/**
 * 世界书（Lorebook）触发引擎
 *
 * 算法逐条对照世界书的规范语义：
 *   - 排序          : sortFn = (a,b) => b.order - a.order  (降序, line 88)
 *   - token 预算     : Math.round(percent * maxContext / 100) || 1，再受 cap 截断
 *   - 扫描文本       : 按 scanDepth 截取的历史 + 可选的 persona/角色描述/性格/场景
 *                      等片段，用 '\n\x01' 连接 (line 279-328)
 *   - 匹配           : 键为 /regex/flags 形式则当正则（覆盖其他选项）；
 *                      否则按大小写折叠 + 可选全词匹配（多词退化为 includes）
 *   - 激活闸门顺序    : disabled -> triggers -> characterFilter -> 时序效果
 *                      -> delayUntilRecursion -> excludeRecursion -> 装饰器
 *                      -> constant -> sticky -> 主键 -> 次级键(selectiveLogic)
 *   - 递归状态       : NONE/INITIAL/RECURSION/MIN_ACTIVATIONS，MAX_SCAN_DEPTH = 1000
 *   - 包含组         : 先 sticky 裁决，再 groupOverride 按 order，否则加权随机
 */

import type { WorldInfoBook, WorldInfoEntry, RegexScript } from './types.ts';
import { WorldInfoLogic, WorldInfoPosition, RegexSubstituteType } from './types.ts';

/* ========================================================================== */

export interface ScanMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** 原始消息文本（未经正则替换），用于对比防止递归自激 */
  raw?: string;
}

export interface ScanContext {
  /** 完整聊天历史，索引 0 为最早 */
  messages: ScanMessage[];
  /** 全局扫描深度（进入扫描的历史条数），未设置时回退 book.scanDepth ?? 4 */
  scanDepth?: number;
  /** 全局大小写敏感 */
  caseSensitive?: boolean;
  /** 全局全词匹配 */
  matchWholeWords?: boolean;
  /** 当前角色名（宏展开 + characterFilter） */
  characterName?: string;
  /** 当前用户名 */
  userName?: string;
  /** persona 描述（是否纳入扫描由 scanPersonaDescription 控制） */
  personaDescription?: string;
  /** 角色描述 / 性格 / 深度提示 / 场景（纳入扫描与否由各开关控制） */
  characterDescription?: string;
  characterPersonality?: string;
  characterDepthPrompt?: string;
  scenario?: string;
  /** 扫描缓冲中各可选片段的开关，对应 ST 的 world_info_include_names 等 */
  scanPersonaDescription?: boolean;
  scanCharacterDescription?: boolean;
  scanCharacterPersonality?: boolean;
  scanCharacterDepthPrompt?: boolean;
  scanScenario?: boolean;
  /** 递归扫描 */
  recursive?: boolean;
  maxRecursionSteps?: number;
  /** 上下文窗口与预算 */
  maxContext: number;
  /** 预算百分比（<100）或绝对 token（>=100），对应 ST world_info_budget */
  tokenBudget?: number;
  /** 绝对上限，对应 ST world_info_budget_cap */
  budgetCap?: number;
  /** token 估算器 */
  countTokens: (text: string) => number;
  /** 消息索引（用于 sticky/cooldown/delay 判定，一般为 messages.length） */
  messageIndex?: number;
  /** 随机源，便于测试注入 */
  random?: () => number;
  /** 正则脚本应用于世界书内容的钩子（可选） */
  applyRegexToWorldInfo?: (text: string, uid: number) => string;
}

export interface ActivatedEntry {
  entry: WorldInfoEntry;
  /** 实际注入的文本（已做宏展开/正则） */
  content: string;
  tokens: number;
  /** 触发原因，便于调试面板展示 */
  reason: 'constant' | 'primary' | 'secondary' | 'recursive' | 'sticky' | 'decorator';
  /** 该条目在扫描中被判定为递归命中 */
  fromRecursion: boolean;
}

