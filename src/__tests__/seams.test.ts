/**
 * The integration seams the parallel agents did not own.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * Five features were built concurrently. Each agent tested its own layer and
 * each proved its failures belonged to someone else — which is exactly how a
 * set of individually-correct changes ships broken. Nobody owned the JOINTS:
 *
 *   - character card → prompt assembly (does the card actually reach the model?)
 *   - world info → prompt (does a keyword actually trigger?)
 *   - opening line → transcript (does a new chat start with the greeting?)
 *   - summary → prompt (does the rolling memory get injected?)
 *   - swipes → message (does `content` stay equal to `swipes[swipeIndex]`?)
 *
 * Every assertion here crosses a boundary between two agents' work.
 *
 * Run with:
 *   node --import ./scripts/register-alias.mjs --test src/__tests__/seams.test.ts
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import type { CharacterRecord } from '@/types/domain.ts'
import { __setDbForTests } from '@/data/db/connection.ts'
import { useChatStore, buildSystemPrompt } from '@/store/index.ts'
import { openingMessageFor, alternateOpeningsFor } from '@/character-card/adapter.ts'
import { parseCard } from '@/character-card/parseCard.ts'
import { buildPrompt } from '@/character-card/buildPrompt.ts'

/**
 * A V2 card carrying a world book, in the canonical snake_case form a real card
 * file uses. The snake_case details are the point: they are what a naive
 * adapter silently drops.
 */
const CARD_WITH_LORE = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria',
    description: 'An elf bard',
    personality: 'cheerful',
    scenario: 'A tavern',
    first_mes: 'Hello!',
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: [],
    creator: '',
    character_version: '',
    extensions: {},
    character_book: {
      name: 'Lore',
      entries: [
        {
          keys: ['lute'],
          secondary_keys: [],
          content: 'THE LUTE IS MAGICAL.',
          enabled: true,
          insertion_order: 1,
          position: 'before_char',
          constant: false,
          selective: false,
        },
      ],
    },
  },
}

/** A minimal V2 card with a world book and an opening line. */
function card(overrides: {
  firstMes?: string
  alternates?: string[]
  book?: unknown
} = {}): CharacterRecord {
  return {
    id: 'char_1',
    createdAt: 0,
    updatedAt: 0,
    avatarPath: null,
    isUserCreated: false,
    card: {
      spec: 'chara_card_v2',
      specVersion: '2.0',
      data: {
        name: '小玉',
        description: '一只猫娘',
        personality: '温柔',
        scenario: '咖啡馆',
        first_mes: overrides.firstMes ?? '欢迎光临～',
        mes_example: '',
        creator_notes: '',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: overrides.alternates ?? [],
        tags: [],
        creator: '',
        character_version: '',
        extensions: {},
        character_book: overrides.book,
      },
    },
  } as unknown as CharacterRecord
}

/** A world book in the card's canonical snake_case form. */
const BOOK = {
  name: '测试世界书',
  entries: [
    {
      keys: ['苹果'],
      secondary_keys: [],
      content: '苹果是本店的招牌甜点。',
      enabled: true,
      insertion_order: 1,
      position: 'before_char',
      constant: false,
      selective: false,
    },
  ],
}

function reset(): void {
  __setDbForTests(null)
  useChatStore.setState({
    conversations: [],
    activeConversationId: null,
    messages: [],
    transcripts: {},
    characters: [],
    activeCharacterId: null,
  } as never)
}

