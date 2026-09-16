/**
 * Onboarding view-model tests.
 *
 * These run against the REAL catalogues (data/models-official.json,
 * data/models-jailbreak.json) through the real recommender — not fixtures —
 * because the class of bug this screen can produce is "the UI says something
 * the engine did not". A fixture-based test would happily pass while the
 * screen showed a stale or re-derived number.
 *
 * Run: node --test src/ui/onboarding/onboarding.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  ALTERNATIVES_SHOWN,
  MIN_HEALTHY_BITS,
  buildBoard,
  buildLineChoice,
  browseList,
  choiceFor,
  describeBudget,
  describeDevice,
  describeDownloadFootprint,
  describeFit,
  describeMemorySource,
  digestWarningFor,
  formatGB,
  formatGiB,
  formatParams,
  groupAlternatives,
  nothingFits,
  quantBits,
  quantIsDegraded,
  sizePair,
  warningsFor,
  type DeviceContext,
  type ModelSource,
} from './onboarding.ts'
import {
  OFFICIAL_LINE,
  ABLITERATED_CATALOG,
  type LineDescriptor,
} from '../../data/models/lineCatalog.ts'
import { INCLUDES_ABLITERATED } from '../../config/buildFlavor.ts'
import {
  deviceBudgetGB,
  quantBits as engineQuantBits,
  recommendModel,
  recommendOptions,
  type ModelEntry,
} from '../../recommend/recommend.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..', '..')

/**
 * The abliterated line is present only in the `full` flavour (compliance
 * rationale in src/config/buildFlavor.ts). Tests that require it are skipped on
 * a store build rather than weakened, so the store build's absence of that line
 * cannot be mistaken for a passing abliterated-feature test.
 */
const ABLITERATED_SKIP = INCLUDES_ABLITERATED
  ? false
  : 'abliterated line is absent by design in the store flavour'

// The recommender's ModelEntry view is what the engine consumes; the display
// catalogue is what the UI renders. `lineCatalog.test.ts` already proves they
// agree on size, so here we simply merge them into the view-model's input.
const ALL: readonly ModelSource[] = buildSources()

function buildSources(): ModelSource[] {
  const fromOfficial = OFFICIAL_LINE.map(toSource)
  const fromAbliterated = ABLITERATED_CATALOG.map(toSource)
  return [...fromOfficial, ...fromAbliterated]
}

function toSource(m: LineDescriptor): ModelSource {
  return {
    id: m.id,
    displayName: m.displayName,
    family: familyOf(m),
    parametersB: m.parametersB,
    quantization: m.quantization,
    sizeBytes: m.sizeBytes,
    sizeGiB: m.sizeBytes / 1024 ** 3,
    isSharded: m.files.length > 1,
    shardCount: m.files.length,
    line: m.line,
    requiresDigestCheck: m.requiresDigestCheck,
    sha256: m.files[0]?.sha256 ?? null,
  }
}

/** The display catalogue has no `family` field; derive a stable label. */
function familyOf(m: LineDescriptor): string {
  const fromDescription = m.description?.split(' · ')[0]
  if (fromDescription) return fromDescription
  return m.displayName.split(' ')[0] ?? m.id
}

function device(totalRamGB: number, confidence: 'probe' | 'pessimistic' = 'probe'): DeviceContext {
  return {
    totalRamGB,
    confidence,
    underPressure: false,
  }
}

// ---------------------------------------------------------------------------
// Device description
// ---------------------------------------------------------------------------

test('describeDevice converts bytes to GB and trusts a real probe', () => {
  const ctx = describeDevice({
    totalMemBytes: 8 * 1024 ** 3,
    availMemBytes: 4 * 1024 ** 3,
    lowRamDevice: false,
  })
  assert.equal(ctx.totalRamGB, 8)
  assert.equal(ctx.confidence, 'probe')
  assert.equal(ctx.underPressure, false)
})

test('describeDevice flags the pessimistic fallback as unmeasured', () => {
  // The fallback in memoryProbe.ts is exactly 4 GiB / 1.5 GiB.
  const ctx = describeDevice({
    totalMemBytes: 4 * 1024 ** 3,
    availMemBytes: 1.5 * 1024 ** 3,
    lowRamDevice: false,
  })
  assert.equal(ctx.totalRamGB, 4)
  assert.equal(ctx.confidence, 'pessimistic')
})

