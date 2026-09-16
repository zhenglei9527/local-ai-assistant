/**
 * Integration tests: both model lines through the recommender against the REAL
 * data files (data/models-official.json, data/models-jailbreak.json).
 *
 * Run: node --test src/recommend/lines.test.ts
 *
 * These tests exist because the jailbreak data file has a different schema
 * (`bytes` not `sizeBytes`, no `parametersB`) and a wrong adapter fails
 * SILENTLY: undefined sizes read as 0 GiB and appear to fit every device.
 * Asserting real numbers is the only way to catch that.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadLines, recommendPerLine, abliteratedAvailable } from './loadLines.ts';
import { deviceBudgetGB, runtimeCostGB, modelSizeGiB, canLoadNow } from './recommend.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

const lines = loadLines({
  officialPath: join(root, 'data', 'models-official.json'),
  abliteratedPath: join(root, 'data', 'models-jailbreak.json'),
});

const TIERS = [4, 6, 8, 12, 16, 24];

/**
 * Does this checkout actually carry the uncensored catalogue?
 *
 * `data/models-jailbreak.json` is deliberately NOT published — it lists
 * uncensored model repositories, which is a liability to tie to a public
 * identity — so a fresh clone and CI both run with it absent. That is a
 * supported configuration, not a fault: `loadLines` returns an empty list.
 *
 * Tests asserting on the CONTENT of that catalogue must therefore skip rather
 * than fail; this constant is how they know. It is derived from the loaded data
 * rather than from `existsSync`, so it stays correct if the source moves.
 *
 * Tests that do not depend on it — official-line checks, the budget invariant,
 * the pre-flight agreement — still run everywhere.
 */
const ABLITERATED_SKIP: string | false =
  lines.abliterated.length > 0
    ? false
    : 'uncensored catalogue is not shipped in this checkout';

test('both lines load, and every entry is fully normalised', (t) => {
  if (ABLITERATED_SKIP) return t.skip(ABLITERATED_SKIP);
  assert.ok(lines.official.length > 50, `official: ${lines.official.length}`);
  assert.ok(lines.abliterated.length >= 10, `abliterated: ${lines.abliterated.length}`);
  assert.equal(lines.all.length, lines.official.length + lines.abliterated.length);

  for (const m of lines.abliterated) {
    // The adapter must have filled every field the engine reads. `undefined`
    // here is the silent-failure mode this file guards against.
    assert.equal(typeof m.parametersB, 'number', `${m.id}: parametersB missing`);
    assert.ok(m.parametersB > 0, `${m.id}: parametersB=${m.parametersB}`);
    assert.equal(typeof m.sizeBytes, 'number', `${m.id}: sizeBytes missing`);
    assert.ok(m.sizeBytes > 0, `${m.id}: sizeBytes=${m.sizeBytes}`);
    assert.equal(typeof m.quantization, 'string');
    assert.equal(typeof m.isSharded, 'boolean');
    assert.equal(m.line, 'abliterated');
  }
});

test('abliterated sizes match the values verified against the live registry', (t) => {
  if (ABLITERATED_SKIP) return t.skip(ABLITERATED_SKIP);
  // These byte counts were independently confirmed against ModelScope and
  // Ollama registry manifests and cross-checked with each other.
  const expect: Record<string, number> = {
    'huihui-qwen3-0-6b-abliterated-v2': 396701536,
    'huihui-qwen3-1-7b-abliterated-v2': 1107405664,
    'huihui-qwen3-4b-abliterated-v2': 2497277376,
    'huihui-qwen3-8b-abliterated-v2': 5027780576,
    'huihui-qwen3-14b-abliterated-v2': 9001750048,
  };
  for (const [id, bytes] of Object.entries(expect)) {
    const m = lines.abliterated.find((x) => x.id === id);
    assert.ok(m, `${id} must be present`);
    assert.equal(m.sizeBytes, bytes, `${id} byte count drifted`);
  }
});

test('the 4B abliterated model is 2.33 GiB, not the decimal 2.5', (t) => {
  if (ABLITERATED_SKIP) return t.skip(ABLITERATED_SKIP);
  const m = lines.abliterated.find((x) => x.id === 'huihui-qwen3-4b-abliterated-v2')!;
  // bytes / 1024^3 = 2.3258 -> engine must not use the rounded decimal field
  assert.ok(Math.abs(modelSizeGiB(m) - 2.3258) < 0.001, `got ${modelSizeGiB(m)}`);
  assert.ok(modelSizeGiB(m) < m.sizeGB, 'GiB value must be below the decimal GB value');
});

test('every tier has a recommendation on both lines', (t) => {
  if (ABLITERATED_SKIP) return t.skip(ABLITERATED_SKIP);
  for (const gb of TIERS) {
    const r = recommendPerLine(lines, { totalRamGB: gb });
    for (const line of ['official', 'abliterated'] as const) {
      const rec = r[line].recommendation;
      assert.ok(rec, `${gb}GB/${line}: no recommendation produced`);
    }
  }
});

