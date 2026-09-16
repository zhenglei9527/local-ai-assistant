# 技术架构文档 — phone-llm-app

> **状态声明（重要）**：本文档描述的骨架**从未经过真实编译验证**。编写机上没有 Android SDK、NDK，也没有 JDK（`java` 命令不存在），因此 Gradle / Kotlin / AndroidManifest 全部文件**未被任何真实工具链解析过**，TypeScript 也仅做了人工审查。所有版本号均已通过 npm registry / GitHub API 核实为「真实存在」，但**未验证它们能组成一个可构建的组合**。详见 §8。

---

## 1. 技术栈决策

### 1.1 最终推荐

**路线 A：React Native + llama.rn + background-downloader + op-sqlite**

即「照抄 OGAM 的选型」。理由见 §1.4。

### 1.2 被否决的方案

#### 方案 0：Fork OGAM 改造 —— ❌ 已否决（前情，非本次分析结论）

`off-grid-ai/OGAM`（3105★）的核心共享包 `@offgrid/models`、`@offgrid/ui`、`@offgrid/application` 等 6 个包，在 `package.json` 中通过 `file:../shared/packages/*` 引用，即**私有 monorepo 的兄弟目录**，不在任何公开仓库中。`preandroid` 钩子硬依赖这些包。

**结论**：`git clone OGAM` 后**无法编译**，Fork 路线彻底否决。本文档后续所有内容均不依赖 OGAM 的代码，只参考其**技术选型**（它用的都是公开第三方库）。

#### 方案 B：Kotlin + Jetpack Compose + llama.cpp JNI —— ❌ 本次未推荐

并非不可行，而是在**本项目当前约束下**不是最优解。弱势原因集中在第 1.3 节表格的「无 Android 经验时的推进难度」一行（决定性因素）与「长期可维护性」一行。

### 1.3 方案对比

| 维度 | A：React Native + llama.rn | B：Kotlin + Compose + llama.cpp JNI |
|---|---|---|
| **开发效率** | 高。UI 用 TSX 热重载，推理/下载/存储全有现成绑定，MVP 可集中在业务逻辑 | 中。UI 用 Compose（本身效率高），但推理需自己写 JNI 桥、自己管生命周期 |
| **安装包体积** | 较大。RN 运行时约 +8~12 MB；但 llama.rn **每个 ABI 的 native 库约 15~40 MB**，两者量级相当。只保留 arm64-v8a 后，APK 主体仍是模型以外的 native 库 | 较小。无 JS 运行时，但 llama.cpp native 库体积相同。净差距约 8~12 MB——**相对于 0.5~7 GB 的模型文件可忽略** |
| **内存占用控制** | 中。多一层 JS 引擎（Hermes）约 20~40 MB 常驻；但 llama.cpp 的 KV cache / 权重是 native 分配，**不受 Java 堆限制**，与方案 B 相同 | 中上。省下 JS 引擎，但 Compose 运行时有自己的开销。两者都是被 **KV cache 主导**，差异在 3~5% 量级 |
| **后台下载能力** | 强。`@kesha-antonov/react-native-background-downloader` 封装了 Android 前台服务 + iOS URLSession，**能扛进程死亡**，这是 7 GB 下载的硬需求 | 强。可直接用 WorkManager + OkHttp，控制力最强但全部自己写 |
| **推理性能** | 与 B **基本相同**。两者最终都是调 llama.cpp 的 C/C++ 内核，差别只在 JSI 桥的调用开销（每 token 一次 JS 回调，实测通常是单 token 耗时的零点几个百分点） | 相同。JNI 调用开销与 JSI 同量级 |
| **生态成熟度** | 高。llama.rn 1039★、MIT、**发布节奏活跃**（见 §2），已内置 GPU/NPU 加速方案 | 中。llama.cpp 官方只发 `llama-b<N>-bin-android-arm64.tar.gz` 命令行产物（见 §3），**没有可直接集成的 Android AAR / 预编译 JNI 库**，需自行编译 .so 或用第三方封装 |
| **无 Android 开发经验时能否推进** | **能**。这是决定性因素。JS/TS 可读可改，Metro 热重载让 UI 迭代以秒计；改坏 UI 不会破坏 native 层；Android Studio 只在首次构建和打包时才需要 | **很难**。需要同时掌握：Kotlin、Compose、Gradle 变体系统、JNI/CMake、NDK 交叉编译、Android 生命周期与内存回收。任一环节出错都会卡住整个项目 |
| **长期可维护性** | 中。风险是 **llama.rn 当前版本为 0.13.0-rc.3（RC，非稳定版）**，API 可能变动。缓解：架构上把 llama.rn 隔离在单一文件内（见 §4），上游破坏性变更 = 改一个文件 | 高。直接依赖 llama.cpp 上游，无中间层，版本自主可控。代价是升级 llama.cpp 时要自己重编 .so |

### 1.4 推荐理由（一段式）

**推荐路线 A**，决定性理由是：本项目要在**没有 Android 开发经验**的前提下推进，而两条路线在**真正的硬指标上几乎无差别**——推理性能与方案 B 相同（底层同为 llama.cpp 内核，JSI 与 JNI 桥开销都可忽略），内存差异被 KV cache 主导（3~5% 量级），包体积差异约 8~12 MB 而模型文件本身是 0.5~7 GB（可忽略）；方案 B 唯一显著胜出的「长期可维护性」换来的是必须同时掌握 Kotlin、Compose、Gradle 变体系统、JNI/CMake 交叉编译与 NDK 这套知识栈，任一环节卡住都会让项目整体停滞，而 llama.rn 恰好提供了一条**已验证可行**的路（OGAM 3105★ 项目就在用同一套公开选型），其 RC 版本的 API 不稳定风险可通过「把 llama.rn 限制在 `src/inference/llamaRnEngine.ts` 一个文件内」这一架构手段对冲——上游破坏性变更只需改一处，且由于全部业务逻辑（角色卡、提示词构造、下载器、存储、UI）都写在类型安全的 TypeScript 里，**未来若真需要迁移到 Kotlin，这些逻辑是可以逐层重写的，而不是推倒重来**。

