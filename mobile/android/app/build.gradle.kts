import java.net.URI
import java.util.Properties
import java.io.File

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

val releaseRequested = gradle.startParameter.taskNames.any {
        val task = it.substringAfterLast(':').lowercase()
        "release" in task || task in setOf("assemble", "build", "bundle")
    }
if (releaseRequested && !providers.gradleProperty("agentPocketSourceDigest").orNull.orEmpty().matches(Regex("[a-f0-9]{64}"))) {
    throw GradleException("Use mobile/scripts/build-release.ps1 with the exact candidate source digest")
}
val legacySigningFile = providers.gradleProperty("agentPocketLegacySigningProperties").orNull?.let { File(it) }
    ?: rootProject.file("../../android/keystore.properties")
val signingProperties = if (legacySigningFile.exists()) Properties().apply { legacySigningFile.inputStream().use(::load) } else null
val signingStorePassword = System.getenv("AGENT_POCKET_STORE_PASSWORD")
val keyPasswordValue = System.getenv("AGENT_POCKET_KEY_PASSWORD")
if (releaseRequested && (signingProperties == null || signingStorePassword.isNullOrEmpty() || keyPasswordValue.isNullOrEmpty())) {
    throw GradleException("Original signing material is required; never create a replacement certificate")
}

android {
    namespace = "com.agentpocket.app"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion
    // Permit a project-specific NDK on a drive with sufficient space.
    System.getenv("AGENT_POCKET_NDK_DIR")?.takeIf { it.isNotBlank() }?.let {
        ndkPath = it
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "com.agentpocket.app"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = 26
        targetSdk = 36
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        val relay = providers.gradleProperty("agentPocketDefaultRelayUrl").orNull?.trim()?.trimEnd('/') ?: ""
        if (relay.isNotEmpty()) {
            val uri = URI(relay)
            require(uri.scheme == "https" && !uri.host.isNullOrEmpty() && uri.userInfo == null && uri.query == null && uri.fragment == null && !relay.any { it.isISOControl() })
        }
        fun literal(value: String) = "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
        buildConfigField("String", "DEFAULT_RELAY_URL", literal(relay))
        buildConfigField("String", "UPDATE_PUBLIC_KEY_SPKI", literal(providers.gradleProperty("agentPocketUpdatePublicKeySpki").orNull?.trim() ?: ""))
    }
    buildFeatures { buildConfig = true }

    if (signingProperties != null && !signingStorePassword.isNullOrEmpty() && !keyPasswordValue.isNullOrEmpty()) {
        signingConfigs.create("legacyRelease") {
            val original = File(signingProperties.getProperty("storeFile") ?: throw GradleException("Missing original keystore path"))
            storeFile = if (original.isAbsolute) original else File(File(legacySigningFile.parentFile, "app"), original.path).canonicalFile
            storePassword = signingStorePassword
            keyAlias = signingProperties.getProperty("keyAlias") ?: throw GradleException("Missing original key alias")
            keyPassword = keyPasswordValue
        }
    }

    buildTypes {
        debug { applicationIdSuffix = ".debug" }
        release {
            signingConfig = signingConfigs.findByName("legacyRelease")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
dependencies { implementation("androidx.core:core:1.17.0") }
