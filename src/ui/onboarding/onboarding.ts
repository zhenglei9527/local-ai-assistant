/**
 * Onboarding view-model.
 *
 * WHY THIS FILE EXISTS
 *
 * `src/recommend/` is pure and testable under plain Node; `src/ui/` is TSX and
 * cannot be executed here at all (no Metro, no compile step on this machine).
 * Everything the recommendation screen *decides* — which line is worth
 * offering, which model is the pick, which card is expanded, how the numbers
 * are worded, whether the digest warning applies — therefore lives in this
 * file as pure functions, so it can be covered by `node --test` instead of
 * being eyeballed inside a component that never runs.
 *
 * The component that renders this is `RecommendScreen.tsx`, and it does no
 * arithmetic of its own. If a number is on screen, it was computed here.
 *
 * NO react-native, NO react, NO `@/` imports — plain relative `.ts` paths so
 * Node's type stripper can resolve them (the `@/` alias is a Metro/tsconfig
 * concern and does not exist at runtime under `node --test`).
 */

import {
  deviceBudgetGB,
  recommendModel,
  recommendOptions,
  runtimeCostGB,
  type FitLevel,
  type Recommendation,
  type RecommendOptions,
} from '../../recommend/recommend.ts'
import type { ModelLine } from '../../recommend/lines.ts'

// ---------------------------------------------------------------------------
// Device context
// ---------------------------------------------------------------------------

/**
 * Where the RAM figure came from, which decides how the screen talks about it.
 *
 * `probe`      — the real `ActivityManager.MemoryInfo` values (Phase 1 native
 *                module present).
 * `pessimistic` — `memoryProbe.ts` returned its `FALLBACK_SNAPSHOT` (4 GiB
 *                total), i.e. the native module is not installed yet.
 *
 * The distinction is load-bearing, not cosmetic. The fallback is deliberately
 * pessimistic, so on a real 12 GB phone without the native module the app will
 * confidently recommend a 4B model. Showing "4.0 GB detected" as a fact would
 * be a lie; showing it as "assumed 4 GB — not measured" is the truth, and the
 * screen offers a manual override for exactly this case.
 */
export type MemoryConfidence = 'probe' | 'pessimistic'

export interface DeviceContext {
  /** Physical RAM in GB, as the recommender's `RecommendOptions` wants it. */
  readonly totalRamGB: number
  readonly confidence: MemoryConfidence
  /**
   * True when the snapshot reports budget far below physical RAM, i.e. the
   * device is currently busy. Worth surfacing because it can change which
   * model is a good idea right now versus in ten minutes.
   */
  readonly underPressure: boolean
}

/** Provided by the call site (which has the snapshot) so this file stays pure. */
export interface DeviceSnapshotInput {
  readonly totalMemBytes: number
  readonly availMemBytes: number
  readonly lowRamDevice: boolean
}

const BYTES_PER_GB = 1024 ** 3

/**
 * The RAM figure `memoryProbe.ts` falls back to when the native module is
 * absent. Duplicated as a constant rather than imported so this module does
 * not pull in `react-native` (see file header). `onboarding.test.ts` pins the
 * two together, so a change to the probe's fallback fails a test here.
 */
export const PESSIMISTIC_TOTAL_GB = 4

/** Round to one decimal for display, and to keep RAM maths stable. */
function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/**
 * Decide the RAM figure to recommend against, and how much to trust it.
 *
 * Deliberately does NOT pick up `availMem` as the primary term. The
 * recommender's `deviceBudgetGB()` already applies its own usable-factor to
 * whatever total it is handed, and `availMem` is a *reclaimable* number that
 * already excludes page cache — feeding it in as "total" would apply the
 * usable factor twice and shrink the budget to the point where nothing but a
 * 0.6B model qualifies. Physical RAM is the input this engine was validated
 * against (see `recommend.test.ts`), so physical RAM is what it gets.
 */
export function describeDevice(snapshot: DeviceSnapshotInput): DeviceContext {
  const totalRamGB = round1(snapshot.totalMemBytes / BYTES_PER_GB)
  const confidence: MemoryConfidence =
    Math.abs(totalRamGB - PESSIMISTIC_TOTAL_GB) < 0.05 ? 'pessimistic' : 'probe'

  // An 8 GB phone idling at 2 GB available is under real pressure; the
  // recommendations still stand (they are budgeted from physical RAM) but the
  // user deserves to know that now is a bad moment to load a large model.
  const availRamGB = snapshot.availMemBytes / BYTES_PER_GB
  const underPressure = availRamGB > 0 && availRamGB < totalRamGB * 0.4

  return { totalRamGB, confidence, underPressure }
}

