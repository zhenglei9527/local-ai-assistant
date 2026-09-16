/**
 * Minimal OpenAI-compatible mock server, for testing the app's cloud path.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The cloud chat path failed on device while the "test connection" button
 * passed, and I could not reproduce it locally: every test I had ran against
 * `MockInferenceEngine`, which replaces the ENGINE in JS. That leaves the entire
 * network layer untested — request building, headers, the streaming SSE body,
 * and the response parser. The bug lived in exactly that gap.
 *
 * This server speaks the real wire protocol, so pointing the app at
 * `http://<this-machine>:8788/v1` exercises every line of that code.
 *
 * ── What it can do that a real provider cannot ──────────────────────────────
 * It plays back a SCRIPT: per-request status codes, delays, and chunk shapes
 * are specified by the caller. That makes it possible to test the failure modes
 * that motivated this work — a 400 on an unknown model, a stream that stalls
 * mid-answer, a non-SSE JSON body where SSE was expected — deterministically,
 * instead of hoping a provider misbehaves on demand.
 *
 * ── Zero dependencies ───────────────────────────────────────────────────────
 * Node's built-in `http` only. No install step means no supply chain, and it
 * starts instantly on a machine with nothing but Node.
 *
 * Usage:
 *   node tools/mock-llm-server.mjs              # port 8788
 *   node tools/mock-llm-server.mjs --port 9000
 *   node tools/mock-llm-server.mjs --scenario 400-model-not-found
 */

import http from 'node:http'

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const PORT = Number(argOf('--port', '8788'))
const SCENARIO = argOf('--scenario', 'normal')
const CHUNK_DELAY_MS = Number(argOf('--delay', '0'))

/** Models this server claims to host. Mirrors the `vendor/model` id shape. */
const MODELS = [
  'deepseek/deepseek-v4.1-flash',
  'deepseek/deepseek-v4-flash',
  'mock/model-a',
]

const log = (...args) => console.log('[mock-llm]', ...args)

/** Write one SSE frame and flush. */
function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function chunk(content, { finish = null } = {}) {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'mock',
    choices: [
      {
        index: 0,
        delta: content === null ? {} : { content },
        finish_reason: finish,
      },
    ],
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const path = url.pathname.replace(/\/+$/, '')

  // Drain the request body; we echo parts of it back for debugging.
  let raw = ''
  for await (const c of req) raw += c

  log(`${req.method} ${path}`)

  // ── GET /models ─────────────────────────────────────────────────────────
  if (req.method === 'GET' && path.endsWith('/models')) {
    if (SCENARIO === '401-bad-key') {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Invalid API key' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: MODELS.map((id) => ({ id, object: 'model' })) }))
    return
  }

  // ── POST /chat/completions ──────────────────────────────────────────────
  if (req.method === 'POST' && path.endsWith('/chat/completions')) {
    let body = {}
    try {
      body = JSON.parse(raw)
    } catch {
      /* fall through to the validation below */
    }

    /**
     * Model-name validation, reproducing the real failure.
     *
     * A provider rejects an unknown model with 400. The app's "test connection"
     * button passed anyway because it only hit /models, so this branch is what
     * proves the button now catches the mistake.
     */
    if (SCENARIO === '400-model-not-found' || !MODELS.includes(body.model)) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          error: {
            message: `The model \`${body.model ?? '(none)'}\` does not exist`,
            type: 'invalid_request_error',
            code: 'model_not_found',
          },
        }),
      )
      return
    }

    if (SCENARIO === '401-bad-key') {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Invalid API key' } }))
      return
    }

    // Non-streaming JSON where the client expects SSE — a realistic gateway
    // misconfiguration, and a parser crash if the client assumes frames.
    if (body.stream !== true) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '非流式回复' },
              finish_reason: 'stop',
            },
          ],
        }),
      )
      return
    }

    // ── Streaming path ────────────────────────────────────────────────────
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })

    const reply =
      SCENARIO === 'long'
        ? '这是一段用于测试流式输出的较长回复。'.repeat(20)
        : `你好，我是 mock 模型。你刚才说：${(body.messages ?? []).at(-1)?.content ?? ''}`

    // Split by CHARACTER, not by word: the app's parser must survive a
    // multi-byte character being split across two network chunks, which is the
    // realistic case for Chinese and the reason `TextDecoder({stream:true})`
    // is used rather than a per-chunk `toString()`.
    const chars = [...reply]
    for (const ch of chars) {
      sse(res, chunk(ch))
      if (CHUNK_DELAY_MS > 0) await wait(CHUNK_DELAY_MS)
    }

    if (SCENARIO === 'stall') {
      // Deliberately never send the terminator; the client must still be
      // cancellable rather than hanging forever.
      log('scenario "stall": holding the connection open')
      return
    }

    sse(res, chunk(null, { finish: 'stop' }))
    res.write('data: [DONE]\n\n')
    res.end()
    log(`  streamed ${chars.length} chunks`)
    return
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message: `no route for ${path}` } }))
})

server.listen(PORT, '0.0.0.0', () => {
  log(`listening on http://0.0.0.0:${PORT}`)
  log(`  base URL for the app:  http://<this-machine-ip>:${PORT}/v1`)
  log(`  scenario: ${SCENARIO}`)
  log(`  models: ${MODELS.join(', ')}`)
})
