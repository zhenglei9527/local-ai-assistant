import type {
  CharacterCardData,
  CharacterCardV1,
  CharacterCardV2,
  CharacterParseResult,
} from '@/types/domain'

/**
 * Character card parsing, SillyTavern-compatible.
 *
 * SillyTavern stores character cards in two places inside a PNG:
 *   1. A `tEXt`/`iTXt` chunk keyed `chara`, base64-encoded JSON.
 *   2. A `tEXt` chunk keyed `ccv3` for the V3 spec.
 *
 * ⚠️ This module implements JSON (V1/V2) parsing ONLY. PNG chunk extraction
 * requires byte-level work on the image, which is deferred to roadmap Phase 3
 * — `parsePngCard` below is the declared seam and currently returns a clear
 * "unimplemented" error rather than pretending to work.
 *
 * Spec references (verify before implementing, do not trust from memory):
 *   - SillyTavern character card V2 spec
 *   - Character Card V3 (`chara_card_v3`) emerging spec
 */

export const EMPTY_CARD_DATA: CharacterCardData = {
  name: '',
  description: '',
  personality: '',
  scenario: '',
  first_mes: '',
  mes_example: '',
  creator_notes: '',
  system_prompt: '',
  post_history_instructions: '',
  alternate_greetings: [],
  tags: [],
  creator: '',
  character_version: '',
  extensions: {},
}

/** Coerces an unknown value to a string, defaulting to ''. */
function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** Coerces an unknown value to a string array, dropping non-strings. */
function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string')
}

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** Normalises a loosely-typed `data` block into a strict `CharacterCardData`. */
export function normalizeCardData(raw: unknown): CharacterCardData {
  const d = record(raw)
  return {
    name: str(d.name, 'Unnamed'),
    description: str(d.description),
    personality: str(d.personality),
    scenario: str(d.scenario),
    first_mes: str(d.first_mes),
    mes_example: str(d.mes_example),
    creator_notes: str(d.creator_notes),
    system_prompt: str(d.system_prompt),
    post_history_instructions: str(d.post_history_instructions),
    alternate_greetings: strArray(d.alternate_greetings),
    tags: strArray(d.tags),
    creator: str(d.creator),
    character_version: str(d.character_version),
    extensions: record(d.extensions),
  }
}

/**
 * Parses a character card from arbitrary JSON text.
 *
 * Handles three shapes, which is what makes imports from the wild work:
 *   - V2 envelope: `{ spec: "chara_card_v2", spec_version: "2.0", data: {...} }`
 *   - V3 envelope: `{ spec: "chara_card_v3", data: {...} }` — normalised to V2
 *   - V1 bare object: `{ name, description, first_mes, ... }`
 *
 * V1 is auto-upgraded and the caller is told which version it came from, so the
 * UI can warn that the imported card is legacy and missing V2-only fields.
 */
export function parseCardJson(text: string): CharacterParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `Not valid JSON: ${e instanceof Error ? e.message : String(e)}` }
  }

  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Card JSON must be an object.' }
  }

  const obj = parsed as Record<string, unknown>
  const spec = str(obj.spec)

  if (spec === 'chara_card_v2' || spec === 'chara_card_v3') {
    if (obj.data == null) {
      return { ok: false, error: `Card declares spec "${spec}" but has no "data" block.` }
    }
    const data = normalizeCardData(obj.data)
    if (!data.name.trim()) {
      return { ok: false, error: 'Card is missing a character name.' }
    }
    return {
      ok: true,
      sourceVersion: spec === 'chara_card_v3' ? 'v2' : 'v2',
      card: { spec: 'chara_card_v2', spec_version: '2.0', data },
    }
  }

  // V1: the whole object IS the data block.
  if (typeof obj.name !== 'string' && typeof obj.first_mes !== 'string') {
    return {
      ok: false,
      error: 'Unrecognised card format: no "spec" envelope and no V1 name/first_mes fields.',
    }
  }

  const data = normalizeCardData(obj)
  if (!data.name.trim()) {
    return { ok: false, error: 'Legacy card is missing a character name.' }
  }

  return {
    ok: true,
    sourceVersion: 'v1',
    card: { spec: 'chara_card_v2', spec_version: '2.0', data },
  }
}

/** Upgrades a V1 card object to the V2 envelope. */
export function upgradeV1ToV2(v1: CharacterCardV1): CharacterCardV2 {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: normalizeCardData(v1),
  }
}

/**
 * Extracts a character card from a PNG's embedded chunks.
 *
 * NOT IMPLEMENTED — see roadmap Phase 3. Declared here so callers can be
 * written against the real signature now.
 *
 * Implementation notes for whoever picks this up:
 *   1. Walk PNG chunks: 8-byte signature, then
 *      `[4-byte BE length][4-byte type][data][4-byte CRC32]`.
 *   2. Collect `tEXt` / `iTXt` chunks with keyword `chara` (V2, base64 JSON)
 *      and `ccv3` (V3).
 *   3. For `iTXt` the payload is `keyword\0 compressionFlag \0 ... \0 text`
 *      — the text may be zlib-compressed, so this needs `pako` or equivalent.
 *   4. base64-decode, then hand the JSON to `parseCardJson`.
 *   5. Verify the CRC of each chunk you read, and cap the total bytes scanned
 *      so a malformed image cannot make us allocate unbounded memory.
 */
export function parsePngCard(_bytes: Uint8Array): CharacterParseResult {
  return {
    ok: false,
    error:
      'PNG character card import is not implemented yet (roadmap Phase 3). ' +
      'Export the card as JSON from SillyTavern and import that instead.',
  }
}

/**
 * Serialises a card for export as `.json`.
 *
 * V3-aware consumers ignore unknown keys, so exporting the V2 envelope is the
 * compatible choice.
 */
export function serializeCard(card: CharacterCardV2): string {
  return JSON.stringify(
    { spec: 'chara_card_v2', spec_version: '2.0', data: card.data },
    null,
    2,
  )
}

/** Derives a filesystem-safe file name for a card export. */
export function cardFileName(card: CharacterCardV2): string {
  const base = card.data.name.trim() || 'character'
  return `${base.replace(/[^a-zA-Z0-9._\- ]/g, '_').slice(0, 64)}.json`
}
