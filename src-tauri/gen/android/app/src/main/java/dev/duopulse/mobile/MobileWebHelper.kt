package dev.duopulse.mobile

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.app.DownloadManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Environment
import android.text.InputType
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.CookieManager
import android.webkit.HttpAuthHandler
import android.webkit.URLUtil
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.PopupWindow
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import java.net.URLEncoder
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
 *
 * duopulse-156 (паритет базовых функций с десктопом):
 *  - клик по ссылке на файл качается системным DownloadManager (на десктопе
 *    файловые загрузки — duopulse-158): куки/UA сессии, прогресс в шторке
 *    уведомлений, сбой — фолбэк системным браузером;
 *  - HTTP Basic-auth (onReceivedHttpAuthRequest) — диалог логин/пароль,
 *    как auth.rs десктопа; прежде запрос молча падал;
 *  - onPageFinished репортит визит (window.__duopulseVisit в UI-webview
 *    Tauri → history.visit SQLite) — история посещений мобильной ветки.
 *
 * duopulse-165 (паритет 2/8 — пароли из форм): пейлоад детекта формы логина
 * (мобильный перенос content/passwords-fill.ts, источник — Rust include_str!)
 * инжектируется onPageFinished; сабмит уходит JS-интерфейсом DuopulsePass →
 * MobilePassNative (JNI, Core) — пароль минует консоль/logcat и UI-webview,
 * бар «Сохранить пароль?» решает Core (событие), запись — только «Сохранить».
 *
 * duopulse-166 (паритет 3/8 — автозаполнение): следом инжектируется пейлоад
 * mobile_pass_fill.js — иконка-ключ 🔑 у поля пароля (когда Core знает логины
 * сайта), тап → один аккаунт: заполнение сразу; несколько: этот нативный
 * нижний лист имён (БЕЗ паролей) → выбор → reveal по id в Core →
 * evaluateJavascript заполняет логин+пароль точечно (пароль живёт в памяти
 * мгновение). Инкогнито: Core отдаёт пустой список — иконок и заполнения нет.
 *
 * duopulse-191 (жалоба «поиск Ютуб → тап по Ютуб — браузер виснет»): органика
 * «Ютуб» в легаси-выдаче Google (WebView-клиенту достается именно она) ведёт
 * на youtube.com/?app=desktop — форс ДЕСКТОПНОГО Polymer-сайта, который вешает
 * WebView телефона бесконечным скелетоном и глушит рендерер («завис», иногда
 * «открывается в обрезанном виде»). UA оверлея мобильный — достаточно
 * выбросить app=desktop (open / shouldOverrideUrlLoading / onPageStarted —
 * редирект google.com/goto не проходит shouldOverride), YouTube сам отдаёт
 * m.youtube.com (проверено на эмуляторе: страница complete, рендерер жив).
 * Заодно: внешние схемы (market:, mailto:, tel:… — карточка приложения в
 * выдаче) прежде глотались молча (тап выглядел зависанием) — теперь уходят
 * системному ACTION_VIEW. Копирование ссылки (жалоба «нет возможности
 * скопировать»): кроме меню «⋮» — долгое нажатие адресного чипа.
 *
 * duopulse-192 (доработка 191: «верхнее меню не такое, строка ввода адреса
 * не кликабельна — со всеми сайтами из поиска; YouTube верни расширенную»):
 *  - тап по адресному чипу = омнибокс: чип сменяется полем ввода с текущим
 *    адресом, GO — URL-догадка (схема/домен/локальные — пара resolveMobileInput
 *    platform.ts) или поиск Google; YouTube-видео из ввода, как и клик по
 *    ссылке, забирает встроенный плеер;
 *  - «расширенный» YouTube — тумблером «Десктопный YouTube» в меню «⋮»
 *    (SharedPreferences duopulse_web, переживает рестарт): десктопный
 *    Polymer грузится с ДЕСКТОП-UA (вис 191 был у пары «десктопный сайт +
 *    мобильный UA»; с правильной парой главная грузится за секунды),
 *    m.youtube.com переписывается на www, серверный редирект goto ловится
 *    в onPageStarted UA-мисматчем → перезапрос. ДЕФОЛТ ВЫКЛ: стенд 192
 *    показал, что после десктопных страниц WebView оверлея клинится до
 *    конца сессии (главная ок, следующие навигации мертвы) — «виснет
 *    браузер» жалобы; дефолт — поведение 191 (app=desktop срезается,
 *    мобильный UA, m.youtube). Видео-страницы по-прежнему идут во
 *    встроенный плеер с duo-субтитрами, режим сайта их не касается.
 */
object MobileWebHelper {
  private const val TAG = "DuoPulseWeb"

