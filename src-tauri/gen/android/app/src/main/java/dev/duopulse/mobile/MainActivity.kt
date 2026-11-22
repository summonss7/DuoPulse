package dev.duopulse.mobile

import android.content.Intent
import android.content.res.Configuration
import android.os.Bundle
import android.webkit.JavascriptInterface
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
    // duopulse-179: видео из «Открыть с помощью» (ACTION_VIEW video/*)
    MobileVideoHelper.handle(this, intent)
  }

  override fun onDestroy() {
    if (current === this) {
      MobileFullscreen.dismiss()
      MobileWebHelper.destroy()
      // duopulse-135: wry не вызывает WebView.destroy() — при «назад»-выходе
      // WebView умирает вместе с activity, и натив Chromium при detach лочит
      // уже разрушенный мьютекс (FORTIFY abort). Гасим явно, до super/onDestroy:
      // сначала снять с дерева видов, потом destroy (паттерн из доков WebView).
      tauriWebView?.let { wv ->
        tauriWebView = null
        (wv.parent as? android.view.ViewGroup)?.removeView(wv)
        wv.stopLoading()
        wv.destroy()
      }
      current = null
    }
    super.onDestroy()
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    tauriWebView = webView
    // duopulse-134: HTML-fullscreen (кнопка «на весь экран»): сгенерированный
    // RustWebChromeClient гасит fullscreen-view; подменяем наследником с поддержкой
    webView.webChromeClient =
      MobileFullscreen.tauriChromeClient(this, (webView as RustWebView).id, webView)
    // duopulse-217: мост «полного экрана поворота» — фронтенд (класс
    // .m-rotate-full по ландшафту) дергает нативные панели/доворот экрана.
    // Регистрируем ДО загрузки страницы; методы приходят с фоновой нити
    // WebView — UI-работа в runOnUiThread у моста
    webView.addJavascriptInterface(UiBridge(), "DuopulseUi")
    // duopulse-179: автовоспроизведение <video> без жеста ВНУТРИ WebView —
    // тап «Открыть с помощью» в файловом менеджере и так жест пользователя
    webView.settings.mediaPlaybackRequiresUserGesture = false
    // duopulse-122: document-start скрипт youtube-фреймов — загрузчик качает
    // медиа fetch'ем внутри youtube-документа (см. MobileDownloadHelper)
    MobileDownloadHelper.registerFetcher(webView)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    // duopulse-217 (жалоба «переворачиваю телефон — не разворачивается»):
    // поворот в ландшафт при открытом видео — плеер на весь экран, обратно
    // в портрет — прежний вид; разворачивает фронтенд, панели гасит Kotlin
    MobileFullscreen.syncRotation()
  }

  // duopulse-217: window.DuopulseUi из UI-webview (виден и кросс-доменным
  // фреймам страницы — поверхность намеренно минимальна и безвредна: панели
  // и ориентация). videoFullscreen — CSS-fullscreen поворота, setLandscape —
  // доворот по кнопке «на весь экран» плеера
  private class UiBridge {
    @JavascriptInterface
    fun videoFullscreen(on: Boolean) {
      val act = MainActivity.current ?: return
      act.runOnUiThread { MobileFullscreen.systemBars(act, on) }
    }

    @JavascriptInterface
    fun setLandscape(on: Boolean) {
      val act = MainActivity.current ?: return
      act.runOnUiThread { MobileFullscreen.landscapeLock(act, on) }
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    // duopulse-119: launchMode=singleTask — файл при живом приложении
    MobilePdfHelper.handle(this, intent)
    // duopulse-179: видео при живом приложении — так же
    MobileVideoHelper.handle(this, intent)
  }

  // duopulse-171: SAF-пикер .conf профиля WireGuard (MobileVpnHelper) —
  // onActivityResult у TauriActivity не переопределён, requestCode свой
  @Deprecated("deprecated in AOSP; простой путь без activity-result API")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    MobileVpnHelper.onActivityResult(requestCode, resultCode, data)
  }
}
