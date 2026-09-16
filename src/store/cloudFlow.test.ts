/**
 * Full-stack test: store → real HTTP → mock LLM server → transcript.
 *
 * ── Why this exists, and why the earlier tests were not enough ──────────────
 * Two layers were already covered and both passed:
 *   - `e2e.test.ts` drives `RemoteEngine` against a real server (network OK).
 *   - `engineWiring.test.ts` drives the store against `MockInferenceEngine`.
 *
 * Neither covers the JOIN: the store's `generate()` choosing a backend,
 * building the engine, and committing the reply. That join is where the
 * reported bug lived — "cloud test succeeds but chatting produces nothing" —
 * and it is exactly the seam that per-layer tests cannot see.
 *
 * This wires the real store to the real `RemoteEngine` talking to
 * `tools/mock-llm-server.mjs`, so a message sent through the store must come
 * back as a committed assistant message. Requires the mock server:
 *
 *   node tools/mock-llm-server.mjs --port 8788 &
 *   node --import ./scripts/register-alias.mjs --test src/store/cloudFlow.test.ts
 */

import { test, describe, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { useChatStore, useEngineStore, useSettingsStore } from '@/store/index.ts'
import { RemoteEngine } from '@/inference/remote/RemoteEngine.ts'
import { createFetchTransport } from '@/inference/remote/fetchTransport.ts'
import { clearBackend } from '@/inference/engineFactory.ts'

const BASE = process.env.MOCK_LLM_URL ?? 'http://127.0.0.1:8788/v1'

let serverUp = false
before(async () => {
  try {
    const res = await fetch(`${BASE}/models`, { signal: AbortSignal.timeout(2000) })
    serverUp = res.ok
  } catch {
    serverUp = false
  }
  if (!serverUp) console.log(`\n  ⚠️  mock server not reachable at ${BASE} — skipping\n`)
})

function installCloud(): void {
  useSettingsStore.setState({
    backend: 'remote',
    remoteProvider: {
      id: 'mock',
      label: 'Mock',
      protocol: 'openai',
      baseUrl: BASE,
      model: 'deepseek/deepseek-v4.1-flash',
      apiKey: 'sk-test',
    },
    // A cloud deployment has no local model id; leaving a stale one in place
    // would let the local path win and hide the bug under test.
    lastLoadedModelId: null,
  })
  // NOTE: no engine is injected here on purpose.
  //
  // `generate()` reconciles the backend itself, and this test exists to prove
  // that happens. Injecting an engine would bypass the very code path that was
  // broken (`installed === 'remote'` but never loaded), so the test would pass
  // while the app failed — which is exactly the trap this file was written to
  // escape.
  clearBackend()
}

function resetStores(): void {
  clearBackend()
  useChatStore.setState({
    conversations: [],
    activeConversationId: null,
    messages: [],
    transcripts: {},
    characters: [],
  } as never)
  useEngineStore.setState({ status: 'idle', modelId: null, error: null, streamingText: '' })
}

describe('cloud chat through the store', () => {
  beforeEach(resetStores)

  test('a reply reaches the transcript', async (t) => {
    if (!serverUp) return t.skip('mock server not running')

    installCloud()
    const id = useChatStore.getState().createConversation(null)
    useChatStore.getState().appendUser('你好')

    await useEngineStore.getState().generate()

    const state = useEngineStore.getState()
    assert.equal(state.status, 'ready', `generate left status=${state.status}: ${state.error ?? ''}`)
    assert.equal(state.error, null)

    const messages = useChatStore.getState().messages
    assert.equal(messages.length, 2, 'expected the user turn plus one assistant reply')
    assert.equal(messages[0]!.role, 'user')
    assert.equal(messages[1]!.role, 'assistant')
    assert.ok(messages[1]!.content.length > 0, 'the assistant reply must not be empty')
    assert.match(messages[1]!.content, /mock/)

    // And it must be parked, so leaving the conversation and returning keeps it.
    assert.equal(useChatStore.getState().transcripts[id]?.length, 2)
  }, { timeout: 30000 })

  test('streaming text is populated progressively during generation', async (t) => {
    if (!serverUp) return t.skip('mock server not running')

    installCloud()
    useChatStore.getState().createConversation(null)
    useChatStore.getState().appendUser('说点什么')

    /**
     * Subscribe rather than poll.
     *
     * A setInterval sampler missed the stream entirely: against a local server
     * the whole reply arrives in ~10 ms, which is fewer timer ticks than the
     * reply has chunks, so the sampler only saw the empty start and the cleared
     * end. Sampling frequency is an artefact of the test; the thing to assert is
     * that the store PUBLISHES a growing value, which a subscription observes
     * exactly.
     */
    const seen: string[] = []
    const unsub = useEngineStore.subscribe((s) => {
      if (s.streamingText.length > 0) seen.push(s.streamingText)
    })

    await useEngineStore.getState().generate()
    unsub()

    // More than one publish means the UI receives intermediate states and can
    // render progressively. A single publish would mean "all at once" — the
    // symptom the user reported.
    assert.ok(
      seen.length > 5,
      'expected many streaming updates, saw ' + seen.length + ' (reply would appear all at once)',
    )
    // Each publish must be a strict extension of the last, so the text only
    // ever grows on screen (a shrinking buffer would flicker).
    for (let i = 1; i < seen.length; i += 1) {
      assert.ok(
        seen[i]!.startsWith(seen[i - 1]!),
        'streaming text went backwards at ' + i,
      )
    }
    // After completion it must be cleared — the committed message is the source
    // of truth, and a leftover buffer would double-render the reply.
    assert.equal(useEngineStore.getState().streamingText, '')
  }, { timeout: 30000 })

  test('a bad model name surfaces a visible error, not silence', async (t) => {
    if (!serverUp) return t.skip('mock server not running')

    installCloud()
    // The mistake that actually shipped: a product name instead of a model id.
    useSettingsStore.setState((s) => ({
      remoteProvider: { ...s.remoteProvider, model: 'DeepSeek V4.1 Flash' },
    }))
    // No injection: generate() must build the engine from the (bad) config
    // itself and surface the resulting 400.
    clearBackend()

    useChatStore.getState().createConversation(null)
    useChatStore.getState().appendUser('你好')

    await useEngineStore.getState().generate()

    const state = useEngineStore.getState()
    // The user must be told something. Previously this produced no message at
    // all, which read as a frozen app.
    assert.equal(state.status, 'error')
    assert.ok(state.error && state.error.length > 0, 'a failure must carry a message')
    // And no bogus empty reply may be committed.
    assert.equal(useChatStore.getState().messages.length, 1)
  }, { timeout: 30000 })
})
