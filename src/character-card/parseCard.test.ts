/**
 * 单元测试 —— 使用 Node 内置 node:test（无第三方依赖）
 *
 * 运行：
 *   node --test src/character-card/
 *
 * 依赖 Node >= 22.6 的原生 TypeScript 类型剥离（type stripping）。
 * 类型剥离只删除类型注解，不转换语法，因此源码中：
 *   - 不使用 enum（enum 需要运行时转换，类型剥离不处理）
 *   - 不使用 namespace / 参数属性
 *   - 所有 import 路径带 .ts 后缀（ESM 解析要求）
 * 详见 README 的「为什么源码里没有 enum」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makePng, toBase64 } from './testPng.ts';
import {
  parseCard,
  parsePngCard,
  parseJsonCard,
  extractTextChunks,
  toV2Card,
  toV3Card,
  normalizeCharacter,
} from './parseCard.ts';
import { scanWorldInfo, parseRegexFromString, applyRegexScripts } from './worldInfo.ts';
import { buildPrompt, substituteMacros, parseExampleMessages, estimateTokens } from './buildPrompt.ts';

/* ==========================================================================
 * 测试数据
 * ========================================================================== */

const V1_CARD = {
  name: 'Aria',
  description: 'A wandering bard with a silver lute.',
  personality: 'Cheerful, curious, slightly mischievous.',
  scenario: 'A tavern at the edge of the world.',
  first_mes: 'She strums a chord. "Well met, traveler."',
  mes_example: '<START>\n{{user}}: Hello.\n{{char}}: "Hello yourself!"',
};

const V2_CARD = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria',
    description: 'A wandering bard.',
    personality: 'Cheerful.',
    scenario: 'A tavern.',
    first_mes: 'Well met.',
    mes_example: '<START>\n{{user}}: Hi\n{{char}}: Hello!',
    creator_notes: 'Made for testing.',
    system_prompt: 'Write {{char}} in first person.',
    post_history_instructions: 'Keep replies under 3 sentences.',
    alternate_greetings: ['A second opening.', 'A third opening.'],
    tags: ['fantasy', 'bard'],
    creator: 'tester',
    character_version: '1.1',
    extensions: { talkativeness: '0.5' },
    character_book: {
      name: 'Aria Lore',
      scan_depth: 2,
      token_budget: 512,
      entries: [
        {
          keys: ['lute', 'instrument'],
          secondary_keys: [],
          content: 'The lute is named Silverwind.',
          insertion_order: 10,
          enabled: true,
          position: 'before_char',
        },
        {
          keys: ['tavern'],
          secondary_keys: ['ale'],
          content: 'The tavern is called The Drowned Star.',
          insertion_order: 5,
          enabled: true,
          selective: true,
        },
      ],
    },
  },
};

const V3_CARD = {
  spec: 'chara_card_v3',
  spec_version: '3.0',
  data: {
    ...V2_CARD.data,
    nickname: 'Ari',
    creator_notes_multilingual: { en: 'notes', zh: '备注' },
    source: ['https://example.com/aria'],
    group_only_greetings: ['Group greeting.'],
    creation_date: 1700000000,
    modification_date: 1700000001,
    assets: [{ type: 'icon', uri: 'ccdefault:', name: 'main', ext: 'png' }],
  },
};

/* ==========================================================================
 * PNG 底层
 * ========================================================================== */

test('extractTextChunks: 能读出写入的 tEXt chunk', () => {
  const png = makePng({ texts: [{ keyword: 'chara', text: 'hello' }] });
  const chunks = extractTextChunks(png);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].keyword, 'chara');
  assert.equal(chunks[0].text, 'hello');
  assert.equal(chunks[0].type, 'tEXt');
});

test('extractTextChunks: 非 PNG 抛错', () => {
  assert.throws(() => extractTextChunks(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), /PNG/);
});

test('extractTextChunks: 截断文件不崩溃', () => {
  const png = makePng({ texts: [{ keyword: 'chara', text: 'x'.repeat(100) }] });
  const truncated = png.subarray(0, 40);
  // 不应抛错，尽力而为
  const chunks = extractTextChunks(truncated);
  assert.ok(Array.isArray(chunks));
});

/* ==========================================================================
 * V1 卡解析
 * ========================================================================== */

