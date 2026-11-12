package dev.duopulse.mobile

import android.content.ContentValues
import android.content.Context
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.WebView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.File
import java.nio.ByteBuffer

/*
 * Загрузки мобильной ветки (duopulse-121 → duopulse-122): сохранение готовых
 * файлов в общую медиатеку и склейка видео+звук. Rust собирает файлы в
 * cacheDir/downloads (mobile_download.rs), здесь они появляются у
 * пользователя — на API ≥29 это MediaStore с RELATIVE_PATH (видят плееры,
 * галерея и файл-менеджеры, разрешений не нужно — запись своего вклада),
 * ниже — каталог приложения без разрешений (виден файл-менеджером по пути
 * из ответа). Один статический вызов из Rust, исключения гасятся здесь и
 * возвращаются строкой ('ok: <где>' | 'error: …') — как MobileOpenHelper
 * (грабля R8 duopulse-102 держится proguard-keep).
 *
 * duopulse-122: registerFetcher — document-start скрипт assets/duopulse/
 * dl-fetcher.js в youtube-фреймы (embed-плеер): медиа качает fetch внутри
 * youtube-документа (googlevideo 403 нативным клиентам и CORS только для
 * youtube origin — см. шапку dl-fetcher.js), байты идут postMessage →
 * invoke в Rust. muxAndSave — склейка видеодорожки и аудио в один MP4
 * (MediaExtractor+MediaMuxer, дорожки уже сжаты — перекодирования нет).
 */
object MobileDownloadHelper {
  private const val COLLECTION_AUDIO = "audio"
  private const val COLLECTION_VIDEO = "video"
  private const val COLLECTION_DOWNLOADS = "downloads"

  @JvmStatic
  fun saveMusic(context: Context, srcPath: String, displayName: String, mimeType: String): String {
    return saveMedia(context, srcPath, displayName, mimeType, COLLECTION_AUDIO)
  }

  /** Регистрация dl-fetcher (duopulse-122): document-start скрипт только в youtube-документах. */
  @JvmStatic
  fun registerFetcher(webView: WebView) {
    try {
      if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
      val js = webView.context.assets.open("duopulse/dl-fetcher.js")
        .use { it.readBytes().toString(Charsets.UTF_8) }
      WebViewCompat.addDocumentStartJavaScript(webView, js, setOf("https://www.youtube.com"))
    } catch (e: Exception) {
      // загрузка честно скажет «YouTube не отвечает» — старт приложения не роняем
    }
  }

