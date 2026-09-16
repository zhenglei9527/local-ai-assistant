# 双模型线集成说明

> 状态：**已完成，70 个测试全绿**
> 覆盖：`src/recommend/lines.ts`、`src/recommend/loadLines.ts`、`src/recommend/lines.test.ts`

## 一、为什么需要适配层

两条线由不同流水线产出，**数据结构不同**：

| | 官方线 `data/models-official.json` | 越狱线 `data/models-jailbreak.json` |
|---|---|---|
| 顶层 | `{ models: [...] }` | 扁平数组 `[...]` |
| 体积字段 | `sizeBytes` | **`bytes`** |
| 参数量 | 有 `parametersB` | **没有** |
| 家族 | 有 `family` | 没有 |
| 分片 | `isSharded` + `shards[]` | 只有 `sharded` 布尔 |
| 下载 URL | `downloadUrls[]` | 单个 `downloadUrl` |

**直接把越狱线喂给 `recommendModel()` 会静默失效**，而且不报错：

1. `parametersB` 为 `undefined` → 与 `minParametersB` 比较恒为 `false` → **模型永远不被选中**
2. `sizeBytes` 为 `undefined` → `modelSizeGiB()` 落到 `?? 0` 兜底 → **报告 0 GiB，看起来能塞进任何手机**
3. `isSharded` 为 `undefined`

第 2 条最危险：结果是一份「看起来很合理」的模型列表，但完全错误。

## 二、适配器设计

`src/recommend/lines.ts` 提供唯一的读取入口：

```ts
toLineEntries(raw)   // 越狱线 → ModelEntry[]
tagOfficial(models)  // 官方线 → ModelEntry[] + line 标记
```

### 参数量为什么必须硬编码

越狱线不记录参数量，且**无法从文件大小反推**：

```
Qwen3-4B @ Q4_K_M  ≈ 2.33 GiB
Qwen3-8B @ IQ2_XS  ≈ 2.51 GiB   ← 大小相近，参数量差 2 倍
```

按体积猜参数量会导致排序错乱。因此 `JAILBREAK_PARAMS` 显式登记每个 id 的真实参数量，**遇到未知 id 直接抛错**：

```ts
throw new Error(`Unknown abliterated model id "${r.id}" — add it to JAILBREAK_PARAMS ...`);
```

这是刻意的：宁可加载失败，也不要静默给出错误推荐。

## 三、两线独立推荐（不是合并后排序）

```ts
recommendPerLine(lines, { totalRamGB }) 
// → { official: {...}, abliterated: {...} }
```

**为什么不合并成一次推荐**：同为 8B，越狱版连贯性略低于官方版。合并排序会让两者在同尺寸下互相插队，而 UI 无法向用户解释「为什么给我挑了未审查模型」。分线各自排序，由用户选择线。

## 四、实测推荐结果

| 内存 | 官方线 | 越狱线 |
|---|---|---|
| 4 GB | `qwen2.5-1.5b-instruct-q6_k` (1.77G, GOOD) | `huihui-qwen3-1.7b-abliterated-v2` (1.34G, GOOD) |
| 6 GB | `qwen3-4b-q5_0` (3.42G, TIGHT) | `gemma-3-4b-it-abliterated` (3.01G, TIGHT) |
| **8 GB** | **`qwen3-4b-q6_k` (4.00G, GOOD)** | **`gemma-3-4b-it-abliterated` (3.01G, GOOD)** |
| **12 GB** | **`qwen3-8b-q5_0` (6.93G, TIGHT)** | **`meta-llama-3-8b-instruct-abliterated` (5.96G, GOOD)** |
| 16 GB | `qwen3-8b-q6_k` (8.14G, GOOD) | `gemma-3-12b-it-abliterated` (8.84G, TIGHT) |
| 24 GB | `qwen2.5-14b-instruct-q6_k` (14.68G, TIGHT) | `huihui-qwen3-14b-abliterated-v2` (10.90G, GOOD) |

### 一个容易被误判为 bug 的现象

**6GB 和 8GB 都推荐 `gemma-3-4b-it-abliterated`。** 这是正确行为：

- 越狱线**只有 Q4_K_M 单一量化**（`_probe_raw.csv` 证实每仓库虽有 6 档，但入册的 11 个模型全是 Q4_K_M）
- 6GB 预算 3.9G、8GB 预算 5.44G，而次一档的 7B/8B 需 5.67~6.09G —— **两个档位都装不下**
- 官方线能升档是因为有 Q5_0/Q6_K 可退让，越狱线没有这个空间

所以这是「可选集合本身稀疏」导致的，不是排序错误。

## 五、下载引用与完整性

`downloadRef()` 揭示两条线的**关键差异**：

| | 官方线 | 越狱线 |
|---|---|---|
| URL 形态 | `/api/v1/models/{repo}/repo?Revision={commit}&FilePath=` | `/models/{repo}/resolve/master/{file}` |
| 版本锁定 | ✅ **pinned commit SHA** | ❌ **只有分支 `master`** |

⚠️ **越狱线的 `master` 分支是可以移动的**，流水线没有记录 commit SHA。因此：

> **越狱线必须在下完后校验 sha256** —— 仅靠 revision 不足以锁定内容。

JSON 里每个条目都带真实 sha256，这是越狱线唯一的完整性锚点。

## 六、测试覆盖（12 个）

| 测试 | 防的是什么 |
|---|---|
| 两条线都加载且字段完整 | 适配器漏字段（静默失效） |
| 体积与线上 registry 实测值一致 | 数据漂移 |
| 4B 是 2.33 GiB 而非十进制 2.5 | 单位口径错误回归 |
| 每个档位两条线都有推荐 | 空列表 |
| **无推荐超出设备预算** | 原始 OOM bug |
| 两线互不串线 | 合并逻辑泄漏 |
| 备选是不同家族而非重量化 | 列表刷屏 |
| **8GB 只推 4B 级，绝不推 8B** | 原始 OOM bug 专项 |
| 低内存设备仍有可用模型 | 空屏 |
| 越狱线在官方线所有档位都可用 | 功能缺失 |
| 预检与档位推荐不冲突 | 选得动但加载被拒 |
| 运行时成本随上下文单调递增 | KV cache 模型错误 |

## 七、已知限制

1. **越狱线只有 Q4_K_M** —— 若某机型只有 Q5/Q6 才合适，越狱线无档可退。补充需扩展 `data/models-jailbreak.json` 的量化覆盖。
2. **`downloadRef()` 的官方线路径未在测试中覆盖** —— 它依赖调用方传入 `officialSource`，当前测试只验证了越狱线分支。
3. **`JAILBREAK_PARAMS` / `JAILBREAK_REPO_BY_ID` / `JAILBREAK_FILE_BY_ID` 三张表需同步维护** —— 新增模型必须同时更新三处，漏一处会抛错（而非静默错误），但仍是维护负担。
4. **`sizeGB` 对越狱线由 `sizeMB / 1000` 推导** —— 仅作显示，引擎内部一律走 `sizeBytes`。
