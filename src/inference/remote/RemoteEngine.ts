import type { ChatMessage, CompletionOutcome, CompletionRequest, InferenceEngine } from '../InferenceEngine.ts'
import type { EngineStatusView, LoadedModelInfo, LoadRequest } from '../InferenceEngine.ts'
import {
  buildRequestUrl,
  type RemoteProviderConfig,
} from './providerConfig.ts'
import {
  makeUtf8Decoder,
  parseSseBuffer,
  readAnthropicDelta,
  readOpenAiDelta,
  type SseEvent,
  type StreamTransport,
} from './sse.ts'

/**
 * Cloud provider backend, implementing the same `InferenceEngine` seam as the
 * local llama.rn engine.
 *
 * WHY IT IMPLEMENTS THE LOCAL INTERFACE RATHER THAN A NEW ONE
 * -----------------------------------------------------------
 * The seam already exists and the comment on it says exactly this: everything
 * above (`store`, `ChatScreen`, the character engine) speaks `InferenceEngine`
 * types only, and a `MockInferenceEngine` proving a non-llama implementation
 * works is already in the tree. Adding a parallel "remote engine" state machine
 * would give the chat screen two render paths for identical semantics — the
 * streaming token contract is the same for an SSE delta as for a llama.cpp
 * token.
 *
 * The mismatch is real and is handled explicitly rather than papered over:
 * `LoadRequest.modelPath` and `ContextConfig.*` are local-inference concepts.
 * See {@link load} — the local-only fields are accepted and ignored, and this
 * is documented rather than hidden.
 *
 * WHAT THIS CLASS DELIBERATELY DOES NOT DO
 * ----------------------------------------
 *   - No retry/backoff. A silent retry of a partially-rendered turn duplicates
 *     text the user already read. Failures surface as errors.
 *   - No token counting by tokenizer. `countTokens` returns a documented
 *     estimate; the real budget is the server's, and the endpoint is optional.
 *   - No conversation storage. History arrives per-call in `messages`, exactly
 *     as the local engine expects, so both backends share one history model.
 */

export class RemoteEngine implements InferenceEngine {
  private readonly config: RemoteProviderConfig
  private readonly transport: StreamTransport
  private readonly now: () => number

  private status: EngineStatusView['state'] = 'idle'
  private lastError: string | null = null
  private abort: AbortController | null = null
  /** Set between `load` and `unload`; mirrors the local engine's readiness. */
  private loaded = false

  constructor(
    config: RemoteProviderConfig,
    transport: StreamTransport,
    now: () => number = () => Date.now(),
  ) {
    this.config = config
    this.transport = transport
    this.now = now
  }

  getStatus(): EngineStatusView {
    return {
      state: this.status,
      modelId: this.loaded ? this.config.model : null,
      loadProgress: this.loaded ? 100 : 0,
      error: this.lastError,
      // Reported honestly as false rather than omitted: there is no local
      // backend, and a UI that shows a "GPU active" badge must not light up.
      gpuActive: false,
      gpuFallbackReason: null,
      activeDevices: ['remote'],
    }
  }

  /**
   * "Loads" a remote provider.
   *
   * There is nothing to load — no weights, no context. This exists because the
   * seam requires it, and it performs the one check that is genuinely useful:
   * that the endpoint is reachable and the credentials are accepted, reported
   * through the same `onProgress` channel the local engine uses for download
   * progress. Failing here rather than at first send is the whole point: the
   * user gets "Key 无效" while looking at the settings form, not after typing a
   * message.
   *
   * `request.modelPath` and `request.contextConfig` are intentionally ignored.
   * They are local-inference concepts; a remote endpoint has no file and no KV
   * cache we control. Ignoring them silently would be a latent bug, so the
   * signatures are documented as unread above.
   */
  async load(_request: LoadRequest, onProgress?: (pct: number) => void): Promise<LoadedModelInfo> {
    this.status = 'loading'
    this.lastError = null
    onProgress?.(10)

    try {
      await this.verify()
      this.loaded = true
      this.status = 'ready'
      onProgress?.(100)

      return {
        modelId: this.config.model,
        // Echoed back because the UI renders it, but it is NOT a real context
        // window: the provider decides truncation and does not reliably report
        // it. Labelled as a nominal value in the settings copy.
        contextLength: 0,
        gpuActive: false,
        gpuFallbackReason: null,
        activeDevices: ['remote'],
        metadata: { provider: this.config.id, protocol: this.config.protocol },
        chatTemplate: null,
      }
    } catch (error) {
      this.loaded = false
      this.status = 'error'
      this.lastError = describeError(error)
      throw error
    }
  }

