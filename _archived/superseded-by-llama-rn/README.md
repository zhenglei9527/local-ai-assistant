# 归档：被 llama.rn 原生能力取代的模块

**归档日期**：2026-09-16
**归档原因**：调研（`docs/research-llama-rn-and-ogam.md`、`docs/research-competitors.md`）证实这些模块
在 llama.rn 中已有原生对应能力，或没有任何已上架 App 实现，属自研冗余。

**为什么是归档而不是删除**：这些代码本身写得对、测试也全过，问题不在质量而在**位置**——
它们解决的是 llama.cpp 已经解决的问题。保留在归档目录里，等到真机验证后发现某个原生能力
不够用（例如 `ctx_shift` 的截断策略不符合角色扮演需求），可以低成本取回。

---

## 归档清单

| 文件 | 体积 | 取代者 | 证据 |
|---|---|---|---|
| `contextWindow.ts` | 9,473 B | llama.rn 的 `n_ctx` + `ctx_shift` | `research-llama-rn-and-ogam.md` A1：`ctx_shift: true` 由库处理滚动，超限时返回 `truncated` / `context_full` |
| `contextWindow.test.ts` | 10,735 B | 同上 | — |
| `prefixStability.ts` | 12,873 B | llama.rn 的 `saveSession` / `loadSession` | 同上：`saveSession(path, {tokenSize})` / `loadSession(path)` 直接包装
`llama_state_save_file` / `load_file`，且 `loadSession` **返回重建好的 prompt 字符串** |
| `prefixStability.test.ts` | 11,204 B | 同上 | — |
| `rollingSummary.ts` | 14,295 B | llama.rn 的 `ctx_shift`（截断）+「开新对话」 | `research-competitors.md`：**9 个 App 中零个做摘要**。Arknights 的计划文档明写
`文本不摘要、不重写`；Google Gallery 直接 `clearHistory = true` |
| `rollingSummary.test.ts` | 15,068 B | 同上 | — |
| `activationFreeze.ts` | 8,944 B | 无（原仅服务于 `prefixStability`） | 唯一的消费者是 `prefixStability`，它本身已被取代 |
| `activationFreeze.test.ts` | 12,072 B | 同上 | — |

**合计归档：94,664 B**

---

## ⚠️ 取回条件（重要）

以下任一情况成立时，应把对应模块从归档取回并重新接入：

1. **`ctx_shift` 的截断策略不符合角色扮演需求**。它按 token 数硬截，可能切断角色卡
   的设定段落；`rollingSummary` 的「压缩旧轮次而非硬截」是更符合角色扮演语义的做法。
   这不是理论问题 —— 需要真机上用一张长世界书卡实测。

2. **`saveSession` 在目标机型不可用**。已知硬约束（`research-llama-rn-and-ogam.md`）：
   Android + OpenCL 后端下 state save/load **不完全支持**，必须设
   `kv_unified: true` + `flash_attn_type: 'off'` 才能启用 —— 即
   **GPU 加速与会话恢复二选一**。如果实测发现开启会话恢复后性能不可接受，
   而 GPU 又必须开，那么 `prefixStability` 需要取回作为退化方案。

3. **世界书需要「激活集合冻结」**。`activationFreeze` 解决的问题是：世界书每轮重新
   求值会改变提示词前缀、导致 KV cache 失效。如果实测发现长对话在实际使用中
   因前缀抖动而反复重算 prefill，这个模块需要取回。

---

## 尚未归档、仍在评估中的模块

| 模块 | 体积 | 状态 |
|---|---|---|
| `src/recommend/deviceProfile.ts` | 8,406 B | **保留待接线**。PocketPal 确有 RAM×SoC 分级规则，方向正确，但应从「只按 RAM」升级为「RAM + SoC 等级」 |
| `src/ui/screens/RecommendScreen.tsx` | 27,805 B | **保留待接线**。代码完整、有测试，只是没挂进导航 |
| `src/ui/onboarding/onboarding.ts` | 27,569 B | 同上，仅被 `RecommendScreen` 引用 |

这三个不是冗余，是**未接线**。处置方式是接进导航，而不是归档。

---

## 一个方法论note

这些模块是「先按理论设计、再实现」的产物：主线程读了 llama.rn 的文档后判断需要
自研上下文管理，于是派子代理实现了一整套，测试也全绿 —— 但**没有人问「库是不是
已经做了」**。教训是：**在实现一个子系统之前，先确认依赖库的能力边界**。
`research-llama-rn-and-ogam.md` 里那五条「可以用库调用取代」的结论，本质上都是
这一个问题的答案。
