import {
  initLlama,
  releaseAllLlama,
  loadLlamaModelInfo,
  type LlamaContext,
  type ContextParams,
} from 'llama.rn'

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
import type { ContextConfig, LoadRequest } from '@/types/domain'

/**
 * The ONLY file in the project that imports `llama.rn`.
 *
 * Verified against llama.rn 0.13.0-rc.3 (npm, published 2026-09-08) — the
 * exact API shapes used here (`initLlama`, `LlamaContext.completion`,
 * `stopCompletion`, `clearCache`, `release`, `context.gpu` /
 * `reasonNoGPU` / `devices` / `systemInfo`) are read from that release's
 * published `src/index.ts`, not from memory.
 *
 * ── Migration notes, because this is a release candidate ────────────────────
 *
 *  • v0.10+ REQUIRES React Native's New Architecture. There is no old-arch path
 *    after v0.9.
 *  • Android natives are NOT in the npm tarball — a `postinstall` script
 *    downloads `android/src/main/jniLibs` from the matching GitHub release and
 *    SHA-256-verifies it. Behind a corporate proxy or in a sandboxed CI this
 *    silently produces a package with no `.so` files, and the failure surfaces
 *    much later as `Missing JSI bindings`. If that error appears, run
 *    `node ./node_modules/llama.rn/install/download-native-artifacts.js` by hand.
 *  • `flash_attn` and raw `cache_type_k/v` strings were re-typed upstream
 *    (`flash_attn_type` enum, validated string unions). We pass the narrowed
 *    values and rely on llama.rn's own fallback-with-warning for bad cache types.
 */

/** Narrowed unions matching llama.rn's `ContextParams` after its own Omit/union rewrite. */
type RnFlashAttn = 'auto' | 'on' | 'off'
type RnCacheType = 'f16' | 'f32' | 'bf16' | 'q8_0' | 'q4_0' | 'q4_1' | 'iq4_nl' | 'q5_0' | 'q5_1'

const FLASH_ATTN_VALUES: readonly RnFlashAttn[] = ['auto', 'on', 'off']
const CACHE_TYPE_VALUES: readonly RnCacheType[] = [
  'f16', 'f32', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1',
]

function toFlashAttn(value: string): RnFlashAttn {
  return (FLASH_ATTN_VALUES as readonly string[]).includes(value)
    ? (value as RnFlashAttn)
    : 'auto'
}

function toCacheType(value: string): RnCacheType {
  // llama.rn warns and falls back to f16 on an invalid value; narrowing here
  // keeps the type honest and makes the fallback explicit rather than silent.
  return (CACHE_TYPE_VALUES as readonly string[]).includes(value)
    ? (value as RnCacheType)
    : 'f16'
}

/**
 * Maps our `ContextConfig` onto llama.rn's `ContextParams`.
 *
 * Kept as a pure exported function so it can be unit-tested without a device.
 */
export function buildContextParams(
  modelPath: string,
  config: ContextConfig,
  modelLayerCount: number,
): ContextParams {
  const gpuLayers =
    config.gpuLayers <= 0 ? 0 : Math.max(1, Math.min(config.gpuLayers, modelLayerCount))

  const params: ContextParams = {
    model: modelPath,
    n_ctx: config.contextLength,
    n_batch: config.batchSize,
    n_threads: config.threads,
    n_gpu_layers: gpuLayers,
    use_mmap: config.useMmap,
    // Passing use_mlock: true pins the weights so the LMK cannot reclaim them,
    // which on Android trades a small latency win for a much higher chance of
    // being killed under pressure. Default is false; see DEFAULT_CONTEXT_CONFIG.
    use_mlock: config.useMlock,
    flash_attn_type: toFlashAttn(config.flashAttention),
    cache_type_k: toCacheType(config.cacheTypeK),
    cache_type_v: toCacheType(config.cacheTypeV),
  }

  // Only set `devices` when the caller asked for something. Omitting it lets
  // llama.rn use the platform default; passing an empty array would be a
  // different (and on some builds, invalid) signal.
  if (config.devices.length > 0) {
    params.devices = [...config.devices]
  }

  return params
}

export class LlamaRnEngine implements InferenceEngine {
  private context: LlamaContext | null = null

  private status: EngineStatusView = {
    state: 'idle',
    modelId: null,
    loadProgress: 0,
    error: null,
    gpuActive: false,
    gpuFallbackReason: null,
    activeDevices: [],
  }

  private modelLayerCount = 0

  private metadata: Record<string, unknown> = {}

  private chatTemplateOverride: string | null = null

  getStatus(): EngineStatusView {
    return { ...this.status }
  }

