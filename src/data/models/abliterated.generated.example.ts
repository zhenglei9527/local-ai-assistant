/**
 * Abliterated (uncensored) model catalogue — EXAMPLE / EMPTY TEMPLATE.
 *
 * Copy this file to `abliterated.generated.ts` to enable the second model line.
 * The real file is gitignored, because it lists uncensored model repositories
 * and having that tied to a public identity is a liability.
 *
 * WHY THIS INDIRECTION EXISTS AT ALL
 * ----------------------------------
 * `lineCatalog.ts` needs this data at *link time*, and a static ESM import of a
 * missing file is an uncatchable error: the whole bundle fails, so a fresh
 * clone could neither build nor run a single test. That is precisely how this
 * project's first CI run failed.
 *
 * Shipping an empty array instead keeps the published tree buildable and
 * testable, while a working copy can light the line up. The `store` build
 * flavour compiles the line out entirely regardless (see `buildFlavor.ts`), and
 * the UI already has copy for a build that has no such catalogue.
 *
 * ── Shape ───────────────────────────────────────────────────────────────────
 * Each entry is a flat record. Note the field names differ from the official
 * index on purpose: that pipeline emits `sizeBytes` and a `/repo?Revision=`
 * URL, while this one has `bytes` and a `/resolve/master/` URL. The adapter in
 * `lineCatalog.ts` reconciles the two.
 *
 * ```ts
 * {
 *   id: 'huihui-qwen3-4b-abliterated-v2',
 *   displayName: 'Huihui-Qwen3-4B-abliterated-v2 [Q4_K_M]',
 *   quantization: 'Q4_K_M',
 *   fileName: 'Huihui-Qwen3-4B-abliterated-v2.i1-Q4_K_M.gguf',
 *   bytes: 2497277376,
 *   downloadUrl: 'https://modelscope.cn/models/<owner>/<repo>/resolve/master/<file>',
 *   sharded: false,
 *   source: 'modelscope',
 *   repo: '<owner>/<repo>',
 *   sha256: '<64 hex chars>',
 * }
 * ```
 *
 * `sha256` is required, not optional: these URLs resolve through a movable
 * `master` branch rather than an immutable commit, so the digest is the only
 * thing pinning the bytes. `requiresDigestCheck` is derived from that.
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

/** Empty by default: the published build carries no uncensored catalogue. */
export const ABLITERATED_ENTRIES: readonly RawAbliteratedEntry[] = []
