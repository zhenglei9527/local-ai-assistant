/**
 * 前缀稳定性（prefix stability）与缓存键构造
 *
 * 依据 `docs/context-budget-strategy.md` §5：固定前缀（系统提示 + 角色卡 +
 * 世界书 + 人设）**必须逐字节稳定**，任何字符变化都会让 `save_prompt_state_path`
 * 的缓存整体失效，用户就要重新等几分钟的 prefill。
 *
 * 这听起来是「注意别写随机数」的软要求，但实际上很容易被破坏。本文件把它变成
 * 可检查的硬约束：
 *
 *   1. `splitPrompt()` —— 把组装好的提示词切分成「稳定前缀」与「可变后缀」。
 *      前缀 = system 段（角色卡/世界书/人设），后缀 = 历史 + 当前输入。
 *   2. `computePrefixKey()` —— 由前缀内容算出缓存键。只有键不变时才允许复用
 *      已持久化的 prompt state。
 *   3. `findVolatileContent()` —— 扫描前缀里有没有时间戳、UUID、随机数等
 *      每轮都会变的字面量。这是**检测**，不是修复；检测到就该由调用方把那段
 *      从固定前缀移到可变后缀，或者去掉。
 *
 * 本文件是纯逻辑：不 import llama.rn，不 import react-native，可在 Node 下测试。
 */

import type { ChatMessage } from './InferenceEngine.ts'

/* ==========================================================================
 * 1. 提示词切分
 * ========================================================================== */

/** 组装后的提示词里，「稳定前缀」与「可变后缀」的边界。 */
export interface SplitPrompt {
  /**
   * 固定前缀文本：跨轮次逐字节不变的部分。
   *
   * llama.rn 的 `save_prompt_state_path` 缓存的就是这段的 prefill 结果。
   * 若为空，说明没有可缓存的内容（例如没有角色卡），调用方应跳过缓存逻辑。
   */
  readonly prefix: string
  /**
   * 可变后缀：每轮都会变的部分（历史 + 当前用户输入）。
   * 这部分永远要重新 prefill，但其长度通常远小于前缀。
   */
  readonly suffix: string
  /** 前缀占整段提示词的字符比例（0..1）。用于向用户展示「省了多少」。 */
  readonly prefixShare: number
}

/**
 * 把 system 段 + 消息数组切分成前缀/后缀。
 *
 * 切分规则（与 `buildPrompt.ts` 的产物结构对应）：
 *   - 前缀 = `systemPrompt`（角色卡 + 世界书 + 人设 + jailbreak 等全部 system 段）
 *   - 后缀 = messages 中除「作为前缀复本的 system 消息」之外的全部内容
 *
 * ⚠️ 历史里**可能**夹杂 `role: 'system'` 的消息（作者注按深度插入就是这种，
 * 见 buildPrompt.ts 第 6 步）。这些消息的位置随对话轮次推移而变，属于可变
 * 内容，因此**不能**算进前缀。判据是「与 systemPrompt 逐字节相同」而不是
 * 「role 是 system」—— 后者会把作者注错误地冻结进前缀。
 */
export function splitPrompt(
  systemPrompt: string,
  messages: readonly ChatMessage[],
): SplitPrompt {
  const prefix = systemPrompt ?? ''

  const suffixParts: string[] = []
  for (const m of messages) {
    // 只有与 systemPrompt 完全一致的 system 消息才是「前缀的复本」，跳过它；
    // 其余 system 消息（作者注/按深度注入的世界书）都是可变后缀的一部分。
    if (m.role === 'system' && m.content === prefix) continue
    suffixParts.push(`${m.role}:${m.content}`)
  }
  const suffix = suffixParts.join('\n')

  const total = prefix.length + suffix.length
  return {
    prefix,
    suffix,
    prefixShare: total === 0 ? 0 : prefix.length / total,
  }
}

/* ==========================================================================
 * 2. 缓存键
 * ========================================================================== */

/**
 * 由前缀内容算出一个稳定的缓存键。
 *
 * 用 FNV-1a 32 位而不是 crypto：这是**缓存失效检测**，不是安全用途 —— 我们
 * 只需要「内容变了键就变」，不需要抗碰撞。FNV-1a 在 JS 里是纯整数运算，
 * Hermes 上快且无依赖。
 *
 * ⚠️ 用字符串而不是数值作为返回键。数值哈希在 JS 里容易在日志/JSON 往返中
 * 被当成 number 处理而丢失精度或格式（`1234567890` vs `1234567890.0`），
 * 前缀一致性判断又恰恰要求逐字节可比。
 *
 * 键里同时带上前缀长度：哈希碰撞到「不同长度但同哈希」时也能区分开。
 */
