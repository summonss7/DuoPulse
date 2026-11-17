package dev.duopulse.mobile

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Log
import java.io.File

/*
 * Приём видео из системы (карточка duopulse-179, паттерн MobilePdfHelper
 * duopulse-119): intent-filter ACTION_VIEW на mime «video, любой subtype»
 * делает DuoPulse кандидатом «Открыть с помощью». Контентный URI живёт,
 * пока жив источник, — копируем поток в cache/video/<ts>-<имя> и держим
 * pending-строку; фронтенд забирает её командой mobile_video_take (старт +
 * возврат фокуса) и играет файл <video> через протокол mobilevideo (Rust).
 * Исключения гасятся здесь и уходят строкой «error: …» (как MobilePdfHelper).
 */
object MobileVideoHelper {
    private const val TAG = "DuoPulseVideo"
    @Volatile private var pending: String = ""
    // duopulse-124 (как у PDF): копирование идёт в фоне, а take фронтенд
    // зовёт сразу (холодный старт/onNewIntent) — без флага файл терялся.
    @Volatile private var copying: Boolean = false
    // сколько копий держать в cache/video: видео тяжёлые, копий без чистки
    // набегает на гигабайты (у PDF чистки нет — PDF-то маленькие)
    private const val KEEP_COPIES = 4

    /** Вызывается из MainActivity (onCreate/onNewIntent), копирование — в фоне.
     *  VIEW — «Открыть с помощью» (URI в intent.data); SEND/SEND_MULTIPLE —
     *  «Поделиться» (URI в EXTRA_STREAM). Пустой mime пропускаем, как у PDF:
     *  фильтр мог сработать по pathPattern (файл .mp4 без type). */
    @JvmStatic
    fun handle(context: Context, intent: Intent?) {
        val action = intent?.action
        val mime = intent?.type ?: ""
        val video = mime.isEmpty() || mime.startsWith("video/", ignoreCase = true)
        if (!video) return
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
                // duopulse-141 (как у PDF): контентный URI без grant — маркер,
                // Rust/фронтенд заменят исключение человеческой подсказкой
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
        val dir = File(context.cacheDir, "video")
        dir.mkdirs()
        val name = displayName(context, data)
        val out = File(dir, "${System.currentTimeMillis()}-$name")
        context.contentResolver.openInputStream(data)?.use { input ->
            out.outputStream().use { input.copyTo(it) }
        } ?: throw IllegalStateException("поток недоступен: $data")
        Log.d(TAG, "copied ${out.name} (${out.length()} B)")
        trimOld(dir)
        return "${out.absolutePath}\t$name"
    }

    /** Копии тяжёлые — держим только последние KEEP_COPIES (старые — вон).
     *  Отказы удаления молчат: это чистка, не работа с файлом пользователя. */
    private fun trimOld(dir: File) {
        try {
            val files = dir.listFiles()?.filter { it.isFile } ?: return
            if (files.size <= KEEP_COPIES) return
            files.sortedByDescending { it.lastModified() }
                .drop(KEEP_COPIES - 1)
                .forEach {
                    if (it.delete()) Log.d(TAG, "trimmed old copy ${it.name}")
                }
        } catch (_: Exception) {
        }
    }

    private fun displayName(context: Context, data: Uri): String {
        // duopulse-141 (как у PDF): query может быть запрещён, когда поток
        // читается — отказ запроса имени не должен ронять копию
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
        return sanitize(data.lastPathSegment ?: "video.mp4")
    }

    /** Имя файла без разделителей пути; расширение оставляем исходным —
     *  контейнер (avi/mov/…) определяет сниффер Chromium, а не наш список. */
    private fun sanitize(raw: String): String {
        val n = raw.replace(Regex("[\\\\/:*?\"<>|]"), "_").trim()
        return n.ifEmpty { "video.mp4" }
    }
}
