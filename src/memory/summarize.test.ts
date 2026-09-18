/**
 * Tests for the memory-summarisation logic.
 *
 * ── Why this file can be pure ───────────────────────────────────────────────
 *
 * The summariser's dangerous parts are not the engine call — that is one
 * `await engine.completion(...)` the store owns. The dangerous parts are the
 * decision ("is it time?") and the text handling ("did the model actually give
 * us a summary?"). Both are pure functions here, so they are pinned down with
 * plain strings and no native module, no database and no fake engine.
 *
 * The failure this suite is really guarding against is silent memory LOSS: a
 * summary that overwrites a good one with a fragment, a trigger that never
 * fires so history is trimmed before it is ever folded, a length cap that does
 * not actually cap Chinese text. None of those throw — they just make the model
 * quietly forget — which is exactly the class of bug that needs tests.
 *
 * Run with:
 *   node --import ./scripts/register-alias.mjs --test src/memory/summarize.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_CHARS_THRESHOLD,
  DEFAULT_SUMMARIZE_CONFIG,
  SUMMARY_PREFIX,
  buildSummaryPrompt,
  buildTranscript,
  cleanSummary,
  countWords,
  formatSummaryForPrompt,
  shouldSummarize,
  toStoredSummary,
  transcriptChars,
} from './summarize.ts'
import type { SummarizeConfig } from './summarize.ts'

const config: SummarizeConfig = { ...DEFAULT_SUMMARIZE_CONFIG }

/** Shorthand: the trigger with everything at rest unless overridden. */
function trigger(overrides: Partial<Parameters<typeof shouldSummarize>[0]> = {}) {
  return shouldSummarize({
    messageCount: 20,
    messagesSinceLastSummary: 0,
    wordsSinceLastSummary: 0,
    config,
    ...overrides,
  })
}

describe('shouldSummarize', () => {
  test('fires at exactly the interval', () => {
    // Inclusive on purpose: "every 10 messages" must mean 10, not 11. An
    // exclusive comparison is the off-by-one nobody notices until a report
    // disagrees with the behaviour.
    assert.equal(trigger({ messagesSinceLastSummary: config.intervalMessages }), true)
  })

  test('does not fire one message short', () => {
    assert.equal(trigger({ messagesSinceLastSummary: config.intervalMessages - 1 }), false)
  })

  test('fires past the interval', () => {
    // A long generation or a backgrounded app can let the count overshoot; the
    // answer must still be yes rather than only at the exact boundary.
    assert.equal(trigger({ messagesSinceLastSummary: config.intervalMessages + 7 }), true)
  })

  test('never fires on an empty conversation', () => {
    // Calling the engine here would spend a whole generation compressing
    // nothing, in the middle of a turn the user is waiting on.
    assert.equal(trigger({ messageCount: 0, messagesSinceLastSummary: 99 }), false)
  })

  test('stays quiet when disabled, even far past both thresholds', () => {
    assert.equal(
      trigger({
        config: { ...config, enabled: false },
        messagesSinceLastSummary: 500,
        wordsSinceLastSummary: 100_000,
      }),
      false,
    )
  })

  test('the length trigger fires before the count trigger', () => {
    // The whole reason there are two triggers: ten long paragraphs blow the
    // window long before ten messages accumulate.
    const long = DEFAULT_CHARS_THRESHOLD + 1
    assert.equal(trigger({ messagesSinceLastSummary: 1, wordsSinceLastSummary: long }), true)
  })

  test('the length trigger is exclusive — exactly at the threshold is not over it', () => {
    // Stated rule is "累计字数超过阈值"; equal is not over.
    assert.equal(trigger({ wordsSinceLastSummary: DEFAULT_CHARS_THRESHOLD }), false)
    assert.equal(trigger({ wordsSinceLastSummary: DEFAULT_CHARS_THRESHOLD + 1 }), true)
  })

  test('a contradictory config cannot fire on a negative delta', () => {
    // A caller that passes a nonsense negative (clock skew, a restored
    // conversation) must not summarise on every single turn.
    assert.equal(trigger({ messagesSinceLastSummary: -5, wordsSinceLastSummary: -5 }), false)
  })
})

