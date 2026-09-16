/**
 * Build-flavour tests.
 *
 * These pin the compliance boundary: a `store` build must not carry the
 * abliterated line, and the flavour must fail closed on anything unexpected.
 *
 * NOTE ON HOW THIS IS TESTED
 *
 * `BUILD_FLAVOR` is a module-level constant resolved from `process.env` at
 * import time, so it cannot be changed within one process. The tests therefore
 * spawn a child process per flavour with the env var set, which is also the
 * only way to observe what a real bundle-time inliner would see.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
// This file lives at <root>/src/config/buildFlavor.test.ts, so the project root
// is two directories up. (Three would escape to the workspace parent — that
// mistake produced "Cannot find module 'D:\DeepSeek harness\src\config\...'".)
const projectRoot = resolve(here, '..', '..')

/**
 * Evaluate a snippet in a fresh Node process with `APP_FLAVOR` set, and parse
 * its JSON stdout.
 *
 * The child imports the real modules (not a reimplementation), so this
 * exercises the actual gating branch rather than a copy of its logic.
 *
 * ⚠️ Imports are passed as `file://` URLs. On Windows a bare `D:\...` specifier
 * is rejected by the ESM loader with ERR_UNSUPPORTED_ESM_URL_SCHEME, so
 * `pathToFileURL` is required rather than string concatenation.
 */
function evalInFlavor(flavor: string | undefined, snippet: string): Record<string, unknown> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (flavor === undefined) delete env.APP_FLAVOR
  else env.APP_FLAVOR = flavor

  const flavorUrl = pathToFileURL(resolve(projectRoot, 'src/config/buildFlavor.ts')).href
  const catalogUrl = pathToFileURL(resolve(projectRoot, 'src/data/models/lineCatalog.ts')).href

  const script = `
    const m = await import(${JSON.stringify(flavorUrl)});
    const c = await import(${JSON.stringify(catalogUrl)});
    const out = (${snippet})(m, c);
    console.log(JSON.stringify(out));
  `

  const raw = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    env,
    encoding: 'utf8',
    cwd: projectRoot,
  })
  return JSON.parse(raw.trim().split('\n').pop() as string)
}

// ---------------------------------------------------------------------------
// Flavour resolution
// ---------------------------------------------------------------------------

test('defaults to the store flavour when APP_FLAVOR is unset', () => {
  const r = evalInFlavor(undefined, '(m) => ({ flavor: m.BUILD_FLAVOR, ab: m.INCLUDES_ABLITERATED })')
  assert.equal(r.flavor, 'store', 'an unset APP_FLAVOR must fail closed to store')
  assert.equal(r.ab, false)
})

test('APP_FLAVOR=full selects the full flavour', () => {
  const r = evalInFlavor('full', '(m) => ({ flavor: m.BUILD_FLAVOR, ab: m.INCLUDES_ABLITERATED })')
  assert.equal(r.flavor, 'full')
  assert.equal(r.ab, true)
})

test('an unrecognised APP_FLAVOR fails closed to store', () => {
  // A CI typo (e.g. "Full", "FULL", "prod") must never produce the
  // unsubmittable binary.
  for (const bad of ['Full', 'FULL', 'prod', 'true', '1', 'full ']) {
    const r = evalInFlavor(bad, '(m) => ({ flavor: m.BUILD_FLAVOR })')
    assert.equal(r.flavor, 'store', `APP_FLAVOR=${JSON.stringify(bad)} must resolve to store`)
  }
})

test('APP_FLAVOR=store is explicit and yields the store flavour', () => {
  const r = evalInFlavor('store', '(m) => ({ flavor: m.BUILD_FLAVOR, ab: m.INCLUDES_ABLITERATED })')
  assert.equal(r.flavor, 'store')
  assert.equal(r.ab, false)
})

// ---------------------------------------------------------------------------
// Catalogue gating — the compliance-critical assertions
// ---------------------------------------------------------------------------

test('the store build carries ZERO abliterated models', () => {
  const r = evalInFlavor('store', '(_m, c) => ({ n: c.ABLITERATED_CATALOG.length })')
  assert.equal(r.n, 0, 'store build must expose no abliterated models')
})

test('the store build CANNOT reach the abliterated line via modelsForLine', () => {
  const r = evalInFlavor('store', '(_m, c) => ({ n: c.modelsForLine("abliterated").length, has: c.hasAbliteratedLine() })')
  assert.equal(r.n, 0)
  assert.equal(r.has, false)
})

test('the store build still carries the full official line', () => {
  const r = evalInFlavor('store', '(_m, c) => ({ n: c.modelsForLine("official").length })')
  assert.ok(
    (r.n as number) > 100,
    `official line should be intact on a store build, got ${r.n}`,
  )
})

test('the full build carries both lines', (t) => {
  const r = evalInFlavor(
    'full',
    '(_m, c) => ({ ab: c.ABLITERATED_CATALOG.length, off: c.modelsForLine("official").length, all: c.ALL_MODELS.length })',
  )

  /**
   * The abliterated CATALOGUE data is not published (see
   * `data/models-jailbreak.json` in .gitignore): it lists uncensored model
   * repositories, which is a liability to tie to a public identity.
   *
   * The `full` build still compiles the CODE path in — that is what this file
   * mostly verifies — but with no entries to load the line is legitimately
   * empty. Skipping is the honest outcome: asserting `> 0` would fail on every
   * fresh clone and in CI, which is exactly what happened before this guard.
   *
   * The store-flavour assertions below are unaffected and still run: they prove
   * the gate works regardless of whether data is present.
   */
  if (r.ab === 0) {
    t.skip('abliterated catalogue data is not shipped in this checkout')
    return
  }

  assert.ok((r.ab as number) > 0, 'full build must expose the abliterated line')
  assert.ok((r.off as number) > 100)
  assert.equal(
    r.all,
    (r.ab as number) + (r.off as number),
    'ALL_MODELS must be exactly both lines on a full build',
  )
})

test('ALL_MODELS on a store build contains no abliterated ids', () => {
  const r = evalInFlavor(
    'store',
    '(_m, c) => ({ ids: c.ALL_MODELS.map((x) => x.id) })',
  )
  const ids = r.ids as string[]
  const leaked = ids.filter((id) => id.includes('abliterated'))
  assert.deepEqual(leaked, [], `abliterated ids leaked into a store build: ${leaked.join(', ')}`)
})

// ---------------------------------------------------------------------------
// User-facing explanation
// ---------------------------------------------------------------------------

test('the store build explains the missing line instead of silently hiding it', () => {
  const r = evalInFlavor('store', '(m) => ({ reason: m.ABLITERATED_UNAVAILABLE_REASON })')
  assert.equal(typeof r.reason, 'string')
  assert.ok((r.reason as string).length > 20, 'the explanation must be an actual sentence')
})

test('the full build has nothing to explain', () => {
  const r = evalInFlavor('full', '(m) => ({ reason: m.ABLITERATED_UNAVAILABLE_REASON })')
  assert.equal(r.reason, null)
})

test('the flavour is self-identifying in the UI label', () => {
  const store = evalInFlavor('store', '(m) => ({ l: m.FLAVOR_LABEL })')
  const full = evalInFlavor('full', '(m) => ({ l: m.FLAVOR_LABEL })')
  assert.notEqual(store.l, full.l, 'the two builds must be distinguishable at a glance')
})
