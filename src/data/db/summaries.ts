/**
 * Rolling memory summaries — persistence.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `src/memory/summarize.ts` decides WHAT the summary should say. This file only
 * stores it. The split matters because the decision logic is where the bugs
 * live (a bad trigger silently discards memory), and keeping it in a pure
 * module makes it testable without a database or the native engine.
 *
 * One row per conversation, replaced on each pass. The summary is a rolling
 * document, not an append-only log: `summarize.ts` extends the existing text
 * rather than re-reading history, so only the newest version is ever useful.
 *
 * ── Failure policy ──────────────────────────────────────────────────────────
 * Identical to `conversations.ts`, and deliberately so. Persistence failing
 * must degrade the app to "memory resets on relaunch" rather than breaking the
 * chat, so writes swallow their errors and `loadSummary` returns null. A
 * throw from here would abort a generation turn, which is a far worse outcome
 * than a forgotten summary.
 */

import { getDb } from './connection.ts'

/** Row shape as SQLite returns it. */
interface SummaryRow {
  conversation_id: string
  summary: string
  up_to_message_id: string
  message_count: number
  created_at: number
  updated_at: number
}

/**
 * A summary as stored.
 *
 * `upToMessageId` and `messageCount` travel together and are both required to
 * compute the increment: the id says WHERE the summary ends, the count says HOW
 * MANY messages existed at that point. See the schema doc for why the id alone
 * is not enough.
 */
export interface StoredSummary {
  conversationId: string
  summary: string
  /** The last message the summary covers, inclusive. */
  upToMessageId: string
  /** Total messages in the conversation when this summary was written. */
  messageCount: number
  createdAt: number
  updatedAt: number
}

function toStoredSummary(row: SummaryRow): StoredSummary {
  return {
    conversationId: row.conversation_id,
    summary: row.summary ?? '',
    upToMessageId: row.up_to_message_id ?? '',
    // `?? 0` rather than trusting the column: a row written by an older build
    // (or a partial migration) must not surface as NaN and poison the
    // arithmetic that decides when the next summary is due.
    messageCount: row.message_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Load a conversation's summary, or null when there is none.
 *
 * Null is the normal "no memory yet" answer, not an error, so callers must not
 * treat it as a failure. A database that is absent, or a read that throws,
 * collapses to the same null — the distinction is not actionable at any call
 * site.
 */
export async function loadSummary(conversationId: string): Promise<StoredSummary | null> {
  if (!conversationId) return null
  const db = await getDb()
  if (!db) return null
  try {
    const row = await db.one<SummaryRow>(
      'SELECT * FROM summaries WHERE conversation_id = ?;',
      [conversationId],
    )
    if (!row) return null
    // A row whose text is empty or whitespace is treated as absent. Storing an
    // empty summary would otherwise make `getSummaryForPrompt` return a
    // non-null value that formats to nothing, and the caller's "is there
    // memory?" branch would take the wrong path.
    const parsed = toStoredSummary(row)
    return parsed.summary.trim().length > 0 ? parsed : null
  } catch {
    return null
  }
}

/**
 * Insert or replace a conversation's summary.
 *
 * Upsert on `conversation_id` rather than delete-then-insert: the two-statement
 * form can leave the conversation with no row at all if the process dies
 * between them, which reads to the user as "my memory was wiped".
 *
 * `created_at` is preserved from the caller's value on conflict while
 * `updated_at` advances — the pair is what lets a future UI show "memory last
 * refreshed N turns ago" without a second table.
 */
export async function saveSummary(s: StoredSummary): Promise<void> {
  if (!s.conversationId) return
  const db = await getDb()
  if (!db) return
  try {
    await db.run(
      `INSERT INTO summaries
         (conversation_id, summary, up_to_message_id, message_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         summary = excluded.summary,
         up_to_message_id = excluded.up_to_message_id,
         message_count = excluded.message_count,
         updated_at = excluded.updated_at;`,
      [
        s.conversationId,
        s.summary,
        s.upToMessageId,
        s.messageCount,
        s.createdAt,
        s.updatedAt,
      ],
    )
  } catch {
    /* best effort — see module docstring */
  }
}

/**
 * Drop a conversation's memory.
 *
 * Needed when a conversation is recreated under the same id, and when the user
 * deliberately edits history far enough back that the summary no longer
 * describes what is on screen. Deleting a whole conversation does NOT need
 * this: the foreign key cascades.
 */
export async function deleteSummary(conversationId: string): Promise<void> {
  if (!conversationId) return
  const db = await getDb()
  if (!db) return
  try {
    await db.run('DELETE FROM summaries WHERE conversation_id = ?;', [conversationId])
  } catch {
    /* best effort */
  }
}
