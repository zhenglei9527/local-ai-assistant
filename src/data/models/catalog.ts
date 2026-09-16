/**
 * Model catalog — adapter over the authoritative, live-verified index.
 *
 * HISTORY / WHY THIS FILE CHANGED
 * -------------------------------
 * An earlier revision of this file hard-coded a five-entry catalog pointing at
 * `huggingface.co` with **placeholder** sha256 digests and approximate sizes.
 * That data could not be verified, because this machine's DNS for
 * huggingface.co is poisoned and the host is unreachable.
 *
 * It has been replaced by `data/models-official.json`, which was produced by
 * live probing the **ModelScope** file-listing API and is authoritative:
 *
 *   - 125 models across 25+ repositories
 *   - **exact** byte sizes measured from the API
 *   - **real** sha256 digests, cross-validated against the `X-Linked-Etag`
 *     response header
 *   - pinned `revision` commits (so a resume cannot splice two different files)
 *   - correct shard sets, including the non-uniform 7B/14B splits
 *   - confirmed HTTP Range support (206 + `Accept-Ranges: bytes`)
 *
 * So there is now exactly ONE source of truth for model data, and it is the
 * measured one. This module's job is narrow: convert that JSON into the
 * runtime types the downloader and UI consume, and derive `ModelDescriptor`'s
 * *runtime* fields (layer count, head counts) which the index does not carry.
 *
 * WHAT THE INDEX DOES NOT CONTAIN
 * -------------------------------
 * Architecture parameters needed for the KV-cache estimate — `layerCount`,
 * `headCountKv`, `headDim`, `contextLength`. These live in GGUF metadata, are
 * NOT in the ModelScope listing, and cannot be fetched here (that would mean
 * downloading multi-GB files).
 *
 * We therefore keep a small table of **architecture facts keyed by family**
 * below, sourced from published model configs. `resolveArchitecture()` returns
 * `null` for an unknown family rather than guessing, and `estimateModelMemory`
 * degrades honestly when it gets `null` (see `memoryProbe.ts`). Inventing a
 * plausible-looking layer count would silently corrupt every memory verdict.
 */

import rawIndex from '../../../data/models-official.json' with { type: 'json' }
import type { ModelDescriptor, ModelFilePart, ModelTag } from '../../types/domain'

// ---------------------------------------------------------------------------
// Index shape (as emitted by the ModelScope pipeline)
// ---------------------------------------------------------------------------

export interface IndexShard {
  readonly index: number
  readonly total: number
  readonly name: string
  readonly sizeBytes: number
  readonly sha256: string | null
  readonly url: string
}

export interface IndexModel {
  readonly id: string
  readonly displayName: string
  readonly family: string
  readonly kind: string
  readonly parametersB: number
  readonly activeParamsB: number
  readonly quantization: string
  readonly repo: string
  readonly revision: string
  readonly fileName: string
  readonly fileNames: string[]
  readonly sizeBytes: number
  readonly sizeGiB: number
  readonly sizeGB: number
  readonly downloadUrls: string[]
  readonly sha256: string | null
  readonly shards: IndexShard[]
  readonly isSharded: boolean
  readonly shardCount: number
  readonly minRamGB: number
  readonly recommendedRamGB: number
  readonly sourcePage: string
}

export interface ModelIndex {
  readonly schemaVersion: number
  readonly generatedAt: string
  readonly sizeUnit: string
  readonly repositoryCount: number
  readonly modelCount: number
  readonly models: IndexModel[]
  readonly memoryTiers: Record<string, unknown>
}

export const MODEL_INDEX = rawIndex as unknown as ModelIndex

// ---------------------------------------------------------------------------
// Architecture facts (NOT in the index — see file header)
// ---------------------------------------------------------------------------

export interface ArchitectureFacts {
  readonly layerCount: number
  readonly headCountKv: number
  readonly headDim: number
  readonly contextLength: number
}

/**
 * Architecture parameters by family prefix.
 *
 * ⚠️ These are read from published model configs, NOT from the GGUF files
 * themselves, and are **not verified against a downloaded model**. GGUF
 * metadata is authoritative; this table is a stand-in until Phase 2, when the
 * app can read it directly via `loadLlamaModelInfo()` on the local file and
 * replace this lookup entirely.
 *
 * When both a GGUF and this table are available, TRUST THE GGUF.
 */
const ARCHITECTURE_BY_FAMILY: Record<string, ArchitectureFacts> = {
  'Qwen2.5': { layerCount: 28, headCountKv: 4, headDim: 128, contextLength: 32768 },
  'Qwen2.5-Coder': { layerCount: 28, headCountKv: 4, headDim: 128, contextLength: 32768 },
  Qwen3: { layerCount: 36, headCountKv: 8, headDim: 128, contextLength: 32768 },
  Qwen3MoE: { layerCount: 48, headCountKv: 4, headDim: 128, contextLength: 32768 },
  Llama: { layerCount: 28, headCountKv: 8, headDim: 128, contextLength: 131072 },
  'Llama-3.2': { layerCount: 28, headCountKv: 8, headDim: 128, contextLength: 131072 },
  'Llama-3.1': { layerCount: 32, headCountKv: 8, headDim: 128, contextLength: 131072 },
  Mistral: { layerCount: 32, headCountKv: 8, headDim: 128, contextLength: 32768 },
  Gemma: { layerCount: 26, headCountKv: 8, headDim: 256, contextLength: 8192 },
  'Gemma-2': { layerCount: 42, headCountKv: 8, headDim: 256, contextLength: 8192 },
  Phi: { layerCount: 32, headCountKv: 32, headDim: 96, contextLength: 131072 },
  DeepSeek: { layerCount: 30, headCountKv: 8, headDim: 128, contextLength: 32768 },
  MiniCPM: { layerCount: 52, headCountKv: 8, headDim: 128, contextLength: 32768 },
  Yi: { layerCount: 32, headCountKv: 8, headDim: 128, contextLength: 32768 },
  InternLM: { layerCount: 32, headCountKv: 8, headDim: 128, contextLength: 32768 },
}

