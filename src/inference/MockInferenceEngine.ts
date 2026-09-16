import {
  DEFAULT_STOP_TOKENS,
  type ChatMessage,
  type CompletionOutcome,
  type CompletionRequest,
  type EngineStatusView,
  type InferenceEngine,
  type LoadedModelInfo,
  type StreamChunkView,
} from './InferenceEngine'
import type { LoadRequest } from '@/types/domain'
import { estimateTokens } from './tokenizer.ts'

/**
 * In-memory engine used for tests, Storybook-style UI work, and any host
 * without the native module.
 *
 * This is not a stub that returns canned strings. It implements the full
 * contract — streaming, cancellation, KV reset, token counting — so the store
 * and UI paths that depend on timing and cancellation are genuinely exercised.
 *
 * Deterministic by design: the same prompt always yields the same text, so
 * snapshot tests do not flake.
 */

export interface MockEngineOptions {
  /** Milliseconds between simulated tokens. 0 makes tests instant. */
  readonly tokenDelayMs?: number
  /** Simulated load duration. */
  readonly loadDelayMs?: number
  /** When set, `load` rejects with this message. */
  readonly failLoad?: string
  /** Tokens per simulated response. */
  readonly responseTokens?: number
}

const CANNED_REPLY =
  'I am a mock engine. The real response would come from a locally loaded ' +
  'GGUF model running through llama.rn, streamed token by token. '

export class MockInferenceEngine implements InferenceEngine {
  private status: EngineStatusView = {
    state: 'idle',
    modelId: null,
    loadProgress: 0,
    error: null,
    gpuActive: false,
    gpuFallbackReason: 'Mock engine — no native backend.',
    activeDevices: [],
  }

  private readonly opts: Required<MockEngineOptions>

  private aborted = false

  private loadedModelId: string | null = null

  /** Number of times `resetContext` ran. Asserted in tests. */
  public resetCount = 0

  /** Number of tokens this engine has emitted, for progress assertions. */
  public emittedTokens = 0

  /** Number of times `stop()` was called. Asserted in tests. */
  public stopCallCount = 0

  /**
   * When set, the next `completion` rejects with this error and then clears it.
   *
   * Exists so tests can drive the failure path — memory exhaustion, a deleted
   * model file — without a device. One-shot rather than sticky: a test that
   * wants two consecutive failures sets it twice, and a test that forgets to
   * reset it does not silently poison later assertions.
   */
  public failNextCompletionWith: Error | null = null

  /**
   * The `messages` array from the most recent `completion` call.
   *
   * Lets a test assert on what the store actually forwarded (ordering, which
   * turns were filtered out) rather than only on the rendered result.
   */
  public lastMessages: readonly ChatMessage[] | null = null

  constructor(options: MockEngineOptions = {}) {
    this.opts = {
      tokenDelayMs: options.tokenDelayMs ?? 0,
      loadDelayMs: options.loadDelayMs ?? 0,
      failLoad: options.failLoad ?? '',
      responseTokens: options.responseTokens ?? 24,
    }
  }

  getStatus(): EngineStatusView {
    return { ...this.status }
  }

  isReady(): boolean {
    return this.loadedModelId != null
  }

  async load(
    request: LoadRequest,
    onProgress?: (pct: number) => void,
  ): Promise<LoadedModelInfo> {
    this.status = { ...this.status, state: 'loading', modelId: request.modelId, loadProgress: 0 }

    if (this.opts.loadDelayMs > 0) {
      await sleep(this.opts.loadDelayMs)
    }

    if (this.opts.failLoad) {
      this.status = { ...this.status, state: 'error', error: this.opts.failLoad }
      throw new Error(this.opts.failLoad)
    }

    onProgress?.(50)
    onProgress?.(100)

    this.loadedModelId = request.modelId
    this.status = {
      state: 'ready',
      modelId: request.modelId,
      loadProgress: 100,
      error: null,
      gpuActive: false,
      gpuFallbackReason: 'Mock engine — no native backend.',
      activeDevices: [],
    }

    return {
      modelId: request.modelId,
      contextLength: request.contextConfig.contextLength,
      gpuActive: false,
      gpuFallbackReason: 'Mock engine — no native backend.',
      activeDevices: [],
      metadata: { 'general.architecture': 'mock' },
      chatTemplate: null,
    }
  }

  async unload(): Promise<void> {
    this.loadedModelId = null
    this.status = {
      state: 'idle',
      modelId: null,
      loadProgress: 0,
      error: null,
      gpuActive: false,
      gpuFallbackReason: null,
      activeDevices: [],
    }
  }

  async completion(
    messages: ChatMessage[],
    params: CompletionRequest,
    onChunk: (chunk: StreamChunkView) => void,
  ): Promise<CompletionOutcome> {
    if (!this.loadedModelId) throw new Error('No model loaded.')

    this.lastMessages = messages

    if (this.failNextCompletionWith) {
      const failure = this.failNextCompletionWith
      this.failNextCompletionWith = null
      this.status = { ...this.status, state: 'error', error: failure.message }
      throw failure
    }

    this.aborted = false
    this.status = { ...this.status, state: 'generating' }

    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    const prefix = lastUser ? `You said: "${truncate(lastUser.content, 40)}". ` : ''
    const full = prefix + CANNED_REPLY

    const tokens = full.split(/(?<=\s)/)
    const limit = Math.min(tokens.length, this.opts.responseTokens)

    let accumulated = ''
    let produced = 0

    for (let i = 0; i < limit; i += 1) {
      if (this.aborted) break
      const token = tokens[i] ?? ''
      accumulated += token
      produced += 1
      this.emittedTokens += 1
      onChunk({ text: token, accumulated, done: false })
      if (this.opts.tokenDelayMs > 0) await sleep(this.opts.tokenDelayMs)
    }

    onChunk({ text: '', accumulated, done: true })
    this.status = { ...this.status, state: 'ready' }

    const stopped = produced < params.sampling.maxTokens

    return {
      text: accumulated,
      reasoning: null,
      stopped,
      timings: {
        promptTokens: messages.reduce((n, m) => n + estimateTokens(m.content), 0),
        generatedTokens: produced,
        promptMs: 10,
        generationMs: Math.max(1, produced * this.opts.tokenDelayMs),
        tokensPerSecond: this.opts.tokenDelayMs > 0 ? 1000 / this.opts.tokenDelayMs : 100,
      },
    }
  }

  async stop(): Promise<void> {
    this.stopCallCount += 1
    this.aborted = true
  }

  async resetContext(): Promise<void> {
    this.resetCount += 1
  }

  async setChatTemplate(): Promise<void> {
    /* no-op: the mock has no template */
  }

  async countTokens(text: string): Promise<number> {
    return estimateTokens(text)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`
}

export { DEFAULT_STOP_TOKENS }
