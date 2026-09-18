/**
 * store 状态 -> `AssembleInput` 适配层
 *
 * 存在的理由：`buildPrompt` 的输入域是**酒馆语义**（NormalizedCharacter /
 * ChatMessage / BuildPromptOptions），而 store 里的状态是**本应用的持久化形态**
 * （CharacterRecord 的 V2 嵌套 card、Message 的扁平 content、全局 settings）。
 * 这两套形态不能就地互相转换 —— 转换逻辑一旦散落在 store 里，它就会和
 * `generate()` 一起膨胀成不可测的巨型函数。所以这里集中一次，且**纯函数、无副作用**。
 *
 * 本文件是 `buildPrompt` 唯一的生产接线点：只要有人绕过它直接手搓 AssembleInput，
 * 世界书字段就会再次被漏掉（这正是之前 worldInfo 完全不生效的根因形态）。
 */

import type {
  AssembleInput,
  BuildPromptOptions,
  ChatMessage,
  CharacterCardData,
  NormalizedCharacter,
  PromptIdentifier,
  PromptOrderEntry,
} from './types.ts';
// DEFAULT_PROMPT_ORDER 是运行时值（无卡时要基于它裁剪槽位），不能用 import type
import { DEFAULT_PROMPT_ORDER } from './types.ts';
import { estimateTokens } from './buildPrompt.ts';
// 运行时要**真的调用**它，不能用 import type：这是 snake_case -> ST 命名的唯一转换点
import { normalizeCharacterBook } from './parseCard.ts';
import type { WorldInfoBook } from './types.ts';

/* ==========================================================================
 * 入参类型
 * ========================================================================== */

/**
 * 角色记录的**结构性**约束，而非 import `CharacterRecord`。
 *
 * 这样 adapter 不依赖 `@/types/domain`，测试可以只用最少的字段构造数据，
 * 也让「adapter 需要角色的哪些字段」这件事在类型上自证 —— 加字段必须显式。
 */
export interface AdapterCharacter {
  id: string;
  card: { spec: string; spec_version: string; data: CharacterCardData };
}

/** 同上，StoreMessage 只要求 adapter 真正读到的三个字段。 */
export interface AdapterMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  createdAt?: number;
}

export interface MakeAssembleInputArgs {
  /** 当前选中的角色卡；null = 无角色卡（纯全局提示词对话） */
  character: AdapterCharacter | null;
  /** 当前对话的完整历史（含刚追加的用户消息） */
  messages: readonly AdapterMessage[];
  /** 设置页的全局 system prompt */
  globalSystemPrompt: string;
  /** 上下文窗口 token 数 */
  contextLength: number;
  /** 为模型输出预留的 token 数 */
  maxOutputTokens?: number;
  /**
   * 对话级的世界书（`conversations.world_info` 列，JSON 字符串）。
   *
   * 契约里它是对话私有状态，与本任务改动的 `buildSystemPrompt` 签名（不接受
   * 对话对象）不兼容，因此当前生产路径不会传它。保留是因为它的语义明确且
   * **优先级高于角色卡世界书**（先扫先得），一旦 store 侧接线即可生效。
   */
  conversationWorldInfo?: string | WorldInfoBook | null;
  /** 用户 persona 描述（宏 {{persona}} 与 personaDescription 段） */
  personaDescription?: string;
  /** 用户名（宏 {{user}}） */
  userName?: string;
}

/* ==========================================================================
 * 角色卡转换
 * ========================================================================== */

/**
 * 把页面上显示的名字转成**发言者名字**（宏 {{char}} / 示例对话的说话人标签）。
 *
 * 卡里没有昵称字段，因此用 name。这正是 `parseCard` 里 `nickname ?? name` 的同一条
 * 规则，只是这里从一开始就没有 nickname 可退。
 */
function displayName(data: CharacterCardData): string {
  return data.name || 'Character';
}

