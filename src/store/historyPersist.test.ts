/**
 * Conversation history survives a restart.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * The reported bug was "每次进 APP 都没聊天记录了" — every launch started with an
 * empty conversation list. The persistence layer has its own tests, but neither
 * those nor the store's tests covered the JOIN: the store writing through to
 * SQLite, and `restoreConversations()` reading it back.
 *
 * That join is the whole feature, and it is exactly where the previous
 * "in-memory transcripts" attempt looked correct in isolation while losing
 * everything on a cold start.
 *
 * The test drives a real SQLite database (Node 24's `node:sqlite`) through the
 * store, simulating: create conversation → send → receive → restart → reopen.
 *
 * Run with:
 *   node --import ./scripts/register-alias.mjs --test src/store/historyPersist.test.ts
 */

import { test, describe, beforeEach, before } from 'node:test'
import assert from 'node:assert/strict'

import type { Message } from '@/types/domain.ts'

import { __adaptForTests, __setDbForTests, type SqliteDb } from '@/data/db/connection.ts'
import { PRAGMAS, CREATE_INDEXES, CREATE_TABLES } from '@/data/db/schema.ts'
import { useChatStore, restoreConversations } from '@/store/index.ts'

interface SqliteLike {
  exec: (sql: string) => void
  prepare: (sql: string) => {
    run: (...p: unknown[]) => unknown
    all: (...p: unknown[]) => unknown[]
    get: (...p: unknown[]) => unknown
  }
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
  if (!DatabaseSync) console.log('\n  ⚠️  node:sqlite unavailable — skipping\n')
})

/**
 * Wrap a real SQLite handle using the PRODUCTION adapter.
 *
 * Deliberately not a hand-rolled equivalent. A local reimplementation would
 * silently skip whatever the real adapter does — and it did: transaction
 * serialization lives inside `adapt()`, so a bespoke `tx` here reproduced a
 * bug the production code had already fixed, making the fix look ineffective.
 * Using the real adapter means only the SQL engine differs (in-process
 * node:sqlite instead of op-sqlite), not the code under test.
 */
function adapt(db: SqliteLike): SqliteDb {
  return __adaptForTests({
    execute: async (sql: string, params?: unknown[]) => ({
      rows: db.prepare(sql).all(...(params ?? [])) as Array<Record<string, unknown>>,
    }),
    transaction: async (fn) => {
      db.exec('BEGIN;')
      try {
        await fn({
          execute: async (sql: string, params?: unknown[]) => ({
            rows: db.prepare(sql).all(...(params ?? [])) as Array<Record<string, unknown>>,
          }),
        })
        db.exec('COMMIT;')
      } catch (error) {
        db.exec('ROLLBACK;')
        throw error
      }
    },
    close: () => db.close?.(),
  })
}
let sqlite: SqliteLike

function freshDatabase(): void {
  sqlite = new DatabaseSync!(':memory:')
  for (const pragma of PRAGMAS) {
    try {
      sqlite.exec(pragma)
    } catch {
      /* WAL is a no-op for :memory: */
    }
  }
  for (const stmt of [...CREATE_TABLES, ...CREATE_INDEXES]) sqlite.exec(stmt)
  __setDbForTests(adapt(sqlite))
}

function resetStore(): void {
  useChatStore.setState({
    conversations: [],
    activeConversationId: null,
    messages: [],
    transcripts: {},
    characters: [],
  } as never)
}

/** A reply as `generate()` would commit it. */
function reply(conversationId: string, content: string, createdAt: number): Message {
  return {
    id: `a-${createdAt}`,
    conversationId,
    role: 'assistant',
    content,
    reasoning: null,
    createdAt,
    modelId: null,
    swipeIndex: 0,
    swipes: [],
    edited: false,
    pinned: false,
  }
}

/**
 * Wait until every pending SQLite write has landed.
 *
 * The store's writes are fire-and-forget (`void saveTranscript(...)`), so a
 * fixed `setTimeout` is a race: it passes or fails depending on how many
 * microtask turns the pending statements need. An earlier version of this file
 * used `setTimeout(20)` and failed intermittently — the assistant reply was
 * still in flight when the "restart" happened, which looked exactly like a
 * persistence bug.
 *
 * This drains the queue properly: yielding to the macrotask queue once lets
 * every already-scheduled promise chain run to completion, and repeating it
 * covers chains that schedule further work.
 */
