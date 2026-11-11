//! Загрузка видео/аудио/субтитров (карточка duopulse-118): кнопка «⬇» в хроме
//! открывает панель — что скачать с текущей страницы: видео (качество), только
//! музыку (m4a/mp3), субтитры выбранным языком; видео/музыку можно кусками —
//! диапазон «с … по …» (--download-sections yt-dlp).
//!
//! Движок — yt-dlp (+ffmpeg), докачивается по требованию в profile/dl/bin
//! (tools.rs, паттерн движка ASR). Субтитры идут БЕЗ yt-dlp: проверенным путём
//! контент-адаптера YouTube (PO-токен плеера, тот же, что у показа плашки) —
//! Core эвалит в активную вкладку duopulse-download-subs, content загружает
//! дорожку (loadTracks, набор показа не трогается) и отвечает WebMessage'ом
//! «download-subs»; Core собирает .srt (subtitles::srt::write_srt) в каталог
//! загрузок.
//!
//! Задания живут в DownloadService (manage в main.rs): поток задания читает
//! stdout yt-dlp (прогресс — шаблоном dl:@…@…@…), события download:progress /
//! download:finished идут в UI контрактом; отмена убивает процесс.

pub mod cookies;
pub mod runner;
pub mod tools;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use tauri::Manager;

use crate::bridge::{self, BridgeEvent};
use runner::{MediaMode, RunSpec};

// --- типы контракта -----------------------------------------------------------

