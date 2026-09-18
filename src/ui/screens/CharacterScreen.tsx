import React, { useCallback, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native'

import { ScreenScaffold } from '@/ui/ScreenScaffold'
import { colors, radii, spacing, typography } from '@/ui/theme'
import { useChatStore } from '@/store'
import type { CharacterRecord } from '@/types/domain'
import { importCharacterCard } from '@/character-card/importCard.ts'

/**
 * Character library.
 *
 * Import accepts the common character-card file formats: PNG with an embedded
 * metadata chunk, or plain JSON. Parsing lives in `src/character-card/` and is
 * covered by tests; this screen only owns the picker and the error surface.
 */
export function CharacterScreen(): React.JSX.Element {
  const characters = useChatStore((s) => s.characters)
  const activeCharacterId = useChatStore((s) => s.activeCharacterId)
  const selectCharacter = useChatStore((s) => s.selectCharacter)
  const addCharacter = useChatStore((s) => s.addCharacter)

  const [importing, setImporting] = useState(false)

  const onImport = useCallback(async () => {
    if (importing) return
    setImporting(true)
    try {
      const result = await importCharacterCard()
      if (!result) return // user cancelled the picker

      // Replace an existing card with the same name rather than silently
      // accumulating duplicates every time the same file is re-imported.
      // The store owns that de-duplication AND the write to SQLite — doing it
      // here against local state is what made imports memory-only and cost the
      // card on the next launch.
      addCharacter(result)
      selectCharacter(result.id)
      Alert.alert('导入成功', `已导入「${result.card.data.name}」`)
    } catch (error) {
      Alert.alert(
        '导入失败',
        error instanceof Error ? error.message : '无法解析该文件，请确认是角色卡（PNG 或 JSON）。',
      )
    } finally {
      setImporting(false)
    }
  }, [importing, addCharacter, selectCharacter])

  const renderItem = useCallback(
    ({ item }: { item: CharacterRecord }) => (
      <CharacterRow
        character={item}
        active={item.id === activeCharacterId}
        onPress={() => selectCharacter(item.id)}
      />
    ),
    [activeCharacterId, selectCharacter],
  )

  const subtitle =
    characters.length === 0 ? '还没有角色' : `${characters.length} 个角色`

  return (
    <ScreenScaffold
      title="角色"
      subtitle={subtitle}
      scroll={false}
      headerRight={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="导入角色卡"
          onPress={() => void onImport()}
          disabled={importing}
          hitSlop={12}
          style={({ pressed }) => [
            styles.addBtn,
            pressed && styles.pressed,
            importing && styles.addBtnBusy,
          ]}
        >
          {importing ? (
            <ActivityIndicator color="#FFFFFF" size="small" />
          ) : (
            <Text style={styles.addBtnGlyph}>＋</Text>
          )}
        </Pressable>
      }
    >
      <FlatList
        contentContainerStyle={styles.listContent}
        data={characters}
        keyExtractor={(c) => c.id}
        renderItem={renderItem}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyGlyph}>{'\u{1F3AD}'}</Text>
            <Text style={styles.emptyTitle}>还没有角色</Text>
            <Text style={styles.emptyBody}>
              点右上角「＋」导入角色卡，支持 PNG 或 JSON 格式。导入后即可在对话中使用该角色。
            </Text>
          </View>
        }
      />
    </ScreenScaffold>
  )
}

function CharacterRow({
  character,
  active,
  onPress,
}: {
  character: CharacterRecord
  active: boolean
  onPress: () => void
}): React.JSX.Element {
  const { card } = character
  const greetingCount = card.data.alternate_greetings.length

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`选择角色 ${card.data.name}`}
      onPress={onPress}
      style={({ pressed }) => [styles.card, active && styles.cardActive, pressed && styles.pressed]}
    >
      <View style={styles.avatar}>
        <Text style={styles.avatarGlyph}>{card.data.name.charAt(0).toUpperCase() || '?'}</Text>
      </View>
      <View style={styles.cardBody}>
        <Text style={styles.name}>{card.data.name || '未命名'}</Text>
        {card.data.creator ? (
          <Text style={styles.creator}>作者 {card.data.creator}</Text>
        ) : null}
        {card.data.description ? (
          <Text style={styles.desc} numberOfLines={2}>
            {card.data.description}
          </Text>
        ) : null}
        <View style={styles.tags}>
          {card.data.tags.slice(0, 4).map((tag) => (
            <View key={tag} style={styles.tag}>
              <Text style={styles.tagText}>{tag}</Text>
            </View>
          ))}
          {greetingCount > 0 ? (
            <View style={styles.tag}>
              <Text style={styles.tagText}>+{greetingCount} greetings</Text>
            </View>
          ) : null}
        </View>
      </View>
      {active ? <Text style={styles.activeMark}>●</Text> : null}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  listContent: { padding: spacing.lg, gap: spacing.md },
  empty: { alignItems: 'center', padding: spacing.xxl, gap: spacing.sm, marginTop: spacing.xxl },
  emptyGlyph: { fontSize: 40 },
  emptyTitle: { ...typography.title, color: colors.text },
  emptyBody: { ...typography.body, color: colors.textMuted, textAlign: 'center' },
  mono: { fontFamily: 'monospace', color: colors.accent },

  card: {
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'flex-start',
  },
  cardActive: { borderColor: colors.accent, backgroundColor: colors.surfaceRaised },
  pressed: { opacity: 0.75 },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: radii.pill,
    backgroundColor: colors.accentMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarGlyph: { ...typography.title, color: colors.accent },
  cardBody: { flex: 1, gap: 2 },
  name: { ...typography.body, color: colors.text, fontWeight: '700' },
  creator: { ...typography.caption, color: colors.textFaint },
  desc: { ...typography.caption, color: colors.textMuted },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.xs },
  tag: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
  },
  tagText: { ...typography.caption, color: colors.textMuted },
  activeMark: { color: colors.accent, fontSize: 12 },

  /** Header "+" — matches the 44dp minimum touch target. */
  addBtn: {
    width: 44,
    height: 44,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addBtnBusy: { opacity: 0.7 },
  addBtnGlyph: { color: '#FFFFFF', fontSize: 24, lineHeight: 28, fontWeight: '500' },
})
