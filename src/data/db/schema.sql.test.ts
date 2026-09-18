/**
 * Schema and SQL validation against a REAL SQLite engine.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * `conversations.test.ts` runs against a hand-written fake, which proves the
 * mapping between domain objects and rows but says nothing about whether the
 * SQL is VALID. A typo in a column name, a missing table, a bad foreign key, or
 * an `INSERT` whose column list does not match its placeholders would all pass
 * that suite and fail on first launch.
 *
 * Node 24 ships `node:sqlite`, so the same DDL and the same statements can be
 * executed by a real engine here. This is the closest thing to a device test
 * that runs in CI.
 *
 * What it still does NOT prove: that op-sqlite's binding behaves like
 * `node:sqlite`. That class of error (calling `getAll`, which does not exist in
 * op-sqlite 18.x) is caught by reading the installed type definitions.
 *
 * Run with:
 *   node --import ./scripts/register-alias.mjs --test src/data/db/schema.sql.test.ts
 */

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'

import { CREATE_INDEXES, CREATE_TABLES, PRAGMAS, SCHEMA_VERSION } from './schema.ts'

/** `node:sqlite` is only present from Node 22.5; skip cleanly elsewhere. */
let DatabaseSync: (new (path: string) => SqliteLike) | null = null

interface SqliteStatement {
  run: (...params: unknown[]) => unknown
  all: (...params: unknown[]) => unknown[]
  get: (...params: unknown[]) => unknown
}
interface SqliteLike {
  exec: (sql: string) => void
  prepare: (sql: string) => SqliteStatement
  close: () => void
}

before(async () => {
  try {
    const mod = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (path: string) => SqliteLike
    }
    DatabaseSync = mod.DatabaseSync
  } catch {
    DatabaseSync = null
  }
  if (!DatabaseSync) console.log('\n  ⚠️  node:sqlite unavailable — skipping SQL tests\n')
})

/** A fresh in-memory database with the real schema applied. */
function freshDb(): SqliteLike {
  const db = new DatabaseSync!(':memory:')
  for (const pragma of PRAGMAS) {
    try {
      db.exec(pragma)
    } catch {
      // `journal_mode = WAL` is a no-op for :memory: databases. That is expected,
      // and it is NOT ignored on device — the file-backed case is where it
      // matters.
    }
  }
  for (const stmt of [...CREATE_TABLES, ...CREATE_INDEXES]) db.exec(stmt)
  return db
}

