//! Метрики производительности (задача 2.5, docs/04 §2; словарь perf.* —
//! docs/05 §2): живой съём в Core + история прогонов в SQLite.
//!
//! Живой съём: фазы старта пишет [`record_phase`] (тот же вывод «[startup]»
//! в stderr, что и до страницы — разбор P-01/P-02 по этапам), итог старта
//! фиксирует [`emit_startup`] на RunEvent::Ready (событие perf:startup_ms),
//! переключение вкладок меряет TabManager::activate (событие
//! perf:tab_switch_ms, [`note_tab_switch`]); срез всего сеанса — команда
//! perf.snapshot (bridge.rs). Значения хранятся в статике модуля: они
//! принадлежат процессу, а не какому-либо состоянию Tauri.
//!
//! История прогонов: SQLite-таблица `perf_runs` в общем duopulse.db профиля
//! (docs/02 §8), последние [`KEEP_RUNS`] прогонов — регрессия видна на
//! графике страницы «Диагностика» (docs/04 §3). Прогон = набор значений
//! P-01..P-08: страница сохраняет срез живого сеанса, эталонный e2e-прогон
//! пишет замеренные медианы (e2e/perf/save-run.mjs, тот же формат таблицы).
//! Идентификаторы метрик (p01_ms, p03_mb, …) и бюджеты — словарь страницы
//! (src/pages/diagnostics.ts), Core хранит числа как есть.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::bridge::BridgeEvent;

/// Сколько прогонов хранит история (docs/04 §3: «последние 10 прогонов»).
const KEEP_RUNS: usize = 10;

/// Память переключений вкладок сеанса (мс), последние — для avg/max.
const SWITCH_WINDOW: usize = 200;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// --- живой съём сеанса (статика процесса) -----------------------------------

/// Точка отсчёта старта: первый вызов [`record_phase`] (вход в main).
static T0: OnceLock<Instant> = OnceLock::new();
/// Фазы старта «[startup]»: stage → мс от входа в main.
static PHASES: OnceLock<Mutex<Vec<PerfPhase>>> = OnceLock::new();
/// Итог старта: заполнен на RunEvent::Ready (None до того).
static STARTUP: OnceLock<Mutex<Option<PerfStartupInfo>>> = OnceLock::new();
/// Стартовый профиль был пуст (холодный старт P-01, а не тёплый P-02).
static COLD: OnceLock<bool> = OnceLock::new();
/// Длительности переключений вкладок сеанса, мс.
static SWITCHES: OnceLock<Mutex<Vec<u64>>> = OnceLock::new();

/// Зафиксировать до открытия хранилищ: профиль уже существует (тёплый старт)
/// или это первый запуск на нём (холодный).
pub fn set_cold(cold: bool) {
    let _ = COLD.set(cold);
}

/// Метка фазы старта: печать «[startup] <фаза>: N мс» в stderr (разбор
/// регрессий P-01/P-02, как в задаче 2.4) + накопление для perf.snapshot.
pub fn record_phase(stage: &str) {
    let t0 = T0.get_or_init(Instant::now);
    let ms = t0.elapsed().as_millis() as u64;
    eprintln!("[startup] {stage}: {ms} ms");
    PHASES
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .expect("perf: лок фаз не отравлен")
        .push(PerfPhase {
            stage: stage.to_string(),
            ms,
        });
}

/// Итог старта на RunEvent::Ready: длительность от входа в main, флаг
/// холодного профиля, фазы; эмитит perf:startup_ms (словарь docs/05 §2) и
/// запоминает для perf.snapshot. Повторные вызовы (перезапуск в том же
/// процессе — app.restart) обновляют значение.
pub fn emit_startup(app: &tauri::AppHandle) {
    let Some(t0) = T0.get() else {
        return;
    };
    let ms = t0.elapsed().as_millis() as u64;
    let cold = *COLD.get_or_init(|| false);
    let phases = PHASES
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .expect("perf: лок фаз не отравлен")
        .clone();
    *STARTUP
        .get_or_init(|| Mutex::new(None))
        .lock()
        .expect("perf: лок старта не отравлен") = Some(PerfStartupInfo { cold, ms, phases });
    crate::bridge::emit::<PerfStartupEvent>(app, &PerfStartupMs { cold, ms }).ok();
}

