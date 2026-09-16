/**
 * Load both model lines from disk and produce per-line recommendations.
 *
 * Kept separate from `lines.ts` (pure transforms) and `recommend.ts` (pure
 * scoring) so that the filesystem dependency stays at the edges and the
 * scoring rules remain testable in isolation.
 */

import { readFileSync } from 'node:fs';

import {
  recommendModel,
  recommendOptions,
  type ModelEntry,
  type Recommendation,
  type RecommendOptions,
} from './recommend.ts';
import {
  toLineEntries,
  tagOfficial,
  type LineModelEntry,
  type ModelLine,
} from './lines.ts';

/** Raw shape of data/models-official.json (only the parts we consume). */
interface OfficialCatalog {
  models: ModelEntry[];
}

export interface LoadedLines {
  official: LineModelEntry[];
  abliterated: LineModelEntry[];
  all: LineModelEntry[];
}

export interface LoadLinesOptions {
  officialPath: string;
  abliteratedPath: string;
}

export function loadLines(opts: LoadLinesOptions): LoadedLines {
  const officialRaw = JSON.parse(
    readFileSync(opts.officialPath, 'utf8'),
  ) as OfficialCatalog;
  const abliteratedRaw = JSON.parse(
    readFileSync(opts.abliteratedPath, 'utf8'),
  ) as Parameters<typeof toLineEntries>[0];

  const official = tagOfficial(officialRaw.models);
  const abliterated = toLineEntries(abliteratedRaw);

  return { official, abliterated, all: [...official, ...abliterated] };
}

/** Recommendation for one line, or null when that line has no viable model. */
export interface LineRecommendation {
  line: ModelLine;
  recommendation: Recommendation | null;
  /** Meaningful alternatives on this line, best-first, excluding the top pick. */
  alternatives: Recommendation[];
}

/**
 * Recommend independently per line.
 *
 * Deliberately NOT "concatenate both lines and recommend once": the two lines
 * have different capability profiles at the same parameter count (an
 * abliterated 8B is somewhat less coherent than an aligned 8B), so a single
 * merged ranking would silently interleave them and the UI could not explain
 * why it picked an uncensored model over an aligned one of the same size.
 * Each line is ranked on its own merits and the user chooses between lines.
 */
export function recommendPerLine(
  lines: LoadedLines,
  options: RecommendOptions,
  alternativesPerLine = 3,
): { official: LineRecommendation; abliterated: LineRecommendation } {
  const build = (line: ModelLine, models: LineModelEntry[]): LineRecommendation => {
    const top = recommendModel(models, options);
    const allOpts = recommendOptions(models, options, alternativesPerLine + 1);
    const alternatives = allOpts.filter((r) => r.model.id !== top?.model.id);
    return { line, recommendation: top, alternatives };
  };

  return {
    official: build('official', lines.official),
    abliterated: build('abliterated', lines.abliterated),
  };
}

/**
 * Whether an abliterated model is worth offering at all alongside the aligned
 * pick, given that it trades some coherence for compliance-free output.
 *
 * Returns false when no abliterated model fits, so the UI can hide the toggle
 * rather than present an empty list.
 */
export function abliteratedAvailable(
  lines: LoadedLines,
  options: RecommendOptions,
): boolean {
  return recommendModel(lines.abliterated, options) !== null;
}
