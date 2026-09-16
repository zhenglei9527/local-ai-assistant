/**
 * SQLite schema for phone-llm-app.
 *
 * Engine: `@op-engineering/op-sqlite` 18.2.1 (verified on npm, 2026-09-07).
 * Chosen over the alternatives because it is a JSI binding — queries run
 * synchronously on the JS thread with no bridge serialisation, which is what
 * makes message-list paging feel instant. It ships prebuilt for Android.
 *
 * ── Design rules ────────────────────────────────────────────────────────────
 *
 *  1. `PRAGMA journal_mode = WAL` — required. Without WAL the app locks the
 *     whole database during the multi-second writes that happen when a
 *     generation completes, and the UI visibly hitches.
 *
 *  2. Model *bytes* live on the filesystem; only metadata lives here. Never
 *     store a BLOB of model weights — SQLite would balloon and the GGUF needs
 *     to be a real path for mmap anyway.
 *
 *  3. Messages are append-only in spirit. Deleting a message mid-conversation
 *     invalidates the KV cache prefix, so the engine must reset its context
 *     after any edit or delete. That constraint is enforced in the store, not
 *     here — but it is why `messages` has no soft-delete column.
 *
 *  4. Timestamps are epoch milliseconds as INTEGER. SQLite has no date type,
 *     and TEXT dates sort correctly only if you never mix formats.
 */

export const SCHEMA_VERSION = 1

export const PRAGMAS: readonly string[] = [
  'PRAGMA journal_mode = WAL;',
  // NORMAL is the right durability/speed trade for a cache-like store: a
  // crash can lose the last few transactions but cannot corrupt the database.
  'PRAGMA synchronous = NORMAL;',
  'PRAGMA foreign_keys = ON;',
  // 5s busy timeout: a background download writing progress must not make a
  // foreground read fail instantly.
  'PRAGMA busy_timeout = 5000;',
]

export const CREATE_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS models (
     id              TEXT PRIMARY KEY NOT NULL,
     state           TEXT NOT NULL,
     completed_parts INTEGER NOT NULL DEFAULT 0,
     bytes_on_disk   INTEGER NOT NULL DEFAULT 0,
     local_path      TEXT,
     shard_paths     TEXT NOT NULL DEFAULT '[]',
     last_error      TEXT,
     created_at      INTEGER NOT NULL,
     updated_at      INTEGER NOT NULL
   );`,

  // Resume state for an interrupted download. One row per model; the in-flight
  // part is identified by part_index so a resume knows where to continue.
  `CREATE TABLE IF NOT EXISTS downloads (
     model_id            TEXT PRIMARY KEY NOT NULL,
     part_index          INTEGER NOT NULL DEFAULT 0,
     part_bytes_written  INTEGER NOT NULL DEFAULT 0,
     prior_parts_bytes   INTEGER NOT NULL DEFAULT 0,
     total_bytes         INTEGER NOT NULL DEFAULT 0,
     validator           TEXT,
     entity_length       INTEGER,
     state               TEXT NOT NULL,
     updated_at          INTEGER NOT NULL,
     FOREIGN KEY (model_id) REFERENCES models (id) ON DELETE CASCADE
   );`,

  `CREATE TABLE IF NOT EXISTS characters (
     id               TEXT PRIMARY KEY NOT NULL,
     card_json        TEXT NOT NULL,
     avatar_path      TEXT,
     name             TEXT NOT NULL,
     is_user_created  INTEGER NOT NULL DEFAULT 0,
     created_at       INTEGER NOT NULL,
     updated_at       INTEGER NOT NULL
   );`,

  `CREATE TABLE IF NOT EXISTS conversations (
     id                 TEXT PRIMARY KEY NOT NULL,
     title              TEXT NOT NULL,
     character_id       TEXT,
     model_id           TEXT,
     sampler_override   TEXT,
     context_override   TEXT,
     world_info         TEXT NOT NULL DEFAULT '',
     message_count      INTEGER NOT NULL DEFAULT 0,
     last_message_at    INTEGER NOT NULL DEFAULT 0,
     created_at         INTEGER NOT NULL,
     updated_at         INTEGER NOT NULL,
     FOREIGN KEY (character_id) REFERENCES characters (id) ON DELETE SET NULL
   );`,

  `CREATE TABLE IF NOT EXISTS messages (
     id              TEXT PRIMARY KEY NOT NULL,
     conversation_id TEXT NOT NULL,
     role            TEXT NOT NULL,
     content         TEXT NOT NULL,
     reasoning       TEXT,
     model_id        TEXT,
     swipe_index     INTEGER NOT NULL DEFAULT 0,
     swipes_json     TEXT NOT NULL DEFAULT '[]',
     edited          INTEGER NOT NULL DEFAULT 0,
     pinned          INTEGER NOT NULL DEFAULT 0,
     created_at      INTEGER NOT NULL,
     FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE
   );`,

  // App-wide settings as a key/value bag. Deliberately schema-less: these are
  // a handful of scalars and a migration per new setting would be noise.
  `CREATE TABLE IF NOT EXISTS settings (
     key   TEXT PRIMARY KEY NOT NULL,
     value TEXT NOT NULL
   );`,
]

export const CREATE_INDEXES: readonly string[] = [
  // The hot path: load a conversation's newest N messages.
  `CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
     ON messages (conversation_id, created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_conversations_last_message
     ON conversations (last_message_at DESC);`,
  // The hot path: find a character's conversations.
  `CREATE INDEX IF NOT EXISTS idx_conversations_character
     ON conversations (character_id);`,
  `CREATE INDEX IF NOT EXISTS idx_models_state ON models (state);`,
]

/**
 * Migration steps, applied in order from the stored user_version.
 *
 * Version 1 is the baseline above, so this list is empty. When version 2
 * arrives, append its statements here — never edit the baseline, because
 * existing installs have already run it.
 */
export const MIGRATIONS: Readonly<Record<number, readonly string[]>> = {}

/** Applies pragmas, tables, indexes and any pending migrations. */
export async function migrate(db: {
  execute: (sql: string) => Promise<unknown>
  executeBatch?: (sql: string[]) => Promise<unknown>
  getFirst?: <T>(sql: string) => Promise<T | null>
}): Promise<void> {
  for (const pragma of PRAGMAS) {
    await db.execute(pragma)
  }

  if (db.executeBatch) {
    await db.executeBatch([...CREATE_TABLES, ...CREATE_INDEXES])
  } else {
    for (const stmt of [...CREATE_TABLES, ...CREATE_INDEXES]) {
      await db.execute(stmt)
    }
  }

  let current = SCHEMA_VERSION
  if (db.getFirst) {
    const row = await db.getFirst<{ user_version: number }>('PRAGMA user_version;')
    current = row?.user_version ?? 0
  }

  for (let v = current + 1; v <= SCHEMA_VERSION; v += 1) {
    const steps = MIGRATIONS[v]
    if (!steps) continue
    for (const stmt of steps) await db.execute(stmt)
  }

  await db.execute(`PRAGMA user_version = ${SCHEMA_VERSION};`)
}
