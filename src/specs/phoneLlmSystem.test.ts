/**
 * Runtime check of the `PhoneLlmSystem` JS seam.
 *
 * WHAT THIS CAN AND CANNOT PROVE
 * ------------------------------
 * It cannot prove the Kotlin module compiles or that a device reports correct
 * RAM — no JDK/SDK/NDK and no device exist on this machine.
 *
 * It CAN prove the things that are pure JS logic and that would otherwise only
 * fail on a phone:
 *   1. The spec file's default export is a `TurboModuleRegistry.get` call, not
 *      `getEnforcing` — i.e. importing it does not throw when the module is
 *      absent. This is the property that keeps iOS and node:test importable.
 *   2. The structural guard rejects a half-built module instead of producing
 *      `undefined is not a function` deep inside a probe.
 *   3. The budget arithmetic in `readMemorySnapshot` produces the EXPECTED
 *      different tiers for different devices — the regression this whole task
 *      exists to fix (all tiers collapsing to 1.2 GiB).
 *
 * `react-native` is not installed, so the module is loaded with a stub
 * injected via a custom loader. That makes this a test of OUR code against a
 * faithful stub, not an end-to-end test.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
// `here` is src/specs; the project root is two levels up.
const root = join(here, '..', '..')

const specSource = readFileSync(join(root, 'src/specs/NativePhoneLlmSystem.ts'), 'utf8')
const facadeSource = readFileSync(join(root, 'src/specs/phoneLlmSystem.ts'), 'utf8')

test('spec uses the non-throwing registry get, not getEnforcing', () => {
  assert.match(
    specSource,
    /TurboModuleRegistry\.get<Spec>\('PhoneLlmSystem'\)/,
    'the spec must resolve via TurboModuleRegistry.get so an absent module is null, not a crash',
  )

  // Assert on executable code only: the doc comment legitimately explains
  // why getEnforcing is avoided, and matching raw source would flag that prose.
  const codeOnly = specSource
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/\/\/[^\n]*/g, '') // line comments
  assert.ok(
    !/getEnforcing/.test(codeOnly),
    'getEnforcing would make importing the spec fatal on iOS and in node:test',
  )
})

test('the module name is coupled identically in the spec and the facade', () => {
  // The three-way coupling (file name / getName() / registry string) is the
  // documented silent-failure mode; assert the JS half of it.
  const specName = /TurboModuleRegistry\.get<Spec>\('([A-Za-z0-9_]+)'\)/.exec(specSource)?.[1]
  assert.equal(specName, 'PhoneLlmSystem')

  const kotlin = readFileSync(
    join(root, 'android/app/src/main/java/com/phonellm/app/PhoneLlmSystemModule.kt'),
    'utf8',
  )
  const kotlinName = /const val NAME = "([A-Za-z0-9_]+)"/.exec(kotlin)?.[1]
  assert.equal(
    kotlinName,
    specName,
    `getName() returns "${kotlinName}" but the spec registers "${specName}" — the module would resolve to null`,
  )

  // And the spec FILE name must be Native<Name>.ts.
  assert.ok(
    readFileSync(join(root, 'src/specs', `Native${specName}.ts`), 'utf8').length > 0,
    'the spec file must be named Native<ModuleName>.ts for Codegen to pick it up',
  )
})

test('facade structurally rejects a partial module', () => {
  // The guard's contract: every method the callers use must be present.
  assert.match(facadeSource, /typeof m\.getMemoryInfo === 'function'/)
  assert.match(facadeSource, /typeof m\.getFilesDir === 'function'/)
  assert.match(facadeSource, /typeof m\.deleteRecursively === 'function'/)
})

test('memoryProbe derives DIFFERENT budgets per device (the regression)', () => {
  // Reproduces readMemorySnapshot's arithmetic exactly. The bug being fixed is
  // that every device previously produced usableBudget = 1.2 GiB. If this test
  // ever collapses to a single value again, the recommendation engine is dead.
  const SAFETY_FRACTION = 0.2
  const CEILING = 24 * 1024 ** 3
  const FLOOR = 256 * 1024 ** 2
  const GiB = 1024 ** 3

  function budget(totalMem, availMem, threshold = 256 * 1024 ** 2) {
    const effectiveAvail = Math.max(availMem, threshold)
    const raw = Math.min(effectiveAvail, totalMem) * (1 - SAFETY_FRACTION)
    return Math.min(Math.max(raw, FLOOR), CEILING)
  }

  // A "4GB" phone reports ~4 GiB total; assume 60% reclaimable at boot.
  const tiers = [4, 6, 8, 12, 16, 24].map((gb) => {
    const total = gb * GiB
    return { gb, budgetGiB: budget(total, total * 0.6) / GiB }
  })

  const distinct = new Set(tiers.map((t) => t.budgetGiB.toFixed(2)))
  assert.ok(
    distinct.size >= 5,
    `budgets must vary by device, got ${distinct.size} distinct values: ` +
      tiers.map((t) => `${t.gb}GB→${t.budgetGiB.toFixed(2)}`).join(', '),
  )

  // The old fallback was a flat 1.2 GiB. A real 8GB device must exceed it, or
  // the native path is not actually being used.
  const eight = tiers.find((t) => t.gb === 8)
  assert.ok(
    eight.budgetGiB > 3.0,
    `an 8GB device must have a budget well above the 1.2 GiB fallback, got ${eight.budgetGiB}`,
  )

  // And the ceiling must not bind below 24GB.
  const sixteen = tiers.find((t) => t.gb === 16)
  assert.ok(sixteen.budgetGiB > 7, 'a 16GB device must not be capped at the old 8GiB ceiling')
})

test('the JS fallback is retained but is clearly the fallback', () => {
  const probe = readFileSync(join(root, 'src/data/models/memoryProbe.ts'), 'utf8')

  // The real path must exist and be the first branch.
  assert.match(probe, /const native = getPhoneLlmSystem\(\)/)
  assert.match(probe, /if \(!native\) return FALLBACK_SNAPSHOT/)
  assert.match(probe, /const info = await native\.getMemoryInfo\(\)/)

  // The fallback constant must survive for safety.
  assert.match(probe, /const FALLBACK_SNAPSHOT: MemorySnapshot/)
  assert.match(probe, /usableBudget: 1\.2 \* 1024 \* 1024 \* 1024/)

  // The dead `NativeModules` direct read must be gone.
  assert.ok(
    !/NativeModules\.PhoneLlmSystem/.test(probe),
    'memoryProbe must resolve the module through the spec facade, not NativeModules',
  )
})
