package com.phonellm.app

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * Registers `PhoneLlmSystemModule` with the React host.
 *
 * With the New Architecture on, this `ReactPackage` is still the correct and
 * required registration site: it is what `MainApplication.getPackages()`
 * returns, and the TurboModule registry resolves `PhoneLlmSystem` through it.
 * (Codegen generates the *spec*; the package is what instantiates it.)
 *
 * Registered in `MainApplication.reactNativeHost`'s package list as
 * `add(PhoneLlmSystemPackage())`. Before that line existed,
 * `NativeModules.PhoneLlmSystem` was `undefined` and `memoryProbe.ts` silently
 * used its conservative 1.2 GiB fallback — which collapsed every memory tier
 * to the smallest model.
 *
 * ⚠️ `getPackages()` must return `List<ReactPackage>`, but `PackageList` yields
 * `ArrayList<ReactPackage>`; the explicit cast is what makes `.add()` type-check
 * in Kotlin. This is the standard RN 0.83 template pattern.
 */
class PhoneLlmSystemPackage : ReactPackage {

    override fun createNativeModules(
        reactContext: ReactApplicationContext,
    ): List<NativeModule> = listOf(PhoneLlmSystemModule(reactContext))

    override fun createViewManagers(
        reactContext: ReactApplicationContext,
    ): List<ViewManager<*, *>> = emptyList()
}
