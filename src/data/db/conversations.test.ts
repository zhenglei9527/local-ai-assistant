/**
 * Conversation persistence.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * The app shipped without message persistence: every cold start began with an
 * empty conversation list. That is the defining failure for a chat app, and it
 * survived several review passes because nothing tested it — the store's own
 * tests all ran within one process, where in-memory state looks exactly like
 * working persistence.
 *
 * These tests drive the real SQL statements against an in-memory fake that
 * stores rows and answers this module's queries. The fake does NOT reimplement
 * SQLite: it is just enough to catch the failures that matter here — a field
 * that never gets written, a column that silently writes `undefined`, a round
 * trip that loses a message.
 *
 * ── What it deliberately does NOT prove ─────────────────────────────────────
 * That op-sqlite behaves as assumed. The fake implements the `SqliteDb`
 * interface, so a wrong assumption about the BINDING (for instance that
 * `getAll` exists — it does not, in 18.x) is invisible here. That class of bug
 * is caught by reading the installed `.d.ts`, not by a test.
 *
 * Run with:
 *   node --import ./scripts/register-alias.mjs --test src/data/db/conversations.test.ts
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import type { Conversation, Message } from '@/types/domain.ts'

import { __setDbForTests, type SqliteDb } from './connection.ts'
import {
  deleteConversation,
  deleteMessage,
  loadConversations,
  loadMessages,
  saveConversation,
  saveMessage,
  saveTranscript,
} from './conversations.ts'

// ── In-memory stand-in for the two tables ────────────────────────────────────

type Row = Record<string, unknown>

let conversations: Map<string, Row>
let messages: Map<string, Row>

/**
 * Column order of the INSERT statements in `conversations.ts`.
 *
 * Declared explicitly rather than parsed from the SQL, so a change to the column
 * list without a matching change here fails loudly instead of shifting every
 * value one position — which would "pass" while writing garbage.
 */
const CONVERSATION_COLUMNS = [
  'id',
  'title',
  'character_id',
  'model_id',
  'sampler_override',
  'context_override',
  'world_info',
  'message_count',
  'last_message_at',
  'created_at',
  'updated_at',
]

const MESSAGE_COLUMNS = [
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
]

/** Which table an INSERT targets. */
function tableOf(sql: string): 'conversations' | 'messages' {
  return /INSERT INTO conversations/i.test(sql) ? 'conversations' : 'messages'
}

function columnsOf(sql: string): string[] {
  return tableOf(sql) === 'conversations' ? CONVERSATION_COLUMNS : MESSAGE_COLUMNS
}

function rowsOf(sql: string): Map<string, Row> {
  return tableOf(sql) === 'conversations' ? conversations : messages
}

