import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'

import { ScreenScaffold } from '@/ui/ScreenScaffold'
import { colors, radii, spacing, typography } from '@/ui/theme'
import { OFFICIAL_LINE, type LineDescriptor } from '@/data/models/lineCatalog'
import {
  estimateModelMemory,
  evaluateFit,
  formatBytes,
  memoryProbeAvailable,
  readMemorySnapshot,
  suggestContextLength,
} from '@/data/models/memoryProbe'
import type { MemorySnapshot, ModelRecord } from '@/types/domain'
import { useEngineStore, useModelStore, useSettingsStore } from '@/store'
import {
  PROVIDER_PRESETS,
  REMOTE_PRIVACY_NOTICE,
  validateProviderConfig,
} from '@/inference/remote/providerConfig'

/**
 * Model page — two sources, one tab each.
 *
 * ── Why tabs and not a settings toggle ─────────────────────────────────────
 * "Local GGUF" and "cloud API" are not two settings; they are two answers to
 * the same question ("where does the model live?"). Presenting them as sibling
 * tabs makes the tradeoff visible at the moment of choosing, and makes it
 * obvious that picking cloud means the conversation leaves the device.
 *
 * ── The local tab ──────────────────────────────────────────────────────────
 * The memory gate lives here: every row shows an estimated peak RAM and a
 * verdict, computed BEFORE the user commits to a multi-GB download. Letting
 * someone spend 20 minutes downloading a model that the phone then refuses to
 * load is the single worst UX failure this app can have, and it is entirely
 * avoidable with `MemoryInfo.availMem` (see memoryProbe.ts for why
 * `Runtime.maxMemory()` must not be used).
 */
type SourceTab = 'local' | 'downloaded' | 'cloud'

