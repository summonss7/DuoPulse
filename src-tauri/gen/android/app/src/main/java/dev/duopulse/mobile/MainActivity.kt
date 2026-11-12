package dev.duopulse.mobile

import android.content.Intent
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  companion object {
    // duopulse-126: нативный web-оверлей (MobileWebHelper) добавляется в окно
    // активности — Application-контекста из JNI для этого мало, держим
    // активность и UI-webview Tauri (кнопка «▶ duo» открывает видео во
    // встроенном плеере через evaluateJavascript в нём).
    @Volatile var current: MainActivity? = null
    @Volatile var tauriWebView: WebView? = null
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    current = this
    // duopulse-119: PDF из «Открыть с помощью» (ACTION_VIEW) — холодный старт
    MobilePdfHelper.handle(this, intent)
  }

  override fun onDestroy() {
    if (current === this) {
      MobileWebHelper.destroy()
      current = null
      tauriWebView = null
    }
    super.onDestroy()
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    tauriWebView = webView
    // duopulse-122: document-start скрипт youtube-фреймов — загрузчик качает
    // медиа fetch'ем внутри youtube-документа (см. MobileDownloadHelper)
    MobileDownloadHelper.registerFetcher(webView)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    // duopulse-119: launchMode=singleTask — файл при живом приложении
    MobilePdfHelper.handle(this, intent)
  }
}
