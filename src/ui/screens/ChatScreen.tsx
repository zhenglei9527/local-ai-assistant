import React, { useCallback, useMemo, useState } from 'react'
import {
  Alert,
  Clipboard,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'

import { ScreenScaffold } from '@/ui/ScreenScaffold'
import { ModelPickerButton } from '@/ui/components/ModelPickerButton'
import { OFFICIAL_LINE } from '@/data/models/lineCatalog'
import { activeEngine } from '@/inference/engineFactory'
import { colors, radii, spacing, typography } from '@/ui/theme'
import { useChatStore, useEngineStore, useModelStore, useSettingsStore } from '@/store'
// The version bar's decision logic lives in the store layer rather than inline
// in JSX so it is reachable from tests — this screen has no renderer under
// `node --test`.
import { swipeLabel } from '@/store/swipe'
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
  /**
   * Engine state, read as TWO flat fields.
   *
   * This screen used to read `engineStatus.state` and `engineStatus.error`,
   * but the store has never had that shape — it holds `status` (a bare string)
   * plus a separate `error` field. Both reads evaluated to `undefined`, so
   * `isGenerating` was permanently false and the composer never switched to the
   * Stop button while the model was answering. A user could tap Send repeatedly
   * mid-generation, queueing duplicate turns.
   *
   * It survived review because the failure is silent and the send path still
   * looks correct; the only visible symptom was a missing Stop button.
   * TypeScript flags it, but this project typechecks nothing at build time —
   * only its tests run.
   */
  const engineStatusValue = useEngineStore((s) => s.status)
  const engineError = useEngineStore((s) => s.error)
  const streamingText = useEngineStore((s) => s.streamingText)
  const tokensPerSecond = useEngineStore((s) => s.tokensPerSecond)
  const generate = useEngineStore((s) => s.generate)
  const stop = useEngineStore((s) => s.stop)

  const readyModelId = useModelStore((s) => s.readyModelId)
  const messages = useChatStore((s) => s.messages)
  const appendUser = useChatStore((s) => s.appendUser)
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)
  const removeMessage = useChatStore((s) => s.removeMessage)
  const regenerateFrom = useChatStore((s) => s.regenerateFrom)
  /**
   * Swipe (multi-version) navigation.
   *
   * Read individually rather than destructuring the whole store: a selector that
   * returned an object would allocate a new one every render and defeat the
   * `React.memo` on each row, which is the thing keeping the streaming path
   * smooth (see the module header).
   */
  const nextSwipe = useChatStore((s) => s.nextSwipe)
  const prevSwipe = useChatStore((s) => s.prevSwipe)

  const [draft, setDraft] = useState('')

  const isGenerating = engineStatusValue === 'generating'

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
  const engineReady = engineStatusValue === 'ready' || engineStatusValue === 'generating'
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

  /**
   * Open the editor for one message.
   *
   * Holds the *whole* message rather than just its id and text: the save path
   * has to write a full `Message` back (`replaceMessage` takes an object), and
   * rebuilding one from a stale lookup would be a chance to lose `createdAt`,
   * `reasoning` or the swipe list.
   */
  const [editing, setEditing] = useState<Message | null>(null)

  const openEditor = useCallback((message: Message) => {
    setEditing(message)
  }, [])

  const closeEditor = useCallback(() => {
    setEditing(null)
  }, [])

  /**
   * Commit an edit.
   *
   * ── Why the context reset is here, not in the store ─────────────────────────
   * `replaceMessage` swaps one row and stops. That is correct for a store
   * primitive, but on its own it leaves the engine holding a KV cache built from
   * the OLD text: the prefix no longer matches the transcript, and a local model
   * then answers as though the correction never happened — or continues the
   * replaced text. `src/data/db/schema.ts` states the rule ("the engine must
   * reset its context after any edit or delete"); `regenerateFrom` already pays
   * it, and this is the same payment.
   *
   * Failure is swallowed deliberately, exactly as `regenerateFrom` does: a
   * context reset that throws must not cost the user the edit they just made.
   * The worst case is a slower, slightly stale next turn; blocking the save
   * would silently discard their typing.
   */
  const onSaveEdit = useCallback(
    (next: string) => {
      const target = editing
      if (!target) return
      setEditing(null)
      useChatStore.getState().replaceMessage({ ...target, content: next, edited: true })
      void (async () => {
        try {
          await activeEngine()?.resetContext()
        } catch {
          // See above — the edit already landed and must survive this.
        }
      })()
    },
    [editing],
  )

  /**
   * Long-press a message → action sheet.
   *
   * WHY THIS EXISTS: message bubbles had no actions at all. Their text was
   * rendered with `selectable`, so a long-press triggered Android's OWN
   * text-selection menu ("复制 / 全选 / 分享") — the user got a system menu that
   * cannot delete a message or regenerate a reply, and reasonably read it as
   * "the delete I was promised does not work".
   *
   * `selectable` is now removed from the bubble text (copying is offered in this
   * menu instead), so the gesture reaches our handler.
   */
  const onMessageLongPress = useCallback(
    (message: Message) => {
      const isAssistant = message.role === 'assistant'

      const actions: Array<{
        text: string
        style?: 'cancel' | 'destructive'
        onPress?: () => void
      }> = [
        {
          text: '复制',
          onPress: () => {
            Clipboard.setString(message.content)
          },
        },
      ]

      // Regeneration only makes sense for a reply: a user turn has nothing to
      // regenerate from.
      if (isAssistant) {
        actions.push({
          text: '重新生成',
          onPress: () => {
            void regenerateFrom(message.id)
          },
        })
      }

      /**
       * Edit, before Delete.
       *
       * APPENDED with `push`, never by rewriting the array above: task D adds its
       * own entry to this same list, and two agents rebuilding the literal would
       * silently drop one another's item.
       */
      actions.push({
        text: '编辑',
        onPress: () => {
          openEditor(message)
        },
      })

      actions.push({
        text: '删除',
        style: 'destructive',
        onPress: () => {
          Alert.alert('删除消息', '确定要删除这条消息吗？此操作无法撤销。', [
            { text: '取消', style: 'cancel' },
            { text: '删除', style: 'destructive', onPress: () => removeMessage(message.id) },
          ])
        },
      })

      actions.push({ text: '取消', style: 'cancel' })

      /**
       * `Alert` with buttons rather than `ActionSheetIOS` or a custom modal:
       * it is one API that renders correctly on both platforms, needs no
       * dependency, and its buttons already support the destructive styling
       * Android and iOS users expect for delete.
       */
      Alert.alert('消息操作', undefined, actions)
    },
    [removeMessage, regenerateFrom, openEditor],
  )

  const renderItem = useCallback(
    ({ item }: { item: Message }) => (
      <MessageBubble
        message={item}
        onLongPress={() => onMessageLongPress(item)}
        onPrevSwipe={() => prevSwipe(item.id)}
        onNextSwipe={() => nextSwipe(item.id)}
      />
    ),
    [onMessageLongPress, prevSwipe, nextSwipe],
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
    if (engineStatusValue === 'loading') return '模型加载中…'
    if (engineStatusValue === 'error') return engineError ?? '引擎出错'
    return null
    // Depends on the flat values, not an `engineStatus` object — that binding
    // no longer exists, and listing it made the memo depend on `undefined`.
  }, [backend, readyModelId, engineStatusValue, engineError])

  const canChat =
    engineStatusValue !== 'loading' && (backend === 'remote' || readyModelId != null)

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
          : subtitleFor(engineStatusValue, engineError, readyModelId)
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
      {blockedReason && engineStatusValue !== 'generating' ? (
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
              : engineStatusValue === 'loading'
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
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder={canChat ? '输入消息…' : '点右侧 ＋ 选择模型'}
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
          {/*
            The model picker, to the RIGHT of send.
            
            It used to be a wide pill on the LEFT showing the model name,
            which ate a large share of the composer width and squeezed the
            text field into what was left. As a bare + it costs one icon's
            width, and the two tap targets sit together at thumb reach.
            
            The current model is still always visible: the header subtitle
            above the transcript names it.
          */}
          <ModelPickerButton />
        </View>
      </KeyboardAvoidingView>

      {/*
        The edit sheet lives at the SCREEN level, outside the KeyboardAvoidingView
        and the transcript, so typing in it is not re-laid-out by the composer's
        keyboard handling and so an edit does not re-render the message list.
      */}
      {editing ? (
        <EditMessageModal
          key={editing.id}
          initial={editing.content}
          onCancel={closeEditor}
          onSave={onSaveEdit}
        />
      ) : null}
    </ScreenScaffold>
  )
}

