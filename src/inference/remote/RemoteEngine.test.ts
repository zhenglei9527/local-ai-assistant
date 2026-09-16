import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildHeaders,
  buildAnthropicBody,
  buildOpenAiBody,
  describeError,
  estimateTokens,
  RemoteEngine,
} from './RemoteEngine.ts'
import {
  buildRequestUrl,
  PROVIDER_PRESETS,
  REMOTE_PRIVACY_NOTICE,
  validateProviderConfig,
  type RemoteProviderConfig,
} from './providerConfig.ts'
import {
  makeUtf8Decoder,
  parseSseBuffer,
  readAnthropicDelta,
  readOpenAiDelta,
  type StreamTransport,
} from './sse.ts'
import type { ChatMessage, CompletionRequest } from '../InferenceEngine.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const openAiConfig: RemoteProviderConfig = {
  id: 'deepseek',
  label: 'DeepSeek',
  protocol: 'openai',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  apiKey: 'sk-test',
}

const anthropicConfig: RemoteProviderConfig = {
  id: 'anthropic',
  label: 'Anthropic',
  protocol: 'anthropic',
  baseUrl: 'https://api.anthropic.com/v1',
  model: 'claude-3-5-haiku-latest',
  apiKey: 'sk-ant-test',
}

const request: CompletionRequest = {
  sampling: {
    temperature: 0.8,
    topK: 40,
    topP: 0.95,
    minP: 0.05,
    typicalP: 1.0,
    repeatPenalty: 1.1,
    repeatLastN: 256,
    presencePenalty: 0,
    frequencyPenalty: 0,
    maxTokens: 256,
    seed: -1,
    stop: [],
  },
  enableThinking: false,
  thinkingBudgetTokens: null,
  jsonSchema: null,
}

/** Scripted transport: yields pre-set chunks, records what it was called with. */
function scripted(chunks: string[], status = 200): StreamTransport & { calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> } {
  const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = []
  return {
    calls,
    async *stream(url, headers, body) {
      calls.push({ url, headers, body })
      if (status >= 400) throw new Error(`HTTP ${status}: {"error":{"message":"boom"}}`)
      for (const chunk of chunks) yield chunk
    },
  }
}

const userMessages: ChatMessage[] = [{ role: 'user', content: '你好' }]

// ---------------------------------------------------------------------------
// URL building
// ---------------------------------------------------------------------------

test('buildRequestUrl appends the protocol-specific path', () => {
  assert.equal(buildRequestUrl(openAiConfig), 'https://api.deepseek.com/v1/chat/completions')
  assert.equal(buildRequestUrl(anthropicConfig), 'https://api.anthropic.com/v1/messages')
})

test('buildRequestUrl normalises a trailing slash (a paste-habit 404 source)', () => {
  assert.equal(
    buildRequestUrl({ baseUrl: 'https://api.deepseek.com/v1/', protocol: 'openai' }),
    'https://api.deepseek.com/v1/chat/completions',
  )
  assert.equal(
    buildRequestUrl({ baseUrl: 'https://host/v1///', protocol: 'openai' }),
    'https://host/v1/chat/completions',
  )
})

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('validateProviderConfig accepts a well-formed config', () => {
  assert.deepEqual(validateProviderConfig(openAiConfig), [])
})

test('validateProviderConfig rejects a missing scheme', () => {
  const problems = validateProviderConfig({ ...openAiConfig, baseUrl: 'api.deepseek.com' })
  assert.ok(problems.some((p) => p.includes('http://')))
})

test('validateProviderConfig ACCEPTS plaintext http for LAN endpoints', () => {
  // Ollama / LM Studio on a LAN address is a first-class use case; refusing
  // http would break it for a security benefit that does not apply on a LAN.
  const problems = validateProviderConfig({
    ...openAiConfig,
    baseUrl: 'http://192.168.1.100:11434/v1',
  })
  assert.deepEqual(problems, [])
})

test('validateProviderConfig flags an empty model name', () => {
  const problems = validateProviderConfig({ ...openAiConfig, model: '  ' })
  assert.ok(problems.some((p) => p.includes('模型名称')))
})

test('validateProviderConfig warns on an empty key without blocking', () => {
  // Not an error: many self-hosted endpoints need no credential at all.
  const problems = validateProviderConfig({ ...openAiConfig, apiKey: '' })
  assert.equal(problems.length, 1)
  assert.ok(problems[0].includes('API Key'))
})

