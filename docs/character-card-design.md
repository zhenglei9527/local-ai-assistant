# 角色卡系统技术设计文档

> 目标读者：`phone-llm-app` 的开发者。
> 范围：角色卡数据模型、解析算法、世界书触发、提示词组装、移动端取舍。
> 参考实现：`src/character-card/`（TypeScript）。

---

## 0. 结论摘要

**兼容角色卡角色卡是可行的，但「100% 兼容」是伪目标。** 真实情况是三层：

1. **卡格式层面可以做到完全兼容** —— V1/V2/V3 三种 JSON 形态 + PNG 内嵌卡，
   字段语义明确、有正式规范，参考实现已跑通 42 个测试。
2. **世界书触发可以做到高度兼容** —— 核心算法（关键词、预算、优先级、递归、
   分组）可完整复刻，少数 ST 专属机制（装饰器、自激抑制）需要降级。
3. **运行时行为不可能完全对齐** —— ST 的提示词组装依赖用户可配置的扩展生态，
   手机端没有这个生态，应做「固定顺序 + 少量开关」而非复刻全部可配置性。

**最大技术风险不在格式，而在 token 预算。** 手机端窗口 4K-8K，而角色卡卡普遍是
按 8K-32K 窗口设计的。世界书 + 角色设定 + 历史三方争抢预算，必须有明确策略。

---

## 1. 三种卡格式字段对照

### 1.1 规范来源（全部经一手核实）

| 版本 | 规范标识 | 权威来源 |
|---|---|---|
| V1 | 无（扁平结构） | `malfoyslastname/character-card-spec-v2` → `spec_v1.md` |
| V2 | `spec: "chara_card_v2"` | 同上 → `spec_v2.md` |
| V3 | `spec: "chara_card_v3"` | `kwaroran/character-card-spec-v3` → `SPEC_V3.md`（**注意文件名全大写**） |

实现行为对照：`角色卡规范/角色卡规范` @ `release` 分支
`src/character-card-parser.js`、`src/endpoints/characters.js`、`public/scripts/world-info.js`。

### 1.2 字段对照表

| 概念 | V1（顶层） | V2 / V3（`data.*`） | 必填 | 备注 |
|---|---|---|---|---|
| 格式标识 | — | `spec` | V2+ ✅ | 字符串字面量 |
| 格式版本 | — | `spec_version` | V2+ ✅ | V2 是 `"2.0"`，V3 是 `"3.0"` |
| 角色名 | `name` | `name` | ✅ | |
| 角色描述 | `description` | `description` | ✅ | prompt 主体 |
| 性格 | `personality` | `personality` | ✅ | |
| 场景 | `scenario` | `scenario` | ✅ | |
| 开场白 | `first_mes` | `first_mes` | ✅ | |
| 示例对话 | `mes_example` | `mes_example` | ✅ | `<START>` 分隔 |
| 作者注 | — | `creator_notes` | ✅(V2+) | **不得进入 prompt** |
| 覆盖系统提示 | — | `system_prompt` | ✅(V2+) | 空串则回退用户设置 |
| 历史后指令 | — | `post_history_instructions` | ✅(V2+) | 注入在对话历史**之后** |
| 备用开场白 | — | `alternate_greetings` | ✅(V2+) | 数组；**实际可能是字符串** |
| 内嵌世界书 | — | `character_book` | ⭕ | V2+ 可选 |
| 标签 | — | `tags` | ✅(V2+) | |
| 作者 | — | `creator` | ✅(V2+) | |
| 卡版本 | — | `character_version` | ✅(V2+) | |
| 扩展数据 | — | `extensions` | ✅(V2+) | **必须默认 `{}`，禁止销毁未知键** |

### 1.3 V3 独有字段（V2 的严格超集）

| 字段 | 类型 | 说明 |
|---|---|---|
| `nickname` | string | 替代 `{{char}}`，**不影响卡名展示** |
| `creator_notes_multilingual` | Record<string,string> | 多语言作者注 |
| `source` | string[] | 来源 URL 列表 |
| `group_only_greetings` | string[] | 仅群聊使用的开场白，**V3 必填** |
| `creation_date` / `modification_date` | number | **Unix 秒**，非毫秒 |
| `assets` | `{type,uri,name,ext}[]` | 资源清单，默认 `[{type:'icon',uri:'ccdefault:',name:'main',ext:'png'}]` |

V3 的世界书条目（`Lorebook` 类型）新增 **`use_regex`（必填）**，并把 `constant`
从可选提升为必填。这是 V3 与 V2 在 `character_book` 上的唯一实质差异。

### 1.4 关键差异总结（V1 → V2 → V3）