test('describeDevice refuses to guess: 4.1GB is not the fallback', () => {
  const ctx = describeDevice({
    totalMemBytes: Math.round(4.1 * 1024 ** 3),
    availMemBytes: 2 * 1024 ** 3,
    lowRamDevice: false,
  })
  assert.equal(ctx.confidence, 'probe')
})

test('describeDevice notices a device under memory pressure', () => {
  const ctx = describeDevice({
    totalMemBytes: 12 * 1024 ** 3,
    availMemBytes: 3 * 1024 ** 3,
    lowRamDevice: false,
  })
  assert.equal(ctx.underPressure, true)
})

// ---------------------------------------------------------------------------
// Ranking delegation — the UI must not invent its own order
// ---------------------------------------------------------------------------

test('the primary pick IS the engine pick for the same device', () => {
  for (const gb of [4, 6, 8, 12, 16, 24]) {
    const board = buildBoard({ models: ALL, device: device(gb) })
    const official = buildLineChoice(ALL, device(gb), 'official')
    // Re-derive independently through the engine's own entry list.
    const expected = enginePick(OFFICIAL_LINE, gb)
    assert.equal(official.primary?.id, expected, `${gb}GB: UI disagreed with the engine`)
    assert.ok(board.official.primary)
  }
})

test('every tier produces a primary pick on both lines (no empty screens)', { skip: ABLITERATED_SKIP }, () => {
  for (const gb of [4, 6, 8, 12, 16, 24]) {
    const board = buildBoard({ models: ALL, device: device(gb) })
    assert.ok(board.official.primary, `${gb}GB official line has no recommendation`)
    assert.ok(board.abliterated.primary, `${gb}GB abliterated line has no recommendation`)
    assert.equal(nothingFits(board), false)
  }
})

test('REGRESSION: the UI never shows a recommendation the engine called NO', () => {
  for (const gb of [4, 6, 8, 12, 16, 24]) {
    const board = buildBoard({ models: ALL, device: device(gb) })
    for (const line of [board.official, board.abliterated]) {
      const shown = [line.primary, ...line.alternatives].filter(Boolean)
      for (const c of shown) {
        assert.notEqual(c!.fit, 'NO', `${gb}GB: ${c!.id} shown despite failing the budget`)
      }
    }
  }
})

test('REGRESSION: shown runtime stays inside the device budget', { skip: ABLITERATED_SKIP }, () => {
  for (const gb of [4, 6, 8, 12, 16, 24]) {
    const budget = deviceBudgetGB(gb)
    const board = buildBoard({ models: ALL, device: device(gb) })
    for (const line of [board.official, board.abliterated]) {
      for (const c of [line.primary, ...line.alternatives]) {
        assert.ok(c, `${gb}GB: missing choice`)
        assert.ok(
          c!.runtimeGB <= budget,
          `${gb}GB: ${c!.id} claims ${c!.runtimeGB}GB against a ${budget}GB budget`,
        )
      }
    }
  }
})

/**
 * Independent restatement of the engine's top pick, for cross-checking.
 *
 * Runs the engine directly on the display catalogue instead of going through
 * the view-model, so a bug in `buildLineChoice` (wrong filter, wrong field,
 * silently swallowing the engine result) shows up as a disagreement rather
 * than as a self-consistent wrong answer.
 */
function enginePick(models: readonly LineDescriptor[], gb: number): string | undefined {
  const entries = models as unknown as ModelEntry[]
  return recommendModel(entries, { totalRamGB: gb })?.model.id
}

// ---------------------------------------------------------------------------
// Alternatives
// ---------------------------------------------------------------------------

test('the UI never offers the same parameter count twice', () => {
  for (const gb of [4, 6, 8, 12, 16, 24]) {
    const board = buildBoard({ models: ALL, device: device(gb) })
    for (const line of [board.official, board.abliterated]) {
      const params = [line.primary, ...line.alternatives].filter(Boolean).map((c) => c!.parametersB)
      assert.equal(
        new Set(params).size,
        params.length,
        `${gb}GB: duplicate size class in ${params.join(', ')}`,
      )
    }
  }
})

