//! Файловые загрузки страниц (карточка duopulse-158): клик по ссылке на файл
//! (музыка, архив, документ) WebView2 раньше качал молча в системный Downloads
//! — файл рос в каталоге, но браузер не показывал ничего. Теперь каждая
//! контентная вкладка вешает on_download (build_tab_webview): старт загрузки
//! переносится в настроенный каталог «Загрузки» (тот же resolve_dir, что у
//! медиа-панели), регистрируется в FileDownloadService и эмитит filedl:started;
//! поток-поллинг меряет размер файла на диске (WebView2 пишет в целевой файл,
//! Chromium-вариант — рядом «.crdownload») и шлёт filedl:progress с байтами и
//! скоростью; итог — filedl:finished. UI зажигает индикатор загрузок в навбаре
//! и секцию «Файлы» панели «Скачать».
//!
//! Отмена файловой загрузки API wry не даёт (Requested умеет только запретить
//! старт) — кнопки отмены у файлов нет; итог прерывания приходит Finished
//! success=false («загрузка прервана»).
//!
//! Медиа-загрузки панели (yt-dlp) живут отдельно в DownloadService (модуль
//! выше) — у них свои события download:progress/finished.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::Manager;

use crate::bridge::{self, BridgeEvent};

// --- типы контракта -----------------------------------------------------------

