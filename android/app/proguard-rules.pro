# Libraries used by Agent Pocket ship their own consumer rules.
-dontwarn org.codehaus.mojo.animal_sniffer.**

# JNA and Lazysodium bind Java symbols to native names at runtime.
-keep class com.sun.jna.** { *; }
-keep class com.goterl.lazysodium.** { *; }
-keep class kotlin.jvm.internal.Intrinsics { *; }
-keep class androidx.tracing.** { *; }
-dontwarn java.awt.Component
-dontwarn java.awt.GraphicsEnvironment
-dontwarn java.awt.HeadlessException
-dontwarn java.awt.Window
