/**
 * Character-card persistence.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Imported cards lived only in the Zustand store. `CharacterScreen` called
 * `setCharacters([...])` and that was the whole story — the `characters` table
 * had been created in `schema.ts` since the beginning and NOTHING ever read or
 * wrote it. So every cold start began with an empty character library and the
 * user had to re-import their cards. That is the same defect class as the
 * "chat history disappears on restart" bug that `conversations.ts` fixed; this
 * file is the other half of that wiring.
 *
 * ── Storage shape ───────────────────────────────────────────────────────────
 * `card_json` holds the ENTIRE `CharacterRecord` serialized, not just
 * `CharacterRecord.card`. The sibling columns (`name`, `avatar_path`,
 * `is_user_created`, the timestamps) are a queryable index over that blob, so
 * the library can still be sorted or filtered in SQL without paying to parse
 * every card. The blob is what a read returns, which means a field added to
 * `CharacterRecord` later round-trips with no migration and no column.
 *
 * ── Failure policy ──────────────────────────────────────────────────────────
 * Mirrors `conversations.ts`: best-effort everywhere. A write failure must
 * degrade the app to "this card was not saved" rather than break the import
 * flow or the screen, so writes swallow their errors and reads return empty.
 * `getDb()` returning null (Node tests, a native module that failed to link)
 * is not an error either — every function is a silent no-op.
 */

import type { CharacterCardV2, CharacterRecord } from '@/types/domain.ts'

import { getDb } from './connection.ts'

/** Row shape as SQLite returns it. */
interface CharacterRow {
  id: string
  card_json: string
  avatar_path: string | null
  name: string
  is_user_created: number
  created_at: number
  updated_at: number
}

/**
 * Rebuild a record from its stored blob, falling back to the index columns.
 *
 * The blob is authoritative; the columns are duplicated data and are only used
 * to fill gaps when the blob is unreadable. That keeps a card whose JSON was
 * truncated by a crash recoverable as "name and avatar kept, details lost"
 * instead of vanishing from the library entirely — losing a card's prose is
 * bad, silently losing the card is worse.
 */
function toRecord(row: CharacterRow): CharacterRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(row.card_json)
  } catch {
    parsed = null
  }

  if (parsed && typeof parsed === 'object') {
    const record = parsed as CharacterRecord
    // A blob missing the card payload cannot render — treat it as unusable
    // rather than handing the UI an object that throws on `card.data.name`.
    if (record.card && typeof record.card === 'object' && record.card.data) {
      return record
    }
  }

  return null
}

/** The `name` index column. Prefers the card's own name; falls back to the id. */
function nameOf(record: CharacterRecord): string {
  const name = record.card?.data?.name
  return typeof name === 'string' && name.length > 0 ? name : record.id
}

/**
 * Reject anything that cannot be stored or rendered.
 *
 * `card_json` and `name` are NOT NULL, so a record without a card would fail
 * the INSERT — and a thrown constraint error inside the import flow is exactly
 * the kind of crash this module exists to prevent. Filtering here also keeps
 * `saveCharacter`'s contract simple: it never throws, whatever it is handed.
 */
function isStorable(record: CharacterRecord | null | undefined): record is CharacterRecord {
  return Boolean(
    record &&
      typeof record.id === 'string' &&
      record.id.length > 0 &&
      record.card &&
      typeof record.card === 'object' &&
      record.card.data,
  )
}

/** All saved cards, newest first. */
export async function loadCharacters(): Promise<CharacterRecord[]> {
  const db = await getDb()
  if (!db) return []
  try {
    const rows = await db.all<CharacterRow>(
      'SELECT * FROM characters ORDER BY created_at DESC, id DESC;',
    )
    // Corrupt rows are dropped rather than thrown: one bad card must not make
    // the whole library unreadable.
    return rows.map(toRecord).filter((r): r is CharacterRecord => r !== null)
  } catch {
    return []
  }
}

/**
 * Insert or update one card.
 *
 * Upsert rather than plain INSERT because re-importing the same card (or
 * editing one) must not create a duplicate row — `CharacterScreen` already
 * de-duplicates by name in memory, and the database has to agree or the two
 * views diverge after a restart.
 */
export async function saveCharacter(record: CharacterRecord): Promise<void> {
  if (!isStorable(record)) return
  const db = await getDb()
  if (!db) return
  try {
    await db.run(
      `INSERT INTO characters
         (id, card_json, avatar_path, name, is_user_created, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         card_json = excluded.card_json,
         avatar_path = excluded.avatar_path,
         name = excluded.name,
         is_user_created = excluded.is_user_created,
         updated_at = excluded.updated_at;`,
      [
        record.id,
        JSON.stringify(record),
        record.avatarPath ?? null,
        nameOf(record),
        record.isUserCreated ? 1 : 0,
        record.createdAt,
        record.updatedAt,
      ],
    )
  } catch {
    /* best effort — see module docstring */
  }
}

/**
 * Delete one card.
 *
 * Conversations that referenced it keep their rows with `character_id` set to
 * NULL, via `ON DELETE SET NULL` on the foreign key (enabled by the PRAGMA in
 * `migrate()`). That is the behaviour we want: the chat history stays, it just
 * loses its character. Nulling the column by hand here would be redundant AND
 * would mask a foreign-key setup that had stopped working.
 */
export async function deleteCharacter(id: string): Promise<void> {
  const db = await getDb()
  if (!db) return
  try {
    await db.run('DELETE FROM characters WHERE id = ?;', [id])
  } catch {
    /* best effort */
  }
}

/** Re-exported for callers that only need the payload type. */
export type { CharacterCardV2 }
