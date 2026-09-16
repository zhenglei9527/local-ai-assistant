# 上下文窗口与 Token 预算策略

> 状态：设计稿（待真机校准）
> 前置：`docs/character-card-design.md` §移动端取舍、`docs/tier-recommendation-fix.md`
> 结论一句话：**预填充时间是首要瓶颈；内存在 8K 以上同样会咬人。策略核心是「尽量不重新 prefill」，默认窗口 8192。**
>
> ⚠️ **2026-09 更正**：本文档 §1 初版有一处 4 倍算术错误（把 32K f16 KV 算成 1.13 GiB，实为 4.50 GiB），
> 导致「32K 在 8GB 机器上完全可行」的结论**错误**。已在 §1 就地修正，修正过程与证据见
> `docs/context-implementation.md`。§2 的预填充结论独立成立、未受影响。

---

## 1. 纠正一个普遍误判

角色卡子代理与主线程独立地把「上下文预算」列为最大风险，预设是：
手机 4K–8K 窗口 vs 酒馆 8K–32K 设计假设冲突，且长上下文会吃爆内存。

**实测计算证明：内存侧几乎不是问题。** 关键在 Qwen3 全系用 GQA（仅 8 个 KV head，非 32），
KV cache 比同等规模的 MHA 模型小 4 倍：

```
KV bytes = 2(K+V) × layers × kv_heads × head_dim × ctx × bytes_per_elem
```

| 模型 | layers | kv_heads | 2K f16 | 4K f16 | 8K f16 | 16K f16 | 32K f16 | 8K q8_0 |
|---|---|---|---|---|---|---|---|---|
| Qwen3-4B | 36 | 8 | 288 M | 576 M | 1,152 M | 2,304 M | 4,608 M | 576 M |
| Qwen3-8B | 36 | 8 | 288 M | 576 M | 1,152 M | 2,304 M | 4,608 M | 576 M |
| Qwen3-14B | 40 | 8 | 320 M | 640 M | 1,280 M | 2,560 M | 5,120 M | 640 M |

代入 8GB 档（预算 5.44 GiB）—— 以 Qwen3-4B Q6_K（权重 3.08 GiB）为例，另留 0.25 GiB scratch：

| 上下文 | 量化 | KV | 合计 | 结论 |
|---|---|---|---|---|
| 4K | f16 | 0.56 GiB | 3.89 GiB | ✅ 余 1.55 |
| **8K** | **f16** | **1.12 GiB** | **4.46 GiB** | ✅ **余 0.99 —— 8GB 档上限** |
| 16K | q8_0 | 1.12 GiB | 4.46 GiB | ✅ 余 0.99（需 KV 量化） |
| 16K | f16 | 2.25 GiB | 5.58 GiB | ❌ 超 0.14 |
| 32K | q8_0 | 2.25 GiB | 5.58 GiB | ❌ 超 0.14 |
| 32K | f16 | 4.50 GiB | 7.83 GiB | ❌ 超 2.39 |

**修正后的结论：**
- 「手机只能 4K 上下文」是错的 —— 8K f16 仍有近 1 GiB 余量。
- 但「32K 完全可行」**同样是错的**。8GB 机器的内存墙落在 **8K 与 16K 之间**。
- **32K f16 需要约 16 GiB 设备内存**（14B 模型则需更多），属发烧档、应保持用户主动选择。
- 内部实现按 GiB 统一口径，并以 `tierFitsMemory()` 把这条约束固化进代码（含 scratch 预留），
  由单元测试对着上面这组修正后的数字守住。

---

## 2. 真正的瓶颈：预填充时间

prefill（提示词处理）是**计算密集**的，与提示词 token 数成正比，而这个成本在手机上极高：

| 提示词长度 | @20 tok/s | @40 tok/s | @80 tok/s |
|---|---|---|---|
| 1,000 tok | 50 s | 25 s | 12 s |
| 2,000 tok | 100 s | 50 s | 25 s |
| 4,000 tok | 200 s | 100 s | 50 s |
| 8,000 tok | 400 s | 200 s | 100 s |
| 16,000 tok | 800 s | 400 s | 200 s |
| 32,000 tok | 1,600 s | 800 s | 400 s |

一张带世界书的典型酒馆卡轻松填满 8K–16K token：

- **20 tok/s 下，16K 提示词 = 13 分钟**才吐出第一个字
- 即使 80 tok/s 也要 3.3 分钟

⚠️ **这就是死亡体验。用户会以为 App 卡死了。**

对比 decode（逐字生成）速度，这才是用户感知「在工作」的部分：

| 模型 | 手机 decode | 评价 |
|---|---|---|
| 4B | 8–15 tok/s | 流畅 |
| 8B | 4–7 tok/s | 接近阅读速度上限 |
| 14B | 2–3 tok/s | 明显慢，但可接受 |

人阅读速度约 5–8 tok/s。**所以 8B 已经是「生成速度刚好够读」的临界点**，14B 开始落后于阅读。

---

## 3. 核心策略：让 prefill 只发生一次

llama.rn 提供了三个验证过的机制（源码/README 已核实），组合起来可把首字延迟从分钟级压到秒级：

### 3.1 `saveSession` / `loadSession` —— 会话状态持久化

```ts
// 上下文状态可存成二进制文件，恢复后无需重新 prefill
await context.saveSession('/path/to/session.bin')
await context.loadSession('/path/to/session.bin')
```

README 原文：*"The session file is a binary file that contains the state of the context,
**it can saves time of prompt processing**."*

**用途**：用户切出 App（微信消息、锁屏）后回来，恢复会话而不是从头 prefill。