---

## 2. llama.rn 核实结果

通过 GitHub API 与 npm registry 核实（**未访问 huggingface.co**）：

| 项目 | 核实结果 |
|---|---|
| 仓库 | `mybigday/llama.rn` — "React Native binding of llama.cpp" |
| Stars / Forks / Open Issues | **1039★** / 120 / 19 |
| 许可证 | **MIT** |
| Archived | **false**（未归档） |
| 最近 push | **2026-09-15T02:16:29Z** — 活跃 |
| 创建时间 | 2023-08-02 |
| **npm 最新版本** | **`0.13.0-rc.3`**（`latest` dist-tag），发布于 **2026-09-08** |
| 最近稳定版 | `0.12.9`（2026-08-04） |
| 版本节奏 | 0.12.6 → 0.13.0-rc.3 共 8 个版本，2026-07-13 至 2026-09-08，**约每 1~2 周一个版本** |
| 包体积 | unpackedSize 40.3 MB，983 files（含各 ABI native 库） |
| peerDependencies | `react: *`, `react-native: *`（无硬版本约束） |

### Android 支持情况

- **预编译产物**：默认使用预编译库。`postinstall` 阶段从对应 GitHub Release 下载 `android/src/main/jniLibs`（及 iOS 的 `rnllama.xcframework`），**每个压缩包用 SHA-256 校验后解压**。首次安装耗时但无需自行编译。
- **从源码构建**：在 `android/gradle.properties` 设 `rnllamaBuildFromSource=true`（代价是 20~40 分钟构建 + 需要匹配的 NDK）。
- **GPU 加速（OpenCL）**：高通 **Adreno 700+** 已支持并测试。需在 manifest 加 `<uses-native-library android:name="libOpenCL.so" android:required="false" />`，并在 `initLlama` 设 `n_gpu_layers > 0`。
- **NPU 加速（Hexagon，实验性）**：高通 **SM8450+**（8 Gen 1 及更新）。需加 `libcdsprpc.so`，并传 `devices: ['HTP0']` 或 `['HTP*']`。
- **ProGuard**：必须保留 `-keep class com.rnllama.** { *; }`，否则 release 构建会剥离 JSI 绑定注册，运行时抛 `JSI bindings not installed`——**该故障在 debug 构建下不复现**。
- **架构要求**：**自 v0.10 起强制要求 React Native 新架构（New Architecture）**。这是硬约束，已反映在 `gradle.properties` 的 `newArchEnabled=true`。

### API 形态

绑定设计参考 llama.cpp 的 `server.cpp` 示例。核心是 JSI 绑定（`global.llamaInitContext` 等 50+ 个 native 函数）。

主要导出：

```ts
initLlama(params: ContextParams, onProgress?): Promise<LlamaContext>
releaseAllLlama(): Promise<void>
loadLlamaModelInfo(model): Promise<Object>
getBackendDevicesInfo(): Promise<NativeBackendDeviceInfo[]>
setContextLimit(limit): Promise<void>
```

`LlamaContext` 实例方法：`completion()`、`stopCompletion()`、`tokenize()`、`detokenize()`、`embedding()`、`rerank()`、`bench()`、`clearCache()`、`release()`、`loadSession()`/`saveSession()`、`applyLoraAdapters()`、`initMultimodal()`、并行模式 `context.parallel.*`。

**关键属性**：`context.gpu`、`context.reasonNoGPU`、`context.devices`、`context.model`、`context.systemInfo` —— 用于在运行时确认 GPU 后端**是否真的启用**（而不是假设）。

**流式输出**：`context.completion(params, callback)`，`callback` 每 token 收到 `{ token, content?, reasoning_content?, tool_calls?, accumulated_text? }`。

**采样参数**（已核实默认值）：`temperature` 默认 0.8、`top_k` 默认 40、`top_p` 默认 0.95、`min_p` 默认 0.05、`typical_p` 默认 1.0、`repeat_last_n` 默认 64、`penalty_repeat` 默认 1.0、`mirostat` 默认 0（关闭）。另支持 `xtc_probability`、`grammar`、`json_schema`、`enable_thinking`、`thinking_budget_tokens`、投机解码（`speculative`）。

**上下文参数**：`n_ctx`、`n_batch`、`n_ubatch`、`n_parallel`、`n_threads`、`cpu_mask`、`cpu_strict`、`n_gpu_layers`、`devices`、`flash_attn_type`、`cache_type_k`/`cache_type_v`（f16/f32/q8_0/q4_0/q4_1/iq4_nl/q5_0/q5_1）、`use_mmap`、`use_mlock`、`ctx_shift`、`swa_full`、`n_cpu_moe`、`no_extra_bufts`。

> ⚠️ `no_extra_bufts`（禁用权重重打包缓冲）在低内存设备上很有价值——用更慢的 prefill 换更低内存。已在类型中保留但 MVP 未启用。

---

## 3. llama.cpp 官方 Android 预编译产物核实

通过 GitHub API 核实 `ggml-org/llama.cpp` releases：

```
TAG b10985  published=2026-09-15T14:19:41Z
    ASSET llama-b10985-bin-android-arm64.tar.gz     ← Android 产物存在
```

**结论：官方确实每个 release 都发布 `llama-b<N>-bin-android-arm64.tar.gz`。**

但必须注意其性质：