test('parseCard: V1 扁平 JSON 卡', () => {
  const c = parseCard(JSON.stringify(V1_CARD));
  assert.equal(c.spec, 'chara_card_v1');
  assert.equal(c.name, 'Aria');
  assert.equal(c.nickname, 'Aria'); // V1 无 nickname，回退 name
  assert.equal(c.personality, 'Cheerful, curious, slightly mischievous.');
  assert.equal(c.scenario, 'A tavern at the edge of the world.');
  assert.ok(c.firstMessage.includes('silver lute') === false);
  assert.equal(c.creatorNotes, ''); // V1 无此字段
  assert.equal(c.systemPrompt, '');
  assert.deepEqual(c.alternateGreetings, []);
});

test('parseCard: V1 卡缺字段时补空串并告警', () => {
  const c = parseCard({ name: 'X', description: 'Y' });
  assert.equal(c.spec, 'chara_card_v1');
  assert.equal(c.scenario, '');
  assert.equal(c.firstMessage, '');
  assert.ok(c.warnings.some((w) => w.includes('personality')));
});

/* ==========================================================================
 * V2 卡解析
 * ========================================================================== */

test('parseCard: V2 嵌套卡全字段', () => {
  const c = parseCard(V2_CARD as any);
  assert.equal(c.spec, 'chara_card_v2');
  assert.equal(c.specVersion, '2.0');
  assert.equal(c.postHistoryInstructions, 'Keep replies under 3 sentences.');
  assert.equal(c.systemPrompt, 'Write {{char}} in first person.');
  assert.deepEqual(c.tags, ['fantasy', 'bard']);
  assert.equal(c.creator, 'tester');
  assert.equal(c.characterVersion, '1.1');
  assert.equal(c.extensions.talkativeness, '0.5');
  assert.equal(c.alternateGreetings.length, 2);
  assert.equal(c.alternateGreetings[1], 'A third opening.');
});

test('parseCard: character_book 字段映射（snake_case -> ST 内部命名）', () => {
  const c = parseCard(V2_CARD as any);
  const book = c.characterBook;
  assert.ok(book);
  assert.equal(book.name, 'Aria Lore');
  assert.equal(book.scanDepth, 2);
  assert.equal(book.tokenBudget, 512);
  assert.equal(book.entries.length, 2);

  const e0 = book.entries[0];
  assert.deepEqual(e0.key, ['lute', 'instrument']); // keys -> key
  assert.equal(e0.order, 10); // insertion_order -> order
  assert.equal(e0.enabled, true); // enabled 直通
  assert.equal(e0.content, 'The lute is named Silverwind.');

  const e1 = book.entries[1];
  assert.deepEqual(e1.keysecondary, ['ale']); // secondary_keys -> keysecondary
  assert.equal(e1.order, 5);
});

test('parseCard: position "before_char" -> 0 (Before)', () => {
  const c = parseCard(V2_CARD as any);
  assert.equal(c.characterBook!.entries[0].position, 0);
});

test('parseCard: alternate_greetings 为字符串时不崩（ST 真实容错分支）', () => {
  const card = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: { ...V2_CARD.data, alternate_greetings: 'only one greeting' },
  };
  const c = parseCard(card as any);
  assert.deepEqual(c.alternateGreetings, ['only one greeting']);
});

/* ==========================================================================
 * V3 卡解析
 * ========================================================================== */

test('parseCard: V3 卡新增字段', () => {
  const c = parseCard(V3_CARD as any);
  assert.equal(c.spec, 'chara_card_v3');
  assert.equal(c.specVersion, '3.0');
  assert.equal(c.nickname, 'Ari');
  assert.deepEqual(c.groupOnlyGreetings, ['Group greeting.']);
  assert.equal(c.assets.length, 1);
  assert.equal(c.assets[0].type, 'icon');
});

test('parseCard: 未知 spec 值降级为 V2 并告警', () => {
  const card = { spec: 'chara_card_v99', spec_version: '99.0', data: { ...V2_CARD.data } };
  const c = parseCard(card as any);
  assert.equal(c.spec, 'chara_card_v2');
  assert.ok(c.warnings.some((w) => w.includes('chara_card_v99')));
});

/* ==========================================================================
 * PNG 内嵌卡 —— 核心
 * ========================================================================== */

