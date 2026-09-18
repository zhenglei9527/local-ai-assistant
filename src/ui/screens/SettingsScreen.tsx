import React, { useCallback, useEffect, useState } from 'react'
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native'

import { ScreenScaffold } from '@/ui/ScreenScaffold'
import { colors, radii, spacing, typography } from '@/ui/theme'
import { formatBytes, readMemorySnapshot } from '@/data/models/memoryProbe'
import { DEFAULT_SAMPLING } from '@/inference/InferenceEngine'
import type { MemorySnapshot } from '@/types/domain'
import { useEngineStore, useSettingsStore, SYSTEM_PROMPT_PLACEHOLDER } from '@/store'

/**
 * Settings + diagnostics.
 *
 * The "Engine diagnostics" block is not decoration — it is the support surface.
 * The first three questions for any on-device LLM bug report are "which
 * backend actually initialised", "how much RAM did the probe see", and "what
 * were the timings", and all three are otherwise invisible on a phone.
 */
export function SettingsScreen(): React.JSX.Element {
  const sampling = useSettingsStore((s) => s.sampling)
  const setSampling = useSettingsStore((s) => s.setSampling)
  const contextConfig = useSettingsStore((s) => s.contextConfig)
  const setContextConfig = useSettingsStore((s) => s.setContextConfig)
  const backend = useSettingsStore((s) => s.backend)
  const setBackend = useSettingsStore((s) => s.setBackend)
  const systemPrompt = useSettingsStore((s) => s.systemPrompt)
  const setSystemPrompt = useSettingsStore((s) => s.setSystemPrompt)

  /**
   * Engine diagnostics, read as FLAT fields.
   *
   * These were read as `engineStatus.state`, `.modelId`, `.gpuActive`,
   * `.activeDevices` and `.gpuFallbackReason` — a nested shape the store has
   * never had. Every one was `undefined`, so the diagnostics panel showed
   * "状态: undefined" and "模型: —" no matter what the engine was doing. For the
   * one screen whose entire job is telling you why the engine is unhappy, that
   * made it useless.
   *
   * TypeScript catches this, but nothing typechecks the build — only tests run.
   */
  const engineStatus = useEngineStore((s) => s.status)
  const engineModelId = useEngineStore((s) => s.modelId)
  const gpuActive = useEngineStore((s) => s.gpuActive)
  const activeDevices = useEngineStore((s) => s.activeDevices)
  const gpuFallbackReason = useEngineStore((s) => s.gpuFallbackReason)
  const lastTimings = useEngineStore((s) => s.lastTimings)

  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null)

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

  const onResetSampling = useCallback(() => {
    setSampling(DEFAULT_SAMPLING)
  }, [setSampling])

  const onToggleGpu = useCallback(
    (enabled: boolean) => {
      setContextConfig({
        gpuLayers: enabled ? 99 : 0,
        // `devices: []` means "platform default", i.e. CPU. Opting into
        // Hexagon NPU would be `['HTP0']` or `['HTP*']` (experimental).
        devices: [],
        flashAttention: enabled ? 'auto' : 'off',
      })
    },
    [setContextConfig],
  )

  return (
    <ScreenScaffold title="设置" subtitle="生成参数、上下文与诊断">
      {/*
        System prompt sits directly above the source switch because the two
        belong together: "who should it be" and "which model" are the first two
        decisions a user makes, and this is where they come to make them.
      */}
      <Section title="系统提示词">
        <Text style={styles.note}>
          这里的内容会作为「系统提示词」发送，用来设定助手的性格或说话方式。
          在消息里写「你扮演…」效果很弱（小模型尤其容易忽略），写在这里每轮都会生效。
          留空则使用模型自带的默认设定。
        </Text>
        <TextInput
          style={styles.promptInput}
          value={systemPrompt}
          onChangeText={setSystemPrompt}
          placeholder={SYSTEM_PROMPT_PLACEHOLDER}
          placeholderTextColor={colors.textFaint}
          multiline
          textAlignVertical="top"
          accessibilityLabel="系统提示词"
        />
        {systemPrompt.trim().length > 0 ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => setSystemPrompt('')}
            style={styles.linkBtn}
          >
            <Text style={styles.linkText}>清空（改用模型默认设定）</Text>
          </Pressable>
        ) : null}
      </Section>

      <Section title="模型来源">
        <SwitchRow
          label="使用云端 API"
          hint={
            backend === 'remote'
              ? '当前：对话内容会发送到第三方服务器。'
              : '当前：全部在本机处理，对话内容不会离开设备。'
          }
          value={backend === 'remote'}
          onChange={(v) => setBackend(v ? 'remote' : 'local')}
        />
        {backend === 'remote' ? (
          <Text style={styles.note}>
            接口地址、模型名称与 API Key 在「模型 → 云端」里配置。
          </Text>
        ) : null}
      </Section>

      <Section title="生成参数">
        <SliderRow
          label="温度"
          value={sampling.temperature}
          min={0}
          max={2}
          step={0.05}
          hint="越高越有创意，但逻辑越松散。角色扮演常用 0.8。"
          onChange={(v) => setSampling({ temperature: v })}
        />
        <SliderRow
          label="Top P"
          value={sampling.topP}
          min={0.1}
          max={1}
          step={0.01}
          hint="核采样阈值，控制候选词范围。"
          onChange={(v) => setSampling({ topP: v })}
        />
        <SliderRow
          label="Top K"
          value={sampling.topK}
          min={1}
          max={200}
          step={1}
          hint="只从最可能的 K 个词里选。"
          onChange={(v) => setSampling({ topK: Math.round(v) })}
        />
        <SliderRow
          label="重复惩罚"
          value={sampling.repeatPenalty}
          min={1}
          max={1.5}
          step={0.01}
          hint="超过 1.2 左右会开始破坏语法和人名。"
          onChange={(v) => setSampling({ repeatPenalty: v })}
        />
        <SliderRow
          label="最大生成长度"
          value={sampling.maxTokens}
          min={64}
          max={4096}
          step={64}
          hint="单条回复的 token 上限。"
          onChange={(v) => setSampling({ maxTokens: Math.round(v) })}
        />
        <Pressable onPress={onResetSampling} style={styles.linkBtn}>
          <Text style={styles.linkText}>恢复默认值</Text>
        </Pressable>
      </Section>

      <Section title="硬件">
        <SwitchRow
          label="GPU 加速（OpenCL）"
          hint="仅支持 Adreno 700 及以上。不支持时会自动退回 CPU。注意：开启后无法保存会话缓存。"
          value={contextConfig.gpuLayers > 0}
          onChange={onToggleGpu}
        />
        <SliderRow
          label="上下文长度"
          value={contextConfig.contextLength}
          min={512}
          max={16384}
          step={512}
          hint="KV 缓存随上下文线性增长。内存紧张时优先调小这一项。"
          onChange={(v) => setContextConfig({ contextLength: Math.round(v) })}
        />
        <SliderRow
          label="线程数"
          value={contextConfig.threads}
          min={1}
          max={8}
          step={1}
          hint="通常「核心数 − 2」最快；用满所有核心反而更慢。"
          onChange={(v) => setContextConfig({ threads: Math.round(v) })}
        />
      </Section>

      <Section title="引擎诊断">
        <Diag label="状态" value={engineStatus} />
        <Diag label="模型" value={engineModelId ?? '—'} />
        <Diag
          label="后端"
          value={
            gpuActive
              ? `GPU (${activeDevices.join(', ') || '默认'})`
              : 'CPU'
          }
        />
        {gpuFallbackReason ? (
          <Diag label="GPU 回退原因" value={gpuFallbackReason} />
        ) : null}
        {lastTimings ? (
          <>
            <Diag
              label="速度"
              value={`生成 ${fmtRate(lastTimings.tokensPerSecond)} · 预填充 ${fmtRate(lastTimings.promptTokensPerSecond)}`}
            />
            <Diag
              label="Token 数"
              value={`输入 ${lastTimings.promptTokens ?? 0} → 输出 ${lastTimings.generatedTokens ?? 0}`}
            />
          </>
        ) : (
          <Diag label="速度" value="尚未生成过" />
        )}
      </Section>

      <Section title="设备内存">
        {snapshot ? (
          <>
            <Diag label="总内存" value={formatBytes(snapshot.totalMem)} />
            <Diag label="可用" value={formatBytes(snapshot.availMem)} />
            <Diag label="低内存设备" value={snapshot.lowRamDevice ? '是' : '否'} />
            <Diag
              label="可用预算"
              value={`${formatBytes(snapshot.usableBudget)}（已扣除 ${Math.round(
                (1 - snapshot.usableBudget / Math.max(snapshot.availMem, 1)) * 100,
              )}% 安全余量）`}
            />
            <Text style={styles.note}>
              数据来自 ActivityManager.MemoryInfo。没有使用 Runtime.maxMemory()——它只反映 Java
              堆上限，对本地内存分配没有参考价值。
            </Text>
          </>
        ) : (
          <Text style={styles.note}>无法读取内存（原生模块未实现）。</Text>
        )}
      </Section>

      <Section title="关于">
        <Text style={styles.note}>
          本地 AI 助手 0.1.0{'\n'}
          推理引擎：llama.rn 0.13.0-rc.3{'\n'}
          所有对话都在本机处理，不会上传到任何服务器。
        </Text>
      </Section>
    </ScreenScaffold>
  )
}