  async unload(): Promise<void> {
    this.abort?.abort()
    this.abort = null
    this.loaded = false
    this.status = 'idle'
    this.lastError = null
  }

  isReady(): boolean {
    return this.loaded
  }

  /**
   * Runs one streaming completion.
   *
   * The `onChunk` callback contract matches the local engine exactly, including
   * that `accumulated` is the full turn text; the store relies on that to
   * render without reassembling deltas itself.
   */
  async completion(
    messages: ChatMessage[],
    params: CompletionRequest,
    onChunk: (chunk: { text: string; accumulated: string; reasoning?: string; done: boolean }) => void,
  ): Promise<CompletionOutcome> {
    if (!this.loaded) {
      throw new Error('RemoteEngine: provider not configured. Call load() first.')
    }

    this.status = 'generating'
    const startedAt = this.now()

    const controller = new AbortController()
    this.abort = controller

    const url = buildRequestUrl(this.config)
    const headers = buildHeaders(this.config)
    const body =
      this.config.protocol === 'anthropic'
        ? buildAnthropicBody(this.config, messages, params)
        : buildOpenAiBody(this.config, messages, params)

    const decoder = makeUtf8Decoder()
    const readDelta = this.config.protocol === 'anthropic' ? readAnthropicDelta : readOpenAiDelta

    let buffer = ''
    let text = ''
    let reasoning = ''
    let stopped = false
    let firstTokenAt: number | null = null

    try {
      for await (const chunk of this.transport.stream(url, headers, body, controller.signal)) {
        buffer += chunk
        const { events, rest } = parseSseBuffer(buffer)
        buffer = rest

        for (const event of events) {
          const delta = readDelta(event)
          if (delta.text.length === 0 && delta.reasoning.length === 0 && !delta.done) continue

          if (firstTokenAt === null && (delta.text.length > 0 || delta.reasoning.length > 0)) {
            firstTokenAt = this.now()
          }

          text += delta.text
          reasoning += delta.reasoning

          if (delta.done) {
            stopped = true
            continue
          }

          onChunk({
            text: delta.text,
            accumulated: text,
            ...(reasoning.length > 0 ? { reasoning } : {}),
            done: false,
          })
        }

        if (stopped) break
      }

      onChunk({ text: '', accumulated: text, ...(reasoning.length > 0 ? { reasoning } : {}), done: true })
      this.status = 'ready'

      const finishedAt = this.now()
      return {
        text,
        reasoning: reasoning.length > 0 ? reasoning : null,
        // Both providers signal a clean stop with an explicit terminal event;
        // reaching this line without one means the cap or the stream end did.
        stopped,
        timings: {
          promptTokens: 0,
          generatedTokens: 0,
          promptMs: firstTokenAt !== null ? firstTokenAt - startedAt : 0,
          generationMs: finishedAt - startedAt,
          tokensPerSecond: 0,
          // Required by `GenerationTimings`. A cloud endpoint does not report
          // token counts, so these stay 0 — but they must be PRESENT: an
          // undefined here crashed the Settings screen on `.toFixed()`.
          promptTokensPerSecond: 0,
          cacheReusedTokens: 0,
        },
      }
    } catch (error) {
      // An abort is a user action, not a failure. Surfacing it as an error
      // would show a red banner every time someone taps Stop.
      if (isAbort(error)) {
        this.status = 'ready'
        onChunk({ text: '', accumulated: text, ...(reasoning.length > 0 ? { reasoning } : {}), done: true })
        return {
          text,
          reasoning: reasoning.length > 0 ? reasoning : null,
          stopped: true,
          timings: {
            promptTokens: 0,
            generatedTokens: 0,
            promptMs: 0,
            generationMs: this.now() - startedAt,
            tokensPerSecond: 0,
          },
        }
      }

      this.status = 'error'
      this.lastError = describeError(error)
      throw error
    } finally {
      this.abort = null
    }
  }

