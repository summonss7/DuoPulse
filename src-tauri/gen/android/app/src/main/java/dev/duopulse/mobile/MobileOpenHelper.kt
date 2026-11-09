package dev.duopulse.mobile

import android.content.Context
import android.content.Intent
import android.net.Uri

/*
 * Внешнее открытие ссылок (duopulse-085): мобильная ветка встраивает в iframe
 * только YouTube-плеер — google.com, страницы поиска и прочие сайты с
 * X-Frame-Options в iframe не открываются вовсе. Такие адреса уходят в
 * системный браузер: Rust (src-tauri/src/mobile_open.rs) валидирует схему
 * (только http/https) и зовёт один статический метод — как в
 * MobileUpdateHelper: минимальная JNI-поверхность, исключения гасятся здесь
 * и возвращаются строкой ('opened' | 'error: …', нет браузера — тоже error).
 */
object MobileOpenHelper {
  @JvmStatic
  fun open(context: Context, url: String): String {
    return try {
      context.startActivity(
        Intent(Intent.ACTION_VIEW, Uri.parse(url))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      "opened"
    } catch (e: Exception) {
      "error: ${e.message}"
    }
  }
}
