/**
 * Registers the `@/` alias loader for Node test runs.
 *
 * Node's `--import` flag evaluates a module but does NOT treat its `resolve`
 * export as a loader hook — hooks must be installed explicitly through
 * `module.register()`. Importing this file (not `alias-loader.mjs`) is what
 * actually takes effect:
 *
 *   node --import ./scripts/register-alias.mjs --test src/store/index.test.ts
 */

import { register } from 'node:module'

// `register` resolves the first argument relative to the second (a parent URL).
// Passing the resolved URL of THIS module as the parent, and the loader as a
// plain relative specifier, avoids double-encoding the path (the workspace
// directory name contains a space, which makes hand-built file:// URLs fail).
register('./alias-loader.mjs', import.meta.url)