  async stop(): Promise<void> {
    this.abort?.abort()
  }

  /**
   * No-op for a remote provider.
   *
   * The local engine needs this to drop a KV cache that outlives a
   * conversation. Here, each request carries the full history and the server
   * keeps no session state, so there is nothing to reset — and pretending
   * otherwise by, say, clearing a local cache would be misleading.
   */
  async resetContext(): Promise<void> {}

  /**
   * No-op: the chat template lives in the provider's own API contract.
   *
   * Accepting the call and doing nothing is the correct behaviour, not a stub —
   * the character-card engine always builds a plain `messages` array, and both
   * remote protocols take that array directly.
   */
  async setChatTemplate(_template: string | null): Promise<void> {}

  /**
   * Estimated token count.
   *
   * Deliberately NOT a network call. This is used for UI affordances (a context
   * meter), and issuing a request per keystroke would be worse than an
   * approximation. The heuristic over-estimates, matching the local estimator's
   * bias, so a budget display never promises room the server will refuse.
   */
  async countTokens(text: string): Promise<number> {
    return estimateTokens(text)
  }

  /**
   * Cheap reachability + credential check.
   *
   * Uses the protocol's model-listing endpoint where one exists (OpenAI
   * `/models`, which most compatible gateways implement) and otherwise a
   * deliberately tiny completion. A 1-token generation costs a fraction of a
   * cent and is the only way to validate an Anthropic key, since its API has
   * no unauthenticated-cheap listing endpoint that all gateways expose.
   */
  private async verify(): Promise<void> {
    const probeUrl =
      this.config.protocol === 'anthropic'
        ? buildRequestUrl(this.config)
        : `${this.config.baseUrl.trim().replace(/\/+$/, '')}/models`

    const body =
      this.config.protocol === 'anthropic'
        ? {
            model: this.config.model,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }],
          }
        : {
            model: this.config.model,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }],
            stream: false,
          }

    const method = this.config.protocol === 'anthropic' ? 'POST' : 'GET'

    for await (const _chunk of this.transport.stream(
      probeUrl,
      buildHeaders(this.config),
      method === 'GET' ? undefined : body,
    )) {
      // Drain a single frame and stop. `stream()` on a non-streaming JSON
      // response yields the whole body once; we only need it to complete
      // without throwing.
      break
    }
  }
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

/**
 * Headers for each protocol.
 *
 * The two APIs authenticate differently and mixing them up produces a 401 that
 * looks like a bad key — worth keeping visibly separate.
 */
export function buildHeaders(config: RemoteProviderConfig): Record<string, string> {
  if (config.protocol === 'anthropic') {
    return {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-api-key': config.apiKey,
      'anthropic-version': config.anthropicVersion ?? '2023-06-01',
    }
  }
  return {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    authorization: `Bearer ${config.apiKey}`,
  }
}

/**
 * OpenAI-shaped request body.
 *
 * `max_tokens` is omitted when the caller passes 0 or less: some newer
 * reasoning models reject the field outright, and sending a huge value is
 * preferable to a hard 400.
 *
 * `top_k` / `min_p` / `typical_p` / `repeat_penalty` are NOT sent. They are
 * llama.cpp sampler knobs with no OpenAI equivalent; the server-side defaults
 * are the only correct choice, and forwarding them to a gateway that silently
 * ignores unknown fields would create a settings screen that lies.
 */
