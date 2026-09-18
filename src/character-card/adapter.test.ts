/**
 * 单元测试 —— adapter（store 状态 -> AssembleInput）
 *
 * 运行：
 *   node --test src/character-card/
 *
 * 这组测试盯的是**一个具体的回归**：`buildPrompt` 已经完整实现（世界书 8 种
 * 注入位置、关键词触发、递归、token 预算），但生产代码曾经完全没调用它，
 * 结果「导入带世界书的角色卡 -> 世界书被静默丢弃」。
 *
 * 因此这里不满足于断言「某段文字出现在提示词里」——那样测的是 `buildPrompt`
 * 自己（它已有测试）。这里断言的是**接线本身**：角色卡里的 `character_book`
 * 能不能穿过 adapter 活着到达 `buildPrompt`，并在关键词命中时真的注入。
 * 这条链路上任何一环断了（字段名写错、book 被漏传、worldBooks 覆盖掉卡书），
 * 用户看到的现象都完全一样：世界书不生效，且没有任何报错。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  makeAssembleInput,
  openingMessageFor,
  alternateOpeningsFor,
  parseConversationWorldInfo,
  toNormalizedCharacter,
  toChatMessages,
} from './adapter.ts';
import type { AdapterCharacter, AdapterMessage } from './adapter.ts';
import { buildPrompt } from './buildPrompt.ts';

/* ==========================================================================
 * 测试数据
 * ========================================================================== */

/**
 * 一张带世界书的 V2 卡。
 *
 * `character_book` 用的是**卡里原样的 snake_case**（keys/secondary_keys/
 * insertion_order），因为 adapter 拿到的就是数据库 `card_json` 里的原始形态 ——
 * 归一化是 adapter 自己的职责，测试不能替它先归一化，否则就测不到转换。
 */
function makeCard(overrides: Record<string, unknown> = {}): AdapterCharacter {
  return {
    id: 'char-1',
    card: {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Aria',
        description: '游荡的吟游诗人。',
        personality: '开朗而好奇。',
        scenario: '世界尽头的一间酒馆。',
        first_mes: '她拨动琴弦：「旅人，幸会。」',
        mes_example: '<START>\n{{user}}: 你好。\n{{char}}: 「你好呀。」',
        creator_notes: '测试用卡。',
        system_prompt: '',
        post_history_instructions: '回复不要超过三句话。',
        alternate_greetings: ['另一个开场白。', '第三个开场白。'],
        tags: ['fantasy'],
        creator: 'tester',
        character_version: '1.0',
        extensions: {},
        character_book: {
          name: 'Aria 设定集',
          scan_depth: 4,
          entries: [
            {
              keys: ['鲁特琴', 'lute'],
              secondary_keys: [],
              content: '那把鲁特琴名叫「银风」（Silverwind）。',
              insertion_order: 10,
              enabled: true,
              position: 'before_char',
            },
            {
              keys: ['酒馆'],
              secondary_keys: [],
              content: '酒馆名叫「溺星」（Drowned Star）。',
              insertion_order: 5,
              enabled: true,
            },
            {
              keys: ['巨龙'],
              secondary_keys: [],
              content: '这条永远不该被激活。（不该出现的内容）',
              insertion_order: 1,
              enabled: false,
            },
          ],
        },
        ...overrides,
      },
    },
  };
}

const HISTORY: AdapterMessage[] = [
  { role: 'user', content: '我拨了一下我的鲁特琴。', createdAt: 1 },
];

/** 统一的小上下文，避免默认预算把测试数据裁掉。 */
const CTX = 4096;

function assemble(
  character: AdapterCharacter | null,
  messages: readonly AdapterMessage[] = HISTORY,
  globalSystemPrompt = '',
) {
  return makeAssembleInput({
    character,
    messages,
    globalSystemPrompt,
    contextLength: CTX,
  });
}

/* ==========================================================================
 * 1. 角色卡字段进入系统提示词
 * ========================================================================== */

test('adapter: 角色卡的描述/性格/背景都进入 system 提示词', () => {
  const out = buildPrompt(assemble(makeCard()));

  assert.ok(out.systemPrompt.includes('游荡的吟游诗人'), '描述应进入');
  assert.ok(out.systemPrompt.includes('开朗而好奇'), '性格应进入');
  assert.ok(out.systemPrompt.includes('世界尽头的一间酒馆'), '背景应进入');
  // 卡作者的后置指令走 jailbreak 段，同样在 system 段里
  assert.ok(out.systemPrompt.includes('回复不要超过三句话'), 'post_history_instructions 应进入');
});

