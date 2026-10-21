//! Loopback-стенд WireGuard для маршрутных тестов DuoPulse (задача 6.6,
//! карточка duopulse-042). Поднимает на 127.0.0.1 UDP-эндпоинт WireGuard
//! (boringtun-сервер, отвечающий последнему адресу клиента — roaming) и
//! виртуальную сеть внутри туннеля (smoltcp, medium-ip):
//!
//! ```text
//! приложение/тест ──SOCKS5-роутер── туннель ── UDP 127.0.0.1:<port>
//!                                            │ 10.66.77.1/24
//!                                            ├─ TCP :80   HTTP (файлы + /slow.bin)
//!                                            ├─ TCP :5000 echo / генератор «gen:N»
//!                                            ├─ UDP :53   DNS (*.tun → 10.66.77.1)
//!                                            └─ ICMP      echo-reply (пинг туннеля, 6.5)
//! ```
//!
//! Пакет используется дважды: cargo-тесты приложения подключают его как
//! dev-dependency (тот же сервер, что раньше жил в `wg.rs::tests`), а bin
//! `wg-stand` работает отдельным процессом в e2e-стенде `e2e/vpn` — события
//! уходят JSONL-строками в `sink` (bin печатает их в stdout, ранер читает),
//! обрыв upstream для kill-switch — убийство процесса ранером.
//!
//! Ключи детерминированы ([`key_pair`]): клиентский `.conf` для импорта в
//! приложение генерирует [`client_conf_text`].

use boringtun::noise::{Tunn, TunnResult};
use boringtun::x25519;
use smoltcp::iface::{Config as IfaceConfig, Interface, SocketHandle, SocketSet};
use smoltcp::phy::{self, Device, DeviceCapabilities, Medium};
use smoltcp::socket::tcp::{Socket as TcpSocket, SocketBuffer as TcpBuffer, State as TcpState};
use smoltcp::socket::udp::{PacketBuffer as UdpBuffer, PacketMetadata, Socket as UdpSocket};
use smoltcp::time::Instant as SmolInstant;
use smoltcp::wire::{HardwareAddress, IpAddress, IpCidr};
use std::collections::{HashMap, VecDeque};
use std::net::{Ipv4Addr, SocketAddr, UdpSocket as StdUdp};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Внутренний MTU (как у клиента wg.rs: 1500 − 80).
const WG_MTU: u16 = 1420;
/// Буферы TCP-сокета стека (на соединение, приём и передача).
const TCP_BUF: usize = 128 * 1024;
/// Буфер UDP-сокета DNS.
const UDP_BUF: usize = 4096;
/// Ритм цикла нити сервера (как у клиента; короткий — низкий RTT).
const TICK: Duration = Duration::from_millis(2);

/// Адрес клиента в туннельной сети (из клиентского `.conf`).
pub const CLIENT_IP: Ipv4Addr = Ipv4Addr::new(10, 66, 77, 2);
/// Адрес сервера стенда в туннельной сети (DNS-ответ для `*.tun`).
pub const SERVER_IP: Ipv4Addr = Ipv4Addr::new(10, 66, 77, 1);
/// Echo/генератор («gen:N») в туннеле.
pub const ECHO_PORT: u16 = 5000;
/// HTTP-сервер стенда в туннеле (страницы, файлы, /slow.bin).
pub const HTTP_PORT: u16 = 80;
/// А-запись для имён вне зоны `.tun`: необслуживаемый адрес — соединение
/// через туннель честно откажет после резолва.
pub const DNS_ANSWER: Ipv4Addr = Ipv4Addr::new(203, 0, 113, 7);
/// `/slow.bin` без `?bytes=` отдаёт столько байт.
pub const SLOW_BYTES: usize = 32 * 1024 * 1024;
/// Пейсинг `/slow.bin`: чанк не чаще, чем раз в этот интервал (~8 МБ/с) —
/// передача длится секунды, ранер успевает оборвать её в середине
/// (kill-switch e2e).
const SLOW_PACE: Duration = Duration::from_millis(8);
const SLOW_CHUNK: usize = 64 * 1024;

