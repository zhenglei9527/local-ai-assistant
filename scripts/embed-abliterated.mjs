/**
 * Project `data/models-jailbreak.json` into a TypeScript data module.
 *
 * WHY THIS STEP EXISTS
 * --------------------
 * The JSON is deliberately not published (it lists uncensored model
 * repositories), but `lineCatalog.ts` needs the data at *link time*. A static
 * ESM import of a missing file is an uncatchable error — it breaks the whole
 * bundle, so a fresh clone of the public repository could neither build nor run
 * a single test. That is exactly how this project's first CI run failed.
 *
 * Generating a `.ts` module that ALWAYS exists resolves the tension:
 *
 *   - published repository → empty array, everything builds;
 *   - working copy         → real entries, the abliterated line lights up.
 *
 * Usage:
 *   node scripts/embed-abliterated.mjs          # JSON -> generated module
 *   node scripts/embed-abliterated.mjs --empty  # write the empty (publishable) version
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(here, '..')
const jsonPath = join(projectRoot, 'data', 'models-jailbreak.json')
const outPath = join(projectRoot, 'src', 'data', 'models', 'abliterated.generated.ts')

const wantEmpty = process.argv.includes('--empty')

const HEADER = `/**
 * Abliterated (uncensored) model catalogue, as a data module.
 *
 * ⚠️ GENERATED FILE — edit \`data/models-jailbreak.json\` and re-run
 * \`node scripts/embed-abliterated.mjs\` instead of editing this by hand.
 *
 * WHY A .ts MODULE AND NOT THE JSON DIRECTLY
 * ------------------------------------------
 * The JSON is deliberately NOT published: it lists uncensored model
 * repositories, and having that tied to a public identity is a liability. But
 * \`lineCatalog.ts\` needs the data at *link time*, and a static ESM import of a
 * missing file is an uncatchable error — the whole bundle fails, so a fresh
 * clone can neither build nor run a single test. That is how this project's
 * first CI run failed.
 *
 * So the data is projected into this module, which ALWAYS exists:
 *   - the published repository ships the empty array;
 *   - a working copy fills it in.
 *
 * This file is gitignored. \`abliterated.generated.example.ts\` documents the
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
`

let entries = []
if (!wantEmpty) {
  if (!existsSync(jsonPath)) {
    console.error(`[embed-abliterated] ${jsonPath} not found.`)
    console.error('  Pass --empty to write the publishable (empty) version.')
    process.exit(1)
  }
  const parsed = JSON.parse(readFileSync(jsonPath, 'utf8'))
  if (!Array.isArray(parsed)) {
    console.error('[embed-abliterated] expected a JSON array.')
    process.exit(1)
  }
  entries = parsed
}

// `JSON.stringify(value, null, 2)` emits valid TypeScript object literals, so
// the array can be inlined directly with `as const` for literal types.
const body = `\nexport const ABLITERATED_ENTRIES: readonly RawAbliteratedEntry[] = ${
  entries.length === 0 ? '[]' : `${JSON.stringify(entries, null, 2)} as const`
}\n`

writeFileSync(outPath, HEADER + body, 'utf8')
console.log(
  `[embed-abliterated] wrote ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} to ${outPath}`,
)
if (entries.length === 0) {
  console.log('  (empty — this is the version safe to publish)')
}