// ---------------------------------------------------------------------------
// Line + option selection
// ---------------------------------------------------------------------------

export type SelectableLine = ModelLine

/** One recommendation, already flattened for rendering. */
export interface ModelChoice {
  readonly id: string
  readonly recommendation: Recommendation
  /** Display name as the catalogue spells it. */
  readonly displayName: string
  /** Short architecture note, e.g. "Qwen3 · 4.0B". */
  readonly familyLabel: string
  readonly parametersB: number
  readonly quantization: string
  readonly sizeBytes: number
  /**
   * Size in GiB derived from exact bytes. Kept alongside the runtime estimate
   * because "you download this" and "it costs this in RAM" are different
   * numbers that users conflate.
   */
  readonly downloadGiB: number
  readonly runtimeGB: number
  readonly headroomGB: number
  readonly fit: FitLevel
  /** True when the model is split into several GGUF files. */
  readonly sharded: boolean
  readonly shardCount: number
  /**
   * True when this model must have its sha256 checked after download — the
   * abliterated line points at a movable `master` branch.
   */
  readonly requiresDigestCheck: boolean
  /** True when this is the engine's top pick for the device. */
  readonly isPrimary: boolean
}

export interface LineChoice {
  readonly line: SelectableLine
  readonly label: string
  /** The engine's top pick, or null when nothing on this line is viable. */
  readonly primary: ModelChoice | null
  /** Meaningfully different alternatives, best-first, excluding the primary. */
  readonly alternatives: readonly ModelChoice[]
  /**
   * True when the engine had to fall back to a quantization below 4 bits per
   * weight. Surfaced because it is a real quality trade, not a detail.
   */
  readonly degradedQuant: boolean
}

export interface LineAvailability {
  readonly line: SelectableLine
  readonly available: boolean
  readonly modelCount: number
}

export interface ModelSource {
  readonly id: string
  readonly displayName: string
  readonly family: string
  readonly parametersB: number
  readonly quantization: string
  readonly sizeBytes: number
  readonly sizeGiB: number
  readonly isSharded: boolean
  readonly shardCount: number
  readonly line: SelectableLine
  readonly requiresDigestCheck: boolean
  /** Non-null when the display catalogue has a digest for this model. */
  readonly sha256?: string | null
}

export interface BoardInput {
  readonly models: readonly ModelSource[]
  readonly device: DeviceContext
  /** Context length the runtime estimate assumes. Defaults to the engine's. */
  readonly contextLength?: number
}

/**
 * Number of alternatives to show beside the primary pick.
 *
 * Two is the deliberate choice. The engine's ranked list is already
 * de-duplicated by (family, parameter count), so a third alternative is
 * usually a *smaller family* that no user wants once they have seen the top
 * pick — it adds a scroll, not a decision. Two covers the only two trade
 * directions that matter in practice: "a bit smaller, more headroom" and "a
 * bit bigger, better output".
 */
export const ALTERNATIVES_SHOWN = 2

/**
 * Expand one engine recommendation into everything the card renders.
 *
 * `modelSizeGiB()` is intentionally NOT called here: the display source
 * already carries `sizeGiB` derived from the same byte count by the catalogue,
 * and `lineCatalog.test.ts` pins the two against each other, so re-deriving it
 * would be a second source of truth for the same number.
 */
function toChoice(
  rec: Recommendation,
  source: ModelSource,
  isPrimary: boolean,
): ModelChoice {
  return {
    id: rec.model.id,
    recommendation: rec,
    displayName: source.displayName,
    familyLabel: `${source.family} · ${formatParams(source.parametersB)}`,
    parametersB: source.parametersB,
    quantization: source.quantization,
    sizeBytes: source.sizeBytes,
    downloadGiB: source.sizeGiB,
    runtimeGB: rec.runtimeGB,
    headroomGB: rec.headroomGB,
    fit: rec.fit,
    sharded: source.isSharded,
    shardCount: source.shardCount,
    requiresDigestCheck: source.requiresDigestCheck,
    isPrimary,
  }
}

