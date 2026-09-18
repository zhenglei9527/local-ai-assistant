# 并行任务接口契约（agent 必读）

本文件是本次并行开发的**唯一事实来源**。多个 agent 同时改这个仓库，
**任何接口改动都必须先在这里登记**，否则会互相覆盖。

---

## 铁律

1. **只改你被分配的文件**。文件清单在下面的任务里明确列出。
   要改清单外的文件 → **先停下来在报告里说明理由**，不要直接改。
2. **不要 `git commit` / `git push`**。主 agent 统一提交。
3. **不要动 `package.json`**。需要新依赖 → 报告里说明，用现有依赖实现。
4. **跑测试用**：
   ```powershell
   $env:Path = "C:\Program Files\nodejs;$env:Path"
   cd "D:\DeepSeek harness\phone-llm-app"
   node --import ./scripts/register-alias.mjs --test "src/**/*.test.ts"
   ```
   ⚠️ 必须用 `C:\Program Files\nodejs` —— PATH 里的 node 被 TRAE 劫持成 v22，跑不了 `.ts`。
5. **交付前必须自己跑一遍全量测试**，报告实际通过数。

---

## 已经存在的接口（不要改签名）

### `src/data/db/schema.ts` —— 表已建好，直接读写

```sql
characters (
  id TEXT PRIMARY KEY, card_json TEXT NOT NULL, avatar_path TEXT,
  name TEXT NOT NULL, is_user_created INTEGER, created_at INTEGER, updated_at INTEGER
)

conversations (
  id TEXT PRIMARY KEY, title TEXT, character_id TEXT, model_id TEXT,
  sampler_override TEXT, context_override TEXT, world_info TEXT,
  message_count INTEGER, last_message_at INTEGER, created_at INTEGER, updated_at INTEGER
)

messages (
  id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT,
  reasoning TEXT, model_id TEXT, swipe_index INTEGER, swipes_json TEXT,
  edited INTEGER, pinned INTEGER, created_at INTEGER
)
```

⚠️ **`swipes_json` 列已存在但从未被读写** —— 多版本回复任务要用它。

### `src/data/db/connection.ts` —— 数据库访问

```ts
export interface SqliteDb {
  all: <T>(sql: string, params?: unknown[]) => Promise<T[]>
  one: <T>(sql: string, params?: unknown[]) => Promise<T | null>
  run: (sql: string, params?: unknown[]) => Promise<void>
  tx: (fn: (db: SqliteDb) => Promise<void>) => Promise<void>
  raw: NativeDb
}
export async function getDb(): Promise<SqliteDb | null>   // null = 无数据库，必须优雅降级
export function __setDbForTests(fake: SqliteDb | null): void
export function __adaptForTests(native: NativeDb): SqliteDb
```

⚠️ **注意**：op-sqlite 18 **没有** `getAll`/`getFirst`，只有 `execute` 返回 `{rows}`。
上面的适配器已经处理好，**用 `all`/`one`/`run`，不要直接调 `raw.execute`**。

### `src/character-card/index.ts` —— 角色卡系统（已完整实现）

```ts
export function buildPrompt(input: AssembleInput): BuiltPrompt
export function scanWorldInfo(book: WorldInfoBook, ctx: ScanContext): WorldInfoResult
export function parseCard(input: string | Uint8Array | object): NormalizedCharacter
```

```ts
interface BuiltPrompt {
  systemPrompt: string                                   // 拼好的 system 段
  messages: Array<{ role: ChatRole; content: string }>   // 顺序消息
  estimatedTokens: number
  activatedWorldInfo: number[]                           // 命中的世界书 uid
  droppedMessages: number
  debug: { budgetTokens, wiTokens, historyTokens, sections[] }
}
```

⚠️ **`buildPrompt` 目前没有任何生产代码调用它** —— 这是「世界书不生效」的根因。

### `src/store/index.ts` —— 状态

```ts
useChatStore: {
  characters: CharacterRecord[]
  setCharacters(c): void
  selectCharacter(id): void
  conversations, messages, transcripts
  createConversation(characterId?): string
  appendUser(content), appendMessage(msg), replaceMessage(msg), removeMessage(id)
  regenerateFrom(assistantMessageId): Promise<void>
  setActiveConversation(id), deleteConversation(id)
}
useEngineStore: { generate(), stop(), activateModel(), status, streamingText, ... }
useModelStore: { records, readyModelId, ... }
useSettingsStore: { systemPrompt, sampling, contextConfig, remoteProvider, backend, ... }
```

### `src/inference/contextWindow.ts` —— 上下文裁剪（已实现）

```ts
export function trimToContext(system, history, opts): TrimResult
export function contextUsage(system, history, contextLength): number  // 0..1
```

### `src/character-card/worldInfo.ts` —— 世界书（已实现，700+ 行）

ST 兼容：`constant` / 关键词触发 / `keysecondary` + `selectiveLogic` /
递归 / 8 种位置 / token 预算。

---

## 报告格式（每个 agent 必须按此格式回）

