# 模型下载器设计（断点续传 + 多分片 + 后台）

> 本文档基于对 ModelScope 下载端点的**实测验证**，非推测。
> 实测时间：本次会话。所有 HTTP 行为均为真实响应。

## 1. 实测确认的服务端能力

### 1.1 下载端点

```
GET https://modelscope.cn/api/v1/models/{owner}/{name}/repo?Revision=master&FilePath={file}
```

### 1.2 Range / 断点续传 —— 实测通过 ✅

对 `Qwen/Qwen3-4B-GGUF` 的 `Qwen3-4B-Q4_K_M.gguf` 做三组 Range 请求，结果：

| 请求 Range | 状态码 | Content-Length | Content-Range | Accept-Ranges |
|---|---|---|---|---|
| `bytes=0-99` | **206** | 100 | `bytes 0-99/2497280256` | `bytes` |
| `bytes=1000-1099` | **206** | 100 | `bytes 1000-1099/2497280256` | `bytes` |
| `bytes=-100` | **206** | 100 | `bytes 2497280156-2497280255/2497280256` | `bytes` |

**结论**：
- 三种 Range 形态全部返回 206 Partial Content
- `Accept-Ranges: bytes` 明确声明支持
- **总长度从 `Content-Range` 尾部可靠获取**（`2497280256`），无需先发 HEAD
- 后缀式 Range（`bytes=-N`，取末尾 N 字节）也支持 —— 可用于**快速校验文件尾部**

### 1.3 真实文件尺寸样本（实测字节数）

| 文件 | 精确字节数 | GiB |
|---|---|---|
| `Qwen3-4B-Q4_K_M.gguf` | 2,497,280,256 | 2.326 |
| `Qwen3-8B-Q4_K_M.gguf` | 5,027,783,488 | 4.682 |
| `qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf` | 3,993,201,344 | 3.719 |
| `qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf` | 689,872,288 | 0.642 |
| `qwen2.5-14b-instruct-q4_k_m-00001-of-00003.gguf` | 3,991,999,872 | 3.718 |
| `qwen2.5-14b-instruct-q4_k_m-00002-of-00003.gguf` | 3,989,373,504 | 3.715 |
| `qwen2.5-14b-instruct-q4_k_m-00003-of-00003.gguf` | 1,006,737,120 | 0.938 |

⚠️ 注意 7B 的分片**极不均匀**（3.719 + 0.642 = 4.361 GB），不要假设分片等大。

## 2. 两种分片形态（必须都支持）

实测发现国内源上并存两种命名：

**形态 A —— 单文件（Qwen3 全系）**
```
Qwen3-8B-Q4_K_M.gguf                      ← 一个文件搞定
```

**形态 B —— 多分片（Qwen2.5 全系）**
```
qwen2.5-14b-instruct-q4_k_m-00001-of-00003.gguf
qwen2.5-14b-instruct-q4_k_m-00002-of-00003.gguf
qwen2.5-14b-instruct-q4_k_m-00003-of-00003.gguf
                        ^^^^^     ^^^^^
                        序号      总数
```

**命名规律**：`{base}-{序号5位}-of-{总数5位}.gguf`

### 2.1 llama.cpp 加载分片的规则（关键）

llama.cpp / llama.rn **只需要传入第 1 个分片路径**，它会自动按 `-0000X-of-0000Y` 规律寻找后续分片。

因此：
- ✅ 必须把**全部分片下载到同一目录**
- ✅ 推理时只传 `...-00001-of-00002.gguf`
- ❌ **不要合并分片成单文件** —— 没必要，且合并后需重新对齐元数据，容易出错

### 2.2 下载器必须做的分片校验

`basename` 的匹配是 llama.cpp 自动寻片的唯一依据 —— 如果用户只下了 1/3 分片，llama.cpp 会加载失败并报难懂的错。所以下载器在**开始下载前**就要确保拿到完整分片列表。

## 3. 分片清单怎么来（两种途径）

### 途径 1：列表接口（推荐，可自动发现）
```
GET https://modelscope.cn/api/v1/models/{owner}/{name}/repo/files?Revision=master&Root=
→ { "Code": 200, "Data": { "Files": [ { "Path": "...", "Size": 123, "Name": "..." } ] } }
```
优点：能拿到**完整文件列表 + 精确字节数**，可在下载前算出总大小、显示准确进度。
限制：需要网络请求；若接口变动需降级。

### 途径 2：内置清单（兜底，推荐作为主路径）
由于 App 内置模型清单本来就是硬编码的（见 `data/models-official.json`），**分片信息直接写死在 App 里**，无需运行时查询列表接口。

