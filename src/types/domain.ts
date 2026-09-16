/**
 * Shared domain types for phone-llm-app.
 *
 * Design rule: this file has ZERO imports from `llama.rn`, `react-native`, or
 * any runtime module. It is pure type surface so that `data/`, `store/` and
 * test code can depend on it without pulling in the native inference module.
 */

// ---------------------------------------------------------------------------
// Model management
// ---------------------------------------------------------------------------

/** Quantisation label as published by the model author (e.g. "Q4_K_M"). */
export type Quantization = string

/** A single downloadable file (a monolithic GGUF, or one shard of a split GGUF). */
export interface ModelFilePart {
  /** Zero-based index. Monolithic GGUFs have exactly one part with index 0. */
  readonly index: number
  /** Remote URL to fetch. */
  readonly url: string
  /** Expected size in bytes, from the model index (Content-Length is a fallback). */
  readonly sizeBytes: number
  /** sha256 hex digest of the *complete* file. */
  readonly sha256: string
}

/**
 * A model as the UI and the downloader understand it — i.e. BEFORE download.
 *
 * `sizeBytes` is the sum over `files`. The runtime path only exists once the
 * model is fully present on disk; see `DownloadedModel`.
 */
export interface ModelDescriptor {
  /** Stable slug, e.g. "qwen3-4b-instruct-q4_k_m". Primary key in SQLite. */
  readonly id: string
  readonly displayName: string
  readonly author: string
  /** Direct GGUF or repository page, for attribution in the UI. */
  readonly sourceUrl: string
  readonly license: string
  readonly quantization: Quantization
  /** Parameter count in billions; drives the memory-estimate heuristic. */
  readonly parametersB: number
  /** Transformer layer count — used to clamp `n_gpu_layers`. */
  readonly layerCount: number
  /** Attention/embedding width, informational + used in KV-cache sizing. */
  readonly embeddingLength: number
  /** Key/value head counts, required for an accurate KV-cache estimate. */
  readonly headCountKv: number
  /** Head dimension, required for an accurate KV-cache estimate. */
  readonly headDim: number
  /** Native training context; the UI must never allow n_ctx beyond this. */
  readonly contextLength: number
  readonly files: readonly ModelFilePart[]
  /** Total download size, derived from `files`. */
  readonly sizeBytes: number
  /** Optional one-line description shown in the picker. */
  readonly description?: string
  /** Capability flags used to gate UI affordances. */
  readonly tags: readonly ModelTag[]
}

export type ModelTag =
  | 'chat'
  | 'instruct'
  | 'reasoning'
  | 'vision'
  | 'multimodal'
  | 'tool-calling'
  | 'roleplay'
  | 'tiny'

/** Lifecycle of a model on this device. */
export type ModelState =
  | 'not-downloaded'
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'verifying'
  | 'ready'
  | 'error'