test('every preset has a usable shape and none ships a key', () => {
  for (const preset of PROVIDER_PRESETS) {
    assert.ok(preset.id.length > 0, 'preset id')
    assert.ok(preset.label.length > 0, 'preset label')
    assert.ok(preset.hint.length > 0, 'preset hint')
    assert.ok(preset.baseUrl.length > 0 || preset.id === 'custom', `preset ${preset.id} url`)
    // A baked-in key would leak on first decompile.
    assert.ok(!('apiKey' in preset), `preset ${preset.id} must not carry a key`)
  }
})

test('the privacy notice exists and names the third party risk', () => {
  assert.ok(REMOTE_PRIVACY_NOTICE.length > 0)
  assert.ok(REMOTE_PRIVACY_NOTICE.includes('第三方'))
})

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

test('openai uses a bearer token; anthropic uses x-api-key + version', () => {
  const oa = buildHeaders(openAiConfig)
  assert.equal(oa.authorization, 'Bearer sk-test')
  assert.equal(oa['x-api-key'], undefined)

  const an = buildHeaders(anthropicConfig)
  assert.equal(an['x-api-key'], 'sk-ant-test')
  assert.equal(an.authorization, undefined)
  assert.equal(an['anthropic-version'], '2023-06-01')
})

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

test('openai body keeps roles verbatim and streams', () => {
  const body = buildOpenAiBody(openAiConfig, userMessages, request) as Record<string, unknown>
  assert.equal(body.model, 'deepseek-chat')
  assert.equal(body.stream, true)
  assert.deepEqual(body.messages, [{ role: 'user', content: '你好' }])
  assert.equal(body.max_tokens, 256)
})

test('openai body omits max_tokens when unset rather than sending an invalid value', () => {
  const noCap: CompletionRequest = { ...request, sampling: { ...request.sampling, maxTokens: 0 } }
  const body = buildOpenAiBody(openAiConfig, userMessages, noCap) as Record<string, unknown>
  assert.ok(!('max_tokens' in body))
})

test('openai body does not forward llama.cpp-only sampler knobs', () => {
  const body = buildOpenAiBody(openAiConfig, userMessages, request) as Record<string, unknown>
  // These have no OpenAI equivalent; forwarding them would make the settings
  // screen lie about having an effect.
  for (const key of ['top_k', 'min_p', 'typical_p', 'repeat_penalty']) {
    assert.ok(!(key in body), `must not send ${key}`)
  }
})

test('anthropic hoists the system prompt to a top-level field', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: '你是猫娘。' },
    { role: 'user', content: '你好' },
  ]
  const body = buildAnthropicBody(anthropicConfig, messages, request) as Record<string, unknown>
  assert.equal(body.system, '你是猫娘。')
  // And it must NOT still be in messages — that is a hard 400.
  const turns = body.messages as Array<{ role: string }>
  assert.ok(!turns.some((t) => t.role === 'system'))
})

test('anthropic always sends max_tokens (the API requires it)', () => {
  const noCap: CompletionRequest = { ...request, sampling: { ...request.sampling, maxTokens: 0 } }
  const body = buildAnthropicBody(anthropicConfig, userMessages, noCap) as Record<string, unknown>
  assert.equal(body.max_tokens, 1024)
})

test('anthropic merges consecutive same-role turns', () => {
  // The API rejects them, and a card can easily produce two user turns.
  const messages: ChatMessage[] = [
    { role: 'user', content: 'A' },
    { role: 'user', content: 'B' },
    { role: 'assistant', content: 'C' },
  ]
  const body = buildAnthropicBody(anthropicConfig, messages, request) as Record<string, unknown>
  const turns = body.messages as Array<{ role: string; content: string }>
  assert.equal(turns.length, 2)
  assert.equal(turns[0].content, 'A\n\nB')
  assert.equal(turns[1].role, 'assistant')
})

test('anthropic seeds a user turn when the first turn is an assistant greeting', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: '人设' },
    { role: 'assistant', content: '你好呀' },
  ]
  const body = buildAnthropicBody(anthropicConfig, messages, request) as Record<string, unknown>
  const turns = body.messages as Array<{ role: string }>
  assert.equal(turns[0].role, 'user')
})

test('anthropic uses stop_sequences, not stop', () => {
  const withStop: CompletionRequest = {
    ...request,
    sampling: { ...request.sampling, stop: ['</s>'] },
  }
  const body = buildAnthropicBody(anthropicConfig, userMessages, withStop) as Record<string, unknown>
  assert.deepEqual(body.stop_sequences, ['</s>'])
  assert.ok(!('stop' in body))
})

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

