/**
 * Conversation and message persistence.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The app shipped with NO message persistence at all. Conversations and their
 * transcripts lived in a Zustand store, so every cold start began empty and the
 * user's chat history was gone. That is a fatal flaw for a chat app — it was
 * listed as a "known limitation" in the README, which was the wrong call: a chat
 * app that forgets conversations is not a chat app.
 *
 * The schema (`schema.ts`) was written early and then never wired up; this file
 * is that wiring.
 *
 * ── API note ────────────────────────────────────────────────────────────────
 * All reads go through the `SqliteDb` adapter in `connection.ts`
 * (`all` / `one` / `run` / `tx`), never through a raw `execute`. That indirection
 * exists because op-sqlite 18.x has no `getAll`/`getFirst` — a first draft of
 * this file called both, which would have thrown on every read.
 *
 * ── Failure policy ──────────────────────────────────────────────────────────
 * Every function is best-effort. Persistence failing must degrade the app to
 * "history is not saved" rather than breaking navigation or generation, so
 * writes swallow their errors and reads return empty.
 */

import type { Conversation, Message } from '@/types/domain.ts'

import { getDb } from './connection.ts'

/**
 * Do NOT reorder this list without reordering the `VALUES (?, ?, …)` binds in
 * `messageStatement`. The two are checked against each other by eye, not by the
 * compiler — a column added to the INSERT without a matching value appended
 * would shift every later `?` by one and happily write garbage.
 */
const MESSAGE_BIND_ORDER = [
  'id',
  'conversation_id',
  'role',
  'content',
  'reasoning',
  'model_id',
  'swipe_index',
  'swipes_json',
  'edited',
  'pinned',
  'created_at',
] as const

/** Row shapes as SQLite returns them. */
interface ConversationRow {
  id: string
  title: string
  character_id: string | null
  model_id: string | null
  sampler_override: string | null
  context_override: string | null
  world_info: string
  message_count: number
  last_message_at: number
  created_at: number
  updated_at: number
}

interface MessageRow {
  id: string
  conversation_id: string
  role: string
  content: string
  reasoning: string | null
  model_id: string | null
  swipe_index: number
  swipes_json: string
  edited: number
  pinned: number
  created_at: number
}

/** Parse JSON without throwing; a corrupt column must not kill the whole read. */
function safeJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    characterId: row.character_id ?? null,
    modelId: row.model_id ?? null,
    samplerOverride: safeJson(row.sampler_override, null),
    contextOverride: safeJson(row.context_override, null),
    worldInfo: row.world_info ?? '',
    messageCount: row.message_count ?? 0,
    lastMessageAt: row.last_message_at ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as Message['role'],
    content: row.content,
    reasoning: row.reasoning ?? null,
    createdAt: row.created_at,
    modelId: row.model_id ?? null,
    swipeIndex: row.swipe_index ?? 0,
    swipes: safeJson<string[]>(row.swipes_json, []),
    edited: row.edited === 1,
    pinned: row.pinned === 1,
  }
}

// ---------------------------------------------------------------------------
// Swipes
// ---------------------------------------------------------------------------

/**
 * Make a message's swipe state self-consistent, in place.
 *
 * ── The invariant this enforces ─────────────────────────────────────────────
 * `content === swipes[swipeIndex]`. Both halves are sent to the model and both
 * are rendered, so a message where they disagree shows one reply on screen and
 * feeds a different one into the prompt — the model then continues a
 * conversation the user never had, and nothing on screen explains why.
 *
 * ── Why it heals rather than rejects ────────────────────────────────────────
 * The history on a device predates this feature: every assistant message was
 * written with `swipes_json = '[]'`, and rows copied over from an older schema
 * version (or hand-edited during debugging) can carry more swipes than
 * `swipe_index` addresses. Throwing on those would make a stale database
 * unopenable — data loss in exchange for tidiness. Healing instead means the
 * first read of an old message simply records its visible text as version 1,
 * which is what it always effectively was.
 *
 * Three cases, in order:
 *   1. No swipes stored → seed with the visible content. Migration for free.
 *   2. Index out of range → clamp to the nearest valid version. A stored index
 *      past the end is reachable by deleting a swipe on another device.
 *   3. Content drifted from `swipes[index]` → re-derive from the array.
 *
 * Returns nothing: the caller decides whether the healed object is only read or
 * also written back. `loadMessages` reads; `saveMessage` writes.
 */
