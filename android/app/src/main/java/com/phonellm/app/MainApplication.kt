package com.phonellm.app

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultReactHost
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.react.soloader.OpenSourceMergedSoMapping
import com.facebook.soloader.SoLoader

/**
 * Application entry point.
 *
 * Beyond template boilerplate this class has one job that matters: making sure
 * the llama.cpp native libraries are loadable before any JS asks for them, and
 * failing *loudly and early* when they are not. A missing `librnllama.so`
 * otherwise surfaces much later as an opaque `UnsatisfiedLinkError` inside a
 * model load, which reads like a corrupt GGUF and sends debugging in the wrong
 * direction for hours.
 */
class MainApplication : Application(), ReactApplication {

    override val reactNativeHost: ReactNativeHost =
        object : DefaultReactNativeHost(this) {
            override fun getPackages(): List<ReactPackage> =
                (PackageList(this).packages as ArrayList<ReactPackage>).apply {
                    // Autolinked packages (llama.rn, op-sqlite, background-downloader)
                    // are added by PackageList. Manually-registered packages go here.
                    //
                    // PhoneLlmSystem exposes ActivityManager.MemoryInfo and
                    // Context.getFilesDir() to JS. It MUST be registered: without
                    // this line `NativeModules.PhoneLlmSystem` is undefined,
                    // memoryProbe.ts falls back to its pessimistic 1.2 GiB
                    // constant, and every memory tier collapses to the smallest
                    // model in the catalog.
                    //
                    // The cast to ArrayList is required because
                    // `PackageList.packages` is typed as the Java
                    // `ArrayList<ReactPackage>` interface's supertype; Kotlin
                    // needs it to expose `add`. This matches the RN 0.83
                    // template's own generated code.
                    add(PhoneLlmSystemPackage())
                }

            override fun getJSMainModuleName(): String = "index"

            override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

            override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED

            override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED
        }

    override val reactHost: ReactHost
        get() = DefaultReactHost.getDefaultReactHost(
            applicationContext,
            reactNativeHost,
        )

    override fun onCreate() {
        super.onCreate()

        // Loads libreactnative.so and, transitively, the merged So mapping that
        // makes the llama.rn JSI symbols resolvable.
        SoLoader.init(this, OpenSourceMergedSoMapping)

        // ⚠️ DO NOT also call DefaultNewArchitectureEntryPoint.load() here.
        //
        // `loadReactNative(this)` already loads the New Architecture entry
        // point internally (it handles both arch modes and reads the same
        // BuildConfig flag). Calling load() a second time overrides the
        // feature flags twice, and React Native throws:
        //
        //   java.lang.RuntimeException: Feature flags cannot be overridden
        //   more than once
        //
        // which surfaces as "Unable to create application ...MainApplication"
        // and a hard crash on launch — a *runtime* failure despite the APK
        // building fine, which is exactly what happened on the first device
        // install. Verified on Xiaomi 14 Pro (HyperOS / Android 16).
        loadReactNative(this)

        verifyNativeLibraries()
    }

    /**
     * Pre-flight check for the inference backend.
     *
     * `System.loadLibrary` throws `UnsatisfiedLinkError` synchronously, so we
     * can turn "the APK is missing its arm64 slice" into a clear log line at
     * startup instead of a mystery at first generation.
     *
     * Deliberately non-fatal: a device that cannot load llama.rn should still
     * be able to browse the UI and import character cards, and a hard crash on
     * launch is unshippable. The engine reports the failure through
     * `EngineStatus.error` instead.
     */
    private fun verifyNativeLibraries() {
        val required = listOf("rnllama")
        val missing = required.filterNot { name ->
            try {
                System.loadLibrary(name)
                true
            } catch (e: UnsatisfiedLinkError) {
                android.util.Log.e(
                    TAG,
                    "Native library lib$name.so is unavailable. " +
                        "On-device inference will not work. " +
                        "Check that the APK contains an arm64-v8a slice and that " +
                        "llama.rn's postinstall jniLibs download succeeded.",
                    e,
                )
                false
            }
        }

        if (missing.isEmpty()) {
            android.util.Log.i(TAG, "Native inference backend loaded successfully.")
        }
    }

    private companion object {
        const val TAG = "PhoneLlmApp"
    }
}
