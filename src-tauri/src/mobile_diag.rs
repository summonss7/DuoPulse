//! Диагностика мобильной ветки (карточка duopulse-164, паритет 1/8 аудита
//! duopulse-156): лист «Диагностика» в меню «⋮» (src/mobile/diagnostics.ts).
//! Десктопная страница duopulse://diagnostics (perf.snapshot, метрики
//! P-01..P-08, история прогонов) — десктопные бюджеты, на мобильную НЕ
//! переносится; здесь — лёгкий снимок для поддержки: версия/канал, сеанс,
//! память процесса (RSS из /proc/self/status), счётчики сторов (история/
//! закладки/пароли) и адблока (заблокировано/видено за сеанс). Открытые
//! вкладки и метка последней проверки обновлений — состояние фронта
//! (localStorage), приходят параметрами и ложатся в тот же снимок; сеть
//! снимок не трогает (проверка обновлений НЕ выполняется). Каркас секций
//! листа рассчитан на будущие VPN/ASR (этапы 6–8 цепочки duopulse-162):
//! новая секция = поля в DiagSnapshot + строки в diagSections, без переделки.
//!
//! Чистые функции (парсер RSS, метка канала, сериализация) компилируются
//! везде и тестируются на хосте (паттерн mobile_pdf/mobile_open);
//! #[tauri::command] — только мобильным таргетам либы (0xc0000139, см.
//! шапку mobile_open.rs).

use serde::Serialize;

/// Старт сеанса: фиксирует setup мобильной либы (lib.rs) до старта окна —
/// «время сеанса» снимка отсчитывается от него, а не от первого открытия
/// листа. OnceLock — повторные init (не бывает) не обнуляют старт.
static SESSION_START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

/// Зафиксировать старт сеанса (вызов из setup; повторные — no-op).
pub fn init() {
    let _ = SESSION_START.set(std::time::Instant::now());
}

/// Секунд с начала сеанса (0 — init не звали; на практике не бывает).
pub fn session_secs() -> u64 {
    SESSION_START.get().map_or(0, |s| s.elapsed().as_secs())
}

/// VmRSS из текста /proc/self/status → кБ. Linux-формат строки
/// «VmRSS:\t 123456 kB» (значение — кБ без разделителей); нет строки или
/// не число — None.
pub fn parse_vm_rss_kb(status: &str) -> Option<u64> {
    let line = status.lines().find(|l| l.starts_with("VmRSS:"))?;
    line["VmRSS:".len()..]
        .trim()
        .split_whitespace()
        .next()?
        .parse::<u64>()
        .ok()
}

/// RSS процесса: на Android — VmRSS из /proc/self/status; прочие мобильные
/// таргеты и хост-тесты — None (лист честно покажет «—»). Вызывает только
/// мобильная команда — гейт против dead-code десктоп-либы.
#[cfg(any(target_os = "android", target_os = "ios"))]
fn rss_kb() -> Option<u64> {
    #[cfg(target_os = "android")]
    {
        std::fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|s| parse_vm_rss_kb(&s))
    }
    #[cfg(not(target_os = "android"))]
    {
        None
    }
}

/// Метка канала обновлений — хост базы mobile_updater (стандартный
/// aila.skillcoin.pp.ua или переопределение DUOPULSE_UPDATE_BASE);
/// пустое — «—».
pub fn channel_label(base: &str) -> String {
    let no_scheme = base.split_once("://").map_or(base, |(_, rest)| rest);
    let host = no_scheme.split('/').next().unwrap_or("").trim();
    if host.is_empty() {
        "—".to_string()
    } else {
        host.to_string()
    }
}

/// Адблок в снимке (None — сервис недоступен: профиль не открылся).
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagAdblock {
    pub enabled: bool,
    /// Списки загружены — фильтрация активна.
    pub ready: bool,
    /// Заблокировано за сеанс.
    pub blocked_total: u64,
    /// Всего http(s)-запросов через перехватчик за сеанс.
    pub seen_total: u64,
}

/// Ответ diag_snapshot (зеркало — DiagSnapshot в src/mobile/diagnostics.ts).
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagSnapshot {
    pub app_version: String,
    /// Хост канала обновлений (channel_label).
    pub channel: String,
    pub session_secs: u64,
    /// RSS процесса, кБ (None — прочитать не удалось).
    pub rss_kb: Option<u64>,
    /// Открытых вкладок — состояние фронта (tabs), пришло параметром.
    pub tabs: u32,
    /// Записей истории (агрегат по URL, как в листе «История»).
    pub history_entries: u64,
    /// Закладок всего.
    pub bookmarks: u64,
    /// Сохранённых логинов.
    pub passwords: u64,
    /// Счётчики адблока за сеанс (None — движок недоступен).
    pub adblock: Option<DiagAdblock>,
    /// Последняя проверка обновлений, unix-ms (None — не проверяли; метка
    /// localStorage фронта — updater.ts, тоже параметр).
    pub last_update_check_ms: Option<i64>,
    /// Время снимка, unix-ms.
    pub now_ms: i64,
}

