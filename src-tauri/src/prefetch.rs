//! Прогрев топ-сайтов пользователя (задача 2.4, docs/04 §1.4 «Быстрые пути
//! данных»): при простое UI WebView2 заранее открывает DNS/TLS-соединения к
//! частым сайтам из истории — первая навигация на них не платит за DNS-резолв
//! и рукопожатие TLS. Все webview приложения делят одно окружение WebView2
//! (общий браузерный процесс и сетевой сервис), поэтому соединения,
//! разогретые в UI-хроме, переиспользуются контентными вкладками.
//!
//! Механика: фоновая нить (запуск из setup, [`start`]) после стартовой паузы
//! (по умолчанию 20 с — хром точно готов, пользователь ещё не ушёл далеко)
//! и далее раз в 30 минут спрашивает топ-хосты истории
//! ([`crate::history::HistoryStore::top_hosts`]) и инъекцирует в DOM хрома
//! `<link rel=preconnect>` (верхушка топа) и `<link rel=dns-prefetch>`
//! (хвост). Ссылки помечены `data-duopulse-prefetch` (идемпотентность +
//! проверка e2e). «Простой»: раунд пропускается, пока грузится хоть одна
//! вкладка (загрузке активной страницы прогрев не должен мешать — сете­вой
//! стек общий).
//!
//! Отключение: DUOPULSE_PREFETCH=0; e2e-стенды (задан DUOPULSE_START_URL)
//! прогрев не запускают — детерминизм сетевых замеров (P-07 и т.п.).
//! DUOPULSE_PREFETCH_AFTER_MS / DUOPULSE_PREFETCH_PERIOD_MS — тайминги
//! первого и повторных раундов (e2e-проверка инъекции без ожидания).

use std::time::Duration;

use tauri::{AppHandle, Manager};

/// Пауза после старта до первого раунда прогрева.
const DEFAULT_AFTER: Duration = Duration::from_secs(20);
/// Период повторных раундов.
const DEFAULT_PERIOD: Duration = Duration::from_secs(30 * 60);
/// Сколько хостов греть: топ — полным preconnect (DNS+TCP+TLS), хвост —
/// только DNS.
const PRECONNECT_TOP: usize = 5;
const HOSTS_TOTAL: usize = 10;
/// Окно истории для топа, дней: частота в рамках свежего поведения.
const WINDOW_DAYS: i64 = 30;
/// Хостов должно быть посещено минимум столько раз — разовые визиты
/// не греем.
const MIN_VISITS: u32 = 2;

/// Запустить нить прогрева (вызывается один раз из setup). Выключена
/// окружением — no-op.
pub fn start(app: AppHandle) {
    if let Ok(v) = std::env::var("DUOPULSE_PREFETCH") {
        if v == "0" {
            return;
        }
    }
    // e2e-стенды: DUOPULSE_START_URL означает детерминированный прогон —
    // фоновые сетевые касания к внешним хостам недопустимы.
    if std::env::var("DUOPULSE_START_URL").is_ok() {
        return;
    }
    let after = env_ms("DUOPULSE_PREFETCH_AFTER_MS").unwrap_or(DEFAULT_AFTER);
    let period = env_ms("DUOPULSE_PREFETCH_PERIOD_MS").unwrap_or(DEFAULT_PERIOD);
    std::thread::spawn(move || prefetch_loop(app, after, period));
}

fn env_ms(name: &str) -> Option<Duration> {
    let v = std::env::var(name).ok()?;
    let ms: u64 = v.parse().ok()?;
    Some(Duration::from_millis(ms))
}

fn prefetch_loop(app: AppHandle, after: Duration, period: Duration) {
    /// Пауза повтора, когда раунд пропущен (вкладка грузится): короткая —
    /// «не простой» бывает мимолётным.
    const RETRY: Duration = Duration::from_secs(5);
    let mut wait = after;
    loop {
        std::thread::sleep(wait);
        // Простой UI: пока какая-то вкладка грузится, раунд пропускаем.
        if app.state::<crate::tabs::TabManager>().any_loading() {
            wait = RETRY;
            continue;
        }
        wait = period;
        let hosts = app.state::<crate::history::HistoryStore>().top_hosts(
            HOSTS_TOTAL,
            WINDOW_DAYS,
            MIN_VISITS,
        );
        if hosts.is_empty() {
            continue;
        }
        let Some(webview) = app.get_webview("main") else {
            continue;
        };
        if let Err(e) = webview.eval(inject_js(&hosts)) {
            eprintln!("prefetch: инъекция в хром: {e}");
        }
    }
}

/// JS инъекции: preconnect для верхушки топа, dns-prefetch для хвоста;
/// существующие ссылки не дублируются (идемпотентность повторных раундов).
/// Хосты — из URL-парса истории (ascii/IDNA, кавычек быть не может), но
/// собираем литерал через JSON — без конкатенаций строк в код.
fn inject_js(hosts: &[String]) -> String {
    let arr = serde_json::to_string(hosts).unwrap_or_else(|_| "[]".into());
    format!(
        r#"(function () {{
  var hosts = {arr};
  var head = document.head;
  hosts.slice(0, {PRECONNECT_TOP}).forEach(function (h) {{ add("preconnect", h); }});
  hosts.slice({PRECONNECT_TOP}).forEach(function (h) {{ add("dns-prefetch", h); }});
  function add(rel, host) {{
    if (document.querySelector('link[data-duopulse-prefetch="' + host + '"]')) return;
    var l = document.createElement("link");
    l.rel = rel;
    l.href = "https://" + host;
    l.setAttribute("data-duopulse-prefetch", host);
    head.appendChild(l);
  }}
}})();"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inject_js_marks_hosts_and_splits_rels() {
        let hosts: Vec<String> = ["a.test", "b.test", "c.test", "d.test", "e.test", "f.test"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let js = inject_js(&hosts);
        assert!(js.contains(r#"["a.test","b.test"#), "хосты — JSON-литерал");
        assert!(
            js.contains(r#"hosts.slice(0, 5).forEach"#),
            "топ — preconnect"
        );
        assert!(
            js.contains(r#"hosts.slice(5).forEach"#),
            "хвост — dns-prefetch"
        );
        assert!(js.contains(r#"l.setAttribute("data-duopulse-prefetch", host)"#));
    }
}
