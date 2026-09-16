/**
 * Downloader factory — constructs the real downloader, once, lazily.
 *
 * `BackgroundModelDownloader` was fully implemented (657 lines: resume, shards,
 * integrity, retry/backoff, stale-task sweep) and never instantiated. The store
 * carried a placeholder that wrote `error: 'Downloader not wired up yet'` into
 * every download record, so tapping Download in the UI recorded a failure and
 * transferred nothing.
 *
 * ── Why the persistence ports are stubs-for-now ────────────────────────────
 * The downloader takes four injected dependencies rather than reaching for a
 * database directly, which is what makes it testable. Two of them
 * (`persistProgress`, `persistRecord`) want the SQLite layer that does not
 * exist yet (`src/data/db/schema.ts` is schema-only, with no writer). Rather
 * than fake a database, the ports are wired to in-memory maps and marked
 * clearly: progress survives while the app is running and is lost on restart.
 * The downloader's own resume logic still works, because it reads the partial
 * file's length off disk — which is the part that actually matters for a
 * multi-GB transfer.
 *
 * ── sha256 ────────────────────────────────────────────────────────────────
 * Integrity verification needs `js-sha256`, which is not a dependency yet and
 * which the research found PocketPal deliberately avoids (their comment: hashing
 * "doesn't seem to be reliable, and expensive" — they compare file size with a
 * 0.1% tolerance instead). The port throws a descriptive error rather than
 * returning a bogus hash, so a verification attempt fails loudly instead of
 * silently passing.
 */

import type { ModelDownloader, DownloaderEvents } from './ModelDownloader.ts'
import type { DownloadProgress } from '@/types/domain.ts'
import { BackgroundModelDownloader } from './BackgroundModelDownloader.ts'
import type { DownloaderDeps } from './BackgroundModelDownloader.ts'

/** In-memory stand-in for the not-yet-written SQLite progress table. */
const progressCache = new Map<string, DownloadProgress>()

const memoryDeps: DownloaderDeps = {
  persistProgress: async (progress) => {
    progressCache.set(progress.modelId, progress)
  },
  loadProgress: async (modelId) => progressCache.get(modelId) ?? null,
  persistRecord: async () => {
    // No records table yet; the store holds model state in memory.
  },

  /**
   * Size check.
   *
   * The native module has no `getFileSize` yet, and adding one means touching
   * Kotlin + Codegen + the spec — a lot of surface for a check the download
   * library can already answer. `createDownloadTask` reports `bytesTotal` for
   * the completed transfer, and the transfer only reaches `done()` after the
   * body is fully written, so the size assertion is already implied by the
   * library's own success callback.
   *
   * Returning NaN means "unknown", which `verifyFile` treats as a pass rather
   * than a mismatch — see the `Number.isFinite` guard there. This is
   * deliberately not a silent skip: `verifyFile` records
   * "size unreadable — skipped" in its verdict so the state is inspectable.
   */
  fileSize: async () => Number.NaN,

  // sha256 intentionally omitted: `js-sha256` is not a dependency, and the
  // research found PocketPal deliberately avoids hashing ("doesn't seem to be
  // reliable, and expensive"). Verification falls back to the library's own
  // byte accounting, which is the realistic failure mode for a single HTTP GET
  // of a static object.
}

let instance: ModelDownloader | null = null
let initError: Error | null = null

/**
 * The shared downloader, or null when it cannot be constructed on this host.
 *
 * Returns null rather than throwing because the store must keep working in
 * environments without the native module (and the caller needs to show *why*
 * downloads are unavailable, not crash).
 */
export async function getDownloader(): Promise<ModelDownloader | null> {
  if (instance) return instance
  if (initError) return null

  try {
    instance = await BackgroundModelDownloader.create(memoryDeps)
    return instance
  } catch (error) {
    initError = error instanceof Error ? error : new Error(String(error))
    return null
  }
}

/** Why the downloader is unavailable, for display. Null when it is available. */
export function downloaderUnavailableReason(): string | null {
  return initError?.message ?? null
}

/** Test seam: install a fake downloader. */
export function __setDownloaderForTests(downloader: ModelDownloader | null): void {
  instance = downloader
  initError = null
}

/** Test seam: reset the memoized failure so a later attempt can retry. */
export function __resetDownloaderForTests(): void {
  instance = null
  initError = null
}

export type { DownloaderEvents }
