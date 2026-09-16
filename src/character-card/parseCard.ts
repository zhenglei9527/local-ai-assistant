/**
 * 角色卡解析器：JSON 卡 + PNG 内嵌卡
 *
 * 解析策略（逐条对照角色卡规范的字段定义）：
 *   1. PNG 签名校验 8 字节
 *   2. 逐 chunk 遍历，只关心 tEXt
 *   3. tEXt 载荷结构 = keyword \0 text（keyword 为 1-79 个 Latin-1 字符）
 *   4. 关键词**小写比较**：`ccv3` 优先于 `chara`；两者都有时 ccv3 胜出
 *   5. 文本按 **base64 解码 UTF-8** —— ST 对 V2/V3 两者都无条件 base64 解码
 *   6. 兼容兜底：若 base64 解码失败或解出的不是 JSON，则退回「原文即 JSON」
 *      （对应 V1 时代部分写卡工具不编码的情况，ST 自身没有这条分支）
 */

import type {
  CharacterCardData,
  CharacterCardV1,
  CharacterCardV2,
  CharacterCardV3,
  NormalizedCharacter,
  WorldInfoBook,
  WorldInfoEntry,
} from './types.ts';
// WorldInfoPosition 是运行时值（const 对象），不能用 import type
import { WorldInfoPosition } from './types.ts';

/* ==========================================================================
 * PNG 底层
 * ========================================================================== */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface PngTextChunk {
  /** 原始关键词（保留大小写） */
  keyword: string;
  /** 关键词之后、\0 之后的文本内容（原始字符串，未 base64 解码） */
  text: string;
  /** chunk 类型，本解析器只会产出 'tEXt' */
  type: string;
}

function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  return true;
}

/** 大端读取 32 位无符号整数 */
function readUInt32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) >>> 0) +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}

/**
 * 遍历 PNG，返回全部 tEXt chunk。
 *
 * PNG chunk 结构（RFC 2083 / W3C PNG 规范）：
 *   +--------+--------+--------+--------+--------+--------+--------+--------+
 *   |  Length (4 bytes, big-endian)     |  Type (4 bytes ASCII)             |
 *   +--------+--------+--------+--------+--------+--------+--------+--------+
 *   |  Data (Length bytes)              |  CRC (4 bytes, big-endian)        |
 *   +----------------------------------+---------------------------------+
 *
 * tEXt 的 Data 为：keyword(1-79 bytes) + 0x00 + text(剩余)
 *
 * 遍历终止条件：遇到 IEND，或 Length 越界（防御损坏/截断文件，
 * 否则畸形 length 会导致巨大的循环或越界读取）。
 */
export function extractTextChunks(bytes: Uint8Array): PngTextChunk[] {
  if (!isPng(bytes)) throw new Error('parseCard: 不是合法的 PNG（签名不匹配）');

  const chunks: PngTextChunk[] = [];
  let offset = 8; // 跳过签名

  while (offset + 8 <= bytes.length) {
    const length = readUInt32BE(bytes, offset);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );

    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    // 越界保护：数据段 + 4 字节 CRC 必须落在文件内
    if (dataEnd + 4 > bytes.length) {
      // 截断文件：尽力而为，读到哪算哪
      break;
    }

    if (type === 'tEXt') {
      const data = bytes.subarray(dataStart, dataEnd);
      const nul = data.indexOf(0);
      if (nul > 0) {
        const keyword = latin1Decode(data.subarray(0, nul));
        const text = latin1Decode(data.subarray(nul + 1));
        chunks.push({ keyword, text, type });
      }
    }

    offset = dataEnd + 4; // 跳过 CRC
    if (type === 'IEND') break;
  }

  return chunks;
}

/** PNG tEXt 的 keyword 定义为 Latin-1；此处按字节直转，避免 UTF-8 误判 */
function latin1Decode(bytes: Uint8Array): string {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...(bytes.subarray(i, i + CHUNK) as unknown as number[]));
  }
  return out;
}

/* ==========================================================================
 * base64 / UTF-8
 * ========================================================================== */

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64ToBytes(input: string): Uint8Array {
  const clean = input.replace(/[\s\r\n]/g, '');
  if (clean.length === 0 || /[^A-Za-z0-9+/\-_=]/.test(clean)) {
    throw new Error('parseCard: 内容不是合法 base64');
  }
  const normalized = clean.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');

  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of normalized) {
    const idx = B64_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('parseCard: 内容不是合法 base64');
    buffer = (buffer << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

function utf8Decode(bytes: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
  // 极简回退（Hermes 无 TextDecoder 时；RN 新版已有）
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i += 1;
    } else if (b < 0xe0) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if (b < 0xf0) {
      out += String.fromCharCode(
        ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f),
      );
      i += 3;
    } else {
      const cp =
        ((b & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f);
      const v = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
      i += 4;
    }
  }
  return out;
}

