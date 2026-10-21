//! Локальный SOCKS5-роутер (задача 6.1, docs/02 §6.1, карточка duopulse-037).
//!
//! WebView2 постоянно направлен на `socks5://127.0.0.1:<port>` аргументами
//! окружения на старте приложения — независимо от режима; режимом управляет
//! сам роутер, поэтому тумблер прокси НЕ требует перезапуска (риск из
//! ROADMAP снят):
//!   - `Direct`   — напрямую (режим off; DNS — системный резолвер, как без
//!     роутера);
//!   - `Upstream` — через внешний прокси задачи 1.8: SOCKS5 с логином/паролем
//!     (RFC 1929) или HTTP(S) CONNECT с Proxy-Authorization. Креденшлы
//!     подставляет роутер (логин — settings.json, пароль — DPAPI): WebView2
//!     наружу их больше не отдаёт, обработчик BasicAuthenticationRequested
//!     не нужен;
//!   - `Wg` — туннель WireGuard задачи 6.2 (`vpn/wg.rs`, boringtun): TCP
//!     терминируется userspace-стеком smoltcp, IP-пакеты идут через туннель,
//!     DNS — сервером профиля тоже в туннеле (к системному резолверу
//!     туннельный маршрут не обращается).
//!
//! Split-tunnel (задача 6.3, docs/02 §6.2): политика роутера — не один
//! маршрут на всё, а режим. `Policy::Single` — один маршрут (off/global/
//! прокси, как до 6.3); `Policy::Split` — решение НА КАЖДОЕ соединение по
//! split-правилу домена (`vpn/rules.rs`): правило «tunnel» — туннель
//! (DNS — только сервером туннеля, без утечек), иначе/правило «direct» —
//! напрямую. Домен известен до резолва (Chromium шлёт ATYP=domain),
//! поэтому матчинг не требует DNS. Заблокированный домен идёт через
//! туннель, YouTube — напрямую, одновременно.
//!
//! Fail-closed / kill-switch (docs/02 §6.1): отказ маршрута `Upstream`
//! (upstream не отвечает, рукопожатие отклонено, битый конфиг) — клиенту
//! возвращается ошибка SOCKS5, соединение закрывается; в открытую трафик
//! «протекать» не может. Смена маршрута действует на новые соединения;
//! разрыв уже установленных тоннелей — kill-switch задачи 6.4 (`vpn/wg.rs`:
//! смерть туннеля — handshake старше порога — и остановка сессии закрывают
//! потоки всех соединений, клиент видит обрыв, напрямую ничего не уходит).
//!
//! DNS (docs/02 §6.1, задача 6.3 — `vpn/dns.rs`): схема socks5 заставляет
//! Chromium присылать домен неразрешённым (ATYP=domain) — резолв происходит
//! на стороне выбранного маршрута: системный резолвер в `Direct`, туннельный
//! DNS-сервер в `Wg`, удалённо — в `Upstream`; утечек DNS-запросов к
//! системному резолверу для туннельного маршрута нет.
//!
//! Граница доверия: роутер слушает только loopback и без аутентификации —
//! Chromium не принимает логин/пароль в `--proxy-server`, поэтому отличить
//! WebView2 от другого локального процесса нельзя (как у `ssh -D`); трафик
//! чужих процессов ограничен доверием самой машины пользователя.

use crate::proxy::{ProxyConfig, ProxyProto};
use crate::vpn::rules::{RuleAction, RuleStore};
use std::io::{Read, Write};
use std::net::{IpAddr, Shutdown, TcpListener, TcpStream};
use std::path::Path;
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tauri::Manager;

/// Таймаут установления соединения и рукопожатий (клиент ↔ роутер ↔ upstream).
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Потолок заголовков ответа HTTP-прокси на CONNECT.
const HTTP_HEAD_LIMIT: usize = 8 * 1024;

/// Цель CONNECT: домен остаётся строкой (резолв — на стороне маршрута).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Target {
    host: String,
    port: u16,
}

impl std::fmt::Display for Target {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{}", self.host, self.port)
    }
}

/// Маршрут одного соединения (docs/02 §6.1–6.2). В режиме split решается
/// на соединение по правилу домена (`vpn/rules.rs`, задача 6.3).
#[derive(Debug, Clone)]
pub enum Route {
    /// Напрямую (режим off, split-умолчание и правило «direct»).
    Direct,
    /// Через внешний прокси задачи 1.8. Пароль — из DPAPI, читается при
    /// смене маршрута (в конфиге не хранится).
    Upstream {
        cfg: ProxyConfig,
        password: Option<String>,
    },
    /// Через туннель WireGuard (задача 6.2): сессия `vpn/wg.rs`.
    Wg { session: crate::vpn::wg::WgSession },
}

/// Политика роутера: как выбирать маршрут для соединения (задача 6.3,
/// docs/02 §6.2 — режимы off/global/split).
#[derive(Clone)]
pub enum Policy {
    /// Один маршрут на весь трафик: off → Direct, global-туннель → Wg,
    /// внешний прокси → Upstream (поведение задач 6.1/6.2).
    Single(Route),
    /// Split: правило домена «tunnel» — через туннель, остальное (и правило
    /// «direct») — напрямую. Правила — общий стор с IPC (`vpn/rules.rs`):
    /// правка действует на новые соединения сразу, без перезапуска.
    Split {
        session: crate::vpn::wg::WgSession,
        rules: RuleStore,
    },
}

