/**
 * Token 计数：真实分词优先，启发式仅作兜底。
 *
 * ============================================================================
 * 为什么要有这个模块
 * ============================================================================
 *
 * 本项目此前在 **5 个地方**各写了一份 token 估算器（buildPrompt / worldInfo /
 * rollingSummary / MockInferenceEngine / RemoteEngine），每份都是
 * 「CJK 1 token/字 + 其余 4 字符/token」。这带来两个问题：
 *
 *  1. **五份实现会漂移** —— 任何一份改了，其余四份不会跟着改，于是 UI 上
 *     的上下文占用条、截断决策、预算判断三者对同一个字符串给出不同答案。
 *  2. **它本来就不该手写** —— llama.rn 已经把 llama.cpp 的真实分词器暴露
 *     成 JS API（`context.tokenize()`，见 node_modules/llama.rn/src/index.ts
 *     L939），返回的是**词表实际切分结果**，而不是猜测。
 *
 * 手搓估算在中文上偏差尤其大：BPE 对中文常见 1-2 字/token，而启发式固定
 * 按 1 字/token 且向上取整，再叠加各调用点的「安全余量」，最终会出现
 * 「明明还有空间却说放不下」——用不准的数字做预算决策是这个问题的根因。
 *
 * ============================================================================
 * 设计
 * ============================================================================
 *
 * `countTokens(text, counter)` 接受一个可选的**真实计数器**。有模型时传入
 * 绑定到已加载 context 的计数器，没有时（未加载 / 云端 / 单测）退回启发式。
 *
 * 调用方不需要知道当前有没有模型 —— 这正是把它们收敛到一个函数的意义。
 * 但**重要**：`isEstimate()` 可以问出这次结果是不是估算，UI 应据此弱化
 * 展示（例如给数字加「约」），而不是把估算值当精确值显示给用户。
 */

/** 真实分词器签名。由引擎适配器提供，绑定到已加载的 context。 */
export type TokenCounter = (text: string) => number | Promise<number>

export interface TokenCountResult {
  readonly count: number
  /** true 表示这是启发式估算，不是词表真实切分结果。 */
  readonly estimated: boolean
}

/**
 * 启发式兜底估算。
 *
 * ⚠️ 这是**兜底**，不是主路径。只有在没有已加载模型时才会用到：
 *   - 模型还没加载，但 UI 要显示历史消息的占用
 *   - 云端引擎（服务端自己分词，客户端无从得知真实词表）
 *   - 单元测试
 *
 * 口径有意保持不变（CJK 1 token/字、其余 4 字符/token、向上取整），因为它
 * 是**保守**的：宁可高估导致早截断，不要低估导致超窗报错。但正因保守，
 * 它不该用于「还剩多少空间」这类需要精确的决策。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    const isCJK =
      (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一汉字
      (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
      (cp >= 0x3040 && cp <= 0x30ff) || // 日文假名
      (cp >= 0xac00 && cp <= 0xd7af) || // 韩文
      (cp >= 0xf900 && cp <= 0xfaff) || // 兼容汉字
      (cp >= 0x3000 && cp <= 0x303f); // CJK 标点
    if (isCJK) cjk++
    else other++
  }
  return Math.ceil(cjk + other / 4)
}

/**
 * 计数一个字符串。
 *
 * @param text    待计数文本
 * @param counter 真实分词器；缺省则走启发式估算
 */
export async function countTokens(
  text: string,
  counter?: TokenCounter | null,
): Promise<TokenCountResult> {
  if (!counter) {
    return { count: estimateTokens(text), estimated: true }
  }
  try {
    const count = await counter(text)
    // 防御：真实分词器不应返回负数或非有限值。真发生了说明适配器坏了，
    // 此时退回估算而不是把 NaN 传进预算运算（NaN 会让所有比较恒为 false，
    // 于是「放不下」的判断永不触发，反而一路放行到超窗崩溃）。
    if (!Number.isFinite(count) || count < 0) {
      return { count: estimateTokens(text), estimated: true }
    }
    return { count, estimated: false }
  } catch {
    return { count: estimateTokens(text), estimated: true }
  }
}

/**
 * 同步计数，仅在**确定没有真实分词器**时使用。
 *
 * 存在理由是有些调用点（世界书扫描、角色卡预算预检）在异步上下文里很别扭，
 * 而这些场景发生在模型加载**之前**，本来就没有真实分词器可用。不要用它
 * 替代 `countTokens` 去做「还剩多少 token」的运行时决策。
 */
export function countTokensSync(
  text: string,
  counter?: TokenCounter | null,
): TokenCountResult {
  if (!counter) return { count: estimateTokens(text), estimated: true }
  const result = counter(text)
  if (typeof result === 'number' && Number.isFinite(result) && result >= 0) {
    return { count: result, estimated: false }
  }
  // Promise 或异常值：同步上下文里拿不到，退回估算。
  return { count: estimateTokens(text), estimated: true }
}

/**
 * 把 llama.rn 的 `context.tokenize()` 包装成 `TokenCounter`。
 *
 * 真实签名（node_modules/llama.rn/src/index.ts L939）：
 *   tokenize(text, { media_paths } = {}): Promise<NativeTokenizeResult>
 * 结果形如 `{ tokens: number[], ... }`，长度即 token 数。
 *
 * 这里用结构化类型而不是 import llama.rn 的类型，是为了让本模块保持
 * 零依赖 —— 它要能在 Node 单测里直接跑。
 */
export function makeLlamaTokenCounter(context: {
  tokenize: (
    text: string,
    opts?: { media_paths?: string[] },
  ) => Promise<{ tokens: number[] }>
}): TokenCounter {
  return async (text: string) => {
    const result = await context.tokenize(text)
    return result.tokens.length
  }
}
