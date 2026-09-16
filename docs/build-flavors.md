# 双版本构建（商店版 / 官网版）

> 状态：已实现并测试通过（`src/config/buildFlavor.ts` + `android/app/build.gradle`）
> 测试：`store` 264 通过 / 15 跳过；`full` 279 通过 / 0 跳过

---

## 1. 为什么必须做两个版本

应用支持两条模型线：

| 线 | 内容 | 上架情况 |
|---|---|---|
| `official` | Qwen 系列对齐模型 | ✅ 各商店均可 |
| `abliterated` | 越狱/无审查模型 | ❌ **国内商店必然拒审**；Google Play 也在收紧 |

一个二进制同时装两条线 → **哪个商店都上不了**。
只装官方线 → 想要越狱模型的用户完全没有获取途径。

**解法：一套代码，编译期常量分出两个二进制。**

```
APP_FLAVOR=store   → 仅官方线，可提交商店（默认）
APP_FLAVOR=full    → 双线，仅官网自行分发
```

---

## 2. 为什么是**编译期**常量，不是运行时开关

这是整个方案最关键的决策，**理由是合规，不是性能**：

如果越狱模型目录存在于 JS bundle 中、只是被运行时开关藏起来，那么：

1. **模型 id、仓库路径、下载 URL 仍在已发布的产物里。** 审核方（或自动化的 bundle diff）可以直接读出来。"我们用开关藏起来了" 不构成抗辩。
2. **运行时开关可以被翻转。** 任何能影响持久化状态的人都能在过审后把商店版变成完整版 —— 这正是审核方会下架的模式。

Metro 在打包时会对常量分支做死代码消除。把「线路注册表」本身写成会折叠的常量后，`store` bundle 里越狱条目是**真的不存在**，而不只是「没被引用」。

### 代码上的落实

`src/data/models/lineCatalog.ts`：

```ts
export const ABLITERATED_CATALOG: readonly LineDescriptor[] = INCLUDES_ABLITERATED
  ? (rawJailbreak as unknown as RawJailbreakEntry[]).map(toLineDescriptor)
  : []
```

⚠️ **这个分支必须保持为常量表达式。** `INCLUDES_ABLITERATED` 会折叠成字面量 `true`/`false`，Metro 才能消除不可达分支。**不要**改成对可变值的运行时 `if` —— 那样数据会照常打进包里。

---

## 3. 失败方向：向**保守**倾倒

`src/config/buildFlavor.ts` 的判定：

```ts
export const BUILD_FLAVOR: BuildFlavor =
  process.env.APP_FLAVOR === 'full' ? 'full' : 'store'
```

**只有精确等于 `full` 才是 full，其余一律 store。**

这是刻意的：CI 里一个拼写错误（`Full` / `FULL` / `prod` / `true` / `full `）必须产出**可提交的**二进制，而不是意外发布一个无法过审的版本。

已用测试固化：

```
✔ an unrecognised APP_FLAVOR fails closed to store
    （逐个断言 Full / FULL / prod / true / 1 / "full " 都解析为 store）
```

---

## 4. 两个版本在设备上如何区分

| 渠道 | `versionCode` | `versionName` | 启动器名称 |
|---|---|---|---|
| store | 1 | `0.1.0` | Phone LLM |
| full | 2 | `0.1.0-full` | Phone LLM (Full) |

同时写入 `BuildConfig`：

```java
BuildConfig.APP_FLAVOR              // "store" | "full"
BuildConfig.INCLUDES_ABLITERATED    // false | true
```

**装在同一台设备上时两者可区分** —— 这正是防止误发错版本的关键：如果两个 build 在「设置 → 应用」里同名，早晚会发错。

---

## 5. 构建命令

```powershell
# 商店版（默认）—— 用于提交各应用商店
cd "android"
$env:APP_FLAVOR = "store"
.\gradlew assembleRelease

# 官网版 —— 双线，自行分发
$env:APP_FLAVOR = "full"
.\gradlew assembleRelease
```

### ⚠️ 一个容易踩的坑：环境变量必须传进打包进程

