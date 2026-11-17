package dev.duopulse.mobile

import android.util.Log

/*
 * JNI-мост паролей web-оверлея (карточка duopulse-165 — захват, duopulse-166
 * — автозаполнение; паритет 2/8 и 3/8 аудита duopulse-156): кандидат из
 * формы логина уходит в Core напрямую, автозаполнение спрашивает Core —
 * экспорты Java_dev_duopulse_mobile_MobilePassNative_* в
 * src-tauri/src/mobile_pass.rs (тот же процесс, .so приложения). Инкогнито/
 * denylist/«заслужен ли бар» решает Core (PasswordPrompts), событие в UI —
 * без пароля; пароль не проходит через консоль, logcat и UI-webview.
 *
 * Обёртки гасят любые сбои (как MobileAdblockNative): серфинг не должен
 * падать из-за паролей — сбой = тихо пропустить. credential() возвращает
 * пароль только вызывающему (MobileWebHelper → evaluateJavascript полей) —
 * не логировать и не сохранять.
 */
object MobilePassNative {
  private const val TAG = "DuoPulseWeb"

  /** .so приложения (грузит и tauri-рантайм; повторная загрузка — no-op). */
  private val ready = try {
    System.loadLibrary("duopulse_lib"); true
  } catch (e: Throwable) {
    Log.w(TAG, "pass: libduopulse_lib не загружена — захват недоступен")
    false
  }

  /** JS-пейлоад детекта формы логина (include_str! в Rust, источник
   *  src-tauri/src/mobile_pass_capture.js); пусто — инжектировать нечего. */
  @JvmStatic external fun captureScript(): String?

  /** JS-пейлоад автозаполнения (duopulse-166, mobile_pass_fill.js). */
  @JvmStatic external fun fillScript(): String?

  /** Кандидат с формы (URL/заголовок — доверенные, от MobileWebHelper). */
  @JvmStatic external fun reportCandidate(
    username: String, password: String, url: String, title: String)

  /** Логины сайта для автозаполнения: JSON-массив usernames (БЕЗ паролей);
   *  инкогнито/недоступный Core — «[]». URL — доверенный (webView.url). */
  @JvmStatic external fun accountsFor(url: String): String?

  /** Пароль выбранного логина (reveal по факту выбора в листе): null — нет
   *  логина/инкогнито/сбой. Не логировать и не сохранять. */
  @JvmStatic external fun credentialFor(url: String, username: String): String?

  /** Забыть ожидающего кандидата (закрылся web-оверлей). */
  @JvmStatic external fun reset()

  // --- безопасные обёртки (зовёт MobileWebHelper) --------------------------

  @JvmStatic fun script(): String? =
    if (!ready) null
    else try {
      captureScript()
    } catch (e: Throwable) {
      Log.w(TAG, "pass-capture: сбой JNI — пропускаю ($e)"); null
    }

  @JvmStatic fun fill(): String? =
    if (!ready) null
    else try {
      fillScript()
    } catch (e: Throwable) {
      Log.w(TAG, "pass-fill: сбой JNI — пропускаю ($e)"); null
    }

  @JvmStatic fun report(username: String, password: String, url: String, title: String) {
    if (!ready) return
    try {
      reportCandidate(username, password, url, title)
    } catch (e: Throwable) {
      Log.w(TAG, "pass-report: сбой JNI ($e)")
    }
  }

  /** JSON-массив логинов сайта (без паролей); null — сбой JNI (тихо). */
  @JvmStatic fun accounts(url: String): String? {
    if (!ready) return null
    return try {
      accountsFor(url)
    } catch (e: Throwable) {
      Log.w(TAG, "pass-accounts: сбой JNI ($e)"); null
    }
  }

  /** Пароль логина (только в память вызывающего; null — нет/сбой). */
  @JvmStatic fun credential(url: String, username: String): String? {
    if (!ready) return null
    return try {
      credentialFor(url, username)
    } catch (e: Throwable) {
      Log.w(TAG, "pass-credential: сбой JNI ($e)"); null
    }
  }

  @JvmStatic fun resetPending() {
    if (!ready) return
    try {
      reset()
    } catch (e: Throwable) {
      /* сброс — не критичный путь */
    }
  }
}
