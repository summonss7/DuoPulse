package dev.duopulse.mobile

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File

/*
 * OTA-установка APK (duopulse-083, эталон novagrid-063): вся Android-логика —
 * здесь, Rust (src-tauri/src/mobile_updater.rs) вызывает один статический
 * метод — минимальная JNI-поверхность, исключения гасятся в Kotlin и
 * возвращаются строкой ('started' | 'needs-permission' | 'file-gone' |
 * 'error: …'). APK лежит в cacheDir/updates (FileProvider шаблона шарит
 * cache-path, file_paths.xml).
 */
object MobileUpdateHelper {
  @JvmStatic
  fun install(context: Context, path: String): String {
    try {
      val file = File(path)
      if (!file.isFile) return "file-gone"
      if (!context.packageManager.canRequestPackageInstalls()) {
        context.startActivity(
          Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        return "needs-permission"
      }
      val uri = FileProvider.getUriForFile(context, "dev.duopulse.mobile.fileprovider", file)
      context.startActivity(
        Intent(Intent.ACTION_VIEW)
          .setDataAndType(uri, "application/vnd.android.package-archive")
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
      return "started"
    } catch (e: Exception) {
      return "error: ${e.message}"
    }
  }
}
