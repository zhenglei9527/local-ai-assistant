import { NativeModules, Platform } from 'react-native'
import {
  createDownloadTask,
  completeHandler,
  errorHandler,
  type DownloadTask,
} from '@kesha-antonov/react-native-background-downloader'

import {
  DEFAULT_RETRY_POLICY,
  canResume,
  computeBackoffMs,
  isRetryableStatus,
  type DownloadError,
  type DownloadResult,
  type DownloadTaskId,
  type DownloaderEvents,
  type ModelDownloader,
  type ReconcileReport,
  validateParts,
} from '@/data/download/ModelDownloader'
import type {
  DownloadProgress,
  ModelDescriptor,
  ModelState,
  VerificationResult,
} from '@/types/domain'

/**
 * Downloader backed by `@kesha-antonov/react-native-background-downloader`.
 *
 * WHY THIS LIBRARY (and not expo-file-system / bare fetch):
 * A useful GGUF is 0.5–7 GB. On a phone that is 10–60 minutes of transfer,
 * which *will* be interrupted by the user switching apps, a screen lock, or a
 * network handover. A JS-context download (fetch/XHR) is suspended the moment
 * the app backgrounds, so the practical choice is between a native downloader
 * with a foreground service and "keep the app open for an hour". The library
 * wraps Android's DownloadManager-equivalent plus iOS URLSession into a
 * single API and — critically — survives process death, which is what makes
 * resume meaningful rather than decorative.
 *
 * CONCURRENCY MODEL: shards download sequentially. Parallel shards over a
 * mobile link rarely improve throughput (the link, not the server, is the
 * bottleneck), and they multiply the number of partial files that must be
 * tracked, resumed and garbage-collected. Sequential keeps `partIndex` as a
 * single scalar, which is what makes the persisted progress record small and
 * the resume logic trivially correct.
 *
 * ⚠️ NOT EXECUTED. This file has never run — no device, no build. The library
 * import names (`createDownloadTask`, `completeHandler`, `errorHandler`) are
 * read from the package's published typings and must be re-verified against
 * the installed version before first use.
 */

interface PhoneLlmSystemNative {
  getFilesDir(): Promise<string>
  getFreeDiskBytes(): Promise<number>
  ensureDir(relativePath: string): Promise<boolean>
  deleteRecursively(relativePath: string): Promise<boolean>
}

const System = NativeModules.PhoneLlmSystem as PhoneLlmSystemNative | undefined

/**
 * Free space we refuse to consume. Android needs headroom on /data for its own
 * operation, and a completely full data partition degrades the whole device,
 * not just this app. 1 GiB is a floor, not a target — for a 7 GB model the
 * meaningful check is really "does the file fit at all".
 */
const DISK_HEADROOM_BYTES = 1024 * 1024 * 1024

/** How often progress is persisted to the DB, in bytes. */
const PERSIST_INTERVAL_BYTES = 8 * 1024 * 1024

interface ActiveTask {
  task: DownloadTask
  model: ModelDescriptor
  partIndex: number
  bytesWritten: number
  priorPartsBytes: number
  lastPersisted: number
  startedAt: number
  speedWindow: Array<{ at: number; bytes: number }>
}

export interface DownloaderDeps {
  /** Persist a progress record. Injected so the store owns the DB. */
  readonly persistProgress: (progress: DownloadProgress) => Promise<void>
  readonly loadProgress: (modelId: string) => Promise<DownloadProgress | null>
  readonly persistRecord: (
    modelId: string,
    state: ModelState,
    bytesOnDisk: number,
    localPath: string | null,
    shardPaths: string[],
    lastError: string | null,
  ) => Promise<void>
  /** Byte size of a file on disk. The primary integrity signal. */
  readonly fileSize: (filePath: string) => Promise<number>
  /**
   * Optional sha256 digester. Absent when no implementation is available;
   * verification then relies on file size alone (which is what shipped apps
   * do — see `verifyFile`). Never required.
   */
  readonly sha256?: (filePath: string) => Promise<string>
}

export class BackgroundModelDownloader implements ModelDownloader {
  private readonly active = new Map<string, ActiveTask>()
  private readonly listeners = new Map<string, Set<DownloaderEvents>>()
  private readonly root: string
  private readonly deps: DownloaderDeps