1. **V1 → V2 是结构性变更**：从扁平 6 字段变为 `spec` + `spec_version` + `data` 嵌套，
   并新增 9 个字段。V2 卡**不保证**顶层还有 `name` 等字段。
2. **V2 → V3 是增量扩展**：结构不变，新增 7 个字段 + 世界书 `use_regex`。
   **V3 卡用 V2 解析器读不会崩**（超集特性），但会丢 V3 独有字段。
3. **所有 V1/V2/V3 卡都必须容忍字段缺失**。规范要求默认空串，但真实卡经常
   整个字段不写。解析器必须补默认值而不是抛错。
4. **`spec` 缺失但有 `data`**：规范未明确，参考实现按 V2 处理并告警（V3 是超集，
   V2 路径不丢字段，这个方向是安全的）。
5. **`spec_version` 检测版本时按浮点解析**（`3.0 > 2.0`）—— 但字符串 `"3.0"`
   与数字 `3.0` 都可能出现，需兼容。

---

## 2. PNG 内嵌卡解析

### 2.1 为什么用 PNG

角色卡卡以 PNG 分发（既是头像又是数据载体）。数据藏在 `tEXt` chunk 里，
图片不显示异常，普通看图工具无感知。

### 2.2 PNG 二进制结构

```
┌─────────────── PNG Signature (8 bytes) ───────────────┐
│ 89 50 4E 47 0D 0A 1A 0A                               │
├──────────────── Chunk ────────────────────────────────┤
│ Length    (4 bytes, big-endian)   ← 仅 Data 的长度     │
│ Type      (4 bytes, ASCII)        ← 'IHDR'/'tEXt'/... │
│ Data      (Length bytes)                              │
│ CRC       (4 bytes, big-endian)   ← Type+Data 的校验   │
├──────────────── Chunk ────────────────────────────────┤
│ ...                                                   │
├──────────────── IEND ─────────────────────────────────┤
│ 00 00 00 00 | 'IEND' | CRC                            │
└───────────────────────────────────────────────────────┘
```

**关键点：`Length` 字段只涵盖 `Data`，不含 `Type`(4) 和 `CRC`(4)。**
遍历时步进 `offset += 8 + Length + 4`。这是最常见的 off-by-8 错误来源。

### 2.3 tEXt chunk 的 Data 内部结构

```
┌──────────────────── tEXt Data ────────────────────┐
│ Keyword (1-79 bytes, Latin-1)                     │
│ 00                    ← 单个 NUL 分隔符           │
│ Text (剩余全部字节)                                │
└───────────────────────────────────────────────────┘
```

- Keyword 是 **Latin-1**（1 字节/字符），不是 UTF-8。用 `String.fromCharCode`
  按字节转即可，用 UTF-8 解码会在非 ASCII 关键词上出错。
- 找 NUL 用 `data.indexOf(0)`，**不要在 `Data` 里找 base64 特征**。
- 角色卡的关键词是 `chara`（V2 时代）和 `ccv3`（V3 新增）。

### 2.4 解析步骤

```
parsePngCard(bytes)
  │
  ├─ 1. 校验 8 字节 PNG 签名 (89 50 4E 47 0D 0A 1A 0A)
  │     失败 → 抛错「不是合法 PNG」
  │
  ├─ 2. 从 offset=8 开始遍历 chunk
  │     while offset + 8 <= length:
  │       len  = readUInt32BE(offset)
  │       type = ASCII(bytes[offset+4 .. offset+8])
  │       ├─ 越界保护: offset+8+len+4 > length → break
  │       └─ 若 type == 'tEXt':
  │            data = bytes[offset+8 .. offset+8+len]
  │            nul  = indexOf(data, 0)
  │            keyword = latin1(data[0..nul])
  │            text    = latin1(data[nul+1..])
  │            收集 {keyword, text}
  │       offset += 8 + len + 4
  │       if type == 'IEND': break
  │
  ├─ 3. 选 chunk（**关键词小写比较**）
  │     ccv3 优先 ──► chara ──► 兜底别名
  │     两者同时存在时 **ccv3 胜出，且不合并**
  │
  ├─ 4. 解码 payload（见 2.5 的三分支兼容）
  │
  └─ 5. JSON.parse → normalizeCharacter → 补 rawPng 供 UI 显头像
```

### 2.5 ⚠️ 陷阱一：base64 差异（本题重点）

**实测结论与常见说法不符，必须以 ST 真实代码为准：**

角色卡 `src/character-card-parser.js` 的读取路径，对 `ccv3` 和 `chara`
**两者都无条件执行** `Buffer.from(text, 'base64').toString('utf8')`。
ST **自身没有**「V1 卡可能不编码」的分支 —— V1 时代的非编码卡在 ST 的 PNG
路径下同样会失败。

所以正确做法不是「V2 解码、V1 不解码」（这是错的，会误判），而是：