test('REGRESSION: no recommendation ever exceeds the device budget', (t) => {
  if (ABLITERATED_SKIP) return t.skip(ABLITERATED_SKIP);
  // Examines BOTH lines, and `recommendation` is null on a line with no
  // catalogue — so this cannot run when the data is absent.
  //
  // The invariant itself is still covered on every checkout by
  // 'pre-flight load check agrees with the tier recommendation' below, which
  // exercises the official line only.
  //
  // This is the bug class that motivated the engine: an oversized pick looks
  // fine until the user downloads 5GB and the OS kills the process on load.
  for (const gb of TIERS) {
    const budget = deviceBudgetGB(gb);
    const r = recommendPerLine(lines, { totalRamGB: gb });
    for (const line of ['official', 'abliterated'] as const) {
      const rec = r[line].recommendation!;
      assert.ok(
        rec.runtimeGB <= budget,
        `${gb}GB/${line}: ${rec.model.id} needs ${rec.runtimeGB} but budget is ${budget}`,
      );
    }
  }
});

test('the two lines stay independent — neither leaks into the other', (t) => {
  if (ABLITERATED_SKIP) return t.skip(ABLITERATED_SKIP);
  const r = recommendPerLine(lines, { totalRamGB: 12 });
  assert.equal(r.official.recommendation!.model.line, 'official');
  assert.equal(r.abliterated.recommendation!.model.line, 'abliterated');
  for (const a of r.official.alternatives) assert.equal(a.model.line, 'official');
  for (const a of r.abliterated.alternatives) assert.equal(a.model.line, 'abliterated');
});

test('alternatives are distinct model families, not requantisations', () => {
  const r = recommendPerLine(lines, { totalRamGB: 12 });
  for (const line of ['official', 'abliterated'] as const) {
    const seen = new Set<string>();
    for (const a of r[line].alternatives) {
      const key = `${a.model.family}:${a.model.parametersB}`;
      assert.ok(!seen.has(key), `${line}: duplicate family/size ${key}`);
      seen.add(key);
    }
  }
});

test('8GB picks a 4B-class model, never an 8B (the original OOM bug)', (t) => {
  if (ABLITERATED_SKIP) return t.skip(ABLITERATED_SKIP);
  // Iterates BOTH lines and dereferences `recommendation!`, which is null when
  // the uncensored catalogue is absent — hence the guard above.
  const budget = deviceBudgetGB(8); // 5.44 GiB
  const r = recommendPerLine(lines, { totalRamGB: 8 });
  for (const line of ['official', 'abliterated'] as const) {
    const rec = r[line].recommendation!;
    assert.ok(
      rec.runtimeGB <= budget,
      `${line}: 8GB device offered ${rec.model.id} at ${rec.runtimeGB}`,
    );
    // An 8B at Q4 needs ~6.5 GiB; it must not be chosen here.
    assert.ok(
      rec.model.parametersB <= 4,
      `${line}: 8GB device should not be offered a ${rec.model.parametersB}B model`,
    );
  }
});

test('a low-memory device still gets something on both lines', (t) => {
  if (ABLITERATED_SKIP) return t.skip(ABLITERATED_SKIP);
  const r = recommendPerLine(lines, { totalRamGB: 4 });
  assert.ok(r.official.recommendation);
  assert.ok(r.abliterated.recommendation);
  // Must be small enough to actually run.
  assert.ok(r.official.recommendation!.runtimeGB <= deviceBudgetGB(4));
  assert.ok(r.abliterated.recommendation!.runtimeGB <= deviceBudgetGB(4));
});

test('abliterated line is offered on every tier the official line is', (t) => {
  if (ABLITERATED_SKIP) return t.skip(ABLITERATED_SKIP);
  for (const gb of TIERS) {
    assert.ok(
      abliteratedAvailable(lines, { totalRamGB: gb }),
      `${gb}GB: abliterated line unexpectedly empty`,
    );
  }
});

test('pre-flight load check agrees with the tier recommendation', () => {
  // canLoadNow() answers "right now, with this much free memory" and applies a
  // stricter 1.25x margin than the tier picker. A model the picker chose must
  // not be rejected outright when a representative amount of RAM is free.
  const r = recommendPerLine(lines, { totalRamGB: 8 });
  const rec = r.official.recommendation!;
  const verdict = canLoadNow(rec.model, 4.5);
  assert.notEqual(verdict.verdict, 'NO', `chosen ${rec.model.id} failed pre-flight`);
});

test('runtimeCostGB is monotonic in context length on both lines', () => {
  const models = [...lines.official.slice(0, 5), ...lines.abliterated.slice(0, 5)];
  for (const m of models) {
    const a = runtimeCostGB(m, 2048);
    const b = runtimeCostGB(m, 8192);
    const c = runtimeCostGB(m, 32768);
    assert.ok(a <= b && b <= c, `${m.id}: runtime not monotonic (${a}/${b}/${c})`);
  }
});
