//! DuoPulse — ASR-субтитры мобильной ветки (карточка duopulse-167, паритет
//! 4/8 аудита duopulse-156; локальный движок — duopulse-168, 5/8): для видео
//! без дорожек субтитров ДВА провайдера:
//!
//! - **облако** — OpenAI-совместимый API (ключ — Android Keystore), этап 4/8;
//! - **локальный** — whisper.cpp нативной библиотекой libwhisperjni в APK
//!   (engine::local_jni ← MobileAsrHelper.kt): работает офлайн, аудио не
//!   покидает устройство; модель ggml (tiny — дефолт, base — опция) качается
//!   в профиль с прогрессом и sha256-проверкой (asr/models.rs), движок
//!   выгружается после 10 минут простоя — семантика whisper-server десктопа.
//!
//! Модули asr/ (engine, decode, cache, config, models) переиспользуются с
//! десктопом, серверная часть (server.rs — процесс whisper-server.exe) не
//! включается.
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

/// Имя события менеджера моделей (duopulse-168): скачивание/проверка/удаление
/// ggml — вне конвейера конкретного видео, отдельная форма.
pub const ASR_MODEL_EVENT: &str = "subtitles:asr_model_progress";

/// Прогресс менеджера моделей (subtitles:asr_model_progress): size — "tiny" |
/// "base", phase — download | done | error (done/total — байты).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrModelProgress {
    pub size: String,
    pub phase: String,
    pub done: u32,
    pub total: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Настройки ASR мобильной ветки для UI (asr_get_settings): выбранный