export function buildOpenAiBody(
  config: RemoteProviderConfig,
  messages: readonly ChatMessage[],
  params: CompletionRequest,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: true,
    temperature: params.sampling.temperature,
    top_p: params.sampling.topP,
  }

  if (params.sampling.maxTokens > 0) body.max_tokens = params.sampling.maxTokens
  if (params.sampling.frequencyPenalty !== 0) {
    body.frequency_penalty = params.sampling.frequencyPenalty
  }
  if (params.sampling.presencePenalty !== 0) {
    body.presence_penalty = params.sampling.presencePenalty
  }
  if (params.sampling.seed >= 0) body.seed = params.sampling.seed

  const stop = params.sampling.stop.filter((s) => s.length > 0)
  if (stop.length > 0) body.stop = stop

  if (params.jsonSchema) {
    body.response_format = { type: 'json_object' }
  }

  return body
}

/**
 * Anthropic-shaped request body.
 *
 * Three structural differences from OpenAI, all of which cause a 400 if got
 * wrong, and all handled here:
 *
 *   1. The system prompt is a TOP-LEVEL `system` string, not a message with
 *      `role: 'system'`. Sending it as a message is rejected.
 *   2. `max_tokens` is REQUIRED. There is no "unset means server default".
 *   3. Only `user` and `assistant` roles are legal in `messages`.
 *
 * Consecutive same-role messages are merged because the API rejects them, and
 * a character card can easily produce two user turns in a row (a greeting
 * followed by the player's first line).
 */
export function buildAnthropicBody(
  config: RemoteProviderConfig,
  messages: readonly ChatMessage[],
  params: CompletionRequest,
): Record<string, unknown> {
  const systemParts: string[] = []
  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = []

  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(message.content)
      continue
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const previous = turns[turns.length - 1]
    if (previous && previous.role === role) {
      previous.content += `\n\n${message.content}`
    } else {
      turns.push({ role, content: message.content })
    }
  }

  // Anthropic requires at least one message and requires the first to be from
  // the user. A card whose only content is a system prompt is a real case, so
  // seed a minimal user turn rather than earning a 400.
  if (turns.length === 0 || turns[0].role !== 'user') {
    turns.unshift({ role: 'user', content: '开始。' })
  }

  const body: Record<string, unknown> = {
    model: config.model,
    // Required by the API. `maxTokens` of 0 or less becomes a sane default
    // rather than an invalid request.
    max_tokens: params.sampling.maxTokens > 0 ? params.sampling.maxTokens : 1024,
    messages: turns,
    stream: true,
    temperature: params.sampling.temperature,
    top_p: params.sampling.topP,
  }

  if (systemParts.length > 0) body.system = systemParts.join('\n\n')

  const stop = params.sampling.stop.filter((s) => s.length > 0)
  if (stop.length > 0) body.stop_sequences = stop

  return body
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Token estimate for the remote backend.
 *
 * A cloud provider tokenizes server-side and does not tell us the count, so
 * there is no real vocabulary available here. We deliberately reuse the shared
 * high-biased heuristic rather than carrying a fourth private copy: the point
 * of `src/inference/tokenizer.ts` is that the context meter does not jump when
 * the user switches between local and remote backends, and that is only true
 * if both sides use the same function.
 *
 * Re-exported under the old name because existing tests and call sites import
 * `estimateTokens` from this module.
 */
export { estimateTokens } from '../tokenizer.ts'

function isAbort(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'AbortError' || /abort/i.test(error.message)
  }
  return false
}

/**
 * Turns a transport failure into something a user can act on.
 *
 * The status codes that actually occur in this app's target market are mapped
 * to Chinese copy, because "401 Unauthorized" tells a non-technical user
 * nothing about which field to fix.
 */
