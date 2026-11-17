//! DuoPulse — ASR-субтитры мобильной ветки (карточка duopulse-167, паритет
//! 4/8 аудита duopulse-156): облачный OpenAI-совместимый провайдер для видео
//! без дорожек субтитров. Локальный whisper.exe на Android не вариант (этап
//! 5/8 — libwhisper под NDK), поэтому провайдер один — облако; модули asr/
//! (engine — AsrTransport над ureq+rustls, decode — symphonia portable,
//! cache — asr_tracks в duopulse.db профиля, config) переиспользуются с
//! десктопом, серверная часть (server.rs) не включается.
//!
//! Цепочка (канал тот же, что у загрузок mobile_download — googlevideo
//! отдаёт медиа только браузерному окружению youtube-origin, нативный ureq
//! с устройств получает 403, пробы 11–12.11.2026):
//!   duo-панель «Распознать речь» → subtitles_asr_start {videoId, lang}
//!     → кэш asr_tracks: попадание — готовые cues без сети (airplane mode);
//!     промах — URL/размер аудио из player-ответа innertube (VISIONOS-клиент
//!     с куками watch-сессии, ureq+rustls) → «needAudio»
//!   → UI качает аудио фетчером ВНУТРИ youtube-iframe (dl-fetcher.js:
//!     закрытые Range-диапазоны, движок/куки/TLS WebView) и приносит чанки
//!     base64 командой subtitles_asr_audio_append (потолок AUDIO_MAX_BYTES)
//!   → subtitles_asr_audio_finish: decode → PCM 16 кГц моно → чанки ≤ 5 мин
//!     → облако POST /v1/audio/transcriptions (Bearer ключ) → cues → кэш;
//!     прогресс — событие subtitles:asr_progress (та же форма, что у
//!     десктопа: tabId здесь videoId), итог — ответом команды
//!   → отмена: subtitles_asr_cancel поднимает поколение (asr::core::AsrJobs)
//!     — работающий конвейер видит рассинхрон на границе фаз и останавливается.
//!
//! Ключ API — ТОЛЬКО в Android Keystore (secrets.rs → MobileKeystoreHelper,
//! как пароли duopulse-112), в settings.json его нет. Ошибки сети/квоты
//! (429/401/5xx — AsrError) панель показывает статусом, не молча.
//!
//! Развилка как у mobile_download: модуль asr либа компилирует только
//! мобильным таргетам (развилка lib.rs), поэтому ссылающиеся на него части
//! (вид настроек, конфиг облака, команды) — под cfg; потолок чанков — чистый,
//! тесты на хосте.

/// Имя события прогресса (то же, что у десктопного конвейера).
pub const ASR_PROGRESS_EVENT: &str = "subtitles:asr_progress";

/// Настройки ASR мобильной ветки для UI (asr_get_settings): провайдер один —
/// облако, локальные поля десктопа (движок/модель whisper) не показываются.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileAsrSettings {
    pub enabled: bool,
    pub openai_base_url: String,
    pub openai_model: String,
    /// Ключ API сохранён (Android Keystore; сами ключи наружу не отдаются).
    pub has_api_key: bool,
}

/// Приписать чанк к буферу с потолком: аудио длиннее max — честный отказ
/// (буфер освобождается), как у десктопного самофетча (AUDIO_MAX_BYTES).
pub fn append_chunk(buf: &mut Vec<u8>, chunk: &[u8], max: usize) -> Result<(), String> {
    if buf.len() + chunk.len() > max {
        buf.clear();
        return Err(format!(
            "аудио больше {} МБ — сверх лимита",
            max / (1024 * 1024)
        ));
    }
    buf.extend_from_slice(chunk);
    Ok(())
}

// --- конфиг/команды/конвейер — мобильным таргетам (нужен crate::asr) -----------

#[cfg(any(target_os = "android", target_os = "ios"))]
pub mod cmd {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    use tauri::{AppHandle, Emitter, State};
    use tauri::command;

    use crate::asr::cache::{now_ms, AsrCache};
    use crate::asr::config::{self, AsrConfig, AsrProviderId};
    use crate::asr::core::{transcribe_pcm, AsrJobs, SubtitlesAsrProgress, AUDIO_MAX_BYTES};
    use crate::asr::decode::{chunk_pcm, decode_to_pcm16k_mono};
    use crate::asr::engine::{self, AsrEndpoint, UreqAsrTransport};
    use crate::duo_mobile::{net::DuoManaged, DuoCue, valid_video_id};
    use crate::mobile_download::{cmd::visionos_player_response, pick_audio_format_full};

    use super::{append_chunk, MobileAsrSettings, ASR_PROGRESS_EVENT};