test('adapter: ms_example 对话示例注入提示词，且 {{char}}/{{user}} 已展开', () => {
  const out = buildPrompt(assemble(makeCard()));

  assert.ok(out.systemPrompt.includes('你好呀'), '示例对话内容应进入');

  // 只断言**示例对话那一段**展开了宏，不要在整个 systemPrompt 上查字面
  // 「{{char}}」——`buildPrompt` 自己的 `DEFAULT_NSFW_PROMPT` 常量
  // （'{{char}} will not speak for {{user}}.'）从来没被 substituteMacros 处理过，
  // 所以整个 systemPrompt 里**总是**存在未展开的宏。那是 buildPrompt 的内部问题，
  // 不属于 adapter 的接线范围，用全局断言会把它误报成本任务的回归。
  const exampleStart = out.systemPrompt.indexOf('<START>');
  assert.ok(exampleStart >= 0, '示例对话段应存在');
  const exampleSection = out.systemPrompt.slice(exampleStart);

  assert.ok(exampleSection.includes('Aria'), '{{char}} 应展开为角色名');
  assert.ok(exampleSection.includes('User'), '{{user}} 应展开为用户名');
  assert.ok(!exampleSection.includes('{{'), '示例对话段内不应残留任何未展开的宏');
});

test('adapter: 历史消息按顺序进入 messages，且角色/身份正确', () => {
  const out = buildPrompt(
    assemble(makeCard(), [
      { role: 'user', content: '第一句。' },
      { role: 'assistant', content: '第二句。' },
    ]),
  );

  const convo = out.messages.filter((m) => m.role !== 'system');
  assert.equal(convo.length, 2);
  assert.equal(convo[0].role, 'user');
  assert.equal(convo[1].role, 'assistant');
  assert.ok(convo[0].content.includes('第一句'));
  assert.ok(convo[1].content.includes('第二句'));
});

/* ==========================================================================
 * 2. 世界书 —— 本任务的核心
 * ========================================================================== */

test('adapter: 世界书命中时内容进入提示词（核心回归）', () => {
  const out = buildPrompt(assemble(makeCard()));

  // 关键词「鲁特琴」出现在历史里 -> 对应条目应被激活
  assert.ok(
    out.activatedWorldInfo.length > 0,
    '应激活世界书条目；为 0 说明 character_book 在链路上被丢了',
  );
  assert.ok(out.systemPrompt.includes('银风'), '命中的世界书内容应进入 system 段');
  assert.ok(out.debug.wiTokens > 0, '世界书 token 统计应为正');
});

test('adapter: 世界书未命中的条目不注入，被禁用的条目也不注入', () => {
  const out = buildPrompt(assemble(makeCard()));

  // 「酒馆」没在任何历史消息里出现，且条目非 constant
  assert.ok(!out.systemPrompt.includes('溺星'), '未命中的条目不应注入');
  // enabled: false 的条目无论如何都不该出现
  assert.ok(!out.systemPrompt.includes('不该出现的内容'), '被禁用的条目不应注入');
});

test('adapter: 换个关键词能激活另一条世界书条目', () => {
  const out = buildPrompt(
    assemble(makeCard(), [{ role: 'user', content: '我走进了那间酒馆。' }]),
  );

  assert.ok(out.systemPrompt.includes('溺星'), '「酒馆」条目应被激活');
  assert.ok(!out.systemPrompt.includes('银风'), '没提到鲁特琴时不该注入该条');
});

test('adapter: 无角色卡时世界书为空但流程不崩', () => {
  const out = buildPrompt(assemble(null));

  assert.deepEqual(out.activatedWorldInfo, []);
  assert.equal(out.debug.wiTokens, 0);
  // character 是必填的，adapter 用空壳顶上，不该抛出
  assert.equal(typeof out.systemPrompt, 'string');
});

/* ==========================================================================
 * 3. 全局提示词 —— 必须保留既有行为
 * ========================================================================== */

test('adapter: 没有角色卡时，用户全局 systemPrompt 仍要生效', () => {
  const out = buildPrompt(assemble(null, [], '总是用中文回答。'));

  assert.ok(out.systemPrompt.includes('总是用中文回答。'), '全局提示词必须保留');
});