/**
 * 把应用持久化的 V2 `data` 块映射成 `NormalizedCharacter`。
 *
 * ⚠️ **不要改成调用 `parseCard`**：`parseCard` 接受的是 PNG 字节或 JSON 对象，
 * 而这里的输入是**已经解析过、已归一化过一次**的字段。再走一遍 parseCard 要么
 * 需要反向拼出一个假 JSON（多一层可失败的序列化），要么会丢掉这里的类型保障。
 *
 * 关于 `character_book`：本应用的 `types/domain.ts` 里 `CharacterCardData` **没有**
 * 声明该字段，但 `parseCard` 产出的 V2 卡把它原样保留在 `data` 上（导入 PNG/JSON 时
 * 就在那里），数据库 `card_json` 存的是完整卡所以也不会丢。因此这里必须用一次
 * **收窄断言**把它取出来 —— 缺了它世界书就永远进不了提示词，而世界书不生效正是
 * 本任务要修的那个 bug。
 *
 * ⚠️ **取出来还不够，必须过一遍 `normalizeCharacterBook`**。卡里的 `character_book`
 * 是**规范原样的 snake_case**（`keys` / `secondary_keys` / `insertion_order` /
 * `position: 'before_char'`），而 `scanWorldInfo` 只认 ST 归一化后的命名
 * （`key` / `keysecondary` / `order` / `position: 0`）。
 *
 * 这一步漏掉的后果极其隐蔽：书的 `entries` 数组照样存在、`entries.length` 照样大于 0，
 * 所以任何「检查书在不在」的断言都会通过；但每个条目的 `key` 都是 `undefined`，
 * 关键词永远匹配不上，`activatedWorldInfo` 恒为空 —— 表现和「世界书被整个丢掉」
 * 一模一样，且没有任何报错。这是实测踩到过的坑，不是理论风险。
 */
export function toNormalizedCharacter(character: AdapterCharacter): NormalizedCharacter {
  const data = character.card.data;
  const rawBook = (data as { character_book?: unknown }).character_book;

  return {
    spec: (character.card.spec as NormalizedCharacter['spec']) ?? 'chara_card_v2',
    specVersion: character.card.spec_version ?? '2.0',
    name: data.name,
    nickname: displayName(data),
    description: data.description ?? '',
    personality: data.personality ?? '',
    scenario: data.scenario ?? '',
    firstMessage: data.first_mes ?? '',
    exampleMessages: data.mes_example ?? '',
    creatorNotes: data.creator_notes ?? '',
    systemPrompt: data.system_prompt ?? '',
    postHistoryInstructions: data.post_history_instructions ?? '',
    alternateGreetings: data.alternate_greetings ?? [],
    groupOnlyGreetings: [],
    tags: data.tags ?? [],
    creator: data.creator ?? '',
    characterVersion: data.character_version ?? '',
    extensions: data.extensions ?? {},
    characterBook: normalizeCharacterBook(rawBook),
    assets: [],
    warnings: [],
  };
}

/* ==========================================================================
 * 消息转换
 * ========================================================================== */

/**
 * store 的 Message -> 酒馆的 ChatMessage。
 *
 * `swipes` 只放当前 content 一条：`buildPrompt` 只读 `mes`，而把历史 swipe 全部
 * 塞进去会让 `estimatedTokens` 的统计虚高（它按条计费），并在未来有人改成
 * 「读 swipes[0]」时产生一个静默的行为改变。
 */
export function toChatMessages(messages: readonly AdapterMessage[]): ChatMessage[] {
  return messages.map((m, i) => ({
    id: `m${i}`,
    role: m.role,
    mes: m.content,
    sendDate: m.createdAt ?? 0,
    swipes: [m.content],
    swipeId: 0,
  }));
}

/* ==========================================================================
 * 对话级世界书
 * ========================================================================== */

/**
 * 解析 `conversations.world_info`。
 *
 * 该列存的是 JSON 字符串，但历史数据里可能是「一段自由文本」而不是合法的书对象。
 * 这种数据**不能静默丢弃**：丢掉就等于用户写的设定凭空消失，且没有任何提示。
 * 因此非法 JSON 会被包装成一条**常量条目**（无条件激活），让内容照常注入。
 */
export function parseConversationWorldInfo(
  raw: string | WorldInfoBook | null | undefined,
): WorldInfoBook | null {
  if (!raw) return null;

  if (typeof raw !== 'string') return raw.entries ? raw : null;

  const text = raw.trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text) as WorldInfoBook;
    // 只接受「像一本书」的对象：有 entries 数组。其余（数字、字符串、无反序列化
    // 出的数组）都退回下面的常量条目分支。
    if (parsed && Array.isArray(parsed.entries)) return parsed;
  } catch {
    // 落到下面：当作自由文本处理
  }

  return {
    name: 'conversation-world-info',
    entries: [
      {
        uid: 0,
        key: [],
        keysecondary: [],
        content: text,
        order: 0,
        enabled: true,
        constant: true,
      },
    ],
  };
}

