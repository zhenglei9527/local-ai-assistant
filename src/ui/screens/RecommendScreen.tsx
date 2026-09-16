import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { colors, radii, spacing, typography } from '@/ui/theme'
import { ALL_MODELS, type LineDescriptor } from '@/data/models/lineCatalog'
import { readMemorySnapshot } from '@/data/models/memoryProbe'
import { deviceBudgetGB } from '@/recommend/recommend'
import type { MemorySnapshot, ModelRecord } from '@/types/domain'
import { useModelStore } from '@/store'
import {
  buildBoard,
  choiceFor,
  describeBudget,
  describeDevice,
  describeDownloadFootprint,
  describeFit,
  describeMemorySource,
  formatGiB,
  formatParams,
  groupAlternatives,
  nothingFits,
  sizePair,
  warningsFor,
  type DeviceContext,
  type DeviceSnapshotInput,
  type ModelChoice,
  type ModelSource,
  type OnboardingBoard,
  type SelectableLine,
  type WarningTone,
} from '@/ui/onboarding/onboarding'

/**
 * First-run model picker.
 *
 * This is the first screen a new user sees, and it has exactly one job: get
 * them to a model that will actually run on their phone without making them
 * understand quantization, KV-cache budgeting, or why an 8B model on an 8GB
 * device is a trap. Every number on this screen comes from
 * `@/ui/onboarding/onboarding` — the component does no arithmetic of its own,
 * because TSX cannot be executed on the build machine and pure functions can
 * be covered by `node --test`.
 *
 * LAYOUT INTENT
 *
 * The screen is a single vertical argument, in the order a user asks the
 * questions:
 *
 *   1. What does this app know about my phone?      → header stat strip
 *   2. What should I download?                      → the primary card
 *   3. Why that one?                                → the fit meter + facts
 *   4. What if I disagree?                          → alternatives, then browse
 *
 * The primary card is visually dominant (accent border, filled meter, the only
 * filled button) because a recommendation screen that presents three equal
 * options has not made a recommendation — it has moved the decision back to
 * someone who cannot make it.
 */
export function RecommendScreen({
  onDone,
}: {
  onDone: () => void
}): React.JSX.Element {
  const insets = useSafeAreaInsets()

  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null)
  const [line, setLine] = useState<SelectableLine>('official')
  const [browsing, setBrowsing] = useState(false)

  const records = useModelStore((s) => s.records)
  const startDownload = useModelStore((s) => s.startDownload)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const snap = await readMemorySnapshot()
      if (!cancelled) setSnapshot(snap)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const board: OnboardingBoard | null = useMemo(() => {
    if (!snapshot) return null
    const device = describeDevice(toSnapshotInput(snapshot))
    return buildBoard({ models: recommenderModels(), device })
  }, [snapshot])

  const onPick = useCallback(
    (id: string) => {
      void startDownload(id)
      // Go straight to chat. The download continues in the store; the Chat tab
      // explains what is happening and stays disabled until the model is
      // `ready`, which is the honest thing to show while a multi-GB file is in
      // flight.
      onDone()
    },
    [startDownload, onDone],
  )

  if (!board) {
    return (
      <View style={[styles.root, styles.centered, { paddingTop: insets.top }]}>
        <ActivityIndicator color={colors.accent} />
        <Text style={styles.loadingText}>Checking what this device can run…</Text>
      </View>
    )
  }

  const choice = choiceFor(board, line)
  const warnings = warningsFor(line, choice)

  return (
    <View style={styles.root}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + spacing.lg, paddingBottom: spacing.xxl },
        ]}
      >
        <Header device={board.device} />

        <LineTabs
          available={board.lines}
          active={line}
          onChange={(next) => {
            setLine(next)
            setBrowsing(false)
          }}
        />

        {warnings.map((w) => (
          <Notice key={w.id} tone={w.tone} title={w.title} body={w.body} />
        ))}

        {nothingFits(board) ? (
          <EmptyBoard device={board.device} />
        ) : browsing ? (
          <BrowseList
            models={browseRows(line)}
            records={records}
            onPick={onPick}
            onBack={() => setBrowsing(false)}
          />
        ) : (
          <>
            {choice.primary ? (
              <PrimaryCard
                choice={choice.primary}
                device={board.device}
                record={records[choice.primary.id]}
                onPick={() => onPick(choice.primary!.id)}
              />
            ) : (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Nothing available on this line</Text>
                <Text style={styles.body}>
                  No model on this line fits your device. Try the other line, or pick
                  something manually.
                </Text>
              </View>
            )}

            {choice.alternatives.length > 0 ? (
              <AlternativeGroups
                primary={choice.primary}
                alternatives={choice.alternatives}
                device={board.device}
                records={records}
                onPick={onPick}
              />
            ) : null}

            <Pressable
              accessibilityRole="button"
              onPress={() => setBrowsing(true)}
              style={({ pressed }) => [styles.browseBtn, pressed && styles.pressed]}
            >
              <Text style={styles.browseText}>
                Browse all {browseRows(line).length} models
              </Text>
            </Pressable>
          </>
        )}
      </ScrollView>

      {!browsing ? (
        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Skip for now"
            onPress={onDone}
            style={({ pressed }) => [styles.skipBtn, pressed && styles.pressed]}
          >
            <Text style={styles.skipText}>Skip for now</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  )
}

