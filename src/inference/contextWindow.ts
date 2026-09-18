/**
 * Context-window management: keep a prompt inside the model's budget.
 *
 * ── The defect this fixes ───────────────────────────────────────────────────
 * `generate()` sent EVERY message in the conversation:
 *
 *   const history = chat.messages
 *     .filter((m) => m.content.trim().length > 0)
 *     .map((m) => ({ role: m.role, content: m.content }))
 *
 * There was no trimming of any kind. On the default 4096-token window a
 * conversation reaches the limit after roughly 15–25 exchanges, and past that
 * point behaviour is not "slightly worse" — it is undefined: llama.cpp either
 * refuses the prompt or silently drops the oldest tokens, so the model loses
 * the beginning of the conversation with no indication to the user. The persona
 * description is often the FIRST thing written, which makes this worse: the
 * character silently stops being in character.
 *
 * ── The policy ──────────────────────────────────────────────────────────────
 * Three parts of a prompt have different claims on the budget:
 *
 *   1. The SYSTEM prompt (persona, world info). Never trimmed — losing it
 *      changes who the model is, which is worse than losing old small talk.
 *   2. The most recent turns. Kept in full: this is what the user is talking
 *      about.
 *   3. Older turns. Dropped whole, oldest first, until the budget fits.
 *
 * Messages are dropped in PAIRS where possible. Keeping a lone assistant reply
 * whose question was trimmed produces a model that answers a question the user
 * cannot see, and it also breaks the strict user/assistant alternation that
 * some chat templates require.
 *
 * Trimming happens from the FRONT (oldest), never the middle: the KV-cache
 * prefix stays valid for everything that survives, which matters because
 * dropping a middle message invalidates the whole cached prefix and makes the
 * next turn pay a full prefill.
 *
 * ── Why this is a pure function ─────────────────────────────────────────────
 * No store, no engine, no I/O. The trimming rules are the part worth testing,
 * and they are testable only if they are separable from the machinery that
 * feeds them.
 */

import type { ChatMessage } from '@/inference/InferenceEngine.ts'
import { estimateTokens, type TokenCounter } from '@/inference/tokenizer.ts'

/**
 * Headroom reserved for the model's reply.
 *
 * The context window is shared between prompt and completion. Without this
 * reservation a prompt that exactly fills the window leaves no room to generate,
 * and the reply is empty or truncated at the first token.
 *
 * Sized generously because `maxTokens` is a cap rather than a target: reserving
 * it costs nothing, it just stops the prompt from crowding out the answer.
 */
export const REPLY_RESERVE_TOKENS = 1024

/**
 * The largest share of the window the reply reserve may take.
 *
 * A flat 1024-token reserve is wrong on a small window: at `contextLength: 1024`
 * it would consume the ENTIRE budget and leave nothing for the prompt, so every
 * message would be trimmed and the model would answer with no history at all.
 * Capping the reserve at a fraction of the window keeps the split sensible at
 * both ends of the range — proportionally small on a 32K window, proportionally
 * sane on a 1K one.
 */
const MAX_RESERVE_FRACTION = 0.5

/**
 * Never trim below this many recent messages.
 *
 * A guard against pathological cases — an enormous system prompt, or a very
 * small configured window — collapsing the history to nothing. Even if the
 * budget is blown, keeping a couple of turns gives the model something to
 * respond to, which is a better failure than an empty prompt.
 */
export const MIN_RECENT_MESSAGES = 2

export interface TrimResult {
  /** What to actually send. */
  messages: ChatMessage[]
  /** True when something was dropped — the caller may want to tell the user. */
  trimmed: boolean
  /** How many messages were dropped. */
  droppedCount: number
  /** Token count of the returned prompt, by the counter that was used. */
  promptTokens: number
  /**
   * True when `promptTokens` came from the character heuristic rather than the
   * real tokenizer. Callers should not present an estimated number with the
   * same confidence as a measured one.
   */
  estimated: boolean
}

