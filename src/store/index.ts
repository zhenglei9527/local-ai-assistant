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
import type { LoadedModelInfo } from '@/inference/InferenceEngine'
import { DEFAULT_SAMPLING, DEFAULT_CONTEXT_CONFIG, clampThreads } from '@/inference/InferenceEngine'
import { activeEngine, activeBackendKind, setBackend } from '@/inference/engineFactory'
import type { BackendKind } from '@/inference/engineFactory'
import type { RemoteProviderConfig } from '@/inference/remote/providerConfig'
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

    const history = chat.messages
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
    const systemText = buildSystemPrompt(chat, settings)
    if (systemText) history.unshift({ role: 'system', content: systemText })

    if (history.filter((m) => m.role !== 'system').length === 0) {
      set({ status: 'error', error: '没有可发送的内容。' })
      return
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
        chat.appendMessage({
          id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          conversationId: chat.activeConversationId ?? '',
          role: 'assistant',
          content: text,
          reasoning: outcome.reasoning,
          createdAt: Date.now(),
          modelId: useEngineStore.getState().modelId,
          swipeIndex: 0,
          swipes: [],
        })
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
 * The character's own text comes first and the user's global prompt second.
 * That order makes the global prompt an *additional instruction* rather than a
 * replacement: if a card says "you are a gruff sea captain" and the global
 * prompt says "answer in Chinese", appending preserves both. Putting the global
 * prompt first would let a card's description bury it.
 */
export function buildSystemPrompt(
  chat: { characters: CharacterRecord[]; activeCharacterId: string | null },
  settings: { systemPrompt: string },
): string {
  const parts: string[] = []

  const character = chat.activeCharacterId
    ? chat.characters.find((c) => c.id === chat.activeCharacterId)
    : undefined

  if (character) {
    const d = character.card.data
    const lines: string[] = []
    // Name first, because almost every downstream behaviour (self-reference,
    // staying in character) depends on the model knowing what it is called.
    if (d.name) lines.push(`你的名字是「${d.name}」。`)
    if (d.description) lines.push(d.description)
    if (d.personality) lines.push(`性格：${d.personality}`)
    if (d.scenario) lines.push(`背景设定：${d.scenario}`)
    if (d.system_prompt) lines.push(d.system_prompt)
    if (lines.length > 0) parts.push(lines.join('\n'))
  }

  const global = settings.systemPrompt.trim()
  if (global) parts.push(global)

  return parts.join('\n\n')
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
   * when you switch away, so returning restores it. Without it, switching
   * conversations destroyed the history you left (see `setActiveConversation`).
   *
   * In-memory only for now — a full restart still loses them, and SQLite is the
   * real fix. This at least makes in-app navigation lossless.
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
  setLoadingMore: (loading: boolean) => void
  setHasMore: (hasMore: boolean) => void
  setCharacters: (characters: CharacterRecord[]) => void
  selectCharacter: (id: string | null) => void
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
  appendMessage: (message) =>
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
    }),

  replaceMessage: (message) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.id === message.id ? message : m)),
    })),

  removeMessage: (id) => set((s) => ({ messages: s.messages.filter((m) => m.id !== id) })),

  setLoadingMore: (loading) => set({ loadingMore: loading }),
  setHasMore: (hasMore) => set({ hasMore }),

  setCharacters: (characters) => set({ characters }),

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

    return id
  },

  deleteConversation: (id) =>
    set((s) => {
      const conversations = s.conversations.filter((c) => c.id !== id)
      const wasActive = s.activeConversationId === id
      return {
        conversations,
        // Only clear the transcript when the deleted one was on screen;
        // otherwise removing a background conversation would wipe the chat the
        // user is currently reading.
        ...(wasActive
          ? { activeConversationId: null, messages: [], hasMore: true }
          : {}),
      }
    }),

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
    ...(saved.contextConfig ? { contextConfig: saved.contextConfig as never } : {}),
  })
}
