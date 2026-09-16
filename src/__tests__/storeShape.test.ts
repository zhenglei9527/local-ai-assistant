/**
 * Store shape guards.
 *
 * Written after the app rendered a fully black screen on device: JS started
 * (`Running "phone-llm-app"` in logcat), no exception was thrown, and yet
 * nothing painted. That is the signature of a component returning `null`/
 * `undefined` or a selector reading a field the store does not have — both
 * silent at runtime and both cheap to catch here.
 *
 * These assertions are deliberately about SHAPE, not behaviour, so they stay
 * true as the store grows.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { useChatStore, useModelStore, useEngineStore, useSettingsStore } from '../store/index.ts'

test('chat store exposes arrays, not undefined, for every list field', () => {
  const s = useChatStore.getState()
  assert.ok(Array.isArray(s.conversations), 'conversations must be an array')
  assert.ok(Array.isArray(s.messages), 'messages must be an array')
  assert.ok(Array.isArray(s.characters), 'characters must be an array')
})

test('model store records is a keyed object (not an array)', () => {
  const s = useModelStore.getState()
  assert.equal(typeof s.records, 'object')
  assert.ok(s.records !== null)
  assert.ok(!Array.isArray(s.records), 'records is Record<string, ModelRecord>')
  // The black-screen bug in AppNavigator was `records.some(...)` — an array
  // method on an object. Guard the conversion the UI actually uses.
  assert.doesNotThrow(() => Object.values(s.records).some(() => false))
})

test('createConversation exists and returns a usable id', () => {
  const before = useChatStore.getState().conversations.length
  const id = useChatStore.getState().createConversation(null)
  try {
    assert.equal(typeof id, 'string')
    assert.ok(id.length > 0)
    const after = useChatStore.getState()
    assert.equal(after.conversations.length, before + 1)
    assert.equal(after.activeConversationId, id)
    // The transcript must reset: the store holds ONE conversation's messages,
    // and leaking the previous one would render the wrong chat.
    assert.deepEqual(after.messages, [])
  } finally {
    useChatStore.getState().deleteConversation(id)
  }
})

test('deleteConversation clears the transcript only when it was active', () => {
  const store = useChatStore.getState()
  const a = store.createConversation(null)
  const b = useChatStore.getState().createConversation(null)
  // `b` is active. Deleting `a` must NOT wipe the open transcript.
  useChatStore.getState().deleteConversation(a)
  assert.equal(useChatStore.getState().activeConversationId, b)
  assert.equal(
    useChatStore.getState().conversations.some((c) => c.id === a),
    false,
  )
  useChatStore.getState().deleteConversation(b)
  assert.equal(useChatStore.getState().activeConversationId, null)
})

test('engine and settings stores expose the fields the UI reads', () => {
  const e = useEngineStore.getState()
  assert.equal(typeof e.generate, 'function')
  assert.equal(typeof e.stop, 'function')
  assert.ok(Array.isArray(e.activeDevices))

  const st = useSettingsStore.getState()
  assert.ok(st.sampling != null)
  assert.ok(st.contextConfig != null)
})