/// Одна файловая загрузка в filedl.status.
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileDlInfo {
    pub id: u64,
    /// Адрес, с которого качаем.
    pub url: String,
    /// Имя файла.
    pub file_name: String,
    /// Полный целевой путь.
    pub path: String,
    /// active | done | error.
    pub state: String,
    /// Принято байт (по факту на диске).
    pub received: u64,
    /// Скорость, байт/с (последний замер; 0 — не известно).
    pub speed: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileDlStatusResult {
    /// Живые и последние файловые загрузки (свежие первыми).
    pub files: Vec<FileDlInfo>,
}

/// filedl:started — загрузка файла началась.
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileDlStarted {
    pub id: u64,
    pub url: String,
    pub file_name: String,
    pub path: String,
}

pub struct FileDlStartedEvent;

impl BridgeEvent for FileDlStartedEvent {
    const NAME: &'static str = "filedl:started";
    type Payload = FileDlStarted;
}

/// filedl:progress — живой прогресс (байты на диске и скорость).
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileDlProgress {
    pub id: u64,
    pub received: u64,
    pub speed: u64,
}

pub struct FileDlProgressEvent;

impl BridgeEvent for FileDlProgressEvent {
    const NAME: &'static str = "filedl:progress";
    type Payload = FileDlProgress;
}

/// filedl:finished — файловая загрузка завершилась (успех/прерывание).
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileDlFinished {
    pub id: u64,
    pub ok: bool,
    pub file_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

pub struct FileDlFinishedEvent;

impl BridgeEvent for FileDlFinishedEvent {
    const NAME: &'static str = "filedl:finished";
    type Payload = FileDlFinished;
}

// --- сервис ---------------------------------------------------------------------

/// Реестр файловых загрузок: живые и последние 12 (как задания DownloadService).
#[derive(Default)]
pub struct FileDownloadService {
    files: Mutex<HashMap<u64, FileDlInfo>>,
    next_id: AtomicU64,
}

impl FileDownloadService {
    /// Зарегистрировать загрузку; возвращает снапшот и держит реестр ≤12.
    fn begin(&self, url: &str, path: &std::path::Path) -> FileDlInfo {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let info = FileDlInfo {
            id,
            url: url.to_string(),
            file_name: path
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default(),
            path: path.display().to_string(),
            state: "active".into(),
            received: 0,
            speed: 0,
            error: None,
        };
        let mut files = self.files.lock().expect("filedl: лок не отравлен");
        files.insert(id, info.clone());
        trim(&mut files);
        info
    }

    /// Применить патч; снапшот None — задания нет (вытеснено тримом).
    fn update(&self, id: u64, patch: impl FnOnce(&mut FileDlInfo)) -> Option<FileDlInfo> {
        let mut files = self.files.lock().expect("filedl: лок не отравлен");
        files.get_mut(&id).map(|f| {
            patch(f);
            f.clone()
        })
    }

    /// Загрузка ещё жива?
    fn is_active(&self, id: u64) -> bool {
        self.files
            .lock()
            .expect("filedl: лок не отравлен")
            .get(&id)
            .map(|f| f.state == "active")
            .unwrap_or(false)
    }

    /// Итог по URL (wry отдаёт url, не id): первая активная с тем же адресом.
    fn finish(&self, url: &str, path: Option<&std::path::Path>, ok: bool) -> Option<FileDlInfo> {
        let mut files = self.files.lock().expect("filedl: лок не отравлен");
        let id = files
            .values()
            .find(|f| f.state == "active" && f.url == url)
            .map(|f| f.id)?;
        let f = files.get_mut(&id)?;
        f.state = if ok { "done".into() } else { "error".into() };
        f.speed = 0;
        if !ok {
            f.error = Some("загрузка прервана".into());
        }
        if let Some(p) = path {
            f.path = p.display().to_string();
            f.file_name = p
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| f.file_name.clone());
        }
        f.received = received_bytes(std::path::Path::new(&f.path)).max(f.received);
        Some(f.clone())
    }

    fn snapshot(&self) -> Vec<FileDlInfo> {
        let mut list: Vec<FileDlInfo> = self
            .files
            .lock()
            .expect("filedl: лок не отравлен")
            .values()
            .cloned()
            .collect();
        list.sort_by(|a, b| b.id.cmp(&a.id));
        list
    }

    fn path_of(&self, id: u64) -> Option<String> {
        self.files
            .lock()
            .expect("filedl: лок не отравлен")
            .get(&id)
            .map(|f| f.path.clone())
    }
}

/// Реестр держит последние 12 загрузок (панель показывает свежие).
fn trim(files: &mut HashMap<u64, FileDlInfo>) {
    if files.len() > 12 {
        let mut ids: Vec<u64> = files.keys().copied().collect();
        ids.sort_unstable();
        for id in ids.iter().take(files.len() - 12) {
            files.remove(id);
        }
    }
}

// --- hook вкладок ---------------------------------------------------------------

/// Обработчик on_download контентных вкладок (build_tab_webview): старт —
/// перенос в каталог «Загрузки» + регистрация + события; итог — снятие.
/// Всегда true (разрешить) — запрет файловых загрузок не предусмотрен.
pub fn handle(
    app: &tauri::AppHandle,
    event: tauri::webview::DownloadEvent<'_>,
) -> bool {
    let service = app.state::<FileDownloadService>();
    match event {
        tauri::webview::DownloadEvent::Requested { url, destination } => {
            // каталог назначения — как у медиа-загрузок (настройка → Downloads);
            // не разрешился — качаем по умолчанию WebView2, но с индикатором
            let dir = crate::download::resolve_dir(None);
            let target = match &dir {
                Ok(dir) => {
                    let proposed = destination
                        .file_name()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    let name = file_name_of(&proposed);
                    unique_path(dir, &name)
                }
                Err(e) => {
                    eprintln!("[filedl] каталог загрузок не открыт ({e}) — путь WebView2");
                    destination.clone()
                }
            };
            *destination = target.clone();
            let info = service.begin(url.as_str(), &target);
            let _ = bridge::emit::<FileDlStartedEvent>(
                app,
                &FileDlStarted {
                    id: info.id,
                    url: info.url.clone(),
                    file_name: info.file_name.clone(),
                    path: info.path.clone(),
                },
            );
            spawn_poller(app.clone(), info.id, target);
            true
        }
        tauri::webview::DownloadEvent::Finished { url, path, success } => {
            if let Some(info) = service.finish(url.as_str(), path.as_deref(), success) {
                let _ = bridge::emit::<FileDlFinishedEvent>(
                    app,
                    &FileDlFinished {
                        id: info.id,
                        ok: success,
                        file_name: info.file_name.clone(),
                        path: Some(info.path.clone()),
                    },
                );
            }
            true
        }
        _ => true,
    }
}

/// Поток-поллинг растущего файла: каждые 500 мс — размер на диске (целевой
/// файл либо «.crdownload»-сосед, максимум) и скорость по дельте; событие —
/// только при изменении размера. Выходит, когда загрузка перестала быть active.
fn spawn_poller(app: tauri::AppHandle, id: u64, path: std::path::PathBuf) {
    std::thread::spawn(move || {
        let service = app.state::<FileDownloadService>();
        let mut last_len = received_bytes(&path);
        let mut last_t = std::time::Instant::now();
        service.update(id, |f| f.received = last_len);
        loop {
            std::thread::sleep(std::time::Duration::from_millis(500));
            if !service.is_active(id) {
                return;
            }
            let len = received_bytes(&path);
            if len != last_len {
                let dt = last_t.elapsed().as_secs_f64();
                let speed = if dt > 0.05 {
                    ((len.saturating_sub(last_len)) as f64 / dt) as u64
                } else {
                    0
                };
                last_len = len;
                last_t = std::time::Instant::now();
                service.update(id, |f| {
                    f.received = len;
                    f.speed = speed;
                });
                let _ = bridge::emit::<FileDlProgressEvent>(
                    &app,
                    &FileDlProgress { id, received: len, speed },
                );
            }
        }
    });
}

/// Сколько байт уже на диске: WebView2 пишет в целевой файл; вариант
/// Chromium — рядом лежащий «<имя>.crdownload». Берём максимум по кандидатам.
fn received_bytes(path: &std::path::Path) -> u64 {
    let mut crdownload = path.as_os_str().to_os_string();
    crdownload.push(".crdownload");
    [path, std::path::Path::new(&crdownload)]
        .iter()
        .filter_map(|p| std::fs::metadata(p).ok())
        .map(|m| m.len())
        .max()
        .unwrap_or(0)
}

/// Имя файла для сохранения: чистое по правилам Windows; пустое/из точек —
/// «файл» (дефолт sanitize_filename «субтитры» тут не по смыслу).
fn file_name_of(proposed: &str) -> String {
    let clean = crate::download::sanitize_filename(proposed);
    let meaningful = !proposed.trim().trim_end_matches('.').is_empty();
    if meaningful {
        clean
    } else {
        "файл".into()
    }
}

/// Свободное имя: «база.расширение» занята → «база (2).расширение»…
fn unique_path(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let stem = std::path::Path::new(name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.to_string());
    let ext = std::path::Path::new(name)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for n in 2..1000 {
        let p = dir.join(format!("{stem} ({n}){ext}"));
        if !p.exists() {
            return p;
        }
    }
    first
}

// --- команды -------------------------------------------------------------------

/// filedl.status: живые и последние файловые загрузки (панель при открытии).
#[tauri::command]
pub fn filedl_status(app: tauri::AppHandle) -> FileDlStatusResult {
    FileDlStatusResult {
        files: app.state::<FileDownloadService>().snapshot(),
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileDlRevealParams {
    pub id: u64,
}

/// filedl.reveal: показать файл в Проводнике (/select).
#[tauri::command]
pub fn filedl_reveal(app: tauri::AppHandle, params: FileDlRevealParams) -> Result<(), String> {
    let path = app
        .state::<FileDownloadService>()
        .path_of(params.id)
        .ok_or("загрузка не найдена")?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&path)
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .spawn()
            .map_err(|e| format!("проводник: {e}"))?;
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        return Err("показ в проводнике — только Windows".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(id: u64, url: &str, state: &str) -> FileDlInfo {
        FileDlInfo {
            id,
            url: url.into(),
            file_name: format!("f{id}.bin"),
            path: format!("D:\\dl\\f{id}.bin"),
            state: state.into(),
            received: 0,
            speed: 0,
            error: None,
        }
    }

    #[test]
    fn file_name_of_sanitizes_and_defaults() {
        assert_eq!(file_name_of("трек: лучший?"), "трек_ лучший_");
        assert_eq!(file_name_of("  ...  "), "файл");
        assert_eq!(file_name_of(""), "файл");
    }

    #[test]
    fn unique_path_avoids_collision_with_extension() {
        let dir = std::env::temp_dir().join(format!("duopulse-fdl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p1 = unique_path(&dir, "song.mp3");
        assert_eq!(p1, dir.join("song.mp3"));
        std::fs::write(&p1, "x").unwrap();
        let p2 = unique_path(&dir, "song.mp3");
        assert_eq!(p2, dir.join("song (2).mp3"));
        // без расширения — тоже работает
        std::fs::write(dir.join("README"), "x").unwrap();
        assert_eq!(unique_path(&dir, "README"), dir.join("README (2)"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn received_bytes_takes_max_of_candidates() {
        let dir = std::env::temp_dir();
        let base = dir.join(format!("duopulse-fdl-len-{}.bin", std::process::id()));
        let cr = dir.join(format!("duopulse-fdl-len-{}.bin.crdownload", std::process::id()));
        std::fs::write(&base, "12345").unwrap();
        std::fs::write(&cr, "1234567890").unwrap();
        assert_eq!(received_bytes(&base), 10);
        let _ = std::fs::remove_file(&base);
        let _ = std::fs::remove_file(&cr);
        assert_eq!(received_bytes(&base), 0);
    }

    #[test]
    fn service_lifecycle_and_trim() {
        let svc = FileDownloadService::default();
        let dir = std::path::Path::new("D:\\dl");
        let a = svc.begin("https://a.example/x.mp3", &dir.join("x.mp3"));
        assert_eq!(a.state, "active");
        svc.update(a.id, |f| {
            f.received = 100;
            f.speed = 50;
        });
        let done = svc.finish("https://a.example/x.mp3", None, true).expect("найдена");
        assert_eq!(done.state, "done");
        assert_eq!(done.received, 100);
        // повторный finish того же URL — уже не активен, None
        assert!(svc.finish("https://a.example/x.mp3", None, true).is_none());
        // прерывание: state=error с причиной
        let b = svc.begin("https://b.example/y.zip", &dir.join("y.zip"));
        let failed = svc.finish("https://b.example/y.zip", None, false).expect("найдена");
        assert_eq!(failed.state, "error");
        assert_eq!(failed.error.as_deref(), Some("загрузка прервана"));
        // трим до 12: 13-я загрузка вытесняет первую
        for i in 0..13 {
            svc.begin(&format!("https://c.example/{i}"), &dir.join(format!("c{i}")));
        }
        assert_eq!(svc.snapshot().len(), 12);
        assert!(svc.path_of(a.id).is_none());
        assert_eq!(svc.snapshot()[0].id, b.id + 13);
    }
}
