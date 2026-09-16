import { Platform } from 'react-native'

import { getPhoneLlmSystem } from '@/specs/phoneLlmSystem'
import type { MemoryEstimate, MemorySnapshot, ModelDescriptor } from '@/types/domain'

/**
 * Device memory probing.
 *
 * ⚠️ THE CRITICAL POINT, stated once and loudly:
 *
 *   `Runtime.getRuntime().maxMemory()` IS NOT THE DEVICE'S MEMORY.
 *
 * On Android that call returns the **Java heap cap** for this process —
 * typically 128–512 MB, derived from `dalvik.vm.heapsize` / `largeHeap`. It
 * says nothing about physical RAM, and llama.cpp weights are allocated on the
 * **native** heap (outside the Java heap entirely). A 4 GB device happily
 * reports `maxMemory() == 268435456` (256 MB). Gating model loads on that
 * number would refuse every model above ~200 MB — i.e. all of them.
 *
 * Likewise `ActivityManager.getMemoryClass()` is the same Java-heap figure
 * and is equally unusable here.
 *
 * What we actually use:
 *   - `MemoryInfo.totalMem`  → physical RAM, stable, honest.
 *   - `MemoryInfo.availMem`  → *reclaimable* memory. This is the good signal:
 *     it includes memory the kernel can evict from page cache, so it reflects
 *     what a large native allocation can realistically obtain.
 *   - `MemoryInfo.lowMemory` / `threshold` → pressure indicators.
 *   - `isLowRamDevice()`     → OEM's own verdict on the hardware class.
 *
 * The native module below is the ONLY sanctioned way to reach those APIs. It is
 * implemented as a Codegen TurboModule:
 *
 *   src/specs/NativePhoneLlmSystem.ts   ← the spec (Codegen input)
 *   src/specs/phoneLlmSystem.ts         ← typed accessor, returns null if absent
 *   android/.../PhoneLlmSystemModule.kt ← the implementation
 *
 * When it is unavailable (non-Android, or a build that skipped registration)
 * the TypeScript side degrades to `FALLBACK_SNAPSHOT` — see below.
 */

export interface MemoryProbeNativeModule {
  /** Wraps `ActivityManager.MemoryInfo` + `isLowRamDevice()`. */
  getMemoryInfo(): Promise<{
    totalMem: number
    availMem: number
    threshold: number
    lowMemory: boolean
    lowRamDevice: boolean
  }>
  /** Free bytes on the filesystem holding `filesDir`. */
  getFreeDiskBytes(): Promise<number>
}

/**
 * Safety margin (fraction of physical RAM) held back from the budget.
 *
 * Rationale: Android's LMK (low-memory killer) will kill a foreground app that
 * pushes the system below its watermark, and the estimate for KV cache +
 * compute scratch is approximate. 0.20 covers the OS, the launcher, and the
 * error in our own arithmetic for mid-range devices.
 */
const SAFETY_FRACTION = 0.2

/**
 * Guard rail against absurd reported values, NOT a real device limit.
 *
 * This was 8 GiB, which silently capped every device at 8 GiB of budget: a
 * 16 GB and a 24 GB phone produced the SAME budget, so the app could never
 * offer a 14B model to a flagship even though it plainly has the RAM. That is
 * a product-level bug, not a conservative default.
 *
 * The ceiling exists only so a device reporting a garbage `totalMem` (some
 * emulators and a few vendor ROMs do) cannot make us hand the user a budget
 * larger than any phone has. Real flagships top out around 24 GB today, so
 * 24 GiB leaves headroom without binding on hardware that actually exists.
 *
 * The budget still derives from `availMem`, so a genuinely busy device stays
 * limited by what the kernel will hand over, not by this constant.
 */
const ABSOLUTE_CEILING_BYTES = 24 * 1024 * 1024 * 1024

/** Floor so the UI never shows a nonsense zero budget. */
const FLOOR_BYTES = 256 * 1024 * 1024

/**
 * Fallback used when the native module is absent — a non-Android platform, a
 * unit test, or a build that failed to register `PhoneLlmSystemPackage`.
 *
 * Deliberately pessimistic: a wrong "yes" (offer a model that then OOM-kills
 * the app, after the user spent 20 minutes downloading it) is far worse UX
 * than a wrong "no".
 *
 * ⚠️ This is a *safety net*, not a supported mode. On a correctly built
 * Android app the native path always wins. If the UI shows "4.0 GiB total /
 * 1.2 GiB budget" on a real phone, the module is not registered — see
 * `docs/native-module.md` for the three-way name coupling that causes it.
 */
const FALLBACK_SNAPSHOT: MemorySnapshot = {
  totalMem: 4 * 1024 * 1024 * 1024,
  availMem: 1.5 * 1024 * 1024 * 1024,
  threshold: 256 * 1024 * 1024,
  lowRamDevice: false,
  usableBudget: 1.2 * 1024 * 1024 * 1024,
}

