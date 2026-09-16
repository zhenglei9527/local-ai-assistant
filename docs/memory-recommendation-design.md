# 内存探测与模型推荐设计

> 目标：App 首次启动时**自动判定手机能跑多大的模型**，给出推荐，避免用户下完 5GB 才发现装不下。

## 1. 为什么不能只用 `Runtime.maxMemory()`

Android 上有三个"内存"数字，含义完全不同：

| 取法 | 含义 | 能否用于判定 |
|---|---|---|
| `Runtime.getRuntime().maxMemory()` | **单个 App 的 Java 堆上限**（通常 128-512 MB） | ❌ **严重低估** —— 它只描述 Java 堆，而 llama.cpp 的模型权重是分配在 **native heap** 的，不受此限制 |
| `ActivityManager.MemoryInfo.totalMem` | **设备物理总内存** | ✅ 这是基准 |
| `ActivityManager.MemoryInfo.availMem` | **当前可用内存** | ✅ 用于加载前的实时检查 |

**结论**：用 `totalMem` 做推荐，用 `availMem` 做加载前的准入检查。

```kotlin
fun getTotalMemoryBytes(context: Context): Long {
    val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    val mi = ActivityManager.MemoryInfo()
    am.getMemoryInfo(mi)
    return mi.totalMem          // 物理总内存，字节
}

fun getAvailableMemoryBytes(context: Context): Long {
    val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    val mi = ActivityManager.MemoryInfo()
    am.getMemoryInfo(mi)
    return mi.availMem          // 当前可用
}
```

⚠️ **`availMem` 会被 `lowMemory` 标志影响**。更精确的判断应同时看 `mi.lowMemory`：
```kotlin
if (mi.lowMemory) → 系统内存紧张，任何模型加载都容易失败
```

## 2. 可用内存的真实上限：为什么是 0.6~0.7

物理总内存 ≠ 能给模型的量：

```
设备总内存 (totalMem)
  ├─ Android 系统 + 厂商预装（实测通常 1.5 ~ 3 GB）
  ├─ 用户已开的其他 App
  └─ 留给本 App 的余量  ← 这才是模型能用的
```

**经验取值**：

| 设备总内存 | 留给 App | 可用系数 |
|---|---|---|
| 4 GB | ~2.4 GB | 0.60 |
| 6 GB | ~3.9 GB | 0.65 |
| 8 GB | ~5.4 GB | 0.68 |
| 12 GB | ~8.4 GB | 0.70 |
| 16 GB | ~11.2 GB | 0.70 |

```kotlin
fun usableBudgetBytes(context: Context): Long {
    val total = getTotalMemoryBytes(context)
    val ratio = when {
        total <= 4L * GB -> 0.60
        total <= 6L * GB -> 0.65
        total <= 8L * GB -> 0.68
        else             -> 0.70
    }
    return (total * ratio).toLong()
}
```

## 3. 运行时占用 = 模型体积 × 系数

模型加载进内存的不只是权重，还有 **KV cache**：

```
运行时占用 ≈ 权重体积 + KV cache + 运行时开销
```

**KV cache 大小取决于上下文长度**：
```
KV cache bytes ≈ 2 × n_layers × n_kv_heads × head_dim × ctx_len × bytes_per_element
```

对 Qwen3-4B 这类模型的经验值（Q8 KV 量化）：

| 上下文长度 | KV cache 追加 |
|---|---|
| 2K | ~0.15 GB |
| 4K | ~0.3 GB |
| 8K | ~0.6 GB |

**综合系数**（权重 → 运行时总占用）：

| 上下文 | 系数 |
|---|---|
| 2K | ×1.15 |
| 4K | ×1.25 |
| 8K | ×1.40 |

**推荐时用 ×1.3 作为保守默认**（对应 4K 上下文，手机端合理默认值）。

```kotlin
const val RUNTIME_FACTOR = 1.3

fun runtimeFootprintBytes(weightBytes: Long): Long =
    (weightBytes * RUNTIME_FACTOR).toLong()
```

## 4. 推荐算法