**建议：以途径 2 为主，途径 1 作为"检查更新"的可选能力。** 这样首次下载少一次网络依赖，更稳。

## 4. 下载器核心设计

### 4.1 数据模型

```kotlin
// 模型清单条目（来自内置 JSON）
data class ModelFile(
    val fileName: String,        // 单个文件的路径
    val bytes: Long,             // 精确字节数 ← 来自实测
    val sha256: String?,         // 可空
)

data class ModelEntry(
    val id: String,              // "qwen3-4b-q4_k_m"
    val displayName: String,
    val repoOwner: String,       // "Qwen"
    val repoName: String,        // "Qwen3-4B-GGUF"
    val revision: String,        // "master"
    val files: List<ModelFile>,  // 1 个（单文件）或 N 个（分片）
    val minMemoryGb: Int,        // 最低内存要求
    val recommendedMemoryGb: Int,
) {
    val totalBytes: Long get() = files.sumOf { it.bytes }
    val isSharded: Boolean get() = files.size > 1
    val entryFile: String get() = files.first().fileName   // 传给 llama.cpp 的那个
}

// 下载任务（需持久化，用于崩溃恢复）
data class DownloadTask(
    val modelId: String,
    val fileIndex: Int,          // 当前下到第几个文件
    val downloadedBytes: Long,   // 当前文件已下载字节
    val status: Status,          // PENDING / DOWNLOADING / PAUSED / DONE / FAILED
    val retryCount: Int,
)

// 磁盘上的文件命名
// 未完成：<target>.part
// 已完成：<target>            ← 只有完成后才 rename，避免半截文件被推理加载
```

### 4.2 下载状态机

```
         ┌──────────┐
         │ PENDING  │
         └────┬─────┘
              │ start()
              ▼
       ┌─────────────┐  pause()   ┌──────────┐
       │ DOWNLOADING │───────────▶│  PAUSED  │
       └──────┬──────┘◀───────────└──────────┘
              │                    resume()
      ┌───────┴────────┐
      │                │
   成功│             失败│
      ▼                ▼
 ┌─────────┐    ┌──────────┐
 │  DONE   │    │ RETRYING │───(超过 N 次)──▶ FAILED
 └─────────┘    └────┬─────┘
                     │ 退避等待
                     └──▶ DOWNLOADING
```

### 4.3 断点续传算法

```
fun downloadFile(url: String, target: Path, task: DownloadTask): Result {
    val part = "$target.part"
    var offset = if (part.exists()) part.length() else 0L

    // 首次请求：带 Range（若 offset>0）
    val request = Request.Builder().url(url).apply {
        if (offset > 0) header("Range", "bytes=$offset-")
    }.build()

    client.newCall(request).execute().use { resp ->
        when (resp.code) {
            206 -> {
                // 正常续传：校验服务端返回的起点与本地一致
                val contentRange = resp.header("Content-Range")  // "bytes 1000-1099/2497280256"
                val serverStart = parseStart(contentRange)
                if (serverStart != offset) {
                    // 服务端不认我们的 offset（文件变了 / 服务端不支持）
                    // → 保守起见从头下，避免拼接出错
                    part.delete(); offset = 0L; return retryFromScratch()
                }
            }
            200 -> {
                // 服务端忽略了 Range，返回全量 —— 必须丢弃已有部分，否则文件会错位
                if (offset > 0) { part.delete(); offset = 0L }
            }
            416 -> {
                // Range 超出文件范围：本地 .part 比服务端文件还大 → 文件已变更，重下
                part.delete(); return retryFromScratch()
            }
            else -> return Result.Failure(resp.code)
        }

        // 流式写入，按块 flush 并更新进度
        resp.body.byteStream().use { input ->
            FileOutputStream(part, /* append = */ offset > 0).use { out ->
                val buf = ByteArray(64 * 1024)
                var n: Int
                while (input.read(buf).also { n = it } > 0) {
                    out.write(buf, 0, n)
                    offset += n
                    progress.update(offset)          // 节流上报（每 ~1MB 或 200ms）
                    if (cancelled) return Result.Paused  // 保留 .part 供续传
                }
            }
        }
    }

    // 完成后校验大小
    if (part.length() != expectedBytes) return Result.SizeMismatch
    part.renameTo(target)                            // 原子落地
    return Result.Success
}
```