/* ==========================================================================
 * 主入口
 * ========================================================================== */

/** 无角色卡时用的占位角色 —— `buildPrompt` 的 `character` 是必填项。 */
function emptyCharacter(): NormalizedCharacter {
  return {
    spec: 'chara_card_v2',
    specVersion: '2.0',
    name: 'Assistant',
    nickname: 'Assistant',
    description: '',
    personality: '',
    scenario: '',
    firstMessage: '',
    exampleMessages: '',
    creatorNotes: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    alternateGreetings: [],
    groupOnlyGreetings: [],
    tags: [],
    creator: '',
    characterVersion: '',
    extensions: {},
    assets: [],
    warnings: [],
  };
}

/**
 * 组装 `buildPrompt` 的完整输入。
 *
 * 三个容易踩的点，都在这里一次性处理掉：
 *
 * 1. **无角色卡也要能工作**。`buildPrompt` 要求 `character` 必填，所以走一个空壳
 *    角色；此时除了用户全局提示词外，所有段落都是空串，会被 `buildPrompt`
 *    的 `if (!content) continue` 滤掉。
 * 2. **全局提示词映射到 `mainPrompt`**。在默认 prompt_order 里 `main` 是**第一段**，
 *    角色描述在其后 —— 这与改之前的行为（角色在前、全局在后）是**相反**的。
 *    这一处顺序颠倒是有意接受的，理由见下方 `GLOBAL_PROMPT_ENDING_MARKER` 的说明。
 * 3. **对话级世界书优先于角色卡世界书**：`worldBooks` 传非空数组时，
 *    `buildPrompt` 会**完全忽略** `character.characterBook`（见 buildPrompt.ts 的
 *    `input.worldBooks ?? (character.characterBook ? [...] : [])`）。所以这里必须
 *    显式把两者都放进去，而不是只放对话级的那本。
 */
