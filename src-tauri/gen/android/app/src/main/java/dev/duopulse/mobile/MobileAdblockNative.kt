package dev.duopulse.mobile

import android.util.Log

/*
 * JNI-мост к движку блокировщика Rust (карточка duopulse-144): тот же
 * adblock-rs-движок, что у десктопа (EasyList + uBO + quick-fixes, сетевая
 * фильтрация/косметика/скриптлеты), живёт в libduopulse_lib.so — экспорты
 * Java_dev_duopulse_mobile_MobileAdblockNative_* (src-tauri/src/mobile_adblock.rs).
 * Списки качаются и кэшируются Core в profile/filters (суточное фоновое
 * обновление), тумблер — settings.json мобильного профиля (переживает
 * перезапуск). Вызовы идут с нитей загрузчика WebView (shouldInterceptRequest)
 * — движок в Rust за мьютексом, спроектирован на горячий путь.
 *
 * Обёртки над external-методами гасят любые сбои (нет .so, движок ещё
 * собирается, JNI-исключение): серфинг не должен падать из-за блокировщика —
 * «не решили» = false/пусто, сетевой слой оверлея остаётся на прежнем
 * поведении (лёгкий хост-лист duopulse-139).
 */
object MobileAdblockNative {
  private const val TAG = "DuoPulseWeb"

  /** .so приложения (грузит и tauri-рантайм; повторная загрузка — no-op).
   *  Недоступна — мост молчит, external-вызов бросит UnsatisfiedLinkError,
   *  обёртки его гасят. */
  private val ready = try {
    System.loadLibrary("duopulse_lib"); true
  } catch (e: Throwable) {
    Log.w(TAG, "adblock: libduopulse_lib не загружена — движок недоступен")
    false
  }

  /** Сетевое решение движка (тип запроса Core выводит из URL/Accept:
   *  Android тип ресурса не раскрывает). */
  @JvmStatic
  external fun shouldBlock(
    url: String, pageUrl: String, referer: String, accept: String, isMain: Boolean
  ): Boolean

  /** JS-пейлоад косметики (скриптлеты + hide-селекторы) под evaluateJavascript;
   *  пусто/null — применять нечего (выключен/списки грузятся/исключение). */
  @JvmStatic external fun cosmeticScript(url: String): String?

  /** Тумблер из settings.json (общий с десктопом ключ "adblock"). */
  @JvmStatic external fun isEnabled(): Boolean

  /** Изменить тумблер (пишет settings.json — состояние переживает рестарт). */
  @JvmStatic external fun setEnabled(on: Boolean)

  /** JSON-снапшот состояния (счётчики/списки/готовность) — e2e-диагностика. */
  @JvmStatic external fun status(): String?

  // --- безопасные обёртки (зовёт MobileWebHelper) --------------------------

  @JvmStatic fun engineBlocks(
    url: String, pageUrl: String, referer: String, accept: String, isMain: Boolean
  ): Boolean =
    ready && try {
      shouldBlock(url, pageUrl, referer, accept, isMain)
    } catch (e: Throwable) {
      Log.w(TAG, "adblock-engine: сбой JNI — пропускаю ($e)"); false
    }

  @JvmStatic fun cosmeticFor(url: String): String? =
    if (!ready) null
    else try {
      cosmeticScript(url)
    } catch (e: Throwable) {
      Log.w(TAG, "adblock-cosmetic: сбой JNI — пропускаю ($e)"); null
    }

  @JvmStatic fun adblockEnabled(): Boolean =
    ready && try {
      isEnabled()
    } catch (e: Throwable) {
      false
    }

  @JvmStatic fun setAdblockEnabled(on: Boolean) {
    if (!ready) return
    try {
      setEnabled(on)
    } catch (e: Throwable) {
      Log.w(TAG, "adblock-toggle: сбой JNI ($e)")
    }
  }

  /** Статус одной строкой в logcat — смоук карточки читает готовность/счётчик. */
  @JvmStatic fun logStatus() {
    if (!ready) return
    try {
      Log.d(TAG, "adblock-status: ${status() ?: "{}"}")
    } catch (e: Throwable) {
      /* диагностика — тишина допустима */
    }
  }
}