test('parsePngCard: V2 卡 base64 编码在 chara chunk', () => {
  const png = makePng({
    texts: [{ keyword: 'chara', text: toBase64(JSON.stringify(V2_CARD)) }],
  });
  const c = parsePngCard(png);
  assert.equal(c.spec, 'chara_card_v2');
  assert.equal(c.name, 'Aria');
  assert.equal(c.postHistoryInstructions, 'Keep replies under 3 sentences.');
  assert.ok(c.rawPng && c.rawPng.length > 0);
});

test('parsePngCard: V3 卡在 ccv3 chunk', () => {
  const png = makePng({
    texts: [{ keyword: 'ccv3', text: toBase64(JSON.stringify(V3_CARD)) }],
  });
  const c = parsePngCard(png);
  assert.equal(c.spec, 'chara_card_v3');
  assert.equal(c.nickname, 'Ari');
});

test('parsePngCard: ccv3 与 chara 同时存在时 ccv3 胜出', () => {
  const png = makePng({
    texts: [
      { keyword: 'chara', text: toBase64(JSON.stringify({ ...V2_CARD, data: { ...V2_CARD.data, name: 'OLD' } })) },
      { keyword: 'ccv3', text: toBase64(JSON.stringify({ ...V3_CARD, data: { ...V3_CARD.data, name: 'NEW' } })) },
    ],
  });
  const c = parsePngCard(png);
  assert.equal(c.name, 'NEW');
  assert.equal(c.spec, 'chara_card_v3');
  assert.ok(c.warnings.some((w) => w.includes('ccv3')));
});

test('parsePngCard: keyword 大小写不敏感（Chara 也能读）', () => {
  const png = makePng({
    texts: [{ keyword: 'Chara', text: toBase64(JSON.stringify(V2_CARD)) }],
  });
  const c = parsePngCard(png);
  assert.equal(c.name, 'Aria');
});

test('parsePngCard: V1 风格明文 JSON（未 base64）兼容解析', () => {
  const png = makePng({ texts: [{ keyword: 'chara', text: JSON.stringify(V1_CARD) }] });
  const c = parsePngCard(png);
  assert.equal(c.spec, 'chara_card_v1');
  assert.equal(c.name, 'Aria');
  assert.ok(c.warnings.some((w) => w.includes('明文')));
});

test('parsePngCard: 无角色卡 chunk 时报错并列出已有 keyword', () => {
  const png = makePng({ texts: [{ keyword: 'Comment', text: 'just a comment' }] });
  assert.throws(() => parsePngCard(png), /Comment/);
});

test('parseCard: 自动识别 PNG 与 JSON', () => {
  const png = makePng({ texts: [{ keyword: 'chara', text: toBase64(JSON.stringify(V2_CARD)) }] });
  assert.equal(parseCard(png).name, 'Aria');
  assert.equal(parseCard(JSON.stringify(V2_CARD)).name, 'Aria');
  assert.equal(parseCard(V2_CARD as any).name, 'Aria');
});

test('parseCard: base64 解出来不是 JSON 时给出明确错误', () => {
  const png = makePng({ texts: [{ keyword: 'chara', text: toBase64('not json at all') }] });
  assert.throws(() => parsePngCard(png), /不是合法 JSON/);
});

/* ==========================================================================
 * 写回
 * ========================================================================== */

test('toV2Card / toV3Card 往返', () => {
  const c = parseCard(V2_CARD as any);
  const v2 = toV2Card(c);
  assert.equal(v2.spec, 'chara_card_v2');
  assert.equal(v2.data.post_history_instructions, 'Keep replies under 3 sentences.');
  assert.equal(v2.data.alternate_greetings.length, 2);

  const v3 = toV3Card(c);
  assert.equal(v3.spec, 'chara_card_v3');
  assert.equal(v3.data.assets!.length, 1);
});

/* ==========================================================================
 * 世界书引擎
 * ========================================================================== */

const BOOK = {
  entries: [
    {
      uid: 0,
      key: ['lute'],
      keysecondary: [],
      content: 'The lute is named Silverwind.',
      order: 10,
      enabled: true,
    },
    {
      uid: 1,
      key: ['dragon'],
      keysecondary: [],
      content: 'Dragons are extinct.',
      order: 5,
      enabled: true,
    },
    {
      uid: 2,
      key: [],
      keysecondary: [],
      content: 'Always present.',
      order: 1,
      enabled: true,
      constant: true,
    },
    {
      uid: 3,
      key: ['tavern'],
      keysecondary: ['ale'],
      content: 'The Drowned Star.',
      order: 3,
      enabled: true,
      selective: true,
    },
    {
      uid: 4,
      key: ['hidden'],
      keysecondary: [],
      content: 'Never triggers.',
      order: 1,
      enabled: false,
    },
  ],
};