test('adapter: 角色卡与全局提示词同时存在时两者都在', () => {
  const out = buildPrompt(assemble(makeCard(), HISTORY, '总是用中文回答。'));

  assert.ok(out.systemPrompt.includes('总是用中文回答。'), '全局提示词在');
  assert.ok(out.systemPrompt.includes('游荡的吟游诗人'), '角色描述也在');
});

test('adapter: 角色定义排在全局提示词之前（保住既有追加语义）', () => {
  const out = buildPrompt(assemble(makeCard(), HISTORY, '总是用中文回答。'));

  const globalAt = out.systemPrompt.indexOf('总是用中文回答。');
  const descAt = out.systemPrompt.indexOf('游荡的吟游诗人');

  assert.ok(globalAt >= 0 && descAt >= 0);
  // 全局提示词的语义是「追加指令」，所以必须排在角色定义之后。
  // ST 出厂顺序里 main 在最前，适配器为此把 main 挪到了角色各段之后
  // （见 adapter.ts 的 orderedSections）—— 这条顺序有既有测试在钉
  // （src/store/systemPrompt.test.ts: character comes BEFORE the global prompt）。
  assert.ok(descAt < globalAt, 'charDescription 应排在 main（全局提示词）之前');
});

test('adapter: 全部为空时 systemPrompt 为空串（调用方据此不发 system 消息）', () => {
  // 没角色卡、没全局提示词 —— 必须原样返回空串。
  // 调用方（generate）正是靠空串决定「不发 system 消息」，改用空串消息会让
  // 不同 chat template渲染出不同提示词。这条契约以前被适配器里的人造兜底
  // main 段破坏过，故在此钉死。
  const out = buildPrompt(assemble(null, [], ''));
  assert.equal(out.systemPrompt, '', '无卡无提示词时必须为空串');
});

test('adapter: 空白全局提示词等同没有，无卡时仍返回空串', () => {
  const input = assemble(null, [], '   ');
  // 只有空白字符不算内容，不能被 trim 后当成有效提示词
  assert.equal(input.mainPrompt, undefined, '空白提示词不应设置 mainPrompt');
  assert.equal(buildPrompt(input).systemPrompt, '');
});

test('adapter: 有角色卡但卡内无任何文本时，兜底 main 让提示词非空', () => {
  const bare = makeCard({ description: '', personality: '', scenario: '', mes_example: '' });
  const out = buildPrompt(assemble(bare));

  // 有卡时给中文兜底 main 是有意的：卡片存在即代表用户期望「扮演这个角色」，
  // 给一句角色扮演指令比什么都不给更符合预期。
  assert.ok(out.systemPrompt.length > 0, '有卡时应有兜底 main');
  assert.ok(out.systemPrompt.includes('Aria'), '兜底 main 里的 {{char}} 应展开为角色名');
});

test('adapter: 字段全空的卡等同没有角色，不产出指向空名的提示词', () => {
  // 导入失败 / 用户新建但还没填内容的卡，都会得到一个字段全空串的 record。
  // 若按「有没有卡对象」判断，全局兜底会渲染出「以「Character」的身份…」——
  // 一句指向不存在角色的提示，而 first_mes 只是开场白、不进 system 段。
  const blank = makeCard({
    name: '',
    description: '',
    personality: '',
    scenario: '',
    system_prompt: '',
    post_history_instructions: '',
    mes_example: '',
    first_mes: '主人你回来啦～',
  });
  const out = buildPrompt(assemble(blank, []));

  assert.equal(out.systemPrompt, '', '空卡且无全局提示词时应返回空串');
  assert.ok(!out.systemPrompt.includes('Character'), '不应出现指向空名的占位提示');
});

test('adapter: 无角色时不注入 nsfw 护栏（它的 {{char}} 不会被展开）', () => {
  // buildPrompt 的 nsfw 段走的是常量，**不经过 substituteMacros**，
  // 因此渲染出来永远是字面量 `{{char}} will not speak for {{user}}.`。
  // 发给模型的是两个它无法解释的裸占位符，比不发更糟，故无角色时必须关掉。
  const out = buildPrompt(assemble(null, [], '回答尽量简短。'));

  assert.equal(out.systemPrompt, '回答尽量简短。', '应只剩全局提示词');
  assert.ok(!out.systemPrompt.includes('{{char}}'), '不得把字面量占位符发给模型');
  assert.ok(!out.systemPrompt.includes('{{user}}'), '不得把字面量占位符发给模型');
});

/* ==========================================================================
 * 4. 对话级世界书
 * ========================================================================== */