- 这是**命令行可执行文件的 tar.gz**，用于在 Termux / adb shell 中跑 `llama-cli`、`llama-server`，**不是 Android 库（.aar / .so + JNI 头）**。
- **没有** `llama-b<N>-android.aar` 之类的可直接被 Kotlin 项目 `implementation` 的产物。
- 因此走方案 B 时，**必须自行用 NDK 交叉编译 llama.cpp 源码产出 `.so`，再手写 JNI 桥**；官方产物只能用于设备上的命令行验证（例如确认某个模型能在目标机型跑起来）。

这条事实显著抬高了方案 B 的启动成本——它不是「下载一个预编译库接上就行」，而是「搭一套 CMake 交叉编译 + JNI 工程」。

---

## 4. 模块划分与依赖关系

### 4.1 分层

```
┌─────────────────────────────────────────────────────┐
│  ui/          纯展示层。只读 store，不碰 native       │
│    AppNavigator.tsx, screens/, theme/                │
└───────────────────────┬─────────────────────────────┘
                        │ 只依赖 store 的 selector
┌───────────────────────▼─────────────────────────────┐
│  store/       Zustand 状态中心                        │
│    useEngineStore / useModelStore                    │
│    useChatStore  / useSettingsStore                  │
└───────┬──────────────────────────┬──────────────────┘
        │                          │
┌───────▼──────────┐   ┌───────────▼──────────────────┐
│  inference/      │   │  data/                        │
│   InferenceEngine│   │   models/catalog.ts           │
│     .ts (契约)   │   │   models/memoryProbe.ts       │
│   llamaRnEngine  │   │   download/ModelDownloader.ts │
│     .ts ★唯一★   │   │   download/Background...ts    │
│   MockInference  │   │   download/paths.ts           │
│     Engine.ts    │   │   db/schema.ts                │
└───────┬──────────┘   └───────────┬──────────────────┘
        │                          │
┌───────▼──────────────────────────▼──────────────────┐
│  character/   角色卡（与推理、存储正交）              │
│    cardParser.ts, promptBuilder.ts                   │
├─────────────────────────────────────────────────────┤
│  types/domain.ts   ★零运行时依赖★ 所有层共享的类型    │
├─────────────────────────────────────────────────────┤
│  util/        纯函数工具                              │
└─────────────────────────────────────────────────────┘
```

### 4.2 依赖规则（硬约束）

1. **`llama.rn` 只能出现在 `src/inference/llamaRnEngine.ts` 一个文件里。** 这是本架构最重要的约束。理由：它是 RC 版本（0.13.0-rc.3），且 native 模块在测试与非 Android 环境无法 import。所有上层只认 `InferenceEngine` 接口。
2. **`src/types/domain.ts` 零 import。** 不引入 `llama.rn`、`react-native` 或任何运行时模块，使 `data/`、`store/`、测试都能安全依赖。
3. **`ui/` 不直接调用 `inference/` 或 `data/`。** 一律经由 store action，保证副作用可追踪。
4. **`character/` 与 `inference/` 互不依赖。** promptBuilder 只生产消息数组，不关心谁去执行。
5. **native 模块（`PhoneLlmSystem`）只被 `data/models/memoryProbe.ts` 与 `data/download/paths.ts` 使用。**

### 4.3 为什么选 Zustand

token 级流式输出会以 20~60 Hz 频率产生状态更新。React Context 会让**每一个 consumer 都重渲染**，在聊天页就是每 token 一次全列表重绘。Zustand 的 selector 订阅允许只有真正读该字段的组件重渲染。Redux 则为了这点收益引入大量样板。

**关键的流式设计**：token 增量累加到 store 中**独立的 `streamingText` 字段**，**绝不**逐 token append 进 `messages` 数组。原因：`messages` 变化会触发 FlatList 的 data 引用变化并重新 diff，同时会与 KV prefix 记账（用于判断能否复用缓存）互相干扰。生成结束才把完整消息写入 `messages`。

---

## 5. 模型下载器设计

### 5.1 需求与对策

| 需求 | 对策 |
|---|---|
| 7 GB 下载会被切后台/锁屏/切网打断 | 用 native 下载器（前台服务），**能扛进程死亡**，不是 JS fetch |
| 断点续传 | HTTP `Range` 请求 + 磁盘保留 `.partial` 文件 + 持久化 offset |
| 多分片 GGUF | 分片**串行**下载，`partIndex` 保持为标量 |
| 进度持久化 | 每 8 MB 落一次库（不是每 tick） |
| 校验 | sha256，**每分片完成后**立即校验 |
| 失败重试 | 指数退避 + 全抖动，且**先判断是否可重试** |

### 5.2 磁盘布局

```
<filesDir>/models/<modelId>/
    <shard-1>.gguf                  ← 最终文件，已校验，可加载
    <shard-2>.gguf
    <shard-1>.gguf.partial          ← 传输中；永不交给 llama.rn
    <shard-1>.gguf.partialmeta.json ← 续传元数据
    .complete                       ← 哨兵：所有分片已校验
```

`.partial` 后缀是安全设计：**半截文件不可能被误加载**。llama.cpp 解析截断的 GGUF 会出现难以归因的崩溃，而扩展名隔离从源头排除了这类错误。

模型存放在**应用私有内部存储**（`context.getFilesDir()`），理由有三：无需任何运行时权限；其他应用无法读取或篡改（被替换的 GGUF 在 native 解析器里等于任意代码执行面，应按安全敏感目录对待）；随卸载清理，对多 GB 缓存这是正确生命周期。路径从 native 模块取得而非硬编码——绝对路径因安装和用户而异（`/data/user/0/...` vs `/data/data/...`），硬编码会在多用户设备和部分 OEM ROM 上失效。

### 5.3 关键接口定义

