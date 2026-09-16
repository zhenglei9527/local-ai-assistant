/**
 * 角色卡 / 世界书 / 正则 / 预设 / 聊天 —— 完整类型定义
 *
 * 字段名与取值**逐条对照**下列一手来源核实，未核实的项在注释中标注「待验证」：
 *  - V1 规范: malfoyslastname/character-card-spec-v2  spec_v1.md
 *  - V2 规范: malfoyslastname/character-card-spec-v2  spec_v2.md
 *  - V3 规范: kwaroran/character-card-spec-v3         SPEC_V3.md
 *  - 参考实现: character-card 规范
 *      public/scripts/world-info.js         (世界书触发引擎)
 *      public/scripts/extensions/regex/engine.js (正则)
 *      src/endpoints/characters.js          (character_book -> 内部字段映射)
 *      default/content/presets/openai/Default.json (prompt_order)
 */

/* ==========================================================================
 * 1. 世界书（Lorebook）—— character_book 与 ST 原生 world info 的共有子集
 * ========================================================================== */

/**
 * 插入位置。取值与 ST `world_info_position` 完全一致（world-info.js:855）。
 * 注意 4/6/7 不是连续语义空缺，而是真实存在的位置。
 *
 * 用 `as const` 对象而非 TS `enum`：Node 的原生类型剥离（strip-only mode）
 * 不支持 enum（ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX），且 enum 会生成运行时对象，
 * Hermes 下也需额外转换。用法与 enum 一致：WorldInfoPosition.Before
 */
export const WorldInfoPosition = {
  /** 角色定义（char description）之前 */
  Before: 0,
  /** 角色定义之后 */
  After: 1,
  /** 作者注（Author's Note）顶部 */
  ANTop: 2,
  /** 作者注底部 */
  ANBottom: 3,
  /** 按深度插入到聊天历史中（depth 指定倒序条数） */
  AtDepth: 4,
  /** 示例对话（Example Messages）顶部 */
  EMTop: 5,
  /** 示例对话底部 */
  EMBottom: 6,
  /** 出口(outlet)：不自动注入，由扩展按名引用 —— 手机端不支持 */
  Outlet: 7,
} as const;
export type WorldInfoPosition =
  (typeof WorldInfoPosition)[keyof typeof WorldInfoPosition];

/** 次级键（secondary_keys）的选择逻辑，值同 ST `world_info_logic`（world-info.js:33）。 */
export const WorldInfoLogic = {
  /** 任一次级键命中。注意 NotAll 与之行为重合，这是 ST 的真实语义，非笔误 */
  AndAny: 0,
  NotAll: 1,
  /** 所有次级键都未命中 */
  NotAny: 2,
  /** 所有次级键都命中 */
  AndAll: 3,
} as const;
export type WorldInfoLogic = (typeof WorldInfoLogic)[keyof typeof WorldInfoLogic];

/**
 * 世界书条目。
 *
 * character_book 使用 snake_case（keys/secondary_keys/insertion_order），
 * ST 原生世界书使用 camelCase（key/keysecondary/order/disable）。
 * 本类型采用 **ST 原生命名**，由 parseCard.ts 负责转换。
 */