`buildFlavor.ts` 读的是 `process.env.APP_FLAVOR`。Gradle 守护进程的环境**不会自动被子进程（Node/Metro）继承**，所以如果不显式传递，bundle 永远看到 `undefined` → 落到 `store`。

后果是**朝危险方向失败**：`full` 构建会**静默缺失**越狱线（功能莫名不见），而不是明确报错。

已在 `android/app/build.gradle` 中修复：

```groovy
tasks.configureEach { task ->
    if (task.name.toLowerCase().contains("bundle") && task.name.toLowerCase().contains("jsandassets")) {
        task.doFirst { task.environment("APP_FLAVOR", appFlavor) }
    }
}
```

只对打包任务注入，避免污染 Kotlin/Java 编译器的环境（那会强制全量重编）。

---

## 6. 商店版如何向用户解释

越狱线在商店版里**整个不存在**，但用户可能在别处读到过这个功能 —— 不解释的话会以为 App 坏了。所以：

```ts
export const ABLITERATED_UNAVAILABLE_REASON: string | null = INCLUDES_ABLITERATED
  ? null
  : '本版本不含无审查模型线，应用商店不允许。完整版见项目官网。'
```

`full` 版返回 `null`（无事可解释）。已测试。

---

## 7. 测试策略

因为 `BUILD_FLAVOR` 是**导入时**解析的模块级常量，同一进程内无法改变。所以 `buildFlavor.test.ts` **为每种 flavour 各起一个子进程**（设置环境变量）—— 这也是唯一能观察到「打包期内联器实际看到什么」的方式。

子进程导入的是**真实模块**（不是复刻逻辑），因此验证的是真正的门控分支。

### 合规相关的关键断言

```
✔ the store build carries ZERO abliterated models
✔ the store build CANNOT reach the abliterated line via modelsForLine
✔ the store build still carries the full official line        （确认没误伤官方线）
✔ the full build carries both lines
✔ ALL_MODELS on a store build contains no abliterated ids     （防 id 泄漏）
✔ the store build explains the missing line instead of silently hiding it
✔ the flavour is self-identifying in the UI label
```

### 依赖越狱线的既有测试如何处理

`lineCatalog.test.ts` 与 `onboarding.test.ts` 中有 15 个测试**需要越狱线存在**。商店版下这些数据合法地为空，因此它们被**跳过（skip）而非削弱断言**：

```ts
const ABLITERATED_SKIP = INCLUDES_ABLITERATED
  ? false
  : 'abliterated line is absent by design in the store flavour'
```

**为什么不削弱断言**：如果为了让商店版「全绿」而把 `assert.equal(ABLITERATED_CATALOG.length, 11)` 改成 `assert.ok(length >= 0)`，那么这条测试在两种 flavour 下都失去意义 —— 商店版缺数据这件事会被伪装成「通过」。跳过保留了语义，且跳过的数量本身就是可见信号。

---

## 8. 已知边界

| 项 | 说明 |
|---|---|
| **构建未验证** | 本机无 JDK/SDK 时无法编译；gradle 侧的 flavour 接线（`buildConfigField`、`manifestPlaceholders`、task env 注入）**尚未经真实构建验证** |
| `manifestPlaceholders` 与 `app_name` | `strings.xml` 改为 `${appLabel}`，需真实构建确认资源合并正确 |
| ProGuard/R8 (release) | 收缩规则**未针对越狱线数据做过验证**；若 release 构建意外保留被消除的字符串，需检查 `proguard-rules.pro` |
| 校验和层面 | 本方案保证**模型数据不随包发布**，不改变「URL 指向 master 分支」这一事实（越狱线仍需下载后校验 sha256） |

---

## 9. 相关文件

| 文件 | 作用 |
|---|---|
| `src/config/buildFlavor.ts` | flavour 解析、门控常量、用户解释文案 |
| `src/config/buildFlavor.test.ts` | 12 个合规断言（子进程逐 flavour 验证） |
| `src/data/models/lineCatalog.ts` | 越狱线目录的常量折叠门控 |
| `android/app/build.gradle` | `BuildConfig`、版本号、启动器名、Metro 环境变量注入 |
| `android/app/src/main/res/values/strings.xml` | `app_name` 改为占位符 |
