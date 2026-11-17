package dev.duopulse.mobile

import android.util.Log

/*
 * JNI-мост захвата паролей web-оверлея (карточка duopulse-165, паритет 2/8
 * аудита duopulse-156): кандидат из формы логина уходит в Core напрямую —
 * экспорты Java_dev_duopulse_mobile_MobilePassNative_* в
 * src-tauri/src/mobile_pass.rs (тот же процесс, .so приложения). Инкогнито/
 * denylist/«заслужен ли бар» решает Core (PasswordPrompts), событие в UI —
 * без пароля; пароль не проходит через консоль, logcat и UI-webview.
 *
 * Обёртки гасят любые сбои (как MobileAdblockNative): серфинг не должен
 * падать из-за захвата паролей — сбой = тихо пропустить.
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

  /** Кандидат с формы (URL/заголовок — доверенные, от MobileWebHelper). */
  @JvmStatic external fun reportCandidate(
    username: String, password: String, url: String, title: String)

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

  @JvmStatic fun report(username: String, password: String, url: String, title: String) {
    if (!ready) return
    try {
      reportCandidate(username, password, url, title)
    } catch (e: Throwable) {
      Log.w(TAG, "pass-report: сбой JNI ($e)")
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
