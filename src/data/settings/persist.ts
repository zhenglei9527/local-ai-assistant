/**
 * Settings persistence.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The app had NO persistence of any kind. Every setting — the cloud endpoint
 * URL, the API key, the model name, the system prompt, sampling values — lived
 * in memory only. Restarting meant retyping an API key, which is exactly the
 * complaint that prompted this file ("我每次输入老费劲了").
 *
 * ── Why a hand-rolled store ─────────────────────────────────────────────────
 * `zustand/middleware` ships a `persist` helper, but its built-in storage
 * adapters need AsyncStorage (a native dependency and a rebuild). The app
 * already has a native module that can read and write a file, so persisting one
 * JSON blob through it costs nothing and adds nothing.
 *
 * A single JSON document rather than one key per setting: settings are written
 * rarely (on change) and read once at boot, so the simplicity of "parse one
 * object" beats fine-grained writes, and there is no partial-write failure mode
 * to reason about.
 *
 * ── What is NOT stored here ─────────────────────────────────────────────────
 * Chat transcripts and downloaded-model records. Those belong in SQLite (which
 * is still unwritten) and, for the models, on disk where `reconcileFromDisk`
 * already recovers them. This file is for *preferences* only.
 */

/*
 * ⚠️ NO top-level `react-native` import.
 *
 * This module is reachable from the store, and the store is imported by the
 * test suite under plain Node. A static `import { Platform } from 'react-native'`
 * pulls in React Native's Flow-typed entry point, which Node cannot parse
 * (`SyntaxError: Unexpected token 'typeof'`) — every store test fails at import
 * time. The platform check is therefore done lazily, inside the function that
 * needs it, and the native module lookup already avoids a static import for the
 * same reason.
 */

const STORAGE_FILE = 'settings.json'

/** Everything that should survive a restart. */
export interface PersistedSettings {
  /** Bumped when the shape changes; unknown versions are discarded, not merged. */
  readonly version: 1
  systemPrompt: string
  lastLoadedModelId: string | null
  backend: 'local' | 'remote'
  remoteProvider: {
    id: string
    label: string
    protocol: 'openai' | 'anthropic'
    baseUrl: string
    model: string
    apiKey: string
  }
  sampling: Record<string, unknown>
  contextConfig: Record<string, unknown>
}

type SystemModule = {
  readTextFile?: (p: string) => Promise<string | null>
  writeTextFile?: (p: string, c: string) => Promise<boolean>
}

let cachedModule: SystemModule | null | undefined

async function getSystem(): Promise<SystemModule | null> {
  if (cachedModule !== undefined) return cachedModule
  try {
    const mod = (await import('@/specs/phoneLlmSystem.ts')) as {
      getPhoneLlmSystem?: () => unknown
    }
    // `getPhoneLlmSystem()` already returns null on a non-device host, so there
    // is no separate platform check to make here.
    cachedModule = (mod.getPhoneLlmSystem?.() as SystemModule) ?? null
  } catch {
    cachedModule = null
  }
  return cachedModule
}

/**
 * Load persisted settings.
 *
 * Never throws: a missing file (first run), an unreadable one, or malformed
 * JSON all resolve to `null`, and the caller falls back to defaults. A settings
 * file that cannot be parsed must not prevent the app from starting — that
 * would turn a corrupt preference into a bricked install.
 */
export async function loadPersistedSettings(): Promise<Partial<PersistedSettings> | null> {
  const system = await getSystem()
  if (!system?.readTextFile) return null

  try {
    const raw = await system.readTextFile(STORAGE_FILE)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PersistedSettings>
    // A different version means the shape moved under us; merging unknown keys
    // would be guessing, so start clean rather than half-restoring.
    if (parsed.version !== 1) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Persist settings.
 *
 * Fire-and-forget by design: a failed write should degrade to "this change did
 * not stick", never to a blocked UI. Callers do not await it.
 */
export async function savePersistedSettings(value: PersistedSettings): Promise<void> {
  const system = await getSystem()
  if (!system?.writeTextFile) return
  try {
    await system.writeTextFile(STORAGE_FILE, JSON.stringify(value))
  } catch {
    /* best effort */
  }
}

/**
 * Build the stored document from live store state.
 *
 * Kept separate from the stores so the mapping is explicit and testable, rather
 * than implied by a middleware config.
 */
export function snapshotForPersistence(input: {
  systemPrompt: string
  lastLoadedModelId: string | null
  backend: 'local' | 'remote'
  remoteProvider: PersistedSettings['remoteProvider']
  sampling: Record<string, unknown>
  contextConfig: Record<string, unknown>
}): PersistedSettings {
  return {
    version: 1,
    systemPrompt: input.systemPrompt,
    lastLoadedModelId: input.lastLoadedModelId,
    backend: input.backend,
    remoteProvider: input.remoteProvider,
    sampling: input.sampling,
    contextConfig: input.contextConfig,
  }
}