```
decodeChunkPayload(text)
  ├─ 分支 A: text 以 '{' 开头  → 直接 JSON.parse（明文卡，兼容性兜底）
  ├─ 分支 B: 否则尝试 base64 解码 → UTF-8 → JSON.parse
  └─ 分支 C: 再失败 → 尝试 decodeURIComponent → JSON.parse
            仍失败 → 抛带上下文的错误
```

**注意分支顺序**：先判 `{` 前缀再看 base64。因为一段明文 JSON 通常也是合法
base64 字符集（`{`/`"` 不在 base64 字母表里，所以实际上会自然失败，
但显式前置判断更清晰且避免了「先试 base64 得到垃圾再回退」的弯路）。
反过来，一段 base64 **不可能**以 `{` 开头，所以这个顺序是安全的。

**后果**：解析明文 JSON 卡时必须补一条 warning，因为这是非标准卡，
提示用户该卡在官方角色卡里可能读不出来。

### 2.6 ⚠️ 陷阱二：`ccv3` 与 `chara` 的优先级

V3 规范规定：**两个 chunk 同时存在时 `ccv3` 胜出**。ST 实现一致（先查 `ccv3`）。

**不要合并两个 chunk 的字段。** V3 是 V2 的超集，`ccv3` 已含全部信息；
合并会引入「哪个版本优先」的歧义，还可能把 V2 的旧值覆盖到 V3 的新值上。

**写回时**：ST 会同时写 `chara` 和 `ccv3` 两个 chunk（保证老工具也能读），
这是个好实践，本模块的 `toV3Card` 只产出 JSON，PNG 写入需调用方补齐。

### 2.7 其它 PNG 陷阱

| 陷阱 | 说明 |
|---|---|
| **大小写** | 关键词比较必须 `toLowerCase()`；不同工具写出的可能是 `Chara` |
| **CRC 校验** | 本实现**不校验** CRC。真实卡的 CRC 经常是错的（工具直接拼字节），校验会导致误拒。**解析数据不需要 CRC** |
| **截断文件** | 畸形 `Length` 会导致越界读或死循环，必须有 `offset+8+len+4 > length` 保护 |
| **`tEXt` vs `iTXt` / `zTXt`** | 角色卡用 `tEXt`。`iTXt` 支持 UTF-8 但需解压/分语言，`zTXt` 是压缩的。**未实现**，遇非 ASCII 大内容时可能需补 |
| **多个同名 chunk** | 取**第一个**（`find`），与 ST 一致 |
| **PNG 之外的容器** | WEBP 不被 V1 规范覆盖；JPG 无法携带 tEXt。**不支持** |
| **无 tEXt 的 PNG** | 抛错时**列出实际发现的关键词**，便于定位（很多空卡是写卡工具坏了） |

---

## 3. 世界书（World Info / Lorebook）

### 3.1 两种形态与字段映射

世界书有两套命名，必须做转换：

| ST 原生（`world_info`） | 卡内（`character_book`） | 说明 |
|---|---|---|
| `key` | `keys` | 主键数组 |
| `keysecondary` | `secondary_keys` | 次级键数组 |
| `order` | `insertion_order` | 排序权重 |
| `disable` | `enabled`（取反） | **注意语义相反** |
| `position`（数字） | `position`（`'before_char'`/`'after_char'`） | 枚举形态不同 |
| `uid` | — | 卡内无 uid，解析时按索引生成 |

**几乎所有 ST 专属行为都在 `extensions.*` 里**：
`depth`、`probability`、`useProbability`、`group`、`groupOverride`、`groupWeight`、
`scanDepth`、`role`、`sticky`、`cooldown`、`delay`、`excludeRecursion`、
`preventRecursion`、`delayUntilRecursion`、`matchWholeWords`、`caseSensitive`、
`ignoreBudget`、`characterFilter`、`selectiveLogic`、`automationId`。

> **结论：`character_book` 是有损子集。** 解析时必须把 `extensions.*` 里的
> ST 字段提升为一等公民，否则会丢失大量触发行为。

### 3.2 插入位置（8 个，不是 4 个）

对照 ST `world_info_position`：

| 值 | 名称 | 含义 | 手机端 |
|---|---|---|---|
| 0 | `before` | 角色定义之前 | ✅ |
| 1 | `after` | 角色定义之后 | ✅ |
| 2 | `ANTop` | 作者注顶部 | ⚠️ 降级 |
| 3 | `ANBottom` | 作者注底部 | ⚠️ 降级 |
| 4 | `atDepth` | 按深度插入历史 | ✅ |
| 5 | `EMTop` | 示例对话顶部 | ✅ |
| 6 | `EMBottom` | 示例对话底部 | ✅ |
| 7 | `outlet` | 出口，由扩展按名引用 | ❌ 不支持 |

