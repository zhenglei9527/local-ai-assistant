package com.phonellm.app

import android.app.ActivityManager
import android.content.Context
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableMap
import java.io.File

/**
 * Device introspection for the JS layer.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * React Native exposes no API for physical memory, and the two obvious
 * candidates are both wrong for this use case:
 *
 *   - `Runtime.getRuntime().maxMemory()` returns the **Java heap cap**
 *     (dalvik.vm.heapsize), typically 128–512 MB. llama.cpp weights are native
 *     allocations and are not charged to that heap. Gating model loads on this
 *     number would reject every model above ~200 MB — which is all of them.
 *   - `ActivityManager.getMemoryClass()` is the same figure.
 *
 * The APIs that actually answer the question are on `ActivityManager.MemoryInfo`:
 *   - `totalMem`   — physical RAM
 *   - `availMem`   — *reclaimable* memory, including evictable page cache.
 *                    This is the number that predicts whether a large native
 *                    allocation will succeed.
 *   - `threshold`  — the low-memory watermark
 *   - `lowMemory`  — the current pressure flag
 * plus `ActivityManager.isLowRamDevice()` for the OEM's own hardware verdict.
 *
 * Also exposes `getFilesDir()`. The absolute path differs per install and per
 * user (`/data/user/0/...` vs `/data/data/...` on older layouts and some OEM
 * ROMs), so it must be asked for, never hardcoded.
 *
 * TURBOMODULE WIRING
 * -------------------
 * Under the New Architecture (mandatory here — llama.rn >= 0.10 requires it and
 * `newArchEnabled=true`), this is a **Codegen TurboModule**, not a legacy
 * module:
 *
 *   - `src/specs/NativePhoneLlmSystem.ts` declares the interface.
 *   - The RN Gradle plugin runs Codegen and generates
 *     `NativePhoneLlmSystemSpec` (an abstract Java class) into
 *     `android/app/build/generated/source/codegen/java/com/phonellm/app/`
 *     at build time.
 *   - This class extends that generated spec, so the `override` methods below
 *     are checked against the TypeScript declaration **by the compiler**. A
 *     signature drift between the spec and this file is now a build error
 *     rather than a runtime "method is not a function".
 *
 * The generated class is emitted into the `com.phonellm.app` package (Codegen
 * derives it from this app's `namespace`), so no import statement is needed.
 * It is NOT in this source tree — it does not exist until Gradle runs Codegen,
 * which is why an IDE will flag it as unresolved before the first build.
 *
 * ⚠️ `@ReactMethod` annotations are deliberately ABSENT on the overrides.
 * Codegen's generated spec carries them, and the RN docs are explicit that
 * adding them on top of the override is redundant and can confuse the
 * interop layer. If this file is ever reverted to a plain (non-Codegen)
 * `ReactContextBaseJavaModule`, every `override` must be replaced by
 * `@ReactMethod fun` with the same signatures.
 *
 * ⚠️ `getName()` MUST return "PhoneLlmSystem" — it must match both the spec
 * file name (`NativePhoneLlmSystem.ts`, minus the `Native` prefix) and the
 * string passed to `TurboModuleRegistry.get(...)`. All three are coupled by
 * convention only.
 *
 * ⚠️ KEEP THE CONTEXT PROPERTY BELOW. The constructor parameter of a Kotlin
 * class is NOT a property, and Codegen's generated `NativePhoneLlmSystemSpec`
 * does not expose a `reactContext` field for this app's namespace. Referring
 * to `reactContext` directly below therefore fails to compile with
 * "Unresolved reference 'reactContext'" (and cascades into bogus
 * "Unresolved reference 'canonicalFile'" / "'not' for operator '!'" errors on
 * the following lines). Capturing it into a private val is what makes the rest
 * of the file compile.
 */