export function ModelManagerScreen(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null)
  const [probing, setProbing] = useState(true)
  const [tab, setTab] = useState<SourceTab>('local')

  const records = useModelStore((s) => s.records)
  const startDownload = useModelStore((s) => s.startDownload)
  const pauseDownload = useModelStore((s) => s.pauseDownload)
  const removeModel = useModelStore((s) => s.removeModel)

  // Which model the engine currently holds, and how loading is going.
  const engineStatus = useEngineStore((s) => s.status)
  const loadedModelId = useEngineStore((s) => s.modelId)
  const loadProgress = useEngineStore((s) => s.loadProgress)
  const engineError = useEngineStore((s) => s.error)
  const loadModel = useEngineStore((s) => s.loadModel)
  const unloadModel = useEngineStore((s) => s.unloadModel)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const snap = await readMemorySnapshot()
      if (!cancelled) {
        setSnapshot(snap)
        setProbing(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * Confirm before deleting.
   *
   * Deleting is irreversible from the user's point of view — the bytes are
   * gone and re-downloading a 4 GB model on mobile data is a real cost. The
   * previous version deleted on a single tap.
   */
  /**
   * Catalogue entries the user has engaged with.
   *
   * Derived from `records` rather than a separate list, so the tab cannot drift
   * out of sync with download state. Any state other than `not-downloaded`
   * counts: a half-finished download belongs here too, because that is where
   * the user goes to find it and resume.
   */
  const downloadedModels = useMemo(
    () => OFFICIAL_LINE.filter((m) => (records[m.id]?.state ?? 'not-downloaded') !== 'not-downloaded'),
    [records],
  )

  const confirmRemove = useCallback(    (model: LineDescriptor) => {
      Alert.alert(
        '删除模型',
        `确定要删除「${model.displayName}」吗？\n\n` +
          `将释放 ${formatBytes(model.sizeBytes)} 空间。如需再次使用必须重新下载。`,
        [
          { text: '取消', style: 'cancel' },
          {
            text: '删除',
            style: 'destructive',
            onPress: () => {
              // Unload first when the model being deleted is the loaded one —
              // deleting the file out from under a live context leaves the
              // engine pointing at a path that no longer exists.
              if (loadedModelId === model.id) {
                void unloadModel().then(() => removeModel(model.id))
              } else {
                void removeModel(model.id)
              }
            },
          },
        ],
      )
    },
    [loadedModelId, unloadModel, removeModel],
  )

  const renderItem = useCallback(
    ({ item }: { item: LineDescriptor }) => (
      <ModelRow
        model={item}
        record={records[item.id]}
        snapshot={snapshot}
        isLoaded={loadedModelId === item.id}
        isLoading={engineStatus === 'loading' && loadedModelId === item.id}
        loadProgress={loadProgress}
        onDownload={() => void startDownload(item.id)}
        onPause={() => void pauseDownload(item.id)}
        onRemove={() => confirmRemove(item)}
        onLoad={() => void loadModel(item.id)}
        onUnload={() => void unloadModel()}
      />
    ),
    [
      records,
      snapshot,
      loadedModelId,
      engineStatus,
      loadProgress,
      startDownload,
      pauseDownload,
      confirmRemove,
      loadModel,
      unloadModel,
    ],
  )

  return (
    <ScreenScaffold
      title="模型"
      subtitle={
        tab === 'cloud'
          ? '使用第三方 API，对话会离开本机'
          : probing
            ? '正在检测设备内存…'
            : snapshot
              ? `共 ${formatBytes(snapshot.totalMem)}，可用 ${formatBytes(snapshot.availMem)}`
              : '无法读取内存信息'
      }
      scroll={false}
    >
      <SourceTabs tab={tab} onChange={setTab} downloadedCount={downloadedModels.length} />

      {/*
        Load failures are the one error the user must not miss. An out-of-memory
        rejection from llama.rn otherwise just leaves the button unresponsive,
        which reads as "the app ignored my tap".
      */}
      {tab === 'local' && engineStatus === 'error' && engineError ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorBannerText}>模型加载失败：{engineError}</Text>
        </View>
      ) : null}

      {tab === 'downloaded' ? (
        <FlatList
          contentContainerStyle={styles.listContent}
          data={downloadedModels}
          keyExtractor={(m) => m.id}
          renderItem={renderItem}
          ListEmptyComponent={
            <View style={styles.downloadedEmpty}>
              <Text style={styles.downloadedEmptyGlyph}>{'\u{1F4E5}'}</Text>
              <Text style={styles.downloadedEmptyTitle}>还没有已下载的模型</Text>
              <Text style={styles.downloadedEmptyBody}>
                到「标准」页选一个模型下载。下载完成后会出现在这里，可以加载并开始对话。
              </Text>
            </View>
          }
        />
      ) : tab === 'local' ? (
        <>
          {!memoryProbeAvailable() && !probing ? (
            <View style={styles.notice}>
              <Text style={styles.noticeText}>
                未能读取本机内存，正在使用保守估算值。可能是{' '}
                <Text style={styles.mono}>PhoneLlmSystem</Text>{' '}
                原生模块未注册，或当前不是 Android 环境。
              </Text>
            </View>
          ) : null}

          <FlatList
            contentContainerStyle={styles.listContent}
            data={OFFICIAL_LINE}
            keyExtractor={(m) => m.id}
            renderItem={renderItem}
            ListEmptyComponent={<Text style={styles.empty}>暂无可下载的模型。</Text>}
          />
        </>
      ) : (
        <CloudPanel />
      )}
    </ScreenScaffold>
  )
}

