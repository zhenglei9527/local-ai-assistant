import { create } from 'zustand'

import type {
  CharacterRecord,
  Conversation,
  MemorySnapshot,
  Message,
  ModelDescriptor,
  ModelRecord,
  SamplingParams,
  ContextConfig,
  GenerationTimings,
} from '@/types/domain'
import type { ChatMessage, LoadedModelInfo } from '@/inference/InferenceEngine'
import { DEFAULT_SAMPLING, DEFAULT_CONTEXT_CONFIG, clampThreads } from '@/inference/InferenceEngine'
import { activeEngine, activeBackendKind, setBackend } from '@/inference/engineFactory'
import type { BackendKind } from '@/inference/engineFactory'
import type { RemoteProviderConfig } from '@/inference/remote/providerConfig'
import {
  deleteConversation as deleteConversationRows,
  deleteMessage as deleteMessageRow,
  loadConversations,
  loadMessages,
  saveConversation,
  saveMessage,
  saveMessageSwipes,
  saveTranscript,
} from '@/data/db/conversations'
import {
  deleteCharacter as deleteCharacterRow,
  loadCharacters,
  saveCharacter as saveCharacterRow,
} from '@/data/db/characters'
import {
  loadSummary,
  saveSummary,
  type StoredSummary,
} from '@/data/db/summaries'
import {
  buildSummaryPrompt,
  buildTranscript,
  cleanSummary,
  DEFAULT_SUMMARIZE_CONFIG,
  formatSummaryForPrompt,
  shouldSummarize,
  toStoredSummary,
  transcriptChars,
  type SummarizeConfig,
} from '@/memory/summarize'
import { trimToContext } from '@/inference/contextWindow'
/**
 * Multi-version reply helpers.
 *
 * Pure functions in their own module rather than methods on the store: the
 * `content === swipes[swipeIndex]` invariant is the one thing in this feature
 * that corrupts a conversation SILENTLY when broken (the user reads version 2
 * while the model is sent version 1), so it gets exactly one implementation
 * that every call site routes through — and that implementation is testable
 * without a store, an engine, or a database.
 */
import { appendSwipe, stepSwipe, swipesOf, withSwipeIndex } from '@/store/swipe'
import { buildPrompt } from '@/character-card/buildPrompt'
import { alternateOpeningsFor, makeAssembleInput, openingMessageFor } from '@/character-card/adapter'
import { findLineModel } from '@/data/models/lineCatalog'
import {
  loadPersistedSettings,
  savePersistedSettings,
  snapshotForPersistence,
} from '@/data/settings/persist'

/**
 * Turns an engine failure into something a user can act on.
 *
 * The engines already map their own transport errors to Chinese (see
 * `describeError` in RemoteEngine), but a local `initLlama` failure surfaces as
 * a raw native string. Left untranslated it reads like a crash rather than a
 * recoverable condition.
 */
function describeEngineError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (/memory|oom|out of memory|alloc/i.test(raw)) {
    return '内存不足，无法加载或运行该模型。请换一个更小的模型，或关闭其他应用后重试。'
  }
  if (/not found|ENOENT|no such file/i.test(raw)) {
    return '模型文件不存在或已被删除，请在「模型」页重新下载。'
  }
  if (/context is full/i.test(raw)) {
    return '上下文已满。请开始新对话，或在设置中增大上下文长度。'
  }
  return `生成失败：${raw}`
}

/**
 * Zustand stores.
 *
 * Why Zustand over Redux/Context: the chat stream updates on every token. With
 * Context, each token re-renders every consumer of the tree. Zustand's
 * selector subscriptions let the token stream touch only the message bubble
 * that is actually growing.
 *
 * ── The one non-obvious rule ────────────────────────────────────────────────
 * Token deltas are NOT written into `messages`. They accumulate in
 * `streamingText`, a separate field consumed only by the streaming bubble. The
 * committed message is written to `messages` exactly once, when generation
 * ends. Interleaving partial writes into the message array makes the paging
 * logic and the KV-prefix bookkeeping fight each other.
 */

// ---------------------------------------------------------------------------
// Engine store
// ---------------------------------------------------------------------------

/**
 * Which model should answer the next turn.
 *
 * A discriminated union rather than a nullable id, because "cloud" is not a
 * model id — it is a different *kind* of source with its own configuration. A
 * plain string would force every consumer to special-case a magic prefix.
 */
export type ModelSelection =
  | { readonly kind: 'local'; readonly modelId: string }
  | { readonly kind: 'cloud' }

export interface EngineStoreState {
  status: 'idle' | 'loading' | 'ready' | 'generating' | 'error'
  modelId: string | null
  loadProgress: number
  error: string | null
  gpuActive: boolean
  gpuFallbackReason: string | null
  activeDevices: string[]
  /** Live text of the in-flight generation. */
  streamingText: string
  streamingReasoning: string
  /** Non-null while generating; calling it stops the stream. */
  stopRequested: boolean
  tokensPerSecond: number
  /** Timing report for the last completed generation, for the debug sheet. */
  lastTimings: GenerationTimings | null

  setLoading: (modelId: string) => void
  /**
   * Load a downloaded model into the inference engine.
   *
   * This is the step that was missing entirely: the app could download a model
   * and it could generate text, but nothing ever called `engine.load()`, so
   * `readyModelId` stayed null and the chat screen permanently reported
   * "还没有加载模型" no matter how many models the user downloaded.
   *
   * Resolves when the engine reports ready. Rejects (through `status: 'error'`)
   * with a Chinese message when the load fails — most commonly not enough free
   * memory for the weights.
   */
  loadModel: (modelId: string) => Promise<void>
  /**
   * Switch the active model, local OR cloud, from one call.
   *
   * This is the entry point the chat screen's model picker uses. It exists so
   * that "which model answers me" is one decision with one code path, rather
   * than a local branch and a cloud branch the UI has to know about.
   *
   * Switching is IMMEDIATE by design: the engine holds exactly one context
   * (`InferenceEngine` documents that loading a second OOM-kills the process),
   * so accepting a new selection means unloading the old one. The picker shows
   * a loading state while that happens — a few seconds for an 8B model.
   *
   * @param selection `{kind:'local', modelId}` or `{kind:'cloud'}`.
   */
  activateModel: (selection: ModelSelection) => Promise<void>
  /** Release the loaded model and free its memory. */
  unloadModel: () => Promise<void>
  setLoadProgress: (pct: number) => void
  setLoaded: (info: LoadedModelInfo) => void
  setUnloaded: () => void
  setError: (message: string) => void
  beginStream: () => void
  appendStream: (text: string, reasoning?: string) => void
  endStream: (tokensPerSecond: number, timings?: GenerationTimings | null) => void
  requestStop: () => void
  clearStopRequest: () => void

  /**
   * Run one generation turn against the loaded model.
   *
   * Reads the transcript, forwards it to whichever engine
   * `engineFactory.activeEngine()` reports (local GGUF or remote API), streams
   * deltas into `streamingText`, and commits the finished turn to `messages`
   * exactly once. Failures are translated into actionable text rather than
   * surfacing a native stack.
   *
   * Requires an engine to have been installed via `engineFactory.setBackend()`
   * plus a `load()`. With none installed it reports that plainly instead of
   * silently doing nothing.
   */
  generate: () => Promise<void>
  stop: () => Promise<void>
}