test('parseSseBuffer returns complete events and keeps the remainder', () => {
  const { events, rest } = parseSseBuffer('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c"')
  assert.equal(events.length, 2)
  assert.equal(events[0].data, '{"a":1}')
  assert.equal(events[1].data, '{"b":2}')
  assert.equal(rest, 'data: {"c"')
})

test('parseSseBuffer ignores SSE comment lines (OpenAI keep-alive)', () => {
  // A naive parser JSON.parses these and throws, killing the stream.
  const { events } = parseSseBuffer(': keep-alive\n\ndata: {"x":1}\n\n')
  assert.equal(events.length, 1)
  assert.equal(events[0].data, '{"x":1}')
})

test('parseSseBuffer tolerates CRLF framing', () => {
  const { events } = parseSseBuffer('data: {"a":1}\r\n\r\n')
  assert.equal(events.length, 1)
  assert.equal(events[0].data, '{"a":1}')
})

test('parseSseBuffer strips exactly one leading space after the colon', () => {
  const { events } = parseSseBuffer('data:  two-spaces\n\n')
  assert.equal(events[0].data, ' two-spaces')
})

test('parseSseBuffer joins multiple data lines per the spec', () => {
  const { events } = parseSseBuffer('data: line1\ndata: line2\n\n')
  assert.equal(events[0].data, 'line1\nline2')
})

test('parseSseBuffer carries an incomplete event across a chunk boundary', () => {
  // The realistic failure: TCP splits mid-line.
  const first = parseSseBuffer('data: {"a":')
  assert.equal(first.events.length, 0)
  const second = parseSseBuffer(first.rest + '1}\n\n')
  assert.equal(second.events.length, 1)
  assert.equal(second.events[0].data, '{"a":1}')
})

test('the UTF-8 decoder preserves a character split across chunks', () => {
  // Chinese is 3 bytes/char, so splits are routine, not exotic. Decoding each
  // chunk independently would yield U+FFFD here.
  const decode = makeUtf8Decoder()
  const bytes = new TextEncoder().encode('你好')
  const out = decode(bytes.slice(0, 2)) + decode(bytes.slice(2))
  assert.equal(out, '你好')
})

// ---------------------------------------------------------------------------
// Delta extraction
// ---------------------------------------------------------------------------

test('readOpenAiDelta extracts content', () => {
  const delta = readOpenAiDelta({ event: null, data: '{"choices":[{"delta":{"content":"你"}}]}' })
  assert.equal(delta.text, '你')
  assert.equal(delta.done, false)
})

test('readOpenAiDelta reports done on finish_reason', () => {
  const delta = readOpenAiDelta({ event: null, data: '{"choices":[{"delta":{},"finish_reason":"stop"}]}' })
  assert.equal(delta.done, true)
})

test('readOpenAiDelta treats [DONE] as terminal', () => {
  assert.equal(readOpenAiDelta({ event: null, data: '[DONE]' }).done, true)
})

test('readOpenAiDelta reads DeepSeek reasoning_content', () => {
  const delta = readOpenAiDelta({
    event: null,
    data: '{"choices":[{"delta":{"reasoning_content":"思考中"}}]}',
  })
  assert.equal(delta.reasoning, '思考中')
  assert.equal(delta.text, '')
})

test('readOpenAiDelta survives a malformed frame instead of aborting the turn', () => {
  // Gateways do emit stray non-JSON. Throwing here would discard real output
  // that was already rendered.
  const delta = readOpenAiDelta({ event: null, data: '<html>502</html>' })
  assert.deepEqual(delta, { text: '', reasoning: '', done: false })
})

test('readAnthropicDelta extracts text_delta and thinking_delta', () => {
  const text = readAnthropicDelta({
    event: null,
    data: '{"type":"content_block_delta","delta":{"type":"text_delta","text":"喵"}}',
  })
  assert.equal(text.text, '喵')

  const think = readAnthropicDelta({
    event: null,
    data: '{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"嗯"}}',
  })
  assert.equal(think.reasoning, '嗯')
})

test('readAnthropicDelta reports done on message_stop and ignores lifecycle frames', () => {
  assert.equal(readAnthropicDelta({ event: null, data: '{"type":"message_stop"}' }).done, true)
  assert.deepEqual(
    readAnthropicDelta({ event: null, data: '{"type":"message_start"}' }),
    { text: '', reasoning: '', done: false },
  )
})

test('readAnthropicDelta surfaces an in-stream error frame', () => {
  assert.throws(
    () => readAnthropicDelta({ event: null, data: '{"type":"error","error":{"message":"overloaded"}}' }),
    /overloaded/,
  )
})

