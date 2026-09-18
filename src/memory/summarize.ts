/**
 * Long-term memory for a chat that outgrows its context window.
 *
 * ── The defect this exists to fix ───────────────────────────────────────────
 *
 * The default context window is 4096 tokens. Past roughly 15-25 exchanges the
 * prompt no longer fits, and `trimToContext` does the only thing it can: it
 * drops whole older turns from the front so the newest ones still fit.
 *
 * That is correct as far as it goes — a prompt that does not fit is a hard
 * failure — but it is amnesia. The user says "我叫小明" in turn 1, and in turn 25
 * the model is asked "我叫什么？" with that turn no longer in the prompt. The
 * model is not wrong to answer "我不知道"; the information is genuinely gone.
 *
 * ── Why summarisation, and not a bigger window ──────────────────────────────
 *
 * Raising `contextLength` trades prefill latency for recall. A phone prefills
 * at single-digit tokens/second on a mid-range SoC, so doubling the window
 * doubles the wait before the first token of EVERY reply — including the short
 * ones that never needed it. The cost is paid on every turn to protect against
 * a question asked occasionally.
 *
 * The SillyTavern lineage solves it differently: periodically compress the
 * oldest messages into a short summary and keep that summary pinned in the
 * prompt. The pinned text is a few dozen tokens instead of thousands, it never
 * gets trimmed away because it lives with the system prompt, and the detail it
 * preserves is exactly the kind that gets asked about later — names, facts,
 * decisions, the shape of the relationship.
 *
 * Deliberately NOT an embedding index or a vector store. That machinery needs
 * a second model resident on the device, which is memory this app does not
 * have, and it solves a different problem (finding relevant passages in a huge
 * corpus). Here the whole history is a few thousand tokens; the problem is
 * size, not retrieval, and text compression is the operation that matches it.
 *
 * ── Why every function here is pure ─────────────────────────────────────────
 *
 * The generator lives behind `InferenceEngine`, which is a native module that
 * cannot be imported in a test run. Keeping the decision logic ("should we
 * summarise?"), the prompt construction and the parsing as pure functions means
 * all of it is testable with plain strings, and the store keeps only the
 * orchestration — load state, run the engine, write the result back.
 *
 * ── Failure policy ──────────────────────────────────────────────────────────
 *
 * Memory is an optimisation, never a precondition. Every function degrades to
 * "no summary" rather than throwing: an empty transcript, an empty model reply
 * and a summary that lost a word all have to leave the chat working.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SummarizeConfig {
  /**
   * How many messages may accumulate since the last summary before a new one
   * is due.
   *
   * 10 messages is ~5 exchanges of user+assistant. Chosen against the trigger's
   * real cost: producing a summary is a full generation, and on a phone that is
   * seconds of work competing with the reply the user is waiting for. A tighter
   * interval buys very little — the messages being folded are still well inside
   * the window — and a looser one risks the history being trimmed before it was
   * ever summarised, which is the exact amnesia this feature exists to prevent.
   */
  intervalMessages: number

  /**
   * Soft ceiling on the summary's length, in "words".
   *
   * A CJK character counts as one word (see `countWords`), so ~200 is the
   * intended size for Chinese: about a third of a screen of text, and roughly
   * 200-300 tokens — small enough that pinning it into every prompt is
   * affordable on a 4096-token window, large enough to hold the names, facts
   * and open threads a conversation accumulates.
   */
  maxWords: number

  /**
   * Below this, the model produced a fragment rather than a summary — most
   * often a reply that was cut off mid-sentence by the token cap, or a stub
   * like "好的". Such a result is rejected and the previous summary is kept.
   *
   * 25 is the floor for a summary that says anything specific; anything shorter
   * has almost certainly dropped the facts it was supposed to preserve, and
   * silently replacing a good summary with a truncated one is worse than not
   * updating at all — it destroys memory that was already working.
   */
  minWords: number

  /** Master switch. When false the caller skips the work entirely. */
  enabled: boolean
}

/** Defaults sized for a 4096-token window on a mid-range phone. */
export const DEFAULT_SUMMARIZE_CONFIG: SummarizeConfig = {
  intervalMessages: 10,
  maxWords: 200,
  minWords: 25,
  enabled: true,
}

