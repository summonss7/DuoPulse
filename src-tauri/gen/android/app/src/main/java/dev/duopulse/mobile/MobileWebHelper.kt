package dev.duopulse.mobile

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.view.Gravity
import android.view.View
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback

/*
 * Нативный web-оверлей (duopulse-126): поиск и обычные сайты открываются в
 * приложении, а не в Chrome. Раньше всё, что не встраивается в iframe
 * (выдача поисковиков, youtube.com без /watch), уходило Intent'ом ACTION_VIEW
 * в системный браузер. Оверлей — WebView поверх UI Tauri с мини-тулбаром:
 * назад, адрес текущей страницы, «▶ duo» (видна на страницах YouTube-видео —
 * открывает видео во встроенном плеере через evaluateJavascript в UI-webview
 * Tauri: window.__duopulseOpenVideo), закрыть. Rust-команды mobile_web_open /
 * mobile_web_close (src-tauri/src/mobile_web.rs) валидируют схему и зовут
 * один статический метод — как MobileOpenHelper; исключения гасятся здесь и
 * возвращаются строкой. Системный «назад» — история WebView, исчерпана —
 * оверлей закрывается (OnBackPressedCallback, активность жива всё время).
 */
object MobileWebHelper {
  private var overlay: FrameLayout? = null
  private var webView: WebView? = null
  private var urlText: TextView? = null
  private var duoBtn: Button? = null

  /** Системный «назад»: история WebView; исчерпана — закрыть оверлей. */
  private val backCallback = object : OnBackPressedCallback(false) {
    override fun handleOnBackPressed() {
      val wv = webView
      if (wv != null && wv.canGoBack()) wv.goBack() else close()
    }
  }

  /** videoId из ссылки YouTube (watch/shorts/live/youtu.be) или null. */
  private fun videoIdOf(url: String): String? {
    val m = Regex("""(?:watch\?v=|/shorts/|/live/|youtu\.be/)([\w-]{6,20})""")
      .find(url) ?: return null
    return m.groupValues[1]
  }

  /** Показ адреса и кнопки «▶ duo» — на каждой загрузке страницы. */
  private fun syncChrome(url: String?) {
    urlText?.text = url ?: ""
    val hasVideo = url != null && videoIdOf(url) != null
    duoBtn?.visibility = if (hasVideo) View.VISIBLE else View.GONE
  }

  @JvmStatic fun open(context: Context, url: String): String {
    val act = MainActivity.current ?: return "error: активность не готова"
    act.runOnUiThread {
      val root = act.findViewById<FrameLayout>(android.R.id.content) ?: return@runOnUiThread
      var ov = overlay
      if (ov == null) ov = build(act, root)
      syncChrome(url)
      webView?.loadUrl(url)
      ov.visibility = View.VISIBLE
      backCallback.isEnabled = true
    }
    return "opened"
  }

  @JvmStatic fun close(context: Context): String {
    val act = MainActivity.current ?: return "error: активность не готова"
    act.runOnUiThread { close() }
    return "closed"
  }

  /** Разобрать оверлей совсем (выход/закрытие): WebView destroy — память. */
  @JvmStatic fun destroy() {
    overlay?.let { ov ->
      val act = MainActivity.current
      if (act != null) act.runOnUiThread { teardown(act, ov) } else teardown(null, ov)
    }
  }

  private fun close() {
    val act = MainActivity.current ?: return
    val ov = overlay ?: return
    teardown(act, ov)
  }

  private fun teardown(act: MainActivity?, ov: FrameLayout) {
    backCallback.isEnabled = false
    backCallback.remove()
    val wv = webView
    webView = null
    urlText = null
    duoBtn = null
    // WebView.detach перед destroy (иначе окна/текстуры текут): сначала
    // снимаем оверлей с активити, потом гасим WebView
    (ov.parent as? FrameLayout)?.removeView(ov)
    ov.removeAllViews()
    wv?.apply {
      stopLoading()
      loadUrl("about:blank")
      // слушателей и куки не трогаем: системный профиль общий с iframe-плеером,
      // инкогнито чистит его при выходе (mobile_private_cleanup)
      destroy()
    }
    overlay = null
  }