// ---------------------------------------------------------------------------
// Data adapters
// ---------------------------------------------------------------------------

/** The probe's snapshot, narrowed to the fields the view-model needs. */
function toSnapshotInput(snapshot: MemorySnapshot): DeviceSnapshotInput {
  return {
    totalMemBytes: snapshot.totalMem,
    availMemBytes: snapshot.availMem,
    lowRamDevice: snapshot.lowRamDevice,
  }
}

/**
 * Project the display catalogue onto the view-model's `ModelSource`.
 *
 * `ALL_MODELS` is the single display source: it carries `line` and
 * `requiresDigestCheck`, which the recommender's own `ModelEntry` does not
 * (see `lineCatalog.ts`). Both lines flow through `buildBoard`, which filters
 * by line itself, so one list is enough.
 */
function recommenderModels(): ModelSource[] {
  return ALL_MODELS.map((m: LineDescriptor) => ({
    id: m.id,
    displayName: m.displayName,
    family: m.author || m.displayName,
    parametersB: m.parametersB,
    quantization: m.quantization,
    sizeBytes: m.sizeBytes,
    sizeGiB: m.sizeBytes / 1024 ** 3,
    isSharded: m.files.length > 1,
    shardCount: m.files.length,
    line: m.line as SelectableLine,
    requiresDigestCheck: m.requiresDigestCheck,
    sha256: m.files[0]?.sha256 ?? null,
  }))
}

/**
 * Rows for the manual-override list.
 *
 * Sorted deterministically (largest first) rather than by the engine's
 * ranking: a user who opened this list has explicitly rejected the
 * recommendation, and hiding models that the engine considers wrong would
 * defeat the point of an override.
 */