export interface TrimOptions {
  /** The model's context window, in tokens. */
  contextLength: number
  /**
   * Tokens to leave for the reply. Defaults to `REPLY_RESERVE_TOKENS`.
   * Pass 0 in tests that want to reason about the prompt alone.
   */
  reserveForReply?: number
  /**
   * A real tokenizer, when one is available.
   *
   * Optional: without it the function falls back to the character heuristic,
   * which is accurate enough to keep a prompt inside the window even though it
   * is not exact.
   */
  counter?: TokenCounter | null
}

/**
 * Fit a conversation into the model's context window.
 *
 * Returns the messages to send, oldest-dropped-first. When everything fits the
 * input is returned unchanged (a new array, but the same messages).
 */
export function trimToContext(
  systemMessages: readonly ChatMessage[],
  history: readonly ChatMessage[],
  options: TrimOptions,
): TrimResult {
  const requestedReserve = options.reserveForReply ?? REPLY_RESERVE_TOKENS
  // Cap the reserve so a small window is not fully consumed by it. See
  // MAX_RESERVE_FRACTION.
  const reserve = Math.min(requestedReserve, options.contextLength * MAX_RESERVE_FRACTION)
  const budget = Math.max(0, options.contextLength - reserve)

  const costOf = (message: ChatMessage): number =>
    countMessage(message, options.counter).count

  const systemCost = systemMessages.reduce((sum, m) => sum + costOf(m), 0)

  /**
   * Walk backwards from the newest message, accumulating until the budget is
   * spent. Walking backwards rather than forwards is what makes "keep the most
   * recent turns" the natural expression of the loop instead of a special case.
   */
  let used = systemCost
  let keepFrom = history.length // exclusive lower bound of what we keep

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const cost = costOf(history[i]!)
    if (used + cost > budget && history.length - i > MIN_RECENT_MESSAGES) {
      break
    }
    used += cost
    keepFrom = i
  }

  let kept = history.slice(keepFrom)

  /**
   * Repair a leading assistant turn.
   *
   * Trimming lands wherever the budget runs out, which can orphan an assistant
   * reply whose user message was dropped. Two reasons to fix it: the model sees
   * an answer with no question (which reads as the assistant talking to itself),
   * and some chat templates reject a history that does not start with a user
   * turn.
   */
  while (kept.length > 1 && kept[0]!.role === 'assistant') {
    kept = kept.slice(1)
  }

  const messages = [...systemMessages, ...kept]
  const promptTokens = messages.reduce((sum, m) => sum + costOf(m), 0)
  const droppedCount = history.length - kept.length

  return {
    messages,
    trimmed: droppedCount > 0,
    droppedCount,
    promptTokens,
    estimated: options.counter == null,
  }
}

/**
 * Count one message.
 *
 * The role and separators are not free — a chat template emits markers like
 * `<|im_start|>user\n` around every message — so a small constant is added per
 * message. Ignoring it under-counts a long history by a few percent, which is
 * exactly the direction that overflows the window.
 */
function countMessage(
  message: ChatMessage,
  counter: TokenCounter | null | undefined,
): { count: number; estimated: boolean } {
  const content = countTokens(message.content, counter)
  const PER_MESSAGE_OVERHEAD = 4
  return {
    count: content.count + PER_MESSAGE_OVERHEAD,
    estimated: content.estimated,
  }
}

/** Thin wrapper so `trimToContext` reads as prose. */
function countTokens(
  text: string,
  counter: TokenCounter | null | undefined,
): { count: number; estimated: boolean } {
  if (!counter) return { count: estimateTokens(text), estimated: true }
  const result = counter(text)
  if (typeof result === 'number' && Number.isFinite(result) && result >= 0) {
    return { count: result, estimated: false }
  }
  return { count: estimateTokens(text), estimated: true }
}

/**
 * How much budget a conversation has left, for a UI indicator.
 *
 * Returns a fraction in [0, 1] where 1 means "the window is full". Deliberately
 * reports the whole window including the reply reserve, because that is what
 * the user is being told: how close this conversation is to the limit.
 */
export function contextUsage(
  systemMessages: readonly ChatMessage[],
  history: readonly ChatMessage[],
  contextLength: number,
): number {
  if (contextLength <= 0) return 0
  const total = [...systemMessages, ...history].reduce(
    (sum, m) => sum + countMessage(m, null).count,
    0,
  )
  return Math.min(1, total / contextLength)
}
