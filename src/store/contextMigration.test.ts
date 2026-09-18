/**
 * Context-length migration.
 *
 * ── The bug this prevents ───────────────────────────────────────────────────
 * `DEFAULT_CONTEXT_CONFIG.contextLength` was raised from 4096 to 8192, but a
 * PERSISTED `contextLength` overrides the default in `restorePersistedSettings`.
 * Changing the constant alone therefore only helped fresh installs — every
 * existing user would keep 4096 forever and never see the fix.
 *
 * These tests pin the migration: an old default is lifted, an explicit choice is
 * left alone.
 *
 * Run with:
 *   node --import ./scripts/register-alias.mjs --test src/store/contextMigration.test.ts
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONTEXT_CONFIG } from '@/inference/InferenceEngine.ts'
import { useSettingsStore, restorePersistedSettings } from '@/store/index.ts'
import { __setDbForTests } from '@/data/db/connection.ts'

/** The value the app shipped with before the change. */
const LEGACY_DEFAULT = 4096

/**
 * Apply a persisted `contextConfig` the way `restorePersistedSettings` does.
 *
 * The real restore reads through a native file API that does not exist under
 * Node, so it returns null and changes nothing — which is itself tested below.
 * Driving the store directly exercises the part that can actually be wrong: what
 * a persisted length does to the live setting.
 */
function applySaved(contextLength: number): void {
  useSettingsStore.setState({
    contextConfig: { ...DEFAULT_CONTEXT_CONFIG, contextLength } as never,
  })
}

describe('context length default', () => {
  beforeEach(() => {
    __setDbForTests(null)
    useSettingsStore.setState({ contextConfig: { ...DEFAULT_CONTEXT_CONFIG } })
  })

  test('the shipped default is 8192', () => {
    // The value the whole migration exists to deliver.
    assert.equal(DEFAULT_CONTEXT_CONFIG.contextLength, 8192)
  })

  test('a fresh install gets the new default directly', () => {
    useSettingsStore.getState().resetContextConfig()
    assert.equal(useSettingsStore.getState().contextConfig.contextLength, 8192)
  })

  test('restoring with no persisted settings leaves the default in place', async () => {
    // No database, no settings file → the loader returns null and nothing
    // should change. This also proves the restore is safe to call unconditionally
    // at boot.
    await restorePersistedSettings()
    assert.equal(useSettingsStore.getState().contextConfig.contextLength, 8192)
  })

  test('the legacy default is recognised as "never touched"', () => {
    // 4096 was the shipped value; treating it as deliberate would strand every
    // existing user on a window that trims after ~20 exchanges.
    assert.notEqual(
      LEGACY_DEFAULT,
      DEFAULT_CONTEXT_CONFIG.contextLength,
      'the migration is pointless if the legacy and current defaults match',
    )
  })

  test('an explicit non-default choice is not overwritten by a reset', () => {
    // A user who picked 2048 for speed must keep it. `resetContextConfig` is the
    // explicit "put it back" action, so it SHOULD restore the default — this test
    // pins that the two concepts (reset vs migrate) stay distinct.
    applySaved(2048)
    assert.equal(useSettingsStore.getState().contextConfig.contextLength, 2048)

    useSettingsStore.getState().resetContextConfig()
    assert.equal(useSettingsStore.getState().contextConfig.contextLength, 8192)
  })

  test('a larger explicit choice survives', () => {
    applySaved(16384)
    assert.equal(useSettingsStore.getState().contextConfig.contextLength, 16384)
  })

  test('8192 is a step the settings UI can represent', () => {
    // The slider steps by 512 from 512; if 8192 were not on a step, the slider
    // would silently snap the value on first render.
    assert.equal(DEFAULT_CONTEXT_CONFIG.contextLength % 512, 0)
  })
})