/// Переключение активной вкладки состоялось за N мс (TabManager::activate:
/// смена видимости webview + фокус): накопление для perf.snapshot + событие
/// perf:tab_switch_ms.
pub fn note_tab_switch(app: &tauri::AppHandle, ms: u64) {
    let mut switches = SWITCHES
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .expect("perf: лок переключений не отравлен");
    switches.push(ms);
    if switches.len() > SWITCH_WINDOW {
        let excess = switches.len() - SWITCH_WINDOW;
        switches.drain(0..excess);
    }
    drop(switches);
    crate::bridge::emit::<PerfTabSwitchEvent>(app, &PerfTabSwitchMs { ms }).ok();
}

/// Итог старта этого сеанса (perf.snapshot).
pub fn startup_info() -> Option<PerfStartupInfo> {
    STARTUP
        .get_or_init(|| Mutex::new(None))
        .lock()
        .expect("perf: лок старта не отравлен")
        .clone()
}

/// Статистика переключений вкладок сеанса (perf.snapshot): последнее,
/// среднее и максимум по окну SWITCH_WINDOW, всего переключений.
pub fn tab_switch_info() -> PerfTabSwitchInfo {
    let switches = SWITCHES
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .expect("perf: лок переключений не отравлен");
    if switches.is_empty() {
        return PerfTabSwitchInfo {
            last_ms: None,
            avg_ms: None,
            max_ms: None,
            count: 0,
        };
    }
    let sum: u64 = switches.iter().sum();
    PerfTabSwitchInfo {
        last_ms: Some(*switches.last().expect("непусто — проверено выше")),
        avg_ms: Some(sum / switches.len() as u64),
        max_ms: Some(*switches.iter().max().expect("непусто — проверено выше")),
        count: switches.len() as u32,
    }
}

/// Время с входа в main, мс (perf.snapshot).
pub fn uptime_ms() -> u64 {
    T0.get()
        .map(|t0| t0.elapsed().as_millis() as u64)
        .unwrap_or(0)
}

/// Приватная память duopulse.exe, МБ (P-03 «поверх WebView2» — та же
/// методика, что у e2e/perf: committed private bytes процесса оболочки).
#[cfg(windows)]
pub fn ram_self_mb() -> u64 {
    use windows::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
    };
    use windows::Win32::System::Threading::GetCurrentProcess;

    let mut counters = PROCESS_MEMORY_COUNTERS_EX::default();
    let cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
    // SAFETY: counters жив до вызова, размер передан в cb; GetCurrentProcess —
    // псевдо-хендл текущего процесса, закрывать не нужно.
    let ok = unsafe {
        GetProcessMemoryInfo(
            GetCurrentProcess(),
            &mut counters as *mut PROCESS_MEMORY_COUNTERS_EX as *mut PROCESS_MEMORY_COUNTERS,
            cb,
        )
    };
    if ok.is_err() {
        return 0;
    }
    (counters.PrivateUsage as u64) / (1024 * 1024)
}

/// Нешиндовс-фолбэк (сборка проекта — только Windows, см. Cargo.toml).
#[cfg(not(windows))]
pub fn ram_self_mb() -> u64 {
    0
}

// --- история прогонов (SQLite, duopulse.db) ----------------------------------

/// Хранилище прогонов метрик: таблица perf_runs общего duopulse.db
/// (потокобезопасно через Mutex, обращения короткие).
pub struct PerfStore {
    conn: Mutex<Connection>,
}