```
## 任务：<编号和名字>

### 改了哪些文件
- <完整路径> — <一句话说明>

### 新增的公开接口（如有）
<签名>

### 测试结果
<实际跑出来的数字：tests / pass / fail>

### 遇到的问题 / 未做的部分
<诚实说明，不要粉饰>
```

---

## 任务分配

### 任务 A：角色卡持久化
**负责文件**（只能改这些）：
- `src/data/db/characters.ts`（新建）
- `src/store/index.ts`（**只在 `useChatStore` 里加 character 相关函数**，
  ⚠️ 不要动 `generate`/`appendUser`/`regenerateFrom` 等已有函数）
- `src/ui/screens/CharacterScreen.tsx`（改为调用 store 的持久化函数）
- `src/data/db/characters.test.ts`（新建）

**要求**：
1. 角色卡写入 `characters` 表（`card_json` 存完整 `CharacterRecord`）
2. 启动时恢复（`restoreConversations` 里一并恢复 —— ⚠️ 那个函数在 store 末尾，
   你可以调用它，但**修改它之前先确认没别人在改**；如果冲突就在报告里说明）
3. 删除角色卡要同时处理引用它的对话（`character_id` 外键是 `ON DELETE SET NULL`）
4. 无数据库时优雅降级（`getDb()` 返回 null）

---

### 任务 B：接上 buildPrompt（世界书 + 开场白 + 对话示例）
**负责文件**：
- `src/character-card/adapter.ts`（新建 —— 把 store 状态转成 `AssembleInput`）
- `src/store/index.ts`（**只改 `buildSystemPrompt` 一处**，把它改成调用 `buildPrompt`）

⚠️ **这是最容易冲突的任务**。`buildSystemPrompt` 在 store 第 1119 行附近，
**只改这一个函数**，不要动它周围的任何代码。

**要求**：
1. `buildSystemPrompt` 改为调用 `buildPrompt`，保留原有签名（返回 string）
   —— 如果 `buildPrompt` 返回的 `messages` 里有角色定义注入，需要一并处理
2. 世界书生效：`character.characterBook` 传给 `buildPrompt`
3. `first_mes`（开场白）：新对话时作为第一条 assistant 消息插入
4. `mes_example`（对话示例）：注入到提示词
5. ⚠️ **保留现有行为**：没有角色卡时，用户全局 `systemPrompt` 仍要生效

---

### 任务 C：记忆总结（解决长期失忆）
**负责文件**：
- `src/memory/summarize.ts`（新建）
- `src/memory/summarize.test.ts`（新建）
- `src/data/db/schema.ts`（**只加新表**，不要改已有表；加迁移到 `MIGRATIONS`）
- `src/store/index.ts`（**只加新函数**，不要改已有函数）

**要求**：
1. 每 N 轮（默认 10）触发一次总结
2. 总结用**同一次推理**（不另起模型），把旧对话压成 `[摘要]`
3. 摘要持久化，重启后仍在
4. 注入到提示词（用 `buildPrompt` 的位置机制，或 systemPrompt 拼接）
5. **独立函数 + 纯逻辑可测**，不要在 store 里写死

---

### 任务 D：多版本回复（swipes）
**负责文件**：
- `src/store/index.ts`（**只加 swipe 相关函数**）
- `src/data/db/conversations.ts`（**只加 swipe 的读写**，
  `swipes_json` 列已存在）
- `src/ui/screens/ChatScreen.tsx`（**只加 swipe UI**，
  ⚠️ 不要动 `MessageBubble` 的 long-press 逻辑 —— 那是刚修好的）
- `src/store/swipes.test.ts`（新建）

**要求**：
1. 重新生成时，**保留旧回复**到 `swipes[]` 而不是删除
2. UI：气泡下方左右箭头切换版本，显示 `1/3`
3. 持久化（`swipes_json`）

---

### 任务 E：消息编辑
**负责文件**：
- `src/ui/screens/ChatScreen.tsx`（**只加编辑 UI**）
- `src/store/index.ts`（`replaceMessage` 已存在，可直接用，**不要改它**）

**要求**：
1. 长按菜单加「编辑」项（⚠️ 菜单代码在 `onMessageLongPress`，
   和任务 D 都要改这个函数 —— **D 和 E 都在 ChatScreen，看下面的冲突说明**）
2. 编辑后该消息之后的所有消息需要标记（上下文已变）
3. 编辑用户消息后可选「重新发送」

---

### ⚠️ 冲突说明：任务 D 和 E 都改 ChatScreen.tsx

**约定**：
- 任务 D 只加：swipe 相关的箭头 UI + 对应的 styles
- 任务 E 只加：编辑相关的 modal + 对应的 styles + 在
  `onMessageLongPress` 的 `actions` 数组里追加一项

**`onMessageLongPress` 里通过 `actions.push(...)` 追加，不要重写整个数组。**
两个 agent 各追加自己的一项即可合并。

---

## 验收标准（主 agent 会用这些检查）

1. `node --import ./scripts/register-alias.mjs --test "src/**/*.test.ts"` 全绿
2. 每个任务新增至少 3 个测试
3. 真机验证：安装 APK 后，角色卡重启不丢、世界书生効、开场白出现
4. **不允许**为了通过测试而降低已有行为