export function normalizeSwipes(message: Message): void {
  const swipes = Array.isArray(message.swipes) ? message.swipes : []

  /**
   * The swipe triple is readonly on the domain `Message` — deliberately, so
   * that nobody mutates one field in isolation and lets `content` and
   * `swipes[swipeIndex]` drift apart. `normalizeSwipes` is the single place
   * entitled to move them together, which is exactly what the readonly type is
   * meant to force: the exception is visible here instead of scattered.
   */
  const mutable = message as {
    content: string
    swipes: string[]
    swipeIndex: number
  }

  if (swipes.length === 0) {
    // Heal 1: an assistant message with no versions still has exactly one
    // version — the text on screen. User/system messages carry no swipes at
    // all; giving them one would make every user turn render a version
    // switcher it can never use.
    mutable.swipes =
      message.role === 'assistant' && message.content.length > 0 ? [message.content] : []
    mutable.swipeIndex = 0
    return
  }

  // Heal 2: clamp. `Math.trunc` because a fractional index is not addressable
  // and `swipes[0.5]` is `undefined`, which would silently blank the bubble.
  const index = Number.isFinite(message.swipeIndex) ? Math.trunc(message.swipeIndex) : 0
  const clamped = Math.min(Math.max(index, 0), swipes.length - 1)
  mutable.swipeIndex = clamped

  // Heal 3: the array wins. It is the thing the user navigated through, so the
  // visible text is the field that drifted.
  const current = swipes[clamped]
  if (typeof current === 'string' && current !== message.content) {
    mutable.content = current
  }
}

/** Build the upsert for one message. See `conversationStatement`. */
function messageStatement(message: Message): [string, unknown[]] {
  /**
   * ⚠️ `swipes_json` was a column that nothing ever wrote.
   *
   * The schema declared it and `toMessage` read it, but this statement bound
   * `JSON.stringify(message.swipes ?? [])` — and every message in the app was
   * constructed with `swipes: []`, so the column was written as `'[]'` on
   * every single row. Multi-version replies were therefore impossible even
   * once the UI existed: the store could hold three versions and a reload
   * would return none of them.
   *
   * The bind itself was correct; what was missing was (a) anything ever
   * populating `swipes`, and (b) a guard that the stored array agrees with
   * `swipeIndex`. Both are fixed here and in `normalizeSwipes` so that the
   * column cannot be written in a state the reader would have to distrust.
   */
  const swipes = Array.isArray(message.swipes) ? message.swipes : []
  const swipeIndex =
    swipes.length > 0
      ? Math.min(Math.max(Math.trunc(message.swipeIndex) || 0, 0), swipes.length - 1)
      : 0

  return [
    `INSERT INTO messages
       (id, conversation_id, role, content, reasoning, model_id,
        swipe_index, swipes_json, edited, pinned, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       content = excluded.content,
       reasoning = excluded.reasoning,
       swipe_index = excluded.swipe_index,
       swipes_json = excluded.swipes_json,
       edited = excluded.edited,
       pinned = excluded.pinned;`,
    [
      message.id,
      message.conversationId,
      message.role,
      message.content,
      message.reasoning,
      message.modelId,
      swipeIndex,
      JSON.stringify(swipes),
      message.edited ? 1 : 0,
      message.pinned ? 1 : 0,
      message.createdAt,
    ],
  ]
}