```ts
interface ModelDownloader {
  start(model: ModelDescriptor, opts?: {
    resume?: boolean
    events?: DownloaderEvents
  }): Promise<DownloadTaskId>

  pause(modelId: string): Promise<void>
  cancel(modelId: string): Promise<void>
  getProgress(modelId: string): Promise<DownloadProgress | null>
  listActive(): Promise<DownloadProgress[]>
  subscribe(modelId: string, events: DownloaderEvents): () => void
  verify(model: ModelDescriptor): Promise<VerificationResult[]>
  remove(modelId: string): Promise<void>
  reconcile(): Promise<ReconcileReport>
}

interface DownloaderEvents {
  onProgress?: (p: DownloadProgress) => void
  onStateChange?: (s: ModelState) => void
  onComplete?: (r: DownloadResult) => void
  onError?: (e: DownloadError) => void
}

interface DownloadProgress {
  modelId: string
  partIndex: number          // 当前分片
  partBytesWritten: number   // 当前分片已写字节
  priorPartsBytes: number    // 之前分片字节和
  totalBytes: number
  speedBps: number           // 10 秒滑动窗口
  etaSeconds: number | null
  state: ModelState
}
```

### 5.4 六条不变量（实现必须遵守）

1. **`start` 对同一 modelId 幂等** —— 重复调用返回既有任务，不起第二个。
2. **进度先持久化再上报** —— 进程被杀最多丢失最后一次落库之后的字节，绝不丢失 resume offset。
3. **分片只有 sha256 通过才算完成** —— 永不信任传输层报告的字节数。
4. **`pause` 必须保留部分文件** —— 不得删除已下载数据。
5. **`cancel` 删除部分数据。**
6. **每个模型同时只下一个分片**（串行）。

### 5.5 断点续传的安全判定

续传只有在**远端实体与当初开始下载时逐字节相同**时才安全。因此比较 validator（ETag 最佳，Last-Modified 兜底）**并且**比较总长度：

```ts
function canResume(probe, partial): { resumable: boolean; reason: string }
```

validator 变化意味着发布者重新上传了模型——此时续传会把两个不同文件的字节拼接起来，产出一个损坏的 GGUF，且**要到加载时甚至生成中途才会暴露**。宁可重下。

`Content-Range: bytes 100-999/1000` 由 `parseContentRange()` 解析，用于对齐 offset。

### 5.6 校验（sha256）

**native 实现是必需的**，因为 React Native 没有内置流式哈希。在 JS 里做意味着把 7 GB 数据搬过 bridge，不可行。真实实现是一个 native 方法：打开文件、分块 `MessageDigest.update()`、返回十六进制摘要。

> **本骨架中 `verifyFile()` 是显式声明的未实现接缝。** 当 catalog 中的 digest 是占位符（全 `0`/全 `f`）时跳过并如实报告「skipped」；否则**抛出异常**而不是返回 ok。理由：一个永远通过的校验器比没有校验器更糟——它表面上提供了保护，实际移除了用户对损坏 GGUF 的唯一防线。

### 5.7 失败重试

```ts
computeBackoffMs(attempt, policy)  // 指数退避 + 全抖动
DEFAULT_RETRY_POLICY = { maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 60_000, jitter: 0.3 }

isRetryableStatus(status)  // 408 / 429 / 5xx → 可重试
```

**分类错误时，误判为「可重试」是代价更高的错误**：它会让 App 对着一个 404 猛敲到耗尽重试预算。因此 HTTP 状态码明确分类；无状态码的网络错误（移动网络掉线，本场景最常见的失败）才归为可重试。

**checksum 失败明确不可重试**——重新拉取同样的字节只会得到同样的摘要，重试是纯带宽浪费，应直接提示用户 catalog 可能过期。

---

## 6. 推理引擎封装设计

### 6.1 契约

```ts
interface InferenceEngine {
  getStatus(): EngineStatusView
  load(req: LoadRequest, onProgress?: (pct: number) => void): Promise<LoadedModelInfo>
  unload(): Promise<void>
  isReady(): boolean
  completion(messages, params, onChunk): Promise<CompletionOutcome>
  stop(): Promise<void>
  resetContext(): Promise<void>
  setChatTemplate(t: string | null): Promise<void>
  countTokens(text: string): Promise<number>
}
```

### 6.2 模型加载 / 卸载

- **同一时刻只持有一个 context。** 载入第二个模型前必须先 `unload()`；两个常驻模型在**每一台**中端设备上都会触发 OOM kill。
- **加载前做内存预检**（见 §7）。内存不足时在**触碰 native 加载器之前**就以 `INSUFFICIENT_MEMORY` 拒绝——加载多 GB 文件失败既慢，又可能让进程处于不良状态。
- **加载进度**通过 `initLlama` 的 `onProgress` 回调上报，UI 显示为进度条（大模型加载需要数秒到数十秒）。
- **卸载**调 `context.release()`；进程退出兜底用 `releaseAllLlama()`。
- **运行时确认 GPU 是否真的启用**：读 `context.gpu` / `reasonNoGPU` / `devices`。不假设设了 `n_gpu_layers` 就一定用上 GPU——OpenCL 只在 Adreno 700+ 可用，失败会**静默回落**，必须在 UI 中如实显示。

### 6.3 上下文长度配置

请求的 `n_ctx` 必须被夹到模型的 native 上限内。策略（`suggestContextLength`）：从 `min(model.contextLength, 32768)` 出发，按 512 token 步长递减，取第一个「估算内存 × 1.3 ≤ 预算」的值。

**注意 `n_ctx` 是内存的最大杠杆**：KV cache 与它成线性关系（见 §7.2）。在 4 GB 设备上从 8192 降到 4096，通常就是「能跑」与「被 LMK 杀掉」的分界。

### 6.4 流式输出

```ts
completion(messages, params, onChunk: (chunk: StreamChunkView) => void)
```

