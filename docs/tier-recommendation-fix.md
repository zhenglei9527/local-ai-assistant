# 内存档位推荐修正（tier-recommendation-fix）

## 问题

`data/models-official.json` 的 `memoryTiers` 字段由子代理自动生成，规则是：

> 取「`recommendedRamGB <= 物理内存`」中体积最大的模型

这条规则**会让真实手机 OOM**。实测证据：

| 档位 | 自动推荐 | 说明 |
|---|---|---|
| 8 GB | `qwen3-8b-q4_k_m` (5.03 GB, recRam=7.7) | ❌ 真实 8G 手机可用仅 ~5.4 GB，5.03×1.3 = **6.54 GB** → OOM |
| 12 GB | `qwen2.5-14b-instruct-q3_k_m` (7.34 GB, recRam=10.8) | ❌ 真实 12G 可用 ~8.4 GB，7.34×1.3 = **9.54 GB** → OOM |
| 16 GB | `qwen3-14b-q5_0` (10.26 GB, recRam=14.8) | ❌ 真实 16G 可用 ~11.2 GB，10.26×1.3 = **13.3 GB** → OOM |

## 根因

`memoryTiers` 的 `budgetGB` 直接等于**物理内存**，漏掉了两件事：

1. **系统 + 厂商预装占用**（4G 机约 1.5 GB，8G 机约 2 GB，12G 机约 3 GB）
2. **KV cache 开销**（运行时占用 = 权重 × 约 1.3）

而 `docs/memory-recommendation-design.md` 早已定义：
- 可用系数：4G=0.60 / 6G=0.65 / 8G=0.68 / ≥12G=0.70
- 运行时系数：`RUNTIME_FACTOR = 1.3`

**两个文件的口径不一致** —— 这是并行产出的典型集成缺陷。

## 修正规则

推荐必须走**两级**判定：

```
deviceBudget = totalRamGB × usableFactor(totalRamGB)      // 真实可用上限
runtimeCost  = model.sizeBytes / 1GB × 1.3                // 含 KV cache
fits         = runtimeCost <= deviceBudget
```

在此前提下取**体积最大**者，并保留 `minRamGB` 作为硬性下限兜底：

```
eligible = models.filter { it.minRamGB <= deviceBudget && runtimeCost(it) <= deviceBudget }
best     = eligible.maxBy { it.parametersB }              // 按参数量优先，同参数量取高量化
```

## 修正后的档位结果（实测，GiB 口径，已写回 catalog）

用 `src/recommend/recommend.ts` 跑真实 catalog 得到：

| 物理内存 | 可用预算 | 推荐 | 量化 | 权重 | 运行时 | 余量 | 判定 |
|---|---|---|---|---|---|---|---|
| 4 GB | 2.40 GiB | Qwen2.5-1.5B-Instruct | Q6_K | 1.36 | 1.77 | 0.63 | GOOD |
| 6 GB | 3.90 GiB | Qwen3-4B | Q5_0 | 2.63 | 3.42 | 0.48 | TIGHT |
| 8 GB | 5.44 GiB | Qwen3-4B | **Q6_K** | 3.08 | 4.00 | 1.44 | GOOD |
| 12 GB | 8.40 GiB | Qwen3-8B | Q5_0 | 5.33 | 6.93 | 1.47 | TIGHT |
| 16 GB | 11.20 GiB | Qwen3-8B | **Q6_K** | 6.26 | 8.14 | 3.06 | GOOD |
| 24 GB | 16.80 GiB | Qwen2.5-14B | Q6_K | 11.29 | 14.68 | 2.12 | TIGHT |

## 第四个 bug（单位）：sizeGB 与 sizeGiB 是**两个不同的字段**

子代理报告里说它已把单位从十进制 GB 改成 GiB。这是真的，但它**保留了原字段**，于是 catalog 里同时存在三个值：

```
sizeBytes  2497280256       权威、精确
sizeGiB    2.33             = bytes/1024^3   ← 应该用这个
sizeGB     2.5              = bytes/1e9，四舍五入到 1 位小数  ← 仅用于显示
```

我的引擎最初读的是 `sizeGB`，于是犯了**双重错误**：

1. **单位错**：十进制而非 GiB（差 7.4%）
2. **精度错**：2.5 是四舍五入结果，真实 2.33（再差 7.3%）

对一个 4B 模型，这两个错误叠加后**高估了约 7.3%**（2.5 vs 2.33）。

### 为什么这个错误很危险

它不是"算错得离谱"，而是**刚好在边界上翻转结论**：

| 场景 | 用 sizeGB（错） | 用 sizeGiB（对） |
|---|---|---|
| 6 GB 档推荐 | Qwen3-4B Q4_K_M (3.25)，余量 0.65 | Qwen3-4B **Q5_0** (3.42)，余量 0.48 |
| 24 GB 档推荐 | Qwen3-14B Q5_0 (13.34) | Qwen2.5-14B **Q6_K** (14.68) |

修正后 6GB 档从「4B Q4」升到「4B Q5」（更高保真度），24GB 档从「Qwen3-14B Q5」升到「Qwen2.5-14B Q6」。

### 处理方式

引擎内部**统一为 GiB**，并在边界处一次性从 `sizeBytes` 换算，永不使用四舍五入的显示字段：

```ts
const BYTES_PER_GiB = 1024 ** 3;
export function modelSizeGiB(model: ModelEntry): number {
  if (model.sizeBytes > 0) return model.sizeBytes / BYTES_PER_GiB;
  return model.sizeGiB ?? model.sizeGB ?? 0;   // 防御性兜底
}
```

