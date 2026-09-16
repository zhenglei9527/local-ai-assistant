/**
 * Syntax check for the TypeScript sources, using ONLY what is on this machine.
 *
 * There is no `tsc` here: `node_modules` is not installed and the project has
 * no lockfile, so `@react-native/typescript-config` and the `typescript`
 * package cannot be resolved. What Node 24 *can* do is parse the files itself
 * via its built-in type stripping. That catches genuine syntax errors —
 * unbalanced braces, malformed generics, bad type syntax — which is the
 * failure mode a hand-written spec file is actually at risk of.
 *
 * ⚠️ `.tsx` IS EXCLUDED, and that exclusion is a tool limitation, not a
 * clean bill of health. Node's type-stripping has no JSX plugin enabled, so
 * EVERY `.tsx` file fails with "Expected '>', got 'ident'" at the first
 * `<Component>` — including files this change never touched (verify by running
 * it against `src/ui/screens/ChatScreen.tsx`, which is unmodified). Reporting
 * those as failures would be noise; silently passing them would be a lie, so
 * they are listed explicitly as NOT CHECKED.
 *
 * It does NOT type check, and it does NOT resolve `@/` aliases or bare
 * specifiers — semantic correctness of the spec file is unverified here.
 */
import { readFileSync } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'

const FILES = [
  'src/specs/NativePhoneLlmSystem.ts',
  'src/specs/phoneLlmSystem.ts',
  'src/data/models/memoryProbe.ts',
  'src/data/models/catalog.ts',
  'src/data/download/paths.ts',
]

let failed = 0

for (const file of FILES) {
  let source
  try {
    source = readFileSync(file, 'utf8')
  } catch {
    console.log(`MISSING  ${file}`)
    failed += 1
    continue
  }

  try {
    // `module: true` keeps import/export as ESM so only real syntax problems throw.
    // `transform` mode (not `strip`) is used because it additionally understands
    // TypeScript parameter properties (`constructor(private readonly x: T)`),
    // which are valid TS that strip-only mode rejects — see
    // BackgroundModelDownloader.ts.
    stripTypeScriptTypes(source, { mode: 'transform' })
    console.log(`OK       ${file}`)
  } catch (error) {
    failed += 1
    console.log(`SYNTAX   ${file}`)
    console.log(`           ${error.message}`)
    if (error.stack) {
      const line = error.stack.split('\n').find((l) => l.includes(file))
      if (line) console.log(`           ${line.trim()}`)
    }
  }
}

// Also sweep the whole src tree so nothing else regressed.
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (['.ts', '.tsx'].includes(extname(full))) out.push(full)
  }
  return out
}

let swept = 0
let sweepFailed = 0
let skippedTsx = 0
for (const file of walk('src')) {
  // See the header: .tsx cannot be parsed by this tool at all.
  if (extname(file) === '.tsx') {
    skippedTsx += 1
    continue
  }
  swept += 1
  try {
    stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'transform' })
  } catch (error) {
    sweepFailed += 1
    console.log(`SWEEP-SYNTAX ${file}: ${error.message}`)
  }
}

console.log(
  `\nsrc sweep: ${swept} .ts files parsed, ${sweepFailed} syntax errors, ` +
    `${skippedTsx} .tsx files NOT CHECKED (no JSX parser available)`,
)
console.log(failed === 0 && sweepFailed === 0 ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exitCode = failed === 0 && sweepFailed === 0 ? 0 : 1