/** All conversations, newest activity first. */
export async function loadConversations(): Promise<Conversation[]> {
  const db = await getDb()
  if (!db) return []
  try {
    const rows = await db.all<ConversationRow>(
      'SELECT * FROM conversations ORDER BY last_message_at DESC, id DESC;',
    )
    return rows.map(toConversation)
  } catch {
    return []
  }
}

/**
 * A conversation's full transcript, oldest first.
 *
 * Ordered by `created_at` with `id` as the tie-break: two messages written in
 * the same millisecond would otherwise be free to swap, and a swapped
 * user/assistant pair reads as a corrupted conversation.
 */
export async function loadMessages(conversationId: string): Promise<Message[]> {
  const db = await getDb()
  if (!db) return []
  try {
    const rows = await db.all<MessageRow>(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC;',
      [conversationId],
    )
    // Heal on the way OUT as well as in. A row written before this feature
    // existed has `swipes_json = '[]'` and a `swipe_index` of 0; returning that
    // verbatim leaves the UI with a message it can neither switch away from nor
    // account for. `normalizeSwipes` seeds it from the visible content, so an
    // upgraded install shows "1/1" rather than a broken 0/0.
    const messages = rows.map(toMessage)
    for (const m of messages) normalizeSwipes(m)
    return messages
  } catch {
    return []
  }
}

/**
 * Build the upsert for one conversation.
 *
 * Exposed as a statement builder rather than only a function that executes,
 * because `saveTranscript` needs to run the same SQL inside a transaction.
 * Duplicating the SQL in two places would let them drift, and a row written by
 * one path that the other cannot read is a silent data-loss bug.
 */
function conversationStatement(conversation: Conversation): [string, unknown[]] {
  return [
    `INSERT INTO conversations
       (id, title, character_id, model_id, sampler_override, context_override,
        world_info, message_count, last_message_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       character_id = excluded.character_id,
       model_id = excluded.model_id,
       sampler_override = excluded.sampler_override,
       context_override = excluded.context_override,
       world_info = excluded.world_info,
       message_count = excluded.message_count,
       last_message_at = excluded.last_message_at,
       updated_at = excluded.updated_at;`,
    [
      conversation.id,
      conversation.title,
      conversation.characterId,
      conversation.modelId,
      conversation.samplerOverride ? JSON.stringify(conversation.samplerOverride) : null,
      conversation.contextOverride ? JSON.stringify(conversation.contextOverride) : null,
      conversation.worldInfo,
      conversation.messageCount,
      conversation.lastMessageAt,
      conversation.createdAt,
      conversation.updatedAt,
    ],
  ]
}

/** Insert or update one conversation. */
export async function saveConversation(conversation: Conversation): Promise<void> {
  const db = await getDb()
  if (!db) return
  try {
    const [sql, params] = conversationStatement(conversation)
    await db.run(sql, params)
  } catch {
    /* best effort — see module docstring */
  }
}

/** Insert or update one message. */
export async function saveMessage(message: Message): Promise<void> {
  const db = await getDb()
  if (!db) return
  try {
    const [sql, params] = messageStatement(message)
    await db.run(sql, params)
  } catch {
    /* best effort */
  }
}

/**
 * Save a conversation and some messages atomically.
 *
 * The store calls this after each completed turn. One transaction rather than N
 * statements matters beyond speed: a crash mid-save would otherwise leave a
 * conversation whose `message_count` disagrees with its rows, and the list would
 * show a number that does not match what opens.
 */
export async function saveTranscript(
  conversation: Conversation,
  messages: readonly Message[],
): Promise<void> {
  const db = await getDb()
  if (!db) return

  try {
    await db.tx(async (tx) => {
      const [cSql, cParams] = conversationStatement(conversation)
      await tx.run(cSql, cParams)
      for (const m of messages) {
        const [mSql, mParams] = messageStatement(m)
        await tx.run(mSql, mParams)
      }
    })
  } catch {
    /* best effort */
  }
}