export function makeAssembleInput(args: MakeAssembleInputArgs): AssembleInput {
  const character = args.character
    ? toNormalizedCharacter(args.character)
    : emptyCharacter();

  const conversationBook = parseConversationWorldInfo(args.conversationWorldInfo ?? null);

  const worldBooks: WorldInfoBook[] = [];
  // 先扫先得：对话私有设定应当压过角色卡的通用设定
  if (conversationBook) worldBooks.push(conversationBook);
  if (character.characterBook) worldBooks.push(character.characterBook);

  const global = args.globalSystemPrompt.trim();

  /**
   * 角色卡是否**真的能给 system 提示词提供内容**。
   *
   * 判据不是「有没有角色卡对象」，而是「卡里有没有**会进 system 段的**可用字段」。
   *
   * 为什么必须这么严：
   *   - 导入失败、空卡、用户建了还没填的卡，都会产生一个字段全空串的
   *     `CharacterRecord`。若只按对象存在与否判断，`main` 兜底会填进
   *     「以「{{char}}」的身份…」，而 `{{char}}` 此刻是空名，渲染出
   *     「以「Character」的身份…」——一句**指向不存在角色**的提示；
   *     `nsfw` 段同时被激活，把字面量 `{{char}}` 发给模型。
   *   - `firstMessage` / `alternateGreetings` **不算**：它们是开场白，由
   *     `openingMessageFor` 作为 assistant 消息插入，**从不进入 system 段**。
   *     把它们算作「有内容」，会让「只有开场白的空卡」也生成一句人造角色提示。
   *   - 世界书同理不算：它自己走 worldInfo 段，不依赖 main 兜底。
   *
   * 空卡于是等同于「没有角色」，`buildSystemPrompt` 得以按既有契约返回空串。
   */
  const hasUsableCard = Boolean(
    args.character &&
      (character.name ||
        character.description ||
        character.personality ||
        character.scenario ||
        character.systemPrompt ||
        character.postHistoryInstructions ||
        character.exampleMessages),
  );

  /**
   * 是否在扮演某个角色。`nsfw` 段是 ST 的**角色扮演护栏**
   * （"{{char}} will not speak for {{user}}."），没有角色时它没有意义。
   */
  const hasCharacter = hasUsableCard;

  /**
   * 「是否真的有任何要说的」—— 有可用的角色卡，或有全局提示词。
   *
   * 两者都没有时 `buildPrompt` 仍会返回非空 system 段，因为它对 `main`/`nsfw`
   * 用的是**非空常量兜底**：
   *   main -> DEFAULT_MAIN_PROMPT（"Write {{char}}'s next reply..."）
   *   nsfw -> DEFAULT_NSFW_PROMPT（"{{char}} will not speak for {{user}}."）
   * 于是「无内容 -> 返回空串」这条既有契约会被破坏 —— 而调用方（`generate()`）
   * 正是靠空串来决定「不发 system 消息、让模型用自己的 GGUF 模板前缀」。
   */
  const hasContent = hasCharacter || global.length > 0;

  /**
   * 需要被掐空的段。
   *
   * ⚠️ 关键事实：`buildPrompt` 的 `nsfw` 段**从不过 macro 展开**
   * （`sections.set('nsfw', DEFAULT_NSFW_PROMPT)`），所以它渲染出来的永远是字面量
   * `{{char}} will not speak for {{user}}.` —— 两个占位符原样发给模型。
   * 这不是「有点丑」，是**明确的有害输入**：模型会看到 `{{char}}`、`{{user}}`
   * 这两个它无法解释的符号，而该段本意只是「别替用户说话」。
   *
   * 所以：
   *   - 无角色：整段去掉（护栏对不存在的角色无意义，占位符更是纯噪音）
   *   - 无任何内容：`main` 也去掉（否则空场景被塞进一句英文 ST 默认语）
   *
   * 为什么用 `enabled: false` 而不是「把内容改成空串」：兜底常量在
   * `buildPrompt` 内部用 `??` 取值，调用方给空串会被 `??` 判掉、回退到常量。
   * `promptOrder` 的 `enabled` 是唯一能在**不改 buildPrompt** 的前提下拦住它的开关
   * （buildPrompt 是本任务清单外的文件）。顺序原样保留，只改 `enabled`。
   */
  const suppressed = new Set<PromptIdentifier>();
  if (!hasCharacter) suppressed.add('nsfw');
  if (!hasContent) suppressed.add('main');

  const EMPTY_ORDER: PromptOrderEntry[] = suppressed.size
    ? DEFAULT_PROMPT_ORDER.map((o) =>
        suppressed.has(o.identifier) ? { ...o, enabled: false } : o,
      )
    : DEFAULT_PROMPT_ORDER;

  /**
   * 把 `main` 段移到角色各段**之后**。
   *
   * 这一条是为了保住本仓库既有的、有意的行为（见 `systemPrompt.test.ts` 的
   * `character comes BEFORE the global prompt`）：用户全局提示词放在角色定义
   * 之后，它的角色是**追加指令**而不是替换。反过来放（ST 的出厂顺序确实是
   * main 在最前），一段很长的卡描述会把「用中文回答」这类短指令埋掉。
   *
   * 为什么用挪顺序而不是把全局提示词塞进别的段：
   *   - `main` 是 ST 里语义唯一对得上的槽位（「用户自定义主系统提示」）；
   *   - 塞进 `jailbreak` 会落到对话历史**之后**，指令被历史淹没；
   *   - 塞进 `scenario` 之类则语义不符，且会和角色卡自己的字段互相覆盖。
   * `promptOrder` 本来就是为此存在的可组合控制项，所以这里只调顺序，不改内容。
   *
   * 只在「有全局提示词」时挪：没有全局提示词时 `main` 装的是中文兜底语，
   * 那句是对**角色扮演**的总体交代，理应保持在最前。
   */
  const orderedSections: PromptOrderEntry[] = global
    ? (() => {
        const withoutMain = EMPTY_ORDER.filter((o) => o.identifier !== 'main');
        const main = EMPTY_ORDER.find((o) => o.identifier === 'main');
        if (!main) return EMPTY_ORDER;
        // 插到 worldInfoAfter 之后、dialogueExamples 之前：角色定义已全部说完，
        // 紧接着是全局指令，再接示例与历史。
        const idx = withoutMain.findIndex((o) => o.identifier === 'worldInfoAfter');
        const at = idx >= 0 ? idx + 1 : withoutMain.length;
        return [...withoutMain.slice(0, at), main, ...withoutMain.slice(at)];
      })()
    : EMPTY_ORDER;

  const options: BuildPromptOptions = {
    maxContext: args.contextLength,
    maxTokens: args.maxOutputTokens ?? 512,
    userName: args.userName ?? 'User',
    personaDescription: args.personaDescription,
    countTokens: estimateTokens,
    promptOrder: orderedSections,
  };

  return {
    character,
    ...(worldBooks.length > 0 ? { worldBooks } : {}),
    history: toChatMessages(args.messages),
    ...(global ? { mainPrompt: global } : {}),
    // 角色卡的 system_prompt 是**卡作者写的额外主提示**，与用户全局提示并存。
    // 只有当用户没写全局提示时才让它升格为 main（否则两段会互相盖掉）。
    //
    // ⚠️ 兜底只给**有可用角色卡**的情况。以前这里对无卡情形也塞中文兜底 main，
    // 结果 `buildSystemPrompt` 在「没角色卡、没全局提示词」时不再返回空串，
    // 而是返回一句人造的系统提示 —— 这属于**行为回退**：调用方（generate）
    // 正是靠空串来决定「不发 system 消息、让模型用自己的 GGUF 模板前缀」。
    // 无卡无提示词时必须原样返回空串，这条由 `buildPrompt` 的
    // `if (!content) continue` 自然满足 —— 前提是 main 段确实是空的。
    ...(global || !hasUsableCard
      ? {}
      : { mainPrompt: character.systemPrompt || DEFAULT_ZH_MAIN }),
    // 卡作者的 post_history_instructions 走 buildPrompt 的 jailbreak 段
    // （不传 jailbreakPrompt 时它会自动回退到 character.postHistoryInstructions）。
    // 用户全局提示词已经占据 main，不能再占用 jailbreak —— 否则它在
    // prompt_order 里会跑到对话历史**之后**，指令效力被历史淹没。
    authorsNote: undefined,
    options,
  };
}