export function computePrefixKey(prefix: string): string {
  const h = fnv1a(prefix)
  return `p${prefix.length}-${h.toString(16).padStart(8, '0')}`
}

function fnv1a(input: string): number {
  // FNV-1a 32-bit。Math.imul 保证 32 位整数乘法在 JS 的 double 上不失真。
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  // 转成无符号再输出，避免出现负号导致键的形态不稳定。
  return hash >>> 0
}

/* ==========================================================================
 * 3. 易变内容检测
 * ========================================================================== */

/** 命中一条易变模式。 */
export interface VolatileMatch {
  /** 规则名，用于给用户解释「为什么前缀不稳定」。 */
  readonly rule: string
  /** 实际命中的原文片段（已截断，避免把整段卡塞进日志）。 */
  readonly sample: string
  /** 该规则为什么危险。 */
  readonly why: string
}

interface VolatileRule {
  readonly name: string
  readonly pattern: RegExp
  readonly why: string
}

/**
 * 会随「当前时间」或「本次运行」变化、因而不该出现在固定前缀里的模式。
 *
 * 注意这些**不是**「宏没有展开」的检测 —— 未展开的 `{{time}}` 是稳定字面量，
 * 反倒不会破坏缓存；真正破坏缓存的是已经展开成当前时间戳的结果。所以规则
 * 匹配的是**展开后的形态**。
 */
const VOLATILE_RULES: readonly VolatileRule[] = [
  {
    name: 'iso-timestamp',
    // 2026-09-08T14:23:01Z / 2026-09-08T14:23:01.123+08:00
    pattern: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/,
    why: 'ISO 时间戳每轮都变；前缀一旦含它，缓存必然失效。',
  },
  {
    name: 'clock-time',
    // 14:23:01 这类裸时间（不误伤 1.5:1 之类比例，故要求两侧非数字且含秒）
    pattern: /(?<![\d:])\d{1,2}:\d{2}:\d{2}(?![\d:])/,
    why: '带秒的时钟时间几乎必然是「现在几点」，会每轮变化。',
  },
  {
    name: 'date-slash',
    // 2026/09/08 或 09/08/2026
    pattern: /\b\d{4}\/\d{1,2}\/\d{1,2}\b|\b\d{1,2}\/\d{1,2}\/\d{4}\b/,
    why: '斜杠日期通常是「今天」，跨天即失效。',
  },
  {
    name: 'uuid',
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
    why: 'UUID 每次生成都不同，若由本次运行注入则会破坏前缀。',
  },
  {
    name: 'long-hex',
    // 16 位以上十六进制串：哈希/随机数常见形态。排除常见英文单词形态。
    pattern: /\b[0-9a-f]{16,}\b/i,
    why: '长十六进制串通常是哈希或随机种子，每轮不同。',
  },
  {
    name: 'epoch-millis',
    // 13 位数字（毫秒时间戳）或 10 位（秒级时间戳），排除明显的其他量纲由上下文承担
    pattern: /\b1[5-9]\d{11}\b/,
    why: '13 位数字是毫秒时间戳（2020 年后），每轮都在变。',
  },
]

/**
 * 扫描一段文本，返回其中所有「会破坏前缀稳定性」的片段。
 *
 * 返回空数组表示该前缀**看起来**是稳定的 —— 这是必要条件，不是充分条件：
 * 只要两次调用的入参不同，前缀就会不同，这一点只能靠比较前后两次的
 * `computePrefixKey()` 结果来发现（见 `isPrefixStable`）。
 */
