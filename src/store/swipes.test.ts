/**
 * Multi-version assistant replies ("swipes").
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * A local model's output varies run to run, and the ONLY recovery used to be
 * "重新生成" — which deleted the reply it replaced. On a phone emitting ~10
 * tokens/second a reply costs tens of seconds, so discarding one to see another
 * is a bad trade the user had no way to avoid.
 *
 * The feature rests on one invariant:
 *
 *     message.content === message.swipes[message.swipeIndex]
 *
 * `content` is what the transcript RENDERS and what `generate()` sends back to
 * the model as history. `swipes`/`swipeIndex` are what the user navigates. If
 * they disagree the user reads version 2 while the model is told version 1 —
 * the reply answers a message not on screen, which looks like the model "went
 * crazy" rather than like a bookkeeping bug. That is why every test below
 * asserts the pairing rather than just the text.
 *
 * Run with:
 *   node --import ./scripts/register-alias.mjs --test src/store/swipes.test.ts
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import type { Conversation, Message } from '@/types/domain.ts'

import { useChatStore } from '@/store/index.ts'
import { __setEngineForTests, clearBackend } from '@/inference/engineFactory.ts'
import type { InferenceEngine } from '@/inference/InferenceEngine.ts'
import { __setDbForTests, type SqliteDb } from '@/data/db/connection.ts'
import { loadMessages, saveMessage } from '@/data/db/conversations.ts'
import { appendSwipe, clampSwipeIndex, stepSwipe, swipesOf, swipeLabel, withSwipeIndex } from '@/store/swipe.ts'

// ── Fakes ────────────────────────────────────────────────────────────────────

/**
 * An engine that returns a DIFFERENT reply each call.
 *
 * The counter matters: a fake that returns a fixed string would make
 * "regenerate produced a new version" pass even if the store were appending the
 * OLD text, because `appendSwipe` de-duplicates identical versions.
 */
function fakeEngine(): { engine: InferenceEngine; calls: { reset: number; completion: number } } {
  const calls = { reset: 0, completion: 0 }
  const engine = {
    async load() {
      return {
        modelId: 'fake',
        contextLength: 4096,
        gpuActive: false,
        gpuFallbackReason: null,
        activeDevices: [],
        metadata: {},
        chatTemplate: null,
      }
    },
    async unload() {},
    isReady: () => true,
    async resetContext() {
      calls.reset += 1
    },
    async completion(_messages: unknown, _params: unknown, onChunk?: (c: unknown) => void) {
      calls.completion += 1
      const text = `回复版本${calls.completion}`
      onChunk?.({ text, accumulated: text, done: false })
      return {
        text,
        reasoning: null,
        timings: {
          promptTokens: 1,
          generatedTokens: 1,
          promptMs: 1,
          generationMs: 1,
          tokensPerSecond: 1,
          promptTokensPerSecond: 1,
          cacheReusedTokens: 0,
        },
      }
    },
    async stop() {},
    async setChatTemplate() {},
    async countTokens() {
      return 1
    },
  } as unknown as InferenceEngine
  return { engine, calls }
}

