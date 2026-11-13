package dev.duopulse.mobile

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import android.util.Log
import android.view.Gravity
import android.view.View
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.io.ByteArrayInputStream

/*
 * Нативный web-оверлей (duopulse-126; переработка duopulse-139 по жалобе
 * «открываю страницы через поиск — интерфейс DuoPulse исчезает, ощущение
 * работы в Гугле, на видео подгружается реклама»):
 *  - бренд: тулбар с логотипом duoPulse (тёмный + акцент #BDFE4F, как шапка
 *    мобильной ветки) — каждая страница читается как страница ВНУТРИ DuoPulse;
 *  - ссылки YouTube-видео (watch/shorts/live/youtu.be) не открываются
 *    страницей m.youtube со всей рекламой: видео сразу идёт во встроенный
 *    /embed-плеер с duo-субтитрами (evaluateJavascript → окно
 *    __duopulseOpenVideo UI-webview Tauri), оверлей прячется (НЕ
 *    разрушается — выдача живёт), системный «назад» возвращает к ней;
 *    SPA-навигации m.youtube (Navigation API — pushState не зовётся,
 *    см. duopulse-SPA-память проекта) ловит консоль-хук DPURL;
 *  - лёгкий адблок: shouldInterceptRequest режет подгрузки рекламных/
 *    трекинговых хостов (doubleclick, googlesyndication, …); полный движок
 *    adblock-rs десктопа (WebView2 COM-перехват) в мобильную ветку не
 *    тащим — это отдельная карточка.
 * Rust-команды mobile_web_open / mobile_web_close (src-tauri/src/mobile_web.rs)
 * валидируют схему и зовут один статический метод — как MobileOpenHelper;
 * исключения гасятся здесь и возвращаются строкой. Системный «назад» —
 * из плеера к выдаче / история WebView / исчерпана — закрыть.
 */
object MobileWebHelper {
  private const val TAG = "DuoPulseWeb"

  /** Хвосты рекламных/трекинговых хостов для лёгкого адблока (суффикс-матч
   *  по host подресурсов; главные фреймы не режем — сайт должен открыться). */
  private val AD_HOSTS = setOf(
    "doubleclick.net", "googlesyndication.com", "googleadservices.com",
    "adservice.google.com", "google-analytics.com", "googletagmanager.com",
    "adnxs.com", "criteo.com", "criteo.net", "scorecardresearch.com",
    "outbrain.com", "taboola.com", "moatads.com", "amazon-adsystem.com"
  )

  /** videoId ([\w-]{6,20}) — общий формат id YouTube. */
  private const val ID_RE = "[\\w-]{6,20}"

  private var overlay: FrameLayout? = null
  private var webView: WebView? = null
  private var urlText: TextView? = null
  private var duoBtn: Button? = null

  /** Оверлей спрятан за встроенным плеером (видео открыто из выдачи,
   *  duopulse-139): WebView жив, системный «назад» возвращает к выдаче. */
  private var hidden = false

  /** Последний URL консоль-хука DPURL — на повторы не реагируем. */
  private var lastReportedUrl: String? = null

  /** Системный «назад»: оверлей спрятан — вернуться к выдаче; иначе история
   *  WebView; исчерпана — закрыть оверлей. */
  private val backCallback = object : OnBackPressedCallback(false) {
    override fun handleOnBackPressed() {
      if (hidden) {
        show()
        return
      }
      val wv = webView
      if (wv != null && wv.canGoBack()) wv.goBack() else close()
    }
  }

  /** videoId из ссылки YouTube (watch?v=, /shorts/, /live/, youtu.be) или
   *  null. Хост проверяем отдельно (duopulse-139): «watch?v=» в адресе
   *  выдачи Google — это запрос, а не видео. */
  private fun youTubeVideoId(u: Uri): String? {
    val host = u.host?.lowercase()?.removePrefix("www.") ?: return null
    val path = u.path ?: ""
    return when {
      host == "youtu.be" ->
        path.trimStart('/').split("/").firstOrNull()?.takeIf { it.matches(Regex(ID_RE)) }
      host == "youtube.com" || host.endsWith(".youtube.com") -> {
        val id = u.getQueryParameter("v")
        when {
          path == "/watch" && id != null -> id.takeIf { it.matches(Regex(ID_RE)) }
          else -> Regex("^/(?:embed|shorts|live)/($ID_RE)$").find(path)?.groupValues?.get(1)
        }
      }
      else -> null
    }
  }

