/**
 * character-card —— 角色卡解析与提示词组装
 *
 * 语言无关的数据模型 + TypeScript 参考实现。
 * 本文件是模块的唯一公共入口。
 */

export * from './types.ts';
export {
  parseCard,
  parsePngCard,
  parseJsonCard,
  extractTextChunks,
  decodeChunkPayload,
  normalizeCharacter,
  normalizeCharacterBook,
  toV2Card,
  toV3Card,
  type PngTextChunk,
} from './parseCard.ts';
export {
  scanWorldInfo,
  matchKey,
  matchKeys,
  evaluateSecondary,
  buildScanBuffer,
  checkTimedEffects,
  filterByInclusionGroups,
  parseRegexFromString,
  MAX_SCAN_DEPTH,
  SCAN_SEPARATOR,
  // NOTE: `applyRegexScripts` was previously re-exported here but has no
  // implementation in `worldInfo.ts` — it was a stale name and the import
  // therefore failed to compile. The regex-script feature (its own
  // extension, distinct from world-info regex KEYS) is not implemented in this
  // module; `parseRegexFromString` above only covers the world-info key case.
  // Add the real implementation and this export together when Phase 4 lands.
  type ScanMessage,
  type ScanContext,
  type ActivatedEntry,
  type WorldInfoResult,
} from './worldInfo.ts';
export {
  buildPrompt,
  substituteMacros,
  parseExampleMessages,
  estimateTokens,
  pickGreeting,
  defaultSampling,
  DEFAULT_MAIN_PROMPT,
  type AssembleInput,
} from './buildPrompt.ts';