/* ==========================================================================
 * 格式识别与归一化
 * ========================================================================== */

const V1_FIELDS = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'];

/** 判断对象是否为 V2/V3 包装格式 */
function detectSpec(obj: any): 'chara_card_v1' | 'chara_card_v2' | 'chara_card_v3' {
  if (obj && typeof obj === 'object' && obj.data && typeof obj.data === 'object') {
    if (obj.spec === 'chara_card_v3') return 'chara_card_v3';
    if (obj.spec === 'chara_card_v2') return 'chara_card_v2';
    // spec 字段缺失但存在 data：V3 规范建议按 data 结构判断，
    // 这里保守处理为 V2（V3 是超集，V2 路径不会丢字段）
    if (obj.spec === undefined) return 'chara_card_v2';
    // 未知 spec 字符串：也按 V2 处理并告警，避免直接拒绝
    return 'chara_card_v2';
  }
  return 'chara_card_v1';
}

function asString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

/**
 * alternate_greetings 容错。
 * ST characters.js:572-575 明确分支：数组直接用，字符串包装为单元素数组，
 * 其他类型返回 []。真实卡里存在字符串形态，直接当数组用会崩。
 */
function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(asString).filter((s) => s.length > 0 || true);
  if (typeof v === 'string') return v.length > 0 ? [v] : [];
  return [];
}

/** character_book -> WorldInfoBook。字段映射对照 characters.js:5620+ */
export function normalizeCharacterBook(raw: any): WorldInfoBook | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const entriesRaw = Array.isArray(raw.entries) ? raw.entries : [];
  const entries: WorldInfoEntry[] = entriesRaw.map((e: any, i: number) => {
    const ext = (e && typeof e.extensions === 'object' && e.extensions) || {};
    const posRaw = e?.extensions?.position ?? e?.position;
    let position: WorldInfoPosition;
    if (posRaw === 'before_char') position = WorldInfoPosition.Before;
    else if (posRaw === 'after_char') position = WorldInfoPosition.After;
    else if (typeof posRaw === 'number') position = posRaw as WorldInfoPosition;
    else position = WorldInfoPosition.Before; // 规范默认值
    return {
      uid: i,
      comment: asString(e?.comment) || asString(e?.name) || undefined,
      key: asStringArray(e?.keys),
      keysecondary: asStringArray(e?.secondary_keys),
      content: asString(e?.content),
      order: typeof e?.insertion_order === 'number' ? e.insertion_order : 100,
      enabled: e?.enabled !== false,
      constant: e?.constant === true,
      selective: e?.selective === true,
      selectiveLogic:
        typeof ext.selectiveLogic === 'number'
          ? ext.selectiveLogic
          : typeof e?.selectiveLogic === 'number'
            ? e.selectiveLogic
            : 0,
      caseSensitive:
        typeof e?.case_sensitive === 'boolean' ? e.case_sensitive : (ext.caseSensitive ?? null),
      matchWholeWords:
        typeof e?.match_whole_words === 'boolean'
          ? e.match_whole_words
          : (ext.matchWholeWords ?? null),
      position,
      depth: typeof ext.depth === 'number' ? ext.depth : typeof e?.depth === 'number' ? e.depth : 4,
      role: ext.role ?? null,
      excludeRecursion: ext.excludeRecursion === true,
      preventRecursion: ext.preventRecursion === true,
      delayUntilRecursion: ext.delayUntilRecursion ?? false,
      probability: typeof ext.probability === 'number' ? ext.probability : 100,
      useProbability: ext.useProbability !== false,
      scanDepth: ext.scanDepth ?? null,
      group: asString(ext.group),
      groupOverride: ext.groupOverride === true,
      groupWeight: typeof ext.groupWeight === 'number' ? ext.groupWeight : 100,
      sticky: ext.sticky ?? null,
      cooldown: ext.cooldown ?? null,
      delay: ext.delay ?? null,
      ignoreBudget: ext.ignoreBudget === true,
      characterFilter: ext.characterFilter ?? null,
      useRegex: e?.use_regex === true,
      extensions: ext,
      __raw: e,
    };
  });

  return {
    name: asString(raw.name) || undefined,
    description: asString(raw.description) || undefined,
    scanDepth: typeof raw.scan_depth === 'number' ? raw.scan_depth : undefined,
    tokenBudget: typeof raw.token_budget === 'number' ? raw.token_budget : undefined,
    recursiveScan: raw.recursive_scan === true,
    maxRecursionSteps: typeof raw.max_recursion_steps === 'number' ? raw.max_recursion_steps : undefined,
    caseSensitive: raw.case_sensitive === true,
    matchWholeWords: raw.match_whole_words === true,
    entries,
    extensions: typeof raw.extensions === 'object' && raw.extensions ? raw.extensions : undefined,
  };
}

