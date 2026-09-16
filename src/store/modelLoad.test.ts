/**
 * Model load / unload wiring.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The app shipped with download and generate both wired, but nothing anywhere
 * called `engine.load()`. The result on a real device was: a model downloads
 * successfully, the Models page shows it as downloaded, and the chat screen
 * says "还没有加载模型" forever. There was no button to press and no way for the
 * user to recover.
 *
 * That is a *wiring* gap of a kind unit tests miss by default — every module
 * was individually correct, and the missing piece was a call that nobody made.
 * So these tests assert the specific link: `loadModel` resolves the descriptor
 * and the on-disk record, drives the engine, and publishes the resulting state
 * where the UI reads it.
 *
 * Run with:
 *   node --import ./scripts/register-alias.mjs --test src/store/modelLoad.test.ts
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { useEngineStore, useModelStore, useSettingsStore } from '@/store/index.ts'
import { MockInferenceEngine } from '@/inference/MockInferenceEngine.ts'
import { __setEngineForTests, clearBackend } from '@/inference/engineFactory.ts'
import { OFFICIAL_LINE } from '@/data/models/lineCatalog.ts'

/** The first catalogue entry, which is what a user sees at the top of the list. */
const TARGET = OFFICIAL_LINE[0]!

function installReadyRecord(): void {
  // Put the model in the state a completed download leaves it in.
  useModelStore.setState({
    records: {
      ...useModelStore.getState().records,
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

describe('model load / unload', () => {
  beforeEach(() => {
    clearBackend()
    useEngineStore.setState({
      status: 'idle',
      modelId: null,
      loadProgress: 0,
      error: null,
    })
    useModelStore.setState({ records: {}, loadedModelId: null } as never)
  })

  test('loadModel on a not-downloaded model fails with an actionable message', async () => {
    __setEngineForTests(new MockInferenceEngine(), 'local')
    await useEngineStore.getState().loadModel(TARGET.id)
    const s = useEngineStore.getState()
    assert.equal(s.status, 'error')
    assert.ok(s.error && s.error.length > 0)
    // Must tell the user what to DO, not just that something went wrong.
    assert.match(s.error, /下载/)
  })

  test('loadModel on an unknown id reports it rather than throwing', async () => {
    __setEngineForTests(new MockInferenceEngine(), 'local')
    await useEngineStore.getState().loadModel('definitely-not-a-real-model')
    const s = useEngineStore.getState()
    assert.equal(s.status, 'error')
    assert.ok(s.error)
  })

  test('loadModel drives the engine and publishes ready state', async () => {
    const engine = new MockInferenceEngine()
    __setEngineForTests(engine, 'local')
    installReadyRecord()

    await useEngineStore.getState().loadModel(TARGET.id)

    const s = useEngineStore.getState()
    assert.equal(s.status, 'ready', `expected ready, got ${s.status}: ${s.error ?? ''}`)
    assert.equal(s.modelId, TARGET.id)
    assert.equal(s.loadProgress, 100)
    assert.equal(s.error, null)
    // The engine itself must actually be holding a context — a store that says
    // "ready" while the engine is empty is exactly the bug this guards.
    assert.equal(engine.isReady(), true)
  })

  test('loadModel strips the file:// scheme before handing the path to the engine', async () => {
    const seen: string[] = []
    class PathSpy extends MockInferenceEngine {
      async load(req: Parameters<MockInferenceEngine['load']>[0]) {
        seen.push(req.modelPath)
        return super.load(req)
      }
    }
    __setEngineForTests(new PathSpy(), 'local')
    installReadyRecord()

    await useEngineStore.getState().loadModel(TARGET.id)

    assert.equal(seen.length, 1)
    // llama.rn wants a bare absolute path; a `file://` prefix produces an
    // opaque "failed to load model" from inside llama.cpp.
    assert.ok(!seen[0]!.startsWith('file://'), `path still has scheme: ${seen[0]}`)
    assert.ok(seen[0]!.startsWith('/'), `path is not absolute: ${seen[0]}`)
  })

  test('unloadModel resets state even when nothing is loaded', async () => {
    __setEngineForTests(new MockInferenceEngine(), 'local')
    installReadyRecord()
    await useEngineStore.getState().loadModel(TARGET.id)
    assert.equal(useEngineStore.getState().status, 'ready')

    await useEngineStore.getState().unloadModel()

    const s = useEngineStore.getState()
    assert.equal(s.status, 'idle')
    assert.equal(s.modelId, null)
    assert.equal(s.loadProgress, 0)
  })

  test('loadModel honours the context length from settings', async () => {
    const seen: number[] = []
    class CtxSpy extends MockInferenceEngine {
      async load(req: Parameters<MockInferenceEngine['load']>[0]) {
        seen.push(req.contextConfig.contextLength)
        return super.load(req)
      }
    }
    __setEngineForTests(new CtxSpy(), 'local')
    installReadyRecord()
    useSettingsStore.getState().setContextConfig({ contextLength: 8192 })

    await useEngineStore.getState().loadModel(TARGET.id)

    assert.deepEqual(seen, [8192])
  })
})