/**
 * Recommendation board for one line.
 *
 * The ranking itself is NOT reimplemented here — `recommendModel()` and
 * `recommendOptions()` own that, and this project has 79 tests pinning their
 * behaviour. This function only maps their output onto display fields, which
 * is why it cannot disagree with the engine about what to recommend.
 */
export function buildLineChoice(
  models: readonly ModelSource[],
  device: DeviceContext,
  line: SelectableLine,
  overrides: { readonly contextLength?: number; readonly minParametersB?: number } = {},
): LineChoice {
  const onLine = models.filter((m) => m.line === line)
  const label = line === 'official' ? 'Standard' : 'Uncensored'

  if (onLine.length === 0) {
    return {
      line,
      label,
      primary: null,
      alternatives: [],
      degradedQuant: false,
    }
  }

  const options: RecommendOptions = {
    totalRamGB: device.totalRamGB,
    ...(overrides.contextLength != null ? { contextLength: overrides.contextLength } : {}),
    ...(overrides.minParametersB != null ? { minParametersB: overrides.minParametersB } : {}),
  }

  const top = recommendModel(onLine, options)
  if (!top) {
    return { line, label, primary: null, alternatives: [], degradedQuant: false }
  }

  const byId = new Map(onLine.map((m) => [m.id, m]))
  const topSource = byId.get(top.model.id)
  if (!topSource) {
    // Cannot happen: `recommendModel` returns an entry drawn from `onLine`.
    // Failing loudly beats rendering a card with no display name.
    throw new Error(
      `Recommender returned "${top.model.id}", which is not on the ${line} line.`,
    )
  }

  const primary = toChoice(top, topSource, true)

  // Alternatives come from the ENGINE's own option list, not from a private
  // re-ranking. An earlier revision re-implemented the ordering here so that
  // it could drop same-parameter-count entries *after* ranking; that produced
  // a genuinely different answer from `recommendModel()` on low-memory
  // devices, because `recommendOptions()` sorts on parameter count first and
  // so offers a TIGHT 1.7B ahead of the GOOD 1.5B that `recommendModel()`
  // correctly prefers (see the MIN_HEADROOM_RATIO note in recommend.ts).
  // Presenting both at once meant the highlighted pick and the list beside it
  // contradicted each other. One ranking, one authority.
  const ranked = recommendOptions(onLine, options, ALTERNATIVES_SHOWN + 3)
  const alternatives: ModelChoice[] = []
  const seenParams = new Set<number>([top.model.parametersB])
  for (const rec of ranked) {
    if (rec.model.id === top.model.id) continue
    if (seenParams.has(rec.model.parametersB)) continue
    const source = byId.get(rec.model.id)
    if (!source) continue
    seenParams.add(rec.model.parametersB)
    alternatives.push(toChoice(rec, source, false))
    if (alternatives.length >= ALTERNATIVES_SHOWN) break
  }

  return {
    line,
    label,
    primary,
    alternatives,
    degradedQuant: quantIsDegraded(primary.quantization),
  }
}

/**
 * Bits per weight, mirroring `recommend.ts`'s table.
 *
 * Duplicated rather than exported from the engine so that this file can be
 * tested without reaching into the engine's private constants — and pinned by
 * `onboarding.test.ts` against the engine's `MIN_HEALTHY_BITS` boundary, so
 * the two cannot drift apart unnoticed.
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
}

/** Below this many bits per weight the engine considers output degraded. */
export const MIN_HEALTHY_BITS = 4.0

export function quantBits(quantization: string): number {
  return QUANT_BITS[quantization] ?? 4.5
}