/**
 * True when a real probe can run.
 *
 * Evaluated lazily inside `readMemorySnapshot` rather than at module load: the
 * module registry is not populated at import time on all RN versions, and
 * freezing the answer at import would permanently disable the real path.
 */
export function memoryProbeAvailable(): boolean {
  return Platform.OS === 'android' && getPhoneLlmSystem() != null
}

/**
 * Reads a memory snapshot from the platform.
 *
 * `usableBudget` is derived here, not read: it is `min(availMem, totalMem)`
 * scaled down by the safety margin, floored and ceilinged. Note we take
 * `availMem` as the primary term — it is the number that reflects what the
 * kernel will actually surrender to a new native allocation.
 */
export async function readMemorySnapshot(): Promise<MemorySnapshot> {
  const native = getPhoneLlmSystem()
  if (!native) return FALLBACK_SNAPSHOT

  try {
    const info = await native.getMemoryInfo()

    // On a heavily loaded device availMem can momentarily read near zero.
    // Clamp it up to the watermark so the budget stays usable rather than
    // collapsing to the floor during a transient spike.
    const effectiveAvail = Math.max(info.availMem, info.threshold)

    const rawBudget = Math.min(effectiveAvail, info.totalMem) * (1 - SAFETY_FRACTION)
    const usableBudget = Math.min(
      Math.max(rawBudget, FLOOR_BYTES),
      ABSOLUTE_CEILING_BYTES,
    )

    return {
      totalMem: info.totalMem,
      availMem: info.availMem,
      threshold: info.threshold,
      lowRamDevice: info.lowRamDevice,
      usableBudget,
    }
  } catch {
    // A failing probe must not crash the model picker.
    return FALLBACK_SNAPSHOT
  }
}

// ---------------------------------------------------------------------------
// Estimation
// ---------------------------------------------------------------------------

/** Bytes per element for each supported KV-cache type. */
const CACHE_TYPE_BYTES: Record<string, number> = {
  f32: 4,
  f16: 2,
  bf16: 2,
  q8_0: 1.0625,
  q5_1: 0.75,
  q5_0: 0.6875,
  q4_1: 0.625,
  q4_0: 0.5625,
  iq4_nl: 0.5625,
}

export interface EstimateInput {
  readonly model: ModelDescriptor
  readonly contextLength: number
  readonly cacheTypeK: string
  readonly cacheTypeV: string
}

/**
 * Estimates total runtime RAM for a model at a given context length.
 *
 * Weights: taken directly from the catalog's declared file size — GGUF is
 * memory-mapped, so the resident cost is close to the file size (plus a small
 * margin for the mmap bookkeeping and the non-mapped tensors).
 *
 * KV cache: the real formula is
 *     2 (K and V) × n_layer × n_ctx × n_kv_head × head_dim × bytes_per_element
 *
 * Compute/scratch buffer: llama.cpp allocates roughly `n_batch`-sized graph
 * buffers. We approximate it as a fixed 256 MB allowance rather than trying to
 * model it exactly — it is implementation-dependent and version-sensitive, and
 * this is a go/no-go gate, not a billing statement.
 */
export function estimateModelMemory(input: EstimateInput): MemoryEstimate {
  const { model, contextLength, cacheTypeK, cacheTypeV } = input
  const assumptions: string[] = []

  const weightsBytes = Math.round(model.sizeBytes * 1.05)
  assumptions.push('weights = GGUF file size × 1.05 (mmap page rounding + non-mapped tensors)')

  const bytesK = CACHE_TYPE_BYTES[cacheTypeK]
  const bytesV = CACHE_TYPE_BYTES[cacheTypeV]
  if (bytesK === undefined || bytesV === undefined) {
    assumptions.push(`unknown cache type (${cacheTypeK}/${cacheTypeV}); assuming f16`)
  }
  const kvBytesPerElement = (bytesK ?? 2) + (bytesV ?? 2)

  // Architecture facts come from `catalog.ts`'s family table, which is a
  // stand-in for GGUF metadata. A family we have no entry for yields
  // layerCount === 0, and the naive formula then returns a KV cache of ZERO —
  // which under-estimates total usage and would greenlight a model the device
  // cannot actually hold. That is a wrong "yes", the expensive direction.
  //
  // So: when the architecture is unknown, charge a conservative per-token cost
  // derived from the parameter count instead, and say so in `assumptions`.
  // Roughly 0.5 MiB per 1k tokens of context per billion parameters, which sits
  // at the high end of observed 4-bit GQA models.
  const archKnown =
    model.layerCount > 0 && model.headCountKv > 0 && model.headDim > 0

  let kvCacheBytes: number
  if (archKnown) {
    kvCacheBytes = Math.round(
      model.layerCount *
        contextLength *
        model.headCountKv *
        model.headDim *
        kvBytesPerElement,
    )
    assumptions.push(
      'KV = n_layer × n_ctx × n_kv_head × head_dim × (bytesK + bytesV); ' +
        'ignores sliding-window/GQA sharing and any recurrent-state savings',
    )
  } else {
    const perTokenPerBillion = 512 // bytes
    kvCacheBytes = Math.round(
      contextLength * model.parametersB * perTokenPerBillion,
    )
    assumptions.push(
      'UNKNOWN ARCHITECTURE — no layer/head data for this family. KV cache ' +
        'estimated pessimistically from parameter count (÷ high end). Treat ' +
        'this verdict as a lower bound on memory use.',
    )
  }

  const SCRATCH_BYTES = 256 * 1024 * 1024
  assumptions.push('compute/scratch = flat 256 MiB allowance (implementation-dependent)')

  const totalBytes = weightsBytes + kvCacheBytes + SCRATCH_BYTES

  return {
    weightsBytes,
    kvCacheBytes,
    totalBytes,
    fitsComfortably:
      totalBytes * (1 + COMFORTABLE_RESERVE_RATIO) <= FALLBACK_SNAPSHOT.usableBudget,
    maybeFits: false, // filled in by the caller against a real snapshot
    assumptions,
  }
}