/// download.begin: что и как скачать с активной/указанной страницы.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DownloadBeginParams {
    /// video | audio | subs.
    pub mode: String,
    /// URL страницы/видео (для video/audio; субтитры берутся активной вкладки).
    #[serde(default)]
    pub url: String,
    /// id дорожки из списка адаптера (subs): «yt:en», «yt:en+ru», «ru».
    #[serde(default)]
    pub track_id: String,
    /// best | 1080 | 720 | 480 | 360 (video).
    #[serde(default)]
    pub quality: String,
    /// Формат аудио: mp3 (конвертация, нужен ffmpeg) либо m4a без перекодировки.
    #[serde(default)]
    pub audio_mp3: bool,
    /// Диапазон куска, сек (video/audio): начало.
    pub range_start_sec: Option<f64>,
    /// Конец диапазона (None до конца видео).
    pub range_end_sec: Option<f64>,
    /// Каталог назначения (None — настройка «Загрузки», иначе системный Downloads).
    pub dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DownloadBeginResult {
    pub job_id: u64,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DownloadCancelParams {
    pub job_id: u64,
}

/// Одно задание в download.status (панель показывает живые и последние).
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DownloadJobInfo {
    pub job_id: u64,
    /// video | audio | subs.
    pub mode: String,
    /// prepare | tools | download | convert | subs | done | error | canceled.
    pub phase: String,
    /// 0–100 (фазы без процентов — 0).
    pub percent: f64,
    pub speed: String,
    pub eta: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub out_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DownloadStatusResult {
    /// yt-dlp.exe на месте (иначе докачается при первом video/audio).
    pub ytdlp_ready: bool,
    /// deno.exe на месте (JS-runtime экстрактора YouTube).
    pub deno_ready: bool,
    /// ffmpeg.exe на месте (нужен качеству >360p, mp3, диапазонам).
    pub ffmpeg_ready: bool,
    /// Эффективный каталог загрузок (настройка либо системный Downloads).
    pub default_dir: String,
    /// Живые и последние задания (свежие первыми).
    pub jobs: Vec<DownloadJobInfo>,
}

/// download:progress — живой прогресс задания.
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub job_id: u64,
    /// tools | download | convert | subs.
    pub phase: String,
    pub percent: f64,
    pub speed: String,
    pub eta: String,
}

pub struct DownloadProgressEvent;

impl BridgeEvent for DownloadProgressEvent {
    const NAME: &'static str = "download:progress";
    type Payload = DownloadProgress;
}

/// download:finished — задание завершилось (успех/отмена/ошибка).
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DownloadFinished {
    pub job_id: u64,
    /// video | audio | subs.
    pub mode: String,
    pub ok: bool,
    pub canceled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub struct DownloadFinishedEvent;

impl BridgeEvent for DownloadFinishedEvent {
    const NAME: &'static str = "download:finished";
    type Payload = DownloadFinished;
}

// --- сервис заданий -----------------------------------------------------------

/// Живое задание: состояние для status + управление (убить процесс / доставить
/// ответ субтитров).
struct JobState {
    info: DownloadJobInfo,
    /// Процесс yt-dlp (reader-поток дочитывает до EOF и wait'ит; отмена убивает).
    child: Option<Arc<Mutex<Option<std::process::Child>>>>,
    /// Канал ответа content-слоя (subs).
    subs_tx: Option<mpsc::Sender<serde_json::Value>>,
}

#[derive(Default)]
pub struct DownloadService {
    jobs: Mutex<HashMap<u64, JobState>>,
    next_id: AtomicU64,
}

impl DownloadService {
    fn insert(&self, id: u64, mode: &str) -> DownloadJobInfo {
        let info = DownloadJobInfo {
            job_id: id,
            mode: mode.to_string(),
            phase: "prepare".into(),
            percent: 0.0,
            speed: String::new(),
            eta: String::new(),
            out_path: None,
            error: None,
        };
        let mut jobs = self.jobs.lock().expect("download: лок не отравлен");
        jobs.insert(id, JobState { info: info.clone(), child: None, subs_tx: None });
        // статус держит последние 12 заданий — панель показывает свежие
        if jobs.len() > 12 {
            let mut ids: Vec<u64> = jobs.keys().copied().collect();
            ids.sort_unstable();
            for id in ids.iter().take(jobs.len() - 12) {
                jobs.remove(id);
            }
        }
        info
    }

    /// Применить патч и вернуть свежий снапшот задания.
    fn update(&self, id: u64, patch: impl FnOnce(&mut DownloadJobInfo)) -> Option<DownloadJobInfo> {
        let mut jobs = self.jobs.lock().expect("download: лок не отравлен");
        jobs.get_mut(&id).map(|j| {
            patch(&mut j.info);
            j.info.clone()
        })
    }

    fn take_child_handle(&self, id: u64) -> Option<Arc<Mutex<Option<std::process::Child>>>> {
        self.jobs
            .lock()
            .expect("download: лок не отравлен")
            .get_mut(&id)
            .and_then(|j| j.child.clone())
    }

    fn set_child_handle(&self, id: u64, child: Arc<Mutex<Option<std::process::Child>>>) {
        if let Some(j) = self.jobs.lock().expect("download: лок не отравлен").get_mut(&id) {
            j.child = Some(child);
        }
    }

    fn set_subs_sender(&self, id: u64, tx: mpsc::Sender<serde_json::Value>) {
        if let Some(j) = self.jobs.lock().expect("download: лок не отравлен").get_mut(&id) {
            j.subs_tx = Some(tx);
        }
    }

    /// Ответ content-слоя на duopulse-download-subs (main.rs): заданию в канал.
    pub fn deliver_subs_reply(&self, req_id: u64, value: serde_json::Value) -> bool {
        let tx = self
            .jobs
            .lock()
            .expect("download: лок не отравлен")
            .get(&req_id)
            .and_then(|j| j.subs_tx.clone());
        match tx {
            Some(tx) => tx.send(value).is_ok(),
            None => false,
        }
    }

    fn is_canceled(&self, id: u64) -> bool {
        self.jobs
            .lock()
            .expect("download: лок не отравлен")
            .get(&id)
            .map(|j| j.info.phase == "canceled")
            .unwrap_or(false)
    }

    fn snapshot(&self) -> Vec<DownloadJobInfo> {
        let jobs = self.jobs.lock().expect("download: лок не отравлен");
        let mut list: Vec<DownloadJobInfo> = jobs.values().map(|j| j.info.clone()).collect();
        list.sort_by(|a, b| b.job_id.cmp(&a.job_id));
        list
    }
}

fn emit_progress(app: &tauri::AppHandle, p: DownloadProgress) {
    let _ = bridge::emit::<DownloadProgressEvent>(app, &p);
}

fn emit_finished(app: &tauri::AppHandle, f: DownloadFinished) {
    let _ = bridge::emit::<DownloadFinishedEvent>(app, &f);
}

/// Прокси для yt-dlp: сознательно БЕЗ локального SOCKS5-роутера приложения
/// (замер карточки duopulse-118: анонимный yt-dlp через роутер — в любом его
/// режиме — стабильно ловит «Sign in to confirm you're not a bot»/403, напрямую
/// тот же URL качается; urllib-SOCKS-клиент yt-dlp для YouTube заметно «ботнее»
/// браузерного). Сайтам, доступным только через прокси/VPN, — отдельная карточка.
fn router_port(_app: &tauri::AppHandle) -> Option<u16> {
    None
}

/// Эффективный каталог загрузок: параметр → настройка → системный Downloads →
/// профиль (создаётся при необходимости).
pub fn resolve_dir(param: Option<&str>) -> Result<std::path::PathBuf, String> {
    let profile = crate::proxy::profile_dir();
    let configured = crate::settings::load_downloads(&profile).dir;
    let dir = match param.filter(|s| !s.trim().is_empty()) {
        Some(p) => std::path::PathBuf::from(p),
        None => match configured.filter(|s| !s.trim().is_empty()) {
            Some(p) => std::path::PathBuf::from(p),
            None => std::env::var_os("USERPROFILE")
                .map(|p| std::path::PathBuf::from(p).join("Downloads"))
                .filter(|p| p.is_dir())
                .unwrap_or_else(|| profile.join("downloads")),
        },
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("каталог загрузок {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Имя файла без запрещённых Windows символов, ≤120 символов, без точек в хвосте.
pub fn sanitize_filename(name: &str) -> String {
    let mapped: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .take(120)
        .collect();
    let trimmed = mapped.trim().trim_end_matches('.');
    if trimmed.is_empty() {
        "субтитры".into()
    } else {
        trimmed.to_string()
    }
}

/// Свободное имя файла: «база» занята — «база (2)», «база (3)»…
fn free_path(dir: &std::path::Path, stem: &str, ext: &str) -> std::path::PathBuf {
    let first = dir.join(format!("{stem}.{ext}"));
    if !first.exists() {
        return first;
    }
    for n in 2..1000 {
        let p = dir.join(format!("{stem} ({n}).{ext}"));
        if !p.exists() {
            return p;
        }
    }
    first
}

// --- команды -------------------------------------------------------------------

/// download.begin: запустить задание (video/audio — yt-dlp, subs — контент-адаптер
/// активной вкладки). Синхронно регистрирует задание и диспатчит запрос
/// субтитров (eval — строго главный поток, паттерн subtitles.load_file);
/// работу делает поток задания, прогресс — событиями download:*.
#[tauri::command]
pub async fn download_begin(
    app: tauri::AppHandle,
    manager: tauri::State<'_, crate::tabs::TabManager>,
    params: DownloadBeginParams,
) -> Result<DownloadBeginResult, String> {
    let service = app.state::<DownloadService>();
    let mode = params.mode.clone();
    if !matches!(mode.as_str(), "video" | "audio" | "subs") {
        return Err(format!("неизвестный режим: {mode}"));
    }
    let id = service.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    service.insert(id, &mode);

    let dir = resolve_dir(params.dir.as_deref())?;

    match mode.as_str() {
        "subs" => {
            if params.track_id.trim().is_empty() {
                return Err("не выбран язык субтитров".into());
            }
            // Запрос в активную вкладку — на главном потоке (eval из async-пула
            // тихо не исполняется, e2e 3.6); ответ придёт WebMessage'ом
            // «download-subs» (main.rs → deliver_subs_reply).
            let detail = serde_json::json!({"reqId": id, "trackId": params.track_id});
            let detail_json =
                serde_json::to_string(&detail).map_err(|e| format!("сериализация detail: {e}"))?;
            let mut js = String::from(
                "document.dispatchEvent(new CustomEvent('duopulse-download-subs',{detail:",
            );
            js.push_str(&detail_json);
            js.push_str("}))");
            let (tx, rx) = mpsc::channel::<serde_json::Value>();
            service.set_subs_sender(id, tx);
            match manager.active_webview(&app) {
                None if manager.active_is_lazy() => {
                    return Err("вкладка спит — разбудите её и повторите".into());
                }
                None => return Err("активной вкладки нет".into()),
                Some(wv) => {
                    let (ok_tx, ok_rx) = mpsc::channel::<Result<(), String>>();
                    app.run_on_main_thread(move || {
                        let _ = ok_tx.send(wv.eval(&js).map_err(|e| format!("eval: {e}")));
                    })
                    .map_err(|e| format!("планирование на главном потоке: {e}"))?;
                    ok_rx.recv().map_err(|e| format!("eval-канал: {e}"))??;
                }
            }
            service.update(id, |i| i.phase = "subs".into());
            // Фолбэк (карточка duopulse-118): браузерная сессия YouTube может
            // быть помечена (плеер «видео недоступно», PO-токена нет) — тогда
            // субтитры того же языка докачает yt-dlp (--write-subs), чей
            // extraction работает с того же IP. Адрес — активная вкладка.
            let tab_url = manager
                .snapshot()
                .tabs
                .into_iter()
                .find(|t| t.active)
                .map(|t| t.url)
                .unwrap_or_default();
            let app2 = app.clone();
            std::thread::spawn(move || run_subs_job(app2, id, rx, dir, tab_url, params.track_id));
        }
        _ => {
            let url = params.url.trim().to_string();
            if !url.starts_with("http://") && !url.starts_with("https://") {
                return Err("адрес страницы не указан".into());
            }
            let range = match (params.range_start_sec, params.range_end_sec) {
                (Some(s), e) if s >= 0.0 => Some((s, e.unwrap_or(f64::MAX))),
                _ => None,
            };
            let quality = if params.quality.is_empty() { "best".into() } else { params.quality };
            let spec = RunSpec {
                url,
                mode: if mode == "audio" { MediaMode::Audio } else { MediaMode::Video },
                quality,
                audio_mp3: params.audio_mp3,
                range,
                out_dir: dir.display().to_string(),
                ffmpeg_dir: None, // поток задания решит по факту докачки
                proxy: router_port(&app).map(|p| format!("socks5://127.0.0.1:{p}")),
                cookies: None, // поток задания обновит экспортом профиля
                name_suffix: range.map(|(s, e)| format!("({})", runner::range_suffix(s, e))),
            };
            let app2 = app.clone();
            // инструменты — в профиль (profile/dl/bin), не в каталог загрузок
            let profile = crate::proxy::profile_dir();
            std::thread::spawn(move || run_media_job(app2, id, mode == "audio", spec, profile));
        }
    }
    Ok(DownloadBeginResult { job_id: id })
}

/// download.cancel: отменить задание — пометить и убить yt-dlp; ждущему субтитры
/// потоку доставляется пустой ответ (канал одноразовый), финальный download:
/// finished эмитит сам поток задания.
#[tauri::command]
pub fn download_cancel(
    service: tauri::State<'_, DownloadService>,
    params: DownloadCancelParams,
) -> Result<(), String> {
    service
        .update(params.job_id, |i| {
            if !matches!(i.phase.as_str(), "done" | "error" | "canceled") {
                i.phase = "canceled".into();
                i.error = Some("отменено".into());
            }
        })
        .ok_or("задание не найдено")?;
    if let Some(child) = service.take_child_handle(params.job_id) {
        // процесс жив: reader-поток дочитает EOF и завершит задание отменой
        if let Some(c) = child.lock().expect("download: лок не отравлен").as_mut() {
            let _ = c.kill();
        }
    } else {
        // фаза tools/subs: разбудить ждущий поток (если есть) пустым ответом
        service.deliver_subs_reply(params.job_id, serde_json::json!({"canceledByUser": true}));
    }
    Ok(())
}

/// download.status: инструменты + каталог + задания (панель при открытии).
#[tauri::command]
pub fn download_status(app: tauri::AppHandle) -> DownloadStatusResult {
    let profile = crate::proxy::profile_dir();
    let service = app.state::<DownloadService>();
    DownloadStatusResult {
        ytdlp_ready: tools::ytdlp_ready(&profile),
        deno_ready: tools::deno_ready(&profile),
        ffmpeg_ready: tools::ffmpeg_ready(&profile),
        default_dir: resolve_dir(None).map(|d| d.display().to_string()).unwrap_or_default(),
        jobs: service.snapshot(),
    }
}

// --- поток задания: yt-dlp ------------------------------------------------------

/// Колбэк прогресса докачки инструментов (шаг 1% — разница на каждый вызов своя).
fn tools_progress_cb(app: &tauri::AppHandle, id: u64) -> impl FnMut(u64, u64) {
    let app = app.clone();
    let mut last = -1.0f64;
    move |done: u64, total: u64| {
        let pct = if total > 0 { done as f64 / total as f64 * 100.0 } else { 0.0 };
        if (pct - last).abs() >= 1.0 {
            last = pct;
            emit_progress(
                &app,
                DownloadProgress {
                    job_id: id,
                    phase: "tools".into(),
                    percent: pct,
                    speed: format!("{} МБ", done / 1_048_576),
                    eta: String::new(),
                },
            );
        }
    }
}

fn run_media_job(
    app: tauri::AppHandle,
    id: u64,
    is_audio: bool,
    mut spec: RunSpec,
    profile_dir: std::path::PathBuf,
) {
    let service = app.state::<DownloadService>();
    let fail = |error: String| {
        service.update(id, |i| {
            i.phase = "error".into();
            i.error = Some(error.clone());
        });
        emit_finished(
            &app,
            DownloadFinished {
                job_id: id,
                mode: if is_audio { "audio".into() } else { "video".into() },
                ok: false,
                canceled: false,
                path: None,
                error: Some(error),
            },
        );
    };
    let finish_canceled = || {
        emit_finished(
            &app,
            DownloadFinished {
                job_id: id,
                mode: if is_audio { "audio".into() } else { "video".into() },
                ok: false,
                canceled: true,
                path: None,
                error: None,
            },
        );
    };
    // 1) инструменты: yt-dlp + deno (JS-runtime экстрактора YouTube — без него
    // форматы YouTube отдают 403) всегда; ffmpeg — видео (лучшие качества идут
    // отдельными дорожками), mp3 и диапазонам; m4a целиком обходится без него
    let need_ffmpeg = !is_audio || spec.audio_mp3 || spec.range.is_some();
    if let Err(e) = tools::ensure_ytdlp(&profile_dir, &mut tools_progress_cb(&app, id)) {
        return fail(format!("докачка yt-dlp: {e}"));
    }
    if service.is_canceled(id) {
        return finish_canceled();
    }
    if let Err(e) = tools::ensure_deno(&profile_dir, &mut tools_progress_cb(&app, id)) {
        return fail(format!("докачка deno: {e}"));
    }
    if service.is_canceled(id) {
        return finish_canceled();
    }
    if need_ffmpeg {
        if let Err(e) = tools::ensure_ffmpeg(&profile_dir, &mut tools_progress_cb(&app, id)) {
            return fail(format!("докачка ffmpeg: {e}"));
        }
    }
    if service.is_canceled(id) {
        return finish_canceled();
    }
    if tools::ffmpeg_ready(&profile_dir) {
        spec.ffmpeg_dir = Some(tools::bin_dir(&profile_dir).display().to_string());
    }
    // сессия YouTube из профиля приложения (нет кук — стартуем анонимно)
    if let Some(cookies) = cookies::export_for_ytdlp(&tools::bin_dir(&profile_dir)) {
        spec.cookies = Some(cookies.display().to_string());
    }
    // 2) запуск yt-dlp; deno — в PATH наследуемого окружения (yt-dlp ищет
    // JS-runtime по PATH; явных флагов с путём, содержащим «D:», избегаем)
    let exe = tools::ytdlp_path(&profile_dir);
    let mut cmd = std::process::Command::new(&exe);
    let path_env = {
        let bin = tools::bin_dir(&profile_dir).display().to_string();
        let base = std::env::var("PATH").unwrap_or_default();
        format!("{bin};{base}")
    };
    cmd.args(runner::build_args(&spec))
        .env("PATH", path_env)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return fail(format!("запуск yt-dlp: {e}")),
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child_ref = Arc::new(Mutex::new(Some(child)));
    service.set_child_handle(id, Arc::clone(&child_ref));

    // хвост диагностики для ошибок (кольцо на 8 строк) + итоговый путь файла
    let diag: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let last_path: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let mut readers = Vec::new();
    if let Some(out) = stdout {
        let app2 = app.clone();
        let diag2 = Arc::clone(&diag);
        let path2 = Arc::clone(&last_path);
        readers.push(std::thread::spawn(move || {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(out);
            let mut last_emit = std::time::Instant::now() - std::time::Duration::from_secs(2);
            for line in reader.lines().map_while(|l| l.ok()) {
                if let Some(p) = runner::parse_progress(&line) {
                    if last_emit.elapsed() >= std::time::Duration::from_millis(400) {
                        last_emit = std::time::Instant::now();
                        app2.state::<DownloadService>().update(id, |i| {
                            i.phase = "download".into();
                            i.percent = p.percent;
                            i.speed.clone_from(&p.speed);
                            i.eta.clone_from(&p.eta);
                        });
                        emit_progress(
                            &app2,
                            DownloadProgress {
                                job_id: id,
                                phase: "download".into(),
                                percent: p.percent,
                                speed: p.speed,
                                eta: p.eta,
                            },
                        );
                    }
                } else {
                    note_diag(&diag2, &line);
                    if let Some(phase) = runner::phase_of(&line) {
                        if phase == "convert" {
                            app2.state::<DownloadService>().update(id, |i| {
                                i.phase = "convert".into();
                                i.percent = 100.0;
                            });
                            emit_progress(
                                &app2,
                                DownloadProgress {
                                    job_id: id,
                                    phase: "convert".into(),
                                    percent: 100.0,
                                    speed: String::new(),
                                    eta: String::new(),
                                },
                            );
                        }
                    } else if runner::is_filepath_line(&line) {
                        *path2.lock().expect("download: лок не отравлен") =
                            Some(line.trim().to_string());
                    }
                }
            }
        }));
    }
    if let Some(err) = stderr {
        let diag2 = Arc::clone(&diag);
        readers.push(std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(err).lines().map_while(|l| l.ok()) {
                note_diag(&diag2, &line);
            }
        }));
    }
    for r in readers {
        let _ = r.join();
    }
    let status = child_ref
        .lock()
        .expect("download: лок не отравлен")
        .as_mut()
        .map(std::process::Child::wait);
    let mode: &'static str = if is_audio { "audio" } else { "video" };
    match status {
        Some(Ok(st)) if st.success() => {
            let path = last_path
                .lock()
                .expect("download: лок не отравлен")
                .clone()
                .or_else(|| newest_file(&spec.out_dir)); // печать не замечена — свежий файл
            service.update(id, |i| {
                i.phase = "done".into();
                i.percent = 100.0;
                i.out_path.clone_from(&path);
            });
            emit_finished(
                &app,
                DownloadFinished {
                    job_id: id,
                    mode: mode.into(),
                    ok: true,
                    canceled: false,
                    path,
                    error: None,
                },
            );
        }
        Some(Ok(_)) => {
            let canceled = service.is_canceled(id);
            let error = diag_tail(&diag);
            service.update(id, |i| {
                i.phase = if canceled { "canceled".into() } else { "error".into() };
                if !canceled {
                    i.error = Some(error.clone());
                }
            });
            emit_finished(
                &app,
                DownloadFinished {
                    job_id: id,
                    mode: mode.into(),
                    ok: false,
                    canceled,
                    path: None,
                    error: if canceled { None } else { Some(error) },
                },
            );
        }
        _ => fail("процесс yt-dlp завершился аварийно".into()),
    }
}

fn note_diag(diag: &Arc<Mutex<Vec<String>>>, line: &str) {
    let mut d = diag.lock().expect("download: лок не отравлен");
    d.push(line.trim().to_string());
    let len = d.len();
    if len > 8 {
        d.drain(0..len - 8);
    }
}

fn diag_tail(diag: &Arc<Mutex<Vec<String>>>) -> String {
    let d = diag.lock().expect("download: лок не отравлен");
    if d.is_empty() {
        "yt-dlp завершился с ошибкой (без диагностики)".into()
    } else {
        d.join(" | ")
    }
}

/// Самый свежий файл каталога, имя которого содержит маркер (например
/// «[jNQXAC9IVRw]» — videoId в шаблоне имени yt-dlp).
fn newest_file_with_marker(dir: &str, marker: &str) -> Option<String> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut best: Option<(std::time::SystemTime, String)> = None;
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !name.contains(marker) {
            continue;
        }
        let Ok(meta) = e.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        if let Ok(t) = meta.modified() {
            if best.as_ref().map(|(bt, _)| t > *bt).unwrap_or(true) {
                best = Some((t, e.path().display().to_string()));
            }
        }
    }
    best.map(|(_, n)| n)
}

/// videoId из watch/shorts/youtu.be-ссылки YouTube (маркер имени файла).
fn youtube_id_of(url: &str) -> Option<String> {
    let (path, query) = match url.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (url, None),
    };
    if let Some(q) = query {
        for pair in q.split('&') {
            if let Some(v) = pair.strip_prefix("v=") {
                let id: String = id_chars(v);
                if !id.is_empty() {
                    return Some(id);
                }
            }
        }
    }
    for pref in ["/watch/", "/shorts/", "youtu.be/"] {
        if let Some(pos) = path.find(pref) {
            let tail = &path[pos + pref.len()..];
            let id = id_chars(tail);
            if !id.is_empty() {
                return Some(id);
            }
        }
    }
    None
}