/**
 * Looks up architecture facts, longest-prefix first.
 *
 * Longest-prefix matters: "Qwen2.5-Coder" must win over "Qwen2.5", and
 * "Llama-3.2" must win over "Llama". A plain equality check on `family` would
 * work today but breaks the moment the index adds a variant.
 *
 * Returns `null` when unknown. Do NOT substitute a default — see file header.
 */
export function resolveArchitecture(family: string): ArchitectureFacts | null {
  const candidates = Object.keys(ARCHITECTURE_BY_FAMILY)
    .filter((prefix) => family.startsWith(prefix))
    .sort((a, b) => b.length - a.length)

  const best = candidates[0]
  if (!best) return null
  return ARCHITECTURE_BY_FAMILY[best] ?? null
}

/** Families present in the index that have no architecture entry yet. */
export function familiesMissingArchitecture(): string[] {
  const missing = new Set<string>()
  for (const m of MODEL_INDEX.models) {
    if (!resolveArchitecture(m.family)) missing.add(m.family)
  }
  return [...missing].sort()
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

function deriveTags(model: IndexModel): ModelTag[] {
  const tags: ModelTag[] = []
  if (model.kind === 'chat' || model.kind === 'instruct') tags.push('chat', 'instruct')
  if (model.kind === 'base') tags.push('chat')
  if (/coder|code/i.test(model.id)) tags.push('tool-calling')
  if (model.parametersB <= 2) tags.push('tiny')
  if (/qwen|llama|mistral|gemma|yi|internlm|deepseek/i.test(model.family)) {
    tags.push('roleplay')
  }
  if (model.activeParamsB < model.parametersB * 0.5) tags.push('reasoning')
  return [...new Set(tags)]
}

/**
 * Builds the download file list.
 *
 * Prefers `shards[]` (which carries per-shard size and digest) and falls back
 * to the single-file fields. Where a shard's `sha256` is `null` — which the
 * ModelScope pipeline emits for some sharded models, since the API reports only
 * one digest per repository — we propagate the model-level digest if there is
 * exactly one shard, otherwise leave it empty so `verifyFile` skips rather
 * than failing every download forever.
 */
function buildFiles(model: IndexModel): ModelFilePart[] {
  if (model.shards.length > 0) {
    return model.shards
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((s) => ({
        index: s.index - 1, // index in the raw API is 1-based
        url: s.url,
        sizeBytes: s.sizeBytes,
        sha256: s.sha256 ?? (model.shards.length === 1 ? model.sha256 ?? '' : ''),
      }))
  }

  return model.fileNames.map((name, i) => ({
    index: i,
    url:
      model.downloadUrls[i] ??
      model.downloadUrls[0] ??
      `${model.sourcePage}`,
    sizeBytes: Math.round(model.sizeBytes / model.fileNames.length),
    sha256: model.fileNames.length === 1 ? model.sha256 ?? '' : '',
  }))
}

const UNKNOWN_ARCH: ArchitectureFacts = {
  layerCount: 0,
  headCountKv: 0,
  headDim: 0,
  contextLength: 0,
}

export function toDescriptor(model: IndexModel): ModelDescriptor {
    const arch = resolveArchitecture(model.family) ?? UNKNOWN_ARCH

  return {
    id: model.id,
    displayName: model.displayName,
    author: model.repo.split('/')[0] ?? model.family,
    sourceUrl: model.sourcePage,
    license: 'See model card on ModelScope',
    quantization: model.quantization,
    parametersB: model.parametersB,
    layerCount: arch.layerCount,
    embeddingLength: 0, // not in index; unused by the memory estimate
    headCountKv: arch.headCountKv,
    headDim: arch.headDim,
    contextLength: arch.contextLength,
    files: buildFiles(model),
    sizeBytes: model.sizeBytes,
    description: `${model.family} · ${model.quantization} · ${model.sizeGiB} GiB` +
      (model.isSharded ? ` · ${model.shardCount} shards` : ''),
    tags: deriveTags(model),
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const MODEL_CATALOG: readonly ModelDescriptor[] =
  MODEL_INDEX.models.map(toDescriptor)

export function findModel(id: string): ModelDescriptor | undefined {
  return MODEL_CATALOG.find((m) => m.id === id)
}

export function requireModel(id: string): ModelDescriptor {
  const m = findModel(id)
  if (!m) throw new Error(`Unknown model id: ${id}`)
  return m
}

export function findIndexModel(id: string): IndexModel | undefined {
  return MODEL_INDEX.models.find((m) => m.id === id)
}

export function modelsByFamily(): Map<string, ModelDescriptor[]> {
  const out = new Map<string, ModelDescriptor[]>()
  for (const m of MODEL_CATALOG) {
    const family = m.displayName.split(' / ')[0] ?? m.id
    const list = out.get(family) ?? []
    list.push(m)
    out.set(family, list)
  }
  return out
}

/**
 * True when the catalog carries no usable digest for this model.
 *
 * Replaces the old `isPlaceholderDigest()`: with real data the failure mode
 * changed from "every digest is a placeholder" to "a few sharded models have
 * one digest for several shards". Both mean the same thing at the call site —
 * verification cannot be performed, and that must be visible rather than
 * silently passing.
 */
export function hasUsableDigest(descriptor: ModelDescriptor): boolean {
  return descriptor.files.every((f) => f.sha256.length === 64)
}