describe('schema (real SQLite)', () => {
  test('every DDL statement executes', (t) => {
    if (!DatabaseSync) return t.skip('node:sqlite unavailable')
    // A throw here fails the test — which is the point: one malformed statement
    // means the app starts with missing tables.
    const db = freshDb()
    db.close()
  })

  test('all expected tables exist', (t) => {
    if (!DatabaseSync) return t.skip('node:sqlite unavailable')
    const db = freshDb()
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;")
      .all() as Array<{ name: string }>
    const names = rows.map((r) => r.name)

    for (const expected of [
      'models',
      'downloads',
      'characters',
      'conversations',
      'messages',
      'settings',
    ]) {
      assert.ok(names.includes(expected), `missing table: ${expected} (have ${names.join(', ')})`)
    }
    db.close()
  })

  test('all expected indexes exist', (t) => {
    if (!DatabaseSync) return t.skip('node:sqlite unavailable')
    const db = freshDb()
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%';")
      .all() as Array<{ name: string }>
    const names = rows.map((r) => r.name)

    // The conversation-list and transcript queries are the hot paths; a missing
    // index there is a full table scan on every screen open.
    assert.ok(names.includes('idx_messages_conversation_created'))
    assert.ok(names.includes('idx_conversations_last_message'))
    db.close()
  })

  test('re-applying the schema is idempotent', (t) => {
    if (!DatabaseSync) return t.skip('node:sqlite unavailable')
    // Every launch runs this; a non-idempotent statement would throw on the
    // second start and leave the app with no database.
    const db = freshDb()
    for (const stmt of [...CREATE_TABLES, ...CREATE_INDEXES]) db.exec(stmt)
    db.close()
  })

  test('the message upsert matches the real column list', (t) => {
    if (!DatabaseSync) return t.skip('node:sqlite unavailable')
    const db = freshDb()

    // Exactly the statement `messageStatement()` builds. If the column list and
    // the placeholder count ever disagree, a real engine rejects it — the fake
    // would not.
    const sql = `INSERT INTO messages
       (id, conversation_id, role, content, reasoning, model_id,
        swipe_index, swipes_json, edited, pinned, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       content = excluded.content,
       reasoning = excluded.reasoning,
       swipe_index = excluded.swipe_index,
       swipes_json = excluded.swipes_json,
       edited = excluded.edited,
       pinned = excluded.pinned;`

    db.exec(
      "INSERT INTO conversations (id, title, world_info, message_count, last_message_at, created_at, updated_at) VALUES ('c1','t','',0,1,1,1);",
    )

    const stmt = db.prepare(sql)
    const params = ['m1', 'c1', 'user', 'hello', null, null, 0, '[]', 0, 0, 1]
    stmt.run(...params)
    stmt.run(...params) // the conflict path

    const rows = db.prepare('SELECT * FROM messages;').all() as Array<Record<string, unknown>>
    assert.equal(rows.length, 1, 'the upsert must update, not duplicate')
    assert.equal(rows[0]!.content, 'hello')
    db.close()
  })

  test('the conversation upsert matches the real column list', (t) => {
    if (!DatabaseSync) return t.skip('node:sqlite unavailable')
    const db = freshDb()

    const sql = `INSERT INTO conversations
       (id, title, character_id, model_id, sampler_override, context_override,
        world_info, message_count, last_message_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       message_count = excluded.message_count,
       updated_at = excluded.updated_at;`

    const stmt = db.prepare(sql)
    stmt.run('c1', 'first', null, null, null, null, '', 0, 1, 1, 1)
    stmt.run('c1', 'second', null, null, null, null, '', 5, 2, 1, 2)

    const rows = db.prepare('SELECT * FROM conversations;').all() as Array<
      Record<string, unknown>
    >
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.title, 'second')
    assert.equal(rows[0]!.message_count, 5)
    db.close()
  })

  test('deleting a conversation cascades to its messages', (t) => {
    if (!DatabaseSync) return t.skip('node:sqlite unavailable')
    const db = freshDb()

    db.exec(
      "INSERT INTO conversations (id, title, world_info, message_count, last_message_at, created_at, updated_at) VALUES ('c1','t','',0,1,1,1);",
    )
    db.exec(
      "INSERT INTO messages (id, conversation_id, role, content, swipes_json, created_at) VALUES ('m1','c1','user','hi','[]',1);",
    )

    db.exec("DELETE FROM conversations WHERE id = 'c1';")

    const remaining = db.prepare('SELECT * FROM messages;').all()
    assert.equal(remaining.length, 0, 'orphaned messages would be ghost history')
    db.close()
  })

  test('foreign keys are actually enabled by the pragma', (t) => {
    if (!DatabaseSync) return t.skip('node:sqlite unavailable')
    const db = freshDb()
    const row = db.prepare('PRAGMA foreign_keys;').get() as Record<string, unknown>
    const enabled = Number(Object.values(row)[0])
    // Without this the cascade above silently does nothing.
    assert.equal(enabled, 1, 'foreign_keys pragma did not take effect')
    db.close()
  })

  test('an orphaned message is rejected', (t) => {
    if (!DatabaseSync) return t.skip('node:sqlite unavailable')
    const db = freshDb()
    assert.throws(
      () =>
        db.exec(
          "INSERT INTO messages (id, conversation_id, role, content, swipes_json, created_at) VALUES ('m1','nope','user','hi','[]',1);",
        ),
      'a message for a non-existent conversation must be refused',
    )
    db.close()
  })

  test('the schema version is a positive integer', () => {
    assert.ok(Number.isInteger(SCHEMA_VERSION) && SCHEMA_VERSION > 0)
  })
})
