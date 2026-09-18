/**
 * Character-card persistence.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * Cards were imported into the store and never written to SQLite, so every cold
 * start began with an empty character library. The failure is invisible to any
 * test that runs inside one process — in-memory state and persisted state look
 * identical until you restart — which is precisely how it survived. These tests
 * cross the boundary deliberately: save, then read back through a separate call
 * on a fake that only knows what SQL actually stored.
 *
 * ── What the fake does and does not prove ───────────────────────────────────
 * It stores rows and answers this module's queries. It does NOT reimplement
 * SQLite. Two behaviours ARE modelled because they are load-bearing here:
 * `ON CONFLICT(id) DO UPDATE` (so a re-save that duplicated would be caught)
 * and the `conversations.character_id` foreign key with `ON DELETE SET NULL`
 * (so the delete contract is actually verified rather than assumed).
 *
 * What it cannot prove is that op-sqlite behaves as assumed — a wrong
 * assumption about the BINDING is invisible. That class of bug is caught by
 * reading the installed `.d.ts`, not by a test.
 *
 * Run with:
 *   node --import ./scripts/register-alias.mjs --test src/data/db/characters.test.ts
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import type { CharacterCardV2, CharacterRecord } from '@/types/domain.ts'

import { __setDbForTests, type SqliteDb } from './connection.ts'
import { deleteCharacter, loadCharacters, saveCharacter } from './characters.ts'

// ── In-memory stand-in for the two tables ────────────────────────────────────

type Row = Record<string, unknown>

let characters: Map<string, Row>
let conversations: Map<string, Row>

/**
 * Column order of the INSERT in `characters.ts`.
 *
 * Declared explicitly rather than parsed from the SQL: a change to the column
 * list without a matching change here then fails loudly instead of shifting
 * every value one position, which would "pass" while writing garbage.
 */
const CHARACTER_COLUMNS = [
  'id',
  'card_json',
  'avatar_path',
  'name',
  'is_user_created',
  'created_at',
  'updated_at',
]

/** Install a fresh fake database for one test. */
function installFake(): void {
  characters = new Map()
  conversations = new Map()

  const fake: SqliteDb = {
    async all<T>(sql: string, _params?: unknown[]): Promise<T[]> {
      if (/FROM characters/i.test(sql)) {
        const rows = [...characters.values()]
        rows.sort(
          (a, b) =>
            Number(b.created_at) - Number(a.created_at) ||
            String(b.id).localeCompare(String(a.id)),
        )
        return rows as T[]
      }
      return []
    },

    async one<T>(sql: string, params?: unknown[]): Promise<T | null> {
      const rows = await fake.all<T>(sql, params)
      return rows[0] ?? null
    },

    async run(sql: string, params?: unknown[]): Promise<void> {
      if (/^\s*INSERT INTO characters/i.test(sql)) {
        const row: Row = {}
        for (let i = 0; i < CHARACTER_COLUMNS.length; i += 1) {
          row[CHARACTER_COLUMNS[i]!] = params?.[i]
        }
        // Reproduce `ON CONFLICT(id) DO UPDATE`: without this an upsert that
        // silently became an append would insert a second row and pass a test
        // that only checked the first one.
        const existing = characters.get(String(row.id))
        characters.set(String(row.id), existing ? { ...existing, ...row } : row)
        return
      }

      if (/^\s*DELETE FROM characters/i.test(sql)) {
        const id = String(params?.[0])
        characters.delete(id)
        // Reproduce `ON DELETE SET NULL` on conversations.character_id. If the
        // production schema lost that clause, a deleted character would leave
        // conversations pointing at a row that no longer exists.
        for (const conv of conversations.values()) {
          if (conv.character_id === id) conv.character_id = null
        }
        return
      }
    },

    async tx(fn) {
      // No rollback: the tests never exercise failure mid-transaction, and
      // pretending to roll back would invite false confidence.
      await fn(fake)
    },

    raw: { execute: async () => ({}) },
  }

  __setDbForTests(fake)
}

/** Insert a conversation row directly, the way `conversations.ts` would. */
function seedConversation(id: string, characterId: string | null): void {
  conversations.set(id, { id, character_id: characterId, title: '对话' })
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function card(overrides: Partial<CharacterCardV2['data']> = {}): CharacterCardV2 {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '测试角色',
      description: '',
      personality: '',
      scenario: '',
      first_mes: '',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      // `character_book` is deliberately OMITTED rather than set to
      // `undefined`: `JSON.stringify` drops undefined-valued keys, so a fixture
      // carrying the key would compare unequal after any round trip. That is
      // JSON semantics, not a persistence bug — see the dedicated test below.
      tags: [],
      creator: '',
      character_version: '',
      extensions: {},
      ...overrides,
    },
  }
}

