package dev.duopulse.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/*
 * Фоновая музыка мобильной ветки (duopulse-218, жалоба «перехожу в другое
 * приложение — музыка, которую слушаю в браузере, сразу выключается»):
 *  - источник: медиа двух окон — UI-webview Tauri (встроенный плеер: файлное
 *    видео — свой <video>, YouTube — embed-iframe, время которого опрашивают
 *    duo-часы window.__duopulseMobileDuo().clock) и web-оверлей (MobileWebHelper,
 *    любые <video>/<audio> страницы выдачи);
 *  - почему глохло: WryActivity.onPause() зовёт WebView.onPause() UI-webview —
 *    страница уходит в hidden, медиа рендерера глушится, YouTube сам ставит
 *    паузу (см. шапку clock.ts). Пока музыка играет, паузу снимаем сразу за
 *    super.onPause(), а процесс держим foreground-сервисом mediaPlayback
 *    (Android 11+ замораживает cached-процессы; рендерер — привязкой приоритета
 *    setRendererPriorityPolicy(BOUND, false), без неё WebView-плеер в фоне
 *    замерзал — duopulse-082);
 *  - зонд: Handler UI-нити каждые 2 с — evaluateJavascript в оба окна. «Играет» =
 *    незапауженный <video>/<audio> в топ-документе ИЛИ прирост часов duo между
 *    тиками (замороженный/запауженный плеер время не наращивает — тот же
 *    принцип, что детектор замерзания clock.ts; позволяет читать состояние
 *    КРОСС-ДОМЕННОГО iframe без доступа к нему). Кросс-доменные iframe-плееры
 *    чужих сайтов (SoundCloud и пр.) зонд не видит — известный предел v1;
 *  - стоп: зонд видит остановку (≤4 с) — сервис гасится, сессия деактивируется.
 *    Пауза из шторки/медиа-кнопок — JS-посылка pauseVideo во все iframe (прямой
 *    postMessage IFrame API, как пауза фоновых вкладок tabs.ts) + pause()
 *    media-элементам обоих окон.
 *
 * Сервис и уведомление: канал «Фоновая музыка», перманентное уведомление с
 * «⏸» (PendingIntent в сервис), тап — вернуть приложение. MediaStyle не
 * используем (нет зависимости androidx.media): сессия нужна системе, вид —
 * простой.
 */
object MobileMediaHelper {
  private const val TAG = "DuoPulseMedia"

  /** Период зонда (мс): баланс «нотификация появляется вовремя» / лишние eval. */
  private const val POLL_MS = 2000L

  /** Порог прироста часов duo (с) между тиками: играет ⇒ ~POLL_MS прироста. */
  private const val CLOCK_ADVANCE = 0.15f

  private const val CHANNEL_ID = "duopulse_media"

  /** Действия сервиса: старт/пауза (play из шторки не нужен — см. шапку). */
  private const val ACTION_START = "dev.duopulse.media.START"
  private const val ACTION_PAUSE = "dev.duopulse.media.PAUSE"

  private var handler: Handler? = null
  private var serviceOn = false

  /** Минимальная жизнь сервиса после старта (мс): stopService ДО доставки
   *  startIntent отменяет обещанный startForeground — система роняет приложение
   *  (ForegroundServiceDidNotStartInTimeException, поймано смоуком duopulse-218);
   *  остановка не раньше, чем сервис гарантированно вышел в foreground. */
  private const val SERVICE_FLOOR_MS = 8000L

  /** Метка старта сервиса (elapsedRealtime) — пол остановки. */
  private var serviceStartedAt = 0L

  /** Отложенный останов (пол жизни): отменяется повторным стартом (флап зонда
   *  на границе порога прироста часов). */
  private var pendingStop: Runnable? = null

  /** Тихих тиков подряд перед остановкой: единичный «не играет» (буферизация,
   *  затык сети) не должен глушить музыку — стойкость против флапа. */
  private var quietTicks = 0

