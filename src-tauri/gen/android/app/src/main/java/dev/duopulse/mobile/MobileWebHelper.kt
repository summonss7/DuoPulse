package dev.duopulse.mobile

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.PopupWindow
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.io.ByteArrayInputStream

/*
 * Нативный web-оверлей (duopulse-126; переработка duopulse-139 по жалобе
 * «открываю страницы через поиск — интерфейс DuoPulse исчезает, ощущение
 * работы в Гугле, на видео подгружается реклама»; доработка duopulse-145
 * по жалобе «обновился — меню нет, только ссылка сверху, ощущение другой
 * программы»):
 *  - бренд: шапка КАК в мобильной ветке (.m-bar, два ряда: кнопки + адрес-
 *    чип-омнибокс, токены темы из tokens.css: surface #111d2b, base
 *    #0a0e17, elevated #1d282b, акцент #BDFE4F), полоса прогресса загрузки;
 *  - меню «⋮» (duopulse-145, стиль .m-menu): Главная DuoPulse (хук
 *    __duopulseGoHome), обновить, вперёд, открыть в плеере duo, копировать
 *    ссылку, поделиться, открыть в системном браузере — страница выдачи
 *    управляется ИЗ DuoPulse, а не «ссылка сверху в другой программе»;
 *  - ссылки YouTube-видео (watch/shorts/live/youtu.be) не открываются
 *    страницей m.youtube со всей рекламой: видео сразу идёт во встроенный
 *    /embed-плеер с duo-субтитрами (evaluateJavascript → окно
 *    __duopulseOpenVideo UI-webview Tauri), оверлей прячется (НЕ
 *    разрушается — выдача живёт), системный «назад» возвращает к ней;
 *    SPA-навигации m.youtube (Navigation API — pushState не зовётся,
 *    см. duopulse-SPA-память проекта) ловит консоль-хук DPURL;
 *  - полный адблок (duopulse-144): shouldInterceptRequest спрашивает движок
 *    adblock-rs десктопа через JNI (EasyList + uBO + quick-fixes — списки
 *    качаются/кэшируются Core в profile/filters, тумблер в меню «⋮»),
 *    лёгкий хост-лист duopulse-139 (doubleclick, googlesyndication, …)
 *    остаётся фолбэком — движок выключен/собирается/сбой = прежнее
 *    поведение; косметика (hide-селекторы + скриптлеты) — JS-пейлоадом
 *    движка на onPageStarted/onPageFinished (evaluateJavascript).
 * Rust-команды mobile_web_open / mobile_web_close (src-tauri/src/mobile_web.rs)
 * валидируют схему и зовут один статический метод — как MobileOpenHelper;
 * исключения гасятся здесь и возвращаются строкой. Системный «назад» —
 * из плеера к выдаче / история WebView / исчерпана — закрыть.
 */
object MobileWebHelper {
  private const val TAG = "DuoPulseWeb"

  /** Хвосты рекламных/трекинговых хостов для лёгкого адблока (суффикс-матч
   *  по host подресурсов; главные фреймы не режем — сайт должен открыться).
   *  С duopulse-144 — фолбэк полного движка: решает первым adblock-rs,
   *  сюда попадает то, что движок не взял (выключен/собирается/сбой JNI). */
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

  /** Полоса прогресса загрузки под шапкой (duopulse-145). */
  private var progress: ProgressBar? = null

  /** Открытое меню «⋮» шапки (закрыть при teardown, duopulse-145). */
  private var menu: PopupWindow? = null

  /** Оверлей спрятан за встроенным плеером (видео открыто из выдачи,
   *  duopulse-139): WebView жив, системный «назад» возвращает к выдаче. */
  private var hidden = false

  /** Последний URL консоль-хука DPURL — на повторы не реагируем. */
  private var lastReportedUrl: String? = null

  /** Последний применённый косметический скрипт (дедуп между
   *  onPageStarted/onPageFinished и повторами на том же документе). */
  private var lastCosmetic: String? = null

  /** Текущий URL страницы для движка (shouldInterceptRequest идёт с нити
   *  загрузчика WebView, где нельзя звать view.url — только UI-нить; поле
   *  пишется на onPageStarted/консоль-хуке и читается без лока — гонка
   *  безвредна: это лишь запасной источник запроса, Referer точнее). */
  @Volatile private var pageUrl: String = ""

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

  /** «Главная DuoPulse» из меню оверлея (duopulse-145): логика «домой» уже
   *  есть у кнопки «⌂» мобильной ветки — хук __duopulseGoHome в mobile.ts
   *  закрывает оверлей (mobile_web_close из обработчика), открывает новую
   *  вкладку и фокусирует omnibox; видео остаются в фоне. */
  private fun goHome() {
    MainActivity.tauriWebView?.evaluateJavascript(
      "window.__duopulseGoHome && window.__duopulseGoHome()", null)
  }