`ANTop`/`ANBottom` 依赖「作者注」这个独立 UI 概念，手机端若不做作者注编辑
则退化为 after 桶。`outlet` 依赖扩展生态，无消费方。

### 3.3 触发算法伪代码

```
FUNCTION scanWorldInfo(book, messages, maxContext, opts):

  # ---- 1. 预算 ----
  IF book.tokenBudget >= 100:            # 绝对值语义
      budget = book.tokenBudget
  ELSE:
      budget = round((book.tokenBudget OR 25) * maxContext / 100) OR 1
  IF opts.budgetCap > 0:
      budget = min(budget, opts.budgetCap)

  # ---- 2. 扫描缓冲 ----
  depth   = book.scanDepth OR opts.scanDepth OR 4
  recent  = messages[ len-depth .. ]      # 取最近 depth 条
  buffer  = join(recent, "\n\x01")        # ST 用 \x01 作分隔符
  bufferLower = lower(buffer)

  # ---- 3. 排序：order 降序 ----
  entries = sort(book.entries, BY b.order - a.order)

  # ---- 4. 主扫描 ----
  activated = []            # 触发条件的全部条目
  injected  = []            # 通过预算的条目
  used      = 0
  alreadyActivated = {}

  FOR entry IN entries:
      IF NOT entry.enabled:                        CONTINUE
      IF entry.ignoreBudget == false AND used >= budget:  BREAK   # 预算耗尽
      IF alreadyActivated[entry.uid]:              CONTINUE  # 递归自激抑制（降级版）

      # --- 时序效果 ---
      IF timed[entry.uid]:
          IF timed.sticky   > 0: mark activated; CONTINUE
          IF timed.cooldown > 0: CONTINUE
          IF timed.delay    > 0: CONTINUE

      # --- 递归控制 ---
      IF entry.excludeRecursion: CONTINUE
      IF entry.delayUntilRecursion AND pass == 0: CONTINUE

      # --- 主键匹配 ---
      hit = false
      IF entry.constant:
          hit = true; reason = 'constant'
      ELSE:
          FOR k IN entry.key:
              IF matchKey(k, buffer, entry): hit = true; reason = 'primary'; BREAK

      IF NOT hit: CONTINUE

      # --- 次级键 ----
      IF entry.selective AND entry.keysecondary.length > 0:
          s = matchSecondary(entry, buffer)      # 见 3.4
          IF NOT s: CONTINUE

      # --- 概率 ---
      IF entry.useProbability AND entry.probability < 100:
          IF random() * 100 > entry.probability: CONTINUE

      activated.push(entry)

      # --- 预算消费 ---
      tokens = countTokens(entry.content)
      IF entry.ignoreBudget OR used + tokens <= budget:
          injected.push(entry)
          used += tokens
      ELSE:
          budgetDropped.push(entry)     # 命中但超预算，保留以便 UI 解释
      alreadyActivated[entry.uid] = true

  # ---- 5. 包含组过滤 ----
  injected = filterByInclusionGroups(injected)

  # ---- 6. 按 position 分桶 ----
  RETURN { activated, injected, budgetDropped, byPosition, used, budget }
```

### 3.4 关键词匹配（`matchKey`）

```
FUNCTION matchKey(key, buffer):
  # 正则键：/pattern/flags 形式，**覆盖所有其他匹配选项**
  IF key 形如 /.../flags:
      RETURN new RegExp(body, flags).test(buffer)

  needle = caseSensitive ? key : lower(key)

  IF matchWholeWords:
      IF key 是单个词:
          RETURN new RegExp(`(?:^|\\W)${escape(needle)}(?:$|\\W)`).test(bufferLower)
      ELSE:                          # 多词键
          RETURN bufferLower.includes(needle)     # ← ST 就是这么退化的
  ELSE:
      RETURN bufferLower.includes(needle)
```

**注意**：`matchWholeWords` 对多词键**不生效**，这是 ST 的真实行为
（源码里 `keyWords.length > 1` 时走 `includes`），不是本实现的疏漏。
复刻时必须保持一致，否则同一条目在两端行为不同。

### 3.5 次级键逻辑（4 值）

| 值 | 名称 | 语义 |
|---|---|---|
| 0 | `AND_ANY` | 至少一个次级键命中 |
| 1 | `NOT_ALL` | 并非全部未命中（≈ 至少一个命中） |
| 2 | `NOT_ANY` | 全部未命中 |
| 3 | `AND_ALL` | 全部命中 |

> ⚠️ **`AND_ANY`(0) 与 `NOT_ALL`(1) 实际语义重合**（都是「至少一个命中」）。
> 这看似的冗余是 ST 源码的真实状态，不是笔误。实现时保持原值语义即可，
> 不要「自作主张」把 `NOT_ALL` 改成别的含义。