```kotlin
data class Recommendation(
    val entry: ModelEntry,
    val fit: FitLevel,          // GOOD / TIGHT / NO
    val reason: String,
)

enum class FitLevel { GOOD, TIGHT, NO }

fun recommend(
    context: Context,
    candidates: List<ModelEntry>,   // 按质量（参数量）降序
    ctxLen: Int = 4096,
): Recommendation? {
    val budget = usableBudgetBytes(context)
    val factor = factorFor(ctxLen)

    // 从大到小找第一个能放下的 —— "能跑的最大模型" 是最优解
    for (m in candidates.sortedByDescending { it.entryFileBytes }) {
        val need = runtimeFootprintBytes(m.entryFileBytes, factor)
        val headroom = budget - need
        when {
            headroom > budget * 0.25 -> return Recommendation(m, GOOD,  "充裕")
            headroom > 0             -> return Recommendation(m, TIGHT, "偏紧，可能被系统回收")
            else                     -> continue     // 放不下，试下一个
        }
    }
    // 全都放不下 → 返回最小的那个，标记 NO，并给出警告
    return candidates.minByOrNull { it.entryFileBytes }
        ?.let { Recommendation(it, NO, "内存不足，可能无法加载") }
}
```

### 4.1 分片的体积怎么算

**用总分片体积，不是第一个分片**：

```kotlin
val ModelEntry.entryFileBytes: Long get() = files.sumOf { it.bytes }
```

⚠️ 这是**极易写错**的地方 —— 如果只算 `files.first()`，7B 模型会被算成 3.7 GB（实际 4.36 GB），推荐结果偏大。

## 5. 加载前的准入检查（必做）

推荐是**静态**判断（基于总内存），加载前还要做**动态**判断：

```kotlin
fun canLoadNow(context: Context, entry: ModelEntry, ctxLen: Int): LoadCheck {
    val need = runtimeFootprintBytes(entry.entryFileBytes, factorFor(ctxLen))
    val avail = getAvailableMemoryBytes(context)

    return when {
        avail >= need * 1.25 -> LoadCheck.OK
        avail >= need        -> LoadCheck.TIGHT          // 提示"建议关闭其他应用"
        else                 -> LoadCheck.INSUFFICIENT(
            needGb = need / GB, availGb = avail / GB
        )
    }
}
```

**加载顺序建议**：先 `unload` 旧模型再 `load` 新模型，否则两个模型同时在内存里会直接 OOM。

## 6. 实测模型体积 → 推荐档位映射

基于已实测的精确体积（`data/models-official.json`），映射如下：

| 设备内存 | 可用预算 | **推荐模型** | 权重 | 运行时 | 余量 |
|---|---|---|---|---|---|
| 4 GB | 2.4 GB | Qwen3-1.7B (Q8_0) | 1.71 G | 2.22 G | 偏紧 |
| 6 GB | 3.9 GB | **Qwen3-4B (Q4_K_M)** | 2.33 G | 3.03 G | 充裕 |
| 8 GB | 5.4 GB | **Qwen3-4B (Q4_K_M)** | 2.33 G | 3.03 G | 充裕 |
| 12 GB | 8.4 GB | **Qwen3-8B (Q4_K_M)** | 4.68 G | 6.08 G | 充裕 |
| 16 GB | 11.2 GB | Qwen3-14B (Q4_K_M) | 8.38 G | 10.89 G | 偏紧 |

与前期人工分析的结论一致（8G→4B、12G→8B），**算法验证通过**。

⚠️ 注意 4 GB 档：Qwen3-1.7B 只有 Q8_0（1.71 G），运行时 2.22 G，逼近 2.4 G 预算 —— **偏紧**。若要更低，需引入 Qwen2.5-3B 的 `q2_k`（1.28 G，运行时 1.66 G），更安全。

## 7. 需要给用户展示的信息

避免技术上正确但用户看不懂，界面上应展示：

```
推荐：Qwen3-4B (Q4_K_M)
├─ 下载体积：2.33 GB
├─ 运行内存：约 3.0 GB
├─ 你的手机：8 GB 内存，可用约 5.4 GB    ✅ 充裕
└─ 适合：日常对话、角色扮演

其他可选：
  Qwen3-1.7B (1.71 GB)  ← 更省内存，但能力弱
  Qwen3-8B   (4.68 GB)  ← 更聪明，但内存吃紧 ⚠️
```

## 8. 待验证项

| 项 | 状态 |
|---|---|
| `totalMem` / `availMem` 取值 | ⚠️ 标准 API，代码正确，但**未在真机实测各机型的实际数值分布** |
| 0.6~0.7 可用系数 | ⚠️ **经验值**，需在多种真机上校准 |
| ×1.3 运行时系数 | ⚠️ **经验值**，依赖具体模型的层数/head 数，需实测校准 |
| KV cache 随上下文的增长 | ⚠️ 公式正确，但系数需用实际模型验证 |
| llama.cpp 在 Android 上的 native 分配上限 | ⚠️ **未验证** —— 有些设备对 native 内存有额外限制（尤其国产 ROM） |

**建议**：MVP 阶段先用保守系数（宁可推荐小一点），上线后收集真实 OOM 反馈再校准。
