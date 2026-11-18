// DuoPulse — JNI-шим локального ASR-движка (карточка duopulse-168, паритет
// 5/8): три нативных метода MobileAsrHelper.kt поверх C-API whisper.cpp
// (ревизия та же, что у десктопного спайка e2e/asr — пин в CMakeLists.txt):
//
//   nativeInit(modelPath, threads) → контекст (0 — ошибка)
//   nativeTranscribe(ctx, pcm16le, lang, prompt) → JSON «verbose_json»-формы
//       {"detected_language":"en","segments":[{"start":0.0,"end":1.5,"text":"…"}]}
//       — Rust (asr/engine.rs local_jni) разбирает его общим parse_verbose_json,
//       тем же кодом, что ответы whisper-server и облака.
//   nativeFree(ctx)
//
// Ошибки — строкой "error: …" (конвенция JNI-хелперов проекта). Сегментные
// t0/t1 у whisper.cpp — САНТИСЕКУНДЫ (см. whisper.h «in centiseconds»), в
// JSON уходят секундами t/100. PCM — i16 LE → f32 /32768 в шиме.

#include <jni.h>

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "whisper.h"

// Потоков у контекста: инициализируется nativeInit, читается nativeTranscribe
// (у приложения один контекст — Rust-менеджер engine.rs local_jni).
static std::atomic<int> g_threads(4);

// Экранирование JSON-строк (текст сегментов whisper — произвольный UTF-8).
static std::string json_escape(const char *s) {
    std::string out;
    for (const unsigned char *p = (const unsigned char *)s; *p; ++p) {
        switch (*p) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b";  break;
            case '\f': out += "\\f";  break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:
                if (*p < 0x20) {
                    char buf[8];
                    snprintf(buf, sizeof buf, "\\u%04x", *p);
                    out += buf;
                } else {
                    out += (char)*p; // UTF-8 проходит как есть
                }
        }
    }
    return out;
}

// JNI NewStringUTF ждёт «modified UTF-8» (4-байтовых кодов там нет) — whisper
// может отдать суррогатные пары (эмодзи в речи), поэтому строим UTF-16 сами.
static jstring utf8_to_jstring(JNIEnv *env, const std::string &s) {
    std::vector<jchar> u16;
    u16.reserve(s.size());
    size_t i = 0;
    while (i < s.size()) {
        uint32_t cp = 0;
        unsigned char c = (unsigned char)s[i];
        int extra = 0;
        if (c < 0x80) {
            cp = c;
        } else if ((c & 0xE0) == 0xC0) {
            cp = c & 0x1F; extra = 1;
        } else if ((c & 0xF0) == 0xE0) {
            cp = c & 0x0F; extra = 2;
        } else if ((c & 0xF8) == 0xF0) {
            cp = c & 0x07; extra = 3;
        } else {
            cp = 0xFFFD; // битый байт — replacement char, не роняем прогон
        }
        for (int k = 0; k < extra && i + 1 < s.size(); ++k) {
            cp = (cp << 6) | ((unsigned char)s[++i] & 0x3F);
        }
        ++i;
        if (cp > 0xFFFF) {
            cp -= 0x10000;
            u16.push_back((jchar)(0xD800 | (cp >> 10)));
            u16.push_back((jchar)(0xDC00 | (cp & 0x3FF)));
        } else {
            u16.push_back((jchar)cp);
        }
    }
    return env->NewString(u16.data(), (jsize)u16.size());
}

extern "C" JNIEXPORT jlong JNICALL
Java_dev_duopulse_mobile_MobileAsrHelper_nativeInit(JNIEnv *env, jclass, jstring jpath, jint threads) {
    if (threads > 0) g_threads.store((int)threads);
    const char *path = env->GetStringUTFChars(jpath, nullptr);
    if (!path) return 0;
    struct whisper_context_params cparams = whisper_context_default_params();
    cparams.use_gpu = false; // CPU-сборка ggml (см. CMakeLists.txt)
    cparams.flash_attn = false;
    struct whisper_context *ctx = whisper_init_from_file_with_params(path, cparams);
    env->ReleaseStringUTFChars(jpath, path);
    return reinterpret_cast<jlong>(ctx);
}