/// Детерминированная пара ключей клиента и сервера (как в тестах wg.rs):
/// секреты фиксированы, .conf генерируется под открытый ключ сервера.
pub fn key_pair() -> ([u8; 32], [u8; 32], [u8; 32], [u8; 32]) {
    let client_secret = [1u8; 32];
    let server_secret = [2u8; 32];
    let client_pub =
        *x25519::PublicKey::from(&x25519::StaticSecret::from(client_secret)).as_bytes();
    let server_pub =
        *x25519::PublicKey::from(&x25519::StaticSecret::from(server_secret)).as_bytes();
    (client_pub, client_secret, server_pub, server_secret)
}

/// Клиентский `.conf` к этому серверу (импорт в приложение — `vpn.import_profile`).
pub fn client_conf_text(endpoint_port: u16) -> String {
    let (_, client_secret, server_pub, _) = key_pair();
    format!(
        "[Interface]\nPrivateKey = {}\nAddress = 10.66.77.2/24\nDNS = 10.66.77.1\n\n\
         [Peer]\nPublicKey = {}\nAllowedIPs = 0.0.0.0/0\nEndpoint = 127.0.0.1:{endpoint_port}\n\
         PersistentKeepalive = 25\n",
        b64_encode(&client_secret),
        b64_encode(&server_pub),
    )
}

fn b64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// Файл раздачи HTTP-сервера стенда (`path` — с ведущим `/`).
pub struct ServeFile {
    pub path: String,
    pub body: Arc<Vec<u8>>,
    pub content_type: String,
}

/// Пришедший HTTP-запрос (лог стенда; ранер сверяет маршруты по нему).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpHit {
    pub method: String,
    pub path: String,
    pub status: u16,
}

/// Счётчики стенда для тестов (атомики читаются из тестовой нити).
#[derive(Default)]
pub struct LoopbackStats {
    /// Внутренних IP-пакетов от клиента (включая пустые keepalive).
    pub rx_packets: AtomicU64,
    pub dns_hits: AtomicU64,
    pub tcp_connects: AtomicU64,
    /// Имена DNS-запросов в порядке прихода (что именно резолвилось туннелем).
    pub dns_queries: Mutex<Vec<String>>,
    /// HTTP-запросы (метод/путь/статус) в порядке прихода.
    pub http_requests: Mutex<Vec<HttpHit>>,
}

/// Приёмник событий стенда: готовая JSON-строка (bin печатает их в stdout
/// как JSONL; тесты обычно не передают sink).
pub type EventSink = Arc<dyn Fn(&str) + Send + Sync>;