/**
 * Format a tokens/second figure, tolerating a missing value.
 *
 * The diagnostics panel renders whatever the engine last reported, and an
 * engine that omits a field must not be able to take down the whole app: an
 * unguarded `.toFixed(1)` on `undefined` produced a red-screen crash with
 * "Cannot read property 'toFixed' of undefined" the moment this screen opened.
 * The engines now always populate the field; this is the belt to that braces,
 * because a diagnostics panel is exactly the wrong place to be fragile.
 */
function fmtRate(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return `${value.toFixed(1)} tok/s`
}

function Section({  title,
  children,
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  )
}

/**
 * Numeric stepper rather than a Slider.
 *
 * `@react-native-community/slider` is a native dependency; this skeleton cannot
 * build native code, so a pure-JS stepper keeps the screen honest and usable.
 * Swap in a real Slider during Phase 5 polish.
 */
function SliderRow({
  label,
  value,
  min,
  max,
  step,
  hint,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  hint?: string
  onChange: (value: number) => void
}): React.JSX.Element {
  const clamp = (v: number) => Math.min(max, Math.max(min, v))
  const decimals = step < 1 ? 2 : 0

  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text style={styles.rowLabel}>{label}</Text>
        {hint ? <Text style={styles.rowHint}>{hint}</Text> : null}
      </View>
      <View style={styles.stepper}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Decrease ${label}`}
          onPress={() => onChange(clamp(value - step))}
          style={({ pressed }) => [styles.stepBtn, pressed && styles.pressed]}
        >
          <Text style={styles.stepText}>−</Text>
        </Pressable>
        <Text style={styles.stepValue}>{value.toFixed(decimals)}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Increase ${label}`}
          onPress={() => onChange(clamp(value + step))}
          style={({ pressed }) => [styles.stepBtn, pressed && styles.pressed]}
        >
          <Text style={styles.stepText}>+</Text>
        </Pressable>
      </View>
    </View>
  )
}

function SwitchRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string
  hint?: string
  value: boolean
  onChange: (value: boolean) => void
}): React.JSX.Element {
  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text style={styles.rowLabel}>{label}</Text>
        {hint ? <Text style={styles.rowHint}>{hint}</Text> : null}
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: colors.accent }} />
    </View>
  )
}

function Diag({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View style={styles.diagRow}>
      <Text style={styles.diagLabel}>{label}</Text>
      <Text style={styles.diagValue} numberOfLines={2}>
        {value}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  section: { gap: spacing.sm },
  sectionTitle: {
    ...typography.caption,
    color: colors.textFaint,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    fontWeight: '700',
  },
  sectionBody: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.md,
    gap: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  rowText: { flex: 1, gap: 1 },
  rowLabel: { ...typography.body, color: colors.text },
  rowHint: { ...typography.caption, color: colors.textFaint },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  stepBtn: {
    width: 34,
    height: 34,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepText: { color: colors.text, fontSize: 18, lineHeight: 20 },
  stepValue: {
    ...typography.mono,
    color: colors.accent,
    minWidth: 52,
    textAlign: 'center',
  },
  pressed: { opacity: 0.6 },
  linkBtn: { alignSelf: 'flex-start', paddingVertical: spacing.xs },
  linkText: { ...typography.caption, color: colors.accent },
  diagRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  diagLabel: { ...typography.caption, color: colors.textMuted },
  diagValue: { ...typography.mono, color: colors.text, flexShrink: 1, textAlign: 'right' },
  note: { ...typography.caption, color: colors.textFaint, lineHeight: 17 },

  /** Multi-line system prompt box. Tall enough for a real persona, not a line. */
  promptInput: {
    ...typography.body,
    color: colors.text,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 96,
    marginTop: spacing.xs,
  },
})
