/**
 * Device-profile tests.
 *
 * The load-bearing cases are the NOISY READINGS: real Android devices report
 * `totalMem` below their nominal size because the GPU, modem and secure world
 * reserve memory first. A 16GB phone commonly reports ~15.3 GiB. If the tier
 * logic used a naive `>= 16` comparison, every 16GB device would be demoted to
 * the 12GB tier — a silent quality regression the user would never report as a
 * bug, just as "this app picks weak models".
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveRamTier,
  buildDeviceProfile,
  describeDeviceProfile,
  RAM_TIERS,
  type RamTier,
} from './deviceProfile.ts'

// ---------------------------------------------------------------------------
// Exact nominal sizes
// ---------------------------------------------------------------------------

test('exact nominal sizes resolve to themselves', () => {
  for (const tier of RAM_TIERS) {
    assert.equal(resolveRamTier(tier), tier, `${tier} GiB should resolve to ${tier}`)
  }
})

// ---------------------------------------------------------------------------
// The real-world noise cases — these are what actually happen on devices
// ---------------------------------------------------------------------------

test('a 12GB device reporting vendor-reserved memory still resolves to 12', () => {
  // Observed range on Android 12GB devices.
  for (const reading of [11.9, 11.6, 11.2, 11.05]) {
    assert.equal(
      resolveRamTier(reading),
      12,
      `${reading} GiB is a 12GB device and must not be demoted to 8`,
    )
  }
})

test('a 16GB device reporting vendor-reserved memory still resolves to 16', () => {
  // This is the Xiaomi 14 Pro case and the single most consequential tier.
  for (const reading of [15.7, 15.3, 14.9, 14.75]) {
    assert.equal(
      resolveRamTier(reading),
      16,
      `${reading} GiB is a 16GB device; demoting it to 12 would lose the 14B option`,
    )
  }
})

test('12 and 16 are never conflated in either direction', () => {
  // The whole point of the feature: these two sizes must be distinguishable.
  assert.equal(resolveRamTier(12), 12)
  assert.equal(resolveRamTier(16), 16)
  assert.notEqual(resolveRamTier(12), resolveRamTier(16))
})

// ---------------------------------------------------------------------------
// Tolerance must not over-promote
// ---------------------------------------------------------------------------

test('an 8GB device is NOT promoted into the 12GB tier', () => {
  // 7.3 GiB is a plausible 8GB reading; 12 * 0.92 = 11.04, so this must stay 8.
  for (const reading of [8, 7.8, 7.3, 7.0]) {
    assert.equal(resolveRamTier(reading), 8, `${reading} GiB must stay in the 8GB tier`)
  }
})

test('a 6GB device is NOT promoted into the 8GB tier', () => {
  for (const reading of [6, 5.8, 5.5]) {
    assert.equal(resolveRamTier(reading), 6, `${reading} GiB must stay in the 6GB tier`)
  }
})

test('the promotion allowance is bounded — a reading far below a tier never promotes', () => {
  // With a 1.35 GiB absolute allowance:
  //   tier 12 promotes from >= 10.65
  //   tier 16 promotes from >= 14.65
  // The critical property is that the bands never merge: the 12GB band must not
  // reach up into 16, and the 16GB band must not reach down into 12.
  assert.equal(resolveRamTier(10.6), 8, '10.6 is below the 12GB band and must stay at 8')
  assert.equal(resolveRamTier(10.65), 12, '10.65 is the first 12GB reading')
  assert.equal(resolveRamTier(13.5), 12, '13.5 is neither a 16GB reading nor an 8GB one')
  assert.equal(resolveRamTier(14.6), 12, '14.6 is below the 16GB band')
  assert.equal(resolveRamTier(14.65), 16, '14.65 is the first 16GB reading')
})

test('the 12GB and 16GB bands do not overlap', () => {
  // Guards the single most consequential boundary. A 12GB device reading at the
  // top of its plausible range must never be promoted into 16, and a 16GB
  // device reading at the bottom of its range must never fall into 12.
  assert.equal(resolveRamTier(11.9), 12, 'top of the 12GB range')
  assert.equal(resolveRamTier(14.7), 16, 'bottom of the 16GB range')
})

// ---------------------------------------------------------------------------
// Degenerate readings must fail safe (downward, never upward)
// ---------------------------------------------------------------------------

test('a zero or negative reading clamps to the smallest tier, not a large one', () => {
  for (const bad of [0, -1, -999]) {
    assert.equal(resolveRamTier(bad), 4, `${bad} must clamp to the smallest tier`)
  }
})

test('NaN and Infinity do not produce a bogus large tier', () => {
  assert.equal(resolveRamTier(NaN), 4)
  // Infinity is treated as "no reading" rather than "the biggest phone ever":
  // Number.isFinite guards it in the same branch as NaN.
  assert.equal(resolveRamTier(Infinity), 4)
})

test('a tiny device still gets the smallest tier rather than an error', () => {
  assert.equal(resolveRamTier(3.1), 4)
  assert.equal(resolveRamTier(2), 4)
})

// ---------------------------------------------------------------------------
// Profile shape and the tier -> capability mapping
// ---------------------------------------------------------------------------

test('12GB and 16GB profiles differ in the way the product depends on', () => {
  const twelve = buildDeviceProfile(12)
  const sixteen = buildDeviceProfile(16)

  assert.equal(twelve.tier, 12)
  assert.equal(sixteen.tier, 16)

  // The 16GB tier must unlock larger models than the 12GB tier.
  assert.ok(
    sixteen.maxParametersB > twelve.maxParametersB,
    `16GB (max ${sixteen.maxParametersB}B) must exceed 12GB (max ${twelve.maxParametersB}B)`,
  )

  // And more budget.
  assert.ok(sixteen.budgetGiB > twelve.budgetGiB)
})

test('budget is derived from the shared usableFactor, not a private copy', () => {
  // A 12GB device: 12 * 0.70 = 8.40
  assert.equal(buildDeviceProfile(12).budgetGiB, 8.4)
  // A 16GB device: 16 * 0.70 = 11.20
  assert.equal(buildDeviceProfile(16).budgetGiB, 11.2)
  // An 8GB device: 8 * 0.68 = 5.44
  assert.equal(buildDeviceProfile(8).budgetGiB, 5.44)
})

test('no tier is ever assigned a budget larger than its physical RAM', () => {
  for (const tier of RAM_TIERS) {
    const p = buildDeviceProfile(tier)
    assert.ok(
      p.budgetGiB < tier,
      `tier ${tier} budget ${p.budgetGiB} must leave headroom for the OS`,
    )
  }
})

test('default context never exceeds the strategy cap of 8192 below the 24GB tier', () => {
  for (const tier of RAM_TIERS) {
    const p = buildDeviceProfile(tier)
    if (tier < 24) {
      assert.ok(
        p.defaultContextLength <= 8192,
        `tier ${tier} default context ${p.defaultContextLength} exceeds the 8192 default`,
      )
    }
  }
})

test('confidence distinguishes exact, promoted and clamped readings', () => {
  assert.equal(buildDeviceProfile(16).confidence, 'exact')
  assert.equal(buildDeviceProfile(15.3).confidence, 'promoted')
  assert.equal(buildDeviceProfile(2).confidence, 'clamped')
})

test('the description exposes the raw reading for support triage', () => {
  const d = describeDeviceProfile(buildDeviceProfile(15.3))
  assert.match(d, /16 GB tier/)
  assert.match(d, /15\.3/, 'the raw reading must be visible, not just the tier')
})

// ---------------------------------------------------------------------------
// Monotonicity: a bigger phone never gets a smaller capability
// ---------------------------------------------------------------------------

test('maxParametersB is monotonically non-decreasing across tiers', () => {
  let prev = 0
  for (const tier of RAM_TIERS) {
    const cur = buildDeviceProfile(tier).maxParametersB
    assert.ok(cur >= prev, `tier ${tier} capability ${cur} regressed below ${prev}`)
    prev = cur
  }
})

test('tier resolution is monotonic in the reading', () => {
  let prevTier: RamTier = 4
  for (let reading = 2; reading <= 26; reading += 0.25) {
    const t = resolveRamTier(reading)
    assert.ok(
      t >= prevTier,
      `reading ${reading} resolved down to ${t} from ${prevTier} — not monotonic`,
    )
    prevTier = t
  }
})