    /// Вид настроек мобильной ветки: конфиг + факт наличия ключа. Провайдер
    /// принудительно облако — локального whisper на Android нет (этап 5/8).
    pub fn mobile_settings(cfg: &AsrConfig, has_key: bool) -> MobileAsrSettings {
        MobileAsrSettings {
            enabled: cfg.enabled && cfg.provider == AsrProviderId::Openai,
            openai_base_url: cfg.openai_base_url.clone(),
            openai_model: cfg.openai_model.clone(),
            has_api_key: has_key,
        }
    }

    /// Конфиг облака из аргументов asr_set_settings: провайдер всегда Openai,
    /// локальные параметры — дефолты (в мобильной ветке не настраиваются).
    /// Валидация — как у десктопа (облаку нужен http(s)-адрес и модель).
    pub fn cloud_config(enabled: bool, base_url: &str, model: &str) -> AsrConfig {
        AsrConfig {
            enabled,
            provider: AsrProviderId::Openai,
            local_model: Default::default(),
            local_engine_path: String::new(),
            openai_base_url: base_url.trim().to_string(),
            openai_model: model.trim().to_string(),
        }
    }

    /// Ответ конвейера: cues + язык (запрошенный или определённый движком).
    #[derive(Debug, Clone, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct AsrRunResult {
        pub cues: Vec<DuoCue>,
        pub lang: String,
        pub from_cache: bool,
        /// Идентификатор движка («openai:whisper-1») — подпись дорожки.
        pub engine: String,
    }

    /// Ответ subtitles_asr_start: готовая дорожка из кэша либо задание на
    /// скачивание аудио (URL+размер отдаёт Core, байты качает iframe-фетчер).
    #[derive(Debug, Clone, serde::Serialize)]
    #[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
    pub enum AsrStartOutcome {
        /// Кэш-хит: сети не было, cues готовы.
        Done(Box<AsrRunResult>),
        /// Нужно скачать аудио (subtitles_asr_audio_append → …_finish).
        NeedAudio { url: String, size: u64 },
    }

    /// Скачанное аудио задачи: поколение (отмена) + ожидаемый размер (прогресс
    /// фазы audio) + байты (память Core — как самофетч десктопа; после
    /// декодирования освобождаются).
    struct AsrAudio {
        gen: u64,
        expected_size: u64,
        bytes: Vec<u8>,
    }

    /// Состояние ASR мобильной ветки: поколения отмен + буферы аудио задач.
    #[derive(Default)]
    pub struct AsrManaged {
        jobs: AsrJobs,
        audio: Mutex<HashMap<String, AsrAudio>>,
    }

    fn profile_dir() -> Result<std::path::PathBuf, String> {
        crate::mobile_history::profile_dir()
    }

    /// Событие прогресса в UI-webview (форма — как у десктопа; tabId
    /// мобильной ветки несёт videoId — вкладок Core не знает).
    fn emit_progress(
        app: &AppHandle,
        video_id: &str,
        engine_id: &str,
        phase: &str,
        done: u32,
        total: u32,
        from_cache: bool,
        error: Option<String>,
    ) {
        let _ = app.emit(
            ASR_PROGRESS_EVENT,
            SubtitlesAsrProgress {
                tab_id: video_id.to_string(),
                video_key: video_id.to_string(),
                engine: engine_id.to_string(),
                phase: phase.to_string(),
                done,
                total,
                from_cache,
                error,
            },
        );
    }

    /// Аргументы asr_set_settings (camelCase на фронте).
    #[derive(Debug, serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct AsrSetArgs {
        pub enabled: bool,
        pub openai_base_url: String,
        pub openai_model: String,
        /// Ключ API: None — не менять, Some("") — удалить, строка — записать.
        pub api_key: Option<String>,
    }

    /// asr_get_settings: конфиг облака + факт наличия ключа.
    #[command]
    pub fn asr_get_settings() -> Result<MobileAsrSettings, String> {
        let dir = profile_dir()?;
        let cfg = config::load_config(&dir);
        Ok(mobile_settings(&cfg, config::has_api_key(&dir)))
    }

    /// asr_set_settings: конфиг — settings.json профиля (раздел "asr",
    /// провайдер всегда облако), ключ — Android Keystore (secrets.rs).
    #[command]
    pub fn asr_set_settings(args: AsrSetArgs) -> Result<MobileAsrSettings, String> {
        let dir = profile_dir()?;
        let cfg = cloud_config(args.enabled, &args.openai_base_url, &args.openai_model);
        config::save_settings(&dir, &cfg, args.api_key.as_deref())?;
        Ok(mobile_settings(&cfg, config::has_api_key(&dir)))
    }

    /// Эндпоинт облака по настройкам: провайдер мобильной ветки один, без
    /// ключа — честный отказ (панель предложит настройки).
    fn cloud_endpoint(dir: &std::path::Path, cfg: &AsrConfig) -> Result<AsrEndpoint, String> {
        let key = config::load_api_key(dir)
            .filter(|k| !k.trim().is_empty())
            .ok_or_else(|| "нет ключа API — сохраните в настройках ASR".to_string())?;
        Ok(AsrEndpoint::OpenAiCompatible {
            base_url: cfg.openai_base_url.trim().trim_end_matches('/').to_string(),
            key,
            model: cfg.openai_model.trim().to_string(),
        })
    }

    /// subtitles_asr_start: кэш → готовая дорожка; промах → URL/размер аудио
    /// (player-ответ VISIONOS-клиента с куками watch-сессии — прямые url
    /// дорожек, качаемые фетчером iframe диапазонами). Буфер прежней задачи
    /// этого видео освобождается, поколение поднимается (старая работа
    /// отменяется).
    #[command]
    pub fn subtitles_asr_start(
        app: AppHandle,
        video_id: String,
        lang: String,
        duo: State<'_, DuoManaged>,
        st: State<'_, Arc<AsrManaged>>,
        cache: State<'_, Arc<AsrCache>>,
    ) -> Result<AsrStartOutcome, String> {
        if !valid_video_id(&video_id) {
            return Err("некорректный videoId".into());
        }
        let lang = lang.trim().to_lowercase();
        let dir = profile_dir()?;
        let cfg = config::load_config(&dir);
        if !cfg.enabled || cfg.provider != AsrProviderId::Openai {
            return Err("распознавание речи выключено в настройках ASR".into());
        }
        // ключ проверяем сразу — отказ до скачивания аудио честнее
        cloud_endpoint(&dir, &cfg)?;
        let engine_id = engine::engine_id(AsrProviderId::Openai, &cfg.openai_model);
        // кэш: повторный просмотр того же видео тем же движком — без сети
        if let Some((cues, cached_lang)) = cache.get(&video_id, &engine_id, &lang, now_ms()) {
            // событие как у десктопного конвейера: панель показывает «из кэша»
            emit_progress(
                &app,
                &video_id,
                &engine_id,
                "done",
                cues.len() as u32,
                cues.len() as u32,
                true,
                None,
            );
            return Ok(AsrStartOutcome::Done(Box::new(AsrRunResult {
                cues: cues
                    .into_iter()
                    .map(|c| DuoCue {
                        start_ms: c.start_ms,
                        end_ms: c.end_ms,
                        text: c.text,
                    })
                    .collect(),
                lang: cached_lang,
                from_cache: true,
                engine: engine_id,
            })));
        }
        // аудио: VISIONOS-клиент — единственный, чьи прямые url обслуживаются
        // диапазонами целиком (ANDROID урезан ~1 МиБ — фетч упадёт 403 на
        // первом же стыке, пробы duopulse-122)
        let player = visionos_player_response(&video_id, &duo)?;
        let Some((url, _mime, size)) = pick_audio_format_full(&player) else {
            return Err("аудио этого видео недоступно для распознавания".into());
        };
        let gen = st.jobs.bump(&video_id);
        st.audio
            .lock()
            .expect("asr: лок не отравлен")
            .insert(video_id.clone(), AsrAudio {
                gen,
                expected_size: size,
                bytes: Vec::new(),
            });
        Ok(AsrStartOutcome::NeedAudio { url, size })
    }

    /// subtitles_asr_audio_append: чанк base64 от iframe-фетчера → буфер
    /// задачи (потолок AUDIO_MAX_BYTES). Ответ — сколько байт собрано; по
    /// чанкам эмитится прогресс фазы audio (байты, как у десктопа).
    #[command]
    pub fn subtitles_asr_audio_append(
        app: AppHandle,
        video_id: String,
        b64: String,
        st: State<'_, Arc<AsrManaged>>,
    ) -> Result<u64, String> {
        let chunk = crate::mobile_download::decode_base64(&b64)?;
        let (engine_id, done, total) = {
            let mut audio = st.audio.lock().expect("asr: лок не отравлен");
            let Some(job) = audio.get_mut(&video_id) else {
                return Err("задача распознавания не начиналась".into());
            };
            append_chunk(&mut job.bytes, &chunk, AUDIO_MAX_BYTES)?;
            // engine_id до старта неизвестен панели — прогресс без него
            // не рисуется; храним конфиг-независимую подпись облака
            ("cloud", job.bytes.len() as u32, job.expected_size as u32)
        };
        let _ = app.emit(
            ASR_PROGRESS_EVENT,
            SubtitlesAsrProgress {
                tab_id: video_id.clone(),
                video_key: video_id,
                engine: engine_id.to_string(),
                phase: "audio".to_string(),
                done,
                total,
                from_cache: false,
                error: None,
            },
        );
        Ok(done as u64)
    }

    /// subtitles_asr_audio_finish: собранное аудио → decode → чанки → облако
    /// → кэш; прогресс — событием, итог — ответом. Отмена (поколение) и
    /// ошибки сети/квоты — Err строкой (панель показывает статусом).
    #[command]
    pub fn subtitles_asr_audio_finish(
        app: AppHandle,
        video_id: String,
        lang: String,
        st: State<'_, Arc<AsrManaged>>,
        cache: State<'_, Arc<AsrCache>>,
    ) -> Result<AsrRunResult, String> {
        if !valid_video_id(&video_id) {
            return Err("некорректный videoId".into());
        }
        let lang = lang.trim().to_lowercase();
        let dir = profile_dir()?;
        let cfg = config::load_config(&dir);
        if !cfg.enabled || cfg.provider != AsrProviderId::Openai {
            return Err("распознавание речи выключено в настройках ASR".into());
        }
        let engine_id = engine::engine_id(AsrProviderId::Openai, &cfg.openai_model);
        let job = st
            .audio
            .lock()
            .expect("asr: лок не отравлен")
            .remove(&video_id)
            .ok_or_else(|| "аудио не скачано".to_string())?;
        let gen = job.gen;
        let current = |g: u64| st.jobs.is_current(&video_id, g);
        let fail = |reason: String| -> Result<AsrRunResult, String> {
            emit_progress(&app, &video_id, &engine_id, "error", 0, 0, false, Some(reason.clone()));
            Err(reason)
        };
        // декод (буфер байтов освобождается сразу — пик памяти как у десктопа)
        emit_progress(&app, &video_id, &engine_id, "decode", 0, 0, false, None);
        let pcm = match decode_to_pcm16k_mono(&job.bytes) {
            Ok(p) => p,
            Err(e) => return fail(format!("декодирование аудио: {e}")),
        };
        drop(job);
        if !current(gen) {
            return Err("распознавание отменено".into());
        }
        // транскрипция чанками (прогресс между запросами, отмена — на стыке)
        let chunks = chunk_pcm(&pcm);
        let total = chunks.len() as u32;
        emit_progress(&app, &video_id, &engine_id, "transcribe", 0, total, false, None);
        let endpoint = cloud_endpoint(&dir, &cfg)?;
        let transport = UreqAsrTransport::new();
        let app_for_progress = app.clone();
        let video_for_progress = video_id.clone();
        let engine_for_progress = engine_id.clone();
        let result = transcribe_pcm(
            &transport,
            &endpoint,
            &chunks,
            &lang,
            |done, total| {
                emit_progress(
                    &app_for_progress,
                    &video_for_progress,
                    &engine_for_progress,
                    "transcribe",
                    done as u32,
                    total as u32,
                    false,
                    None,
                );
            },
        );
        let (cues, detected) = match result {
            Ok(r) => r,
            Err(e) => return fail(e.message()),
        };
        if !current(gen) {
            return Err("распознавание отменено".into());
        }
        let out_lang = if lang.is_empty() { detected } else { lang };
        // пишем под итоговый язык: повторный просмотр найдёт той же дорожкой
        cache.put(&video_id, &engine_id, &out_lang, &cues, now_ms());
        let out = AsrRunResult {
            cues: cues
                .into_iter()
                .map(|c| DuoCue {
                    start_ms: c.start_ms,
                    end_ms: c.end_ms,
                    text: c.text,
                })
                .collect(),
            lang: out_lang,
            from_cache: false,
            engine: engine_id.clone(),
        };
        emit_progress(
            &app,
            &video_id,
            &engine_id,
            "done",
            out.cues.len() as u32,
            out.cues.len() as u32,
            false,
            None,
        );
        Ok(out)
    }

    /// subtitles_asr_cancel: поднять поколение (конвейер остановится на
    /// границе фаз) и освободить буфер аудио.
    #[command]
    pub fn subtitles_asr_cancel(video_id: String, st: State<'_, Arc<AsrManaged>>) {
        st.jobs.bump(&video_id);
        st.audio
            .lock()
            .expect("asr: лок не отравлен")
            .remove(&video_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_chunk_caps_and_frees() {
        let mut buf = Vec::new();
        append_chunk(&mut buf, &[1, 2, 3], 10).unwrap();
        assert_eq!(buf.len(), 3);
        append_chunk(&mut buf, &[4], 10).unwrap();
        assert_eq!(buf.len(), 4);
        let err = append_chunk(&mut buf, &[0; 7], 10).unwrap_err();
        assert!(err.contains("сверх лимита"), "{err}");
        assert!(buf.is_empty(), "буфер освобождён при отказе");
    }

    // Остальная логика модуля (конфиг облака, кэш asr_tracks, конвейер)
    // покрыта тестами общих модулей asr/ — они собираются десктоп-бином
    // (cargo test гоняет оба таргета) и мобильной либой.
}
