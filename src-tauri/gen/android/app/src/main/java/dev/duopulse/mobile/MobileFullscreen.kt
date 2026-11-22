package dev.duopulse.mobile

import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.util.Log
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
  private const val TAG = "DuoPulseFs"

  private var customView: View? = null
  private var customCallback: WebChromeClient.CustomViewCallback? = null
  private var backCallback: OnBackPressedCallback? = null
  // WebView-владелец fullscreen: у RustWebView (UI-webview Tauri) признак
  // document.fullscreenElement не сбрасывается сам при onCustomViewHidden —
  // дожимаем exitFullscreen'ом, иначе страница считает, что она всё ещё в фулскрине
  private var ownerWebView: WebView? = null

  /** ChromeClient для web-оверлея MobileWebHelper (fullscreen + консоль).
   *  onConsoleMessage — хук DPURL (duopulse-139): страница репортит URL для
   *  ловли SPA-навигаций m.youtube (Navigation API, shouldOverrideUrlLoading
   *  их не видит); null — клиент без консоли. onProgress — прогресс загрузки
   *  для полосы шапки оверлея (duopulse-145); null — не нужен. */
  fun chromeClient(
    act: MainActivity,
    owner: WebView,
    onConsoleMessage: ((String) -> Unit)? = null,
    onProgress: ((Int) -> Unit)? = null
  ): WebChromeClient =
    object : WebChromeClient() {
      override fun onShowCustomView(view: View, callback: CustomViewCallback) {
        Log.d(TAG, "custom-view: overlay 2-arg")
        show(act, owner, view, callback)
      }

      override fun onShowCustomView(
        view: View, requestedOrientation: Int, callback: CustomViewCallback
      ) {
        Log.d(TAG, "custom-view: overlay 3-arg")
        show(act, owner, view, callback)
      }

      override fun onHideCustomView() {
        hide()
      }

      override fun onConsoleMessage(consoleMessage: android.webkit.ConsoleMessage): Boolean {
        onConsoleMessage?.invoke(consoleMessage.message() ?: "")
        return false
      }

      override fun onProgressChanged(view: WebView, newProgress: Int) {
        onProgress?.invoke(newProgress)
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
        Log.d(TAG, "custom-view: tauri 2-arg")
        show(act, owner, view, callback)
      }

      override fun onShowCustomView(
        view: View, requestedOrientation: Int, callback: CustomViewCallback
      ) {
        Log.d(TAG, "custom-view: tauri 3-arg")
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
      // duopulse-217: вышли из HTML-fullscreen, а телефон ещё в ландшафте с
      // открытым видео — полный экран поворота должен вернуть спрятанные
      // панели (hide только что их показал)
      syncRotation()
    }
  }

  /** Разрушение оверлея/активности — снять fullscreen, не дожидаясь onHideCustomView. */
  fun dismiss() {
    if (customView != null) hide()
    // duopulse-217: активность уходит — её back-колбэк полного экрана тоже
    rotateBackCallback = null
  }

  /** duopulse-217: системный «назад» в полном экране поворота — свернуть
   *  видео, а не закрывать приложение (колбэк WryActivity при пустой истории
   *  WebView финиширует активность). Выход — той же дверью, что поворот в
   *  портрет: фронтенд снимет класс и вернёт панели/ориентацию. */
  private var rotateBackCallback: OnBackPressedCallback? = null

  private fun ensureRotateBack(act: MainActivity) {
    if (rotateBackCallback != null) return
    val cb = object : OnBackPressedCallback(false) {
      override fun handleOnBackPressed() {
        MainActivity.tauriWebView?.evaluateJavascript(
          "window.__duopulseRotate && window.__duopulseRotate(false)", null)
      }
    }
    act.onBackPressedDispatcher.addCallback(act, cb)
    rotateBackCallback = cb
  }

  /** duopulse-217 (жалоба «поворот телефона не разворачивает видео»):
   *  системные панели для «полного экрана поворота» — CSS-режим фронтенда
   *  (класс .m-rotate-full по ландшафту/кнопке «⛶»). То же, что у
   *  HTML-fullscreen (иммерсивный режим, экран не гаснет), но без
   *  onShowCustomView: поворот — не жест, Fullscreen API из
   *  onConfigurationChanged WebView не пускает, а кнопочный путь WebView
   *  теперь обрабатывает внутренне (мимо ChromeClient). */
  fun systemBars(act: MainActivity, hideBars: Boolean) {
    if (act.isFinishing) return
    ensureRotateBack(act)
    rotateBackCallback?.isEnabled = hideBars
    if (hideBars) {
      act.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      WindowInsetsControllerCompat(act.window, act.window.decorView).apply {
        hide(WindowInsetsCompat.Type.systemBars())
        systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      }
    } else {
      act.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      WindowInsetsControllerCompat(act.window, act.window.decorView)
        .show(WindowInsetsCompat.Type.systemBars())
    }
  }

  /** duopulse-217: кнопка «⛶» шапки в портрете — доворот экрана в ландшафт
   *  (как приложение YouTube: прежний портретный фулскрин выглядел
   *  «не сработавшим» — ландшафтное видео в чёрных полях того же размера);
   *  сворачивание возвращает ориентацию датчику. */
  fun landscapeLock(act: MainActivity, on: Boolean) {
    act.requestedOrientation =
      if (on) ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
      else ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
  }

  /** duopulse-217: синхронизировать полный экран поворота с UI-webview —
   *  зовётся из onConfigurationChanged (поворот) и show/hide/teardown
   *  web-оверлея (меняется то, что видит пользователь). Ландшафт без
   *  оверлея поверх — фронтенд разворачивает видео, прочее — прежний вид. */
  fun syncRotation() {
    val act = MainActivity.current ?: return
    val wv = MainActivity.tauriWebView ?: return
    val landscape = act.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
    val apply = landscape && !MobileWebHelper.isOverlayShown()
    wv.evaluateJavascript("window.__duopulseRotate && window.__duopulseRotate($apply)", null)
  }
}
