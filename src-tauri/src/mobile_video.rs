//! Приём видео из системы (карточка duopulse-179, мобильная ветка):
//! intent-filter ACTION_VIEW video/* (AndroidManifest, из fileAssociations
//! tauri.android.conf.json) — DuoPulse появляется в «Открыть с помощью».
//! Kotlin-хелпер gen/android (MobileVideoHelper) копирует контентный URI в
//! cache/video/<ts>-<имя> и держит pending-строку (паттерн MobilePdfHelper,
//! duopulse-119; grant-грабля — duopulse-141). Команда mobile_video_take —
//! забрать pending ({path, name} | null) однократно.
//!
//! Сам файл играет <video> фронтенда — но WebView не читает ни content://
//! (хелпер уже скопировал), ни file:// из http-origin приложения, поэтому
//! куски отдаёт кастомный протокол mobilevideo (wry на Android мапит его на
//! http://mobilevideo.localhost, здесь URL приходит «развернутым» обратно в
//! mobilevideo://localhost/…): Range-запросы → 206 + Content-Range, чем
//! кормится перемотка Chromium. wry 0.57 сам держит обход Chromium-бага со
//! скипом префикса у 206 (RustWebViewClient.wrapPartialContentBody).
//! Путь валидируется (is_video_cache_path): протокол читает только файлы
//! cache/video, положенные хелпером, а не произвольные пути системы; для
//! памяти кусок на открытый Range («bytes=N-») режется по потолку RANGE_CAP.
//! Валидаторы/Range-разбор — чистые функции, компилируются и тестируются на
//! хосте (как is_pdf_cache_path); JNI — только Android (паттерн mobile_pdf).

use serde::Serialize;

/// Потолок куска на один Range-запрос (особенно открытый «bytes=N-», каким
/// Chromium зондирует файл): отвечает 206-куском короче запрошенного — это
/// валидно, плеер дозапросит следующее окно. Больше — пустая память JNI,
/// меньше — лишние круги IPC на каждый блок буфера.
pub const RANGE_CAP: u64 = 8 * 1024 * 1024;

/// Разрешённый путь протокола mobilevideo: файл (любого расширения —
/// контейнер определяет Chromium-сниффер, список расширений не закрываем)
/// непосредственно в папке «video» внутри «cache» (кладёт MobileVideoHelper).
/// Отсекает произвольное чтение файлов системы (как is_pdf_cache_path).
pub fn is_video_cache_path(path: &str) -> bool {
    // Путь только с ведущим «/» (абсолютный на Android): Path::is_absolute
    // на Windows-хосте (тесты) для «/data/…» ложно — нет буквы диска.
    if !path.starts_with('/') {
        return false;
    }
    let p = std::path::Path::new(path);
    let has_file = p.file_name().is_some_and(|f| !f.to_string_lossy().is_empty());
    let in_video_dir = p.parent().is_some_and(|d| d.file_name().is_some_and(|n| n == "video"));
    let in_cache = p
        .parent()
        .and_then(|d| d.parent())
        .and_then(|d| d.file_name())
        .is_some_and(|n| n == "cache");
    has_file && in_video_dir && in_cache
}

/// Content-Type по расширению (Chromium сниффит контент сам, но честный
/// mime помогает первому зонд-запросу).
pub fn video_mime(path: &str) -> &'static str {
    let ext = std::path::Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "mp4" | "m4v" | "mov" => "video/mp4",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "3gp" => "video/3gpp",
        _ => "application/octet-stream",
    }
}

/// Разбор «Range: bytes=…» (одна область, RFC 7233): «bytes=N-M» —
/// (N, Some(M)), «bytes=N-» — (N, None) — до конца, «bytes=-N» — последние
/// N байт файла. Мульти-области и мусор — None (по RFC Range игнорируется,
/// отдаём файл целиком 200).
pub fn parse_range(header: &str, total: u64) -> Option<(u64, Option<u64>)> {
    let spec = header.trim().strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None; // мульти-область — не запрашивает ни один плеер
    }
    let (a, b) = spec.split_once('-')?;
    if a.is_empty() {
        // суффикс «-N»: последние N байт (0 — весь файл)
        let n: u64 = b.parse().ok()?;
        let take = n.min(total);
        return Some((total - take, None));
    }
    let start: u64 = a.parse().ok()?;
    if b.is_empty() {
        return Some((start, None));
    }
    Some((start, Some(b.parse().ok()?)))
}

/// Итоговый срез [start, end] включительно: конец зажимается по размеру
/// файла и потолку RANGE_CAP. None — start за концом файла (ответ 416).
pub fn resolve_range(start: u64, end: Option<u64>, total: u64) -> Option<(u64, u64)> {
    if total == 0 || start >= total {
        return None;
    }
    let last = end.unwrap_or(total - 1).min(total - 1);
    Some((start, last.min(start + RANGE_CAP - 1)))
}

/// Ответ mobile_video_take: путь к копии в cache и исходное имя файла.
#[derive(Serialize)]
pub struct VideoPending {
    pub path: String,
    pub name: String,
}