/** A model row as persisted in SQLite. */
export interface ModelRecord {
  readonly id: string
  state: ModelState
  /** Number of parts fully present and verified. */
  completedParts: number
  /** Aggregate bytes on disk across all parts (including partial part). */
  bytesOnDisk: number
  /** Absolute path of the primary GGUF once `state === 'ready'`. */
  localPath: string | null
  /** Absolute paths of every shard, ordered by index, once `state === 'ready'`. */
  shardPaths: string[]
  /** Last error message, cleared on a successful transition out of `error`. */
  lastError: string | null
  /** Epoch ms of the last write; drives the "stale download" sweep. */
  updatedAt: number
  /** Epoch ms the download first started. */
  createdAt: number
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

/** Per-part download progress, persisted so a resume survives process death. */
export interface DownloadProgress {
  readonly modelId: string
  /** Part currently in flight, or the next one if idle. */
  readonly partIndex: number
  /** Bytes confirmed written for the in-flight part. */
  readonly partBytesWritten: number
  /** Sum of bytes for all parts strictly before `partIndex`. */
  readonly priorPartsBytes: number
  readonly totalBytes: number
  /** Bytes/second, smoothed over a short window. 0 when unknown. */
  readonly speedBps: number
  /** Estimated remaining seconds, or null when it cannot be estimated. */
  readonly etaSeconds: number | null
  readonly state: ModelState
}

/** Result of a sha256 verification pass. */
export interface VerificationResult {
  readonly ok: boolean
  readonly expected: string
  readonly actual: string
  readonly bytesHashed: number
  readonly durationMs: number
}

/** Retry policy for a single part. */
export interface RetryPolicy {
  readonly maxAttempts: number
  /** Base delay in ms; the actual delay grows exponentially. */
  readonly baseDelayMs: number
  readonly maxDelayMs: number
  /** Jitter fraction, 0..1, applied to each delay. */
  readonly jitter: number
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

/** Sampling + generation parameters. Mirrors llama.rn's completion params. */
export interface SamplingParams {
  temperature: number
  topK: number
  topP: number
  minP: number
  typicalP: number
  repeatPenalty: number
  repeatLastN: number
  presencePenalty: number
  frequencyPenalty: number
  /** Max tokens to generate in one turn. */
  maxTokens: number
  /** Optional RNG seed; -1 means "randomise". */
  seed: number
  /** Stop strings appended to the model's own stop tokens. */
  stop: string[]
}

/** Context-construction parameters, distinct from sampling. */
export interface ContextConfig {
  /** Requested context window in tokens. Clamped to the model's native max. */
  contextLength: number
  /** Prompt batch size. */
  batchSize: number
  /** CPU worker threads. */
  threads: number
  /** Layers offloaded to GPU (OpenCL) / NPU (Hexagon). 0 = pure CPU. */
  gpuLayers: number
  /**
   * llama.rn backend device selection. `[]` = platform default (CPU).
   * `['HTP0']` / `['HTP*']` opt into Hexagon NPU (experimental).
   */
  devices: string[]
  /** Use memory-mapped weights. Strongly recommended on Android. */
  useMmap: boolean
  /** Lock weights in RAM. Off by default — Android OOM-kills aggressively. */
  useMlock: boolean
  /** Flash attention. Only meaningful with a GPU backend. */
  flashAttention: 'auto' | 'on' | 'off'
  /** KV-cache key quantisation. `f16` is the safe default. */
  cacheTypeK: string
  /** KV-cache value quantisation. `f16` is the safe default. */
  cacheTypeV: string
}

/** Everything needed to bring a model up. */
export interface LoadRequest {
  readonly modelId: string
  /** Absolute `file://` path to the primary GGUF (first shard if split). */
  readonly modelPath: string
  readonly contextConfig: ContextConfig
  /**
   * Transformer layer count, used to clamp `n_gpu_layers`.
   *
   * Passed in rather than read from GGUF metadata because
   * `loadLlamaModelInfo` opens the file, and we want the load path to open it
   * exactly once. The catalog already knows this value.
   */
  readonly modelLayerCount: number
}

/** Live status of the inference engine. */
export interface EngineStatus {
  readonly state: 'idle' | 'loading' | 'ready' | 'generating' | 'error'
  readonly modelId: string | null
  /** 0..100 during `loading`. */
  readonly loadProgress: number
  readonly error: string | null
  /** True when a GPU (OpenCL) backend actually initialised. */
  readonly gpuActive: boolean
  /** Populated when `gpuActive` is false — why the backend fell back. */
  readonly gpuFallbackReason: string | null
  /** Human-readable list of active backend devices. */
  readonly activeDevices: string[]
}

/** One streamed chunk of generated text. */
export interface StreamChunk {
  /** Newly produced text since the previous chunk. */
  readonly text: string
  /** Cumulative text for this turn. */
  readonly accumulated: string
  /** Reasoning/thinking text, when the model emits it separately. */
  readonly reasoning?: string
  readonly done: boolean
}

/** Post-generation timing report, surfaced in the debug sheet. */
export interface GenerationTimings {
  readonly promptTokens: number
  readonly generatedTokens: number
  readonly promptMs: number
  readonly generationMs: number
  readonly tokensPerSecond: number
  readonly promptTokensPerSecond: number
  readonly cacheReusedTokens: number
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/** Device memory snapshot used to gate model loading. */
export interface MemorySnapshot {
  /** `MemoryInfo.totalMem` — physical RAM, in bytes. */
  readonly totalMem: number
  /** `MemoryInfo.availMem` — *reclaimable* memory, in bytes. */
  readonly availMem: number
  /** `MemoryInfo.threshold` — the low-memory watermark, in bytes. */
  readonly threshold: number
  /** `ActivityManager.isLowRamDevice()` — true on budget hardware. */
  readonly lowRamDevice: boolean
  /**
   * The budget the app may actually use, in bytes.
   *
   * Computed by `MemoryProbe`, NOT read from the platform. It deliberately
   * uses `availMem` and a safety margin rather than `Runtime.maxMemory()`,
   * which reports only the Java heap cap (typically 128–512 MB) and is
   * wildly misleading for native allocations like llama.cpp weights.
   */
  readonly usableBudget: number
}

/** Estimate of what a given model + context will cost in RAM. */
export interface MemoryEstimate {
  readonly weightsBytes: number
  readonly kvCacheBytes: number
  /** Weights + KV + compute scratch + runtime overhead. */
  readonly totalBytes: number
  readonly fitsComfortably: boolean
  readonly maybeFits: boolean
  /** Populated when the estimate is a heuristic rather than exact. */
  readonly assumptions: string[]
}

// ---------------------------------------------------------------------------
// Character cards
// ---------------------------------------------------------------------------

/** Character card V2 `data` block. */
export interface CharacterCardData {
  name: string
  description: string
  personality: string
  scenario: string
  first_mes: string
  mes_example: string
  creator_notes: string
  system_prompt: string
  post_history_instructions: string
  alternate_greetings: string[]
  tags: string[]
  creator: string
  character_version: string
  extensions: Record<string, unknown>
}

/** A V2 card file: `{ spec, spec_version, data }`. */
export interface CharacterCardV2 {
  spec: 'chara_card_v2'
  spec_version: '2.0'
  data: CharacterCardData
}

/** Legacy V1 card — a bare `CharacterCardData`. Auto-upgraded on import. */
export type CharacterCardV1 = CharacterCardData

/** Result of parsing an arbitrary `.png` / `.json` card file. */
export type CharacterParseResult =
  | { readonly ok: true; readonly card: CharacterCardV2; readonly sourceVersion: 'v1' | 'v2' }
  | { readonly ok: false; readonly error: string }

/** A character as stored locally (card + our own bookkeeping). */
export interface CharacterRecord {
  readonly id: string
  card: CharacterCardV2
  /** Absolute path of the imported cover image, if any. */
  avatarPath: string | null
  /** True for cards the user authored in-app rather than imported. */
  isUserCreated: boolean
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export type MessageRole = 'system' | 'user' | 'assistant'

export interface Message {
  readonly id: string
  readonly conversationId: string
  readonly role: MessageRole
  readonly content: string
  /** Reasoning/thinking text, kept out of the main transcript. */
  reasoning: string | null
  /** Epoch ms. */
  readonly createdAt: number
  /** Model that produced this message; null for user messages. */
  readonly modelId: string | null
  /** Swipes: alternative assistant generations for the same turn. */
  swipeIndex: number
  readonly swipes: string[]
  /** True when the user explicitly edited this message. */
  edited: boolean
  /** True when this message is pinned out of context-window trimming. */
  pinned: boolean
}

export interface Conversation {
  readonly id: string
  readonly title: string
  /** Null until the user picks a character. */
  characterId: string | null
  /** Null until the user picks a model. */
  modelId: string | null
  /** Per-conversation sampler overrides; null = inherit global defaults. */
  samplerOverride: Partial<SamplingParams> | null
  /** Per-conversation context override; null = inherit global defaults. */
  contextOverride: Partial<ContextConfig> | null
  /** Free-form scenario/lorebook text prepended to the system prompt. */
  worldInfo: string
  createdAt: number
  updatedAt: number
  /** Denormalised for the conversation list; avoids a COUNT per row. */
  messageCount: number
  /** Epoch ms of the newest message, for sorting. */
  lastMessageAt: number
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type AppErrorCode =
  | 'MODEL_NOT_FOUND'
  | 'MODEL_NOT_READY'
  | 'INSUFFICIENT_MEMORY'
  | 'DOWNLOAD_FAILED'
  | 'CHECKSUM_MISMATCH'
  | 'DISK_FULL'
  | 'LOAD_FAILED'
  | 'GENERATION_FAILED'
  | 'CANCELLED'
  | 'UNKNOWN'

export class AppError extends Error {
  readonly code: AppErrorCode

  readonly cause?: unknown

  constructor(code: AppErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.cause = cause
  }
}
