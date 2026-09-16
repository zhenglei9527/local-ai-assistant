import React, { useCallback, useMemo, useState } from 'react'
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'

import { ScreenScaffold } from '@/ui/ScreenScaffold'
import { ModelPickerButton } from '@/ui/components/ModelPickerButton'
import { colors, radii, spacing, typography } from '@/ui/theme'
import { useChatStore, useEngineStore, useModelStore, useSettingsStore } from '@/store'
import type { Message } from '@/types/domain'

/**
 * Chat transcript + composer.
 *
 * ⚠️ PERFORMANCE NOTE — this is the screen that decides whether the app feels
 * native or not, so the streaming path is designed rather than incidental:
 *
 *   - Token deltas live in `streamingText` (read from `useEngineStore`), NOT
 *     in the `messages` array. Appending every token to `messages` would
 *     re-render the whole FlatList at 20–60 Hz and drop frames on mid-range
 *     hardware. One extra bubble at the tail costs nothing.
 *   - `renderItem` is `useCallback`-stable and each row is `React.memo`'d, so
 *     a streaming tick cannot invalidate the historical rows.
 *   - The list is `inverted` with newest-first data: no scrollToEnd bookkeeping
 *     during streaming, which is the other common source of jank here.
 */
export function ChatScreen(): React.JSX.Element {
  const engineStatus = useEngineStore((s) => s.status)
  const streamingText = useEngineStore((s) => s.streamingText)
  const tokensPerSecond = useEngineStore((s) => s.tokensPerSecond)
  const generate = useEngineStore((s) => s.generate)
  const stop = useEngineStore((s) => s.stop)

  const readyModelId = useModelStore((s) => s.readyModelId)
  const messages = useChatStore((s) => s.messages)
  const appendUser = useChatStore((s) => s.appendUser)
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)

  const [draft, setDraft] = useState('')

  const isGenerating = engineStatus.state === 'generating'

  /**
   * Can the user send?
   *
   * ⚠️ Gating on `readyModelId` alone was a real defect: that field only ever
   * describes a LOCAL model, so in cloud mode it stays null and the composer
   * silently refused every send — no error, no spinner, nothing. "Select cloud,
   * type, press send, and nothing happens" is exactly what a user reported.
   *
   * What actually makes a send possible is that the ENGINE is ready, whichever
   * backend it is. `readyModelId` is only consulted as a second opinion when
   * the backend is local.
   */
  const backend = useSettingsStore((s) => s.backend)
  const engineReady = engineStatus.state === 'ready' || engineStatus.state === 'generating'
  const canSend =
    draft.trim().length > 0 && !isGenerating && (backend === 'remote' || readyModelId != null)

  // Newest-first copy for the inverted list. Reversed once per change rather
  // than per render of each row.
  const listData = useMemo(() => [...messages].reverse(), [messages])

  const onSend = useCallback(() => {
    const text = draft.trim()
    // Same correction as `canSend`: cloud mode has no local `readyModelId`, so
    // requiring one made the send a silent no-op exactly when the user had
    // explicitly chosen the cloud backend.
    if (!text || isGenerating) return
    if (backend === 'local' && readyModelId == null) return
    setDraft('')
    appendUser(text)
    void generate()
  }, [draft, isGenerating, backend, readyModelId, appendUser, generate])

  const onStop = useCallback(() => {
    void stop()
  }, [stop])

  const renderItem = useCallback(
    ({ item }: { item: Message }) => <MessageBubble message={item} />,
    [],
  )

  /**
   * The in-flight assistant bubble.
   *
   * ⚠️ MUST be passed to FlatList as a FUNCTION, not an element.
   *
   * `ListHeaderComponent={<X/>}` hands FlatList a React *element*, which its
   * internal `ListHeaderComponent` wrapper memoises — it renders once and then
   * ignores prop changes, because the element identity it captured never
   * changes. The effect on device was that a whole reply appeared at once when
   * generation finished: every token updated `streamingText` correctly, and the
   * UI simply never re-read it.
   *
   * `ListHeaderComponent={() => <X/>}` gives FlatList a component type, which
   * it re-invokes on every render of the list — so each token paints.
   */
  const renderStreamingRow = useCallback(
    () =>
      isGenerating ? (
        <MessageBubble
          streaming
          message={{
            id: '__streaming__',
            conversationId: '',
            role: 'assistant',
            content: streamingText,
            reasoning: null,
            createdAt: 0,
            modelId: readyModelId,
            swipeIndex: 0,
            swipes: [],
            edited: false,
            pinned: false,
          }}
        />
      ) : null,
    [isGenerating, streamingText, readyModelId],
  )

  const blockedReason = useMemo(() => {
    // Cloud mode has no local model id by design — never report it as missing.
    if (backend === 'local' && readyModelId == null) return '还没有加载模型'
    if (engineStatus.state === 'loading') return '模型加载中…'
    if (engineStatus.state === 'error') return engineStatus.error ?? '引擎出错'
    return null
  }, [backend, readyModelId, engineStatus])

  const canChat =
    engineStatus.state !== 'loading' && (backend === 'remote' || readyModelId != null)

  // Back to the conversation list. Clearing the active id is the whole
  // mechanism: the navigator shows the list whenever `activeConversationId`
  // is null, so no separate route state has to be kept in sync.
  const onBack = useCallback(() => {
    setActiveConversation(null)
  }, [setActiveConversation])

  return (
    <ScreenScaffold
      title="对话"
      subtitle={
        backend === 'remote'
          ? '云端 API · 对话内容会发送到第三方'
          : subtitleFor(engineStatus, readyModelId)
      }
      scroll={false}
      headerLeft={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="返回对话列表"
          onPress={onBack}
          hitSlop={12}
          style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
        >
          <Text style={styles.backGlyph}>‹</Text>
        </Pressable>
      }
    >
      {/*
        Error banner.

        ⚠️ `blockedReason` was computed and then NEVER RENDERED — a leftover
        from an earlier refactor. The observable effect was the worst failure
        mode a chat app can have: press send, nothing happens, no error, no
        spinner. A wrong cloud model name produced exactly that, because the
        provider's 400 went into `engineStatus.error` and the screen read every
        field except that one.

        Rendered ABOVE the transcript so it survives an empty message list —
        which is precisely the case where the user most needs to see it.
      */}
      {blockedReason && engineStatus.state !== 'generating' ? (
        <View style={styles.errorBanner} accessibilityRole="alert">
          <Text style={styles.errorBannerText}>{blockedReason}</Text>
        </View>
      ) : null}

      {messages.length === 0 && !isGenerating ? (
        <View style={styles.empty}>
          <Text style={styles.emptyGlyph}>{'\u{1F4AC}'}</Text>
          <Text style={styles.emptyTitle}>还没有开始对话</Text>
          <Text style={styles.emptyBody}>
            {canChat
              ? backend === 'remote'
                ? '在下面输入消息开始聊天。当前使用云端 API，对话内容会发送到第三方。'
                : '在下面输入消息，开始聊天。所有内容都在本机处理，不会上传。'
              : engineStatus.state === 'loading'
                ? '正在加载模型，请稍候…'
                : '还没有可用的模型。请在输入框左侧选择模型，或到「模型」页下载一个。'}
          </Text>
        </View>
      ) : (
        <FlatList
          style={styles.list}
          contentContainerStyle={styles.listContent}
          data={listData}
          inverted={listData.length > 0}
          keyExtractor={(m) => m.id}
          renderItem={renderItem}
          ListHeaderComponent={renderStreamingRow}
          keyboardShouldPersistTaps="handled"
          removeClippedSubviews
          initialNumToRender={12}
          maxToRenderPerBatch={10}
          windowSize={9}
        />
      )}

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        <View style={styles.composer}>
          <ModelPickerButton />
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder={canChat ? '输入消息…' : '请在输入框左侧选择模型'}
            placeholderTextColor={colors.textFaint}
            editable={canChat}
            multiline
            maxLength={8000}
            textAlignVertical="top"
          />
          {isGenerating ? (
            /*
              Live counter, not decoration. On a 3B model the phone emits
              roughly 10 tokens/second, so a full reply takes tens of seconds;
              without a moving number a slow model is indistinguishable from a
              hung one, and users kill the app.
            */
            <View style={styles.generatingInfo}>
              <Text style={styles.generatingCount}>{streamingText.length} 字</Text>
              {tokensPerSecond > 0 ? (
                <Text style={styles.generatingSpeed}>
                  {tokensPerSecond.toFixed(1)} tok/s
                </Text>
              ) : (
                <Text style={styles.generatingSpeed}>生成中…</Text>
              )}
            </View>
          ) : null}
          {isGenerating ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="停止生成"
              onPress={onStop}
              style={({ pressed }) => [styles.action, styles.stop, pressed && styles.pressed]}
            >
              <Text style={styles.actionText}>停止</Text>
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="发送消息"
              onPress={onSend}
              disabled={!canSend}
              style={({ pressed }) => [
                styles.action,
                styles.send,
                !canSend && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.actionText}>发送</Text>
            </Pressable>
          )}
        </View>
      </KeyboardAvoidingView>
    </ScreenScaffold>
  )
}