### 3.6 高级机制

**递归扫描**：条目内容本身也进入扫描缓冲，从而触发其他条目。
ST 用 `MAX_SCAN_DEPTH = 1000` 上限 + `compareBufferMessages` 等机制防止无限递归。

> ⚠️ **本实现做了降级**：只做「已激活条目跳过」，不做原文/替换后文本的逐条比对。
> 后果：A 触发 B、B 内容又触发 A 的**交叉递归**，在 ST 里会持续追加，
> 本实现只会各激活一次。不会死循环，但极端卡的结果会不同。

**包含组（Inclusion Groups）**：多个条目归入同组，只允许一个激活。裁决顺序：

```
1. 组内已 sticky 的条目 → 直接胜出
2. groupOverride 的条目 → 按 order 取最优
3. 否则 → 按 groupWeight 加权随机（默认权重 100）
```

**时序效果**：`sticky`（激活后保持 N 条）/ `cooldown`（激活后 N 条内不再触发）/
`delay`（N 条后才允许激活）。状态持久化在 chat 的 `timedWorldInfo`。

---

## 4. 正则脚本

### 4.1 位置枚举

对照 ST `regex_placement`：

| 值 | 名称 | 手机端 |
|---|---|---|
| 0 | `MD_DISPLAY` | ❌ ST 源码已标 `@deprecated` |
| 1 | `USER_INPUT` | ✅ |
| 2 | `AI_OUTPUT` | ✅ |
| 3 | `SLASH_COMMAND` | ❌ 无斜杠命令系统 |
| — | *（4 是历史遗留 `sendAs`，死值）* | ❌ |
| 5 | `WORLD_INFO` | ✅ |
| 6 | `REASONING` | ⚠️ 仅推理模型 |

**枚举不连续** —— 不要用 `for (let i = 0; i <= 6; i++)` 遍历。

### 4.2 执行闸门顺序（顺序本身是语义）

```
FOR script IN scripts:
  1. IF script.disabled:                          SKIP
  2. IF script.markdownOnly XOR isMarkdown:       SKIP
  3. IF script.promptOnly   XOR isPrompt:         SKIP
  4. IF isEdit AND NOT script.runOnEdit:          SKIP
  5. IF minDepth 是数字 AND depth < minDepth:     SKIP
  6. IF maxDepth 是数字 AND depth > maxDepth:     SKIP
  7. IF NOT script.placement.includes(placement): SKIP
  8. 应用替换
```

深度闸门的「仅当是数字」很关键 —— 未设置时是 `null`，不能参与比较，
否则 `null < 0` 会误杀脚本。

---

## 5. 提示词组装

### 5.1 真实插入顺序（来自 ST 默认预设）

权威来源：`default/content/presets/openai/Default.json` 的 `prompt_order`。

```
┌─────────────────────────────────────────────────────────────┐
│  1. main              ← 主系统提示                           │
│  2. worldInfoBefore   ← 世界书（before 位置）                 │
│     [personaDescription] ← 仅 persona 变体，在 charDesc 前    │
│  3. charDescription   ← 角色描述                             │
│  4. charPersonality   ← 性格                                 │
│  5. scenario          ← 场景                                 │
│  6. enhanceDefinitions ← 默认关闭，空占位                     │
│  7. nsfw              ← 辅助提示                             │
│  8. worldInfoAfter    ← 世界书（after 位置）                  │
│  9. dialogueExamples  ← 示例对话（mes_example）               │
│ 10. chatHistory       ← 对话历史（标记位，展开为 messages）    │
│ 11. jailbreak         ← post_history_instructions 【在历史之后】│
└─────────────────────────────────────────────────────────────┘
```

**核心结论：`post_history_instructions` 注入在对话历史*之后*。**
这就是它在 V2 里叫 `post_history` 的原因 —— 它是最后一道「越狱/格式约束」
指令，模型在读完整个对话后立刻看到它，指令遵循度最高。

### 5.2 输出结构

`prompt_order` 是**标识符数组**，不是硬编码模板。因此：

- 组装必须**按 order 逐标识符生成段落再拼接**，不能写成固定的字符串模板。
- `worldInfoBefore`/`worldInfoAfter`/`dialogueExamples`/`chatHistory` 是**标记位**，
  内容动态填充；其余是静态段。
- `chatHistory` 段落本身内容为空 —— 对话历史以真正的多轮 `messages` 形式
  传给 llama.cpp，而不是拼成一坨文本（这直接决定模型能否正确理解轮次）。

### 5.3 宏展开

按 V1 规范，替换**大小写不敏感**：

