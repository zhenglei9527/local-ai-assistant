/**
 * Device profile: turn a raw RAM reading into a stable, named tier.
 *
 * WHY THIS IS SEPARATE FROM recommend.ts
 *
 * `recommend.ts` answers "given N GB, which models fit?" — a pure function of
 * one number. This module answers "what KIND of device is this, and therefore
 * what should we default to?" Those are different questions with different
 * failure modes:
 *
 *   - The fit math must be exact and unit-correct (see recommend.ts §UNIT).
 *   - The tiering must be STABLE across the noisy readings real devices report,
 *     and must never round a device up into a tier it cannot survive.
 *
 * THE NOISE PROBLEM
 *
 * A "12GB" phone does not report 12. It reports 12 * 1024^3 = 12.0 GiB, but
 * vendors reserve memory for the GPU/modem/secure world, so `totalMem` commonly
 * lands at 11.2–11.9 GiB. Similarly a "16GB" device reports 15.1–15.7 GiB.
 *
 * A naive `>= 12` check therefore demotes almost every 12GB device to the 8GB
 * tier, and a naive `>= 16` check demotes every 16GB device to the 12 tier.
 * That is a *quality* regression: the user paid for 16GB and gets 12GB-class
 * recommendations.
 *
 * Rounding must also never go the other way. The Asymmetric Band rule below
 * handles both: a reading is promoted to the nominal tier only if it is within
 * `PROMOTION_TOLERANCE`, and demoted otherwise.
 *
 * WHY 12 AND 16 SPECIFICALLY
 *
 * These are the two sizes that matter for the target device (Xiaomi 14 Pro ships
 * as 12GB or 16GB), and they straddle the single most consequential boundary in
 * the whole app: 12GB comfortably runs an 8B model, 16GB additionally fits a
 * 14B. Getting 12-vs-16 wrong changes the recommended download by ~5 GB and
 * roughly doubles first-token latency, which is the difference between a usable
 * app and an unusable one.
 */

import { usableFactor } from '../recommend/recommend.ts'

/** Nominal RAM sizes the app recognises, in GiB. */
export type RamTier = 4 | 6 | 8 | 12 | 16 | 24

/**
 * Nominal tiers, ascending. Ordered because tier resolution walks downward.
 */
export const RAM_TIERS: readonly RamTier[] = [4, 6, 8, 12, 16, 24]

/**
 * How far below a nominal tier a reading may be and still be promoted to it,
 * as an ABSOLUTE allowance in GiB.
 *
 * WHY ABSOLUTE, NOT A PERCENTAGE
 *
 * The Android memory reserve (GPU, modem, secure world) is a roughly FIXED
 * amount of memory — on the order of 0.5–0.8 GiB — not a fraction of RAM. A
 * percentage tolerance therefore misbehaves in both directions:
 *
 *   - At SMALL tiers it is too strict in absolute terms but still wrong in
 *     effect. An 8% band around 8 GiB is 0.64 GiB, yet around 6 GiB it is only
 *     0.48 GiB — smaller than the reserve, so real 6GB devices fell through.
 *   - At LARGE tiers it is too generous. An 8% band around 16 GiB is 1.28 GiB,
 *     which would swallow a 14.75 GiB reading — enough to promote a device that
 *     is genuinely a 14GB-class part into the 16GB tier and hand it a 14B model
 *     it cannot run.
 *
 * A single absolute band handles all tiers identically and matches the physical
 * cause. Measured readings that must promote: 12GB → 11.0–11.9, 16GB → 14.6–15.7.
 * Readings that must NOT promote: 8GB → ≤8, 6GB → ≤6.
 *
 * 1.35 GiB is chosen to cover the observed 16GB spread (down to ~14.7) while
 * staying well clear of the next tier down (12), so the two can never merge.
 */
const PROMOTION_ALLOWANCE_GIB = 1.35

/**
 * Resolve a raw RAM reading (GiB) to a nominal tier.
 *
 * Never returns a tier ABOVE what the device can actually support: the
 * promoted tier is only accepted when the reading is within the allowance, and
 * anything below the smallest tier clamps to the smallest rather than
 * returning null — a device that reports 3.1 GiB is a real device that should
 * still get the smallest model rather than an error screen.
 */
export function resolveRamTier(totalRamGiB: number): RamTier {
  if (!Number.isFinite(totalRamGiB) || totalRamGiB <= 0) {
    // A broken/absent reading must not become a huge tier.
    return RAM_TIERS[0]
  }

  // Walk descending so the first (largest) qualifying tier wins.
  for (let i = RAM_TIERS.length - 1; i >= 0; i -= 1) {
    const nominal = RAM_TIERS[i]
    if (totalRamGiB >= nominal - PROMOTION_ALLOWANCE_GIB) {
      return nominal
    }
  }
  return RAM_TIERS[0]
}