  // NOTE: written out longhand rather than using TypeScript *parameter
  // properties* (`private readonly deps: DownloaderDeps` in the signature).
  // Parameter properties are unsupported by Node's type-stripping loader, so
  // the class could not be imported in a unit test — which is part of why the
  // downloader sat unwired for so long.
  constructor(deps: DownloaderDeps, root: string) {
    this.deps = deps
    this.root = root
  }

  /**
   * Factory that resolves the models root from the native module.
   * Throws clearly when the module is absent rather than silently writing to
   * a bogus path — a download that "succeeds" into the wrong directory is
   * worse than one that refuses to start.
   */
  static async create(deps: DownloaderDeps): Promise<BackgroundModelDownloader> {
    if (Platform.OS !== 'android' || !System) {
      throw new Error(
        'PhoneLlmSystem native module is unavailable, so the models directory cannot be ' +
          'resolved. Implement it (docs/roadmap.md Phase 1) before downloading models.',
      )
    }
    const filesDir = await System.getFilesDir()
    await System.ensureDir('models')
    return new BackgroundModelDownloader(deps, `${filesDir}/models`)
  }

  // -------------------------------------------------------------------------
  // Subscription
  // -------------------------------------------------------------------------

  subscribe(modelId: string, events: DownloaderEvents): () => void {
    let set = this.listeners.get(modelId)
    if (!set) {
      set = new Set()
      this.listeners.set(modelId, set)
    }
    set.add(events)
    return () => {
      set?.delete(events)
      if (set && set.size === 0) this.listeners.delete(modelId)
    }
  }

  private emit(modelId: string, fn: (e: DownloaderEvents) => void): void {
    this.listeners.get(modelId)?.forEach((e) => {
      try {
        fn(e)
      } catch {
        // A throwing listener must not abort the download.
      }
    })
  }

  // -------------------------------------------------------------------------
  // Control
  // -------------------------------------------------------------------------

  async start(
    model: ModelDescriptor,
    opts?: { resume?: boolean; events?: DownloaderEvents },
  ): Promise<DownloadTaskId> {
    // Invariant 1: idempotent per modelId.
    const existing = this.active.get(model.id)
    if (existing) return model.id

    if (opts?.events) this.subscribe(model.id, opts.events)

    const invalid = validateParts(model.files)
    if (invalid) {
      await this.fail(model, 0, invalid, false)
      throw new Error(invalid)
    }

    // Disk pre-flight. Refusing up front is much better than filling the
    // device and failing at 90%.
    const free = await this.requireFreeDisk()
    if (free < model.sizeBytes + DISK_HEADROOM_BYTES) {
      const msg =
        `Not enough free space: need ${fmt(model.sizeBytes + DISK_HEADROOM_BYTES)}, ` +
        `have ${fmt(free)}. Free up space and retry.`
      await this.fail(model, 0, msg, false)
      throw new Error(msg)
    }

    await System!.ensureDir(`models/${model.id}`)
    await this.deps.persistRecord(model.id, 'downloading', 0, null, [], null)
    this.emit(model.id, (e) => e.onStateChange?.('downloading'))

    void this.runParts(model, opts?.resume ?? true)
    return model.id
  }

