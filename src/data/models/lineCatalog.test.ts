/**
 * Cross-module consistency: the display catalogue (LineDescriptor, used by the
 * UI/downloader) and the recommender's ModelEntry view must agree on every
 * model they both know about.
 *
 * They are separate type systems reading the same two JSON files through
 * different adapters, so nothing but a test stops them from drifting. A
 * mismatch here means the UI shows one size and the recommender reasons about
 * another — which is exactly the class of silent bug that produced the
 * original OOM recommendations.
 *
 * Run: node --test src/data/models/lineCatalog.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  ABLITERATED_CATALOG,
  OFFICIAL_LINE,
  ALL_MODELS,
  modelsForLine,
  findLineModel,
  catalogConsistencyIssues,
} from './lineCatalog.ts'
import { loadLines } from '../../recommend/loadLines.ts'
import { INCLUDES_ABLITERATED } from '../../config/buildFlavor.ts'

/**
 * The abliterated line exists only in the `full` flavour (see
 * src/config/buildFlavor.ts and src/config/buildFlavor.test.ts for the
 * compliance rationale). On a `store` build the catalogue is legitimately
 * empty, so the assertions below are skipped rather than faked — the store
 * build's *absence* of these models is itself asserted in buildFlavor.test.ts.
 *
 * Run the full flavour to exercise them:
 *   APP_FLAVOR=full npm test
 */
const ABLITERATED_SKIP = INCLUDES_ABLITERATED
  ? false
  : 'abliterated line is absent by design in the store flavour'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..', '..')

const recommenderLines = loadLines({
  officialPath: join(root, 'data', 'models-official.json'),
  abliteratedPath: join(root, 'data', 'models-jailbreak.json'),
})

test('both catalogues load and are non-empty', { skip: ABLITERATED_SKIP }, () => {
  assert.ok(OFFICIAL_LINE.length > 50, `official: ${OFFICIAL_LINE.length}`)
  assert.equal(ABLITERATED_CATALOG.length, 11, `abliterated: ${ABLITERATED_CATALOG.length}`)
  assert.equal(ALL_MODELS.length, OFFICIAL_LINE.length + ABLITERATED_CATALOG.length)
})

test('the official line loads regardless of flavour', () => {
  // Flavour-independent: this must hold on BOTH builds.
  assert.ok(OFFICIAL_LINE.length > 50, `official: ${OFFICIAL_LINE.length}`)
  assert.equal(ALL_MODELS.length, OFFICIAL_LINE.length + ABLITERATED_CATALOG.length)
})

test('no id collisions between the two lines', () => {
  const ids = ALL_MODELS.map((m) => m.id)
  assert.equal(new Set(ids).size, ids.length, 'duplicate model id across lines')
})

test('abliterated entries carry every field the UI and downloader read', { skip: ABLITERATED_SKIP }, () => {
  for (const m of ABLITERATED_CATALOG) {
    assert.equal(typeof m.parametersB, 'number', `${m.id}: parametersB`)
    assert.ok(m.parametersB > 0, `${m.id}: parametersB=${m.parametersB}`)
    assert.ok(m.sizeBytes > 0, `${m.id}: sizeBytes=${m.sizeBytes}`)
    assert.equal(m.files.length, 1, `${m.id}: expected a single file part`)
    assert.equal(m.files[0].sizeBytes, m.sizeBytes, `${m.id}: file size != model size`)
    assert.equal(m.files[0].sha256.length, 64, `${m.id}: unusable digest`)
    assert.ok(m.files[0].url.startsWith('https://modelscope.cn/'), `${m.id}: bad url host`)
    // Architecture must have resolved, or every memory verdict is wrong.
    assert.ok(m.layerCount > 0, `${m.id}: layerCount unresolved`)
    assert.ok(m.headCountKv > 0, `${m.id}: headCountKv unresolved`)
    assert.ok(m.headDim > 0, `${m.id}: headDim unresolved`)
  }
})

test('abliterated models are flagged as needing a digest check', { skip: ABLITERATED_SKIP }, () => {
  // Their URLs point at `master`, which can move; the digest is the only pin.
  for (const m of ABLITERATED_CATALOG) {
    assert.equal(m.requiresDigestCheck, true, `${m.id} must require a digest check`)
    assert.equal(m.line, 'abliterated')
  }
  for (const m of OFFICIAL_LINE) {
    assert.equal(m.requiresDigestCheck, false, `${m.id} is commit-pinned, no check needed`)
    assert.equal(m.line, 'official')
  }
})

test('REGRESSION: display and recommender agree on every shared model', { skip: ABLITERATED_SKIP }, () => {
  const issues = catalogConsistencyIssues(recommenderLines.all)
  assert.deepEqual(issues, [], `catalogue drift:\n${issues.join('\n')}`)
})

test('modelsForLine returns the right subset', () => {
  assert.equal(modelsForLine('official').length, OFFICIAL_LINE.length)
  // Flavour-aware: on a store build the abliterated line legitimately resolves
  // to an empty list rather than throwing (see lineCatalog.ts modelsForLine).
  assert.equal(modelsForLine('abliterated').length, ABLITERATED_CATALOG.length)
  for (const m of modelsForLine('abliterated')) assert.equal(m.line, 'abliterated')
  if (!INCLUDES_ABLITERATED) {
    assert.equal(modelsForLine('abliterated').length, 0, 'store build must expose no abliterated models')
  }
})

test('findLineModel locates models on both lines and rejects unknown ids', { skip: ABLITERATED_SKIP }, () => {
  assert.ok(findLineModel('huihui-qwen3-4b-abliterated-v2'))
  assert.ok(findLineModel('qwen3-4b-q4_k_m'))
  assert.equal(findLineModel('does-not-exist'), undefined)
})

test('abi line sizes match the live-verified byte counts', { skip: ABLITERATED_SKIP }, () => {
  const expect: Record<string, number> = {
    'huihui-qwen3-0-6b-abliterated-v2': 396701536,
    'huihui-qwen3-1-7b-abliterated-v2': 1107405664,
    'huihui-qwen3-4b-abliterated-v2': 2497277376,
    'huihui-qwen3-8b-abliterated-v2': 5027780576,
    'huihui-qwen3-14b-abliterated-v2': 9001750048,
  }
  for (const [id, bytes] of Object.entries(expect)) {
    assert.equal(findLineModel(id)?.sizeBytes, bytes, `${id} drifted`)
  }
})

test('abliterated line is all Q4_K_M — a known coverage limit', { skip: ABLITERATED_SKIP }, () => {
  // Documented in docs/dual-line-integration.md: the abliterated line ships a
  // single quantization, so it cannot step up to a better quant the way the
  // official line can. If this changes, update that doc and the tier table.
  for (const m of ABLITERATED_CATALOG) {
    assert.equal(m.quantization, 'Q4_K_M', `${m.id} is ${m.quantization}, not Q4_K_M`)
  }
})