export const useEngineStore = create<EngineStoreState>((set) => ({
  status: 'idle',
  modelId: null,
  loadProgress: 0,
  error: null,
  gpuActive: false,
  gpuFallbackReason: null,
  activeDevices: [],
  streamingText: '',
  streamingReasoning: '',
  stopRequested: false,
  tokensPerSecond: 0,
  lastTimings: null,

  setLoading: (modelId) =>
    set({
      status: 'loading',
      modelId,
      loadProgress: 0,
      error: null,
    }),

  setLoadProgress: (pct) => set({ loadProgress: pct }),

  setLoaded: (info) =>
    set({
      status: 'ready',
      modelId: info.modelId,
      loadProgress: 100,
      error: null,
      gpuActive: info.gpuActive,
      gpuFallbackReason: info.gpuFallbackReason,
      activeDevices: info.activeDevices,
    }),

  setUnloaded: () =>
    set({
      status: 'idle',
      modelId: null,
      loadProgress: 0,
      error: null,
      gpuActive: false,
      gpuFallbackReason: null,
      activeDevices: [],
      streamingText: '',
      streamingReasoning: '',
    }),

  setError: (message) => set({ status: 'error', error: message, loadProgress: 0 }),

  beginStream: () =>
    set({ status: 'generating', streamingText: '', streamingReasoning: '', stopRequested: false }),

  appendStream: (text, reasoning) =>
    set((s) => ({
      streamingText: text,
      streamingReasoning: reasoning ?? s.streamingReasoning,
    })),

  endStream: (tokensPerSecond, timings) =>
    set({
      status: 'ready',
      streamingText: '',
      streamingReasoning: '',
      stopRequested: false,
      tokensPerSecond,
      lastTimings: timings ?? null,
    }),

  requestStop: () => set({ stopRequested: true }),
  clearStopRequest: () => set({ stopRequested: false }),

  loadModel: async (modelId) => {
    await loadLocalModel(set, modelId)
  },

  activateModel: async (selection) => {
    // Tear down whatever is resident first. Doing this before deciding the next
    // backend matters: a cloud switch must release the local context (hundreds
    // of MB to several GB) rather than leave it pinned behind an unused engine.
    const current = activeEngine()
    if (current) {
      try {
        await current.unload()
      } catch {
        // A failed unload must not block the switch; the engine factory will
        // construct a fresh one below regardless.
      }
    }

    if (selection.kind === 'cloud') {
      const provider = useSettingsStore.getState().remoteProvider
      set({ status: 'loading', modelId: `cloud:${provider.model}`, loadProgress: 0, error: null })

      // Record the intent BEFORE probing. The user has explicitly asked for the
      // cloud; if the endpoint turns out to be unreachable, the honest outcome
      // is "cloud selected, connection failed" — not silently staying on local,
      // which is exactly the bug that was reported ("I switched to cloud and it
      // still used the local model").
      useSettingsStore.getState().setBackend('remote')

      // ⚠️ DO NOT clear `lastLoadedModelId` here.
      //
      // An earlier revision did, reasoning that a cloud model has no local file
      // to restore. That broke the return trip: with the id gone, switching back
      // to 本地 had nothing to reload and the user was stranded in cloud mode
      // with an empty engine ("切到本地模型且不过来了"). The remembered id is
      // precisely what makes the return trip work, and it costs nothing to keep
      // — it is not a claim that a local model is currently resident.
      try {
        const engine = await setBackend({
          kind: 'remote',
          options: { config: provider },
        })
        // Probe the endpoint before declaring success: a wrong key or URL must
        // surface here, where the user just acted, not on their first message.
        const info = await engine.load({} as never)
        set({
          status: 'ready',
          loadProgress: 100,
          error: null,
          gpuActive: false,
          gpuFallbackReason: null,
          activeDevices: info.activeDevices,
        })
      } catch (error) {
        set({ status: 'error', modelId: null, loadProgress: 0, error: describeEngineError(error) })
      }
      return
    }

    // Local: clear the cloud backend so a stale remote engine cannot answer.
    useSettingsStore.getState().setBackend('local')
    // Inlined rather than delegating to `useEngineStore.getState().loadModel`:
    // referring to the store being defined from inside its own initialiser
    // works at runtime but is a self-reference that breaks the moment the store
    // is split or lazily created. The local path is short enough to repeat.
    await loadLocalModel(set, selection.modelId)
  },

  unloadModel: async () => {
    const engine = activeEngine()
    try {
      // Safe when idle — the contract says so explicitly, which matters here
      // because the UI lets the user unload without checking first.
      await engine?.unload()
    } catch {
      // A failed unload must not leave the UI stuck on "ready" for a model
      // that is no longer resident, so fall through and reset state anyway.
    }
    set({
      status: 'idle',
      modelId: null,
      loadProgress: 0,
      streamingText: '',
      streamingReasoning: '',
      gpuActive: false,
      gpuFallbackReason: null,
      activeDevices: [],
    })
    useModelStore.getState().setLoadedModelId(null)
    // Deliberately NOT clearing `lastLoadedModelId`: unloading is a temporary
    // memory decision ("I want to free RAM"), not a statement that the user no
    // longer wants this model. Clearing it would turn every unload into a
    // forgotten preference and force a manual re-pick on next launch.
  },

  generate: async () => {
    /**
     * Make the active engine agree with the user's chosen backend before
     * sending.
     *
     * This is the fix for a reported defect: the user configured a cloud API
     * and switched to it, returned to the chat, and a local model still
     * answered. The toggle only wrote `settings.backend` — nothing reconciled
     * that with the engine actually installed in the factory, so the stale
     * local engine kept taking every turn.
     *
     * Reconciling here (rather than only at switch time) also covers the boot
     * path, where `lastLoadedModelId` restoration and a cloud preference can
     * race.
     */
    const desired = useSettingsStore.getState().backend
    const installed = activeBackendKind()

    /**
     * Reconcile the installed engine with the user's chosen backend.
     *
     * Both branches SELF-HEAL rather than erroring out. An earlier revision
     * refused with "云端模式已选择，但尚未连接" when the engines disagreed, which
     * left the user stuck: the picker had already recorded their choice, so the
     * only way forward was to switch away and back. Rebuilding here means the
     * first message after a switch simply works.
     */
    /**
     * ⚠️ The condition is "is the engine USABLE", not "does one exist".
     *
     * This used to read installed !== 'remote', which is true whenever a
     * remote engine has been created — but a freshly created engine is
     * installed and NOT loaded, so isReady() is false and generate() fell
     * through to its isReady guard and bailed with "引擎未就绪".
     *
     * Reachable on every app restart: the persisted ackend is 'remote' while
     * the engine factory is empty, so nothing ever called load().
     *
     * Caught by cloudFlow.test.ts, which wires the real store to a real HTTP
     * server — every per-layer test passed while this path was broken.
     */
    if (desired === 'remote' && !(installed === 'remote' && activeEngine()?.isReady())) {
      const provider = useSettingsStore.getState().remoteProvider
      try {
        const engine = await setBackend({
          kind: 'remote',
          options: { config: provider },
        })
        await engine.load({} as never)
        set({ status: 'ready', loadProgress: 100, error: null, activeDevices: ['remote'] })
      } catch (error) {
        set({ status: 'error', error: describeEngineError(error) })
        return
      }
    }

    if (desired === 'local' && installed === 'remote') {
      // Moved back to local: rebuild the local engine from the remembered id.
      const remembered = useSettingsStore.getState().lastLoadedModelId
      if (!remembered) {
        set({ status: 'error', error: '已切回本地模式，请先在输入框左侧选择一个本地模型。' })
        return
      }
      await loadLocalModel(set, remembered)
    }

    const engine = activeEngine()
    if (!engine) {
      set({
        status: 'error',
        error: '没有已加载的模型。请在输入框左侧选择模型。',
      })
      return
    }
    if (!engine.isReady()) {
      set({
        status: 'error',
        error: '模型尚未就绪，请稍候或重新选择模型。',
      })
      return
    }

    // Read the transcript through getState() rather than the closed-over
    // snapshot: `generate` is long-lived and the caller may have appended the
    // user's message in the same tick that started this turn.
    const chat = useChatStore.getState()
    // Sampler settings live in the settings store, not here — `useEngineStore`
    // is created with `set` only (no `get`), and sampling is a global user
    // preference rather than per-turn state.
    const settings = useSettingsStore.getState()
    const sampling = settings.sampling

    const rawHistory = chat.messages
      .filter((m) => m.content.trim().length > 0)
      .map((m) => ({ role: m.role, content: m.content }))

    /**
     * Prepend the system prompt.
     *
     * THIS IS THE PERSONA MECHANISM, and its absence was a real defect: the
     * app asked the model to play a character while sending only the model
     * vendor's default preamble ("You are a helpful assistant"). The result on
     * device was a model that ignored every "act as X" instruction in the
     * message history — which reads as "the small model is too dumb", when the
     * actual cause was that nothing ever told it who to be.
     *
     * Order matters and is deliberate:
     *
     *   1. The character card's own fields (name/description/personality/
     *      scenario), when a character is selected — a card carries far more
     *      detail than a one-line prompt and is what the user deliberately
     *      imported.
     *   2. The user's global system prompt appended AFTER it, so it acts as
     *      additional instructions ("keep replies short") rather than being
     *      overwritten by the card.
     *
     * When neither is set we send no system message at all rather than an
     * empty one: llama.cpp then applies the template baked into the GGUF, which
     * is the model author's intent.
     */
    /**
     * Fold in the rolling summary, if this conversation has one.
     *
     * The summary is the answer to "the window trimmed away the start of this
     * conversation and the model forgot". `buildSystemPrompt` is synchronous,
     * so the await has to live here in the caller rather than inside it.
     *
     * Awaited rather than fire-and-forget: a turn generated WITHOUT the summary
     * is exactly the amnesia the feature exists to prevent.
     *
     * Failure is not fatal — a missing summary degrades to the previous
     * behaviour, which is a shorter memory rather than a broken turn.
     */
    let summaryText = ""
    try {
      summaryText = (await getSummaryForPrompt(chat.activeConversationId ?? "")) ?? ""
    } catch {
      summaryText = ""
    }

    const baseSystemText = buildSystemPrompt(
      chat,
      settings,
      settings.contextConfig.contextLength,
    )
    const systemText = summaryText
      ? baseSystemText
        ? `${baseSystemText}${"\n\n"}${summaryText}`
        : summaryText
      : baseSystemText
    const systemMessages: ChatMessage[] = systemText
      ? [{ role: 'system', content: systemText }]
      : []

    if (rawHistory.filter((m) => m.role !== 'system').length === 0) {
      set({ status: 'error', error: '没有可发送的内容。' })
      return
    }

    /**
     * Fit the prompt inside the model's context window.
     *
     * Previously EVERY message was sent with no trimming at all. Past the window
     * — which the 4096-token default reaches after roughly 20 exchanges —
     * llama.cpp either refuses the prompt or silently drops the oldest tokens,
     * so the model loses the beginning of the conversation with no indication.
     * The persona sits at the very start, so the visible symptom was a character
     * quietly breaking partway through a long chat.
     *
     * `trimToContext` always keeps the system prompt, always keeps the newest
     * turns, and drops whole older turns from the front. See its module doc for
     * why the front (KV-cache prefix validity) and why whole turns (chat
     * template alternation).
     */
    const trimmed = trimToContext(systemMessages, rawHistory, {
      contextLength: settings.contextConfig.contextLength,
    })
    const history = trimmed.messages

    if (trimmed.trimmed) {
      // Kept in the log rather than silently applied: a shortened memory is the
      // explanation for "why did it forget what I said", and without a trace
      // that question has no answer.
      console.log(
        `[context] dropped ${trimmed.droppedCount} older message(s); prompt ~${trimmed.promptTokens} tokens`,
      )
    }

    set({
      status: 'generating',
      streamingText: '',
      streamingReasoning: '',
      stopRequested: false,
      error: null,
    })

    try {
      const outcome = await engine.completion(
        history,
        {
          sampling,
          enableThinking: false,
          thinkingBudgetTokens: null,
          jsonSchema: null,
        },
        (chunk) => {
          /**
           * Publish the in-flight text.
           *
           * Verified against a real HTTP server (`cloudFlow.test.ts`): each
           * token produces its own store update, so the UI re-renders
           * progressively rather than showing the whole reply at once. This must
           * stay a plain `set` on a dedicated field — batching here, or writing
           * into `messages`, would reintroduce the all-at-once behaviour.
           */
          set({ streamingText: chunk.accumulated, streamingReasoning: chunk.reasoning ?? '' })
        },
      )

      const text = outcome.text

      /**
       * Roll the memory forward, AFTER this turn is committed.
       *
       * Deliberately not awaited. Summarising is a second generation of its own,
       * so awaiting it would keep the UI in a generating state for as long as a
       * whole extra reply takes — for a background housekeeping task the user
       * never asked for. `maybeSummarize` swallows its own failures and its own
       * trigger condition decides whether any work happens at all.
       */
      void maybeSummarize(useChatStore.getState().activeConversationId ?? '')

      set({
        status: 'ready',
        streamingText: '',
        streamingReasoning: '',
        stopRequested: false,
        tokensPerSecond: outcome.timings.tokensPerSecond,
        lastTimings: outcome.timings,
      })

      // Commit the completed turn as a real message. Deltas deliberately never
      // touched `messages` during streaming (see the module header), so this is
      // the single write for the whole turn.
      if (text.trim().length > 0) {
        /**
         * ── Where a regenerated reply lands ────────────────────────────────────
         *
         * `regenerateFrom`/`regenerateSwipe` set `pendingSwipeTargetId` before
         * calling us. When it is set, this generation is a RE-ROLL of that
         * turn, and its text must be APPENDED AS A VERSION of that message.
         *
         * Appending a sibling instead would put two assistant messages in a row
         * answering one user turn: wrong for the model (the chat template
         * alternates user/assistant) and wrong on screen (two bubbles, with an
         * arrow row on only one of them, and the version list never growing).
         *
         * ⚠️ The target id is taken from the marker, NOT inferred from "the last
         * message has a version list". A first-time regeneration leaves exactly
         * ONE version after seeding, so a `length > 1` test silently fails and
         * the sibling bug returns.
         *
         * The marker is cleared unconditionally below, so a later ordinary turn
         * appends normally even if this generation produced nothing.
         */
        const live = useChatStore.getState()
        const target = pendingSwipeTargetId
        pendingSwipeTargetId = null
        const seeded = target ? live.messages.find((m) => m.id === target) : undefined

        if (seeded && seeded.role === 'assistant') {
          const updated = appendSwipe(seeded, text)
          live.replaceMessage(updated)
          void saveMessageSwipes(updated.id, updated.swipes, updated.swipeIndex)
        } else {
          live.appendMessage({
            id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            conversationId: chat.activeConversationId ?? '',
            role: 'assistant',
            content: text,
            reasoning: outcome.reasoning,
            createdAt: Date.now(),
            modelId: useEngineStore.getState().modelId,
            swipeIndex: 0,
            swipes: [text],
          })
        }
      }
    } catch (error) {
      set({
        status: 'error',
        streamingText: '',
        streamingReasoning: '',
        stopRequested: false,
        error: describeEngineError(error),
      })
    }
  },

  stop: async () => {
    const engine = activeEngine()
    set({ stopRequested: true })
    if (!engine) return
    try {
      // Resolves when the native/HTTP call actually returns, so the caller can
      // rely on "stopped" meaning stopped rather than merely requested.
      await engine.stop()
    } catch {
      // The engine may already have finished; the store state is the authority.
    } finally {
      set({ stopRequested: false })
    }
  },
}))