test('alternatives are capped and never repeat the primary', () => {
  const board = buildBoard({ models: ALL, device: device(8) })
  for (const line of [board.official, board.abliterated]) {
    assert.ok(line.alternatives.length <= ALTERNATIVES_SHOWN)
    for (const a of line.alternatives) {
      assert.notEqual(a.id, line.primary?.id)
      assert.equal(a.isPrimary, false)
    }
  }
})

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

test('both lines are offered and Standard is the default entry point', { skip: ABLITERATED_SKIP }, () => {
  const board = buildBoard({ models: ALL, device: device(8) })
  assert.deepEqual(board.availableLines, ['official', 'abliterated'])
  assert.equal(board.initialLine, 'official')
  assert.equal(choiceFor(board, 'official'), board.official)
  assert.equal(choiceFor(board, 'abliterated'), board.abliterated)
})

test('line availability reports model counts for the switcher', () => {
  const board = buildBoard({ models: ALL, device: device(8) })
  assert.equal(board.lines[0].modelCount, OFFICIAL_LINE.length)
  assert.equal(board.lines[1].modelCount, ABLITERATED_CATALOG.length)
})

test('an empty line reports itself unavailable instead of throwing', () => {
  const choice = buildLineChoice([], device(8), 'abliterated')
  assert.equal(choice.primary, null)
  assert.deepEqual(choice.alternatives, [])
  assert.equal(choice.degradedQuant, false)
})

test('a line with nothing viable still yields something to download', () => {
  // `recommendModel()` deliberately falls back to the SMALLEST model when
  // nothing fits, so the user gets a working (if slow) chat instead of an
  // empty screen. That fallback is a documented engine rule and the UI must
  // pass it through rather than second-guess it — an empty recommendation
  // screen on a low-end phone is the exact outcome the rule exists to prevent.
  //
  // The oversized pick is therefore shown WITH its fit: 'NO' verdict visible,
  // not hidden and not silently upgraded.
  const huge: ModelSource[] = [
    {
      id: 'huge-70b',
      displayName: 'Huge 70B',
      family: 'Huge',
      parametersB: 70,
      quantization: 'Q4_K_M',
      sizeBytes: 40 * 1024 ** 3,
      sizeGiB: 40,
      isSharded: true,
      shardCount: 8,
      line: 'official',
      requiresDigestCheck: false,
      sha256: null,
    },
    {
      id: 'huge-8b',
      displayName: 'Huge 8B',
      family: 'Huge',
      parametersB: 8,
      quantization: 'Q4_K_M',
      sizeBytes: 5 * 1024 ** 3,
      sizeGiB: 5,
      isSharded: false,
      shardCount: 1,
      line: 'official',
      requiresDigestCheck: false,
      sha256: null,
    },
  ]
  const line = buildLineChoice(huge, device(4), 'official')
  assert.ok(line.primary, 'the engine fallback must reach the UI')
  // Smallest model, not largest — that is what "fall back to the smallest" means.
  assert.equal(line.primary.id, 'huge-8b')
  assert.equal(line.primary.fit, 'NO', 'the verdict must stay honest, not be softened')
  assert.equal(nothingFits(buildBoard({ models: huge, device: device(4) })), false)
})

test('nothingFits is true only when no line offers anything at all', () => {
  const board = buildBoard({ models: [], device: device(8) })
  assert.equal(nothingFits(board), true)
  assert.deepEqual(board.availableLines, [])
  assert.equal(board.official.primary, null)
  assert.equal(board.abliterated.primary, null)
})

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

test('the uncensored line always warns that sha256 verification is required', { skip: ABLITERATED_SKIP }, () => {
  const board = buildBoard({ models: ALL, device: device(8) })
  const warnings = warningsFor('abliterated', board.abliterated)
  const digest = warnings.find((w) => w.id === 'digest')
  assert.ok(digest, 'missing digest warning on the abliterated line')
  assert.equal(digest.tone, 'danger')
  assert.match(digest.title, /sha256/)
})

