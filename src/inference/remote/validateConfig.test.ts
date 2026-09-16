/**
 * Provider-config validation.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The cloud path shipped with a config that passed every check the UI made and
 * still could not chat: the user had put the provider's *product name*
 * ("DeepSeek V4.1 Flash") in the model field, while the API required the id
 * `deepseek/deepseek-v4.1-flash`. The request failed with a 400 that the UI
 * never displayed, so the app looked frozen.
 *
 * `validateProviderConfig` existed the whole time but was never called from the
 * cloud panel. These tests pin the heuristic that closes the gap, so it cannot
 * silently disappear again.
 *
 * Run with:
 *   node --import ./scripts/register-alias.mjs --test src/inference/remote/validateConfig.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { validateProviderConfig } from '@/inference/remote/providerConfig.ts'

const GOOD = {
  baseUrl: 'https://api.example.com/v1',
  model: 'deepseek/deepseek-v4.1-flash',
  apiKey: 'sk-abc',
  protocol: 'openai' as const,
}

describe('validateProviderConfig', () => {
  test('a well-formed config reports no problems', () => {
    assert.deepEqual(validateProviderConfig(GOOD), [])
  })

  test('a model name with spaces is flagged as a likely product name', () => {
    // The exact input that produced the invisible failure on device.
    const problems = validateProviderConfig({ ...GOOD, model: 'DeepSeek V4.1 Flash' })
    assert.equal(problems.length, 1)
    assert.match(problems[0]!, /空格/)
    // The message must show the correct shape, otherwise the user is told
    // they are wrong without being told what right looks like.
    assert.match(problems[0]!, /deepseek\/deepseek-v4\.1-flash/)
  })

  test('a model id with a vendor prefix is accepted', () => {
    assert.deepEqual(validateProviderConfig({ ...GOOD, model: 'openai/gpt-4o' }), [])
  })

  test('a plain model id is accepted', () => {
    assert.deepEqual(validateProviderConfig({ ...GOOD, model: 'deepseek-chat' }), [])
  })

  test('an empty model name is still reported separately from the space case', () => {
    const problems = validateProviderConfig({ ...GOOD, model: '   ' })
    assert.equal(problems.length, 1)
    assert.match(problems[0]!, /不能为空/)
    // An empty name must not ALSO trip the space heuristic — one clear message
    // beats two overlapping ones.
    assert.doesNotMatch(problems[0]!, /空格/)
  })

  test('a missing scheme is reported', () => {
    const problems = validateProviderConfig({ ...GOOD, baseUrl: 'api.example.com' })
    assert.ok(problems.some((p) => /http/.test(p)))
  })

  test('http is allowed for LAN endpoints', () => {
    // Ollama and LM Studio serve plaintext on localhost; rejecting them would
    // break a first-class use case.
    const problems = validateProviderConfig({ ...GOOD, baseUrl: 'http://192.168.1.5:11434/v1' })
    assert.deepEqual(problems, [])
  })

  test('an empty API key is advisory, not fatal', () => {
    const problems = validateProviderConfig({ ...GOOD, apiKey: '' })
    assert.equal(problems.length, 1)
    assert.match(problems[0]!, /可忽略/)
  })
})