  /** Момент последнего «играет» зонда ПО ОКНУ (elapsedRealtime): латч против
   *  гонки «музыка только началась, тик ещё не видел прироста, а активность
   *  уже уходит в фон» — 8 с держат решение wantedNow() утвердительным.
   *  Раздельность важна реплею: играет web-оверлей — реплей tauri-окна
   *  перехватил бы аудио-фокус (фокус один на приложение). */
  private var lastUiPlayingAt = 0L
  private var lastOverlayPlayingAt = 0L

  /** Цикл погашен (активность разрушена): летящий колбэк зонда не должен
   *  поднять сервис заново — WebView'ы мертвы, музыки больше нет. */
  private var stopped = false

  // кэш последнего зонда (UI-нить: тики и колбэки evaluateJavascript там же)
  private var uiPlaying = false
  private var uiClock = -1.0
  private var uiVideoOpen = false
  private var overlayPlaying = false

  /** Запуск зонд-цикла (MainActivity.onCreate). */
  fun start() {
    if (handler != null) return
    stopped = false
    handler = Handler(Looper.getMainLooper())
    handler?.post(::tick)
  }

  private fun tick() {
    probe()
    handler?.postDelayed(::tick, POLL_MS)
  }

  /** Остановка всего (активность разрушена —WebView умирают вместе с ней). */
  fun shutdown() {
    stopped = true
    handler?.removeCallbacksAndMessages(null)
    handler = null
    stopPlayback()
    synchronized(shields) { shields.clear() }
  }

  /** Зонд обоих окон; колбэки сходятся на UI-нити и применяют переход. */
  private fun probe() {
    val tw = MainActivity.tauriWebView
    if (tw == null) {
      uiPlaying = false
      uiClock = -1.0
      uiVideoOpen = false
    } else {
      tw.evaluateJavascript(UI_PROBE) { r -> onUiProbe(r) }
    }
    MobileWebHelper.probeMedia { on ->
      overlayPlaying = on
      if (on) lastOverlayPlayingAt = android.os.SystemClock.elapsedRealtime()
      apply()
    }
  }

  /**
   * Зонд UI-webview: файловое видео + часы duo + признак открытой видео-вкладки
   * (оптимистичный старт при уходе в фон: плеер мог заиграть <2 с назад, зонд
   * прироста ещё не видел). Ответ — строка "f=0|c=123.456|v=1" (c=- : duo-сессии
   * нет), evaluateJavascript отдаёт её JSON-закодированной — снимаем кавычки.
   */
  private fun onUiProbe(raw: String?) {
    val parts = (raw ?: "")
      .trim()
      .removeSurrounding("\"")
      .split("|")
      .map { it.substringAfter('=') }
    val file = parts.getOrNull(0) == "1"
    val clock = parts.getOrNull(1)?.toDoubleOrNull()
    val videoOpen = parts.getOrNull(2) == "1"

    val advanced = uiClock >= 0 && clock != null && clock > uiClock + CLOCK_ADVANCE
    uiPlaying = file || advanced
    if (uiPlaying) lastUiPlayingAt = android.os.SystemClock.elapsedRealtime()
    uiClock = clock ?: -1.0
    uiVideoOpen = videoOpen
    apply()
  }

  /** Переход состояния: игра → сервис+сессия, тишина → погасить (два тихих
   *  тика подряд — стойкость к буферизационным затыкам одиночного тика). */
  private fun apply() {
    if (stopped) return
    if (uiPlaying || overlayPlaying) {
      quietTicks = 0
      startPlayback()
    } else {
      quietTicks++
      if (quietTicks >= 2) stopPlayback()
    }
  }

  /** Синхронное решение для onPause активности (см. onActivityPause): зонд
   *  живёт тиками по 2 с, между тиками «нажал play и сразу ушёл» решает
   *  оптимизм открытой видео-вкладки — фоновый цикл погасит лишнее за ≤4 с. */
  private fun wantedNow(): Boolean =
    uiPlaying || overlayPlaying || uiVideoOpen ||
      // латч: музыка играла в последние 8 с — гонка «музыка только началась,
      // тик зонда прироста ещё не видел, активность уже уходит» не должна
      // глушить только что включённую музыку (поймано смоуком duopulse-218)
      (lastUiPlayingAt > 0 &&
        android.os.SystemClock.elapsedRealtime() - lastUiPlayingAt < 8000L) ||
      (lastOverlayPlayingAt > 0 &&
        android.os.SystemClock.elapsedRealtime() - lastOverlayPlayingAt < 8000L)

