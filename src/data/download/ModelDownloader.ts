import type {
  DownloadProgress,
  ModelDescriptor,
  ModelFilePart,
  ModelState,
  RetryPolicy,
  VerificationResult,
} from '@/types/domain'

/**
 * Model downloader interface.
 *
 * Split into a transport-agnostic contract so the implementation can be
 * swapped (background-downloader today, foreground fetch or a WorkManager
 * bridge later) without touching the store or the UI.
 */
export interface DownloaderEvents {
  onProgress?: (progress: DownloadProgress) => void
  onStateChange?: (state: ModelState) => void
  onComplete?: (result: DownloadResult) => void
  onError?: (error: DownloadError) => void
}

export interface DownloadResult {
  readonly modelId: string
  /** Absolute paths of every shard, ordered by index. */
  readonly shardPaths: string[]
  /** Path of the first shard — what llama.rn is handed. */
  readonly primaryPath: string
  readonly totalBytes: number
  readonly durationMs: number
  readonly verifications: VerificationResult[]
}

export interface DownloadError {
  readonly modelId: string
  readonly partIndex: number
  /** HTTP status when the failure was an HTTP failure. */
  readonly status?: number
  readonly message: string
  /** True when a retry is worth attempting. */
  readonly retryable: boolean
}

export type DownloadTaskId = string

/**
 * The main downloader contract.
 *
 * Lifecycle invariants the implementation must uphold:
 *  1. `start` is idempotent per modelId — calling it while a download is
 *     running returns the existing task rather than starting a second one.
 *  2. Progress is persisted BEFORE it is emitted. A process death must lose
 *     at most the bytes since the last persist, never the resume offset.
 *  3. A part is only marked complete after its sha256 verifies. Bytes are
 *     never trusted from the transport alone.
 *  4. `pause` must leave the partial file on disk with a valid resume offset.
 *     It must not delete partial data.
 *  5. `cancel` deletes partial data for the model.
 *  6. Only one part downloads at a time per model (shards are sequential —
 *     parallel shards on a mobile link rarely help and complicate resume).
 */
export interface ModelDownloader {
  /** Begin (or resume) downloading every part of a model. */
  start(
    model: ModelDescriptor,
    opts?: { readonly resume?: boolean; readonly events?: DownloaderEvents },
  ): Promise<DownloadTaskId>

  /** Suspend an active download, keeping partial data for a later resume. */
  pause(modelId: string): Promise<void>

  /** Abandon the download and remove partial data. */
  cancel(modelId: string): Promise<void>

  /** Read the persisted progress for a model, or null if never started. */
  getProgress(modelId: string): Promise<DownloadProgress | null>

  /** All models with persisted progress, for restoring UI state at boot. */
  listActive(): Promise<DownloadProgress[]>

  /** Re-emit progress/state updates. Returns an unsubscribe function. */
  subscribe(modelId: string, events: DownloaderEvents): () => void

  /**
   * Verify an already-downloaded model against its declared digests.
   * Used by the "repair" affordance and after an app update.
   */
  verify(model: ModelDescriptor): Promise<VerificationResult[]>

  /** Delete a downloaded model and all of its shards. */
  remove(modelId: string): Promise<void>

  /**
   * Enumerate models whose parts are all present ON DISK.
   *
   * This is a filesystem scan, deliberately independent of the SQLite state —
   * it is how the app recovers if the database and the disk disagree (user
   * cleared app data, restored a backup, or the process died mid-transaction).
   */
  reconcile(): Promise<ReconcileReport>
}

export interface ReconcileReport {
  /** Appeared on disk but was missing from the database. */
  readonly adopted: string[]
  /** Recorded as ready but missing or truncated on disk. */
  readonly missing: string[]
  /** Present with the right size but not yet verified this session. */
  readonly unverified: string[]
}

// ---------------------------------------------------------------------------
// Range/resume helpers — pure, unit-testable
// ---------------------------------------------------------------------------

export interface RangeProbe {
  /** True when the server answered 206 to a Range request. */
  readonly supportsRanges: boolean
  /** Total entity length in bytes, or null when unknown. */
  readonly contentLength: number | null
  /** ETag / Last-Modified, used to detect the file changing under us. */
  readonly validator: string | null
}

/**
 * Decides whether an existing partial file may be resumed.
 *
 * Resume is only safe when the remote entity is byte-identical to the one the
 * partial download started from. We compare the validator (ETag is best;
 * Last-Modified is the weak fallback) AND the total length. A changed
 * validator means the publisher re-uploaded the model — resuming would splice
 * two different files together and produce a corrupt GGUF that only fails
 * much later, at load time or, worse, mid-generation.
 */
export function canResume(
  probe: RangeProbe,
  partial: { validator: string | null; totalBytes: number | null },
): { resumable: boolean; reason: string } {
  if (!probe.supportsRanges) {
    return { resumable: false, reason: 'Server does not support HTTP Range requests.' }
  }
  if (probe.validator != null && partial.validator != null && probe.validator !== partial.validator) {
    return {
      resumable: false,
      reason: 'Remote file changed since the partial download started (validator mismatch).',
    }
  }
  if (probe.contentLength != null && partial.totalBytes != null && probe.contentLength !== partial.totalBytes) {
    return {
      resumable: false,
      reason: 'Remote file size changed since the partial download started.',
    }
  }
  return { resumable: true, reason: 'Safe to resume.' }
}

/** Parses `Content-Range: bytes 100-999/1000` into its parts. */
export function parseContentRange(
  header: string | null,
): { start: number; end: number; total: number } | null {
  if (!header) return null
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(header.trim())
  if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) return null
  if (m[3] === '*') return null
  return { start: Number(m[1]), end: Number(m[2]), total: Number(m[3]) }
}

/** Exponential backoff with full jitter. Pure — used directly in tests. */
export function computeBackoffMs(attempt: number, policy: RetryPolicy): number {
  const exponential = Math.min(policy.baseDelayMs * 2 ** attempt, policy.maxDelayMs)
  const jitterFactor = 1 - policy.jitter * Math.random()
  return Math.round(exponential * jitterFactor)
}

/** Default retry policy — tuned for flaky mobile networks. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 60_000,
  jitter: 0.3,
}

/**
 * Classifies an error as retryable. Getting this wrong in the "retryable"
 * direction is the expensive mistake: it makes the app hammer a 404 until the
 * attempt budget is gone.
 */
export function isRetryableStatus(status: number): boolean {
  if (status === 408 || status === 429) return true
  if (status >= 500 && status <= 599) return true
  return false
}

/** Total bytes remaining across every part of a model. */
export function remainingBytes(
  model: ModelDescriptor,
  progress: Pick<DownloadProgress, 'partIndex' | 'partBytesWritten'>,
): number {
  const done = model.files
    .filter((f) => f.index < progress.partIndex)
    .reduce((sum, f) => sum + f.sizeBytes, 0)
  return Math.max(0, model.sizeBytes - done - progress.partBytesWritten)
}

/** Validates that shard indices are contiguous from 0 — a corrupt catalog would break resume. */
export function validateParts(parts: readonly ModelFilePart[]): string | null {
  if (parts.length === 0) return 'Model has no files.'
  const sorted = [...parts].sort((a, b) => a.index - b.index)
  for (let i = 0; i < sorted.length; i += 1) {
    if (sorted[i]?.index !== i) return `Shard indices are not contiguous from 0 (found ${sorted[i]?.index} at position ${i}).`
  }
  if (parts.length > 1 && parts.length > 99999) return 'Split GGUF exceeds the llama.cpp 5-digit shard limit.'
  return null
}