function subtitleFor(
  status: { state: string; gpuActive: boolean },
  modelId: string | null,
): string {
  if (modelId == null) return '未加载模型'
  const backend = status.gpuActive ? 'GPU' : 'CPU'
  return `${modelId} · ${backend}`
}

/**
 * One transcript row.
 *
 * `React.memo` is load-bearing: without it a streaming tick re-renders every
 * historical message. Props are primitives plus a stable `message` object
 * reference, so the default shallow comparison is sufficient.
 */
const MessageBubble = React.memo(function MessageBubble({
  message,
  streaming = false,
}: {
  message: Message
  streaming?: boolean
}): React.JSX.Element {
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'

  return (
    <View style={[styles.row, isUser ? styles.rowUser : styles.rowAssistant]}>
      <View
        style={[
          styles.bubble,
          isUser ? styles.bubbleUser : isSystem ? styles.bubbleSystem : styles.bubbleAssistant,
        ]}
      >
        {isSystem ? <Text style={styles.roleTag}>SYSTEM</Text> : null}
        <Text style={styles.bubbleText} selectable>
          {message.content}
          {streaming ? <Text style={styles.caret}>▍</Text> : null}
        </Text>
        {message.reasoning ? (
          <Text style={styles.reasoning} numberOfLines={4}>
            {message.reasoning}
          </Text>
        ) : null}
      </View>
    </View>
  )
})