  isReady(): boolean {
    return this.context != null && this.status.state !== 'error'
  }

  /**
   * Reads GGUF metadata WITHOUT loading the model into a context.
   *
   * Cheap (parses the header only) and safe to call while another model is
   * loaded. Used by the model picker to show the real context length and the
   * embedded chat template before committing to a multi-GB load.
   */
  static async inspect(modelPath: string): Promise<Record<string, unknown>> {
    try {
      return (await loadLlamaModelInfo(modelPath)) as Record<string, unknown>
    } catch {
      return {}
    }
  }

  async load(
    request: LoadRequest,
    onProgress?: (pct: number) => void,
  ): Promise<LoadedModelInfo> {
    // Enforce the single-context invariant. A second resident model is an
    // OOM kill on any device that is not a flagship.
    if (this.context) await this.unload()

    this.status = {
      state: 'loading',
      modelId: request.modelId,
      loadProgress: 0,
      error: null,
      gpuActive: false,
      gpuFallbackReason: null,
      activeDevices: [],
    }

    this.modelLayerCount = request.modelLayerCount

    try {
      const params = buildContextParams(
        request.modelPath,
        request.contextConfig,
        request.modelLayerCount,
      )

      // Wrap the caller's callback: it may throw (e.g. a React state update
      // after unmount) and a throw inside the native progress bridge would
      // abort the load.
      const progressCb = onProgress
        ? (pct: number) => {
            this.status = { ...this.status, loadProgress: pct }
            try {
              onProgress(pct)
            } catch {
              /* ignore consumer errors */
            }
          }
        : undefined

      const context = await initLlama(params, progressCb)

      this.context = context
      this.metadata = (context.model?.metadata ?? {}) as Record<string, unknown>

      const rawTemplate = this.metadata['tokenizer.chat_template']
      const chatTemplate = typeof rawTemplate === 'string' ? rawTemplate : null

      this.status = {
        state: 'ready',
        modelId: request.modelId,
        loadProgress: 100,
        error: null,
        gpuActive: context.gpu === true,
        // llama.rn exposes reasonNoGPU only on iOS; on Android this stays null
        // unless a GPU was requested and refused.
        gpuFallbackReason: context.gpu === true ? null : (context.reasonNoGPU || null),
        activeDevices: (context.devices ?? []).map((d) => String(d)),
      }

      return {
        modelId: request.modelId,
        contextLength: request.contextConfig.contextLength,
        gpuActive: this.status.gpuActive,
        gpuFallbackReason: this.status.gpuFallbackReason,
        activeDevices: this.status.activeDevices,
        metadata: this.metadata,
        chatTemplate,
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.status = {
        state: 'error',
        modelId: request.modelId,
        loadProgress: 0,
        error: message,
        gpuActive: false,
        gpuFallbackReason: null,
        activeDevices: [],
      }
      // A failed initLlama can still have left native state behind.
      await this.forceRelease()
      throw e
    }
  }

  async unload(): Promise<void> {
    await this.forceRelease()
    this.status = {
      state: 'idle',
      modelId: null,
      loadProgress: 0,
      error: null,
      gpuActive: false,
      gpuFallbackReason: null,
      activeDevices: [],
    }
    this.metadata = {}
    this.chatTemplateOverride = null
  }

  private async forceRelease(): Promise<void> {
    const ctx = this.context
    this.context = null
    if (ctx) {
      try {
        await ctx.release()
      } catch {
        /* already gone */
      }
    }
  }

  /**
   * Releases every context llama.rn knows about.
   *
   * `context.release()` can miss native state if the JS object was lost (a
   * Fast Refresh, or a crash inside the load). llama.rn keeps an id-keyed
   * native registry, so this is the belt-and-braces teardown. Call it from a
   * top-level error boundary.
   */
  static async releaseEverything(): Promise<void> {
    try {
      await releaseAllLlama()
    } catch {
      /* nothing loaded */
    }
  }

  async completion(
    messages: ChatMessage[],
    params: CompletionRequest,
    onChunk: (chunk: StreamChunkView) => void,
  ): Promise<CompletionOutcome> {
    const context = this.context
    if (!context) throw new Error('No model loaded.')

    this.status = { ...this.status, state: 'generating' }

    const stops =
      params.sampling.stop.length > 0
        ? [...params.sampling.stop, ...DEFAULT_STOP_TOKENS]
        : [...DEFAULT_STOP_TOKENS]

    let accumulated = ''
    let reasoning = ''

    try {
      const result = await context.completion(
        {
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          n_predict: params.sampling.maxTokens,
          temperature: params.sampling.temperature,
          top_k: params.sampling.topK,
          top_p: params.sampling.topP,
          min_p: params.sampling.minP,
          typical_p: params.sampling.typicalP,
          penalty_repeat: params.sampling.repeatPenalty,
          penalty_last_n: params.sampling.repeatLastN,
          penalty_present: params.sampling.presencePenalty,
          penalty_freq: params.sampling.frequencyPenalty,
          seed: params.sampling.seed,
          stop: stops,
          // Jinja + the model's own template. llama.rn ignores `jinja` when the
          // GGUF has no template; we fall back to the raw `llama-chat` path there.
          jinja: true,
          chat_template: this.chatTemplateOverride ?? undefined,
          enable_thinking: params.enableThinking,
          ...(params.thinkingBudgetTokens != null
            ? { thinking_budget_tokens: params.thinkingBudgetTokens }
            : {}),
          ...(params.jsonSchema ? { json_schema: params.jsonSchema } : {}),
        },
        (data) => {
          // `data.token` is the delta; `data.content` is llama.rn's own parsed
          // content split out of thinking blocks. Prefer the parsed form when
          // it is present so reasoning never leaks into the transcript.
          const delta = data.token ?? ''
          accumulated += delta
          if (typeof data.reasoning_content === 'string') {
            reasoning += data.reasoning_content
          }
          try {
            onChunk({
              text: delta,
              accumulated,
              ...(reasoning ? { reasoning } : {}),
              done: false,
            })
          } catch {
            /* consumer error must not abort generation */
          }
        },
      )

      const timings = result.timings
      const generatedTokens = timings?.predicted_n ?? 0
      const generationMs = timings?.predicted_ms ?? 0

      // `result.text` is authoritative — it reflects llama.rn's post-processing
      // (thinking-block stripping, stop-sequence removal). Our `accumulated` is
      // only used for the live stream.
      const finalText = result.text ?? accumulated

      try {
        onChunk({ text: '', accumulated: finalText, ...(reasoning ? { reasoning } : {}), done: true })
      } catch {
        /* ignore */
      }

      this.status = { ...this.status, state: 'ready' }

      return {
        text: finalText,
        reasoning: reasoning || null,
        stopped: generatedTokens < params.sampling.maxTokens,
        timings: {
          promptTokens: timings?.prompt_n ?? 0,
          generatedTokens,
          promptMs: timings?.prompt_ms ?? 0,
          generationMs,
          tokensPerSecond: generationMs > 0 ? (generatedTokens / generationMs) * 1000 : 0,
          // ⚠️ These two are REQUIRED by `GenerationTimings` and were omitted
          // here. Nothing caught it at build time, and the gap surfaced at
          // runtime as a full-app crash: the Settings screen called
          // `.toFixed(1)` on `promptTokensPerSecond` and got
          // "Cannot read property 'toFixed' of undefined".
          promptTokensPerSecond: (timings?.prompt_ms ?? 0) > 0
            ? ((timings?.prompt_n ?? 0) / (timings?.prompt_ms ?? 1)) * 1000
            : 0,
          cacheReusedTokens: timings?.cache_n ?? 0,
        },
      }
    } catch (e) {
      this.status = { ...this.status, state: 'ready' }
      throw e
    }
  }

  async stop(): Promise<void> {
    const context = this.context
    if (!context) return
    try {
      await context.stopCompletion()
    } catch {
      /* already finished */
    }
  }

  async resetContext(): Promise<void> {
    const context = this.context
    if (!context) return
    // clearData=false keeps the allocated tensors and only drops the metadata —
    // far faster, and sufficient to stop cross-conversation bleed. Pass true
    // only when a hybrid/recurrent model needs a full state reset.
    await context.clearCache(false)
  }

  async setChatTemplate(template: string | null): Promise<void> {
    // llama.rn takes the template per-completion rather than per-context, so
    // this is a stored override, not a native call. A change takes effect on
    // the next generation and does NOT require a model reload.
    this.chatTemplateOverride = template
  }

  async countTokens(text: string): Promise<number> {
    const context = this.context
    // Route through the shared tokenizer so the fallback policy (high-biased
    // heuristic, never NaN, never throws) lives in exactly one place. Before
    // this, five modules each carried their own estimator and they could drift.
    if (!context) {
      const { countTokens } = await import('./tokenizer.ts')
      return (await countTokens(text, null)).count
    }
    const { countTokens, makeLlamaTokenCounter } = await import('./tokenizer.ts')
    return (await countTokens(text, makeLlamaTokenCounter(context))).count
  }
}