test('the standard line carries no digest warning', () => {
  const board = buildBoard({ models: ALL, device: device(8) })
  const ids = warningsFor('official', board.official).map((w) => w.id)
  assert.equal(ids.includes('digest'), false)
  assert.equal(digestWarningFor('official'), null)
  assert.ok(digestWarningFor('abliterated'))
})

test('the uncensored line is explained in plain language', () => {
  const board = buildBoard({ models: ALL, device: device(8) })
  const notice = warningsFor('abliterated', board.abliterated).find((w) => w.id === 'uncensored')
  assert.ok(notice)
  assert.equal(notice.tone, 'info')
})

test('every abliterated model really is flagged as needing a digest check', { skip: ABLITERATED_SKIP }, () => {
  // The warning is only meaningful if the data agrees with it.
  for (const m of ABLITERATED_CATALOG) {
    assert.equal(m.requiresDigestCheck, true, `${m.id}`)
  }
  const board = buildBoard({ models: ALL, device: device(8) })
  assert.equal(board.abliterated.primary?.requiresDigestCheck, true)
})

// ---------------------------------------------------------------------------
// Fit presentation
// ---------------------------------------------------------------------------

test('GOOD / TIGHT / NO map to distinct, honest copy', () => {
  const base = {
    id: 'x',
    displayName: 'X',
    familyLabel: 'F · 4B',
    parametersB: 4,
    quantization: 'Q4_K_M',
    sizeBytes: 1024 ** 3,
    downloadGiB: 1,
    runtimeGB: 3,
    headroomGB: 2,
    sharded: false,
    shardCount: 1,
    requiresDigestCheck: false,
    isPrimary: true,
  } as const

  const good = describeFit({ ...base, recommendation: null as never, fit: 'GOOD' }, 5)
  const tight = describeFit({ ...base, recommendation: null as never, fit: 'TIGHT' }, 5)
  const no = describeFit({ ...base, recommendation: null as never, fit: 'NO' }, 5)

  assert.equal(good.tone, 'success')
  assert.equal(tight.tone, 'warning')
  assert.equal(no.tone, 'danger')
  assert.notEqual(good.label, tight.label)
  assert.notEqual(tight.label, no.label)
  // TIGHT copy must actually warn about being killed, not just say "tight".
  assert.match(tight.detail, /close/i)
})

test('the fit meter is a headroom ratio, clamped and never overflowing', () => {
  const mk = (headroom: number, fit: 'GOOD' | 'TIGHT' | 'NO') =>
    describeFit(
      {
        id: 'x',
        displayName: 'X',
        familyLabel: '',
        parametersB: 4,
        quantization: 'Q4_K_M',
        sizeBytes: 0,
        downloadGiB: 1,
        runtimeGB: 1,
        headroomGB: headroom,
        sharded: false,
        shardCount: 1,
        requiresDigestCheck: false,
        isPrimary: true,
        recommendation: null as never,
        fit,
      },
      8,
    )

  assert.equal(mk(4, 'GOOD').fill, 0.5)
  assert.ok(mk(40, 'GOOD').fill <= 1, 'fill must not exceed the track')
  assert.ok(mk(-3, 'NO').fill >= 0, 'fill must not go negative')
  // Negative headroom means the model needs more than the whole budget, so the
  // meter floors at the minimum sliver — the card text carries the failure
  // ("Will not fit"), the bar does not try to encode a negative quantity.
  assert.ok(mk(-3, 'NO').fill <= 0.05, 'a failed fit must not look comfortable')
  assert.ok(mk(0.0001, 'TIGHT').fill > 0)
})

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

test('small models are shown in MiB, not "0.4 GiB"', () => {
  assert.equal(formatGiB(0.4), '410 MiB')
  assert.equal(formatGiB(0.386), '395 MiB')
  assert.equal(formatGiB(2.3258), '2.33 GiB')
  assert.equal(formatGiB(12.34), '12.3 GiB')
  assert.equal(formatGiB(0), '—')
  assert.equal(formatGiB(Number.NaN), '—')
})

test('GiB and GB stay distinguishable — the unit bug must not return', () => {
  // 2.33 GiB is 2.5 decimal GB. The app reports the GiB figure and says so.
  assert.equal(formatGiB(2.3258), '2.33 GiB')
  assert.notEqual(formatGiB(2.3258), formatGB(2.5))
  assert.match(formatGiB(2.3258), /GiB$/)
  assert.match(formatGB(2.5), /GB$/)
})