  @SuppressLint("SetJavaScriptEnabled")
  private fun build(act: MainActivity, root: FrameLayout): FrameLayout {
    val dp = { v: Int -> (v * act.resources.displayMetrics.density).toInt() }
    val ov = FrameLayout(act)
    ov.setBackgroundColor(Color.WHITE)
    // edge-to-edge: иначе тулбар уходит под статус-бар и тапы по нему ест
    // системная панель (грабли duopulse-android-stage-gotchas)
    ov.fitsSystemWindows = true

    val col = LinearLayout(act)
    col.orientation = LinearLayout.VERTICAL

    // мини-тулбар в стиле DuoPulse: тёмный фон, акцент #BDFE4F (mobile.css)
    val bar = LinearLayout(act)
    bar.orientation = LinearLayout.HORIZONTAL
    bar.setBackgroundColor(Color.parseColor("#14171A"))
    bar.setPadding(dp(6), dp(6), dp(6), dp(6))

    fun toolButton(label: String, title: String): Button {
      val b = Button(act)
      b.text = label
      b.contentDescription = title
      b.setBackgroundColor(Color.TRANSPARENT)
      b.setTextColor(Color.parseColor("#BDFE4F"))
      b.setPadding(dp(10), 0, dp(10), 0)
      b.minimumWidth = 0
      b.minWidth = 0
      b.minimumHeight = 0
      b.minHeight = 0
      return b
    }

    val back = toolButton("‹", "Назад")
    back.layoutParams = LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    back.setOnClickListener {
      val wv = webView
      if (wv != null && wv.canGoBack()) wv.goBack()
    }
    bar.addView(back)

    val addr = TextView(act)
    addr.setTextColor(Color.parseColor("#DDE1E6"))
    addr.textSize = 13f
    addr.maxLines = 1
    addr.ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
    addr.gravity = Gravity.CENTER_VERTICAL
    addr.setPadding(dp(8), 0, dp(8), 0)
    addr.layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f)
    bar.addView(addr)
    urlText = addr

    val duo = toolButton("▶ duo", "Открыть во встроенном плеере")
    duo.visibility = View.GONE
    duo.layoutParams = LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    duo.setOnClickListener {
      val id = videoIdOf(webView?.url ?: "") ?: return@setOnClickListener
      close()
      // видео — во встроенный плеер мобильной ветки (tabs.open в mobile.ts)
      MainActivity.tauriWebView?.evaluateJavascript(
        "window.__duopulseOpenVideo && window.__duopulseOpenVideo('$id')", null)
    }
    bar.addView(duo)
    duoBtn = duo

    val exit = toolButton("✕", "Закрыть")
    exit.setTextColor(Color.parseColor("#DDE1E6"))
    exit.layoutParams = LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    exit.setOnClickListener { close() }
    bar.addView(exit)

    bar.layoutParams = LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    col.addView(bar)

    val wv = WebView(act)
    wv.settings.javaScriptEnabled = true
    wv.settings.domStorageEnabled = true
    wv.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        // всё открываем в оверлее (youtube/m.youtube/music.youtube — их
        // мобильные страницы); внешние протоколы (market:, intent:) не грузим
        val scheme = request.url.scheme?.lowercase() ?: return false
        return !(scheme == "http" || scheme == "https")
      }

      override fun onPageFinished(view: WebView, url: String) {
        syncChrome(url)
      }
    }
    wv.layoutParams = LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f)
    col.addView(wv)
    webView = wv

    ov.addView(col)
    root.addView(ov, FrameLayout.LayoutParams(
      FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    act.onBackPressedDispatcher.addCallback(act, backCallback)
    overlay = ov
    return ov
  }
}