export function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)

  if (isAbort(error)) return '已取消'
  if (/401|unauthor|invalid.*key|api key/i.test(raw)) return 'API Key 无效或已过期，请检查设置'
  if (/403|forbidden/i.test(raw)) return '无权访问：Key 可能未开通该模型'
  if (/404|not found/i.test(raw)) return '接口地址或模型名称不正确'
  if (/429|rate ?limit|quota/i.test(raw)) return '请求过于频繁或额度已用尽，请稍后再试'
  if (/5\d\d|server error/i.test(raw)) return '服务端错误，请稍后再试'
  if (/network|timeout|timed out|failed to fetch|connect/i.test(raw)) return '网络连接失败，请检查网络或接口地址'

  return `请求失败：${raw}`
}

/**
 * Test a cloud configuration WITHOUT touching the live engine.
 *
 * ── Why standalone rather than reusing the installed engine ─────────────────
 * The 云端 settings page needs "is this config usable?" as a side-effect-free
 * question. The engine holds exactly ONE context at a time, so probing through
 * it would silently unload whatever local model the user has resident — merely
 * checking an API key must not cost them their model. This builds a throwaway
 * engine over the same transport and probes with that.
 *
 * ── What a pass actually proves ────────────────────────────────────────────
 * That the base URL is reachable and the credential is accepted. For
 * OpenAI-compatible gateways the probe is `GET /models`, which most implement;
 * for Anthropic it is a 1-token completion, since Anthropic has no cheap
 * unauthenticated listing endpoint. A model-name typo may not be caught by
 * `/models` on every gateway, which is why a failure message is surfaced
 * verbatim rather than replaced with a generic one.
 *
 * Never throws: a rejected promise would be an awkward contract for a button
 * whose whole job is to report a result.
 */
export async function testRemoteProvider(config: RemoteProviderConfig): Promise<{
  ok: boolean
  message: string
  latencyMs: number
  /** HTTP status when one could be recovered, for troubleshooting. */
  status: number | null
}> {
  const started = Date.now()

  try {
    // Imported lazily so this module stays loadable in tests that only need
    // `describeError` — the transport pulls in `fetch`, which is not present in
    // plain Node.
    const { createFetchTransport } = await import('./fetchTransport.ts')
    const engine = new RemoteEngine(config, createFetchTransport())

    /**
     * Probe the CHAT endpoint, not the model list.
     *
     * The first version of this button only hit `GET /models`, which does not
     * validate the model name. A user with the product name "DeepSeek V4.1
     * Flash" in that field got "连接成功" from the button and then total silence
     * when they actually chatted — the chat request was rejected with a 400
     * that the UI swallowed. A test that passes while the real call fails is
     * worse than no test.
     *
     * `completion` with a 1-token budget exercises exactly the endpoint and
     * body shape that real traffic uses, so a bad model name is caught here.
     * The cost is one token, and the result is discarded.
     */
    await engine.load({} as never)
    await engine.completion(
      [{ role: 'user', content: 'hi' }],
      {
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
          // One token: enough to prove the model name resolves, cheap enough to
          // be free on every provider.
          maxTokens: 1,
          seed: -1,
          stop: [],
        },
        enableThinking: false,
        thinkingBudgetTokens: null,
        jsonSchema: null,
      },
      () => {},
    )

    return {
      ok: true,
      message: '连接成功，可以正常对话。',
      latencyMs: Date.now() - started,
      status: null,
    }
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      message: describeError(error),
      latencyMs: Date.now() - started,
      status: extractStatus(raw),
    }
  }
}

/** Recover an HTTP status embedded in an error string, when present. */
function extractStatus(text: string): number | null {
  const match = /(?:HTTP\s*)?\b(\d{3})\b/.exec(text)
  if (!match) return null
  const code = Number(match[1])
  return code >= 100 && code < 600 ? code : null
}
