import type { ContextConfig, LoadRequest, SamplingParams } from '@/types/domain'

/**
 * Inference engine contract.
 *
 * This is the seam that keeps `llama.rn` out of the rest of the app. Everything
 * above it (store, UI, character engine) speaks these types only. That matters
 * for two reasons:
 *
 *  1. `llama.rn` is a 0.13.0 **release candidate** with a live API — see the
 *     architecture doc. Confining it to one adapter means an upstream break is
 *     a one-file fix.
 *  2. The native module cannot be imported in tests or on non-Android hosts.
 *     A `MockEngine` implementing this interface drives the whole app offline.
 *
 * Threading model: the engine owns exactly ONE loaded context at a time.
 * Loading a second model requires `unload()` first — two resident models will
 * OOM-kill the process on every mid-range device.
 */
export interface InferenceEngine {
  /** Current lifecycle state. */
  getStatus(): EngineStatusView

  /**
   * Load a model. Rejects with `INSUFFICIENT_MEMORY` before touching the
   * native loader when the pre-flight memory check fails — a failed native
   * load of a multi-GB file is slow and can leave the process in a bad state.
   */
  load(request: LoadRequest, onProgress?: (pct: number) => void): Promise<LoadedModelInfo>

  /** Release the context and all native memory. Safe to call when idle. */
  unload(): Promise<void>

  /** True when a context is loaded and usable. */
  isReady(): boolean

  /**
   * Run a chat completion, streaming tokens through `onChunk`.
   *
   * Returns the final text plus timings. `onChunk` fires on the JS thread
   * already batched by llama.rn — do not add another buffer layer on top.
   */
  completion(
    messages: ChatMessage[],
    params: CompletionRequest,
    onChunk: (chunk: StreamChunkView) => void,
  ): Promise<CompletionOutcome>

  /** Stop the in-flight generation. Resolves when the native call returns. */
  stop(): Promise<void>

  /**
   * Drop the KV cache between conversations.
   *
   * Required, not optional: llama.rn keeps context across `completion` calls,
   * so without this a new conversation inherits the previous one's KV state
   * and the model will confidently continue someone else's chat.
   */
  resetContext(): Promise<void>

  /**
   * Apply a chat template override. Advances roadmap Phase 4.
   */
  setChatTemplate(template: string | null): Promise<void>

  /** Count tokens in a string using the loaded model's vocabulary. */
  countTokens(text: string): Promise<number>
}

export interface EngineStatusView {
  readonly state: 'idle' | 'loading' | 'ready' | 'generating' | 'error'
  readonly modelId: string | null
  readonly loadProgress: number
  readonly error: string | null
  readonly gpuActive: boolean
  readonly gpuFallbackReason: string | null
  readonly activeDevices: string[]
}

export interface LoadedModelInfo {
  readonly modelId: string
  /** Context window actually granted by llama.cpp — may be less than requested. */
  readonly contextLength: number
  readonly gpuActive: boolean
  readonly gpuFallbackReason: string | null
  readonly activeDevices: string[]
  /** Model metadata as reported by GGUF, e.g. the chat template. */
  readonly metadata: Record<string, unknown>
  readonly chatTemplate: string | null
}

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: string
}

export interface CompletionRequest {
  readonly sampling: SamplingParams
  /** Enables the model's own reasoning mode where the template supports it. */
  readonly enableThinking: boolean
  /** Soft cap on tokens inside a thinking block. */
  readonly thinkingBudgetTokens: number | null
  /** Grammar for structured output (JSON schema as a string). */
  readonly jsonSchema: string | null
}

export interface StreamChunkView {
  readonly text: string
  readonly accumulated: string
  readonly reasoning?: string
  readonly done: boolean
}

export interface CompletionOutcome {
  readonly text: string
  readonly reasoning: string | null
  /** True when generation stopped because of a stop sequence rather than the cap. */
  readonly stopped: boolean
  readonly timings: {
    readonly promptTokens: number
    readonly generatedTokens: number
    readonly promptMs: number
    readonly generationMs: number
    readonly tokensPerSecond: number
  }
}

