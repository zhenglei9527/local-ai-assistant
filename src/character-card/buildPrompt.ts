/**
 * 提示词组装
 *
 * 插入顺序**不是推断**，而是取自角色卡的
 * default/content/presets/openai/Default.json 中 `prompt_order`（character_id: 100000）：
 *
 *   main -> worldInfoBefore -> charDescription -> charPersonality -> scenario
 *        -> enhanceDefinitions(默认关) -> nsfw -> worldInfoAfter
 *        -> dialogueExamples -> chatHistory -> jailbreak
 *
 * personaDescription 出现在 persona 变体（character_id: 100001），
 * 位置在 worldInfoBefore 之后、charDescription 之前。
 *
 * 关键事实：`post_history_instructions` 对应标识符 `jailbreak`，**在 chatHistory 之后**。
 */

import type {
  BuildPromptOptions,
  BuiltPrompt,
  ChatMessage,
  NormalizedCharacter,
  PromptIdentifier,
  PromptOrderEntry,
  WorldInfoBook,
} from './types.ts';
// 以下为运行时值，不能用 import type
import { DEFAULT_PROMPT_ORDER, DEFAULT_SAMPLING, WorldInfoPosition } from './types.ts';
import { scanWorldInfo } from './worldInfo.ts';
import type { ScanContext } from './worldInfo.ts';

/* ==========================================================================
 * 宏（macro）展开
 * ========================================================================== */

/**
 * 宏替换。ST 的宏系统很大，此处实现手机端必需子集。
 * 参考 V1 规范：`{{char}}`/`<BOT>` 与 `{{user}}`/`<USER>` 需大小写不敏感替换。
 */
export function substituteMacros(
  text: string,
  vars: {
    char?: string;
    user?: string;
    description?: string;
    personality?: string;
    scenario?: string;
    persona?: string;
    model?: string;
    original?: string;
    /** 允许调用方注入额外宏 */
    extra?: Record<string, string>;
  },
): string {
  if (!text) return '';
  const char = vars.char ?? '';
  const user = vars.user ?? 'User';

  let out = text;

  // ST 内核宏
  out = out.replace(/\{\{char\}\}/gi, char);
  out = out.replace(/<BOT>/gi, char);
  out = out.replace(/\{\{user\}\}/gi, user);
  out = out.replace(/<USER>/gi, user);

  out = out.replace(/\{\{description\}\}/gi, vars.description ?? '');
  out = out.replace(/\{\{personality\}\}/gi, vars.personality ?? '');
  out = out.replace(/\{\{scenario\}\}/gi, vars.scenario ?? '');
  out = out.replace(/\{\{persona\}\}/gi, vars.persona ?? '');
  out = out.replace(/\{\{model\}\}/gi, vars.model ?? '');
  out = out.replace(/\{\{original\}\}/gi, vars.original ?? '');

  // 换行/空格控制宏
  out = out.replace(/\{\{newline\}\}/gi, '\n');
  out = out.replace(/\{\{trim\}\}/gi, '');

  if (vars.extra) {
    for (const [k, v] of Object.entries(vars.extra)) {
      out = out.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'gi'), v);
    }
  }

  return out;
}

/* ==========================================================================
 * 示例对话解析
 * ========================================================================== */

/**
 * 把 mes_example 拆成对话消息。
 * V1 规范用 `<START>` 分段；每段内部以 `{{user}}:` / `{{char}}:` 起头的行分组。
 * 无法解析的段整体作为 assistant 消息保留（不丢弃用户内容）。
 */