  /**
   * Уход активности из поля зрения (MainActivity.onPause): решаем СИНХРОННО
   * до super — в super WryActivity гасит UI-webview (WebView.onPause), а
   * сразу за onPause окно уходит в GONE и Вид-система разносит
   * dispatchWindowVisibilityChanged вниз по дереву — оба события Chromium
   * трактует как «страница скрыта» и глушит медиа/рендерер (музыка обрывалась
   * мгновенно, смоук duopulse-218). Пока музыка играет: щит webView'ов
   * блокирует событие (страница остаётся «видимой»), super-пауза снимается
   * обратно, сервис поднимается ПОКА старт foreground ещё разрешён (между
   * onPause и onStop приложение ещё «на экране»). Возвращает keep-флаг
   * для второй половины (после super).
   */
  fun onActivityPauseBegin(): Boolean {
    val keep = wantedNow()
    if (keep) blockWindowEvents = true
    return keep
  }

  fun onActivityPauseEnd() {
    startPlayback()
    // Контрмеры с короткой задержкой: пауза WryActivity (mWebView.onPause)
    // ставит медиа на паузу, onResume сам воспроизведение НЕ возвращает, а
    // ранняя пара onPause/onResume может проиграть доотрабатывающей асинхронно
    // паузе wry (смоук duopulse-218: время видео в фоне вставало). 400 мс —
    // окно ещё видимо (onPause→onStop), паузы сошлись.
    MainActivity.tauriWebView?.postDelayed({
      val tw = MainActivity.tauriWebView ?: return@postDelayed
      tw.onResume()
      MobileWebHelper.resumeForBackground()
      // перезапуск ТОГО, что играло: решение самостоятельное (кэш зонда
      // ненадёжен в момент паузы — колбэк «тихо» от только что запауженного
      // WryActivity WebView способен сбросить uiPlaying прямо между тиками):
      // начатое видео в топ-документе ИЛИ свежие часы duo (кейс «нажал play
      // и сразу ушёл»). Реплей трогает только НАЧАТЫЕ элементы (currentTime>0)
      // — не заводить то, что пользователь ставил на паузу сам.
      tw.evaluateJavascript(
        "(function(){var s=false,c=null;" +
          "try{var q=document.querySelector('video');" +
          "if(q&&q.currentTime>0.1&&!q.ended)s=true}catch(e){}" +
          "try{var d=window.__duopulseMobileDuo?window.__duopulseMobileDuo():null;" +
          "if(d&&typeof d.clock==='number')c=d.clock}catch(e){}" +
          "return 's='+(s?1:0)+'|c='+(c===null?'-':c)})()"
      ) { fresh ->
        val parts = (fresh ?: "").removeSurrounding("\"").split("|")
          .map { it.substringAfter('=') }
        val started = parts.getOrNull(0) == "1"
        val clock = parts.getOrNull(1)?.toDoubleOrNull()
        // реплей трогает только TAURI-окно и только когда оно было источником:
        // играет web-оверлей — PLAY_JS в tauri перехватил бы аудио-фокус
        // (фокус один на приложение: WebView-«пауза по потере фокуса» гасила
        // музыку оверлея, поймано смоуком duopulse-218)
        val now = android.os.SystemClock.elapsedRealtime()
        val overlaySource = overlayPlaying || lastOverlayPlayingAt > 0 && now - lastOverlayPlayingAt < 8000L
        val tauriRecent = lastUiPlayingAt > 0 && now - lastUiPlayingAt < 8000L
        val tauriSource = uiPlaying ||
          (!overlaySource && tauriRecent && started) ||
          (!overlaySource && clock != null && uiClock >= 0 && clock > uiClock)
        if (tauriSource) {
          tw.evaluateJavascript(PLAY_JS, null)
          Log.d(TAG, "background-play: медиа перезапущено (started=$started clock=${clock ?: "-"})")
        } else {
          Log.d(TAG, "background-play: реплей не нужен (${if (overlayPlaying) "источник — оверлей" else "не играло"})")
        }
      }
      Log.d(TAG, "background-play: веб-окна держим активными (400 мс)")
    }, 400)
  }

