# 本地 AI 助手 · Local AI Assistant

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
![Platform: Android](https://img.shields.io/badge/platform-Android-blue.svg)
![React Native 0.83](https://img.shields.io/badge/React%20Native-0.83-61dafb.svg)
![llama.cpp / GGUF](https://img.shields.io/badge/inference-llama.cpp%20%2F%20GGUF-orange.svg)

> **English summary:** A fully offline, on-device LLM chat app for Android. Models run on the phone (llama.cpp / GGUF via llama.rn) — conversations never leave the device. Includes a built-in model downloader with resume support and memory-based model recommendation, character cards with world-info, long-term memory summaries, and an optional OpenAI/Anthropic-compatible cloud channel. Chinese-first UI and design docs. MIT licensed.

一个**完全离线**的 Android 大语言模型聊天应用。模型跑在手机上，对话不出设备。

内置模型下载器（含断点续传）、按设备内存自动推荐、角色卡系统，以及一个可选的云端 API 通道。

> **状态：可运行，但未上架。** 核心链路（下载 → 加载 → 对话 → 流式输出）已在真机验证；角色卡持久化、世界书、记忆总结、多版本回复、消息编辑已交付；见文末[已知限制](#已知限制)。

---

## 为什么做这个

市面上的 AI 聊天应用几乎都是云端的：你的每句话都会离开手机。本地推理能解决这个问题，但在手机上做本地推理有一堆实际的坑——内存、下载、模型格式、首字延迟。

这个项目把那些坑都记录下来，并给出可运行的实现。**设计文档比代码更值得看**（见 [`docs/`](docs/)）。

---

## 特性

| | |
|---|---|
| **完全离线** | 模型权重在设备上，推理不联网。应用只申请 `INTERNET` 权限，用途仅为下载模型 |
| **国内可下载** | 模型源使用 ModelScope（魔搭），国内直连，无需代理 |
| **断点续传** | 多 GB 下载可中断续传，前后台切换不丢进度 |
| **按内存推荐** | 读取真实设备内存，推荐能跑得动的量化档位，避免"下载 5GB 后打不开" |
| **角色扮演** | 支持导入角色卡（PNG / JSON），支持世界书（World Info） |
| **流式输出** | 逐字显示，带实时速度和字数 |
| **可选云端** | 支持 OpenAI / Anthropic 双协议，低配设备或想用大模型时可切换 |
| **中文优先** | 界面、错误提示、文档全中文 |
| **本地持久化** | 会话、角色卡与记忆总结存入 SQLite，重启 App 不丢失 |

---

## 技术栈

```
React Native 0.83.1    ← New Architecture（llama.rn 强制要求）
llama.rn 0.13.0-rc.3   ← GGUF 端侧推理
zustand 5              ← 状态管理
op-sqlite 15           ← 本地数据库
react-native-background-downloader  ← 后台下载
```

**为什么是 React Native**：`llama.rn` 把最难的 native 编译和 JNI 桥接产品化了，并附预编译的 Android 产物。自己写 Kotlin + JNI 绑定是几周的工作量。

**为什么只编译 arm64-v8a**：llama.cpp 的 native 库每个 ABI 约 15–40 MB。包里四个 ABI 会让 APK 膨胀到无法接受，而 2017 年后的 64 位 Android 设备都是 arm64。

---

## 快速开始

### 环境要求

- Node.js ≥ 20
- JDK 17+（实测 JDK 22 可用）
- Android SDK（compileSdk 35）+ NDK 27.1.12297006
- Gradle 8.13+

### 构建

```bash
npm install

cd android
./gradlew assembleStandalone -PreactNativeArchitectures=arm64-v8a
```

产物：`android/app/build/outputs/apk/standalone/本地AI助手-标准版-<版本>.apk`

> `assembleStandalone` 是本项目自定义的构建类型：**debug 签名 + 内嵌 JS bundle**。
> 普通的 `assembleDebug` 不含 JS，装到手机上会报 `Unable to load script`（它期待 Metro 在跑）。

### 测试

```bash
# 需要 Node 24（本项目用原生 TypeScript 剥离，Node 22 不支持）
npm test
```

```
291 tests · 269 pass · 0 fail · 22 skipped
```

端到端测试会连一个本地 mock LLM 服务器：

```bash
node tools/mock-llm-server.mjs --port 8788 &
npm test
```

---

## 项目结构

```
src/
├── inference/           推理引擎（本地 llama.rn + 云端 OpenAI/Anthropic）
│   ├── InferenceEngine.ts    ← 引擎契约，整个应用的接缝
│   ├── llamaRnEngine.ts      ← 唯一 import llama.rn 的文件
│   ├── tokenizer.ts          ← 统一 token 计数（真实分词优先，启发式兜底）
│   └── remote/               ← 云端实现 + SSE 解析
├── character-card/      角色卡解析、世界书、提示词组装
├── data/
│   ├── models/          模型清单、内存探测、按内存推荐
│   ├── download/        下载器（断点续传、分片、完整性校验）
│   └── settings/        设置持久化
├── store/               zustand 状态（引擎 / 模型 / 会话 / 设置）
└── ui/                  界面
```

### 架构上的两个关键决定

**1. `InferenceEngine` 是唯一的接缝。** 本地推理和云端 API 实现同一个接口，所以聊天界面、会话管理、角色卡系统**完全不需要知道**当前用的是哪个后端。加第三个后端不用改上层。

**2. 引擎同时只持有一个模型。** 两个模型同时驻留会 OOM-kill 进程。切换模型意味着先卸载旧的。

---

## 设计文档

| 文档 | 内容 |
|---|---|
| [architecture.md](docs/architecture.md) | 整体架构、模块划分、技术选型理由 |
| [character-card-design.md](docs/character-card-design.md) | 角色卡数据模型、解析算法、世界书触发、提示词组装 |
| [downloader-design.md](docs/downloader-design.md) | 断点续传、分片、完整性校验 |
| [context-budget-strategy.md](docs/context-budget-strategy.md) | 上下文窗口与 token 预算（**结论可能反直觉**） |
| [memory-recommendation-design.md](docs/memory-recommendation-design.md) | 内存模型与推荐算法 |
| [native-module.md](docs/native-module.md) | 原生模块（内存、文件、目录） |
| [device-adaptation.md](docs/device-adaptation.md) | 不同内存档位的适配策略 |
| [build-flavors.md](docs/build-flavors.md) | 商店版 / 完整版双构建 |
| [android-build-setup.md](docs/android-build-setup.md) | Android 构建环境搭建（含踩过的坑） |
| [roadmap.md](docs/roadmap.md) | 未完成的部分 |

### 几个值得一读的工程结论

- **手机跑本地模型，瓶颈是预填充时间，不是内存。** Qwen3 全系用 GQA，32K 上下文的 KV cache 只有约 1.15 GiB —— 装得下。但 16K token 的提示词在手机上要跑十几分钟。所以默认窗口是 8192，且必须缓存固定前缀。
- **`Runtime.maxMemory()` 不能用。** 它返回的是 Java 堆上限（128–512 MB），而模型权重是 native 分配，不计入该堆。用它判断"能不能跑"会让所有模型都被拒绝。正确做法是 `ActivityManager.MemoryInfo.totalMem`。
- **`manifestPlaceholders` 不会替换 `res/values/` 里的占位符。** 应用名曾经因此显示成字面量 `${appLabel}`。要在资源里改字符串，得用 `resValue`。
- **循环依赖会让界面静默不渲染。** `AppNavigator` 和各个屏幕互相 import 时，首屏会渲染成白屏且不报任何错。拆成独立模块才好。

---

## 已知限制

诚实列出没做完的部分：

- **`llama.rn` 是非稳定版**（`0.13.0-rc.3`）。已把对它的依赖限制在一个文件内，升级是单文件修改。
- **只在小米 14 Pro（骁龙 8 Gen 3 / Android 16）上验证过。** 内存探测逻辑有绝对容差处理（12GB 机型实读约 11.0–11.9 GiB），但未在多机型上校准。
- **GPU 加速默认关闭。** 骁龙 8 系支持 OpenCL，但开启后无法保存会话状态 —— 二者在 llama.rn 上互斥。
- **未在应用商店上架。** 越狱模型相关的功能若上架需拆分构建（见 build-flavors.md）。
- **未做代码签名发布**，当前产物是 debug 签名。

---

## 参与贡献

欢迎 issue 和 PR。对于较大的改动，建议先开 issue 讨论——这个项目有若干不明显的约束（上面那些"工程结论"），改错方向会白费功夫。

---

## 许可证

[MIT](LICENSE)

---

## 致谢

建立在 [`llama.rn`](https://github.com/mybigday/llama.rn) 与 [`llama.cpp`](https://github.com/ggml-org/llama.cpp) 之上。
模型来自 [ModelScope](https://modelscope.cn)。
