/**
 * System prompt composition.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The app shipped with no system message at all. The model received only its
 * vendor default ("You are a helpful assistant"), so every "act like X"
 * instruction the user typed into the message history was competing with a
 * stronger, earlier instruction — and small models simply followed the system
 * prompt. On device this looked like "the 0.5B model is too dumb to roleplay",
 * when the actual defect was that the persona was never sent.
 *
 * These tests pin the composition rules, which are the whole fix.
 *
 * Run with:
 *   node --import ./scripts/register-alias.mjs --test src/store/systemPrompt.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { buildSystemPrompt } from '@/store/index.ts'
import type { CharacterCardV2, CharacterRecord } from '@/types/domain.ts'

function character(overrides: Partial<CharacterCardV2['data']> = {}): CharacterRecord {
  const data = {
    name: '小玉',
    description: '一只住在咖啡馆里的猫娘。',
    personality: '温柔、黏人',
    scenario: '午后的咖啡馆',
    first_mes: '主人你回来啦～',
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    character_book: undefined,
    tags: [],
    creator: '',
    character_version: '',
    extensions: {},
    ...overrides,
  }
  return {
    id: 'char_1',
    card: { spec: 'chara_card_v2', spec_version: '2.0', data } as CharacterCardV2,
    avatarPath: null,
    isUserCreated: false,
    createdAt: 0,
    updatedAt: 0,
  }
}

const NO_SETTINGS = { systemPrompt: '' }
const NO_CHARACTER = { characters: [] as CharacterRecord[], activeCharacterId: null }

describe('buildSystemPrompt', () => {
  test('returns empty when there is nothing to say', () => {
    // Empty string — NOT an empty system message. Sending
    // `{role:'system', content:''}` renders differently across chat templates,
    // so the caller must omit the message entirely.
    assert.equal(buildSystemPrompt(NO_CHARACTER, NO_SETTINGS), '')
  })

  test('uses the global prompt when no character is selected', () => {
    const out = buildSystemPrompt(NO_CHARACTER, { systemPrompt: '回答尽量简短。' })
    assert.equal(out, '回答尽量简短。')
  })

  test('trims the global prompt and ignores whitespace-only input', () => {
    assert.equal(buildSystemPrompt(NO_CHARACTER, { systemPrompt: '   \n  ' }), '')
    assert.equal(
      buildSystemPrompt(NO_CHARACTER, { systemPrompt: '  简短回答  ' }),
      '简短回答',
    )
  })

  test('builds a persona from the character card', () => {
    const out = buildSystemPrompt(
      { characters: [character()], activeCharacterId: 'char_1' },
      NO_SETTINGS,
    )
    // Name is load-bearing: everything downstream (self-reference, staying in
    // character) depends on the model knowing what it is called.
    assert.match(out, /小玉/)
    assert.match(out, /猫娘/)
    assert.match(out, /温柔/)
    assert.match(out, /咖啡馆/)
  })

  test('character comes BEFORE the global prompt', () => {
    // Order is the design: appending the global prompt makes it an *additional
    // instruction*. Putting it first would let a long card description bury it.
    const out = buildSystemPrompt(
      { characters: [character()], activeCharacterId: 'char_1' },
      { systemPrompt: '用中文回答。' },
    )
    const charAt = out.indexOf('猫娘')
    const globalAt = out.indexOf('用中文回答')
    assert.ok(charAt >= 0 && globalAt >= 0)
    assert.ok(charAt < globalAt, 'character text must precede the global prompt')
  })

  test('the card system_prompt field is included when present', () => {
    const out = buildSystemPrompt(
      {
        characters: [character({ system_prompt: '永远不要打破角色。' })],
        activeCharacterId: 'char_1',
      },
      NO_SETTINGS,
    )
    assert.match(out, /永远不要打破角色/)
  })

  test('an unknown activeCharacterId degrades to the global prompt', () => {
    // Dangling id happens when a card is deleted while a conversation still
    // references it. This must not throw and must not silently send an empty
    // prompt.
    const out = buildSystemPrompt(
      { characters: [character()], activeCharacterId: 'deleted_id' },
      { systemPrompt: '备用指令' },
    )
    assert.equal(out, '备用指令')
  })

  test('a card with no usable fields does not produce a bare heading', () => {
    const empty = character({
      name: '',
      description: '',
      personality: '',
      scenario: '',
      system_prompt: '',
    })
    const out = buildSystemPrompt(
      { characters: [empty], activeCharacterId: 'char_1' },
      NO_SETTINGS,
    )
    assert.equal(out, '')
  })
})