  /** Возврат активности: щит снять (события видимости снова доходят),
   *  зонд сразу, не ждать тика. */
  fun onActivityResume() {
    blockWindowEvents = false
    probe()
  }

  // ── щит window-visibility (фоновая музыка) ─────────────────────────────

  /** Блокировать событие window-visibility для webView'ов (см. щит). */
  @Volatile var blockWindowEvents = false
    private set

  /** Для щита (MediaShieldView читает с любой нити). */
  @JvmStatic fun isWindowEventBlocked(): Boolean = blockWindowEvents

  /** Обёртки webView'ов (tauri + web-оверлей), гасящие window-visibility. */
  private val shields = ArrayList<MediaShieldView>()

  /** Обернуть WebView щитом на месте (layout-параметры сохраняются):
   *  пока играет фоновая музыка, GONE вниз не проходит — Chromium считает
   *  страницу видимой и не глушит медиа/CDP/рендерер. В момент вызова
   *  webview может быть ещё не в дереве (wry добавляет своим ходом) —
   *  короткий ретрай через post. */
  fun shield(wv: WebView) {
    wv.post { shieldNow(wv, 10) }
  }

  private fun shieldNow(wv: WebView, tries: Int) {
    val parent = wv.parent as? ViewGroup
    if (parent == null) {
      if (tries > 0) wv.post { shieldNow(wv, tries - 1) }
      else Log.d(TAG, "shield: не пристёгнут (нет родителя)")
      return
    }
    val idx = parent.indexOfChild(wv)
    if (idx < 0) return
    val lp = wv.layoutParams
    parent.removeView(wv)
    val shield = MediaShieldView(wv.context)
    shield.addView(wv, FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    parent.addView(shield, idx, lp)
    synchronized(shields) { if (!shields.contains(shield)) shields.add(shield) }
  }

  /** Разбор (webview умирает вместе с окном) — выкинуть щит из реестра. */
  fun unshield(wv: WebView) {
    val shield = wv.parent as? MediaShieldView ?: return
    synchronized(shields) { shields.remove(shield) }
  }

  /** Вернуть webView'ам честную видимость после снятия блока в фоне:
   *  страница снова «скрыта» — таймеры/рендерер троттлятся, батарея как
   *  до щита (на переднем плане событие VISIBLE и так придёт окном). */
  private fun repairHiddenState() {
    val act = MainActivity.current ?: return
    if (act.lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)) return
    synchronized(shields) {
      for (s in shields) s.dispatchToChildren(View.GONE)
    }
  }

  // ── сервис/сессия/уведомление ──────────────────────────────────────────

  private fun startPlayback() {
    if (serviceOn || stopped) return
    val act = MainActivity.current ?: return
    serviceOn = true
    pendingStop?.let { handler?.removeCallbacks(it) }
    pendingStop = null
    serviceStartedAt = android.os.SystemClock.elapsedRealtime()
    // POST_NOTIFICATIONS НЕ спрашиваем: системный диалог сам паузит
    // активность (пауза = реплей = фокус-кража, поймано смоуком duopulse-218),
    // а без разрешения foreground-сервис жив — не покажется лишь уведомление
    // БЕЗ MediaSession: активная сессия STATE_PLAYING сама перезахватывает
    // аудио-фокус у AudioFocusDelegate'ов WebView (война фокуса каждые ~2 с,
    // поймана смоуком duopulse-218 — Chromium гасил «своё» медиа по потере
    // фона). Сервису/уведомлению сессия не нужна: «⏸» идёт PendingIntent'ом
    // в сервис напрямую.
    try {
      ensureChannel(act)
      ContextCompat.startForegroundService(
        act, Intent(act, MediaPlaybackService::class.java).setAction(ACTION_START))
      Log.d(TAG, "playback-on: ${mediaTitle(act)}")
    } catch (e: Exception) {
      serviceOn = false
      Log.d(TAG, "playback-on сбой: ${e.message}")
    }
  }