/** Switches the page between on-device models and a cloud API. */
function SourceTabs({
  tab,
  onChange,
  downloadedCount,
}: {
  tab: SourceTab
  onChange: (next: SourceTab) => void
  /** Shown on the Downloaded tab so the count is visible without opening it. */
  downloadedCount: number
}): React.JSX.Element {
  const tabs: { key: SourceTab; label: string }[] = [
    { key: 'local', label: '标准' },
    { key: 'downloaded', label: `已下载 (${downloadedCount})` },
    { key: 'cloud', label: '云端' },
  ]
  return (
    <View style={styles.tabs}>
      {tabs.map((t) => {
        const active = t.key === tab
        return (
          <Pressable
            key={t.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(t.key)}
            style={({ pressed }) => [
              styles.tab,
              active && styles.tabActive,
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.tabText, active && styles.tabTextActive]}>{t.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

/**
 * Cloud API configuration.
 *
 * Deliberately minimal: a provider preset, a model name, and an API key. The
 * request protocol (OpenAI-compatible vs Anthropic) is a property of the
 * preset rather than a user-facing choice, because getting it wrong produces a
 * 400 that reads like a credentials problem.
 *
 * The privacy notice is not decoration. `AndroidManifest.xml` declares
 * INTERNET with the comment "Model downloads only" — that comment is a lie the
 * moment this tab is used, and the user has to be told before their first
 * message, not after.
 */
function CloudPanel(): React.JSX.Element {
  const provider = useSettingsStore((s) => s.remoteProvider)
  const setRemoteProvider = useSettingsStore((s) => s.setRemoteProvider)

  /**
   * Test-connection state.
   *
   * `null` means "not yet tested since the last edit" — deliberately reset on
   * every field change, because a stale "连接成功" next to an edited URL is
   * worse than no result at all: it asserts something untested.
   */
  const [testResult, setTestResult] = useState<
    { ok: boolean; message: string; latencyMs: number; status: number | null } | null
  >(null)
  const [testing, setTesting] = useState(false)

  const applyPreset = useCallback(
    (id: string) => {
      const preset = PROVIDER_PRESETS.find((p) => p.id === id)
      if (!preset) return
      // Keep the user's key: switching provider is about the endpoint, and
      // making them re-paste a key for an unrelated change is hostile.
      setRemoteProvider({
        id: preset.id,
        label: preset.label,
        protocol: preset.protocol,
        baseUrl: preset.baseUrl,
        model: preset.suggestedModel,
      })
      setTestResult(null)
    },
    [setRemoteProvider],
  )

  const onEdit = useCallback(
    (patch: Record<string, string>) => {
      setRemoteProvider(patch)
      setTestResult(null)
    },
    [setRemoteProvider],
  )

  const onTest = useCallback(async () => {
    if (testing) return
    setTesting(true)
    setTestResult(null)
    try {
      const { testRemoteProvider } = await import('@/inference/remote/RemoteEngine.ts')
      setTestResult(await testRemoteProvider(provider))
    } catch (error) {
      setTestResult({
        ok: false,
        message: error instanceof Error ? error.message : '测试失败',
        latencyMs: 0,
        status: null,
      })
    } finally {
      setTesting(false)
    }
  }, [testing, provider])

  /**
   * Advisory validation, shown live.
   *
   * Not a hard block: these checks are heuristics (a space in the model name is
   * *probably* a product name), and refusing to let someone proceed would be
   * wrong for a self-hosted endpoint with unusual naming. They are surfaced
   * because the alternative is the failure this app actually shipped — a wrong
   * model name that produced no error message at all.
   */
  const problems = validateProviderConfig(provider)

  return (
    <ScrollView
      style={styles.cloudScroll}
      contentContainerStyle={styles.cloudContent}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.notice}>
        <Text style={styles.noticeText}>{REMOTE_PRIVACY_NOTICE}</Text>
      </View>

      <Text style={styles.cloudLabel}>服务商</Text>
      <View style={styles.presetRow}>
        {PROVIDER_PRESETS.map((p) => {
          const active = p.id === provider.id
          return (
            <Pressable
              key={p.id}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => applyPreset(p.id)}
              style={({ pressed }) => [
                styles.presetChip,
                active && styles.presetChipActive,
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.presetText, active && styles.presetTextActive]}>
                {p.label}
              </Text>
            </Pressable>
          )
        })}
      </View>

      <Text style={styles.cloudLabel}>接口地址</Text>
      <TextInput
        style={styles.cloudInput}
        value={provider.baseUrl}
        onChangeText={(v) => onEdit({ baseUrl: v })}
        placeholder="https://api.deepseek.com/v1"
        placeholderTextColor={colors.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />

      <Text style={styles.cloudLabel}>模型名称</Text>
      <TextInput
        style={styles.cloudInput}
        value={provider.model}
        onChangeText={(v) => onEdit({ model: v })}
        placeholder="deepseek-chat"
        placeholderTextColor={colors.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
      />

      <Text style={styles.cloudLabel}>API Key</Text>
      <TextInput
        style={styles.cloudInput}
        value={provider.apiKey}
        onChangeText={(v) => onEdit({ apiKey: v })}
        placeholder="sk-..."
        placeholderTextColor={colors.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
      />

      {problems.length > 0 ? (
        <View style={styles.cloudWarn}>
          {problems.map((p) => (
            <Text key={p} style={styles.cloudWarnText}>
              • {p}
            </Text>
          ))}
        </View>
      ) : null}

      {/*
        Test button. Without it the only way to find out that a URL or key is
        wrong is to send a real message and read the error — which wastes the
        user's time and, for a paid endpoint, can bill a failed request.
      */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="测试连接"
        onPress={() => void onTest()}
        disabled={testing}
        style={({ pressed }) => [
          styles.testBtn,
          testing && styles.testBtnBusy,
          pressed && styles.pressed,
        ]}
      >
        {testing ? (
          <ActivityIndicator size="small" color="#FFFFFF" />
        ) : (
          <Text style={styles.testBtnText}>测试连接</Text>
        )}
      </Pressable>

      {testResult ? (
        <View
          style={[
            styles.testResult,
            testResult.ok ? styles.testResultOk : styles.testResultBad,
          ]}
        >
          <Text
            style={[
              styles.testResultText,
              { color: testResult.ok ? colors.success : colors.danger },
            ]}
          >
            {testResult.ok ? '✓ ' : '✕ '}
            {testResult.message}
          </Text>
          {testResult.latencyMs > 0 ? (
            <Text style={styles.testResultMeta}>
              耗时 {testResult.latencyMs} ms
              {testResult.status != null ? ` · HTTP ${testResult.status}` : ''}
            </Text>
          ) : null}
        </View>
      ) : null}

      <Text style={styles.cloudHint}>
        Key 只保存在本机，不会上传。测试通过后，回到「设置」把模型来源切到「云端」，
        或在对话页左侧的模型选择器里选「云端」即可使用。
      </Text>
    </ScrollView>
  )
}

function ModelRow({
  model,
  record,
  snapshot,
  isLoaded,
  isLoading,
  loadProgress,
  onDownload,
  onPause,
  onRemove,
  onLoad,
  onUnload,
}: {
  model: LineDescriptor
  record: ModelRecord | undefined
  snapshot: MemorySnapshot | null
  /** This model is the one currently resident in the engine. */
  isLoaded: boolean
  /** This model is being loaded right now. */
  isLoading: boolean
  /** 0..100, meaningful only while `isLoading`. */
  loadProgress: number
  onDownload: () => void
  onPause: () => void
  onRemove: () => void
  onLoad: () => void
  onUnload: () => void
}): React.JSX.Element {
  const state = record?.state ?? 'not-downloaded'

  // Estimate at the largest context that would fit, so the verdict reflects
  // the best case rather than an arbitrary default.
  const estimate = estimateModelMemory({
    model,
    contextLength: snapshot
      ? Math.min(model.contextLength, suggestContextLength(model, snapshot) || 2048)
      : 4096,
    cacheTypeK: 'f16',
    cacheTypeV: 'f16',
  })
  const verdict = snapshot ? evaluateFit(estimate, snapshot) : null

  const progressPct =
    record && model.sizeBytes > 0
      ? Math.min(100, Math.round(((record.bytesOnDisk ?? 0) / model.sizeBytes) * 100))
      : 0

  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <View style={styles.cardHeadText}>
          <Text style={styles.name}>{model.displayName}</Text>
          <Text style={styles.meta}>
            {model.author} · {model.quantization} · {formatBytes(model.sizeBytes)} ·{' '}
            {model.parametersB}B params
          </Text>
        </View>
        <StateChip state={state} isLoaded={isLoaded} />
      </View>

      {isLoaded ? (
        <Text style={styles.inUse}>● 正在使用中 — 对话页会用这个模型回复</Text>
      ) : null}

      {model.description ? <Text style={styles.desc}>{model.description}</Text> : null}

      <View style={styles.factsRow}>
        <Fact label="上下文" value={`${(model.contextLength / 1024).toFixed(0)}K`} />
        <Fact label="层数" value={String(model.layerCount)} />
        <Fact label="分片" value={String(model.files.length)} />
      </View>

      <View style={styles.memoryBox}>
        <Text style={styles.memoryLine}>
          运行占用约 {formatBytes(estimate.totalBytes)}（权重 {formatBytes(estimate.weightsBytes)} +
          缓存 {formatBytes(estimate.kvCacheBytes)}）
        </Text>
        {verdict ? (
          <Text style={[styles.verdict, verdict.fits ? styles.verdictOk : styles.verdictBad]}>
            {verdict.comfortable
              ? '✓ 运行流畅'
              : verdict.fits
                ? '⚠ 勉强能跑 — 内存紧张时可能被系统关闭'
                : '✕ 超出本机内存'}
          </Text>
        ) : null}
        {verdict?.reason && !verdict.comfortable ? (
          <Text style={styles.verdictDetail}>{verdict.reason}</Text>
        ) : null}
        {model.requiresDigestCheck ? (
          <Text style={styles.verdictDetail}>下载后将校验 sha256（该仓库跟随可变分支）</Text>
        ) : null}
      </View>

      {state === 'downloading' || state === 'paused' || state === 'verifying' ? (
        <View style={styles.progressWrap}>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${progressPct}%` }]} />
          </View>
          <Text style={styles.progressLabel}>
            {progressPct}% · {formatBytes(record?.bytesOnDisk ?? 0)} / {formatBytes(model.sizeBytes)}
            {state === 'verifying' ? ' · 正在校验 sha256…' : ''}
          </Text>
        </View>
      ) : null}

      {state === 'error' && record?.lastError ? (
        <Text style={styles.errorText}>{record.lastError}</Text>
      ) : null}

      <View style={styles.actions}>
        {state === 'not-downloaded' || state === 'error' ? (
          <Button
            label="下载"
            onPress={onDownload}
            disabled={verdict != null && !verdict.fits}
          />
        ) : null}
        {state === 'downloading' ? <Button label="暂停" onPress={onPause} /> : null}
        {state === 'paused' ? <Button label="继续" onPress={onDownload} /> : null}
        {state === 'verifying' ? <ActivityIndicator color={colors.accent} /> : null}

        {/*
          A downloaded model has to be LOADED before it can answer anything.
          This button is the missing link: without it the bytes sat on disk
          forever while the chat screen kept saying "还没有加载模型".
        */}
        {state === 'ready' && !isLoaded && !isLoading ? (
          <Button label="加载" onPress={onLoad} />
        ) : null}
        {isLoading ? <Button label="加载中…" onPress={() => {}} disabled /> : null}
        {isLoaded && !isLoading ? (
          <Button label="卸载" onPress={onUnload} tone="default" />
        ) : null}
        {state === 'ready' ? <Button label="删除" onPress={onRemove} tone="danger" /> : null}
      </View>

      {isLoading ? (
        <View style={styles.progressWrap}>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${Math.max(2, loadProgress)}%` }]} />
          </View>
          <Text style={styles.progressLabel}>
            正在加载模型… {loadProgress}%
            {loadProgress < 100 ? '（首次加载需要几秒到几十秒）' : ''}
          </Text>
        </View>
      ) : null}
    </View>
  )
}

function StateChip({
  state,
  isLoaded,
}: {
  state: ModelRecord['state']
  /** Overrides the chip to "使用中" — the most important thing to know. */
  isLoaded?: boolean
}): React.JSX.Element {
  const map: Record<ModelRecord['state'], { label: string; color: string }> = {
    'not-downloaded': { label: '未下载', color: colors.textFaint },
    queued: { label: '排队中', color: colors.textMuted },
    downloading: { label: '下载中', color: colors.accent },
    paused: { label: '已暂停', color: colors.warning },
    verifying: { label: '校验中', color: colors.accent },
    ready: { label: '已就绪', color: colors.success },
    error: { label: '出错', color: colors.danger },
  }
  // "Using this one right now" beats "downloaded" as the headline state.
  const entry = isLoaded ? { label: '使用中', color: colors.accent } : map[state]
  return (
    <View style={[styles.chip, { borderColor: entry.color }]}>
      <Text style={[styles.chipText, { color: entry.color }]}>{entry.label}</Text>
    </View>
  )
}

function Fact({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View style={styles.fact}>
      <Text style={styles.factValue}>{value}</Text>
      <Text style={styles.factLabel}>{label}</Text>
    </View>
  )
}

function Button({
  label,
  onPress,
  disabled = false,
  tone = 'default',
}: {
  label: string
  onPress: () => void
  disabled?: boolean
  tone?: 'default' | 'danger'
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        tone === 'danger' && styles.buttonDanger,
        disabled && styles.buttonDisabled,
        pressed && styles.pressed,
      ]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  listContent: { padding: spacing.lg, gap: spacing.md },
  empty: { ...typography.body, color: colors.textMuted, textAlign: 'center', marginTop: spacing.xl },

  /* ── Cloud tab ─────────────────────────────────────────────────────────── */
  cloudScroll: { flex: 1 },
  cloudContent: { padding: spacing.lg, gap: spacing.xs, paddingBottom: spacing.xxl },
  cloudLabel: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  cloudInput: {
    ...typography.body,
    color: colors.text,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 44,
  },
  cloudHint: {
    ...typography.caption,
    color: colors.textFaint,
    marginTop: spacing.md,
    lineHeight: 18,
  },
  presetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  presetChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  presetChipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  presetText: { ...typography.caption, color: colors.textMuted },
  presetTextActive: { color: '#FFFFFF', fontWeight: '600' },

  notice: {
    margin: spacing.lg,
    marginBottom: 0,
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.accentMuted,
  },
  noticeText: { ...typography.caption, color: colors.text },
  mono: { fontFamily: 'monospace', color: colors.accent },

  tabs: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    padding: 3,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceRaised,
  },
  tab: {
    flex: 1,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.sm,
  },
  tabActive: { backgroundColor: colors.accent },
  tabText: { ...typography.caption, color: colors.textMuted, fontWeight: '600' },
  tabTextActive: { color: '#FFFFFF' },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.md,
    gap: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  cardHeadText: { flex: 1, gap: 2 },
  name: { ...typography.body, color: colors.text, fontWeight: '700' },
  meta: { ...typography.caption, color: colors.textMuted },
  desc: { ...typography.caption, color: colors.textMuted },

  factsRow: { flexDirection: 'row', gap: spacing.lg },
  fact: { alignItems: 'flex-start' },
  factValue: { ...typography.body, color: colors.text, fontWeight: '600' },
  factLabel: { ...typography.caption, color: colors.textFaint },

  memoryBox: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.sm,
    padding: spacing.sm,
    gap: 2,
  },
  memoryLine: { ...typography.caption, color: colors.textMuted },
  verdict: { ...typography.caption, fontWeight: '700' },
  verdictOk: { color: colors.success },
  verdictBad: { color: colors.danger },
  verdictDetail: { ...typography.caption, color: colors.textFaint },
  /** "正在使用中" banner on the loaded model. */
  inUse: { ...typography.caption, color: colors.accent, marginTop: spacing.xs },

  downloadedEmpty: {
    alignItems: 'center',
    padding: spacing.xxl,
    gap: spacing.sm,
    marginTop: spacing.xxl,
  },
  downloadedEmptyGlyph: { fontSize: 40 },
  downloadedEmptyTitle: { ...typography.title, color: colors.text },
  downloadedEmptyBody: {
    ...typography.body,
    color: colors.textMuted,
    textAlign: 'center',
  },

  errorBanner: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: 'rgba(248,81,73,0.12)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.danger,
  },
  errorBannerText: { ...typography.caption, color: colors.danger },

  cloudWarn: {
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: 'rgba(210,153,34,0.12)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.warning,
    gap: 2,
  },
  cloudWarnText: { ...typography.caption, color: colors.warning, lineHeight: 17 },

  /* ── Cloud: test-connection ─────────────────────────────────────────── */
  testBtn: {
    marginTop: spacing.md,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    backgroundColor: colors.accent,
  },
  testBtnBusy: { opacity: 0.7 },
  testBtnText: { ...typography.body, color: '#FFFFFF', fontWeight: '600' },

  testResult: {
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 2,
  },
  testResultOk: {
    backgroundColor: 'rgba(63,185,80,0.10)',
    borderColor: colors.success,
  },
  testResultBad: {
    backgroundColor: 'rgba(248,81,73,0.10)',
    borderColor: colors.danger,
  },
  testResultText: { ...typography.body, fontWeight: '600' },
  testResultMeta: { ...typography.caption, color: colors.textFaint },
  progressWrap: { gap: spacing.xs },
  progressTrack: {
    height: 6,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceRaised,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: colors.accent },
  progressLabel: { ...typography.caption, color: colors.textMuted },

  errorText: { ...typography.caption, color: colors.danger },

  actions: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  button: {
    minHeight: 40,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDanger: { backgroundColor: colors.danger },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: '#FFFFFF', fontWeight: '600', fontSize: 14 },
  pressed: { opacity: 0.75 },

  chip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  chipText: { ...typography.caption, fontWeight: '600' },
})
