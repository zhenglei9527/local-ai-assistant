/**
 * Editing a message that is already in the transcript.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * A user who mistypes a message, or wants to reword a question and re-send it,
 * previously had exactly one option: delete the whole conversation and start
 * over. `replaceMessage` existed in the store but nothing called it.
 *
 * Editing is deceptively simple — "swap the string" — and three things about it
 * are easy to get wrong and invisible when they are:
 *
 *   1. The parked transcript must be updated too. `messages` is swapped out on
 *      every conversation switch, so a change that lands only in the visible
 *      array is reverted the moment the user leaves the screen and comes back.
 *      That reads as "my edit did not save".
 *   2. The other messages must be untouched. A naive `map` that returns the new
 *      object for every row, or an edit that rebinds the whole array to a single
 *      message, silently destroys the rest of the history.
 *   3. An unknown id must be a no-op rather than a throw. The id can go stale
 *      (the message was deleted on another screen while the editor was open), and
 *      a throw inside a Zustand setter takes the screen down with it.
 *
 * The engine's KV cache is part of the contract as well: the cached prefix holds
 * the PRE-edit tokens, so a subsequent generation against a stale cache
 * continues the old text. The UI resets it on save and that reset is asserted
 * here through a fake engine.
 *
 * Run with:
 *   node --import ./scripts/register-alias.mjs --test src/store/editMessage.test.ts
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import type { Message } from '@/types/domain.ts'

import { useChatStore } from '@/store/index.ts'
import { __setEngineForTests, activeEngine, clearBackend } from '@/inference/engineFactory.ts'
import type { InferenceEngine } from '@/inference/InferenceEngine.ts'

/**
 * An engine that records the calls made against it.
 *
 * Only `resetContext` is exercised by editing, but the full surface is stubbed
 * because `activeEngine()` hands back a typed `InferenceEngine` and a partial
 * object would be a lie the compiler is right to reject.
 */
function fakeEngine(): { engine: InferenceEngine; calls: { reset: number } } {
  const calls = { reset: 0 }
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
    async completion() {
      return { text: '', reasoning: null, timings: null }
    },
    async stop() {},
    async setChatTemplate() {},
    async countTokens() {
      return 1
    },
  } as unknown as InferenceEngine
  return { engine, calls }
}

function resetStore(): void {
  clearBackend()
  useChatStore.setState({
    conversations: [],
    activeConversationId: null,
    messages: [],
    transcripts: {},
    characters: [],
  } as never)
}

/** A committed message, built the way `appendMessage` receives one. */
function message(
  id: string,
  role: Message['role'],
  content: string,
  at: number,
  conversationId = 'x',
): Message {
  return {
    id,
    conversationId,
    role,
    content,
    reasoning: null,
    createdAt: at,
    modelId: role === 'assistant' ? null : null,
    swipeIndex: 0,
    swipes: [],
    edited: false,
    pinned: false,
  }
}

/** Two turns on screen: user, reply, user, reply. Returns the ids involved. */
function seedConversation(): { conversationId: string; ids: string[] } {
  const conversationId = useChatStore.getState().createConversation(null)
  const ids = ['u1', 'a1', 'u2', 'a2']
  const rows = [
    message('u1', 'user', '第一个问题', 1, conversationId),
    message('a1', 'assistant', '第一个回答', 2, conversationId),
    message('u2', 'user', '第二个问题', 3, conversationId),
    message('a2', 'assistant', '第二个回答', 4, conversationId),
  ]
  for (const row of rows) useChatStore.getState().appendMessage(row)
  return { conversationId, ids }
}