impl Policy {
    /// Доминирующий маршрут для статуса IPC: split — это туннель (часть
    /// соединений идёт напрямую, но режим задаёт туннель).
    fn dominant_route(&self) -> Route {
        match self {
            Self::Single(route) => route.clone(),
            Self::Split { session, .. } => Route::Wg {
                session: session.clone(),
            },
        }
    }
}

/// Запущенный роутер: слушатель живёт в своей нити до конца процесса.
/// Клонирование — это та же политика (внутри Arc), клон для управления.
#[derive(Clone)]
pub struct Router {
    port: u16,
    policy: Arc<RwLock<Policy>>,
}

impl Router {
    /// Поднять роутер на 127.0.0.1. Порт — из DUOPULSE_ROUTER_PORT (отладка/
    /// стенды) или случайный свободный. Стартовая политика — Single(Direct).
    pub fn start() -> std::io::Result<Router> {
        let port_env = std::env::var("DUOPULSE_ROUTER_PORT")
            .ok()
            .and_then(|v| v.trim().parse::<u16>().ok())
            .filter(|p| *p > 0);
        let listener = TcpListener::bind(("127.0.0.1", port_env.unwrap_or(0)))?;
        let port = listener.local_addr()?.port();
        let policy = Arc::new(RwLock::new(Policy::Single(Route::Direct)));
        let policy_loop = Arc::clone(&policy);
        std::thread::Builder::new()
            .name("vpn-router-accept".into())
            .spawn(move || accept_loop(listener, policy_loop))?;
        eprintln!("[vpn] SOCKS5-роутер слушает 127.0.0.1:{port}");
        Ok(Router { port, policy })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Доминирующий маршрут (клонирование — для тестов и статуса vpn; панель
    /// с разрезом по split — задача 6.5).
    pub fn route(&self) -> Route {
        self.policy
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .dominant_route()
    }

    /// Сменить политику на «один маршрут на всё» — действует на новые
    /// соединения, без перезапуска приложения (docs/02 §6.1). Битый
    /// включённый конфиг сознательно даёт `Upstream`: отказ будет у каждого
    /// соединения (fail-closed), но не «протечёт» в прямые соединения.
    pub fn set_route(&self, route: Route) {
        if let Ok(mut slot) = self.policy.write() {
            *slot = Policy::Single(route);
        }
    }

    /// Включить split-режим: туннель для правил «tunnel», остальное —
    /// напрямую (docs/02 §6.2). Действует на новые соединения.
    pub fn set_split(&self, session: crate::vpn::wg::WgSession, rules: RuleStore) {
        if let Ok(mut slot) = self.policy.write() {
            *slot = Policy::Split { session, rules };
        }
    }

    /// Применить к роутеру приложения сохранённый конфиг прокси (пароль —
    /// из DPAPI профиля). Вызывается на старте и при каждой смене настроек/
    /// импорте профиля. Туннель/global/split активен — конфиг только
    /// сохраняется, маршрут не трогаем (взаимная исключительность
    /// маршрутов): прокс вернётся при выключении VPN-режима (задача 6.3).
    pub fn apply_config(&self, cfg: &ProxyConfig, profile_dir: &Path) {
        {
            let guard = self.policy.read().unwrap_or_else(|p| p.into_inner());
            let tunnel_is_policy = match &*guard {
                Policy::Single(Route::Direct) | Policy::Single(Route::Upstream { .. }) => false,
                Policy::Single(Route::Wg { .. }) | Policy::Split { .. } => true,
            };
            if tunnel_is_policy {
                return;
            }
        }
        let route = if cfg.enabled {
            Route::Upstream {
                cfg: cfg.clone(),
                password: crate::proxy::load_password(profile_dir),
            }
        } else {
            Route::Direct
        };
        self.set_route(route);
    }
}

/// Применить к роутеру приложения сохранённый конфиг прокси (задача 6.1:
/// настройка действует сразу, перезапуск не нужен). Роутера нет (не поднялся
/// на старте) — тихий no-op, деградация уже зафиксирована в журнале старта.
pub fn apply_saved(app: &tauri::AppHandle, profile_dir: &Path) {
    if let Some(router) = app
        .try_state::<Option<Router>>()
        .and_then(|state| state.inner().clone())
    {
        router.apply_config(&crate::proxy::load_config(profile_dir), profile_dir);
    }
}

fn accept_loop(listener: TcpListener, policy: Arc<RwLock<Policy>>) {
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let policy = policy.read().unwrap_or_else(|p| p.into_inner()).clone();
                let _ = std::thread::Builder::new()
                    .name("vpn-router-conn".into())
                    .spawn(move || {
                        let peer = stream
                            .peer_addr()
                            .map(|a| a.to_string())
                            .unwrap_or_else(|_| "?".into());
                        if let Err(e) = serve_client(stream, &policy) {
                            eprintln!("[vpn] {peer}: {e}");
                        }
                    });
            }
            Err(e) => eprintln!("[vpn] accept: {e}"),
        }
    }
}