/// Loopback-сервер WireGuard. Живёт до Drop (или до фатальной ошибки UDP —
/// тогда событие `fatal` и нить завершается).
pub struct LoopbackWgServer {
    /// Порт UDP-эндпоинта (для клиентского `.conf`).
    pub port: u16,
    pub stats: Arc<LoopbackStats>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl LoopbackWgServer {
    /// Поднять сервер; `psk` должен совпасть с клиентским (тесты psk — None).
    pub fn start(psk: Option<[u8; 32]>, http: Vec<ServeFile>, sink: Option<EventSink>) -> Self {
        let sock = StdUdp::bind("127.0.0.1:0").expect("bind udp 127.0.0.1:0");
        let _ = socket2::SockRef::from(&sock).set_recv_buffer_size(2 * 1024 * 1024);
        let _ = socket2::SockRef::from(&sock).set_send_buffer_size(2 * 1024 * 1024);
        let port = sock.local_addr().expect("local_addr").port();
        let (client_pub, _, _, server_secret) = key_pair();
        let tunn = make_tunn(&server_secret, &client_pub, &psk, None);
        let stats = Arc::new(LoopbackStats::default());
        let stop = Arc::new(AtomicBool::new(false));
        let files: HashMap<String, ServeFile> =
            http.into_iter().map(|f| (f.path.clone(), f)).collect();
        let sink = sink.unwrap_or_else(|| Arc::new(|_: &str| {}));
        let thread = std::thread::Builder::new()
            .name("wg-stand-server".into())
            .spawn({
                let stats = Arc::clone(&stats);
                let stop = Arc::clone(&stop);
                move || server_loop(sock, tunn, files, stats, stop, sink)
            })
            .expect("spawn server thread");
        LoopbackWgServer {
            port,
            stats,
            stop,
            thread: Some(thread),
        }
    }
}

impl Drop for LoopbackWgServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

// --- минимальные втулки протокола (копии из wg.rs, чтобы не тянуть app-крейт) --

fn make_tunn(
    private_key: &[u8; 32],
    peer_public: &[u8; 32],
    psk: &Option<[u8; 32]>,
    keepalive: Option<u16>,
) -> Tunn {
    Tunn::new(
        x25519::StaticSecret::from(*private_key),
        x25519::PublicKey::from(*peer_public),
        *psk,
        keepalive,
        u32::from_be_bytes([
            private_key[0] ^ peer_public[0],
            private_key[7],
            peer_public[13],
            private_key[31] ^ peer_public[1],
        ]) | 1,
        None,
    )
}

fn is_would_block(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::WouldBlock
            | std::io::ErrorKind::TimedOut
            | std::io::ErrorKind::Interrupted
    )
}

/// Шлюз default-маршрута стека (адрес подсети с хостом .1).
fn default_gateway(our: Ipv4Addr) -> Ipv4Addr {
    let o = our.octets();
    Ipv4Addr::new(o[0], o[1], o[2], 1)
}

/// Виртуальный IP-канал стека (medium-ip, без Ethernet) — как IpDevice wg.rs.
struct IpDevice {
    rx: VecDeque<Vec<u8>>,
    tx: VecDeque<Vec<u8>>,
}

struct DevRxToken(Vec<u8>);
struct DevTxToken<'a>(&'a mut VecDeque<Vec<u8>>);

impl phy::RxToken for DevRxToken {
    fn consume<R, F>(self, f: F) -> R
    where
        F: FnOnce(&[u8]) -> R,
    {
        f(&self.0)
    }
}

impl phy::TxToken for DevTxToken<'_> {
    fn consume<R, F>(self, len: usize, f: F) -> R
    where
        F: FnOnce(&mut [u8]) -> R,
    {
        let mut packet = vec![0u8; len];
        let result = f(&mut packet);
        if len > 0 {
            self.0.push_back(packet);
        }
        result
    }
}

impl Device for IpDevice {
    type RxToken<'a> = DevRxToken;
    type TxToken<'a> = DevTxToken<'a>;

    fn receive(&mut self, _t: SmolInstant) -> Option<(Self::RxToken<'_>, Self::TxToken<'_>)> {
        self.rx
            .pop_front()
            .map(|packet| (DevRxToken(packet), DevTxToken(&mut self.tx)))
    }

    fn transmit(&mut self, _t: SmolInstant) -> Option<Self::TxToken<'_>> {
        Some(DevTxToken(&mut self.tx))
    }

    fn capabilities(&self) -> DeviceCapabilities {
        let mut caps = DeviceCapabilities::default();
        caps.max_transmission_unit = WG_MTU as usize;
        caps.medium = Medium::Ip;
        caps
    }
}

// --- HTTP/DNS внутри туннеля ---------------------------------------------------

