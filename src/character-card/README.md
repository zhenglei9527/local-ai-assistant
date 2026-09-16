# character-card —— SillyTavern 兼容角色卡模块

`phone-llm-app` 的**角色卡系统**参考实现（TypeScript，零运行时依赖）。
目标：让 Android 本地大模型聊天 App 能直接吃下酒馆（SillyTavern）生态的角色卡。

---

## 这个模块能做什么

| 能力 | 入口 | 状态 |
|---|---|---|
| 解析 V1 / V2 / V3 JSON 角色卡 | `parseCard` / `parseJsonCard` | ✅ 已实现并测试 |
| 解析 PNG 内嵌卡（`chara` / `ccv3` chunk） | `parsePngCard` | ✅ 已实现并测试 |
| 归一化为统一内部表示 | `normalizeCharacter` | ✅ |
| 世界书触发（关键词 / 预算 / 递归 / 分组） | `scanWorldInfo` | ✅ 核心已测试，见「已知偏差」 |
| 正则脚本应用 | `applyRegexScripts` | ✅ 已测试 |
| 提示词组装 | `buildPrompt` | ✅ 已测试 |
| 导出回 V2 / V3 卡 | `toV2Card` / `toV3Card` | ✅ 基础往返已测试 |

---

## 快速开始

### 1. 从文件解析角色卡（自动识别 PNG / JSON）

```ts
import { parseCard } from './character-card';

// Uint8Array（PNG 文件读出的字节）或 string（.json 内容），同一个入口
const character = parseCard(bytes);

console.log(character.name);              // 角色名
console.log(character.firstMessage);      // 开场白
console.log(character.spec);              // 'chara_card_v1' | 'chara_card_v2' | 'chara_card_v3'
console.log(character.warnings);          // 解析告警（非致命问题，建议展示给用户）
```

**务必检查 `warnings`**：真实世界的卡脏数据很多（spec 不识别、字段缺失、
V1 卡被写进 base64 chunk 等），解析器一律「尽力解析 + 记录告警」而不抛错。

### 2. 跑世界书触发

```ts
import { scanWorldInfo } from './character-card';

const result = scanWorldInfo({
  book: character.characterBook,          // V2 卡的 character_book
  messages: chat.messages,                // ChatMessage[]，用 mes 字段即可
  maxContext: 4096,                       // 手机端典型窗口
  worldInfoBudgetPercent: 25,             // ST 默认预算占比
  countTokens: (s) => estimateTokens(s),  // 建议接入真实分词器
});

result.injected;       // ← 真正要注入 prompt 的条目（已过预算）
result.budgetDropped;  // 命中但因预算被丢的条目（可用于 UI 解释）
result.byPosition;     // 按 8 个插入位置分组
```

> ⚠️ **`activated` 与 `injected` 不是一回事**，这是最容易踩的坑：
> - `activated` = 触发了条件的**全部**条目
> - `injected` = 真正通过 token 预算、应当进入 prompt 的条目
>
> 组装 prompt 请一律用 **`injected`**。

### 3. 组装最终 prompt

```ts
import { buildPrompt, estimateTokens } from './character-card';

const out = buildPrompt({
  character,
  worldBooks: [character.characterBook],
  history: chat.messages,
  options: {
    maxContext: 4096,
    maxTokens: 512,
    userName: 'User',
    countTokens: estimateTokens,
  },
});

out.systemPrompt;          // system 段（角色设定 + 世界书 + 示例对话）
out.messages;              // 对话消息数组，直接喂给 llama.rn
out.activatedWorldInfo;    // 本轮激活的世界书 uid
out.droppedMessages;       // 因窗口不足被丢弃的历史条数
out.debug.sections;        // 每个段落的 token 消耗，用于调试面板
```

---

## 与 `llama.rn` 对接

`buildPrompt` 的输出是通用的 `{ role, content }[]`，直接喂给 chat completion：

```ts
import { initLlama } from 'llama.rn';

const ctx = await initLlama({ model: 'file:///.../model.gguf', n_ctx: 4096 });

const out = buildPrompt({ /* ... */ });

await ctx.completion(
  {
    messages: [
      { role: 'system', content: out.systemPrompt },
      ...out.messages,
    ],
    temperature: 0.8,
    top_p: 0.95,
    n_predict: 512,
  },
  (data) => { /* 流式回调 */ },
);
```

**重要**：`estimateTokens` 是**启发式估算**（CJK 约 1 字/token，拉丁约 4 字符/token），
不是真实分词。生产环境应换成 llama.cpp 的真实分词（见下）。

```ts
// 生产建议：用 llama.rn 的真实分词器替换估算器
const countTokens = async (text: string) => {
  const tokens = await ctx.tokenize(text);
  return tokens.length;
};
```

---

## 为什么源码里没有 `enum`

本模块用 `as const` 对象 + 同名 union type 代替 TS `enum`：

```ts
export const WorldInfoPosition = { Before: 0, After: 1, /* ... */ } as const;
export type WorldInfoPosition = (typeof WorldInfoPosition)[keyof typeof WorldInfoPosition];
```

