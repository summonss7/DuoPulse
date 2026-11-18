import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Release signing (duopulse-081, схема novagrid-059): keystore и креды — в
// корне android-каркаса (src-tauri/gen/android); keystore.properties gitignored
// (секрет), сам keystore коммитится (частный репозиторий; потеря = осиротевшие
// обновления). Нет keystore.properties → APK без подписи (на телефон не встанет,
// android-build.sh предупредит).
val keystoreProperties = Properties().apply {
    val propFile = rootProject.file("keystore.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}
val releaseKeystoreFile = rootProject.file(keystoreProperties.getProperty("storeFile", "duopulse-release.keystore"))

// duopulse-168: release по умолчанию строит только aarch64 (scripts/
// android-build.sh передаёт tauri --target aarch64 → -PabiList=arm64-v8a):
// x86_64-копия whisper из universal-APK выкидывается — телефонам не нужна.
// R8-смоук на эмуляторе собирает release под x86_64 (abiList=x86_64) — тогда
// x86_64-библиотеку оставляем: без неё System.loadLibrary падает на старте.
val stripX86FromRelease = when (val abi: String? = findProperty("abiList") as? String) {
    null -> true
    else -> abi.split(',').map(String::trim).filter { it.isNotEmpty() } == listOf("arm64-v8a")
}

android {
    compileSdk = 37
    namespace = "dev.duopulse.mobile"
    // duopulse-168: тот же NDK, что берёт scripts/android-build.sh (новейший
    // в $ANDROID_HOME/ndk) — whisper.cpp externalNativeBuild и Rust-либа
    // собираются одним тулчейном; фиксация — воспроизводимость сборки.
    ndkVersion = "28.2.13676358"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "dev.duopulse.mobile"
        minSdk = 24
        targetSdk = 37
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
        // duopulse-168: локальный ASR-движок (libwhisperjni.so) — arm64-v8a
        // (телефоны) + x86_64 (эмулятор/debug); флаги — cpp/CMakeLists.txt.
        externalNativeBuild {
            cmake {
                arguments += listOf(
                    "-DGGML_OPENMP=OFF",
                    "-DWHISPER_BUILD_EXAMPLES=OFF",
                    "-DWHISPER_BUILD_SERVER=OFF",
                    "-DWHISPER_BUILD_TESTS=OFF",
                    "-DWHISPER_BUILD_COMMON=OFF",
                )
                abiFilters += listOf("arm64-v8a", "x86_64")
            }
        }
    }
    externalNativeBuild {
        cmake {
            path = file("cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            // whisper под Debug-макросами медленнее на порядок — движок в
            // debug-APK тоже собираем оптимизированным (смоуки на эмуляторе)
            externalNativeBuild {
                cmake {
                    arguments += "-DCMAKE_BUILD_TYPE=RelWithDebInfo"
                }
            }
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            // duopulse-146: DuoPulse — браузер: http-сайты (без TLS) обязаны
            // открываться и в релизе, не только debug (иначе «Webpage not
            // available, net::ERR_CLEARTEXT_NOT_PERMITTED»). Выбран полный
            // usesCleartextTraffic=true, а не networkSecurityConfig: политика
            // cleartext у Android применяется к приложению целиком — различить
            // «запрос из web-оверлея» и «запрос Core» конфиг не может (только
            // домены); Core остаётся https-only на уровне кода (aila.rs
            // DEFAULT_SERVER, updater endpoints, списки адблока — https-константы).
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            if (keystoreProperties.isNotEmpty() && releaseKeystoreFile.exists()) {
                signingConfig = signingConfigs.maybeCreate("release").apply {
                    storeFile = releaseKeystoreFile
                    storePassword = keystoreProperties.getProperty("password")
                    keyAlias = keystoreProperties.getProperty("keyAlias")
                    keyPassword = keystoreProperties.getProperty("password")
                }
            }
            optimization {
               enable = true
            }
            // см. stripX86FromRelease наверху: телефонной сборке x86_64-whisper
            // не нужна, сборке под эмулятор — обязательна
            if (stripX86FromRelease) {
                packaging {
                    jniLibs.excludes.add("**/x86_64/**")
                }
            }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))