/**
 * Edit one message's text.
 *
 * ── Why a Modal and not `Alert.prompt` ──────────────────────────────────────
 * This is an Android app, and `Alert.prompt` does not exist there — it is an
 * iOS-only API. Calling it on Android is not a visible crash: React Native
 * reaches an undefined native method and the press does nothing at all, which is
 * the worst possible failure for an edit button. A plain `<Modal>` with a
 * `TextInput` works on both platforms and is the only option that can honour the
 * dark theme.
 *
 * ── Why the draft is copied out of the message ──────────────────────────────
 * The field is seeded once from `initial` and then owns its text. Writing every
 * keystroke back into the store would push the transcript through a re-render
 * per character, and — worse — would persist a half-typed message if the user
 * backed out.
 */
function EditMessageModal({
  initial,
  onCancel,
  onSave,
}: {
  initial: string
  onCancel: () => void
  onSave: (next: string) => void
}): React.JSX.Element {
  const [text, setText] = useState(initial)

  // A message cannot be saved as empty. Whitespace-only content would render as
  // a blank bubble that the model still receives as a turn.
  const canSave = text.trim().length > 0

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      {/*
        Tapping the backdrop cancels, matching the model picker's sheet. The
        inner Pressable swallows taps so that a mistimed tap inside the sheet
        does not discard what the user has typed.
      */}
      <Pressable style={styles.editBackdrop} onPress={onCancel}>
        <Pressable style={styles.editSheet} onPress={() => {}}>
          <View style={styles.editGrabber} />
          <Text style={styles.editTitle}>编辑消息</Text>
          <Text style={styles.editHint}>修改后，这条消息之后的对话上下文会重新计算。</Text>

          <TextInput
            style={styles.editInput}
            value={text}
            onChangeText={setText}
            multiline
            autoFocus
            maxLength={8000}
            textAlignVertical="top"
            placeholder="输入消息内容…"
            placeholderTextColor={colors.textFaint}
          />

          <View style={styles.editActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="取消编辑"
              onPress={onCancel}
              style={({ pressed }) => [
                styles.editBtn,
                styles.editCancel,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.editCancelText}>取消</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="保存修改"
              onPress={() => onSave(text)}
              disabled={!canSave}
              style={({ pressed }) => [
                styles.editBtn,
                styles.editSave,
                !canSave && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.editSaveText}>保存</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

/**
 * Header subtitle: which model is answering.
 *
 * Now that the composer's model control is an unlabelled +, this line is the
 * ONLY place the active model is named, so it has to be readable. It
 * previously printed the raw id -- qwen2.5-3b-instruct-q4_0 - CPU -- which
 * is a filename, not a label. The catalogue lookup gives the display name and
 * falls back to the raw id, which is what happens for a model re-adopted from
 * disk whose catalogue entry is missing.
 */
function subtitleFor(
  status: string,
  error: string | null,
  modelId: string | null,
): string {
  if (status === 'error') return error ?? '引擎出错'
  if (status === 'loading') return '模型加载中…'
  if (modelId == null) return '未加载模型'
  const device = 'CPU'
  const found = OFFICIAL_LINE.find((m) => m.id === modelId)
  const name = found?.displayName ?? modelId
  return name + ' · ' + device
}

/**
 * One transcript row.
 *
 * `React.memo` is load-bearing: without it a streaming tick re-renders every
 * historical message. Props are primitives plus a stable `message` object
 * reference, so the default shallow comparison is sufficient. The swipe
 * handlers are `useCallback`-stable in the parent, so adding them does not
 * break that comparison.
 */
const MessageBubble = React.memo(function MessageBubble({
  message,
  streaming = false,
  onLongPress,
  onPrevSwipe,
  onNextSwipe,
}: {
  message: Message
  streaming?: boolean
  /**
   * Invoked on long-press. Optional because the streaming bubble is not a real
   * message and has nothing to act on.
   */
  onLongPress?: () => void
  /** Switch to the previous/next version of this reply. */
  onPrevSwipe?: () => void
  onNextSwipe?: () => void
}): React.JSX.Element {
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'

  /**
   * The version bar's visible state, or null when there is nothing to switch.
   *
   * `swipeLabel` owns the decision (hidden below two versions, position always
   * in range) so the numbers shown here are covered by unit tests — this screen
   * has no renderer in the test environment, so a fraction computed inline in
   * JSX would be unverifiable.
   *
   * A pre-feature row (or a user turn) yields null, so the bar never renders an
   * impossible "0/0".
   */
  const swipe = streaming ? null : swipeLabel(message)

  /**
   * Reasoning is COLLAPSED by default.
   *
   * It used to render inline at up to four lines, which put the model's private
   * deliberation directly into the chat — on device a reply showed "嗯，用户只
   * 发了一个－，这看起来像是一个破折号…" above the actual answer. That reads as
   * the character thinking out loud, breaks immersion, and buries the reply.
   *
   * Collapsed rather than hidden, because the reasoning is genuinely useful when
   * a small model gives a strange answer and you want to know why. One tap
   * reveals it.
   */
  const [showReasoning, setShowReasoning] = useState(false)

  return (
    <View style={[styles.row, isUser ? styles.rowUser : styles.rowAssistant]}>
      <Pressable
        /**
         * The bubble itself is the long-press target.
         *
         * Wrapping the whole bubble (rather than only the text) means the
         * gesture works on short messages and on empty-looking whitespace, which
         * is what a user actually aims at.
         *
         * `onLongPress` is undefined for the streaming bubble, and Pressable
         * treats that as "no long-press behaviour" without disabling the
         * pressable — so the streaming row still lays out identically.
         */
        onLongPress={onLongPress}
        delayLongPress={350}
        accessibilityHint={onLongPress ? '长按可复制、删除或重新生成' : undefined}
        style={[
          styles.bubble,
          isUser ? styles.bubbleUser : isSystem ? styles.bubbleSystem : styles.bubbleAssistant,
        ]}
      >
        {isSystem ? <Text style={styles.roleTag}>SYSTEM</Text> : null}

        {message.reasoning && !streaming ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={showReasoning ? '收起思考过程' : '展开思考过程'}
            onPress={() => setShowReasoning((v) => !v)}
            hitSlop={6}
            style={({ pressed }) => [styles.reasoningToggle, pressed && styles.pressed]}
          >
            <Text style={styles.reasoningToggleText}>
              {showReasoning ? '▾ 思考过程' : '▸ 思考过程'}
            </Text>
          </Pressable>
        ) : null}

        {showReasoning && message.reasoning ? (
          <Text style={styles.reasoning}>{message.reasoning}</Text>
        ) : null}

        {/*
          NOT `selectable`.

          `selectable` made a long-press open Android's own text-selection menu
          ("复制 / 全选 / 分享") instead of this bubble's action sheet, so the
          delete and regenerate actions were unreachable — the user saw a system
          menu and concluded the feature was broken. Copying is offered in that
          action sheet instead, which is where it belongs now that the gesture is
          ours.
        */}
        <Text style={styles.bubbleText}>
          {message.content}
          {streaming ? <Text style={styles.caret}>▍</Text> : null}
        </Text>

        {/*
          Timestamp, inside the bubble at the bottom-right.
          
          A transcript with no times at all makes it impossible to tell
          whether a reply came a minute or a day later, and the conversation
          list already shows relative times — so a message having none was an
          inconsistency the user could feel without being able to name it.
          
          Not shown while streaming: that bubble's createdAt is a placeholder,
          and a clock ticking on an in-flight reply is noise.
        */}
        {!streaming && message.createdAt > 0 ? (
          <Text
            style={[
              styles.bubbleTime,
              isUser ? styles.bubbleTimeUser : styles.bubbleTimeAssistant,
            ]}
          >
            {formatClock(message.createdAt)}
          </Text>
        ) : null}
      </Pressable>

      {/*
        Version switcher: ‹ 2/3 ›.

        ── Why it is OUTSIDE the Pressable ───────────────────────────────────
        The bubble itself is the long-press target. Nested inside it, a tap on an
        arrow would also register on the parent Pressable, so switching versions
        would risk opening the action sheet instead — and the two gestures would
        fight over the same 350ms window. A sibling row keeps the two entirely
        separate, which is also why the long-press structure above is untouched.

        ── Why hidden below two versions ─────────────────────────────────────
        One version is the normal case: an ordinary reply has exactly one, and a
        control reading "1/1" is pure noise on every message in the transcript.
        The feature should only announce itself when there is somewhere to go.
      */}
      {swipe ? (
        <View style={styles.swipeBar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="上一个版本"
            onPress={onPrevSwipe}
            hitSlop={8}
            style={({ pressed }) => [styles.swipeArrow, pressed && styles.pressed]}
          >
            <Text style={styles.swipeArrowText}>‹</Text>
          </Pressable>

          <Text style={styles.swipeCount}>
            {swipe.position}/{swipe.total}
          </Text>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="下一个版本"
            onPress={onNextSwipe}
            hitSlop={8}
            style={({ pressed }) => [styles.swipeArrow, pressed && styles.pressed]}
          >
            <Text style={styles.swipeArrowText}>›</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  )
})

/**
 * HH:MM, 24-hour.
 *
 * Built by hand rather than via toLocaleTimeString: on a Chinese-locale device
 * the default form renders 下午4:33, which is too long for the bubble's bottom
 * line and wraps. The numeric form is also unambiguous in a transcript.
 */
function formatClock(epochMs: number): string {
  const d = new Date(epochMs)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return hh + ':' + mm
}

const styles = StyleSheet.create({
  list: { flex: 1 },
  /**
   * Vertical rhythm between turns.
   *
   * gap: spacing.sm (8) made consecutive bubbles read as one block — a user
   * message and the reply to it looked like a single wall of text. 14px is
   * enough to group each turn visually without wasting scroll height, and the
   * horizontal padding keeps long lines off the screen edge.
   */
  listContent: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: 14 },

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
    /**
     * 82%, not 86%.
     *
     * At 86% a long CJK reply runs past the line length where the eye
     * comfortably tracks back to the next line, and the bubble sits flush
     * against the screen edge, which stops it reading as a bubble at all.
     */
    maxWidth: '82%',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
  },
  bubbleUser: { backgroundColor: colors.bubbleUser, borderBottomRightRadius: 6 },
  bubbleAssistant: {
    backgroundColor: colors.bubbleAssistant,
    borderBottomLeftRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  bubbleSystem: { backgroundColor: colors.bubbleSystem },
  bubbleText: { ...typography.message, color: colors.text },

  /**
   * Version switcher, on its own line under the bubble.
   *
   * `alignSelf: 'flex-start'` matches the assistant bubble's own alignment, so
   * the control lines up with the left edge of the reply it belongs to rather
   * than floating in the middle of the row.
   *
   * The container deliberately does NOT set `flexDirection` alignment to the
   * row's opposite side: these are assistant-only (a user turn has no
   * alternatives), so right-aligning them would never apply.
   */
  swipeBar: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 2,
    marginTop: 4,
    marginLeft: 2,
  },
  /**
   * Arrow hit area.
   *
   * 28x28 rather than a bare glyph: the ‹ › characters alone are a few pixels
   * wide, which fails the 44pt touch-target guideline and makes the control feel
   * broken on a phone. `hitSlop` widens it further without affecting layout.
   */
  swipeArrow: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    backgroundColor: colors.surfaceRaised,
  },
  swipeArrowText: {
    color: colors.textMuted,
    fontSize: 17,
    lineHeight: 20,
    fontWeight: '400',
  },
  /** "2/3" — monospace-ish width so the arrows do not jitter as it changes. */
  swipeCount: {
    ...typography.caption,
    color: colors.textFaint,
    fontVariant: ['tabular-nums'],
    paddingHorizontal: 2,
    minWidth: 30,
    textAlign: 'center',
  },
  /**
   * Time inside the bubble, bottom-right.
   *
   * lignSelf: flex-end rather than a wrapping row: the timestamp must sit on
   * its own line under the text, and a row would place it beside the last line
   * of a short message — which looks like a typo, not a timestamp.
   *
   * Muted on both bubbles, but the user bubble needs a lighter tone: white-on-
   * blue at 12px disappears, while the same value on the dark assistant bubble
   * is legible.
   */
  bubbleTime: { ...typography.caption, fontSize: 11, alignSelf: 'flex-end', marginTop: 3 },
  bubbleTimeUser: { color: 'rgba(255,255,255,0.62)' },
  bubbleTimeAssistant: { color: colors.textFaint },
  roleTag: { ...typography.caption, color: colors.warning, fontWeight: '700', marginBottom: 2 },
  /**
   * The 思考过程 disclosure control.
   *
   * Styled as a pill rather than bare text. As plain low-contrast text it was
   * indistinguishable from the reasoning excerpt it reveals, so it did not
   * read as tappable at all. A faint background gives it an obvious hit area
   * without competing with the reply itself.
   */
  reasoningToggle: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginBottom: spacing.sm,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  reasoningToggleText: {
    ...typography.caption,
    fontSize: 11.5,
    color: colors.textMuted,
  },
  reasoning: {
    ...typography.caption,
    color: colors.textFaint,
    fontStyle: 'italic',
    marginBottom: spacing.sm,
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
  /**
   * Composer input.
   *
   * Pill-shaped rather than a rounded rectangle: at a fixed 44px height a
   * large corner radius is what makes it read as a text field rather than a
   * box, and it echoes the bubbles above it. Vertical padding is explicit
   * rather than symmetric because Android centres single-line text
   * differently once paddingVertical is involved.
   */
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 140,
    ...typography.body,
    color: colors.text,
    backgroundColor: colors.surfaceRaised,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingTop: 11,
    paddingBottom: 11,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  /**
   * Send button.
   *
   * Pill-shaped to match the input beside it, and slightly wider than before
   * so the two-character label 发送 is not cramped against the edges.
   */
  action: {
    minHeight: 44,
    minWidth: 68,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
    paddingHorizontal: spacing.lg,
  },
  send: { backgroundColor: colors.accent },
  stop: { backgroundColor: colors.danger },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.75 },
  actionText: { color: '#FFFFFF', fontWeight: '600', fontSize: 15 },

  /**
   * Edit sheet.
   *
   * Same bottom-sheet geometry as the model picker (backdrop → sheet → grabber →
   * title), because the two are opened from the same screen and a second,
   * differently-shaped overlay would read as a different app. Pill radii on the
   * buttons match the composer's 胶囊 controls.
   */
  editBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.62)',
    justifyContent: 'flex-end',
  },
  editSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl,
    gap: spacing.xs,
  },
  editGrabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginBottom: spacing.md,
  },
  editTitle: { ...typography.title, fontSize: 19, color: colors.text },
  /**
   * Warns that editing invalidates what follows.
   *
   * Worth one line: the reply below an edited question was generated from the
   * OLD wording, and the engine's cached context is dropped on save. Saying so
   * here is cheaper than a user concluding the app "forgot" the conversation.
   */
  editHint: {
    ...typography.caption,
    color: colors.textMuted,
    marginBottom: spacing.md,
  },
  /**
   * Multi-line, ~5 rows tall.
   *
   * `minHeight` rather than a fixed height: a one-word correction should not
   * open a tall empty box, and a paragraph should not be edited through a
   * two-line slot.
   */
  editInput: {
    minHeight: 120,
    maxHeight: 240,
    ...typography.body,
    color: colors.text,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.lg,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  editActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  editBtn: {
    flex: 1,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.pill,
  },
  editCancel: {
    backgroundColor: colors.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  editCancelText: { ...typography.body, color: colors.textMuted, fontWeight: '600' },
  editSave: { backgroundColor: colors.accent },
  editSaveText: { ...typography.body, color: '#FFFFFF', fontWeight: '600' },
})