/// Одно клиентское соединение WebView2 → роутер (RFC 1928, только CONNECT).
fn serve_client(mut client: TcpStream, policy: &Policy) -> Result<(), String> {
    let _ = client.set_read_timeout(Some(HANDSHAKE_TIMEOUT));
    let _ = client.set_write_timeout(Some(HANDSHAKE_TIMEOUT));

    // Приветствие: роутер принимает только «без аутентификации» (loopback).
    let mut head = [0u8; 2];
    client
        .read_exact(&mut head)
        .map_err(|e| format!("приветствие: {e}"))?;
    if head[0] != 0x05 {
        return Err("клиент говорит не по SOCKS5".into());
    }
    let mut methods = vec![0u8; head[1] as usize];
    client
        .read_exact(&mut methods)
        .map_err(|e| format!("методы приветствия: {e}"))?;
    if !methods.contains(&0x00) {
        let _ = client.write_all(&[0x05, 0xFF]);
        return Err("клиент не предложил метод no-auth".into());
    }
    client
        .write_all(&[0x05, 0x00])
        .map_err(|e| format!("выбор метода: {e}"))?;

    // Запрос: VER CMD RSV ATYP ADDR PORT. Chromium использует только CONNECT.
    let mut req = [0u8; 4];
    client
        .read_exact(&mut req)
        .map_err(|e| format!("запрос: {e}"))?;
    if req[0] != 0x05 {
        return Err("запрос не SOCKS5".into());
    }
    if req[1] != 0x01 {
        reply(&mut client, 0x07)?;
        return Err(format!("команда {} не поддерживается", req[1]));
    }
    let host = match req[3] {
        0x01 => {
            let mut b = [0u8; 4];
            read_client(&mut client, &mut b)?;
            IpAddr::from(b).to_string()
        }
        0x03 => {
            let mut len = [0u8; 1];
            read_client(&mut client, &mut len)?;
            let mut name = vec![0u8; len[0] as usize];
            read_client(&mut client, &mut name)?;
            String::from_utf8_lossy(&name).into_owned()
        }
        0x04 => {
            let mut b = [0u8; 16];
            read_client(&mut client, &mut b)?;
            IpAddr::from(b).to_string()
        }
        atyp => {
            reply(&mut client, 0x08)?;
            return Err(format!("тип адреса {atyp} не поддерживается"));
        }
    };
    let mut port_be = [0u8; 2];
    read_client(&mut client, &mut port_be)?;
    let target = Target {
        host,
        port: u16::from_be_bytes(port_be),
    };

    // Маршрутизация (задача 6.3): в split-режимах решение принимается ПО
    // ДОМЕНУ на каждое соединение — до первого DNS-запроса (Chromium прислал
    // имя, а не адрес). Правило «tunnel»/режим global — туннель (DNS — только
    // сервером туннеля, vpn/dns.rs), остальное — напрямую. Любой отказ —
    // ошибка клиенту (fail-closed): в туннельных маршрутах прямой ход
    // запрещён, в Direct отказ цели — обычная ошибка сети. (preamble —
    // ранние данные тоннеля, приехавшие в одном сегменте с заголовками
    // ответа HTTP-прокси.)
    let route = match &policy {
        Policy::Single(route) => route.clone(),
        Policy::Split { session, rules } => match rules.match_action(&target.host) {
            Some(RuleAction::Tunnel) => Route::Wg {
                session: session.clone(),
            },
            // Умолчание split — напрямую; явное правило «direct» — то же
            // (docs/02 §6.2: в туннель — только заблокированные домены).
            Some(RuleAction::Direct) | None => Route::Direct,
        },
    };
    let (upstream, preamble) = match &route {
        Route::Direct => connect_direct(&target).map(|s| (Conn::Tcp(s), Vec::new())),
        Route::Upstream { cfg, password } => {
            connect_upstream(cfg, password.as_deref().unwrap_or(""), &target)
                .map(|(s, p)| (Conn::Tcp(s), p))
        }
        Route::Wg { session } => connect_wg(session, &target).map(|s| (Conn::Wg(s), Vec::new())),
    }
    .inspect_err(|e| {
        let _ = reply(&mut client, 0x01);
        eprintln!("[vpn] {target}: {e}");
    })?;

    reply(&mut client, 0x00)?;
    if !preamble.is_empty() {
        client
            .write_all(&preamble)
            .map_err(|e| format!("хвост ответа тоннеля: {e}"))?;
    }

    // Рукопожатия окончены — тоннель живёт без таймаутов (keep-alive, стримы).
    let _ = client.set_read_timeout(None);
    let _ = client.set_write_timeout(None);
    pipe(client, upstream);
    Ok(())
}

fn read_client(client: &mut TcpStream, buf: &mut [u8]) -> Result<(), String> {
    client
        .read_exact(buf)
        .map_err(|e| format!("чтение запроса: {e}"))
}

