import type { CharacterCardV2, Conversation, Message } from '@/types/domain'
import type { ChatMessage } from '@/inference/InferenceEngine'

/**
 * Prompt assembly for character chat.
 *
 * The ordering below is the SillyTavern convention and it matters: models are
 * trained on a fixed section order, and scrambling it degrades persona
 * adherence measurably. The structure, outermost first:
 *
 *   1. system_prompt      — card-level override of the base instruction
 *   2. world info         — per-conversation lorebook text
 *   3. description        — the character definition
 *   4. personality        — trait summary
 *   5. scenario           — the situation the chat opens in
 *   6. mes_example        — few-shot dialogue illustrating the voice
 *   7. post_history_instr — instructions that must land AFTER the example,
 *                           i.e. closest to the generation point
 *   8. conversation       — actual user/assistant turns
 *
 * The card's `system_prompt` REPLACES our base prompt rather than appending to
 * it. Appending is the common mistake: a card author who wrote a tight system
 * prompt gets it diluted by boilerplate, and the persona goes generic.
 */

/** Base instruction used when a card does not supply its own. */
export const DEFAULT_SYSTEM_PROMPT =
  'You are a roleplay partner. Stay in character at all times. ' +
  'Never speak or act for the user. Write in the present tense. ' +
  'Match the length and style of the user\'s messages.'

export interface PromptBudget {
  /** Total tokens the context window can hold. */
  readonly contextLength: number
  /** Tokens to leave free for the model's reply. */
  readonly reserveForReply: number
}

export interface BuiltPrompt {
  readonly messages: ChatMessage[]
  /** Tokens used by the assembled prompt, per the caller's counter. */
  readonly estimatedTokens: number
  /** How many of the oldest conversation turns were dropped to fit. */
  readonly droppedMessages: number
  readonly warnings: string[]
}

/** A pluggable token counter, so this stays testable without a model. */
export type TokenCounter = (text: string) => number

/** Default heuristic counter: ~4 characters per token for English. */
export const heuristicTokenCounter: TokenCounter = (text) => Math.ceil(text.length / 4)

/**
 * Renders the character block (steps 3–5) into one system message body.
 *
 * Kept as a single message rather than several so that trimming has a
 * meaningful unit to work with — a partially-trimmed character definition is
 * worse than none.
 */
export function renderCharacterBlock(card: CharacterCardV2): string {
  const d = card.data
  const parts: string[] = []

  if (d.description.trim()) parts.push(d.description.trim())

  if (d.personality.trim()) {
    parts.push(`Personality: ${d.personality.trim()}`)
  }

  if (d.scenario.trim()) {
    parts.push(`Scenario: ${d.scenario.trim()}`)
  }

  return parts.join('\n\n')
}

/**
 * Builds the full message array for a completion request.
 *
 * Trimming policy, in strict priority order — we drop the CHEAPEST thing that
 * still fits, never a whole section if a cheaper cut exists:
 *
 *   1. Oldest conversation turns (never the character/scenario block)
 *   2. `mes_example` (long, and only affects style)
 *   3. `world_info` (situational lore)
 *
 * Trimming is done oldest-first with the greeting (`first_mes`) protected: it
 * is the assistant's opening turn and removing it makes the model start as if
 * the conversation had no beginning.
 */
export function buildPrompt(input: {
  readonly card: CharacterCardV2
  readonly conversation: Pick<Conversation, 'worldInfo'>
  readonly history: readonly Message[]
  readonly budget: PromptBudget
  readonly countTokens?: TokenCounter
}): BuiltPrompt {
  const { card, conversation, history, budget } = input
  const count = input.countTokens ?? heuristicTokenCounter
  const warnings: string[] = []

  const available = Math.max(0, budget.contextLength - budget.reserveForReply)
  if (available <= 0) {
    warnings.push('Context budget is fully consumed by the reply reserve; no prompt fits.')
    return { messages: [], estimatedTokens: 0, droppedMessages: history.length, warnings }
  }

  const d = card.data

  const systemBody = d.system_prompt.trim() || DEFAULT_SYSTEM_PROMPT
  const characterBlock = renderCharacterBlock(card)
  const exampleBlock = d.mes_example.trim()
  const worldInfo = conversation.worldInfo.trim()
  const postHistory = d.post_history_instructions.trim()

  // Fixed sections, each costed once.
  const fixed: ChatMessage[] = [{ role: 'system', content: systemBody }]
  if (worldInfo) fixed.push({ role: 'system', content: `World info:\n${worldInfo}` })
  if (characterBlock) fixed.push({ role: 'system', content: characterBlock })
  if (exampleBlock) {
    fixed.push({ role: 'system', content: `Example dialogue:\n${exampleBlock}` })
  }
  if (postHistory) fixed.push({ role: 'system', content: postHistory })

  const fixedTokens = fixed.reduce((n, m) => n + count(m.content) + 4, 0)

  // Conversation turns, newest-first selection so the most recent exchange
  // always survives.
  const usable = history.filter((m) => m.role !== 'system' && m.content.trim().length > 0)
  const selected: Message[] = []
  let conversationTokens = 0
  let remaining = available - fixedTokens

  for (let i = usable.length - 1; i >= 0; i -= 1) {
    const msg = usable[i]
    if (!msg) continue
    const cost = count(msg.content) + 4
    // The first message (index 0) is the greeting — keep it even when it does
    // not fit, because a persona with no opening line reads as broken.
    const isGreeting = i === 0 && msg.role === 'assistant'
    if (cost > remaining && !isGreeting) break
    selected.unshift(msg)
    conversationTokens += cost
    remaining -= cost
  }

  const droppedMessages = usable.length - selected.length
  if (droppedMessages > 0) {
    warnings.push(
      `${droppedMessages} older message(s) were dropped to fit the ${budget.contextLength}-token window.`,
    )
  }

  const messages: ChatMessage[] = [
    ...fixed,
    ...selected.map((m) => ({ role: m.role, content: m.content })),
  ]

  return {
    messages,
    estimatedTokens: fixedTokens + conversationTokens,
    droppedMessages,
    warnings,
  }
}

/**
 * Picks the opening assistant message for a new conversation.
 *
 * `alternate_greetings` is a V2 feature: a card ships several openings and the
 * user (or a random roll) picks one. We surface the choice rather than
 * silently taking index 0, because picking the greeting is a real part of the
 * SillyTavern workflow.
 */
export function pickGreeting(card: CharacterCardV2, index: number): string {
  if (index <= 0) return card.data.first_mes
  const alt = card.data.alternate_greetings[index - 1]
  return alt ?? card.data.first_mes
}

/** Total number of selectable greetings: the primary plus alternates. */
export function greetingCount(card: CharacterCardV2): number {
  return 1 + card.data.alternate_greetings.length
}

/**
 * Builds the system message used when the user edits the card in-app and
 * previews it. Exposed so the editor and the runtime agree by construction.
 */
export function previewSystemPrompt(card: CharacterCardV2, worldInfo: string): string {
  const built = buildPrompt({
    card,
    conversation: { worldInfo },
    history: [],
    budget: { contextLength: 8192, reserveForReply: 1024 },
  })
  return built.messages.map((m) => `[${m.role}]\n${m.content}`).join('\n\n---\n\n')
}