/**
 * Second trigger: total characters accumulated since the last summary.
 *
 * The message-count trigger alone is wrong for this app, because message
 * *length* varies by an order of magnitude. Ten one-line greetings cost a few
 * dozen tokens and are not worth compressing; ten long roleplay paragraphs can
 * be several thousand tokens — most of the window — and would be trimmed away
 * long before the count reached ten.
 *
 * 2000 characters is the point where the accumulated text starts to rival the
 * summary in cost: an average Chinese paragraph is 300-400 characters, so this
 * fires after roughly five substantial messages. Expressed in characters rather
 * than tokens because it is computed without the model: counting tokens needs
 * the loaded vocabulary (`engine.countTokens`), and a trigger that must await
 * the engine cannot be a pure function.
 */
export const DEFAULT_CHARS_THRESHOLD = 2000

/**
 * Separator used to splice a new summary onto the previous one.
 *
 * Exported because the store needs the same marker to count how many times a
 * summary has been extended, and two definitions of "the marker" would drift.
 */
export const SUMMARY_SEPARATOR = '\n\n'

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

export interface ShouldSummarizeArgs {
  messageCount: number
  messagesSinceLastSummary: number
  wordsSinceLastSummary: number
  config: SummarizeConfig
  /** Overrides `DEFAULT_CHARS_THRESHOLD`; exposed for tests and for a future
   *  setting. Character count, despite the historical `words` field name — see
   *  `countWords` for why the two are the same thing for Chinese. */
  charsThreshold?: number
}

/**
 * Decide whether the conversation is due for a new summary.
 *
 * Both thresholds are INCLUSIVE: at exactly `intervalMessages` messages the
 * answer is yes. The alternative (`>`) makes "summarise every 10 messages" mean
 * every 11, which is the kind of off-by-one that is invisible in production and
 * confusing in a report.
 *
 * Returns false for a conversation that has never been summarised only when
 * there is genuinely nothing to fold — a caller that passes the full history
 * count gets a summary once the history reaches the interval, which is what
 * makes the FIRST summary happen (there is no previous summary to extend, so
 * `previousSummary` is null and the model summarises from scratch).
 */
export function shouldSummarize(args: ShouldSummarizeArgs): boolean {
  const { config } = args
  if (!config.enabled) return false

  // A conversation with nothing in it cannot be summarised, and calling the
  // engine on an empty transcript would burn a generation to produce nothing.
  if (args.messageCount <= 0) return false

  const threshold = args.charsThreshold ?? DEFAULT_CHARS_THRESHOLD

  // `> threshold` rather than `>=`: "累计字数超过阈值" — exceeding is the stated
  // rule, and a character count that merely equals the bar is not yet over it.
  return args.messagesSinceLastSummary >= config.intervalMessages || args.wordsSinceLastSummary > threshold
}

// ---------------------------------------------------------------------------
// Text measurement
// ---------------------------------------------------------------------------

/**
 * Measure text in the units the summary budget is expressed in.
 *
 * CJK characters are counted one per character; runs of Latin letters are
 * counted one per whitespace-delimited word. This is not a tokenizer and does
 * not pretend to be — it is a length ruler, and the only property it needs is
 * that a Chinese summary and an English summary of the same visible size score
 * roughly the same. A naive `split(/\s+/)` scores a 200-character Chinese
 * paragraph as ONE unit, which would let a summariser run away with an
 * arbitrarily long "25-word" summary and blow the prompt budget it was supposed
 * to protect.
 *
 * Real token counts need the loaded model's vocabulary
 * (`InferenceEngine.countTokens`); that is async and model-dependent, so it
 * cannot be used inside a pure trigger.
 */
export function countWords(text: string): number {
  if (!text) return 0
  const trimmed = text.trim()
  if (!trimmed) return 0
  // Alternation order matters: the CJK class is tried per character and must
  // not be swallowed by the Latin run.
  const matches = trimmed.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]|[A-Za-z0-9']+/g)
  return matches ? matches.length : 0
}

/** First `limit` words (CJK-aware, space-joined), for cheap budget checks. */
function firstWords(text: string, limit: number): string {
  if (limit <= 0) return ''
  const matches = text
    .trim()
    .match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]|[^\s\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g)
  if (!matches) return ''
  return matches.slice(0, limit).join(' ')
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

export interface BuildSummaryPromptArgs {
  transcript: string
  previousSummary: string | null
  maxWords: number
  /** Replaces the built-in instruction; used by tests and by a future
   *  user-editable summarisation prompt. */
  instruction?: string
}

/** The task instruction handed to the model. Kept deliberately blunt: small
 *  local models follow a short imperative far more reliably than a nuanced
 *  request, and any ambiguity here shows up as a summary written in the
 *  character's voice rather than as narration. */
const SUMMARY_INSTRUCTION =
  '你是一个对话记忆压缩器。把下面的对话压缩成一段简洁的摘要，' +
  '只保留后续对话需要的信息：人物姓名与称呼、身份与关系、关键事实与约定、' +
  '正在进行的剧情或话题、用户的偏好。' +
  '不要写评论、不要复述原话、不要编造没出现过的内容。用第三人称。'

