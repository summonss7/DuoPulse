//! Загрузки с YouTube мобильной веткой (карточки duopulse-121 → duopulse-122).
//! Десктоп качает yt-dlp+deno+ffmpeg (download/, duopulse-118) — на Android
//! этих бинарников нет. 121 качала лучшую аудиодорожку нативным ureq; живой
//! опыт показал: googlevideo на реальных устройствах отбивает такой клиент
//! HTTP 403 (бот-блок), при этом плеер в том же WebView стримит без проблем,
//! а CORS на медиа googlevideo даёт только origin youtube.com (пробы
//! 11–12.11.2026). Поэтому транспорт другой (duopulse-122):
//!
//! 1) медиа-байты качает fetch ВНУТРИ youtube-документа — document-start
//!    скрипт assets/duopulse/dl-fetcher.js (регистрирует MainActivity.
//!    onWebViewCreate → MobileDownloadHelper.registerFetcher, wry inject'ит
//!    только в свои фреймы, а тут все youtube-фреймы) — тем же движком,
//!    куками и TLS, что и воспроизведение; байты идут postMessage→invoke;
//! 2) этот модуль отдаёт список форматов (duo_mobile_formats: тот же
//!    innertube ANDROID-клиент, кэш общий с субтитрами), принимает чанки
//!    base64 (duo_download_begin/append) и сохраняет готовый файл в медиатеку
//!    (duo_download_finish — Music для аудио, Movies для видео) или склеивает
//!    видео+звук в один MP4 без перекодирования (duo_download_finish_mux →
//!    Kotlin MediaMuxer; ffmpeg на Android нет, а YouTube отдаёт DASH-дорожки
//!    раздельно);
//! 3) субтитры — duo_download_subtitle: baseUrl дорожки + &fmt=vtt (ureq —
//!    timedtext бот-блоком не бьётся, путь уже кормит duo_fetch_cues),
//!    конвертация WebVTT→SRT (как десктопный yt-dlp --convert-subs srt),
//!    сохранение в Download/DuoPulse.
//!
//! Чистые функции (список форматов, VTT→SRT, base64, имена) компилируются
//! везде и покрыты хостовыми тестами; сетевая и файловая части — только
//! мобильным таргетам.

use serde::Serialize;

/// Пункт списка форматов для мобильного листа загрузки (аудио или видео).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaFormatEntry {
    pub itag: u64,
    /// Полный mimeType дорожки («audio/mp4; codecs=…»).
    pub mime: String,
    /// Расширение файла (m4a/webm/mp4).
    pub ext: String,
    pub url: String,
    /// Битрейт, бит/с (0 — не указан).
    pub bitrate: u64,
    /// contentLength дорожки (0 — неизвестен).
    pub size: u64,
    /// qualityLabel видео («720p»), у аудио пусто.
    pub quality: String,
    pub fps: u64,
    /// Видео со звуком (прогрессивный itag 18) — склейка не нужна.
    pub muxed: bool,
}

/// Дорожка субтитров для загрузки (.srt).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubTrackEntry {
    /// Читаемое имя («Russian», «French (auto-generated)» в ответе уже с ним).
    pub name: String,
    pub lang: String,
    /// Распознано автоматически (kind=asr).
    pub asr: bool,
    pub url: String,
}

/// Список загрузок по видео: аудио/видео форматы + дорожки субтитров.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuoFormats {
    pub title: String,
    pub audio: Vec<MediaFormatEntry>,
    pub video: Vec<MediaFormatEntry>,
    pub subs: Vec<SubTrackEntry>,
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
pub fn pick_audio_format(player: &serde_json::Value) -> Option<(String, String)> {
    let formats = player
        .pointer("/streamingData/adaptiveFormats")?
        .as_array()?;
    let audio = |f: &serde_json::Value| -> Option<(bool, bool, u64, String, String)> {
        let mime = f.get("mimeType")?.as_str()?.trim().to_ascii_lowercase();
        if !mime.starts_with("audio/") {
            return None;
        }
        let url = f.get("url")?.as_str()?.to_string();
        if url.is_empty() {
            return None;
        }
        Some((
            f.get("xtags").and_then(|x| x.as_str()).unwrap_or("").is_empty(),
            mime.starts_with("audio/mp4"),
            fmt_bitrate(f),
            url,
            mime,
        ))
    };
    formats
        .iter()
        .filter_map(audio)
        .max_by_key(|(primary, mp4, bitrate, _, _)| (*primary, *mp4, *bitrate))
        .map(|(_, _, _, url, mime)| (url, mime))
}

/// Расширение файла по mimeType дорожки.
pub fn audio_ext(mime: &str) -> &'static str {
    if mime.starts_with("audio/mp4") {
        "m4a"
    } else {
        "webm"
    }
}

/// Высота качества из qualityLabel («1080p60» → 1080) для сортировки.
fn quality_height(label: &str) -> u64 {
    label
        .split('p')
        .next()
        .and_then(|digits| digits.parse().ok())
        .unwrap_or(0)
}