async function flushWrites(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('history survives a restart', () => {
  beforeEach(() => {
    if (!DatabaseSync) return
    freshDatabase()
    resetStore()
  })

  test('a conversation and its messages are still there after a restart', async (t) => {
    if (!DatabaseSync) return t.skip('node:sqlite unavailable')

    // ── Session 1 ───────────────────────────────────────────────────────────
    const id = useChatStore.getState().createConversation(null)
    useChatStore.getState().appendUser('你好')
    useChatStore.getState().appendMessage(reply(id, '你好，我是助手', Date.now() + 1))

    assert.equal(useChatStore.getState().messages.length, 2)

    // Writes are fire-and-forget; give the microtask queue a turn so the
    // pending SQLite statements actually run before we simulate a restart.
    await flushWrites()

    // ── Simulate a cold start ───────────────────────────────────────────────
    // The store is wiped exactly as a fresh process would leave it, then the
    // boot path repopulates from the database.
    resetStore()
    assert.equal(useChatStore.getState().conversations.length, 0, 'reset should empty the store')

    await restoreConversations()

    // ── Session 2 ───────────────────────────────────────────────────────────
    const conversations = useChatStore.getState().conversations
    assert.equal(conversations.length, 1, 'the conversation must come back')

    const restored = useChatStore.getState().transcripts[id]
    assert.ok(restored, 'the transcript must be loaded for the conversation')
    assert.deepEqual(
      restored!.map((m) => m.content),
      ['你好', '你好，我是助手'],
    )
    assert.deepEqual(
      restored!.map((m) => m.role),
      ['user', 'assistant'],
    )
  }, { timeout: 20000 })

  test('several conversations all come back, newest first', async (t) => {
    if (!DatabaseSync) return t.skip('node:sqlite unavailable')

    const first = useChatStore.getState().createConversation(null)
    useChatStore.getState().appendUser('第一个对话')
    // Sleep so the two conversations get distinguishable timestamps; otherwise
    // the ordering assertion is a tie and proves nothing.
    await flushWrites()

    const second = useChatStore.getState().createConversation(null)
    useChatStore.getState().appendUser('第二个对话')

    await flushWrites()

    resetStore()
    await restoreConversations()

    const conversations = useChatStore.getState().conversations
    assert.equal(conversations.length, 2)
    // Newest activity first — the messaging-app convention.
    assert.equal(conversations[0]!.id, second)
    assert.equal(conversations[1]!.id, first)
  }, { timeout: 20000 })

  test('a deleted conversation does not come back', async (t) => {
    if (!DatabaseSync) return t.skip('node:sqlite unavailable')

    const keep = useChatStore.getState().createConversation(null)
    useChatStore.getState().appendUser('保留')
    const drop = useChatStore.getState().createConversation(null)
    useChatStore.getState().appendUser('删除')

    await flushWrites()

    useChatStore.getState().deleteConversation(drop)
    await flushWrites()

    resetStore()
    await restoreConversations()

    const conversations = useChatStore.getState().conversations
    assert.equal(conversations.length, 1)
    assert.equal(conversations[0]!.id, keep)
    assert.equal(useChatStore.getState().transcripts[drop], undefined)
  }, { timeout: 20000 })

  test('an edited message keeps its new text across a restart', async (t) => {
    if (!DatabaseSync) return t.skip('node:sqlite unavailable')

    const id = useChatStore.getState().createConversation(null)
    useChatStore.getState().appendUser('原文')
    await flushWrites()

    const original = useChatStore.getState().messages[0]!
    useChatStore.getState().replaceMessage({ ...original, content: '改后的文本' })
    await flushWrites()

    resetStore()
    await restoreConversations()

    assert.equal(useChatStore.getState().transcripts[id]![0]!.content, '改后的文本')
  }, { timeout: 20000 })

  test('the boot path does not auto-open the last conversation', async (t) => {
    if (!DatabaseSync) return t.skip('node:sqlite unavailable')

    const id = useChatStore.getState().createConversation(null)
    useChatStore.getState().appendUser('内容')
    await flushWrites()

    resetStore()
    await restoreConversations()

    // Opening straight into the last chat hides the list and makes back feel
    // broken; a messaging app lands on the list.
    assert.equal(useChatStore.getState().activeConversationId, null)
    assert.equal(useChatStore.getState().messages.length, 0)
    // …but the transcript is still loaded, so opening it is instant.
    assert.equal(useChatStore.getState().transcripts[id]!.length, 1)
  }, { timeout: 20000 })

  test('an empty database restores an empty state without throwing', async (t) => {
    if (!DatabaseSync) return t.skip('node:sqlite unavailable')

    resetStore()
    await restoreConversations()

    assert.deepEqual(useChatStore.getState().conversations, [])
    assert.deepEqual(useChatStore.getState().transcripts, {})
  }, { timeout: 20000 })
})