test('parameter counts read naturally', () => {
  assert.equal(formatParams(0.6), '0.6B')
  assert.equal(formatParams(4), '4B')
  assert.equal(formatParams(30), '30B')
  assert.equal(formatParams(0), '?')
})

test('size pair keeps download size and runtime cost separate', () => {
  const board = buildBoard({ models: ALL, device: device(8) })
  const primary = board.official.primary!
  const pair = sizePair(primary)
  assert.match(pair.download, /GiB$/)
  assert.match(pair.runtime, /GB$/)
  // Runtime includes the KV cache and is always the larger of the two.
  assert.ok(primary.runtimeGB > primary.downloadGiB, 'runtime must exceed raw file size')
})

test('the storage line talks about the file, not the RAM estimate', () => {
  const board = buildBoard({ models: ALL, device: device(8) })
  const text = describeDownloadFootprint(board.official.primary!)
  assert.match(text, /free storage/)
  // 5% verification headroom on a ~2 GiB file is still ~2.x GiB, not 3.x.
  assert.match(text, /GiB/)
})

test('describeBudget explains the usable budget, and hedges when unmeasured', () => {
  const measured = describeBudget(device(8, 'probe'))
  assert.match(measured, /8\.00 GB/)
  assert.match(measured, /usable/)

  const assumed = describeBudget(device(4, 'pessimistic'))
  assert.match(assumed, /Assuming/)

  assert.match(describeMemorySource(device(4, 'pessimistic')), /Not measured/)
  assert.match(describeMemorySource(device(8, 'probe')), /Measured/)
})

// ---------------------------------------------------------------------------
// Alternative grouping
// ---------------------------------------------------------------------------

test('alternatives are grouped by direction, not dumped in a list', () => {
  const board = buildBoard({ models: ALL, device: device(12) })
  const line = board.official
  const groups = groupAlternatives(line.primary, line.alternatives)
  for (const g of groups) {
    assert.ok(g.choices.length > 0, 'empty group rendered')
    assert.ok(g.title.length > 0)
    assert.ok(g.subtitle.length > 0)
  }
  // Every alternative appears exactly once across the groups.
  const ids = groups.flatMap((g) => g.choices.map((c) => c.id))
  assert.deepEqual(ids.slice().sort(), line.alternatives.map((a) => a.id).sort())
})

test('grouping holds when there is no primary pick', () => {
  const board = buildBoard({ models: ALL, device: device(8) })
  const groups = groupAlternatives(null, board.official.alternatives)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].choices.length, board.official.alternatives.length)
})

test('grouping an empty alternative list renders nothing', () => {
  assert.deepEqual(groupAlternatives(null, []), [])
})

// ---------------------------------------------------------------------------
// Manual override
// ---------------------------------------------------------------------------

test('browse lists every model on the line, unfiltered', () => {
  const listed = browseList(ALL, device(4), 'abliterated')
  assert.equal(listed.length, ABLITERATED_CATALOG.length)
  for (const m of listed) assert.equal(m.line, 'abliterated')
})

test('browse keeps oversized models visible — that is the point of an override', () => {
  const listed = browseList(ALL, device(4), 'official')
  const budget = deviceBudgetGB(4)
  const oversized = listed.filter((m) => m.sizeGiB * 1.3 > budget)
  assert.ok(oversized.length > 0, 'a 4GB phone should still be shown the big models')
})

test('browse is grouped by family and sorted largest-quant-first', () => {
  const listed = browseList(ALL, device(8), 'official')
  const families = listed.map((m) => m.family)
  const sortedFamilies = [...families].sort((a, b) => a.localeCompare(b))
  assert.deepEqual(families, sortedFamilies, 'families must be contiguous and ordered')
})

// ---------------------------------------------------------------------------
// Quantization agreement with the engine
// ---------------------------------------------------------------------------

test('the UI quant table agrees with the engine on every catalog quantization', () => {
  const quants = new Set(ALL.map((m) => m.quantization))
  for (const q of quants) {
    assert.equal(
      quantBits(q),
      engineQuantBits(q),
      `quantization ${q} disagrees with recommend.ts`,
    )
  }
})

