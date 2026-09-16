/**
 * Cloud connection test (`testRemoteProvider`).
 *
 * WHY THIS EXISTS
 * ---------------
 * The 云端 page collects a base URL, a model name and an API key. Before this
 * button the only way to discover a typo in any of them was to send a real
 * message and read whatever error came back — slow, and on a metered endpoint
 * it bills a doomed request.
 *
 * Two properties matter and are easy to regress:
 *
 *   1. It must NOT touch the live engine. The engine holds one context at a
 *      time, so probing through it would unload the user's local model just to
 *      check a key.
 *   2. It must never throw. A button reports a result; a rejected promise is
 *      the wrong contract and would leave the UI stuck on "testing…".
 *
 * The transport is not exercised here — these run without a network. What is
 * pinned is the failure classification, which is the part a user actually reads.
 *
 * Run with:
 *   node --import ./scripts/register-alias.mjs --test src/inference/remote/testConnection.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { describeError } from '@/inference/remote/RemoteEngine.ts'

describe('cloud error messages', () => {
  test('401 is reported as a bad key, not a raw status code', () => {
    const msg = describeError(new Error('HTTP 401 Unauthorized'))
    assert.match(msg, /Key/)
  })

  test('404 points at the URL or model name', () => {
    const msg = describeError(new Error('HTTP 404 not found'))
    assert.match(msg, /地址|模型/)
  })

  test('429 is reported as rate limiting or exhausted quota', () => {
    const msg = describeError(new Error('HTTP 429 rate limit exceeded'))
    assert.match(msg, /频繁|额度/)
  })

  test('a network failure is distinguished from a credential failure', () => {
    // These need different user actions — fix the URL vs fix the key — so
    // collapsing them into one message would send people to the wrong field.
    const net = describeError(new Error('Network request failed'))
    const key = describeError(new Error('HTTP 401 Unauthorized'))
    assert.notEqual(net, key)
    assert.match(net, /网络|地址/)
  })

  test('5xx is reported as a server-side problem, not the user\u2019s', () => {
    const msg = describeError(new Error('HTTP 503 server error'))
    assert.match(msg, /服务端|稍后/)
  })

  test('an unrecognised error keeps its original text', () => {
    // Losing the raw message would make an unusual provider impossible to
    // debug — the generic fallback must still carry the detail.
    const msg = describeError(new Error('model "foo-9000" does not exist'))
    assert.match(msg, /foo-9000/)
  })
})
