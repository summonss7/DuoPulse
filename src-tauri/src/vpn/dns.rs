//! DNS-резолв строго по маршруту (задача 6.3, docs/02 §6.1–6.2).
//!
//! Правило без утечек (docs/02 §6): DNS-запрос домена уходит тем же
//! маршрутом, что и само соединение —
//!   - туннельный домен (split-правило «tunnel» или режим global): резолвит
//!     ТОЛЬКО DNS-сервер профиля WireGuard через UDP-сокет стека внутри
//!     туннеля ([`crate::vpn::wg::WgSession::resolve`]); к системному
//!     резолверу туннельный маршрут не обращается — утечек нет;
//!   - прямой домен (режим off, прокси-режим без удалённого резолва не
//!     бывает — см. ниже, split-правило «direct»/умолчание): системный
//!     резолвер, как без VPN.
//!
//! Схема `--proxy-server=socks5://…` заставляет Chromium присылать домен
//! неразрешённым (ATYP=domain), поэтому решение «куда резолвить» принимает
//! роутер ПОСЛЕ матчинга split-правила — по имени, до первого DNS-запроса.
//! Внешний прокси (Upstream) получает цель доменом и резолвит её сам
//! (удалённый резолв, RFC 1928) — локальных DNS-запросов тоже нет.
//!
//! Единственное системное исключение — endpoint самого WG-сервера: он
//! резолвится до туннеля системно, как у любого WireGuard-клиента
//! (внутри туннеля пути к нему ещё нет).
//!
//! Устойчивость системного пути (карточка duopulse-054, docs/02 §6.1):
//! проксирование через socks5 отнимает у Chromium его собственный резолвер
//! (кэш HostCache + повторные запросы к нескольким серверам + фолбэк в
//! системный) — резолв каждого соединения делает роутер одним getaddrinfo
//! без ретрая и кэша, и транзитный флэк DNS (os error 11001 на живых
//! CDN-хостах, 24.10.2026) ронял перезагружаемую страницу в ошибку.
//! Поэтому [`resolve_system`] повторяет неудачный резолв с нарастающей
//! задержкой и держит короткий позитивный кэш горячих имён — паритет с
//! браузерным поведением на классе «перегрузка страницы через секунды
//! после успешной загрузки» (themeRefresh YouTube). Негативные ответы не
//! кэшируются (Windows dnscache негативного ответа добавлять не нужно),
//! connect-ошибки (10053) не ретраятся — см. docs/02 §6.1.

use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// Резолвер, соответствующий выбранному маршруту соединения.
pub enum Resolver<'a> {
    /// DNS-сервер профиля через туннель WireGuard (без утечек).
    Tunnel(&'a crate::vpn::wg::WgSession),
    /// Системный резолвер (прямой маршрут).
    System,
}

impl Resolver<'_> {
    /// Адрес для TCP-соединения. IP-литералы проходят без DNS-запроса
    /// вовсе; туннель — стек proto-ipv4, IPv6-литерал честно отклоняется.
    pub fn resolve(&self, host: &str, port: u16) -> Result<SocketAddr, String> {
        match self {
            Resolver::Tunnel(session) => match host.trim().parse::<IpAddr>() {
                Ok(IpAddr::V4(v4)) => Ok(SocketAddr::new(IpAddr::V4(v4), port)),
                Ok(IpAddr::V6(_)) => Err(format!("{host}: IPv6 через туннель не поддержан (v1)")),
                Err(_) => session
                    .resolve(host.trim())
                    .map(|ip| SocketAddr::new(IpAddr::V4(ip), port))
                    .map_err(|e| format!("резолв {host} DNS-сервером туннеля: {e}")),
            },
            Resolver::System => resolve_system(host, port),
        }
    }
}

/// Кэш системного резолва: имя → (адреса в порядке getaddrinfo, момент
/// успешного резолва). Только позитивные ответы; TTL — [`SYSTEM_POLICY`].
type SystemCache = HashMap<String, (Vec<IpAddr>, Instant)>;

