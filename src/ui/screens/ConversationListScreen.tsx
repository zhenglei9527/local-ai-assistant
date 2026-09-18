/**
 * Conversation list — the app's home surface.
 *
 * ── Why this is the home tab ───────────────────────────────────────────────
 * The app previously opened straight into a single chat transcript, so there
 * was exactly one conversation and no way to start a second one. That is the
 * wrong shape for a character-chat app: people keep several personas going at
 * once, and they come back to a specific one.
 *
 * ── Search ─────────────────────────────────────────────────────────────────
 * Search runs over conversation titles AND message bodies. Title-only search
 * is close to useless here, because titles are auto-derived from the first
 * message and people remember what was *said*, not what they called the chat.
 *
 * The scan is deliberately simple (substring, case-insensitive) rather than
 * fuzzy or tokenised. At the scale this operates on — tens of conversations,
 * hundreds of messages each, all already in memory — a linear scan is
 * sub-millisecond, and fuzzy matching mostly produces surprising hits on
 * short CJK queries where every character is a word.
 */

import React, { useCallback, useMemo, useState } from 'react'
import {
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'

import { ScreenScaffold } from '@/ui/ScreenScaffold'
import { colors, radii, spacing, typography } from '@/ui/theme'
import { useChatStore } from '@/store'
import type { Conversation, Message } from '@/types/domain'

/** One search hit: the conversation, plus why it matched. */
interface Hit {
  readonly conversation: Conversation
  /** Snippet around the first matching message, when the match was in a body. */
  readonly snippet: string | null
}

export function ConversationListScreen({
  onOpen,
}: {
  onOpen: (conversationId: string) => void
}): React.JSX.Element {
  const conversations = useChatStore((s) => s.conversations)
  const messages = useChatStore((s) => s.messages)
  const characters = useChatStore((s) => s.characters)
  const createConversation = useChatStore((s) => s.createConversation)
  const deleteConversation = useChatStore((s) => s.deleteConversation)

  const [query, setQuery] = useState('')

  const nameOf = useCallback(
    (characterId: string | null): string | null => {
      if (!characterId) return null
      const found = characters.find((c) => c.id === characterId)
      return found?.card.data.name ?? null
    },
    [characters],
  )

  /**
   * Group the active transcript by conversation, so search can look inside
   * bodies. Only the loaded conversation has messages in memory right now —
   * the store keeps one transcript at a time — so body search covers what the
   * user has actually opened, and title search covers the rest. Noted rather
   * than hidden: a full-text index is the correct fix once conversations are
   * persisted to SQLite.
   */
  const byConversation = useMemo(() => {
    const map = new Map<string, Message[]>()
    for (const m of messages) {
      const list = map.get(m.conversationId)
      if (list) list.push(m)
      else map.set(m.conversationId, [m])
    }
    return map
  }, [messages])

  const hits = useMemo<Hit[]>(() => {
    const q = query.trim().toLowerCase()
    /**
     * Newest first, with a deterministic tie-break.
     *
     * `lastMessageAt` alone is not a total order: two conversations touched in
     * the same millisecond compare equal, and the sort is then free to order
     * them arbitrarily. What a user sees is the chat they just used failing to
     * rise to the top, or two rows swapping places between renders.
     *
     * `id` is monotonic (timestamp + counter, see `createConversation`), so it
     * supplies a stable, meaningful fallback: among equally-recent
     * conversations, the more recently created one wins.
     */
    const sorted = [...conversations].sort(
      (a, b) => b.lastMessageAt - a.lastMessageAt || b.id.localeCompare(a.id),
    )

    if (!q) {
      return sorted.map((conversation) => ({
        conversation,
        snippet: lastMessageSnippet(byConversation.get(conversation.id)),
      }))
    }

    const out: Hit[] = []
    for (const conversation of sorted) {
      if (conversation.title.toLowerCase().includes(q)) {
        out.push({
          conversation,
          snippet: lastMessageSnippet(byConversation.get(conversation.id)),
        })
        continue
      }
      const body = byConversation.get(conversation.id)
      const matched = body?.find((m) => m.content.toLowerCase().includes(q))
      if (matched) {
        out.push({ conversation, snippet: snippetAround(matched.content, q) })
      }
    }
    return out
  }, [conversations, byConversation, query])

  const onNew = useCallback(() => {
    const id = createConversation()
    onOpen(id)
  }, [createConversation, onOpen])

  /**
   * Confirm before deleting.
   *
   * A long-press is easy to trigger by accident while scrolling, and a
   * conversation holds text the user cannot get back. Confirming is the
   * difference between a gesture and an accident.
   */
  const confirmDelete = useCallback(
    (conversation: Conversation) => {
      const title = conversation.title || '这个对话'
      Alert.alert('删除对话', `确定要删除「${title}」吗？此操作无法撤销。`, [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => deleteConversation(conversation.id),
        },
      ])
    },
    [deleteConversation],
  )

  const renderItem = useCallback(
    ({ item }: { item: Hit }) => (
      <ConversationRow
        hit={item}
        characterName={nameOf(item.conversation.characterId)}
        onPress={() => onOpen(item.conversation.id)}
        onDelete={() => confirmDelete(item.conversation)}
      />
    ),
    [nameOf, onOpen, confirmDelete],
  )

  const searching = query.trim().length > 0

  return (
    <ScreenScaffold
      title="对话"
      subtitle={conversations.length === 0 ? '还没有对话' : `${conversations.length} 个对话`}
      scroll={false}
      headerRight={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="新建对话"
          onPress={onNew}
          hitSlop={12}
          style={({ pressed }) => [styles.addBtn, pressed && styles.pressed]}
        >
          <Text style={styles.addBtnGlyph}>＋</Text>
        </Pressable>
      }
    >
      <View style={styles.searchWrap}>
        <TextInput
          style={styles.search}
          value={query}
          onChangeText={setQuery}
          placeholder="搜索对话和聊天记录"
          placeholderTextColor={colors.textFaint}
          returnKeyType="search"
          clearButtonMode="while-editing"
          autoCorrect={false}
        />
        {query.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="清除搜索"
            onPress={() => setQuery('')}
            hitSlop={10}
            style={styles.clearBtn}
          >
            <Text style={styles.clearGlyph}>✕</Text>
          </Pressable>
        ) : null}
      </View>

      <FlatList
        contentContainerStyle={styles.list}
        data={hits}
        keyExtractor={(h) => h.conversation.id}
        renderItem={renderItem}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyGlyph}>{searching ? '\u{1F50D}' : '\u{1F4AC}'}</Text>
            <Text style={styles.emptyTitle}>
              {searching ? '没有匹配的结果' : '还没有对话'}
            </Text>
            <Text style={styles.emptyBody}>
              {searching
                ? '换个关键词试试。搜索会同时查找对话标题和聊天内容。'
                : '点右上角「＋」新建一个对话，选个角色就能开始聊天。'}
            </Text>
          </View>
        }
      />
    </ScreenScaffold>
  )
}