  /**
   * Перенос готового файла в медиатеку по коллекции: audio → Music/DuoPulse,
   * video → Movies/DuoPulse, downloads → Download/DuoPulse (субтитры).
   * API <29 — в каталог приложения соответствующего типа.
   */
  @JvmStatic
  fun saveMedia(
    context: Context,
    srcPath: String,
    displayName: String,
    mimeType: String,
    collection: String,
  ): String {
    return try {
      val src = File(srcPath)
      if (!src.exists()) return "error: tmp-файла нет: $srcPath"
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        val resolver = context.contentResolver
        val (uri, relPath, mime) = when (collection) {
          COLLECTION_VIDEO -> Triple(
            MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
            Environment.DIRECTORY_MOVIES + "/DuoPulse",
            "video/mp4",
          )
          COLLECTION_DOWNLOADS -> Triple(
            MediaStore.Downloads.EXTERNAL_CONTENT_URI,
            Environment.DIRECTORY_DOWNLOADS + "/DuoPulse",
            mimeOf(mimeType, "text/plain"),
          )
          else -> Triple(
            MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
            Environment.DIRECTORY_MUSIC + "/DuoPulse",
            mimeOf(mimeType, "audio/mp4"),
          )
        }
        val values = ContentValues().apply {
          put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
          put(MediaStore.MediaColumns.MIME_TYPE, mime)
          put(MediaStore.MediaColumns.RELATIVE_PATH, relPath)
          put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val target = resolver.insert(uri, values)
          ?: return "error: медиатека не приняла запись"
        resolver.openOutputStream(target)?.use { out -> src.inputStream().use { it.copyTo(out) } }
          ?: return "error: медиатека не отдала поток"
        val done = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
        resolver.update(target, done, null, null)
        "ok:$relPath"
      } else {
        val type = when (collection) {
          COLLECTION_VIDEO -> Environment.DIRECTORY_MOVIES
          COLLECTION_DOWNLOADS -> Environment.DIRECTORY_DOWNLOADS
          else -> Environment.DIRECTORY_MUSIC
        }
        val dir = context.getExternalFilesDir(type)
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

  /**
   * Склейка видеодорожки и аудио в один MP4 (duopulse-122): YouTube отдаёт
   * видео и звук раздельными fMP4-дорожками (DASH), мобильного ffmpeg нет —
   * сэмплы перекладываются MediaExtractor → MediaMuxer без перекодирования
   * (кодеки avc1+mp4a в MP4-контейнере поддержаны всегда). Готовый файл — в
   * медиатеку Movies/DuoPulse, исходники и результат склейки удаляются.
   */
  @JvmStatic
  fun muxAndSave(context: Context, videoPath: String, audioPath: String, displayName: String): String {
    val muxed = File(context.cacheDir, "downloads/mux-${System.currentTimeMillis()}.mp4")
    try {
      muxed.parentFile?.mkdirs()
      mux(File(videoPath), File(audioPath), muxed)
      return saveMedia(context, muxed.absolutePath, displayName, "video/mp4", COLLECTION_VIDEO)
    } catch (e: Exception) {
      return "error: склейка: ${e.message}"
    } finally {
      muxed.delete()
      File(videoPath).delete()
      File(audioPath).delete()
    }
  }

  /** Перекладывание сэмплов двух дорожек в один контейнер по возрастанию pts. */
  private fun mux(video: File, audio: File, out: File) {
    val vExt = MediaExtractor()
    val aExt = MediaExtractor()
    var muxer: MediaMuxer? = null
    try {
      vExt.setDataSource(video.absolutePath)
      aExt.setDataSource(audio.absolutePath)
      var vTrack = -1
      for (i in 0 until vExt.trackCount) {
        if (vExt.getTrackFormat(i).getString(MediaFormat.KEY_MIME)?.startsWith("video/") == true) {
          vTrack = i
          break
        }
      }
      var aTrack = -1
      for (i in 0 until aExt.trackCount) {
        if (aExt.getTrackFormat(i).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true) {
          aTrack = i
          break
        }
      }
      if (vTrack < 0 || aTrack < 0) throw IllegalStateException("дорожка не найдена")
      vExt.selectTrack(vTrack)
      aExt.selectTrack(aTrack)
      muxer = MediaMuxer(out.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      val vOut = muxer.addTrack(vExt.getTrackFormat(vTrack))
      val aOut = muxer.addTrack(aExt.getTrackFormat(aTrack))
      muxer.start()

      val buf = ByteBuffer.allocate(4 * 1024 * 1024)
      val info = MediaCodec.BufferInfo()
      var vDone = false
      var aDone = false
      while (!vDone || !aDone) {
        // следующий сэмпл — той дорожки, где pts меньше (MediaMuxer требует
        // монотонного времени на трек; чередование даёт играбельный файл)
        val vPts = if (vDone) Long.MAX_VALUE else vExt.sampleTime
        val aPts = if (aDone) Long.MAX_VALUE else aExt.sampleTime
        val useVideo = vPts <= aPts
        val ext = if (useVideo) vExt else aExt
        val outTrack = if (useVideo) vOut else aOut
        val size = ext.readSampleData(buf, 0)
        if (size < 0) {
          if (useVideo) vDone = true else aDone = true
          continue
        }
        info.offset = 0
        info.size = size
        info.presentationTimeUs = ext.sampleTime
        // из флагов экстрактора валиден только бит ключевого кадра
        info.flags = ext.sampleFlags and MediaCodec.BUFFER_FLAG_KEY_FRAME
        muxer.writeSampleData(outTrack, buf, info)
        ext.advance()
      }
    } finally {
      try { muxer?.stop() } catch (e: Exception) { /* частичный файл словит валидация длины */ }
      muxer?.release()
      vExt.release()
      aExt.release()
    }
    if (out.length() <= 0) throw IllegalStateException("пустой результат склейки")
  }

  /** mimeType дорожки («audio/mp4; codecs=…») → чистый MIME для MediaStore. */
  private fun mimeOf(mimeType: String, fallback: String): String {
    val base = mimeType.substringBefore(';').trim().lowercase()
    return if (base.contains('/')) base else fallback
  }
}
