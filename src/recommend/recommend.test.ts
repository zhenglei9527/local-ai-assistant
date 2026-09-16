/**
 * Verifies the recommendation engine against the REAL generated catalog
 * (data/models-official.json), proving the tier bug is fixed.
 *
 * Run: node --experimental-strip-types src/recommend/recommend.test.ts
 * or:  node --test src/recommend/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  recommendModel,
  recommendOptions,
  evaluateModels,
  deviceBudgetGB,
  runtimeCostGB,
  modelSizeGiB,
  canLoadNow,
  quantBits,
  type ModelEntry,
} from './recommend.ts';

const here = dirname(fileURLToPath(import.meta.url));
const catalogPath = join(here, '..', '..', 'data', 'models-official.json');

const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as {
  models: ModelEntry[];
};
const models = catalog.models;

test('catalog loaded with a sane number of models', () => {
  assert.ok(models.length > 50, `expected many models, got ${models.length}`);
  // Every entry used by the recommender must carry the fields it depends on.
  for (const m of models) {
    assert.equal(typeof m.id, 'string');
    assert.equal(typeof m.sizeGB, 'number');
    assert.equal(typeof m.parametersB, 'number');
    assert.ok(m.sizeGB > 0, `${m.id} has non-positive size`);
  }
});

test('usable budget leaves room for the OS', () => {
  assert.equal(deviceBudgetGB(4), 2.4);
  assert.equal(deviceBudgetGB(8), 5.44);
  assert.equal(deviceBudgetGB(12), 8.4);
  // Budget must always be strictly below physical RAM.
  for (const gb of [4, 6, 8, 12, 16, 24]) {
    assert.ok(deviceBudgetGB(gb) < gb, `budget(=${gb}) should be < ${gb}`);
  }
});

test('runtime cost applies the safety multiplier', () => {
  const m4 = models.find((m) => m.id === 'qwen3-4b-q4_k_m');
  assert.ok(m4, 'qwen3-4b-q4_k_m must exist in catalog');
  // 2.3258 GiB weights * 1.3 = 3.0235 -> 3.02 GiB. Note the catalog's `sizeGB`
  // field says 2.5, which is decimal and rounded; using it would give 3.25 and
  // overstate the requirement by ~7%.
  assert.equal(runtimeCostGB(m4), 3.02);
});

test('REGRESSION: calculations must use GiB, not the rounded decimal sizeGB', () => {
  const m = models.find((x) => x.id === 'qwen3-4b-q4_k_m')!;
  const fromBytes = m.sizeBytes / 1024 ** 3;
  assert.ok(
    Math.abs(modelSizeGiB(m) - fromBytes) < 1e-9,
    'modelSizeGiB must derive from sizeBytes',
  );
  // The decimal display field must NOT be what we compute with.
  assert.ok(
    Math.abs(modelSizeGiB(m) - m.sizeGB) > 0.1,
    'sizeGB is a lossy display field and must differ from the GiB value',
  );
  // Cross-check against the independently verified figure: 4B Q4_K_M is 2.33GiB.
  assert.equal(Math.round(m.sizeGiB * 100) / 100, 2.33);
});

test('8B Q4_K_M matches the independently verified 4.68 GiB', () => {
  // Cross-checked against the Ollama registry manifest sum earlier in the
  // project; both sources must agree or one of them is wrong.
  const m = models.find((x) => x.id === 'qwen3-8b-q4_k_m')!;
  assert.equal(Math.round(m.sizeGiB * 100) / 100, 4.68);
});

test('REGRESSION: 8GB device must NOT be told to run an 8B model', () => {
  const rec = recommendModel(models, { totalRamGB: 8 });
  assert.ok(rec, 'expected a recommendation');

  // The buggy generator picked qwen3-8b-q4_k_m (5.03GB) for 8GB devices,
  // which needs 5.03*1.3 = 6.54GB and OOMs against a 5.44GB budget.
  assert.notEqual(
    rec.model.id,
    'qwen3-8b-q4_k_m',
    'must not recommend an 8B model for an 8GB device',
  );
  assert.equal(rec.model.parametersB, 4, 'expected a 4B model for 8GB');
  assert.ok(rec.fit !== 'NO', 'recommended model must fit');
  assert.ok(
    rec.runtimeGB <= rec.budgetGB,
    `runtime ${rec.runtimeGB} must fit budget ${rec.budgetGB}`,
  );
});

test('REGRESSION: every tier recommendation actually fits its budget', () => {
  for (const gb of [4, 6, 8, 12, 16, 24]) {
    const rec = recommendModel(models, { totalRamGB: gb });
    assert.ok(rec, `tier ${gb}GB produced no recommendation`);
    assert.ok(
      rec.fit !== 'NO',
      `tier ${gb}GB recommended ${rec.model.id} which does not fit ` +
        `(runtime ${rec.runtimeGB} > budget ${rec.budgetGB})`,
    );
  }
});

test('recommendation is monotonic: more RAM never yields fewer parameters', () => {
  let prev = 0;
  for (const gb of [4, 6, 8, 12, 16]) {
    const rec = recommendModel(models, { totalRamGB: gb });
    assert.ok(rec);
    assert.ok(
      rec.model.parametersB >= prev,
      `tier ${gb}GB regressed from ${prev}B to ${rec.model.parametersB}B`,
    );
    prev = rec.model.parametersB;
  }
});

test('tier picks match the hand-verified expectation', () => {
  // 4GB usable budget is 2.4GB. Nothing healthy fits at 4B (3.25GB runtime),
  // so this tier legitimately lands on a 3B at Q2_K or a 1.7B-ish model.
  const expect4 = recommendModel(models, { totalRamGB: 4 });
  assert.ok(expect4);
  assert.ok(
    expect4.model.parametersB <= 3,
    `4GB device got ${expect4.model.parametersB}B which is too large`,
  );

  const expect12 = recommendModel(models, { totalRamGB: 12 });
  assert.ok(expect12);
  // 12GB usable budget is 8.4GB; 8B Q4 (5.03 * 1.3 = 6.54) fits, 14B Q4 (8.38
  // * 1.3 = 10.89) does not.
  assert.equal(expect12.model.parametersB, 8, 'expected 8B for a 12GB device');
});

test('REGRESSION: must not pick a sub-Q4 quant when a healthy quant fits', () => {
  // A 7B at Q3_K_M fits an 8GB device on paper (4.95GB vs a 5.44GB budget), but
  // a 4B at Q4_K_M is more coherent, faster to load, and leaves room for a
  // longer context. Picking by parameter count alone would silently degrade
  // every user's experience.
  for (const gb of [6, 8, 12, 16]) {
    const rec = recommendModel(models, { totalRamGB: gb });
    assert.ok(rec, `tier ${gb}GB produced no recommendation`);
    const bits = quantBits(rec.model.quantization);
    assert.ok(
      bits >= 4.0,
      `tier ${gb}GB chose ${rec.model.id} at ` +
        `${rec.model.quantization} (${bits} bits/weight), below the Q4 floor`,
    );
  }
});

test('8GB tier prefers a well-quantized 4B over a Q2 7B', () => {
  const rec = recommendModel(models, { totalRamGB: 8 });
  assert.ok(rec);
  assert.equal(rec.model.parametersB, 4, 'expected a 4B model for 8GB');
  assert.ok(
    quantBits(rec.model.quantization) >= 4.5,
    `expected a Q4-class quant, got ${rec.model.quantization}`,
  );
});

test('recommendOptions returns distinct, non-duplicated choices', () => {
  const opts = recommendOptions(models, { totalRamGB: 12 }, 3);
  assert.ok(opts.length >= 2, 'expected multiple options for a 12GB device');
  const keys = opts.map((o) => `${o.model.family}:${o.model.parametersB}`);
  assert.equal(new Set(keys).size, keys.length, 'options must be distinct');
  for (const o of opts) {
    assert.notEqual(o.fit, 'NO', `${o.model.id} should fit`);
  }
});

test('evaluateModels marks oversized models as NO', () => {
  const evals = evaluateModels(models, { totalRamGB: 8 });
  const big = evals.find((e) => e.model.id === 'qwen3-8b-q4_k_m');
  assert.ok(big);
  assert.equal(big.fit, 'NO', '8B must not fit on an 8GB device');
  assert.ok(big.headroomGB < 0);
});

test('sharded models are costed on their TOTAL size, not the first shard', () => {
  const sharded = models.filter((m) => m.isSharded);
  // The catalog may legitimately contain no sharded entries; only assert when
  // shards are present so the test does not encode a false expectation.
  for (const m of sharded) {
    assert.ok(
      m.sizeGB > 4,
      `${m.id} is sharded (${m.shardCount} parts) but only ${m.sizeGB}GB total`,
    );
  }
});

test('canLoadNow refuses when available memory is low', () => {
  const m = models.find((x) => x.id === 'qwen3-4b-q4_k_m')!;
  // Needs 3.25GB; 2GB available is not enough.
  assert.equal(canLoadNow(m, 2).verdict, 'NO');
  // Exactly enough is TIGHT (no safety margin).
  assert.equal(canLoadNow(m, 3.25).verdict, 'TIGHT');
  // Comfortably enough is GOOD.
  assert.equal(canLoadNow(m, 5).verdict, 'GOOD');
  // OS low-memory flag overrides the arithmetic.
  assert.equal(canLoadNow(m, 5, { lowMemory: true }).verdict, 'NO');
});

test('longer context increases the memory estimate', () => {
  const m = models.find((x) => x.id === 'qwen3-4b-q4_k_m')!;
  const short = runtimeCostGB(m, 2048);
  const medium = runtimeCostGB(m, 4096);
  const long = runtimeCostGB(m, 8192);
  assert.ok(short < medium, `${short} should be < ${medium}`);
  assert.ok(medium < long, `${medium} should be < ${long}`);
});