// ---------------------------------------------------------------------------
// Model store
// ---------------------------------------------------------------------------

export interface ActiveDownload {
  modelId: string
  partIndex: number
  /** 0..1 overall. */
  progress: number
  bytesWritten: number
  totalBytes: number
  speedBps: number
  etaSeconds: number | null
  state: ModelRecord['state']
  error: string | null
}

export interface ModelStoreState {
  catalog: ModelDescriptor[]
  records: Record<string, ModelRecord>
  downloads: Record<string, ActiveDownload>
  memory: MemorySnapshot | null
  loadedModelId: string | null

  /**
   * The model the user can actually chat with right now.
   *
   * Derived from `records` rather than tracked separately, but exposed as a
   * stored field because it is read on every Chat render and by the
   * boot-time routing decision; recomputing it by scanning `records` in a
   * selector would allocate a new array per token during streaming.
   *
   * NOTE ON TRUTH: this has no access to the filesystem or SQLite. It is
   * authoritative only once `setRecords`/`upsertRecord` have been fed by the
   * boot reconcile pass (roadmap Phase 2, "应用启动时 reconcile"). Until that
   * exists, `records` stays empty and this stays null — which is exactly why
   * onboarding asks the user to pick a model instead of trusting a flag.
   */
  readyModelId: string | null

  setCatalog: (catalog: ModelDescriptor[]) => void
  setRecords: (records: ModelRecord[]) => void
  upsertRecord: (record: ModelRecord) => void
  setDownloadProgress: (modelId: string, patch: Partial<ActiveDownload>) => void
  clearDownload: (modelId: string) => void
  setMemory: (snapshot: MemorySnapshot) => void
  setLoadedModelId: (id: string | null) => void

  /** Begin (or resume) a download. Wired to the downloader in Phase 2. */
  startDownload: (modelId: string) => Promise<void>
  pauseDownload: (modelId: string) => Promise<void>
  /** Delete a downloaded model and its partial data. */
  removeModel: (modelId: string) => Promise<void>

  /**
   * Re-adopt models that are already on disk.
   *
   * Download state lived only in memory, so every restart showed completed
   * models as "未下载" while their files sat in `files/models/` — the user
   * could not load them and had no way to find out why. This scans the models
   * directory and marks any catalogue entry whose file is present and
   * the right size as `ready`.
   *
   * Called once at startup. Safe to call repeatedly.
   */
  reconcileFromDisk: () => Promise<void>
}

/**
 * `ModelRecord` for a model that is downloading right now.
 *
 * `bytesOnDisk` starts at 0 and `localPath` is null: nothing is on disk yet.
 * `startedAt` is used for both timestamps so the "stale download" sweep has a
 * sane anchor even for a record that never completed a part.
 */
function downloadRecord(modelId: string, existing: ModelRecord | undefined): ModelRecord {
  const now = Date.now()
  return {
    id: modelId,
    state: 'downloading',
    completedParts: existing?.completedParts ?? 0,
    bytesOnDisk: existing?.bytesOnDisk ?? 0,
    localPath: null,
    shardPaths: [],
    lastError: null,
    updatedAt: now,
    createdAt: existing?.createdAt ?? now,
  }
}

export const useModelStore = create<ModelStoreState>((set) => ({
  catalog: [],
  records: {},
  downloads: {},
  memory: null,
  loadedModelId: null,
  readyModelId: null,

  setCatalog: (catalog) => set({ catalog }),

  setRecords: (records) =>
    set({
      records: Object.fromEntries(records.map((r) => [r.id, r])),
      readyModelId: pickReady(records),
    }),

  upsertRecord: (record) =>
    set((s) => {
      const records = { ...s.records, [record.id]: record }
      return { records, readyModelId: pickReady(Object.values(records)) }
    }),

  setDownloadProgress: (modelId, patch) =>
    set((s) => {
      const existing = s.downloads[modelId]
      const base: ActiveDownload = existing ?? {
        modelId,
        partIndex: 0,
        progress: 0,
        bytesWritten: 0,
        totalBytes: 0,
        speedBps: 0,
        etaSeconds: null,
        state: 'downloading',
        error: null,
      }
      return { downloads: { ...s.downloads, [modelId]: { ...base, ...patch } } }
    }),

  clearDownload: (modelId) =>
    set((s) => {
      const next = { ...s.downloads }
      delete next[modelId]
      return { downloads: next }
    }),

  setMemory: (snapshot) => set({ memory: snapshot }),
  setLoadedModelId: (id) => set({ loadedModelId: id }),

  /**
   * ── The downloader seam ────────────────────────────────────────────────────
   *
   * These three are the ONLY members in this store that must eventually touch
   * the outside world (network, disk, SQLite). They are implemented here as
   * state transitions the UI can drive, deliberately WITHOUT constructing a
   * `BackgroundModelDownloader`:
   *
   *   - The downloader's native module cannot be exercised on this machine
   *     (no Android SDK, no device), so any wiring written now would be
   *     unverifiable — and this project's stated rule is that unverifiable
   *     code is worse than an honest gap (see docs/roadmap.md Phase 2).
   *   - `BackgroundModelDownloader` needs `DownloaderDeps` (paths, DB handle)
   *     that the app does not construct yet, so a call site written today
   *     would not compile even if a device were present.
   *
   * What they DO guarantee is the part the onboarding screen depends on: the
   * record moves to `downloading`, so the UI reflects the tap instead of
   * silently doing nothing, and `readyModelId` never claims a model is usable
   * before its bytes have been verified.
   */
  startDownload: async (modelId) => {
    set((s) => ({
      records: { ...s.records, [modelId]: downloadRecord(modelId, s.records[modelId]) },
      downloads: {
        ...s.downloads,
        [modelId]: {
          modelId,
          partIndex: 0,
          progress: 0,
          bytesWritten: 0,
          totalBytes: 0,
          speedBps: 0,
          etaSeconds: null,
          state: 'downloading' as const,
          error: null,
        },
      },
    }))

    // Dynamic import: `downloaderFactory` pulls in `BackgroundModelDownloader`,
    // which imports `react-native`. A static import would make this whole store
    // unloadable in Node, which is exactly what kept it untested before.
    //
    // The import itself can fail on a host without React Native (Node tests,
    // web). That must degrade to "downloads unavailable" rather than an
    // unhandled rejection — the UI needs to explain why, not blank out.
    let downloaderModule: typeof import('@/data/download/downloaderFactory') | null = null
    try {
      downloaderModule = await import('@/data/download/downloaderFactory')
    } catch {
      downloaderModule = null
    }

    const failWith = (message: string) => {
      set((s) => ({
        records: {
          ...s.records,
          [modelId]: { ...s.records[modelId], state: 'error' as const, updatedAt: Date.now() },
        },
        downloads: {
          ...s.downloads,
          [modelId]: { ...s.downloads[modelId], state: 'error' as const, error: message },
        },
      }))
    }

    if (!downloaderModule) {
      failWith('当前环境不支持下载（需要 Android 设备）。')
      return
    }

    const downloader = await downloaderModule.getDownloader()
    if (!downloader) {
      failWith(downloaderModule.downloaderUnavailableReason() ?? '下载器不可用。')
      return
    }

    const descriptor = findLineModel(modelId)
    if (!descriptor) {
      failWith('模型清单中不存在该条目。')
      return
    }

    // Progress is reported through events rather than a promise so the caller
    // can render a multi-GB transfer without awaiting it.
    downloader.subscribe(modelId, {
      onProgress: (progress) => {
        const pct = progress.totalBytes > 0 ? progress.bytesWritten / progress.totalBytes : 0
        set((s) => ({
          downloads: {
            ...s.downloads,
            [modelId]: {
              ...s.downloads[modelId],
              progress: pct,
              bytesWritten: progress.bytesWritten,
              totalBytes: progress.totalBytes,
              speedBps: progress.speedBps ?? 0,
              etaSeconds: progress.etaSeconds ?? null,
              state: 'downloading',
            },
          },
        }))
      },
      onComplete: (result) => {
        set((s) => ({
          records: {
            ...s.records,
            [modelId]: {
              ...s.records[modelId],
              state: 'ready' as const,
              bytesOnDisk: result.totalBytes,
              localPath: result.primaryPath,
              shardPaths: result.shardPaths ?? [],
              updatedAt: Date.now(),
            },
          },
          downloads: {
            ...s.downloads,
            [modelId]: { ...s.downloads[modelId], state: 'ready', progress: 1 },
          },
        }))
      },
      onError: (error) => {
        set((s) => ({
          records: {
            ...s.records,
            [modelId]: { ...s.records[modelId], state: 'error' as const, updatedAt: Date.now() },
          },
          downloads: {
            ...s.downloads,
            [modelId]: { ...s.downloads[modelId], state: 'error', error: error.message },
          },
        }))
      },
    })

    try {
      await downloader.start(descriptor, { resume: true })
    } catch (error) {
      set((s) => ({
        records: {
          ...s.records,
          [modelId]: { ...s.records[modelId], state: 'error' as const, updatedAt: Date.now() },
        },
        downloads: {
          ...s.downloads,
          [modelId]: {
            ...s.downloads[modelId],
            state: 'error',
            error: error instanceof Error ? error.message : String(error),
          },
        },
      }))
    }
  },

  pauseDownload: async (modelId) =>
    set((s) => {
      const existing = s.records[modelId]
      if (!existing) return {}
      return {
        records: {
          ...s.records,
          [modelId]: { ...existing, state: 'paused' as const, updatedAt: Date.now() },
        },
      }
    }),

  removeModel: async (modelId) =>
    set((s) => {
      const records = { ...s.records }
      delete records[modelId]
      const downloads = { ...s.downloads }
      delete downloads[modelId]
      return {
        records,
        downloads,
        readyModelId: pickReady(Object.values(records)),
      }
    }),

  /**
   * Re-adopt completed downloads from disk.
   *
   * The downloader is authoritative while the app runs, but its record store is
   * in memory (`downloaderFactory` has no SQLite writer yet). Without this pass
   * every relaunch reports finished models as "未下载", which is what the device
   * showed: 469 MB present on disk, UI insisting nothing was downloaded.
   *
   * A file counts as complete when its size matches the catalogue exactly. That
   * is the same standard the downloader's own integrity check uses, and for a
   * single HTTP GET of a static object a truncated body is the realistic
   * failure — so a size match is meaningful evidence, not a shortcut.
   *
   * Failure is silent by design: reconcile is a convenience, and a device
   * without the native module must still start normally.
   */
  reconcileFromDisk: async () => {
    let entries: Array<{ name: string; path: string; isDirectory: boolean; size: number }>
    try {
      const { getPhoneLlmSystem } = await import('@/specs/phoneLlmSystem.ts')
      const system = getPhoneLlmSystem() as unknown as {
        listDir?: (p: string) => Promise<typeof entries>
      } | null
      if (!system || typeof system.listDir !== 'function') return
      entries = await system.listDir('models')
    } catch {
      return
    }

    // Decide what is complete OUTSIDE the state update: the inner listing is
    // async, and doing I/O inside a `set` callback is both illegal-looking and
    // a way to run it more than once under React's strict mode.
    const adopted: ModelRecord[] = []
    for (const dir of entries) {
      if (!dir.isDirectory) continue

      // Directory name IS the model id — `BackgroundModelDownloader` creates
      // `models/<modelId>/`. An unrecognised directory is left alone rather
      // than guessed at.
      const descriptor = findLineModel(dir.name)
      if (!descriptor) continue

      const files = await listModelFiles(dir.name)
      if (files.length === 0) continue

      // Completeness = the downloaded bytes match the catalogue exactly. Same
      // standard the downloader's own integrity check uses; for a single HTTP
      // GET of a static object a truncated body is the realistic failure, so a
      // size match is real evidence rather than a shortcut.
      //
      // The file NAME is deliberately not asserted: the download library writes
      // whatever it resolves from the URL (observed as `repo` for ModelScope's
      // `/repo?...` endpoint), so matching on a predicted name would reject
      // perfectly good downloads.
      const total = files.reduce((sum, f) => sum + f.size, 0)
      if (total !== descriptor.sizeBytes) continue

      const primary = files.slice().sort((a, b) => b.size - a.size)[0]!
      adopted.push({
        id: dir.name,
        state: 'ready',
        bytesOnDisk: total,
        localPath: `file://${primary.path}`,
        shardPaths: [],
        lastError: null,
        updatedAt: Date.now(),
      })
    }

    if (adopted.length === 0) return

    set((s) => {
      const records = { ...s.records }
      for (const record of adopted) {
        // Never clobber a live download or a record the user is working with.
        const existing = records[record.id]
        if (existing && existing.state !== 'error' && existing.state !== 'not-downloaded') {
          continue
        }
        records[record.id] = record
      }
      return { records, readyModelId: pickReady(Object.values(records)) }
    })
  },
}))

