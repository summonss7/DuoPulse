package dev.duopulse.mobile

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context

/*
 * Системный буфер обмена для экрана паролей мобильной ветки (duopulse-112):
 * Rust-команда mobile_clipboard_copy (mobile_account.rs) зовёт один
 * статический метод — как MobileOpenHelper: минимальная JNI-поверхность,
 * исключения гасятся здесь и возвращаются строкой ('copied' | 'error: …').
 * navigator.clipboard из WebView требует фокус/жест и на части прошивок
 * молчит — нативный путь надёжнее.
 */
object MobileClipboardHelper {
  @JvmStatic
  fun copy(context: Context, text: String): String {
    return try {
      val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
      cm.setPrimaryClip(ClipData.newPlainText("DuoPulse", text))
      "copied"
    } catch (e: Exception) {
      "error: ${e.message}"
    }
  }
}