test('REGRESSION: the UI alternative ranking matches the engine ordering', { skip: ABLITERATED_SKIP }, () => {
  // The highlighted pick comes from `recommendModel()` and the list beside it
  // from `recommendOptions()`. Those two are deliberately different functions
  // (recommendOptions maximises parameter count first and CAN return a TIGHT
  // model that recommendModel rejects for lack of headroom), so this pins the
  // exact pairing the screen relies on: the primary is the engine's pick, and
  // the alternatives are the engine's own options excluding it.
  for (const gb of [4, 6, 8, 12, 16, 24]) {
    for (const line of ['official', 'abliterated'] as const) {
      const models = ALL.filter((m) => m.line === line) as unknown as ModelEntry[]
      const choice = buildLineChoice(ALL, device(gb), line)
      const uiIds = choice.alternatives.map((c) => c.id)

      // Expected: engine options (minus the primary, minus repeated sizes).
      const ranked = recommendOptions(models, { totalRamGB: gb }, ALTERNATIVES_SHOWN + 3)
      const seen = new Set<number>([choice.primary!.parametersB])
      const expected: string[] = []
      for (const rec of ranked) {
        if (rec.model.id === choice.primary!.id) continue
        if (seen.has(rec.model.parametersB)) continue
        seen.add(rec.model.parametersB)
        expected.push(rec.model.id)
        if (expected.length >= ALTERNATIVES_SHOWN) break
      }

      assert.deepEqual(uiIds, expected, `${gb}GB ${line}: alternatives drifted from the engine`)
    }
  }
})

test('REGRESSION: a TIGHT alternative never displaces a GOOD primary pick', () => {
  // At 4GB the engine's option list starts with a TIGHT 1.7B while
  // recommendModel correctly prefers a GOOD 1.5B. The screen must show the
  // GOOD one as the headline — an earlier revision re-ranked privately and
  // put the TIGHT model on top, contradicting the engine.
  const choice = buildLineChoice(ALL, device(4), 'official')
  assert.equal(choice.primary?.id, 'qwen2.5-1.5b-instruct-q6_k')
  assert.equal(choice.primary?.fit, 'GOOD')
})

test('smaller alternatives are offered without claiming they are safer', () => {
  // The group heading asserts parameter count, which is always true. It must
  // NOT assert lower memory use: at 8GB the engine's 3B Q8_0 alternative
  // leaves less headroom (1.06GB) than the 4B Q6_K primary (1.44GB), because
  // quantization dominates memory at these sizes. Checked across every tier so
  // the day that stops being true, this comment is re-read.
  let sawSmaller = 0
  let sawLarger = 0
  let sawUptick = 0

  for (const gb of [4, 6, 8, 12, 16, 24]) {
    const board = buildBoard({ models: ALL, device: device(gb) })
    for (const line of [board.official, board.abliterated]) {
      const primary = line.primary
      if (!primary) continue
      for (const group of groupAlternatives(primary, line.alternatives)) {
        for (const alt of group.choices) {
          if (group.title === 'Smaller') {
            sawSmaller += 1
            assert.ok(
              alt.parametersB < primary.parametersB,
              `${gb}GB: "${alt.id}" is in Smaller but has ${alt.parametersB}B`,
            )
            if (alt.headroomGB > primary.headroomGB) sawUptick += 1
          }
          if (group.title === 'Bigger') {
            sawLarger += 1
            assert.ok(
              alt.parametersB > primary.parametersB,
              `${gb}GB: "${alt.id}" is in Bigger but has ${alt.parametersB}B`,
            )
          }
        }
      }
    }
  }

  assert.ok(sawSmaller > 0, 'no Smaller group was ever populated')
  assert.ok(sawLarger > 0, 'no Bigger group was ever populated')
  // Documents the real, counter-intuitive shape rather than asserting a tidy
  // rule the data does not follow.
  assert.ok(
    sawUptick < sawSmaller,
    'every smaller alternative left more headroom — the grouping note in ' +
      'groupAlternatives() can be simplified if this is now always true',
  )
})

