# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile
# duopulse-083: Kotlin-хелпер OTA-установки (MobileUpdateHelper.install)
# зовётся из Rust по имени через JNI — ссылок в Java/Kotlin-коде нет, без
# keep R8 переименует/удалит класс (грабля novagrid-063)
-keep class dev.duopulse.mobile.MobileUpdateHelper { *; }
# duopulse-102: тот же JNI-вызов у внешнего открытия ссылок (MobileOpenHelper.open).
# Правило proguard-wry.pro «dev.duopulse.mobile.* → native <methods>» держит имя
# класса, но НЕ его методы: R8 (release, optimization.enable=true) выпилил open(),
# и каждый ввод omnibox без YouTube-видео падал «helper: Java exception was thrown»
# (репродьюс живьём на release 0.1.14; смоук duopulse-085 гонял debug — без R8)
-keep class dev.duopulse.mobile.MobileOpenHelper { *; }
# duopulse-112: JNI-хелперы аккаунта Aila — Keystore-секреты (синоним DPAPI
# десктопа: ключ синка/токен) и системный буфер обмена для паролей.
# Та же грабля, что 083/102: без Java-ссылок R8 вырезает методы.
-keep class dev.duopulse.mobile.MobileKeystoreHelper { *; }
-keep class dev.duopulse.mobile.MobileClipboardHelper { *; }
# duopulse-121: JNI-хелпер загрузки музыки (MobileDownloadHelper.saveMusic) —
# та же грабля, что 083/102: без Java-ссылок R8 вырезает метод в release.
-keep class dev.duopulse.mobile.MobileDownloadHelper { *; }
# duopulse-119: JNI-хелпер приёма PDF из «Открыть с помощью»
# (MobilePdfHelper.take) — та же грабля, что 083/102/121: без Java-ссылок
# R8 вырезает метод в release.
-keep class dev.duopulse.mobile.MobilePdfHelper { *; }
