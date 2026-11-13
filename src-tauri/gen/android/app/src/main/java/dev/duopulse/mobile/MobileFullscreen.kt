package dev.duopulse.mobile

import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.GeolocationPermissions
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/*
 * HTML-fullscreen на Android (duopulse-134): кнопка «на весь экран» YouTube
 * не работала — ни в web-оверлее поиска (MobileWebHelper, у WebView вообще
 * не было WebChromeClient), ни в UI-webview Tauri (сгенерированный
 * RustWebChromeClient.onShowCustomView сразу гасит view). Здесь — общая
 * реализация: fullscreen-view добавляется в android.R.id.content поверх
 * всего хрома (оверлей-тулбар, панели), системные панели прячутся
 * (иммерсивный режим, свайпом показываются), экран не гаснет, системный
 * «назад» выходит из fullscreen. Ориентация не блокируется: вертикальные
 * видео смотрятся в портрете, горизонтальные — поворотом телефона
 * (configChanges в манифесте уже включает orientation).
 */
object MobileFullscreen {
  private var customView: View? = null
  private var customCallback: WebChromeClient.CustomViewCallback? = null
  private var backCallback: OnBackPressedCallback? = null
  // WebView-владелец fullscreen: у RustWebView (UI-webview Tauri) признак
  // document.fullscreenElement не сбрасывается сам при onCustomViewHidden —
  // дожимаем exitFullscreen'ом, иначе страница считает, что она всё ещё в фулскрине
  private var ownerWebView: WebView? = null

  /** ChromeClient для web-оверлея MobileWebHelper (ничего лишнего, только fullscreen). */
  fun chromeClient(act: MainActivity, owner: WebView): WebChromeClient =
    object : WebChromeClient() {
      override fun onShowCustomView(view: View, callback: CustomViewCallback) {
        show(act, owner, view, callback)
      }

      override fun onHideCustomView() {
        hide()
      }
    }

  /** ChromeClient для UI-webview Tauri: сгенерированный RustWebChromeClient
   *  final (наследовать нельзя, а сам файл tauri CLI перезаписывает при
   *  каждой сборке), поэтому держим его экземпляр и делегируем разрешения
   *  камеры/микрофона, геолокацию, файл-пикеры, алерты и заголовки; fullscreen — свой. */
  fun tauriChromeClient(act: MainActivity, webViewId: String, owner: WebView): WebChromeClient {
    val base = RustWebChromeClient(act, webViewId)
    return object : WebChromeClient() {
      override fun onShowCustomView(view: View, callback: CustomViewCallback) {
        show(act, owner, view, callback)
      }

      override fun onHideCustomView() {
        hide()
      }

      override fun onPermissionRequest(request: PermissionRequest) {
        base.onPermissionRequest(request)
      }

      override fun onGeolocationPermissionsShowPrompt(
        origin: String,
        callback: GeolocationPermissions.Callback
      ) {
        base.onGeolocationPermissionsShowPrompt(origin, callback)
      }

      override fun onJsAlert(
        view: WebView, url: String, message: String, result: JsResult
      ): Boolean = base.onJsAlert(view, url, message, result)

      override fun onJsConfirm(
        view: WebView, url: String, message: String, result: JsResult
      ): Boolean = base.onJsConfirm(view, url, message, result)

      override fun onJsPrompt(
        view: WebView, url: String, message: String, defaultValue: String,
        result: JsPromptResult
      ): Boolean = base.onJsPrompt(view, url, message, defaultValue, result)

      override fun onShowFileChooser(
        webView: WebView,
        filePathCallback: ValueCallback<Array<Uri?>>,
        fileChooserParams: FileChooserParams
      ): Boolean {
        @Suppress("UNCHECKED_CAST")
        val cb = filePathCallback as ValueCallback<Array<Uri?>?>
        return base.onShowFileChooser(webView, cb, fileChooserParams)
      }

      override fun onReceivedTitle(view: WebView, title: String) {
        base.onReceivedTitle(view, title)
      }

      override fun getDefaultVideoPoster(): Bitmap = base.defaultVideoPoster
    }
  }

  private fun show(
    act: MainActivity, owner: WebView, view: View, callback: WebChromeClient.CustomViewCallback
  ) {
    if (customView != null) {
      callback.onCustomViewHidden()
      return
    }
    val root = act.findViewById<FrameLayout>(android.R.id.content)
    if (root == null) {
      callback.onCustomViewHidden()
      return
    }
    customView = view
    customCallback = callback
    ownerWebView = owner
    view.setBackgroundColor(Color.BLACK)
    // edge-to-edge (duopulse-133): декор и так не делает fitsSystemWindows,
    // content без инсетов — fullscreen-view реально накрывает статус-бар
    root.addView(view, FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    act.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    WindowInsetsControllerCompat(act.window, view).apply {
      hide(WindowInsetsCompat.Type.systemBars())
      systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }
    val cb = object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        hide()
      }
    }
    act.onBackPressedDispatcher.addCallback(act, cb)
    backCallback = cb
  }

  private fun hide() {
    val act = MainActivity.current
    val view = customView ?: return
    customView = null
    (view.parent as? ViewGroup)?.removeView(view)
    val cb = customCallback
    customCallback = null
    cb?.onCustomViewHidden()
    ownerWebView = null
    backCallback?.remove()
    backCallback = null
    if (act != null && !act.isFinishing) {
      act.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      WindowInsetsControllerCompat(act.window, view)
        .show(WindowInsetsCompat.Type.systemBars())
    }
  }

  /** Разрушение оверлея/активности — снять fullscreen, не дожидаясь onHideCustomView. */
  fun dismiss() {
    if (customView != null) hide()
  }
}