const styles = StyleSheet.create({
  list: { flex: 1 },
  listContent: { padding: spacing.lg, gap: spacing.sm },

  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xxl,
    gap: spacing.sm,
  },
  emptyGlyph: { fontSize: 40 },
  emptyTitle: { ...typography.title, color: colors.text },
  emptyBody: { ...typography.body, color: colors.textMuted, textAlign: 'center' },

  row: { flexDirection: 'row' },
  rowUser: { justifyContent: 'flex-end' },
  rowAssistant: { justifyContent: 'flex-start' },
  bubble: {
    maxWidth: '86%',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.lg,
  },
  bubbleUser: { backgroundColor: colors.bubbleUser, borderBottomRightRadius: radii.sm },
  bubbleAssistant: {
    backgroundColor: colors.bubbleAssistant,
    borderBottomLeftRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  bubbleSystem: { backgroundColor: colors.bubbleSystem },
  bubbleText: { ...typography.body, color: colors.text },
  roleTag: { ...typography.caption, color: colors.warning, fontWeight: '700', marginBottom: 2 },
  reasoning: {
    ...typography.caption,
    color: colors.textFaint,
    fontStyle: 'italic',
    marginTop: spacing.xs,
    borderLeftWidth: 2,
    borderLeftColor: colors.border,
    paddingLeft: spacing.sm,
  },
  caret: { color: colors.accent },

  backBtn: {
    width: 32,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backGlyph: { color: colors.accent, fontSize: 32, lineHeight: 34, fontWeight: '300' },

  /** Live "N 字 / X tok/s" readout shown while generating. */
  generatingInfo: {
    alignItems: 'flex-end',
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
    minWidth: 56,
  },
  generatingCount: { ...typography.caption, color: colors.textMuted },
  generatingSpeed: { ...typography.caption, color: colors.textFaint },

  /** Red banner above the transcript. Must be impossible to miss. */
  errorBanner: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: 'rgba(248,81,73,0.12)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.danger,
  },
  errorBannerText: { ...typography.body, color: colors.danger },

  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    padding: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 140,
    ...typography.body,
    color: colors.text,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  action: {
    minHeight: 44,
    minWidth: 64,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
  },
  send: { backgroundColor: colors.accent },
  stop: { backgroundColor: colors.danger },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.75 },
  actionText: { color: '#FFFFFF', fontWeight: '600', fontSize: 15 },
})