extern "C" JNIEXPORT jstring JNICALL
Java_dev_duopulse_mobile_MobileAsrHelper_nativeTranscribe(
        JNIEnv *env, jclass, jlong jctx, jbyteArray jpcm, jstring jlang, jstring jprompt) {
    struct whisper_context *ctx = reinterpret_cast<struct whisper_context *>(jctx);
    if (!ctx || !jpcm) {
        return env->NewStringUTF("error: контекст whisper не инициализирован");
    }
    const jsize n_bytes = env->GetArrayLength(jpcm);
    if (n_bytes < 2) {
        return env->NewStringUTF("error: пустой аудио-чанк");
    }
    const char *lang = jlang ? env->GetStringUTFChars(jlang, nullptr) : nullptr;
    const char *prompt = jprompt ? env->GetStringUTFChars(jprompt, nullptr) : nullptr;

    jbyte *raw = env->GetByteArrayElements(jpcm, nullptr);
    const size_t n_samples = (size_t)n_bytes / 2;
    std::vector<float> samples(n_samples);
    for (size_t i = 0; i < n_samples; ++i) {
        const int16_t s = (int16_t)(((uint16_t)(uint8_t)raw[2 * i]) |
                                    ((uint16_t)(uint8_t)raw[2 * i + 1] << 8));
        samples[i] = (float)s / 32768.0f;
    }
    env->ReleaseByteArrayElements(jpcm, raw, JNI_ABORT);

    struct whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    params.n_threads = g_threads.load();
    params.translate = false;
    params.language = (lang && lang[0] && strcmp(lang, "auto") != 0) ? lang : nullptr; // nullptr → авто-язык
    params.initial_prompt = (prompt && prompt[0]) ? prompt : nullptr;
    params.single_segment = false;
    params.print_progress = false;
    params.print_special = false;
    params.print_realtime = false;
    params.print_timestamps = false;
    params.suppress_nst = true;

    std::string out;
    if (whisper_full(ctx, params, samples.data(), (int)n_samples) != 0) {
        out = "error: whisper_full не справился с чанком";
    } else {
        out = "{\"detected_language\":";
        const int lang_id = whisper_full_lang_id(ctx);
        const char *lang_code = lang_id >= 0 ? whisper_lang_str(lang_id) : nullptr;
        if (lang_code) {
            out += "\"" + json_escape(lang_code) + "\"";
        } else {
            out += "null";
        }
        out += ",\"segments\":[";
        const int n_seg = whisper_full_n_segments(ctx);
        char buf[48];
        for (int i = 0; i < n_seg; ++i) {
            // t0/t1 — сантисекунды: секунды = /100
            const int64_t t0 = whisper_full_get_segment_t0(ctx, i);
            const int64_t t1 = whisper_full_get_segment_t1(ctx, i);
            const char *text = whisper_full_get_segment_text(ctx, i);
            if (i) out += ",";
            snprintf(buf, sizeof buf, "%lld.%02lld", (long long)(t0 / 100), (long long)(t0 % 100));
            out += "{\"start\":" + std::string(buf);
            snprintf(buf, sizeof buf, "%lld.%02lld", (long long)(t1 / 100), (long long)(t1 % 100));
            out += ",\"end\":" + std::string(buf);
            out += ",\"text\":\"" + json_escape(text ? text : "") + "\"}";
        }
        out += "]}";
    }
    if (lang) env->ReleaseStringUTFChars(jlang, lang);
    if (prompt) env->ReleaseStringUTFChars(jprompt, prompt);
    return utf8_to_jstring(env, out);
}

extern "C" JNIEXPORT void JNICALL
Java_dev_duopulse_mobile_MobileAsrHelper_nativeFree(JNIEnv *, jclass, jlong jctx) {
    if (jctx) {
        whisper_free(reinterpret_cast<struct whisper_context *>(jctx));
    }
}