`onChunk` 已由 llama.rn 在每次 token 回调中触发并已批量处理，**不要在其之上再加一层缓冲**。UI 侧的处理见 §4.3：增量进 `streamingText`，结束才落 `messages`。

**停止**：`stopCompletion()`。用户点「停止」到 native 真正停下的延迟通常是一个 token 的时间。

### 6.5 参数

默认值面向**角色扮演**而非事实问答（`DEFAULT_SAMPLING`）：

```ts
temperature: 0.8, topK: 40, topP: 0.95, minP: 0.05,
repeatPenalty: 1.1, repeatLastN: 256, maxTokens: 512, seed: -1
```

较高的 temperature 与生效的重复惩罚，是让一个角色**不会在几轮之后塌回助手口吻**的关键。这些值与 SillyTavern 的常规起点一致。

`DEFAULT_STOP_TOKENS` 覆盖常见 GGUF 对话格式（`</s>`、`<|im_end|>`、`<|eot_id|>`、`<|end_of_turn|>` 等）。llama.rn 在模型自带 Jinja 模板时会自动补 stop，但**大量社区 GGUF 没有模板**，而一个不会停的模型会一路生成到 token 上限。

### 6.6 内存管理

- `use_mmap: true`（默认）—— 权重走内存映射，避免一次性拷贝。
- `use_mlock: false`（默认）—— **刻意如此**。mlock 会把页钉住使 LMK 无法回收，在 Android 上这是被杀的快车道，而非性能优化。
- `n_threads = cores - 2`（`clampThreads`，上限 8）—— 用满所有核心适得其反：llama.cpp 需要大核跑 token 循环，在 big.LITTLE 上小核只会拖慢同步点，且要给 UI 线程和系统留余量。
- `cache_type_k/v: 'f16'` 为安全默认；低内存设备可降为 `q8_0`，KV cache 直接减半（有轻微质量代价）。
- `no_extra_bufts: true` 可在低内存设备上进一步降低峰值（牺牲 prefill 速度）。

### 6.7 KV cache 清理

`resetContext()`（内部调 `context.clearCache()`）**是必需的，不是可选的**：llama.rn 的 context 会跨 `completion` 调用保留状态，不清空的话新会话会继承上一个会话的 KV，模型会自信地接着别人的对话往下说。对混合架构模型（如 LFM2）尤其关键，它们的循环状态**无法部分移除，只能整体清空**。

---

## 7. 内存探测与模型推荐

### 7.1 如何取真实可用内存

> ⚠️ **`Runtime.getRuntime().maxMemory()` 不是设备内存。**
>
> 在 Android 上它返回**本进程的 Java 堆上限**，通常 128~512 MB（由 `dalvik.vm.heapsize` / `largeHeap` 决定）。它与物理 RAM 无关，而 llama.cpp 的权重分配在 **native 堆**上（完全在 Java 堆之外）。一台 4 GB 设备会愉快地报告 `maxMemory() == 268435456`（256 MB）。若用它来把关模型加载，**所有大于约 200 MB 的模型都会被拒绝**——也就是全部模型。
>
> `ActivityManager.getMemoryClass()` 是同一个数字，同样不可用。

**实际使用的信号**（`PhoneLlmSystemModule.kt` 实现）：

| 信号 | 用途 |
|---|---|
| `MemoryInfo.totalMem` | 物理 RAM。稳定、诚实。 |
| `MemoryInfo.availMem` | ***可回收*内存**，主信号。包含内核可从 page cache 驱逐的部分，因此反映大块 native 分配真正能拿到的量。 |
| `MemoryInfo.threshold` | 低内存水位线。 |
| `MemoryInfo.lowMemory` | 当前是否已处于压力状态。 |
| `isLowRamDevice()` | OEM 自己对硬件档位的判断。 |

预算计算（`readMemorySnapshot`）：

```
effectiveAvail = max(availMem, threshold)     // 防止瞬时尖峰把预算压到地板
rawBudget      = min(effectiveAvail, totalMem) × (1 - 0.20)
usableBudget   = clamp(rawBudget, 256 MiB, 8 GiB)
```

**20% 安全边际**的理由：Android 的 LMK 会把低于水位的 App 杀掉，而 KV cache 与 compute scratch 都是估算值。20% 覆盖了系统、桌面启动器和我们自身算术的误差。

> native 侧的坑：内存值必须以 **double** 返回，`putInt` 会在 2 GiB 处溢出（这也是 WritableMap 的 `putDouble` 必须用的原因）。

### 7.2 估算公式

```
权重      = GGUF 文件大小 × 1.05           （mmap 页对齐 + 未映射张量）
KV cache  = n_layer × n_ctx × n_kv_head × head_dim × (bytesK + bytesV)
compute   = 固定 256 MiB 额度              （实现相关，不做精确建模）
总计      = 三者之和
```

`bytesPerElement`：`f32`=4、`f16`/`bf16`=2、`q8_0`≈1.0625、`q5_1`=0.75、`q5_0`≈0.6875、`q4_1`=0.625、`q4_0`/`iq4_nl`≈0.5625。

compute buffer 用固定额度而非精确建模：它是实现相关且版本敏感的，而这个数字是**通行/不通行**的闸门，不是账单。

### 7.3 判定

```ts
evaluateFit(estimate, snapshot): FitVerdict
```

两档，因为估算有误差：

- `comfortable`: `total × 1.3 ≤ usableBudget` → 可自动加载。
- `fits`: `total ≤ usableBudget` → 允许，但警告用户。

不通过时给出**可操作**的提示（「把上下文从 8192 降到 4096」或「换更小的量化」），而不是只说「内存不足」。

**UI 上的位置很关键**：这个闸门放在**模型列表的每一行**，在开始多 GB 下载**之前**就显示预估峰值内存与「合适/勉强/过大」判定。让用户花 20 分钟下一个模型、然后 App 拒绝加载它，是本项目最可避免的 UX 失败。