function browseRows(line: SelectableLine): ModelSource[] {
  return recommenderModels()
    .filter((m) => m.line === line)
    .sort((a, b) => {
      if (b.parametersB !== a.parametersB) return b.parametersB - a.parametersB
      return a.displayName.localeCompare(b.displayName)
    })
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function Header({ device }: { device: DeviceContext }): React.JSX.Element {
  return (
    <View style={styles.header}>
      <Text style={styles.title}>Let’s pick a model</Text>
      <Text style={styles.subtitle}>
        Everything runs on this phone. Nothing is sent anywhere.
      </Text>

      <View style={styles.deviceStrip}>
        <DeviceStat
          label="RAM"
          value={`${device.totalRamGB} GB`}
          estimated={device.confidence === 'pessimistic'}
        />
        <View style={styles.stripDivider} />
        <View style={styles.deviceStat}>
          <Text style={styles.statValue} numberOfLines={2}>
            {describeBudget(device)}
          </Text>
        </View>
      </View>

      <Text style={styles.memorySource}>{describeMemorySource(device)}</Text>
    </View>
  )
}

function DeviceStat({
  label,
  value,
  estimated = false,
}: {
  label: string
  value: string
  estimated?: boolean
}): React.JSX.Element {
  return (
    <View style={styles.deviceStat}>
      <Text style={styles.statLabel}>{label.toUpperCase()}</Text>
      <View style={styles.statValueRow}>
        <Text style={styles.statValueStrong}>{value}</Text>
        {estimated ? <Text style={styles.estBadge}>assumed</Text> : null}
      </View>
    </View>
  )
}

// ---------------------------------------------------------------------------
// Line switcher
// ---------------------------------------------------------------------------

function LineTabs({
  available,
  active,
  onChange,
}: {
  available: OnboardingBoard['lines']
  active: SelectableLine
  onChange: (line: SelectableLine) => void
}): React.JSX.Element {
  return (
    <View style={styles.tabs}>
      {available.map((l) => {
        const selected = l.line === active
        const label = l.line === 'official' ? 'Standard' : 'Uncensored'
        return (
          <Pressable
            key={l.line}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(l.line)}
            style={({ pressed }) => [
              styles.tab,
              selected && styles.tabActive,
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.tabText, selected && styles.tabTextActive]}>
              {label}
            </Text>
            <Text style={[styles.tabCount, selected && styles.tabCountActive]}>
              {l.modelCount}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

// ---------------------------------------------------------------------------
// Primary recommendation
// ---------------------------------------------------------------------------

function PrimaryCard({
  choice,
  device,
  record,
  onPick,
}: {
  choice: ModelChoice
  device: DeviceContext
  record: ModelRecord | undefined
  onPick: () => void
}): React.JSX.Element {
  const fit = describeFit(choice, budgetFor(device))
  const sizes = sizePair(choice)
  const downloading = record?.state === 'downloading' || record?.state === 'paused'

  return (
    <View style={styles.primaryCard}>
      <View style={styles.recommendedRow}>
        <Text style={styles.recommended}>★ RECOMMENDED</Text>
        <FitPill tone={fit.tone} label={fit.label} />
      </View>

      <Text style={styles.primaryName}>{choice.displayName}</Text>
      <Text style={styles.primaryFamily}>{choice.familyLabel}</Text>

      <View style={styles.statGrid}>
        <GridStat label="Download" value={sizes.download} />
        <GridStat label="Runs in" value={sizes.runtime} />
        <GridStat label="Quant" value={choice.quantization} />
      </View>

      <FitMeter fill={fit.fill} tone={fit.tone} />
      <Text style={styles.fitDetail}>{fit.detail}</Text>

      <Text style={styles.footprint}>{describeDownloadFootprint(choice)}</Text>
      {choice.sharded ? (
        <Text style={styles.footprint}>
          Downloads as {choice.shardCount} files — keep the app open on Wi-Fi.
        </Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Download ${choice.displayName}`}
        onPress={onPick}
        style={({ pressed }) => [styles.cta, pressed && styles.pressed]}
      >
        <Text style={styles.ctaText}>
          {downloading ? 'Continue in chat' : `Download ${sizes.download}`}
        </Text>
      </Pressable>
    </View>
  )
}

function AlternativeGroups({
  primary,
  alternatives,
  device,
  records,
  onPick,
}: {
  primary: ModelChoice | null
  alternatives: readonly ModelChoice[]
  device: DeviceContext
  records: Record<string, ModelRecord>
  onPick: (id: string) => void
}): React.JSX.Element {
  const groups = groupAlternatives(primary, alternatives)
  return (
    <View style={styles.groups}>
      {groups.map((g) => (
        <View key={g.title} style={styles.group}>
          <Text style={styles.groupTitle}>{g.title}</Text>
          <Text style={styles.groupSubtitle}>{g.subtitle}</Text>
          {g.choices.map((c) => (
            <AlternativeCard
              key={c.id}
              choice={c}
              device={device}
              record={records[c.id]}
              onPick={() => onPick(c.id)}
            />
          ))}
        </View>
      ))}
    </View>
  )
}

function AlternativeCard({
  choice,
  device,
  record,
  onPick,
}: {
  choice: ModelChoice
  device: DeviceContext
  record: ModelRecord | undefined
  onPick: () => void
}): React.JSX.Element {
  const fit = describeFit(choice, budgetFor(device))
  const sizes = sizePair(choice)
  const downloading = record?.state === 'downloading' || record?.state === 'paused'

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Download ${choice.displayName}`}
      onPress={onPick}
      style={({ pressed }) => [styles.altCard, pressed && styles.pressed]}
    >
      <View style={styles.altHead}>
        <View style={styles.altHeadText}>
          <Text style={styles.altName} numberOfLines={1}>
            {choice.displayName}
          </Text>
          <Text style={styles.altMeta}>
            {choice.familyLabel} · {choice.quantization}
          </Text>
        </View>
        <FitPill tone={fit.tone} label={fit.label} compact />
      </View>

      <View style={styles.altFacts}>
        <MiniFact label="Download" value={sizes.download} />
        <MiniFact label="Runs in" value={sizes.runtime} />
        <MiniFact label="Free after" value={formatGiB(choice.headroomGB)} />
      </View>

      <Text style={styles.altAction}>{downloading ? 'Continue in chat' : 'Tap to download'}</Text>
    </Pressable>
  )
}

// ---------------------------------------------------------------------------
// Browse (manual override)
// ---------------------------------------------------------------------------

function BrowseList({
  models,
  records,
  onPick,
  onBack,
}: {
  models: readonly ModelSource[]
  records: Record<string, ModelRecord>
  onPick: (id: string) => void
  onBack: () => void
}): React.JSX.Element {
  return (
    <View style={styles.groups}>
      <Pressable
        accessibilityRole="button"
        onPress={onBack}
        style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
      >
        <Text style={styles.backText}>‹ Back to recommendations</Text>
      </Pressable>

      <Text style={styles.groupSubtitle}>
        Every model on this line. Sizes are the exact download, and large models
        are still listed even when this phone cannot hold them.
      </Text>

      {models.map((m) => {
        const record = records[m.id]
        const downloading =
          record?.state === 'downloading' || record?.state === 'paused'
        return (
          <Pressable
            key={m.id}
            accessibilityRole="button"
            accessibilityLabel={`Download ${m.displayName}`}
            onPress={() => onPick(m.id)}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <View style={styles.rowText}>
              <Text style={styles.rowName} numberOfLines={1}>
                {m.displayName}
              </Text>
              <Text style={styles.rowMeta}>
                {formatParams(m.parametersB)} · {m.quantization} ·{' '}
                {formatGiB(m.sizeGiB)}
                {m.isSharded ? ` · ${m.shardCount} shards` : ''}
              </Text>
            </View>
            <Text style={styles.rowGo}>{downloading ? '…' : '›'}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

// ---------------------------------------------------------------------------
// Empty / warning states
// ---------------------------------------------------------------------------

function EmptyBoard({ device }: { device: DeviceContext }): React.JSX.Element {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>No model fits this device</Text>
      <Text style={styles.body}>
        {describeBudget(device)} Even the smallest model in the catalogue needs more
        than that. Freeing up memory by closing other apps, or installing this app’s
        Android memory probe, may raise the estimate.
      </Text>
    </View>
  )
}

function Notice({
  tone,
  title,
  body,
}: {
  tone: WarningTone
  title: string
  body: string
}): React.JSX.Element {
  const border =
    tone === 'danger' ? colors.danger : tone === 'warning' ? colors.warning : colors.accent
  return (
    <View style={[styles.notice, { borderLeftColor: border }]}>
      <Text style={[styles.noticeTitle, { color: border }]}>{title}</Text>
      <Text style={styles.noticeBody}>{body}</Text>
    </View>
  )
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function FitPill({
  tone,
  label,
  compact = false,
}: {
  tone: 'success' | 'warning' | 'danger'
  label: string
  compact?: boolean
}): React.JSX.Element {
  const color =
    tone === 'success' ? colors.success : tone === 'warning' ? colors.warning : colors.danger
  return (
    <View style={[styles.pill, { borderColor: color }, compact && styles.pillCompact]}>
      <Text style={[styles.pillText, { color }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  )
}

/**
 * Headroom bar.
 *
 * The fill is "fraction of the device budget still free after loading", which
 * is why a GOOD verdict at 40% headroom looks comfortable rather than nearly
 * full — see `describeFit()` for why this is not `runtime / budget`.
 */
function FitMeter({
  fill,
  tone,
}: {
  fill: number
  tone: 'success' | 'warning' | 'danger'
}): React.JSX.Element {
  const color =
    tone === 'success' ? colors.success : tone === 'warning' ? colors.warning : colors.danger
  return (
    <View style={styles.meterTrack}>
      <View
        style={[styles.meterFill, { width: `${Math.round(fill * 100)}%`, backgroundColor: color }]}
      />
    </View>
  )
}

function GridStat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View style={styles.gridStat}>
      <Text style={styles.gridValue}>{value}</Text>
      <Text style={styles.gridLabel}>{label}</Text>
    </View>
  )
}

function MiniFact({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View style={styles.miniFact}>
      <Text style={styles.miniValue}>{value}</Text>
      <Text style={styles.miniLabel}>{label}</Text>
    </View>
  )
}

/**
 * The engine's budget for this device, in GB.
 *
 * This is the ONE number the component asks the engine for directly, because
 * `describeFit()` takes the budget as an argument rather than recomputing it —
 * keeping the engine's `deviceBudgetGB()` (the function the 79 pinned tests
 * exercise) as the single authority instead of a second copy of its factors.
 */
function budgetFor(device: DeviceContext): number {
  return deviceBudgetGB(device.totalRamGB)
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  centered: { alignItems: 'center', justifyContent: 'center', gap: spacing.md },
  loadingText: { ...typography.body, color: colors.textMuted },
  scroll: { flex: 1 },
  content: { paddingHorizontal: spacing.lg, gap: spacing.lg },

  header: { gap: spacing.sm },
  title: { ...typography.title, color: colors.text },
  subtitle: { ...typography.body, color: colors.textMuted },

  deviceStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  deviceStat: { flex: 1, gap: 2 },
  statLabel: {
    ...typography.caption,
    color: colors.textFaint,
    letterSpacing: 0.8,
    fontWeight: '700',
  },
  statValueRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  statValueStrong: { ...typography.body, color: colors.text, fontWeight: '700' },
  statValue: { ...typography.caption, color: colors.textMuted, lineHeight: 16 },
  estBadge: {
    ...typography.caption,
    color: colors.warning,
    fontSize: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.warning,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.xs,
  },
  stripDivider: { width: StyleSheet.hairlineWidth, alignSelf: 'stretch', backgroundColor: colors.border },
  memorySource: { ...typography.caption, color: colors.textFaint },

  tabs: {
    flexDirection: 'row',
    gap: spacing.xs,
    padding: 3,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceRaised,
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    borderRadius: radii.sm,
  },
  tabActive: { backgroundColor: colors.accent },
  tabText: { ...typography.body, color: colors.textMuted, fontWeight: '600' },
  tabTextActive: { color: '#FFFFFF' },
  tabCount: { ...typography.caption, color: colors.textFaint },
  tabCountActive: { color: '#DCE8FF' },

  notice: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderLeftWidth: 3,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    gap: 2,
  },
  noticeTitle: { ...typography.caption, fontWeight: '700', letterSpacing: 0.4 },
  noticeBody: { ...typography.caption, color: colors.textMuted, lineHeight: 17 },

  primaryCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1.5,
    borderColor: colors.accent,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  recommendedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  recommended: {
    ...typography.caption,
    color: colors.accent,
    fontWeight: '700',
    letterSpacing: 1,
  },
  primaryName: { ...typography.title, color: colors.text, lineHeight: 28 },
  primaryFamily: { ...typography.caption, color: colors.textMuted },

  statGrid: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.md,
    paddingVertical: spacing.sm,
    marginTop: spacing.xs,
  },
  gridStat: { flex: 1, alignItems: 'center', gap: 2 },
  gridValue: { ...typography.body, color: colors.text, fontWeight: '700' },
  gridLabel: { ...typography.caption, color: colors.textFaint },

  meterTrack: {
    height: 8,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceRaised,
    overflow: 'hidden',
    marginTop: spacing.xs,
  },
  meterFill: { height: '100%', borderRadius: radii.pill },
  fitDetail: { ...typography.caption, color: colors.textMuted, lineHeight: 17 },
  footprint: { ...typography.caption, color: colors.textFaint },

  cta: {
    minHeight: 52,
    marginTop: spacing.sm,
    borderRadius: radii.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaText: { color: '#FFFFFF', fontWeight: '700', fontSize: 16 },

  groups: { gap: spacing.md },
  group: { gap: spacing.xs },
  groupTitle: { ...typography.body, color: colors.text, fontWeight: '700' },
  groupSubtitle: { ...typography.caption, color: colors.textFaint, marginBottom: spacing.xs },

  altCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  altHead: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  altHeadText: { flex: 1, gap: 2 },
  altName: { ...typography.body, color: colors.text, fontWeight: '600' },
  altMeta: { ...typography.caption, color: colors.textMuted },
  altFacts: { flexDirection: 'row', gap: spacing.lg },
  miniFact: { gap: 1 },
  miniValue: { ...typography.caption, color: colors.text, fontWeight: '700' },
  miniLabel: { ...typography.caption, color: colors.textFaint, fontSize: 10 },
  altAction: { ...typography.caption, color: colors.accent, fontWeight: '600' },

  pill: {
    borderWidth: 1,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    flexShrink: 0,
  },
  pillCompact: { paddingVertical: 2 },
  pillText: { ...typography.caption, fontWeight: '700', fontSize: 11 },

  browseBtn: {
    minHeight: 48,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  browseText: { ...typography.body, color: colors.accent, fontWeight: '600' },

  backBtn: { alignSelf: 'flex-start', paddingVertical: spacing.xs },
  backText: { ...typography.body, color: colors.accent },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 56,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  rowText: { flex: 1, gap: 2 },
  rowName: { ...typography.body, color: colors.text, fontWeight: '600' },
  rowMeta: { ...typography.caption, color: colors.textMuted },
  rowGo: { ...typography.title, color: colors.accent },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  cardTitle: { ...typography.body, color: colors.text, fontWeight: '700' },
  body: { ...typography.body, color: colors.textMuted },

  footer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
  skipBtn: { minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  skipText: { ...typography.body, color: colors.textMuted },

  pressed: { opacity: 0.75 },
})