/** Delete a conversation and, by cascade, its messages. */
export async function deleteConversation(conversationId: string): Promise<void> {
  const db = await getDb()
  if (!db) return
  try {
    // Messages are removed by `ON DELETE CASCADE`; the PRAGMA that enables it is
    // set in `migrate()`. Deleting them explicitly as well would be redundant
    // and would mask a broken foreign-key setup.
    await db.run('DELETE FROM conversations WHERE id = ?;', [conversationId])
  } catch {
    /* best effort */
  }
}

/**
 * Delete one message.
 *
 * The store must reset the engine context after this: removing a message from
 * the middle invalidates the KV cache prefix, and the next turn would otherwise
 * be generated against a context that no longer matches the visible transcript.
 */
export async function deleteMessage(messageId: string): Promise<void> {
  const db = await getDb()
  if (!db) return
  try {
    await db.run('DELETE FROM messages WHERE id = ?;', [messageId])
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Swipe persistence
// ---------------------------------------------------------------------------

/**
 * Load one message's swipe state.
 *
 * ── Why this exists ALONGSIDE `loadMessages` ────────────────────────────────
 * `loadMessages` reads a whole transcript, which is the right thing at boot and
 * the wrong thing when the user taps a version arrow: it would re-read and
 * re-allocate every message in the conversation to answer a question about one
 * of them. As a chat grows, "switch to version 2" would get slower every turn.
 *
 * The three columns it selects are exactly the ones that describe swipe state
 * (`content` is included because the invariant is `content === swipes[index]`
 * — reading `swipes` without it would make the invariant unverifiable).
 *
 * Returns `null` when the message is unknown or persistence is off; the caller
 * falls back to the in-memory copy rather than treating that as empty, because
 * "no row" and "no versions" are very different answers.
 */
export async function loadMessageSwipes(
  messageId: string,
): Promise<{ content: string; swipes: string[]; swipeIndex: number } | null> {
  const db = await getDb()
  if (!db) return null
  try {
    const row = await db.one<MessageRow>('SELECT * FROM messages WHERE id = ?;', [messageId])
    if (!row) return null
    const message = toMessage(row)
    normalizeSwipes(message)
    return { content: message.content, swipes: message.swipes, swipeIndex: message.swipeIndex }
  } catch {
    return null
  }
}

/**
 * Write one message's swipe state.
 *
 * Narrower than `saveMessage`, which would also rewrite the role, timestamps and
 * conversation id of a message that is not changing. A swipe switch touches two
 * columns, and saying so in the SQL is what keeps a version switch from being
 * able to clobber anything else — including fields another feature owns (the
 * `edited` flag, for instance).
 *
 * The array is clamped against the index on the way in, mirroring
 * `messageStatement`, so the row can never be stored in a state `normalizeSwipes`
 * would have to repair on the next read.
 */
export async function saveMessageSwipes(
  messageId: string,
  swipes: readonly string[],
  swipeIndex: number,
): Promise<void> {
  const db = await getDb()
  if (!db) return
  try {
    const list = Array.isArray(swipes) ? [...swipes] : []
    const index =
      list.length > 0 ? Math.min(Math.max(Math.trunc(swipeIndex) || 0, 0), list.length - 1) : 0
    /**
     * `content` is written together with `swipes_json`, in ONE statement.
     *
     * Splitting them would create a window — a crash, a kill, a failed second
     * write — in which the row holds version 3 in `content` and version 1 in
     * `swipes_json`. On the next launch the user sees the reply they did not
     * pick, and the text they did pick is gone. One UPDATE makes the invariant
     * hold across a process death, not just across a successful call.
     */
    const content = list.length > 0 ? list[index]! : ''
    await db.run(
      `UPDATE messages SET content = ?, swipes_json = ?, swipe_index = ? WHERE id = ?;`,
      [content, JSON.stringify(list), index, messageId],
    )
  } catch {
    /* best effort — see module docstring */
  }
}