// ---------------------------------------------------------------------------
// RemoteEngine end-to-end (against a scripted transport)
// ---------------------------------------------------------------------------

test('RemoteEngine streams a full OpenAI turn and accumulates text', async () => {
  const transport = scripted([
    'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
    'data: [DONE]\n\n',
  ])
  const engine = new RemoteEngine(openAiConfig, transport)

  await engine.load({} as never)
  const chunks: string[] = []
  const outcome = await engine.completion(userMessages, request, (c) => {
    if (c.text.length > 0) chunks.push(c.text)
  })

  assert.equal(outcome.text, '你好')
  assert.deepEqual(chunks, ['你', '好'])
  assert.equal(engine.getStatus().state, 'ready')
  assert.equal(engine.isReady(), true)
})

test('RemoteEngine handles a chunk boundary splitting an SSE event', async () => {
  const transport = scripted([
    'data: {"choices":[{"delta":{"con',
    'tent":"分割"}}]}\n\n',
    'data: [DONE]\n\n',
  ])
  const engine = new RemoteEngine(openAiConfig, transport)
  await engine.load({} as never)
  const outcome = await engine.completion(userMessages, request, () => {})
  assert.equal(outcome.text, '分割')
})

test('RemoteEngine streams an Anthropic turn', async () => {
  const transport = scripted([
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"喵"}}\n\n',
    'data: {"type":"message_stop"}\n\n',
  ])
  const engine = new RemoteEngine(anthropicConfig, transport)
  await engine.load({} as never)
  const outcome = await engine.completion(userMessages, request, () => {})
  assert.equal(outcome.text, '喵')
  assert.equal(outcome.stopped, true)
})

test('RemoteEngine refuses completion before load', async () => {
  const engine = new RemoteEngine(openAiConfig, scripted([]))
  await assert.rejects(() => engine.completion(userMessages, request, () => {}), /not configured/)
})

test('RemoteEngine reports a bad key as actionable Chinese copy', async () => {
  const engine = new RemoteEngine(openAiConfig, scripted([], 401))
  await assert.rejects(() => engine.load({} as never), /HTTP 401/)
  assert.match(engine.getStatus().error ?? '', /API Key 无效/)
})

test('RemoteEngine unload returns it to idle', async () => {
  const engine = new RemoteEngine(openAiConfig, scripted([]))
  await engine.load({} as never)
  await engine.unload()
  assert.equal(engine.isReady(), false)
  assert.equal(engine.getStatus().state, 'idle')
})

test('RemoteEngine ignores the local-only LoadRequest fields', async () => {
  // Documents the seam mismatch explicitly: a remote provider has no file path
  // and no KV cache, so these must be accepted-and-ignored, not required.
  const transport = scripted([])
  const engine = new RemoteEngine(openAiConfig, transport)
  await engine.load({} as never)
  const info = await engine.load({
    modelId: 'x',
    modelPath: 'file:///ignored.gguf',
    modelLayerCount: 32,
  } as never)
  assert.equal(info.modelId, 'deepseek-chat')
})

test('RemoteEngine probes /models for openai but POSTs for anthropic', async () => {
  const oa = scripted([])
  await new RemoteEngine(openAiConfig, oa).load({} as never)
  assert.match(oa.calls[0].url, /\/models$/)
  assert.equal((oa.calls[0].body as unknown), undefined)

  const an = scripted([])
  await new RemoteEngine(anthropicConfig, an).load({} as never)
  assert.match(an.calls[0].url, /\/messages$/)
  assert.notEqual(an.calls[0].body, undefined)
})

// ---------------------------------------------------------------------------
// Error copy + token estimate
// ---------------------------------------------------------------------------

test('describeError maps status codes to actionable Chinese', () => {
  assert.match(describeError(new Error('HTTP 401: bad key')), /API Key 无效/)
  assert.match(describeError(new Error('HTTP 429: rate limit')), /过于频繁|额度/)
  assert.match(describeError(new Error('HTTP 404: model not found')), /接口地址或模型名称/)
  assert.match(describeError(new Error('Network request failed')), /网络连接失败/)
})

test('estimateTokens is high-biased for CJK and lower for latin', () => {
  assert.equal(estimateTokens(''), 0)
  // One token per CJK character.
  assert.equal(estimateTokens('你好世界'), 4)
  // ~4 latin characters per token.
  assert.equal(estimateTokens('abcdefgh'), 2)
  assert.ok(estimateTokens('你好') > estimateTokens('ab'))
})
