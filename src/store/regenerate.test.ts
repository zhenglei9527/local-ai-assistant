/**
 * Regenerating an assistant reply.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * "重新生成" is the recovery path for a local model's bad output: a refusal, a
 * repetition loop, a character that broke. The logic has three parts that are
 * easy to get wrong and invisible when they are:
 *
 *   1. It must drop the target reply AND everything after it. Keeping later
 *      turns would leave the model reading an answer to a question that is about
 *      to be replaced.
 *   2. It must reset the engine context. A stale KV cache still holds the
 *      discarded reply's tokens, and generating against it produces a reply that
 *      CONTINUES the old one — which looks like the button did nothing.
 *   3. It must not corrupt the conversation's message counters. They are
 *      incremented per append, so a removal has to decrement them or the list
 *      shows a count that does not match what opens.
 *
 * Run with:
 *   node --import ./scripts/register-alias.mjs --test src/store/regenerate.test.ts
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import type { Message } from '@/types/domain.ts'

import { useChatStore } from '@/store/index.ts'
import { __setEngineForTests, clearBackend } from '@/inference/engineFactory.ts'
import type { InferenceEngine } from '@/inference/InferenceEngine.ts'

/** An engine that records what it was asked to do and returns a fixed reply. */
function fakeEngine(options: { reply?: string } = {}): {
  engine: InferenceEngine
  calls: { reset: number; completion: number }
} {
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
      const text = options.reply ?? '新回复'
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

/** Append a reply the way `generate()` would. */
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

describe('regenerateFrom', () => {
  beforeEach(resetStore)

  test('it drops the target reply and regenerates', async () => {
    const { engine, calls } = fakeEngine({ reply: '更好的回复' })
    __setEngineForTests(engine, 'local')

    const id = useChatStore.getState().createConversation(null)
    useChatStore.getState().appendUser('问题')
    useChatStore.getState().appendMessage(assistantReply('a1', '糟糕的回复', Date.now()))

    await useChatStore.getState().regenerateFrom('a1')

    const messages = useChatStore.getState().messages
    assert.deepEqual(
      messages.map((m) => m.content),
      ['问题', '更好的回复'],
    )
    assert.equal(messages[0]!.role, 'user')
    assert.equal(calls.reset, 1, 'the KV cache must be reset or the reply continues the old one')
    assert.ok(id)
  })

  test('it also drops everything after the target', async () => {
    // Those later turns answered a conversation whose reply is being replaced;
    // keeping them leaves the model reading an answer to a question that no
    // longer exists.
    const { engine } = fakeEngine()
    __setEngineForTests(engine, 'local')

    useChatStore.getState().createConversation(null)
    useChatStore.getState().appendUser('第一问')
    useChatStore.getState().appendMessage(assistantReply('a1', '第一答', 1))
    useChatStore.getState().appendUser('第二问')
    useChatStore.getState().appendMessage(assistantReply('a2', '第二答', 2))

    await useChatStore.getState().regenerateFrom('a1')

    assert.deepEqual(
      useChatStore.getState().messages.map((m) => m.content),
      ['第一问', '新回复'],
    )
  })

  test('it refuses when there is no preceding user turn', async () => {
    const { engine, calls } = fakeEngine()
    __setEngineForTests(engine, 'local')

    useChatStore.getState().createConversation(null)
    useChatStore.getState().appendMessage(assistantReply('a1', '凭空出现的回复', 1))

    await useChatStore.getState().regenerateFrom('a1')

    // Generating here would ask the model to answer nothing.
    assert.equal(calls.completion, 0)
    assert.match(useChatStore.getState().error ?? '', /用户消息/)
  })

  test('the conversation message count stays consistent', async () => {
    // Counters are incremented per append, so a removal that does not decrement
    // leaves the list showing a number that disagrees with what opens.
    const { engine } = fakeEngine()
    __setEngineForTests(engine, 'local')

    const id = useChatStore.getState().createConversation(null)
    useChatStore.getState().appendUser('问题')
    useChatStore.getState().appendMessage(assistantReply('a1', '回复一', 1))
    useChatStore.getState().appendUser('追问')
    useChatStore.getState().appendMessage(assistantReply('a2', '回复二', 2))

    const before = useChatStore.getState().conversations.find((c) => c.id === id)!.messageCount
    assert.equal(before, 4)

    await useChatStore.getState().regenerateFrom('a1')

    const after = useChatStore.getState().conversations.find((c) => c.id === id)!
    // Two removed (a1, a2), one added (the new reply) → 4 - 2 + 1 = 3.
    assert.equal(
      after.messageCount,
      useChatStore.getState().messages.length,
      'the counter must match the actual transcript',
    )
  })

  test('an unknown message id is a no-op', async () => {
    const { engine, calls } = fakeEngine()
    __setEngineForTests(engine, 'local')

    useChatStore.getState().createConversation(null)
    useChatStore.getState().appendUser('问题')

    await useChatStore.getState().regenerateFrom('does-not-exist')

    assert.equal(calls.completion, 0)
    assert.equal(useChatStore.getState().messages.length, 1)
  })

  test('the parked transcript is updated too', async () => {
    // `messages` is swapped out on every conversation switch, so a change that
    // only lands there is lost the moment the user navigates away.
    const { engine } = fakeEngine()
    __setEngineForTests(engine, 'local')

    const id = useChatStore.getState().createConversation(null)
    useChatStore.getState().appendUser('问题')
    useChatStore.getState().appendMessage(assistantReply('a1', '旧回复', 1))

    await useChatStore.getState().regenerateFrom('a1')

    const parked = useChatStore.getState().transcripts[id]
    assert.ok(parked, 'the transcript must be parked')
    assert.deepEqual(
      parked!.map((m) => m.content),
      ['问题', '新回复'],
    )
  })
})