  private fun stopPlayback() {
    if (!serviceOn) return
    serviceOn = false
    // музыка кончилась: щит больше не нужен — если приложение в фоне,
    // вернуть webView'ам честное «скрыто» (троттлинг таймеров/рендерера)
    if (blockWindowEvents) {
      blockWindowEvents = false
      repairHiddenState()
    }
    try {
      val act = MainActivity.current ?: return
      // пол жизни: мгновенный stopService после старта отменяет доставку
      // startIntent — сервис не выйдет в foreground, и система уронит
      // приложение (см. SERVICE_FLOOR_MS); выжидаем остаток полы
      val wait = SERVICE_FLOOR_MS -
        (android.os.SystemClock.elapsedRealtime() - serviceStartedAt)
      val stop = Runnable {
        try {
          act.stopService(Intent(act, MediaPlaybackService::class.java))
          Log.d(TAG, "playback-off")
        } catch (e: Exception) {
          Log.d(TAG, "playback-off сбой: ${e.message}")
        }
      }
      if (wait <= 0) stop.run()
      else {
        pendingStop?.let { handler?.removeCallbacks(it) }
        pendingStop = stop
        (handler ?: Handler(Looper.getMainLooper())).postDelayed(stop, wait)
      }
    } catch (e: Exception) {
      Log.d(TAG, "playback-off сбой: ${e.message}")
    }
  }

  /** Заголовок для сессии/уведомления: страница оверлея (если играет она)
   *  или просто duoPulse. */
  private fun mediaTitle(act: Context): String =
    (if (overlayPlaying) MobileWebHelper.mediaTitle() else null)
      ?.takeIf { it.isNotBlank() }
      ?: "duoPulse"

  private fun ensureChannel(act: Context) {
    val nm = act.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    nm.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "Фоновая музыка",
        NotificationManager.IMPORTANCE_LOW))
  }

  /** Перманентное уведомление сервиса (тот же id — обновления на месте). */
  fun notification(act: Context): Notification {
    val open = PendingIntent.getActivity(
      act, 0,
      Intent(act, MainActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val pause = PendingIntent.getService(
      act, 1,
      Intent(act, MediaPlaybackService::class.java).setAction(ACTION_PAUSE),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    return NotificationCompat.Builder(act, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_media_play)
      .setContentTitle("duoPulse")
      .setContentText("Музыка играет в фоне")
      .setOngoing(true)
      .setContentIntent(open)
      .addAction(android.R.drawable.ic_media_pause, "Пауза", pause)
      .setOnlyAlertOnce(true)
      .build()
  }

  // ── управление воспроизведением (шторка/медиа-кнопки) ──────────────────

  /** Пауза всей музыки обоих окон: postMessage pauseVideo в iframe-ы IFrame API
   *  (кросс-доменно, как пауза фоновых вкладок tabs.ts) + pause() media.
   *  Путь — кнопка «⏸» уведомления (PendingIntent → сервис). */
  fun dispatchPause() {
    val act = MainActivity.current ?: return
    act.runOnUiThread {
      MainActivity.tauriWebView?.evaluateJavascript(PAUSE_JS, null)
      MobileWebHelper.pauseMedia()
      Log.d(TAG, "pause-dispatch")
    }
  }

  /** Зонд UI-webview (см. onUiProbe): f — файловое видео играет, c — часы duo
   *  (секунды или -), v — открыта видео-вкладка. */
  private val UI_PROBE =
    "(function(){var f=0,c='-',v=0;" +
      "try{var q=document.querySelector('video');" +
      "if(q&&!q.paused&&!q.ended&&q.currentTime>0.1)f=1}catch(e){}" +
      "try{var d=window.__duopulseMobileDuo?window.__duopulseMobileDuo():null;" +
      "if(d&&typeof d.clock==='number')c=d.clock}catch(e){}" +
      "try{var h=window.__duopulseHeaderState?window.__duopulseHeaderState():null;" +
      "if(h&&h.video)v=1}catch(e){}" +
      "return 'f='+f+'|c='+c+'|v='+v})()"

  /** Пауза UI-webview: postMessage IFrame API доходит и до кросс-доменных
   *  embed-iframe YouTube (отправитель — топ-документ). */
  private val PAUSE_JS =
    "(function(){document.querySelectorAll('iframe').forEach(function(f){" +
      "try{f.contentWindow.postMessage(" +
      "JSON.stringify({event:'command',func:'pauseVideo',args:[]}),'*')}catch(e){}});" +
      "document.querySelectorAll('video,audio').forEach(function(m){" +
      "try{m.pause()}catch(e){}})})()"

  /** Реплей после снятия onPause-паузы (страница ещё видима — до onStop):
   *  только НАЧАТЫЕ элементы (currentTime>0 — не заводить то, что пользователь
   *  ставил на паузу сам) + playVideo в iframe-ы (кросс-доменно). */
  private val PLAY_JS =
    "(function(){document.querySelectorAll('video,audio').forEach(function(m){" +
      "try{if(m.currentTime>0&&!m.ended)m.play()}catch(e){}});" +
      "document.querySelectorAll('iframe').forEach(function(f){" +
      "try{f.contentWindow.postMessage(" +
      "JSON.stringify({event:'command',func:'playVideo',args:[]}),'*')}catch(e){}})})()"

  /** Сервис жив (для смоуков/диагностики). */
  fun isServiceOn(): Boolean = serviceOn

  /** Приоритет рендерера WebView — привязать к приоритету приложения и НЕ
   *  снижать в фоне (duopulse-082: фоновый рендерер замерзал; FGS поднимает
   *  приоритет процесса — рендерер наследует). API 26+. */
  fun bindRenderer(wv: WebView) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      try {
        wv.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_BOUND, false)
      } catch (e: Exception) {
        Log.d(TAG, "renderer-priority: ${e.message}")
      }
    }
  }
}