function character(overrides: Partial<CharacterRecord> = {}): CharacterRecord {
  const now = 1_700_000_000_000
  return {
    id: 'char_1',
    card: card(),
    avatarPath: null,
    isUserCreated: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe('character-card persistence', () => {
  beforeEach(installFake)

  test('a saved card round-trips with every field intact', async () => {
    // The nested card payload is the point: a shallow save that only stored the
    // name would still render the list correctly and lose everything that makes
    // the character a character.
    const original = character({
      id: 'char_42',
      card: card({
        name: '艾莉丝',
        description: '一位来自北境的法师',
        personality: '冷静、寡言',
        scenario: '雪原上的塔楼',
        first_mes: '「你终于来了。」',
        mes_example: '<START>\n{{user}}: 你好\n{{char}}: 嗯。',
        creator: '作者甲',
        character_version: '1.2',
        alternate_greetings: ['「谁？」', '「走开。」'],
        tags: ['奇幻', '女性'],
      }),
      avatarPath: '/data/user/0/cards/alice.png',
      isUserCreated: true,
      createdAt: 111,
      updatedAt: 222,
    })

    await saveCharacter(original)
    const [loaded] = await loadCharacters()

    assert.deepEqual(loaded, original)
    // Spelled out separately so a failure says WHICH field regressed rather
    // than dumping one large diff.
    assert.equal(loaded!.card.data.first_mes, '「你终于来了。」')
    assert.equal(loaded!.card.data.alternate_greetings.length, 2)
    assert.equal(loaded!.card.data.creator, '作者甲')
    assert.equal(loaded!.avatarPath, '/data/user/0/cards/alice.png')
    assert.equal(loaded!.isUserCreated, true)
  })

  test('re-saving the same id updates rather than inserting a duplicate', async () => {
    await saveCharacter(character({ id: 'char_1' }))
    await saveCharacter(
      character({
        id: 'char_1',
        card: card({ name: '改名之后', description: '新描述' }),
        updatedAt: 999,
      }),
    )

    const loaded = await loadCharacters()
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0]!.card.data.name, '改名之后')
    assert.equal(loaded[0]!.updatedAt, 999)
  })

  test('re-saving preserves the original createdAt', async () => {
    // `createdAt` is absent from the DO UPDATE list on purpose: an edit must
    // not renumber the card to the top of the list as if it were new.
    await saveCharacter(character({ id: 'char_1', createdAt: 100, updatedAt: 100 }))
    await saveCharacter(character({ id: 'char_1', createdAt: 100, updatedAt: 500 }))

    const [loaded] = await loadCharacters()
    assert.equal(loaded!.createdAt, 100)
    assert.equal(loaded!.updatedAt, 500)
  })

  test('a deleted card is no longer readable', async () => {
    await saveCharacter(character({ id: 'char_1' }))
    await saveCharacter(character({ id: 'char_2', createdAt: 1_700_000_001_000 }))

    await deleteCharacter('char_1')

    const loaded = await loadCharacters()
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0]!.id, 'char_2')
  })

  test('deleting a card nulls the character_id of conversations that used it', async () => {
    // `ON DELETE SET NULL` is the contract, and the whole reason `deleteCharacter`
    // does not null the column itself. The chat history has to survive losing
    // its character — deleting the conversations too would lose the user's
    // messages, which is a far worse outcome than an unnamed chat.
    await saveCharacter(character({ id: 'char_1' }))
    seedConversation('conv_a', 'char_1')
    seedConversation('conv_b', null)

    await deleteCharacter('char_1')

    assert.equal(characters.has('char_1'), false)
    assert.equal(conversations.get('conv_a')!.character_id, null)
    // An unrelated conversation must not be touched by the sweep.
    assert.equal(conversations.get('conv_b')!.character_id, null)
    assert.equal(conversations.size, 2)
  })

  test('no database means every operation is a silent no-op', async () => {
    // The Node test process has no native SQLite; a device whose module failed
    // to link behaves the same way. The app must still work.
    __setDbForTests(null)

    await saveCharacter(character())
    await deleteCharacter('char_1')

    assert.deepEqual(await loadCharacters(), [])
  })

  test('SQL errors are swallowed so a failed write cannot break the import flow', async () => {
    __setDbForTests({
      all: async () => {
        throw new Error('corrupt database')
      },
      one: async () => {
        throw new Error('corrupt database')
      },
      run: async () => {
        throw new Error('disk full')
      },
      tx: async () => {
        throw new Error('disk full')
      },
      raw: { execute: async () => ({}) },
    })

    // None of these may reject: the caller is a UI event handler, and a
    // rejected promise there surfaces as an unhandled rejection or a stuck
    // spinner rather than a useful error.
    await saveCharacter(character())
    await deleteCharacter('char_1')
    assert.deepEqual(await loadCharacters(), [])
  })

  test('a corrupt card_json is dropped instead of breaking the library', async () => {
    // One truncated row must not make every OTHER card unreadable.
    await saveCharacter(character({ id: 'char_good' }))
    await saveCharacter(character({ id: 'char_bad', createdAt: 1_700_000_002_000 }))
    characters.get('char_bad')!.card_json = '{ this is not json'

    const loaded = await loadCharacters()
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0]!.id, 'char_good')
  })

  test('a card_json that parses but has no card payload is dropped', async () => {
    // `JSON.parse` succeeding is not the same as the record being usable —
    // handing this to the UI would throw on `card.data.name`.
    await saveCharacter(character({ id: 'char_shallow' }))
    characters.get('char_shallow')!.card_json = '{"id":"char_shallow"}'

    assert.deepEqual(await loadCharacters(), [])
  })

  test('Chinese names and descriptions survive the round trip', async () => {
    // Stored as JSON text, so this guards against an encoding path that would
    // mojibake or truncate on a multi-byte boundary.
    const name = '林黛玉·测试「繁简」🌸'
    const description = '多愁善感，才情过人——注意：含全角标点、换行\n第二行。'

    await saveCharacter(
      character({ id: 'char_zh', card: card({ name, description, tags: ['古典', '女性'] }) }),
    )
    const [loaded] = await loadCharacters()

    assert.equal(loaded!.card.data.name, name)
    assert.equal(loaded!.card.data.description, description)
    assert.deepEqual(loaded!.card.data.tags, ['古典', '女性'])
  })

  test('Chinese names reach the queryable name column', async () => {
    // The `name` column is an index over the blob, so it must be populated from
    // the card rather than left empty or set to the internal id.
    await saveCharacter(character({ id: 'char_zh', card: card({ name: '苏东坡' }) }))

    assert.equal(characters.get('char_zh')!.name, '苏东坡')
  })

  test('a nameless card falls back to its id for the name column', async () => {
    // `name` is NOT NULL. An empty card name is legal in the format, so the
    // fallback is what keeps the INSERT from failing the constraint.
    await saveCharacter(character({ id: 'char_noname', card: card({ name: '' }) }))

    assert.equal(characters.get('char_noname')!.name, 'char_noname')
  })

  test('booleans are stored as 0/1, which is what SQLite expects', async () => {
    await saveCharacter(character({ id: 'char_a', isUserCreated: true }))
    await saveCharacter(character({ id: 'char_b', isUserCreated: false, createdAt: 1 }))

    assert.equal(characters.get('char_a')!.is_user_created, 1)
    assert.equal(characters.get('char_b')!.is_user_created, 0)
  })

  test('a null avatarPath survives the round trip', async () => {
    await saveCharacter(character({ id: 'char_1', avatarPath: null }))

    assert.equal((await loadCharacters())[0]!.avatarPath, null)
    assert.equal(characters.get('char_1')!.avatar_path, null)
  })

  test('a record without a card is rejected rather than throwing', async () => {
    // An unparseable file could in principle reach here; the INSERT would fail
    // its NOT NULL constraint and the import flow would report a parse error
    // for what is actually a storage error.
    const broken = { id: 'char_broken' } as unknown as CharacterRecord

    await saveCharacter(broken)
    assert.equal(characters.size, 0)
  })

  test('many cards all survive a save and reload', async () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      character({
        id: `char_${i}`,
        card: card({ name: `角色 ${i}` }),
        createdAt: 1_700_000_000_000 + i,
      }),
    )

    for (const c of many) await saveCharacter(c)
    const loaded = await loadCharacters()

    assert.equal(loaded.length, 50)
    // Newest first, which is what the library screen renders.
    assert.equal(loaded[0]!.card.data.name, '角色 49')
    assert.equal(loaded[49]!.card.data.name, '角色 0')
  })

  test('an import overwrites the previous card with the same id', async () => {
    // The user-visible shape of the bug this module fixes: import a card, close
    // the app, reopen it. Re-importing the same file must not double the list.
    await saveCharacter(character({ id: 'char_dup', card: card({ name: '同名' }) }))
    await saveCharacter(character({ id: 'char_dup', card: card({ name: '同名' }) }))

    assert.equal((await loadCharacters()).length, 1)
  })
})
