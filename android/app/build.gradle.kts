import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

if (file("google-services.json").exists()) apply(plugin = "com.google.gms.google-services")

val releaseRequested = gradle.startParameter.taskNames.any { requested ->
    val taskName = requested.substringAfterLast(':').lowercase()
    taskName.contains("release") || taskName in setOf("assemble", "build", "bundle")
}
val signingPropertiesFile = rootProject.file("keystore.properties")
val signingProperties = signingPropertiesFile.takeIf { it.exists() }?.let { file ->
    Properties().apply { file.inputStream().use(::load) }
}
val signingStorePassword = System.getenv("AGENT_POCKET_STORE_PASSWORD")
val signingKeyPassword = System.getenv("AGENT_POCKET_KEY_PASSWORD")
if (releaseRequested && (signingProperties == null || signingStorePassword.isNullOrEmpty() || signingKeyPassword.isNullOrEmpty())) {
    throw GradleException("Release signing is required. Run android/scripts/build-release.ps1.")
}

android {
    namespace = "com.agentpocket.app"
    compileSdk = 36
    testBuildType = "release"

    defaultConfig {
        applicationId = "com.agentpocket.app"
        minSdk = 26
        targetSdk = 36
        testInstrumentationRunner = "com.agentpocket.app.data.ReleaseNativeCryptoInstrumentation"
        versionCode = 23
        versionName = "0.2.10"
        buildConfigField(
            "String",
            "UPDATE_API_URL",
            "\"https://api.github.com/repos/gongzhang9396-ui/agent-pocket/releases/latest\"",
        )
    }

    if (signingProperties != null && !signingStorePassword.isNullOrEmpty() && !signingKeyPassword.isNullOrEmpty()) {
        signingConfigs {
            create("release") {
                storeFile = file(signingProperties.getProperty("storeFile"))
                storePassword = signingStorePassword
                keyAlias = signingProperties.getProperty("keyAlias")
                keyPassword = signingKeyPassword
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            testProguardFiles("proguard-test-rules.pro")
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources {
            excludes += "META-INF/{AL2.0,LGPL2.1}"
        }
    }

    sourceSets.getByName("androidTest").assets.srcDir("../../protocol")
}

dependencies {
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.fragment:fragment-ktx:1.8.9")
    implementation("androidx.tracing:tracing:1.2.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.lifecycle:lifecycle-process:2.8.7")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
    implementation("com.goterl:lazysodium-android:5.2.0") {
        exclude(group = "net.java.dev.jna", module = "jna")
    }
    implementation("net.java.dev.jna:jna:5.17.0@aar")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.camera:camera-camera2:1.4.2")
    implementation("androidx.camera:camera-lifecycle:1.4.2")
    implementation("androidx.camera:camera-view:1.4.2")
    implementation("com.google.mlkit:barcode-scanning:17.3.0")
    implementation(platform("com.google.firebase:firebase-bom:34.18.0"))
    implementation("com.google.firebase:firebase-messaging")

    implementation(platform("androidx.compose:compose-bom:2025.08.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")

    debugImplementation("androidx.compose.ui:ui-tooling")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}
