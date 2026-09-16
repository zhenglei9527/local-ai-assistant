# 官方模型线数据（phone-llm-app / data）

本目录存放 Android 本地大模型聊天 App「官方模型线」的模型清单，以及生成它的可复现脚本。

## 文件说明

| 文件 | 用途 | 谁消费 |
|---|---|---|
| `models-official.json` | **权威清单**，App 直接读取 | App 运行时 |
| `models-official.md` | 人类可读摘要（内存档位推荐、全部模型表、命名陷阱） | 开发者 / 评审 |
| `README.md` | 本文件：来源、实测时间、更新方法 | 维护者 |
| `_raw-gguf.json` | 实测原始数据（每个 GGUF 文件的原始 API 记录） | 生成脚本的输入 |
| `_entries.xml` | 中间层：按 仓库+量化+分片 聚合后的条目 | 生成脚本的中间产物 |
| `_build-manifest.ps1` | 把 `_raw-gguf.json` 聚合成 `_entries.xml` | 维护者 |
| `_emit.ps1` | 把 `_entries.xml` + `_raw-gguf.json` 生成 `models-official.json` | 维护者 |
| `_emit-md.ps1` | 把 `models-official.json` 渲染成 `models-official.md` | 维护者 |

> `_` 前缀的文件是**生成管线**，不是交付物。App 只需要 `models-official.json`。

## 数据来源

全部数据来自 **ModelScope（魔搭）** 的文件列表接口，直接实测抓取：

```
列表：GET https://modelscope.cn/api/v1/models/{owner}/{name}/repo/files?Revision=master&Root=
下载：GET https://modelscope.cn/api/v1/models/{owner}/{name}/repo?Revision=master&FilePath={file}
```

