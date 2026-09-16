rootProject.name = "phone-llm-app"

/**
 * Plugin management: the React Native Gradle plugin and the autolinking plugin
 * are resolved from `node_modules`, not from a Maven repository.
 *
 * NOTE: this file is Kotlin DSL (`.kts`), so string literals MUST use double
 * quotes. Groovy-style single quotes ('app') are a compile error here — the
 * original skeleton had Groovy syntax in a .kts file and failed to build.
 */
pluginManagement {
    includeBuild("../node_modules/@react-native/gradle-plugin")
}

plugins {
    id("com.facebook.react.settings")
}

extensions.configure<com.facebook.react.ReactSettingsExtension> {
    autolinkLibrariesFromCommand()
}

include(":app")
includeBuild("../node_modules/@react-native/gradle-plugin")
