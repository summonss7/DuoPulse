//! Загрузка музыки с YouTube мобильной веткой (карточка duopulse-121).
//! Десктоп качает yt-dlp+deno+ffmpeg (download/, duopulse-118) — на Android
//! этих бинарников нет, поэтому путь нативный: тот же innertube ANDROID-клиент,
//! что уже кормит субтитры (duo_mobile::net::player_response, кэш общий),
//! отдаёт streamingData.adaptiveFormats с ПРЯМЫМИ url аудио-дорожек без
//! PO-токена (живая проба 11.11.2026: itag 140 audio/mp4 ~129 kbps, Range
//! 206, magic ftyp). Выбор дорожки — чистая функция pick_audio_format
//! (m4a в приоритете: играется системными плеерами), скачивание — ureq
//! потоками в cacheDir/music с событиями «duopulse:mobile-music-progress»,
//! обрывы лечатся докачкой Range (рецепт мобильного OTA duopulse-101: до 3
//! попыток, таймаут чтения 30 с). Готовый файл переносится в общую медиатеку
//! Kotlin-хелпером MobileDownloadHelper (MediaStore Audio → Music/DuoPulse
//! на API ≥29; ниже — каталог приложения без разрешений), JNI-поверхность —
//! один статический вызов, исключения гасятся в Kotlin (эталон 083/102).
//!
//! Чистые функции (выбор дорожки, имя файла) компилируются везде и покрыты
//! хостовыми тестами; сетевая часть — только мобильным таргетам.

/// Выбранная аудио-дорожка (adaptiveFormats): прямой url + mimeType.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioPick {
    pub url: String,
    pub mime: String,
}

/// Битрейт дорожки для сравнения (bitrate, иначе averageBitrate, иначе 0).
fn fmt_bitrate(f: &serde_json::Value) -> u64 {
    f.get("bitrate")
        .or_else(|| f.get("averageBitrate"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0)
}

/// Лучший аудио-формат player-ответа: только adaptiveFormats с mimeType
/// audio/* и прямым url (signatureCipher требует расшифровки — ANDROID-клиент
/// её не отдаёт, такие записи пропускаем). Приоритеты: (1) основная дорожка —
/// без xtags (ответ ANDROID-клиента содержит дубля DRC-варианта с тем же
/// битрейтом, xtags=CggKA2RyYxIBMQ = «drc:1» — сжатая альтернативная сводка,
/// пользователю нужен оригинал), (2) audio/mp4 (m4a играется системными
/// плеерами и медиатеками), (3) максимальный битрейт (обычно itag 140
/// ~129 kbps); без m4a — любой аудио-формат (webm/opus).
pub fn pick_audio_format(player: &serde_json::Value) -> Option<AudioPick> {
    let formats = player
        .pointer("/streamingData/adaptiveFormats")?
        .as_array()?;
    let audio = |f: &serde_json::Value| -> Option<(bool, bool, u64, AudioPick)> {
        let mime = f.get("mimeType")?.as_str()?.trim().to_ascii_lowercase();
        if !mime.starts_with("audio/") {
            return None;
        }
        let url = f.get("url")?.as_str()?;
        if url.is_empty() {
            return None;
        }
        Some((
            f.get("xtags").and_then(|x| x.as_str()).unwrap_or("").is_empty(),
            mime.starts_with("audio/mp4"),
            fmt_bitrate(f),
            AudioPick {
                url: url.to_string(),
                mime,
            },
        ))
    };
    formats
        .iter()
        .filter_map(audio)
        .max_by_key(|(primary, mp4, bitrate, _)| (*primary, *mp4, *bitrate))
        .map(|(_, _, _, pick)| pick)
}

/// Расширение файла по mimeType дорожки.
pub fn audio_ext(mime: &str) -> &'static str {
    if mime.starts_with("audio/mp4") {
        "m4a"
    } else {
        "webm"
    }
}

/// Потолок имени файла (с расширением) — длинные заголовки клипнутся.
const FILENAME_MAX_CHARS: usize = 120;

