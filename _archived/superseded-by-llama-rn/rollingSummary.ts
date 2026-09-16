/**
 * 历史滚动摘要（rolling summarization）
 *
 * 依据 `docs/context-budget-strategy.md` §5：
 *
 *   [系统提示 + 角色卡 + 世界书]  ← 固定前缀，缓存，永不重算
 *           ↓
 *   [历史摘要]                    ← 超出窗口的旧对话，用同一模型滚动摘要
 *           ↓
 *   [最近 N 轮原文]               ← 保证近处连贯
 *           ↓
 *   [当前用户输入]
 *
 * 规则（文档 §5）：
 *   3. 摘要用**同一个模型**跑（省内存），生成时 `n_predict` 限 200–300 token
 *   4. 摘要触发点：历史原文超过窗口 60% 时压缩到 25%
 *
 * 本文件只做**决策与预算**，不做实际生成 —— 真正调模型在 `summarizer.ts`。
 * 这样全部阈值逻辑都能在 Node 下测试，不需要设备。
 *
 * 本文件是纯逻辑：不 import llama.rn，不 import react-native。
 */

import type { ChatMessage } from './InferenceEngine.ts'

/* ==========================================================================
 * 1. 阈值
 * ========================================================================== */

/**
 * 触发摘要的上下文占用比例。
 *
 * 60% 而不是 90%：摘要是**用同一个模型**跑的，本身就要 prefill 一遍即将被
 * 压缩的历史。等到 90% 才动手，那一刻的 prefill 已经贵到让用户以为卡死；
 * 而且在手机上摘要生成期间界面是不能用的。留 40% 余量，是为了让这次
 * 压缩前的 prefill 仍在「能忍」的范围内。
 */
export const SUMMARY_TRIGGER_RATIO = 0.6

/**
 * 压缩目标比例。
 *
 * 25% 而不是 40%：摘要本身就是一次有损压缩，压得不够狠就会很快再次触顶、
 * 又一次摘要 —— 每次摘要都要花掉一次完整的生成时间。压到 1/4 能把
 * 「摘要 → 再次触顶」的间隔拉到足够长，摊薄单次成本。
 */
export const SUMMARY_TARGET_RATIO = 0.25

/**
 * 生成摘要时的 `n_predict` 上限，直接对应文档 §5 规则 3 的 200–300。
 *
 * 取 256：中文摘要 256 token 约 400–500 字，足够覆盖十几轮对话的要点；
 * 再长则摘要本身开始显著吃预算，反而逼近下一次触发。
 */
export const SUMMARY_N_PREDICT = 256

/**
 * 触发摘要后，最少要保留的最近原文轮数。
 *
 * 摘要有损，且用户对最近几轮的记忆最清晰。即使预算已经很紧，也不能把
 * 最近这几轮也压掉 —— 用户会发现 AI「忘了刚才说的话」，这比慢更糟。
 */
export const MIN_RECENT_TURNS = 4

/* ==========================================================================
 * 2. 占用评估与触发判定
 * ========================================================================== */

/** 一次上下文占用的快照，用于判断是否需要摘要。 */
export interface ContextUsage {
  /** 上下文窗口总 token 数（n_ctx）。 */
  readonly windowTokens: number
  /** 固定前缀（角色卡/世界书/人设）占用的 token。 */
  readonly prefixTokens: number
  /** 历史原文占用的 token（含当前用户输入）。 */
  readonly historyTokens: number
  /** 为模型输出预留的 token。 */
  readonly reservedOutputTokens: number
}

/** 摘要决策结果。 */
export interface SummaryDecision {
  /** 是否应该触发摘要。 */
  readonly shouldSummarize: boolean
  /** 当前占用比例（0..1）。 */
  readonly usageRatio: number
  /** 触发阈值比例（0..1）。 */
  readonly triggerRatio: number
  /** 压缩后希望历史降到多少 token。 */
  readonly targetHistoryTokens: number
  /** 需要从历史中移除（转入摘要）的 token 量。 */
  readonly tokensToCompress: number
  /** 是否需要缩短历史（false 时移除量为 0）。 */
  readonly reason: string | null
}

/**
 * 当前上下文占用比例。
 *
 * 分母是 `windowTokens - reservedOutputTokens`，不是 `windowTokens`：
 * 为输出预留的那部分空间**不能**被历史占用，否则模型没地方生成回复，
 * 会直接撞到 n_ctx 上限。用可用空间做分母才是诚实的「还剩多少」。
 */
export function measureContextUsage(usage: ContextUsage): number {
  const available = usage.windowTokens - usage.reservedOutputTokens
  if (!Number.isFinite(available) || available <= 0) return 1
  const used = usage.prefixTokens + usage.historyTokens
  const ratio = used / available
  return Number.isFinite(ratio) ? Math.max(0, ratio) : 1
}

