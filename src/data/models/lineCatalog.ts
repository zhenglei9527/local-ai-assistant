/**
 * Unified model catalogue: the aligned line and the abliterated line, both as
 * `ModelDescriptor` so the existing picker/download/UI code needs no changes.
 *
 * WHY THIS EXISTS
 *
 * `data/models-official.json` is a rich index (shards, revision, architecture
 * families). `data/models-jailbreak.json` is a flat, minimal array produced by
 * a different pipeline: it has `bytes` rather than `sizeBytes`, no `family`,
 * no `revision`, and its download URL is a `/resolve/master/` path rather than
 * the `/repo?Revision=` form the official pipeline emits.
 *
 * The abliterated line is therefore adapted here rather than being forced
 * through the official index shape, and the two are kept distinguishable
 * downstream via `line`, so the UI can label them and the downloader can pick
 * the correct URL/verification strategy.
 */

import rawJailbreak from '../../../data/models-jailbreak.json' with { type: 'json' }
import { MODEL_CATALOG, resolveArchitecture, type ArchitectureFacts } from './catalog.ts'
import { INCLUDES_ABLITERATED } from '../../config/buildFlavor.ts'
import type { ModelDescriptor, ModelFilePart, Quantization, ModelTag } from '../../types/domain'

/** Which catalogue a model belongs to. */
export type CatalogLine = 'official' | 'abliterated'

/** A `ModelDescriptor` tagged with its line and verification requirement. */
export interface LineDescriptor extends ModelDescriptor {
  readonly line: CatalogLine
  /**
   * True when the download URL points at a movable branch (`master`) instead
   * of an immutable commit, so the sha256 MUST be checked after download.
   */
  readonly requiresDigestCheck: boolean
  /** ModelScope repository, for attribution and manual inspection. */
  readonly repo: string
}

// ---------------------------------------------------------------------------
// Raw jailbreak index shape
// ---------------------------------------------------------------------------

interface RawJailbreakEntry {
  readonly id: string
  readonly displayName: string
  readonly quantization: string
  readonly fileName: string
  /** NOTE: `bytes` here, not `sizeBytes` as in the official index. */
  readonly bytes: number
  readonly sizeMB: number
  readonly downloadUrl: string
  readonly sharded: boolean
  readonly source: string
  readonly repo: string
  readonly sha256: string
}

/**
 * True parameter counts for the abliterated line, keyed by model id.
 *
 * The jailbreak pipeline records no parameter count and, crucially, it cannot
 * be inferred from file size: a 4B at Q4_K_M and an 8B at IQ2_XS are both
 * ~2.3-2.5 GiB. Guessing from size would mislabel models and corrupt every
 * memory verdict, so the counts are pinned and an unknown id throws.
 *
 * `family` is used only for architecture lookup and display; the
 * `-abliterated` suffix keeps it distinct from the aligned families so a
 * lookup cannot silently borrow the aligned model's facts.
 */
const ABLITERATED_FACTS: Readonly<
  Record<string, { parametersB: number; architectureFamily: string }>
> = {
  'huihui-qwen3-0-6b-abliterated-v2': { parametersB: 0.6, architectureFamily: 'Qwen3' },
  'huihui-qwen3-1-7b-abliterated-v2': { parametersB: 1.7, architectureFamily: 'Qwen3' },
  'llama-3-2-3b-instruct-abliterated-finetuned': { parametersB: 3, architectureFamily: 'Llama-3.2' },
  'gemma-3-4b-it-abliterated': { parametersB: 4, architectureFamily: 'Gemma' },
  'huihui-qwen3-4b-abliterated-v2': { parametersB: 4, architectureFamily: 'Qwen3' },
  'josiefied-qwen2-5-7b-instruct-abliterated': { parametersB: 7, architectureFamily: 'Qwen2.5' },
  'meta-llama-3-8b-instruct-abliterated': { parametersB: 8, architectureFamily: 'Llama' },
  'huihui-qwen3-8b-abliterated-v2': { parametersB: 8, architectureFamily: 'Qwen3' },
  'gemma-3-12b-it-abliterated': { parametersB: 12, architectureFamily: 'Gemma-2' },
  'huihui-qwen3-14b-abliterated-v2': { parametersB: 14, architectureFamily: 'Qwen3' },
  'qwen3-30b-a3b-abliterated-erotic': { parametersB: 30, architectureFamily: 'Qwen3' },
}

const UNKNOWN_ARCH: ArchitectureFacts = {
  layerCount: 0,
  headCountKv: 0,
  headDim: 0,
  contextLength: 0,
}

function abliteratedTags(entry: RawJailbreakEntry, parametersB: number): ModelTag[] {
  const tags: ModelTag[] = ['chat', 'instruct', 'roleplay']
  if (parametersB <= 2) tags.push('tiny')
  return tags
}