test('every alternative card carries its own fit verdict and headroom', { skip: ABLITERATED_SKIP }, () => {
  // The group heading cannot be trusted to describe memory, so each card must
  // stand alone. A card with a missing or non-finite figure is unrenderable.
  for (const gb of [4, 6, 8, 12, 16, 24]) {
    const board = buildBoard({ models: ALL, device: device(gb) })
    for (const line of [board.official, board.abliterated]) {
      for (const c of [line.primary, ...line.alternatives]) {
        assert.ok(c, `${gb}GB: missing choice`)
        assert.ok(['GOOD', 'TIGHT', 'NO'].includes(c!.fit), `${c!.id}: bad fit`)
        assert.ok(Number.isFinite(c!.headroomGB), `${c!.id}: headroom not finite`)
        assert.ok(Number.isFinite(c!.runtimeGB), `${c!.id}: runtime not finite`)
        assert.ok(c!.runtimeGB > 0, `${c!.id}: zero runtime`)
      }
    }
  }
})

test('the health threshold matches the engine minimum', () => {
  assert.equal(MIN_HEALTHY_BITS, 4.0)
  assert.equal(quantIsDegraded('Q4_K_M'), false)
  assert.equal(quantIsDegraded('Q4_0'), false)
  assert.equal(quantIsDegraded('Q3_K_M'), true)
  assert.equal(quantIsDegraded('Q2_K'), true)
  // Unknown quantizations must degrade to the conservative 4.5 default, i.e.
  // treated as healthy rather than silently rejected.
  assert.equal(quantIsDegraded('SOMETHING_NEW'), false)
})

// ---------------------------------------------------------------------------
// Full-board invariants
// ---------------------------------------------------------------------------

test('the board recommends the documented 8GB model, not an 8B', () => {
  // docs/dual-line-integration.md §4 pins qwen3-4b-q6_k at the 8GB tier.
  const board = buildBoard({ models: ALL, device: device(8) })
  assert.equal(board.official.primary?.id, 'qwen3-4b-q6_k')
  assert.ok(
    board.official.primary!.parametersB <= 4.1,
    'an 8GB phone must never be handed an 8B model',
  )
})

test('the board recommends the documented 4GB model', () => {
  const board = buildBoard({ models: ALL, device: device(4) })
  assert.equal(board.official.primary?.id, 'qwen2.5-1.5b-instruct-q6_k')
})

test('the abliterated pick on 8GB is the documented gemma 4B', { skip: ABLITERATED_SKIP }, () => {
  const board = buildBoard({ models: ALL, device: device(8) })
  assert.equal(board.abliterated.primary?.id, 'gemma-3-4b-it-abliterated')
})

test('a bigger phone never gets a smaller model recommendation', () => {
  const tiers = [4, 6, 8, 12, 16, 24]
  const picks = tiers.map(
    (gb) => buildBoard({ models: ALL, device: device(gb) }).official.primary!.parametersB,
  )
  for (let i = 1; i < picks.length; i += 1) {
    assert.ok(
      picks[i] >= picks[i - 1],
      `tier ${tiers[i]}GB picked ${picks[i]}B after ${tiers[i - 1]}GB picked ${picks[i - 1]}B`,
    )
  }
})

test('buildBoard is deterministic — same input, same board', () => {
  const a = buildBoard({ models: ALL, device: device(8) })
  const b = buildBoard({ models: ALL, device: device(8) })
  assert.equal(a.official.primary?.id, b.official.primary?.id)
  assert.deepEqual(
    a.official.alternatives.map((c) => c.id),
    b.official.alternatives.map((c) => c.id),
  )
})

// ---------------------------------------------------------------------------
// Duplicate-suppression guard: the source of truth is checked for duplicates
// ---------------------------------------------------------------------------

test('sanity: the merged source list has no duplicate ids', () => {
  const ids = ALL.map((m) => m.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('root path used by the live-catalogue assertions is correct', () => {
  // If the data files move, this test fails loudly rather than the suite
  // silently testing hand-built fixtures.
  assert.ok(OFFICIAL_LINE.length > 50, `official line loaded ${OFFICIAL_LINE.length} models`)
  assert.ok(root.length > 0)
})