/// провайдер (облако | локальный whisper), конфиг облака и статус моделей
/// (локальный провайдер предлагается только со скачанной моделью).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileAsrSettings {
    pub enabled: bool,
    /// "cloud" | "local".
    pub provider: String,
    pub openai_base_url: String,
    pub openai_model: String,
    /// Ключ API сохранён (Android Keystore; сами ключи наружу не отдаются).
    pub has_api_key: bool,
    /// Выбранная модель локального движка: "tiny" | "base".
    pub local_model: String,
    /// ggml-tiny на месте (размер сверен).
    pub model_tiny_downloaded: bool,
    /// ggml-base на месте.
    pub model_base_downloaded: bool,
    /// Локальный провайдер готов: выбранная модель скачана (движок в APK
    /// есть всегда — libwhisperjni грузится всеми сборками).
    pub local_ready: bool,
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
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    use tauri::{AppHandle, Emitter, State};
    use tauri::command;

    use crate::asr::cache::{now_ms, AsrCache};
    use crate::asr::config::{self, AsrConfig, AsrProviderId, LocalModelSize};
    use crate::asr::core::{transcribe_pcm, transcribe_pcm_with, AsrJobs, SubtitlesAsrProgress, AUDIO_MAX_BYTES};
    use crate::asr::decode::{chunk_pcm, decode_to_pcm16k_mono};
    use crate::asr::engine::{self, AsrEndpoint, UreqAsrTransport};
    use crate::asr::models;
    use crate::duo_mobile::{net::DuoManaged, DuoCue, valid_video_id};
    use crate::mobile_download::{cmd::visionos_player_response, pick_audio_format_full};

    use super::{append_chunk, AsrModelProgress, MobileAsrSettings, ASR_MODEL_EVENT, ASR_PROGRESS_EVENT};

    /// «tiny» | «base» (мобильный выбор моделей; small — десктопный).
    fn parse_local_size(raw: &str) -> Option<LocalModelSize> {
        match raw.trim().to_lowercase().as_str() {
            "tiny" => Some(LocalModelSize::Tiny),
            "base" => Some(LocalModelSize::Base),
            _ => None,
        }
    }

    fn size_label(size: LocalModelSize) -> &'static str {
        match size {
            LocalModelSize::Tiny => "tiny",
            LocalModelSize::Base => "base",
            LocalModelSize::Small => "small",
        }
    }

    /// Вид настроек мобильной ветки: конфиг + статус моделей. local_ready —
    /// выбранная модель на месте: без неё UI локальный провайдер не предлагает.
    pub fn mobile_settings(
        cfg: &AsrConfig,
        has_key: bool,
        tiny: bool,
        base: bool,
    ) -> MobileAsrSettings {
        let downloaded = match cfg.local_model {
            LocalModelSize::Tiny => tiny,
            LocalModelSize::Base => base,
            LocalModelSize::Small => false,
        };
        MobileAsrSettings {
            enabled: cfg.enabled,
            provider: if cfg.provider == AsrProviderId::Local { "local".into() } else { "cloud".into() },
            openai_base_url: cfg.openai_base_url.clone(),
            openai_model: cfg.openai_model.clone(),
            has_api_key: has_key,
            local_model: size_label(cfg.local_model).into(),
            model_tiny_downloaded: tiny,
            model_base_downloaded: base,
            local_ready: cfg.provider == AsrProviderId::Local && downloaded,
        }
    }

    /// Конфиг ASR мобильной ветки: десктопный дефолт (local + base — Base
    /// выбран для ru-качества на десктопе) телефону не подходит — до первого
    /// сохранения и для облачного провайдера предлагаем tiny (78 МБ, заметно
    /// быстрее мобильного CPU; карточка duopulse-168). Осознанный выбор
    /// «локальный + base» сохраняется и не переопределяется.
    fn load_mobile_config(dir: &std::path::Path) -> AsrConfig {
        let mut cfg = config::load_config(dir);
        if !config::has_saved_config(dir) || cfg.provider != AsrProviderId::Local {
            cfg.local_model = LocalModelSize::Tiny;
        }
        cfg
    }

    /// Снимок настроек с текущим статусом моделей (общий хвост get/set).
    fn settings_view(dir: &std::path::Path) -> Result<MobileAsrSettings, String> {
        let cfg = load_mobile_config(dir);
        Ok(mobile_settings(
            &cfg,
            config::has_api_key(dir),
            models::is_downloaded(dir, LocalModelSize::Tiny),
            models::is_downloaded(dir, LocalModelSize::Base),
        ))
    }

    /// Конфиг из аргументов asr_set_settings (duopulse-168: провайдер —
    /// выбор). Локальному нужна скачанная модель (иначе нечего поднимать);
    /// облаку — http(s)-адрес и модель, как у десктопа. Поля облака храним
    /// и при локальном провайдере — переключение туда-обратно не теряет ввод.
    pub fn config_from_args(
        enabled: bool,
        provider: &str,
        local_model: &str,
        base_url: &str,
        model: &str,
        dir: &std::path::Path,
    ) -> Result<AsrConfig, String> {
        let cloud = || AsrConfig {
            enabled,
            provider: AsrProviderId::Openai,
            // мобильный дефолт — tiny (см. settings_view: Base — десктопный)
            local_model: LocalModelSize::Tiny,
            local_engine_path: String::new(),
            openai_base_url: base_url.trim().to_string(),
            openai_model: model.trim().to_string(),
        };
        if provider.trim().eq_ignore_ascii_case("local") {
            let size = parse_local_size(local_model)
                .ok_or_else(|| "модель локального движка — tiny или base".to_string())?;
            if !models::is_downloaded(dir, size) {
                return Err("модель локального движка не скачана — скачайте её в настройках ASR".into());
            }
            let mut cfg = cloud();
            cfg.provider = AsrProviderId::Local;
            cfg.local_model = size;
            return Ok(cfg);
        }
        let cfg = cloud();
        cfg.validate()?;
        Ok(cfg)
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
    /// декодирования освобождаются) + подпись движка для прогресса фазы audio.
    struct AsrAudio {
        gen: u64,
        expected_size: u64,
        bytes: Vec<u8>,
        engine: String,
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

    /// Аргументы asr_set_settings (camelCase на фронте; provider/local_model
    /// — опции duopulse-168: старые вызовы без них = облако, как в 167).
    #[derive(Debug, serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct AsrSetArgs {
        pub enabled: bool,
        pub openai_base_url: String,
        pub openai_model: String,
        /// Ключ API: None — не менять, Some("") — удалить, строка — записать.
        pub api_key: Option<String>,
        /// "cloud" (дефолт) | "local".
        pub provider: Option<String>,
        /// "tiny" | "base" — для провайдера local.
        pub local_model: Option<String>,
    }

    /// Одна загрузка модели одновременно (фоновые нити — глобальный флаг).
    static MODEL_DOWNLOADING: AtomicBool = AtomicBool::new(false);

    /// Событие менеджера моделей в UI-webview.
    fn emit_model(app: &AppHandle, size: &str, phase: &str, done: u32, total: u32, error: Option<String>) {
        let _ = app.emit(
            ASR_MODEL_EVENT,
            AsrModelProgress {
                size: size.to_string(),
                phase: phase.to_string(),
                done,
                total,
                error,
            },
        );
    }

    /// asr_get_settings: конфиг + статус моделей локального движка.
    #[command]
    pub fn asr_get_settings() -> Result<MobileAsrSettings, String> {
        settings_view(&profile_dir()?)
    }

    /// asr_set_settings: конфиг — settings.json профиля (раздел "asr";
    /// провайдер local требует скачанную модель), ключ — Android Keystore.
    #[command]
    pub fn asr_set_settings(args: AsrSetArgs) -> Result<MobileAsrSettings, String> {
        let dir = profile_dir()?;
        let cfg = config_from_args(
            args.enabled,
            args.provider.as_deref().unwrap_or("cloud"),
            args.local_model.as_deref().unwrap_or("tiny"),
            &args.openai_base_url,
            &args.openai_model,
            &dir,
        )?;
        config::save_settings(&dir, &cfg, args.api_key.as_deref())?;
        settings_view(&dir)
    }

    /// asr_model_download (duopulse-168): скачать ggml в профиль фоновой
    /// нитью — прогресс событием subtitles:asr_model_progress (байты),
    /// завершение — done (модель проверена: размер + sha256) или error.
    /// Повторный вызов при активной загрузке — честный отказ.
    #[command]
    pub fn asr_model_download(app: AppHandle, size: String) -> Result<(), String> {
        let size = parse_local_size(&size).ok_or("размер модели — tiny | base")?;
        let dir = profile_dir()?;
        if models::is_downloaded(&dir, size) {
            emit_model(&app, size_label(size), "done", 0, 0, None);
            return Ok(());
        }
        if MODEL_DOWNLOADING.swap(true, Ordering::SeqCst) {
            return Err("модель уже скачивается".into());
        }
        std::thread::spawn(move || {
            let label = size_label(size);
            let res = models::download_model(&dir, size, &mut |done, total| {
                emit_model(&app, label, "download", done as u32, total as u32, None);
            });
            match res {
                Ok(_) => emit_model(&app, label, "done", 0, 0, None),
                Err(e) => emit_model(&app, label, "error", 0, 0, Some(e)),
            }
            MODEL_DOWNLOADING.store(false, Ordering::SeqCst);
        });
        Ok(())
    }

    /// asr_model_delete: убрать модель (и .part-хвост) из профиля; загруженный
    /// движок выгружается — контекст ссылался на этот файл.
    #[command]
    pub fn asr_model_delete(size: String) -> Result<MobileAsrSettings, String> {
        let size = parse_local_size(&size).ok_or("размер модели — tiny | base")?;
        let dir = profile_dir()?;
        engine::local_jni::unload();
        models::delete_model(&dir, size)?;
        settings_view(&dir)
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
        let cfg = load_mobile_config(&dir);
        if !cfg.enabled {
            return Err("распознавание речи выключено в настройках ASR".into());
        }
        // провайдер: локальному — модель на месте, облаку — ключ (отказ до
        // скачивания аудио честнее, чем после)
        let engine_id = match cfg.provider {
            AsrProviderId::Local => {
                if !models::is_downloaded(&dir, cfg.local_model) {
                    return Err("модель локального движка не скачана — скачайте в настройках ASR".into());
                }
                engine::engine_id(AsrProviderId::Local, "")
            }
            AsrProviderId::Openai => {
                cloud_endpoint(&dir, &cfg)?;
                engine::engine_id(AsrProviderId::Openai, &cfg.openai_model)
            }
        };
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
                engine: engine_id.clone(),
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
            // подпись движка записана при старте (local:whisper / openai:…)
            (job.engine.clone(), job.bytes.len() as u32, job.expected_size as u32)
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
        let cfg = load_mobile_config(&dir);
        if !cfg.enabled {
            return Err("распознавание речи выключено в настройках ASR".into());
        }
        let engine_id = match cfg.provider {
            AsrProviderId::Local => engine::engine_id(AsrProviderId::Local, ""),
            AsrProviderId::Openai => engine::engine_id(AsrProviderId::Openai, &cfg.openai_model),
        };
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
        // транскрипция чанками (прогресс между запросами, отмена — на стыке):
        // локальный движок — JNI (engine::local_jni, без сети вообще), облако —
        // HTTP-транспорт; офсеты/prompt/язык чанков — общий код core.rs
        let chunks = chunk_pcm(&pcm);
        let total = chunks.len() as u32;
        emit_progress(&app, &video_id, &engine_id, "transcribe", 0, total, false, None);
        let app_for_progress = app.clone();
        let video_for_progress = video_id.clone();
        let engine_for_progress = engine_id.clone();
        let mut on_chunk = |done: usize, total: usize| {
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
        };
        let result = match cfg.provider {
            AsrProviderId::Local => {
                if !models::is_downloaded(&dir, cfg.local_model) {
                    return fail("модель локального движка не скачана".into());
                }
                let model_path = models::model_path(&dir, cfg.local_model)
                    .display()
                    .to_string();
                transcribe_pcm_with(
                    &chunks,
                    &lang,
                    |pcm, lang, prompt| engine::local_jni::transcribe_pcm(&model_path, pcm, lang, prompt),
                    |done, total| on_chunk(done, total),
                )
            }
            AsrProviderId::Openai => {
                let endpoint = cloud_endpoint(&dir, &cfg)?;
                let transport = UreqAsrTransport::new();
                transcribe_pcm(&transport, &endpoint, &chunks, &lang, |done, total| {
                    on_chunk(done, total)
                })
            }
        };
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
