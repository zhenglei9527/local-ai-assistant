import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { ChatScreen } from '@/ui/screens/ChatScreen'
import { ConversationListScreen } from '@/ui/screens/ConversationListScreen'
import { ModelManagerScreen } from '@/ui/screens/ModelManagerScreen'
import { CharacterScreen } from '@/ui/screens/CharacterScreen'
import { SettingsScreen } from '@/ui/screens/SettingsScreen'
import { colors, radii, spacing, typography } from '@/ui/theme'
import {
  useChatStore,
  useEngineStore,
  useModelStore,
  useSettingsStore,
  restoreConversations,
  restorePersistedSettings,
} from '@/store'

/**
 * Tab navigator.
 *
 * Hand-rolled rather than pulling in `@react-navigation/*`. Rationale: the app
 * has four flat, non-nested destinations and no deep-linking requirement
 * (roadmap Phase 6 at the earliest). React Navigation would add three
 * dependencies and a native `react-native-screens` build step for what is
 * ~40 lines of state here. Swap it out when nested stacks or deep links
 * actually arrive — not before.
 */

type TabKey = 'chat' | 'characters' | 'models' | 'settings'

const TABS: ReadonlyArray<{ key: TabKey; label: string; glyph: string }> = [
  { key: 'chat', label: '对话', glyph: '\u{1F4AC}' },
  { key: 'characters', label: '角色', glyph: '\u{1F3AD}' },
  { key: 'models', label: '模型', glyph: '\u{1F9E0}' },
  { key: 'settings', label: '设置', glyph: '\u{2699}\u{FE0F}' },
]

export function AppNavigator(): React.JSX.Element {
  const [tab, setTab] = useState<TabKey>('chat')
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)
  const reconcileFromDisk = useModelStore((s) => s.reconcileFromDisk)

  /**
   * Boot sequence: re-adopt downloaded models, then restore the last one.
   *
   * Two separate problems, one order:
   *
   *   1. `reconcileFromDisk` — download state is memory-only (no SQLite writer
   *      yet), so without this every relaunch shows finished models as
   *      "未下载" while hundreds of MB sit in app storage. Observed on device: a
   *      completed 469 MB download displayed as not downloaded after restart.
   *
   *   2. `loadModel` — even once the file is recognised, the ENGINE is empty
   *      after a restart, so the chat screen says "未加载模型" until the user
   *      manually taps 加载. Restoring the last-used model removes that step.
   *
   * The order is load-bearing: loading reads the record that reconcile writes,
   * so running them the other way round finds nothing to load.
   *
   * Sequenced rather than parallel for the same reason, and guarded so a second
   * run (Fast Refresh) cannot double-load and OOM the device.
   */
  const loadModel = useEngineStore((s) => s.loadModel)
  const bootDone = useRef(false)

  useEffect(() => {
    if (bootDone.current) return
    bootDone.current = true

    void (async () => {
      // Settings FIRST: the restore below reads `lastLoadedModelId` and
      // `backend` out of the settings store, and restoring afterwards would
      // boot with defaults (no remembered model, wrong backend).
      await restorePersistedSettings()
      // Conversations BEFORE anything that reads them: the list renders from
      // store state, and restoring later would show an empty screen first.
      await restoreConversations()
      await reconcileFromDisk()
      const wanted = useSettingsStore.getState().lastLoadedModelId
      if (!wanted) return
      // Only if it actually made it onto disk — otherwise this throws a
      // confusing "not downloaded" error at every launch.
      const record = useModelStore.getState().records[wanted]
      if (record?.state !== 'ready') return
      await loadModel(wanted)
    })()
  }, [reconcileFromDisk, loadModel])

  const renderScreen = useCallback((): React.JSX.Element => {
    switch (tab) {
      case 'chat':
        // Conversation list is the home surface. It hands off to the
        // transcript once a conversation is selected, so "list vs chat" is
        // navigation state rather than a second tab — a dedicated tab for each
        // would make the user learn a distinction they do not care about.
        //
        // `onOpen` selects the conversation; the navigator then re-renders
        // into `ChatScreen` because `activeConversationId` is no longer null.
        return activeConversationId == null ? (
          <ConversationListScreen onOpen={setActiveConversation} />
        ) : (
          <ChatScreen />
        )
      case 'characters':
        return <CharacterScreen />
      case 'models':
        return <ModelManagerScreen />
      case 'settings':
        return <SettingsScreen />
    }
  }, [tab, activeConversationId, setActiveConversation])

  return (
    <View style={styles.root}>
      <View style={styles.content}>{renderScreen()}</View>
      <TabBar active={tab} onChange={setTab} />
    </View>
  )
}

function TabBar({
  active,
  onChange,
}: {
  active: TabKey
  onChange: (key: TabKey) => void
}): React.JSX.Element {
  const insets = useSafeAreaInsets()

  return (
    <View style={[styles.tabBar, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
      {TABS.map((t) => {
        const selected = t.key === active
        return (
          <Pressable
            key={t.key}
            onPress={() => onChange(t.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={t.label}
            style={({ pressed }) => [
              styles.tab,
              pressed && styles.tabPressed,
            ]}
          >
            <Text style={[styles.tabGlyph, selected && styles.tabGlyphActive]}>{t.glyph}</Text>
            <Text style={[styles.tabLabel, selected && styles.tabLabelActive]} numberOfLines={1}>
              {t.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { flex: 1 },

  tabBar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    paddingTop: spacing.sm,
  },
  tab: { flex: 1, alignItems: 'center', gap: 2, paddingVertical: spacing.xs },
  tabPressed: { opacity: 0.6 },
  tabGlyph: { fontSize: 20 },
  tabGlyphActive: {},
  tabLabel: { ...typography.caption, color: colors.textMuted },
  tabLabelActive: { color: colors.accent, fontWeight: '600' },
})

export const __styles = styles
export { colors, radii, spacing, typography }

/**
 * `ScreenScaffold` now lives in `./ScreenScaffold`.
 *
 * It used to be exported from here, which formed an import cycle
 * (AppNavigator → screen → AppNavigator). Re-exported for one release so any
 * missed call site still resolves; delete this once nothing imports it.
 */
export { ScreenScaffold } from './ScreenScaffold'
