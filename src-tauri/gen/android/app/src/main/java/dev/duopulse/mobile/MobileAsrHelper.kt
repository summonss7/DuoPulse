package dev.duopulse.mobile

/*
 * Локальный ASR-движок мобильной ветки (duopulse-168, паритет 5/8 аудита
 * duopulse-156): тонкая JNI-обёртка libwhisperjni.so — whisper.cpp ревизии
 * десктопного спайка + шим cpp/whisper_jni.cpp, сборка — gradle
 * externalNativeBuild (cpp/CMakeLists.txt). Руст-провайдер (asr/engine.rs,
 * local_jni) зовёт эти статические методы по JNI через mobile_jni.rs — как
 * MobileKeystoreHelper/MobileOpenHelper. Возврат транскрипции — JSON
 * verbose_json-формы, ошибки — строкой "error: …"; JVM-исключения гасятся
 * вызывающей стороной (with_jni). Класс в release держит proguard-keep
 * (грабля duopulse-083/102: без Java-ссылок R8 вырезает методы).
 */
object MobileAsrHelper {
  init {
    System.loadLibrary("whisperjni")
  }

  /** Загрузить модель ggml (0 — ошибка). threads — потоков whisper. */
  @JvmStatic
  external fun nativeInit(modelPath: String, threads: Int): Long

  /** Транскрибировать PCM 16 кГц моно (i16 LE байтами): JSON verbose_json
   * (сегменты с таймингами) либо "error: …". lang пустой/"auto" — авто-язык. */
  @JvmStatic
  external fun nativeTranscribe(ctx: Long, pcm16Le: ByteArray, lang: String, prompt: String): String

  /** Выгрузить модель (простой 10 мин — Rust-менеджер; удаление модели). */
  @JvmStatic
  external fun nativeFree(ctx: Long)
}