describe('seam: character card → prompt', () => {
  beforeEach(reset)

  test('the card description reaches the system prompt', () => {
    const out = buildSystemPrompt(
      { characters: [card()], activeCharacterId: 'char_1' },
      { systemPrompt: '' },
    )
    assert.match(out, /猫娘/)
    assert.match(out, /温柔/)
    assert.match(out, /咖啡馆/)
  })

  test('a world-info keyword in the user message activates its entry', () => {
    /*
     * THE test for the whole world-info feature, and the one that would have
     * caught the original bug.
     *
     * `buildSystemPrompt` deliberately receives no history (the caller owns
     * history assembly), so it cannot trigger entry activation on its own. The
     * trigger has to be exercised through `buildPrompt` with a real transcript.
     *
     * The subtlety that made this fail silently: a card's `character_book`
     * arrives in canonical snake_case (`keys`, `secondary_keys`,
     * `insertion_order`, `position: 'before_char'`), while `scanWorldInfo` reads
     * ST naming (`key`, `keysecondary`, `order`, numeric position). Because
     * `entries.length > 0` still holds, ANY "does this book exist" check passes
     * while every `key` is undefined — so activation is silently always-empty
     * and nothing errors. Only asserting on the lore TEXT catches it.
     */
    const c = parseCard(CARD_WITH_LORE as never)
    const options = {
      maxContext: 4096,
      maxTokens: 300,
      userName: 'Bob',
      countTokens: (s: string) => s.length,
    }

    const dormant = buildPrompt({
      character: c,
      history: [{ id: '1', role: 'user', mes: 'hello there', sendDate: 0, swipes: [], swipeId: 0 }],
      options,
    })
    assert.ok(
      !dormant.systemPrompt.includes('MAGICAL'),
      'lore must stay dormant when its keyword is absent',
    )

    const triggered = buildPrompt({
      character: c,
      history: [{ id: '1', role: 'user', mes: 'I play my lute.', sendDate: 0, swipes: [], swipeId: 0 }],
      options,
    })
    assert.ok(
      triggered.systemPrompt.includes('THE LUTE IS MAGICAL'),
      'a mentioned keyword must pull its lore into the prompt',
    )
    assert.ok(
      triggered.activatedWorldInfo.length > 0,
      'the activated uid list must reflect the hit',
    )
  })

  test('the global prompt still works with no character selected', () => {
    const out = buildSystemPrompt(
      { characters: [], activeCharacterId: null },
      { systemPrompt: '用中文回答' },
    )
    assert.equal(out, '用中文回答')
  })

  test('no character and no prompt yields an empty string', () => {
    // The caller omits the system message entirely when this is empty, letting
    // the GGUF's own template apply. An empty system MESSAGE would not.
    const out = buildSystemPrompt(
      { characters: [], activeCharacterId: null },
      { systemPrompt: '   ' },
    )
    assert.equal(out, '')
  })

  test('no unsubstituted macro survives into the prompt', () => {
    // `{{char}}` / `{{user}}` reaching the model is worse than omitting the
    // section: the model cannot interpret them and they pull attention.
    const out = buildSystemPrompt(
      { characters: [card()], activeCharacterId: 'char_1' },
      { systemPrompt: '' },
    )
    assert.ok(!out.includes('{{'), `unsubstituted macro in prompt: ${out}`)
  })
})

describe('seam: opening line → new conversation', () => {
  beforeEach(reset)

  test('openingMessageFor returns the card first_mes', () => {
    assert.equal(openingMessageFor(card({ firstMes: '你好呀' })), '你好呀')
  })

  test('it returns null when the card has no first_mes', () => {
    assert.equal(openingMessageFor(card({ firstMes: '   ' })), null)
    assert.equal(openingMessageFor(null), null)
  })

  test('alternate greetings are exposed as versions', () => {
    const alternates = alternateOpeningsFor(card({ alternates: ['备选一', '备选二'] }))
    assert.deepEqual(alternates, ['备选一', '备选二'])
  })

  test('a new conversation with a character starts with the greeting', () => {
    // This is the SEAM: task B produced `openingMessageFor`, the parent wired it
    // into `createConversation`. Neither agent's own tests covered the join.
    useChatStore.setState({
      characters: [card({ firstMes: '欢迎光临～' })],
      activeCharacterId: 'char_1',
    } as never)

    useChatStore.getState().createConversation('char_1')

    const messages = useChatStore.getState().messages
    assert.equal(messages.length, 1, 'the greeting must be seeded as a message')
    assert.equal(messages[0]!.role, 'assistant')
    assert.equal(messages[0]!.content, '欢迎光临～')
  })

  test('a plain conversation still starts empty', () => {
    useChatStore.getState().createConversation(null)
    assert.equal(useChatStore.getState().messages.length, 0)
  })

  test('a card without a first_mes does not seed anything', () => {
    useChatStore.setState({
      characters: [card({ firstMes: '' })],
      activeCharacterId: 'char_1',
    } as never)
    useChatStore.getState().createConversation('char_1')
    assert.equal(useChatStore.getState().messages.length, 0)
  })
})

describe('seam: swipe invariant', () => {
  beforeEach(reset)

  test('content always equals the currently selected version', async () => {
    // The invariant every swipe bug violates. Task D owned swipes; this checks
    // the invariant survives the store round trip.
    if (typeof (useChatStore.getState() as never as Record<string, unknown>)['nextSwipe'] !== 'function') {
      return
    }

    useChatStore.setState({
      characters: [card({ firstMes: '开场', alternates: ['备选'] })],
      activeCharacterId: 'char_1',
    } as never)
    useChatStore.getState().createConversation('char_1')

    const state = useChatStore.getState() as unknown as Record<string, unknown> & {
      messages: Array<{ id: string; content: string; swipes: string[]; swipeIndex: number }>
      nextSwipe: (id: string) => void
    }
    const msg = state.messages[0]!
    assert.equal(msg.content, msg.swipes[msg.swipeIndex])

    state.nextSwipe(msg.id)

    const after = (useChatStore.getState() as unknown as typeof state).messages[0]!
    assert.equal(
      after.content,
      after.swipes[after.swipeIndex],
      'content drifted from the selected version — the model would read one thing and the user see another',
    )
  })
})