/// Серверное соединение: echo/генератор (порт 5000) или HTTP (порт 80).
struct SrvConn {
    handle: SocketHandle,
    /// Подготовленные к отправке куски (заголовок, тело).
    out: VecDeque<Vec<u8>>,
    /// Накопитель HTTP-запроса до пустой строки.
    inbuf: Vec<u8>,
    /// Порт соединения — echo (5000) или http (80).
    http: bool,
    /// Сколько байт ещё догенерировать (echo-режим «gen:N»).
    gen_left: usize,
    /// Остаток paced-потока /slow.bin и момент последнего чанка.
    slow_left: usize,
    last_slow: Option<Instant>,
    /// Ответ выстроен; FIN — когда очередь отправки опустеет.
    close_after_flush: bool,
}

impl SrvConn {
    fn new(handle: SocketHandle, http: bool) -> Self {
        SrvConn {
            handle,
            out: VecDeque::new(),
            inbuf: Vec::new(),
            http,
            gen_left: 0,
            slow_left: 0,
            last_slow: None,
            close_after_flush: false,
        }
    }
}

fn server_loop(
    sock: StdUdp,
    mut tunn: Tunn,
    files: HashMap<String, ServeFile>,
    stats: Arc<LoopbackStats>,
    stop: Arc<AtomicBool>,
    sink: EventSink,
) {
    let emit = |text: String| sink(&text);
    let mut device = IpDevice {
        rx: VecDeque::new(),
        tx: VecDeque::new(),
    };
    let mut iface = Interface::new(
        IfaceConfig::new(HardwareAddress::Ip),
        &mut device,
        SmolInstant::now(),
    );
    iface.update_ip_addrs(|addrs| {
        let _ = addrs.push(IpCidr::new(IpAddress::from(SERVER_IP), 24));
    });
    let _ = iface
        .routes_mut()
        .add_default_ipv4_route(default_gateway(SERVER_IP));

    let mut sockets = SocketSet::new(Vec::new());
    let mut echo_listeners = Vec::new();
    for _ in 0..4 {
        let mut l = TcpSocket::new(
            TcpBuffer::new(vec![0u8; TCP_BUF]),
            TcpBuffer::new(vec![0u8; TCP_BUF]),
        );
        l.listen(ECHO_PORT).expect("listen echo");
        echo_listeners.push(sockets.add(l));
    }
    let mut http_listeners = Vec::new();
    for _ in 0..8 {
        let mut l = TcpSocket::new(
            TcpBuffer::new(vec![0u8; TCP_BUF]),
            TcpBuffer::new(vec![0u8; TCP_BUF]),
        );
        l.listen(HTTP_PORT).expect("listen http");
        http_listeners.push(sockets.add(l));
    }
    let mut dns_socket = UdpSocket::new(
        UdpBuffer::new(vec![PacketMetadata::EMPTY; 4], vec![0u8; UDP_BUF]),
        UdpBuffer::new(vec![PacketMetadata::EMPTY; 4], vec![0u8; UDP_BUF]),
    );
    dns_socket.bind(53u16).expect("bind dns");
    let dns_handle = sockets.add(dns_socket);

    let mut conns: Vec<SrvConn> = Vec::new();
    let mut last_client: Option<SocketAddr> = None;
    let mut udp_buf = [0u8; 65536];
    let mut wg_buf = vec![0u8; 65536 + 96];
    sock.set_read_timeout(Some(TICK)).expect("read_timeout");

    while !stop.load(Ordering::Relaxed) {
        // UDP → decapsulate; ответы — последнему адресу клиента (roaming).
        match sock.recv_from(&mut udp_buf) {
            Ok((n, src)) => {
                if n >= 4
                    && u32::from_le_bytes([udp_buf[0], udp_buf[1], udp_buf[2], udp_buf[3]]) == 4
                {
                    stats.rx_packets.fetch_add(1, Ordering::Relaxed);
                }
                last_client = Some(src);
                let mut src_opt = Some(src.ip());
                let mut data_opt = Some(&udp_buf[..n]);
                loop {
                    let result = match data_opt.take() {
                        Some(d) => tunn.decapsulate(src_opt.take(), d, &mut wg_buf),
                        None => tunn.decapsulate(None, &[], &mut wg_buf),
                    };
                    match result {
                        TunnResult::WriteToNetwork(wg) => {
                            if let Some(peer) = last_client {
                                let _ = sock.send_to(wg, peer);
                            }
                        }
                        TunnResult::WriteToTunnelV4(pkt, _) => {
                            stats.rx_packets.fetch_add(1, Ordering::Relaxed);
                            if !pkt.is_empty() {
                                device.rx.push_back(pkt.to_vec());
                            }
                        }
                        TunnResult::Done | TunnResult::Err(_) | TunnResult::WriteToTunnelV6(..) => {
                            break
                        }
                    }
                }
            }
            Err(ref e) if is_would_block(e) => {}
            Err(e) => {
                emit(serde_json::json!({"ev": "fatal", "err": e.to_string()}).to_string());
                return;
            }
        }

        let _ = iface.poll(SmolInstant::now(), &mut device, &mut sockets);

        // Установившиеся слушатели превращаются в соединения (на освободившийся
        // слот встаёт свежий listener); echo-порт — генератор/эхо, http — раздача.
        for (listeners, is_http) in [(&mut echo_listeners, false), (&mut http_listeners, true)] {
            let mut i = 0;
            while i < listeners.len() {
                let handle = listeners[i];
                let socket = sockets.get_mut::<TcpSocket>(handle);
                if socket.state() == TcpState::Established {
                    stats.tcp_connects.fetch_add(1, Ordering::Relaxed);
                    emit(serde_json::json!({"ev": "tcp"}).to_string());
                    conns.push(SrvConn::new(handle, is_http));
                    let port = if is_http { HTTP_PORT } else { ECHO_PORT };
                    let mut l = TcpSocket::new(
                        TcpBuffer::new(vec![0u8; TCP_BUF]),
                        TcpBuffer::new(vec![0u8; TCP_BUF]),
                    );
                    l.listen(port).expect("listen");
                    listeners[i] = sockets.add(l);
                } else {
                    i += 1;
                }
            }
        }

        // Приём: echo/«gen:N» или накопление HTTP-запроса.
        let mut chunk = [0u8; 16 * 1024];
        for conn in &mut conns {
            {
                let socket = sockets.get_mut::<TcpSocket>(conn.handle);
                while socket.can_recv() {
                    match socket.recv_slice(&mut chunk) {
                        Ok(n) if n > 0 => {
                            if conn.http {
                                if conn.inbuf.len() <= 16 * 1024 {
                                    conn.inbuf.extend_from_slice(&chunk[..n]);
                                }
                            } else if conn.gen_left == 0 {
                                if let Some(rest) = chunk[..n].strip_prefix(b"gen:") {
                                    let gen: usize = std::str::from_utf8(rest)
                                        .ok()
                                        .and_then(|s| s.trim().parse().ok())
                                        .unwrap_or(0);
                                    conn.gen_left = gen;
                                } else {
                                    conn.out.push_back(chunk[..n].to_vec());
                                }
                            }
                        }
                        _ => break,
                    }
                }
            }
            if conn.http && !conn.inbuf.is_empty() {
                http_try_respond(conn, &files, &stats, &emit);
            }
        }

        // Догенерация echo-режима и paced-поток /slow.bin.
        let now = Instant::now();
        for conn in &mut conns {
            if conn.gen_left > 0 && conn.out.len() < 4 {
                let block = conn.gen_left.min(16 * 1024);
                conn.out.push_back(vec![b'A'; block]);
                conn.gen_left -= block;
            }
            if conn.slow_left > 0
                && conn.out.len() < 3
                && conn
                    .last_slow
                    .map(|t| now.duration_since(t) >= SLOW_PACE)
                    .unwrap_or(true)
            {
                let block = conn.slow_left.min(SLOW_CHUNK);
                conn.out.push_back(vec![b'V'; block]);
                conn.slow_left -= block;
                conn.last_slow = Some(now);
            }
        }

        // Отправка: всё из очереди, сколько влезает в окно.
        for conn in &mut conns {
            let socket = sockets.get_mut::<TcpSocket>(conn.handle);
            while let Some(head) = conn.out.front() {
                match socket.send_slice(head) {
                    Ok(n) if n > 0 => {
                        if n >= head.len() {
                            conn.out.pop_front();
                        } else {
                            let rest = head[n..].to_vec();
                            conn.out[0] = rest;
                            break;
                        }
                    }
                    _ => break,
                }
            }
            if conn.close_after_flush && conn.out.is_empty() && conn.slow_left == 0 {
                socket.close();
            }
        }
        conns.retain(|conn| {
            let socket = sockets.get_mut::<TcpSocket>(conn.handle);
            if socket.state() == TcpState::Closed {
                sockets.remove(conn.handle);
                false
            } else {
                true
            }
        });

        // DNS-ответчик: зона .tun → SERVER_IP (сервисы стенда), прочее —
        // DNS_ANSWER (необслуживаемый адрес: резолв есть, соединения нет).
        let dns = sockets.get_mut::<UdpSocket>(dns_handle);
        if dns.can_recv() {
            let mut buf = [0u8; UDP_BUF];
            if let Ok((n, meta)) = dns.recv_slice(&mut buf) {
                stats.dns_hits.fetch_add(1, Ordering::Relaxed);
                let name = dns_query_name(&buf[..n]).unwrap_or_default();
                stats
                    .dns_queries
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .push(name.clone());
                let answer = if name.ends_with(".tun") {
                    SERVER_IP
                } else {
                    DNS_ANSWER
                };
                emit(
                    serde_json::json!({"ev": "dns", "name": name, "answer": answer.to_string()})
                        .to_string(),
                );
                if let Some(reply) = dns_echo_reply(&buf[..n], answer) {
                    let _ = dns.send_slice(&reply, meta.endpoint);
                }
            }
        }

        // Доразгон в tx-буферах сокетов после poll — откачать сразу.
        let _ = iface.poll(SmolInstant::now(), &mut device, &mut sockets);

        // Стек → туннель.
        while let Some(packet) = device.tx.pop_front() {
            match tunn.encapsulate(&packet, &mut wg_buf) {
                TunnResult::WriteToNetwork(wg) => {
                    if let Some(peer) = last_client {
                        let _ = sock.send_to(wg, peer);
                    }
                }
                _ => break,
            }
        }
        if let TunnResult::WriteToNetwork(wg) = tunn.update_timers(&mut wg_buf) {
            if let Some(peer) = last_client {
                let _ = sock.send_to(wg, peer);
            }
        }
    }
}

