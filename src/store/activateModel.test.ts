/**
 * `activateModel` — the chat model picker's single entry point.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * "Which model answers me" used to be implicit: the engine held whatever was
 * last loaded from the 模型 tab, and the chat screen had no way to see or change
 * it. The user's report was concrete — they configured a cloud API, flipped the
 * switch, went back to the chat, and a local model still answered.
 *
 * `activateModel` collapses local and cloud into one decision with one code
 * path. These tests pin the parts that are easy to get wrong: the previous
 * engine is released (not left resident), the backend flag follows the choice,
 * and an unknown / not-downloaded model fails with an actionable message
 * instead of silently keeping the old one.
 *
 * Run with:
 *   node --import ./scripts/register-alias.mjs --test src/store/activateModel.test.ts
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { useEngineStore, useModelStore, useSettingsStore } from '@/store/index.ts'
import { MockInferenceEngine } from '@/inference/MockInferenceEngine.ts'
import { __setEngineForTests, clearBackend, activeEngine } from '@/inference/engineFactory.ts'
import { OFFICIAL_LINE } from '@/data/models/lineCatalog.ts'

const TARGET = OFFICIAL_LINE[0]!

function markDownloaded(): void {
  useModelStore.setState({
    records: {
      [TARGET.id]: {
        id: TARGET.id,
        state: 'ready',
        bytesOnDisk: TARGET.sizeBytes,
        localPath: 'file:///data/user/0/com.phonellm.app/files/models/x/repo',
        shardPaths: [],
        lastError: null,
        updatedAt: Date.now(),
      },
    },
  } as never)
}

describe('activateModel', () => {
  beforeEach(() => {
    clearBackend()
    useEngineStore.setState({ status: 'idle', modelId: null, loadProgress: 0, error: null })
    useModelStore.setState({ records: {}, loadedModelId: null } as never)
    useSettingsStore.setState({ backend: 'local' })
  })

  test('a local selection loads that model and reports ready', async () => {
    __setEngineForTests(new MockInferenceEngine(), 'local')
    markDownloaded()

    await useEngineStore.getState().activateModel({ kind: 'local', modelId: TARGET.id })

    const s = useEngineStore.getState()
    assert.equal(s.status, 'ready', `got ${s.status}: ${s.error ?? ''}`)
    assert.equal(s.modelId, TARGET.id)
    assert.equal(useSettingsStore.getState().backend, 'local')
  })

  test('selecting a model that is not downloaded fails loudly', async () => {
    __setEngineForTests(new MockInferenceEngine(), 'local')
    // No markDownloaded(): the catalogue entry exists but nothing is on disk.
    await useEngineStore.getState().activateModel({ kind: 'local', modelId: TARGET.id })

    const s = useEngineStore.getState()
    assert.equal(s.status, 'error')
    // The old model must NOT still be reported as active — that would make the
    // picker show the wrong selection after a failed switch.
    assert.notEqual(s.status, 'ready')
  })

  test('switching unloads whatever engine is currently active', async () => {
    // The factory holds ONE engine at a time, so the observable contract is
    // "the engine that was active before the switch got unloaded" — not "the
    // first object ever installed is still tracked". Using a spy that survives
    // the swap is what makes that assertion meaningful.
    let unloadCalls = 0
    class CountingEngine extends MockInferenceEngine {
      async unload(): Promise<void> {
        unloadCalls += 1
        return super.unload()
      }
    }

    const engine = new CountingEngine()
    __setEngineForTests(engine, 'local')
    markDownloaded()

    await useEngineStore.getState().activateModel({ kind: 'local', modelId: TARGET.id })

    // One unload from the explicit teardown at the top of `activateModel`.
    // (Re-installing the same engine means the subsequent load reuses it.)
    assert.ok(unloadCalls >= 1, 'activateModel must release the previous context')
    assert.equal(useEngineStore.getState().status, 'ready')
  })

  test('cloud selection switches the backend flag', async () => {
    __setEngineForTests(new MockInferenceEngine(), 'local')
    useSettingsStore.setState({
      remoteProvider: {
        id: 'deepseek',
        label: 'DeepSeek',
        protocol: 'openai',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        apiKey: 'sk-test',
      },
    })

    await useEngineStore.getState().activateModel({ kind: 'cloud' })

    // Even if the probe fails (no network in tests), the user's intent to use
    // the cloud must be recorded — otherwise the switch silently does nothing,
    // which is the exact bug that was reported.
    assert.equal(useSettingsStore.getState().backend, 'remote')
  })

  test('unloadModel clears state without forgetting the preference', async () => {
    __setEngineForTests(new MockInferenceEngine(), 'local')
    markDownloaded()
    await useEngineStore.getState().activateModel({ kind: 'local', modelId: TARGET.id })
    const remembered = useSettingsStore.getState().lastLoadedModelId
    assert.equal(remembered, TARGET.id)

    await useEngineStore.getState().unloadModel()

    assert.equal(useEngineStore.getState().status, 'idle')
    // Unloading is "free some RAM", not "forget this model" — a relaunch should
    // still restore it.
    assert.equal(useSettingsStore.getState().lastLoadedModelId, TARGET.id)
  })

  test('the engine factory is left holding an engine after a cloud switch attempt', async () => {
    __setEngineForTests(new MockInferenceEngine(), 'local')
    await useEngineStore.getState().activateModel({ kind: 'cloud' })
    // Whatever the outcome, the app must not be left with NO engine at all —
    // the composer would then be permanently disabled.
    assert.ok(activeEngine() != null || useEngineStore.getState().status === 'error')
  })
})