export function findVolatileContent(text: string): VolatileMatch[] {
  if (!text) return []
  const out: VolatileMatch[] = []

  for (const rule of VOLATILE_RULES) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g')
      ? rule.pattern.flags
      : `${rule.pattern.flags}g`)
    let m: RegExpExecArray | null
    // 每条规则只报一次，避免同一段卡里几十个时间戳刷屏。
    m = re.exec(text)
    if (m) {
      out.push({
        rule: rule.name,
        sample: truncate(m[0], 60),
        why: rule.why,
      })
    }
  }

  return out
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`
}

/* ==========================================================================
 * 4. 跨轮次稳定性判定
 * ========================================================================== */

/** 两次组装的对比结果。 */
export interface PrefixStabilityReport {
  /** 前缀是否逐字节相同（= 缓存可以命中）。 */
  readonly stable: boolean
  /** 上一轮的前缀键。 */
  readonly previousKey: string | null
  /** 本轮的前缀键。 */
  readonly currentKey: string
  /** 不稳定的原因（稳定时为 null）。 */
  readonly reason: string | null
}

/**
 * 比较两轮之间的固定前缀。
 *
 * 调用方应在每次组装后调用它，并把结果写进日志/调试面板：如果 `stable` 变成
 * false，说明有一处改动破坏了缓存，用户的下一轮会退化成全量 prefill。
 * 这是把「缓存失效」从一种难以察觉的性能回退，变成一条可见的告警。
 */
export function comparePrefix(
  previousPrefix: string | null,
  currentPrefix: string,
): PrefixStabilityReport {
  const currentKey = computePrefixKey(currentPrefix)

  if (previousPrefix == null) {
    return {
      stable: true,
      previousKey: null,
      currentKey,
      reason: null,
    }
  }

  const previousKey = computePrefixKey(previousPrefix)
  if (previousKey === currentKey) {
    return { stable: true, previousKey, currentKey, reason: null }
  }

  // 定位第一处差异，给出可操作的报错而不是只说「变了」。
  // 用 0-based 下标（并显式标注），避免「第几个字符」在中英文/0-based 与
  // 1-based 之间产生歧义 —— 排查前缀问题时下标要能直接喂给 slice()。
  const idx = firstDifferenceIndex(previousPrefix, currentPrefix)
  const reason =
    `固定前缀在下标 ${idx}（0-based）处发生变化 ` +
    `(${describeAt(previousPrefix, idx)} → ${describeAt(currentPrefix, idx)})；` +
    '本轮无法复用已缓存的 prompt state，将退化为全量 prefill。'

  return { stable: false, previousKey, currentKey, reason }
}

/** 首个不同的字符下标；完全相同则返回 -1。 */
export function firstDifferenceIndex(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) return i
  }
  if (a.length === b.length) return -1
  return n
}

/** 描述某下标附近的字符，便于人工定位。 */
function describeAt(s: string, idx: number): string {
  if (idx >= s.length) return '<结尾>'
  const ch = s[idx]
  const code = ch.codePointAt(0) ?? 0
  // 把换行等不可见字符显式写出来，否则报错信息无法定位。
  const shown =
    ch === '\n' ? '\\n' : ch === '\t' ? '\\t' : ch === '\r' ? '\\r' : ch
  return `'${shown}'(U+${code.toString(16).toUpperCase().padStart(4, '0')})`
}

/* ==========================================================================
 * 5. 缓存决策
 * ========================================================================== */

/**
 * 是否值得为这个前缀做持久化缓存。
 *
 * 门槛是 `minPrefixTokens`：如果前缀本身只有几百 token，恢复缓存的开销
 * （读写一个二进制 state 文件）可能比重新 prefill 还大，而且会让代码路径
 * 变复杂。默认 512 token 是「一秒以上的 prefill」的量级。
 *
 * 另一个条件：前缀必须**非空**。空前缀意味着没有角色卡，此时缓存没有意义。
 */
export function shouldPersistPrefix(
  prefixTokens: number,
  minPrefixTokens = DEFAULT_MIN_PREFIX_TOKENS,
): boolean {
  return prefixTokens >= minPrefixTokens
}

/** 默认的最小可缓存前缀长度（token）。 */
export const DEFAULT_MIN_PREFIX_TOKENS = 512

/**
 * 估算「省下了多少次 prefill」的直观收益，用于 UI 文案。
 *
 * 返回秒数，按调用方给出的 prefill 速度（tok/s）。速度未知时用设计文档的
 * 保守参考值 20 tok/s —— 宁可让用户预期偏悲观。
 */
export function prefixReuseSavingSeconds(
  prefixTokens: number,
  prefillTokensPerSecond: number,
): number {
  const speed =
    Number.isFinite(prefillTokensPerSecond) && prefillTokensPerSecond > 0
      ? prefillTokensPerSecond
      : 20
  return prefixTokens / speed
}