const MSG = (mes: string, role: 'user' | 'assistant' = 'user') => ({
  role,
  mes,
  sendDate: 0,
});

test('scanWorldInfo: 主键命中与未命中', () => {
  const r = scanWorldInfo({
    book: BOOK as any,
    messages: [MSG('I play my lute.')],
    maxContext: 4096,
    countTokens: (s: string) => s.length,
    random: () => 1,
  });
  const uids = r.activated.map((a) => a.entry.uid);
  assert.ok(uids.includes(0), 'lute 条目应激活');
  assert.ok(!uids.includes(1), 'dragon 条目不应激活');
});

test('scanWorldInfo: constant 条目无条件激活', () => {
  const r = scanWorldInfo({
    book: BOOK as any,
    messages: [MSG('nothing relevant')],
    maxContext: 4096,
    countTokens: (s: string) => s.length,
    random: () => 1,
  });
  const uids = r.activated.map((a) => a.entry.uid);
  assert.ok(uids.includes(2));
});

test('scanWorldInfo: disabled 条目永不激活', () => {
  const r = scanWorldInfo({
    book: BOOK as any,
    messages: [MSG('the hidden thing')],
    maxContext: 4096,
    countTokens: (s: string) => s.length,
    random: () => 1,
  });
  assert.ok(!r.activated.some((a) => a.entry.uid === 4));
});

test('scanWorldInfo: selective 需次级键同时命中', () => {
  const no = scanWorldInfo({
    book: BOOK as any,
    messages: [MSG('I enter the tavern.')],
    maxContext: 4096,
    countTokens: (s: string) => s.length,
    random: () => 1,
  });
  assert.ok(!no.activated.some((a) => a.entry.uid === 3), '缺次级键不应激活');

  const yes = scanWorldInfo({
    book: BOOK as any,
    messages: [MSG('I enter the tavern and order an ale.')],
    maxContext: 4096,
    countTokens: (s: string) => s.length,
    random: () => 1,
  });
  assert.ok(yes.activated.some((a) => a.entry.uid === 3), '次级键命中应激活');
});

test('scanWorldInfo: 大小写不敏感默认开启', () => {
  const r = scanWorldInfo({
    book: BOOK as any,
    messages: [MSG('I PLAY MY LUTE')],
    maxContext: 4096,
    countTokens: (s: string) => s.length,
    random: () => 1,
  });
  assert.ok(r.activated.some((a) => a.entry.uid === 0));
});

test('scanWorldInfo: 按 order 降序排列', () => {
  const r = scanWorldInfo({
    book: BOOK as any,
    messages: [MSG('lute and tavern and ale')],
    maxContext: 4096,
    countTokens: (s: string) => s.length,
    random: () => 1,
  });
  const orders = r.activated.map((a) => a.entry.order);
  const sorted = [...orders].sort((a, b) => b - a);
  assert.deepEqual(orders, sorted);
});

test('scanWorldInfo: token 预算充足时全部注入', () => {
  const big = {
    entries: [
      { uid: 0, key: ['a'], keysecondary: [], content: 'x'.repeat(100), order: 10, enabled: true },
      { uid: 1, key: ['a'], keysecondary: [], content: 'y'.repeat(100), order: 5, enabled: true },
      { uid: 2, key: ['a'], keysecondary: [], content: 'z'.repeat(100), order: 1, enabled: true },
    ],
  };
  const r = scanWorldInfo({
    book: big as any,
    messages: [MSG('a')],
    maxContext: 4096,
    // 10% of 4096 = 409 token 预算
    worldInfoBudgetPercent: 10,
    countTokens: (s: string) => s.length,
    random: () => 1,
  });
  // 三条各 100 token，合计 300 < 410，全部放得下
  assert.equal(r.activated.length, 3);
  assert.equal(r.injected.length, 3);
  assert.equal(r.budgetDropped.length, 0);
  // Math.round(0.10 * 4096) = 410
  assert.equal(r.budgetTokens, 410);
});

