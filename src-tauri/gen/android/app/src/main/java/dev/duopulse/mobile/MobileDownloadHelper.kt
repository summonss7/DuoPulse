package dev.duopulse.mobile

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File

/*
 * Перенос скачанной музыки в общую медиатеку (duopulse-121): Rust качает
 * аудиодорожку в cacheDir/music (mobile_download.rs), здесь файл появляется
 * у пользователя — на API ≥29 это MediaStore.Audio с RELATIVE_PATH
 * «Music/DuoPulse» (видят плееры и файл-менеджеры, разрешений не нужно —
 * запись своего вклада), ниже — каталог приложения Music без разрешений
 * (виден файл-менеджером по пути из ответа). Один статический вызов из Rust,
 * исключения гасятся здесь и возвращаются строкой ('ok: <где>' | 'error: …') —
 * как MobileOpenHelper (грабля R8 duopulse-102 держится proguard-keep).
 */
object MobileDownloadHelper {
  @JvmStatic
  fun saveMusic(context: Context, srcPath: String, displayName: String, mimeType: String): String {
    return try {
      val src = File(srcPath)
      if (!src.exists()) return "error: tmp-файла нет: $srcPath"
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
          put(MediaStore.Audio.Media.DISPLAY_NAME, displayName)
          put(MediaStore.Audio.Media.MIME_TYPE, mimeOf(mimeType))
          put(MediaStore.Audio.Media.RELATIVE_PATH, "Music/DuoPulse")
          put(MediaStore.Audio.Media.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, values)
          ?: return "error: медиатека не приняла запись"
        resolver.openOutputStream(uri)?.use { out -> src.inputStream().use { it.copyTo(out) } }
          ?: return "error: медиатека не отдала поток"
        val done = ContentValues().apply { put(MediaStore.Audio.Media.IS_PENDING, 0) }
        resolver.update(uri, done, null, null)
        "ok:Music/DuoPulse"
      } else {
        val dir = context.getExternalFilesDir(Environment.DIRECTORY_MUSIC)
          ?: return "error: внешний каталог недоступен"
        dir.mkdirs()
        val dest = File(dir, displayName)
        src.copyTo(dest, overwrite = true)
        "ok:${dest.absolutePath}"
      }
    } catch (e: Exception) {
      "error: ${e.message}"
    }
  }

  /** mimeType дорожки («audio/mp4; codecs=…») → чистый MIME для MediaStore. */
  private fun mimeOf(mimeType: String): String {
    val base = mimeType.substringBefore(';').trim().lowercase()
    return if (base.startsWith("audio/")) base else "audio/mp4"
  }
}