/// Разобрать накопленный HTTP-запрос, как только пришла пустая строка.
fn http_try_respond(
    conn: &mut SrvConn,
    files: &HashMap<String, ServeFile>,
    stats: &Arc<LoopbackStats>,
    emit: &dyn Fn(String),
) {
    let Some(pos) = conn.inbuf.windows(4).position(|w| w == b"\r\n\r\n") else {
        return;
    };
    let head = String::from_utf8_lossy(&conn.inbuf[..pos]).into_owned();
    conn.inbuf.clear();
    let mut parts = head.split("\r\n").next().unwrap_or("").split(' ');
    let method = parts.next().unwrap_or("GET").to_string();
    let target = parts.next().unwrap_or("/").to_string();
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (target, String::new()),
    };
    http_respond(conn, files, &method, &path, &query, stats, emit);
}

/// Выстроить ответ (заголовок + план тела) по методу и пути. Неизвестный
/// путь — 404; `/slow.bin?bytes=N` — paced-поток (тело догенерирует цикл).
fn http_respond(
    conn: &mut SrvConn,
    files: &HashMap<String, ServeFile>,
    method: &str,
    path: &str,
    query: &str,
    stats: &Arc<LoopbackStats>,
    emit: &dyn Fn(String),
) {
    let mut status = 200u16;
    let content_type;
    let mut body: Option<Arc<Vec<u8>>> = None;
    let mut slow = 0usize;
    if path == "/slow.bin" {
        slow = query
            .split('&')
            .find_map(|kv| kv.strip_prefix("bytes="))
            .and_then(|v| v.parse().ok())
            .unwrap_or(SLOW_BYTES);
        content_type = "application/octet-stream".to_string();
    } else if let Some(f) = files.get(path) {
        content_type = f.content_type.clone();
        body = Some(Arc::clone(&f.body));
    } else {
        status = 404;
        content_type = "text/plain; charset=utf-8".to_string();
        body = Some(Arc::new(b"not found\n".to_vec()));
    }
    let len = body.as_ref().map_or(slow, |b| b.len());
    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\n\
         Connection: close\r\nAccept-Ranges: none\r\n\r\n",
        status,
        if status == 200 { "OK" } else { "Not Found" },
        content_type,
        len
    );
    conn.out.push_back(head.into_bytes());
    if method != "HEAD" {
        if let Some(bytes) = body {
            conn.out.push_back(bytes.to_vec());
        } else if slow > 0 {
            conn.slow_left = slow;
            conn.last_slow = None;
        }
    }
    conn.close_after_flush = true;
    stats
        .http_requests
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .push(HttpHit {
            method: method.to_string(),
            path: path.to_string(),
            status,
        });
    emit(
        serde_json::json!({"ev": "http", "method": method, "path": path, "status": status})
            .to_string(),
    );
}