/**
 * 有角色卡但既无用户提示、也无卡作者提示时的中文兜底 main 段。
 *
 * `buildPrompt` 内置的 `DEFAULT_MAIN_PROMPT` 是英文 ST 默认语
 * （"Write {{char}}'s next reply..."），直接用在中文卡上会诱导模型用英文回答首轮。
 * 这里换成等价语义的中文表述。
 *
 * 注意它**只在有角色卡时**使用：无卡时宁可不给 main，也要保住「无内容 -> 空串」
 * 这条既有契约（见 `makeAssembleInput` 里的说明）。
 */
const DEFAULT_ZH_MAIN =
  '以「{{char}}」的身份，在虚构的对话中回复 {{user}} 的下一句话。';

/* ==========================================================================
 * 开场白
 * ========================================================================== */

/**
 * 取出新对话的第一条 assistant 消息（角色的开场白）。
 *
 * ⚠️ **本函数目前没有任何生产调用点**，这是**有意的**：
 * 插入时机在 `useChatStore.createConversation` 里，而该函数不在本任务的
 * 可改文件清单内（多个 agent 同时在改同一个 store 文件）。接线方式：
 *
 * ```ts
 * const opening = openingMessageFor(character)
 * if (opening) appendMessage({ role: 'assistant', content: opening, ... })
 * ```
 *
 * `alternateGreetings`：ST 里它由用户点击「换一个开场白」选择，默认用第一条。
 * 这里返回 first_mes；alternate 的选择交给 UI，不在本函数内定夺。
 */
export function openingMessageFor(character: AdapterCharacter | null): string | null {
  if (!character) return null;
  const first = character.card.data.first_mes;
  return first && first.trim() ? first : null;
}

/**
 * 备用开场白列表。UI 需要它来提供「换一个开场白」。
 * 与 `openingMessageFor` 一样，当前无生产调用点。
 */
export function alternateOpeningsFor(character: AdapterCharacter | null): string[] {
  if (!character) return [];
  return (character.card.data.alternate_greetings ?? []).filter(
    (g) => typeof g === 'string' && g.trim().length > 0,
  );
}