test('scanWorldInfo: 预算不足时按 order 降序优先注入', () => {
  const big = {
    entries: [
      { uid: 0, key: ['a'], keysecondary: [], content: 'x'.repeat(100), order: 10, enabled: true },
      { uid: 1, key: ['a'], keysecondary: [], content: 'y'.repeat(100), order: 5, enabled: true },
      { uid: 2, key: ['a'], keysecondary: [], content: 'z'.repeat(100), order: 1, enabled: true },
    ],
  };
  const r = scanWorldInfo({
    book: big as any,
    messages: [MSG('a')],
    maxContext: 1000,
    // 15% of 1000 = 150 token 预算：只够第一条
    worldInfoBudgetPercent: 15,
    countTokens: (s: string) => s.length,
    random: () => 1,
  });
  assert.equal(r.budgetTokens, 150);
  // 三条都「命中」了触发条件，但只有 order 最高的一条进了预算
  assert.equal(r.activated.length, 3);
  assert.equal(r.injected.length, 1, '只有 order 最高的第一条应被注入');
  assert.equal(r.injected[0].entry.order, 10);
  assert.equal(r.budgetDropped.length, 2);
  assert.equal(r.usedTokens, 100);
});

test('scanWorldInfo: ignoreBudget 可越过预算', () => {
  const big = {
    entries: [
      { uid: 0, key: ['a'], keysecondary: [], content: 'x'.repeat(400), order: 10, enabled: true, ignoreBudget: true },
      { uid: 1, key: ['a'], keysecondary: [], content: 'y'.repeat(400), order: 5, enabled: true, ignoreBudget: true },
    ],
  };
  const r = scanWorldInfo({
    book: big as any,
    messages: [MSG('a')],
    maxContext: 4096,
    worldInfoBudgetPercent: 5, // 205 token 预算
    countTokens: (s: string) => s.length,
    random: () => 1,
  });
  assert.equal(r.activated.length, 2);
});

test('scanWorldInfo: 正则形式的键优先于全部匹配选项', () => {
  const book = {
    entries: [
      { uid: 0, key: ['/\\d{3,}/'], keysecondary: [], content: 'Numbers!', order: 1, enabled: true, caseSensitive: true },
    ],
  };
  const hit = scanWorldInfo({
    book: book as any,
    messages: [MSG('code 12345 here')],
    maxContext: 4096,
    countTokens: (s) => s.length,
    random: () => 1,
  });
  assert.equal(hit.activated.length, 1);

  const miss = scanWorldInfo({
    book: book as any,
    messages: [MSG('no digits')],
    maxContext: 4096,
    countTokens: (s) => s.length,
    random: () => 1,
  });
  assert.equal(miss.activated.length, 0);
});

test('scanWorldInfo: 包含组内只激活一个', () => {
  const book = {
    entries: [
      { uid: 0, key: ['a'], keysecondary: [], content: 'one', order: 10, enabled: true, group: 'g1' },
      { uid: 1, key: ['a'], keysecondary: [], content: 'two', order: 5, enabled: true, group: 'g1' },
    ],
  };
  const r = scanWorldInfo({
    book: book as any,
    messages: [MSG('a')],
    maxContext: 4096,
    countTokens: (s) => s.length,
    random: () => 1,
  });
  const inGroup = r.activated.filter((a) => a.entry.group === 'g1');
  assert.equal(inGroup.length, 1);
});

test('scanWorldInfo: scanDepth 限制扫描的历史条数', () => {
  const book = {
    scanDepth: 1,
    entries: [{ uid: 0, key: ['ancient'], keysecondary: [], content: 'old', order: 1, enabled: true }],
  };
  const msgs = [MSG('ancient secret'), MSG('unrelated recent')];
  const r = scanWorldInfo({
    book: book as any,
    messages: msgs,
    maxContext: 4096,
    countTokens: (s) => s.length,
    random: () => 1,
  });
  // 只扫最后 1 条，命中不到
  assert.equal(r.activated.length, 0);
});

/* ==========================================================================
 * 正则
 * ========================================================================== */

test('parseRegexFromString: 解析 /pattern/flags', () => {
  const re = parseRegexFromString('/hello/i');
  assert.ok(re instanceof RegExp);
  assert.equal(re!.flags.includes('i'), true);
});

test('parseRegexFromString: 非正则字符串返回 null', () => {
  assert.equal(parseRegexFromString('hello'), null);
});