/**
 * Build the messages the summariser hands to the engine.
 *
 * ── Incremental, not from scratch ───────────────────────────────────────────
 *
 * When a previous summary exists the model is asked to EXTEND it rather than to
 * summarise the transcript alone. That is the whole reason incremental
 * summarisation is affordable: the old summary already carries everything from
 * before it, so the transcript only has to be the delta. Re-summarising the
 * full history every time would make each pass more expensive than the last and
 * would force the caller to keep the entire history in memory forever.
 *
 * The old summary is presented as material to fold in — never as an example to
 * imitate — because a small model shown a summary-shaped blob before an
 * instruction tends to continue the blob instead of following the instruction.
 *
 * Returned as a `role` pair rather than a single string so the caller can pass
 * it straight to `engine.completion`, which takes chat messages.
 */
export function buildSummaryPrompt(
  args: BuildSummaryPromptArgs,
): Array<{ role: 'system' | 'user'; content: string }> {
  const instruction = args.instruction ?? SUMMARY_INSTRUCTION
  const budget = Math.max(1, Math.floor(args.maxWords))

  const lengths = `摘要不超过 ${budget} 字。直接输出摘要正文，不要写“摘要：”之类的标题。`

  const previous = args.previousSummary?.trim()
  const transcript = args.transcript.trim()

  if (previous) {
    return [
      { role: 'system', content: instruction },
      {
        role: 'user',
        content:
          `【已有摘要】\n${previous}\n\n` +
          `【新增对话】\n${transcript || '（无）'}\n\n` +
          `请把【新增对话】中值得长期记住的信息合并进【已有摘要】，` +
          `输出更新后的完整摘要（覆盖旧摘要，不要保留“已有摘要”这个标题）。${lengths}`,
      },
    ]
  }

  return [
    { role: 'system', content: instruction },
    {
      role: 'user',
      content: `【对话记录】\n${transcript || '（无）'}\n\n请输出这段对话的摘要。${lengths}`,
    },
  ]
}

// ---------------------------------------------------------------------------
// Formatting into the prompt
// ---------------------------------------------------------------------------

/** Marker that identifies the memory block inside a system prompt. */
export const SUMMARY_PREFIX = '[摘要]'

/**
 * Render a summary as the one line block that gets pinned into the prompt.
 *
 * Newlines are folded to spaces: the summary is injected into a system prompt
 * that is itself a sequence of paragraphs, and a multi-line summary would be
 * indistinguishable from the persona text around it — the model has no way to
 * tell where the memory ends and the character description resumes.
 *
 * Returns an EMPTY STRING for an empty summary rather than `"[摘要] "`. The
 * caller decides whether to include the block at all, and a bare marker with
 * nothing after it is worse than no block: it tells the model there is a
 * memory section and then shows it nothing, which invites it to invent one.
 */
export function formatSummaryForPrompt(summary: string | null | undefined): string {
  const flattened = (summary ?? '').replace(/\s+/g, ' ').trim()
  if (!flattened) return ''
  // Idempotent: stored summaries are written WITH the marker, so this path runs
  // on every normal read. Without this check each turn would add a second
  // marker, and the memory block would creep longer every time the prompt is
  // rebuilt.
  if (flattened.startsWith(SUMMARY_PREFIX)) return flattened
  return `${SUMMARY_PREFIX} ${flattened}`
}

// ---------------------------------------------------------------------------
// Parsing the model's reply
// ---------------------------------------------------------------------------

/**
 * Strip the wrapper the model tends to add back.
 *
 * Three failure modes, all observed from small local models asked for a
 * summary:
 *
 *   1. It echoes the marker: `[摘要] 小明…`. Harmless but it would be doubled
 *      on the next pass, and the marker is ours to add.
 *   2. It copies the heading from the prompt: `新增对话：` / `摘要：`.
 *   3. It answers with a preamble: `好的，以下是摘要：…`.
 *
 * Only leading labels are removed. A summary that mentions "摘要" in its body is
 * left alone — stripping anywhere would corrupt legitimate text.
 */
function stripLabels(text: string): string {
  let out = text.trim()
  // Repeat: "好的，以下是摘要：小明…" needs two passes to become bare content.
  for (let i = 0; i < 3; i += 1) {
    const next = out
      .replace(/^\[摘要\]\s*/, '')
      .replace(/^(以下是|这是|下面是)?\s*(更新后的)?(摘要|总结|概要)\s*[:：]\s*/, '')
      .replace(/^(好的|好)[，,]\s*/, '')
      .trim()
    if (next === out) break
    out = next
  }
  return out
}