/// mobile_video_take: pending-файл из Kotlin-хелпера («path\tимя»), null —
/// файлов нет. Маркеры хелпера («busy» — копирование идёт, duopulse-124;
/// «noperm» — URI без grant, duopulse-141; «error: …») — как у PDF.
#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub fn mobile_video_take() -> Result<Option<VideoPending>, String> {
    jni_impl::take_pending()
}

#[cfg(target_os = "android")]
mod jni_impl {
    use crate::mobile_jni::{app_class, with_jni};

    use super::VideoPending;

    /// pending-строка из MobileVideoHelper.take(): "" — пусто, "busy" —
    /// копирование идёт, "noperm" — URI без grant, "error: …" — прочая
    /// ошибка; иначе «path\tимя».
    pub fn take_pending() -> Result<Option<VideoPending>, String> {
        with_jni(|env, context| {
            let helper = app_class(env, context, "dev.duopulse.mobile.MobileVideoHelper")?;
            let r = env
                .call_static_method(
                    &helper,
                    "take",
                    "()Ljava/lang/String;",
                    &[],
                )
                .map_err(|e| format!("helper: {e}"))?
                .l()
                .map_err(|e| format!("helper: {e}"))?;
            let js = jni::objects::JString::from(r);
            let s = env
                .get_string(&js)
                .map(|s| s.to_string_lossy().into_owned())
                .map_err(|e| format!("helper str: {e}"))?;
            if s.is_empty() {
                return Ok(None);
            }
            if s == "busy" {
                return Err("busy: копирование видео ещё идёт".into());
            }
            if s == "noperm" {
                return Err(
                    "noperm: нет доступа к файлу (проводник не выдал разрешение)".into(),
                );
            }
            if let Some(err) = s.strip_prefix("error:") {
                return Err(format!("копирование видео:{}", err.trim_start()));
            }
            match s.split_once('\t') {
                Some((path, name)) => Ok(Some(VideoPending {
                    path: path.into(),
                    name: name.into(),
                })),
                None => Err(format!("pending без имени: {s}")),
            }
        })
    }
}

/// iOS-таргет: мобильная ветка проекта — Android; сигнатура для симметрии
/// с mobile_pdf (команда регистрируется, всегда пусто).
#[cfg(all(not(target_os = "android"), target_os = "ios"))]
mod jni_impl {
    use super::VideoPending;

    pub fn take_pending() -> Result<Option<VideoPending>, String> {
        Ok(None)
    }
}

// --- протокол mobilevideo (только мобильным таргетам: регистрирует
// mobile_run в lib.rs; на хосте компилируется ради тестов Range-логики) ---

/// URL-префикс, который видит хендлер: wry на Android разворачивает
/// http://mobilevideo.localhost/… обратно в mobilevideo://localhost/…
/// (custom_protocol_workaround::revert_uri_work_around).
#[cfg(any(target_os = "android", target_os = "ios"))]
const URI_PREFIX: &str = "mobilevideo://localhost";