  /** Настройки оверлея (duopulse-192): SharedPreferences — тумблеры шапки
   *  живут рядом с их UI, без JNI-моста в settings.json Core. */
  private const val PREFS = "duopulse_web"

  /** «Десктопный YouTube» (duopulse-192, просьба вернуть «расширенную»):
   *  дефолт ВЫКЛ — даже с десктоп-UA десктопный YouTube клинит WebView
   *  оверлея (стенд 192: главная грузится за 4 с, но ВСЕ следующие
   *  навигации сессии умирают — тот самый «виснет браузер» жалобы);
   *  «расширенная» включается тумблером «⋮» — на мощных устройствах
   *  работает, состояние переживает рестарт). */
  private const val PREF_YT_DESKTOP = "yt_desktop"

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

  /** Внешние схемы, которые отдаём системе (duopulse-191): карточка
   *  приложения в выдаче Google — market:// (Play Store), mailto:/tel: —
   *  почта/звонилка, мессенджеры. Остальные (javascript:, file:, blob:,
   *  data:, about:) не грузим и не отдаём — как прежде. */
  private val EXTERNAL_SCHEMES = setOf(
    "market", "mailto", "tel", "sms", "geo", "tg", "whatsapp", "viber"
  )

  private var overlay: FrameLayout? = null
  private var webView: WebView? = null
  private var urlText: TextView? = null
  private var duoBtn: Button? = null

  /** Поле правки адреса (duopulse-192): чип по тапу сменяется им —
   *  «строка ввода адреса» оверлея кликабельна, как омнибокс мобильной ветки. */
  private var addrEdit: EditText? = null

  /** Идёт правка адреса (duopulse-192): syncChrome не затирает ввод
   *  пользователя URL'ами загрузок. */
  private var addrEditing = false

  /** Дефолтный (мобильный) UA WebView, захвачен при build (duopulse-192):
   *  база для восстановления после десктопного YouTube и для номера Chrome
   *  в собираемом десктоп-UA. */
  private var defaultUa: String? = null

  /** Полоса прогресса загрузки под шапкой (duopulse-145). */
  private var progress: ProgressBar? = null

  /** Открытое меню «⋮» шапки (закрыть при teardown, duopulse-145). */
  private var menu: PopupWindow? = null

  /** Нижний лист выбора аккаунта автозаполнения (duopulse-166; закрыть при
   *  teardown — поверхность выбора исчезла вместе с оверлеем). */
  private var accountSheet: PopupWindow? = null

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

  /** Хост — главный сайт YouTube (без www, любые поддомены). */
  private fun youTubeHost(url: String): Boolean {
    val host = try {
      Uri.parse(url).host?.lowercase()?.removePrefix("www.")
    } catch (e: Exception) {
      null
    } ?: return false
    return host == "youtube.com" || host.endsWith(".youtube.com")
  }

  /** Тумблер «Десктопный YouTube» (duopulse-192): SharedPreferences; дефолт
   *  ВЫКЛ — мобильная версия 191 (десктопный сайт клинит WebView оверлея,
   *  см. комментарий у PREF_YT_DESKTOP). */
  private fun ytDesktop(ctx: Context): Boolean =
    try {
      ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        .getBoolean(PREF_YT_DESKTOP, false)
    } catch (e: Exception) {
      false
    }

  private fun setYtDesktop(ctx: Context, on: Boolean) {
    try {
      ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
        .putBoolean(PREF_YT_DESKTOP, on).apply()
    } catch (e: Exception) {
      Log.d(TAG, "yt-desktop-pref: ${e.message}")
    }
  }

  /** Десктопный UA из дефлотного (duopulse-192): номер Chrome берём свой —
   *  возможности движка WebView соответствуют заявленной версии. */
  private fun desktopUa(base: String): String {
    val ver = Regex("Chrome/(\\d+)").find(base)?.groupValues?.get(1) ?: "130"
    return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/$ver.0.0.0 Safari/537.36"
  }

  /** Целевой UA для адреса (duopulse-192): YouTube в «расширенном» режиме —
   *  десктопный (вис 191 был у пары «десктопный Polymer + мобильный UA»),
   *  всё прочее — дефолтный мобильный. */
  private fun uaFor(url: String, base: String): String =
    if (youTubeHost(url) && ytDesktopSafe()) desktopUa(base) else base

  private fun ytDesktopSafe(): Boolean =
    MainActivity.current?.let { ytDesktop(it) } ?: true

  /** Выставить UA под адрес ДО запроса (duopulse-192): open/клики/ввод
   *  проходят наши хуки; серверные редиректы (google.com/goto) догоняет
   *  onPageStarted. Смена UA не перезагружает текущую страницу. */
  private fun applyUaFor(url: String) {
    val wv = webView ?: return
    val base = defaultUa ?: return
    val target = uaFor(url, base)
    if (wv.settings.userAgentString != target) {
      wv.settings.userAgentString = target
      Log.d(TAG, "ua-switch: ${target.take(60)}… ← ${url.take(80)}")
    }
  }