| 宏 | 替代形式 | 说明 |
|---|---|---|
| `{{char}}` | `<BOT>` | 角色名（V3 优先用 `nickname`） |
| `{{user}}` | `<USER>` | 用户名 |

本实现额外支持：`{{description}}` `{{personality}}` `{{scenario}}` `{{persona}}`
`{{model}}` `{{original}}` `{{newline}}` `{{trim}}`。

**不支持**：`{{time}}` `{{date}}` `{{random}}` `{{roll}}` `{{pick}}` 等运行时宏
（无扩展消费方，且引入不确定性不利于缓存）。

### 5.4 示例对话解析

`mes_example` 用 `<START>` 分隔多段对话。每段内按 `角色名:` / `用户名:`
切分说话人。

**重要取舍**：**无法识别说话人的段落整体保留为 assistant 消息，不丢弃。**
真实卡的 `mes_example` 格式极其随意，丢内容比留噪音代价大得多。

### 5.5 `system_prompt` 的回退规则

V2 规范明确：`data.system_prompt` 为空串时**必须回退**到用户设置，
并支持 `{{original}}` 占位符引用默认系统提示。这是容易漏掉的一条 ——
直接把它塞进 prompt 会导致空段落或覆盖掉用户配置。

---

## 6. 移动端适配取舍

### 6.1 核心矛盾

| | 角色卡（桌面/Web） | 手机本地 |
|---|---|---|
| 上下文窗口 | 8K - 128K 可调 | **4K - 8K 典型** |
| 卡设计假设 | 8K+ 充裕 | 普遍超标 |
| 世界书条目数 | 几十到几百 | 几十已吃紧 |
| 推理速度 | 快 | 慢（几 token/s） |
| 内存 | 宽松 | 紧张 |

**一张典型角色卡卡**：角色描述 800 tok + 示例对话 600 tok + 系统提示 200 tok
= 1600 tok 固定开销。4K 窗口下只剩 2.4K 给世界书和历史 —— 这还没算
512 的生成预留。**必须主动管理预算。**

### 6.2 预算分配建议（4K 窗口）

```
总计  4096
├─ 生成预留      512   (12.5%)  必须留，否则模型无输出空间
├─ 系统段        ~1000 (24%)    主提示 + 角色描述 + 场景
├─ 世界书         ~800 (20%)    建议 15-25%，对应 ST 默认 25%
├─ 示例对话       ~400 (10%)    超预算时优先砍
└─ 对话历史      ~1400 (34%)    留最多，历史是连贯性来源
```

8K 窗口时整体放宽，世界书可到 25%（2000 tok），历史可到 3000+。

### 6.3 降级策略（按优先级从低到高砍）

| 优先级 | 内容 | 处理 |
|---|---|---|
| 1（最先砍） | `enhanceDefinitions` | 直接关闭 |
| 2 | 示例对话 | 截断到最近 1-2 段 `<START>` |
| 3 | 旧对话历史 | 从最早开始丢，保留最近 N 轮 |
| 4 | 世界书低优先级条目 | 按 `order` 升序丢（order 低的先丢） |
| 5 | 角色描述 | 截断（**最后手段**，伤角色一致性） |
| 6（绝不砍） | `post_history_instructions` | 长度固定且短，且是行为约束 |
| 7（绝不砍） | `first_mes` | 开场白，砍了对话无法开始 |

**世界书预算压缩的具体手段**（按性价比排序）：

1. **严格 order 降序 + 预算截断**（ST 原生机制，零成本）—— 把 `ignoreBudget`
   只留给真正关键的条目。
2. **降低 `scanDepth`** —— 默认 4 条，手机端建议 2-4。扫描深度直接决定
   误触发率，也是 CPU 开销。
3. **提高 `order` 门槛** —— 导入卡时按 `order` 排序，只保留前 N 条
   （N 按预算算），其余标记为「未启用」而非删除，用户可手动开。
4. **关闭递归扫描**（默认关）—— 递归是 token 消耗的放大器。
5. **常量条目（`constant`）从严** —— 它们无条件注入，最吃预算。

### 6.4 历史截断策略

**双重截断**：先按条数（`maxHistoryMessages`），再按 token。

```
1. 按条数粗截：保留最近 N 条（N 默认 20-40）
2. 按 token 精截：从最新往回累积，超预算即停
3. 保证首条是 user、末条是 assistant（部分模型对此敏感）
```

**为什么必须先条数后 token**：只按 token 会让保留条数随消息长度剧烈抖动，
用户体验不可预期；只按条数则超长单条仍会溢出。两者结合才稳。

**摘要（summarization）**：对小模型（1B-3B）风险高 —— 摘要质量差会污染上下文，
且摘要本身要额外推理一轮。**建议做法**：移动端先用「丢弃 + 在 UI 上明确告知
用户已丢弃 N 条」，把摘要作为可选高级功能，且只在 4B+ 模型上启用。

