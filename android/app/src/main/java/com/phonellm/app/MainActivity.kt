package com.phonellm.app

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

/**
 * Single-activity host. All UI is React Native.
 *
 * Note the absence of the usual `onCreate(savedInstanceState: Bundle?)` ->
 * `super.onCreate(null)` override that older RN templates carried. That hack
 * existed to work around fragment-state restoration in the pre-Fabric
 * architecture. With the New Architecture (which llama.rn requires) it is
 * unnecessary, and passing `null` here actively discards state on a
 * configuration change / process restore — the opposite of what a chat app
 * wants.
 */
class MainActivity : ReactActivity() {

    override fun getMainComponentName(): String = "phone-llm-app"

    override fun createReactActivityDelegate(): ReactActivityDelegate =
        DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

    /**
     * Back-button handling: DO NOT override this to poke at ReactNativeHost.
     *
     * An earlier revision overrode `invokeDefaultOnBackPressed()` and called
     * `reactNativeHost.reactInstanceManager` to decide what to do. Under the
     * New Architecture — which is mandatory here, since llama.rn requires it —
     * that getter is not supported and throws:
     *
     *   ReactInstanceManager.createReactContext is unsupported.
     *     at ReactNativeHost.getReactInstanceManager(ReactNativeHost.java:97)
     *     at MainActivity.invokeDefaultOnBackPressed(MainActivity.kt:36)
     *
     * The result was a crash every time the user pressed the system back
     * button, which is about the worst possible bug to ship: it looks like the
     * app "suddenly broke" and it fires on the most common gesture there is.
     *
     * No override is needed. `ReactActivity` already routes back presses
     * through the React delegate, so JS `BackHandler` listeners run first and
     * the default (finish the activity) applies only when JS declines — which
     * is exactly what the removed code was trying to express, minus the legacy
     * API call that crashes.
     */

    /**
     * Configuration changes are handled by the manifest's `configChanges`
     * list, so a rotation does not restart the activity and the loaded model
     * survives it. Do not add `android:configChanges` entries casually, and do
     * not remove them without also accepting a model reload on every rotate.
     */
}