/// DNS-ответ: копия вопроса + одна A-запись.
fn dns_echo_reply(query: &[u8], answer: Ipv4Addr) -> Option<Vec<u8>> {
    if query.len() < 12 {
        return None;
    }
    let q_end = skip_dns_name(query, 12).ok()? + 4;
    let mut out = query[..q_end].to_vec();
    out[2] |= 0x80; // QR=1
    out[3] &= 0xF0; // rcode 0
    out[7] = 1; // ANCOUNT
    out.extend_from_slice(&[
        0xC0, 0x0C, // имя — указатель на вопрос
        0x00, 0x01, 0x00, 0x01, // A IN
        0x00, 0x00, 0x00, 0x3C, // TTL 60
        0x00, 0x04, // RDLEN
    ]);
    out.extend_from_slice(&answer.octets());
    Some(out)
}

/// Имя из вопроса DNS-запроса (сжатие указателей в question не бывает).
fn dns_query_name(query: &[u8]) -> Option<String> {
    if query.len() < 12 {
        return None;
    }
    let mut pos = 12usize;
    let mut labels = Vec::new();
    loop {
        if pos >= query.len() {
            return None;
        }
        let len = query[pos] as usize;
        if len == 0 {
            break;
        }
        if len & 0xC0 != 0 {
            return None;
        }
        pos += 1;
        if pos + len > query.len() {
            return None;
        }
        labels.push(String::from_utf8_lossy(&query[pos..pos + len]).into_owned());
        pos += len;
    }
    Some(labels.join("."))
}

fn skip_dns_name(msg: &[u8], mut pos: usize) -> Result<usize, ()> {
    loop {
        if pos >= msg.len() {
            return Err(());
        }
        let len = msg[pos] as usize;
        if len == 0 {
            return Ok(pos + 1);
        }
        if len & 0xC0 != 0 {
            // указатель сжатия — выходим по адресу из двух байт
            if pos + 1 >= msg.len() {
                return Err(());
            }
            return Ok(pos + 2);
        }
        pos += 1 + len;
    }
}