function ConversationRow({
  hit,
  characterName,
  onPress,
  onDelete,
}: {
  hit: Hit
  characterName: string | null
  onPress: () => void
  onDelete: () => void
}): React.JSX.Element {
  const { conversation, snippet } = hit
  const title = characterName ?? conversation.title

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`打开对话 ${title}`}
      accessibilityHint="长按可删除"
      onPress={onPress}
      onLongPress={onDelete}
      delayLongPress={400}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.avatar}>
        <Text style={styles.avatarGlyph}>{title.charAt(0) || '?'}</Text>
      </View>
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.rowTime}>{formatWhen(conversation.lastMessageAt)}</Text>
        </View>
        <Text style={styles.rowSnippet} numberOfLines={2}>
          {snippet ?? `${conversation.messageCount} 条消息`}
        </Text>
      </View>
    </Pressable>
  )
}

/** Most recent message text, or null when the conversation has none loaded. */
function lastMessageSnippet(list: Message[] | undefined): string | null {
  if (!list || list.length === 0) return null
  const last = list[list.length - 1]
  if (!last) return null
  return last.content.replace(/\s+/g, ' ').slice(0, 120)
}

/**
 * A window around the match.
 *
 * Showing the first 120 characters would hide the hit whenever it is deep in a
 * long message — the user sees a snippet and no reason it matched, which reads
 * as a bug.
 */
function snippetAround(text: string, query: string): string {
  const flat = text.replace(/\s+/g, ' ')
  const at = flat.toLowerCase().indexOf(query)
  if (at < 0) return flat.slice(0, 120)
  const start = Math.max(0, at - 30)
  const end = Math.min(flat.length, at + query.length + 60)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

/** Compact relative time, the way a messaging app shows it. */
function formatWhen(epochMs: number): string {
  if (!epochMs) return ''
  const diff = Date.now() - epochMs
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  const d = new Date(epochMs)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

const styles = StyleSheet.create({
  searchWrap: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  search: {
    ...typography.body,
    color: colors.text,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  clearBtn: {
    position: 'absolute',
    right: spacing.lg + spacing.md,
    top: spacing.md + spacing.sm + 2,
  },
  clearGlyph: { color: colors.textFaint, fontSize: 16 },

  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, gap: spacing.xs },

  /**
   * Comfortable row height with a pressed state.
   *
   * The row had no pressed feedback at all before — tapping a conversation
   * looked like nothing happened until the screen changed, which on a slow load
   * reads as a dropped tap. The tint also has to be subtle: a full-row highlight
   * at this size is heavier than a messaging app wants.
   */
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
    paddingHorizontal: spacing.md,
    borderRadius: 14,
  },
  rowPressed: { backgroundColor: colors.pressed },
  rowBody: { flex: 1, gap: 2 },
  rowTop: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  rowTitle: { ...typography.body, color: colors.text, fontWeight: '600' as const, flex: 1, letterSpacing: -0.1 },
  rowTime: { ...typography.caption, color: colors.textFaint },
  rowSnippet: { ...typography.caption, color: colors.textMuted, lineHeight: 17 },

  avatar: {
    width: 46,
    height: 46,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /**
   * The initial reads as a monogram, not a title.
   *
   * It was 	ypography.title at 22px in the accent blue on an accent-tinted
   * circle — the loudest element on the screen, for the least important
   * information. Smaller and neutral lets the conversation title carry the row.
   */
  avatarGlyph: { fontSize: 18, fontWeight: '600' as const, color: colors.textMuted },

  empty: { alignItems: 'center', padding: spacing.xxl, gap: spacing.sm, marginTop: spacing.xxl },
  emptyGlyph: { fontSize: 40 },
  emptyTitle: { ...typography.title, color: colors.text },
  emptyBody: { ...typography.body, color: colors.textMuted, textAlign: 'center' },

  addBtn: {
    width: 44,
    height: 44,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addBtnGlyph: { color: '#FFFFFF', fontSize: 24, lineHeight: 28, fontWeight: '500' },
  pressed: { opacity: 0.7 },
})