**关键安全点（容易写错的）**：
1. **206 时校验 `Content-Range` 起点**：不能无条件 append。若服务端返回的起点不等于本地 offset（比如文件被替换），拼接出来的文件是**静默损坏**的 —— 推理时会崩在难查的地方。
2. **200 时必须丢弃 `.part`**：服务端忽略 Range 返回全量时，若仍 append，文件会前段重复。
3. **416 要当"文件已变"处理**：直接删 `.part` 重下。
4. **只有 `.part` 长度 == 期望字节数才 rename**：避免半截文件被 llama.cpp 加载。
5. **进度上报节流**：每 64KB 回调一次会在高速下载时刷爆 UI 线程，需按时间/大小节流。

### 4.4 重试与退避

```kotlin
val delays = listOf(2, 5, 10, 30, 60, 120)  // 秒
```

只在**可重试错误**上退避：网络 IO 异常、5xx、408、429。
**不要重试**：404（文件不存在，重试无意义）、403、以及大小校验失败（需人工介入）。

### 4.5 校验策略

| 阶段 | 校验 | 说明 |
|---|---|---|
| 下载前 | 可用内存 vs 模型体积 | 不足直接拒绝，别下完才发现装不下 |
| 下载中 | 无 | 流式校验代价高 |
| 下载后 | **文件长度 == 清单字节数** | 必做，成本 O(1) |
| 下载后（可选） | sha256 | 大文件全量哈希在手机上是**秒级到分钟级**开销，建议**默认跳过**，放在「设置 → 校验模型」里手动触发 |
| 加载前 | GGUF magic number | 读前 4 字节应为 `GGUF`（0x47 0x47 0x55 0x46）。**便宜且能拦住大部分损坏** —— 强烈建议做 |

⚠️ **GGUF magic 校验是性价比最高的一环**：读 4 字节即可确认文件不是 HTML 错误页、不是空文件、不是半截文件。必须实现。

### 4.6 多分片调度

```kotlin
suspend fun downloadModel(entry: ModelEntry) {
    for ((i, f) in entry.files.withIndex()) {
        // 分片顺序下载（不并行：并行会争抢带宽且更难恢复）
        val r = withRetry { downloadFile(urlFor(entry, f), dir.resolve(f.fileName), task.copy(fileIndex = i)) }
        if (r is Result.Failure) return markFailed(entry, i, r.reason)
    }
    // 全部分片就位后，做一次整体 magic 校验
    verifyGgufMagic(dir.resolve(entry.entryFile))
    markComplete(entry)
}
```

**为什么串行不并行**：手机带宽有限；并行分片会让单个连接更易超时；断点恢复逻辑（记录 fileIndex + offset）在串行下是单点状态，简单可靠。

### 4.7 存储位置

```kotlin
// 首选：应用专属外部存储，无需权限，卸载时清理
val dir = context.getExternalFilesDir("models")   // /Android/data/<pkg>/files/models

// 需要检查可用空间：模型可能 5GB+
val stat = StatFs(dir.path)
if (stat.availableBytes < entry.totalBytes * 1.1) → 提示空间不足   // 留 10% 余量
```

⚠️ 不要用 `getExternalStorageDirectory()`（需要 MANAGE_EXTERNAL_STORAGE，上架会被拒）。

### 4.8 后台下载

必须用 **Foreground Service**：
- Android 12+ 后台限制严格，普通 Service 会被杀
- 需要在 Manifest 声明 `android:foregroundServiceType="dataSync"` 和权限 `FOREGROUND_SERVICE_DATA_SYNC`
- 通知栏显示进度、暂停/取消按钮
- Android 14+ 对 `dataSync` 类型有 6 小时/天的时长限制（**大模型下载需注意**，必要时提示用户前台保持）

## 5. 待验证 / 已知风险

| 项 | 状态 |
|---|---|
| Range 断点续传 | ✅ **已实测通过** |
| 206 的 `Content-Range` 格式 | ✅ 已实测（`bytes X-Y/TOTAL`） |
| 后缀 Range（`bytes=-N`） | ✅ 已实测支持 |
| 分片命名规律 | ✅ 已实测（Qwen2.5 系列） |
| 单文件形式 | ✅ 已实测（Qwen3 系列） |
| **sha256 可从列表接口取到** | ✅ **已实测**（见 §6，且与响应头交叉验证一致） |
| **ETag 可用** | ✅ **已实测**（`X-Linked-Etag`，值为 sha256） |
| Commit 时间戳 / revision | ✅ 已实测（`CommittedDate` / `Revision`） |
| **断点续传的实际长期稳定性** | ⚠️ **未验证** —— 需用大文件跨多天实测 |
| **限速 / 并发连接限制** | ⚠️ **未验证** —— 大量用户同时下载时是否被限流未知 |
| 断流后能否恢复 | ⚠️ 逻辑上支持，但未做端到端长跑测试 |

