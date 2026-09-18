/**
 * Context-window trimming.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * `generate()` used to send the ENTIRE conversation with no trimming. Past the
 * context window the behaviour is not "slightly worse" — llama.cpp either
 * refuses the prompt or silently discards the oldest tokens, so the model loses
 * the start of the conversation with no indication. The persona lives at the
 * start, so the visible symptom is that a character silently stops being in
 * character partway through a long chat.
 *
 * The assertions below pin the policy, not the implementation: what survives,
 * what is dropped, and in which order.
 *
 * Run with:
 *   node --import ./scripts/register-alias.mjs --test src/inference/contextWindow.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import type { ChatMessage } from '@/inference/InferenceEngine.ts'
import {
  MIN_RECENT_MESSAGES,
  REPLY_RESERVE_TOKENS,
  contextUsage,
  trimToContext,
} from '@/inference/contextWindow.ts'

/** A deterministic stand-in for a tokenizer: one token per character. */
const charCounter = (text: string): number => text.length

function user(content: string): ChatMessage {
  return { role: 'user', content }
}
function assistant(content: string): ChatMessage {
  return { role: 'assistant', content }
}
function system(content: string): ChatMessage {
  return { role: 'system', content }
}

/** Build N alternating turns of a fixed size. */
function turns(n: number, size = 10): ChatMessage[] {
  const out: ChatMessage[] = []
  for (let i = 0; i < n; i += 1) {
    out.push(user(`u${i}`.padEnd(size, 'x')))
    out.push(assistant(`a${i}`.padEnd(size, 'y')))
  }
  return out
}