impl PerfStore {
    /// Открыть/создать таблицу perf_runs в duopulse.db профиля.
    pub fn open(dir: &Path) -> rusqlite::Result<Self> {
        std::fs::create_dir_all(dir).map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(format!(
                "создать каталог профиля {}: {e}",
                dir.display()
            ))))
        })?;
        Self::connect(Connection::open(dir.join("duopulse.db"))?)
    }

    /// In-memory хранилище (тесты).
    #[cfg(test)]
    pub fn open_in_memory() -> rusqlite::Result<Self> {
        Self::connect(Connection::open_in_memory()?)
    }

    fn connect(conn: Connection) -> rusqlite::Result<Self> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "busy_timeout", 5000)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS perf_runs(
                 id INTEGER PRIMARY KEY,
                 created_at INTEGER NOT NULL,
                 label TEXT NOT NULL DEFAULT '',
                 metrics TEXT NOT NULL
             );",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Сохранить прогон (значения P-01..P-08 по идентификаторам страницы);
    /// история обрезается до KEEP_RUNS последних.
    pub fn save_run(&self, label: &str, metrics: &BTreeMap<String, f64>) -> Result<(), String> {
        let label: String = label.chars().take(120).collect();
        let metrics =
            serde_json::to_string(metrics).map_err(|e| format!("сериализация метрик: {e}"))?;
        let mut conn = self.conn.lock().expect("perf: лок не отравлен");
        let tx = conn.transaction().map_err(err_sql)?;
        tx.execute(
            "INSERT INTO perf_runs(created_at, label, metrics) VALUES (?1, ?2, ?3)",
            rusqlite::params![now_ms(), label, metrics],
        )
        .map_err(err_sql)?;
        tx.execute(
            "DELETE FROM perf_runs WHERE id NOT IN (
                 SELECT id FROM perf_runs ORDER BY id DESC LIMIT ?1
             )",
            rusqlite::params![KEEP_RUNS as i64],
        )
        .map_err(err_sql)?;
        tx.commit().map_err(err_sql)?;
        Ok(())
    }

    /// Прогоны для графика страницы: новые → старые (последние KEEP_RUNS).
    pub fn list_runs(&self) -> Result<Vec<PerfRun>, String> {
        let conn = self.conn.lock().expect("perf: лок не отравлен");
        let mut stmt = conn
            .prepare("SELECT id, created_at, label, metrics FROM perf_runs ORDER BY id DESC")
            .map_err(err_sql)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .map_err(err_sql)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err_sql)?;
        rows.into_iter()
            .map(|(id, created_at, label, metrics)| {
                // Битый JSON (внешние записи) не должен ломать страницу —
                // прогон показывается без метрик.
                let metrics = serde_json::from_str(&metrics).unwrap_or_default();
                Ok(PerfRun {
                    id,
                    created_at,
                    label,
                    metrics,
                })
            })
            .collect()
    }
}

fn err_sql(e: rusqlite::Error) -> String {
    format!("sqlite: {e}")
}

// --- схемы IPC (часть контракта bridge, задачи 2.5) --------------------------

/// perf.snapshot (результат): живой срез сеанса для страницы «Диагностика».
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PerfSnapshotResult {
    pub startup: Option<PerfStartupInfo>,
    pub tab_switch: PerfTabSwitchInfo,
    /// Приватная память duopulse.exe, МБ (P-03).
    pub ram_self_mb: u64,
    pub uptime_ms: u64,
    pub tabs: PerfTabs,
    pub adblock: PerfAdblock,
}

/// Итог старта этого сеанса (perf.snapshot / payload perf:startup_ms без фаз).
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PerfStartupInfo {
    /// Профиль на старте был пуст — холодный старт (P-01), иначе тёплый (P-02).
    pub cold: bool,
    /// Вход в main → RunEvent::Ready, мс.
    pub ms: u64,
    /// Фазы «[startup]» (main, stores-open, setup, …, ready).
    pub phases: Vec<PerfPhase>,
}

/// Одна фаза старта: имя и накопленное время от входа в main, мс.
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PerfPhase {
    pub stage: String,
    pub ms: u64,
}

/// payload события perf:startup_ms (фазы страница берёт perf.snapshot'ом).
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PerfStartupMs {
    pub cold: bool,
    pub ms: u64,
}