  /** UA WebView не соответствует целевому для адреса (duopulse-192): адрес
   *  стартовал без нашего хука (серверный редирект) — сигналя перезапуску. */
  private fun uaMismatched(url: String): Boolean {
    val wv = webView ?: return false
    val base = defaultUa ?: return false
    return wv.settings.userAgentString != uaFor(url, base)
  }

  /** Адрес главного фрейма YouTube под режимом (duopulse-191/192):
   *  мобильный режим (тумблер выкл) — выбросить app=desktop: десктопный
   *  Polymer на мобильном UA вешает WebView скелетоном (191); «расширенный»
   *  (вкл, дефолт) — наоборот, m.youtube.com переписать на www (тот же сайт
   *  загрузится десктопной версией с десктоп-UA, см. applyUaFor). Страницы
   *  видео не трогаем (их забирает встроенный плеер). null — не трогать. */
  private fun youTubeModeUrl(url: String): String? {
    val u = try {
      Uri.parse(url)
    } catch (e: Exception) {
      return null
    }
    val host = u.host?.lowercase()?.removePrefix("www.") ?: return null
    if (host != "youtube.com" && !host.endsWith(".youtube.com")) return null
    if (youTubeVideoId(u) != null) return null
    if (ytDesktopSafe()) {
      if (host != "m.youtube.com") return null
      // m → www: расширенный режим грузит десктопный сайт (music и прочие
      // поддомены не трогаем — у них свои версии)
      return u.buildUpon().authority("www.youtube.com").build().toString()
    }
    if (!url.contains("app=desktop")) return null
    // пересборка без app=…: очищенный URL параметра не несёт — цикла нет
    val b = u.buildUpon().clearQuery()
    for (name in u.queryParameterNames) {
      if (name == "app") continue
      for (v in u.getQueryParameters(name)) b.appendQueryParameter(name, v)
    }
    return b.build().toString()
  }

  /** «Голый домен» без схемы (TLD с буквы) — пара BARE_DOMAIN platform.ts
   *  (отсекает «2.5»/«1.2.3.4.5» — это поиск; IP ловится отдельно). */
  private val BARE_DOMAIN =
    Regex("^[a-z0-9-]+(\\.[a-z0-9-]+)*\\.[a-z][a-z0-9-]*([/?#:].*)?$", RegexOption.IGNORE_CASE)

  /** IPv4-литерал ввода (порт/путь после хоста допустимы) — isIpv4Input. */
  private fun isIpv4Input(q: String): Boolean {
    val host = (q.split(Regex("[/?#]")).firstOrNull() ?: "")
      .replace(Regex(":\\d+$"), "")
    val parts = host.split(".")
    return parts.size == 4 &&
      parts.all { it.matches(Regex("\\d{1,3}")) && it.toInt() <= 255 }
  }

  /** IPv6-литерал в скобках (порт/путь допустимы) — IPV6_LITERAL. */
  private val IPV6_LITERAL =
    Regex("^\\[[0-9a-f:.]+\\](:\\d+)?([/?#].*)?$", RegexOption.IGNORE_CASE)

  /** Ввод «URL (догадка схемы) или поиск» — мобильная пара resolveMobileInput
   *  (platform.ts): http(s) — как есть; домен/localhost/IP — с догадкой схемы
   *  (локальные — http, роутеры почти всегда без TLS, duopulse-154); прочее —
   *  поиск Google (дефолт мобильной ветки, duopulse-085). */
  private fun resolveInput(q: String): String {
    if (q.startsWith("http://", true) || q.startsWith("https://", true)) return q
    val local = q.startsWith("localhost", true) &&
      (q.length == 9 || "/:?#".contains(q[9])) ||
      isIpv4Input(q) || IPV6_LITERAL.containsMatchIn(q)
    if (BARE_DOMAIN.containsMatchIn(q) || local) {
      return (if (local) "http://" else "https://") + q
    }
    return "https://www.google.com/search?q=" +
      URLEncoder.encode(q, "UTF-8")
  }

  /** Тап по адресному чипу (duopulse-192): чип → поле ввода с текущим
   *  адресом (выделен — заменяется вводом), клавиатура открыта. */
  private fun beginAddrEdit() {
    val edit = addrEdit ?: return
    if (addrEditing) return
    addrEditing = true
    val cur = if (pageUrl.startsWith("http")) pageUrl else (webView?.url ?: "")
    edit.setText(cur)
    edit.selectAll()
    urlText?.visibility = View.GONE
    edit.visibility = View.VISIBLE
    edit.requestFocus()
    val imm = edit.context
      .getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
    imm.showSoftInput(edit, 0)
  }