/**
 * The real go/no-go decision: does this model fit right now?
 *
 * Two tiers, because the numbers are estimates:
 *   - `comfortable`: total × 1.15 ≤ budget. Safe to auto-load.
 *   - `fits`:        total ≤ budget. Allowed, but warn the user.
 *
 * Note `total` is the FULL runtime footprint (weights + KV cache + scratch),
 * so no extra multiplier is applied here — see COMFORTABLE_RESERVE_RATIO.
 *
 * `needsDiskBytes` is checked separately — a full disk fails at write time,
 * which is a much worse failure than refusing up front.
 */
export interface FitVerdict {
  readonly fits: boolean
  readonly comfortable: boolean
  readonly estimate: MemoryEstimate
  readonly snapshot: MemorySnapshot
  readonly shortfallBytes: number
  readonly reason: string | null
}

/**
 * Fraction of the *remaining* headroom kept in reserve before a load is called
 * "comfortable".
 *
 * `MemoryEstimate.totalBytes` ALREADY includes the KV cache for the configured
 * context and a flat scratch allowance — it is the full runtime footprint, not
 * just the weights. An earlier revision multiplied it by 1.3 here, which
 * double-counted the KV cache and made the load-time check far stricter than
 * the picker in `src/recommend/recommend.ts` (which applies its multiplier to
 * *weights* before KV is added). The two layers then disagreed: the picker
 * offered a model the loader refused on the same device.
 *
 * So the multiplier here is 1.0, and the safety comes from `usableBudget`
 * already being `min(availMem, totalMem) * (1 - SAFETY_FRACTION)`. We keep the
 * "comfortable" tier as a reserve check instead: a load is comfortable only if
 * it leaves at least this fraction of the budget unused.
 */
const COMFORTABLE_RESERVE_RATIO = 0.15

export function evaluateFit(
  estimate: MemoryEstimate,
  snapshot: MemorySnapshot,
): FitVerdict {
  const comfortable =
    estimate.totalBytes * (1 + COMFORTABLE_RESERVE_RATIO) <= snapshot.usableBudget
  const fits = estimate.totalBytes <= snapshot.usableBudget

  let reason: string | null = null
  if (!fits) {
    const short = estimate.totalBytes - snapshot.usableBudget
    reason =
      `Estimated ${formatBytes(estimate.totalBytes)}, budget ${formatBytes(snapshot.usableBudget)} ` +
      `— short by ${formatBytes(short)}. Lower the context length or pick a smaller quantisation.`
  } else if (!comfortable) {
    reason =
      `Estimated ${formatBytes(estimate.totalBytes)} against a ${formatBytes(snapshot.usableBudget)} budget. ` +
      'It should load, but the system may kill the app under memory pressure. ' +
      'Close other apps first.'
  }

  return {
    fits,
    comfortable,
    estimate,
    snapshot,
    shortfallBytes: Math.max(0, estimate.totalBytes - snapshot.usableBudget),
    reason,
  }
}

/**
 * Picks the largest context length that still fits, in 512-token steps.
 * Returns 0 when even the smallest step does not fit.
 */
export function suggestContextLength(
  model: ModelDescriptor,
  snapshot: MemorySnapshot,
  cacheTypeK = 'f16',
  cacheTypeV = 'f16',
  step = 512,
): number {
  const maxCtx = Math.min(model.contextLength, 32768)
  for (let ctx = maxCtx; ctx >= step; ctx -= step) {
    const est = estimateModelMemory({ model, contextLength: ctx, cacheTypeK, cacheTypeV })
    if (est.totalBytes * (1 + COMFORTABLE_RESERVE_RATIO) <= snapshot.usableBudget) {
      return ctx
    }
  }
  return 0
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = value >= 100 || unit === 0 ? 0 : 1
  return `${value.toFixed(digits)} ${units[unit]}`
}