/// Время снимка; вызывает только мобильная команда (гейт — как rss_kb).
#[cfg(any(target_os = "android", target_os = "ios"))]
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// diag_snapshot: лёгкий снимок состояния для листа «Диагностика» (меню «⋮»).
/// Сторы и адблок — из управляемых в setup State-сторов/сервиса; счётчики
/// читаются лимитом 1 (нужен только total).
#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub fn diag_snapshot(
    app: tauri::AppHandle,
    history: tauri::State<'_, std::sync::Arc<crate::history::HistoryStore>>,
    passwords: tauri::State<'_, std::sync::Arc<crate::passwords::PasswordStore>>,
    tabs: Option<u32>,
    last_update_check_ms: Option<i64>,
) -> Result<DiagSnapshot, String> {
    let (_, history_total) = history.list("", 0, 1)?;
    let (_, bookmark_total) = history.bookmark_list("", crate::history::GroupFilter::All, 0, 1)?;
    let pw_total = passwords.list("", 1)?.total;
    let adblock =
        crate::mobile_adblock::mobile_adblock_status()
            .ok()
            .map(|s| DiagAdblock {
                enabled: s.enabled,
                ready: s.ready,
                blocked_total: s.blocked_total,
                seen_total: s.seen_total,
            });
    Ok(DiagSnapshot {
        app_version: app.package_info().version.to_string(),
        channel: channel_label(&crate::mobile_updater::update_base()),
        session_secs: session_secs(),
        rss_kb: rss_kb(),
        tabs: tabs.unwrap_or(0),
        history_entries: history_total as u64,
        bookmarks: bookmark_total as u64,
        passwords: pw_total,
        adblock,
        last_update_check_ms,
        now_ms: now_ms(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_vm_rss_from_proc_status() {
        let status = "Name:\tduopulse\nState:\tS (sleeping)\nVmSize:\t 902324 kB\nVmRSS:\t 241152 kB\nThreads:\t42\n";
        assert_eq!(parse_vm_rss_kb(status), Some(241_152));
    }

    #[test]
    fn vm_rss_missing_or_broken_is_none() {
        assert_eq!(parse_vm_rss_kb("Name:\tduopulse\n"), None);
        assert_eq!(parse_vm_rss_kb("VmRSS:\t kB\n"), None);
        assert_eq!(parse_vm_rss_kb(""), None);
    }

    #[test]
    fn channel_label_is_host_of_update_base() {
        assert_eq!(
            channel_label("https://aila.skillcoin.pp.ua/updates/duopulse"),
            "aila.skillcoin.pp.ua",
        );
        // переопределение DUOPULSE_UPDATE_BASE: хост с портом, без схемы
        assert_eq!(channel_label("http://10.0.2.2:8080/updates"), "10.0.2.2:8080");
        assert_eq!(channel_label("aila.skillcoin.pp.ua"), "aila.skillcoin.pp.ua");
        assert_eq!(channel_label("  "), "—");
    }

    #[test]
    fn snapshot_serializes_camel_case() {
        let snap = DiagSnapshot {
            app_version: "0.1.64".into(),
            channel: "aila.skillcoin.pp.ua".into(),
            session_secs: 75,
            rss_kb: Some(241_152),
            tabs: 3,
            history_entries: 12,
            bookmarks: 4,
            passwords: 2,
            adblock: Some(DiagAdblock {
                enabled: true,
                ready: false,
                blocked_total: 7,
                seen_total: 90,
            }),
            last_update_check_ms: Some(1_700_000_000_000),
            now_ms: 1_700_000_060_000,
        };
        let v = serde_json::to_value(&snap).unwrap();
        assert_eq!(v["appVersion"], "0.1.64");
        assert_eq!(v["sessionSecs"], 75);
        assert_eq!(v["lastUpdateCheckMs"].as_i64(), Some(1_700_000_000_000));
        assert_eq!(v["adblock"]["blockedTotal"], 7);
        assert!(v.get("app_version").is_none());
    }

    #[test]
    fn session_secs_counts_from_init() {
        init(); // идемпотентно: повтор не обнуляет старт и не паникует
        init();
        // живой тестовый процесс — сеанс заведомо меньше часа
        assert!(session_secs() < 3600);
    }
}
