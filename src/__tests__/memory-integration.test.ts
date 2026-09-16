/**
 * Integration check: the two memory systems must agree.
 *
 * This project has two memory layers that were written independently and
 * answer different questions:
 *
 *   src/recommend/recommend.ts        "which model should we SUGGEST?"
 *     Static, based on TOTAL RAM. Runs before any download. Used by the picker.
 *     Its `runtimeCostGB` = weights × 1.3, where the 1.3 stands in for KV cache
 *     because the catalog carries no architecture data at pick time.
 *
 *   src/data/models/memoryProbe.ts    "can we LOAD this right now?"
 *     Dynamic, based on AVAILABLE memory. Used at load time. Its
 *     `estimateModelMemory().totalBytes` is the FULL footprint — weights PLUS a
 *     real KV-cache computation PLUS scratch — so it must NOT be multiplied by
 *     1.3 again.
 *
 * The invariant that matters: the picker must not offer a model that the loader
 * would then refuse, on the same device. An earlier revision applied ×1.3 in
 * BOTH layers (double-counting KV), which broke exactly that invariant.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  recommendModel,
  deviceBudgetGB,
  modelSizeGiB,
  type ModelEntry,
} from '../recommend/recommend.ts';

const here = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(
  readFileSync(join(here, '..', '..', 'data', 'models-official.json'), 'utf8'),
) as { models: ModelEntry[] };

const GiB = 1024 ** 3;

/** Mirrors memoryProbe's budget derivation for a freshly-booted device. */
function probeBudgetGiB(totalGB: number, availFraction = 0.6): number {
  const total = totalGB * GiB;
  const avail = total * availFraction;
  const raw = Math.min(avail, total) * 0.8; // SAFETY_FRACTION = 0.2
  const clamped = Math.min(Math.max(raw, 256 * 1024 * 1024), 24 * GiB);
  return clamped / GiB;
}

test('the picker never offers a model the loader would refuse', () => {
  for (const totalGB of [4, 6, 8, 12, 16, 24]) {
    const rec = recommendModel(catalog.models, { totalRamGB: totalGB });
    assert.ok(rec, `no recommendation for ${totalGB}GB`);

    // Weights only, in GiB. The probe adds KV cache on top of this, so if the
    // weights alone already exceed the probe budget the picker is definitely
    // offering something unloadable.
    const weightsGiB = modelSizeGiB(rec.model);
    const budget = probeBudgetGiB(totalGB);

    assert.ok(
      weightsGiB <= budget,
      `tier ${totalGB}GB: picker offered ${rec.model.id} with ` +
        `${weightsGiB.toFixed(2)}GiB of weights, but the loader's fresh-boot ` +
        `budget is only ${budget.toFixed(2)}GiB — it would be refused.`,
    );
  }
});

test('the picker stays within the static total-RAM budget', () => {
  for (const totalGB of [4, 6, 8, 12, 16, 24]) {
    const rec = recommendModel(catalog.models, { totalRamGB: totalGB });
    assert.ok(rec);
    assert.ok(
      rec.runtimeGB <= deviceBudgetGB(totalGB),
      `tier ${totalGB}GB: runtime ${rec.runtimeGB} exceeds static budget ` +
        `${deviceBudgetGB(totalGB)}`,
    );
  }
});

test('the probe no longer double-counts the KV cache', () => {
  // Regression: evaluateFit used `totalBytes * 1.3`, but totalBytes already
  // contains KV cache, so the load-time check was far stricter than the
  // picker's and the two disagreed by roughly a factor of 1.3.
  const src = readFileSync(
    join(here, '..', 'data', 'models', 'memoryProbe.ts'),
    'utf8',
  );

  // The old expression must be gone from the fit logic.
  assert.ok(
    !/estimate\.totalBytes\s*\*\s*1\.3/.test(src),
    'evaluateFit still multiplies the full runtime estimate by 1.3',
  );
  assert.ok(
    !/est\.totalBytes\s*\*\s*1\.3/.test(src),
    'suggestContextLength still multiplies the full runtime estimate by 1.3',
  );
  // And the reserve-based approach must be present.
  assert.match(src, /COMFORTABLE_RESERVE_RATIO/);
});

test('the probe ceiling no longer caps flagship devices', () => {
  // Regression for ABSOLUTE_CEILING_BYTES being 8GiB: a 16GB and a 24GB phone
  // produced identical budgets, making 14B models unreachable on flagships.
  assert.notEqual(
    probeBudgetGiB(16),
    probeBudgetGiB(24),
    '16GB and 24GB devices must not share a budget',
  );
  assert.ok(probeBudgetGiB(24) > 8, 'a 24GB device must exceed the old 8GiB cap');

  const rec24 = recommendModel(catalog.models, { totalRamGB: 24 });
  assert.ok(rec24);
  assert.ok(
    rec24.model.parametersB >= 14,
    `a 24GB device should reach 14B, got ${rec24.model.parametersB}B`,
  );
});

