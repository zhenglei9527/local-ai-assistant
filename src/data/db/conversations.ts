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
    return rows.map(toMessage)
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

/** Build the upsert for one message. See `conversationStatement`. */
function messageStatement(message: Message): [string, unknown[]] {
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
      message.swipeIndex,
      JSON.stringify(message.swipes ?? []),
      message.edited ? 1 : 0,
      message.pinned ? 1 : 0,
      message.createdAt,
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