/// Событие perf:startup_ms (словарь docs/05 §2).
#[derive(Debug, Clone)]
pub struct PerfStartupEvent;

impl BridgeEvent for PerfStartupEvent {
    const NAME: &'static str = "perf:startup_ms";
    type Payload = PerfStartupMs;
}

/// payload события perf:tab_switch_ms.
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PerfTabSwitchMs {
    pub ms: u64,
}

/// Событие perf:tab_switch_ms (словарь docs/05 §2).
#[derive(Debug, Clone)]
pub struct PerfTabSwitchEvent;

impl BridgeEvent for PerfTabSwitchEvent {
    const NAME: &'static str = "perf:tab_switch_ms";
    type Payload = PerfTabSwitchMs;
}

/// Переключения вкладок сеанса (perf.snapshot).
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PerfTabSwitchInfo {
    pub last_ms: Option<u64>,
    pub avg_ms: Option<u64>,
    pub max_ms: Option<u64>,
    pub count: u32,
}

/// Вкладки сеанса (perf.snapshot): всего и спящих (P-04 в живом сеансе).
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PerfTabs {
    pub total: u32,
    pub sleeping: u32,
}

/// Счётчики блокировщика сеанса (perf.snapshot): контекст P-07.
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PerfAdblock {
    pub ready: bool,
    pub enabled: bool,
    pub blocked_total: u64,
    pub seen_total: u64,
}

/// perf.save_run (параметры): метки прогона и значения метрик по
/// идентификаторам страницы (p01_ms, p02_ms, …).
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PerfSaveRunParams {
    #[serde(default)]
    pub label: String,
    pub metrics: BTreeMap<String, f64>,
}

/// perf.list_runs (результат): прогоны, новые → старые.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct PerfRunListResult {
    pub runs: Vec<PerfRun>,
}

/// Сохранённый прогон метрик (perf.list_runs).
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PerfRun {
    pub id: i64,
    /// Время сохранения, unix-ms.
    pub created_at: i64,
    pub label: String,
    pub metrics: BTreeMap<String, f64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metrics(pairs: &[(&str, f64)]) -> BTreeMap<String, f64> {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    /// История хранит значения и режет хвост за KEEP_RUNS; порядок — новые
    /// сверху; метрики переживают JSON-кругозворот.
    #[test]
    fn runs_history_keeps_last_ten() {
        let store = PerfStore::open_in_memory().expect("память");
        for i in 0..(KEEP_RUNS + 3) {
            store
                .save_run(
                    &format!("прогон {i}"),
                    &metrics(&[("p01_ms", 400.0 + i as f64)]),
                )
                .expect("сохранить");
        }
        let runs = store.list_runs().expect("список");
        assert_eq!(runs.len(), KEEP_RUNS);
        assert_eq!(
            runs[0].label,
            format!("прогон {}", KEEP_RUNS + 2),
            "новые сверху"
        );
        assert_eq!(
            runs[0].metrics.get("p01_ms"),
            Some(&(400.0 + (KEEP_RUNS + 2) as f64)),
            "метрики пережили JSON"
        );
        assert_eq!(runs.last().expect("непусто").label, "прогон 3");
    }

    /// Живой съём: фазы и переключения накапливаются, статистика сходится.
    #[test]
    fn live_switch_stats() {
        let switches = SWITCHES.get_or_init(|| Mutex::new(Vec::new()));
        switches.lock().expect("лок").clear();
        let info = tab_switch_info();
        assert_eq!(info.count, 0);
        assert!(info.last_ms.is_none());
        for ms in [12, 20, 7] {
            switches.lock().expect("лок").push(ms);
        }
        let info = tab_switch_info();
        assert_eq!(info.count, 3);
        assert_eq!(info.last_ms, Some(7));
        assert_eq!(info.avg_ms, Some(13));
        assert_eq!(info.max_ms, Some(20));
        switches.lock().expect("лок").clear();
    }
}