/** 把任意版本的卡对象归一化为 NormalizedCharacter */
export function normalizeCharacter(rawCard: unknown, rawPng?: Uint8Array): NormalizedCharacter {
  const warnings: string[] = [];
  const card: any = rawCard;
  if (!card || typeof card !== 'object') {
    throw new Error('parseCard: 角色卡内容不是一个 JSON 对象');
  }

  const spec = detectSpec(card);
  let specVersion = '';
  let d: any;

  if (spec === 'chara_card_v1') {
    d = card;
    specVersion = '1.0';
    if (!V1_FIELDS.some((f) => typeof card[f] === 'string' && card[f].length > 0)) {
      warnings.push('V1 卡中六个规范字段全部为空，可能是无效卡。');
    }
  } else {
    d = card.data;
    specVersion = asString(card.spec_version) || (spec === 'chara_card_v3' ? '3.0' : '2.0');
    if (spec === 'chara_card_v2' && card.spec !== 'chara_card_v2') {
      warnings.push(`未识别的 spec 值 "${String(card.spec)}"，已按 V2 处理。`);
    }
  }

  for (const f of V1_FIELDS) {
    if (d[f] === undefined) warnings.push(`字段 ${f} 缺失，已补为空字符串。`);
  }

  const name = asString(d.name);
  const nickname = asString(d.nickname) || name;

  return {
    spec,
    specVersion,
    name,
    nickname,
    description: asString(d.description),
    personality: asString(d.personality),
    scenario: asString(d.scenario),
    firstMessage: asString(d.first_mes),
    exampleMessages: asString(d.mes_example),
    creatorNotes: asString(d.creator_notes),
    systemPrompt: asString(d.system_prompt),
    postHistoryInstructions: asString(d.post_history_instructions),
    alternateGreetings: asStringArray(d.alternate_greetings),
    groupOnlyGreetings: asStringArray(d.group_only_greetings),
    tags: asStringArray(d.tags),
    creator: asString(d.creator),
    characterVersion: asString(d.character_version),
    extensions:
      d.extensions && typeof d.extensions === 'object'
        ? (d.extensions as Record<string, unknown>)
        : {},
    characterBook: normalizeCharacterBook(d.character_book),
    assets: Array.isArray(d.assets)
      ? d.assets.map((a: any) => ({
          type: asString(a?.type) || 'icon',
          uri: asString(a?.uri),
          name: asString(a?.name) || 'main',
          ext: asString(a?.ext) || 'png',
        }))
      : [],
    rawPng,
    warnings,
  };
}

/* ==========================================================================
 * 对外入口
 * ========================================================================== */

/** 把 tEXt 的 text 还原为 JSON 对象，自动兼容「base64」与「明文 JSON」两种形态 */
export function decodeChunkPayload(text: string, warnings?: string[]): unknown {
  const trimmed = text.trim();

  // 形态 1：明文 JSON（V1 时代部分工具不编码；ST 自身无此分支）
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      warnings?.push('该 PNG 的 tEXt 内容为明文 JSON（未 base64 编码），已按兼容模式解析。');
      return parsed;
    } catch (e) {
      throw new Error(`parseCard: tEXt 内容是明文但 JSON 解析失败: ${(e as Error).message}`);
    }
  }

  // 形态 2：base64（ST 的标准路径，V2/V3 均如此）
  let decoded: string;
  try {
    decoded = utf8Decode(base64ToBytes(trimmed));
  } catch (e) {
    // 形态 3：既不是明文 JSON 也不是合法 base64 —— 报错说清两种可能
    throw new Error(
      `parseCard: 无法解码 tEXt 内容（base64 解码失败：${(e as Error).message}），` +
        '且内容不是以 "{" 开头的明文 JSON。',
    );
  }

  const decodedTrimmed = decoded.trim();
  try {
    return JSON.parse(decodedTrimmed);
  } catch {
    // base64 解出来仍非 JSON：可能整段是 URL-encoded 或二次转义，尝试一次
    try {
      return JSON.parse(decodeURIComponent(decodedTrimmed));
    } catch {
      throw new Error(
        `parseCard: base64 解码成功但内容不是合法 JSON。前 120 字符：${decodedTrimmed.slice(0, 120)}`,
      );
    }
  }
}

