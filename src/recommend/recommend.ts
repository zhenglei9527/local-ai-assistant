/**
 * Memory-aware model recommendation.
 *
 * Fixes the bug in the auto-generated `memoryTiers` field of
 * data/models-official.json, which compared a model's RAM need against the
 * device's PHYSICAL memory instead of its USABLE memory, causing recommendations
 * that OOM on real hardware (e.g. Qwen3-8B on an 8GB phone).
 *
 * See docs/tier-recommendation-fix.md for the full analysis.
 */

/**
 * UNIT DISCIPLINE — read before touching this file.
 *
 * The catalog exposes the same file size three ways, and they disagree:
 *
 *   sizeBytes  2497280256        authoritative, exact
 *   sizeGiB    2.33              = bytes / 1024^3   <- the one to use
 *   sizeGB     2.5               = bytes / 1e9, rounded to 1 decimal
 *
 * `sizeGB` is a *display* field: it is decimal AND rounded, so it overstates a
 * 4B model by ~7.3%. Physical RAM is conventionally GiB (an "8GB" phone reports
 * 8 * 1024^3 bytes). Comparing the rounded decimal field against a GiB budget
 * is a silent error large enough to flip a borderline decision.
 *
 * Everything internal to this module is GiB. `modelSizeGiB()` derives the value
 * from `sizeBytes` so precision is never lost.
 */

const BYTES_PER_GiB = 1024 ** 3;

/** Weight size in GiB, derived from the exact byte count. */
export function modelSizeGiB(model: ModelEntry): number {
  if (model.sizeBytes && model.sizeBytes > 0) {
    return model.sizeBytes / BYTES_PER_GiB;
  }
  // Defensive fallback for hand-authored entries with no byte count.
  return model.sizeGiB ?? model.sizeGB ?? 0;
}

/** A single downloadable model entry, as produced by the catalog builder. */
export interface ModelEntry {
  id: string;
  displayName: string;
  family: string;
  parametersB: number;
  activeParamsB: number;
  quantization: string;
  /** Exact size in bytes. Preferred source for all calculations. */
  sizeBytes: number;
  /** Size in GiB (bytes / 1024^3). */
  sizeGiB: number;
  /** Size in decimal GB (bytes / 1e9), rounded. Display only — do not compute with. */
  sizeGB: number;
  minRamGB: number;
  recommendedRamGB: number;
  isSharded: boolean;
  shardCount: number;
  sha256: string | null;
}

export type FitLevel = 'GOOD' | 'TIGHT' | 'NO';

export interface Recommendation {
  model: ModelEntry;
  /** Budget actually available to the model process, in GB. */
  budgetGB: number;
  /** Estimated runtime footprint (weights x runtime factor), in GB. */
  runtimeGB: number;
  /** budgetGB - runtimeGB. Negative means it does not fit. */
  headroomGB: number;
  fit: FitLevel;
}

export interface RecommendOptions {
  /** Total physical RAM reported by the OS, in GB. */
  totalRamGB: number;
  /**
   * Context length used for the KV-cache estimate. Longer context costs more
   * memory. Defaults to 4096.
   */
  contextLength?: number;
  /** Minimum parametersB to consider; used to skip tiny fallback models. */
  minParametersB?: number;
}

/** Fraction of physical RAM actually usable by the model process. */
const USABLE_FACTORS: ReadonlyArray<readonly [number, number]> = [
  [4, 0.6],
  [6, 0.65],
  [8, 0.68],
  [Infinity, 0.7],
];

/** Runtime footprint multiplier relative to the on-disk weight size. */
const RUNTIME_FACTORS: ReadonlyArray<readonly [number, number]> = [
  [2048, 1.15],
  [4096, 1.25],
  [8192, 1.4],
];

const DEFAULT_CONTEXT = 4096;
const DEFAULT_RUNTIME_FACTOR = 1.3;

/** Android will reclaim the process long before memory is truly exhausted. */
const TIGHT_HEADROOM_RATIO = 0.25;

export function usableFactor(totalRamGB: number): number {
  for (const [threshold, factor] of USABLE_FACTORS) {
    if (totalRamGB <= threshold) return factor;
  }
  return USABLE_FACTORS[USABLE_FACTORS.length - 1][1];
}

export function runtimeFactor(contextLength: number): number {
  for (const [threshold, factor] of RUNTIME_FACTORS) {
    if (contextLength <= threshold) return factor;
  }
  // Interpolate beyond 8K: KV cache scales roughly linearly with context.
  return 1.4 * (contextLength / 8192);
}

/** Budget in GB available to the model process on this device. */
export function deviceBudgetGB(totalRamGB: number): number {
  return round2(totalRamGB * usableFactor(totalRamGB));
}