/// Ответ клиенту: VER REP RSV ATYP BND.ADDR BND.PORT — адрес привязки Chromium
/// не использует, возвращаем нули.
fn reply(client: &mut TcpStream, rep: u8) -> Result<(), String> {
    client
        .write_all(&[0x05, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
        .map_err(|e| format!("ответ клиенту: {e}"))
}

/// Режим off / split-умолчание / правило «direct»: DNS — системный резолвер
/// (vpn/dns.rs), соединение — напрямую.
fn connect_direct(target: &Target) -> Result<TcpStream, String> {
    let addr = crate::vpn::dns::Resolver::System.resolve(&target.host, target.port)?;
    TcpStream::connect_timeout(&addr, HANDSHAKE_TIMEOUT)
        .map_err(|e| format!("напрямую к {target}: {e}"))
}

/// Режим прокси: соединение с внешним прокси + рукопожатие до цели.
/// Каждый отказ — ошибка наверх (fail-closed), прямой ход исключён.
/// Возвращает поток upstream и «преамбулу» — байты данных тоннеля, которые
/// приехали вместе с заголовками ответа (их нельзя потерять).
fn connect_upstream(
    cfg: &ProxyConfig,
    password: &str,
    target: &Target,
) -> Result<(TcpStream, Vec<u8>), String> {
    cfg.validate()?;
    let login = cfg.login.as_deref().unwrap_or("");
    if login.len() > 255 || password.len() > 255 {
        return Err("логин/пароль прокси длиннее 255 байт".into());
    }
    let addr = crate::vpn::dns::Resolver::System.resolve(&cfg.host, cfg.port)?;
    let mut stream = TcpStream::connect_timeout(&addr, HANDSHAKE_TIMEOUT)
        .map_err(|e| format!("upstream {}: {e}", cfg.host))?;
    let _ = stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT));
    let _ = stream.set_write_timeout(Some(HANDSHAKE_TIMEOUT));
    let preamble = match cfg.proto {
        ProxyProto::Socks5 => {
            socks5_upstream(&mut stream, login, password, target)?;
            Vec::new()
        }
        ProxyProto::Http | ProxyProto::Https => {
            http_connect_upstream(&mut stream, login, password, target)?
        }
    };
    Ok((stream, preamble))
}

/// Рукопожатие SOCKS5 с внешним прокси (RFC 1928 + авторизация RFC 1929).
/// Цель уходит доменом (ATYP=domain) — DNS резолвит upstream.
fn socks5_upstream(
    stream: &mut TcpStream,
    login: &str,
    password: &str,
    target: &Target,
) -> Result<(), String> {
    let who = "SOCKS5 upstream";
    let use_auth = !login.is_empty() || !password.is_empty();

    let mut greeting = vec![0x05, 0x01, 0x00];
    if use_auth {
        greeting[1] = 0x02;
        greeting.push(0x02);
    }
    stream
        .write_all(&greeting)
        .map_err(|e| format!("{who}: приветствие: {e}"))?;
    let mut sel = [0u8; 2];
    stream
        .read_exact(&mut sel)
        .map_err(|e| format!("{who}: ответ на приветствие: {e}"))?;
    if sel[0] != 0x05 {
        return Err(format!("{who}: это не SOCKS5 (проверьте тип прокси)"));
    }
    match sel[1] {
        0x00 => {}
        0x02 if use_auth => {
            // RFC 1929: VER ULEN UNAME PLEN PASSWD → VER STATUS
            let mut auth = Vec::with_capacity(3 + login.len() + password.len());
            auth.push(0x01);
            auth.push(login.len() as u8);
            auth.extend_from_slice(login.as_bytes());
            auth.push(password.len() as u8);
            auth.extend_from_slice(password.as_bytes());
            stream
                .write_all(&auth)
                .map_err(|e| format!("{who}: логин/пароль: {e}"))?;
            let mut verdict = [0u8; 2];
            stream
                .read_exact(&mut verdict)
                .map_err(|e| format!("{who}: ответ логин/пароль: {e}"))?;
            if verdict[1] != 0x00 {
                return Err(format!("{who}: отклонён логин/пароль"));
            }
        }
        method => {
            return Err(format!(
                "{who}: выбрал неподдерживаемый метод аутентификации {method:#04x}"
            ));
        }
    }

    let mut req = vec![0x05, 0x01, 0x00];
    push_target(&mut req, target);
    stream
        .write_all(&req)
        .map_err(|e| format!("{who}: CONNECT {target}: {e}"))?;
    let mut head = [0u8; 4];
    stream
        .read_exact(&mut head)
        .map_err(|e| format!("{who}: ответ на CONNECT: {e}"))?;
    if head[0] != 0x05 || head[1] != 0x00 {
        return Err(format!(
            "{who}: отказал в CONNECT {target} (REP={:#04x})",
            head[1]
        ));
    }
    // Вычитываем BND.ADDR/BND.PORT ответа — значения не важны, но байты обязаны
    // уйти из потока до начала тоннеля.
    match head[3] {
        0x01 => skip_exact(stream, 6)?,
        0x04 => skip_exact(stream, 18)?,
        0x03 => {
            let mut len = [0u8; 1];
            stream
                .read_exact(&mut len)
                .map_err(|e| format!("{who}: ответ на CONNECT: {e}"))?;
            skip_exact(stream, len[0] as usize + 2)?;
        }
        atyp => return Err(format!("{who}: ответ с типом адреса {atyp}")),
    }
    Ok(())
}

/// HTTP(S)-прокси: всё через CONNECT (WebView2 говорит с роутером SOCKS5,
/// для http-целей это тоже тоннель; большинство HTTP-прокси поддерживают
/// CONNECT на любые порты). Возвращает хвост данных после заголовков ответа.
fn http_connect_upstream(
    stream: &mut TcpStream,
    login: &str,
    password: &str,
    target: &Target,
) -> Result<Vec<u8>, String> {
    let who = "HTTP upstream";
    let mut req = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n");
    if !login.is_empty() || !password.is_empty() {
        let creds = base64(format!("{login}:{password}").as_bytes());
        req.push_str(&format!("Proxy-Authorization: Basic {creds}\r\n"));
    }
    req.push_str("\r\n");
    stream
        .write_all(req.as_bytes())
        .map_err(|e| format!("{who}: CONNECT: {e}"))?;

    // Статус-строка + заголовки до пустой строки; хвост после неё — начало
    // данных тоннеля, его нельзя потерять.
    let (head, rest) = read_http_head(stream)?;
    let status = head.lines().next().unwrap_or_default().to_string();
    let code = status.split_whitespace().nth(1).unwrap_or_default();
    if !(code.len() == 3 && code.starts_with('2')) {
        return Err(format!("{who}: отказал в CONNECT {target}: {status}"));
    }
    Ok(rest)
}