磁盘空间单独检查（`needsDiskBytes`）——磁盘满是在写入时失败，比提前拒绝糟糕得多。

---

## 8. 数据存储方案

### 8.1 选型：`@op-engineering/op-sqlite`

理由：同步 API（避免每次查询都跨 bridge 往返）；JSI 直连 SQLite；支持 WAL；与 OGAM 选型一致（该库为公开库，与私有包无关）。核实版本 **18.2.1**（2026-09-07）。

### 8.2 表结构（`SCHEMA_VERSION = 1`）

| 表 | 用途 | 关键设计 |
|---|---|---|
| `models` | 模型元数据与本地状态 | 主键 `id`（catalog slug）；`state`、`bytes_on_disk`、`local_path`、`shard_paths`(JSON)、`last_error` |
| `downloads` | 下载进度 | 与 `models` 分离，因为进度写入频率远高于元数据；`part_index`、`part_bytes_written`、`prior_parts_bytes`、`validator`、`updated_at` |
| `characters` | 角色卡 | 整张 card 以 JSON 存储（字段结构会随 V2/V3 演进，不适合拆列）；`avatar_path`、`is_user_created` |
| `conversations` | 会话 | `sampler_override`/`context_override` 为 JSON，null 表示继承全局；冗余 `message_count`、`last_message_at` 用于列表排序，避免每行一次 COUNT |
| `messages` | 消息 | 索引 `(conversation_id, created_at)`；`swipes`(JSON) + `swipe_index` 支持重roll；`reasoning` 独立列，不混入正文 |
| `settings` | KV 配置 | 单表 key/value |

**索引**：`(conversation_id, created_at)`、`(character_id)`、`(models.state)`、`(downloads.updated_at)`。

### 8.3 为什么 messages 单独建表

把消息塞进 `conversations.messages` JSON 列看起来更简单，但会让「加载最近 50 条」变成「读出全部历史再切片」。一段长期角色扮演很容易积累数千条消息、单会话 JSON 达数 MB，每次进入会话都要全量解析。分表 + 索引让分页是 O(页大小)。

### 8.4 KV prefix 复用

`messages` 不变（用户只追加、不编辑历史）时，llama.rn 的 context 可复用已计算的 KV prefix，**这会让第二轮以后的响应快数倍**，因为只需 prefill 新增的 token。

失效条件（任一即需 `clearCache()`）：用户编辑了历史消息；切换角色卡；切换模型；切换世界书；context 溢出触发 `ctx_shift`。

---

## 9. 目录与关键文件清单

```

├── package.json                        依赖与版本（全部已核实存在）
├── tsconfig.json                       strict + @/* 路径别名
├── metro.config.js                     ★ blockList 阻止 .gguf 进入打包
├── babel.config.js
├── App.tsx                             SafeAreaProvider + AppNavigator
├── index.js                            AppRegistry 入口
├── docs/
│   ├── architecture.md                 本文档
│   └── roadmap.md                      分阶段路线图
├── android/
│   ├── build.gradle                    minSdk 26 / compileSdk 35 / NDK pin
│   ├── settings.gradle.kts             RN autolinking
│   ├── gradle.properties               newArchEnabled=true, rnllamaBuildFromSource=false
│   ├── gradle/wrapper/gradle-wrapper.properties
│   └── app/
│       ├── build.gradle                ★ abiFilters "arm64-v8a" 仅此一个 ABI
│       ├── proguard-rules.pro          ★ -keep class com.rnllama.**
│       └── src/main/
│           ├── AndroidManifest.xml     可选 native lib、无存储权限、allowBackup=false
│           ├── res/values/strings.xml
│           └── java/com/phonellm/app/
│               ├── MainApplication.kt      含 verifyNativeLibraries() 预检
│               ├── MainActivity.kt
│               ├── PhoneLlmSystemModule.kt ★ 真实 MemoryInfo 探测 + 目录操作
│               └── PhoneLlmSystemPackage.kt
└── src/
    ├── types/domain.ts                 ★零运行时依赖★ 全部领域类型
    ├── ui/
    │   ├── AppNavigator.tsx            手写 4 tab + ScreenScaffold
    │   ├── theme/index.ts              colors / spacing / typography
    │   └── screens/
    │       ├── ChatScreen.tsx          ★ 流式文本独立字段，不逐 token 入列表
    │       ├── ModelManagerScreen.tsx  ★ 内存闸门前置到列表行
    │       ├── CharacterScreen.tsx     空态声明 Phase 3 依赖
    │       └── SettingsScreen.tsx      引擎诊断区
    ├── inference/
    │   ├── InferenceEngine.ts          契约 + DEFAULT_SAMPLING/CONTEXT_CONFIG
    │   ├── llamaRnEngine.ts            ★唯一 import llama.rn 的文件★
    │   └── MockInferenceEngine.ts      完整契约的离线实现，可跑测试
    ├── data/
    │   ├── models/catalog.ts            读 data/models-official.json + 架构参数表
    │   ├── models/memoryProbe.ts       ★真实内存探测 + 估算 + 通行判定
    │   ├── download/ModelDownloader.ts 下载契约 + 纯函数（续传/退避/校验）
    │   ├── download/BackgroundModelDownloader.ts  实现
    │   ├── download/paths.ts           路径与 .partial 隔离
    │   └── db/schema.ts                SQLite 建表 + 迁移骨架
    ├── character/
    │   ├── cardParser.ts               V1/V2/V3 JSON 解析与升级
    │   └── promptBuilder.ts            SillyTavern 风格提示词构造
    └── store/index.ts                  4 个 Zustand store
```

---

## 10. 未经验证的部分（诚实清单）

**本节必须与骨架一同阅读。以下内容没有任何一项经过真实构建、类型检查或设备运行。**

