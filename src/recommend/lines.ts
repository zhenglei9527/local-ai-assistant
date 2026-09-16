/**
 * Model "lines" — the official (aligned) catalogue and the abliterated
 * (uncensored) one — unified behind the recommender's `ModelEntry` shape.
 *
 * WHY THIS FILE EXISTS
 *
 * The two data files were produced by different pipelines and have different
 * schemas:
 *
 *   data/models-official.json  -> { models: [...] }        family, parametersB,
 *                                 sizeBytes, sizeGiB, sizeGB, shards[], ...
 *   data/models-jailbreak.json -> [ ... ]                  flat array, no
 *                                 family, no parametersB, `bytes` instead of
 *                                 `sizeBytes`
 *
 * Feeding the jailbreak file straight to `recommendModel()` would silently
 * break three things: `parametersB` would be `undefined` (so every comparison
 * against `minParametersB` is false and the model is never eligible),
 * `sizeBytes` would be `undefined` (so `modelSizeGiB()` falls through to its
 * defensive `?? 0` and reports a 0 GiB model that appears to fit everything),
 * and `isSharded` would be `undefined`.
 *
 * Neither failure throws. The result is a model list that looks plausible and
 * is wrong, so the adapter below is the only sanctioned way to read the
 * jailbreak data.
 */

import type { ModelEntry } from './recommend.ts';

/** Which catalogue a model came from. */
export type ModelLine = 'official' | 'abliterated';

/** A `ModelEntry` tagged with its originating line. */
export interface LineModelEntry extends ModelEntry {
  line: ModelLine;
}

/** Raw shape of one entry in data/models-jailbreak.json. */
interface RawJailbreakEntry {
  id: string;
  displayName: string;
  quantization: string;
  fileName: string;
  /** NOTE: `bytes`, not `sizeBytes`. */
  bytes: number;
  sizeMB: number;
  downloadUrl: string;
  sharded: boolean;
  source: string;
  repo: string;
  sha256: string;
}

/**
 * Parameter counts for the abliterated catalogue.
 *
 * The jailbreak pipeline does not record `parametersB`, and it cannot be
 * derived from the file size: a Q4_K_M 4B file is ~2.33 GiB, but so is an
 * 8B at IQ2_XS. Reading the count off the size would misclassify models.
 *
 * So the counts are pinned explicitly, keyed by the model id in
 * data/models-jailbreak.json. An unknown id is a hard error rather than a
 * default, because a wrong parameter count silently corrupts ranking.
 *
 * `eras` mirrors the Qwen2.5/3 split used by the official catalogue: later
 * generations are more coherent per parameter, so they are preferred at equal
 * size. `activeParamsB` differs from `parametersB` for the one MoE entry.
 */
const JAILBREAK_PARAMS: Readonly<
  Record<string, { parametersB: number; activeParamsB: number; family: string }>
> = {
  'huihui-qwen3-0-6b-abliterated-v2': { parametersB: 0.6, activeParamsB: 0.6, family: 'Qwen3-abliterated' },
  'huihui-qwen3-1-7b-abliterated-v2': { parametersB: 1.7, activeParamsB: 1.7, family: 'Qwen3-abliterated' },
  'llama-3-2-3b-instruct-abliterated-finetuned': { parametersB: 3, activeParamsB: 3, family: 'Llama-3.2-abliterated' },
  'gemma-3-4b-it-abliterated': { parametersB: 4, activeParamsB: 4, family: 'Gemma-3-abliterated' },
  'huihui-qwen3-4b-abliterated-v2': { parametersB: 4, activeParamsB: 4, family: 'Qwen3-abliterated' },
  'josiefied-qwen2-5-7b-instruct-abliterated': { parametersB: 7, activeParamsB: 7, family: 'Qwen2.5-abliterated' },
  'meta-llama-3-8b-instruct-abliterated': { parametersB: 8, activeParamsB: 8, family: 'Llama-3-abliterated' },
  'huihui-qwen3-8b-abliterated-v2': { parametersB: 8, activeParamsB: 8, family: 'Qwen3-abliterated' },
  'gemma-3-12b-it-abliterated': { parametersB: 12, activeParamsB: 12, family: 'Gemma-3-abliterated' },
  'huihui-qwen3-14b-abliterated-v2': { parametersB: 14, activeParamsB: 14, family: 'Qwen3-abliterated' },
  'qwen3-30b-a3b-abliterated-erotic': { parametersB: 30, activeParamsB: 3, family: 'Qwen3-abliterated' },
};