class PhoneLlmSystemModule(
    private val reactContext: ReactApplicationContext,
) : NativePhoneLlmSystemSpec(reactContext) {

    override fun getName(): String = NAME

    /**
     * Reads `ActivityManager.MemoryInfo`.
     *
     * `getMemoryInfo` is called on every invocation rather than cached: the
     * whole point is to observe the *current* pressure, and a cached snapshot
     * taken at app start would be stale exactly when it matters most (right
     * before a multi-GB load).
     */
    override fun getMemoryInfo(promise: Promise) {
        try {
            val activityManager =
                reactContext.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager

            val info = ActivityManager.MemoryInfo()
            activityManager.getMemoryInfo(info)

            val result: WritableMap = Arguments.createMap().apply {
                // Doubles: these are 64-bit byte counts and JS numbers are
                // IEEE-754 doubles, exact up to 2^53. A `totalMem` of 16 GiB is
                // ~1.7e10, comfortably inside that. Passing them through an Int
                // (the tempting `putInt`) would overflow at 2 GiB and make a
                // 4 GiB device report a negative total — which the JS budget
                // arithmetic would then clamp to the floor, silently collapsing
                // every memory tier to the smallest model. This is THE bug this
                // module exists to avoid.
                putDouble("totalMem", info.totalMem.toDouble())
                putDouble("availMem", info.availMem.toDouble())
                putDouble("threshold", info.threshold.toDouble())
                putBoolean("lowMemory", info.lowMemory)
                putBoolean("lowRamDevice", activityManager.isLowRamDevice)
            }

            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("E_MEMORY_INFO", "Failed to read ActivityManager.MemoryInfo", e)
        }
    }

    /**
     * Free bytes on the volume holding app-private storage.
     *
     * Checked before a download starts. Running out of disk 80% of the way
     * into a 7 GB model is a far worse failure than refusing up front — and on
     * Android a full data partition degrades the whole system, not just us.
     *
     * `usableSpace` (not `freeSpace`) is the right field: `freeSpace` counts
     * blocks reserved for privileged processes that this app cannot use.
     */
    override fun getFreeDiskBytes(promise: Promise) {
        try {
            val filesDir = reactContext.filesDir
            val usable = filesDir.usableSpace
            promise.resolve(usable.toDouble())
        } catch (e: Exception) {
            promise.reject("E_DISK_INFO", "Failed to read filesystem space", e)
        }
    }

    /** Absolute path of app-private internal storage. */
    override fun getFilesDir(promise: Promise) {
        try {
            promise.resolve(reactContext.filesDir.absolutePath)
        } catch (e: Exception) {
            promise.reject("E_FILES_DIR", "Failed to resolve filesDir", e)
        }
    }

    override fun getCacheDir(promise: Promise) {
        try {
            promise.resolve(reactContext.cacheDir.absolutePath)
        } catch (e: Exception) {
            promise.reject("E_CACHE_DIR", "Failed to resolve cacheDir", e)
        }
    }

    /**
     * Creates a directory (and parents) under app-private storage.
     *
     * Exposed so the JS downloader can create `<modelId>/` without a
     * filesystem library. Returns false rather than throwing when the path
     * escapes `filesDir` — a traversal guard, since the argument crosses from
     * JS and the model directory is the one place an attacker-supplied path
     * could do real damage.
     */
    override fun ensureDir(relativePath: String, promise: Promise) {
        try {
            val root = reactContext.filesDir.canonicalFile
            val target = File(root, relativePath)
            val canonical = target.canonicalFile

            if (!canonical.path.startsWith(root.path + File.separator) && canonical != root) {
                promise.reject("E_PATH_ESCAPE", "Path escapes app storage: $relativePath")
                return
            }

            val created = canonical.exists() || canonical.mkdirs()
            promise.resolve(created || canonical.isDirectory)
        } catch (e: Exception) {
            promise.reject("E_MKDIR", "Failed to create directory: $relativePath", e)
        }
    }

    /**
     * Deletes a model directory recursively.
     *
     * Same traversal guard as `ensureDir`. Deletion is irreversible and the
     * argument is JS-supplied, so this is checked before any File call.
     */
    override fun deleteRecursively(relativePath: String, promise: Promise) {
        try {
            val root = reactContext.filesDir.canonicalFile
            val target = File(root, relativePath).canonicalFile

            if (!target.path.startsWith(root.path + File.separator)) {
                promise.reject("E_PATH_ESCAPE", "Path escapes app storage: $relativePath")
                return
            }
            if (target == root) {
                promise.reject("E_PATH_ESCAPE", "Refusing to delete the app storage root")
                return
            }

            val ok = target.deleteRecursively()
            promise.resolve(ok)
        } catch (e: Exception) {
            promise.reject("E_DELETE", "Failed to delete: $relativePath", e)
        }
    }

    /**
     * Lists a directory under app-private storage.
     *
     * WHY THIS EXISTS
     * ---------------
     * Download state lived only in memory, so every app restart made completed
     * models show as "未下载" (not downloaded) even though the multi-hundred-MB
     * files were sitting right there on disk — the user could not load them and
     * could not tell why. A startup scan is the fix, and a scan needs a
     * directory listing.
     *
     * Returns one entry per immediate child. `size` is -1 for directories so the
     * JS side can tell them apart without a second round trip.
     */
    override fun listDir(relativePath: String, promise: Promise) {
        try {
            val root = reactContext.filesDir.canonicalFile
            val target = File(root, relativePath).canonicalFile

            if (!target.path.startsWith(root.path + File.separator) && target != root) {
                promise.reject("E_PATH_ESCAPE", "Path escapes app storage: $relativePath")
                return
            }
            if (!target.exists()) {
                // Not an error: "the models directory does not exist yet" is the
                // normal state on a fresh install, and the caller wants an empty
                // list rather than an exception to special-case.
                promise.resolve(Arguments.createArray())
                return
            }

            val out = Arguments.createArray()
            target.listFiles()?.forEach { child ->
                val entry = Arguments.createMap().apply {
                    putString("name", child.name)
                    putString("path", child.absolutePath)
                    putBoolean("isDirectory", child.isDirectory)
                    putDouble("size", if (child.isFile) child.length().toDouble() else -1.0)
                    putDouble("modifiedAt", child.lastModified().toDouble())
                }
                out.pushMap(entry)
            }
            promise.resolve(out)
        } catch (e: Exception) {
            promise.reject("E_LIST_DIR", "Failed to list: $relativePath", e)
        }
    }

    /**
     * Byte size of a single file.
     *
     * Returns -1 when the path does not exist, rather than rejecting: the
     * downloader's integrity check treats "cannot tell" and "definitely wrong
     * size" as different outcomes, and a missing file is closer to the former
     * during a resume.
     */
    override fun getFileSize(absolutePath: String, promise: Promise) {
        try {
            val root = reactContext.filesDir.canonicalFile
            val target = File(absolutePath).canonicalFile

            if (!target.path.startsWith(root.path + File.separator)) {
                promise.reject("E_PATH_ESCAPE", "Path escapes app storage: $absolutePath")
                return
            }
            promise.resolve(if (target.isFile) target.length().toDouble() else -1.0)
        } catch (e: Exception) {
            promise.reject("E_FILE_SIZE", "Failed to stat: $absolutePath", e)
        }
    }

    /**
     * Reads a UTF-8 text file under app storage.
     *
     * WHY THIS EXISTS
     * ---------------
     * Settings had NO persistence of any kind: the cloud API key, the endpoint
     * URL, the system prompt and the sampling values were all in memory only,
     * so every restart wiped them and the user had to retype a key each time
     * ("我每次输入老费劲了").
     *
     * This is deliberately a small generic file read/write pair rather than a
     * key-value store: the app needs exactly one JSON blob, and pulling in
     * AsyncStorage for that would be a dependency (and a native build) for no
     * gain.
     *
     * Resolves to null when the file is absent — the normal first-run case,
     * which the caller must treat as "use defaults" rather than an error.
     */
    override fun readTextFile(relativePath: String, promise: Promise) {
        try {
            val root = reactContext.filesDir.canonicalFile
            val target = File(root, relativePath).canonicalFile

            if (!target.path.startsWith(root.path + File.separator)) {
                promise.reject("E_PATH_ESCAPE", "Path escapes app storage: $relativePath")
                return
            }
            if (!target.isFile) {
                promise.resolve(null)
                return
            }
            promise.resolve(target.readText(Charsets.UTF_8))
        } catch (e: Exception) {
            promise.reject("E_READ", "Failed to read: $relativePath", e)
        }
    }

    /**
     * Writes a UTF-8 text file under app storage, creating parents as needed.
     *
     * Written to a temp file and then renamed so a crash mid-write cannot leave
     * a truncated JSON document that fails to parse on the next launch — losing
     * settings is bad, but silently resetting to defaults because the file is
     * half-written is worse.
     */
    override fun writeTextFile(relativePath: String, contents: String, promise: Promise) {
        try {
            val root = reactContext.filesDir.canonicalFile
            val target = File(root, relativePath).canonicalFile

            if (!target.path.startsWith(root.path + File.separator)) {
                promise.reject("E_PATH_ESCAPE", "Path escapes app storage: $relativePath")
                return
            }
            target.parentFile?.mkdirs()

            val temp = File(target.parentFile, "${target.name}.tmp")
            temp.writeText(contents, Charsets.UTF_8)
            if (!temp.renameTo(target)) {
                // Rename can fail on some filesystems when the destination
                // exists; fall back to a direct write rather than losing the
                // update entirely.
                target.writeText(contents, Charsets.UTF_8)
                temp.delete()
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("E_WRITE", "Failed to write: $relativePath", e)
        }
    }

    companion object {
        const val NAME = "PhoneLlmSystem"
    }
}