### 6.5 推荐的手机端默认值

```ts
{
  maxContext: 4096,              // 按设备能力探测，不要硬编码
  maxTokens: 512,
  worldInfoBudgetPercent: 20,    // 比 ST 的 25 保守
  worldInfoBudgetCap: 800,       // 绝对上限，防止大窗口下世界书失控
  maxHistoryMessages: 20,
  scanDepth: 4,
  recursiveScan: false,          // 默认关，省 CPU 和 token
}
```

---

## 7. 兼容性矩阵

### 7.1 卡格式

| 特性 | 状态 | 说明 |
|---|---|---|
| V1 扁平 JSON | ✅ 支持 | |
| V2 `data` 嵌套 | ✅ 支持 | |
| V3 超集字段 | ✅ 支持 | |
| PNG `chara` chunk | ✅ 支持 | |
| PNG `ccv3` chunk | ✅ 支持 | 优先级正确 |
| PNG 明文 JSON（非 base64） | ✅ 兼容 | 非标准，补 warning |
| `alternate_greetings` 为字符串 | ✅ 容错 | ST 真实卡存在此形态 |
| `extensions` 未知键透传 | ✅ 支持 | 规范强制要求 |
| `character_book` 完整字段 | ⚠️ 部分 | 见世界书矩阵 |
| CHUNK（分块）卡 | ❌ 不支持 | |
| CHARX（zip 容器） | ❌ 不支持 | V3 新分发格式，手机端无解压链路 |
| WEBP / JPG 内嵌 | ❌ 不支持 | 规范未覆盖 / 无法携带 tEXt |
| `iTXt` / `zTXt` chunk | ❌ 未实现 | 角色卡用 tEXt |
| PNG CRC 校验 | ❌ 刻意不做 | 真实卡 CRC 常错，校验会误拒 |

### 7.2 世界书

| 特性 | 状态 | 说明 |
|---|---|---|
| 关键词匹配（含正则键） | ✅ 支持 | |
| `matchWholeWords` | ✅ 支持 | 含多词键退化行为 |
| `caseSensitive` | ✅ 支持 | |
| 4 种 `selectiveLogic` | ✅ 支持 | |
| token 预算（百分比 + 上限） | ✅ 支持 | |
| `insertion_order` 降序 | ✅ 支持 | |
| `constant` | ✅ 支持 | |
| 包含组（含加权随机） | ✅ 支持 | |
| sticky / cooldown / delay | ✅ 支持 | |
| `excludeRecursion` / `delayUntilRecursion` | ✅ 支持 | |
| `probability` | ✅ 支持 | |
| `position` 8 位置 | ⚠️ 部分 | ANTop/ANBottom 降级，outlet 不支持 |
| 递归扫描 | ⚠️ 降级 | 无自激抑制，见 3.6 |
| `@@activate` / `@@dont_activate` 装饰器 | ❌ 未实现 | |
| `world_info_character_strategy` | ❌ 未接入 | 多本世界书合并需调用方编排 |
| 向量/语义检索世界书 | ❌ 不支持 | 无向量库 |
| `matchCreatorNotes` 等扫描片段开关 | ⚠️ 部分 | 参数位已留，`creatorNotes` 未接入缓冲 |

### 7.3 提示词与运行时

| 特性 | 状态 | 说明 |
|---|---|---|
| `prompt_order` 顺序 | ✅ 支持 | 按真实标识符数组组装 |
| `post_history_instructions` 位置 | ✅ 支持 | 历史之后 |
| 宏 `{{char}}` / `{{user}}` / `<BOT>` / `<USER>` | ✅ 支持 | 大小写不敏感 |
| `{{original}}` | ✅ 支持 | |
| 运行时宏（`{{time}}`/`{{random}}`/`{{roll}}`） | ❌ 不支持 | 无扩展消费方 |
| `mes_example` `<START>` 解析 | ✅ 支持 | 未知说话人保留不丢 |
| `system_prompt` 空串回退 | ✅ 支持 | |
| 正则脚本（1/2/5/6 位置 + 全闸门） | ✅ 支持 | |
| 正则 `MD_DISPLAY`(0) / `sendAs`(4) | ❌ 不支持 | ST 已废弃 / 死值 |
| 斜杠命令 / STscript | ❌ 不支持 | 无脚本引擎 |
| 扩展系统（UI 扩展、插件） | ❌ 不支持 | 架构性差异 |
| 群聊（多角色） | ❌ 不支持 | 单角色产品定位 |
| 世界书注入深度 UI | ⚠️ 简化 | 固定 8 位置，不开放作者注编辑 |
| token 计数 | ⚠️ 估算 | 应换 `llama_tokenize` |
| 严格类型检查 `tsc --noEmit` | ⚠️ 未执行 | 项目未装 typescript |