test('applyRegexScripts: 按 placement 过滤并替换', () => {
  const scripts = [
    {
      id: 's1',
      scriptName: 'test',
      findRegex: '/foo/g',
      replaceString: 'bar',
      placement: [1], // USER_INPUT
      disabled: false,
      markdownOnly: false,
      promptOnly: false,
      runOnEdit: false,
      substituteRegex: 0,
      minDepth: null,
      maxDepth: null,
    },
  ];
  const out = applyRegexScripts('foo foo', scripts as any, 1, { isPrompt: true, isEdit: false });
  assert.equal(out, 'bar bar');

  // 不同 placement 不应生效
  const out2 = applyRegexScripts('foo', scripts as any, 2, { isPrompt: true, isEdit: false });
  assert.equal(out2, 'foo');
});

test('applyRegexScripts: disabled 脚本跳过', () => {
  const scripts = [
    {
      id: 's1',
      scriptName: 'test',
      findRegex: '/foo/g',
      replaceString: 'bar',
      placement: [1],
      disabled: true,
      markdownOnly: false,
      promptOnly: false,
      runOnEdit: false,
      substituteRegex: 0,
      minDepth: null,
      maxDepth: null,
    },
  ];
  assert.equal(applyRegexScripts('foo', scripts as any, 1, { isPrompt: true, isEdit: false }), 'foo');
});

/* ==========================================================================
 * 宏与提示词组装
 * ========================================================================== */

test('substituteMacros: {{char}}/{{user}} 及大小写不敏感', () => {
  assert.equal(substituteMacros('{{char}} meets {{user}}', { char: 'Aria', user: 'Bob' }), 'Aria meets Bob');
  assert.equal(substituteMacros('{{CHAR}}', { char: 'Aria', user: 'Bob' }), 'Aria');
  assert.equal(substituteMacros('<BOT> and <USER>', { char: 'Aria', user: 'Bob' }), 'Aria and Bob');
});

test('parseExampleMessages: 按 <START> 分段', () => {
  const parsed = parseExampleMessages('<START>\n{{user}}: Hi\n{{char}}: Hello!', 'Aria', 'Bob');
  assert.ok(parsed.length >= 2);
  assert.equal(parsed[0].role, 'user');
  assert.equal(parsed[1].role, 'assistant');
});

test('estimateTokens: 中文与英文都返回正数', () => {
  assert.ok(estimateTokens('hello world') > 0);
  assert.ok(estimateTokens('你好世界') > 0);
  assert.equal(estimateTokens(''), 0);
});

test('buildPrompt: 基本组装包含角色描述与历史', () => {
  const c = parseCard(V2_CARD as any);
  const out = buildPrompt({
    character: c,
    history: [
      { id: '1', role: 'user', mes: 'Hello there', sendDate: 0, swipes: [], swipeId: 0 },
      { id: '2', role: 'assistant', mes: 'Well met.', sendDate: 0, swipes: [], swipeId: 0 },
    ],
    options: { maxContext: 4096, maxTokens: 300, userName: 'Bob', countTokens: (s: string) => s.length },
  });
  assert.ok(out.systemPrompt.includes('Aria'));
  assert.ok(out.messages.length >= 2);
  assert.equal(out.messages[out.messages.length - 1].role, 'assistant');
  assert.ok(out.debug.sections.length > 0);
});

test('buildPrompt: 世界书命中时内容进入 system 段', () => {
  const c = parseCard(V2_CARD as any);
  const out = buildPrompt({
    character: c,
    history: [{ id: '1', role: 'user', mes: 'I play my lute.', sendDate: 0, swipes: [], swipeId: 0 }],
    options: { maxContext: 4096, maxTokens: 300, userName: 'Bob', countTokens: (s: string) => s.length },
  });
  assert.ok(out.activatedWorldInfo.length > 0, '应激活 lute 条目');
  assert.ok(out.systemPrompt.includes('Silverwind'));
});

test('buildPrompt: 超长历史被截断', () => {
  const c = parseCard(V2_CARD as any);
  const history = Array.from({ length: 200 }, (_, i) => ({
    id: String(i),
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    mes: 'x'.repeat(100),
    sendDate: 0,
    swipes: [],
    swipeId: 0,
  }));
  const out = buildPrompt({
    character: c,
    history,
    options: {
      maxContext: 1200,
      maxTokens: 200,
      userName: 'Bob',
      countTokens: (s: string) => s.length,
      maxHistoryMessages: 50,
    },
  });
  assert.ok(out.droppedMessages > 0, '应丢弃部分历史');
  assert.ok(out.estimatedTokens <= 1200 + 50);
});
