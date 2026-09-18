/**
 * Model picker for the chat composer.
 *
 * ── Why it is a "+" beside the send button ──────────────────────────────────
 * It used to be a wide pill to the LEFT of the input, carrying the model name.
 * That occupied a large share of a phone's composer width for information the
 * user rarely changes mid-conversation, and it pushed the actual text field —
 * the thing being used constantly — into whatever space was left. On a narrow
 * screen the input ended up short enough to be awkward.
 *
 * A "+" tap target costs one icon's width. The current model is still always
 * visible: it is shown in the header subtitle above the transcript, which is
 * where a user looks to answer "which model just replied".
 *
 * ── What it lists ───────────────────────────────────────────────────────────
 * Downloaded local models first (they are the ones that work offline), then the
 * cloud endpoint if one is configured. Models still downloading appear disabled
 * rather than hidden: a user who just started a 4 GB download needs to see it
 * exists and is not ready, otherwise the list looks empty and they start it
 * again.
 */

import React, { useCallback, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'

import { colors, spacing, typography } from '@/ui/theme'
import { OFFICIAL_LINE, type LineDescriptor } from '@/data/models/lineCatalog'
import { formatBytes } from '@/data/models/memoryProbe'
import { useEngineStore, useModelStore, useSettingsStore } from '@/store'

/** One row in the picker. */
interface Entry {
  readonly key: string
  readonly label: string
  readonly detail: string
  readonly kind: 'local' | 'cloud'
  /** Local model id; empty for cloud. */
  readonly modelId: string
  /** False when the model is not usable yet (still downloading, or failed). */
  readonly enabled: boolean
  readonly note: string | null
}

export function ModelPickerButton(): React.JSX.Element {
  const [open, setOpen] = useState(false)

  const records = useModelStore((s) => s.records)
  const engineStatus = useEngineStore((s) => s.status)
  const activeModelId = useEngineStore((s) => s.modelId)
  const activateModel = useEngineStore((s) => s.activateModel)
  const provider = useSettingsStore((s) => s.remoteProvider)
  const backend = useSettingsStore((s) => s.backend)

  const entries = useMemo<Entry[]>(() => {
    const list: Entry[] = []

    for (const model of OFFICIAL_LINE) {
      const record = records[model.id]
      const state = record?.state ?? 'not-downloaded'
      // Only surface models the user has actually engaged with. Listing all 125
      // catalogue entries here would turn a quick switch into a search task —
      // the full catalogue already lives on the 模型 tab.
      if (state === 'not-downloaded') continue

      const ready = state === 'ready'
      list.push({
        key: model.id,
        label: model.displayName,
        detail: `${model.quantization} · ${formatBytes(model.sizeBytes)}`,
        kind: 'local',
        modelId: model.id,
        enabled: ready,
        note: ready ? null : noteFor(state),
      })
    }

    // Cloud is only offered when the user has configured it. Showing a
    // permanently disabled row would just be noise for the majority who never
    // turn it on.
    if (backend === 'remote' && provider.apiKey.trim().length > 0) {
      list.push({
        key: 'cloud',
        label: provider.label || '云端 API',
        detail: provider.model,
        kind: 'cloud',
        modelId: '',
        enabled: true,
        note: '对话内容会发送到第三方',
      })
    }

    return list
  }, [records, provider, backend])

  const currentLabel = useMemo(() => {
    if (backend === 'remote') return provider.model || '云端'
    // `modelId` on the engine is the authority for what is resident; the
    // catalogue lookup is only for a friendlier display name. Falling back to
    // the raw id matters when the model was re-adopted from disk and the
    // catalogue entry is missing — showing "未选择模型" while a model is
    // demonstrably loaded (the header shows its name) is contradictory.
    if (activeModelId) {
      const found = OFFICIAL_LINE.find((m) => m.id === activeModelId)
      return found?.displayName ?? activeModelId
    }
    return '未选择模型'
  }, [backend, provider.model, activeModelId])

  const onPick = useCallback(
    (entry: Entry) => {
      if (!entry.enabled) return
      setOpen(false)
      if (entry.kind === 'cloud') {
        void activateModel({ kind: 'cloud' })
      } else {
        void activateModel({ kind: 'local', modelId: entry.modelId })
      }
    },
    [activateModel],
  )

  const busy = engineStatus === 'loading'

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`切换模型（当前：${currentLabel}）`}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [
          styles.trigger,
          busy && styles.triggerBusy,
          pressed && styles.pressed,
        ]}
      >
        {busy ? (
          <ActivityIndicator size="small" color={colors.accent} />
        ) : (
          <Text style={styles.triggerGlyph}>＋</Text>
        )}
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          {/* Stop taps inside the sheet from closing it. */}
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.grabber} />
            <Text style={styles.sheetTitle}>选择模型</Text>
            {/*
              Surfacing the current model HERE matters more now that the trigger
              is an unlabelled "+": without it the sheet would open with no
              indication of what is already active beyond the row highlight.
            */}
            <Text style={styles.sheetHint} numberOfLines={1}>
              当前：{currentLabel}
            </Text>

            <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
              {entries.length === 0 ? (
                <Text style={styles.empty}>
                  还没有可用的模型。请到「模型」页下载一个。
                </Text>
              ) : (
                entries.map((entry) => {
                  const active =
                    entry.kind === 'cloud'
                      ? backend === 'remote'
                      : backend === 'local' && entry.modelId === activeModelId
                  return (
                    <Pressable
                      key={entry.key}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active, disabled: !entry.enabled }}
                      onPress={() => onPick(entry)}
                      style={({ pressed }) => [
                        styles.row,
                        active && styles.rowActive,
                        !entry.enabled && styles.rowDisabled,
                        pressed && styles.pressed,
                      ]}
                    >
                      <View style={styles.rowBody}>
                        <Text style={[styles.rowLabel, active && styles.rowLabelActive]}>
                          {entry.label}
                        </Text>
                        <Text style={styles.rowDetail}>{entry.detail}</Text>
                        {entry.note ? (
                          <Text style={styles.rowNote}>{entry.note}</Text>
                        ) : null}
                      </View>
                      {active ? <Text style={styles.check}>✓</Text> : null}
                    </Pressable>
                  )
                })
              )}
            </ScrollView>

            <Pressable
              accessibilityRole="button"
              onPress={() => setOpen(false)}
              style={({ pressed }) => [styles.close, pressed && styles.pressed]}
            >
              <Text style={styles.closeText}>关闭</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  )
}