describe('trimToContext', () => {
  test('a short conversation is passed through untouched', () => {
    const history = [user('你好'), assistant('你好呀')]
    const result = trimToContext([], history, {
      contextLength: 4096,
      counter: charCounter,
    })

    assert.equal(result.trimmed, false)
    assert.equal(result.droppedCount, 0)
    assert.deepEqual(result.messages, history)
  })

  test('the system prompt is never trimmed', () => {
    // Losing the persona is worse than losing old small talk: it changes who
    // the model is, and the user sees a character break rather than a shorter
    // memory.
    const persona = system('你是一只猫，说话要带喵')
    const long = turns(200)

    const result = trimToContext([persona], long, {
      contextLength: 500,
      counter: charCounter,
    })

    assert.equal(result.messages[0]!.role, 'system')
    assert.equal(result.messages[0]!.content, persona.content)
  })

  test('the newest turns are the ones that survive', () => {
    const history = turns(100)

    const result = trimToContext([], history, {
      contextLength: 300,
      counter: charCounter,
    })

    // The last message must always be present: it is the one being replied to.
    assert.deepEqual(result.messages.at(-1), history.at(-1))
    // And what survived must be a contiguous tail, not scattered picks.
    const kept = result.messages
    const tail = history.slice(history.length - kept.length)
    assert.deepEqual(kept, tail)
  })

  test('trimming happens from the front, never the middle', () => {
    // Dropping a MIDDLE message invalidates the whole KV-cache prefix, making
    // the next turn pay a full prefill.
    const history = turns(50)
    const result = trimToContext([], history, {
      contextLength: 200,
      counter: charCounter,
    })

    const firstKeptIndex = history.indexOf(result.messages[0]!)
    const expectedFirst = history.length - result.messages.length
    assert.equal(firstKeptIndex, expectedFirst, 'kept messages must be a suffix')
  })

  test('the reply reserve is subtracted from the budget', () => {
    // Without the reserve, a prompt that exactly fills the window leaves no
    // room to generate and the reply comes back empty.
    const history: ChatMessage[] = []
    for (let i = 0; i < 100; i += 1) {
      history.push(user('x'.repeat(50)))
      history.push(assistant('y'.repeat(50)))
    }

    // A window comfortably larger than the reserve, so the full reserve applies.
    const result = trimToContext([], history, {
      contextLength: 4000,
      counter: charCounter,
    })

    assert.ok(
      result.promptTokens <= 4000 - REPLY_RESERVE_TOKENS,
      `prompt of ${result.promptTokens} must leave room for the reply`,
    )
  })

  test('the reserve is capped on a small window instead of eating it whole', () => {
    // A flat 1024-token reserve on a 1024-token window would consume the entire
    // budget, trimming away every message and leaving the model answering with
    // no history at all.
    const history = turns(20)

    const result = trimToContext([], history, {
      contextLength: 1024,
      counter: charCounter,
    })

    assert.ok(
      result.messages.length > MIN_RECENT_MESSAGES,
      'a small window must still carry a usable history',
    )
    // Half the window is available to the prompt, so it must not exceed that.
    assert.ok(
      result.promptTokens <= 1024 * 0.5 + 4 * result.messages.length,
      `prompt of ${result.promptTokens} should fit the capped budget`,
    )
  })

  test('a lone leading assistant turn is dropped', () => {
    // Trimming can land between a question and its answer. Sending an answer
    // with no question makes the model talk to itself, and some chat templates
    // reject a history that does not start with a user turn.
    const history: ChatMessage[] = [
      user('x'.repeat(500)),
      assistant('y'.repeat(500)),
      user('短'),
      assistant('短'),
    ]

    const result = trimToContext([], history, {
      contextLength: 100,
      counter: charCounter,
    })

    assert.equal(result.messages[0]!.role, 'user', 'history must start with a user turn')
  })

  test('a genuinely recent history is never collapsed to nothing', () => {
    // A guard against a tiny window or an enormous system prompt wiping out the
    // conversation entirely: an empty prompt is a worse failure than an
    // over-budget one.
    const history = turns(20)

    const result = trimToContext([], history, {
      contextLength: 1, // absurdly small on purpose
      counter: charCounter,
    })

    assert.ok(
      result.messages.length >= MIN_RECENT_MESSAGES,
      `expected at least ${MIN_RECENT_MESSAGES} messages, got ${result.messages.length}`,
    )
  })

  test('the reported prompt size matches what is actually sent', () => {
    const history = turns(50)
    const result = trimToContext([], history, {
      contextLength: 400,
      counter: charCounter,
    })

    // The reported figure is what the UI shows; it must describe the real
    // payload or it is worse than showing nothing.
    const measured =
      result.messages.reduce((sum, m) => sum + m.content.length, 0) +
      result.messages.length * 4
    assert.equal(result.promptTokens, measured)
  })

  test('the result is flagged as estimated without a real tokenizer', () => {
    // An estimate must not be presented with the same confidence as a
    // measurement.
    const withCounter = trimToContext([], turns(3), {
      contextLength: 4096,
      counter: charCounter,
    })
    const withoutCounter = trimToContext([], turns(3), { contextLength: 4096 })

    assert.equal(withCounter.estimated, false)
    assert.equal(withoutCounter.estimated, true)
  })

  test('an empty history is handled', () => {
    const result = trimToContext([system('p')], [], {
      contextLength: 100,
      counter: charCounter,
    })

    assert.equal(result.messages.length, 1)
    assert.equal(result.trimmed, false)
  })

  test('history identical in size to the budget is kept', () => {
    // Off-by-one check: a prompt that exactly fits must not be trimmed.
    const history = [user('x'.repeat(50))]
    const cost = 50 + 4 // content + per-message overhead
    const result = trimToContext([], history, {
      contextLength: cost,
      reserveForReply: 0,
      counter: charCounter,
    })

    assert.equal(result.trimmed, false)
    assert.equal(result.messages.length, 1)
  })

  test('droppedCount matches what was actually dropped', () => {
    const history = turns(60)
    const result = trimToContext([], history, {
      contextLength: 200,
      counter: charCounter,
    })

    assert.equal(result.droppedCount, history.length - result.messages.length)
    assert.equal(result.trimmed, result.droppedCount > 0)
  })
})

describe('contextUsage', () => {
  /**
   * `contextUsage` deliberately does NOT take a counter — it is called on every
   * render to draw a progress bar, and running a real tokenizer there would be
   * wasteful. So it always uses the character heuristic, which is roughly
   * 4 Latin characters per token (see `estimateTokens`). These expectations are
   * written against that heuristic rather than against a 1:1 ratio.
   */
  const TOKENS_PER_LATIN_CHAR = 4

  test('an empty conversation reports zero', () => {
    assert.equal(contextUsage([], [], 4096), 0)
  })

  test('a conversation using the whole window reports one', () => {
    const history = [user('x'.repeat(4096 * TOKENS_PER_LATIN_CHAR))]
    assert.ok(contextUsage([], history, 4096) >= 1)
  })

  test('a half-full conversation reports about a half', () => {
    const history = [user('x'.repeat(2000 * TOKENS_PER_LATIN_CHAR))]
    const usage = contextUsage([], history, 4096)
    assert.ok(usage > 0.4 && usage < 0.6, `expected ~0.5, got ${usage}`)
  })

  test('it never exceeds one, even when over budget', () => {
    // A bar that overflows its track is a rendering bug; clamp instead.
    const history = [user('x'.repeat(100_000))]
    assert.equal(contextUsage([], history, 4096), 1)
  })

  test('a zero context length does not divide by zero', () => {
    assert.equal(contextUsage([], [user('hi')], 0), 0)
  })
})