describe('buildSummaryPrompt', () => {
  test('includes the new transcript and asks for a fresh summary when there is no history', () => {
    const messages = buildSummaryPrompt({
      transcript: '用户：我叫小明\n角色：你好，小明',
      previousSummary: null,
      maxWords: 200,
    })

    assert.equal(messages.length, 2)
    assert.equal(messages[0]!.role, 'system')
    assert.equal(messages[1]!.role, 'user')
    assert.match(messages[1]!.content, /我叫小明/)
    assert.match(messages[1]!.content, /你好，小明/)
    // Budget must be stated, or a small model writes an essay and the cap has
    // to truncate it.
    assert.match(messages[1]!.content, /200/)
    // No previous summary -> the instruction must not ask to merge with one.
    assert.doesNotMatch(messages[1]!.content, /已有摘要/)
  })

  test('carries the old summary AND the new transcript when extending', () => {
    // This is the incremental contract: the old summary is what makes folding
    // only the delta sufficient. If it is dropped, every pass would have to
    // re-read the whole history.
    const messages = buildSummaryPrompt({
      transcript: '用户：我养了一只猫',
      previousSummary: '[摘要] 用户叫小明，是程序员。',
      maxWords: 150,
    })

    const user = messages[1]!.content
    assert.match(user, /小明/)
    assert.match(user, /程序员/)
    assert.match(user, /我养了一只猫/)
    assert.match(user, /已有摘要/)
    assert.match(user, /合并/)
  })

  test('treats a whitespace-only previous summary as no summary at all', () => {
    const messages = buildSummaryPrompt({
      transcript: '用户：在吗',
      previousSummary: '   \n  ',
      maxWords: 200,
    })
    assert.doesNotMatch(messages[1]!.content, /已有摘要/)
    assert.match(messages[1]!.content, /对话记录/)
  })

  test('produces a usable prompt for an empty transcript', () => {
    // Must not throw and must not produce an empty user message — an empty
    // message is rejected by some chat templates and produces an ungrammatical
    // turn on others.
    const messages = buildSummaryPrompt({ transcript: '', previousSummary: null, maxWords: 200 })
    assert.equal(messages.length, 2)
    assert.ok(messages[1]!.content.trim().length > 0)
  })

  test('honours a non-default budget and a caller-supplied instruction', () => {
    const messages = buildSummaryPrompt({
      transcript: '用户：测试',
      previousSummary: null,
      maxWords: 42,
      instruction: 'CUSTOM-INSTRUCTION',
    })
    assert.equal(messages[0]!.content, 'CUSTOM-INSTRUCTION')
    assert.match(messages[1]!.content, /42/)
  })

  test('never asks the model to produce the [摘要] marker itself', () => {
    // The marker is the app's, not the model's. Letting the model write it is
    // how it ends up doubled or nested on the next pass.
    for (const previousSummary of [null, '[摘要] 旧摘要内容在这里']) {
      const messages = buildSummaryPrompt({
        transcript: '用户：你好',
        previousSummary,
        maxWords: 200,
      })
      assert.match(messages[1]!.content, /不要写/)
    }
  })
})

describe('formatSummaryForPrompt', () => {
  test('prefixes with the marker', () => {
    assert.equal(formatSummaryForPrompt('小明是程序员'), `${SUMMARY_PREFIX} 小明是程序员`)
  })

  test('flattens newlines so the memory stays one block', () => {
    // A multi-line summary is indistinguishable from the persona paragraphs
    // around it once it is spliced into the system prompt.
    const formatted = formatSummaryForPrompt('第一行\n\n第二行\n第三行')
    assert.equal(formatted, `${SUMMARY_PREFIX} 第一行 第二行 第三行`)
    assert.equal(formatted.includes('\n'), false)
  })

  test('returns an empty string for empty, null and whitespace input', () => {
    // A bare marker with nothing after it tells the model there is a memory
    // section and then shows it nothing, which invites it to invent one.
    for (const input of ['', '   ', '\n\n', null, undefined]) {
      assert.equal(formatSummaryForPrompt(input), '')
    }
  })

  test('does not double the marker on an already-formatted summary', () => {
    // Stored summaries are written WITH the marker, so this path runs on every
    // normal read. A doubled marker would grow the prompt a little on each turn.
    const once = formatSummaryForPrompt('小明是程序员')
    assert.equal(formatSummaryForPrompt(once), once)
  })

  test('keeps long summaries intact', () => {
    const long = '细节'.repeat(300)
    const formatted = formatSummaryForPrompt(long)
    assert.ok(formatted.includes(long), 'formatting must not silently truncate')
  })
})