### 7.4 降级决策的三条理由

1. **无消费方的功能一律不做**：`outlet`、扩展系统、斜杠命令都依赖桌面端
   的扩展生态。手机端复刻了也没人用，纯增加维护面。
2. **CPU/内存敏感的功能默认关**：递归扫描、向量检索在大卡上是性能黑洞。
   保留代码路径 + 默认关闭，比彻底删除更好（用户可手动开）。
3. **UI 概念缺失导致的降级要诚实**：作者注（Author's Note）在 ST 是个独立
   可编辑的 UI 概念。手机端不做这个编辑 UI，`ANTop`/`ANBottom` 就没有锚点，
   只能退化到 after 桶。**这是产品取舍，不是技术缺陷** —— 但必须在文档里
   写清楚，不能假装支持。

---

## 8. 待验证项

以下内容**未经一手核实**，落地前需确认：

1. **`{{match}}` 在 `replaceString` 中的行为** —— 部分 ST 后端支持、部分是
   `$1` 语法。本实现只支持 `$1..$9`，未核实一致性。
2. **V3 `assets` 的 `uri` 协议** —— 已知 `ccdefault:` 是内置占位符，
   其它自定义协议的解析规则未核实（如 `embeded://`）。
3. **`spec_version` 的比较方式** —— 规范提「按浮点解析」，但 `"3.0"` 字符串
   与 `3.0` 数字混用时的鲁棒比较未逐条核实。本实现用字符串相等判断 `spec`，
   不依赖版本号比较。
4. **V1 卡的真实编码比例** —— 「V1 卡可能不 base64 编码」这一说法在
   ST 源码中**没有对应分支**。社区流传的版本可能指其它客户端的实现。
   本实现按「三分支兼容」处理，实测未被真实卡触发过。
5. **`world_info_budget` 的旧值迁移规则** —— 源码中有 `>100 → 25` 的迁移，
   但其历史边界未完整核实。

---

## 9. 参考实现的验证状态

- **测试**：`node --test src/character-card/parseCard.test.ts` → **42 passed / 0 failed**
  （Node v24.15.0，零第三方依赖）。
- **测试自证性**：`testPng.ts` 独立实现 CRC32 + PNG chunk 组装 + zlib IDAT，
  **刻意不复用解析器代码**，避免用同一份有 bug 的代码自证正确。
- **类型检查**：⚠️ **未执行**。项目 `node_modules` 未安装，本机无 typescript。
  已用 Node 逐个 import 验证 7 个模块可正常加载（能捕获悬空 import 与语法
  错误，但**不能**发现类型错误）。**接入 CI 前必须补 `tsc --noEmit`。**
- **已知实现偏离**：见 README「已知偏差」表与本文 7.2 / 7.3。

---

## 附录 A：快速参考 —— 组装一次 4K 窗口的 prompt

```ts
import { parseCard, buildPrompt, scanWorldInfo, estimateTokens } from './character-card';

// 1. 解析（自动识别 PNG / JSON）
const char = parseCard(fileBytes);
if (char.warnings.length) console.warn('卡解析告警:', char.warnings);

// 2. 世界书扫描（单独调用便于调试）
const wi = scanWorldInfo({
  book: char.characterBook,
  messages: chat.messages,
  maxContext: 4096,
  worldInfoBudgetPercent: 20,
  budgetCap: 800,
  countTokens: estimateTokens,
});
console.log(`世界书: 激活 ${wi.activated.length} / 注入 ${wi.injected.length} / 丢弃 ${wi.budgetDropped.length}`);

// 3. 组装
const out = buildPrompt({
  character: char,
  worldBooks: [char.characterBook],
  history: chat.messages,
  options: {
    maxContext: 4096,
    maxTokens: 512,
    worldInfoBudgetPercent: 20,
    worldInfoBudgetCap: 800,
    maxHistoryMessages: 20,
    userName: 'User',
    countTokens: estimateTokens,
  },
});

// 4. 喂给 llama.rn
await ctx.completion({
  messages: [{ role: 'system', content: out.systemPrompt }, ...out.messages],
  temperature: 0.8, top_p: 0.95, n_predict: 512,
});
```

## 附录 B：`prompt_order` 为什么是数组

因为它是用户在 ST 的「提示词管理器」里**可拖拽重排 + 逐项开关**的配置。
硬编码成模板字符串会丢掉：自定义顺序、`enhanceDefinitions` 的开关、
persona 变体（`character_id 100001` 把 `personaDescription` 插在
`charDescription` 之前）。手机端可以不开放 UI，但**数据结构和组装算法
必须保留这个可配置性**，否则后续想加「用户自定义顺序」就要重写。