test('adapter: 对话级世界书（JSON 字符串）与角色卡世界书同时生效', () => {
  const input = makeAssembleInput({
    character: makeCard(),
    messages: HISTORY,
    globalSystemPrompt: '',
    contextLength: CTX,
    conversationWorldInfo: JSON.stringify({
      name: '对话设定',
      entries: [
        {
          uid: 900,
          key: [],
          keysecondary: [],
          content: '本场对话发生在雨夜。',
          order: 100,
          enabled: true,
          constant: true,
        },
      ],
    }),
  });

  const out = buildPrompt(input);
  assert.ok(out.systemPrompt.includes('本场对话发生在雨夜'), '对话级世界书应生效');
  // 关键：传了 worldBooks 之后，角色卡的世界书**不能**被丢掉
  assert.ok(out.systemPrompt.includes('银风'), '角色卡世界书不应被 worldBooks 覆盖掉');
});

test('adapter: 对话级世界书是自由文本时不被丢弃，包装成常量条目', () => {
  const book = parseConversationWorldInfo('本场对话发生在雨夜。');
  assert.ok(book, '自由文本应被包装而非丢弃');
  assert.equal(book.entries.length, 1);
  assert.equal(book.entries[0].constant, true);
  assert.equal(book.entries[0].content, '本场对话发生在雨夜。');
});

test('adapter: 非法/空的世界书字符串安全降级为 null', () => {
  assert.equal(parseConversationWorldInfo(''), null);
  assert.equal(parseConversationWorldInfo('   '), null);
  assert.equal(parseConversationWorldInfo(null), null);
  assert.equal(parseConversationWorldInfo(undefined), null);
});

/* ==========================================================================
 * 5. 开场白 first_mes
 * ========================================================================== */

test('adapter: first_mes 能被正确取出', () => {
  const opening = openingMessageFor(makeCard());
  assert.equal(opening, '她拨动琴弦：「旅人，幸会。」');
});

test('adapter: 无角色卡或空 first_mes 时返回 null', () => {
  assert.equal(openingMessageFor(null), null);
  assert.equal(openingMessageFor(makeCard({ first_mes: '' })), null);
  assert.equal(openingMessageFor(makeCard({ first_mes: '   ' })), null);
});

test('adapter: alternate_greetings 可取出且过滤空串', () => {
  assert.deepEqual(alternateOpeningsFor(makeCard()), ['另一个开场白。', '第三个开场白。']);
  assert.deepEqual(alternateOpeningsFor(makeCard({ alternate_greetings: ['', '  ', '有效'] })), ['有效']);
  assert.deepEqual(alternateOpeningsFor(null), []);
});

/* ==========================================================================
 * 6. 转换函数本身
 * ========================================================================== */

test('adapter: toNormalizedCharacter 保留 character_book', () => {
  const c = toNormalizedCharacter(makeCard());
  assert.ok(c.characterBook, 'character_book 必须被保留（世界书生效的前提）');
  assert.equal(c.characterBook.entries.length, 3);
  assert.equal(c.name, 'Aria');
  assert.equal(c.firstMessage, '她拨动琴弦：「旅人，幸会。」');
});

test('adapter: toNormalizedCharacter 对缺失字段给空串而非 undefined', () => {
  const bare: AdapterCharacter = {
    id: 'x',
    card: {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Bare',
        description: '',
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
        creator_notes: '',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: [],
        creator: '',
        character_version: '',
        extensions: {},
      },
    },
  };
  const c = toNormalizedCharacter(bare);

  // buildPrompt 大量使用字符串插值与 .replace，undefined 会在运行时炸
  for (const key of ['description', 'personality', 'scenario', 'exampleMessages'] as const) {
    assert.equal(typeof c[key], 'string', `${key} 应为字符串`);
  }
  assert.equal(c.characterBook, undefined);
});

test('adapter: toChatMessages 映射 role/content 到 mes，并保留顺序', () => {
  const msgs = toChatMessages([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
  ]);

  assert.equal(msgs.length, 3);
  assert.deepEqual(msgs.map((m) => m.mes), ['sys', 'u1', 'a1']);
  assert.deepEqual(msgs.map((m) => m.role), ['system', 'user', 'assistant']);
});

test('adapter: 不传世界书时不产生 worldBooks 字段（走 buildPrompt 的卡书回退）', () => {
  const input = assemble(null);
  assert.equal(input.worldBooks, undefined, '无书时不应传空数组');
});