- 列表接口返回每个文件的 `Path` / `Name` / `Size`（精确字节）/**`Sha256`** / `IsLFS` / `Revision` / `CommittedDate`。
- 下载接口**支持 HTTP Range**，已实测：带 `Range: bytes=0-1023` 返回 `206`、
  `Content-Range: bytes 0-1023/2497280256`、`Accept-Ranges: bytes`，且首 4 字节为 `GGUF` 魔数。
  → App 可据此实现断点续传。
- `sha256` 与下载端点的 `X-Linked-Etag` 响应头**交叉验证一致**，可放心用于完整性校验。

### ⚠️ 搜索接口不可用

ModelScope 的搜索接口 `dolphin/models` **返回 404，不可用**。
本清单只能通过**已知仓库名直连列表接口**获得，无法用关键词发现新仓库。
新增模型时需要先拿到确切的 `owner/name`。

### 为什么不用 HuggingFace

本机 DNS 被污染，`huggingface.co` 必定无法访问，故全程未尝试。

## 实测时间

| 项目 | 值 |
|---|---|
| 抓取时间 (UTC) | 2026-09-15 17:12:19 |
| 上游最后提交 | 2025-05-08 |
| 可用仓库数 | 18 |
| 模型条目数 | 125 |
| 分片文件总数 | 180 |
| GGUF 原始文件数 | 277 |

> `generatedAt` 是脚本实际抓取的时刻；`newestUpstreamCommit` 是所收录仓库中最新一次上游提交的日期。
> 两者含义不同，更新时都以 `generatedAt` 判断数据新鲜度。

## 如何更新

### 完整重抓（推荐）

```powershell
cd "D:\DeepSeek harness\phone-llm-app\data"

# 1. 重新抓取列表接口，重建 _raw-gguf.json
#    （仓库名清单在脚本内的 $repos 数组中，新增模型时在此追加 owner/name）
& .\_build-manifest.ps1     # 依赖已更新过的 _raw-gguf.json

# 2. 聚合成条目
& .\_build-manifest.ps1

# 3. 生成 JSON 清单
& .\_emit.ps1

# 4. 渲染 Markdown 摘要
& .\_emit-md.ps1

# 5. 校验 JSON 合法
Get-Content .\models-official.json -Raw | ConvertFrom-Json | Select-Object modelCount
```

### 只更新单个仓库

改 `_build-manifest.ps1` 里的仓库列表，或在抓取脚本中指定目标仓库，然后从第 1 步重跑。
脚本是**幂等**的：每次都用实测数据整体覆盖，不做增量合并，因此不会累积脏数据。

### 新增模型时的注意事项

1. **探测仓库是否存在**：必须按 `*.gguf` 过滤后再计数。
   有仓库返回 200 但**不含任何 GGUF**（如 `Qwen/Qwen3-0.6B`、`Qwen/Qwen2.5-7B-Instruct`），
   只看 `Files.Count` 会误判为可用。
2. **404 不要当限流重试**：同批次其他请求都 200 时，404 就是仓库名确实不存在。
3. **文件名大小写不统一**：Qwen3 是 `Qwen3-4B-Q4_K_M.gguf`，Qwen2.5 是 `qwen2.5-7b-instruct-q4_k_m.gguf`。
   一律以实测 `Path` 为准，不要硬编码。

## 关键口径

### 体积单位

JSON 里同时提供两种：

- **`sizeBytes`** — 精确字节数（权威值，来自接口的 `Size`）
- **`sizeGiB`** — `sizeBytes / 1024³`，**这是文档与任务书使用的口径**

> 注意：早期版本曾误用十进制 GB（`/1e9`），造成约 7.4% 的系统性偏差。
> 修正后，任务书给出的全部 35 个体积值与实测值**逐一吻合，零处不符**。
> 新增字段时务必显式声明口径。

### 内存估算

```
最低内存 = 权重体积(GiB) × 1.12 + 0.35 GB   # 运行时开销
推荐内存 = 权重体积(GiB) × 1.35 + 0.90 GB   # 预留 KV cache 余量
```

这是**启发式估算**，未考虑上下文长度、KV cache 量化、后端实现差异。
接入时应按真机实测调整，不要当成硬性约束。

### 内存档位推荐规则

在预算内**先满足 Q4_0 级质量下限，再取最大参数量**。

理由：14B 的 Q2_K 实际效果通常**劣于** 7B 的 Q4_K_M。
因此档位推荐不会用「换更大模型」去换「更差量化」——只有在没有任何模型满足质量下限时，
才会退回到「能装下就行」。每个档位同时给出 5 个备选，便于按偏好调整。

## 分片规律

所有分片严格遵循：

```
<basename>-<5位序号>-of-<5位总数>.gguf
例：qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf
```

已对全部 180 个分片文件校验：组内序号恰为连续的 `1..N`，分片数与文件名总数一致，**失败数 0**。

**接入注意**：分片总数**不能按固定体积推算**——同为 32B 的 fp16，
`Qwen2.5-32B-Instruct` 是 17 片而 `Qwen2.5-Coder-32B` 是 9 片。
另有部分仓库（`Qwen2.5-14B-Instruct`、`Qwen2.5-32B-Instruct`）**只提供分片文件**，
不存在未分片的单文件，App 不能假设单文件一定存在。

## 已知未收录项

**404 确认不存在**：

- 全部 `2507` 后缀变体：`Qwen/Qwen3-{0.6B,1.7B,4B,8B,14B,30B-A3B,32B}-Instruct-2507-GGUF`
  与 `…-Thinking-2507-GGUF`
- `Qwen/Qwen3-Coder-30B-A3B-Instruct-GGUF`
- `Qwen/Qwen2.5-1.5B-GGUF`（注意：`Qwen2.5-1.5B-Instruct-GGUF` **存在**）

**200 但无 GGUF 文件**：

- `Qwen/Qwen3-235B-A22B-GGUF`
- `Qwen/Qwen3-0.6B`
- `Qwen/Qwen2.5-7B-Instruct`

## 限制与免责

1. 清单是**快照**，上游仓库可能随时更新或删除。App 侧应设超时与校验失败的降级路径。
2. 所有 `sha256` 均来自上游接口，未做本地全量下载复算（单文件最大 34 GB）。
   已通过下载端点 `X-Linked-Etag` 做交叉验证，但**未逐字节校验**。
3. ModelScope 无可用搜索接口，**新模型无法自动发现**，必须人工提供仓库名。
