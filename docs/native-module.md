# Native module: `PhoneLlmSystem`

> **Status: written, wired, and structurally reviewed — but NEVER COMPILED.**
> This machine has no JDK, no Android SDK, and no NDK. No Gradle task, no
> `kotlinc`, and no codegen step has ever run against these files. Nothing here
> has been on a device. Treat every claim below as "reviewed against the docs",
> not as "verified working". See §6.

---

## 1. Why this module exists

React Native exposes no API for physical RAM, and the two obvious native
candidates are both wrong for this use case:

| API | Returns | Usable? |
|---|---|---|
| `Runtime.getRuntime().maxMemory()` | This process's **Java heap cap** (128–512 MB) | ❌ |
| `ActivityManager.getMemoryClass()` | The same Java-heap figure | ❌ |
| `ActivityManager.MemoryInfo.totalMem` | Physical RAM | ✅ |
| `ActivityManager.MemoryInfo.availMem` | **Reclaimable** memory (incl. evictable page cache) | ✅ |

llama.cpp weights are **native** allocations, outside the Java heap. A 4 GB
phone happily reports `maxMemory() == 268435456` (256 MB), so gating model loads
on it would reject every model above ~200 MB — i.e. all of them.

**The bug this module fixes:** with no native module,
`src/data/models/memoryProbe.ts` fell back to a hard-coded
`usableBudget = 1.2 GiB`. Every device — 4 GB or 24 GB — got the same budget,
so all memory tiers collapsed to the smallest model in the catalog and the
recommendation engine could never offer a larger one. The fallback is still
kept as a safety net, but the real path now works.

---

## 2. Method signatures

Declared in `src/specs/NativePhoneLlmSystem.ts`, implemented in
`android/app/src/main/java/com/phonellm/app/PhoneLlmSystemModule.kt`.

Every method returns a `Promise` and takes no inputs except the two path-taking
methods. All byte counts cross the bridge as **doubles** — `putInt` would
overflow at 2 GiB.

| Method | Returns |
|---|---|
| `getMemoryInfo()` | `Promise<{ totalMem: number, availMem: number, threshold: number, lowMemory: boolean, lowRamDevice: boolean }>` |
| `getFreeDiskBytes()` | `Promise<number>` — `usableSpace` of the `filesDir` volume |
| `getFilesDir()` | `Promise<string>` — absolute path, no trailing slash |
| `getCacheDir()` | `Promise<string>` — absolute path, no trailing slash |
| `ensureDir(relativePath: string)` | `Promise<boolean>` — creates parents; rejects on path escape |
| `deleteRecursively(relativePath: string)` | `Promise<boolean>` — rejects on path escape or on the storage root |

`getMemoryInfo` is called fresh on every invocation rather than cached: the point
is to observe pressure *right before* a multi-GB load, and a start-up snapshot is
stale exactly when it matters.

`getFreeDiskBytes` uses `usableSpace`, not `freeSpace` — `freeSpace` counts
blocks reserved for privileged processes that this app cannot use.

---

## 3. How it is registered

**Three names must agree exactly, or the module silently resolves to `null`:**

1. **File name** `src/specs/NativePhoneLlmSystem.ts` — Codegen strips the
   `Native` prefix to derive the module name.
2. **Kotlin** `override fun getName(): String = NAME` where
   `NAME = "PhoneLlmSystem"`.
3. **JS** `TurboModuleRegistry.get<Spec>('PhoneLlmSystem')`.

A mismatch is **not** a compile error on either side. It surfaces at runtime as
a missing module, so this coupling is asserted by
`src/specs/phoneLlmSystem.test.ts` (it reads all three files and checks they
agree).

Wiring, in order:

```
package.json                 codegenConfig { name, type: "modules",
                               jsSrcsDir: "src/specs",
                               android.javaPackageName: "com.phonellm.app" }
        ↓  (Gradle: generateCodegenArtifactsFromSchema)
NativePhoneLlmSystemSpec.java   generated abstract class, package com.phonellm.app
        ↓  (extends)
PhoneLlmSystemModule.kt         class PhoneLlmSystemModule(reactContext)
                                  : NativePhoneLlmSystemSpec(reactContext)
        ↓  (instantiated by)
PhoneLlmSystemPackage.kt        ReactPackage.createNativeModules()
        ↓  (registered in)
MainApplication.kt              getPackages() → add(PhoneLlmSystemPackage())
```

`MainApplication.getPackages()` now casts to `ArrayList<ReactPackage>` before
`.add(...)`, which is the standard RN 0.83 template pattern.

> The generated `NativePhoneLlmSystemSpec.java` **does not exist in this source
> tree** — Codegen emits it into
> `android/app/build/generated/source/codegen/java/com/phonellm/app/` at build
> time. An IDE will flag it as unresolved before the first build. That is
> expected, not a defect.

The `@ReactMethod` annotations were **removed** from the Kotlin overrides while
converting to the Codegen path: the generated spec already carries them, and the
docs state that re-adding them on an override is redundant. If this file is ever
reverted to a plain `ReactContextBaseJavaModule`, every `override fun` must go
back to `@ReactMethod fun` with the same signatures.

### The non-throwing accessor

`src/specs/phoneLlmSystem.ts` wraps the module in `TurboModuleRegistry.get`
(**not** `getEnforcing`, which throws). Two reasons:

1. Every consumer has a documented fallback. `memoryProbe.ts` degrades to a
   conservative snapshot; `paths.ts` throws a specific, actionable error naming
   the module. A hard throw at import would turn both into an opaque crash.
2. The module is Android-only. On iOS and under `node:test`, there is no
   implementation, and importing must not be fatal.

It falls back to `NativeModules.PhoneLlmSystem` as a second probe, which is the
only path that still resolves if codegen is skipped. A **structural check**
guards both: a module that resolves but lacks `getMemoryInfo` is worse than no
module, because the caller would get `undefined is not a function` deep inside
the probe instead of a clean fallback.

---

## 4. Files

| Path | Role |
|---|---|
| `src/specs/NativePhoneLlmSystem.ts` | **New.** Codegen spec. |
| `src/specs/phoneLlmSystem.ts` | **New.** Typed accessor, returns `null` if absent. |
| `src/specs/phoneLlmSystem.test.ts` | **New.** 5 tests on JS-only invariants. |
| `android/.../PhoneLlmSystemModule.kt` | **Modified.** Now extends the generated spec; `@ReactMethod` → `override`. |
| `android/.../PhoneLlmSystemPackage.kt` | **Modified.** Doc comment corrected (it was never "not registered yet" any more). |
| `android/.../MainApplication.kt` | **Modified.** Registers the package; adds the missing `ReactPackage` import. |
| `package.json` | **Modified.** `codegenConfig` block; `test` script extended. |
| `src/data/models/memoryProbe.ts` | **Modified.** Uses the spec; `memoryProbeAvailable` is now a function. |
| `src/data/download/paths.ts` | **Modified.** Uses the spec facade. |
| `src/ui/screens/ModelManagerScreen.tsx` | **Modified.** `memoryProbeAvailable` → `memoryProbeAvailable()`. |
| `scripts/syntax-check.mjs` | **New.** Node type-strip parse of every `src/**/*.ts`. |

---

## 5. What was actually verified

| Check | Result |
|---|---|
| `npm test` | ✅ **84 pass, 0 fail** — the 79 pre-existing tests plus 5 new ones. |
| `node scripts/syntax-check.mjs` | ✅ 35 `.ts` files parse, 0 syntax errors. |
| `package.json` JSON validity | ✅ Parsed; `codegenConfig` present at top level. |
| Structure vs. RN 0.83 docs | ✅ Spec shape, `codegenConfig` keys, and `extends NativeXSpec` pattern match the official Turbo Native Modules guide. |

Five new tests cover: the spec uses non-throwing `get`; the three-way name
coupling agrees across the spec, the Kotlin `NAME`, and the registry string; the
structural guard rejects a partial module; `memoryProbe` derives **distinct**
budgets per device size (the exact regression — all tiers used to collapse onto
the 1.2 GiB fallback); and the fallback is retained but clearly marked as a
fallback.

---

## 6. Unverified — read this before trusting anything

**Nothing here has been compiled or executed.** Specifically:

1. **No Kotlin compile.** No JDK, no Android SDK, no NDK. `kotlinc` never ran.
   Type errors, wrong import paths, and unresolvable references in the `.kt`
   files would not have been caught.
2. **Codegen never ran.** `NativePhoneLlmSystemSpec.java` has never been
   generated, so the `override` signatures have never been checked against what
   codegen actually emits. This is the single largest risk: if Codegen names a
   method differently or rejects the spec, the Kotlin will not compile.
3. **No Gradle run.** `build.gradle`, `gradle.properties`, `settings.gradle.kts`,
   and the manifest are all unparsed by any toolchain. The `codegenConfig`
   `jsSrcsDir` value (`"src/specs"`) and `javaPackageName`
   (`"com.phonellm.app"`) match the docs' *shape*, but the exact relative-path
   resolution for an app (as opposed to a library) is untested.
4. **No `tsc`.** `node_modules` is not installed, so TypeScript type checking
   never ran. The `@/` path alias and bare-specifier imports (`react-native`)
   are resolved only by Metro at bundle time — nothing here proves they resolve.
5. **No device, no emulator.** Actual `totalMem`/`availMem` values across OEM
   ROMs are unmeasured. Some vendor ROMs are known to misreport `totalMem`.
6. **`ActivityManager.isLowRamDevice`** is a standard API (added API 19), and
   `MemoryInfo.threshold` likewise, but neither has been exercised here.
7. **The `.tsx` files are not syntax-checked at all.** Node's built-in
   `stripTypeScriptTypes` has no JSX plugin enabled, so *every* `.tsx` file fails
   with `Expected '>', got 'ident'` — including files this change never touched.
   That is a tooling limitation, not a code defect. `ModelManagerScreen.tsx`'s
   single edited call site was verified by regex instead.
8. **`nativeModules` interop fallback is unproven.** The second registry probe in
   `phoneLlmSystem.ts` is defensive; whether it is reachable under RN 0.83's
   New Architecture was not tested.

### First thing to do on a machine with a toolchain

```bash
cd android && ./gradlew generateCodegenArtifactsFromSchema
```

Then inspect the generated `NativePhoneLlmSystemSpec.java`: confirm the class
name, package, and each method signature match the Kotlin overrides. That single
step resolves risks 2 and 3 above.