/**
 * 判断是否该压缩历史，以及压到多少。
 *
 * 决策链：
 *   1. 占用 < 60%  -> 不动（绝大多数轮次走这条）
 *   2. 占用 >= 60% -> 把历史压到可用空间的 25%
 *   3. 但**永远保留最近 `MIN_RECENT_TURNS` 轮原文**；若这会导致压不动，
 *      则退化为「不摘要」，由调用方的硬截断兜底（而不是把最近几轮也压掉）
 *
 * `historyMessages` 传入是为了执行规则 3：摘要压缩的对象只能是「可丢弃的
 * 旧轮次」，最近几轮的 token 要从可压缩额度里扣掉。
 */
export function planSummarization(
  usage: ContextUsage,
  historyMessages: readonly ChatMessage[],
  options: {
    triggerRatio?: number
    targetRatio?: number
    minRecentTurns?: number
    countTokens?: (text: string) => number
  } = {},
): SummaryDecision {
  const triggerRatio = options.triggerRatio ?? SUMMARY_TRIGGER_RATIO
  const targetRatio = options.targetRatio ?? SUMMARY_TARGET_RATIO
  const minRecentTurns = options.minRecentTurns ?? MIN_RECENT_TURNS
  // 必须与 `usage.historyTokens` 同口径（token），否则「最近几轮占了多少」
  // 和「历史总共多少」会在不同单位上相减，得出无意义的压缩量。
  const count = options.countTokens ?? heuristicTokens

  const usageRatio = measureContextUsage(usage)
  const available = usage.windowTokens - usage.reservedOutputTokens

  const no = (reason: string | null): SummaryDecision => ({
    shouldSummarize: false,
    usageRatio,
    triggerRatio,
    targetHistoryTokens: usage.historyTokens,
    tokensToCompress: 0,
    reason,
  })

  // 窗口本身就不可用（配置错误）：不做摘要，让上层报错。
  if (!Number.isFinite(available) || available <= 0) {
    return no('上下文窗口小于为输出预留的空间，配置无效。')
  }

  if (usageRatio < triggerRatio) {
    return no(null)
  }

  // 目标：把**可压缩部分**压到摘要预算 targetHistoryTokens。
  //
  // ⚠️ 这里有一个容易写错的地方，值得写清楚：所谓「压到窗口的 25%」指的是
  // 整个历史最终占用的量，它由两块组成 ——
  //
  //     最终历史 = 必须保留的最近若干轮原文 + 摘要文本
  //
  // 最近几轮是**不可压缩**的，它们的大小已经在 historyTokens 里了；而摘要
  // 文本是新产生的，需要给它留额度。所以：
  //
  //     要移除的原文量 = historyTokens - recentTokens - 摘要额度
  //
  // 早先的实现把 targetHistoryTokens 同时当作「目标总量」和「摘要额度」，
  // 于是最近几轮被减了两次，压缩量偏小 → 压缩完仍高于阈值，下一轮立刻又
  // 触发摘要（端到端测试正是靠这一点抓出来的：压缩后占用 0.81，看似成功
  // 其实没降下来）。
  const targetHistoryTokens = Math.floor(available * targetRatio)

  // 最近 minRecentTurns 条消息必须保留原文，它们占的额度不可压缩。
  const recentCount = Math.max(0, minRecentTurns)
  const recent = historyMessages.slice(-recentCount)
  const recentTokens = recent.reduce((s, m) => s + count(m.content), 0)

  // 摘要文本能占用的额度：目标总量减去不可动的最近几轮。
  // 若最近几轮本身就超过目标总量，额度为 0 —— 此时没有压缩空间。
  const summaryBudgetTokens = Math.max(0, targetHistoryTokens - recentTokens)

  // 要移除的原文量
  const tokensToCompress = Math.max(
    0,
    usage.historyTokens - recentTokens - summaryBudgetTokens,
  )

  // ⚠️ 摘要额度为 0 意味着「最近几轮本身就超过了目标总量」，此时没有地方放
  // 摘要文本。若仍按上面的差值去压缩，结果是：旧轮次被删掉了，但**摘要无处
  // 可放**——净效果只是丢历史，占用并没有降到目标，下一轮还要再摘要一次。
  // 这不是压缩，是纯损失。所以这种情况直接判为「压不动」，交给硬截断。
  if (summaryBudgetTokens <= 0 || tokensToCompress <= 0) {
    // 触发线到了，但可压缩的部分不足以达到目标。此时**不强行压缩最近几轮**，
    // 而是报告「需要摘要但压不动」，交由调用方决定是否硬截断。
    return {
      shouldSummarize: false,
      usageRatio,
      triggerRatio,
      targetHistoryTokens,
      tokensToCompress: 0,
      reason:
        '上下文已超过触发线，但可压缩的旧轮次不足以降到目标；' +
        `最近 ${recentCount} 轮原文必须保留。将由硬截断兜底。`,
    }
  }

  return {
    shouldSummarize: true,
    usageRatio,
    triggerRatio,
    targetHistoryTokens,
    tokensToCompress,
    reason:
      `上下文占用 ${(usageRatio * 100).toFixed(0)}%（阈值 ${(triggerRatio * 100).toFixed(0)}%）：` +
      `压缩约 ${tokensToCompress} token 的历史为摘要，目标降到 ${targetHistoryTokens} token。`,
  }
}