/// Префикс из допустимых в videoId символов (11 шт. обычно; без жёсткой длины).
fn id_chars(s: &str) -> String {
    s.chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect()
}

fn newest_file(dir: &str) -> Option<String> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut best: Option<(std::time::SystemTime, String)> = None;
    for e in entries.flatten() {
        let Ok(meta) = e.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        if let Ok(t) = meta.modified() {
            let name = e.path().display().to_string();
            if best.as_ref().map(|(bt, _)| t > *bt).unwrap_or(true) {
                best = Some((t, name));
            }
        }
    }
    best.map(|(_, n)| n)
}

// --- поток задания: субтитры -----------------------------------------------------

/// Ожидание ответа content-слоя и запись .srt. Таймаут 5 минут — перевод
/// дорожки с ретраями 429 может идти долго (tlang-конвейер адаптера). Ошибка/
/// таймаут контент-пути на YouTube-адресе — фолбэк yt-dlp --write-subs.
#[allow(clippy::too_many_arguments)]
fn run_subs_job(
    app: tauri::AppHandle,
    id: u64,
    rx: mpsc::Receiver<serde_json::Value>,
    dir: std::path::PathBuf,
    tab_url: String,
    track_id: String,
) {
    let service = app.state::<DownloadService>();
    let finish = |ok: bool, canceled: bool, path: Option<String>, error: Option<String>| {
        service.update(id, |i| {
            i.phase = if ok {
                "done".into()
            } else if canceled {
                "canceled".into()
            } else {
                "error".into()
            };
            i.out_path.clone_from(&path);
            i.error.clone_from(&error);
        });
        emit_finished(
            &app,
            DownloadFinished {
                job_id: id,
                mode: "subs".into(),
                ok,
                canceled,
                path,
                error,
            },
        );
    };
    let reply = rx.recv_timeout(std::time::Duration::from_secs(300));
    if let Ok(v) = &reply {
        if v.get("canceledByUser").and_then(|x| x.as_bool()).unwrap_or(false) {
            return finish(false, true, None, None);
        }
        if v.get("ok").and_then(|x| x.as_bool()) == Some(true) {
            // cues: [{startMs,endMs,text}]
            let mut cues = Vec::new();
            if let Some(arr) = v.get("cues").and_then(|x| x.as_array()) {
                for c in arr {
                    let (Some(start), Some(end), Some(text)) = (
                        c.get("startMs").and_then(|x| x.as_i64()),
                        c.get("endMs").and_then(|x| x.as_i64()),
                        c.get("text").and_then(|x| x.as_str()),
                    ) else {
                        continue;
                    };
                    cues.push(crate::subtitles::Cue {
                        start_ms: start,
                        end_ms: end,
                        text: text.to_string(),
                    });
                }
            }
            if !cues.is_empty() {
                let title = v.get("title").and_then(|x| x.as_str()).unwrap_or("субтитры");
                let lang = v.get("lang").and_then(|x| x.as_str()).unwrap_or("");
                let stem = sanitize_filename(&format!("{title}.{lang}"));
                let path = free_path(&dir, &stem, "srt");
                let srt = crate::subtitles::srt::write_srt(&cues);
                return match std::fs::write(&path, srt) {
                    Ok(()) => finish(true, false, Some(path.display().to_string()), None),
                    Err(e) => finish(false, false, None, Some(format!("запись {}: {e}", path.display()))),
                };
            }
            return finish(false, false, None, Some("дорожка без реплик".into()));
        }
    }
    // Контент-путь не смог (таймаут/ошибка/пусто) — фолбэк yt-dlp, если это
    // сетевой адрес и язык из trackId понятен; сам путь остаётся «subs».
    let content_error = reply
        .ok()
        .and_then(|v| v.get("error").and_then(|x| x.as_str()).map(str::to_string))
        .unwrap_or_else(|| "контент страницы не ответил за 5 минут".into());
    let fallback_lang = runner::subs_lang_of(&track_id);
    if service.is_canceled(id) {
        return finish(false, true, None, None);
    }
    if !tab_url.starts_with("http") || fallback_lang.is_none() {
        return finish(false, false, None, Some(content_error));
    }
    eprintln!("[download] subs: контент-путь не смог ({content_error}) — фолбэк yt-dlp");
    service.update(id, |i| i.phase = "tools".into());
    let profile = crate::proxy::profile_dir();
    if let Err(e) = tools::ensure_ytdlp(&profile, &mut tools_progress_cb(&app, id)) {
        return finish(false, false, None, Some(format!("докачка yt-dlp: {e}")));
    }
    let _ = tools::ensure_ffmpeg(&profile, &mut tools_progress_cb(&app, id)); // для --convert-subs srt; не вышло — vtt
    service.update(id, |i| i.phase = "subs".into());
    let lang = fallback_lang.unwrap_or_default();
    let ffmpeg = tools::ffmpeg_ready(&profile)
        .then(|| tools::bin_dir(&profile).display().to_string());
    let args = runner::build_subs_args(&tab_url, &lang, &dir.display().to_string(), ffmpeg.as_deref());
    let mut cmd = std::process::Command::new(tools::ytdlp_path(&profile));
    let path_env = {
        let bin = tools::bin_dir(&profile).display().to_string();
        let base = std::env::var("PATH").unwrap_or_default();
        format!("{bin};{base}")
    };
    cmd.args(&args)
        .env("PATH", path_env)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    // куки профиля — как у media-заданий (сессия живее анонимной)
    if let Some(cookies) = cookies::export_for_ytdlp(&tools::bin_dir(&profile)) {
        cmd.arg("--cookies").arg(cookies);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return finish(false, false, None, Some(format!("запуск yt-dlp: {e}"))),
    };
    let out = child.stdout.take();
    let err = child.stderr.take();
    let child_ref = Arc::new(Mutex::new(Some(child)));
    app.state::<DownloadService>().set_child_handle(id, Arc::clone(&child_ref));
    let diag: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let last_path: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let mut readers = Vec::new();
    if let Some(o) = out {
        let d2 = Arc::clone(&diag);
        let p2 = Arc::clone(&last_path);
        readers.push(std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(o).lines().map_while(|l| l.ok()) {
                note_diag(&d2, &line);
                if runner::is_filepath_line(&line) {
                    *p2.lock().expect("download: лок не отравлен") = Some(line.trim().to_string());
                }
            }
        }));
    }
    if let Some(e) = err {
        let d2 = Arc::clone(&diag);
        readers.push(std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(e).lines().map_while(|l| l.ok()) {
                note_diag(&d2, &line);
            }
        }));
    }
    for r in readers {
        let _ = r.join();
    }
    let status = child_ref
        .lock()
        .expect("download: лок не отравлен")
        .as_mut()
        .map(std::process::Child::wait);
    match status {
        Some(Ok(st)) if st.success() => {
            // --skip-download не порождает after_move:filepath — итог ищем
            // печатанной строкой «Writing video subtitles to:» либо свежим
            // файлом с videoId в имени (шаблон -o содержит [%(id)s])
            let mut path = last_path.lock().expect("download: лок не отравлен").clone();
            if path.is_none() {
                path = diag
                    .lock()
                    .expect("download: лок не отравлен")
                    .iter()
                    .rev()
                    .find_map(|l| l.split_once(": ").and_then(|(_, p)| {
                        let p = p.trim().trim_matches('"');
                        p.ends_with(".srt").then(|| p.to_string())
                    }));
            }
            if path.is_none() {
                path = youtube_id_of(&tab_url)
                    .and_then(|id| newest_file_with_marker(&dir.display().to_string(), &format!("[{id}]")));
            }
            match path {
                Some(p) => finish(true, false, Some(p), None),
                None => finish(false, false, None, Some("yt-dlp не отдал путь файла субтитров".into())),
            }
        }
        Some(Ok(_)) => {
            if service.is_canceled(id) {
                finish(false, true, None, None)
            } else {
                finish(false, false, None, Some(format!("{content_error}; фолбэк yt-dlp: {}", diag_tail(&diag))))
            }
        }
        _ => finish(false, false, None, Some("процесс yt-dlp завершился аварийно".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_filename_windows_rules() {
        assert_eq!(sanitize_filename("Concert: Best <2026>?"), "Concert_ Best _2026__");
        assert_eq!(sanitize_filename("  имя с точкой... "), "имя с точкой");
        assert_eq!(sanitize_filename(""), "субтитры");
        assert_eq!(sanitize_filename("..."), "субтитры");
        let long = "x".repeat(300);
        assert_eq!(sanitize_filename(&long).chars().count(), 120);
    }

    #[test]
    fn free_path_avoids_overwrite() {
        let dir = std::env::temp_dir().join(format!("duopulse-dl-free-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p1 = free_path(&dir, "трек", "srt");
        assert_eq!(p1, dir.join("трек.srt"));
        std::fs::write(&p1, "1").unwrap();
        let p2 = free_path(&dir, "трек", "srt");
        assert_eq!(p2, dir.join("трек (2).srt"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn deliver_subs_reply_unknown_job_is_false() {
        let svc = DownloadService::default();
        assert!(!svc.deliver_subs_reply(999, serde_json::json!({})));
    }

    #[test]
    fn youtube_id_of_urls() {
        assert_eq!(
            youtube_id_of("https://www.youtube.com/watch?v=jNQXAC9IVRw&list=X"),
            Some("jNQXAC9IVRw".into())
        );
        assert_eq!(
            youtube_id_of("https://youtu.be/abc-123_x?t=10"),
            Some("abc-123_x".into())
        );
        assert_eq!(
            youtube_id_of("https://www.youtube.com/shorts/QwerTy12"),
            Some("QwerTy12".into())
        );
        assert_eq!(youtube_id_of("https://example.com/video"), None);
    }
}
