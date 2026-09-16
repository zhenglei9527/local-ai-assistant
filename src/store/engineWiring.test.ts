/**
 * Store ↔ engine wiring tests.
 *
 * WHAT THIS PROVES
 * ----------------
 * Before this, `useEngineStore.generate()` was a stub that reported "Inference
 * is not wired up", and `src/store/index.ts` could not be imported under plain
 * Node at all (`@/` alias, and a native `llama.rn` import chain). So the
 * app-level contract — "send a message, get a streamed reply committed to the
 * transcript" — had never been executed, in any environment.
 *
 * These tests drive the real store against `MockInferenceEngine`, which is the
 * only engine that runs without a device. They are deliberately about the
 * WIRING (does the turn reach the engine, does the result land in `messages`,
 * do failures surface as actionable text) rather than about generation quality.
 *
 * Requires the alias loader:
 *   node --import ./scripts/register-alias.mjs --test src/store/engineWiring.test.ts
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { useEngineStore, useChatStore } from '@/store/index.ts'
import { MockInferenceEngine } from '@/inference/MockInferenceEngine.ts'
import { __setEngineForTests, clearBackend, activeEngine } from '@/inference/engineFactory.ts'
import type { LoadRequest } from '@/types/domain.ts'

const LOAD_REQUEST: LoadRequest = {
  modelId: 'test-model',
  modelPath: 'file:///nonexistent/test-model.gguf',
  contextConfig: {
    contextLength: 2048,
    batchSize: 512,
    threads: 4,
    gpuLayers: 0,
    devices: [],
    useMmap: true,
    useMlock: false,
    flashAttention: 'auto',
    cacheTypeK: 'f16',
    cacheTypeV: 'f16',
  },
  modelLayerCount: 28,
  maxParametersB: 4,
}

function seedConversation(): void {
  const chat = useChatStore.getState()
  chat.setConversations([
    {
      id: 'conv-1',
      title: 'Test',
      characterId: null,
      modelId: 'test-model',
      samplerOverride: null,
      contextOverride: null,
      worldInfo: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ])
  chat.setActiveConversation('conv-1')
  chat.setMessages([])
}

async function installMockEngine(): Promise<MockInferenceEngine> {
  const engine = new MockInferenceEngine()
  await engine.load(LOAD_REQUEST)
  __setEngineForTests(engine, 'local')
  useEngineStore.getState().setLoaded({
    modelId: 'test-model',
    contextLength: 2048,
    gpuActive: false,
    gpuFallbackReason: null,
    activeDevices: [],
    metadata: {},
    chatTemplate: null,
  })
  return engine
}

describe('engine store wiring', () => {
  beforeEach(async () => {
    await clearBackend()
    useEngineStore.getState().setUnloaded()
    seedConversation()
  })

  test('the factory starts empty — no engine is installed implicitly', () => {
    assert.equal(activeEngine(), null)
  })

  test('generate() with no engine installed reports an actionable message', async () => {
    await useEngineStore.getState().generate()

    const s = useEngineStore.getState()
    assert.equal(s.status, 'error')
    assert.ok(s.error, 'expected an error message')
    // Must name the screen the user has to visit. "Something went wrong" was
    // the failure mode this replaced.
    assert.match(s.error!, /模型/)
  })

  test('generate() with an empty transcript refuses rather than calling the engine', async () => {
    await installMockEngine()
    useChatStore.getState().setMessages([])

    await useEngineStore.getState().generate()

    const s = useEngineStore.getState()
    assert.equal(s.status, 'error')
    assert.match(s.error!, /没有可发送/)
  })

  test('a completed turn is committed to the transcript exactly once', async () => {
    await installMockEngine()
    const chat = useChatStore.getState()
    chat.appendMessage({
      id: 'u1',
      conversationId: 'conv-1',
      role: 'user',
      content: 'hello there',
      reasoning: null,
      createdAt: Date.now(),
      modelId: null,
      swipeIndex: 0,
      swipes: [],
    })

    await useEngineStore.getState().generate()

    const messages = useChatStore.getState().messages
    assert.equal(messages.length, 2, 'expected the user turn plus one assistant turn')
    assert.equal(messages[0].role, 'user')
    assert.equal(messages[1].role, 'assistant')
    assert.ok(messages[1].content.length > 0, 'assistant reply must not be empty')
    assert.equal(messages[1].modelId, 'test-model')
  })

  test('streaming text is cleared once the turn settles', async () => {
    await installMockEngine()
    useChatStore.getState().appendMessage({
      id: 'u1',
      conversationId: 'conv-1',
      role: 'user',
      content: 'hi',
      reasoning: null,
      createdAt: Date.now(),
      modelId: null,
      swipeIndex: 0,
      swipes: [],
    })

    await useEngineStore.getState().generate()

    const s = useEngineStore.getState()
    assert.equal(s.streamingText, '', 'streamingText must not survive the turn')
    assert.equal(s.status, 'ready')
    assert.notEqual(s.tokensPerSecond, 0, 'timings should have been recorded')
  })

  test('the transcript is what reaches the engine, in order', async () => {
    const engine = await installMockEngine()
    const chat = useChatStore.getState()
    for (const [i, content] of ['first', 'second', 'third'].entries()) {
      chat.appendMessage({
        id: `m${i}`,
        conversationId: 'conv-1',
        role: i % 2 === 0 ? 'user' : 'assistant',
        content,
        reasoning: null,
        createdAt: Date.now() + i,
        modelId: null,
        swipeIndex: 0,
        swipes: [],
      })
    }

    await useEngineStore.getState().generate()

    assert.deepEqual(
      engine.lastMessages?.map((m) => m.content),
      ['first', 'second', 'third'],
    )
  })

  test('blank-only messages are not forwarded to the engine', async () => {
    const engine = await installMockEngine()
    const chat = useChatStore.getState()
    chat.appendMessage({
      id: 'blank',
      conversationId: 'conv-1',
      role: 'assistant',
      content: '   ',
      reasoning: null,
      createdAt: Date.now(),
      modelId: null,
      swipeIndex: 0,
      swipes: [],
    })
    chat.appendMessage({
      id: 'real',
      conversationId: 'conv-1',
      role: 'user',
      content: 'actual question',
      reasoning: null,
      createdAt: Date.now() + 1,
      modelId: null,
      swipeIndex: 0,
      swipes: [],
    })

    await useEngineStore.getState().generate()

    assert.deepEqual(
      engine.lastMessages?.map((m) => m.content),
      ['actual question'],
    )
  })

  test('an engine that throws surfaces translated text, not a raw stack', async () => {
    const engine = await installMockEngine()
    engine.failNextCompletionWith = new Error('llama_decode: out of memory')

    useChatStore.getState().appendMessage({
      id: 'u1',
      conversationId: 'conv-1',
      role: 'user',
      content: 'hi',
      reasoning: null,
      createdAt: Date.now(),
      modelId: null,
      swipeIndex: 0,
      swipes: [],
    })

    await useEngineStore.getState().generate()

    const s = useEngineStore.getState()
    assert.equal(s.status, 'error')
    assert.match(s.error!, /内存不足/, 'OOM should be explained in plain language')
    assert.equal(s.streamingText, '', 'a failed turn must not leave partial text')
  })

  test('stop() is forwarded to the engine and clears the request flag', async () => {
    const engine = await installMockEngine()
    await useEngineStore.getState().stop()

    assert.equal(engine.stopCallCount, 1)
    assert.equal(useEngineStore.getState().stopRequested, false)
  })
})