/// Читает заголовки ответа до `\r\n\r\n`; возвращает (заголовки, хвост).
fn read_http_head(stream: &mut TcpStream) -> Result<(String, Vec<u8>), String> {
    let mut buf = Vec::with_capacity(512);
    let mut chunk = [0u8; 512];
    loop {
        if let Some(pos) = find_head_end(&buf) {
            let rest = buf.split_off(pos + 4);
            let head = String::from_utf8_lossy(&buf).into_owned();
            return Ok((head, rest));
        }
        if buf.len() > HTTP_HEAD_LIMIT {
            return Err("заголовки HTTP-прокси сверх лимита".into());
        }
        let n = stream
            .read(&mut chunk)
            .map_err(|e| format!("чтение ответа HTTP-прокси: {e}"))?;
        if n == 0 {
            return Err("HTTP-прокс закрыл соединение до конца заголовков".into());
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

fn find_head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn skip_exact(stream: &mut TcpStream, n: usize) -> Result<(), String> {
    let mut skip = vec![0u8; n];
    stream
        .read_exact(&mut skip)
        .map_err(|e| format!("чтение ответа: {e}"))
}

/// Адрес цели в формате запроса SOCKS5: IP — бинарно, домен — ATYP=domain.
fn push_target(req: &mut Vec<u8>, target: &Target) {
    match target.host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            req.extend_from_slice(&[0x01]);
            req.extend_from_slice(&ip.octets());
        }
        Ok(IpAddr::V6(ip)) => {
            req.extend_from_slice(&[0x04]);
            req.extend_from_slice(&ip.octets());
        }
        Err(_) => {
            req.extend_from_slice(&[0x03]);
            req.push(target.host.len() as u8);
            req.extend_from_slice(target.host.as_bytes());
        }
    }
    req.extend_from_slice(&target.port.to_be_bytes());
}

/// Поток тоннеля со стороны маршрута: системный TCP или виртуальный сокет
/// туннеля WireGuard (одинаковая блокирующая семантика Read/Write).
enum Conn {
    Tcp(TcpStream),
    Wg(crate::vpn::wg::WgStream),
}

/// Половины потока маршрута для двух нитей pipe (чтение и запись — Send).
type ConnHalfs = (Box<dyn Read + Send>, Box<dyn Write + Send>);

impl Conn {
    /// Половины чтения/записи для двух нитей pipe (обе Send). Drop записи
    /// закрывает соединение: TcpStream — целиком (shutdown клонов), Wg — FIN
    /// виртуального сокета.
    fn split(self) -> Result<ConnHalfs, String> {
        match self {
            Conn::Tcp(stream) => {
                let read = stream
                    .try_clone()
                    .map_err(|e| format!("клон потока upstream: {e}"))?;
                // Рукопожатия окончены — дальше тоннель живёт без таймаутов
                // (в connect_upstream стоял HANDSHAKE_TIMEOUT).
                let _ = read.set_read_timeout(None);
                let _ = read.set_write_timeout(None);
                let _ = stream.set_read_timeout(None);
                let _ = stream.set_write_timeout(None);
                Ok((Box::new(read), Box::new(stream)))
            }
            Conn::Wg(stream) => {
                let (read, write) = stream.split();
                Ok((Box::new(read), Box::new(write)))
            }
        }
    }
}

/// Маршрут Wg: домен резолвится DNS-сервером профиля ВНУТРИ туннеля (утечек
/// к системному резолверу нет, docs/02 §6.1; политика — vpn/dns.rs, задача
/// 6.3), затем TCP — через туннель. Любой отказ — ошибка наверх
/// (fail-closed), прямой ход исключён.
fn connect_wg(
    session: &crate::vpn::wg::WgSession,
    target: &Target,
) -> Result<crate::vpn::wg::WgStream, String> {
    let addr = crate::vpn::dns::Resolver::Tunnel(session).resolve(&target.host, target.port)?;
    session
        .tcp_connect(addr)
        .map_err(|e| format!("туннель к {target}: {e}"))
}

/// Двунаправленный тоннель: обе стороны до EOF; завершение любого направления
/// закрывает соединение целиком (shutdown клонов клиента + закрытие потока
/// маршрута), чтобы второе не висело на чтении мёртвого пира.
fn pipe(client: TcpStream, upstream: Conn) {
    let Ok((mut up_read, mut up_write)) = upstream.split() else {
        return;
    };
    let Ok(mut client_read) = client.try_clone() else {
        return;
    };
    let mut client_write = client;
    let to_upstream = std::thread::spawn(move || {
        let _ = std::io::copy(&mut client_read, &mut up_write);
        // Полузакрытие не моделируем: направление кончилось — соединение
        // закрывается (drop up_write шлёт FIN/закрытие маршруту).
    });
    let _ = std::io::copy(&mut up_read, &mut client_write);
    let _ = client_write.shutdown(Shutdown::Both); // будит и встречную нить
    drop(up_read);
    let _ = to_upstream.join();
}

/// Base64 (RFC 4648) для Proxy-Authorization — без зависимости ради 10 строк.
fn base64(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

// ---------------------------------------------------------------------------
// Тесты: поведение роутера против локальных фейков (upstream SOCKS5/HTTP,
// цель-эхо, мёртвый порт) — включая fail-closed и смену маршрута на лету.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn proxy_cfg(proto: ProxyProto, host: &str, port: u16, login: Option<&str>) -> ProxyConfig {
        ProxyConfig {
            enabled: true,
            proto,
            host: host.into(),
            port,
            login: login.map(str::to_string),
        }
    }

    /// Цель-эхо: считает попадания, отвечает эхом первой строки.
    fn echo_target() -> (u16, Arc<AtomicUsize>, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_own = Arc::clone(&hits);
        let t = std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { break };
                let hits = Arc::clone(&hits_own);
                std::thread::spawn(move || {
                    hits.fetch_add(1, Ordering::SeqCst);
                    let mut buf = [0u8; 256];
                    if let Ok(n) = s.read(&mut buf) {
                        let _ = s.write_all(&buf[..n]);
                    }
                });
            }
        });
        (port, hits, t)
    }

    /// Мёртвый порт: слушатель подняли и закрыли — соединение точно откажет.
    fn dead_port() -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    }

    /// Клиент SOCKS5: приветствие → CONNECT → REP-байт ответа; при успехе
    /// возвращает поток для обмена данными.
    fn socks5_connect(router_port: u16, host: &str, port: u16) -> Result<TcpStream, u8> {
        let mut s = TcpStream::connect(("127.0.0.1", router_port)).unwrap();
        s.set_read_timeout(Some(HANDSHAKE_TIMEOUT)).unwrap();
        s.write_all(&[0x05, 0x01, 0x00]).unwrap();
        let mut sel = [0u8; 2];
        s.read_exact(&mut sel).unwrap();
        assert_eq!(sel, [0x05, 0x00], "роутер выбирает no-auth");
        let mut req = vec![0x05, 0x01, 0x00];
        push_target(
            &mut req,
            &Target {
                host: host.into(),
                port,
            },
        );
        s.write_all(&req).unwrap();
        let mut rep = [0u8; 10];
        s.read_exact(&mut rep).unwrap();
        if rep[1] != 0x00 {
            return Err(rep[1]);
        }
        Ok(s)
    }

    /// Фейковый SOCKS5-upstream: пишет цели в лог, требует креденшалы, если
    /// заданы; тоннель всегда ведёт в echo-сервер (не в реальную цель).
    struct FakeSocks5 {
        port: u16,
        connects: Arc<std::sync::Mutex<Vec<String>>>,
        auth_fail: Arc<std::sync::atomic::AtomicBool>,
    }

    impl FakeSocks5 {
        fn start(login: &str, password: &str, reject_auth: bool) -> FakeSocks5 {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let connects = Arc::new(std::sync::Mutex::new(Vec::new()));
            let auth_fail = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let connects_own = Arc::clone(&connects);
            let auth_fail_own = Arc::clone(&auth_fail);
            let (login, password) = (login.to_string(), password.to_string());
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut s) = stream else { break };
                    let (connects, auth_fail) =
                        (Arc::clone(&connects_own), Arc::clone(&auth_fail_own));
                    let (login, password) = (login.clone(), password.clone());
                    std::thread::spawn(move || {
                        let mut head = [0u8; 2];
                        if s.read_exact(&mut head).is_err() || head[0] != 0x05 {
                            return;
                        }
                        let mut methods = vec![0u8; head[1] as usize];
                        if s.read_exact(&mut methods).is_err() {
                            return;
                        }
                        let need_auth = !login.is_empty() || !password.is_empty();
                        if need_auth && methods.contains(&0x02) {
                            let _ = s.write_all(&[0x05, 0x02]);
                            let mut auth_head = [0u8; 2];
                            if s.read_exact(&mut auth_head).is_err() || auth_head[0] != 0x01 {
                                return;
                            }
                            let mut user = vec![0u8; auth_head[1] as usize];
                            if s.read_exact(&mut user).is_err() {
                                return;
                            }
                            let mut plen = [0u8; 1];
                            if s.read_exact(&mut plen).is_err() {
                                return;
                            }
                            let mut pass = vec![0u8; plen[0] as usize];
                            if s.read_exact(&mut pass).is_err() {
                                return;
                            }
                            let ok = user == login.as_bytes() && pass == password.as_bytes();
                            auth_fail.store(!ok, Ordering::SeqCst);
                            let verdict = if reject_auth || !ok { 0x01 } else { 0x00 };
                            let _ = s.write_all(&[0x01, verdict]);
                            if verdict != 0x00 {
                                return;
                            }
                        } else {
                            let _ = s.write_all(&[0x05, 0x00]);
                        }
                        let mut req = [0u8; 4];
                        if s.read_exact(&mut req).is_err() || req[1] != 0x01 {
                            return;
                        }
                        let mut host = match req[3] {
                            0x03 => {
                                let mut len = [0u8; 1];
                                if s.read_exact(&mut len).is_err() {
                                    return;
                                }
                                let mut name = vec![0u8; len[0] as usize];
                                if s.read_exact(&mut name).is_err() {
                                    return;
                                }
                                format!("domain:{}", String::from_utf8_lossy(&name))
                            }
                            0x01 => "ipv4".to_string(),
                            0x04 => "ipv6".to_string(),
                            _ => return,
                        };
                        let _ = s.read_exact(&mut [0u8; 2]);
                        host.push_str(":port");
                        connects.lock().unwrap().push(host);
                        let _ = s.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
                        // Тоннель: строки туда-обратно, чтобы клиент что-то получил
                        let mut buf = [0u8; 256];
                        if let Ok(n) = s.read(&mut buf) {
                            let reply =
                                format!("via-socks5:{}", String::from_utf8_lossy(&buf[..n]));
                            let _ = s.write_all(reply.as_bytes());
                        }
                    });
                }
            });
            FakeSocks5 {
                port,
                connects,
                auth_fail,
            }
        }
    }

    /// Фейковый HTTP-прокси: CONNECT + опциональная проверка Basic-креденшалов;
    /// 403, если reject.
    struct FakeHttpProxy {
        port: u16,
        requests: Arc<std::sync::Mutex<Vec<String>>>,
    }

    impl FakeHttpProxy {
        fn start(reject: bool) -> FakeHttpProxy {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
            let requests_own = Arc::clone(&requests);
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut s) = stream else { break };
                    let requests = Arc::clone(&requests_own);
                    std::thread::spawn(move || {
                        let Ok((head, _rest)) = read_http_head(&mut s) else {
                            return;
                        };
                        requests.lock().unwrap().push(head);
                        if reject {
                            let _ = s.write_all(b"HTTP/1.1 403 Forbidden\r\n\r\n");
                            return;
                        }
                        let _ = s.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n");
                        let mut buf = [0u8; 256];
                        if let Ok(n) = s.read(&mut buf) {
                            let reply = format!("via-http:{}", String::from_utf8_lossy(&buf[..n]));
                            let _ = s.write_all(reply.as_bytes());
                        }
                    });
                }
            });
            FakeHttpProxy { port, requests }
        }
    }

    /// Ждать, пока цель не увидит n соединений (accept в нити цели асинхронен
    /// относительно connect в роутере).
    fn wait_hits(hits: &Arc<AtomicUsize>, n: usize) {
        for _ in 0..150 {
            if hits.load(Ordering::SeqCst) >= n {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!(
            "цель не увидела {n} соединений, hits={}",
            hits.load(Ordering::SeqCst)
        );
    }

    fn exchange(mut s: TcpStream, send: &str) -> String {
        s.write_all(send.as_bytes()).unwrap();
        s.set_read_timeout(Some(HANDSHAKE_TIMEOUT)).unwrap();
        let mut buf = [0u8; 256];
        let n = s.read(&mut buf).unwrap();
        String::from_utf8_lossy(&buf[..n]).into_owned()
    }

    #[test]
    fn direct_route_connects_and_flows() {
        let router = Router::start().unwrap();
        assert!(
            matches!(router.route(), Route::Direct),
            "стартовый маршрут — off"
        );
        let (port, hits, _t) = echo_target();

        let s = socks5_connect(router.port(), "127.0.0.1", port).expect("REP=00");
        assert_eq!(exchange(s, "ping"), "ping", "эхо через роутер (direct)");
        assert_eq!(hits.load(Ordering::SeqCst), 1, "цель получила соединение");
    }

    #[test]
    fn upstream_socks5_forwards_domain_and_data() {
        let fake = FakeSocks5::start("", "", false);
        let router = Router::start().unwrap();
        router.set_route(Route::Upstream {
            cfg: proxy_cfg(ProxyProto::Socks5, "127.0.0.1", fake.port, None),
            password: None,
        });

        let s = socks5_connect(router.port(), "example.com", 443).expect("REP=00");
        assert_eq!(
            exchange(s, "hello"),
            "via-socks5:hello",
            "данные через upstream"
        );
        let connects = fake.connects.lock().unwrap().clone();
        assert_eq!(
            connects,
            vec!["domain:example.com:port".to_string()],
            "цель ушла доменом (DNS на стороне upstream), лог: {connects:?}"
        );
    }

    #[test]
    fn upstream_socks5_sends_credentials() {
        let fake = FakeSocks5::start("user", "secret", false);
        let router = Router::start().unwrap();
        router.set_route(Route::Upstream {
            cfg: proxy_cfg(ProxyProto::Socks5, "127.0.0.1", fake.port, Some("user")),
            password: Some("secret".into()),
        });

        let s = socks5_connect(router.port(), "example.org", 80).expect("REP=00");
        assert_eq!(exchange(s, "x"), "via-socks5:x");
        assert!(
            !fake.auth_fail.load(Ordering::SeqCst),
            "креденшалы дошли верные"
        );
    }

    #[test]
    fn upstream_socks5_wrong_password_is_fail_closed() {
        let fake = FakeSocks5::start("user", "right", false);
        let router = Router::start().unwrap();
        router.set_route(Route::Upstream {
            cfg: proxy_cfg(ProxyProto::Socks5, "127.0.0.1", fake.port, Some("user")),
            password: Some("wrong".into()),
        });

        let rep = socks5_connect(router.port(), "example.org", 80).unwrap_err();
        assert_ne!(rep, 0x00, "отказ аутентификации — ошибка клиенту");
        assert!(
            fake.connects.lock().unwrap().is_empty(),
            "CONNECT к цели не ушёл"
        );
    }

    #[test]
    fn upstream_http_connect_with_basic_auth() {
        let fake = FakeHttpProxy::start(false);
        let router = Router::start().unwrap();
        router.set_route(Route::Upstream {
            cfg: proxy_cfg(ProxyProto::Http, "127.0.0.1", fake.port, Some("u1")),
            password: Some("p1".into()),
        });

        let s = socks5_connect(router.port(), "example.net", 443).expect("REP=00");
        assert_eq!(exchange(s, "q"), "via-http:q", "тоннель через HTTP-прокси");
        let reqs = fake.requests.lock().unwrap().clone();
        assert_eq!(reqs.len(), 1);
        assert!(
            reqs[0].starts_with("CONNECT example.net:443 HTTP/1.1"),
            "{}",
            reqs[0]
        );
        let expected = base64(b"u1:p1");
        assert!(
            reqs[0].contains(&format!("Proxy-Authorization: Basic {expected}")),
            "Basic-креденшалы в запросе: {}",
            reqs[0]
        );
    }

    #[test]
    fn upstream_http_403_is_fail_closed() {
        let fake = FakeHttpProxy::start(true);
        let router = Router::start().unwrap();
        router.set_route(Route::Upstream {
            cfg: proxy_cfg(ProxyProto::Http, "127.0.0.1", fake.port, None),
            password: None,
        });

        let rep = socks5_connect(router.port(), "example.net", 443).unwrap_err();
        assert_ne!(rep, 0x00, "403 от прокси — ошибка клиенту, не прямой ход");
    }

    /// Критерий карточки: отказ upstream → соединение закрывается ошибкой,
    /// напрямую к цели не идёт (kill-switch).
    #[test]
    fn fail_closed_on_dead_upstream() {
        let router = Router::start().unwrap();
        let (target_port, hits, _t) = echo_target();
        router.set_route(Route::Upstream {
            cfg: proxy_cfg(ProxyProto::Socks5, "127.0.0.1", dead_port(), None),
            password: None,
        });

        let rep = socks5_connect(router.port(), "127.0.0.1", target_port).unwrap_err();
        assert_eq!(rep, 0x01, "REP=general failure");
        assert_eq!(
            hits.load(Ordering::SeqCst),
            0,
            "напрямую к цели роутер не ходил — fail-closed"
        );
    }

    /// Смена маршрута без перезапуска (миграция инкремента A на роутер).
    #[test]
    fn mode_switches_without_restart() {
        let router = Router::start().unwrap();
        let (port, hits, _t) = echo_target();

        // off: напрямую (accept в нити цели асинхронен — ждём попадания)
        socks5_connect(router.port(), "127.0.0.1", port).expect("direct работает");
        wait_hits(&hits, 1);

        // включили битый прокси: fail-closed, мимо роутера ничего не проходит
        router.set_route(Route::Upstream {
            cfg: proxy_cfg(ProxyProto::Socks5, "127.0.0.1", dead_port(), None),
            password: None,
        });
        let rep = socks5_connect(router.port(), "127.0.0.1", port).unwrap_err();
        assert_ne!(rep, 0x00);
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(
            hits.load(Ordering::SeqCst),
            1,
            "новых прямых соединений нет"
        );

        // выключили: снова напрямую, тот же экземпляр роутера
        router.set_route(Route::Direct);
        socks5_connect(router.port(), "127.0.0.1", port).expect("direct после откл");
        wait_hits(&hits, 2);
    }

    #[test]
    fn unsupported_commands_rejected() {
        let router = Router::start().unwrap();
        let mut s = TcpStream::connect(("127.0.0.1", router.port())).unwrap();
        s.set_read_timeout(Some(HANDSHAKE_TIMEOUT)).unwrap();
        s.write_all(&[0x05, 0x01, 0x00]).unwrap();
        s.read_exact(&mut [0u8; 2]).unwrap();
        // BIND (0x02) и UDP ASSOCIATE (0x03) не нужны Chromium — отклоняем
        s.write_all(&[0x05, 0x02, 0x00, 0x01, 127, 0, 0, 1, 0, 80])
            .unwrap();
        let mut rep = [0u8; 10];
        s.read_exact(&mut rep).unwrap();
        assert_eq!(rep[1], 0x07, "command not supported");
    }

    #[test]
    fn greeting_without_no_auth_rejected() {
        let router = Router::start().unwrap();
        let mut s = TcpStream::connect(("127.0.0.1", router.port())).unwrap();
        s.set_read_timeout(Some(HANDSHAKE_TIMEOUT)).unwrap();
        s.write_all(&[0x05, 0x01, 0x02]).unwrap(); // только login/password
        let mut sel = [0u8; 2];
        s.read_exact(&mut sel).unwrap();
        assert_eq!(sel, [0x05, 0xFF], "нет приемлемого метода");
    }

    #[test]
    fn apply_config_routes_by_enabled_flag() {
        let dir = std::env::temp_dir().join(format!("duopulse-router-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let router = Router::start().unwrap();

        router.apply_config(
            &proxy_cfg(ProxyProto::Socks5, "p.example", 1080, None),
            &dir,
        );
        match router.route() {
            Route::Upstream { cfg, password } => {
                assert_eq!(cfg.host, "p.example");
                assert_eq!(password, None, "без DPAPI-blob пароля нет");
            }
            other => panic!("включённый конфиг → Upstream, получили {other:?}"),
        }

        let mut off = proxy_cfg(ProxyProto::Socks5, "p.example", 1080, None);
        off.enabled = false;
        router.apply_config(&off, &dir);
        assert!(matches!(router.route(), Route::Direct));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn base64_known_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }
}