function noteFor(state: string): string {
  switch (state) {
    case 'downloading':
      return '下载中，完成后可切换'
    case 'paused':
      return '已暂停'
    case 'queued':
      return '排队中'
    case 'verifying':
      return '校验中'
    case 'error':
      return '下载出错'
    default:
      return '尚未下载'
  }
}

const styles = StyleSheet.create({
  /**
   * Square "+" button, sized to match the send button beside it.
   *
   * 44x44 is the minimum touch target both Android and iOS agree on, and keeping
   * it square means the composer's three controls (+, input, send) share one
   * baseline height instead of looking misaligned.
   */
  trigger: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
    backgroundColor: colors.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  triggerBusy: { borderColor: colors.accent },
  /**
   * The glyph is text, not an icon font.
   *
   * `＋` (U+FF0B, fullwidth) rather than `+`: the ASCII form sits on the
   * baseline and looks off-centre in a circle, while the fullwidth form is
   * optically centred and matches the CJK text around it.
   */
  triggerGlyph: { fontSize: 20, color: colors.textMuted, lineHeight: 24 },

  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.62)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl,
    maxHeight: '75%',
    gap: spacing.xs,
  },
  /** The little handle that signals "this sheet can be dismissed". */
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginBottom: spacing.md,
  },
  sheetTitle: { ...typography.title, fontSize: 19, color: colors.text },
  sheetHint: { ...typography.caption, color: colors.textMuted, marginBottom: spacing.md },
  list: { flexGrow: 0 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    paddingHorizontal: spacing.md,
    borderRadius: 14,
    gap: spacing.sm,
  },
  rowActive: { backgroundColor: colors.accentMuted },
  rowDisabled: { opacity: 0.45 },
  /** `minWidth: 0` so a long model name truncates instead of overflowing. */
  rowBody: { flex: 1, minWidth: 0, gap: 2 },
  rowLabel: { ...typography.body, color: colors.text, fontWeight: '600' },
  rowLabelActive: { color: colors.accent },
  rowDetail: { ...typography.caption, color: colors.textMuted },
  rowNote: { ...typography.caption, color: colors.warning },
  check: { color: colors.accent, fontSize: 18, fontWeight: '700' },

  empty: {
    ...typography.body,
    color: colors.textMuted,
    textAlign: 'center',
    paddingVertical: spacing.xxl,
  },
  close: {
    marginTop: spacing.md,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 24,
    backgroundColor: colors.surfaceRaised,
  },
  closeText: { ...typography.body, color: colors.textMuted, fontWeight: '600' },
  pressed: { opacity: 0.75 },
})
