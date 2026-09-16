/**
 * Minimal Node ESM loader that resolves the `@/` alias.
 *
 * WHY
 * ---
 * `@/foo` is a Metro/bundler alias (tsconfig `paths`). Plain Node does not read
 * tsconfig, so any module that uses it — notably `src/store/index.ts` — cannot
 * be imported in a unit test. That is the reason the store's engine wiring had
 * never been exercised: the store was simply untestable in this repo.
 *
 * This loader maps `@/x` to `<projectRoot>/src/x`, and additionally appends
 * `.ts`/`.tsx` when the bare specifier has no extension, mirroring what Metro
 * does. It changes nothing about how the app itself is built — it is only used
 * by `node --import` in test runs.
 *
 * Usage:
 *   node --import ./scripts/alias-loader.mjs --test src/store/*.test.ts
 */

import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolvePath(here, '..')
const srcRoot = resolvePath(projectRoot, 'src')

/** Extensions to try, in Metro's precedence order. */
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx']

function resolveAlias(specifier) {
  if (!specifier.startsWith('@/')) return null

  const base = resolvePath(srcRoot, specifier.slice(2))

  // Exact path first (covers `@/foo.ts` and `@/foo/index.ts` spelled out).
  if (existsSync(base) && !base.endsWith('/')) {
    return pathToFileURL(base).href
  }

  // Then try each extension.
  for (const ext of EXTENSIONS) {
    const candidate = base + ext
    if (existsSync(candidate)) return pathToFileURL(candidate).href
  }

  // Then an index file inside a directory.
  for (const ext of EXTENSIONS) {
    const candidate = resolvePath(base, `index${ext}`)
    if (existsSync(candidate)) return pathToFileURL(candidate).href
  }

  return null
}

export async function resolve(specifier, context, nextResolve) {
  const aliased = resolveAlias(specifier)
  if (aliased) {
    return { url: aliased, shortCircuit: true }
  }

  // Some project files import siblings WITHOUT an extension
  // (`from './InferenceEngine'`), which Metro resolves but Node does not.
  // Mirror Metro so these modules become loadable in tests.
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const parentPath = context.parentURL ? fileURLToPath(context.parentURL) : null
    if (parentPath) {
      const base = resolvePath(dirname(parentPath), specifier)
      if (!existsSync(base)) {
        for (const ext of EXTENSIONS) {
          if (existsSync(base + ext)) {
            return { url: pathToFileURL(base + ext).href, shortCircuit: true }
          }
        }
        for (const ext of EXTENSIONS) {
          const candidate = resolvePath(base, `index${ext}`)
          if (existsSync(candidate)) {
            return { url: pathToFileURL(candidate).href, shortCircuit: true }
          }
        }
      }
    }
  }

  // Anything else (node builtins, npm packages) falls through.
  return nextResolve(specifier, context)
}