  /** Строковая обёртка youTubeVideoId (битой строке — null: Uri.parse на
   *  мусоре даёт Uri с null-host; tryParse — API 30+, minSdk ниже). */
  private fun youTubeVideoId(url: String): String? {
    val u = try {
      Uri.parse(url)
    } catch (e: Exception) {
      return null
    }
    return youTubeVideoId(u)
  }

  /** Показ адреса и кнопки «▶ duo» — на каждой смене URL. */
  private fun syncChrome(url: String?) {
    urlText?.text = url ?: ""
    val hasVideo = url != null && youTubeVideoId(url) != null
    duoBtn?.visibility = if (hasVideo) View.VISIBLE else View.GONE
  }

  @JvmStatic fun open(context: Context, url: String): String {
    val act = MainActivity.current ?: return "error: активность не готова"
    act.runOnUiThread {
      val root = act.findViewById<FrameLayout>(android.R.id.content) ?: return@runOnUiThread
      var ov = overlay
      if (ov == null) ov = build(act, root)
      hidden = false
      syncChrome(url)
      webView?.loadUrl(url)
      ov.visibility = View.VISIBLE
      backCallback.isEnabled = true
    }
    return "opened"
  }

  /** Показать спрятанный оверлей (системный «назад» из встроенного плеера):
   *  активная вкладка-плеер под ним уходит на паузу (__duopulseOverlayShown). */
  private fun show() {
    val ov = overlay ?: return
    hidden = false
    webView?.onResume()
    ov.visibility = View.VISIBLE
    backCallback.isEnabled = true
    MainActivity.tauriWebView?.evaluateJavascript(
      "window.__duopulseOverlayShown && window.__duopulseOverlayShown()", null)
  }

  /** Спрятать оверлей за встроенным плеером (duopulse-139): выдача живёт —
   *  INVISIBLE (layout не меняем — UI Tauri под ним не перетасовывается),
   *  WebView на паузу (таймеры/аудио страницы). */
  private fun hide() {
    val ov = overlay ?: return
    hidden = true
    webView?.onPause()
    ov.visibility = View.INVISIBLE
    backCallback.isEnabled = true
  }

  /** Открыть видео во встроенном плеере мобильной ветки (tabs.open в
   *  mobile.ts через __duopulseOpenVideo) вместо страницы m.youtube с
   *  рекламой; оверлей прячем — «назад» вернёт к выдаче. */
  private fun openVideoInPlayer(id: String) {
    hide()
    MainActivity.tauriWebView?.evaluateJavascript(
      "window.__duopulseOpenVideo && window.__duopulseOpenVideo('$id')", null)
  }