/** Immediate files inside `models/<id>/`, or an empty list on any failure. */
async function listModelFiles(
  modelId: string,
): Promise<Array<{ path: string; size: number }>> {
  try {
    const { getPhoneLlmSystem } = await import('@/specs/phoneLlmSystem.ts')
    const system = getPhoneLlmSystem() as unknown as {
      listDir?: (p: string) => Promise<
        Array<{ path: string; isDirectory: boolean; size: number }>
      >
    } | null
    if (!system || typeof system.listDir !== 'function') return []
    const entries = await system.listDir(`models/${modelId}`)
    return entries
      .filter((e) => !e.isDirectory && Number.isFinite(e.size) && e.size > 0)
      .map((e) => ({ path: e.path, size: Number(e.size) }))
  } catch {
    return []
  }
}

/**
 * Which of these records can actually be chatted with?
 *
 * Only `ready`. A `downloading`/`paused`/`verifying` record has no complete,
 * digest-checked file — and for the abliterated line the digest IS the only
 * integrity anchor (its URL resolves through a movable `master` branch), so
 * treating a partial download as usable would defeat the one check that makes
 * that line safe to offer at all.
 *
 * Ties are broken by newest `updatedAt` so that, after the user downloads a
 * second model, the most recent choice wins rather than an arbitrary one.
 */
function pickReady(records: readonly ModelRecord[]): string | null {
  let best: ModelRecord | null = null
  for (const r of records) {
    if (r.state !== 'ready') continue
    if (!best || r.updatedAt > best.updatedAt) best = r
  }
  return best?.id ?? null
}

/** True once any model is `ready` — the boot-time routing predicate. */
export function hasUsableModel(state: { readyModelId: string | null }): boolean {
  return state.readyModelId != null
}

/**
 * Load a downloaded local model into the engine.
 *
 * Extracted from the store's `loadModel` so `activateModel` (the chat model
 * picker's entry point) can reuse it without the store referring to itself.
 *
 * `set` is passed in because this runs outside the store's initialiser, where
 * the setter is not otherwise reachable.
 */