export function quantIsDegraded(quantization: string): boolean {
  return quantBits(quantization) < MIN_HEALTHY_BITS
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export interface AlternativeGroup {
  /** "Smaller & safer" / "Bigger & sharper". */
  readonly title: string
  readonly subtitle: string
  readonly choices: readonly ModelChoice[]
}

/**
 * Split alternatives into the directions a user actually reasons about.
 *
 * A flat list of three cards makes the user compare three things on three axes
 * at once. Splitting them gives each alternative a one-line reason to exist,
 * which is what turns a list into a decision.
 *
 * ⚠ The grouping is by PARAMETER COUNT, and the subtitles deliberately do NOT
 * claim the smaller model is the memory-safer one. That claim is false often
 * enough to matter: at 8GB the engine's alternatives include a 3B at Q8_0
 * leaving 1.06 GB free while the 4B primary at Q6_K leaves 1.44 GB — the
 * "lighter" model is the riskier one, because quantization moves memory use
 * more than parameter count does at these sizes. Each card therefore carries
 * its own fit verdict and headroom figure; the group heading only describes
 * parameter count, which is the one thing it can honestly assert.
 */
export function groupAlternatives(
  primary: ModelChoice | null,
  alternatives: readonly ModelChoice[],
): AlternativeGroup[] {
  if (alternatives.length === 0) return []

  if (!primary) {
    return [
      {
        title: 'Available on this device',
        subtitle: 'Nothing fits the full budget, so these are the closest options.',
        choices: alternatives,
      },
    ]
  }

  const smaller = alternatives.filter((a) => a.parametersB < primary.parametersB)
  const larger = alternatives.filter((a) => a.parametersB > primary.parametersB)
  const same = alternatives.filter((a) => a.parametersB === primary.parametersB)

  const groups: AlternativeGroup[] = []
  if (smaller.length > 0) {
    groups.push({
      title: 'Smaller',
      subtitle: 'Fewer parameters. Check the memory figure — quantization varies.',
      choices: smaller,
    })
  }
  if (same.length > 0) {
    groups.push({
      title: 'Different flavor',
      subtitle: 'Same size, different model family.',
      choices: same,
    })
  }
  if (larger.length > 0) {
    groups.push({
      title: 'Bigger',
      subtitle: 'More parameters — better answers if the memory holds.',
      choices: larger,
    })
  }
  return groups
}

// ---------------------------------------------------------------------------
// Fit presentation
// ---------------------------------------------------------------------------

export interface FitPresentation {
  readonly label: string
  readonly detail: string
  /** `success` | `warning` | `danger` mapped to the theme's semantic colours. */
  readonly tone: 'success' | 'warning' | 'danger'
  /** 0..1 fill for the fit meter. NOT a probability — see below. */
  readonly fill: number
}

/**
 * Turn the engine's verdict into words, and into a meter.
 *
 * The meter is `headroom / budget`, i.e. "how much of the device budget is
 * still free after this model loads" — not a confidence score, and not
 * `runtime / budget`, which reads as "almost full" for a model the engine
 * called GOOD. A GOOD verdict at 40% headroom should look comfortable, and it
 * does under this definition.
 *
 * Clamped to [0.04, 1] so a device with enormous headroom still shows a sliver
 * rather than an invisible bar, and a failed fit shows an almost-full bar
 * rather than overflowing its track.
 */
export function describeFit(choice: ModelChoice, budgetGB: number): FitPresentation {
  const budget = budgetGB > 0 ? budgetGB : 1
  const ratio = choice.headroomGB / budget
  // `headroomGB` is negative when the model does not fit, so this floors to the
  // minimum sliver. The card text carries the failure; the bar is not asked to
  // render a negative quantity, and an empty track would read as "nothing to
  // see here" rather than "this will not work".
  const fill = Math.min(1, Math.max(0.04, ratio))

  switch (choice.fit) {
    case 'GOOD':
      return {
        label: 'Comfortable fit',
        detail: `About ${formatGB(choice.headroomGB)} of memory stays free after loading.`,
        tone: 'success',
        fill,
      }
    case 'TIGHT':
      return {
        label: 'Tight fit',
        detail:
          `Only ${formatGB(choice.headroomGB)} would be left free. It should run, but ` +
          'Android may close the app under pressure — close other apps first.',
        tone: 'warning',
        fill,
      }
    case 'NO':
      return {
        label: 'Will not fit',
        detail:
          `This model needs about ${formatGB(choice.runtimeGB)} and the device can only ` +
          `spare ${formatGB(budget)}. Expect it to be killed while loading. Try a lighter ` +
          'model above, or lower the context length in Settings.',
        tone: 'danger',
        fill,
      }
  }
}

/**
 * One-line summary of what is being asked of the device, for the header.
 *
 * Reads as a sentence rather than a stat block because it is the first thing
 * on the screen and the user has no frame of reference yet.
 */
export function describeBudget(device: DeviceContext): string {
  const budget = deviceBudgetGB(device.totalRamGB)
  if (device.confidence === 'pessimistic') {
    return `Assuming ${formatGB(device.totalRamGB)} of RAM — about ${formatGB(budget)} usable for a model.`
  }
  return `Using ${formatGB(device.totalRamGB)} of RAM — about ${formatGB(budget)} usable for a model.`
}

/** Short, honest caption about where the memory figure came from. */
export function describeMemorySource(device: DeviceContext): string {
  if (device.confidence === 'pessimistic') {
    return (
      'Not measured. The Android memory probe is not wired up yet, so the app is ' +
      'using a safe minimum — your phone may well handle a bigger model.'
    )
  }
  if (device.underPressure) {
    return 'Measured from the system, but the device looks busy right now.'
  }
  return 'Measured from the system.'
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format a GiB figure for display.
 *
 * The engine works in GiB everywhere (see the unit-discipline note in
 * `recommend.ts`), so the unit label says GiB and the app never silently
 * converts to decimal GB — a 2.33 GiB file shown as "2.5 GB" is the exact
 * class of rounding that caused the original OOM recommendations.
 *
 * Below 1 GiB the value is shown in MiB, because "0.4 GiB" is harder to read
 * than "410 MiB" and small models are common on budget phones.
 */
export function formatGiB(gib: number): string {
  if (!Number.isFinite(gib) || gib <= 0) return '—'
  if (gib < 1) return `${Math.round(gib * 1024)} MiB`
  return `${gib.toFixed(gib < 10 ? 2 : 1)} GiB`
}

/** Same convention as `formatGiB`, for the engine's GB-denominated outputs. */
export function formatGB(gb: number): string {
  if (!Number.isFinite(gb) || gb <= 0) return '—'
  if (gb < 1) return `${Math.round(gb * 1024)} MB`
  return `${gb.toFixed(gb < 10 ? 2 : 1)} GB`
}

/** "4.0B" / "0.6B" — never "4B params". */
export function formatParams(parametersB: number): string {
  if (!Number.isFinite(parametersB) || parametersB <= 0) return '?'
  return parametersB < 1 ? `${parametersB.toFixed(1)}B` : `${parametersB}B`
}

export interface SizePair {
  /** Bytes to fetch over the network. */
  readonly download: string
  /** Expected resident cost while running, including KV cache. */
  readonly runtime: string
}

/** The two numbers a user actually needs, as a matched pair for one row. */
export function sizePair(choice: ModelChoice): SizePair {
  return {
    download: formatGiB(choice.downloadGiB),
    runtime: formatGB(choice.runtimeGB),
  }
}

/**
 * Disk-space line for the primary pick.
 *
 * Reported against the download size (plus a verification headroom margin),
 * not the runtime estimate — the file has to fit on disk before it has to fit
 * in RAM, and conflating the two makes the number look scarier than it is.
 */
export function describeDownloadFootprint(choice: ModelChoice): string {
  const withMargin = choice.sizeBytes + Math.round(choice.sizeBytes * 0.05)
  return `Needs about ${formatGiB(withMargin / BYTES_PER_GB)} of free storage.`
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

export type WarningTone = 'warning' | 'danger' | 'info'

export interface OnboardingWarning {
  readonly id: string
  readonly tone: WarningTone
  readonly title: string
  readonly body: string
}

/**
 * The digest warning, for the uncensored line only.
 *
 * This is not boilerplate. The abliterated catalogue's URLs resolve through a
 * moving `master` branch and the pipeline recorded no commit SHA, so the
 * recorded sha256 is the ONLY thing pinning the bytes (see
 * docs/dual-line-integration.md §5). If verification is skipped there is
 * nothing else standing between the user and a swapped file.
 */
export function digestWarningFor(line: SelectableLine): OnboardingWarning | null {
  if (line !== 'abliterated') return null
  return {
    id: 'digest',
    tone: 'danger',
    title: 'sha256 verification is required',
    body:
      'These files are served from a moving `master` branch, so the checksum recorded ' +
      'at build time is the only thing pinning the download. The app verifies it after ' +
      'downloading; a mismatch fails the install rather than loading an altered file.',
  }
}

/** What the uncensored line is, in one honest sentence. */
export function uncensoredNoticeFor(line: SelectableLine): OnboardingWarning | null {
  if (line !== 'abliterated') return null
  return {
    id: 'uncensored',
    tone: 'info',
    title: 'Uncensored models',
    body:
      'Refusal behaviour has been removed from these models. They comply with more ' +
      'requests, at some cost to general coherence and reliability.',
  }
}

export function warningsFor(
  line: SelectableLine,
  choice: LineChoice,
): OnboardingWarning[] {
  const out: OnboardingWarning[] = []

  const uncensored = uncensoredNoticeFor(line)
  if (uncensored) out.push(uncensored)

  const digest = digestWarningFor(line)
  const needsDigest =
    choice.primary?.requiresDigestCheck === true ||
    choice.alternatives.some((a) => a.requiresDigestCheck)
  if (digest && needsDigest) out.push(digest)

  if (choice.degradedQuant) {
    out.push({
      id: 'degraded',
      tone: 'warning',
      title: 'Recompressed to fit',
      body:
        'Nothing at full quality fits this device, so the smallest usable version is ' +
        'shown. Expect noticeably rougher answers. Lowering the context length in ' +
        'Settings can free up enough memory to step back up.',
    })
  }

  return out
}

// ---------------------------------------------------------------------------
// Manual override
// ---------------------------------------------------------------------------

/**
 * Every model on a line, sorted for browsing.
 *
 * Sorted largest-first within a family because the user arriving here has
 * rejected the recommendation and is almost always looking *up* the ladder,
 * not down. Models that cannot fit still appear — that is the point of an
 * override — and the row shows the verdict so the choice stays informed.
 */
export function browseList(
  models: readonly ModelSource[],
  device: DeviceContext,
  line: SelectableLine,
): readonly ModelSource[] {
  return models
    .filter((m) => m.line === line)
    .slice()
    .sort((a, b) => {
      if (a.family !== b.family) return a.family.localeCompare(b.family)
      if (b.parametersB !== a.parametersB) return b.parametersB - a.parametersB
      return quantBits(b.quantization) - quantBits(a.quantization)
    })
}

// ---------------------------------------------------------------------------
// Board assembly
// ---------------------------------------------------------------------------

export interface OnboardingBoard {
  readonly device: DeviceContext
  readonly official: LineChoice
  readonly abliterated: LineChoice
  readonly lines: readonly LineAvailability[]
  /** Lines that actually have a viable model, in preference order. */
  readonly availableLines: readonly SelectableLine[]
  /** Which line to open on. */
  readonly initialLine: SelectableLine
}

/**
 * Assemble everything the screen renders, in one deterministic pass.
 *
 * Line preference: Standard first, because the aligned line is the one whose
 * behaviour is documented and whose quality the user has no reason to mistrust
 * yet. Uncensored remains one tap away and is never hidden — but defaulting a
 * first-time user into it, before they have read what it trades away, is not a
 * choice this app should make on their behalf.
 */
export function buildBoard(input: BoardInput): OnboardingBoard {
  const recommend = {
    ...(input.contextLength != null ? { contextLength: input.contextLength } : {}),
  }

  const official = buildLineChoice(input.models, input.device, 'official', recommend)
  const abliterated = buildLineChoice(input.models, input.device, 'abliterated', recommend)

  const lines: LineAvailability[] = [
    {
      line: 'official',
      available: official.primary !== null,
      modelCount: input.models.filter((m) => m.line === 'official').length,
    },
    {
      line: 'abliterated',
      available: abliterated.primary !== null,
      modelCount: input.models.filter((m) => m.line === 'abliterated').length,
    },
  ]

  const availableLines = lines.filter((l) => l.available).map((l) => l.line)
  const initialLine: SelectableLine = availableLines.includes('official')
    ? 'official'
    : (availableLines[0] ?? 'official')

  return { device: input.device, official, abliterated, lines, availableLines, initialLine }
}

/** Look up the choice for a line. Exists so the screen has no branch to get wrong. */
export function choiceFor(board: OnboardingBoard, line: SelectableLine): LineChoice {
  return line === 'official' ? board.official : board.abliterated
}

/**
 * True when the device can hold no model at all, in which case the screen
 * shows an explanation rather than an empty list.
 */
export function nothingFits(board: OnboardingBoard): boolean {
  return board.availableLines.length === 0
}

/** Runtime estimate at an explicit context, for the settings-style detail row. */
export function runtimeAtContext(choice: ModelChoice, contextLength: number): number {
  return runtimeCostGB(choice.recommendation.model, contextLength)
}