/**
 * 从 PNG 字节解析角色卡。
 *
 * 关键词优先级严格同 ST src/character-card-parser.js：
 *   1. `ccv3`（V3 规范新增，UTF-8 -> base64）
 *   2. `chara`（V2 规范，UTF-8 -> base64）
 *   3. 其它常见别名兜底：`character`、`Character`（大小写不敏感匹配已覆盖）
 * 两者同时存在时 ccv3 胜出，且**不合并**（V3 是超集，ccv3 已含全部信息）。
 */
export function parsePngCard(bytes: Uint8Array): NormalizedCharacter {
  const chunks = extractTextChunks(bytes);
  const warnings: string[] = [];

  const lowered = chunks.map((c) => ({ ...c, lower: c.keyword.toLowerCase() }));
  const ccv3 = lowered.find((c) => c.lower === 'ccv3');
  const chara = lowered.find((c) => c.lower === 'chara');

  let picked = ccv3 ?? chara;
  if (!picked) {
    // 兜底：有些工具写的是 character / description
    picked = lowered.find((c) => ['character', 'description', 'chara_card'].includes(c.lower));
  }

  if (!picked) {
    const found = chunks.map((c) => c.keyword).join(', ') || '(无 tEXt chunk)';
    throw new Error(`parseCard: PNG 中未找到角色卡数据。已发现的 tEXt 关键词：${found}`);
  }

  if (ccv3 && chara) {
    warnings.push('PNG 同时包含 ccv3 与 chara 两个 chunk，已使用 ccv3。');
  }

  const json = decodeChunkPayload(picked.text, warnings);
  const result = normalizeCharacter(json, bytes);

  // 若选中的是 chara 但内容是 V3，补一条说明（不改变解析结果）
  if (picked === chara && result.spec === 'chara_card_v3') {
    warnings.push('chara chunk 中实际存放的是 V3 数据（该卡由 V3 工具写出但缺少 ccv3 chunk）。');
  }

  return { ...result, warnings: [...warnings, ...result.warnings] };
}

/** 从 JSON 文本 / 对象解析角色卡（.json 卡文件或 API 返回） */
export function parseJsonCard(input: string | object): NormalizedCharacter {
  let obj: unknown;
  if (typeof input === 'string') {
    try {
      obj = JSON.parse(input);
    } catch (e) {
      throw new Error(`parseCard: JSON 解析失败: ${(e as Error).message}`);
    }
  } else {
    obj = input;
  }
  return normalizeCharacter(obj);
}

/**
 * 统一入口：按魔数自动识别 PNG 与 JSON。
 * 传入 Uint8Array 时先做 PNG 签名判断，失败则按 UTF-8 文本当 JSON 处理。
 */
export function parseCard(input: string | Uint8Array | object): NormalizedCharacter {
  if (input instanceof Uint8Array) {
    if (isPng(input)) return parsePngCard(input);
    // 非 PNG 二进制：尝试当文本解析
    return parseJsonCard(utf8Decode(input));
  }
  if (typeof input === 'string') return parseJsonCard(input);
  return parseJsonCard(input);
}

/** 写回：把归一化角色打包成 V2 卡（供导出功能使用） */
export function toV2Card(c: NormalizedCharacter): CharacterCardV2 {
  const data: CharacterCardData = {
    name: c.name,
    description: c.description,
    personality: c.personality,
    scenario: c.scenario,
    first_mes: c.firstMessage,
    mes_example: c.exampleMessages,
    creator_notes: c.creatorNotes,
    system_prompt: c.systemPrompt,
    post_history_instructions: c.postHistoryInstructions,
    alternate_greetings: c.alternateGreetings,
    character_book: c.characterBook,
    tags: c.tags,
    creator: c.creator,
    character_version: c.characterVersion,
    extensions: c.extensions,
  };
  return { spec: 'chara_card_v2', spec_version: '2.0', data };
}

/** 写回：打包成 V3 卡 */
export function toV3Card(c: NormalizedCharacter): CharacterCardV3 {
  const v2 = toV2Card(c);
  const data: CharacterCardData = {
    ...v2.data,
    nickname: c.nickname,
    assets: c.assets.length
      ? c.assets
      : [{ type: 'icon', uri: 'ccdefault:', name: 'main', ext: 'png' }],
    group_only_greetings: c.groupOnlyGreetings,
    source: [],
    creation_date: Math.floor(Date.now() / 1000),
    modification_date: Math.floor(Date.now() / 1000),
  };
  return { spec: 'chara_card_v3', spec_version: '3.0', data };
}