### 10.1 环境限制导致的未验证

| 项目 | 状态 |
|---|---|
| Gradle 构建 | ❌ **从未运行**。本机无 JDK（`java` 命令不存在）、无 Android SDK、无 NDK。所有 `.gradle` / `.kts` 文件**未被任何工具链解析过**。 |
| Kotlin 编译 | ❌ **从未编译**。`MainApplication.kt`、`MainActivity.kt`、`PhoneLlmSystemModule.kt`、`PhoneLlmSystemPackage.kt` 全部未经编译器检查。 |
| AndroidManifest 有效性 | ❌ 未经过 `aapt` 校验。属性名、命名空间解析、`<uses-native-library>` 的 API level 门限均未验证。 |
| TypeScript 类型检查 | ⚠️ **未运行 `tsc`**。骨架编写完成后未执行类型检查（本机 node 可用，但 `node_modules` 未安装，无法解析 `llama.rn` / `react-native` 的类型）。 |
| 任何代码的实际运行 | ❌ 从未执行。无设备、无模拟器。 |

### 10.2 版本号：已核实存在，但未核实可组合

以下是**通过 npm registry / GitHub API 核实「真实存在」**的版本，但**没有验证它们能否组成一个可构建的组合**（尤其是 RN 0.83.1 与各库的 peer 约束、以及 AGP/Kotlin/NDK 的兼容矩阵）：

| 包 / 工具 | 版本 | 核实状态 |
|---|---|---|
| `llama.rn` | `0.13.0-rc.3` | ✅ npm latest，2026-09-08 发布。**是 RC，非稳定版** |
| `@kesha-antonov/react-native-background-downloader` | `^4.6.3` | ✅ npm latest，2026-09-15 发布 |
| `@op-engineering/op-sqlite` | `^18.2.1` | ✅ npm latest，2026-09-07 发布 |
| `react-native` | `0.83.1` | ✅ 存在（npm latest 为 0.87.1）。**刻意选择 0.83.1 以对齐 OGAM 选型**，非最新版 |
| `zustand` | `^5.0.15` | ✅ npm latest |
| `react` | `19.2.0` | ⚠️ **待验证**：未核实 RN 0.83.1 的 peer 要求是否精确匹配此版本 |
| `@react-native/*` (babel-preset / metro-config / typescript-config / eslint-config) | `0.83.1` | ⚠️ **待验证**：假定与 RN 同版本发布，未逐个核实存在性 |
| `react-native-safe-area-context` | `^5.6.0` | ⚠️ **待验证** |
| `typescript` | `^5.9.0` | ⚠️ **待验证** |
| `compileSdk` / `targetSdk` | `35` | ⚠️ 未经 SDK 校验；假定为 RN 0.83 的要求 |
| `buildToolsVersion` | `35.0.0` | ⚠️ 待验证 |
| `minSdkVersion` | `26` | ⚠️ 设计决策（API 26 起 `MemoryInfo.totalMem` 在各 OEM ROM 上才可靠上报；API 24/25 会**低报**，即向不安全方向说谎），未验证与 llama.rn 的 native 库 ABI 要求是否冲突 |
| `ndkVersion` | `27.1.12297006` | ⚠️ **待验证**：未核实此 NDK 是否与 llama.rn 预编译库的构建环境兼容。仅在使用 `rnllamaBuildFromSource=true` 时才关键 |
| Kotlin | `2.1.20` | ⚠️ 待验证 |
| Android Gradle Plugin | `8.7.3` | ⚠️ 待验证 |
| Gradle wrapper | — | ⚠️ 未核实与 AGP 8.7.3 的匹配版本 |

### 10.3 显式声明的未实现接缝（代码中存在，但故意不工作）

这些**不是疏漏，是有意留白**——它们会明确报错而不是假装成功：

1. **`PhoneLlmSystemPackage` 未注册进 `MainApplication`。** 因此运行时 `NativeModules.PhoneLlmSystem` 为 `undefined`，`memoryProbe.ts` 走 `FALLBACK_SNAPSHOT`（4 GB / 1.2 GB 预算的保守值）。**UI 上显示的内存数字目前是假的。** 这是刻意的：注册包但不接线，会产生「看起来在工作」的假象。
2. **`BackgroundModelDownloader.verifyFile()` 未实现 hash。** 需要 native 侧 `PhoneLlmSystem.sha256`。占位 digest 跳过并如实报告 skipped；真实 digest **抛异常**。
3. **`BackgroundModelDownloader.reconcile()` 返回空报告。** 需要 native 侧目录列举能力。返回空是诚实做法：它声称「没找到东西」，而不是声称「一切正常」。
4. **`parsePngCard()` 是抛异常的 stub。** SillyTavern 的 PNG 角色卡把 JSON 存在 `tEXt`/`iTXt` chunk 的 `chara` 键里，需要字节级 chunk 遍历 + 可能的 zlib 解压。Phase 3 实现。
5. **~~`catalog.ts` 中所有 `sha256` 都是占位符~~ —— 已解决。** catalog 已重写为消费 `data/models-official.json`（125 个模型，sha256 与字节数均为 ModelScope API 实测）。**残余问题**：分片模型的 `sha256` 在 ModelScope API 中只按仓库给一个，无法逐分片校验，`catalog.ts` 对这类模型把 digest 留空，`verifyFile()` 会跳过并如实报告「skipped — no digest available for this shard」。这在使用上可接受，但**分片模型目前没有完整校验**。
6. **~~catalog 的文件名与大小是近似值~~ —— 已解决。** 现为实测精确值（如 `Qwen3-4B-Q4_K_M.gguf` = 2,497,280,256 B）。注意 7B/14B 的分片**极不均匀**（7B = 3.719 + 0.642 GiB），代码不得假设分片等大。
7. **架构参数表是代用品。** `catalog.ts` 中 `ARCHITECTURE_BY_FAMILY` 提供的 `layerCount` / `headCountKv` / `headDim` / `contextLength` **不在 ModelScope 索引中**，是查阅公开 config 填的，**未对照真实 GGUF 元数据验证**。Phase 2 应改为调用 `loadLlamaModelInfo()` 直接读本地文件的 GGUF 元数据。`familiesMissingArchitecture()` 可列出尚无条目的家族——对这些家族，KV cache 估算退化为按参数量悲观估算（见 `memoryProbe.ts`）。
7. **模型 catalog 无运行时刷新。** 需远端 index.json，路线图列入但未实现。
8. **`MainActivity.invokeDefaultOnBackPressed()` 含一处空分支**，其意图（让 JS 的 `BackHandler` 接管返回手势）写在注释里而未实现。