function toLineDescriptor(entry: RawJailbreakEntry): LineDescriptor {
  const facts = ABLITERATED_FACTS[entry.id]
  if (!facts) {
    throw new Error(
      `Unknown abliterated model id "${entry.id}" — declare its parameter count and ` +
        `architecture family in ABLITERATED_FACTS (src/data/models/lineCatalog.ts) first.`,
    )
  }
  if (!(entry.bytes > 0)) {
    throw new Error(`Abliterated model "${entry.id}" has non-positive size (${entry.bytes}).`)
  }

  const arch = resolveArchitecture(facts.architectureFamily) ?? UNKNOWN_ARCH

  const files: ModelFilePart[] = [
    {
      index: 0,
      url: entry.downloadUrl,
      sizeBytes: entry.bytes,
      sha256: entry.sha256,
    },
  ]

  return {
    id: entry.id,
    displayName: entry.displayName,
    author: entry.repo.split('/')[0] ?? 'unknown',
    sourceUrl: `https://modelscope.cn/models/${entry.repo}`,
    license: 'See model card on ModelScope',
    // Cast is safe: the pipeline only emits quants the app supports, and the
    // recommender independently maps unknown strings to a conservative default.
    quantization: entry.quantization as Quantization,
    parametersB: facts.parametersB,
    layerCount: arch.layerCount,
    embeddingLength: 0,
    headCountKv: arch.headCountKv,
    headDim: arch.headDim,
    contextLength: arch.contextLength,
    files,
    sizeBytes: entry.bytes,
    description: `${facts.architectureFamily} abliterated · ${entry.quantization}`,
    tags: abliteratedTags(entry, facts.parametersB),
    line: 'abliterated',
    // The URL targets the `master` branch, which can move. The recorded
    // sha256 is the only thing pinning the bytes, so it must be verified.
    requiresDigestCheck: true,
    repo: entry.repo,
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The abliterated line, gated by build flavour.
 *
 * ⚠️ THE BRANCH MUST STAY A CONSTANT EXPRESSION. `INCLUDES_ABLITERATED` folds
 * to a literal `true`/`false` at bundle time, so Metro eliminates the
 * unreachable arm entirely. On a `store` build the `map(toLineDescriptor)`
 * call — and with it every abliterated id, repo path and download URL — is
 * removed from the shipped bundle, not merely hidden at runtime. Do not
 * rewrite this as a runtime `if` over a mutable value: the data would then
 * ship, and the store build would contain exactly what it must not.
 */
export const ABLITERATED_CATALOG: readonly LineDescriptor[] = INCLUDES_ABLITERATED
  ? (rawJailbreak as unknown as RawJailbreakEntry[]).map(toLineDescriptor)
  : []

/** Official-line models, tagged and marked as commit-pinned. */
export const OFFICIAL_LINE: readonly LineDescriptor[] = MODEL_CATALOG.map((m) => ({
  ...m,
  line: 'official' as const,
  requiresDigestCheck: false,
  repo: '',
}))

/** Every model from both lines. */
export const ALL_MODELS: readonly LineDescriptor[] = [...OFFICIAL_LINE, ...ABLITERATED_CATALOG]

/**
 * Models available for a line.
 *
 * On a `store` build the abliterated line resolves to an empty list rather
 * than throwing: the UI asks for both lines unconditionally and renders a tab
 * per non-empty result, so an empty list is the natural "this build has no
 * such line" signal. Throwing here would crash the picker on every store
 * build for no benefit.
 */
export function modelsForLine(line: CatalogLine): readonly LineDescriptor[] {
  if (line === 'official') return OFFICIAL_LINE
  return INCLUDES_ABLITERATED ? ABLITERATED_CATALOG : []
}

/** True when this build carries the abliterated line at all. */
export function hasAbliteratedLine(): boolean {
  return INCLUDES_ABLITERATED && ABLITERATED_CATALOG.length > 0
}

export function findLineModel(id: string): LineDescriptor | undefined {
  return ALL_MODELS.find((m) => m.id === id)
}

/**
 * Reconcile the display catalogue against the recommender's `ModelEntry` view.
 *
 * The two modules derive the same numbers from the same bytes but through
 * different type definitions, so this returns the ids that disagree — a cheap
 * guard against the two drifting apart.
 */
export function catalogConsistencyIssues(entries: readonly { id: string; sizeBytes: number }[]): string[] {
  const issues: string[] = []
  const byId = new Map(ALL_MODELS.map((m) => [m.id, m]))
  for (const e of entries) {
    const m = byId.get(e.id)
    if (!m) {
      issues.push(`${e.id}: present in recommender but missing from display catalogue`)
      continue
    }
    if (m.sizeBytes !== e.sizeBytes) {
      issues.push(`${e.id}: size mismatch (display ${m.sizeBytes} vs recommender ${e.sizeBytes})`)
    }
  }
  return issues
}