  /** Вернуть чип (без перехода): отмена правки, уход фокуса, после GO. */
  private fun endAddrEdit() {
    addrEditing = false
    addrEdit?.let {
      it.visibility = View.GONE
      val imm = it.context
        .getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
      imm.hideSoftInputFromWindow(it.windowToken, 0)
    }
    urlText?.visibility = View.VISIBLE
  }

  /** GO поля адреса (duopulse-192): разбор ввода, YouTube-видео — как клик
   *  по ссылке во встроенный плеер, прочее — загрузка в оверлее. */
  private fun commitAddrEdit(raw: String) {
    endAddrEdit()
    val q = raw.trim()
    if (q.isEmpty()) return
    val target = resolveInput(q)
    applyUaFor(target)
    youTubeVideoId(target)?.let { id ->
      openVideoInPlayer(id)
      return
    }
    webView?.loadUrl(target)
  }

  /** Показ адреса и кнопки «▶ duo» — на каждой смене URL. Во время правки
   *  адреса (duopulse-192) ввод пользователя не затираем — только кнопку. */
  private fun syncChrome(url: String?) {
    if (!addrEditing) urlText?.text = url ?: ""
    val hasVideo = url != null && youTubeVideoId(url) != null
    duoBtn?.visibility = if (hasVideo) View.VISIBLE else View.GONE
  }

  /** JSON-строка для evaluateJavascript (duopulse-156: визит в историю —
   *  URL/заголовок с кавычками и переводами строк не ломают JS-литерал). */
  private fun jsonStr(s: String): String {
    val sb = StringBuilder("\"")
    for (c in s) when {
      c == '"' -> sb.append("\\\"")
      c == '\\' -> sb.append("\\\\")
      c == '\n' -> sb.append("\\n")
      c == '\r' || c < ' ' -> {} // управляющие выкидываем
      else -> sb.append(c)
    }
    return sb.append("\"").toString()
  }