### 10.4 从源码阅读得出、但未在设备上验证的技术判断

- **`llama.rn` 的 API 用法**：`llamaRnEngine.ts` 是照着 0.13.0-rc.3 **已发布的 `src/index.ts` 与 `src/types.ts`** 写的，不是猜的。但由于该版本是 **RC**，且我们**没有实际调用过任何一个方法**，运行时行为（尤其是 `devices` 传空数组 vs 省略的区别、`flash_attn_type` 的取值校验、`cache_type_k/v` 的合法值范围）**未经验证**。
- **`BackgroundModelDownloader` 的库 API 用法**：`createDownloadTask` / `completeHandler` / `errorHandler` 的导入名是照该包已发布 typings 写的，**未对照安装后的实际版本验证**。库的 `.begin()` / `.progress()` / `.done()` / `.error()` 链式 API 同理。
- **`resume` 的实际行为**：文档中「当目标文件已存在且服务器曾响应 Range 请求时库会自动续传」是**基于库的声称**，我们自己的 `canResume()` 只做安全性判定，**没有端到端验证过续传真的能接上**。
- **OpenCL / Hexagon 的具体机型支持**：Adreno 700+ / SM8450+ 来自 llama.rn README，**未在真机验证**。
- **`arm64-v8a` 单一 ABI 的取舍**：设计判断（armeabi-v7a 是 32 位、地址空间不足以跑有意义的模型；x86_64 仅模拟器、无法验证 GPU/NPU 路径）。**未验证 llama.rn 的 arm64-v8a 预编译库是否包含所有必要组件**（例如 Hexagon 相关的 `libcdsprpc` 依赖）。
- **内存估算中 256 MiB 的 compute/scratch 额度**：是经验值，**未通过实测校准**。

### 10.5 明确排除的核实项

- **未访问 huggingface.co**（本机 DNS 被污染不可达）。

### 10.6 已完成的真实验证（与本项目其他部分的区别）

与上述「未验证」不同，以下项目**经过了真实工具验证**，可以信任：

| 验证项 | 方法 | 结果 |
|---|---|---|
| JSON 合法性 | `ConvertFrom-Json` | ✅ `package.json` / `app.json` / `tsconfig.json` / `data/models-official.json` 全部通过 |
| `metro.config.js` / `babel.config.js` 语法 | `node --check` | ✅ 通过 |
| **TypeScript 解析与类型检查** | 安装 TypeScript 5.9.2，对全部 `.ts`/`.tsx` 运行 `tsc --noEmit` | ✅ **本骨架自身文件（`src/` 除 `character-card/`、`recommend/`）零错误**——详见下方 |
| `llama.rn` 版本 / 活跃度 / API | GitHub API + npm registry + 读取已发布的 `src/index.ts` 与 `src/types.ts` | ✅ 见 §2，API 用法是**照着真实源码写的，不是猜的** |
| llama.cpp Android 产物 | GitHub Releases API | ✅ 见 §3 |
| ModelScope 下载端点 Range 支持 | 真实 HTTP 请求（206 + `Content-Range` + `Accept-Ranges`） | ✅ 见 `data/README.md` |
| 125 个模型的 sha256 / 精确字节数 | ModelScope 文件列表 API 实测 | ✅ 见 `data/models-official.json` |

**TypeScript 检查的具体结果**：运行真实 `tsc` 后修复了以下**真实缺陷**（这些是本次验证的实际产出，不是假设）：

1. `BackgroundModelDownloader` 未实现接口中的 `remove()` 方法 —— 已补。
2. `store/index.ts` 从 `@/types/domain` 导入 `LoadedModelInfo`，但该类型实际定义在 `@/inference/InferenceEngine` —— 已修。
3. `character-card/buildPrompt.ts` 中 `speakerRe` 在块作用域内声明、在块外引用（`void speakerRe;`），属于重构残留 —— 已删。
4. `character-card/worldInfo.ts` 的 `SCAN_SEPARATOR` 缺 `export`，而 `index.ts` 要重新导出它 —— 已补。
5. `character-card/index.ts` 重新导出了**不存在**的 `applyRegexScripts` —— 已移除该导出并注明原因。
6. `tsconfig.json` 缺少 `allowImportingTsExtensions`，导致 `character-card/` 与 `recommend/` 中显式带 `.ts` 后缀的相对导入无法通过类型检查 —— 已添加（因 `noEmit: true` 而合法）。

**仍存在的已知失败**：`src/character-card/parseCard.test.ts` 与 `src/recommend/recommend.test.ts` 存在类型错误（前者调用签名与 `scanWorldInfo` 实际参数个数不符、引用了不存在的 `WorldInfoResult.dropped`）。这些文件由并行工作的另一 agent 产出，**不在本次任务范围内，未修复**。运行 `pnpm typecheck` 时会看到它们。这些是测试而非产品代码，但不修复会让类型检查无法通过，应在 Phase 1 一并处理。
