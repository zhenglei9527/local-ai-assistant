/**
 * Typed accessor for the `PhoneLlmSystem` native module.
 *
 * This is the single import site for the native module across the app. It
 * exists so the callers never touch `react-native`'s module plumbing directly
 * and so there is exactly one place where "the module is missing" is decided.
 *
 * WHY NOT `TurboModuleRegistry.getEnforcing`
 * ------------------------------------------
 * `getEnforcing` throws when the module is absent. Two realities make that the
 * wrong choice here:
 *
 *   1. Every consumer in this app has a documented fallback. `memoryProbe.ts`
 *      degrades to a conservative snapshot; `paths.ts` throws a *specific*,
 *      actionable error naming this module. Turning those into an opaque
 *      crash-at-import would be a regression in diagnosability.
 *   2. The module is Android-only. On iOS (and under `node:test`, which is how
 *      this project runs its suite) there is no implementation at all, and
 *      importing must not be fatal.
 *
 * So we use the non-throwing `get`, which is why the spec's default export in
 * `NativePhoneLlmSystem.ts` is `TurboModuleRegistry.get<Spec>(...)`.
 *
 * WHY THE `NativeModules` FALLBACK BRANCH
 * ---------------------------------------
 * Under the New Architecture with `newArchEnabled=true`, `TurboModuleRegistry.get`
 * is the correct and sufficient path — Codegen generates
 * `NativePhoneLlmSystemSpec` and the registered Kotlin module satisfies it.
 *
 * The `NativeModules.PhoneLlmSystem` lookup is kept as a *second* attempt
 * because it is the only path that still resolves if the codegen step is
 * skipped (e.g. someone builds without `codegenConfig`, or the generated spec
 * is excluded from the build). In that situation `TurboModuleRegistry.get`
 * returns `null` while the module is in fact registered and working. Reading
 * the legacy registry costs one property access and turns a silent
 * "module missing" degradation back into a working probe.
 *
 * The shape is asserted structurally at the call site rather than trusted:
 * `isPhoneLlmSystem()` checks for the methods that are actually used.
 */

import { NativeModules } from 'react-native'

import NativePhoneLlmSystem, { type MemoryInfoResult, type Spec } from './NativePhoneLlmSystem'

export type { MemoryInfoResult }

/** The surface the JS layer actually depends on. */
export type PhoneLlmSystemModule = Spec

/**
 * Structural check.
 *
 * A module that resolves but is missing `getMemoryInfo` is worse than no
 * module at all: the caller would get `undefined is not a function` deep
 * inside the probe instead of a clean fallback. Type assertions in TypeScript
 * do not survive into runtime, so the check has to be explicit.
 */
function isPhoneLlmSystem(candidate: unknown): candidate is PhoneLlmSystemModule {
  if (candidate == null || typeof candidate !== 'object') return false
  const m = candidate as Record<string, unknown>
  return (
    typeof m.getMemoryInfo === 'function' &&
    typeof m.getFreeDiskBytes === 'function' &&
    typeof m.getFilesDir === 'function' &&
    typeof m.getCacheDir === 'function' &&
    typeof m.ensureDir === 'function' &&
    typeof m.deleteRecursively === 'function'
  )
}

/**
 * Resolves the module once, at first use.
 *
 * `TurboModuleRegistry.get` itself throws if the module was registered but is
 * malformed, so both lookups are wrapped. A throw here must not take down the
 * caller that has a fallback.
 */
function resolve(): PhoneLlmSystemModule | null {
  try {
    if (isPhoneLlmSystem(NativePhoneLlmSystem)) return NativePhoneLlmSystem
  } catch {
    // Fall through to the legacy registry.
  }

  try {
    const legacy = NativeModules.PhoneLlmSystem as unknown
    if (isPhoneLlmSystem(legacy)) return legacy
  } catch {
    // Neither registry has it.
  }

  return null
}

let cached: PhoneLlmSystemModule | null | undefined

/**
 * Returns the native module, or `null` when it is genuinely unavailable.
 *
 * The result is cached including the `null` case: the module registry cannot
 * become populated later in a process, so re-probing on every call is pure
 * overhead on a path that runs before a multi-GB model load.
 */
export function getPhoneLlmSystem(): PhoneLlmSystemModule | null {
  if (cached === undefined) cached = resolve()
  return cached
}

/** True when the native module is present and structurally usable. */
export function isPhoneLlmSystemAvailable(): boolean {
  return getPhoneLlmSystem() != null
}

/** Test-only: clears the memoised resolution. */
export function __resetPhoneLlmSystemForTests(): void {
  cached = undefined
}