static SYSTEM_CACHE: LazyLock<Mutex<SystemCache>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Политика ретрая/кэша системного резолва (карточка duopulse-054).
/// 3 попытки с задержками 250 и 500 мс покрывают короткие UDP-флэки
/// (потеря/таймаут запроса), не пытаясь «переждать» негативный кэш
/// Windows; TTL 60 с кэша — порядок TTL CDN-записей, за вычетом риска
/// устаревания адреса; лимит — переполнение сбрасывает каталог целиком
/// (как каталог событий роутера: это кэш, не таблица маршрутов).
#[derive(Clone, Copy)]
struct SystemPolicy {
    attempts: usize,
    delay: Duration,
    backoff: u32,
    ttl: Duration,
    limit: usize,
}

impl SystemPolicy {
    /// Тестовая политика: микрозадержки/деградированный TTL.
    #[cfg(test)]
    fn quick() -> Self {
        Self {
            attempts: 3,
            delay: Duration::from_millis(1),
            backoff: 2,
            ttl: Duration::from_secs(60),
            limit: 512,
        }
    }
}

const SYSTEM_POLICY: SystemPolicy = SystemPolicy {
    attempts: 3,
    delay: Duration::from_millis(250),
    backoff: 2,
    ttl: Duration::from_secs(60),
    limit: 512,
};

/// Системный резолв (прямой маршрут): IP-литерал — без DNS, иначе
/// getaddrinfo с ретраем и позитивным кэшем (карточка duopulse-054).
pub fn resolve_system(host: &str, port: u16) -> Result<SocketAddr, String> {
    resolve_system_with(getaddrinfo_once, host, port, &SYSTEM_CACHE, SYSTEM_POLICY)
}

/// Одна попытка getaddrinfo: все адреса имени в исходном порядке (как
/// итератор `ToSocketAddrs` до правки — потребитель берёт первый).
fn getaddrinfo_once(host: &str) -> io::Result<Vec<IpAddr>> {
    let addrs: Vec<IpAddr> = (host, 0u16).to_socket_addrs()?.map(|sa| sa.ip()).collect();
    if addrs.is_empty() {
        return Err(io::Error::other("резолв вернул пусто"));
    }
    Ok(addrs)
}

/// Резолв с ретраем и кэшем; попытка — инъекция (getaddrinfo в бою,
/// фейки в тестах). Мьютекс кэша захватывается только на чтение/запись
/// одной записи — резолв с ретраями (~0,75 с на стойкий сбой) не должен
/// останавливать резолвы других хостов (нити соединений роутера).
fn resolve_system_with<F>(
    lookup: F,
    host: &str,
    port: u16,
    cache: &Mutex<SystemCache>,
    policy: SystemPolicy,
) -> Result<SocketAddr, String>
where
    F: Fn(&str) -> io::Result<Vec<IpAddr>>,
{
    let host = host.trim();
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(SocketAddr::new(ip, port)); // литерал: без DNS и кэша
    }
    {
        let guard = cache.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((ips, at)) = guard.get(host) {
            if at.elapsed() < policy.ttl {
                if let Some(ip) = ips.first() {
                    return Ok(SocketAddr::new(*ip, port));
                }
            }
        }
    }
    let mut last_err = String::new();
    let mut delay = policy.delay;
    for attempt in 1..=policy.attempts {
        if attempt > 1 {
            std::thread::sleep(delay);
            delay *= policy.backoff;
        }
        match lookup(host) {
            Ok(addrs) => {
                let Some(ip) = addrs.first().copied() else {
                    last_err = "резолв вернул пусто".into();
                    continue;
                };
                if attempt > 1 {
                    eprintln!(
                        "[vpn] резолв {host}: попытка {attempt}/{} прошла после сбоя",
                        policy.attempts
                    );
                }
                let mut guard = cache.lock().unwrap_or_else(|p| p.into_inner());
                if guard.len() >= policy.limit {
                    guard.clear();
                }
                guard.insert(host.to_string(), (addrs, Instant::now()));
                return Ok(SocketAddr::new(ip, port));
            }
            Err(e) => {
                eprintln!(
                    "[vpn] резолв {host}: попытка {attempt}/{}: {e}",
                    policy.attempts
                );
                last_err = e.to_string();
            }
        }
    }
    Err(format!("резолв {host}: {last_err}"))
}