describe('cleanSummary', () => {
  const config200 = { maxWords: 200, minWords: 25 }
  /** A reply comfortably inside the 25..200 word window. */
  const good = '用户叫小明，是一名程序员，住在杭州，养了一只叫团子的猫。他喜欢简洁的回答，讨厌客套话。'

  test('returns null for empty and whitespace-only replies', () => {
    // The core safety property: an empty reply must never erase a working
    // summary. The caller keeps the previous one when it sees null.
    for (const raw of ['', '   ', '\n\t ']) {
      const result = cleanSummary(raw, config200)
      assert.equal(result.summary, null)
      assert.equal(result.rejected, 'empty')
    }
  })

  test('rejects a fragment that is too short', () => {
    // A local model that hit its token cap returns a mid-sentence stub. Storing
    // it would replace a good summary with a quarter of one — worse than not
    // updating, because the memory that worked is gone.
    const result = cleanSummary('用户', config200)
    assert.equal(result.summary, null)
    assert.equal(result.rejected, 'too_short')
  })

  test('truncates an over-long reply instead of rejecting it', () => {
    // The content is there, it is just verbose; the cap exists to protect the
    // prompt window.
    const long = Array.from({ length: 400 }, (_, i) => `词${i}`).join(' ')
    const result = cleanSummary(long, config200)
    assert.equal(result.truncated, true)
    assert.equal(result.rejected, null)
    assert.ok(result.summary !== null)
    assert.ok(countWords(result.summary!) <= 200)
  })

  test('strips the marker and labels the model echoes back', () => {
    const result = cleanSummary(`[摘要] ${good}`, config200)
    assert.ok(result.summary !== null)
    assert.equal(result.summary!.startsWith('摘要'), false)
    assert.equal(result.summary!.startsWith('[摘要]'), false)
  })

  test('strips a conversational preamble', () => {
    const result = cleanSummary(`好的，以下是摘要：${good}`, config200)
    assert.ok(result.summary !== null)
    assert.equal(result.summary!.startsWith('好的'), false)
    assert.ok(result.summary!.startsWith('用户叫小明'))
  })

  test('accepts a Chinese summary at the minimum length', () => {
    // 21 CJK characters must count as 21 "words", not as 1. A naive
    // whitespace tokenizer scores this correct summary as way under budget and
    // rejects it forever, so the minimum-length guard would silently disable
    // Chinese summarisation entirely.
    const exactly = '这是一段刚好达到最小长度要求的中文摘要内容'
    assert.equal([...exactly].length, 21)
    assert.equal(countWords(exactly), 21)
    const result = cleanSummary(exactly, { maxWords: 200, minWords: 21 })
    assert.equal(result.summary, exactly)
  })

  test('collapses newlines so storage and word counting agree', () => {
    const result = cleanSummary(`第一句。\n\n第二句。\n第三句。${'补充细节。'.repeat(8)}`, config200)
    assert.ok(result.summary !== null)
    assert.equal(result.summary!.includes('\n'), false)
  })
})

describe('countWords', () => {
  test('counts each CJK character as one word', () => {
    assert.equal(countWords('你好世界'), 4)
  })

  test('counts Latin text by whitespace-delimited words', () => {
    assert.equal(countWords('the quick brown fox'), 4)
  })

  test('counts a mixed summary without inventing or dropping content', () => {
    // 用户是 = 3 CJK, Python = 1 Latin run, 工程师 = 3 CJK -> 7.
    // The CJK class must be tried BEFORE the Latin run, or the Latin pattern
    // swallows adjacent characters and the count silently drifts.
    assert.equal(countWords('用户是 Python 工程师'), 7)
  })

  test('returns 0 for empty and whitespace input', () => {
    for (const input of ['', '   ', '\n']) assert.equal(countWords(input), 0)
  })

  test('a 200-character Chinese summary scores 200, not 1', () => {
    // The regression this guards: with a naive tokenizer the length cap never
    // engages on Chinese text and the "200 word" summary eats the window it was
    // supposed to protect.
    const chinese = '字'.repeat(200)
    assert.equal(countWords(chinese), 200)
  })
})

describe('buildTranscript', () => {
  test('renders roles as labels and skips empty content', () => {
    const transcript = buildTranscript([
      { role: 'user', content: '我叫小明' },
      { role: 'assistant', content: '   ' },
      { role: 'assistant', content: '你好，小明' },
    ])
    assert.match(transcript, /用户：我叫小明/)
    assert.match(transcript, /角色：你好，小明/)
    assert.equal(transcript.split('\n').length, 2, 'blank rows must not reach the summariser')
  })

  test('prefers an explicit name over the role label', () => {
    const transcript = buildTranscript([{ role: 'assistant', content: '在。', name: '小明' }])
    assert.match(transcript, /小明：在。/)
  })

  test('returns an empty string for an empty history', () => {
    assert.equal(buildTranscript([]), '')
  })
})

describe('transcriptChars', () => {
  test('sums content length across messages', () => {
    assert.equal(
      transcriptChars([
        { role: 'user', content: '一二三' },
        { role: 'assistant', content: '四五' },
      ]),
      5,
    )
  })

  test('is 0 for an empty history', () => {
    assert.equal(transcriptChars([]), 0)
  })
})

describe('toStoredSummary', () => {
  test('adds the marker once', () => {
    const stored = toStoredSummary('小明是程序员')
    assert.equal(stored, `${SUMMARY_PREFIX} 小明是程序员`)
    assert.equal(toStoredSummary(stored), stored)
  })

  test('returns an empty string for empty input', () => {
    assert.equal(toStoredSummary('  '), '')
  })

  test('round-trips through formatSummaryForPrompt without doubling', () => {
    const stored = toStoredSummary('小明是程序员')
    assert.equal(formatSummaryForPrompt(stored), stored)
  })
})