/** A fake database that records the last UPDATE issued against `messages`. */
function installRecordingDb(): { writes: Array<Record<string, unknown>>; rows: Map<string, Record<string, unknown>> } {
  const writes: Array<Record<string, unknown>> = []
  const rows = new Map<string, Record<string, unknown>>()

  const fake: SqliteDb = {
    async all<T>(sql: string, params?: unknown[]): Promise<T[]> {
      if (/FROM messages/i.test(sql)) {
        const id = params?.[0] == null ? null : String(params[0])
        // ⚠️ Match on `conversation_id`, not `id`. `loadMessages` filters
        // `WHERE conversation_id = ?`, and matching the primary key instead
        // silently returned nothing for a multi-message conversation — the
        // reads came back empty and every persistence assertion failed with a
        // confusing "undefined" rather than any hint about the fake.
        return [...rows.values()].filter(
          (r) => id == null || r.conversation_id === id,
        ) as T[]
      }
      return []
    },
    async one<T>(sql: string, params?: unknown[]): Promise<T | null> {
      const found = await fake.all<T>(sql, params)
      return found[0] ?? null
    },
    async run(sql: string, params?: unknown[]): Promise<void> {
      if (/INSERT INTO messages/i.test(sql)) {
        const cols = [
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
        const row: Record<string, unknown> = {}
        cols.forEach((c, i) => {
          row[c] = params?.[i]
        })
        rows.set(String(row.id), row)
        writes.push({ sql, ...row })
        return
      }
      if (/UPDATE messages SET content/i.test(sql)) {
        // Column order of `saveMessageSwipes`.
        const [content, swipesJson, swipeIndex, id] = params as [string, string, number, string]
        const row = rows.get(String(id))
        if (row) {
          row.content = content
          row.swipes_json = swipesJson
          row.swipe_index = swipeIndex
        }
        writes.push({ content, swipes_json: swipesJson, swipe_index: swipeIndex, id })
        return
      }
      if (/DELETE FROM messages/i.test(sql)) {
        rows.delete(String(params?.[0]))
      }
    },
    async tx(fn) {
      await fn(fake)
    },
    raw: { execute: async () => ({}) },
  }

  __setDbForTests(fake)
  return { writes, rows }
}

function resetStore(): void {
  clearBackend()
  __setDbForTests(null)
  useChatStore.setState({
    conversations: [],
    activeConversationId: null,
    messages: [],
    transcripts: {},
    characters: [],
  } as never)
}

function assistantReply(id: string, content: string, at: number): Message {
  return {
    id,
    conversationId: 'x',
    role: 'assistant',
    content,
    reasoning: null,
    createdAt: at,
    modelId: null,
    swipeIndex: 0,
    swipes: [],
    edited: false,
    pinned: false,
  }
}

/** The invariant, asserted the same way everywhere. */
function assertInvariant(message: Message): void {
  assert.ok(message.swipes.length > 0, 'an assistant reply must have at least one version')
  assert.equal(
    message.content,
    message.swipes[message.swipeIndex],
    `content (${JSON.stringify(message.content)}) must equal swipes[${message.swipeIndex}]`,
  )
}

/** Seed a reply that already has several versions, as the UI would. */
function seedVersions(versions: string[], index = 0): string {
  const id = useChatStore.getState().createConversation(null)
  useChatStore.getState().appendUser('用户的问题')
  /**
   * ⚠️ The reply must carry the REAL conversation id.
   *
   * `assistantReply` hardcodes `conversationId: 'x'`, which is fine for the
   * in-memory tests but makes the row invisible to `loadMessages`, which
   * filters `WHERE conversation_id = ?`. Persistence assertions then fail with
   * "row must exist" even though the write succeeded.
   */
  useChatStore.getState().appendMessage(
    withSwipeIndex(
      { ...assistantReply('a1', versions[0]!, 1), conversationId: id, swipes: versions },
      index,
    ) as never,
  )
  return id
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('swipe helpers', () => {
  test('swipesOf treats a pre-feature assistant reply as one version', () => {
    // Every row written before this feature has `swipes_json = '[]'`. Reading
    // that as zero versions would make the arrows render "0/0" on every reply
    // in every conversation the user already has.
    const legacy = assistantReply('a1', '旧回复', 1)
    assert.deepEqual(swipesOf(legacy), ['旧回复'])
  })

  test('swipesOf never invents versions for a user turn', () => {
    // Seeding a user turn would let the UI offer to swap the user's own message
    // for a wording they never typed.
    const user = { ...assistantReply('u1', '我说的话', 1), role: 'user' as const }
    assert.deepEqual(swipesOf(user), [])
  })

  test('clampSwipeIndex folds garbage into a valid index', () => {
    // A fractional index indexes to `undefined` and blanks the bubble; NaN is
    // what a missing column or corrupt JSON produces. Both must not escape.
    assert.equal(clampSwipeIndex(5, 3), 2)
    assert.equal(clampSwipeIndex(-1, 3), 0)
    assert.equal(clampSwipeIndex(0.5, 3), 0)
    assert.equal(clampSwipeIndex(Number.NaN, 3), 0)
    assert.equal(clampSwipeIndex(1, 0), 0)
  })

  test('stepSwipe wraps at both ends', () => {
    const message = { ...assistantReply('a1', '甲', 1), swipes: ['甲', '乙', '丙'] }
    const last = withSwipeIndex(message, 2)
    assert.equal(stepSwipe(last, 1).content, '甲', 'next from the last wraps to the first')
    assert.equal(stepSwipe(withSwipeIndex(message, 0), -1).content, '丙', 'prev from the first wraps')
  })

  test('stepSwipe on a single-version reply is stable', () => {
    const one = { ...assistantReply('a1', '唯一', 1), swipes: ['唯一'] }
    assert.equal(stepSwipe(one, 1).content, '唯一')
    assert.equal(stepSwipe(one, -1).content, '唯一')
    assert.equal(stepSwipe(one, 1).swipeIndex, 0)
  })

  test('appendSwipe appends and selects, and refuses a duplicate', () => {
    const base = { ...assistantReply('a1', '甲', 1), swipes: ['甲'] }
    const two = appendSwipe(base, '乙')
    assert.deepEqual(two.swipes, ['甲', '乙'])
    assert.equal(two.swipeIndex, 1)
    assert.equal(two.content, '乙')

    // A retry that produced byte-identical output must not add a "new" version
    // that reads as the button having done nothing.
    const again = appendSwipe(two, '乙')
    assert.equal(again.swipes.length, 2)
    assert.equal(again.content, '乙')
  })

  test('appendSwipe refuses an empty version', () => {
    // Generation can legitimately yield nothing (immediate stop, whitespace
    // only). A blank version is selectable and the user has to escape it.
    const base = { ...assistantReply('a1', '甲', 1), swipes: ['甲'] }
    const result = appendSwipe(base, '')
    assert.deepEqual(result.swipes, ['甲'])
    assert.equal(result.content, '甲')
  })
})

/**
 * What the version bar actually shows.
 *
 * This is the only part of the swipe UI reachable from a test: the project runs
 * its suite under `node --test` with no renderer, and adding one would mean a
 * new dependency (forbidden by the contract). So the DISPLAY DECISION lives in
 * `swipeLabel` and is covered here, and `ChatScreen` only renders its result.
 *
 * Asserting the `.tsx` source text instead would pass with the fraction
 * inverted, which is why this exists.
 */
describe('swipeLabel (what the UI renders)', () => {
  test('is hidden for a single-version reply', () => {
    // The overwhelming majority of replies. A "1/1" on every bubble would be
    // noise and would train the user to ignore the control.
    assert.equal(swipeLabel({ ...assistantReply('a1', '唯一版本', 1), swipes: ['唯一版本'] }), null)
  })

  test('is hidden for a pre-feature reply with no swipes stored', () => {
    // Every assistant row written before this feature has `swipes: []`. Showing
    // a counter there would render "0/0".
    assert.equal(swipeLabel(assistantReply('a1', '旧回复', 1)), null)
  })

  test('is hidden for a user turn', () => {
    const user: Message = {
      ...assistantReply('u1', '问题', 1),
      role: 'user',
      swipes: ['问题'],
    }
    assert.equal(swipeLabel(user), null, 'a user turn has no alternatives to offer')
  })

  test('reports a 1-based position and the total', () => {
    const message = { ...assistantReply('a1', '二', 1), swipes: ['一', '二', '三'], swipeIndex: 1 }
    assert.deepEqual(swipeLabel(message), { position: 2, total: 3 })
  })

  test('shows the first version as 1/N', () => {
    const message = { ...assistantReply('a1', '一', 1), swipes: ['一', '二'], swipeIndex: 0 }
    assert.deepEqual(swipeLabel(message), { position: 1, total: 2 })
  })

  test('shows the last version as N/N', () => {
    const message = { ...assistantReply('a1', '三', 1), swipes: ['一', '二', '三'], swipeIndex: 2 }
    assert.deepEqual(swipeLabel(message), { position: 3, total: 3 })
  })

  test('a stale out-of-range index never renders 0/N or beyond N/N', () => {
    // Reachable by loading a row whose swipes were pruned elsewhere, or by a
    // corrupt column. The user must never see a position that cannot exist.
    const high = { ...assistantReply('a1', '一', 1), swipes: ['一', '二'], swipeIndex: 9 }
    assert.deepEqual(swipeLabel(high), { position: 2, total: 2 })

    const negative = { ...assistantReply('a1', '一', 1), swipes: ['一', '二'], swipeIndex: -4 }
    assert.deepEqual(swipeLabel(negative), { position: 1, total: 2 })
  })

  test('the label stays consistent with the content shown', () => {
    // The bar and the bubble must agree: `position` identifies the version whose
    // text is on screen, so switching versions moves both together.
    let message = { ...assistantReply('a1', '甲', 1), swipes: ['甲', '乙', '丙'], swipeIndex: 0 }
    assert.deepEqual(swipeLabel(message), { position: 1, total: 3 })
    assert.equal(message.content, '甲')

    message = stepSwipe(message, 1)
    assert.deepEqual(swipeLabel(message), { position: 2, total: 3 })
    assert.equal(message.content, '乙')

    message = stepSwipe(message, 1)
    assert.deepEqual(swipeLabel(message), { position: 3, total: 3 })
    assert.equal(message.content, '丙')
  })

  test('the count grows when a new version is appended', () => {
    let message = { ...assistantReply('a1', '甲', 1), swipes: ['甲'], swipeIndex: 0 }
    assert.equal(swipeLabel(message), null, 'hidden until a second version exists')

    message = appendSwipe(message, '乙')
    assert.deepEqual(swipeLabel(message), { position: 2, total: 2 })

    message = appendSwipe(message, '丙')
    assert.deepEqual(swipeLabel(message), { position: 3, total: 3 })
  })
})

// ── Store integration ────────────────────────────────────────────────────────

describe('swipe navigation', () => {
  beforeEach(resetStore)

  test('switching versions keeps content equal to swipes[swipeIndex]', () => {
    seedVersions(['版本甲', '版本乙', '版本丙'])

    useChatStore.getState().nextSwipe('a1')
    assertInvariant(useChatStore.getState().messages[1]!)

    useChatStore.getState().nextSwipe('a1')
    assertInvariant(useChatStore.getState().messages[1]!)
    assert.equal(useChatStore.getState().messages[1]!.content, '版本丙')

    useChatStore.getState().prevSwipe('a1')
    assertInvariant(useChatStore.getState().messages[1]!)
    assert.equal(useChatStore.getState().messages[1]!.content, '版本乙')
  })

  test('navigation wraps past the last version back to the first', () => {
    seedVersions(['甲', '乙', '丙'], 2)

    useChatStore.getState().nextSwipe('a1')
    const after = useChatStore.getState().messages[1]!
    assert.equal(after.swipeIndex, 0, 'past the last version must wrap, not dead-end')
    assertInvariant(after)

    useChatStore.getState().prevSwipe('a1')
    assert.equal(useChatStore.getState().messages[1]!.swipeIndex, 2)
    assertInvariant(useChatStore.getState().messages[1]!)
  })

  test('a single-version reply cannot be navigated out of range', () => {
    seedVersions(['唯一版本'])

    useChatStore.getState().nextSwipe('a1')
    useChatStore.getState().prevSwipe('a1')
    useChatStore.getState().nextSwipe('a1')

    const only = useChatStore.getState().messages[1]!
    assert.equal(only.swipeIndex, 0)
    assert.equal(only.content, '唯一版本')
    assertInvariant(only)
  })

  test('navigating an unknown id changes nothing', () => {
    seedVersions(['甲', '乙'])
    const before = useChatStore.getState().messages

    useChatStore.getState().nextSwipe('does-not-exist')
    useChatStore.getState().prevSwipe('does-not-exist')

    assert.deepEqual(useChatStore.getState().messages, before)
  })

  test('the parked transcript copy is updated by navigation too', () => {
    // `messages` is swapped out on every conversation switch. A change that
    // landed only there would be lost the moment the user navigated away and
    // back — the same class of bug `transcripts.test.ts` was written for.
    const id = seedVersions(['甲', '乙'])
    useChatStore.getState().nextSwipe('a1')

    const parked = useChatStore.getState().transcripts[id]!
    assert.ok(parked, 'the transcript must be parked')
    const parkedReply = parked.find((m) => m.id === 'a1')!
    assert.equal(parkedReply.content, '乙')
    assert.equal(parkedReply.swipeIndex, 1)
    assertInvariant(parkedReply)
  })

  test('navigation survives a conversation switch round trip', () => {
    const id = seedVersions(['甲', '乙'])
    useChatStore.getState().nextSwipe('a1')

    useChatStore.getState().setActiveConversation(null)
    useChatStore.getState().setActiveConversation(id)

    assertInvariant(useChatStore.getState().messages[1]!)
    assert.equal(useChatStore.getState().messages[1]!.content, '乙')
  })
})

describe('regenerateSwipe', () => {
  beforeEach(resetStore)

  test('it appends a new version instead of replacing the old one', async () => {
    const { engine, calls } = fakeEngine()
    __setEngineForTests(engine, 'local')

    seedVersions(['第一个版本'])

    await useChatStore.getState().regenerateSwipe('a1')

    const messages = useChatStore.getState().messages
    // One reply, not two: a re-roll of a turn must not create a sibling
    // assistant message, or the transcript has two answers to one question.
    assert.equal(messages.length, 2, 'the transcript must still be user + one reply')

    const reply = messages[1]!
    assert.equal(reply.id, 'a1', 'the reply keeps its identity across a regeneration')
    assert.deepEqual(reply.swipes, ['第一个版本', '回复版本1'])
    assert.equal(reply.swipeIndex, 1, 'the new version is selected')
    assertInvariant(reply)
    assert.equal(calls.completion, 1)
  })

  test('the previous version is still reachable after regenerating', async () => {
    const { engine } = fakeEngine()
    __setEngineForTests(engine, 'local')

    seedVersions(['旧回复'])
    await useChatStore.getState().regenerateSwipe('a1')

    // This is the whole point of the feature: the answer the user waited for is
    // recoverable, not gone.
    useChatStore.getState().prevSwipe('a1')
    const back = useChatStore.getState().messages[1]!
    assert.equal(back.content, '旧回复')
    assert.equal(back.swipeIndex, 0)
    assertInvariant(back)
  })

  test('repeated regenerations accumulate versions rather than losing them', async () => {
    const { engine, calls } = fakeEngine()
    __setEngineForTests(engine, 'local')

    seedVersions(['第零版'])
    await useChatStore.getState().regenerateSwipe('a1')
    await useChatStore.getState().regenerateSwipe('a1')

    const reply = useChatStore.getState().messages[1]!
    assert.deepEqual(reply.swipes, ['第零版', '回复版本1', '回复版本2'])
    assert.equal(reply.swipeIndex, 2)
    assertInvariant(reply)
    assert.equal(calls.completion, 2)
  })

  test('it refuses a user message', async () => {
    const { engine, calls } = fakeEngine()
    __setEngineForTests(engine, 'local')

    useChatStore.getState().createConversation(null)
    useChatStore.getState().appendUser('用户的问题')

    const userId = useChatStore.getState().messages[0]!.id
    await useChatStore.getState().regenerateSwipe(userId)

    // There is nothing for a user turn to have alternatives TO.
    assert.equal(calls.completion, 0)
  })
})

describe('regenerateFrom keeps versions and still trims later turns', () => {
  beforeEach(resetStore)

  test('the replaced answer becomes a version rather than being deleted', async () => {
    const { engine } = fakeEngine()
    __setEngineForTests(engine, 'local')

    useChatStore.getState().createConversation(null)
    useChatStore.getState().appendUser('问题')
    useChatStore.getState().appendMessage(assistantReply('a1', '糟糕的回复', 1))

    await useChatStore.getState().regenerateFrom('a1')

    const messages = useChatStore.getState().messages
    assert.deepEqual(
      messages.map((m) => m.content),
      ['问题', '回复版本1'],
    )
    // ⚠️ The behaviour under test: the discarded text is PRESERVED as a version.
    const reply = messages[1]!
    assert.deepEqual(reply.swipes, ['糟糕的回复', '回复版本1'])
    assertInvariant(reply)
  })

  test('later turns are still dropped, as before the feature', async () => {
    const { engine } = fakeEngine()
    __setEngineForTests(engine, 'local')

    useChatStore.getState().createConversation(null)
    useChatStore.getState().appendUser('第一问')
    useChatStore.getState().appendMessage(assistantReply('a1', '第一答', 1))
    useChatStore.getState().appendUser('第二问')
    useChatStore.getState().appendMessage(assistantReply('a2', '第二答', 2))

    await useChatStore.getState().regenerateFrom('a1')

    // Those later turns answered a conversation whose reply is being replaced.
    assert.deepEqual(
      useChatStore.getState().messages.map((m) => m.content),
      ['第一问', '回复版本1'],
    )
    assertInvariant(useChatStore.getState().messages[1]!)
  })

  test('the conversation message count stays consistent', async () => {
    const { engine } = fakeEngine()
    __setEngineForTests(engine, 'local')

    const id = useChatStore.getState().createConversation(null)
    useChatStore.getState().appendUser('问题')
    useChatStore.getState().appendMessage(assistantReply('a1', '回复一', 1))
    useChatStore.getState().appendUser('追问')
    useChatStore.getState().appendMessage(assistantReply('a2', '回复二', 2))

    await useChatStore.getState().regenerateFrom('a1')

    const convo = useChatStore.getState().conversations.find((c) => c.id === id)!
    // The invariant that actually matters: the denormalised counter the LIST
    // renders must equal the transcript the chat opens with. The exact value is
    // incidental — and it is 2, not 3, because the regenerated reply lands as a
    // VERSION of the kept target via `replaceMessage` (which does not increment
    // a per-append counter), rather than as a newly appended message.
    assert.equal(convo.messageCount, useChatStore.getState().messages.length)
    assert.equal(convo.messageCount, 2)
    assert.deepEqual(
      useChatStore.getState().messages.map((m) => m.content),
      ['问题', '回复版本1'],
    )
  })

  test('it still refuses when there is no preceding user turn', async () => {
    const { engine, calls } = fakeEngine()
    __setEngineForTests(engine, 'local')

    useChatStore.getState().createConversation(null)
    useChatStore.getState().appendMessage(assistantReply('a1', '凭空出现的回复', 1))

    await useChatStore.getState().regenerateFrom('a1')

    assert.equal(calls.completion, 0)
    assert.match(useChatStore.getState().error ?? '', /用户消息/)
  })
})

// ── Persistence ──────────────────────────────────────────────────────────────

describe('swipe persistence', () => {
  beforeEach(resetStore)

  test('a version list round-trips through the database', async () => {
    const { rows } = installRecordingDb()

    await useChatStore.getState().createConversation('c1')
    const conversationId = useChatStore.getState().activeConversationId ?? 'c1'

    const reply: Message = {
      ...assistantReply('a1', '版本乙', 5),
      conversationId,
      swipes: ['版本甲', '版本乙', '版本丙'],
      swipeIndex: 1,
    }
    await saveMessage(reply)

    // Written, not silently dropped — the column existed but nothing populated
    // it, so a reload returned no versions at all.
    assert.ok(rows.has('a1'), 'the row must be written')
    assert.equal(rows.get('a1')!.swipes_json, JSON.stringify(['版本甲', '版本乙', '版本丙']))
    assert.equal(rows.get('a1')!.swipe_index, 1)

    const [loaded] = await loadMessages(conversationId)
    assert.deepEqual(loaded!.swipes, ['版本甲', '版本乙', '版本丙'])
    assert.equal(loaded!.swipeIndex, 1)
    assertInvariant(loaded!)
  })

  test('an out-of-range index is clamped on write, not stored broken', async () => {
    const { rows } = installRecordingDb()

    await saveMessage({
      ...assistantReply('a1', '乙', 5),
      swipes: ['甲', '乙'],
      swipeIndex: 9,
    })

    // Storing 9 against a 2-element array would blank the bubble on reload.
    assert.equal(rows.get('a1')!.swipe_index, 1)
    assert.equal(rows.get('a1')!.content, '乙')
  })

  test('a legacy row with an empty swipes array still reads as one version', async () => {
    const { rows } = installRecordingDb()
    rows.set('a1', {
      id: 'a1',
      conversation_id: 'c1',
      role: 'assistant',
      content: '老回复',
      reasoning: null,
      model_id: null,
      swipe_index: 0,
      swipes_json: '[]',
      edited: 0,
      pinned: 0,
      created_at: 1,
    })

    const [loaded] = await loadMessages('c1')
    // Reading it upgrades the shape in memory, so the UI shows "1/1" rather
    // than "0/0" for every reply written before this feature existed.
    const healed = withSwipeIndex(loaded!, 0)
    assert.deepEqual(swipesOf(healed), ['老回复'])
    assertInvariant(healed)
  })

  test('switching versions persists the new index', async () => {
    installRecordingDb()
    const conversationId = seedVersions(['甲', '乙'])

    /**
     * ⚠️ `seedVersions` only puts messages in the STORE; it does not write rows.
     * `nextSwipe` persists with a narrow `UPDATE ... WHERE id = ?`, which is a
     * no-op against a row that does not exist. Inserting the seeded row first is
     * what makes this a persistence test rather than a test of an update that
     * updated nothing.
     */
    /**
     * ⚠️ Drain the fire-and-forget writes from `seedVersions` FIRST.
     *
     * `appendUser` and `appendMessage` persist via `saveTranscript` without
     * being awaited. Inserting the row before those land lets a queued
     * transaction overwrite the row afterwards, so the assertion reads the
     * pre-switch index and the test fails for a reason that has nothing to do
     * with swipe persistence.
     */
    await new Promise((resolve) => setTimeout(resolve, 0))
    await saveMessage(useChatStore.getState().messages[1]!)

    useChatStore.getState().nextSwipe('a1')
    /**
     * Two drains, not one.
     *
     * `nextSwipe` issues its UPDATE and `replaceMessage` also mirrors the whole
     * transcript. Those are queued in order, and a single `setTimeout(0)` can
     * return while the second is still pending — which reads as the switch not
     * having persisted at all. Draining twice lets the queue settle before the
     * assertion.
     */
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    const reloaded = await loadMessages(conversationId)
    // Select by id, not by position: the transcript also holds the seeded user
    // turn, and `loadMessages` orders by `created_at` — so index 0 is the user
    // message and reading it there silently asserts against the wrong row.
    const persisted = reloaded.find((m) => m.id === 'a1')
    assert.ok(persisted, 'the reply row must exist')
    assert.equal(
      persisted.swipeIndex,
      1,
      `the selected version must survive a reload (got content=${JSON.stringify(persisted.content)}, swipes=${JSON.stringify(persisted.swipes)})`,
    )
    assert.equal(persisted.content, '乙')
    assert.deepEqual(persisted.swipes, ['甲', '乙'])
  })

  test('no database means swipes still work in memory', async () => {
    __setDbForTests(null)
    seedVersions(['甲', '乙'])

    useChatStore.getState().nextSwipe('a1')

    assertInvariant(useChatStore.getState().messages[1]!)
    assert.equal(useChatStore.getState().messages[1]!.content, '乙')
  })
})