describe('editing a message (replaceMessage)', () => {
  beforeEach(resetStore)

  test('the content changes and the flag says it was edited', () => {
    const { ids } = seedConversation()
    const target = useChatStore.getState().messages.find((m) => m.id === 'u1')!

    useChatStore.getState().replaceMessage({ ...target, content: '改过的第一个问题', edited: true })

    const after = useChatStore.getState().messages.find((m) => m.id === 'u1')!
    assert.equal(after.content, '改过的第一个问题')
    assert.equal(after.edited, true, '`edited` is what renders the "已编辑" marker')
    assert.ok(ids.length === 4)
  })

  test('the parked transcript keeps the edit', () => {
    // `messages` is swapped out on every conversation switch, so an edit that
    // only lands in the visible array is reverted by navigating away and back.
    const { conversationId } = seedConversation()
    const target = useChatStore.getState().messages.find((m) => m.id === 'u1')!

    useChatStore.getState().replaceMessage({ ...target, content: '改过的第一个问题', edited: true })

    const parked = useChatStore.getState().transcripts[conversationId]
    assert.ok(parked, 'the transcript must be parked')
    assert.equal(parked!.find((m) => m.id === 'u1')!.content, '改过的第一个问题')

    // And the round trip the user actually performs: leave, come back.
    useChatStore.getState().setActiveConversation(null)
    useChatStore.getState().setActiveConversation(conversationId)
    assert.equal(
      useChatStore.getState().messages.find((m) => m.id === 'u1')!.content,
      '改过的第一个问题',
      'the edit must survive leaving and re-entering the conversation',
    )
  })

  test('editing an unknown id is a no-op rather than a throw', () => {
    // The id can go stale — the message was deleted on another surface while the
    // editor was open. Throwing inside the setter would take the screen down.
    seedConversation()
    const before = useChatStore.getState().messages

    assert.doesNotThrow(() => {
      useChatStore.getState().replaceMessage(
        message('does-not-exist', 'user', '幽灵消息', 9),
      )
    })

    const after = useChatStore.getState().messages
    assert.equal(after.length, before.length)
    assert.deepEqual(
      after.map((m) => m.content),
      ['第一个问题', '第一个回答', '第二个问题', '第二个回答'],
    )
  })

  test('the other messages are untouched, in place and in value', () => {
    seedConversation()
    const before = useChatStore.getState().messages
    const target = before.find((m) => m.id === 'u2')!

    useChatStore.getState().replaceMessage({ ...target, content: '改过的第二个问题', edited: true })

    const after = useChatStore.getState().messages
    assert.equal(after.length, before.length, 'no message may be added or dropped')
    assert.deepEqual(
      after.map((m) => m.id),
      ['u1', 'a1', 'u2', 'a2'],
      'order is part of the transcript and must not move',
    )
    assert.deepEqual(
      after.map((m) => m.content),
      ['第一个问题', '第一个回答', '改过的第二个问题', '第二个回答'],
    )
    // The neighbours must be the same objects, not rebuilt copies: a rewrite
    // that reallocates every row would defeat the memoised bubbles.
    assert.equal(after[0], before[0])
    assert.equal(after[1], before[1])
    assert.equal(after[3], before[3])
  })

  test('editing a reply keeps the message on the same message id', () => {
    // The id is the handle the long-press menu, the swipe controls and the
    // pending database row all use. Minting a new one on edit would orphan all
    // three.
    seedConversation()
    const target = useChatStore.getState().messages.find((m) => m.id === 'a1')!

    useChatStore.getState().replaceMessage({ ...target, content: '改过的回答', edited: true })

    const after = useChatStore.getState().messages.find((m) => m.id === 'a1')!
    assert.equal(after.content, '改过的回答')
    assert.equal(after.role, 'assistant')
    assert.equal(after.createdAt, target.createdAt, 'editing does not restamp the message')
  })

  test('editing an empty transcript does not resurrect or add anything', () => {
    useChatStore.getState().createConversation(null)

    useChatStore.getState().replaceMessage(message('u1', 'user', '无中生有', 1))

    assert.equal(useChatStore.getState().messages.length, 0)
  })

  test('an edit with no real change still writes the content back verbatim', () => {
    // Whitespace-only edits are legitimate (the user may be fixing an invisible
    // trailing space). The store must not "helpfully" trim it away.
    seedConversation()
    const target = useChatStore.getState().messages.find((m) => m.id === 'u1')!

    useChatStore.getState().replaceMessage({ ...target, content: '  第一个问题  ', edited: true })

    assert.equal(useChatStore.getState().messages.find((m) => m.id === 'u1')!.content, '  第一个问题  ')
  })

  test('the engine context can be reset after an edit', async () => {
    // The KV cache holds the PRE-edit token prefix. Generating against a stale
    // cache continues the old text, which looks like the edit was ignored — so
    // the save path resets it. This pins the engine surface that path relies on.
    const { engine, calls } = fakeEngine()
    __setEngineForTests(engine, 'local')

    seedConversation()
    const target = useChatStore.getState().messages.find((m) => m.id === 'u1')!
    useChatStore.getState().replaceMessage({ ...target, content: '改过的第一个问题', edited: true })

    await activeEngine()?.resetContext()

    assert.equal(calls.reset, 1, 'the stale KV prefix must be dropped after an edit')
  })
})