/// Процент-декодирование сегмента пути (фронтенд кодирует encodeURIComponent;
/// зависимость percent-encoding ради одной функции не тащим).
// Потребители — serve мобильных таргетов и тесты; вне их не компилируется
// (иначе либа на хосте ругается мёртвой функцией, duopulse-231).
#[cfg(any(target_os = "android", target_os = "ios", test))]
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = |b: u8| (b as char).to_digit(16);
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Хендлер протокола mobilevideo (регистрируется в mobile_run):
/// mobilevideo://localhost/v/<encodeURIComponent(путь)> → файл из cache/video
/// с поддержкой Range (206/Content-Range) для перемотки <video>. Контекст
/// хендлера не нужен (никакого состояния за протоколом нет).
#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn serve(
    _ctx: tauri::UriSchemeContext<'_, tauri::Wry>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};

    use tauri::http::{header, Response, StatusCode};

    let err = |status: StatusCode, text: &str| {
        Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .body(text.as_bytes().to_vec())
            .unwrap_or_else(|_| Response::new(Vec::new()))
    };

    // путь: /v/<percent-encoded абсолютный путь хелпера>
    let uri = request.uri().to_string();
    let Some(encoded) = uri
        .strip_prefix(URI_PREFIX)
        .and_then(|r| r.strip_prefix("/v/"))
    else {
        return err(StatusCode::NOT_FOUND, "mobilevideo: неизвестный маршрут");
    };
    let path = percent_decode(encoded);
    if !is_video_cache_path(&path) {
        return err(
            StatusCode::FORBIDDEN,
            "mobilevideo: путь вне cache/video",
        );
    }

    let mut file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(_) => return err(StatusCode::NOT_FOUND, "mobilevideo: файл не найден"),
    };
    let total = match file.metadata() {
        Ok(m) => m.len(),
        Err(_) => return err(StatusCode::NOT_FOUND, "mobilevideo: файл не найден"),
    };

    // Range-запрос: разбор + срез. Неразобранный Range игнорируем (RFC 7233,
    // отдаём 200 целиком); start за концом файла — 416 с bytes */total
    enum SlicePlan {
        Full,
        Range((u64, u64)),
        Unsatisfiable,
    }
    let plan = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|h| match parse_range(h, total) {
            None => SlicePlan::Full,
            Some((s, e)) => match resolve_range(s, e, total) {
                Some(se) => SlicePlan::Range(se),
                None => SlicePlan::Unsatisfiable,
            },
        })
        .unwrap_or(SlicePlan::Full); // без Range — файл целиком
    let (start, last, status) = match plan {
        SlicePlan::Range((s, l)) => (s, l, StatusCode::PARTIAL_CONTENT),
        SlicePlan::Full => (0, total.saturating_sub(1), StatusCode::OK),
        SlicePlan::Unsatisfiable => {
            let mut resp = err(StatusCode::RANGE_NOT_SATISFIABLE, "диапазон за концом файла");
            if let Ok(v) = format!("bytes */{total}").parse() {
                resp.headers_mut().insert(header::CONTENT_RANGE, v);
            }
            return resp;
        }
    };
    let len = last - start + 1;
    let mut body = vec![0u8; len as usize];
    if let Err(e) = file
        .seek(SeekFrom::Start(start))
        .and_then(|_| file.read_exact(&mut body))
    {
        return err(StatusCode::INTERNAL_SERVER_ERROR, &format!("читать файл: {e}"));
    }

    let mime = video_mime(&path);
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, len.to_string());
    if status == StatusCode::PARTIAL_CONTENT {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{last}/{total}"),
        );
    }
    eprintln!("mobilevideo: {} {}-{}/{} {mime}", status.as_u16(), start, last, total);
    builder.body(body).unwrap_or_else(|_| Response::new(Vec::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_video_paths_allowed() {
        assert!(is_video_cache_path(
            "/data/user/0/dev.duopulse.mobile/cache/video/1770000000-фильм.МКВ"
        ));
        assert!(is_video_cache_path(
            "/storage/emulated/0/Android/data/dev.duopulse.mobile/cache/video/a b.mp4"
        ));
    }

    #[test]
    fn foreign_paths_rejected() {
        assert!(!is_video_cache_path("/data/user/0/dev.duopulse.mobile/cache/doc.mp4"));
        assert!(!is_video_cache_path("/sdcard/Download/secret.mp4"));
        assert!(!is_video_cache_path("cache/video/rel.mp4"));
        assert!(!is_video_cache_path(
            "/data/user/0/dev.duopulse.mobile/cache/video/../secret.mp4"
        ));
        assert!(!is_video_cache_path(""));
    }

    #[test]
    fn range_parsing() {
        assert_eq!(parse_range("bytes=0-", 1000), Some((0, None)));
        assert_eq!(parse_range("bytes=100-199", 1000), Some((100, Some(199))));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, None)));
        assert_eq!(parse_range("bytes=0-0", 1000), Some((0, Some(0))));
        // мульти-область и мусор — None (кормим 200 целиком)
        assert_eq!(parse_range("bytes=0-99,200-", 1000), None);
        assert_eq!(parse_range("chars=1-2", 1000), None);
        assert_eq!(parse_range("bytes=a-b", 1000), None);
    }

    #[test]
    fn range_resolved_capped() {
        let total = 100 * 1024 * 1024;
        // открытый Range режется по потолку
        let (s, e) = resolve_range(0, None, total).unwrap();
        assert_eq!((s, e), (0, RANGE_CAP - 1));
        // конец зажимается по файлу
        let (s, e) = resolve_range(995, None, 1000).unwrap();
        assert_eq!((s, e), (995, 999));
        // явный конец за файлом — по последнему байту
        let (s, e) = resolve_range(500, Some(5000), 1000).unwrap();
        assert_eq!((s, e), (500, 999));
        // начало за концом — None (416)
        assert_eq!(resolve_range(1000, None, 1000), None);
        assert_eq!(resolve_range(5, None, 0), None);
    }

    #[test]
    fn mime_by_extension() {
        assert_eq!(video_mime("/a/b/x.mp4"), "video/mp4");
        assert_eq!(video_mime("/a/b/X.M4V"), "video/mp4");
        assert_eq!(video_mime("/a/b/x.mkv"), "video/x-matroska");
        assert_eq!(video_mime("/a/b/x.webm"), "video/webm");
        assert_eq!(video_mime("/a/b/x.bin"), "application/octet-stream");
    }

    #[test]
    fn decode_percent_segments() {
        assert_eq!(percent_decode("a%20b"), "a b");
        assert_eq!(
            percent_decode("%2Fdata%2Fuser%2F0%2Fx%2Fcache%2Fvideo%2F1-f.mp4"),
            "/data/user/0/x/cache/video/1-f.mp4"
        );
        // кириллица UTF-8 побайтно
        assert_eq!(percent_decode("%D1%84"), "ф");
        // битные последовательности проходят как есть
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }
}