const BYTES_PER_GiB = 1024 ** 3;

/**
 * Convert the flat jailbreak array into `ModelEntry[]`.
 *
 * Throws on an unrecognised id so that adding a model to the data file
 * without declaring its parameter count fails loudly at load time instead of
 * producing a silently mis-ranked catalogue.
 */
export function toLineEntries(raw: readonly RawJailbreakEntry[]): LineModelEntry[] {
  return raw.map((r) => {
    const params = JAILBREAK_PARAMS[r.id];
    if (!params) {
      throw new Error(
        `Unknown abliterated model id "${r.id}" — add it to JAILBREAK_PARAMS in src/recommend/lines.ts ` +
          `with its true parameter count before it can be recommended.`,
      );
    }
    if (!(r.bytes > 0)) {
      throw new Error(`Abliterated model "${r.id}" has non-positive size (${r.bytes}).`);
    }
    return {
      id: r.id,
      displayName: r.displayName,
      family: params.family,
      parametersB: params.parametersB,
      activeParamsB: params.activeParamsB,
      quantization: r.quantization,
      // Copy `bytes` into the field name the engine reads.
      sizeBytes: r.bytes,
      sizeGiB: r.bytes / BYTES_PER_GiB,
      sizeGB: r.sizeMB / 1000,
      minRamGB: 0,
      recommendedRamGB: 0,
      isSharded: r.sharded,
      shardCount: r.sharded ? 0 : 1,
      sha256: r.sha256 ?? null,
      line: 'abliterated' as const,
    };
  });
}

/** Tag official-catalogue entries with their line. */
export function tagOfficial(models: readonly ModelEntry[]): LineModelEntry[] {
  return models.map((m) => ({ ...m, line: 'official' as const }));
}

/** Everything needed to resolve a downloaded file's URL and integrity. */
export interface DownloadRef {
  line: ModelLine;
  repo: string;
  fileName: string;
  sha256: string | null;
  sizeBytes: number;
  sharded: boolean;
}

/**
 * Resolve a model id to its download coordinates.
 *
 * The two lines build URLs differently and, importantly, disagree on whether
 * an exact revision can be pinned:
 *
 *  - official: `/api/v1/models/{repo}/repo?Revision=<commit>&FilePath=<file>`,
 *    pinned to a commit SHA captured at catalogue build time.
 *  - abliterated: `/models/{repo}/resolve/master/<file>`, and the jailbreak
 *    pipeline records NO commit SHA — only the branch `master`. That branch
 *    can move, so the recorded sha256 is what actually pins the bytes.
 *
 * The caller must therefore verify the sha256 after download on the
 * abliterated line; a revision check alone is not sufficient there.
 */
export function downloadRef(
  model: LineModelEntry,
  officialSource: readonly { id: string; repo: string; fileName: string; revision: string }[],
): DownloadRef {
  if (model.line === 'abliterated') {
    // Repo is not carried on ModelEntry; recover it from the id.
    const raw = JAILBREAK_REPO_BY_ID[model.id];
    if (!raw) throw new Error(`No repository recorded for abliterated model "${model.id}".`);
    return {
      line: 'abliterated',
      repo: raw,
      fileName: JAILBREAK_FILE_BY_ID[model.id],
      sha256: model.sha256,
      sizeBytes: model.sizeBytes,
      sharded: model.isSharded,
    };
  }
  const src = officialSource.find((s) => s.id === model.id);
  if (!src) throw new Error(`No official catalogue source for "${model.id}".`);
  return {
    line: 'official',
    repo: src.repo,
    fileName: src.fileName,
    sha256: model.sha256,
    sizeBytes: model.sizeBytes,
    sharded: model.isSharded,
  };
}