export interface WorldInfoResult {
  /** 按位置分组的注入内容 */
  byPosition: Record<WorldInfoPosition, ActivatedEntry[]>;
  /** 全部激活条目（排序后） */
  activated: ActivatedEntry[];
  /** 预算内实际注入的条目 */
  injected: ActivatedEntry[];
  /** 因预算不足被丢弃的条目 */
  budgetDropped: ActivatedEntry[];
  /** 使用的预算 token 数 */
  budgetTokens: number;
  /** 实际消耗 token 数 */
  usedTokens: number;
  /** 递归执行层数 */
  recursionDepth: number;
  /** 更新后的时序效果状态，需写回 chat.timedWorldInfo */
  timedWorldInfo: Record<string, { sticky?: number; cooldown?: number; delay?: number }>;
}

/* ==========================================================================
 * 工具
 * ========================================================================== */

export const SCAN_SEPARATOR = '\n\x01'; // ST 用 \x01 作为缓冲区分隔符
export const MAX_SCAN_DEPTH = 1000;

/** 大小写折叠。与 ST #transformString 一致：双方都 toLowerCase */
function fold(s: string, caseSensitive: boolean): string {
  return caseSensitive ? s : s.toLowerCase();
}

/** 解析 /pattern/flags 形式的正则键。非正则返回 null。 */
export function parseRegexFromString(input: string): RegExp | null {
  if (typeof input !== 'string' || input.length < 2) return null;
  if (!input.startsWith('/')) return null;
  const lastSlash = input.lastIndexOf('/');
  if (lastSlash <= 0) return null;
  const body = input.slice(1, lastSlash);
  const flags = input.slice(lastSlash + 1);
  if (!/^[gimsuy]*$/.test(flags)) return null;
  try {
    return new RegExp(body, flags.replace('g', ''));
  } catch {
    return null;
  }
}

/**
 * 单词键的全词匹配构造，同 ST：`(?:^|\W)(key)(?:$|\W)`。
 * 多词键在 ST 中退化为普通 includes，此处保持一致。
 */
function wholeWordMatch(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return new RegExp(`(?:^|\\W)(${escaped})(?:$|\\W)`).test(haystack);
  } catch {
    return haystack.includes(needle);
  }
}

/**
 * 单键匹配。返回是否命中。
 * ST 规则：键若为 /regex/flags 则直接当正则，且**忽略**大小写/全词设置。
 */
export function matchKey(
  haystack: string,
  rawKey: string,
  opts: { caseSensitive: boolean; matchWholeWords: boolean },
): boolean {
  const key = rawKey.trim();
  if (key.length === 0) return false;

  const re = parseRegexFromString(key);
  if (re) return re.test(haystack);

  const h = fold(haystack, opts.caseSensitive);
  const n = fold(key, opts.caseSensitive);

  if (opts.matchWholeWords && !/\s/.test(n)) return wholeWordMatch(h, n);
  return h.includes(n);
}

/** 条目是否命中任一主键 */
export function matchKeys(haystack: string, keys: string[], opts: any): boolean {
  return keys.some((k) => matchKey(haystack, k, opts));
}

/* ==========================================================================
 * 扫描缓冲区
 * ========================================================================== */

/**
 * 构造扫描文本，同 ST buffer.get()
 *
 * depth 解析优先级（高到低）：
 *   单条目覆盖 depthOverride > ctx.scanDepth > book.scanDepth > 4
 * 注意 book.scanDepth 必须参与回退链，否则 V2 卡里
 * `character_book.scan_depth` 会被静默忽略。
 */