export interface CleanSummaryOptions {
  /** Words kept when over budget. Defaults to letting the caller choose. */
  maxWords?: number
  /** Words below which the result counts as a failed summary. */
  minWords?: number
}

export interface CleanSummaryResult {
  /** The cleaned summary, or `null` when the model reply was unusable. */
  summary: string | null
  /** True when the reply was cut down to `maxWords`. */
  truncated: boolean
  /** Why the reply was rejected; `null` when it was accepted. */
  rejected: 'empty' | 'too_short' | null
}

/**
 * Turn a raw model reply into something safe to store and pin into prompts.
 *
 * This is the only function in the module that can silently LOSE information,
 * so the policy is explicit and conservative:
 *
 *   - A reply with no usable content is rejected (`summary: null`). The caller
 *     keeps the previous summary. An empty memory must never overwrite a full
 *     one.
 *   - A reply shorter than `minWords` is rejected the same way. A local model
 *     that ran into the token cap returns a mid-sentence fragment, and storing
 *     that fragment would replace a good summary with a quarter of one.
 *   - A reply longer than `maxWords` is TRUNCATED rather than rejected — the
 *     content is there, it is just verbose, and the budget exists to protect the
 *     prompt. A hard cut mid-sentence is accepted here because the alternative
 *     (an over-long summary that eats the window) is the failure mode this
 *     whole module exists to prevent. Callers that want a cleaner edge should
 *     lower the budget in the prompt, which is what usually keeps replies close
 *     to the target.
 */
export function cleanSummary(raw: string, options: CleanSummaryOptions = {}): CleanSummaryResult {
  const maxWords = options.maxWords ?? DEFAULT_SUMMARIZE_CONFIG.maxWords
  const minWords = options.minWords ?? DEFAULT_SUMMARIZE_CONFIG.minWords

  const stripped = stripLabels(raw)
  // Collapse whitespace so word counting and storage agree.
  const flattened = stripped.replace(/\s+/g, ' ').trim()

  if (!flattened) {
    return { summary: null, truncated: false, rejected: 'empty' }
  }

  const words = countWords(flattened)

  if (words < minWords) {
    return { summary: null, truncated: false, rejected: 'too_short' }
  }

  if (words > maxWords) {
    return { summary: firstWords(flattened, maxWords), truncated: true, rejected: null }
  }

  return { summary: flattened, truncated: false, rejected: null }
}

/**
 * Wrap a completed summary in the marker, for storage and for the prompt.
 *
 * Stored WITH the marker so a value read back from the database is immediately
 * usable in `formatSummaryForPrompt`, which replaces the marker rather than
 * stacking a second one.
 */
export function toStoredSummary(summary: string): string {
  const flattened = summary.replace(/\s+/g, ' ').trim()
  if (!flattened) return ''
  if (flattened.startsWith(SUMMARY_PREFIX)) return flattened
  return `${SUMMARY_PREFIX} ${flattened}`
}

// ---------------------------------------------------------------------------
// Transcript rendering
// ---------------------------------------------------------------------------

export interface TranscriptMessage {
  role: string
  content: string
  /** Optional human label; for a group chat this is who spoke. */
  name?: string | null
}

/** Role labels used in the transcript handed to the summariser. */
const ROLE_LABELS: Record<string, string> = {
  user: '用户',
  assistant: '角色',
  system: '系统',
}

/**
 * Render the messages to be folded into a single transcript block.
 *
 * Two deliberate choices:
 *
 *   - `reasoning` is NOT included. A thinking model's scratchpad is mostly
 *     self-correction ("wait, no, that's wrong, let me reconsider") and folding
 *     it in teaches the summariser that the character is uncertain about facts
 *     it states plainly elsewhere. Only what was actually said is memory.
 *   - Empty messages are skipped. The store keeps placeholder rows during
 *     streaming; a transcript of blanks would waste the summariser's budget.
 */
export function buildTranscript(messages: readonly TranscriptMessage[]): string {
  const lines: string[] = []
  for (const message of messages) {
    const content = (message.content ?? '').trim()
    if (!content) continue
    const label = message.name?.trim() || ROLE_LABELS[message.role] || message.role
    lines.push(`${label}：${content}`)
  }
  return lines.join('\n')
}

/** Total character count of a transcript, for the secondary trigger. */
export function transcriptChars(messages: readonly TranscriptMessage[]): number {
  let total = 0
  for (const message of messages) {
    total += (message.content ?? '').length
  }
  return total
}
