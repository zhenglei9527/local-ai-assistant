/**
 * Engine factory — the missing link between the engine implementations and the
 * store.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `LlamaRnEngine` and `RemoteEngine` were both fully implemented and tested,
 * but nothing ever constructed one. `useEngineStore.generate()` therefore
 * reported "Inference is not wired up" and the Send button did nothing. This
 * module is the single place that decides *which* backend a turn runs on, so
 * the store never has to know that two backends exist.
 *
 * ── The invariant ──────────────────────────────────────────────────────────
 * Exactly ONE engine is active at a time, and it is owned here. Both backends
 * are mutually exclusive by construction: a local GGUF context occupies
 * several GiB of native memory and a remote provider occupies none, but
 * letting both exist simultaneously would mean two code paths can mutate the
 * same KV/conversation state. The store treats `activeEngine()` as the only
 * source, and `setBackend()` is the only way to switch.
 *
 * ── Why lazy construction ──────────────────────────────────────────────────
 * `LlamaRnEngine` imports `llama.rn`, whose module-level `getJsi()` call
 * throws on any host that is not a device (and in every unit test). Importing
 * this file in Node must therefore not pull `llama.rn` in. The local import is
 * dynamic and happens only when a local engine is actually requested.
 */

import type { RemoteProviderConfig } from './remote/providerConfig.ts'
import type { InferenceEngine } from './InferenceEngine.ts'
import { RemoteEngine } from './remote/RemoteEngine.ts'
import { createFetchTransport } from './remote/fetchTransport.ts'

/** Which backend conversation turns are routed to. */
export type BackendKind = 'local' | 'remote'

export interface RemoteBackendOptions {
  readonly config: RemoteProviderConfig
}

export interface LocalBackendOptions {
  /**
   * `file://` path to the primary GGUF, as resolved by the download layer.
   * Passed straight through to the engine's `load`.
   */
  readonly modelPath: string
}

export type BackendOptions =
  | { kind: 'local'; options: LocalBackendOptions }
  | { kind: 'remote'; options: RemoteBackendOptions }

let active: InferenceEngine | null = null
let activeKind: BackendKind | null = null

/** The engine the store should use, or null when nothing is loaded. */
export function activeEngine(): InferenceEngine | null {
  return active
}

/** Which backend `activeEngine()` currently refers to. */
export function activeBackendKind(): BackendKind | null {
  return activeKind
}

/**
 * Replace the active engine.
 *
 * Unloads whatever came before it. The unload is awaited before the new engine
 * is installed because a failed unload leaves several GiB resident, and
 * installing a second engine on top of that is the OOM path this codebase
 * already documents in `InferenceEngine.ts`.
 */
export async function setBackend(spec: BackendOptions): Promise<InferenceEngine> {
  if (active) {
    try {
      await active.unload()
    } catch {
      // A failed unload must not strand the caller: the old engine is being
      // discarded either way, and the native side is the authority on whether
      // memory was actually released.
    }
  }
  active = null
  activeKind = null

  const engine = spec.kind === 'local' ? await createLocalEngine() : createRemoteEngine(spec.options)
  active = engine
  activeKind = spec.kind
  return engine
}

/** Drop the active engine, unloading it first. */
export async function clearBackend(): Promise<void> {
  if (active) {
    try {
      await active.unload()
    } catch {
      // See setBackend.
    }
  }
  active = null
  activeKind = null
}

async function createLocalEngine(): Promise<InferenceEngine> {
  // Dynamic so that importing this module in Node (tests, scripted checks)
  // does not evaluate llama.rn's module-level JSI lookup.
  const { LlamaRnEngine } = await import('./llamaRnEngine.ts')
  return new LlamaRnEngine()
}

function createRemoteEngine(options: RemoteBackendOptions): InferenceEngine {
  // Both are statically imported and safe: RemoteEngine and the fetch transport
  // have no native dependency, so they evaluate fine in Node. The LOCAL engine
  // is the only one that must stay behind a dynamic import.
  return new RemoteEngine(options.config, createFetchTransport())
}

/**
 * Test seam: install an engine directly without going through the factories.
 *
 * Exists so the store's wiring can be exercised in Node against
 * `MockInferenceEngine`, which is the only engine that runs without a device.
 */
export function __setEngineForTests(engine: InferenceEngine | null, kind: BackendKind | null): void {
  active = engine
  activeKind = kind
}