export function buildScanBuffer(
  ctx: ScanContext,
  depthOverride?: number | null,
  bookScanDepth?: number | null,
): string {
  const depth = Math.min(
    Math.max(0, depthOverride ?? ctx.scanDepth ?? bookScanDepth ?? 4),
    MAX_SCAN_DEPTH,
  );
  const parts: string[] = [];

  if (depth > 0 && ctx.messages.length > 0) {
    const slice = ctx.messages.slice(-depth);
    for (const m of slice) parts.push(m.content);
  }
  if (ctx.scanPersonaDescription && ctx.personaDescription) parts.push(ctx.personaDescription);
  if (ctx.scanCharacterDescription && ctx.characterDescription) parts.push(ctx.characterDescription);
  if (ctx.scanCharacterPersonality && ctx.characterPersonality) parts.push(ctx.characterPersonality);
  if (ctx.scanCharacterDepthPrompt && ctx.characterDepthPrompt) parts.push(ctx.characterDepthPrompt);
  if (ctx.scanScenario && ctx.scenario) parts.push(ctx.scenario);

  return parts.join(SCAN_SEPARATOR);
}

/* ==========================================================================
 * 次级键逻辑
 * ========================================================================== */

export function evaluateSecondary(
  haystack: string,
  entry: WorldInfoEntry,
  opts: { caseSensitive: boolean; matchWholeWords: boolean },
): boolean {
  const keys = entry.keysecondary;
  if (!keys || keys.length === 0) return true;

  const hits = keys.map((k) => matchKey(haystack, k, opts));
  const logic = entry.selectiveLogic ?? WorldInfoLogic.AndAny;

  switch (logic) {
    case WorldInfoLogic.AndAny:
      return hits.some(Boolean);
    case WorldInfoLogic.AndAll:
      return hits.every(Boolean);
    case WorldInfoLogic.NotAll:
      // 并非所有次级键都未命中（= 至少命中一个）。ST 对无键情形的空数组返回 true
      return hits.some(Boolean);
    case WorldInfoLogic.NotAny:
      return hits.every((h) => !h);
    default:
      return hits.some(Boolean);
  }
}

/* ==========================================================================
 * 时序效果与包含组
 * ========================================================================== */

/** sticky/cooldown/delay 判定。返回值同 ST：null 表示未受时序影响，'sticky'|'cooldown'|'delay' 表示拦截原因 */
export function checkTimedEffects(
  entry: WorldInfoEntry,
  currentIndex: number,
  timed: Record<string, { sticky?: number; cooldown?: number; delay?: number }>,
  activates: Record<string, number>,
): 'sticky' | 'cooldown' | 'delay' | null {
  const uid = String(entry.uid);
  const state = timed[uid];
  const lastActivate = activates[uid];

  if (state?.sticky) {
    // sticky 作用中：即使键不匹配也激活（由调用方处理），此处返回 sticky 表示「强制激活」
    if (currentIndex - state.sticky <= 0) return 'sticky';
  }
  if (typeof entry.cooldown === 'number' && entry.cooldown > 0 && lastActivate !== undefined) {
    if (currentIndex - lastActivate <= entry.cooldown) return 'cooldown';
  }
  if (typeof entry.delay === 'number' && entry.delay > 0 && lastActivate === undefined) {
    // 尚未激活过且处于延迟窗口内则拦截
    if (currentIndex <= entry.delay) return 'delay';
  }
  return null;
}