/** Обёртка-щит WebView (duopulse-218): пока играет фоновая музыка, событие
 *  window-visibility не проходит вниз — Chromium по GONE прячет страницу
 *  (медиа-пауза, троттлинг таймеров, суспензия рендерера — музыка браузера
 *  обрывалась мгновенно при уходе в другое приложение). Блок управляет
 *  MobileMediaHelper (blockWindowEvents), вне фоновой музыки поведение
 *  штатное — батарея не страдает. */
class MediaShieldView(context: Context) : FrameLayout(context) {
  override fun dispatchWindowVisibilityChanged(visibility: Int) {
    Log.d("DuoPulseMedia",
      "shield: visibility=$visibility blocked=${MobileMediaHelper.isWindowEventBlocked()}")
    if (MobileMediaHelper.isWindowEventBlocked()) {
      // событие гасим на себе (собственное состояние вида честно),
      // детям (WebView) не отдаём
      onWindowVisibilityChanged(visibility)
      return
    }
    super.dispatchWindowVisibilityChanged(visibility)
  }

  /** Принудительно доставить видимость детям (снятие щита в фоне). */
  fun dispatchToChildren(visibility: Int) {
    for (i in 0 until childCount) getChildAt(i).dispatchWindowVisibilityChanged(visibility)
  }
}

/** Сервис фоновой музыки (duopulse-218): перманентное уведомление + тип
 *  mediaPlayback (Android 14+ требует тип и разрешение
 *  FOREGROUND_SERVICE_MEDIA_PLAYBACK); «⏸» уведомления — пауза медиа окон.
 *  startForeground исполняется на КАЖДОМ onStartCommand (даже «пауза»):
 *  startForegroundService обещает foreground — пропущенный вызов роняет
 *  приложение (ForegroundServiceDidNotStartInTimeException). */
class MediaPlaybackService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val n = MobileMediaHelper.notification(this)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      ServiceCompat.startForeground(
        this, 218, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
    } else {
      startForeground(218, n)
    }
    if (intent?.action == "dev.duopulse.media.PAUSE") {
      MobileMediaHelper.dispatchPause()
    }
    return START_NOT_STICKY
  }
}