export interface WorldInfoEntry {
  /** 稳定标识；V2 的 character_book 条目没有 id，解析时自动生成 */
  uid: number;
  /** 条目备注（仅 UI 显示，不进 prompt） */
  comment?: string;
  /** 主键：命中任一即视为「主键匹配」 */
  key: string[];
  /** 次级键 */
  keysecondary: string[];
  /** 命中的内容 */
  content: string;
  /** 插入顺序，越大越靠前（排序为 order 降序） */
  order: number;
  /** ST 用 disable = !enabled；这里统一暴露为 enabled 更直观 */
  enabled: boolean;
  /** 常量条目：无条件激活 */
  constant?: boolean;
  /** 是否启用次级键检查 */
  selective?: boolean;
  /** 次级键逻辑 */
  selectiveLogic?: WorldInfoLogic;
  /** 条目级大小写敏感；未设置时回退全局设置 */
  caseSensitive?: boolean | null;
  /** 全词匹配 */
  matchWholeWords?: boolean | null;
  /** 插入位置 */
  position?: WorldInfoPosition;
  /** position === AtDepth 时，从聊天末尾倒数的深度 */
  depth?: number;
  /** 角色名与用户名的相对位置：'before' | 'after' */
  role?: 'system' | 'user' | 'assistant' | null;
  /** 该条目允许被递归扫描再次扫描 */
  excludeRecursion?: boolean;
  /** 该条目自身的触发不参与递归扫描（旧字段，与 excludeRecursion 意向相反） */
  preventRecursion?: boolean;
  /** 延迟到第 N 层递归才允许激活；true 等价于 1 */
  delayUntilRecursion?: boolean | number;
  /** 激活概率 0-100 */
  probability?: number;
  /** 是否使用 probability（否则恒为 100） */
  useProbability?: boolean;
  /** 覆盖扫描深度（参加扫描的历史条数） */
  scanDepth?: number | null;
  /** 是否纳入自动扫描范围（ST: 决定条目是否进入扫描缓冲） */
  automationId?: string;
  /** 组名（逗号分隔），同组只激活一个 */
  group?: string;
  /** 组内优先：按 order 取最优而非加权随机 */
  groupOverride?: boolean;
  /** 组内权重 */
  groupWeight?: number;
  /** 粘性：激活后保持 N 条消息 */
  sticky?: number | null;
  /** 冷却：激活后 N 条消息内不再激活 */
  cooldown?: number | null;
  /** 延迟：N 条消息后才允许激活 */
  delay?: number | null;
  /** 越预算也强制插入 */
  ignoreBudget?: boolean;
  /** 匹配到角色卡/nickname 时按角色过滤 */
  characterFilter?: WorldInfoCharacterFilter | null;
  /** V3 新增（Lorebook 下为必填；character_book 下可选） */
  useRegex?: boolean;
  /** 原始 JSON 中的 extensions，如实保留 */
  extensions?: Record<string, unknown>;
  /** 保留原始键名形态，便于无损回写 */
  __raw?: unknown;
  [k: `x_${string}`]: unknown;
}

export interface WorldInfoCharacterFilter {
  isExclude: boolean;
  names: string[];
  tags: string[];
}

/** 世界书（character_book / 独立 world info 文件统一表示） */
export interface WorldInfoBook {
  name?: string;
  description?: string;
  /** 扫描深度（包含多少条历史消息） */
  scanDepth?: number;
  /** token 预算：<100 视为上下文百分比，>=100 视为绝对 token 数 */
  tokenBudget?: number;
  /** 递归扫描 */
  recursiveScan?: boolean;
  /** 递归最大步数 */
  maxRecursionSteps?: number;
  /** 大小写敏感默认值 */
  caseSensitive?: boolean;
  /** 匹配全词默认值 */
  matchWholeWords?: boolean;
  entries: WorldInfoEntry[];
  extensions?: Record<string, unknown>;
}

/* ==========================================================================
 * 2. 正则脚本
 * ========================================================================== */

/** 同 ST `regex_placement`（regex/engine.js）。0 已在源码中标记 @deprecated，不实现。 */
export const RegexPlacement = {
  /** @deprecated ST 源码明确标注废弃，不实现 */
  MDDisplay: 0,
  UserInput: 1,
  AIOutput: 2,
  SlashCommand: 3,
  /** slot 4 是历史遗留的 sendAs，本实现跳过 */
  WorldInfo: 5,
  Reasoning: 6,
} as const;
export type RegexPlacement = (typeof RegexPlacement)[keyof typeof RegexPlacement];

/** 同 ST `substitute_find_regex` */
export const RegexSubstituteType = {
  NONE: 0,
  RAW: 1,
  ESCAPED: 2,
} as const;
export type RegexSubstituteType =
  (typeof RegexSubstituteType)[keyof typeof RegexSubstituteType];

export interface RegexScript {
  id: string;
  scriptName: string;
  /** 查找模式（字符串形式，Android 端可用 RegExp 构造） */
  findRegex: string;
  /** 替换串，支持 $1..$9 与 ST 的 {{match}} 约定（待验证：{{match}} 仅部分后端起效） */
  replaceString: string;
  /** 参与处理的位置集合 */
  placement: RegexPlacement[];
  disabled: boolean;
  markdownOnly: boolean;
  promptOnly: boolean;
  runOnEdit: boolean;
  substituteRegex: RegexSubstituteType;
  minDepth: number | null;
  maxDepth: number | null;
  trimStrings?: string[];
  /** 安卓端需要防止灾难性回溯，可设上限 */
  timeoutMs?: number;
}