  /** «Копировать ссылку» из меню: буфер обмена + тост. */
  private fun copyUrl(act: MainActivity, url: String) {
    if (url.isEmpty()) return
    val cm = act.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    cm.setPrimaryClip(ClipData.newPlainText("DuoPulse URL", url))
    Toast.makeText(act, "Ссылка скопирована", Toast.LENGTH_SHORT).show()
  }

  /** «Поделиться…» из меню: системный chooser (ACTION_SEND). */
  private fun share(act: MainActivity, url: String) {
    if (url.isEmpty()) return
    val i = Intent(Intent.ACTION_SEND).apply {
      type = "text/plain"
      putExtra(Intent.EXTRA_TEXT, url)
    }
    act.startActivity(Intent.createChooser(i, "Поделиться ссылкой"))
  }

  /** «Открыть в браузере» из меню: системный ACTION_VIEW (как фолбэк
   *  mobile_open_url); браузера нет — честный тост, не падение. */
  private fun openInBrowser(act: MainActivity, url: String) {
    if (url.isEmpty()) return
    try {
      act.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
    } catch (e: android.content.ActivityNotFoundException) {
      Toast.makeText(act, "Браузер не найден", Toast.LENGTH_SHORT).show()
    }
  }

  /** Меню «⋮» шапки оверлея (duopulse-145): действия над страницей, стиль —
   *  .m-menu мобильной ветки (тёмный elevated-фон, акцентная рамка,
   *  скругление 16). Состав живой: «вперёд»/«плеер duo» — только когда есть
   *  смысл; тап вне — закрыть. */
  private fun showMenu(act: MainActivity, anchor: View) {
    val wv = webView ?: return
    menu?.dismiss()
    val dp = { v: Int -> (v * act.resources.displayMetrics.density).toInt() }

    val url = wv.url ?: ""
    val video = youTubeVideoId(url)
    val items = mutableListOf<Pair<String, () -> Unit>>()
    items += "⌂  Главная DuoPulse" to { goHome() }
    items += "⟳  Обновить страницу" to { wv.reload() }
    if (wv.canGoForward()) items += "›  Вперёд" to { wv.goForward() }
    if (video != null) items += "▶  Открыть в плеере duo" to { openVideoInPlayer(video) }
    items += "⧉  Копировать ссылку" to { copyUrl(act, url) }
    items += "↗  Поделиться…" to { share(act, url) }
    items += "⌘  Открыть в браузере" to { openInBrowser(act, url) }
    // Тумблер полного блокировщика (duopulse-144): галка — состояние из
    // settings.json Core (переживает перезапуск); выкл = прежнее поведение
    // (лёгкий хост-лист duopulse-139)
    val adOn = MobileAdblockNative.adblockEnabled()
    items += (if (adOn) "✓" else "○") + "  Блокировщик рекламы" to {
      val on = !adOn
      MobileAdblockNative.setAdblockEnabled(on)
      Toast.makeText(
        act,
        if (on) "Блокировщик рекламы включён"
        else "Блокировщик выключен — остался лёгкий список",
        Toast.LENGTH_SHORT
      ).show()
      MobileAdblockNative.logStatus()
    }

    val list = LinearLayout(act)
    list.orientation = LinearLayout.VERTICAL
    list.setPadding(dp(6), dp(6), dp(6), dp(6))
    list.background = GradientDrawable().apply {
      cornerRadius = dp(16).toFloat()
      setColor(Color.parseColor("#1d282b")) // --bg-elevated
      setStroke(dp(1), Color.argb(64, 189, 254, 79)) // рамка .m-menu
    }
    // ripple-подсветка пунктов — как у кнопок приложения
    val ripple = TypedValue().let {
      act.theme.resolveAttribute(android.R.attr.selectableItemBackground, it, true)
      it.resourceId
    }
    for ((label, action) in items) {
      val row = TextView(act)
      row.text = label
      row.setTextColor(Color.parseColor("#F2F7EE")) // --text-primary
      row.textSize = 15f
      row.gravity = Gravity.CENTER_VERTICAL
      row.setPadding(dp(12), dp(11), dp(12), dp(11))
      row.setBackgroundResource(ripple)
      row.setOnClickListener { menu?.dismiss(); action() }
      list.addView(row, LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
    }

    val popup = PopupWindow(list, LinearLayout.LayoutParams.WRAP_CONTENT,
      LinearLayout.LayoutParams.WRAP_CONTENT, true)
    popup.setBackgroundDrawable(ColorDrawable())
    popup.isOutsideTouchable = true
    popup.elevation = dp(8).toFloat()
    popup.setOnDismissListener { menu = null }
    menu = popup
    popup.showAsDropDown(anchor, 0, 0, Gravity.TOP or Gravity.END)
  }

  /** Косметика движка (duopulse-144, второй этап): JS-пейлоад (скриптлеты
   *  + hide-селекторы) собирается в Rust на фоновой нити (холодный расчёт
   *  до ~0,9 с — UI не подвешиваем), применяется в UI-нити оверлея
   *  evaluateJavascript'ом. Дедуп: тот же скрипт повторно не гоняем
   *  (onPageStarted + onPageFinished + SPA-повторы одного документа). */
  private fun injectCosmetic(wv: WebView, url: String) {
    if (!url.startsWith("http")) return
    Thread {
      val js = MobileAdblockNative.cosmeticFor(url) ?: return@Thread
      if (js.isEmpty() || js == lastCosmetic) return@Thread
      val act = MainActivity.current ?: return@Thread
      act.runOnUiThread {
        // WebView мог уже закрыться/перейти — строка адреса скажет какую
        if (webView === wv) {
          lastCosmetic = js
          wv.evaluateJavascript(js, null)
        }
      }
    }.start()
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
    pageUrl = url // SPA-навигация: адрес для движка (нити загрузчика)
    syncChrome(url)
    if (hidden) return
    youTubeVideoId(url)?.let { id ->
      val wv = webView ?: return
      if (wv.canGoBack()) wv.goBack() // вернуть выдачу: история SPA-перехода
      openVideoInPlayer(id)
    }
  }

  /** Закрытие из Rust (mobile_web_close). Поверхность JNI у open/close общая
   *  — (Context, String) → String (jni_impl в mobile_web.rs): второй параметр
   *  у close не используется, но обязателен дескриптору. До duopulse-145
   *  метод звался с одним параметром — NoSuchMethodException, «⌂ домой» не
   *  закрывал спрятанный оверлей (выдача «воскресала» системным «назад»). */
  @JvmStatic fun close(context: Context, unused: String): String {
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
    menu?.dismiss()
    menu = null
    backCallback.isEnabled = false
    backCallback.remove()
    val wv = webView
    webView = null
    urlText = null
    duoBtn = null
    progress = null
    hidden = false
    lastReportedUrl = null
    lastCosmetic = null
    pageUrl = ""
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

    // ── Шапка оверлея — как .m-bar мобильной ветки (duopulse-145): два ряда
    // (кнопки + адрес-чип-омнибокс) + меню «⋮» + полоса прогресса. Прежний
    // один тонкий ряд читался «ссылкой сверху чужой программы» (жалоба
    // duopulse-145). Цвета — токены tokens.css: surface/base/elevated/акцент.
    val header = LinearLayout(act)
    header.orientation = LinearLayout.VERTICAL
    header.setBackgroundColor(Color.parseColor("#111d2b")) // --bg-surface

    fun toolButton(label: String, title: String, tint: String = "#BDFE4F"): Button {
      val b = Button(act)
      b.text = label
      b.contentDescription = title
      b.setBackgroundColor(Color.TRANSPARENT)
      b.setTextColor(Color.parseColor(tint))
      b.setPadding(dp(10), 0, dp(10), 0)
      b.minimumWidth = 0
      b.minWidth = 0
      b.minimumHeight = 0
      b.minHeight = 0
      return b
    }

    // ряд 1: ‹ назад | логотип (растягивается) | ✕ закрыть | ⋮ меню — как
    // ряд кнопок .m-bar-top (⌂ + логотип + … + ⋮) мобильной ветки
    val bar = LinearLayout(act)
    bar.orientation = LinearLayout.HORIZONTAL
    bar.setPadding(dp(4), dp(4), dp(4), 0)

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
    mark.setSpan(ForegroundColorSpan(Color.parseColor("#F2F7EE")), 0, 3,
      Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    mark.setSpan(ForegroundColorSpan(Color.parseColor("#BDFE4F")), 3, 8,
      Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    mark.setSpan(StyleSpan(Typeface.BOLD), 3, 8, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    logo.text = mark
    logo.textSize = 14f
    logo.gravity = Gravity.CENTER_VERTICAL
    logo.setPadding(dp(8), 0, 0, 0)
    logo.layoutParams = LinearLayout.LayoutParams(
      0, LinearLayout.LayoutParams.MATCH_PARENT, 1f)
    bar.addView(logo)

    val exit = toolButton("✕", "Закрыть", "#F2F7EE")
    exit.layoutParams = LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    exit.setOnClickListener { close() }
    bar.addView(exit)

    val menuBtn = toolButton("⋮", "Меню", "#F2F7EE")
    menuBtn.layoutParams = LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    menuBtn.setOnClickListener { showMenu(act, it) }
    bar.addView(menuBtn)

    bar.layoutParams = LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    header.addView(bar)

    // ряд 2: адрес-чип — как omnibox (.m-bar input: скругление 18, фон
    // --bg-base, рамка акцента 0.18); «▶ duo» на страницах YouTube-видео
    val urlRow = LinearLayout(act)
    urlRow.orientation = LinearLayout.HORIZONTAL
    urlRow.setPadding(dp(10), dp(8), dp(10), dp(8))

    val addr = TextView(act)
    addr.setTextColor(Color.parseColor("#F2F7EE")) // --text-primary
    addr.textSize = 14f
    addr.maxLines = 1
    addr.ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
    addr.gravity = Gravity.CENTER_VERTICAL
    addr.setPadding(dp(12), 0, dp(12), 0)
    addr.background = GradientDrawable().apply {
      cornerRadius = dp(18).toFloat()
      setColor(Color.parseColor("#0a0e17")) // --bg-base
      setStroke(dp(1), Color.argb(46, 189, 254, 79))
    }
    addr.layoutParams = LinearLayout.LayoutParams(0, dp(36), 1f)
    urlRow.addView(addr)
    urlText = addr

    val duo = toolButton("▶ duo", "Открыть во встроенном плеере")
    duo.visibility = View.GONE
    val duoLp = LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.MATCH_PARENT)
    duoLp.marginStart = dp(8)
    duo.layoutParams = duoLp
    duo.setOnClickListener {
      val id = youTubeVideoId(webView?.url ?: "") ?: return@setOnClickListener
      openVideoInPlayer(id)
    }
    urlRow.addView(duo)
    duoBtn = duo

    urlRow.layoutParams = LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    header.addView(urlRow)

    // полоса прогресса загрузки (браузерный индикатор): появляется на старте
    // страницы, гаснет на 100% — страница «живая», оверлей ведёт себя как
    // браузер, а не безымянная вьюха
    val prog = ProgressBar(act, null, android.R.attr.progressBarStyleHorizontal)
    prog.max = 100
    prog.progressTintList = android.content.res.ColorStateList.valueOf(
      Color.parseColor("#BDFE4F"))
    prog.progressBackgroundTintList = android.content.res.ColorStateList.valueOf(
      Color.TRANSPARENT)
    prog.layoutParams = LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.MATCH_PARENT, dp(3))
    prog.visibility = View.GONE
    header.addView(prog)
    progress = prog

    // border-bottom шапки — как .m-bar (rgba(189,254,79,0.14))
    val divider = View(act)
    divider.setBackgroundColor(Color.argb(36, 189, 254, 79))
    divider.layoutParams = LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.MATCH_PARENT, dp(1))
    header.addView(divider)

    header.layoutParams = LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    col.addView(header)

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
        // полный адблок (duopulse-144) + лёгкий фолбэк (duopulse-139):
        // решает движок adblock-rs (EasyList/uBO, тип запроса Core выводит
        // из URL/Accept); невырезанное проходит хвостовой хост-лист.
        // Главную навигацию не трогаем — сайт должен открыться.
        if (request.isForMainFrame) return null
        val url = request.url.toString()
        val headers = request.requestHeaders
        val referer = headers?.get("Referer") ?: headers?.get("referer") ?: ""
        val accept = headers?.get("Accept") ?: headers?.get("accept") ?: ""
        // pageUrl (не view.url!): shouldInterceptRequest — фоновая нить
        // загрузчика, WebView-геттеры там роняют процесс (поймано смоуком)
        if (MobileAdblockNative.engineBlocks(url, pageUrl, referer, accept, false)) {
          Log.d(TAG, "adblock-engine: $url")
          return WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
        }
        val host = request.url.host?.lowercase() ?: return null
        if (AD_HOSTS.any { host == it || host.endsWith(".$it") }) {
          Log.d(TAG, "adblock: $host${request.url.path ?: ""}")
          return WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
        }
        return null
      }

      override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
        // прогресс: страница грузится — полоса видна (100% погасит onProgress)
        progress?.let { it.progress = 5; it.visibility = View.VISIBLE }
        // текущий адрес — фоновым нитям загрузчика (движок адблока)
        pageUrl = url
        // косметика — пораньше (документ создаётся): скриптлеты до скриптов
        injectCosmetic(view, url)
      }

      override fun onPageFinished(view: WebView, url: String) {
        syncChrome(url)
        installUrlWatch(view)
        // повтор — на случай холодного движка (пустой пейлоад на старте);
        // дубли исключены сравнением с последним применённым скриптом
        injectCosmetic(view, url)
      }
    }
    // duopulse-134: кнопка «на весь экран» YouTube — без WebChromeClient
    // fullscreen не работает вовсе; консоль — хук DPURL (onConsole);
    // прогресс — полоса шапки (duopulse-145)
    wv.webChromeClient = MobileFullscreen.chromeClient(act, wv, { msg -> onConsole(msg) }) { p ->
      progress?.let { it.progress = p }
      if (p >= 100) progress?.visibility = View.GONE
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