/// Имя файла музыки из заголовка видео: буквы/цифры/пробелы и безопасная
/// пунктуация, прочее → пробел, пробелы схлопываются; пусто/мусор —
/// «youtube-audio». Как sanitize_filename десктопа (download/mod.rs), но
/// здесь независимая копия: десктопный модуль не компилируется мобильным
/// таргетам либы.
pub fn music_filename(title: &str, ext: &str) -> String {
    let mut name = String::new();
    let mut last_space = true; // схлопывает пробелы и не даёт начать с него
    for ch in title.chars() {
        let keep = ch.is_alphanumeric() || matches!(ch, ' ' | '-' | '_' | '&' | '\'' | '(' | ')' | ',' | '.' | '!');
        if !keep || (ch == ' ' && last_space) {
            if !last_space {
                name.push(' ');
                last_space = true;
            }
            continue;
        }
        name.push(ch);
        last_space = ch == ' ';
    }
    let name = name.trim().to_string();
    let stem: String = name.chars().take(FILENAME_MAX_CHARS).collect();
    let stem = stem.trim().to_string();
    if stem.is_empty() {
        format!("youtube-audio.{ext}")
    } else {
        format!("{stem}.{ext}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Живая диагностика PO-гейтинга googlevideo (duopulse-121): тот же
    /// ureq+rustls, что в приложении. Запуск вручную: cargo test --lib
    /// mobile_download -- --ignored — в обычные прогоны не входит.
    #[test]
    #[ignore = "живая сеть"]
    fn live_probe_stream_urls() {
        let body = r#"{"context":{"client":{"clientName":"ANDROID","clientVersion":"20.10.38"}},"videoId":"iG9CE55wbtY","contentCheckOk":true,"racyCheckOk":true}"#;
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(20))
            .build();
        let resp = agent
            .post("https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8")
            .set("Content-Type", "application/json")
            .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
            .set("Accept-Language", "en-US,en")
            .send_string(body)
            .expect("innertube");
        let player: serde_json::Value = resp.into_string().expect("тело").parse().expect("json");
        let pick = pick_audio_format(&player).expect("аудио-формат");
        println!("picked mime={} url.len={}", pick.mime, pick.url.len());
        match agent
            .get(pick.url.as_str())
            .set("User-Agent", "Mozilla/5.0")
            .set("Range", "bytes=0-99")
            .call()
        {
            Ok(r) => println!("GET -> {}", r.status()),
            Err(ureq::Error::Status(c, _)) => println!("GET -> HTTP {c}"),
            Err(e) => println!("GET -> err {e}"),
        }
    }

    fn player(mime: &str, bitrate: u64, url: &str) -> serde_json::Value {
        json!({"streamingData": {"adaptiveFormats": [
            {"mimeType": "video/mp4; codecs=\"avc1\"", "bitrate": 999999, "url": "https://v.example/v"},
            {"mimeType": mime, "bitrate": bitrate, "url": url},
        ]}})
    }

    #[test]
    fn picks_audio_not_video_prefers_m4a_and_bitrate() {
        // m4a выигрывает у webm даже с меньшим битрейтом (совместимость плееров)
        let both = json!({"streamingData": {"adaptiveFormats": [
            {"mimeType": "audio/webm; codecs=\"opus\"", "bitrate": 160000, "url": "https://a.example/w"},
            {"mimeType": "audio/mp4; codecs=\"mp4a.40.2\"", "bitrate": 129000, "url": "https://a.example/m"},
        ]}});
        let pick = pick_audio_format(&both).expect("есть аудио");
        assert_eq!((pick.mime.as_str(), pick.url.as_str()), ("audio/mp4; codecs=\"mp4a.40.2\"", "https://a.example/m"));
        assert_eq!(audio_ext(&pick.mime), "m4a");
        // без m4a — максимум битрейта
        let webm_only = player("audio/webm", 48000, "https://a.example/lo");
        let pick = pick_audio_format(&webm_only).expect("есть аудио");
        assert_eq!(audio_ext(&pick.mime), "webm");
        // только видео / подписанные url без поля url — дорожки нет
        let video_only = json!({"streamingData": {"adaptiveFormats": [
            {"mimeType": "video/mp4", "bitrate": 1, "url": "https://v.example/v"},
            {"mimeType": "audio/mp4", "bitrate": 129000, "signatureCipher": "s=..."},
        ]}});
        assert!(pick_audio_format(&video_only).is_none());
        assert!(pick_audio_format(&json!({})).is_none());
        // дубль DRC (xtags, живой ответ ANDROID-клиента) не должен побеждать
        // оригинальную дорожку того же битрейта
        let with_drc = json!({"streamingData": {"adaptiveFormats": [
            {"mimeType": "audio/mp4", "bitrate": 129476, "xtags": "CggKA2RyYxIBMQ", "url": "https://a.example/drc"},
            {"mimeType": "audio/mp4", "bitrate": 129476, "url": "https://a.example/main"},
        ]}});
        let pick = pick_audio_format(&with_drc).expect("есть аудио");
        assert_eq!(pick.url, "https://a.example/main");
        // bitrate нет → averageBitrate, нет → 0 (не паникует)
        let no_bitrate = json!({"streamingData": {"adaptiveFormats": [
            {"mimeType": "audio/mp4", "url": "https://a.example/x"},
        ]}});
        assert!(pick_audio_format(&no_bitrate).is_some());
    }

    #[test]
    fn filename_sanitized_and_capped() {
        // буквы любых языков остаются, слэш → пробел
        assert_eq!(music_filename("PSY - GANGNAM STYLE(강남스타일) M/V", "m4a"), "PSY - GANGNAM STYLE(강남스타일) M V.m4a");
        assert_eq!(music_filename("  a \u{0}\t b  ", "m4a"), "a b.m4a");
        assert_eq!(music_filename("///", "m4a"), "youtube-audio.m4a");
        assert_eq!(music_filename("", "webm"), "youtube-audio.webm");
        let long = "x".repeat(500);
        let name = music_filename(&long, "m4a");
        assert!(name.chars().count() <= FILENAME_MAX_CHARS + ".m4a".len(), "{name}");
        assert!(name.ends_with(".m4a"));
    }
}

// --- мобильная сетевая часть -----------------------------------------------------

#[cfg(any(target_os = "android", target_os = "ios"))]
pub(crate) mod cmd {
    use super::*;

    use std::io::{Read, Write};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};

    use serde::Serialize;
    use tauri::{AppHandle, Emitter, State};

    use crate::duo_mobile::net::{player_response, DuoManaged};
    use crate::duo_mobile::{check_fetch_url, USER_AGENT};

    /// Попыток скачивания с докачкой (меньше OTA: дорожка — единицы МБ).
    const MAX_ATTEMPTS: u32 = 3;
    /// Троттлинг событий прогресса — на каждые ~128 КиБ (музыка меньше APK).
    const EMIT_STEP: u64 = 128 * 1024;

    #[derive(Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct MusicProgress {
        video_id: String,
        downloaded: u64,
        total: u64,
    }

    /// Одна загрузка одновременно (иначе два tmp-файла под один videoId и
    /// гонка событий; кнопка UI и так блокируется, это страховка команд).
    static BUSY: AtomicBool = AtomicBool::new(false);

    fn agent() -> ureq::Agent {
        ureq::AgentBuilder::new()
            .timeout_connect(std::time::Duration::from_secs(10))
            .timeout_read(std::time::Duration::from_secs(30))
            .build()
    }

    /// tmp-каталог cacheDir/music (как updates у OTA; чистим при выходе).
    fn music_dir() -> Result<PathBuf, String> {
        let dir = cache_dir()?.join("music");
        std::fs::create_dir_all(&dir).map_err(|e| format!("cache: {e}"))?;
        Ok(dir)
    }

    /// cacheDir приложения (тот же JNI-путь, что у OTA-скачивателя).
    #[cfg(target_os = "android")]
    fn cache_dir() -> Result<PathBuf, String> {
        jni_impl::app_cache_dir()
    }

    /// iOS-ветки в проекте нет — сигнатура для компиляции команды.
    #[cfg(all(not(target_os = "android"), target_os = "ios"))]
    fn cache_dir() -> Result<PathBuf, String> {
        Err("загрузка музыки поддержана только на Android".into())
    }

    /// duo_download_music: дорожка → поток в tmp (события прогресса,
    /// докачка Range) → MediaStore/music-каталог (Kotlin-хелпер) → «ok: …».
    /// Возврат — имя сохранённого файла для строки статуса UI.
    #[tauri::command]
    pub fn duo_download_music(
        app: AppHandle,
        video_id: String,
        state: State<'_, DuoManaged>,
    ) -> Result<String, String> {
        if !crate::duo_mobile::valid_video_id(&video_id) {
            return Err("некорректный videoId".into());
        }
        if BUSY.swap(true, Ordering::SeqCst) {
            return Err("загрузка уже идёт — дождитесь её конца".into());
        }
        let out = download_music(&app, &video_id, &state);
        BUSY.store(false, Ordering::SeqCst);
        out
    }

    /// e2e/диагностика (только debug-сборки): прогнать готовый файл через тот
    /// же путь сохранения в медиатеку, что и у загрузки музыки — googlevideo
    /// с эмулятора бот-блокирует стрим (живой прогон duopulse-121), а
    /// MediaStore/JNI-часть проверить надо; в release команду не собираем.
    #[cfg(debug_assertions)]
    #[tauri::command]
    pub fn duo_debug_save_music(src: String, display: String, mime: String) -> Result<String, String> {
        let place = platform::save_to_library(std::path::Path::new(&src), &display, &mime)?;
        Ok(format!("ok {place}"))
    }

    /// Ошибка сети без простыни подписанного URL (ureq включает его в Display
    /// ошибки статуса — строка статуса на пол-экрана; для пользователя — код).
    fn net_error(e: &ureq::Error) -> String {
        match e {
            ureq::Error::Status(code, _) => format!("HTTP {code}"),
            other => format!("сеть: {other}"),
        }
    }

    fn download_music(
        app: &AppHandle,
        video_id: &str,
        state: &DuoManaged,
    ) -> Result<String, String> {
        let player = player_response(video_id, state)?;
        let title = player
            .pointer("/videoDetails/title")
            .and_then(|t| t.as_str())
            .unwrap_or_default();
        let pick = pick_audio_format(&player).ok_or("у видео нет доступной аудиодорожки")?;
        let url = check_fetch_url(&pick.url)?;
        let ext = audio_ext(&pick.mime);
        let hint_total = player
            .pointer("/streamingData/adaptiveFormats")
            .and_then(|f| f.as_array())
            .and_then(|a| {
                a.iter()
                    .find(|f| f.get("url").and_then(|u| u.as_str()) == Some(pick.url.as_str()))
            })
            .and_then(|f| f.get("contentLength"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let dir = music_dir()?;
        let dest = dir.join(format!("{videoId}.part", videoId = video_id));
        let display = music_filename(if title.is_empty() { video_id } else { title }, ext);
        let _ = std::fs::remove_file(&dest); // недокачанное с прошлого раза не докачиваем: подпись URL могла истечь
        let mut downloaded: u64 = 0;
        let mut total = hint_total;
        let mut last_emit: u64 = u64::MAX;
        let emit = |downloaded: u64, total: u64, last_emit: &mut u64| {
            let _ = app.emit(
                "duopulse:mobile-music-progress",
                MusicProgress {
                    video_id: video_id.to_string(),
                    downloaded,
                    total,
                },
            );
            *last_emit = downloaded;
        };
        let mut last_err = String::new();
        'attempts: for _ in 1..=MAX_ATTEMPTS {
            // googlevideo отвечает 403 на GET без Range (живая проба
            // 11.11: plain GET → 403, Range: bytes=0- → 206) — просим диапазон
            // всегда: с нуля «bytes=0-», при докачке «bytes=N-».
            let mut request = agent()
                .get(pick.url.as_str())
                .set("User-Agent", USER_AGENT)
                .set("Range", format!("bytes={downloaded}-").as_str());
            let resp = match request.call() {
                Ok(r) => r,
                Err(e) => {
                    last_err = net_error(&e);
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    continue 'attempts;
                }
            };
            let status = resp.status();
            // 206 → докачка с downloaded; 200 — сервер игнорировал Range
            if status == 200 && downloaded > 0 {
                downloaded = 0;
                let _ = std::fs::remove_file(&dest);
            }
            if status != 200 && status != 206 {
                last_err = format!("HTTP {status}");
                std::thread::sleep(std::time::Duration::from_millis(500));
                continue 'attempts;
            }
            if let Some(len) = resp
                .header("Content-Length")
                .and_then(|v| v.parse::<u64>().ok())
            {
                if status == 206 {
                    total = downloaded + len;
                } else if len > 0 {
                    total = len;
                }
            }
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&dest)
                .map_err(|e| format!("tmp-файл: {e}"))?;
            let mut reader = resp.into_reader();
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        file.write_all(&buf[..n])
                            .map_err(|e| format!("запись: {e}"))?;
                        downloaded += n as u64;
                        if last_emit == u64::MAX || downloaded.saturating_sub(last_emit) >= EMIT_STEP {
                            emit(downloaded, total, &mut last_emit);
                        }
                    }
                    Err(e) => {
                        // обрыв: попытка докачки со следующей итерации
                        last_err = format!("чтение: {e}");
                        std::thread::sleep(std::time::Duration::from_millis(500));
                        continue 'attempts;
                    }
                }
            }
            file.flush().map_err(|e| format!("запись: {e}"))?;
            emit(downloaded, total, &mut last_emit);
            if total > 0 && downloaded < total {
                last_err = "дорожка скачана не целиком".into();
                continue 'attempts;
            }
            // готово: tmp → медиатека/каталог (Kotlin), tmp убираем в любом случае
            let saved = platform::save_to_library(&dest, &display, &pick.mime);
            let _ = std::fs::remove_file(&dest);
            return match saved {
                Ok(place) => Ok(format!("{display} · {place}")),
                Err(e) => Err(e),
            };
        }
        let _ = std::fs::remove_file(&dest);
        Err(format!("скачивание не удалось за {MAX_ATTEMPTS} попыток: {last_err}"))
    }

    #[cfg(target_os = "android")]
    mod jni_impl {
        use crate::mobile_jni::{app_class, jstr, with_jni};

        /// cacheDir приложения: как у OTA (mobile_updater), через контекст.
        pub fn app_cache_dir() -> Result<std::path::PathBuf, String> {
            with_jni(|env, context| {
                let dir = crate::mobile_jni::call_obj(
                    env,
                    context,
                    "getCacheDir",
                    "()Ljava/io/File;",
                )?;
                let path = crate::mobile_jni::call_string(env, &dir, "getAbsolutePath", "()Ljava/lang/String;")?;
                Ok(std::path::PathBuf::from(path))
            })
        }

        /// Перенос готового файла в медиатеку — Kotlin-хелпер (MediaStore на
        /// API ≥29, каталог приложения ниже): из Rust один статический вызов,
        /// исключения гасятся в Kotlin и возвращаются строкой.
        pub fn save_to_library(src: &std::path::Path, display: &str, mime: &str) -> Result<String, String> {
            let src = src.to_string_lossy().into_owned();
            with_jni(|env, context| {
                let helper = app_class(env, context, "dev.duopulse.mobile.MobileDownloadHelper")?;
                let jsrc = jstr(env, &src)?;
                let jdisplay = jstr(env, display)?;
                let jmime = jstr(env, mime)?;
                let r = env
                    .call_static_method(
                        &helper,
                        "saveMusic",
                        "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
                        &[context.into(), (&jsrc).into(), (&jdisplay).into(), (&jmime).into()],
                    )
                    .map_err(|e| format!("helper: {e}"))?
                    .l()
                    .map_err(|e| format!("helper: {e}"))?;
                let js = jni::objects::JString::from(r);
                env.get_string(&js)
                    .map(|s| s.to_string_lossy().into_owned())
                    .map_err(|e| format!("helper str: {e}"))
            })
            .and_then(|r| {
                if let Some(place) = r.strip_prefix("ok:") {
                    Ok(place.to_string())
                } else {
                    Err(r.strip_prefix("error:").unwrap_or(&r).to_string())
                }
            })
        }
    }

    #[cfg(target_os = "android")]
    use jni_impl as platform;

    /// iOS-ветки нет — заглушки для компиляции команды.
    #[cfg(all(not(target_os = "android"), target_os = "ios"))]
    mod platform {
        pub fn save_to_library(
            _src: &std::path::Path,
            _display: &str,
            _mime: &str,
        ) -> Result<String, String> {
            Err("загрузка музыки поддержана только на Android".into())
        }
    }
}

// Хендлер команд собирает lib.rs по ПУТИ (generate_handler! резолвит скрытые
// __cmd__-элементы рядом с функцией): mobile_download::cmd::duo_download_music,
// как duo_mobile::net (см. комментарий в duo_mobile.rs).
