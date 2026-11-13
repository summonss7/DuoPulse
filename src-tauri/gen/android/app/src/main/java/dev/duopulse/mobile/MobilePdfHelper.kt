package dev.duopulse.mobile

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import java.io.File

/*
 * Приём PDF из системы (карточка duopulse-119): intent-filter ACTION_VIEW
 * application/pdf делает DuoPulse кандидатом «Открыть с помощью» у файловых
 * менеджеров. Контентный URI живёт, пока жив источник, — копируем поток в
 * cache/pdf/<ts>-<имя>.pdf и держим pending-строку; фронтенд забирает её
 * командой mobile_pdf_take (старт + возврат фокуса) и читает документ
 * кусками (mobile_pdf_chunk, base64) для pdf.js. Исключения гасятся здесь
 * и уходят строкой «error: …» (как MobileOpenHelper).
 */
object MobilePdfHelper {
  @Volatile private var pending: String = ""
  // duopulse-124: копирование идёт в фоновом потоке, а mobile_pdf_take фронтенд
  // зовёт сразу (холодный старт/onNewIntent) — без флага take читал пустое
  // pending ДО окончания копирования и файл терялся («открылось, но пусто»).
  // Теперь take отвечает «busy», пока поток не положил результат.
  @Volatile private var copying: Boolean = false

  /** Вызывается из MainActivity (onCreate/onNewIntent), копирование — в фоне.
   *  VIEW — «Открыть с помощью» (URI в intent.data); SEND/SEND_MULTIPLE —
   *  «Поделиться» (URI в EXTRA_STREAM, фильтры те же — генерит tauri-CLI из
   *  fileAssociations). */
  @JvmStatic
  fun handle(context: Context, intent: Intent?) {
    val action = intent?.action
    val mime = intent?.type ?: ""
    val pdf = mime.isEmpty() || mime.equals("application/pdf", ignoreCase = true)
    if (!pdf) return
    val data: Uri? = when (action) {
      Intent.ACTION_VIEW -> intent?.data
      Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE ->
        @Suppress("DEPRECATION")
        intent?.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
      else -> null
    }
    if (data == null) return
    copying = true
    Thread {
      pending = try {
        copy(context, data)
      } catch (e: SecurityException) {
        // duopulse-141: контентный URI пришёл без grant (файловый менеджер
        // не выдал FLAG_GRANT_READ_URI_PERMISSION — восстановление интента
        // из «недавних», «всегда открывать» и т.п.): сырой текст исключения
        // («dev.duopulse.mobile has no access to content://…») пользователю
        // не показать — маркер, Rust/фронтенд заменят подсказкой
        "noperm"
      } catch (e: Exception) {
        "error: ${e.message}"
      }
      copying = false
    }.start()
  }

  /** pending для Rust: «path\tимя» | «error: …» | «busy» | «». Читается
   *  однократно; «busy» — копирование ещё идёт, фронтенд повторит take. */
  @JvmStatic
  fun take(): String {
    if (copying && pending.isEmpty()) return "busy"
    val v = pending
    pending = ""
    return v
  }

  private fun copy(context: Context, data: Uri): String {
    val dir = File(context.cacheDir, "pdf")
    dir.mkdirs()
    val name = displayName(context, data)
    val out = File(dir, "${System.currentTimeMillis()}-$name")
    context.contentResolver.openInputStream(data)?.use { input ->
      out.outputStream().use { input.copyTo(it) }
    } ?: throw IllegalStateException("поток недоступен: $data")
    return "${out.absolutePath}\t$name"
  }

  private fun displayName(context: Context, data: Uri): String {
    // duopulse-141: query может быть запрещён, когда сам поток читается
    // (разные пути разрешений у провайдеров) — отказ запроса имени не
    // должен ронять копию, откатываемся на последний сегмент URI
    try {
      context.contentResolver
        .query(data, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
        ?.use { c ->
          if (c.moveToFirst()) {
            val i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (i >= 0) c.getString(i)?.let { return sanitize(it) }
          }
        }
    } catch (_: Exception) {
    }
    return sanitize(data.lastPathSegment ?: "document.pdf")
  }

  /** Имя файла без разделителей пути; расширение .pdf — обязательно. */
  private fun sanitize(raw: String): String {
    val n = raw.replace(Regex("[\\\\/:*?\"<>|]"), "_").trim()
    val withExt = if (n.endsWith(".pdf", true)) n else "$n.pdf"
    return withExt.ifEmpty { "document.pdf" }
  }
}