  @JvmStatic fun open(context: Context, url: String): String {
    val act = MainActivity.current ?: return "error: активность не готова"
    act.runOnUiThread {
      val root = act.findViewById<FrameLayout>(android.R.id.content) ?: return@runOnUiThread
      var ov = overlay
      if (ov == null) ov = build(act, root)
      hidden = false
      syncChrome(url)
      // duopulse-191/192: адрес под режимом YouTube — мобильный срезает
      // app=desktop, «расширенный» держит десктоп (с десктоп-UA до запроса)
      val target = youTubeModeUrl(url) ?: url
      applyUaFor(target)
      webView?.loadUrl(target)
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

  /** Обёртка openInBrowser для мест без активности под рукой (фолбэк
   *  загрузчика файлов, duopulse-156). */
  private fun openInBrowserSafe(url: String) {
    val a = MainActivity.current ?: return
    openInBrowser(a, url)
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
    // «Расширенный» YouTube (duopulse-192, просьба Артёма): десктопный сайт
    // с десктоп-UA (мобильный UA + десктопный Polymer = вис 191); выкл —
    // прежнее поведение 191 (app=desktop срезается, m.youtube). Видео-страницы
    // режим не касается — их всегда забирает встроенный плеер duo
    val ytDesk = ytDesktop(act)
    items += (if (ytDesk) "✓" else "○") + "  Десктопный YouTube" to {
      val on = !ytDesk
      setYtDesktop(act, on)
      Toast.makeText(
        act,
        if (on) "YouTube — расширенная (десктопная) версия"
        else "YouTube — мобильная версия",
        Toast.LENGTH_SHORT
      ).show()
      // на YouTube — перечитать адрес уже в новом режиме
      val wv2 = webView
      if (wv2 != null && youTubeHost(wv2.url ?: "")) {
        val cur = wv2.url ?: ""
        val target = youTubeModeUrl(cur) ?: cur
        applyUaFor(target)
        wv2.loadUrl(target)
      }
    }
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

  /** Перезагрузить страницу оверлея после смены прокси WebView
   *  (duopulse-170, MobileProxyHelper): прокси действует на новые запросы —
   *  открытая страница перечитывается уже через выбранный маршрут. Вызовы
   *  идут из колбэка ProxyController на UI-ните; скрытый оверлей тоже
   *  перезагружаем — выдача обновится к возвращению. */
  @JvmStatic fun reloadForProxy() {
    val act = MainActivity.current ?: return
    act.runOnUiThread { webView?.reload() }
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
    // оверлей закрылся — ожидающий кандидат пароля больше не актуален
    // (мобильный аналог on_tabs_changed десктопа, duopulse-165)
    MobilePassNative.resetPending()
    menu?.dismiss()
    menu = null
    accountSheet?.dismiss()
    accountSheet = null
    backCallback.isEnabled = false
    backCallback.remove()
    if (addrEditing) endAddrEdit() // клавиатура/поле не должны пережить оверлей
    val wv = webView
    webView = null
    urlText = null
    addrEdit = null
    addrEditing = false
    duoBtn = null
    progress = null
    defaultUa = null
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
    addr.contentDescription = "Адресная строка"
    // duopulse-192: тап по чипу = омнибокс (жалоба «строка ввода адреса не
    // кликабельна») — чип сменяется полем ввода (beginAddrEdit)
    addr.setOnClickListener { beginAddrEdit() }
    // duopulse-191: долгое нажатие адреса = «Копировать ссылку» (тот же
    // буфер/тост, что пункт меню «⋮») — быстрый доступ без раскрытия меню
    addr.setOnLongClickListener {
      val u = webView?.url ?: ""
      if (u.isNotEmpty()) copyUrl(act, u)
      true
    }
    urlRow.addView(addr)
    urlText = addr

    // поле правки адреса (duopulse-192): тот же чип-стиль, GO — переход,
    // уход фокуса — вернуть чип без перехода; подменяет чип в ряду
    val edit = EditText(act)
    edit.setTextColor(Color.parseColor("#F2F7EE")) // --text-primary
    edit.textSize = 14f
    edit.hint = "Адрес или поиск"
    edit.maxLines = 1
    edit.setSingleLine()
    edit.imeOptions = EditorInfo.IME_ACTION_GO
    edit.inputType = InputType.TYPE_CLASS_TEXT or
      InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
    edit.setPadding(dp(12), 0, dp(12), 0)
    edit.background = GradientDrawable().apply {
      cornerRadius = dp(18).toFloat()
      setColor(Color.parseColor("#0a0e17")) // --bg-base
      setStroke(dp(1), Color.argb(46, 189, 254, 79))
    }
    edit.layoutParams = LinearLayout.LayoutParams(0, dp(36), 1f)
    edit.visibility = View.GONE
    edit.setOnEditorActionListener { v, actionId, _ ->
      if (actionId == EditorInfo.IME_ACTION_GO) {
        commitAddrEdit(v.text.toString())
        true
      } else {
        false
      }
    }
    edit.setOnFocusChangeListener { _, hasFocus ->
      // фокус ушёл (клавиатура скрыта/тап мимо) — вернуть чип без перехода
      if (!hasFocus && addrEditing) endAddrEdit()
    }
    urlRow.addView(edit)
    addrEdit = edit

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
    // дефолтный (мобильный) UA WebView (duopulse-192): база переключения
    // на десктопный для «расширенного» YouTube и обратно
    defaultUa = wv.settings.userAgentString
    wv.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        // всё открываем в оверлее (youtube/m.youtube/music.youtube — их
        // мобильные страницы); внешние протоколы не грузим
        val scheme = request.url.scheme?.lowercase() ?: return false
        if (scheme != "http" && scheme != "https") {
          // duopulse-191: знакомые приложению схемы (карточка приложения в
          // выдаче — market://, mailto:, tel:…) отдаём системе — прежде тап
          // молча пропадал и выглядел зависанием; отказ — тишина
          if (scheme in EXTERNAL_SCHEMES) {
            try {
              act.startActivity(Intent(Intent.ACTION_VIEW, request.url))
            } catch (e: Exception) {
              Log.d(TAG, "external-scheme: $scheme не открыт (${e.message})")
            }
          }
          return true
        }
        if (request.isForMainFrame) {
          // YouTube под режимом (duopulse-191/192): мобильный срезает
          // app=desktop, расширенный переписывает m → www — и грузим с
          // правильным UA (до запроса)
          youTubeModeUrl(request.url.toString())?.let { clean ->
            applyUaFor(clean)
            view.loadUrl(clean)
            return true
          }
          // Переход на YouTube-видео с выдачи/другого сайта (duopulse-139) — не
          // страница m.youtube с рекламой, а сразу встроенный плеер
          youTubeVideoId(request.url)?.let { id ->
            openVideoInPlayer(id)
            return true
          }
          // UA под цель до запроса (duopulse-192): youtube↔прочие сайты
          applyUaFor(request.url.toString())
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
        // duopulse-191/192: серверный редирект (google.com/goto → 302) не
        // проходит shouldOverrideUrlLoading — YouTube под режимом ловим и
        // здесь: адрес под режимом, затем UA (очищенный/переписанный адрес
        // повторной переработки не требует — цикла нет)
        youTubeModeUrl(url)?.let { clean ->
          applyUaFor(clean)
          view.loadUrl(clean)
          return
        }
        // duopulse-192: редирект мог привести на десктопный YouTube до нашего
        // ведома (goto несёт app=desktop) — запрос уже ушёл с мобильным UA,
        // той паре и обязан вис 191: выставить десктоп-UA и перезапросить
        // (второй проход идёт правильным UA — цикла нет). Уход с YouTube —
        // просто вернуть мобильный UA будущим загрузкам (без перезапуска).
        if (youTubeHost(url) && ytDesktopSafe()) {
          if (uaMismatched(url)) {
            applyUaFor(url)
            view.loadUrl(url)
            return
          }
        } else if (defaultUa != null && view.settings.userAgentString != defaultUa) {
          view.settings.userAgentString = defaultUa
        }
        // чип адреса — сразу (duopulse-192), не дожидаясь onPageFinished
        syncChrome(url)
        // текущий адрес — фоновым нитям загрузчика (движок адблока)
        pageUrl = url
        // косметика — пораньше (документ создаётся): скриптлеты до скриптов
        injectCosmetic(view, url)
      }

      // duopulse-146: журнал загрузок/ошибок главного фрейма в logcat — у
      // релиз-сборки нет CDP-сокета webview (полный смоук гоняется debug), а
      // ERR_CLEARTEXT_NOT_PERMITTED и прочие сетевые ошибки оверлея видны
      // только по «Webpage not available» на экране. Стенд e2e/mobile/
      // http-release-smoke.mjs верифицирует релиз по этим строкам.
      override fun onReceivedError(
        view: WebView, request: WebResourceRequest, error: android.webkit.WebResourceError
      ) {
        if (request.isForMainFrame) {
          Log.d(TAG, "overlay-error: ${request.url} ${error.description}")
        }
      }

      override fun onPageFinished(view: WebView, url: String) {
        Log.d(TAG, "overlay-loaded: $url")
        syncChrome(url)
        installUrlWatch(view)
        // захват паролей из форм (duopulse-165): пейлоад идемпотентен
        // (маркер __dpPassWatch), повтор на том же документе — тишина
        injectPassCapture(view)
        // автозаполнение (duopulse-166): пейлоад зовёт DuopulseFill.ready(),
        // логины сайта вернутся в страницу __dpPassAccounts (без паролей)
        injectPassFill(view)
        // повтор — на случай холодного движка (пустой пейлоад на старте);
        // дубли исключены сравнением с последним применённым скриптом
        injectCosmetic(view, url)
        // визит в историю мобильной ветки (duopulse-156): URL + заголовок
        // страницы — в UI Tauri (запись/дедуп/инкогнито решает фронт)
        if (url.startsWith("http")) {
          MainActivity.tauriWebView?.evaluateJavascript(
            "window.__duopulseVisit && window.__duopulseVisit(" +
              jsonStr(url) + "," + jsonStr(view.title ?: "") + ")", null)
        }
      }

      // HTTP Basic-auth (duopulse-156): диалог логин/пароль, как auth.rs
      // десктопа; прежде запрос авторизации молча проваливал загрузку.
      override fun onReceivedHttpAuthRequest(
        view: WebView, handler: HttpAuthHandler, host: String, realm: String
      ) {
        val a = MainActivity.current
        if (a == null) { handler.cancel(); return }
        val pad = (10 * a.resources.displayMetrics.density).toInt()
        val user = EditText(a).apply { hint = "Логин" }
        val pass = EditText(a).apply {
          hint = "Пароль"
          inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        val box = LinearLayout(a).apply {
          orientation = LinearLayout.VERTICAL
          setPadding(pad, pad / 2, pad, 0)
          addView(user)
          addView(pass)
        }
        AlertDialog.Builder(a)
          .setTitle("Вход: $host" + (realm.takeIf { it.isNotEmpty() }?.let { " ($it)" } ?: ""))
          .setView(box)
          .setPositiveButton("Войти") { _, _ ->
            handler.proceed(user.text.toString(), pass.text.toString())
          }
          .setNegativeButton(android.R.string.cancel) { _, _ -> handler.cancel() }
          .setOnCancelListener { handler.cancel() }
          .show()
      }
    }
    // Захват паролей из форм (duopulse-165): страница отдаёт кандидата
    // напрямую в Kotlin (addJavascriptInterface — пароль не идёт через
    // консоль-хук, как DPURL); MobilePassNative уносит его в Core.
    wv.addJavascriptInterface(PassReport, "DuopulsePass")
    // Автозаполнение (duopulse-166): пейлоад mobile_pass_fill.js спрашивает
    // логины сайта (ready) и выбор пользователя (pick) — Core решает по
    // доверенному URL; пароль приходит только credential-заполнением.
    wv.addJavascriptInterface(PassFill, "DuopulseFill")
    // Файловые загрузки (duopulse-156): клик по ссылке на файл качает
    // системный DownloadManager (куки/UA сессии, прогресс в шторке), сбой —
    // фолбэк внешним браузером; прежде клик просто молчал.
    wv.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
      val a = MainActivity.current
      if (a == null) { openInBrowserSafe(url); return@setDownloadListener }
      try {
        val name = URLUtil.guessFileName(url, contentDisposition, mimeType)
        val req = DownloadManager.Request(Uri.parse(url))
        if (mimeType.isNotEmpty()) req.setMimeType(mimeType)
        CookieManager.getInstance().getCookie(url)?.let { req.addRequestHeader("Cookie", it) }
        if (userAgent.isNotEmpty()) req.addRequestHeader("User-Agent", userAgent)
        req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
        req.setTitle(name)
        req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        val dm = a.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        dm.enqueue(req)
        Toast.makeText(a, "Загрузка началась: $name", Toast.LENGTH_SHORT).show()
      } catch (e: Exception) {
        Log.d(TAG, "download-fallback: $url ${e.message}")
        openInBrowserSafe(url)
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

  /** Инжекция пейлоада детекта формы логина (duopulse-165): источник — Core
   *  (include_str! mobile_pass_capture.js), подаётся evaluateJavascript на
   *  каждой странице; идемпотентность — маркер __dpPassWatch в пейлоаде. */
  private fun injectPassCapture(wv: WebView) {
    val js = MobilePassNative.script() ?: return
    if (js.isEmpty()) return
    wv.evaluateJavascript(js, null)
  }

  /** Инжекция пейлоада автозаполнения (duopulse-166): источник — Core
   *  (include_str! mobile_pass_fill.js); идемпотентность — маркер
   *  __dpPassFillWatch. Порядок не важен: мосты независимы. */
  private fun injectPassFill(wv: WebView) {
    val js = MobilePassNative.fill() ?: return
    if (js.isEmpty()) return
    wv.evaluateJavascript(js, null)
  }

  /** Заполнить форму выбранным логином (duopulse-166): reveal по факту
   *  выбора → пароль сразу уходит evaluateJavascript'ом в поля страницы
   *  (__dpPassFill) — нигде не хранится и не логируется. Битый/пустой
   *  ответ Core — тихо (страница не страдает). */
  private fun fillUsername(username: String) {
    val wv = webView ?: return
    val url = trustedUrl(wv) ?: return
    val pass = MobilePassNative.credential(url, username) ?: return
    // jsonStr экранирует значения: литералы не ломаются переводами строк
    wv.evaluateJavascript(
      "window.__dpPassFill && window.__dpPassFill(${jsonStr(username)}, ${jsonStr(pass)})",
      null)
  }

  /** Доверенный URL текущей страницы (SPA-хук держит pageUrl свежее wv.url,
   *  геттеры WebView — только UI-нить); не-http — null. */
  private fun trustedUrl(wv: WebView): String? {
    val url = if (pageUrl.startsWith("http")) pageUrl else (wv.url ?: "")
    return if (url.startsWith("http")) url else null
  }

  /** Нативный нижний лист выбора аккаунта (duopulse-166): имена логинов
   *  сайта БЕЗ паролей (reveal — только по факту выбора), стиль — m-sheet
   *  мобильной ветки (elevated-фон, скругление сверху, акцентная рамка).
   *  Один аккаунт сюда не попадает — заполнение сразу в pick(). */
  private fun showAccountSheet(act: MainActivity, usernames: List<String>) {
    val wv = webView ?: return
    accountSheet?.dismiss()
    val dp = { v: Int -> (v * act.resources.displayMetrics.density).toInt() }
    val ripple = TypedValue().let {
      act.theme.resolveAttribute(android.R.attr.selectableItemBackground, it, true)
      it.resourceId
    }

    val list = LinearLayout(act)
    list.orientation = LinearLayout.VERTICAL
    list.setPadding(dp(8), dp(10), dp(8), dp(12))
    list.background = GradientDrawable().apply {
      cornerRadii = floatArrayOf(
        dp(16).toFloat(), dp(16).toFloat(), dp(16).toFloat(), dp(16).toFloat(),
        0f, 0f, 0f, 0f) // скругление только сверху — лист у нижней кромки
      setColor(Color.parseColor("#1d282b")) // --bg-elevated
      setStroke(dp(1), Color.argb(64, 189, 254, 79))
    }

    val head = TextView(act)
    head.text = "Выберите аккаунт"
    head.setTextColor(Color.parseColor("#8a94a6")) // --text-secondary
    head.textSize = 13f
    head.setPadding(dp(12), dp(4), dp(12), dp(6))
    list.addView(head, LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))

    for (name in usernames) {
      val row = TextView(act)
      row.text = name
      row.setTextColor(Color.parseColor("#F2F7EE")) // --text-primary
      row.textSize = 16f
      row.gravity = Gravity.CENTER_VERTICAL
      row.setPadding(dp(12), dp(13), dp(12), dp(13))
      row.setBackgroundResource(ripple)
      row.isClickable = true
      row.setOnClickListener {
        accountSheet?.dismiss()
        fillUsername(name)
      }
      list.addView(row, LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
    }

    val popup = PopupWindow(list, LinearLayout.LayoutParams.MATCH_PARENT,
      LinearLayout.LayoutParams.WRAP_CONTENT, true)
    popup.setBackgroundDrawable(ColorDrawable())
    popup.isOutsideTouchable = true
    popup.elevation = dp(12).toFloat()
    popup.setOnDismissListener { accountSheet = null }
    accountSheet = popup
    popup.showAtLocation(wv, Gravity.BOTTOM, 0, 0)
  }

  /** Мост «страница → Core» автозаполнения (duopulse-166): пейлоад нашёл
   *  форму логина (ready — прислать логины сайта в __dpPassAccounts) либо
   *  пользователь тапнул иконку-ключ (pick — один аккаунт: заполнить сразу,
   *  несколько: лист выбора). Вызовы идут с нити JavaBridge — webView.url
   *  читаем только на UI-ните; URL берём свой, странице не верим. Инкогнито
   *  решает Core (пустой список — ни иконок, ни заполнения). */
  private object PassFill {
    @android.webkit.JavascriptInterface
    fun ready() {
      val act = MainActivity.current ?: return
      act.runOnUiThread {
        val wv = webView ?: return@runOnUiThread
        val url = trustedUrl(wv) ?: return@runOnUiThread
        // JSON-массив логинов (без паролей) — как есть в страницу; пустой
        // список честен: снимет иконки после SPA-перехода на чужой сайт
        val accounts = MobilePassNative.accounts(url) ?: return@runOnUiThread
        if (webView !== wv) return@runOnUiThread
        wv.evaluateJavascript(
          "window.__dpPassAccounts && window.__dpPassAccounts($accounts)", null)
      }
    }

    @android.webkit.JavascriptInterface
    fun pick() {
      val act = MainActivity.current ?: return
      act.runOnUiThread {
        val wv = webView ?: return@runOnUiThread
        val url = trustedUrl(wv) ?: return@runOnUiThread
        // список свежий (мог измениться сохранением после загрузки страницы)
        val names = try {
          org.json.JSONArray(MobilePassNative.accounts(url) ?: "[]").let { ja ->
            List(ja.length()) { i -> ja.optString(i, "") }.filter { it.isNotEmpty() }
          }
        } catch (e: Exception) {
          emptyList()
        }
        when (names.size) {
          0 -> {} // сохранённых нет (или инкогнито) — тап тихо пропадает
          1 -> fillUsername(names[0])
          else -> showAccountSheet(act, names)
        }
      }
    }
  }

  /** Мост «страница → Core» захвата паролей (duopulse-165): пейлоад нашёл
   *  сабмит формы логина и принёс пару {username, password} (JSON со
   *  страницы — парсим, длинам верим с потолком). Вызовы идут с нити
   *  JavaBridge — webView.url/title читаем только на UI-ните (геттеры с
   *  фоновых нитей роняют процесс); URL берём свой (pageUrl свежее SPA-хука,
   *  fallback — wv.url), странице не верим. Инкогнито/denylist решает Core. */
  private object PassReport {
    /** Потолки длин (пароль из менеджера бывает длинным, но не мегабайт). */
    private const val MAX_USER = 256
    private const val MAX_PASS = 512

    @android.webkit.JavascriptInterface
    fun report(json: String) {
      val act = MainActivity.current ?: return
      act.runOnUiThread {
        val wv = webView ?: return@runOnUiThread
        try {
          val o = org.json.JSONObject(json)
          val u = o.optString("username", "")
          val p = o.optString("password", "")
          if (u.isEmpty() || p.isEmpty()) return@runOnUiThread
          if (u.length > MAX_USER || p.length > MAX_PASS) return@runOnUiThread
          // доверенный URL: SPA-хук держит pageUrl свежее wv.url
          val url = if (pageUrl.startsWith("http")) pageUrl else (wv.url ?: "")
          if (!url.startsWith("http")) return@runOnUiThread
          MobilePassNative.report(u, p, url, wv.title ?: "")
        } catch (e: Exception) {
          // битый JSON с чужой страницы — тихо, страница не страдает
        }
      }
    }
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