/** Install a fresh fake database for one test. */
function installFake(): void {
  conversations = new Map()
  messages = new Map()

  const fake: SqliteDb = {
    async all<T>(sql: string, params?: unknown[]): Promise<T[]> {
      if (/FROM conversations/i.test(sql)) {
        const rows = [...conversations.values()]
        rows.sort((a, b) => Number(b.last_message_at) - Number(a.last_message_at))
        return rows as T[]
      }
      if (/FROM messages/i.test(sql)) {
        const id = params?.[0] == null ? null : String(params[0])
        const rows = [...messages.values()].filter(
          (r) => id == null || r.conversation_id === id,
        )
        rows.sort(
          (a, b) =>
            Number(a.created_at) - Number(b.created_at) ||
            String(a.id).localeCompare(String(b.id)),
        )
        return rows as T[]
      }
      return []
    },

    async one<T>(sql: string, params?: unknown[]): Promise<T | null> {
      const rows = await fake.all<T>(sql, params)
      return rows[0] ?? null
    },

    async run(sql: string, params?: unknown[]): Promise<void> {
      if (/^\s*INSERT INTO/i.test(sql)) {
        const columns = columnsOf(sql)
        const row: Row = {}
        for (let i = 0; i < columns.length; i += 1) row[columns[i]!] = params?.[i]
        rowsOf(sql).set(String(row.id), row)
        return
      }

      if (/^\s*DELETE FROM conversations/i.test(sql)) {
        const id = String(params?.[0])
        conversations.delete(id)
        // Reproduce `ON DELETE CASCADE`, which the PRAGMA enables in production.
        for (const [mid, row] of messages) {
          if (row.conversation_id === id) messages.delete(mid)
        }
        return
      }

      if (/^\s*DELETE FROM messages/i.test(sql)) {
        messages.delete(String(params?.[0]))
        return
      }
    },

    async tx(fn) {
      // No rollback: the tests never exercise failure mid-transaction, and
      // pretending to roll back would invite false confidence.
      await fn(fake)
    },

    raw: { execute: async () => ({}) },
  }

  __setDbForTests(fake)
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  const now = 1_700_000_000_000
  return {
    id: 'conv_1',
    title: '测试对话',
    characterId: null,
    modelId: null,
    samplerOverride: null,
    contextOverride: null,
    worldInfo: '',
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    lastMessageAt: now,
    ...overrides,
  }
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg_1',
    conversationId: 'conv_1',
    role: 'user',
    content: '你好',
    reasoning: null,
    createdAt: 1_700_000_000_001,
    modelId: null,
    swipeIndex: 0,
    swipes: [],
    edited: false,
    pinned: false,
    ...overrides,
  }
}