/// Размер дорожки в байтах: contentLength из ответа, а если клиент его не
/// положил (VISIONOS/ANDROID часто отдают только в подписанном url) —
/// параметр clen query-строки.
fn fmt_size(f: &serde_json::Value, url: &str) -> u64 {
    if let Some(s) = f.get("contentLength").and_then(|s| s.as_u64()) {
        return s;
    }
    url.split(&['?', '&'][..])
        .find_map(|p| p.strip_prefix("clen="))
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

/// Собрать список загрузок из player-ответа innertube (чистая, тесты на
/// хосте). Аудио: adaptiveFormats audio/* с прямым url, только основные
/// дорожки (без xtags — DRC-дубли 121), по убыванию битрейта. Видео:
/// adaptiveFormats video/mp4 с кодеком avc1 (MediaMuxer склеивает MP4;
/// vp9/av1 в webm в мобильный MP4-контейнер не кладём) + прогрессивные
/// formats[] со звуком (обычно itag 18, 360p — готовый файл без склейки),
/// сортировка по высоте качества. Субтитры: captionTracks с читаемым именем.
pub fn build_formats(player: &serde_json::Value) -> DuoFormats {
    let title = player
        .pointer("/videoDetails/title")
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .to_string();
    let mut audio: Vec<MediaFormatEntry> = Vec::new();
    let mut video: Vec<MediaFormatEntry> = Vec::new();
    let adaptive = player
        .pointer("/streamingData/adaptiveFormats")
        .and_then(|f| f.as_array());
    let progressive = player
        .pointer("/streamingData/formats")
        .and_then(|f| f.as_array());
    for (formats, muxed) in [(adaptive, false), (progressive, true)] {
        for f in formats.into_iter().flatten() {
            let Some(url) = f.get("url").and_then(|u| u.as_str()) else {
                continue; // signatureCipher — расшифровки нет, пропускаем
            };
            if url.is_empty() {
                continue;
            }
            let mime = f
                .get("mimeType")
                .and_then(|m| m.as_str())
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase();
            let itag = f.get("itag").and_then(|i| i.as_u64()).unwrap_or(0);
            let entry = MediaFormatEntry {
                itag,
                mime: mime.clone(),
                ext: String::new(),
                url: url.to_string(),
                bitrate: fmt_bitrate(f),
                size: fmt_size(f, url),
                quality: f
                    .get("qualityLabel")
                    .and_then(|q| q.as_str())
                    .unwrap_or_default()
                    .to_string(),
                fps: f.get("fps").and_then(|v| v.as_u64()).unwrap_or(0),
                muxed,
            };
            if mime.starts_with("audio/") {
                if !muxed && !f.get("xtags").and_then(|x| x.as_str()).unwrap_or("").is_empty() {
                    continue; // DRC-дубль
                }
                let mut e = entry;
                e.ext = audio_ext(&mime).to_string();
                audio.push(e);
            } else if mime.starts_with("video/mp4") && (muxed || mime.contains("avc1")) {
                let mut e = entry;
                e.ext = "mp4".to_string();
                video.push(e);
            }
        }
    }
    audio.sort_by(|a, b| b.bitrate.cmp(&a.bitrate).then(b.itag.cmp(&a.itag)));
    video.sort_by(|a, b| {
        quality_height(&b.quality)
            .cmp(&quality_height(&a.quality))
            .then(b.bitrate.cmp(&a.bitrate))
    });
    let subs = player
        .pointer("/captions/playerCaptionsTracklistRenderer/captionTracks")
        .and_then(|t| t.as_array())
        .map(|tracks| {
            tracks
                .iter()
                .filter_map(|t| {
                    let url = t.get("baseUrl")?.as_str()?.to_string();
                    if url.is_empty() {
                        return None;
                    }
                    let name = t
                        .pointer("/name/simpleText")
                        .and_then(|n| n.as_str())
                        .or_else(|| t.pointer("/name/runs/0/text").and_then(|n| n.as_str()))
                        .unwrap_or_default()
                        .to_string();
                    Some(SubTrackEntry {
                        name,
                        lang: t
                            .get("languageCode")
                            .and_then(|l| l.as_str())
                            .unwrap_or_default()
                            .to_string(),
                        asr: t.get("kind").and_then(|k| k.as_str()) == Some("asr"),
                        url,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    DuoFormats { title, audio, video, subs }
}

/// Потолок имени файла (с расширением) — длинные заголовки клипнутся.
const FILENAME_MAX_CHARS: usize = 120;

/// Имя файла из заголовка видео: буквы/цифры/пробелы и безопасная
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

/// base64 (стандартный алфавит с padding) → байты; чанки IPC от фронтенда
/// (энкодер — btoa в JS). Крейт base64 напрямую не подключен (эталон
/// subtitles::fonts::base64) — локальный декодер без новой зависимости.
pub fn decode_base64(s: &str) -> Result<Vec<u8>, String> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut vals = Vec::with_capacity(s.len());
    for (i, ch) in s.bytes().enumerate() {
        match ch {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/' => {
                vals.push(TABLE.iter().position(|&t| t == ch).unwrap_or(0) as u32);
            }
            b'=' => {
                let tail = s.len() - i;
                if tail > 2 || s.len() % 4 != 0 || !s[i..].bytes().all(|c| c == b'=') {
                    return Err("некорректный base64".into());
                }
                break;
            }
            _ => return Err("некорректный base64".into()),
        }
    }
    if s.len() % 4 != 0 || vals.is_empty() {
        if s.is_empty() {
            return Ok(Vec::new());
        }
        return Err("некорректный base64".into());
    }
    let mut out = Vec::with_capacity(vals.len() / 4 * 3);
    for group in vals.chunks(4) {
        let n = (group[0] << 18) | (group[1] << 12) | (group.get(2).copied().unwrap_or(0) << 6)
            | group.get(3).copied().unwrap_or(0);
        out.push((n >> 16) as u8);
        if group.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if group.len() > 3 {
            out.push(n as u8);
        }
    }
    Ok(out)
}

/// WebVTT (timedtext &fmt=vtt) → SRT: заголовки/NOTE/STYLE прочь, тайминги
/// «00:00:01.000» → «00:00:01,000», настройки cue (align/position…) прочь,
/// karaoke-теги <…> из текста вырезаются, нумерация блоков своя. Форма
/// с минутами без часов («01:02.5») добивается до «HH:MM:SS,mmm» — SRT
/// требует часы.
pub fn vtt_to_srt(body: &str) -> String {
    /// Метка VTT «[HH:]MM:SS.mmm» → SRT «HH:MM:SS,mmm».
    fn stamp(t: &str) -> Option<String> {
        let (hms, ms) = t.trim().split_once('.')?;
        let segs: Vec<&str> = hms.split(':').collect();
        if segs.len() < 2 || segs.len() > 3 {
            return None;
        }
        let (h, m, s) = match segs.as_slice() {
            [m, s] => ("00".to_string(), m.to_string(), s.to_string()),
            [h, m, s] => (h.to_string(), m.to_string(), s.to_string()),
            _ => return None,
        };
        let ms = format!("{ms:0<3}");
        Some(format!("{h:0>2}:{m:0>2}:{s:0>2},{}", &ms[..3]))
    }
    let strip_tags = |line: &str| -> String {
        let mut out = String::new();
        let mut depth = 0usize;
        for ch in line.chars() {
            match ch {
                '<' => depth += 1,
                '>' if depth > 0 => depth -= 1,
                c if depth == 0 => out.push(c),
                _ => {}
            }
        }
        out.trim().to_string()
    };
    let mut out_blocks: Vec<String> = Vec::new();
    let mut lines = body.lines().peekable();
    // заголовочный блок до первой пустой строки (WEBVTT, STYLE, REGION)
    while let Some(line) = lines.peek() {
        if line.trim().is_empty() {
            lines.next();
            break;
        }
        lines.next();
    }
    let mut text: Vec<String> = Vec::new();
    let mut timing: Option<(String, String)> = None;
    let flush = |timing: &mut Option<(String, String)>, text: &mut Vec<String>, out: &mut Vec<String>| {
        if let Some((start, end)) = timing.take() {
            if !text.is_empty() {
                out.push(format!(
                    "{}\n{} --> {}\n{}",
                    out.len() + 1,
                    start,
                    end,
                    text.join("\n")
                ));
            }
        }
        text.clear();
    };
    while let Some(line) = lines.next() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            flush(&mut timing, &mut text, &mut out_blocks);
            continue;
        }
        if trimmed == "NOTE" || trimmed.starts_with("NOTE ") {
            // блок-комментарий до пустой строки
            while let Some(l) = lines.next() {
                if l.trim().is_empty() {
                    break;
                }
            }
            flush(&mut timing, &mut text, &mut out_blocks);
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("WEBVTT") {
            let _ = rest;
            continue;
        }
        if let Some((start_raw, end_raw)) = trimmed.split_once("-->") {
            flush(&mut timing, &mut text, &mut out_blocks);
            let start = stamp(start_raw);
            let end = stamp(end_raw.split_whitespace().next().unwrap_or(""));
            if let (Some(start), Some(end)) = (start, end) {
                timing = Some((start, end));
            }
            continue;
        }
        if timing.is_some() {
            let clean = strip_tags(trimmed);
            if !clean.is_empty() {
                text.push(clean);
            }
        }
        // строка до тайминга — идентификатор cue, пропускаем (нумерация своя)
    }
    flush(&mut timing, &mut text, &mut out_blocks);
    out_blocks.join("\n\n")
}

/// Сессия посетителя YouTube для innertube-клиента загрузок (duopulse-122):
/// куки Set-Cookie watch-страницы + visitorData из её HTML (без них клиент
/// VISIONOS отвечает LOGIN_REQUIRED). Компилируется на всех таргетах —
/// чистый разбор тестируется на хосте.
pub struct WatchSession {
    pub cookie: String,
    pub visitor: String,
}

/// Собрать сессию из сырых Set-Cookie и тела watch-страницы.
pub fn parse_watch_session(set_cookies: &[&str], body: &str) -> Option<WatchSession> {
    let mut parts: Vec<String> = Vec::new();
    for raw in set_cookies {
        // «NAME=value; Path=/; ...» → «NAME=value»
        if let Some(pair) = raw.split(';').next() {
            let pair = pair.trim();
            match pair.split_once('=') {
                Some((name, _)) if !name.is_empty() => parts.push(pair.to_string()),
                _ => {}
            }
        }
    }
    let marker = "\"visitorData\":\"";
    let start = body.find(marker)? + marker.len();
    let end = body[start..].find('"')? + start;
    let visitor = &body[start..end];
    if parts.is_empty() || visitor.len() < 16 {
        return None;
    }
    Some(WatchSession {
        cookie: parts.join("; "),
        visitor: visitor.to_string(),
    })
}

/// Играбельный player-ответ или ошибка с причиной (общее для клиентов).
pub fn playable_or_err(value: serde_json::Value) -> Result<serde_json::Value, String> {
    if let Some(status) = value
        .pointer("/playabilityStatus/status")
        .and_then(|s| s.as_str())
    {
        if status != "OK" {
            let reason = value
                .pointer("/playabilityStatus/reason")
                .and_then(|r| r.as_str())
                .unwrap_or("видео недоступно");
            return Err(format!("YouTube: {reason}"));
        }
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Живая диагностика форматов (duopulse-121/122): тот же ureq+rustls,
    /// что в приложении. Запуск вручную: cargo test --lib mobile_download
    /// -- --ignored — в обычные прогоны не входит.
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
        let formats = build_formats(&player);
        println!(
            "title={} audio={} video={} subs={}",
            formats.title,
            formats.audio.len(),
            formats.video.len(),
            formats.subs.len()
        );
        for e in &formats.video {
            println!("video {} {} muxed={} size={}", e.itag, e.quality, e.muxed, e.size);
        }
        let pick = formats.audio.first().expect("аудио-формат");
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

    fn player() -> serde_json::Value {
        json!({
            "videoDetails": {"title": "PSY - Test"},
            "streamingData": {
                "formats": [
                    {"itag": 18, "mimeType": "video/mp4; codecs=\"avc1.42E01E, mp4a.40.2\"", "bitrate": 500000, "qualityLabel": "360p", "fps": 30, "url": "https://rr.example/googlevideo.com/videoplayback?mux", "contentLength": 1000}
                ],
                "adaptiveFormats": [
                    {"itag": 137, "mimeType": "video/mp4; codecs=\"avc1.640028\"", "bitrate": 3000000, "qualityLabel": "1080p", "fps": 30, "url": "https://v.example/1080", "contentLength": 119},
                    {"itag": 248, "mimeType": "video/webm; codecs=\"vp9\"", "bitrate": 3500000, "qualityLabel": "1080p", "url": "https://v.example/webm"},
                    {"itag": 399, "mimeType": "video/mp4; codecs=\"av01.0.08M.08\"", "bitrate": 2500000, "qualityLabel": "1080p", "url": "https://v.example/av1"},
                    {"itag": 136, "mimeType": "video/mp4; codecs=\"avc1.4d401f\"", "bitrate": 1500000, "qualityLabel": "720p", "fps": 30, "url": "https://v.example/720"},
                    {"mimeType": "audio/mp4; codecs=\"mp4a.40.2\"", "bitrate": 129476, "xtags": "CggKA2RyYxIBMQ", "url": "https://a.example/drc"},
                    {"mimeType": "audio/mp4; codecs=\"mp4a.40.2\"", "bitrate": 129476, "itag": 140, "url": "https://a.example/main", "contentLength": 4624883},
                    {"mimeType": "audio/webm; codecs=\"opus\"", "bitrate": 160000, "itag": 251, "url": "https://a.example/opus"},
                    {"mimeType": "audio/mp4", "bitrate": 48000, "itag": 139, "url": "https://a.example/lo"},
                    {"mimeType": "audio/mp4", "bitrate": 1, "signatureCipher": "s=..."}
                ]
            },
            "captions": {"playerCaptionsTracklistRenderer": {"captionTracks": [
                {"baseUrl": "https://www.youtube.com/api/timedtext?v=1&lang=fr", "languageCode": "fr", "kind": "asr", "name": {"simpleText": "French (auto-generated)"}},
                {"baseUrl": "https://www.youtube.com/api/timedtext?v=1&lang=en", "languageCode": "en", "name": {"runs": [{"text": "English"}]}}
            ]}}
        })
    }

    #[test]
    fn builds_formats_sorted_and_filtered() {
        let f = build_formats(&player());
        assert_eq!(f.title, "PSY - Test");
        // аудио: без DRC-дубля и подписанных, по убыванию битрейта
        let itags: Vec<u64> = f.audio.iter().map(|e| e.itag).collect();
        assert_eq!(itags, vec![251, 140, 139]);
        assert_eq!(f.audio[1].ext, "m4a");
        assert_eq!(f.audio[1].size, 4624883);
        // видео: только avc1/прогрессив (vp9/av1-webm отфильтрованы), по высоте
        let labels: Vec<(String, bool)> = f.video.iter().map(|e| (e.quality.clone(), e.muxed)).collect();
        assert_eq!(labels, vec![("1080p".into(), false), ("720p".into(), false), ("360p".into(), true)]);
        assert_eq!(f.video[0].itag, 137);
        // субтитры: имя из simpleText и runs, asr-флаг
        assert_eq!(f.subs.len(), 2);
        assert_eq!((f.subs[0].lang.as_str(), f.subs[0].asr), ("fr", true));
        assert_eq!((f.subs[1].lang.as_str(), f.subs[1].name.as_str()), ("en", "English"));
        // пустой ответ — пустые списки, не паникует
        let empty = build_formats(&json!({}));
        assert!(empty.audio.is_empty() && empty.video.is_empty() && empty.subs.is_empty());
    }

    #[test]
    fn picks_audio_not_video_prefers_m4a_and_bitrate() {
        let player = player();
        let (url, mime) = pick_audio_format(&player).expect("есть аудио");
        // для «одним тапом» остаётся выбор 121: m4a важнее чуть более
        // тяжёлого opus (совместимость системных плееров)
        assert_eq!((url.as_str(), mime.starts_with("audio/mp4")), ("https://a.example/main", true));
        assert!(pick_audio_format(&json!({})).is_none());
    }

    #[test]
    fn watch_сессия_из_куков_и_visitordata() {
        // куки обрезаются до NAME=value, visitorData вытаскивается из HTML
        let sess = parse_watch_session(
            &[
                "VISITOR_INFO1_LIVE=tpGpzM0Y; Path=/; Domain=.youtube.com; Secure",
                "YSC=so1SXRJ79BQ; Path=/; Domain=.youtube.com",
                "=; Path=/",
            ],
            "ytcfg.set({\"visitorData\":\"Cgt0cEdwek0wWUptWSiD0g%3D%3D\",\"other\":1});",
        )
        .expect("сессия");
        assert_eq!(sess.cookie, "VISITOR_INFO1_LIVE=tpGpzM0Y; YSC=so1SXRJ79BQ");
        assert_eq!(sess.visitor, "Cgt0cEdwek0wWUptWSiD0g%3D%3D");
        // без visitorData / без кук / короткий visitor — None (фолбэк на ANDROID)
        assert!(parse_watch_session(&["A=1"], "<html></html>").is_none());
        assert!(parse_watch_session(&[], "x\"visitorData\":\"Cgt0cEdwek0wWUptWSiD0g%3D%3D\"").is_none());
        assert!(parse_watch_session(&["A=1"], "\"visitorData\":\"short\"").is_none());
    }

    #[test]
    fn visionos_формат_лист_с_размерами() {
        // фрагмент живого VISIONOS-ответа (пробы 12.11.2026): contentLength у
        // дорожек есть — лист показывает размеры; playability не-OK — ошибка
        let player = json!({
            "playabilityStatus": {"status": "OK"},
            "videoDetails": {"title": "Le Félin - Gnose"},
            "streamingData": {"adaptiveFormats": [
                {"itag": 140, "mimeType": "audio/mp4; codecs=\"mp4a.40.2\"", "bitrate": 130514,
                 "contentLength": 4624883, "url": "https://rr.example/140"},
                {"itag": 136, "mimeType": "video/mp4; codecs=\"avc1.64001F\"", "bitrate": 1500000,
                 "contentLength": 61635771, "qualityLabel": "720p", "fps": 30, "url": "https://rr.example/136"}
            ]}
        });
        let f = build_formats(&player);
        assert_eq!(f.audio[0].size, 4624883);
        assert_eq!(f.video[0].size, 61635771);
        assert_eq!(f.video[0].quality, "720p");
        // размер из clen url, когда contentLength в JSON нет (VISIONOS/ANDROID)
        assert_eq!(fmt_size(&json!({}), "https://rr.example/v?clen=4624883&dur=1"), 4624883);
        assert_eq!(fmt_size(&json!({}), "https://rr.example/v?dur=1"), 0);
        let err = playable_or_err(json!({"playabilityStatus": {"status": "LOGIN_REQUIRED", "reason": "Sign in"}}))
            .unwrap_err();
        assert_eq!(err, "YouTube: Sign in");
    }

    #[test]
    fn filename_sanitized_and_capped() {
        // буквы любых языков остаются, слэш → пробел
        assert_eq!(music_filename("PSY - GANGNAM STYLE(강남스타일) M/V", "m4a"), "PSY - GANGNAM STYLE(강남스타일) M V.m4a");
        assert_eq!(music_filename("  a \u{0}\t b  ", "m4a"), "a b.m4a");
        assert_eq!(music_filename("///", "m4a"), "youtube-audio.m4a");
        assert_eq!(music_filename("", "webm"), "youtube-audio.webm");
        assert_eq!(music_filename("Song", "fr.srt"), "Song.fr.srt");
        let long = "x".repeat(500);
        let name = music_filename(&long, "m4a");
        assert!(name.chars().count() <= FILENAME_MAX_CHARS + ".m4a".len(), "{name}");
        assert!(name.ends_with(".m4a"));
    }

    #[test]
    fn base64_декодирует_с_padding_и_без() {
        assert_eq!(decode_base64("").unwrap(), Vec::<u8>::new());
        assert_eq!(decode_base64("AA==").unwrap(), vec![0]);
        assert_eq!(decode_base64("AQID").unwrap(), vec![1, 2, 3]);
        assert_eq!(decode_base64("aGVsbG8=").unwrap(), b"hello".to_vec());
        assert_eq!(decode_base64("aGVsbG8h").unwrap(), b"hello!".to_vec());
        // мусор и битый padding отклоняются
        assert!(decode_base64("a").is_err());
        assert!(decode_base64("====").is_err());
        assert!(decode_base64("AA=").is_err());
        assert!(decode_base64("A?ID").is_err());
        // двоичные байты проходят без потерь
        assert_eq!(decode_base64("AAECBP8=").unwrap(), vec![0, 1, 2, 4, 255]);
    }

    #[test]
    fn vtt_в_srt_конвертирует_тайминги_и_чистит_теги() {
        let vtt = "WEBVTT\nKind: captions\n\n1\n00:00:01.000 --> 00:00:04.000 align:start position:0%\n<c>Привет</c> мир\n\n00:01:02.500 --> 00:01:05.250\nвторой <00:00:01.000><c>блок</c>\n";
        let srt = vtt_to_srt(vtt);
        assert_eq!(
            srt,
            "1\n00:00:01,000 --> 00:00:04,000\nПривет мир\n\n2\n00:01:02,500 --> 00:01:05,250\nвторой блок"
        );
        // NOTE-блок и cue без текста исчезают
        let with_note = "WEBVTT\n\nNOTE это комментарий\nна две строки\n\n00:00:00.000 --> 00:00:01.000\n\n00:00:02.000 --> 00:00:03.000\nтекст\n";
        assert_eq!(vtt_to_srt(with_note), "1\n00:00:02,000 --> 00:00:03,000\nтекст");
        assert_eq!(vtt_to_srt("WEBVTT\n\n"), "");
    }

    #[test]
    fn vtt_с_минутами_без_часов_добивается() {
        let vtt = "WEBVTT\n\n01:02.5 --> 01:03.0\nраз\n";
        assert_eq!(vtt_to_srt(vtt), "1\n00:01:02,500 --> 00:01:03,000\nраз");
    }
}

// --- мобильная сетевая часть -----------------------------------------------------

#[cfg(any(target_os = "android", target_os = "ios"))]
pub(crate) mod cmd {
    use super::*;

    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    use serde::Deserialize;
    use tauri::State;

    use crate::duo_mobile::net::player_response;
    use crate::duo_mobile::{check_fetch_url, DuoManaged, USER_AGENT};

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct FinishArgs {
        pub id: String,
        pub video_id: String,
        /// Расширение файла выбранного формата (m4a/webm/mp4).
        pub ext: String,
        /// Полный mimeType дорожки (для MediaStore).
        pub mime: String,
        /// Куда сохранить: audio → Music, video → Movies.
        pub collection: String,
    }

    /// Счётчик идентификаторов загрузок (внутри процесса уникален).
    static DL_SEQ: AtomicU64 = AtomicU64::new(0);

    /// tmp-каталог cacheDir/downloads (как music у 121; чистим при выходе).
    fn downloads_dir() -> Result<PathBuf, String> {
        let dir = cache_dir()?.join("downloads");
        std::fs::create_dir_all(&dir).map_err(|e| format!("cache: {e}"))?;
        Ok(dir)
    }

    /// Путь tmp-файла загрузки; идентификатор — только [A-Za-z0-9_-]
    /// (защита от «../» из IPC).
    fn part_path(id: &str) -> Result<PathBuf, String> {
        if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err("некорректный идентификатор загрузки".into());
        }
        Ok(downloads_dir()?.join(format!("{id}.part")))
    }

    /// cacheDir приложения (тот же JNI-путь, что у OTA-скачивателя).
    #[cfg(target_os = "android")]
    fn cache_dir() -> Result<PathBuf, String> {
        jni_impl::app_cache_dir()
    }

    /// iOS-ветки в проекте нет — сигнатура для компиляции команды.
    #[cfg(all(not(target_os = "android"), target_os = "ios"))]
    fn cache_dir() -> Result<PathBuf, String> {
        Err("загрузки поддержаны только на Android".into())
    }

    fn agent() -> ureq::Agent {
        ureq::AgentBuilder::new()
            .timeout_connect(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(30))
            .build()
    }

    // ── клиент VISIONOS для загрузок (duopulse-122) ─────────────────────────
    //
    // Пробы 12.11.2026 (подробности — шапка assets/duopulse/dl-fetcher.js):
    // googlevideo-URL клиента ANDROID отдают лишь первый ~1 МиБ (дальше 403,
    // даже маленькими диапазонами), WEB-клиенту нужен PO-токен, а VISIONOS
    // (Apple Vision Pro) отвечает direct-url БЕЗ n-параметра — их плеерный
    // диапазон-GET обслуживает целиком (рецепт перенят у yt-dlp 2026.10.26,
    // клиентов tv/visionos). Запросу нужна «сессия посетителя»: куки +
    // visitorData из одного GET watch-страницы (без них LOGIN_REQUIRED).
    // signatureTimestamp жёстко задан (yt-dlp добывает его из JS плеера);
    // ротация YouTube просто уронит VISIONOS-ветку в фолбэк на ANDROID.

    /// UA десктопного Chrome для GET watch-страницы (то же сочетание, что у
    /// yt-dlp; TV/VR-UA получают consent-редирект).
    const WATCH_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                            (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";
    /// UA клиента VISIONOS (должен совпадать с userAgent в context.client).
    const VISIONOS_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) \
                               AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
    /// Текущий signatureTimestamp плеера YouTube (yt-dlp fad7e4e9, окт.2026).
    const SIG_TIMESTAMP: u64 = 20760;    /// Player-ответ innertube клиентом VISIONOS — прямые url дорожек без
    /// n-параметра. Кэш общий с субтитрами (ключ с префиксом «dl:», TTL 1 ч).
    fn visionos_player_response(
        video_id: &str,
        state: &State<'_, DuoManaged>,
    ) -> Result<serde_json::Value, String> {
        let cache_key = format!("dl:{video_id}");
        {
            let cache = state.player_cache.lock().expect("duo: лок не отравлен");
            if let Some((at, v)) = cache.get(&cache_key) {
                if at.elapsed() < crate::duo_mobile::PLAYER_TTL {
                    return Ok(v.clone());
                }
            }
        }
        let watch = agent()
            .get(&format!("https://www.youtube.com/watch?v={video_id}"))
            .set("User-Agent", WATCH_UA)
            .set("Accept-Language", "en-US,en")
            .call()
            .map_err(|e| format!("watch-страница: {e}"))?;
        if watch.status() != 200 {
            return Err(format!("watch-страница HTTP {}", watch.status()));
        }
        let set_cookies: Vec<String> = watch
            .all("set-cookie")
            .into_iter()
            .map(String::from)
            .collect();
        let body = watch
            .into_string()
            .map_err(|e| format!("watch-страница тело: {e}"))?;
        let names: Vec<&str> = set_cookies.iter().map(String::as_str).collect();
        let sess = parse_watch_session(&names, &body)
            .ok_or_else(|| "watch-страница без сессии посетителя".to_string())?;
        let body = serde_json::json!({
            "context": { "client": {
                "clientName": "VISIONOS", "clientVersion": "1.02",
                "deviceMake": "Apple", "deviceModel": "RealityDevice17,1",
                "userAgent": VISIONOS_UA, "osName": "visionOS", "osVersion": "26.5.23O471",
                "hl": "en", "timeZone": "UTC", "utcOffsetMinutes": 0,
            } },
            "videoId": video_id,
            "playbackContext": { "contentPlaybackContext": {
                "html5Preference": "HTML5_PREF_WANTS", "signatureTimestamp": SIG_TIMESTAMP,
            } },
            "contentCheckOk": true,
            "racyCheckOk": true,
        });
        let resp = agent()
            .post("https://www.youtube.com/youtubei/v1/player?prettyPrint=false")
            .set("Content-Type", "application/json")
            .set("User-Agent", VISIONOS_UA)
            .set("Accept-Language", "en-US,en")
            .set("X-Youtube-Client-Name", "101")
            .set("X-Youtube-Client-Version", "1.02")
            .set("Origin", "https://www.youtube.com")
            .set("X-Goog-Visitor-Id", &sess.visitor)
            .set("Cookie", &sess.cookie)
            .send_string(&body.to_string())
            .map_err(|e| format!("innertube сеть: {e}"))?;
        if resp.status() != 200 {
            return Err(format!("innertube HTTP {}", resp.status()));
        }
        let value: serde_json::Value = resp
            .into_string()
            .map_err(|e| format!("innertube тело: {e}"))?
            .trim()
            .parse()
            .map_err(|e| format!("innertube JSON: {e}"))?;
        let out = playable_or_err(value)?;
        let mut cache = state.player_cache.lock().expect("duo: лок не отравлен");
        cache.insert(cache_key, (std::time::Instant::now(), out.clone()));
        Ok(out)
    }

    /// duo_mobile_formats: список для листа загрузки — player-ответ innertube
    /// клиента VISIONOS (прямые url дорожек качаемы диапазонами, см. блок
    /// констант выше); при отказе (бот-стена/ротация клиента) — фолбэк на
    /// ANDROID-ответ субтитров: лист соберётся, но медиа-url могут быть
    /// урезаны (~1 МиБ) — проба загрузки честно скажет 403.
    #[tauri::command]
    pub fn duo_mobile_formats(
        video_id: String,
        state: State<'_, DuoManaged>,
    ) -> Result<DuoFormats, String> {
        if !crate::duo_mobile::valid_video_id(&video_id) {
            return Err("некорректный videoId".into());
        }
        let mut player = None;
        match visionos_player_response(&video_id, &state) {
            Ok(vision) => {
                let formats = build_formats(&vision);
                if !formats.audio.is_empty() || !formats.video.is_empty() {
                    player = Some(vision);
                } else {
                    eprintln!("duo-dl: visionos без форматов — фолбэк ANDROID");
                }
            }
            Err(e) => eprintln!("duo-dl: visionos ошибка: {e} — фолбэк ANDROID"),
        }
        let player = match player {
            Some(v) => v,
            None => player_response(&video_id, &state)?,
        };
        Ok(build_formats(&player))
    }

    /// duo_download_begin: начать сборку файла — идентификатор для append.
    #[tauri::command]
    pub fn duo_download_begin() -> Result<String, String> {
        let id = format!(
            "dl{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0),
            DL_SEQ.fetch_add(1, Ordering::Relaxed)
        );
        downloads_dir()?;
        Ok(id)
    }

    /// duo_download_append: приписать base64-чанк к tmp-файлу загрузки,
    /// ответ — сколько байт уже собрано (прогресс рисует фронтенд).
    #[tauri::command]
    pub fn duo_download_append(id: String, b64: String) -> Result<u64, String> {
        let bytes = decode_base64(&b64)?;
        let path = part_path(&id)?;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| format!("tmp-файл: {e}"))?;
        if !bytes.is_empty() {
            file.write_all(&bytes).map_err(|e| format!("запись: {e}"))?;
        }
        Ok(file.metadata().map_err(|e| format!("tmp-файл: {e}"))?.len())
    }

    /// Имя сохранаемого файла по заголовку видео (кэш player-ответа).
    fn display_name(video_id: &str, ext: &str, state: &DuoManaged) -> Result<String, String> {
        let player = player_response(video_id, state)?;
        let title = player
            .pointer("/videoDetails/title")
            .and_then(|t| t.as_str())
            .unwrap_or_default();
        Ok(music_filename(if title.is_empty() { video_id } else { title }, ext))
    }

    /// duo_download_finish: собранный файл → медиатека (Kotlin-хелпер),
    /// tmp удаляется. Ответ — «имя · место» для строки статуса.
    #[tauri::command]
    pub fn duo_download_finish(
        args: FinishArgs,
        state: State<'_, DuoManaged>,
    ) -> Result<String, String> {
        if !crate::duo_mobile::valid_video_id(&args.video_id) {
            return Err("некорректный videoId".into());
        }
        let collection = match args.collection.as_str() {
            "audio" => "audio",
            "video" => "video",
            other => return Err(format!("неизвестная коллекция: {other}")),
        };
        let path = part_path(&args.id)?;
        let len = std::fs::metadata(&path).map_err(|_| "загрузка не начиналась")?.len();
        if len == 0 {
            let _ = std::fs::remove_file(&path);
            return Err("файл пуст — загрузка не удалась".into());
        }
        let display = display_name(&args.video_id, &args.ext, &state)?;
        let saved = platform::save_media(&path, &display, &args.mime, collection);
        let _ = std::fs::remove_file(&path);
        match saved {
            Ok(place) => Ok(format!("{display} · {place}")),
            Err(e) => Err(e),
        }
    }

    /// duo_download_finish_mux: видеодорожка + аудиодорожка → один MP4
    /// (MediaMuxer в Kotlin, без перекодирования) → Movies/DuoPulse.
    #[tauri::command]
    pub fn duo_download_finish_mux(
        video_id: String,
        video_part: String,
        audio_part: String,
        state: State<'_, DuoManaged>,
    ) -> Result<String, String> {
        if !crate::duo_mobile::valid_video_id(&video_id) {
            return Err("некорректный videoId".into());
        }
        let vpath = part_path(&video_part)?;
        let apath = part_path(&audio_part)?;
        for (what, p) in [("видео", &vpath), ("аудио", &apath)] {
            let len = std::fs::metadata(p).map_err(|_| format!("{what} не скачано"))?.len();
            if len == 0 {
                return Err(format!("{what} скачано пустым"));
            }
        }
        let display = display_name(&video_id, "mp4", &state)?;
        let saved = platform::mux_and_save(&vpath, &apath, &display);
        let _ = std::fs::remove_file(&vpath);
        let _ = std::fs::remove_file(&apath);
        match saved {
            Ok(place) => Ok(format!("{display} · {place}")),
            Err(e) => Err(e),
        }
    }

    /// duo_download_abort: бросить загрузку — удалить tmp.
    #[tauri::command]
    pub fn duo_download_abort(id: String) -> Result<(), String> {
        let path = part_path(&id)?;
        let _ = std::fs::remove_file(&path);
        Ok(())
    }

    /// duo_download_subtitle: дорожка субтитров → .srt в Download/DuoPulse.
    /// timedtext бот-блоком не бьётся (путь уже кормит субтитры duo), поэтому
    /// обычный ureq-GET: baseUrl + &fmt=vtt (WebVTT), конвертация в SRT как у
    /// десктопного yt-dlp --convert-subs srt.
    #[tauri::command]
    pub fn duo_download_subtitle(
        video_id: String,
        url: String,
        lang: String,
        state: State<'_, DuoManaged>,
    ) -> Result<String, String> {
        if !crate::duo_mobile::valid_video_id(&video_id) {
            return Err("некорректный videoId".into());
        }
        check_fetch_url(&url)?;
        let mut vtt_url = url.clone();
        if !vtt_url.contains("fmt=") {
            vtt_url.push_str(if vtt_url.contains('?') { "&fmt=vtt" } else { "?fmt=vtt" });
        }
        let resp = agent()
            .get(vtt_url.as_str())
            .set("User-Agent", USER_AGENT)
            .set("Accept-Language", "en-US,en")
            .call()
            .map_err(|e| match e {
                ureq::Error::Status(code, _) => format!("HTTP {code}"),
                other => format!("сеть: {other}"),
            })?;
        let body = resp
            .into_string()
            .map_err(|e| format!("чтение дорожки: {e}"))?;
        let srt = vtt_to_srt(&body);
        if srt.trim().is_empty() {
            return Err("дорожка субтитров пуста".into());
        }
        let lang = if lang.is_empty() { "subs".into() } else { lang };
        let ext = format!("{lang}.srt");
        let display = display_name(&video_id, &ext, &state)?;
        let tmp = downloads_dir()?.join(format!("sub-{}.srt", std::process::id()));
        std::fs::write(&tmp, srt).map_err(|e| format!("tmp-файл: {e}"))?;
        let saved = platform::save_media(&tmp, &display, "application/x-subrip", "downloads");
        let _ = std::fs::remove_file(&tmp);
        match saved {
            Ok(place) => Ok(format!("{display} · {place}")),
            Err(e) => Err(e),
        }
    }

    /// e2e/диагностика (только debug-сборки): прогнать готовый файл через тот
    /// же путь сохранения в медиатеку, что и у загрузок — googlevideo с
    /// эмулятора бот-блокирует нативный стрим (живой прогон duopulse-121),
    /// а MediaStore/JNI-часть проверить надо; в release команду не собираем.
    #[cfg(debug_assertions)]
    #[tauri::command]
    pub fn duo_debug_save_music(src: String, display: String, mime: String) -> Result<String, String> {
        let place = platform::save_media(std::path::Path::new(&src), &display, &mime, "audio")?;
        Ok(format!("ok {place}"))
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

        fn call_helper(method: &'static str, sig: &'static str, args: &[&str]) -> Result<String, String> {
            with_jni(|env, context| {
                let helper = app_class(env, context, "dev.duopulse.mobile.MobileDownloadHelper")?;
                let jstrs: Vec<jni::objects::JString<'_>> = args
                    .iter()
                    .map(|a| jstr(env, a))
                    .collect::<Result<_, _>>()?;
                let mut jvals: Vec<jni::objects::JValue<'_, '_>> = vec![context.into()];
                for js in &jstrs {
                    jvals.push(js.into());
                }
                let r = env
                    .call_static_method(&helper, method, sig, jvals.as_slice())
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

        /// Перенос готового файла в медиатеку — Kotlin-хелпер (MediaStore на
        /// API ≥29, каталог приложения ниже): из Rust один статический вызов,
        /// исключения гасятся в Kotlin и возвращаются строкой.
        pub fn save_media(
            src: &std::path::Path,
            display: &str,
            mime: &str,
            collection: &str,
        ) -> Result<String, String> {
            call_helper(
                "saveMedia",
                "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
                &[&src.to_string_lossy(), display, mime, collection].map(|s| s.as_ref()),
            )
        }

        /// Склейка видео+аудио в один MP4 и сохранение в Movies (Kotlin).
        pub fn mux_and_save(
            video: &std::path::Path,
            audio: &std::path::Path,
            display: &str,
        ) -> Result<String, String> {
            call_helper(
                "muxAndSave",
                "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
                &[&video.to_string_lossy(), &audio.to_string_lossy(), display].map(|s| s.as_ref()),
            )
        }
    }

    #[cfg(target_os = "android")]
    use jni_impl as platform;

    /// iOS-ветки нет — заглушки для компиляции команды.
    #[cfg(all(not(target_os = "android"), target_os = "ios"))]
    mod platform {
        pub fn save_media(
            _src: &std::path::Path,
            _display: &str,
            _mime: &str,
            _collection: &str,
        ) -> Result<String, String> {
            Err("загрузки поддержаны только на Android".into())
        }
        pub fn mux_and_save(
            _video: &std::path::Path,
            _audio: &std::path::Path,
            _display: &str,
        ) -> Result<String, String> {
            Err("загрузки поддержаны только на Android".into())
        }
    }
}

// Хендлер команд собирает lib.rs по ПУТИ (generate_handler! резолвит скрытые
// __cmd__-элементы рядом с функцией): mobile_download::cmd::duo_mobile_formats
// и остальные команды модуля, как duo_mobile::net (см. комментарий в
// duo_mobile.rs).