export function parseExampleMessages(
  exampleBlock: string,
  charName: string,
  userName: string,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (!exampleBlock || !exampleBlock.trim()) return [];
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  const blocks = exampleBlock.split(/<START>/i);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    // 按「角色名:」切分说话人，支持 {{char}}/{{user}} 已展开后的形态
    const speakerRe = new RegExp(`^(?:\\{\\{char\\}\\}|\\{\\{user\\\\}\\}|${escapeRe(charName)}|${escapeRe(userName)})\\s*:`, 'i');
    const lines = trimmed.split('\n');
    let currentRole: 'user' | 'assistant' | null = null;
    let buffer: string[] = [];

    const flush = () => {
      if (buffer.length && currentRole) {
        out.push({ role: currentRole, content: buffer.join('\n').trim() });
      }
      buffer = [];
    };

    for (const line of lines) {
      const isChar = new RegExp(`^(?:\\{\\{char\\}\\}|${escapeRe(charName)})\\s*:`, 'i').test(line);
      const isUser = new RegExp(`^(?:\\{\\{user\\}\\}|${escapeRe(userName)})\\s*:`, 'i').test(line);
      if (isChar || isUser) {
        flush();
        currentRole = isChar ? 'assistant' : 'user';
        buffer.push(line.replace(/^[^:]*:\s*/, ''));
      } else {
        if (currentRole === null) currentRole = 'assistant';
        buffer.push(line);
      }
    }
    flush();
  }

  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ==========================================================================
 * token 估算
 * ========================================================================== */

/**
 * 默认 token 估算器。
 *
 * ⚠️ 已收敛到 `src/inference/tokenizer.ts`，此处仅作**再导出**以保持既有调用点
 * 不变。此前本项目有 5 份各自独立的估算器（本文件、worldInfo、rollingSummary、
 * MockInferenceEngine、RemoteEngine），它们会漂移 —— UI 的上下文占用条、
 * 截断决策、预算判断会对同一个字符串给出不同答案。
 *
 * 有已加载模型时应使用 `makeLlamaTokenCounter(context)` 拿**真实词表计数**；
 * 本函数只在模型尚未加载（此处的世界书扫描与卡预算预检正是这种场景）时兜底。
 */
export { estimateTokens } from '../inference/tokenizer.ts'

/* ==========================================================================
 * 主组装流程
 * ========================================================================== */

export interface AssembleInput {
  character: NormalizedCharacter;
  /** 额外世界书（全局/角色绑定），按优先级顺序排列，前面的先扫 */
  worldBooks?: WorldInfoBook[];
  history: ChatMessage[];
  /** 用户自定义主系统提示（对应 ST 的 main） */
  mainPrompt?: string;
  /** 用户自定义越狱/后置提示（对应 ST 的 jailbreak），默认取角色的 post_history_instructions */
  jailbreakPrompt?: string;
  /** 作者注 */
  authorsNote?: string;
  authorsNoteDepth?: number;
  options: BuildPromptOptions;
}

/** ST 默认的 main 提示（含义等价；原文见 Default.json 的 main 字段） */
export const DEFAULT_MAIN_PROMPT =
  "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.";

const DEFAULT_NSFW_PROMPT =
  '{{char}} will not speak for {{user}}.';

/**
 * 组装完整提示词。
 */