/* ==========================================================================
 * 3. 预设（采样参数）
 * ========================================================================== */

/** 采样与上下文参数，字段名对照 ST textgen/openai 预设。 */
export interface SamplingPreset {
  temperature: number;
  topP: number;
  topK: number;
  topA: number;
  minP: number;
  repetitionPenalty: number;
  frequencyPenalty: number;
  presencePenalty: number;
  seed: number;
  /** 最大上下文 token */
  maxContext: number;
  /** 最大输出 token */
  maxTokens: number;
  /** 无重复 n-gram 大小（llama.cpp 支持；ST 的 textgen 预设中有） */
  noRepeatNgramSize?: number;
  /** 上下文偏移（MiRo stat 等扩展参数在手机端不实现） */
  contextShift?: boolean;
}

/** ST 默认采样值，取自 default/content/presets/openai/Default.json */
export const DEFAULT_SAMPLING: SamplingPreset = {
  temperature: 1,
  topP: 1,
  topK: 0,
  topA: 0,
  minP: 0,
  repetitionPenalty: 1,
  frequencyPenalty: 0,
  presencePenalty: 0,
  seed: -1,
  maxContext: 4095,
  maxTokens: 300,
};

/* ==========================================================================
 * 4. 角色卡 V1 / V2 / V3
 * ========================================================================== */

/** V1 扁平卡。规范要求六个字段全部存在且默认 ""。 */
export interface CharacterCardV1 {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  /** 写卡工具常附带，非 V1 规范字段 */
  creatorcomment?: string;
  avatar?: string;
  talkativeness?: string;
  fav?: boolean;
  tags?: string[];
}

/** V3 assets 条目 */
export interface CharacterAsset {
  type: string;
  uri: string;
  name: string;
  ext: string;
}

/** V2 / V3 的 data 载荷。V3 是 V2 的严格超集。 */
export interface CharacterCardData {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  creator_notes: string;
  system_prompt: string;
  post_history_instructions: string;
  alternate_greetings: string[];
  character_book?: WorldInfoBook;
  tags: string[];
  creator: string;
  character_version: string;
  extensions: Record<string, unknown>;

  /* ---- V3 新增 ---- */
  nickname?: string;
  creator_notes_multilingual?: Record<string, string>;
  source?: string[];
  group_only_greetings?: string[];
  creation_date?: number;
  modification_date?: number;
  assets?: CharacterAsset[];
}

export interface CharacterCardV2 {
  spec: 'chara_card_v2';
  spec_version: '2.0';
  data: CharacterCardData;
}

export interface CharacterCardV3 {
  spec: 'chara_card_v3';
  spec_version: '3.0';
  data: CharacterCardData;
}

export type CharacterCardV2OrV3 = CharacterCardV2 | CharacterCardV3;

/** 归一化后的统一内部表示 —— 运行时只使用这一种形态 */
export interface NormalizedCharacter {
  /** 卡格式来源 */
  spec: 'chara_card_v1' | 'chara_card_v2' | 'chara_card_v3';
  /** 原始 spec_version 原文 */
  specVersion: string;
  name: string;
  /** V3 nickname；未提供时等于 name */
  nickname: string;
  description: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  exampleMessages: string;
  creatorNotes: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  alternateGreetings: string[];
  groupOnlyGreetings: string[];
  tags: string[];
  creator: string;
  characterVersion: string;
  extensions: Record<string, unknown>;
  characterBook?: WorldInfoBook;
  assets: CharacterAsset[];
  /** 源 PNG 的原始字节（若是从 PNG 解析），供 UI 展示头像 */
  rawPng?: Uint8Array;
  /** 解析过程中的非致命告警，供 UI 提示用户 */
  warnings: string[];
}

/* ==========================================================================
 * 5. 聊天记录
 * ========================================================================== */

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  /** 已展开宏（{{char}}/{{user}}）之前的原始文本 */
  mes: string;
  /** 该消息的生成时间戳（毫秒） */
  sendDate: number;
  /** swipe（多次候选），messages[i] 为当前显示 */
  swipes: string[];
  swipeId: number;
  /** 用户手工编辑过 */
  isEdited?: boolean;
  /** 用户收藏的书签 */
  isBookmark?: boolean;
  /** 该消息相关的世界书激活记录（便于调试） */
  worldInfoActivated?: number[];
  extra?: Record<string, unknown>;
}

