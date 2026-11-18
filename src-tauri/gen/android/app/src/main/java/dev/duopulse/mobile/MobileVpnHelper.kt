package dev.duopulse.mobile

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Log
import org.json.JSONObject

/*
 * Импорт профиля WireGuard .conf (duopulse-171, паритет-мобайл 8/8 — панель
 * VPN): лист VPN зовёт системный файл-пикер SAF (ACTION_OPEN_DOCUMENT), хелпер
 * читает выбранный файл в текст и отдаёт его фронтенду глобалом
 * __duopulseVpnConfPicked в UI-webview (паттерн __duopulseVisit,
 * duopulse-156) — дальше текст уходит в Core командой
 * mobile_vpn_import_profile (контракт текста .conf не менялся).
 *
 * Поверхность JNI — как у MobileOpenHelper: статический (Context, String) →
 * String, исключения гасятся здесь и возвращаются строкой ('ok' |
 * 'error: …'). Результат пикера асинхронный: onActivityResult MainActivity
 * передаёт сюда (requestCode свой, конфликтов с file-chooser Wry нет);
 * чтание — в вызывающей нити onActivityResult (файл маленький, ≤64 КиБ).
 */
object MobileVpnHelper {
  private const val TAG = "DuoPulseVpn"
  private const val REQ_PICK_CONF = 47171
  private const val MAX_CONF_BYTES = 64 * 1024

  /** Пикер уже открыт — повторный invoke не должен плодить окна. */
  @Volatile private var picking = false

  /** Открыть системный пикер .conf (Rust — mobile_vpn_pick_conf). */
  @JvmStatic fun pick(context: Context, unused: String): String {
    val act = MainActivity.current ?: return "error: активность не готова"
    if (picking) return "error: выбор файла уже открыт"
    picking = true
    act.runOnUiThread {
      try {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
          addCategory(Intent.CATEGORY_OPENABLE)
          // .conf в системе почти всегда octet-stream/text/plain — фильтр по
          // расширению SAF не умеет, показываем все файлы (mime-подсказка)
          type = "*/*"
          putExtra(
            Intent.EXTRA_MIME_TYPES,
            arrayOf("application/octet-stream", "text/plain", "application/x-config"),
          )
        }
        @Suppress("DEPRECATION") // SAF-пикер без зависимостей: проще startActivityForResult
        act.startActivityForResult(intent, REQ_PICK_CONF)
      } catch (e: Exception) {
        picking = false
        Log.w(TAG, "файл-пикер не открылся: ${e.message}")
      }
    }
    return "ok"
  }

  /** Файл выбран: читаем текст и отдаём в UI-webview (MainActivity.onActivityResult). */
  fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
    if (requestCode != REQ_PICK_CONF) return false
    picking = false
    val uri: Uri? = data?.data
    if (resultCode != Activity.RESULT_OK || uri == null) {
      pushJs(JSONObject().put("error", "cancelled"))
      return true
    }
    val payload = try {
      val act = MainActivity.current
        ?: return true.also { Log.w(TAG, "активность ушла — файл не прочитан") }
      val bytes = act.contentResolver.openInputStream(uri).use { it?.readBytes() }
      if (bytes == null || bytes.isEmpty()) throw IllegalStateException("файл пуст")
      if (bytes.size > MAX_CONF_BYTES) {
        throw IllegalStateException("файл больше ${MAX_CONF_BYTES / 1024} КиБ — это не профиль WireGuard")
      }
      JSONObject()
        .put("name", displayName(act, uri))
        .put("text", String(bytes, Charsets.UTF_8))
    } catch (e: Exception) {
      Log.w(TAG, "чтение .conf: ${e.message}")
      JSONObject().put("error", e.message ?: "не удалось прочитать файл")
    }
    pushJs(payload)
    return true
  }

  /** Отображаемое имя файла ( DocumentsContract DISPLAY_NAME; нет — profile.conf). */
  private fun displayName(act: Activity, uri: Uri): String =
    act.contentResolver.query(uri, null, null, null, null)?.use { c ->
      if (c.moveToFirst()) {
        val i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (i >= 0) c.getString(i) else null
      } else null
    } ?: "profile.conf"

  /** Итог в UI-webview: window.__duopulseVpnConfPicked({name,text} | {error}). */
  private fun pushJs(payload: JSONObject) {
    val wv = MainActivity.tauriWebView
    if (wv == null) {
      Log.w(TAG, "UI-webview нет — итог пикера потерян")
      return
    }
    wv.post { wv.evaluateJavascript("window.__duopulseVpnConfPicked && window.__duopulseVpnConfPicked($payload)", null) }
  }
}