  /** Сообщение консоль-хука DPURL (SPA-навигации m.youtube — Navigation API,
   *  shouldOverrideUrlLoading их не видит). Смена URL — обновить хром;
   * переход на YouTube-видео — откатить SPA-навигацию (выдача остаётся под
   *  оверлеем) и открыть видео во встроенном плеере. */
  private fun onConsole(msg: String) {
    if (!msg.startsWith("DPURL:")) return
    val url = msg.removePrefix("DPURL:")
    if (url == lastReportedUrl) return
    lastReportedUrl = url
    syncChrome(url)
    if (hidden) return
    youTubeVideoId(url)?.let { id ->
      val wv = webView ?: return
      if (wv.canGoBack()) wv.goBack() // вернуть выдачу: история SPA-перехода
      openVideoInPlayer(id)
    }
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
    MobileFullscreen.dismiss()
    backCallback.isEnabled = false
    backCallback.remove()
    val wv = webView
    webView = null
    urlText = null
    duoBtn = null
    hidden = false
    lastReportedUrl = null
    // WebView.detach перед destroy (иначе окна/текстуры текут): сначала
    // снимаем оверлей с активити, потом гасим WebView
    (ov.parent as? FrameLayout)?.removeView(ov)
    ov.removeAllViews()
    wv?.apply {
      stopLoading()
      loadUrl("about:blank")
      onResume() // teardown из спрятанного (onPause) состояния — убрать паузу перед destroy
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
    // edge-to-edge (duopulse-133): enableEdgeToEdge в MainActivity гасит
    // fitsSystemWindows у decor — оверлей рисуется под статус-баром и тот
    // перекрывал тулбар с адресом. Применяем инсеты сами: паддинг системными
    // панелями + вырезом дисплея
    ViewCompat.setOnApplyWindowInsetsListener(ov) { v, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }

    val col = LinearLayout(act)
    col.orientation = LinearLayout.VERTICAL

    // мини-тулбар в стиле DuoPulse: тёмный фон, акцент #BDFE4F (mobile.css);
    // логотип (duopulse-139) — чтобы страница выдачи читалась страницей
    // ВНУТРИ DuoPulse, а не «я работаю в Гугле»
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

    // логотип duoPulse — как .m-logo шапки мобильной ветки (duo обычным,
    // Pulse жирным акцентом)
    val logo = TextView(act)
    val mark = SpannableStringBuilder("duoPulse")
    mark.setSpan(ForegroundColorSpan(Color.parseColor("#DDE1E6")), 0, 3,
      Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    mark.setSpan(ForegroundColorSpan(Color.parseColor("#BDFE4F")), 3, 8,
      Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    mark.setSpan(StyleSpan(Typeface.BOLD), 3, 8, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    logo.text = mark
    logo.textSize = 14f
    logo.gravity = Gravity.CENTER_VERTICAL
    logo.setPadding(dp(8), 0, 0, 0)
    logo.layoutParams = LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.MATCH_PARENT)
    bar.addView(logo)

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
      val id = youTubeVideoId(webView?.url ?: "") ?: return@setOnClickListener
      openVideoInPlayer(id)
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
        if (scheme != "http" && scheme != "https") return true
        // Переход на YouTube-видео с выдачи/другого сайта (duopulse-139) — не
        // страница m.youtube с рекламой, а сразу встроенный плеер
        if (request.isForMainFrame) {
          youTubeVideoId(request.url)?.let { id ->
            openVideoInPlayer(id)
            return true
          }
        }
        return false
      }

      override fun shouldInterceptRequest(
        view: WebView, request: WebResourceRequest
      ): WebResourceResponse? {
        // лёгкий адблок (duopulse-139): рекламные/трекинговые подгрузки —
        // пустым ответом; главную навигацию не трогаем
        if (request.isForMainFrame) return null
        val host = request.url.host?.lowercase() ?: return null
        if (AD_HOSTS.any { host == it || host.endsWith(".$it") }) {
          Log.d(TAG, "adblock: $host${request.url.path ?: ""}")
          return WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
        }
        return null
      }

      override fun onPageFinished(view: WebView, url: String) {
        syncChrome(url)
        installUrlWatch(view)
      }
    }
    // duopulse-134: кнопка «на весь экран» YouTube — без WebChromeClient
    // fullscreen не работает вовсе; консоль — хук DPURL (onConsole)
    wv.webChromeClient = MobileFullscreen.chromeClient(act, wv) { msg -> onConsole(msg) }

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

  /** Консоль-хук URL (duopulse-139): SPA-навигации m.youtube (Navigation
   *  API — pushState не зовётся) shouldOverrideUrlLoading не видит; здесь
   *  страница сама репортит location.href (префикс DPURL:, ловит
   *  WebChromeClient), navigatesuccess — мгновенно, интервал — фолбэк. */
  private fun installUrlWatch(wv: WebView) {
    val js = "(function(){if(window.__dpUrlWatch)return;window.__dpUrlWatch=1;" +
      "var s=function(){console.log('DPURL:'+location.href)};" +
      "if(window.navigation)navigation.addEventListener('navigatesuccess',s);" +
      "setInterval(s,700)})"
    wv.evaluateJavascript("$js()", null)
  }
}