async function loadLocalModel(
  set: (partial: Partial<EngineStoreState>) => void,
  modelId: string,
): Promise<void> {
  // Resolve the descriptor from the catalogue, and the on-disk record for the
  // actual path. Both are needed: the catalogue knows layerCount (which
  // llama.rn needs to clamp gpu layers) and the record knows where the bytes
  // actually landed.
  const descriptor = findLineModel(modelId)
  if (!descriptor) {
    set({ status: 'error', error: `模型清单中找不到「${modelId}」。` })
    return
  }

  const record = useModelStore.getState().records[modelId]
  if (!record || record.state !== 'ready' || !record.localPath) {
    set({ status: 'error', error: '该模型尚未下载完成，请先下载。' })
    return
  }

  const contextConfig = useSettingsStore.getState().contextConfig
  set({ status: 'loading', modelId, loadProgress: 0, error: null })

  try {
    // `setBackend` is idempotent for an already-active local engine and
    // constructs one on first use. Going through it (rather than `engine.load`
    // directly) is what keeps the local/remote switch authoritative.
    const engine = activeEngine() ?? (await setBackend({ kind: 'local' }))

    const info = await engine.load(
      {
        modelId,
        // llama.rn wants a bare absolute path; the record stores a `file://`
        // URI because that is what the downloader resolves to. Strip the
        // scheme — passing `file://` through yields a confusing
        // "failed to open model" from deep inside llama.cpp.
        modelPath: record.localPath.replace(/^file:\/\//, ''),
        contextConfig,
        modelLayerCount: descriptor.layerCount,
      },
      (pct) => set({ loadProgress: Math.round(pct) }),
    )

    set({
      status: 'ready',
      modelId,
      loadProgress: 100,
      error: null,
      gpuActive: info.gpuActive,
      gpuFallbackReason: info.gpuFallbackReason,
      activeDevices: info.activeDevices,
    })
    useModelStore.getState().setLoadedModelId(modelId)
    // Remember the choice so a relaunch can restore it without the user
    // hunting for the model again. Observed on device: after every restart the
    // chat screen demanded a manual reload.
    useSettingsStore.getState().setLastLoadedModelId(modelId)
  } catch (error) {
    set({
      status: 'error',
      modelId: null,
      loadProgress: 0,
      error: describeEngineError(error),
    })
  }
}

/**
 * Compose the system message for one turn.
 *
 * Returns an empty string when there is nothing to say, and the caller then
 * omits the system message entirely — sending `{role:'system', content:''}`
 * is not equivalent, because some chat templates render an empty system block
 * and others skip it, so the same input produces different prompts across
 * models.
 *
 * This delegates to `buildPrompt`, which is the full SillyTavern-grade
 * assembler (world info with all 8 insertion positions and keyword triggers,
 * dialogue examples, author's note, prompt_order). It previously assembled a
 * hand-rolled five-line summary here and, as a direct consequence, an imported
 * card's `character_book` was silently dropped — the world info never reached
 * the model at all.
 *
 * ⚠️ `buildPrompt` returns `{systemPrompt, messages}`, but this function's
 * signature returns only `string`. That is a real lossy boundary and it is
 * handled deliberately rather than papered over:
 *
 *   - Everything that lands in `systemPrompt` (main / worldInfoBefore /
 *     charDescription / charPersonality / scenario / worldInfoAfter /
 *     dialogueExamples / jailbreak) is returned and sent.
 *   - World-info entries positioned at `AtDepth`, plus the author's note, are
 *     injected as extra entries INSIDE `messages`. Those cannot be expressed
 *     as one string without inventing a fake chat turn, so they are dropped
 *     here. `adapter.ts` therefore passes no `authorsNote`, and `AtDepth`
 *     entries are a documented, known gap — closing it needs the caller to
 *     consume `BuiltPrompt.messages` directly instead of calling this.
 *
 * `contextLength` is accepted because the world-info token budget is a
 * percentage of the window; without it the budget defaults to 0 and a large
 * lorebook would be budget-starved.
 */
export function buildSystemPrompt(
  chat: { characters: CharacterRecord[]; activeCharacterId: string | null },
  settings: { systemPrompt: string },
  contextLength = DEFAULT_CONTEXT_CONFIG.contextLength,
): string {
  const character = chat.activeCharacterId
    ? chat.characters.find((c) => c.id === chat.activeCharacterId)
    : null

  // Conversation history is intentionally NOT passed: the caller already owns
  // history assembly and trims it with `trimToContext` immediately afterwards,
  // so feeding the same transcript in here would only duplicate that work and
  // risk the two disagreeing. What this function contributes is the *static*
  // prefix — which is exactly the part that was missing.
  const input = makeAssembleInput({
    character,
    messages: [],
    globalSystemPrompt: settings.systemPrompt,
    contextLength,
  })

  return buildPrompt(input).systemPrompt
}

// ---------------------------------------------------------------------------
// Conversation store
// ---------------------------------------------------------------------------

export interface ChatStoreState {
  conversations: Conversation[]
  activeConversationId: string | null
  messages: Message[]
  /**
   * Transcripts parked by conversation id.
   *
   * `messages` is the transcript on screen; this is where the previous one goes
   * when you switch away, so returning restores it without a database round
   * trip. Without it, switching conversations destroyed the history you left
   * (see `setActiveConversation`).
   *
   * This is a CACHE in front of SQLite, not the source of truth: every write is
   * mirrored to the database via `saveTranscript`, and `restoreConversations()`
   * rebuilds the map at boot. Before persistence existed this was the only copy,
   * which is why a cold start used to begin with an empty conversation list.
   */
  transcripts: Record<string, Message[]>
  /**
   * Imported character cards.
   *
   * Empty until card import lands (Phase 3). `CharacterScreen` renders its
   * empty state from this, so it is a real field rather than a placeholder —
   * it simply has no writer yet.
   */
  characters: CharacterRecord[]
  /** Card selected for the active conversation. */
  activeCharacterId: string | null
  /** True while an older page is loading, to drive the list spinner. */
  loadingMore: boolean
  hasMore: boolean

  setConversations: (list: Conversation[]) => void
  setActiveConversation: (id: string | null) => void
  setMessages: (messages: Message[]) => void
  prependMessages: (older: Message[]) => void
  appendMessage: (message: Message) => void
  replaceMessage: (message: Message) => void
  removeMessage: (id: string) => void
  /**
   * Discard an assistant reply and generate a new one for the same prompt.
   *
   * Needed because a local model's output varies run to run and occasionally
   * comes out wrong — a refusal, a repetition loop, a broken character. Without
   * this the only recovery is to retype the message, which also loses the
   * prompt's exact wording.
   *
   * Drops the target assistant message and everything after it, resets the
   * engine context, and regenerates from the user turn that preceded it.
   *
   * ⚠️ The NEW reply is appended to `swipes` rather than replacing `content`
   * in place — see the implementation for why that did NOT change the
   * "drop everything after it" behaviour.
   */
  regenerateFrom: (assistantMessageId: string) => Promise<void>
  /**
   * Move to the next / previous stored version of an assistant reply.
   *
   * ── Why this is separate from `regenerateFrom` ──────────────────────────────
   * Regenerating DISCARDS the visible reply and pays for another one. A user who
   * has already waited out a local model's answer does not want to lose it just
   * to compare — they want to flip between the two. SillyTavern calls these
   * "swipes", and `Message.swipes` / `Message.swipeIndex` were designed for it
   * from the start.
   *
   * Both WRAP, so "previous" on the first version lands on the last. Disabling
   * the arrows at the ends would make the most common case — two versions,
   * sitting on the newer one, wanting the older one — need a hunt for whichever
   * arrow happens to be live.
   *
   * Synchronous and local: nothing is generated, so there is no promise to await
   * and the UI cannot be left showing a spinner.
   */
  nextSwipe: (messageId: string) => void
  prevSwipe: (messageId: string) => void
  /**
   * Append a freshly generated version to a reply's `swipes` and show it.
   *
   * The non-destructive sibling of `regenerateFrom`: existing versions stay in
   * the array and the new one is appended, so the user can flip back to the
   * reply they just replaced.
   */
  regenerateSwipe: (messageId: string) => Promise<void>
  setLoadingMore: (loading: boolean) => void
  setHasMore: (hasMore: boolean) => void
  setCharacters: (characters: CharacterRecord[]) => void
  selectCharacter: (id: string | null) => void
  /**
   * Add or replace a card in the library AND persist it.
   *
   * Replaces an existing entry with the same `id`, or -- when none matches --
   * one with the same card name. Name-matching is what the import flow relies
   * on: `importCard` hashes the file name and a timestamp into the id, so
   * re-importing the same file yields a DIFFERENT id and would otherwise
   * accumulate a duplicate row on every attempt.
   *
   * Fire-and-forget by design. The write is not awaited: dropping a card into
   * the library must not wait on (or fail with) a disk round trip, and
   * `saveCharacter` never rejects. Losing a save is recoverable by
   * re-importing; a frozen import button is not.
   */
  addCharacter: (record: CharacterRecord) => void
  /** Remove a card from the library and from SQLite. */
  removeCharacter: (id: string) => void
  /** Append a user message to the transcript. */
  appendUser: (content: string) => void
  /**
   * Start a fresh conversation and make it active.
   *
   * Returns the new id so the caller can navigate straight into it — the
   * conversation-list screen creates and opens in one gesture, and threading
   * the id back avoids a second store read that could race the update.
   */
  createConversation: (characterId?: string | null) => string
  /** Delete a conversation and its messages. */
  deleteConversation: (id: string) => void
}

/**
 * Monotonic suffix for conversation ids.
 *
 * Two conversations created in the same millisecond (a double-tap on "+")
 * would otherwise collide, and a collision here silently merges two people's
 * chat histories.
 */
let conversationCounter = 0

/**
 * Message id that the NEXT completed generation must extend with a new version,
 * rather than following with a fresh assistant message.
 *
 * Module-scope rather than a store field because it is transient intent, not
 * user-visible state: nothing renders it, it must never be persisted, and a
 * store field would invite a component to read it. `generate` clears it as soon
 * as it consumes it.
 *
 * See `regenerateFrom` for why this cannot be inferred from the transcript.
 */
let pendingSwipeTargetId: string | null = null

export const useChatStore = create<ChatStoreState>((set, get) => ({
  conversations: [],
  activeConversationId: null,
  messages: [],
  transcripts: {},
  characters: [],
  activeCharacterId: null,
  loadingMore: false,
  hasMore: true,

  setConversations: (list) => set({ conversations: list }),

  /**
   * Switch to a conversation.
   *
   * ── The bug this fixes ─────────────────────────────────────────────────────
   * This used to unconditionally do `set({ activeConversationId: id, messages: [] })`.
   * The store holds ONE transcript at a time, so clearing on entry meant every
   * switch destroyed the history you were leaving — and coming back showed an
   * empty chat. On device that read as "I sent a message, left the tab, came
   * back, and my message was gone", which looks like data loss.
   *
   * The transcript is now parked per conversation in `transcripts`, so leaving
   * and returning restores what was there. This is the in-memory half; writing
   * them to SQLite is the next step, and until then a full app restart still
   * loses them (the conversation LIST survives via its own records).
   */
  setActiveConversation: (id) =>
    set((s) => {
      if (id == null) return { activeConversationId: null, messages: [], hasMore: true }

      // Park the outgoing transcript before switching away.
      const parked = s.activeConversationId
        ? { ...s.transcripts, [s.activeConversationId]: s.messages }
        : s.transcripts

      return {
        transcripts: parked,
        activeConversationId: id,
        messages: parked[id] ?? [],
        hasMore: true,
      }
    }),

  setMessages: (messages) => set({ messages }),

  prependMessages: (older) => set((s) => ({ messages: [...older, ...s.messages] })),

  /**
   * Append an assistant/system message to the on-screen transcript.
   *
   * Also written through to the parked copy, because messages is swapped out
   * on every conversation switch — a message that lived only in the on-screen
   * array would be lost the moment the user navigated away.
   */
  appendMessage: (message) => {
    set((s) => {
      const messages = [...s.messages, message]
      const id = s.activeConversationId
      return {
        messages,
        transcripts: id ? { ...s.transcripts, [id]: messages } : s.transcripts,
        conversations: id
          ? s.conversations.map((c) =>
              c.id === id
                ? {
                    ...c,
                    lastMessageAt: message.createdAt,
                    updatedAt: message.createdAt,
                    messageCount: c.messageCount + 1,
                  }
                : c,
            )
          : s.conversations,
      }
    })

    // Persist the assistant turn. This is the write that makes a reply survive a
    // cold start; before it existed, closing the app discarded every reply the
    // user had received.
    const after = get()
    const convo = after.activeConversationId
      ? after.conversations.find((c) => c.id === after.activeConversationId)
      : undefined
    if (convo) void saveTranscript(convo, [message])
  },

  replaceMessage: (message) => {
    set((s) => ({
      messages: s.messages.map((m) => (m.id === message.id ? message : m)),
      // Keep the parked copy in step, or navigating away and back would show
      // the pre-edit text.
      transcripts: s.activeConversationId
        ? {
            ...s.transcripts,
            [s.activeConversationId]: s.messages.map((m) =>
              m.id === message.id ? message : m,
            ),
          }
        : s.transcripts,
    }))
    void saveMessage(message)
  },

  removeMessage: (id) => {
    set((s) => {
      const messages = s.messages.filter((m) => m.id !== id)
      return {
        messages,
        transcripts: s.activeConversationId
          ? { ...s.transcripts, [s.activeConversationId]: messages }
          : s.transcripts,
      }
    })
    void deleteMessageRow(id)
  },

  /**
   * Regenerate an assistant reply.
   *
   * ── How swipes changed this, and how they did not ───────────────────────────
   * The reply being replaced is no longer DESTROYED. Its text is folded into
   * `swipes` first, so the user can arrow back to the answer they just spent
   * thirty seconds waiting for. Before this, "重新生成" was the only recovery
   * from a bad local-model reply, and it was a one-way door.
   *
   * The target message is also no longer deleted from the transcript. It is
   * re-used as the carrier for the new version, which keeps its id, timestamp
   * and any markers attributable to the same turn.
   *
   * ⚠️ What did NOT change: everything AFTER the target is still removed, from
   * screen and from the database. Those later turns answered a conversation
   * whose reply is being replaced, so keeping them would leave the model reading
   * an answer to a question that no longer exists.
   *
   * The two rules do not conflict. A version list belongs to ONE turn — the
   * answer to the preceding user message. "Drop what follows" is about LATER
   * turns. Regenerating turn 1 says nothing about the validity of a reply to
   * turn 2, so turn 1's alternatives are kept while turn 2 is still discarded.
   *
   * The engine context is reset first. A stale KV cache still holds the tokens
   * of the version being replaced, and generating against it produces a reply
   * that continues the OLD one — which looks like nothing happened.
   */
  regenerateFrom: async (assistantMessageId) => {
    const targetIndex = get().messages.findIndex((m) => m.id === assistantMessageId)
    if (targetIndex < 0) return

    const target = get().messages[targetIndex]!

    // Nothing to answer if the regenerated reply is the first message.
    const preceding = get().messages.slice(0, targetIndex)
    if (!preceding.some((m) => m.role === 'user')) {
      set({ status: 'error', error: '这条回复前面没有用户消息，无法重新生成。' })
      return
    }

    /**
     * Freeze the current answer as a version BEFORE regenerating.
     *
     * `generate()` commits its output by APPENDING a message, and its commit
     * path folds that output into the last assistant turn when that turn
     * carries a version list (see `generate`). Seeding here is therefore what
     * preserves the pre-existing answer: it becomes version 1, and the
     * regenerated text arrives as version 2.
     *
     * A message that already has versions keeps every one of them — this only
     * normalises the index/content pairing, it never discards history.
     */
    const seeded = withSwipeIndex({ ...target, swipes: swipesOf(target) }, target.swipeIndex)

    // Remove everything AFTER the target. The target row itself stays, so only
    // these later messages are dropped from the database.
    const removed = get().messages.slice(targetIndex + 1)
    for (const message of removed) void deleteMessageRow(message.id)

    set((s) => {
      const messages = s.messages.slice(0, targetIndex)
      messages.push(seeded)
      const conversation = s.activeConversationId
        ? s.conversations.find((c) => c.id === s.activeConversationId)
        : undefined
      // Keep the list counters honest: they were incremented per appended
      // message, so removing messages must decrement them too. The target is
      // retained, so only the later messages are subtracted.
      const conversations = conversation
        ? s.conversations.map((c) =>
            c.id === conversation.id
              ? {
                  ...c,
                  messageCount: Math.max(0, c.messageCount - removed.length),
                  updatedAt: Date.now(),
                }
              : c,
          )
        : s.conversations
      return {
        messages,
        transcripts: s.activeConversationId
          ? { ...s.transcripts, [s.activeConversationId]: messages }
          : s.transcripts,
        conversations,
      }
    })

    // Persist the seeded versions immediately. Without this, a process death
    // between here and the generation finishing would reload a row whose
    // `swipes_json` is still empty — losing the exact answer the user just
    // asked to keep.
    void saveMessageSwipes(seeded.id, swipesOf(seeded), seeded.swipeIndex)

    /**
     * Record WHERE the next generation's text must land.
     *
     * ⚠️ Inferring this inside `generate` from "the last message has a version
     * list" does NOT work, and the failure is silent: a reply being regenerated
     * for the first time has exactly ONE version after seeding, so a
     * `length > 1` test is false, `generate` appends a sibling, and the user
     * gets two bubbles for one turn with the version list never growing. The
     * intent has to be stated explicitly by the code that has it.
     *
     * Consumed (and cleared) by `generate`, so a later ordinary turn appends
     * normally.
     */
    pendingSwipeTargetId = seeded.id

    // Drop the cached prefix; see the doc comment.
    try {
      await activeEngine()?.resetContext()
    } catch {
      // A failed reset must not block the regeneration — the worst case is a
      // slower turn, not a broken one.
    }

    /**
     * `generate` lives on the ENGINE store, not this one.
     *
     * Calling `get().generate()` here was wrong: this store has no such field,
     * so the call threw and the button silently did nothing. Referencing the
     * engine store explicitly is the fix, and it is also the more honest
     * expression — regeneration is an engine operation triggered from the chat
     * surface.
     *
     * `generate` folds its output into the last assistant message when that
     * message has a version list, which is how the seeded row above receives
     * the new version instead of gaining a sibling message.
     */
    await useEngineStore.getState().generate()
  },

  /**
   * Show the next / previous version of a reply.
   *
   * Both write through `replaceMessage`, so `content`, `swipes`, `swipeIndex`
   * and the parked transcript copy move together. The invariant
   * `content === swipes[swipeIndex]` is enforced by `withSwipeIndex`, and the
   * persist is a single narrow UPDATE, so a process death cannot leave a row
   * whose text and index disagree.
   *
   * A no-op when the message is missing or has one version: the arrows are only
   * rendered for `swipes.length > 1`, but a screen reader can still reach them,
   * and rewriting an identical message would emit a pointless DB write per tap.
   */
  nextSwipe: (messageId) => {
    const message = get().messages.find((m) => m.id === messageId)
    if (!message || swipesOf(message).length <= 1) return
    const next = stepSwipe(message, 1)
    get().replaceMessage(next)
    if (next.content !== message.content) {
      void saveMessageSwipes(next.id, next.swipes, next.swipeIndex)
    }
  },

  prevSwipe: (messageId) => {
    const message = get().messages.find((m) => m.id === messageId)
    if (!message || swipesOf(message).length <= 1) return
    const prev = stepSwipe(message, -1)
    get().replaceMessage(prev)
    if (prev.content !== message.content) {
      void saveMessageSwipes(prev.id, prev.swipes, prev.swipeIndex)
    }
  },

  /**
   * Ask the model for one more version of an existing reply.
   *
   * This is the arrow row's "new version" action, and it is the same operation
   * `regenerateFrom` performs — so it DELEGATES rather than duplicating the
   * engine reset, the context seeding, and the history trim. Two implementations
   * of "regenerate" would drift, and the drift would show up as one entry point
   * silently losing versions the other keeps.
   *
   * Refuses a non-assistant message: there is nothing to have alternatives to.
   */
  regenerateSwipe: async (messageId) => {
    const message = get().messages.find((m) => m.id === messageId)
    if (!message || message.role !== 'assistant') return
    await get().regenerateFrom(messageId)
  },

  setLoadingMore: (loading) => set({ loadingMore: loading }),
  setHasMore: (hasMore) => set({ hasMore }),

  setCharacters: (characters) => set({ characters }),

  /**
   * Add or replace a card, in the store and in SQLite.
   *
   * Both halves matter and they must agree. Updating only memory is the bug
   * this replaces: the card looked imported, survived navigation, and vanished
   * on the next cold start.
   */
  addCharacter: (record) => {
    set((s) => {
      // Same id, or the same card name — see the interface note on why the name
      // has to participate.
      const kept = s.characters.filter(
        (c) => c.id !== record.id && c.card?.data?.name !== record.card?.data?.name,
      )
      return { characters: [...kept, record] }
    })
    // Not awaited: a failed save must not surface in the import flow.
    void saveCharacterRow(record)
  },

  /**
   * Remove a card from the library and from SQLite.
   *
   * Conversations that referenced it keep their transcripts and lose only the
   * link (`ON DELETE SET NULL` in the schema). The store mirrors that here so
   * the in-memory list does not keep showing a character that no longer exists,
   * which would leave the next generation building a prompt from a deleted card.
   */
  removeCharacter: (id) => {
    set((s) => ({
      characters: s.characters.filter((c) => c.id !== id),
      activeCharacterId: s.activeCharacterId === id ? null : s.activeCharacterId,
      conversations: s.conversations.map((c) =>
        c.characterId === id ? { ...c, characterId: null } : c,
      ),
    }))
    void deleteCharacterRow(id)
  },

  /**
   * Selecting a character updates the active conversation too, when there is
   * one — `Conversation.characterId` is the value that reaches the prompt
   * builder, so setting only the store's `activeCharacterId` would make the
   * UI look correct while the model saw the wrong character.
   */
  selectCharacter: (id) =>
    set((s) => ({
      activeCharacterId: id,
      conversations: s.conversations.map((c) =>
        c.id === s.activeConversationId ? { ...c, characterId: id } : c,
      ),
    })),

  /**
   * Create a conversation and switch to it.
   *
   * `messages` is cleared because the store holds ONE transcript at a time —
   * `messages` belongs to whichever conversation is active. Without the reset
   * the previous conversation's turns would render inside the new one, and
   * they would be persisted under the wrong id on the next write.
   *
   * The id is timestamp-plus-counter rather than a UUID for the same reason as
   * `appendUser`: `crypto.randomUUID` is not guaranteed on Hermes.
   */
  createConversation: (characterId) => {
    const now = Date.now()
    const id = `conv_${now.toString(36)}_${(conversationCounter += 1).toString(36)}`
    const selected = characterId ?? get().activeCharacterId ?? null

    set((s) => {
      const character = selected ? s.characters.find((c) => c.id === selected) : undefined
      const conversation: Conversation = {
        id,
        // Falls back to a neutral title; the list prefers the character name
        // when one is attached, so this is only what the user sees if they
        // start a chat before picking a persona.
        title: character ? character.card.data.name : '新对话',
        characterId: selected,
        // Null = inherit whatever model the engine has loaded. A per-conversation
        // model pin is not exposed yet, so writing a value here would be a lie.
        modelId: null,
        samplerOverride: null,
        contextOverride: null,
        worldInfo: '',
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
        lastMessageAt: now,
      }
      return {
        conversations: [conversation, ...s.conversations],
        activeConversationId: id,
        messages: [],
        hasMore: true,
        activeCharacterId: selected,
      }
    })

    /**
     * Persist immediately.
     *
     * A conversation created and then abandoned (user taps ＋, changes their
     * mind, closes the app) should still be there — otherwise the list silently
     * loses rows the user has seen. Writing one row is cheap, and it avoids the
     * "when do we save?" question entirely for creation.
     */
    const created = get().conversations.find((c) => c.id === id)
    if (created) void saveConversation(created)

    /**
     * Seed the character's opening line.
     *
     * A card's `first_mes` is the scene-setter: the tavern, the greeting, the
     * character's first move. Without it a roleplay opens on a blank screen and
     * the user cannot tell whether they are supposed to speak first, while the
     * model has no anchor for tone.
     *
     * Committed as a REAL assistant message rather than injected into the prompt,
     * so the user can see it, scroll it, edit it and regenerate it like any other
     * turn.
     *
     * `openingMessageFor` returns null for a card with no `first_mes` (or only
     * whitespace), so a plain conversation still starts empty.
     */
    if (selected) {
      const character = get().characters.find((c) => c.id === selected) ?? null
      const opening = openingMessageFor(character)
      if (opening) {
        /**
         * Alternate greetings become VERSIONS of the same opening.
         *
         * That is exactly what the swipe control is for: a user who dislikes the
         * first line cycles through the alternatives instead of retyping. The
         * first greeting is index 0, so the card's primary opening is what shows.
         */
        const alternates = alternateOpeningsFor(character)
        get().appendMessage({
          id: `opening-${id}`,
          conversationId: id,
          role: 'assistant',
          content: opening,
          reasoning: null,
          createdAt: Date.now(),
          modelId: null,
          swipeIndex: 0,
          swipes: alternates.length > 0 ? [opening, ...alternates] : [opening],
          edited: false,
          pinned: false,
        })
      }
    }

    return id
  },

  deleteConversation: (id) => {
    set((s) => {
      const conversations = s.conversations.filter((c) => c.id !== id)
      const wasActive = s.activeConversationId === id
      // Drop the parked transcript too: leaving it would resurrect a deleted
      // conversation's history if its id were ever reused.
      const { [id]: _removed, ...transcripts } = s.transcripts
      return {
        conversations,
        transcripts,
        // Only clear the transcript when the deleted one was on screen;
        // otherwise removing a background conversation would wipe the chat the
        // user is currently reading.
        ...(wasActive
          ? { activeConversationId: null, messages: [], hasMore: true }
          : {}),
      }
    })
    // Cascades to the messages via the foreign key.
    void deleteConversationRows(id)
  },

  /**
   * Append a user turn.
   *
   * The id is built from the timestamp plus a counter rather than a UUID:
   * `crypto.randomUUID` is not guaranteed on Hermes, and a monotonic suffix
   * keeps ids unique when two messages land in the same millisecond (which
   * happens when a user pastes and immediately hits send).
   */
  appendUser: (content) => {
    const conversationId = get().activeConversationId ?? 'local'
    const now = Date.now()
    set((s) => {
      // Keep the conversation list's denormalised counters in step. The list
      // sorts by `lastMessageAt` and shows `messageCount`, so a conversation
      // that just received a message must move to the top — otherwise the user
      // sends a message and watches it stay buried under an older chat.
      const conversations = s.conversations.map((c) =>
        c.id === conversationId
          ? { ...c, lastMessageAt: now, updatedAt: now, messageCount: c.messageCount + 1 }
          : c,
      )
      const messages = [
        ...s.messages,
        {
          id: `u-${now}-${s.messages.length}`,
          conversationId,
          role: 'user' as const,
          content,
          reasoning: null,
          createdAt: now,
          modelId: null,
          swipeIndex: 0,
          swipes: [],
          edited: false,
          pinned: false,
        },
      ]
      return {
        conversations,
        messages,
        // Park the updated transcript: messages is replaced on every
        // conversation switch, so a turn that lived only there would vanish the
        // moment the user navigated away and back.
        transcripts: { ...s.transcripts, [conversationId]: messages },
      }
    })

    // Mirror to SQLite. Fire-and-forget on purpose: a failed write must not
    // block sending, and the in-memory state is already correct either way.
    const after = get()
    const convo = after.conversations.find((c) => c.id === conversationId)
    const last = after.messages[after.messages.length - 1]
    if (convo && last) void saveTranscript(convo, [last])
  },
}))

// ---------------------------------------------------------------------------
// Settings store
// ---------------------------------------------------------------------------

export interface SettingsStoreState {
  sampling: SamplingParams
  contextConfig: ContextConfig
  /** Character used for new conversations. */
  defaultCharacterId: string | null

  /**
   * The system prompt prepended to every conversation.
   *
   * Empty string means "use the model's own default" — we then send nothing
   * and let llama.cpp apply whatever the GGUF was trained with, rather than
   * inventing an assistant preamble the model did not ask for.
   *
   * This is the app's persona mechanism. It is deliberately a plain text box
   * rather than a card format: it is the one lever that reliably changes model
   * behaviour, it needs no importer, and it works identically for a local GGUF
   * and a cloud endpoint. Small models in particular ignore a stray "act like
   * X" buried in the message history but follow a system prompt.
   */
  systemPrompt: string

  /**
   * Last model the user loaded, so a relaunch can restore it automatically.
   *
   * Persisting just this id (rather than the whole engine state) is enough:
   * the model file is re-adopted from disk at startup, and loading is
   * deterministic from the id.
   */
  lastLoadedModelId: string | null

  /**
   * Which backend new turns go to.
   *
   * 'local' is the default and the product's whole premise: weights on the
   * device, nothing leaves the phone. 'remote' is an explicit opt-in for
   * devices that cannot run a useful model, and the UI must state plainly that
   * conversation content is then sent to a third party (see
   * `REMOTE_PRIVACY_NOTICE`).
   */
  backend: BackendKind
  /** Cloud endpoint settings. Only meaningful when `backend === 'remote'`. */
  remoteProvider: RemoteProviderConfig

  setSampling: (patch: Partial<SamplingParams>) => void
  setContextConfig: (patch: Partial<ContextConfig>) => void
  resetSampling: () => void
  resetContextConfig: () => void
  setDefaultCharacterId: (id: string | null) => void
  setBackend: (kind: BackendKind) => void
  setRemoteProvider: (patch: Partial<RemoteProviderConfig>) => void
  setSystemPrompt: (prompt: string) => void
  setLastLoadedModelId: (id: string | null) => void
}

/** Shown as placeholder text; not sent unless the user actually types it. */
export const SYSTEM_PROMPT_PLACEHOLDER =
  '例如：你是一位耐心的编程助手，回答简洁，先给结论再解释。'

/** Preset the cloud tab starts on — DeepSeek, since the app targets CN users. */
const DEFAULT_REMOTE_PROVIDER: RemoteProviderConfig = {
  id: 'deepseek',
  label: 'DeepSeek',
  protocol: 'openai',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  apiKey: '',
}

export const useSettingsStore = create<SettingsStoreState>((set) => ({
  sampling: { ...DEFAULT_SAMPLING },
  contextConfig: { ...DEFAULT_CONTEXT_CONFIG },
  defaultCharacterId: null,
  systemPrompt: '',
  lastLoadedModelId: null,
  backend: 'local',
  remoteProvider: { ...DEFAULT_REMOTE_PROVIDER },

  setSampling: (patch) => set((s) => ({ sampling: { ...s.sampling, ...patch } })),

  setContextConfig: (patch) =>
    set((s) => {
      const next = { ...s.contextConfig, ...patch }
      // The engine must agree with the OS about how many cores exist; clamping
      // here rather than at the call site means no path can set threads to 0.
      next.threads = clampThreads(next.threads)
      return { contextConfig: next }
    }),

  setBackend: (kind) => set({ backend: kind }),

  setRemoteProvider: (patch) =>
    set((s) => ({ remoteProvider: { ...s.remoteProvider, ...patch } })),

  resetSampling: () => set({ sampling: { ...DEFAULT_SAMPLING } }),
  resetContextConfig: () => set({ contextConfig: { ...DEFAULT_CONTEXT_CONFIG } }),
  setDefaultCharacterId: (id) => set({ defaultCharacterId: id }),
  setSystemPrompt: (prompt) => set({ systemPrompt: prompt }),
  setLastLoadedModelId: (id) => set({ lastLoadedModelId: id }),
}))

/**
 * Persist settings whenever something durable changes.
 *
 * Subscribed at module scope rather than inside a component so it runs
 * regardless of which screen is mounted — the API key is typed on the 模型 tab
 * and read on the 对话 tab, and a component-scoped subscription would miss
 * changes made while that component is unmounted.
 *
 * Fire-and-forget: `savePersistedSettings` swallows its own errors, because
 * failing to write a preference must never surface as a UI error.
 */
useSettingsStore.subscribe((state) => {
  const payload = snapshotForPersistence({
    systemPrompt: state.systemPrompt,
    lastLoadedModelId: state.lastLoadedModelId,
    backend: state.backend,
    remoteProvider: state.remoteProvider,
    sampling: state.sampling as unknown as Record<string, unknown>,
    contextConfig: state.contextConfig as unknown as Record<string, unknown>,
  })
  // Skip the write when nothing durable actually changed — the store also
  // carries transient fields, and an unconditional write on every action would
  // hit the filesystem on every keystroke of the system-prompt box.
  const encoded = JSON.stringify(payload)
  if (encoded === lastPersisted) return
  lastPersisted = encoded
  void savePersistedSettings(payload)
})

let lastPersisted: string | null = null

/**
 * Restore persisted settings into the store. Call once, at boot, before any
 * screen reads a setting.
 */
export async function restorePersistedSettings(): Promise<void> {
  const saved = await loadPersistedSettings()
  if (!saved) return
  useSettingsStore.setState({
    ...(typeof saved.systemPrompt === 'string' ? { systemPrompt: saved.systemPrompt } : {}),
    ...(saved.lastLoadedModelId !== undefined
      ? { lastLoadedModelId: saved.lastLoadedModelId }
      : {}),
    ...(saved.backend === 'local' || saved.backend === 'remote'
      ? { backend: saved.backend }
      : {}),
    ...(saved.remoteProvider ? { remoteProvider: { ...saved.remoteProvider } } : {}),
    ...(saved.sampling ? { sampling: saved.sampling as never } : {}),
    ...(saved.contextConfig
      ? { contextConfig: migrateContextConfig(saved.contextConfig as never) }
      : {}),
  })
}

/**
 * Raise a persisted context length that predates the 8192 default.
 *
 * A saved `contextLength` OVERRIDES `DEFAULT_CONTEXT_CONFIG`, so simply changing
 * the default would only affect fresh installs — every existing user would keep
 * 4096 and never see the fix. That is the classic "we changed the default and
 * nothing happened" bug.
 *
 * Only the OLD DEFAULT (4096) is migrated. A user who deliberately chose 2048 or
 * 16384 keeps their choice; silently rewriting an explicit preference would be
 * worse than leaving it alone. 4096 is treated as "never touched" because it was
 * the shipped value, and anyone who wanted a different number would have moved
 * it to one of the other steps the Settings slider offers.
 */
const LEGACY_DEFAULT_CONTEXT = 4096

function migrateContextConfig(
  saved: Record<string, unknown> & { contextLength?: number },
): never {
  if (saved.contextLength === LEGACY_DEFAULT_CONTEXT) {
    return { ...saved, contextLength: DEFAULT_CONTEXT_CONFIG.contextLength } as never
  }
  return saved as never
}

/**
 * Rebuild conversation state from SQLite.
 *
 * Call once at boot, before the conversation list renders. Before this existed
 * the app started empty every launch and every transcript was discarded on exit
 * -- the worst defect this project shipped, and one that only a real cold start
 * could reveal.
 *
 * Transcripts are loaded EAGERLY for every conversation rather than lazily on
 * open. That is a deliberate trade: lazy loading would introduce a spinner on
 * every row tap, a race with any in-flight generation, and a visible flash of
 * empty chat. A realistic history is hundreds of messages and reads in
 * milliseconds from a local file.
 *
 * Failures are non-fatal: with no database this resolves having changed nothing,
 * and the app runs in-memory exactly as it did before persistence landed.
 */
export async function restoreConversations(): Promise<void> {
  const conversations = await loadConversations()
  if (conversations.length === 0) return

  const transcripts: Record<string, Message[]> = {}
  for (const conversation of conversations) {
    transcripts[conversation.id] = await loadMessages(conversation.id)
  }

  useChatStore.setState({
    conversations,
    transcripts,
    // Deliberately NOT restoring `activeConversationId`: opening the app should
    // land on the conversation LIST, which is what a messaging app does.
    // Jumping straight into the last chat hides the list and makes the back
    // gesture feel like it did nothing.
    activeConversationId: null,
    messages: [],
  })
}

/**
 * Rebuild the character library from SQLite.
 *
 * Call once at boot, before the character screen renders. Before this existed
 * every imported card lived only in the store, so a cold start began with an
 * empty library and the user had to re-import their cards -- the same defect
 * `restoreConversations` above fixed for chat history, and equally invisible
 * without a real cold start.
 *
 * Kept separate from `restoreConversations` rather than folded into it: the two
 * restore different tables, and a failure loading cards must not prevent
 * conversations from coming back (or the reverse).
 *
 * Failures are non-fatal. With no database `loadCharacters` returns an empty
 * list and this resolves having changed nothing, which is the correct boot
 * state for a fresh install.
 *
 * `activeCharacterId` is deliberately left alone rather than set to the most
 * recent card: selecting a character for a conversation is a user decision, and
 * silently attaching the last-imported character to every new chat would put
 * words in a character's mouth that the user never chose.
 */
export async function restoreCharacters(): Promise<void> {
  const characters = await loadCharacters()
  if (characters.length === 0) return

  useChatStore.setState({ characters })
}

// ---------------------------------------------------------------------------
// Rolling memory summaries
// ---------------------------------------------------------------------------
//
// ⚠️ EVERYTHING BELOW THIS LINE IS NEW AND APPEND-ONLY.
//
// Multiple agents edit this file concurrently. The functions above are owned by
// other tasks; these two are the whole of task C's store surface. Do not fold
// them into `generate()` from here — the wiring is the main agent's, and the
// call sites are named in the comment on `maybeSummarize`.

/**
 * Cap on the summariser's own output.
 *
 * Deliberately larger than `config.maxWords` (200) so the WORDS limit is what
 * actually stops the summary, not the token cap: a model cut off by the cap
 * returns a fragment, and `cleanSummary` rejects fragments. Sized for a CJK
 * summary, where one character is roughly one token.
 */
const SUMMARY_MAX_TOKENS = 512

/**
 * Summarise a conversation's older turns, if it is due.
 *
 * ── What problem this solves ────────────────────────────────────────────────
 * The context window is small (4096 by default). Past roughly 20 exchanges
 * `trimToContext` starts dropping the OLDEST turns, and those are exactly the
 * ones holding facts the user stated once — their name, their job, what they
 * asked for. The user's experience is a character that gradually forgets, with
 * no error anywhere. SillyTavern's answer is the same one implemented here:
 * compress old turns into a short summary that stays permanently in the prompt,
 * so the *amount* of history sent stays bounded while the *information* does
 * not evaporate.
 *
 * ── Why this is not called from `generate()` ────────────────────────────────
 * Deliberately left as a separate function. A summarisation pass runs its own
 * `engine.completion`, and the engine owns exactly ONE context (see the
 * `InferenceEngine` doc) — so calling this while a reply is streaming would
 * fight the reply. The intended wiring is:
 *
 *   1. In `generate()`, AFTER the assistant reply is committed via
 *      `chat.appendMessage(...)` and the engine status is back to `ready`,
 *      fire it fire-and-forget:
 *      `void maybeSummarize(chat.activeConversationId ?? '')`.
 *      Do NOT await it: the user's reply is already on screen, and blocking
 *      the turn on a second generation makes the app feel stalled.
 *   2. For injection, read the memory in `generate()` just before
 *      `buildSystemPrompt(chat, settings)` and append it as an extra part —
 *      `getSummaryForPrompt` is async and `buildSystemPrompt` is sync, so the
 *      await has to happen at the caller. `formatSummaryForPrompt` already
 *      returns the finished `[摘要] …` form.
 *
 * ── Failure policy ──────────────────────────────────────────────────────────
 * Best-effort and silent, like all persistence here. A failed summary costs the
 * user nothing until the window fills; a thrown error would break the chat.
 */
export async function maybeSummarize(
  conversationId: string,
  config: SummarizeConfig = DEFAULT_SUMMARIZE_CONFIG,
): Promise<void> {
  if (!conversationId) return

  // ⚠️ Config is a PARAMETER, not a field on `useSettingsStore`.
  //
  // Reading it from the settings store would mean adding a field, an
  // initialiser and a setter to a store that other agents are editing in
  // parallel, for a knob no UI exposes yet. The default is the shipped
  // behaviour, and the main agent can add a persisted setting later and pass it
  // in from the call site without touching this function.
  if (!config.enabled) return

  // Read the transcript through `getState()` rather than a closed-over
  // snapshot: this runs fire-and-forget after a turn, and the caller may have
  // appended the assistant reply in the same tick that started this call.
  const chat = useChatStore.getState()
  // The transcript on screen is the right source only while this conversation
  // IS the active one. For a background conversation we have nothing loaded, so
  // summarising would compress the wrong turns — worse than not summarising.
  if (chat.activeConversationId !== conversationId) return
  const messages = chat.messages

  let previous: StoredSummary | null = null
  try {
    previous = await loadSummary(conversationId)
  } catch {
    previous = null
  }

  // How many messages are new since the last pass. Derived from the STORED
  // COUNT, not from the id: ids are not ordered, and a message deleted from
  // the middle of the thread would make an id-based count wrong in a way that
  // silently skips summarisation.
  const alreadyCovered = previous?.messageCount ?? 0
  const sinceLast = Math.max(0, messages.length - alreadyCovered)

  const fresh = messages.slice(alreadyCovered)
  const freshChars = transcriptChars(fresh)

  const due = shouldSummarize({
    messageCount: messages.length,
    messagesSinceLastSummary: sinceLast,
    wordsSinceLastSummary: freshChars,
    config,
  })
  if (!due) return

  // Nothing new to compress would ask the model to "extend" a summary with no
  // new information, which small models answer by paraphrasing what they were
  // already given — spending a full generation to make the memory worse.
  if (fresh.length === 0) return

  const engine = activeEngine()
  if (!engine || !engine.isReady()) return

  const transcript = buildTranscript(fresh)
  if (transcript.trim().length === 0) return

  const prompt = buildSummaryPrompt({
    transcript,
    previousSummary: previous?.summary ?? null,
    maxWords: config.maxWords,
  })

  let raw: string
  try {
    const outcome = await engine.completion(
      prompt,
      {
        // Greedy decoding, unlike the roleplay sampler. A creative sample here
        // would rewrite the very facts it was asked to preserve, and memory
        // that drifts is worse than memory that is terse.
        sampling: {
          ...DEFAULT_SAMPLING,
          temperature: 0,
          topK: 1,
          seed: -1,
          maxTokens: SUMMARY_MAX_TOKENS,
        },
        enableThinking: false,
        thinkingBudgetTokens: null,
        jsonSchema: null,
      },
      // No streaming: this text is never shown as it is produced, and pushing
      // it into `streamingText` would render the summariser's inner monologue
      // in the chat as if the character were speaking.
      () => {},
    )
    raw = outcome.text
  } catch {
    // A failed summary must not surface as a chat error. The next turn finds
    // the same condition still true and tries again.
    return
  }

  const cleaned = cleanSummary(raw, { maxWords: config.maxWords, minWords: config.minWords })
  if (!cleaned.summary) {
    // Deliberately keeps the previous summary. See `cleanSummary`: a short
    // reply usually means the model hit its token cap, and replacing a good
    // summary with a fragment is silent memory destruction.
    return
  }

  const now = Date.now()
  const lastMessage = messages[messages.length - 1]
  await saveSummary({
    conversationId,
    summary: toStoredSummary(cleaned.summary),
    upToMessageId: lastMessage?.id ?? previous?.upToMessageId ?? '',
    // The count at the END of this pass, which is what the next pass subtracts.
    messageCount: messages.length,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  })
}

/**
 * The memory block for a conversation, ready to append to the system prompt.
 *
 * Returns null when there is no memory yet, so the caller can distinguish
 * "nothing to say" from "something to say" without inspecting the string.
 * `formatSummaryForPrompt` would also collapse absent input to `''`, but the
 * null lets the caller skip the separator join entirely rather than adding a
 * stray blank section to the prompt.
 */
export async function getSummaryForPrompt(conversationId: string): Promise<string | null> {
  if (!conversationId) return null
  try {
    const stored = await loadSummary(conversationId)
    if (!stored) return null
    const formatted = formatSummaryForPrompt(stored.summary)
    return formatted.length > 0 ? formatted : null
  } catch {
    return null
  }
}