/**
 * Repository and file name for each abliterated entry, transcribed from
 * data/models-jailbreak.json.
 *
 * Duplicated here because `ModelEntry` (the recommender's contract) has no
 * repository field, and widening that interface would ripple into the
 * already-tested official path. Kept adjacent to JAILBREAK_PARAMS so the two
 * tables are updated together.
 */
const JAILBREAK_REPO_BY_ID: Readonly<Record<string, string>> = {
  'huihui-qwen3-0-6b-abliterated-v2': 'mradermacher/Huihui-Qwen3-0.6B-abliterated-v2-i1-GGUF',
  'huihui-qwen3-1-7b-abliterated-v2': 'mradermacher/Huihui-Qwen3-1.7B-abliterated-v2-i1-GGUF',
  'llama-3-2-3b-instruct-abliterated-finetuned': 'mradermacher/Llama-3.2-3B-Instruct-abliterated-finetuned-i1-GGUF',
  'gemma-3-4b-it-abliterated': 'mradermacher/gemma-3-4b-it-abliterated-i1-GGUF',
  'huihui-qwen3-4b-abliterated-v2': 'mradermacher/Huihui-Qwen3-4B-abliterated-v2-i1-GGUF',
  'josiefied-qwen2-5-7b-instruct-abliterated': 'mradermacher/Josiefied-Qwen2.5-7B-Instruct-abliterated-i1-GGUF',
  'meta-llama-3-8b-instruct-abliterated': 'mradermacher/Meta-Llama-3-8B-Instruct-abliterated-i1-GGUF',
  'huihui-qwen3-8b-abliterated-v2': 'mradermacher/Huihui-Qwen3-8B-abliterated-v2-i1-GGUF',
  'gemma-3-12b-it-abliterated': 'mradermacher/gemma-3-12b-it-abliterated-i1-GGUF',
  'huihui-qwen3-14b-abliterated-v2': 'mradermacher/Huihui-Qwen3-14B-abliterated-v2-i1-GGUF',
  'qwen3-30b-a3b-abliterated-erotic': 'mradermacher/Qwen3-30B-A3B-abliterated-erotic-i1-GGUF',
};

const JAILBREAK_FILE_BY_ID: Readonly<Record<string, string>> = {
  'huihui-qwen3-0-6b-abliterated-v2': 'Huihui-Qwen3-0.6B-abliterated-v2.i1-Q4_K_M.gguf',
  'huihui-qwen3-1-7b-abliterated-v2': 'Huihui-Qwen3-1.7B-abliterated-v2.i1-Q4_K_M.gguf',
  'llama-3-2-3b-instruct-abliterated-finetuned': 'Llama-3.2-3B-Instruct-abliterated-finetuned.i1-Q4_K_M.gguf',
  'gemma-3-4b-it-abliterated': 'gemma-3-4b-it-abliterated.i1-Q4_K_M.gguf',
  'huihui-qwen3-4b-abliterated-v2': 'Huihui-Qwen3-4B-abliterated-v2.i1-Q4_K_M.gguf',
  'josiefied-qwen2-5-7b-instruct-abliterated': 'Josiefied-Qwen2.5-7B-Instruct-abliterated.i1-Q4_K_M.gguf',
  'meta-llama-3-8b-instruct-abliterated': 'Meta-Llama-3-8B-Instruct-abliterated.i1-Q4_K_M.gguf',
  'huihui-qwen3-8b-abliterated-v2': 'Huihui-Qwen3-8B-abliterated-v2.i1-Q4_K_M.gguf',
  'gemma-3-12b-it-abliterated': 'gemma-3-12b-it-abliterated.i1-Q4_K_M.gguf',
  'huihui-qwen3-14b-abliterated-v2': 'Huihui-Qwen3-14B-abliterated-v2.i1-Q4_K_M.gguf',
  'qwen3-30b-a3b-abliterated-erotic': 'Qwen3-30B-A3B-abliterated-erotic.i1-Q4_K_M.gguf',
};
