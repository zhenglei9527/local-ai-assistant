import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  countTokens,
  countTokensSync,
  estimateTokens,
  makeLlamaTokenCounter,
  type TokenCounter,
} from './tokenizer.ts'

describe('estimateTokens (fallback heuristic)', () => {
  test('empty string is zero', () => {
    assert.equal(estimateTokens(''), 0)
  })

  test('latin text uses ~4 chars per token', () => {
    assert.equal(estimateTokens('abcdefgh'), 2)
    assert.equal(estimateTokens('abcd'), 1)
  })

  test('CJK is counted per character', () => {
    assert.equal(estimateTokens('你好世界'), 4)
  })

  test('mixed text sums both parts', () => {
    // 4 CJK + 4 latin -> 4 + 1
    assert.equal(estimateTokens('你好世界abcd'), 5)
  })

  test('includes CJK extensions, kana, hangul and CJK punctuation', () => {
    assert.equal(estimateTokens('あ'), 1) // hiragana
    assert.equal(estimateTokens('ア'), 1) // katakana
    assert.equal(estimateTokens('한'), 1) // hangul
    assert.equal(estimateTokens('，'), 1) // fullwidth comma
    assert.equal(estimateTokens('\u3400'), 1) // CJK ext A
    assert.equal(estimateTokens('\uf900'), 1) // compatibility ideograph
  })
})

describe('countTokens with a real counter', () => {
  test('uses the real counter and reports estimated=false', async () => {
    const counter: TokenCounter = () => 42
    const result = await countTokens('anything', counter)
    assert.equal(result.count, 42)
    assert.equal(result.estimated, false)
  })

  test('awaits an async counter', async () => {
    const counter: TokenCounter = async () => 7
    const result = await countTokens('x', counter)
    assert.equal(result.count, 7)
    assert.equal(result.estimated, false)
  })

  test('falls back to the heuristic when no counter is supplied', async () => {
    const result = await countTokens('你好世界', null)
    assert.equal(result.count, 4)
    assert.equal(result.estimated, true)
  })

  test('a throwing counter falls back rather than propagating', async () => {
    // A crashing tokenizer must not take down a chat turn.
    const counter: TokenCounter = () => {
      throw new Error('native context disposed')
    }
    const result = await countTokens('你好世界', counter)
    assert.equal(result.count, 4)
    assert.equal(result.estimated, true)
  })

  test('a rejecting async counter falls back', async () => {
    const counter: TokenCounter = async () => {
      throw new Error('boom')
    }
    const result = await countTokens('abcd', counter)
    assert.equal(result.count, 1)
    assert.equal(result.estimated, true)
  })

  test('NaN from a counter falls back — NaN would silently disable budget checks', async () => {
    // NaN makes every comparison false, so a "does this fit?" guard would
    // never fire and the request would run past the context window.
    const counter: TokenCounter = () => Number.NaN
    const result = await countTokens('abcd', counter)
    assert.equal(result.count, 1)
    assert.equal(result.estimated, true)
  })

  test('Infinity from a counter falls back', async () => {
    const counter: TokenCounter = () => Number.POSITIVE_INFINITY
    const result = await countTokens('abcd', counter)
    assert.equal(result.estimated, true)
  })

  test('a negative count falls back', async () => {
    const counter: TokenCounter = () => -5
    const result = await countTokens('abcd', counter)
    assert.equal(result.estimated, true)
  })

  test('zero from a real counter is honoured, not treated as missing', async () => {
    // Empty string in a real vocabulary is genuinely 0 tokens, and 0 is the
    // one falsy number that must NOT trigger the fallback.
    const counter: TokenCounter = () => 0
    const result = await countTokens('', counter)
    assert.equal(result.count, 0)
    assert.equal(result.estimated, false)
  })
})

describe('countTokensSync', () => {
  test('uses a synchronous counter', () => {
    const result = countTokensSync('abcd', () => 11)
    assert.equal(result.count, 11)
    assert.equal(result.estimated, false)
  })

  test('falls back when counter returns a Promise', () => {
    const result = countTokensSync('abcd', async () => 11)
    assert.equal(result.count, 1)
    assert.equal(result.estimated, true)
  })

  test('falls back when no counter', () => {
    const result = countTokensSync('你好世界')
    assert.equal(result.count, 4)
    assert.equal(result.estimated, true)
  })
})

describe('makeLlamaTokenCounter', () => {
  test('adapts llama.rn tokenize() into a TokenCounter', async () => {
    // Mirrors the real shape: Promise<{ tokens: number[] }>
    const fakeContext = {
      tokenize: async (_text: string) => ({ tokens: [1, 2, 3, 4, 5] }),
    }
    const counter = makeLlamaTokenCounter(fakeContext)
    const result = await countTokens('hello', counter)
    assert.equal(result.count, 5)
    assert.equal(result.estimated, false)
  })

  test('passes the text through unchanged', async () => {
    let seen: string | null = null
    const fakeContext = {
      tokenize: async (text: string) => {
        seen = text
        return { tokens: [] }
      },
    }
    const counter = makeLlamaTokenCounter(fakeContext)
    await countTokens('猫娘', counter)
    assert.equal(seen, '猫娘')
  })

  test('a real-vocabulary count beats the heuristic for Chinese', async () => {
    // The whole point: BPE often packs 1-2 Chinese chars per token, so the
    // heuristic's 1-token-per-char over-counts and truncates too early.
    const fakeContext = {
      tokenize: async (text: string) => ({
        tokens: new Array(Math.ceil([...text].length / 2)).fill(0),
      }),
    }
    const counter = makeLlamaTokenCounter(fakeContext)
    const text = '你好世界你好世界' // 8 chars
    const real = await countTokens(text, counter)
    const heuristic = await countTokens(text)
    assert.equal(real.count, 4)
    assert.equal(heuristic.count, 8)
    assert.ok(
      real.count < heuristic.count,
      'real tokenizer should count fewer tokens than the high-biased heuristic',
    )
  })
})