/* ==========================================================================
 * 3. 分批选择与摘要提示词
 * ========================================================================== */

/** 摘要的输入：一批将被替换掉的旧消息。 */
export interface SummaryBatch {
  /** 需要被摘要的消息（按时间升序）。 */
  readonly messages: readonly ChatMessage[]
  /** 这些消息估算占用的 token。 */
  readonly tokens: number
}

/**
 * 选出这一轮要摘要掉的那批旧消息。
 *
 * 策略：从**最旧**的一端开始收，直到凑够 `tokensToCompress`。保留最近
 * `minRecentTurns` 条不动。
 *
 * 为什么从最旧开始而不是按比例抽：相邻的对话轮次语义连续，抽掉中间会
 * 让摘要模型收到互不相关的片段，产出的摘要会丢失因果。整段最旧的连续
 * 区间是唯一自洽的选择。
 */
export function selectSummaryBatch(
  historyMessages: readonly ChatMessage[],
  tokensToCompress: number,
  options: { minRecentTurns?: number; countTokens?: (text: string) => number } = {},
): SummaryBatch {
  const minRecentTurns = options.minRecentTurns ?? MIN_RECENT_TURNS
  const count = options.countTokens ?? heuristicTokens

  const protectFrom = Math.max(0, historyMessages.length - Math.max(0, minRecentTurns))
  const candidates = historyMessages.slice(0, protectFrom)

  const picked: ChatMessage[] = []
  let tokens = 0

  for (const m of candidates) {
    if (tokens >= tokensToCompress) break
    picked.push(m)
    tokens += count(m.content)
  }

  return { messages: picked, tokens }
}

/**
 * 构造送给模型的摘要请求。
 *
 * 用 `role: 'user'` 而不是 system：system 段是**固定前缀**，往里塞内容等于
 * 每轮换一次前缀，缓存全废 —— 这正是本策略要避免的事。摘要请求走成一次
 * 独立的 completion，不复用前缀缓存。
 */
export function buildSummaryPrompt(
  previousSummary: string | null,
  batch: SummaryBatch,
): ChatMessage[] {
  const transcript = batch.messages
    .map((m) => `${m.role === 'assistant' ? '角色' : '用户'}：${m.content}`)
    .join('\n')

  const parts: string[] = [
    '请把下面这段角色扮演对话压缩成要点摘要，供后续对话作为背景参考。',
    '要求：保留人物关系、已发生的关键事件、承诺与约定、当前场景与情绪走向；',
    '省略寒暄与重复内容。用第三人称陈述，不要编造未出现的信息。',
    '只输出摘要正文，不要加任何前后缀或标题。',
  ]

  if (previousSummary && previousSummary.trim()) {
    parts.push('', '已有的更早摘要（请与之合并，不要重复其中已写明的内容）：', previousSummary.trim())
  }

  parts.push('', '需要压缩的对话：', transcript)

  return [{ role: 'user', content: parts.join('\n') }]
}

/**
 * 摘要请求的采样参数。
 *
 * 温度刻意压低（0.3）：摘要是**信息压缩**任务，不是创作任务，高温只会带
 * 来编造。而角色扮演本身的默认温度是 0.8，两者必须分开设置。
 */
export function summarySampling(overrides: {
  maxTokens?: number
} = {}): { temperature: number; maxTokens: number; topP: number } {
  return {
    temperature: 0.3,
    maxTokens: overrides.maxTokens ?? SUMMARY_N_PREDICT,
    topP: 0.9,
  }
}

/* ==========================================================================
 * 4. 摘要拼接
 * ========================================================================== */

/** 摘要段在提示词里的包裹形态，便于模型区分「这是压缩过的背景」。 */
export function wrapSummary(summary: string): string {
  const body = summary.trim()
  if (!body) return ''
  return `[以下是此前对话的摘要]\n${body}\n[摘要结束]`
}

/**
 * 把摘要接在历史最前面。
 *
 * ⚠️ 摘要**属于可变后缀**，不能进固定前缀。摘要会在每次压缩后变化，若把它
 * 拼进 system 段，前缀就会跟着变，缓存失效 —— 与 `prefixStability.ts` 的
 * 规则一致。
 */
export function prependSummary(
  summary: string | null,
  messages: readonly ChatMessage[],
): ChatMessage[] {
  const wrapped = summary ? wrapSummary(summary) : ''
  if (!wrapped) return [...messages]
  return [{ role: 'user', content: wrapped }, ...messages]
}

/** 兜底估算：与 buildPrompt.estimateTokens 同口径，避免循环依赖而内联。 */
function heuristicTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0x3040 && cp <= 0x30ff) ||
      (cp >= 0xac00 && cp <= 0xd7af)
    ) {
      cjk++
    }
  }
  const rest = text.length - cjk
  return cjk + Math.ceil(rest / 4)
}