export interface InferenceEngineDeps {
  /** Milliseconds clock; injectable for tests. */
  readonly now: () => number
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Sampler defaults chosen for roleplay, not for factual QA.
 *
 * Higher temperature and a live repetition penalty are what keep a persona
 * from collapsing into an assistant voice after a few turns. These are
 * conventional roleplay defaults.
 */
export const DEFAULT_SAMPLING: SamplingParams = {
  temperature: 0.8,
  topK: 40,
  topP: 0.95,
  minP: 0.05,
  typicalP: 1.0,
  repeatPenalty: 1.1,
  repeatLastN: 256,
  presencePenalty: 0.0,
  frequencyPenalty: 0.0,
  /**
   * Hard cap per reply.
   *
   * 1024. Reasoning, revised twice:
   *
   *   - 512 was the original default and was fine for short chat, but a phone
   *     generating ~10 tokens/second spends a full minute to reach it.
   *   - 256 was tried to keep replies snappy, and proved too small: any task
   *     that legitimately enumerates (count to 100, list the fields, write a
   *     function) got cut off mid-answer, and the model was blamed for being
   *     "lazy".
   *
   * 1024 covers the longest realistic single answer. Generation is streamed and
   * cancellable, so a long cap costs the user nothing unless the model actually
   * uses it — the Stop button is right there.
   */
  maxTokens: 1024,
  seed: -1,
  stop: [],
}

/** Conservative context defaults; the memory probe raises them when it can. */
export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  /**
   * 8192, raised from 4096.
   *
   * The bundled model (Qwen2.5-3B) supports 32768 natively, so 4096 left seven
   * eighths of its capacity unused and trimmed conversations after roughly
   * 15–20 exchanges — the symptom being that the model forgets what was said.
   *
   * 8192 doubles the usable conversation length while bounding the cost:
   *
   *   - KV cache: about 1.0 GiB at f16, on a device with far more than that.
   *   - Prefill: about a minute for a FULL window, paid once per turn, and only
   *     when the prompt is genuinely that long. A short chat is unaffected.
   *
   * 16384 was rejected as a default: prefill reaches 2–4 minutes on a large
   * character card, which reads as a frozen app rather than a slow one. Users
   * who want more can raise it in Settings.
   */
  contextLength: 8192,
  batchSize: 512,
  threads: 4,
  gpuLayers: 0,
  devices: [],
  useMmap: true,
  // Deliberately false: use_mlock pins pages so the LMK cannot reclaim them,
  // which on Android is a fast route to being killed rather than a perf win.
  useMlock: false,
  flashAttention: 'auto',
  cacheTypeK: 'f16',
  cacheTypeV: 'f16',
}

/**
 * Stop sequences covering the common GGUF chat formats.
 *
 * llama.rn adds template-derived stops automatically when the model ships a
 * Jinja template, but a large share of community GGUFs do not, and a model
 * that never stops will happily generate until it hits the token cap.
 */
export const DEFAULT_STOP_TOKENS: readonly string[] = [
  '</s>',
  '<|end|>',
  '<|eot_id|>',
  '<|end_of_text|>',
  '<|im_end|>',
  '<|EOT|>',
  '<|END_OF_TURN_TOKEN|>',
  '<|end_of_turn|>',
  '<|endoftext|>',
  '<|eom_id|>',
]

/**
 * Clamps a thread count to something sensible.
 *
 * Using every core is counterproductive: llama.cpp needs the big cores for the
 * token loop, and on big.LITTLE SoCs the little cores drag the barrier rather
 * than helping. `cores - 2` leaves headroom for the UI thread and the OS.
 */
export function clampThreads(envCores: number): number {
  if (!Number.isFinite(envCores) || envCores <= 0) return 4
  return Math.max(2, Math.min(envCores - 2, 8))
}

/**
 * Resolves GPU layer offload for llama.rn.
 *
 * `-1` is not a valid llama.cpp value here; `0` means "none", and a large
 * number means "all". We pass the model's layer count so every layer is a
 * candidate and let the backend keep what fits.
 */
export function resolveGpuLayers(gpuLayers: number, modelLayerCount: number): number {
  if (gpuLayers <= 0) return 0
  return Math.max(1, Math.min(gpuLayers, modelLayerCount))
}