/** How the tier relates to the raw reading — surfaced in diagnostics. */
export type TierConfidence = 'exact' | 'promoted' | 'clamped'

export interface DeviceProfile {
  /** Raw physical RAM as reported, in GiB. */
  readonly totalRamGiB: number
  /** Nominal tier the device is treated as. */
  readonly tier: RamTier
  /** Budget available to the model process, in GiB. */
  readonly budgetGiB: number
  /** Whether the tier was matched, promoted from a low reading, or clamped. */
  readonly confidence: TierConfidence
  /** Largest model parameter count this tier can realistically host. */
  readonly maxParametersB: number
  /** Default context window for this tier. */
  readonly defaultContextLength: number
}

/**
 * Largest parameter count per tier, at a healthy Q4-or-better quantization.
 *
 * These are deliberately conservative and differ from the raw fit math: they
 * encode "what will actually be a good experience", not "what barely loads".
 * A 12GB device CAN load a 14B at Q3_K_M, but the output quality is worse than
 * an 8B at Q5/Q6, so 8B is the ceiling here.
 */
const MAX_PARAMS_BY_TIER: Readonly<Record<RamTier, number>> = {
  4: 1.7,
  6: 4,
  8: 4,
  12: 8,
  16: 14,
  24: 14,
}

/**
 * Default context window per tier.
 *
 * NOT the model's maximum. Verified finding (docs/context-budget-strategy.md):
 * the binding constraint on mobile is prefill TIME, not memory. A 16K-token
 * prompt costs ~13 minutes to first token at 20 tok/s. 8192 is the largest
 * default that keeps first-token latency tolerable, and it is also the largest
 * window that fits an 8GB device alongside a 4B Q6_K (~4.46 GiB of a 5.44 GiB
 * budget — see the corrected KV math in that doc).
 */
const DEFAULT_CONTEXT_BY_TIER: Readonly<Record<RamTier, number>> = {
  4: 4096,
  6: 4096,
  8: 8192,
  12: 8192,
  16: 8192,
  24: 16384,
}

/**
 * Build the device profile from a raw reading.
 *
 * `budgetGiB` comes from the shared `usableFactor` in recommend.ts so the
 * profile and the fit math can never disagree about how much memory is
 * actually available — that divergence was the original OOM bug.
 */
export function buildDeviceProfile(totalRamGiB: number): DeviceProfile {
  const tier = resolveRamTier(totalRamGiB)
  const budgetGiB = round2(tier * usableFactor(tier))

  // Confidence describes the RELATIONSHIP between the raw reading and the tier
  // actually assigned. Order matters: a degenerate reading is 'clamped' even
  // though it also happens to be below the lowest tier, so the degenerate check
  // must come first, otherwise `clamped` is unreachable (the tier would already
  // be the minimum, making `totalRamGiB < tier` true and reporting 'promoted').
  let confidence: TierConfidence = 'exact'
  if (!Number.isFinite(totalRamGiB) || totalRamGiB <= 0 || totalRamGiB < RAM_TIERS[0] - PROMOTION_ALLOWANCE_GIB) {
    confidence = 'clamped'
  } else if (totalRamGiB < tier) {
    confidence = 'promoted'
  }

  return {
    totalRamGiB: Number.isFinite(totalRamGiB) ? round2(totalRamGiB) : 0,
    tier,
    budgetGiB,
    confidence,
    maxParametersB: MAX_PARAMS_BY_TIER[tier],
    defaultContextLength: DEFAULT_CONTEXT_BY_TIER[tier],
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Human-facing summary, used in Settings and in support conversations.
 *
 * Deliberately includes the raw reading next to the tier: when a user reports
 * "it recommended a model too big for my phone", the first question is whether
 * their device reported an unexpected `totalMem`, and that is answerable only
 * if the raw number is visible.
 */
export function describeDeviceProfile(p: DeviceProfile): string {
  const conf =
    p.confidence === 'exact'
      ? 'matched'
      : p.confidence === 'promoted'
        ? 'rounded up to the nominal size'
        : 'below the smallest tier; using minimum'
  return `${p.tier} GB tier (device reported ${p.totalRamGiB} GiB, ${conf}) — budget ${p.budgetGiB} GiB, up to ${p.maxParametersB}B models, ${p.defaultContextLength} context`
}