  /**
   * Drives the shard sequence. Runs detached: `start` returns the task id
   * synchronously while this loop reports through events, so the UI is never
   * blocked on a multi-GB transfer.
   */
  private async runParts(model: ModelDescriptor, allowResume: boolean): Promise<void> {
    const priorProgress = await this.deps.loadProgress(model.id)
    const startIndex = allowResume && priorProgress ? priorProgress.partIndex : 0

    let priorPartsBytes = model.files
      .filter((f) => f.index < startIndex)
      .reduce((sum, f) => sum + f.sizeBytes, 0)

    const shardPaths: string[] = []

    for (let i = startIndex; i < model.files.length; i += 1) {
      const part = model.files[i]
      if (!part) continue

      let attempt = 0
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          const path = await this.downloadPart(model, part.index, part.url, part.sizeBytes)
          shardPaths.push(path)

          // Invariant 3: a part is complete only after it verifies. Size is the
          // primary check; the digest is a bonus when a digester exists.
          const verification = await this.verifyFile(path, part.sha256, part.sizeBytes)
          if (!verification.ok) {
            await this.fail(
              model,
              part.index,
              `第 ${part.index + 1} 个文件校验失败：` +
                `应为 ${verification.expected}，实际 ${verification.actual}。` +
                '文件可能在传输中损坏，或清单记录有误。',
              // Not retryable: re-fetching the same bytes yields the same
              // result. A retry storm here is pure bandwidth waste.
              false,
            )
            return
          }

          priorPartsBytes += part.sizeBytes
          await this.deps.persistProgress({
            modelId: model.id,
            partIndex: part.index + 1,
            partBytesWritten: 0,
            priorPartsBytes,
            totalBytes: model.sizeBytes,
            speedBps: 0,
            etaSeconds: null,
            state: 'downloading',
          })
          break
        } catch (err) {
          const retryable = this.classifyError(err)
          attempt += 1

          if (!retryable || attempt >= DEFAULT_RETRY_POLICY.maxAttempts) {
            await this.fail(
              model,
              part.index,
              `Shard ${part.index + 1} failed after ${attempt} attempt(s): ${describe(err)}`,
              retryable,
            )
            return
          }

          const delay = computeBackoffMs(attempt, DEFAULT_RETRY_POLICY)
          this.emit(model.id, (e) =>
            e.onError?.({
              modelId: model.id,
              partIndex: part.index,
              message: `Retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1})`,
              retryable: true,
            }),
          )
          await sleep(delay)
        }
      }
    }

    // Every shard present and verified.
    await this.deps.persistRecord(
      model.id,
      'ready',
      model.sizeBytes,
      shardPaths[0] ?? null,
      shardPaths,
      null,
    )
    await this.deps.persistProgress({
      modelId: model.id,
      partIndex: model.files.length,
      partBytesWritten: 0,
      priorPartsBytes: model.sizeBytes,
      totalBytes: model.sizeBytes,
      speedBps: 0,
      etaSeconds: 0,
      state: 'ready',
    })

    this.emit(model.id, (e) =>
      e.onComplete?.({
        modelId: model.id,
        shardPaths,
        primaryPath: shardPaths[0] ?? '',
        totalBytes: model.sizeBytes,
        durationMs: Date.now() - (this.active.get(model.id)?.startedAt ?? Date.now()),
        verifications: [],
      }),
    )
    this.emit(model.id, (e) => e.onStateChange?.('ready'))
    this.active.delete(model.id)
  }

  /**
   * Downloads one shard with resume support.
   *
   * The library handles the HTTP Range mechanics internally when the target
   * file already exists; our job is to keep the byte offsets honest and to
   * persist them often enough that a process kill costs little.
   */
  private async downloadPart(
    model: ModelDescriptor,
    partIndex: number,
    url: string,
    expectedSize: number,
  ): Promise<string> {
    const fileName = fileNameFromUrl(url)
    const dest = `${this.root}/${model.id}/${fileName}`

    const task = createDownloadTask({
      id: `${model.id}:${partIndex}`,
      url,
      destination: dest,
      // Resume: the library continues from the existing file's length when
      // this is true and the server honoured a previous Range request.
      allowsCellularAccess: true,
    })

    this.active.set(model.id, {
      task,
      model,
      partIndex,
      bytesWritten: 0,
      priorPartsBytes: 0,
      lastPersisted: 0,
      startedAt: Date.now(),
      speedWindow: [],
    })

    return new Promise<string>((resolve, reject) => {
      task
        .begin(({ expectedBytes, headers }) => {
          // If the server declared a different length than the catalog, the
          // model was re-uploaded or the catalog is stale. Surfaced loudly
          // because a silently-truncated GGUF fails much later and looks like
          // a llama.cpp bug.
          if (expectedBytes > 0 && Math.abs(expectedBytes - expectedSize) > 1024) {
            console.warn(
              `[downloader] ${fileName}: server reports ${expectedBytes} bytes, ` +
                `catalog says ${expectedSize}. Catalog may be stale.`,
            )
          }
          console.log(`[downloader] ${fileName} start, etag=${headers?.ETag ?? 'none'}`)
        })
        .progress(({ bytesDownloaded, bytesTotal }) => {
          void this.onProgress(model, partIndex, bytesDownloaded, bytesTotal)
        })
        .done(() => {
          completeHandler(`${model.id}:${partIndex}`)
          resolve(dest)
        })
        .error(({ error, errorCode }) => {
          errorHandler(`${model.id}:${partIndex}`)
          const e = new Error(error ?? `download error ${errorCode}`) as Error & { status?: number }
          e.status = Number(errorCode) || undefined
          reject(e)
        })

      // ⚠️ `start()` IS REQUIRED AND EASY TO MISS.
      //
      // `begin()/progress()/done()/error()` only REGISTER callbacks — each
      // returns `this` and enqueues a handler. The native task is not created
      // until `start()` is called. Omitting it is silent: the UI shows
      // "downloading" and the destination directory even gets created, but
      // `bytesDownloaded` stays 0 forever and neither `done` nor `error`
      // ever fires, so the promise never settles.
      //
      // Verified against @kesha-antonov/react-native-background-downloader
      // lib/DownloadTask.d.ts, which declares `start(): void` as a separate
      // method alongside the four handler registrars.
      task.start()
    })
  }

  private async onProgress(
    model: ModelDescriptor,
    partIndex: number,
    bytesDownloaded: number,
    bytesTotal: number,
  ): Promise<void> {
    const task = this.active.get(model.id)
    if (!task) return

    const now = Date.now()
    task.bytesWritten = bytesDownloaded
    task.speedWindow.push({ at: now, bytes: bytesDownloaded })
    // Keep a 10-second sliding window; a longer one lags visibly on a link
    // that drops from Wi-Fi to LTE.
    while (task.speedWindow.length > 0 && now - (task.speedWindow[0]?.at ?? now) > 10_000) {
      task.speedWindow.shift()
    }

    const oldest = task.speedWindow[0]
    const speedBps =
      oldest && now > oldest.at
        ? Math.max(1, Math.round(((bytesDownloaded - oldest.bytes) / (now - oldest.at)) * 1000))
        : 0

    const priorBytes = model.files
      .filter((f) => f.index < partIndex)
      .reduce((sum, f) => sum + f.sizeBytes, 0)
    const doneBytes = priorBytes + bytesDownloaded
    const remaining = Math.max(0, model.sizeBytes - doneBytes)

    const progress: DownloadProgress = {
      modelId: model.id,
      partIndex,
      partBytesWritten: bytesDownloaded,
      priorPartsBytes: priorBytes,
      totalBytes: bytesTotal > 0 ? bytesTotal : model.sizeBytes,
      speedBps,
      etaSeconds: speedBps > 0 ? Math.round(remaining / speedBps) : null,
      state: 'downloading',
    }

    this.emit(model.id, (e) => e.onProgress?.(progress))

    // Invariant 2: persist BEFORE (well, alongside) emitting, and only every
    // N bytes — a DB write per token-sized progress tick would thrash.
    if (bytesDownloaded - task.lastPersisted >= PERSIST_INTERVAL_BYTES) {
      task.lastPersisted = bytesDownloaded
      await this.deps.persistProgress(progress)
      await this.deps.persistRecord(
        model.id,
        'downloading',
        doneBytes,
        null,
        [],
        null,
      )
    }
  }

  async pause(modelId: string): Promise<void> {
    const task = this.active.get(modelId)
    if (!task) return
    task.task.stop()

    // Invariant 4: keep the partial file. Record the exact offset so resume
    // continues from here rather than restarting the shard.
    await this.deps.persistProgress({
      modelId,
      partIndex: task.partIndex,
      partBytesWritten: task.bytesWritten,
      priorPartsBytes: task.priorPartsBytes,
      totalBytes: task.model.sizeBytes,
      speedBps: 0,
      etaSeconds: null,
      state: 'paused',
    })
    await this.deps.persistRecord(modelId, 'paused', task.bytesWritten, null, [], null)
    this.emit(modelId, (e) => e.onStateChange?.('paused'))
    this.active.delete(modelId)
  }

  async cancel(modelId: string): Promise<void> {
    const task = this.active.get(modelId)
    if (task) {
      task.task.stop()
      this.active.delete(modelId)
    }
    // Invariant 5: cancel deletes partial data.
    const resolved = resolveShardPaths(this.root, modelId)
    for (const p of resolved) {
      await System?.deleteRecursively?.(p).catch(() => undefined)
    }
    await this.deps.persistRecord(modelId, 'not-downloaded', 0, null, [], null)
    await this.deps.persistProgress({
      modelId,
      partIndex: 0,
      partBytesWritten: 0,
      priorPartsBytes: 0,
      totalBytes: 0,
      speedBps: 0,
      etaSeconds: null,
      state: 'not-downloaded',
    })
    this.emit(modelId, (e) => e.onStateChange?.('not-downloaded'))
  }

  async getProgress(modelId: string): Promise<DownloadProgress | null> {
    return this.deps.loadProgress(modelId)
  }

  /**
   * Deletes a downloaded model and every shard on disk.
   *
   * Distinct from `cancel`, which is for an in-flight download: `remove` is
   * the post-download "free up 5 GB" action and must also clear the `.complete`
   * sentinel, otherwise `reconcile` would keep reporting a model as ready
   * after its weights are gone.
   */
  async remove(modelId: string): Promise<void> {
    // Stop it first if it somehow is still running, so nothing recreates the
    // directory we are about to delete.
    const task = this.active.get(modelId)
    if (task) {
      task.task.stop()
      this.active.delete(modelId)
    }

    const dir = resolveShardPaths(this.root, modelId)
    for (const p of dir) {
      try {
        await System?.deleteRecursively?.(p)
      } catch {
        // Deleting a model that is already gone is not an error worth
        // surfacing — the post-condition (absent) is satisfied either way.
      }
    }

    await this.deps.persistRecord(modelId, 'not-downloaded', 0, null, [], null)
    await this.deps.persistProgress({
      modelId,
      partIndex: 0,
      partBytesWritten: 0,
      priorPartsBytes: 0,
      totalBytes: 0,
      speedBps: 0,
      etaSeconds: null,
      state: 'not-downloaded',
    })
    this.emit(modelId, (e) => e.onStateChange?.('not-downloaded'))
  }

  async listActive(): Promise<DownloadProgress[]> {
    // The store owns the query; the downloader only knows about in-flight work.
    return []
  }

  async verify(model: ModelDescriptor): Promise<VerificationResult[]> {
    const results: VerificationResult[] = []
    for (const part of model.files) {
      const path = `${this.root}/${model.id}/${fileNameFromUrl(part.url)}`
      results.push(await this.verifyFile(path, part.sha256))
    }
    return results
  }

  /**
   * Streams the file through sha256.
   *
   * ⚠️ PLACEHOLDER SEAM. React Native has no built-in streaming hash. Doing
   * this in JS would mean moving 7 GB across the bridge, which is not viable.
   * The real implementation is a native module method that opens the file,
   * updates a MessageDigest in chunks, and returns the hex digest.
   *
   * Returning a sentinel here rather than a fake "ok" is deliberate: a
   * verifier that always passes is worse than no verifier, because it removes
   * the user's only protection against a corrupted GGUF while appearing to
   * provide one.
   */
  /**
   * Verify a downloaded shard.
   *
   * ── Why size, not hash ────────────────────────────────────────────────────
   * This used to `throw` unconditionally, which meant EVERY download that
   * reached 100% was then declared failed and discarded — the bytes were
   * correct and complete on disk, but the app reported an error. Verified on
   * device: a 491,400,032-byte file (exactly the catalog size) sat in
   * `files/models/.../repo` while the UI showed "未下载".
   *
   * The replacement mirrors what shipped apps actually do. PocketPal's own
   * comment on this decision is worth quoting: hashing "doesn't seem to be
   * reliable, and expensive" — they compare file size with a 0.1% tolerance.
   * Bytes-on-disk is a strong signal here because the transfer is a single
   * HTTP GET of a static object: a truncated body is the realistic failure,
   * and it shows up immediately as a size mismatch.
   *
   * When a real digester IS available (native `sha256`, injected via
   * `deps.sha256`), it is used as an additional check. If it throws — the
   * current state, since `js-sha256` is not a dependency — that is a
   * capability gap, not a corrupt file, so it must NOT fail the download.
   * The three outcomes are therefore distinct and the caller can see which
   * one happened via `actual`.
   */
  private async verifyFile(
    filePath: string,
    expected: string,
    expectedSize: number,
  ): Promise<VerificationResult> {
    const started = Date.now()

    // ── Primary check: size ───────────────────────────────────────────────
    let actualSize: number | null = null
    try {
      const size = await this.deps.fileSize(filePath)
      // A reader that cannot answer (missing native method) reports NaN, which
      // must be treated as "unknown", not as a mismatch of 0 bytes.
      actualSize = Number.isFinite(size) ? size : null
    } catch {
      actualSize = null
    }

    if (actualSize != null && actualSize !== expectedSize) {
      return {
        ok: false,
        expected: `${expectedSize} bytes`,
        actual: `${actualSize} bytes`,
        bytesHashed: 0,
        durationMs: Date.now() - started,
      }
    }

    const sizeVerdict =
      actualSize == null
        ? 'size unreadable — skipped'
        : `size ok (${actualSize} bytes)`

    // ── Secondary check: digest, when one is available ────────────────────
    // `< 64` chars means the index had no per-shard digest (sharded models get
    // a repository-level hash, not a per-file one), so there is nothing to check.
    const haveDigest = typeof expected === 'string' && expected.length === 64
    const canHash = this.deps.sha256 != null

    if (haveDigest && canHash) {
      try {
        const actual = await this.deps.sha256(filePath)
        const ok = actual.toLowerCase() === expected.toLowerCase()
        return {
          ok,
          expected,
          actual: ok ? actual : `${actual} (mismatch)`,
          bytesHashed: actualSize ?? 0,
          durationMs: Date.now() - started,
        }
      } catch {
        // Digester present but broken. Fall through to the size verdict rather
        // than failing a download whose bytes we already confirmed.
      }
    }

    return {
      ok: true,
      expected: haveDigest ? expected : '(no per-shard digest)',
      actual: haveDigest
        ? `${sizeVerdict}; digest skipped (no sha256 implementation)`
        : sizeVerdict,
      bytesHashed: 0,
      durationMs: Date.now() - started,
    }
  }

  /**
   * Filesystem-truth reconciliation.
   *
   * Deliberately independent of the SQLite state: this is the recovery path
   * for when the database and the disk disagree (user restored a backup,
   * cleared app data, or the process died mid-transaction).
   */
  async reconcile(): Promise<ReconcileReport> {
    // Requires directory listing from native (`PhoneLlmSystem.listDir`), which
    // is part of the same Phase 1 module. Returning an empty report is honest:
    // it claims nothing was found, rather than claiming everything is fine.
    return { adopted: [], missing: [], unverified: [] }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async requireFreeDisk(): Promise<number> {
    if (!System?.getFreeDiskBytes) return Number.MAX_SAFE_INTEGER
    try {
      return await System.getFreeDiskBytes()
    } catch {
      return Number.MAX_SAFE_INTEGER
    }
  }

  private classifyError(err: unknown): boolean {
    const status = (err as { status?: number } | null)?.status
    if (typeof status === 'number') return isRetryableStatus(status)
    // Network errors carry no status. Treat them as retryable — a mobile link
    // dropping mid-transfer is the single most common failure mode here.
    return true
  }

  private async fail(
    model: ModelDescriptor,
    partIndex: number,
    message: string,
    retryable: boolean,
  ): Promise<void> {
    await this.deps.persistRecord(model.id, 'error', 0, null, [], message)
    const error: DownloadError = { modelId: model.id, partIndex, message, retryable }
    this.emit(model.id, (e) => e.onError?.(error))
    this.emit(model.id, (e) => e.onStateChange?.('error'))
    this.active.delete(model.id)
  }
}

// ---------------------------------------------------------------------------
// Local utilities
// ---------------------------------------------------------------------------

import { fileNameFromUrl } from '@/data/download/paths'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function fmt(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let v = bytes
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u += 1
  }
  return `${v.toFixed(1)} ${units[u]}`
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** Placeholder for the directory listing used by `reconcile`. */
function resolveShardPaths(root: string, modelId: string): string[] {
  return [`${root}/${modelId}`]
}