## 6. 校验和与版本标识（实测补充，重要）

### 6.1 列表接口自带 sha256 ✅

实测 `Qwen/Qwen3-4B-GGUF` 的 `Qwen3-4B-Q4_K_M.gguf` 条目，**完整字段**如下：

```json
{
  "Name": "Qwen3-4B-Q4_K_M.gguf",
  "Path": "Qwen3-4B-Q4_K_M.gguf",
  "Size": 2497280256,
  "Sha256": "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5",
  "Revision": "8cca206c792af04f8d452368bd30b43ec18007f1",
  "CommittedDate": 1746432924,
  "CommitterName": "Cherrytest",
  "CommitMessage": "Upload to Qwen/Qwen3-4B-GGUF on ModelScope hub",
  "IsLFS": true,
  "InCheck": false,
  "Mode": "33188",
  "Type": "blob"
}
```

**结论**：
- ✅ `Sha256` 字段**直接提供**，无需自己计算或从别处获取
- ✅ `Size` 精确到字节
- ✅ `Revision` 是**真实 commit SHA**（不是 `master` 这种浮动引用）—— **可用于锁定版本，防止上游更新导致清单失效**

### 6.2 响应头 `X-Linked-Etag` = sha256 ✅

下载响应的头里存在：
```
X-Linked-Etag: 7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5
```
**与列表接口的 `Sha256` 完全一致** —— 两个独立来源交叉验证通过。

⚠️ 注意它叫 `X-Linked-Etag` **不是标准 `ETag`**，所以不能直接用 HTTP 条件请求（`If-Range` / `If-None-Match`）做标准缓存协商。但可以：
- 在续传前发一次 HEAD，比对 `X-Linked-Etag` 与本地记录的 sha256
- 若不一致 → 说明上游文件已替换 → 丢弃 `.part` 重下

**这解决了 §4.3 里"如何检测文件被替换"的问题** —— 有了 sha256 就有了可靠的版本判据。

### 6.3 对下载器设计的修订建议

1. **清单里应该写死 sha256**，而不是留 `null`（本设计最初假设取不到，现已推翻）
2. **下载完成后做 sha256 校验是有意义的**（因为期望值已知，不需要额外获取）
   - 但**性能仍需权衡**：4.68 GB 文件在手机上的全量 sha256 约需数十秒到数分钟
   - 折中方案：**默认只校验长度 + GGUF magic**；提供「严格校验模式」让用户可选，或仅在**首次下载/大文件**时启用
   - 更好的折中：**下载过程中边下边算**（流式哈希），零额外 IO 成本 —— **推荐这个**
3. **用真实 commit SHA 固定 Revision**，而不是 `Revision=master`
   - 好处：清单永不过期，上游改了也不会导致"下载到一半文件变了"
   - 代价：需要在上游更新时手动升清单（但对 App 是好事 —— 可控）

### 6.4 URL 形态（带 commit 固定版本）✅ 已实测可用

```
https://modelscope.cn/api/v1/models/{owner}/{name}/repo?Revision={commit_sha}&FilePath={file}
```

实测三种 `Revision` 形态**全部返回 206**，且内容一致：

| Revision 形态 | 状态 | Content-Range |
|---|---|---|
| `master` | 206 | `bytes 0-3/2497280256` |
| `8cca206c792af04f8d452368bd30b43ec18007f1`（完整 SHA） | 206 | `bytes 0-3/2497280256` |
| `8cca206c`（8 位短 SHA） | 206 | `bytes 0-3/2497280256` |

**结论：可以用 commit SHA 锁定版本。强烈建议这样做** —— 清单一旦生成就永久有效，不会因上游更新导致「下到一半文件被替换」。

### 6.5 GGUF magic number ✅ 已实测确认

对上述请求取前 4 字节，返回的正是 ASCII 字符串 **`GGUF`**。

这验证了 §4.5 中「GGUF magic 校验」方案是**可行且真实有效**的：
- 读文件前 4 字节，应为 `0x47 0x47 0x55 0x46`（`GGUF`）
- 成本：读 4 字节（O(1)）
- 能拦住：HTML 错误页、空文件、半截下载、非 GGUF 格式文件

⚠️ 顺带发现：`X-Linked-Etag` 在 `Range` 请求下**不再返回**（本轮的 3 次 Range 请求均未取到该头，而此前的 HEAD 请求有）。因此：
- 想用 ETag 比对，**必须发 HEAD 而不是 Range GET**
- 这进一步说明：**sha256 应该从列表接口预先取好并写进清单**，而不是运行时从响应头读
