import { Platform } from 'react-native'

import { getPhoneLlmSystem } from '@/specs/phoneLlmSystem'

/**
 * Path resolution for model storage.
 *
 * All model bytes live in the app's **private internal storage**
 * (`context.getFilesDir()`), never on external/shared storage. Reasons:
 *
 *  1. No runtime permission is needed on any supported API level.
 *  2. Other apps cannot read or tamper with the weights (a swapped GGUF is an
 *     arbitrary-code-execution vector in a native parser — treat the model
 *     directory as security-sensitive).
 *  3. It survives app updates and is removed on uninstall, which is the
 *     correct lifecycle for a multi-GB cache.
 *
 * The `filesDir` path is obtained from the native module rather than hardcoded
 * — the absolute path is per-install and per-user (`/data/user/0/<pkg>/files`
 * vs `/data/data/<pkg>/files` on older layouts), so hardcoding it breaks on
 * multi-user devices and on some OEM ROMs.
 */

export interface ModelPathsNativeModule {
  /** Absolute path of `context.getFilesDir()`, no trailing slash. */
  getFilesDir(): Promise<string>
  /** Absolute path of `context.getCacheDir()`, no trailing slash. */
  getCacheDir(): Promise<string>
  getFreeDiskBytes(): Promise<number>
}

export const MODELS_SUBDIR = 'models'
/** Extension of the in-progress file. Kept distinct so a partial is never loaded. */
export const PARTIAL_SUFFIX = '.partial'
/** Sidecar holding the resume offset + validator for a partial file. */
export const PARTIAL_META_SUFFIX = '.partialmeta.json'

/**
 * Root of the models tree, resolved from the native module and memoised.
 *
 * `getModelsRoot(native)` still takes an explicit module argument so tests can
 * inject a fake, but the default app path is `getModelsRootOrThrow()`, which
 * resolves `PhoneLlmSystem` through the spec facade.
 */
let cachedRoot: string | null = null

export async function getModelsRoot(native: ModelPathsNativeModule | null): Promise<string> {
  if (cachedRoot) return cachedRoot
  if (!native) {
    throw new Error(
      'PhoneLlmSystem native module is unavailable; cannot resolve the models directory. ' +
        'Check that PhoneLlmSystemPackage is registered in MainApplication.kt — see ' +
        'docs/native-module.md.',
    )
  }
  const filesDir = await native.getFilesDir()
  cachedRoot = `${filesDir}/${MODELS_SUBDIR}`
  return cachedRoot
}

/**
 * App-facing variant: resolves the native module itself.
 *
 * Kept separate from `getModelsRoot` so the module lookup stays injectable in
 * tests, which cannot import `react-native`.
 */
export async function getModelsRootOrThrow(): Promise<string> {
  return getModelsRoot(getPhoneLlmSystem())
}

/**
 * The native surface used by the downloader, structurally.
 *
 * Note this is a subset of what the spec declares — widening it here would
 * couple the downloader to memory probing it does not need.
 */
export function systemModuleForDownloader(): ModelPathsNativeModule | null {
  return getPhoneLlmSystem()
}

/** Overrides the cached root. Test-only. */
export function __setModelsRootForTests(root: string | null): void {
  cachedRoot = root
}

/**
 * Directory layout:
 *
 *   <filesDir>/models/<modelId>/
 *       <shard-1>.gguf            ← final, verified, loadable
 *       <shard-2>.gguf
 *       <shard-1>.gguf.partial    ← in flight; never handed to llama.rn
 *       <shard-1>.gguf.partialmeta.json
 *       .complete                 ← sentinel: every shard verified
 *
 * The `.complete` sentinel is what makes `reconcile()` cheap and safe: the
 * loader trusts it, and its absence means "scan the parts", not "assume ready".
 */
export function modelDir(root: string, modelId: string): string {
  return `${root}/${sanitizeId(modelId)}`
}

export function finalPath(root: string, modelId: string, fileName: string): string {
  return `${modelDir(root, modelId)}/${fileName}`
}

export function partialPath(root: string, modelId: string, fileName: string): string {
  return `${finalPath(root, modelId, fileName)}${PARTIAL_SUFFIX}`
}

export function partialMetaPath(root: string, modelId: string, fileName: string): string {
  return `${finalPath(root, modelId, fileName)}${PARTIAL_META_SUFFIX}`
}

export function completeSentinelPath(root: string, modelId: string): string {
  return `${modelDir(root, modelId)}/.complete`
}

/** Extracts the file name from a resolve URL, ignoring any query string. */
export function fileNameFromUrl(url: string): string {
  const withoutQuery = url.split('?')[0] ?? url
  const segments = withoutQuery.split('/')
  const last = segments[segments.length - 1]
  if (!last) throw new Error(`Cannot derive a file name from URL: ${url}`)
  return decodeURIComponent(last)
}

/** Model ids come from our own catalog, but they reach the filesystem — keep them tame. */
export function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_')
}

/** Persisted alongside a `.partial` file. */
export interface PartialMeta {
  /** Bytes already written and flushed to the partial file. */
  readonly bytesWritten: number
  /** ETag or Last-Modified from the original response. */
  readonly validator: string | null
  /** Total entity length from the original response, when known. */
  readonly totalBytes: number | null
  readonly url: string
  /** Epoch ms the partial was last written — drives the stale sweep. */
  readonly updatedAt: number
}

/** Partials untouched for this long are swept on boot. */
export const STALE_PARTIAL_MS = 30 * 24 * 60 * 60 * 1000

export function isStalePartial(meta: PartialMeta, now = Date.now()): boolean {
  return now - meta.updatedAt > STALE_PARTIAL_MS
}

export const platformSupportsBackgroundDownloads = Platform.OS === 'android'