export interface ChatBranch {
  id: string;
  name: string;
  /** 分支起始消息索引（含） */
  fromIndex: number;
  createdAt: number;
}

export interface ChatSession {
  id: string;
  characterId: string;
  /** 显示名（同名角色多开时的区分） */
  name: string;
  messages: ChatMessage[];
  branches: ChatBranch[];
  /** 当前所处分支 id，null 表示主干 */
  currentBranch: string | null;
  /** 每轮消息计数，供 sticky/cooldown/delay 使用 */
  lastUpdated: number;
  /** 时序效果状态：ST 存于 chat_metadata.timedWorldInfo */
  timedWorldInfo: Record<string, { sticky?: number; cooldown?: number; delay?: number }>;
  metadata?: Record<string, unknown>;
}

/* ==========================================================================
 * 6. 提示词组装
 * ========================================================================== */

/**
 * prompt_order 条目标识符。取值对照 Default.json：
 *   main, worldInfoBefore, charDescription, charPersonality, scenario,
 *   enhanceDefinitions, nsfw, worldInfoAfter, dialogueExamples, chatHistory, jailbreak
 * personaDescription 出现在 persona 变体中（character_id 100001）。
 */
export type PromptIdentifier =
  | 'main'
  | 'worldInfoBefore'
  | 'personaDescription'
  | 'charDescription'
  | 'charPersonality'
  | 'scenario'
  | 'enhanceDefinitions'
  | 'nsfw'
  | 'worldInfoAfter'
  | 'dialogueExamples'
  | 'chatHistory'
  | 'jailbreak';

export interface PromptOrderEntry {
  identifier: PromptIdentifier;
  enabled: boolean;
}

/** ST 默认 prompt_order（取自 Default.json 的 character_id: 100000） */
export const DEFAULT_PROMPT_ORDER: PromptOrderEntry[] = [
  { identifier: 'main', enabled: true },
  { identifier: 'worldInfoBefore', enabled: true },
  { identifier: 'charDescription', enabled: true },
  { identifier: 'charPersonality', enabled: true },
  { identifier: 'scenario', enabled: true },
  { identifier: 'enhanceDefinitions', enabled: false },
  { identifier: 'nsfw', enabled: true },
  { identifier: 'worldInfoAfter', enabled: true },
  { identifier: 'dialogueExamples', enabled: true },
  { identifier: 'chatHistory', enabled: true },
  { identifier: 'jailbreak', enabled: true },
];

export interface BuiltPrompt {
  /** 最终拼接的 system 段（供 llama.cpp 的 system role 使用） */
  systemPrompt: string;
  /** 按顺序排列的对话消息（含角色定义注入后的形态） */
  messages: Array<{ role: ChatRole; content: string }>;
  /** 估算的 token 数 */
  estimatedTokens: number;
  /** 实际激活的世界书 uid 列表 */
  activatedWorldInfo: number[];
  /** 被截断的历史消息数 */
  droppedMessages: number;
  /** 诊断信息 */
  debug: {
    budgetTokens: number;
    wiTokens: number;
    historyTokens: number;
    sections: Array<{ identifier: PromptIdentifier; tokens: number; chars: number }>;
  };
}

export interface BuildPromptOptions {
  /** 目标上下文窗口（token） */
  maxContext: number;
  /** 为模型输出预留的 token */
  maxTokens: number;
  /** 世界书 token 预算占上下文百分比 */
  worldInfoBudgetPercent?: number;
  /** 世界书绝对 token 上限（对应 ST world_info_budget_cap） */
  worldInfoBudgetCap?: number;
  /** 历史保留多少条 */
  maxHistoryMessages?: number;
  /** 是否启用世界书递归扫描 */
  recursiveScan?: boolean;
  /** token 估算器（默认启发式；接入 llama.rn 后可换成真实分词器） */
  countTokens?: (text: string) => number;
  /** 用户名（宏展开用） */
  userName?: string;
  /** persona 描述 */
  personaDescription?: string;
  promptOrder?: PromptOrderEntry[];
  wiFormat?: string;
  scenarioFormat?: string;
  personalityFormat?: string;
}