/** Estimated runtime footprint of a model in GiB, including KV cache. */
export function runtimeCostGB(model: ModelEntry, contextLength = DEFAULT_CONTEXT): number {
  const factor =
    contextLength === DEFAULT_CONTEXT
      ? DEFAULT_RUNTIME_FACTOR
      : runtimeFactor(contextLength);
  return round2(modelSizeGiB(model) * factor);
}

function classify(headroomGB: number, budgetGB: number): FitLevel {
  if (headroomGB < 0) return 'NO';
  if (headroomGB < budgetGB * TIGHT_HEADROOM_RATIO) return 'TIGHT';
  return 'GOOD';
}

/** Score every model against the device budget. */
export function evaluateModels(
  models: readonly ModelEntry[],
  options: RecommendOptions,
): Recommendation[] {
  const { totalRamGB, contextLength = DEFAULT_CONTEXT } = options;
  const budgetGB = deviceBudgetGB(totalRamGB);

  return models.map((model) => {
    const runtimeGB = runtimeCostGB(model, contextLength);
    const headroomGB = round2(budgetGB - runtimeGB);
    return {
      model,
      budgetGB,
      runtimeGB,
      headroomGB,
      fit: classify(headroomGB, budgetGB),
    };
  });
}

/**
 * Effective bits per weight for each quantization, used to judge whether a
 * quant is aggressive enough to have damaged the model.
 */
const QUANT_BITS: Readonly<Record<string, number>> = {
  FP16: 16,
  Q8_0: 8.5,
  Q6_K: 6.56,
  Q5_K_M: 5.5,
  Q5_0: 5.5,
  Q4_K_M: 4.85,
  Q4_0: 4.5,
  Q3_K_M: 3.91,
  Q2_K: 2.63,
};

/**
 * Quantizations below this many bits per weight measurably degrade output
 * quality (and, for chat/roleplay, coherence). These are still allowed as a
 * last resort on very small devices, but never chosen over a smaller,
 * better-quantized model.
 *
 * The floor is 4.0 bits/weight, i.e. Q4-class and above. Q3_K_M (3.91) sits
 * just under it deliberately: a 7B at Q3_K_M does fit an 8GB phone, but it is
 * a poor trade against a 4B at Q4_K_M — the smaller model is more coherent,
 * loads faster, and leaves headroom for a longer context window, which matters
 * far more for roleplay than raw parameter count. Users who explicitly want the
 * bigger-but-degraded model can still pick it from the full model list.
 */
const MIN_HEALTHY_BITS = 4.0;

export function quantBits(quantization: string): number {
  return QUANT_BITS[quantization] ?? 4.5;
}

/**
 * Pick the best model for this device.
 *
 * Two rules matter, and both are easy to get wrong:
 *
 * 1. A model's *runtime* footprint must fit the device's *usable* budget (not
 *    its physical RAM). The catalog's `memoryTiers` compared against physical
 *    RAM and so recommended an 8B model to 8GB phones, which OOMs.
 * 2. Do NOT simply maximise parameter count. A 7B at Q2_K fits an 8GB phone
 *    on paper but produces worse output than a 4B at Q4_K_M, so parameter
 *    count alone would silently degrade quality for every user.
 *
 * So: prefer the largest well-quantized model that fits, and only fall back to
 * damaged quantizations when nothing healthy fits.
 */
export function recommendModel(
  models: readonly ModelEntry[],
  options: RecommendOptions,
): Recommendation | null {
  const { minParametersB = 0 } = options;
  const evaluated = evaluateModels(models, options);
  const budgetGB = deviceBudgetGB(options.totalRamGB);

  const fitting = evaluated.filter(
    (r) => r.fit !== 'NO' && r.model.parametersB >= minParametersB,
  );

  if (fitting.length === 0) {
    // Nothing fits: fall back to the smallest model so the user still has a
    // working (if slow) chat rather than an empty screen.
    const smallest = evaluated
      .filter((r) => r.model.parametersB >= minParametersB)
      .sort((a, b) => modelSizeGiB(a.model) - modelSizeGiB(b.model))[0];
    return smallest ?? null;
  }

  const healthy = fitting.filter(
    (r) => quantBits(r.model.quantization) >= MIN_HEALTHY_BITS,
  );
  const pool = healthy.length > 0 ? healthy : fitting;

  // Group by parameter count so a family is judged as a unit, then walk down
  // from the largest until one offers a viable quantization.
  const byParams = new Map<number, Recommendation[]>();
  for (const rec of pool) {
    const key = rec.model.parametersB;
    const list = byParams.get(key);
    if (list) list.push(rec);
    else byParams.set(key, [rec]);
  }

  const sizes = [...byParams.keys()].sort((a, b) => b - a);
  for (const size of sizes) {
    const candidates = byParams.get(size)!;
    const comfortable = candidates.filter(
      (r) => r.headroomGB >= budgetGB * MIN_HEADROOM_RATIO,
    );
    // Accept this size only if some quantization leaves a safe margin.
    if (comfortable.length > 0) {
      return pickQuantization(comfortable, budgetGB, MIN_HEADROOM_RATIO);
    }
  }

  // Nothing has comfortable headroom: take the largest size available and let
  // it run tight (the UI will surface a warning).
  const largest = byParams.get(sizes[0])!;
  return pickQuantization(largest, budgetGB, MIN_HEADROOM_RATIO);
}

