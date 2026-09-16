# Android Build Setup

How to build this app on this Windows machine, and the honest state of that build.

> Status at time of writing: see [§5 Build status](#5-build-status). The environment is
> installed and verified; the project had **never been compiled** before this work and
> carried several real defects, which are listed there with their fixes.

---

## 1. Installed toolchain

Everything is on **D:** (per the D-drive-first convention) except Gradle's own cache,
which lives under `~\.gradle`.

| Component | Version | Location | Notes |
|---|---|---|---|
| JDK | **Oracle OpenJDK 22** (`22+36-2370`) | `D:\MCLDownload\ext\jre-v64-220420\jdk22` | Pre-existing (bundled with Minecraft Launcher). A **full** JDK: 132 binaries, plus `jmods/` (70 modules) and `jlink.exe`, which AGP requires. |
| Android SDK | cmdline-tools **19.0** | `D:\Android\Sdk\cmdline-tools\latest` | |
| Android platform | **android-35** | `D:\Android\Sdk\platforms\android-35` | Matches `compileSdkVersion = 35`. |
| Build tools | **35.0.0** (`aapt2 2.19-11948202`) | `D:\Android\Sdk\build-tools\35.0.0` | Matches `buildToolsVersion = "35.0.0"`. |
| Platform tools | **adb 37.0.1** | `D:\Android\Sdk\platform-tools` | |
| NDK | **27.0.12077973** and **27.1.12297006** | `D:\Android\Sdk\ndk\...` | 27.1.12297006 is the project's pin; AGP additionally demanded 27.0.12077973. Both present. |
| CMake | **3.22.1** | `D:\Android\Sdk\cmake\3.22.1` | Required by `op-sqlite` and `llama.rn` native builds. |
| Gradle | **8.13** (wrapper) | `~/.gradle/wrapper/dists` | Downloaded by `gradlew`. |

### Why Gradle 8.13, not the 8.10.2 originally written in the wrapper

`android/build.gradle` pins AGP `8.7.3`, but **that pin is fictional**: React Native
0.83.1's Gradle plugin resolves **AGP 8.12.0** transitively and wins. AGP 8.12 requires
Gradle **8.13+**. On Gradle 8.10.2 the build dies during configuration with:

```
missing parameter of type InternalProblems, or no service of type InternalProblems
```

The wrapper was therefore rewritten to `gradle-8.13-bin.zip`. **Choose the Gradle version
against the AGP that actually resolves, not the one written in `build.gradle`.**

### Where downloads came from

`dl.google.com` was reachable and fast (command-line tools: 136.4 MB in 1.7s; Gradle:
130.6 MB in 6.3s), so **no mirror fallback was needed**. `mirrors.aliyun.com` and
`registry.npmmirror.com` were confirmed working and are available as fallbacks if Google
is ever blocked. Downloads are cached in `D:\Android\dl`.

---

## 2. Environment variables

Persisted at **User** scope (`[Environment]::SetEnvironmentVariable(name, value, 'User')`):

| Variable | Value |
|---|---|
| `JAVA_HOME` | `D:\MCLDownload\ext\jre-v64-220420\jdk22` |
| `ANDROID_HOME` | `D:\Android\Sdk` |
| `ANDROID_SDK_ROOT` | `D:\Android\Sdk` |
| `HTTP_PROXY` | *(deleted — see below)* |
| `HTTPS_PROXY` | *(deleted — see below)* |

### ⚠️ The empty-proxy trap — read this first

The machine has a proxy configured at `127.0.0.1:7897` that is **turned off**. This left
`HTTP_PROXY` and `HTTPS_PROXY` present-but-**empty**. Java's URL parser rejects an empty
string, so **every Java-based Android SDK tool fails**, with a message that points nowhere
near the cause:

```
Error: The proxy server URL extracted from HTTP_PROXY or HTTPS_PROXY environment
variable could not be parsed ... java.net.MalformedURLException: no protocol:
```

`sdkmanager` reports this as `Java version 17 or higher is required.` — a **lie**, since
the JDK is fine. (`SKIP_JDK_VERSION_CHECK=1` reveals the real `MalformedURLException`.)

Both variables are now **deleted** at User scope. Note `Invoke-WebRequest` ignores these
variables entirely (its .NET proxy is null), so **PowerShell connectivity tests pass while
Java tools are dying** — never use a PowerShell HTTP result to conclude the Java toolchain
is healthy.

If the proxy is ever legitimately enabled, set both to a *valid* URL (`http://127.0.0.1:7897`).

### Every fresh shell needs this preamble

Each `pwsh` call is a new process. Env vars persisted at User scope are inherited, but
these builds were also run with them set explicitly:

```powershell
$env:JAVA_HOME        = "D:\MCLDownload\ext\jre-v64-220420\jdk22"
$env:ANDROID_HOME     = "D:\Android\Sdk"
$env:ANDROID_SDK_ROOT = "D:\Android\Sdk"
Remove-Item Env:\HTTP_PROXY  -ErrorAction SilentlyContinue
Remove-Item Env:\HTTPS_PROXY -ErrorAction SilentlyContinue
```

---

## 3. Build commands

```powershell
cd "android"
.\gradlew.bat assembleDebug --no-daemon --max-workers=1
```

`android/local.properties` must contain:

```properties
sdk.dir=D:\\Android\\Sdk
```

(it is present; note the escaped backslashes — `local.properties` is a Java properties file).

Output APK (when the build succeeds):
`android\app\build\outputs\apk\debug\app-debug.apk`

### Why `--max-workers=1` and bounded memory

`android/gradle.properties` sets `org.gradle.jvmargs=-Xmx4g`. On this machine that is **too
aggressive**: with the JVM plus concurrent CMake/NDK native compilation, the build was
**hard-killed** — the log ended abruptly mid-task with `exit code -1`, no error text, and
zero remaining `java` processes. Bounding it fixes this:

```powershell
$env:GRADLE_OPTS = "-Xmx2g"
.\gradlew.bat assembleDebug --no-daemon --max-workers=1
```

Consider lowering `-Xmx4g` in `gradle.properties` to `-Xmx2560m` permanently.

> **Exit-code trap:** piping Gradle through `Tee-Object` makes the *pipeline* exit 0 even
> when Gradle fails, and a background job may report `exit code: 0` for a build that died.
> Always read the real `BUILD SUCCESSFUL` / `BUILD FAILED` line, or `=== EXIT: <n> ===`.

---

## 4. Changes required to build (defects in the scaffold)

The project was authored without being compiled, so these were all found by building it.
None are toolchain problems.

| # | Defect | Fix |
|---|---|---|
| 1 | `android/build.gradle` is **Groovy** (`.gradle`) but was written with **Kotlin** syntax in three places: `import com.android.build.api.dsl.ApplicationExtension`, `Delete::class.java`, `ApplicationExtension::class.java` + `?.apply {}` | Removed the import; `Delete::class.java` → `Delete`; rewrote `subprojects {}` in Groovy using `extensions.findByName("android")`, covering **both** application and library modules (the original matched only `ApplicationExtension`, silently missing every autolinked RN module). |
| 2 | `@op-engineering/op-sqlite: ^18.2.1` **does not exist** (real max is 15.2.9) — `npm` refused to install anything | Re-pinned to `^15.2.9`. |
| 3 | `@react-native-community/cli` was absent. RNGP runs `npx @react-native-community/cli config` as its autolinking source of truth; without it, `autolinking.json` is schema-valid but empty (`"platforms": {}`, `"project": {}`), and the build fails with `Could not find project.android.packageName` | Added `@react-native-community/cli@^20.2.0` and `@react-native-community/cli-platform-android@^20.2.0` to `devDependencies`. |
| 4 | `android/app/debug.keystore` is referenced by the debug `signingConfig` but was **never committed** | Generated with `keytool` (RSA 2048, alias `androiddebugkey`, store/key password `android`, 10000 days). |
| 5 | `<uses-native-library>` (`libOpenCL.so`, `libcdsprpc.so`) declared as a direct child of `<manifest>` in the **application** module. Legal in a *library* manifest; **aapt2 rejects it in an application manifest**: `AAPT: error: unexpected element <uses-native-library> found in <manifest>` | Added `tools:node="remove"`. The element is not stripped by the manifest merger, so it genuinely reaches aapt2. No behavior lost: `android:required="false"` already meant no device filtering, and llama.rn's runtime `dlopen` path is unaffected. Only packaging metadata is forfeited. |
| 6 | The manifest references `@mipmap/ic_launcher`, `@mipmap/ic_launcher_round`, and `@style/AppTheme`, but `res/` contained **only** `values/strings.xml` | Authored `values/styles.xml` (`AppTheme` → `Theme.AppCompat.DayNight.NoActionBar`), `values/colors.xml`, adaptive icons `mipmap-anydpi-v26/ic_launcher.xml` + `ic_launcher_round.xml`, and `drawable/ic_launcher_foreground.xml`. Adaptive-only is correct because `minSdkVersion 26` is exactly the API level that introduced adaptive icons. |

Per-item detail and the reasoning behind each choice is in the git history for these files.

### Benign warnings — do not chase these

- `Setting the namespace via the package attribute in the source AndroidManifest.xml is no
  longer supported, and the value is ignored` — emitted for every native module.
- `uses-native-library was tagged ... to remove other declarations but no other declaration present`
- `Warning: android:extractNativeLibs should not be specified in this source AndroidManifest.xml file`
- `🚫 Hexagon SDK not found — building CPU-only` — expected; Hexagon NPU support is off
  (`phonellm.enableHexagonNpu=false`).
- `Hard link from '...' to '...' failed. Doing a slower copy instead.` — cross-volume
  (C: cache → D: project) hard-link failure; cosmetic, falls back to copy.

---

## 5. Build status

**No APK has been produced.** The build has never reached packaging. Nothing in this
document should be read as a successful build.

### How far it gets

Verified-reached, in order (all green and Gradle-cached):

- Gradle configuration against AGP 8.12.0 / Gradle 8.13 — **succeeds**
- React Native Gradle plugin compilation (`:gradle-plugin:*`) — **succeeds**
- Autolinking: `:app:generateAutolinkingPackageList`, `:app:generateAutolinkingNewArchitectureFiles`
  — **succeeds**, resolving all four native modules (`llama.rn`, `@op-engineering/op-sqlite`,
  `@kesha-antonov/react-native-background-downloader`, `react-native-safe-area-context`)
- Codegen schema + artifacts for the app and all four modules — **succeeds**
- `:app:generateReactNativeEntryPoint`, `:app:syncRNLlamaHtpAssets` — **succeeds**
- Per-module `preBuild` / manifests / resource compilation for all four modules — **succeeds**
- Native CMake builds: `:llama.rn:buildCMakeDebug[arm64-v8a]`,
  `:op-engineering_op-sqlite:buildCMakeDebug[arm64-v8a|armeabi-v7a|x86|x86_64]` — **compile**
- `:app:processDebugResources` — **BUILD SUCCESSFUL**

So: Gradle configures, the RN toolchain runs end to end, Kotlin/Java **and** native C/C++
sources compile, and Android resources link. The unresolved tail is native-library
packaging and final APK assembly.

### Known remaining risk — the most likely next failure

`llama.rn`'s prebuilt native libraries are **not present**:

```
node_modules\llama.rn\android\src\main\jniLibs   ->  MISSING
```

`android/build.gradle`'s own comment calls a missing `jniLibs` directory *"the #1
`UnsatisfiedLinkError at runtime` cause for this dependency"*. The package's `postinstall`
downloader did not populate it. The module ships `CMakeLists.txt` and `RNLlamaJSI.cpp`, and
`:llama.rn:buildCMakeDebug[arm64-v8a]` compiles — but the prebuilt llama.cpp `.so` set is a
separate download. Either the build will fail to package `libllama.so`/`librnllama.so`, or it
will produce an **APK that builds but crashes on first inference**. This has **not** been
exercised yet and is the first thing to check on the next run.

---

## 6. Reproducing from scratch

```powershell
# 1. Env (a fresh shell is a fresh process)
$env:JAVA_HOME        = "D:\MCLDownload\ext\jre-v64-220420\jdk22"
$env:ANDROID_HOME     = "D:\Android\Sdk"
$env:ANDROID_SDK_ROOT = "D:\Android\Sdk"
Remove-Item Env:\HTTP_PROXY  -ErrorAction SilentlyContinue
Remove-Item Env:\HTTPS_PROXY -ErrorAction SilentlyContinue

# 2. SDK packages (sdkmanager fails on an empty HTTP_PROXY — see §2)
$sd = "$env:ANDROID_HOME\cmdline-tools\latest\bin\sdkmanager.bat"
& $sd --sdk_root=$env:ANDROID_HOME "platform-tools" "platforms;android-35" `
      "build-tools;35.0.0" "ndk;27.1.12297006" "ndk;27.0.12077973" "cmake;3.22.1"
& $sd --sdk_root=$env:ANDROID_HOME --licenses   # accept all

# 3. JS deps
cd "."
npm install --registry=https://registry.npmmirror.com

# 4. Build
cd android
$env:GRADLE_OPTS = "-Xmx2g"
.\gradlew.bat assembleDebug --no-daemon --max-workers=1
```

Fallback mirrors if Google is unreachable: `https://mirrors.aliyun.com/android.googlesource.com/`
(verified reachable) or `https://mirrors.cloud.tencent.com/AndroidSDK/`.
