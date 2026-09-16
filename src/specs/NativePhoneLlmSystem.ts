/**
 * TurboModule Codegen specification for `PhoneLlmSystem`.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * This project runs React Native 0.83.1 with the New Architecture forced on
 * (`newArchEnabled=true` in `android/gradle.properties`), because llama.rn
 * >= 0.10 requires it. Under the New Architecture, a *legacy*
 * `ReactContextBaseJavaModule` reached through `NativeModules.PhoneLlmSystem`
 * still works — but only via the interop layer, which needs the module to be
 * registered through `ReactPackage`. A TurboModule (Codegen) spec is the
 * first-class path: the codegen step generates `NativePhoneLlmSystemSpec.java`
 * from this file, and the Kotlin module extends that generated class.
 *
 * THE THREE-WAY NAME COUPLING — this is the part that silently breaks:
 *
 *   1. This file MUST be named `NativePhoneLlmSystem.ts` (prefix `Native`,
 *      matching `PhoneLlmSystem`). Codegen derives the module name from the
 *      file name by stripping the `Native` prefix.
 *   2. `getName()` in `PhoneLlmSystemModule.kt` MUST return `"PhoneLlmSystem"`.
 *   3. The first argument of `TurboModuleRegistry.getEnforcing(...)` /
 *      `get(...)` below MUST be `'PhoneLlmSystem'`.
 *
 * All three must agree exactly. A mismatch is not a compile error on either
 * side — it surfaces at runtime as `TurboModuleRegistry.getEnforcing():
 * 'PhoneLlmSystem' could not be found`, or as a silently `null` module.
 *
 * ⚠️ `getEnforcing` vs `get`: see `src/specs/phoneLlmSystem.ts` (the typed
 * facade) for why the app deliberately uses the non-throwing `get`. Short
 * version: `memoryProbe.ts` has a documented conservative fallback and must
 * keep working on iOS and in tests, where no Android implementation exists. A
 * hard `getEnforcing` there would turn a soft degradation into a crash.
 *
 * ⚠️ WHAT CODEGEN ACCEPTS HERE: only the TurboModule schema subset — `number`,
 * `string`, `boolean`, nullable variants, arrays, and object literal types
 * whose members are themselves primitives. `Promise<T>` returns are supported
 * and map to a Kotlin `Promise` parameter. No imports, no generics, no enums,
 * no unions in this file, or codegen will reject it at build time.
 */

import type { TurboModule } from 'react-native'
import { TurboModuleRegistry } from 'react-native'

/**
 * Shape returned by `getMemoryInfo()`.
 *
 * Every byte count is a `number` (an IEEE-754 double by the time it reaches
 * JS). This is load-bearing on the native side: the Kotlin module must use
 * `putDouble`, never `putInt`, because `putInt` overflows at 2 GiB and a 4+ GiB
 * device would report a negative or wrapped `totalMem`.
 */
export interface MemoryInfoResult {
  /** Physical RAM in bytes (`ActivityManager.MemoryInfo.totalMem`). */
  totalMem: number
  /**
   * Reclaimable memory in bytes (`MemoryInfo.availMem`).
   *
   * This — not `totalMem` — is the number that predicts whether a large native
   * allocation will succeed, because it includes evictable page cache.
   */
  availMem: number
  /** Low-memory watermark in bytes (`MemoryInfo.threshold`). */
  threshold: number
  /** Kernel's current memory-pressure verdict (`MemoryInfo.lowMemory`). */
  lowMemory: boolean
  /** OEM's own hardware-class verdict (`ActivityManager.isLowRamDevice`). */
  lowRamDevice: boolean
}

/** One entry from `listDir()`. */
export interface DirEntry {
  name: string
  /** Absolute path, so callers do not have to re-join and risk a mismatch. */
  path: string
  isDirectory: boolean
  /** Bytes for a file; `-1` for a directory. */
  size: number
  /** Epoch ms, used to detect a file still being written. */
  modifiedAt: number
}

export interface Spec extends TurboModule {
  /**
   * Reads the current `ActivityManager.MemoryInfo`.
   *
   * Deliberately NOT cached at app start: the entire point is to observe
   * pressure at the moment a multi-GB load is about to happen, and a snapshot
   * taken at launch is stale exactly when it matters.
   */
  getMemoryInfo(): Promise<MemoryInfoResult>

  /** Free bytes on the volume holding app-private storage. */
  getFreeDiskBytes(): Promise<number>

  /** Absolute path of `context.getFilesDir()`, no trailing slash. */
  getFilesDir(): Promise<string>

  /** Absolute path of `context.getCacheDir()`, no trailing slash. */
  getCacheDir(): Promise<string>

  /** Creates a directory (and parents) under app-private storage. */
  ensureDir(relativePath: string): Promise<boolean>

  /** Deletes a path recursively, guarded against escaping app storage. */
  deleteRecursively(relativePath: string): Promise<boolean>

  /**
   * Lists an immediate child directory.
   *
   * Exists so completed downloads can be re-adopted after a restart — without
   * it, download state is memory-only and every relaunch shows finished models
   * as "未下载". Resolves to an empty array when the directory is absent
   * (normal on a fresh install) rather than rejecting.
   */
  listDir(relativePath: string): Promise<DirEntry[]>

  /** Byte size of a file under app storage; `-1` when it does not exist. */
  getFileSize(absolutePath: string): Promise<number>

  /**
   * Reads a UTF-8 text file under app storage, or `null` if absent.
   *
   * Added for settings persistence: there was none at all, so the cloud API
   * key, endpoint URL and system prompt were lost on every restart.
   */
  readTextFile(relativePath: string): Promise<string | null>

  /** Writes a UTF-8 text file under app storage (atomically). */
  writeTextFile(relativePath: string, contents: string): Promise<boolean>
}

export default TurboModuleRegistry.get<Spec>('PhoneLlmSystem')