⚠️ **Android + OpenCL 后端下状态存取不完全支持**。需要设：
```ts
kv_unified: true,
flash_attn_type: 'off',
```
这是必须写进 `InferenceEngine` 初始化参数的硬要求，否则 Adreno GPU 加速与 session 恢复**二选一**。

### 3.2 `save_prompt_state_path` —— 只保存提示词处理结果

```ts
completion({
  prompt,
  n_predict: 0,                          // 只算不生成
  save_prompt_state_path: '/path/state.bin'
})
```
README 注明 *"Useful for fast prompt reuse"*。

**用途**：角色卡+世界书+人设这部分**固定前缀**（通常占提示词 60–80%）只 prefill 一次，
后续每条消息只处理新增的对话轮次 —— 增量 prefill。

### 3.3 `ctx_shift` 与 q8 KV 量化

- `ctx_shift: true`：提示词超窗时自动滚动，避免硬失败（**多模态模型必须关**：`ctx_shift: false`）
- `cache_type_k/v: 'q8_0'`：KV cache 减半，代价是 prefill 略慢

⚠️ README 注：*"Reduces memory usage at the cost of slower prompt processing"* ——
**默认对 8K 档不开 KV 量化**（8K f16 仅 1.12 GiB，8GB 机型装得下，没必要付 prefill 变慢的代价）；
但**在 16K 档及以上建议开启**：16K 若不量化则超预算，量化后 1.12 GiB 才装得下。

---

## 4. 上下文窗口分档建议

基于「8K 以内内存宽裕、8K 以上内存与时间双重受限」，窗口默认按**用户耐心**设，同时用内存做硬性准入：

| 档位 | n_ctx | 适用 | 理由 |
|---|---|---|---|
| 省流 | 4,096 | 4–6 GB 机型 | 兼容性优先，仍有对话余地 |
| **标准** | **8,192** | **8–12 GB（默认）** | prefill 可控，够放卡片+世界书+20 轮 |
| 长文 | 16,384 | 12 GB+ 自愿开启 | 需明确提示「首字较慢」 |
| 极限 | 32,768 | 发烧友 | 内存可行，但需增量 prefill 才实用 |

⚠️ **默认值应该是 8,192，不是模型支持的最大值。** 把 32K 当默认 = 首字等 13 分钟。

---

## 5. 历史摘要策略（配合窗口）

长对话必须压缩，否则 prefill 成本随轮次线性增长：

```
[系统提示 + 角色卡 + 世界书]  ← 固定前缀，save_prompt_state 缓存，永不重算
        ↓
[历史摘要]                    ← 超出窗口的旧对话，用同一模型滚动摘要
        ↓
[最近 N 轮原文]               ← 保证近处连贯
        ↓
[当前用户输入]
```

**规则**：
1. 固定前缀**必须**放在最前且逐字节稳定 —— 任何字符变化都会让缓存整体失效
2. 世界书条目按触发插入会**破坏前缀稳定性**，应做「已激活条目集合在会话内冻结」处理
3. 历史摘要用**同一个模型**跑（省内存），生成时 `n_predict` 限 200–300 token
4. 摘要触发点：历史原文超过窗口 60% 时压缩到 25%

---

## 6. 对已交付模块的影响

| 模块 | 影响 | 动作 |
|---|---|---|
| `src/character-card/buildPrompt.ts` | 需保证前缀逐字节稳定 | 检查是否有 `{{time}}` 类不稳定宏注入（本实现已不支持运行时宏 ✅） |
| `src/character-card/worldInfo.ts` | 世界书触发会破坏前缀 | 增加「激活集合冻结」选项 |
| `src/inference/InferenceEngine.ts` | 需暴露 session 存取 | 加 `saveSession`/`loadSession`/`save_prompt_state_path` |
| `src/recommend/recommend.ts` | 当前按内存推荐 | **无需改**：它管的是「选哪个模型」，与 `n_ctx` 无关；上下文预算由本节新增的窗口分档单独负责 |
| token 计数 | 当前是启发式估算 | 接入 `context.tokenize()` 换真实计数 |

⚠️ 角色卡子代理已实现启发式 token 估算（CJK 1 token/字、其余 4 字符/token，刻意高估）。
引入该策略后**应替换为 llama.rn 的真实 `tokenize()`**，因为预算决策现在依赖它。

---

## 7. 待真机验证项

| 项 | 为什么重要 | 怎么验 |
|---|---|---|
| 真实 prefill 速度 | 上表是估算区间，决定窗口默认值 | 真机跑 `prompt_per_second`（llama.rn 返回此指标） |
| `saveSession` 在目标机型是否可用 | Android+OpenCL 有限制 | 实测 + 回退到 `save_prompt_state_path` |
| 前缀稳定性能省多少 | 决定增量 prefill 收益 | 对比全量 vs 增量 prefill 的 `prompt_ms` |
| 世界书激活冻结对体验的影响 | 可能让新触发词失效 | 设定冻结周期（如每 10 轮解冻一次） |

---

## 8. 一句话总结

> **上下文窗口受两道门约束：内存决定「能不能装」，预填充时间决定「用户愿不愿意等」。
> 默认必须取两者中更严的那个 —— 8K。**

8GB 机型：32K f16 需 7.83 GiB，**装不下**（内存墙在 8K–16K 之间）；
即便如此也要默认 8K，因为 32K 提示词的 prefill 要等 13 分钟。
所以：**默认 8K + 前缀持久化缓存 + 增量 prefill + 历史滚动摘要。**
