//! Приём PDF из системы (карточка duopulse-119, мобильная ветка):
//! intent-filter ACTION_VIEW application/pdf (AndroidManifest) — DuoPulse
//! появляется в «Открыть с помощью»; Kotlin-хелпер gen/android
//! (MobilePdfHelper) копирует контентный URI в cache/pdf/<ts>-<имя>.pdf и
//! держит pending-строку. Команды:
//!   mobile_pdf_take  — забрать pending ({path, name} | null), однократно;
//!   mobile_pdf_chunk — кусок файла base64 (фронтенд собирает байты для
//!     pdf.js: WebView Android PDF не рендерит, просмотрщик свой).
//! Путь для chunk валидируется (is_pdf_cache_path) — команда читает только
//! файлы, положенные хелпером, а не произвольные пути системы. Валидатор —
//! чистая функция, компилируется и тестируется на хосте (как allowlist в
//! duo_mobile); JNI — только Android (паттерн mobile_open).

use serde::Serialize;

/// Размер куска mobile_pdf_chunk: 512 КБ → ~700 КБ base64 на вызов IPC —
/// десятки вызовов на документ без пиков памяти JNI.
pub const CHUNK_LEN: u64 = 512 * 1024;

/// Разрешённый путь mobile_pdf_chunk: файл *.pdf непосредственно в папке
/// «pdf» внутри «cache» (внутренний /data/user/0/<pkg>/cache/pdf или
/// внешний /storage/…/Android/data/<pkg>/cache/pdf — кладёт туда
/// MobilePdfHelper). Отсекает произвольное чтение файлов системы.
pub fn is_pdf_cache_path(path: &str) -> bool {
    // Путь только с ведущим «/» (абсолютный на Android): Path::is_absolute
    // на Windows-хосте (тесты) для «/data/…» ложно — нет буквы диска.
    if !path.starts_with('/') {
        return false;
    }
    let p = std::path::Path::new(path);
    let file_pdf = p
        .file_name()
        .is_some_and(|f| f.to_string_lossy().to_lowercase().ends_with(".pdf"));
    let in_pdf_dir = p.parent().is_some_and(|d| d.file_name().is_some_and(|n| n == "pdf"));
    let in_cache = p
        .parent()
        .and_then(|d| d.parent())
        .and_then(|d| d.file_name())
        .is_some_and(|n| n == "cache");
    file_pdf && in_pdf_dir && in_cache
}

/// Ответ mobile_pdf_take: путь к копии в cache и исходное имя файла.
#[derive(Serialize)]
pub struct PdfPending {
    pub path: String,
    pub name: String,
}

/// Ответ mobile_pdf_chunk: base64-кусок, следующий offset и полный размер.
#[derive(Serialize)]
pub struct PdfChunk {
    pub data: String,
    pub next: u64,
    pub total: u64,
}

/// mobile_pdf_take: pending-файл из Kotlin-хелпера («path\tимя»), null —
/// файлов нет. Ошибки копирования хелпер возвращает строкой «error: …» —
/// прокидываются как Err (UI показывает в строке статуса).
#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub fn mobile_pdf_take() -> Result<Option<PdfPending>, String> {
    jni_impl::take_pending()
}

/// mobile_pdf_chunk (path, offset): кусок файла из cache/pdf (см.
/// is_pdf_cache_path), base64-строкой — фронтенд собирает документ для
/// pdf.js последовательными вызовами до next == total.
#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub fn mobile_pdf_chunk(path: String, offset: u64) -> Result<PdfChunk, String> {
    if !is_pdf_cache_path(&path) {
        return Err(format!("путь вне cache/pdf: {path}"));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("прочитать {path}: {e}"))?;
    let total = bytes.len() as u64;
    if offset >= total {
        return Err(format!("offset {offset} за концом файла ({total})"));
    }
    let start = offset as usize;
    let end = (start + CHUNK_LEN as usize).min(bytes.len());
    let data = crate::subtitles::fonts::base64(&bytes[start..end]);
    Ok(PdfChunk {
        data,
        next: end as u64,
        total,
    })
}

#[cfg(target_os = "android")]
mod jni_impl {
    use crate::mobile_jni::{app_class, with_jni};

    use super::PdfPending;

    /// pending-строка из MobilePdfHelper.take(): "" — пусто, "error: …" —
    /// прокина как Err, иначе «path\tимя».
    pub fn take_pending() -> Result<Option<PdfPending>, String> {
        with_jni(|env, context| {
            let helper = app_class(env, context, "dev.duopulse.mobile.MobilePdfHelper")?;
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
                // duopulse-124: копирование ещё идёт (фоновый поток хелпера) —
                // фронтенд повторит take по этому маркеру, файл не теряется
                return Err("busy: копирование PDF ещё идёт".into());
            }
            if let Some(err) = s.strip_prefix("error:") {
                return Err(format!("копирование PDF:{}", err.trim_start()));
            }
            match s.split_once('\t') {
                Some((path, name)) => Ok(Some(PdfPending {
                    path: path.into(),
                    name: name.into(),
                })),
                None => Err(format!("pending без имени: {s}")),
            }
        })
    }
}

/// iOS-таргет: мобильная ветка проекта — Android; сигнатура для симметрии
/// с mobile_open (команда регистрируется, всегда пусто).
#[cfg(all(not(target_os = "android"), target_os = "ios"))]
mod jni_impl {
    use super::PdfPending;

    pub fn take_pending() -> Result<Option<PdfPending>, String> {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_pdf_paths_allowed() {
        assert!(is_pdf_cache_path(
            "/data/user/0/dev.duopulse.spike/cache/pdf/1770000000-doc.PDF"
        ));
        assert!(is_pdf_cache_path(
            "/storage/emulated/0/Android/data/dev.duopulse.spike/cache/pdf/a b.pdf"
        ));
    }

    #[test]
    fn foreign_paths_rejected() {
        // произвольные файлы, чужие каталоги, относительные пути
        assert!(!is_pdf_cache_path("/data/user/0/dev.duopulse.spike/cache/doc.pdf"));
        assert!(!is_pdf_cache_path("/sdcard/Download/secret.pdf"));
        assert!(!is_pdf_cache_path("cache/pdf/rel.pdf"));
        assert!(!is_pdf_cache_path(
            "/data/user/0/dev.duopulse.spike/cache/pdf/../secret.pdf"
        ));
        // traversal нормализуется компонентами: ParentDir — не имя файла
        assert!(!is_pdf_cache_path(""));
    }
}
