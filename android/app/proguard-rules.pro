# llama.rn — the JSI bridge and the native context class.
#
# Without these rules R8 strips the JSI binding registration on release builds
# and every call fails at runtime with "JSI bindings not installed", which does
# not reproduce in debug. Upstream documents exactly this rule.
-keep class com.rnllama.** { *; }
-keep class com.rnllama.RNLlamaPackage { *; }

# llama.rn's JSI installation reaches the module reflectively.
-keepclassmembers class * {
    @com.facebook.react.bridge.ReactMethod <methods>;
}
-keep class com.facebook.react.turbomodule.** { *; }

# op-sqlite: reached via JNI + reflection.
-keep class com.opesqlite.** { *; }
-keep class io.liteglue.** { *; }

# background-downloader: the service is instantiated by the framework.
-keep class com.eko.** { *; }
-keep class com.keshaantonov.** { *; }

# Our own native module (Phase 1).
-keep class com.phonellm.app.** { *; }

# Keep GGUF-relevant annotations; the native layer reads some of these.
-keepattributes *Annotation*, Signature, InnerClasses, EnclosingMethod

# Standard Android/RN noise.
-dontwarn com.facebook.react.**
-dontwarn java.nio.file.**
-dontwarn org.codehaus.mojo.**
