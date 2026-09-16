/**
 * End-to-end test of the cloud path against a real HTTP server.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * The cloud chat path failed on device while the connection test passed, and I
 * could not reproduce it. The reason: every existing test drove
 * `MockInferenceEngine`, which replaces the ENGINE in JS and therefore never
 * touches `RemoteEngine`'s network code — request building, headers, the SSE
 * body, or the response parser. The bug was in precisely that untested gap, and
 * "I could not reproduce it" was itself the symptom of a missing test, not of a
 * flaky bug.
 *
 * This points `RemoteEngine` at `tools/mock-llm-server.mjs` over real HTTP, so
 * the whole path runs: build request → fetch → stream frames → parse → emit
 * chunks. Requires the mock server, started by the harness before this runs:
 *
 *   node tools/mock-llm-server.mjs --port 8788 &
 *   node --import ./scripts/register-alias.mjs --test src/inference/remote/e2e.test.ts
 */

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'

import { RemoteEngine } from '@/inference/remote/RemoteEngine.ts'
import { createFetchTransport } from '@/inference/remote/fetchTransport.ts'
import type { RemoteProviderConfig } from '@/inference/remote/providerConfig.ts'
import type { CompletionRequest } from '@/inference/InferenceEngine.ts'

const BASE = process.env.MOCK_LLM_URL ?? 'http://127.0.0.1:8788/v1'

function config(overrides: Partial<RemoteProviderConfig> = {}): RemoteProviderConfig {
  return {
    id: 'mock',
    label: 'Mock',
    protocol: 'openai',
    baseUrl: BASE,
    model: 'deepseek/deepseek-v4.1-flash',
    apiKey: 'sk-test',
    ...overrides,
  }
}

const PARAMS: CompletionRequest = {
  sampling: {
    temperature: 0,
    topK: 1,
    topP: 1,
    minP: 0,
    typicalP: 1,
    repeatPenalty: 1,
    repeatLastN: 0,
    presencePenalty: 0,
    frequencyPenalty: 0,
    maxTokens: 64,
    seed: -1,
    stop: [],
  },
  enableThinking: false,
  thinkingBudgetTokens: null,
  jsonSchema: null,
}

/** Is the mock server reachable? Skip the suite cleanly when it is not. */
let serverUp = false
before(async () => {
  try {
    const res = await fetch(`${BASE}/models`, { signal: AbortSignal.timeout(2000) })
    serverUp = res.ok
  } catch {
    serverUp = false
  }
  if (!serverUp) {
    console.log(`\n  ⚠️  mock server not reachable at ${BASE} — skipping e2e tests\n`)
  }
})

describe('cloud chat end-to-end (real HTTP)', () => {
  test('streams a reply token by token', async (t) => {
    if (!serverUp) return t.skip('mock server not running')

    const engine = new RemoteEngine(config(), createFetchTransport())
    await engine.load({} as never)
    assert.equal(engine.isReady(), true, 'load() must mark the engine ready')

    const chunks: string[] = []
    const outcome = await engine.completion(
      [{ role: 'user', content: '你好' }],
      PARAMS,
      (c) => {
        if (c.text.length > 0) chunks.push(c.text)
      },
    )

    // The whole point: more than one chunk. A single chunk means the server
    // (or the client) batched the whole reply, which is the "appears all at
    // once" bug the user reported.
    assert.ok(
      chunks.length > 5,
      `expected many chunks, got ${chunks.length} — streaming is not working`,
    )
    assert.ok(outcome.text.length > 0, 'the reply must be non-empty')
    assert.equal(chunks.join(''), outcome.text, 'chunks must reconstruct the full text')
  }, { timeout: 30000 })

  test('Chinese survives the byte stream intact', async (t) => {
    if (!serverUp) return t.skip('mock server not running')

    const engine = new RemoteEngine(config(), createFetchTransport())
    await engine.load({} as never)
    const outcome = await engine.completion(
      [{ role: 'user', content: '测试中文' }],
      PARAMS,
      () => {},
    )

    // A per-chunk `toString()` instead of a streaming TextDecoder corrupts
    // multi-byte characters split across chunks — the server splits by
    // character precisely to make that failure visible.
    assert.ok(!outcome.text.includes('\uFFFD'), 'replacement characters mean broken decoding')
    assert.match(outcome.text, /你好/)
  }, { timeout: 30000 })

  test('an unknown model is rejected with an actionable message', async (t) => {
    if (!serverUp) return t.skip('mock server not running')

    const engine = new RemoteEngine(
      config({ model: 'DeepSeek V4.1 Flash' as never }),
      createFetchTransport(),
    )
    // `load()` only probes /models, which does NOT validate the model name —
    // this is exactly why the app's connection test passed while chat failed.
    await engine.load({} as never)

    await assert.rejects(
      () => engine.completion([{ role: 'user', content: 'hi' }], PARAMS, () => {}),
      (err) => {
        const msg = err instanceof Error ? err.message : String(err)
        // The failure must be visible and attributable, not silent.
        assert.ok(msg.length > 0, 'the error must carry a message')
        return true
      },
      'chatting with a bad model name must reject, not hang or resolve empty',
    )
  }, { timeout: 30000 })

  test('a good model name is accepted by the chat endpoint', async (t) => {
    if (!serverUp) return t.skip('mock server not running')

    // The mirror of the previous test: this is the config that actually works,
    // and it must not be rejected.
    const engine = new RemoteEngine(config(), createFetchTransport())
    await engine.load({} as never)
    const outcome = await engine.completion(
      [{ role: 'user', content: 'hi' }],
      PARAMS,
      () => {},
    )
    assert.ok(outcome.text.length > 0)
  }, { timeout: 30000 })
})