/**
 * Rank candidates best-first.
 *
 * Maximising parameters first, then quantization, is wrong on its own: it
 * greedily consumes the budget and can leave almost no headroom (measured as
 * low as 0.02GB on a 4GB device), which OOMs in practice because the OS
 * reclaims memory unpredictably. Instead, prefer the largest parameter count
 * whose best-fitting quantization still leaves a healthy margin, and only then
 * take the highest-fidelity quant within that parameter count.
 */
function compareByQuality(a: Recommendation, b: Recommendation): number {
  if (b.model.parametersB !== a.model.parametersB) {
    return b.model.parametersB - a.model.parametersB;
  }
  const bits = quantBits(b.model.quantization) - quantBits(a.model.quantization);
  if (bits !== 0) return bits;
  return b.headroomGB - a.headroomGB;
}

/**
 * Pick the single quantization to recommend for a given model family: the
 * highest-fidelity one that fits while keeping at least `minHeadroomRatio` of
 * the budget free.
 */
function pickQuantization(
  candidates: readonly Recommendation[],
  budgetGB: number,
  minHeadroomRatio: number,
): Recommendation {
  const comfortable = candidates.filter(
    (r) => r.headroomGB >= budgetGB * minHeadroomRatio,
  );
  // If nothing is comfortable, take the one with the most room anyway — the
  // caller already knows this device sits at its limit.
  const pool = comfortable.length > 0 ? comfortable : candidates;
  // Highest fidelity first; for equal fidelity prefer more headroom.
  return [...pool].sort((a, b) => {
    const bits = quantBits(b.model.quantization) - quantBits(a.model.quantization);
    if (bits !== 0) return bits;
    return b.headroomGB - a.headroomGB;
  })[0];
}

/** Minimum fraction of the budget to leave free for KV cache growth and the OS. */
const MIN_HEADROOM_RATIO = 0.1;

/**
 * All viable options for a device, best-first. The first entry is the primary
 * recommendation; the rest are meaningful alternatives to offer the user (for
 * example a smaller model with more headroom if the top pick feels tight).
 */
export function recommendOptions(
  models: readonly ModelEntry[],
  options: RecommendOptions,
  limit = 3,
): Recommendation[] {
  const { minParametersB = 0 } = options;
  const evaluated = evaluateModels(models, options);

  const fitting = evaluated.filter(
    (r) => r.fit !== 'NO' && r.model.parametersB >= minParametersB,
  );
  const healthy = fitting.filter(
    (r) => quantBits(r.model.quantization) >= MIN_HEALTHY_BITS,
  );
  const pool = (healthy.length > 0 ? healthy : fitting).sort(compareByQuality);

  // De-duplicate so the list offers genuinely different choices rather than
  // three quantizations of the same model.
  const seen = new Set<string>();
  const out: Recommendation[] = [];
  for (const rec of pool) {
    const key = `${rec.model.family}:${rec.model.parametersB}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rec);
    if (out.length >= limit) break;
  }
  return out;
}

/** Recommendations for the standard device tiers, for use as JSON defaults. */
export function tierRecommendations(
  models: readonly ModelEntry[],
  tiers: readonly number[] = [4, 6, 8, 12, 16, 24],
): Record<string, Recommendation | null> {
  const out: Record<string, Recommendation | null> = {};
  for (const gb of tiers) {
    out[`${gb}GB`] = recommendModel(models, { totalRamGB: gb });
  }
  return out;
}

/**
 * Runtime pre-flight check before loading a model, using *currently available*
 * memory rather than total memory. Call this immediately before load.
 */
export function canLoadNow(
  model: ModelEntry,
  availableRamGB: number,
  opts: { contextLength?: number; lowMemory?: boolean } = {},
): { verdict: FitLevel; needGB: number; availGB: number } {
  const needGB = runtimeCostGB(model, opts.contextLength ?? DEFAULT_CONTEXT);
  const availGB = round2(availableRamGB);

  if (opts.lowMemory) return { verdict: 'NO', needGB, availGB };
  // Leave a safety margin: a load that exactly saturates available memory will
  // usually be killed by the OS mid-inference.
  if (availGB >= needGB * 1.25) return { verdict: 'GOOD', needGB, availGB };
  if (availGB >= needGB) return { verdict: 'TIGHT', needGB, availGB };
  return { verdict: 'NO', needGB, availGB };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
