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

export const SCHEMA_VERSION = 2

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

  // One rolling memory summary per conversation.
  //
  // ── Why this table exists ───────────────────────────────────────────────
  // A 4096-token window discards the opening of a conversation after roughly
  // 20 exchanges, so the model forgets things the user stated outright ("我叫
  // 小明") and answers as if the chat had just started. Enlarging the window is
  // not a fix: prefilling more history makes every turn slower, and on a phone
  // the KV cache for it is memory the model itself needs.
  //
  // The SillyTavern answer is to compress the old turns once and keep the
  // compression in the prompt permanently, which costs a fixed ~200 words
  // instead of an unbounded transcript.
  //
  // ── Shape notes ─────────────────────────────────────────────────────────
  // `conversation_id` is the PRIMARY KEY rather than a surrogate id: a
  // conversation has exactly one current summary, and the upsert on this key
  // is what makes "extend the existing memory" a single statement. A history
  // table of every past summary would grow without bound and nothing reads it.
  //
  // `up_to_message_id` records which message the summary covers *inclusively*.
  // Without it the summariser cannot tell what is already compressed, and
  // every pass would re-read the whole transcript — the cost this design is
  // specifically avoiding. `message_count` is stored alongside it because the
  // id alone cannot answer "how many messages are new since then"; counting
  // rows by id ordering would break the moment a message is deleted mid-thread.
  //
  // Deliberately NOT stored: the summary's own token count. It is derivable
  // from the text, and a stored copy would go stale the first time the text is
  // edited by `cleanSummary`.
  `CREATE TABLE IF NOT EXISTS summaries (
     conversation_id  TEXT PRIMARY KEY NOT NULL,
     summary          TEXT NOT NULL,
     up_to_message_id TEXT NOT NULL,
     message_count    INTEGER NOT NULL DEFAULT 0,
     created_at       INTEGER NOT NULL,
     updated_at       INTEGER NOT NULL,
     FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE
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
 * Version 1 is the baseline above, so its entry is absent. Never edit the
 * baseline, because existing installs have already run it.
 *
 * ── Why version 2 ALSO lives in `CREATE_TABLES` ─────────────────────────────
 * The `summaries` DDL appears in both places, and that is intentional rather
 * than an oversight:
 *
 *   - `CREATE_TABLES` runs on EVERY launch, for every install. A fresh install
 *     reaches version 2 without ever executing this migration.
 *   - `MIGRATIONS[2]` runs exactly once, for an install already sitting at
 *     version 1.
 *
 * Both are `CREATE TABLE IF NOT EXISTS`, so whichever path an install takes,
 * the second application is a no-op. The alternative — putting the DDL only in
 * `MIGRATIONS[2]` — works too, but it leaves the baseline DDL array unable to
 * describe the current schema, so anyone reading `CREATE_TABLES` (or a test
 * that builds a database from it, as `schema.sql.test.ts` does) sees a schema
 * that is silently missing a table. Keeping the authoritative DDL in one
 * readable list and the migration as a thin repeat of it is the smaller lie.
 *
 * A statement that is NOT idempotent — an `ALTER TABLE`, a data backfill —
 * must go in `MIGRATIONS` only, never in `CREATE_TABLES`.
 */
export const MIGRATIONS: Readonly<Record<number, readonly string[]>> = {
  // v1 → v2: rolling conversation memory (see the `summaries` table above).
  2: [
    `CREATE TABLE IF NOT EXISTS summaries (
       conversation_id  TEXT PRIMARY KEY NOT NULL,
       summary          TEXT NOT NULL,
       up_to_message_id TEXT NOT NULL,
       message_count    INTEGER NOT NULL DEFAULT 0,
       created_at       INTEGER NOT NULL,
       updated_at       INTEGER NOT NULL,
       FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE
     );`,
  ],
}

/**
 * Applies pragmas, tables, indexes and any pending migrations.
 *
 * ── The shape this expects, and the two bugs it used to have ────────────────
 * It is written against `@op-engineering/op-sqlite` 18.x, where:
 *
 *   - `executeBatch` takes `SQLBatchTuple[]` = `[sql] | [sql, params]`, NOT a
 *     bare `string[]`. Passing strings made schema creation fail, so the app
 *     would have had no tables at all.
 *   - there is NO `getFirst`. Reading `PRAGMA user_version` through it always
 *     resolved the optional away, so the version silently reset to the baseline
 *     on every launch.
 *
 * Both are expressed in the parameter type below, so the compiler — and any
 * caller — sees the real contract.
 */
export async function migrate(db: {
  execute: (sql: string, params?: unknown[]) => Promise<unknown>
  /** op-sqlite takes `[sql]` or `[sql, params]` tuples, not plain strings. */
  executeBatch?: (commands: Array<[string] | [string, unknown[]]>) => Promise<unknown>
  /** Returns `{ rows: [...] }`; there is no `getFirst` in this binding. */
  executeRows?: (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>
}): Promise<void> {
  for (const pragma of PRAGMAS) {
    await db.execute(pragma)
  }

  const statements = [...CREATE_TABLES, ...CREATE_INDEXES]
  if (db.executeBatch) {
    // Tuples, because the binding rejects bare strings.
    await db.executeBatch(statements.map((sql) => [sql] as [string]))
  } else {
    for (const stmt of statements) {
      await db.execute(stmt)
    }
  }

  let current = 0
  if (db.executeRows) {
    const rows = await db.executeRows('PRAGMA user_version;')
    // `PRAGMA user_version` returns one row with one column whose name varies
    // by binding version, so read the first value rather than naming it.
    const first = rows[0]
    if (first) current = Number(Object.values(first)[0] ?? 0)
  }

  for (let v = current + 1; v <= SCHEMA_VERSION; v += 1) {
    const steps = MIGRATIONS[v]
    if (!steps) continue
    for (const stmt of steps) await db.execute(stmt)
  }

  await db.execute(`PRAGMA user_version = ${SCHEMA_VERSION};`)
}