// ---------------------------------------------------------------------------
// Тесты: системный путь и литералы (туннельный путь — интеграционно в
// wg.rs/router.rs по loopback-стенду: DNS-ответчик сервера видит запрос,
// системный резолвер — нет).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// Счётчик вызовов фейкового резолвера по хостам.
    type Calls = Arc<Mutex<HashMap<String, usize>>>;

    /// Фейковый резолвер-замыкание: сценарий неуспехов (11001) перед
    /// первым успехом (usize::MAX — неуспех всегда); второй элемент —
    /// счётчик вызовов по хостам.
    fn fake_lookup(
        fails_first: usize,
    ) -> (Calls, impl Fn(&str) -> io::Result<Vec<IpAddr>> + Clone) {
        let calls: Calls = Arc::new(Mutex::new(HashMap::new()));
        let lookup = {
            let calls = calls.clone();
            move |host: &str| {
                let n = {
                    let mut calls = calls.lock().unwrap();
                    let n = calls.entry(host.to_string()).or_insert(0);
                    *n += 1;
                    *n
                };
                if n <= fails_first {
                    // Настоящий вид ошибки роутера (getaddrinfo WSAHOST_NOT_FOUND).
                    Err(io::Error::from_raw_os_error(11001))
                } else {
                    Ok(vec![[93, 184, 216, 34].into(), [1, 1, 1, 1].into()])
                }
            }
        };
        (calls, lookup)
    }

    fn calls_of(calls: &Calls, host: &str) -> usize {
        *calls.lock().unwrap().get(host).unwrap_or(&0)
    }

    fn fresh_cache() -> Mutex<SystemCache> {
        Mutex::new(HashMap::new())
    }

    #[test]
    fn system_resolves_localhost_and_literals() {
        let a = resolve_system("127.0.0.1", 80).unwrap();
        assert_eq!(a, SocketAddr::new(IpAddr::V4([127, 0, 0, 1].into()), 80));

        let a = resolve_system("  localhost  ", 8080).unwrap();
        assert_eq!(a.port(), 8080);
        assert!(a.ip().is_loopback(), "localhost — loopback: {a}");
    }

    #[test]
    fn system_unresolvable_name_is_error() {
        // .test — зарезервированная зона (RFC 6761), в системном DNS её нет.
        assert!(resolve_system("no-such-host.invalid", 80).is_err());
    }

    /// Транзитный сбой (11001) на живом хосте: повторная попытка проходит,
    /// соединение не роняется (суть карточки duopulse-054).
    #[test]
    fn retry_recovers_transient_resolve_failure() {
        let (calls, lookup) = fake_lookup(1); // первая попытка падает
        let addr = resolve_system_with(
            &lookup,
            "live.example",
            443,
            &fresh_cache(),
            SystemPolicy::quick(),
        )
        .expect("ретрай вытащил");
        assert_eq!(addr.ip(), IpAddr::from([93, 184, 216, 34]));
        assert_eq!(addr.port(), 443);
        assert_eq!(calls_of(&calls, "live.example"), 2, "ровно две попытки");
    }

    /// Стойкий неуспех: все попытки исчерпаны, ошибка — последняя, формат
    /// сообщения как до правки (стенды парсят «резолв … os error N»).
    #[test]
    fn retry_exhaustion_reports_last_error() {
        let (calls, lookup) = fake_lookup(usize::MAX);
        let err = resolve_system_with(
            &lookup,
            "dead.example",
            80,
            &fresh_cache(),
            SystemPolicy::quick(),
        )
        .unwrap_err();
        assert!(err.starts_with("резолв dead.example:"), "формат: {err}");
        assert!(err.contains("os error 11001"), "последняя ошибка: {err}");
        assert_eq!(calls_of(&calls, "dead.example"), 3, "три попытки");
    }

    /// Кэш: повторное соединение с тем же хостом не делает DNS-запрос —
    /// перезагрузка страницы (themeRefresh) переживает флэк-окно.
    #[test]
    fn cache_hit_skips_lookup() {
        let (calls, lookup) = fake_lookup(0);
        let cache = fresh_cache();
        let first = resolve_system_with(&lookup, "hot.example", 443, &cache, SystemPolicy::quick())
            .unwrap();
        let second =
            resolve_system_with(&lookup, "hot.example", 443, &cache, SystemPolicy::quick())
                .unwrap();
        assert_eq!(first, second);
        assert_eq!(calls_of(&calls, "hot.example"), 1, "второй вызов — из кэша");
    }

    /// Кэш хранит имя без порта: тот же хост на другом порту — тот же IP.
    #[test]
    fn cache_entry_applies_requested_port() {
        let (calls, lookup) = fake_lookup(0);
        let cache = fresh_cache();
        resolve_system_with(&lookup, "hot.example", 443, &cache, SystemPolicy::quick()).unwrap();
        let http =
            resolve_system_with(&lookup, "hot.example", 80, &cache, SystemPolicy::quick()).unwrap();
        assert_eq!(http.port(), 80);
        assert_eq!(http.ip(), IpAddr::from([93, 184, 216, 34]));
        assert_eq!(calls_of(&calls, "hot.example"), 1);
    }

    /// TTL: протухшая запись не подаётся, имя резолвится заново.
    #[test]
    fn cache_expires_after_ttl() {
        let (calls, lookup) = fake_lookup(0);
        let cache = fresh_cache();
        let mut policy = SystemPolicy::quick();
        policy.ttl = Duration::from_millis(30);
        resolve_system_with(&lookup, "ttl.example", 443, &cache, policy).unwrap();
        std::thread::sleep(Duration::from_millis(60));
        resolve_system_with(&lookup, "ttl.example", 443, &cache, policy).unwrap();
        assert_eq!(
            calls_of(&calls, "ttl.example"),
            2,
            "после TTL — новый резолв"
        );
    }

    /// Неуспех не кэшируется: следующий вызов снова пытается (флэк-окно
    /// кончится — и резолв пройдёт, без ожидания перезапуска приложения).
    #[test]
    fn failures_are_not_cached() {
        let (calls, lookup) = fake_lookup(usize::MAX);
        let cache = fresh_cache();
        let policy = SystemPolicy::quick();
        assert!(resolve_system_with(&lookup, "flaky.example", 80, &cache, policy).is_err());
        assert!(resolve_system_with(&lookup, "flaky.example", 80, &cache, policy).is_err());
        assert_eq!(
            calls_of(&calls, "flaky.example"),
            6,
            "по 3 попытки на вызов"
        );
    }

    /// Переполнение каталога — сброс (кэш, а не таблица: жертва — самый
    /// старый контент неважно какой, лишь бы память была ограничена).
    #[test]
    fn cache_overflow_clears_all() {
        let (calls, lookup) = fake_lookup(0);
        let cache = fresh_cache();
        let mut policy = SystemPolicy::quick();
        policy.limit = 2;
        for host in ["a.example", "b.example", "c.example"] {
            resolve_system_with(&lookup, host, 80, &cache, policy).unwrap();
        }
        resolve_system_with(&lookup, "a.example", 80, &cache, policy).unwrap();
        assert_eq!(calls_of(&calls, "a.example"), 2, "a вытеснен сбросом при c");
    }

    /// IP-литерал: без DNS-запроса и без записи в кэш даже при сломанном
    /// резолвере (локальные стенды и внутренние адреса не зависят от DNS).
    #[test]
    fn ip_literal_bypasses_lookup_and_cache() {
        let (calls, lookup) = fake_lookup(usize::MAX);
        let cache = fresh_cache();
        let a = resolve_system_with(&lookup, "127.0.0.1", 8080, &cache, SystemPolicy::quick())
            .expect("литерал — без DNS");
        assert_eq!(a, SocketAddr::new(IpAddr::V4([127, 0, 0, 1].into()), 8080));
        assert!(calls.lock().unwrap().is_empty(), "резолвер не звали");
        assert!(cache.lock().unwrap().is_empty(), "в кэш не писали");
    }
}