## 四条规则（最终）

```
1. 所有体积计算统一为 GiB，从 sizeBytes 精确换算（不用 sizeGB）
2. 运行时占用 = 权重 × 1.3，必须 ≤ 物理内存 × 可用系数
3. 量化必须 ≥ 4.0 bits/weight（Q4 及以上），除非没有合格项
4. 余量必须 ≥ 预算 × 10%，否则降一档参数量
```

## 验证

`src/recommend/recommend.test.ts`，**16 个测试全部通过**，含 5 个针对性回归测试：

- `REGRESSION: 8GB device must NOT be told to run an 8B model`
- `REGRESSION: every tier recommendation actually fits its budget`
- `REGRESSION: must not pick a sub-Q4 quant when a healthy quant fits`
- `REGRESSION: calculations must use GiB, not the rounded decimal sizeGB`
- `recommendation is monotonic: more RAM never yields fewer parameters`

另有一个**独立交叉验证**测试：`8B Q4_K_M matches the independently verified 4.68 GiB` —— 该值来自项目早期对 Ollama registry manifest 的字节求和，两个独立数据源必须一致。

运行方式：
```bash
node --experimental-strip-types --test src/recommend/recommend.test.ts
```


## 开发中发现并修掉的第二个 bug（quality floor）

第一版修正只做了「运行时占用 ≤ 可用预算」，然后**取参数量最大者**。结果是 8GB 手机会被推荐：

```
qwen2.5-7b-instruct-q2_k   7B  Q2_K   3.93 GB  ← 容量上放得下
```

**这是错的**：Q2_K（2.63 bits/weight）量化损伤严重，7B@Q2_K 的输出质量**劣于 4B@Q4_K_M**，而且加载更慢、上下文空间更小。

修正：引入**量化质量下限 `MIN_HEALTHY_BITS = 4.0`**（即 Q4 及以上），优先在合格量化里选最大参数量。

> 阈值取 4.0 而非 3.5 是有意的：7B@Q3_K_M（3.91 bits）虽能塞进 8GB，但对角色扮演而言，4B@Q4_K_M 更连贯、留出的上下文预算更大。想要「更大但更糊」的模型，用户仍可从完整模型列表手动选。

## 开发中发现并修掉的第三个 bug（headroom）

引入 quality floor 后，选择逻辑变成「取放得下的最高量化」，结果是**余量被吃干**：

| 档位 | 当时推荐 | 余量 |
|---|---|---|
| 4 GB | Qwen3-1.7B Q8_0 | **0.02 GB** ❌ |
| 16 GB | Qwen2.5-14B Q4_0 | **0.12 GB** ❌ |

余量 0.02 GB 意味着**实际必然 OOM**（OS 回收内存不可预测，且 KV cache 会随对话增长）。

修正：**要求余量 ≥ 预算的 10%**（`MIN_HEADROOM_RATIO = 0.1`），若某参数量档位下没有任何量化能满足，就降到下一档参数量。

## 三条规则（最终）

```
1. 运行时占用 = 权重 × 1.3，必须 ≤ 物理内存 × 可用系数
2. 量化必须 ≥ 4.0 bits/weight（Q4 及以上），除非没有合格项
3. 余量必须 ≥ 预算 × 10%，否则降一档参数量
```

三条规则带来的行为差异（同一台 8GB 手机）：

| 规则组合 | 推荐 | 结果 |
|---|---|---|
| 原始（对比物理内存） | Qwen3-8B Q4_K_M (6.54G) | ❌ OOM |
| + 运行时系数 | Qwen2.5-7B Q2_K (3.93G) | ⚠️ 质量差 |
| + quality floor | Qwen3-4B Q6_K (4.30G) | ✅ 正确 |

## 验证

`src/recommend/recommend.test.ts` 共 **14 个测试全部通过**，其中 4 个是针对性回归测试：

- `REGRESSION: 8GB device must NOT be told to run an 8B model`
- `REGRESSION: every tier recommendation actually fits its budget`
- `REGRESSION: must not pick a sub-Q4 quant when a healthy quant fits`
- `recommendation is monotonic: more RAM never yields fewer parameters`

运行方式：
```bash
node --experimental-strip-types --test src/recommend/recommend.test.ts
```


## 4 GB 档的取舍

Qwen3-1.7B 在 ModelScope 上**只有 Q8_0**（1.83 GB），运行时 2.38 GB 逼近 2.40 GB 预算，属 TIGHT。

更安全的兜底是 **Qwen2.5-3B-Instruct q2_k**（1.28 GB，运行时 1.66 GB，余量 0.74 GB）。

建议 4 GB 档同时给出两个选项：
- 追求质量：Qwen3-1.7B Q8_0（标注「较吃内存」）
- 追求稳定：Qwen2.5-3B q2_k（标注「更稳，质量略低」）

## 给 app 的实现要求

`memoryTiers` 不应作为静态数据硬编码在 JSON 里，而应在 **App 运行时**用真实 `ActivityManager.MemoryInfo.totalMem` 计算 —— 因为：
- 不同 ROM 的系统占用差异大（国产 ROM 尤甚）
- 同一档位的设备实际可用内存可能差 1 GB

JSON 里的 `memoryTiers` 只应作为**兜底默认值**，且必须用修正后的规则重新生成。

参考实现见 `src/recommend/recommend.ts`。