describe('conversation persistence', () => {
  beforeEach(installFake)

  test('a saved conversation round-trips with every field intact', async () => {
    const original = conversation({
      characterId: 'char_9',
      modelId: 'qwen2.5-3b',
      samplerOverride: { temperature: 0.7 },
      contextOverride: { contextLength: 8192 },
      worldInfo: '世界书内容',
      messageCount: 4,
    })

    await saveConversation(original)
    const [loaded] = await loadConversations()

    assert.deepEqual(loaded, original)
  })

  test('a saved message round-trips with every field intact', async () => {
    await saveConversation(conversation())
    const original = message({
      role: 'assistant',
      content: '回复内容',
      reasoning: '思考过程',
      modelId: 'qwen2.5-3b',
      swipeIndex: 2,
      swipes: ['备选一', '备选二'],
      edited: true,
      pinned: true,
    })

    await saveMessage(original)
    const [loaded] = await loadMessages('conv_1')

    assert.deepEqual(loaded, original)
  })

  test('a transcript survives a full save and reload', async () => {
    // The end-to-end shape of the user-visible bug: send messages, close the
    // app, reopen it. Before persistence this returned an empty list.
    const convo = conversation({ messageCount: 3 })
    const msgs = [
      message({ id: 'm1', role: 'user', content: '第一条', createdAt: 1 }),
      message({ id: 'm2', role: 'assistant', content: '回复', createdAt: 2 }),
      message({ id: 'm3', role: 'user', content: '第二条', createdAt: 3 }),
    ]

    await saveTranscript(convo, msgs)

    const reloaded = await loadMessages('conv_1')
    assert.deepEqual(
      reloaded.map((m) => m.content),
      ['第一条', '回复', '第二条'],
    )
  })

  test('messages come back in chronological order', async () => {
    await saveConversation(conversation())
    // Inserted out of order on purpose: ordering must come from `created_at`,
    // not from insertion order.
    await saveMessage(message({ id: 'b', content: 'second', createdAt: 200 }))
    await saveMessage(message({ id: 'a', content: 'first', createdAt: 100 }))
    await saveMessage(message({ id: 'c', content: 'third', createdAt: 300 }))

    const loaded = await loadMessages('conv_1')
    assert.deepEqual(
      loaded.map((m) => m.content),
      ['first', 'second', 'third'],
    )
  })

  test('re-saving the same message updates rather than duplicates', async () => {
    await saveConversation(conversation())
    await saveMessage(message({ id: 'm1', content: '改之前' }))
    await saveMessage(message({ id: 'm1', content: '改之后' }))

    const loaded = await loadMessages('conv_1')
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0]!.content, '改之后')
  })

  test('deleting a conversation removes its messages too', async () => {
    await saveTranscript(conversation(), [
      message({ id: 'm1', createdAt: 1 }),
      message({ id: 'm2', createdAt: 2 }),
    ])

    await deleteConversation('conv_1')

    assert.equal((await loadConversations()).length, 0)
    // Orphaned rows would show up as ghost history if the id were reused.
    assert.equal((await loadMessages('conv_1')).length, 0)
  })

  test('deleting one message leaves the rest', async () => {
    await saveConversation(conversation())
    await saveMessage(message({ id: 'm1', createdAt: 1 }))
    await saveMessage(message({ id: 'm2', createdAt: 2 }))

    await deleteMessage('m1')

    const loaded = await loadMessages('conv_1')
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0]!.id, 'm2')
  })

  test('an empty transcript loads as an empty list, not null', async () => {
    await saveConversation(conversation())
    assert.deepEqual(await loadMessages('conv_1'), [])
  })

  test('a corrupt JSON column degrades to null instead of throwing', async () => {
    // A half-written override must not make the whole conversation unreadable.
    await saveConversation(conversation({ samplerOverride: { temperature: 1 } }))
    conversations.get('conv_1')!.sampler_override = '{ this is not json'

    const [loaded] = await loadConversations()
    assert.equal(loaded!.samplerOverride, null)
    assert.equal(loaded!.id, 'conv_1')
  })

  test('no database means every operation is a silent no-op', async () => {
    // The Node test process has no native SQLite; the app must still work.
    __setDbForTests(null)

    await saveConversation(conversation())
    await saveMessage(message())
    await deleteConversation('conv_1')

    assert.deepEqual(await loadConversations(), [])
    assert.deepEqual(await loadMessages('conv_1'), [])
  })

  test('SQL errors are swallowed so a failed write cannot break the UI', async () => {
    __setDbForTests({
      all: async () => {
        throw new Error('corrupt database')
      },
      one: async () => {
        throw new Error('corrupt database')
      },
      run: async () => {
        throw new Error('disk full')
      },
      tx: async () => {
        throw new Error('disk full')
      },
      raw: { execute: async () => ({}) },
    })

    await saveConversation(conversation())
    await saveMessage(message())
    await saveTranscript(conversation(), [message()])
    assert.deepEqual(await loadConversations(), [])
  })

  test('booleans are stored as 0/1, which is what SQLite expects', async () => {
    await saveConversation(conversation())
    await saveMessage(message({ edited: true, pinned: false }))

    const row = messages.get('msg_1')!
    assert.equal(row.edited, 1)
    assert.equal(row.pinned, 0)
  })

  test('nulls survive the round trip', async () => {
    await saveConversation(
      conversation({ characterId: null, modelId: null, samplerOverride: null }),
    )
    await saveMessage(message({ reasoning: null, modelId: null }))

    const [c] = await loadConversations()
    assert.equal(c!.characterId, null)
    assert.equal(c!.modelId, null)
    assert.equal(c!.samplerOverride, null)

    const [m] = await loadMessages('conv_1')
    assert.equal(m!.reasoning, null)
    assert.equal(m!.modelId, null)
  })

  test('a save and reload of many messages preserves all of them', async () => {
    // Guards against a chunked/limited write path silently truncating.
    const many = Array.from({ length: 200 }, (_, i) =>
      message({ id: `m${i}`, content: `第 ${i} 条`, createdAt: i }),
    )

    await saveTranscript(conversation({ messageCount: many.length }), many)
    const reloaded = await loadMessages('conv_1')

    assert.equal(reloaded.length, 200)
    assert.equal(reloaded[0]!.content, '第 0 条')
    assert.equal(reloaded[199]!.content, '第 199 条')
  })
})
