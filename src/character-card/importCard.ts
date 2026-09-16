/**
 * Character-card import: file picker → parse → CharacterRecord.
 *
 * ── Why this module exists ─────────────────────────────────────────────────
 * `src/character-card/parseCard.ts` can already parse character cards
 * (42 tests, PNG `chara` chunk + plain JSON). Nothing ever called it, so the
 * library screen could only ever render an empty state. This is the missing
 * wiring, kept out of the screen so the picker (a native dependency) stays
 * separable from the parsing logic (pure, already tested).
 *
 * ── Two distributions, one entry point ─────────────────────────────────────
 * Cards are shared two ways in practice:
 *   1. PNG with an embedded `chara` tEXt chunk — the common distribution, and
 *      what you get from most card sites.
 *   2. Bare JSON (V1 flat object, or V2 `{spec, data}`).
 * Both are accepted. The format is sniffed from the file's magic bytes rather
 * than its extension, because card files are routinely renamed `.png` while
 * actually being JSON (and vice versa) — trusting the extension produces a
 * confusing "not a valid PNG" error on a perfectly good card.
 *
 * ── Why base64 (and not a filesystem read) ─────────────────────────────────
 * We read the picked file as base64 and decode to bytes in JS. That keeps the
 * binary path in one place and avoids needing a separate `readFile` native
 * method with its own permission story; a character card is a few hundred KB
 * at most, so the base64 round-trip is not a concern (unlike, say, model
 * weights, which are never read this way).
 */

import { Platform } from 'react-native'
import type { CharacterCardV2, CharacterRecord } from '@/types/domain'
import { parseCard, toV2Card } from './parseCard.ts'

/**
 * Parse picked bytes into a storable record.
 *
 * Split out from the picker so it is unit-testable without a device: it takes
 * bytes and returns a record, touching no native API.
 *
 * `parseCard` already sniffs PNG-vs-text internally (magic bytes → PNG path,
 * anything else → text/JSON path), so the caller does not need to care which
 * distribution the card came in. It throws with a Chinese message when neither
 * interpretation yields a usable card, which the screen surfaces verbatim.
 */
export function recordFromCardBytes(bytes: Uint8Array, fileName: string): CharacterRecord {
  const normalized = parseCard(bytes)

  // `toV2Card` hands back the V2 shape the store persists. `NormalizedCharacter`
  // is the parser's rich internal form (world book, assets, raw PNG); the store
  // keeps the normalized card, so carry the extras across explicitly rather
  // than letting them be dropped by the V2 round-trip.
  const card = toV2Card(normalized) as CharacterCardV2

  return {
    id: makeId(normalized.name, fileName),
    card,
    avatarPath: null,
    isUserCreated: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

/** Stable-ish id: name plus a short hash of the file name and the clock. */
function makeId(name: string, fileName: string): string {
  const seed = `${name}|${fileName}|${Date.now()}`
  let h = 0
  for (let i = 0; i < seed.length; i += 1) {
    h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0
  }
  return `char_${Math.abs(h).toString(36)}_${Date.now().toString(36)}`
}

/** Decoded bytes of a user-picked file, plus the name we should remember. */
export interface PickedFile {
  readonly name: string
  readonly bytes: Uint8Array
}

/**
 * Present the system file picker and return the chosen file's text.
 *
 * Returns null when the user cancels — callers must treat that as a no-op and
 * NOT as an error, otherwise dismissing the picker shows a spurious alert.
 *
 * ── Why we read as UTF-8 text rather than bytes ────────────────────────────
 * A PNG card's payload lives in a `tEXt` chunk, which is Latin-1 *text* inside
 * the PNG container. The parser already accepts a string and handles the PNG
 * case, so pulling bytes through the bridge buys nothing here. It also sidesteps
 * the fact that the picked URI is a `content://` handle: `fetch(uri)` is the one
 * read path that works for those without extra native code, and it yields text
 * directly.
 *
 * ── Why `keepLocalCopy` ────────────────────────────────────────────────────
 * Android hands back a `content://` URI whose permission is scoped to the
 * picker result and can be revoked. `keepLocalCopy` materialises the file into
 * app storage first, which is what makes it readable afterwards. Without it,
 * a later read intermittently fails with a permission error that looks like a
 * corrupt card.
 */
async function pickFile(): Promise<PickedFile | null> {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') {
    throw new Error('当前环境不支持选择文件。')
  }

  const picker = (await import('@react-native-documents/picker')) as {
    pick: (opts?: Record<string, unknown>) => Promise<Array<{ uri: string; name?: string }>>
    keepLocalCopy: (opts: {
      files: Array<{ uri: string; fileName: string }>
      destination: 'cachesDirectory'
    }) => Promise<Array<{ status: string; localUri?: string; copyError?: string }>>
  }

  let picked: Array<{ uri: string; name?: string }>
  try {
    picked = await picker.pick({ type: ['application/json', 'image/png', '*/*'] })
  } catch (error) {
    // The picker throws a coded error when the user backs out. Treating that as
    // a failure would raise "导入失败" on a deliberate cancel.
    const code = (error as { code?: string }).code
    if (code === 'OPERATION_CANCELED' || code === 'ASYNC_OP_IN_PROGRESS') return null
    throw new Error('无法打开文件选择器，请确认已授予文件访问权限。')
  }

  const first = picked[0]
  if (!first) return null

  const fileName = first.name ?? 'character-card'

  // Materialise into app storage so the URI stays readable.
  let localUri = first.uri
  try {
    const copies = await picker.keepLocalCopy({
      files: [{ uri: first.uri, fileName }],
      destination: 'cachesDirectory',
    })
    const copy = copies[0]
    if (copy?.status === 'success' && copy.localUri) {
      localUri = copy.localUri
    }
  } catch {
    // Not fatal: `content://` often stays readable for the life of the process,
    // which is all this import needs. Fall through with the original URI.
  }

  const text = await readAsText(localUri)
  return { name: fileName, bytes: encodeLatin1(text) }
}

/**
 * Read a local URI as text.
 *
 * `fetch` on a `file://` URI works under React Native's networking layer and
 * is the only reader that needs no extra native code. It is used for BOTH PNG
 * and JSON: a PNG read as text reproduces its bytes faithfully under the
 * Latin-1 round-trip below, because the `tEXt` chunk we care about is itself
 * Latin-1 by spec.
 */
async function readAsText(uri: string): Promise<string> {
  const response = await fetch(uri)
  if (!response.ok && response.status !== 0) {
    throw new Error('无法读取所选文件，请重试。')
  }
  return response.text()
}

/**
 * Latin-1 encode: each JS char code becomes one byte.
 *
 * This is the inverse of how a PNG's `tEXt` payload is defined (ISO-8859-1),
 * so a card's `chara` chunk survives the text round-trip byte-for-byte. It must
 * NOT be `TextEncoder` (UTF-8) — that would mangle any card whose base64
 * payload contains byte values > 127 and produce a silent parse failure.
 */
function encodeLatin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i += 1) {
    out[i] = text.charCodeAt(i) & 0xff
  }
  return out
}

/**
 * Run the whole import: pick a file, parse it, and build a stored record.
 *
 * @returns the new record, or null when the user cancelled.
 * @throws with a human-readable Chinese message on any parse failure.
 */
export async function importCharacterCard(): Promise<CharacterRecord | null> {
  const picked = await pickFile()
  if (!picked) return null
  return recordFromCardBytes(picked.bytes, picked.name)
}
