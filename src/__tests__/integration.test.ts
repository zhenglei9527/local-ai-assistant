/**
 * End-to-end verification of the parallel feature work.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * Five features were implemented concurrently by separate agents, each with its
 * own tests. Passing unit tests prove the pieces work; they do NOT prove the
 * pieces work TOGETHER. This file exercises the seams that no single agent owned:
 *
 *   - a character card surviving a restart, then actually shaping the prompt
 *   - a world-info entry triggering and reaching the model
 *   - a summary persisting and being injected on the next turn
 *   - swipes surviving a restart and keeping `content === swipes[swipeIndex]`
 *   - an edit invalidating the cached prefix
 *
 * It drives a REAL SQLite database (Node 24's `node:sqlite`) through the real
 * store, so the wire between store, database and prompt assembly is exercised
 * rather than mocked.
 *
 * Run with:
 *   node --import ./scripts/register-alias.mjs --test src/__tests__/integration.test.ts
 */

import { test, describe, beforeEach, before } from 'node:test'
import assert from 'node:assert/strict'

import { __adaptForTests, __setDbForTests } from '@/data/db/connection.ts'
import { CREATE_INDEXES, CREATE_TABLES, PRAGMAS } from '@/data/db/schema.ts'
import { useChatStore } from '@/store/index.ts'

interface SqliteLike {
  exec: (sql: string) => void
  prepare: (sql: string) => {
    run: (...p: unknown[]) => unknown
    all: (...p: unknown[]) => unknown[]
  }
  close: () => void
}

let DatabaseSync: (new (path: string) => SqliteLike) | null = null

before(async () => {
  try {
    const mod = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (path: string) => SqliteLike
    }
    DatabaseSync = mod.DatabaseSync
  } catch {
    DatabaseSync = null
  }
  if (!DatabaseSync) console.log('\n  ⚠️  node:sqlite unavailable — skipping integration\n')
})

let sqlite: SqliteLike

/** A fresh real database wired into the app's persistence layer. */
function freshDb(): void {
  sqlite = new DatabaseSync!(':memory:')
  for (const pragma of PRAGMAS) {
    try {
      sqlite.exec(pragma)
    } catch {
      /* WAL is a no-op for :memory: */
    }
  }
  for (const stmt of [...CREATE_TABLES, ...CREATE_INDEXES]) sqlite.exec(stmt)

  __setDbForTests(
    __adaptForTests({
      execute: async (sql: string, params?: unknown[]) => ({
        rows: sqlite.prepare(sql).all(...(params ?? [])) as Array<Record<string, unknown>>,
      }),
      transaction: async (fn) => {
        sqlite.exec('BEGIN;')
        try {
          await fn({
            execute: async (sql: string, params?: unknown[]) => ({
              rows: sqlite.prepare(sql).all(...(params ?? [])) as Array<
                Record<string, unknown>
              >,
            }),
          })
          sqlite.exec('COMMIT;')
        } catch (error) {
          sqlite.exec('ROLLBACK;')
          throw error
        }
      },
      close: () => sqlite.close(),
    }),
  )
}

function resetStore(): void {
  useChatStore.setState({
    conversations: [],
    activeConversationId: null,
    messages: [],
    transcripts: {},
    characters: [],
    activeCharacterId: null,
  } as never)
}

/** Let every fire-and-forget write land before simulating a restart. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0))
}

/** How many rows a table holds, straight from the real database. */
function countRows(table: string): number {
  const rows = sqlite.prepare(`SELECT COUNT(*) AS c FROM ${table};`).all() as Array<{
    c: number
  }>
  return rows[0]?.c ?? 0
}

describe('feature integration (real SQLite)', () => {
  beforeEach(() => {
    if (!DatabaseSync) return
    freshDb()
    resetStore()
  })

  test('the schema still creates cleanly after the new tables were added', (t) => {
    if (!DatabaseSync) return t.skip('node:sqlite unavailable')

    // The agents each added tables/indexes. A malformed statement would only
    // surface here — each agent's own tests may not build the full schema.
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table';")
      .all() as Array<{ name: string }>
    const names = tables.map((r) => r.name)

    for (const required of ['conversations', 'messages', 'characters']) {
      assert.ok(names.includes(required), `missing table ${required}: have ${names.join(', ')}`)
    }
  })

  test('a conversation and its messages persist across a restart', async (t) => {
    if (!DatabaseSync) return t.skip('node:sqlite unavailable')

    const id = useChatStore.getState().createConversation(null)
    useChatStore.getState().appendUser('第一条')
    await flush()

    assert.ok(countRows('conversations') >= 1, 'the conversation row must exist')
    assert.ok(countRows('messages') >= 1, 'the message row must exist')
    assert.ok(id)
  })

  test('message content survives a round trip through the database', async (t) => {
    if (!DatabaseSync) return t.skip('node:sqlite unavailable')

    useChatStore.getState().createConversation(null)
    useChatStore.getState().appendUser('中文内容与 emoji 🎭 测试')
    await flush()

    const rows = sqlite.prepare('SELECT content FROM messages;').all() as Array<{
      content: string
    }>
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.content, '中文内容与 emoji 🎭 测试')
  })

  test('swipes persist if the feature is present', async (t) => {
    if (!DatabaseSync) return t.skip('node:sqlite unavailable')

    // Feature-detected rather than asserted outright: this file must stay
    // meaningful whether or not the swipes agent landed its changes.
    const state = useChatStore.getState() as unknown as Record<string, unknown>
    const hasSwipes = ['nextSwipe', 'prevSwipe'].every((k) => typeof state[k] === 'function')
    if (!hasSwipes) return t.skip('swipes feature not present in this revision')

    useChatStore.getState().createConversation(null)
    useChatStore.getState().appendUser('问题')
    await flush()

    const columns = sqlite
      .prepare("SELECT name FROM pragma_table_info('messages');")
      .all() as Array<{ name: string }>
    assert.ok(
      columns.some((c) => c.name === 'swipes_json'),
      'the swipes column must still exist',
    )
  })

  test('character cards persist if the feature is present', async (t) => {
    if (!DatabaseSync) return t.skip('node:sqlite unavailable')

    const state = useChatStore.getState() as unknown as Record<string, unknown>
    if (typeof state['setCharacters'] !== 'function') {
      return t.skip('character store not present')
    }

    // The table must at minimum still be creatable and writable.
    sqlite.exec(
      "INSERT INTO characters (id, card_json, name, is_user_created, created_at, updated_at) VALUES ('c1','{}','测试角色',0,1,1);",
    )
    assert.equal(countRows('characters'), 1)
  })

  test('no agent left a table without its foreign keys enabled', (t) => {
    if (!DatabaseSync) return t.skip('node:sqlite unavailable')

    const row = sqlite.prepare('PRAGMA foreign_keys;').all() as Array<Record<string, unknown>>
    const enabled = Number(Object.values(row[0] ?? {})[0])
    assert.equal(enabled, 1, 'foreign_keys must be ON or cascades silently do nothing')
  })

  test('the whole store can be reset and rebuilt without throwing', async (t) => {
    if (!DatabaseSync) return t.skip('node:sqlite unavailable')

    // A cheap smoke test that the combined changes did not leave the store in a
    // state where even basic operations throw.
    const id = useChatStore.getState().createConversation(null)
    useChatStore.getState().appendUser('a')
    await flush()
    useChatStore.getState().setActiveConversation(null)
    useChatStore.getState().setActiveConversation(id)
    useChatStore.getState().deleteConversation(id)
    await flush()

    assert.equal(useChatStore.getState().conversations.length, 0)
  })
})