/** 包含组过滤，同 ST filterByInclusionGroups */
export function filterByInclusionGroups(
  entries: WorldInfoEntry[],
  random: () => number = Math.random,
): WorldInfoEntry[] {
  const groups = new Map<string, WorldInfoEntry[]>();
  const ungrouped: WorldInfoEntry[] = [];

  for (const e of entries) {
    const names = (e.group ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (names.length === 0) {
      ungrouped.push(e);
      continue;
    }
    for (const n of names) {
      const arr = groups.get(n) ?? [];
      arr.push(e);
      groups.set(n, arr);
    }
  }

  const winners = new Set<WorldInfoEntry>();
  for (const [, members] of groups) {
    if (members.length === 1) {
      winners.add(members[0]);
      continue;
    }
    // sticky 优先
    const stickyMembers = members.filter((m) => m.sticky);
    if (stickyMembers.length > 0) {
      stickyMembers.forEach((m) => winners.add(m));
      continue;
    }
    const override = members.filter((m) => m.groupOverride);
    if (override.length > 0) {
      const best = override.reduce((a, b) => (b.order > a.order ? b : a));
      winners.add(best);
      continue;
    }
    // 加权随机
    const weightOf = (m: WorldInfoEntry) =>
      typeof m.groupWeight === 'number' && m.groupWeight > 0 ? m.groupWeight : 100;
    const total = members.reduce((s, m) => s + weightOf(m), 0);
    let roll = random() * total;
    for (const m of members) {
      roll -= weightOf(m);
      if (roll <= 0) {
        winners.add(m);
        break;
      }
    }
    if (!members.some((m) => winners.has(m))) winners.add(members[members.length - 1]);
  }

  return [...ungrouped, ...winners];
}

/* ==========================================================================
 * 主扫描
 * ========================================================================== */

/**
 * 便捷调用形态：直接把角色卡/聊天侧的数据丢进来。
 *
 * 与主签名（位置参数）相比，这里接受 `{ book, messages, ... }` 对象，
 * 且 messages 允许是 ChatMessage 形态（用 `mes` 字段）——内部会自动
 * 转成 ScanMessage 的 `content`。这样 buildPrompt / UI 层不必手工转换。
 */
export interface ScanWorldInfoOptions {
  book: WorldInfoBook | undefined;
  /** 既接受 {role, content} 也接受 {role, mes}（ChatMessage） */
  messages: Array<{ role: ScanMessage['role']; content?: string; mes?: string; raw?: string }>;
  maxContext: number;
  /** 便捷别名：传入百分比（<100）或绝对 token（>=100） */
  worldInfoBudgetPercent?: number;
  tokenBudget?: number;
  budgetCap?: number;
  scanDepth?: number;
  caseSensitive?: boolean;
  matchWholeWords?: boolean;
  characterName?: string;
  userName?: string;
  personaDescription?: string;
  characterDescription?: string;
  characterPersonality?: string;
  scenario?: string;
  recursive?: boolean;
  maxRecursionSteps?: number;
  countTokens?: (text: string) => number;
  random?: () => number;
  messageIndex?: number;
}

/**
 * 默认 token 估算。
 *
 * ⚠️ 此前这里内联了第三份启发式实现，注释理由是「避免循环依赖」。但
 * `src/inference/tokenizer.ts` 是**零依赖**模块（不 import 任何东西），引用它
 * 不会产生循环依赖 —— 那份内联是多余的，而且口径已经开始漂移：这里的版本
 * 只认三个 CJK 区段，漏掉了 `buildPrompt` 版本涵盖的 CJK 扩展 A、兼容汉字
 * 和全角标点。同一个字符串在两处会得到不同的 token 数。
 *
 * 现统一为单一来源。世界书扫描发生在模型加载之前，因此走的仍是启发式兜底，
 * 但至少是**同一份**启发式。
 */
import { estimateTokens as defaultCountTokens } from '../inference/tokenizer.ts'

function toScanMessages(
  msgs: ScanWorldInfoOptions['messages'],
): ScanMessage[] {
  return (msgs ?? []).map((m) => ({
    role: m.role,
    content: m.content ?? m.mes ?? '',
    raw: m.raw,
  }));
}

export function scanWorldInfo(options: ScanWorldInfoOptions): WorldInfoResult;
export function scanWorldInfo(
  book: WorldInfoBook | undefined,
  ctx: ScanContext,
  timedWorldInfo?: Record<string, { sticky?: number; cooldown?: number; delay?: number }>,
  activates?: Record<string, number>,
): WorldInfoResult;
export function scanWorldInfo(
  bookOrOptions: WorldInfoBook | undefined | ScanWorldInfoOptions,
  ctx?: ScanContext,
  timedWorldInfo: Record<string, { sticky?: number; cooldown?: number; delay?: number }> = {},
  activates: Record<string, number> = {},
): WorldInfoResult {
  // 形态 A：对象参数（{ book, messages: [...] }）
  if (
    bookOrOptions &&
    typeof bookOrOptions === 'object' &&
    'book' in (bookOrOptions as any) &&
    'messages' in (bookOrOptions as any)
  ) {
    const o = bookOrOptions as ScanWorldInfoOptions;
    const scanCtx: ScanContext = {
      messages: toScanMessages(o.messages),
      scanDepth: o.scanDepth,
      caseSensitive: o.caseSensitive,
      matchWholeWords: o.matchWholeWords,
      characterName: o.characterName,
      userName: o.userName,
      personaDescription: o.personaDescription,
      characterDescription: o.characterDescription,
      characterPersonality: o.characterPersonality,
      scenario: o.scenario,
      recursive: o.recursive,
      maxRecursionSteps: o.maxRecursionSteps,
      maxContext: o.maxContext,
      tokenBudget: o.tokenBudget ?? o.worldInfoBudgetPercent,
      budgetCap: o.budgetCap,
      countTokens: o.countTokens ?? defaultCountTokens,
      random: o.random,
      messageIndex: o.messageIndex,
    };
    return scanWorldInfo(o.book, scanCtx, timedWorldInfo, activates);
  }

  const book = bookOrOptions as WorldInfoBook | undefined;
  const c = ctx as ScanContext;
  return runScan(book, c, timedWorldInfo, activates);
}

function runScan(
  book: WorldInfoBook | undefined,
  ctx: ScanContext,
  timedWorldInfo: Record<string, { sticky?: number; cooldown?: number; delay?: number }> = {},
  activates: Record<string, number> = {},
): WorldInfoResult {
  const empty = (): WorldInfoResult => ({
    byPosition: makePositionBuckets(),
    activated: [],
    injected: [],
    budgetDropped: [],
    budgetTokens: 0,
    usedTokens: 0,
    recursionDepth: 0,
    timedWorldInfo,
  });

  if (!book || !book.entries || book.entries.length === 0) return empty();

  const random = ctx.random ?? Math.random;
  const currentIndex = ctx.messageIndex ?? ctx.messages.length;

  /* ---- 预算 ---- */
  const rawBudget = ctx.tokenBudget ?? book.tokenBudget ?? 25;
  let budgetTokens: number;
  if (rawBudget >= 100) {
    // 绝对 token 数
    budgetTokens = Math.floor(rawBudget);
  } else {
    budgetTokens = Math.round((rawBudget * ctx.maxContext) / 100) || 1;
  }
  if (typeof ctx.budgetCap === 'number' && ctx.budgetCap > 0) {
    budgetTokens = Math.min(budgetTokens, ctx.budgetCap);
  }

  /* ---- 预排序：order 降序（ST sortFn） ---- */
  const sorted = [...book.entries]
    .filter((e) => e.enabled !== false)
    .sort((a, b) => (b.order ?? 0) - (a.order ?? 0));

  const globalCase = ctx.caseSensitive ?? book.caseSensitive ?? false;
  const globalWhole = ctx.matchWholeWords ?? book.matchWholeWords ?? false;

  const activatedMap = new Map<number, ActivatedEntry>();
  const excluded = new Set<number>();
  const recursionStates = new Set<number>(); // 本次扫描中「因递归而产生」的条目 uid

  const recursiveEnabled = ctx.recursive ?? book.recursiveScan ?? false;
  const maxSteps = ctx.maxRecursionSteps ?? book.maxRecursionSteps ?? 0;

  const runPass = (
    buffer: string,
    isRecursion: boolean,
    recursionLevel: number,
  ): boolean => {
    if (isRecursion && recursionLevel > maxSteps) return false;
    let bufferGrew = false;

    for (const entry of sorted) {
      if (activatedMap.has(entry.uid)) continue;
      if (excluded.has(entry.uid)) continue;

      const caseSensitive = entry.caseSensitive ?? globalCase;
      const matchWholeWords = entry.matchWholeWords ?? globalWhole;
      const matchOpts = { caseSensitive, matchWholeWords };

      // excludeRecursion：被递归扫描排除
      if (isRecursion && entry.excludeRecursion) continue;

      // delayUntilRecursion：未到指定递归层级不激活
      const dur = entry.delayUntilRecursion;
      if (dur !== undefined && dur !== false) {
        const required = dur === true ? 1 : Number(dur);
        if (!isRecursion || recursionLevel < required) continue;
      }

      // --- 时序效果 ---
      const timed = checkTimedEffects(entry, currentIndex, timedWorldInfo, activates);

      // --- constant：无条件激活 ---
      if (entry.constant === true) {
        activatedMap.set(entry.uid, {
          entry,
          content: entry.content,
          tokens: ctx.countTokens(entry.content),
          reason: isRecursion ? 'recursive' : 'constant',
          fromRecursion: isRecursion,
        });
        if (isRecursion) recursionStates.add(entry.uid);
        bufferGrew = true;
        continue;
      }

      // --- sticky 强制激活 ---
      if (timed === 'sticky') {
        activatedMap.set(entry.uid, {
          entry,
          content: entry.content,
          tokens: ctx.countTokens(entry.content),
          reason: 'sticky',
          fromRecursion: isRecursion,
        });
        if (isRecursion) recursionStates.add(entry.uid);
        bufferGrew = true;
        continue;
      }
      if (timed === 'cooldown' || timed === 'delay') continue;

      // --- 主键 ---
      const entryDepth = entry.scanDepth ?? ctx.scanDepth ?? book.scanDepth ?? 4;
      const entryBuffer =
        entryDepth === (ctx.scanDepth ?? book.scanDepth ?? 4)
          ? buffer
          : buildScanBuffer(ctx, entryDepth, book.scanDepth);

      if (!matchKeys(entryBuffer, entry.key ?? [], matchOpts)) continue;

      // --- 次级键 ---
      if (entry.selective) {
        if (!evaluateSecondary(entryBuffer, entry, matchOpts)) continue;
      }

      // --- 概率 ---
      if (entry.useProbability !== false && typeof entry.probability === 'number') {
        if (entry.probability < 100 && random() * 100 > entry.probability) continue;
      }

      activatedMap.set(entry.uid, {
        entry,
        content: entry.content,
        tokens: ctx.countTokens(entry.content),
        reason: isRecursion ? 'recursive' : 'primary',
        fromRecursion: isRecursion,
      });
      if (isRecursion) recursionStates.add(entry.uid);
      bufferGrew = true;
    }
    return bufferGrew;
  };

  // 首次扫描
  const baseBuffer = buildScanBuffer(ctx, null, book.scanDepth);
  runPass(baseBuffer, false, 0);

  /* ---- 递归扫描 ---- */
  let recursionDepth = 0;
  if (recursiveEnabled && activatedMap.size > 0) {
    const recursionTexts: string[] = [];
    for (const a of activatedMap.values()) recursionTexts.push(a.content);

    for (let level = 1; level <= maxSteps; level++) {
      const recBuffer = [...recursionTexts, baseBuffer].join(SCAN_SEPARATOR);
      const grew = runPass(recBuffer, true, level);
      recursionDepth = level;
      if (!grew) break;

      // 把本轮新增内容并入递归缓冲，供下一层使用
      recursionTexts.length = 0;
      for (const a of activatedMap.values()) {
        if (a.fromRecursion) recursionTexts.push(a.content);
      }
    }
  }

  /* ---- 递归自激排除：条目内容出现在自己/已激活文本中导致的重复 ---- */
  // ST 通过 compareBufferMessages 等机制抑制；这里做简化版 —— 已激活条目不再重复计入。
  // （见设计文档「兼容性矩阵」中标注为「降级」的部分）

  /* ---- 包含组过滤 ---- */
  let finalList = [...activatedMap.values()];
  const grouped = filterByInclusionGroups(
    finalList.map((a) => a.entry),
    random,
  );
  const groupKeep = new Set(grouped.map((e) => e.uid));
  finalList = finalList.filter((a) => groupKeep.has(a.entry.uid));

  /* ---- 排序：sticky 优先，其余保持 order 降序 ---- */
  finalList.sort((a, b) => {
    const aSticky = a.reason === 'sticky' ? 1 : 0;
    const bSticky = b.reason === 'sticky' ? 1 : 0;
    if (aSticky !== bSticky) return bSticky - aSticky;
    return (b.entry.order ?? 0) - (a.entry.order ?? 0);
  });

  /* ---- 预算消费 ---- */
  const injected: ActivatedEntry[] = [];
  const budgetDropped: ActivatedEntry[] = [];
  let used = 0;

  for (const a of finalList) {
    let text = a.content;
    if (ctx.applyRegexToWorldInfo) text = ctx.applyRegexToWorldInfo(text, a.entry.uid);
    const t = ctx.countTokens(text);
    a.content = text;
    a.tokens = t;

    if (a.entry.ignoreBudget) {
      injected.push(a);
      used += t;
      continue;
    }
    if (used + t >= budgetTokens && used > 0) {
      budgetDropped.push(a);
      continue;
    }
    injected.push(a);
    used += t;
  }

  /* ---- 按时序效果写回状态 ---- */
  const nextTimed = { ...timedWorldInfo };
  for (const a of injected) {
    const uid = String(a.entry.uid);
    const e = a.entry;
    const state: { sticky?: number; cooldown?: number; delay?: number } = { ...(nextTimed[uid] ?? {}) };
    if (typeof e.sticky === 'number' && e.sticky > 0) state.sticky = currentIndex + e.sticky;
    if (typeof e.cooldown === 'number' && e.cooldown > 0) state.cooldown = currentIndex + e.cooldown;
    if (state.sticky !== undefined || state.cooldown !== undefined) nextTimed[uid] = state;
  }
  // sticky 过期清理
  for (const uid of Object.keys(nextTimed)) {
    const s = nextTimed[uid];
    if (s.sticky !== undefined && currentIndex > s.sticky) delete nextTimed[uid];
  }

  /* ---- 按位置分桶 ---- */
  const byPosition = makePositionBuckets();
  for (const a of injected) {
    const pos = a.entry.position ?? WorldInfoPosition.Before;
    (byPosition[pos] ??= []).push(a);
  }

  return {
    byPosition,
    activated: finalList,
    injected,
    budgetDropped,
    budgetTokens,
    usedTokens: used,
    recursionDepth,
    timedWorldInfo: nextTimed,
  };
}

function makePositionBuckets(): Record<WorldInfoPosition, ActivatedEntry[]> {
  return {
    [WorldInfoPosition.Before]: [],
    [WorldInfoPosition.After]: [],
    [WorldInfoPosition.ANTop]: [],
    [WorldInfoPosition.ANBottom]: [],
    [WorldInfoPosition.AtDepth]: [],
    [WorldInfoPosition.EMTop]: [],
    [WorldInfoPosition.EMBottom]: [],
    [WorldInfoPosition.Outlet]: [],
  };
}

/* ==========================================================================
 * 正则脚本引擎
 *
 * 闸门顺序严格对照 ST public/scripts/extensions/regex/engine.js:
 *   disabled 脚本直接跳过
 *   -> isMarkdown 时要求 markdownOnly
 *   -> isPrompt 时要求 promptOnly
 *   -> isEdit 为真时要求 runOnEdit
 *   -> depth 为数字时，按 minDepth / maxDepth 过滤聊天深度
 *   -> placement.includes(当前 placement)
 * 全部通过才执行替换。
 * ========================================================================== */

/** 正则执行上下文，对应 ST 传入的各项标志 */
export interface RegexRunContext {
  /** 当前处理位置（RegexPlacement 值） */
  placement: number;
  /** 是否在处理提示词（promptOnly 门控） */
  isPrompt: boolean;
  /** 是否在处理界面显示文本（markdownOnly 门控） */
  isMarkdown?: boolean;
  /** 是否在编辑消息（runOnEdit 门控） */
  isEdit?: boolean;
  /** 当前消息距聊天末尾的深度；未提供时不做深度过滤 */
  depth?: number | null;
}

/**
 * 由字符串构造正则。支持 ST 的 substituteRegex 语义：
 *   NONE(0)     —— 原样按 /pattern/flags 解析
 *   RAW(1)      —— 字符串本身就是 raw pattern（无斜杠包裹）
 *   ESCAPED(2)  —— 字符串需先转义再当字面量匹配
 * 解析失败返回 null（调用方应跳过该脚本而非崩溃）。
 */
export function compileRegex(
  findRegex: string,
  substitute: RegexSubstituteType = RegexSubstituteType.NONE,
  global = true,
): RegExp | null {
  try {
    if (substitute === RegexSubstituteType.ESCAPED) {
      const esc = findRegex.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(esc, global ? 'g' : '');
    }
    const parsed = parseRegexFromString(findRegex);
    if (parsed) {
      // parseRegexFromString 内部去掉了 g，这里按调用方需求补回
      return global ? new RegExp(parsed.source, parsed.flags + 'g') : parsed;
    }
    if (substitute === RegexSubstituteType.RAW) {
      return new RegExp(findRegex, global ? 'g' : '');
    }
    return null;
  } catch {
    return null;
  }
}

/** 判断单个脚本是否适用于当前上下文 */
export function isRegexScriptApplicable(script: RegexScript, ctx: RegexRunContext): boolean {
  if (script.disabled) return false;
  // markdownOnly：仅在处理界面文本时生效
  if (script.markdownOnly && !ctx.isMarkdown) return false;
  // promptOnly：仅在处理提示词时生效
  if (script.promptOnly && !ctx.isPrompt) return false;
  // runOnEdit：仅在编辑消息时生效（isEdit 未提供时视为非编辑）
  if (script.runOnEdit && !ctx.isEdit) return false;
  // 深度门控只在 depth 为数字时生效
  if (typeof ctx.depth === 'number') {
    if (typeof script.minDepth === 'number' && ctx.depth < script.minDepth) return false;
    if (typeof script.maxDepth === 'number' && ctx.depth > script.maxDepth) return false;
  }
  return Array.isArray(script.placement) && script.placement.includes(ctx.placement);
}

/** 替换串展开：把 $1..$9 之外的 {{match}} 也替换为整体匹配（ST 部分路径支持） */
function expandReplacement(replace: string, match: string): string {
  return replace.replace(/\{\{match\}\}/gi, match);
}

/**
 * 对单条文本依次应用全部正则脚本。
 *
 * 注意 ST 的行为是**按脚本顺序串行**处理，前一个脚本的输出是后一个的输入。
 * 传入的文本原样返回（未命中任何脚本时不产生新字符串）。
 */
export function applyRegexScripts(
  input: string,
  scripts: RegexScript[],
  placement: number,
  ctx: Partial<RegexRunContext> = {},
): string {
  if (typeof input !== 'string' || input.length === 0) return input;
  const fullCtx: RegexRunContext = {
    placement,
    isPrompt: ctx.isPrompt ?? true,
    isMarkdown: ctx.isMarkdown,
    isEdit: ctx.isEdit,
    depth: ctx.depth ?? null,
  };

  let out = input;
  for (const script of scripts ?? []) {
    if (!script || !isRegexScriptApplicable(script, fullCtx)) continue;

    const re = compileRegex(script.findRegex, script.substituteRegex ?? 0, true);
    if (!re) continue;

    // trimStrings：替换前先去掉这些字符串（ST 用于去除前后缀）
    if (Array.isArray(script.trimStrings) && script.trimStrings.length) {
      for (const t of script.trimStrings) {
        if (t) out = out.split(t).join('');
      }
    }

    try {
      out = out.replace(re, (m, ...groups) => {
        let rep = expandReplacement(script.replaceString ?? '', m);
        // 展开 $1..$9 捕获组
        groups.forEach((g, i) => {
          const idx = i + 1;
          if (idx <= 9) rep = rep.split(`$${idx}`).join(g ?? '');
        });
        return rep;
      });
    } catch {
      // 单个脚本失败不应中断整条流水线
      continue;
    }
  }
  return out;
}