两个原因：

1. **Node 原生类型剥离不支持 `enum`**。`node --test` 直接跑 `.ts` 依赖 Node 的
   strip-only 模式，遇到 `enum` 会抛 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。
2. **RN/Hermes 下 enum 需要额外运行时 shim**，而 `as const` 对象是纯值，零开销。

用法与 enum 完全一致：`WorldInfoPosition.Before`。

### 关于 import 后缀

源码中所有相对 import 都带 `.ts` 后缀（`from './types.ts'`），因为 Node 的
ESM 解析要求显式扩展名。Metro / RN 打包器同样接受显式后缀。

**类型导入必须写 `import type`**，否则类型剥离后会留下指向不存在导出的悬空
import 而报错：

```ts
import type { WorldInfoBook } from './types.ts';        // ✅ 纯类型
import { WorldInfoPosition } from './types.ts';          // ✅ 运行时值
```

---

## 运行测试

```bash
# 在 phone-llm-app 目录下
node --test src/character-card/parseCard.test.ts
```

要求 **Node >= 22.6**（原生 TypeScript 类型剥离）。实测环境 Node v24.15.0。

当前状态：**42 个测试全部通过**。覆盖 V1/V2/V3 JSON 卡、V2/V3 PNG 内嵌卡、
`ccv3` 优先级、base64 与明文两种编码、世界书触发/预算/分组/递归、正则闸门、
宏展开、prompt 组装与历史截断。

测试**零第三方依赖**：`testPng.ts` 自行实现了 CRC32、PNG chunk 组装与 zlib
IDAT，刻意不复用解析器代码，避免「用同一份有 bug 的代码自证正确」。

---

## 已知偏差（诚实清单）

以下内容**未实现或与 SillyTavern 行为有差异**，不要当成已完成：

| 项 | 状态 | 说明 |
|---|---|---|
| `@@activate` / `@@dont_activate` 装饰器 | ❌ 未实现 | ST 允许条目前置 `@@` 行强制/禁止激活 |
| 世界书递归自激抑制 | ⚠️ 降级 | ST 用 `compareBufferMessages` 等机制比对原文；本实现只做「已激活跳过」，交叉递归（A 触发 B、B 触发 A）只会各激活一次 |
| `ANTop` / `ANBottom` / `Outlet` 插入位置 | ⚠️ 降级 | 会退化到 after 桶；无作者注 UI，outlet 无扩展消费方 |
| 宏系统 | ⚠️ 子集 | 已实现 `{{char}}`/`{{user}}`/`<BOT>`/`<USER>`/`{{description}}`/`{{personality}}`/`{{scenario}}`/`{{persona}}`/`{{model}}`/`{{original}}`/`{{newline}}`/`{{trim}}`；**无** `{{time}}`/`{{date}}`/`{{random}}`/`{{roll}}` 等 |
| token 计数 | ⚠️ 估算 | 非真实分词，见上文 |
| `world_info_character_strategy` | ❌ 未接入 | 多本世界书的全局/角色优先级合并需调用方自行编排 |
| 正则 `MD_DISPLAY`(0) / `sendAs`(4) | ❌ 刻意不支持 | ST 源码已标 `@deprecated`，slot 4 是死值 |
| CHUNK / WHISPER / 向量检索世界书 | ❌ 不支持 | 手机端无向量库 |
| `enhanceDefinitions` 段落 | ⚠️ 空占位 | 为对齐 ST `prompt_order` 保留槽位，恒为空 |
| 严格类型检查（`tsc --noEmit`） | ⚠️ 未执行 | 项目 `node_modules` 未安装，无本地 typescript |

---

## 目录结构

```
src/character-card/
  types.ts            完整类型定义（卡 / 世界书 / 正则 / 预设 / 聊天 / prompt）
  parseCard.ts        JSON 与 PNG 解析、归一化、写回
  worldInfo.ts        世界书触发引擎 + 正则脚本引擎
  buildPrompt.ts      提示词组装、宏展开、token 估算
  index.ts            公共出口（barrel）
  testPng.ts          测试用 PNG 生成器（独立实现，非生产代码）
  parseCard.test.ts   单元测试（node:test）
  README.md           本文件
```

设计文档见 `docs/character-card-design.md`。

---

## 设计约定

- **统一内部表示优先**：解析后一律转成 `NormalizedCharacter`，运行时只处理这一种
  形态，不区分 V1/V2/V3。版本差异只在 `parseCard` 里消化。
- **零运行时依赖**：手写 base64、UTF-8 解码、PNG chunk 遍历，不依赖 `Buffer`/
  `atob`，保证 RN 与 Node 双端一致。
- **失败要可解释**：解析失败抛带上下文的错误（例如列出 PNG 里实际有哪些 tEXt
  keyword）；非致命问题进 `warnings` 而不中断。
- **确定性可测试**：`countTokens` 与 `random` 都是注入依赖，测试里传固定实现，
  避免随机翻车。