export function buildPrompt(input: AssembleInput): BuiltPrompt {
  const { character, history, options } = input;
  const count = options.countTokens ?? estimateTokens;
  const userName = options.userName ?? 'User';
  const charName = character.nickname || character.name;
  const order: PromptOrderEntry[] = options.promptOrder ?? DEFAULT_PROMPT_ORDER;

  const macroVars = {
    char: charName,
    user: userName,
    description: character.description,
    personality: character.personality,
    scenario: character.scenario,
    persona: options.personaDescription ?? '',
  };

  /* ---- 1. 世界书扫描 ---- */
  const budgetPercent = options.worldInfoBudgetPercent ?? 25;
  const scanCtx: ScanContext = {
    messages: history.map((m) => ({ role: m.role, content: m.mes })),
    scanDepth: 4,
    caseSensitive: false,
    matchWholeWords: false,
    characterName: charName,
    userName,
    personaDescription: options.personaDescription,
    characterDescription: character.description,
    characterPersonality: character.personality,
    scenario: character.scenario,
    scanPersonaDescription: false,
    scanCharacterDescription: false,
    scanCharacterPersonality: false,
    scanScenario: false,
    recursive: options.recursiveScan ?? false,
    maxRecursionSteps: 2,
    maxContext: options.maxContext,
    tokenBudget: budgetPercent,
    budgetCap: options.worldInfoBudgetCap,
    countTokens: count,
    messageIndex: history.length,
  };

  const wiResults = (input.worldBooks ?? (character.characterBook ? [character.characterBook] : []))
    .map((b) => scanWorldInfo(b, scanCtx));

  const wiBefore: string[] = [];
  const wiAfter: string[] = [];
  const wiAtDepth = new Map<number, string[]>();
  const wiExampleTop: string[] = [];
  const wiExampleBottom: string[] = [];
  const activatedUids: number[] = [];
  let wiTokens = 0;

  for (const r of wiResults) {
    wiTokens += r.usedTokens;
    for (const a of r.injected) {
      activatedUids.push(a.entry.uid);
      const text = substituteMacros(a.content, macroVars);
      switch (a.entry.position ?? WorldInfoPosition.Before) {
        case WorldInfoPosition.Before:
          wiBefore.push(text);
          break;
        case WorldInfoPosition.After:
          wiAfter.push(text);
          break;
        case WorldInfoPosition.AtDepth: {
          const d = a.entry.depth ?? 4;
          const arr = wiAtDepth.get(d) ?? [];
          arr.push(text);
          wiAtDepth.set(d, arr);
          break;
        }
        case WorldInfoPosition.EMTop:
          wiExampleTop.push(text);
          break;
        case WorldInfoPosition.EMBottom:
          wiExampleBottom.push(text);
          break;
        // ANTop/ANBottom/Outlet 需要作者注与扩展机制，此处不处理（见兼容性矩阵）
        default:
          wiAfter.push(text);
      }
    }
  }

  const wiFormat = options.wiFormat ?? '{0}';
  const joinWI = (arr: string[]) =>
    arr.map((s) => wiFormat.replace('{0}', s)).join('\n');

  /* ---- 2. 逐标识符生成段落 ---- */
  const sections = new Map<PromptIdentifier, string>();

  sections.set('main', substituteMacros(input.mainPrompt ?? DEFAULT_MAIN_PROMPT, macroVars));

  sections.set('worldInfoBefore', joinWI(wiBefore));

  sections.set(
    'personaDescription',
    options.personaDescription ? substituteMacros(options.personaDescription, macroVars) : '',
  );

  sections.set('charDescription', substituteMacros(character.description, macroVars));

  const personalityFormat = options.personalityFormat ?? '{{personality}}';
  const personalityBody = substituteMacros(
    personalityFormat.replace('{{personality}}', character.personality),
    macroVars,
  );
  sections.set('charPersonality', character.personality ? personalityBody : '');

  const scenarioFormat = options.scenarioFormat ?? '{{scenario}}';
  const scenarioBody = substituteMacros(
    scenarioFormat.replace('{{scenario}}', character.scenario),
    macroVars,
  );
  sections.set('scenario', character.scenario ? scenarioBody : '');

  // enhanceDefinitions 默认为 disabled，此处恒为空但保留槽位
  sections.set('enhanceDefinitions', '');
  sections.set('nsfw', DEFAULT_NSFW_PROMPT);

  sections.set('worldInfoAfter', joinWI(wiAfter));

  // 示例对话：世界书的 EMTop/EMBottom 分别插在示例对话首尾
  const exampleParts: string[] = [];
  if (wiExampleTop.length) exampleParts.push(joinWI(wiExampleTop));
  if (character.exampleMessages) exampleParts.push(substituteMacros(character.exampleMessages, macroVars));
  if (wiExampleBottom.length) exampleParts.push(joinWI(wiExampleBottom));
  sections.set('dialogueExamples', exampleParts.join('\n'));

  // chatHistory 是标记位，内容在 messages 数组中展开
  sections.set('chatHistory', '');

  // jailbreak = post_history_instructions，在历史之后
  const post = input.jailbreakPrompt ?? character.postHistoryInstructions;
  sections.set('jailbreak', substituteMacros(post, macroVars));

  /* ---- 3. 按 order 拼接 system 段 ---- */
  const systemParts: string[] = [];
  const sectionStats: BuiltPrompt['debug']['sections'] = [];

  for (const o of order) {
    if (!o.enabled) continue;
    const content = sections.get(o.identifier) ?? '';
    if (!content) continue;
    sectionStats.push({ identifier: o.identifier, tokens: count(content), chars: content.length });
    if (o.identifier !== 'chatHistory') systemParts.push(content);
  }

  const systemPrompt = systemParts.join('\n');

  /* ---- 4. 历史截断（带预算） ---- */
  const historyBudget =
    options.maxContext - options.maxTokens - count(systemPrompt);

  let maxHistory = options.maxHistoryMessages ?? Infinity;
  const historyMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  // 先做消息条数截断（保留最近 N 条）
  const candidateHistory = history.slice(-maxHistory);

  // 再按 token 预算从最新往回累积
  let historyTokens = 0;
  const kept: ChatMessage[] = [];
  for (let i = candidateHistory.length - 1; i >= 0; i--) {
    const m = candidateHistory[i];
    if (m.role === 'system') continue;
    const t = count(substituteMacros(m.mes, macroVars)) + 4; // +4 为 role 开销
    if (historyTokens + t > historyBudget && kept.length > 0) break;
    historyTokens += t;
    kept.push(m);
  }
  kept.reverse();

  for (const m of kept) {
    historyMessages.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: substituteMacros(m.mes, macroVars),
    });
  }

  /* ---- 5. AtDepth 世界书注入 ---- */
  // depth 表示从历史末尾倒数的位置（depth 1 = 最后一条之前）
  if (wiAtDepth.size > 0) {
    const depths = [...wiAtDepth.keys()].sort((a, b) => b - a);
    for (const d of depths) {
      const texts = wiAtDepth.get(d)!;
      const idx = Math.max(0, historyMessages.length - d);
      historyMessages.splice(idx, 0, { role: 'user', content: joinWI(texts) });
    }
  }

  /* ---- 6. 作者注（默认深度 4） ---- */
  if (input.authorsNote) {
    const depth = input.authorsNoteDepth ?? 4;
    const idx = Math.max(0, historyMessages.length - depth);
    historyMessages.splice(idx, 0, {
      role: 'system' as never,
      content: substituteMacros(input.authorsNote, macroVars),
    } as never);
  }

  /* ---- 7. 组装消息数组 ---- */
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });

  // 示例对话作为 prompt 的一部分插在历史之前（ST 中 dialogueExamples 是静态段落，
  // 这里保持为 system 段的一部分，故不再重复插入 messages）

  messages.push(...historyMessages);

  const estimatedTokens =
    count(systemPrompt) +
    historyMessages.reduce((s, m) => s + count(m.content) + 4, 0);

  return {
    systemPrompt,
    messages,
    estimatedTokens,
    activatedWorldInfo: activatedUids,
    droppedMessages: history.length - kept.length,
    debug: {
      budgetTokens: Math.round((budgetPercent * options.maxContext) / 100) || 1,
      wiTokens,
      historyTokens,
      sections: sectionStats,
    },
  };
}

/** 便捷：从角色卡取首条消息（含备用问候） */
export function pickGreeting(character: NormalizedCharacter, index = -1): string {
  if (index >= 0 && index < character.alternateGreetings.length) {
    return character.alternateGreetings[index];
  }
  return character.firstMessage;
}

/** 便捷：默认采样参数（ST Default.json 的实测值） */
export function defaultSampling() {
  return { ...DEFAULT_SAMPLING };
}
