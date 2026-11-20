package dev.duopulse.mobile

import android.util.Log

/*
 * JNI-мост закладок web-оверлея (карточка duopulse-193): пункты «☆ В закладки»
 * и «★ Закладки» меню «⋮» оверлея. Тот же HistoryStore Core (SQLite профиля),
 * что у команд history.* мобильной ветки, — страница закладится в дефолтную
 * группу «Избранное» и уедет в синк аккаунта Aila; экспорты
 * Java_dev_duopulse_mobile_MobileBookmarksNative_* — src-tauri/src/mobile_history.rs.
 *
 * Обёртки гасят любые сбои (как MobileAdblockNative/MobilePassNative): сбой =
 * «не в закладках»/без изменений, серфинг не страдает.
 */
object MobileBookmarksNative {
  private const val TAG = "DuoPulseWeb"

  /** .so приложения (грузит и tauri-рантайм; повторная загрузка — no-op). */
  private val ready = try {
    System.loadLibrary("duopulse_lib"); true
  } catch (e: Throwable) {
    Log.w(TAG, "bookmarks: libduopulse_lib не загружена — закладки оверлея недоступны")
    false
  }

  /** Есть ли закладка с этим url (☆/★ в меню). */
  @JvmStatic external fun hasBookmark(url: String): Boolean

  /** Переключить закладку (добавить с заголовком / удалить); новое состояние. */
  @JvmStatic external fun toggleBookmark(url: String, title: String): Boolean

  // --- безопасные обёртки (зовёт MobileWebHelper) --------------------------

  @JvmStatic fun has(url: String): Boolean =
    if (!ready) false
    else try {
      hasBookmark(url)
    } catch (e: Throwable) {
      Log.w(TAG, "bookmarks-has: сбой JNI ($e)"); false
    }

  @JvmStatic fun toggle(url: String, title: String): Boolean =
    if (!ready) false
    else try {
      toggleBookmark(url, title)
    } catch (e: Throwable) {
      Log.w(TAG, "bookmarks-toggle: сбой JNI ($e)"); false
    }
}
