/**
 * Abliterated (uncensored) model catalogue, as a data module.
 *
 * ⚠️ GENERATED FILE — edit `data/models-jailbreak.json` and re-run
 * `node scripts/embed-abliterated.mjs` instead of editing this by hand.
 *
 * WHY A .ts MODULE AND NOT THE JSON DIRECTLY
 * ------------------------------------------
 * The JSON is deliberately NOT published: it lists uncensored model
 * repositories, and having that tied to a public identity is a liability. But
 * `lineCatalog.ts` needs the data at *link time*, and a static ESM import of a
 * missing file is an uncatchable error — the whole bundle fails, so a fresh
 * clone can neither build nor run a single test. That is how this project's
 * first CI run failed.
 *
 * So the data is projected into this module, which ALWAYS exists:
 *   - the published repository ships the empty array;
 *   - a working copy fills it in.
 *
 * This file is gitignored. `abliterated.generated.example.ts` documents the
 * entry shape.
 */

export interface RawAbliteratedEntry {
  readonly id: string
  readonly displayName: string
  readonly quantization: string
  readonly fileName: string
  readonly bytes: number
  readonly downloadUrl: string
  readonly sharded: boolean
  readonly source: string
  readonly repo: string
  readonly sha256: string
}

export const ABLITERATED_ENTRIES: readonly RawAbliteratedEntry[] = []
