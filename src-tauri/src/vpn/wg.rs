//! Клиент WireGuard (задача 6.2, docs/02 §6.3-B, карточка duopulse-038).
//!
//! Userspace-реализация без TUN-драйвера и прав администратора: `boringtun`
//! делает Noise IK handshake и ChaCha20-Poly1305-шифрование пакетов, а
//! TCP/IP-стек `smoltcp` (medium-ip, без Ethernet) терминирует соединения
//! роутера в виртуальных сокетах — их IP-пакеты ходят через туннель:
//!
//! ```text
//! роутер (SOCKS5) ──TCP── smoltcp-стек ──IP── boringtun ──UDP── сервер WG
//! ```
//!
//! Изоляция (риск ROADMAP «план Б — системный WireGuard/Wintun»): реализация
//! живёт в этом модуле, наружу — только [`WgSession`] (connect/resolve/status)
//! и хранилище профилей; смена реализации не трогает ни роутер (маршрут
//! `Route::Wg` зовёт те же методы), ни IPC-контракт.
//!
//! Приватный ключ — сразу в DPAPI (`vpn/wg/<id>.bin`, docs/02 §9): в
//! `wg-profiles.json` остаются только открытые поля профиля.
//!
//! DNS без утечек (docs/02 §6.1): резолв имён для туннельного маршрута идёт
//! DNS-сервером из `.conf` через UDP-сокет smoltcp, т.е. внутри туннеля —
//! системный резолвер не участвует. Endpoint самого сервера WG резолвится
//! системно (до туннеля другого пути нет, как у любого WG-клиента).
//!
//! Roaming (карточка): смена сети/адреса — [`WgSession::network_changed`]:
//! UDP-сокет и сессия пересоздаются, handshake уходит заново; сервер
//! WireGuard принимает клиента с любого адреса, established TCP-соединения
//! стека переживают переход (изменился только подстилающий путь). Keepalive
//! и rekey по расписанию протокола гонит `Tunn::update_timers`.
//!
//! Kill-switch (задача 6.4, docs/02 §6.1): handshake старше `dead_after`
//! (по умолчанию REJECT_AFTER_TIME протокола — 180 с: ключи сессии истекли,
//! данные уже не дойдут) — туннель считается мёртвым: установленные
//! соединения закрываются (EOF роутеру — страница видит обрыв, а не вечную
//! загрузку на ретрансмиссиях), новые TCP/DNS отказывают сразу. Напрямую,
//! мимо туннеля, ничего не уходит — маршрут остаётся за роутером, уходить
//! в открытую ему запрещает fail-closed (docs/02 §6.1). Выключение/смена
//! маршрута (`shutdown` в bridge) рвёт установленные соединения тем же
//! образом. Переходы состояния (включая «мёртв» и выключение) уходят
//! событием `vpn:state_changed` (docs/05 §2).

use boringtun::noise::{Tunn, TunnResult};
use boringtun::x25519;
use smoltcp::iface::{Config as IfaceConfig, Interface, SocketHandle, SocketSet};
use smoltcp::phy::{self, Device, DeviceCapabilities, Medium};
use smoltcp::socket::icmp::{
    Endpoint as IcmpEndpoint, PacketBuffer as IcmpBuffer, PacketMetadata as IcmpPacketMetadata,
    Socket as IcmpSocket,
};
use smoltcp::socket::tcp::{Socket as TcpSocket, SocketBuffer as TcpBuffer, State as TcpState};
use smoltcp::socket::udp::{PacketBuffer as UdpBuffer, PacketMetadata, Socket as UdpSocket};
use smoltcp::time::Instant as SmolInstant;
use smoltcp::wire::{HardwareAddress, IpAddress, IpCidr, IpEndpoint, IpListenEndpoint};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, ToSocketAddrs, UdpSocket as StdUdp};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Внутренний MTU туннеля (WireGuard для IPv4-underlay: 1500 − 80).
const WG_MTU: u16 = 1420;
/// Буферы TCP-сокета стека (на соединение, приём и передача).
const TCP_BUF: usize = 128 * 1024;
/// Буфер одного UDP-сокета (DNS-запросы).
const UDP_BUF: usize = 4096;
/// Ритм цикла нити туннеля: блокирующее ожидание UDP между итерациями.
/// Короткий (2 мс): RTT виртуального TCP складывается из тактов клиента и
/// сервера, а окно TCP ограничено буфером — длинный такт режет пропускную
/// способность (замер 25 мс давал ~9 Мбит/с, 2 мс — сотни).
const TICK: Duration = Duration::from_millis(2);
/// Handshake считается живым, пока последний был не старше (REJECT_AFTER_TIME
/// − запас; rekey инициируется раньше — 120 с — update_timers).
const HANDSHAKE_FRESH: Duration = Duration::from_secs(150);
/// Порог мёртвого туннеля для kill-switch (задача 6.4): handshake старше
/// REJECT_AFTER_TIME протокола (180 с) гарантированно мёртв — ключи сессии
/// истекли, данные не дойдут и сервер их отбросит. До порога молчание
/// двусмысленно (роуминг/rekey), established-соединения живут.
const TUNNEL_DEAD_AFTER: Duration = Duration::from_secs(180);
/// Деталь состояния kill-switch: устанавливается в WgLiveStatus и уходит
/// в отказах новых соединений, пока туннель мёртв.
const KILL_SWITCH_DETAIL: &str =
    "kill-switch: туннель мёртв — соединения закрыты, напрямую не уходим";

/// Порог мёртвости сессии: DUOPULSE_WG_DEAD_MS (диагностика/стенды; минимум
/// 1 с — Protect от опечатки, мгновенный kill глушил бы здоровый туннель),
/// иначе протокольный [`TUNNEL_DEAD_AFTER`]. Читается один раз на сессию.
pub fn tunnel_dead_after() -> Duration {
    std::env::var("DUOPULSE_WG_DEAD_MS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|ms| *ms >= 1000)
        .map(Duration::from_millis)
        .unwrap_or(TUNNEL_DEAD_AFTER)
}
/// Таймаут открытия TCP/DNS через туннель (клиентская сторона).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Кэш резолва endpoint сервера (адрес до туннеля меняется редко).
const ENDPOINT_TTL: Duration = Duration::from_secs(30);
/// Потолок пакетов в очереди «туннель → стек» между poll (защита памяти;
/// лишнее отбрасывается — внутренний TCP ретранслирует).
const DEVICE_RX_LIMIT: usize = 512;
/// Пакетов из стека в туннель за одну итерацию цикла (иначе один стрим
/// занимает нить, а остальные голодают).
const TX_BATCH: usize = 128;
/// UDP-датаграмм, вычитываемых за одну итерацию (батч сопоставим с пачками
/// сегментов TCP-окна).
const RX_BATCH: usize = 256;
/// Ритм ICMP-пинга туннеля (статистика задачи 6.5): echo DNS-серверу профиля
/// — он всегда внутри туннеля, RTT честный «до сервера через туннель».
const PING_EVERY: Duration = Duration::from_secs(1);
/// Столько ждём echo-ответ; дольше — ping_ms=None (не показываем старое
/// число, сервер может не отвечать на ICMP).
const PING_TIMEOUT: Duration = Duration::from_secs(3);
/// ICMP-идентификатор нашей пары echo request/reply (фильтр входящих
/// smoltcp; чексумму smoltcp считает сам на отправке).
const PING_IDENT: u16 = 0x0D0D;
/// Ритм события vpn:stats (задача 6.5): панель VPN ведёт rx/tx и ping без
/// опроса; между эмитами числа могут летать, интерфейс не топит.
const STATS_EVERY: Duration = Duration::from_millis(1000);

// ---------------------------------------------------------------------------
// Base64 (RFC 4648): ключи .conf и идентификаторы профилей.
// ---------------------------------------------------------------------------

fn b64_decode(src: &str) -> Result<Vec<u8>, String> {
    const ERR: &str = "не base64";
    let val = |c: u8| -> Result<u32, String> {
        match c {
            b'A'..=b'Z' => Ok(u32::from(c - b'A')),
            b'a'..=b'z' => Ok(u32::from(c - b'a') + 26),
            b'0'..=b'9' => Ok(u32::from(c - b'0') + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err(ERR.into()),
        }
    };
    let bytes = src.as_bytes();
    let pad = bytes.iter().filter(|&&b| b == b'=').count();
    if pad > 2 || !bytes.len().is_multiple_of(4) || bytes[..bytes.len() - pad].contains(&b'=') {
        return Err(ERR.into());
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks(4) {
        let (c2, c3) = (chunk[2] != b'=', chunk[3] != b'=');
        let n = (val(chunk[0])? << 18)
            | (val(chunk[1])? << 12)
            | ((if c2 { val(chunk[2])? } else { 0 }) << 6)
            | if c3 { val(chunk[3])? } else { 0 };
        out.push((n >> 16) as u8);
        if c2 {
            out.push((n >> 8) as u8);
        }
        if c3 {
            out.push(n as u8);
        }
    }
    Ok(out)
}

fn b64_encode(data: &[u8]) -> String {
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

/// Ключ x25519 в base64 (44 символа с padding) → 32 байта.
fn key_from_b64(src: &str) -> Result<[u8; 32], String> {
    let v = b64_decode(src.trim())?;
    let got = v.len();
    v.try_into()
        .map_err(|_| format!("ключ должен быть 32 байта, получилось {got}"))
}

// ---------------------------------------------------------------------------
// Парсер .conf (формат wg-quick: [Interface]/[Peer]).
// ---------------------------------------------------------------------------

/// Разобранный профиль из файла `.conf`.
#[derive(Debug, Clone, PartialEq)]
pub struct WgConf {
    /// Имя профиля — имя файла без расширения.
    pub name: String,
    pub private_key: [u8; 32],
    pub preshared_key: Option<[u8; 32]>,
    pub peer_public_key: [u8; 32],
    pub endpoint_host: String,
    pub endpoint_port: u16,
    /// Наш адрес в туннеле (первый IPv4 из Address).
    pub address: Ipv4Addr,
    pub prefix: u8,
    /// DNS-серверы из .conf (IPv4 — стек proto-ipv4).
    pub dns: Vec<Ipv4Addr>,
    pub keepalive: Option<u16>,
    pub listen_port: Option<u16>,
    /// AllowedIPs пира — сохраняются для информации (весь трафик стека и так
    /// идёт в туннель; split-правила — задача 6.3).
    pub allowed_ips: Vec<String>,
}

impl WgConf {
    /// Идентификатор профиля: детерминирован по публичному ключу пира —
    /// повторный импорт того же файла обновляет профиль, а не плодит копии.
    pub fn profile_id(&self) -> String {
        b64_encode(&self.peer_public_key)
            .replace(['+', '/', '='], "")
            .chars()
            .take(10)
            .collect()
    }
}

/// Разобрать текст `.conf`. Снисходителен к пробелам и порядку ключей;
/// несколько `[Peer]` — берётся первый (клиент с одним пиром).
pub fn parse_conf(text: &str, file_name: &str) -> Result<WgConf, String> {
    let mut section = "";
    let (mut private_key, mut preshared_key, mut peer_public) = (None, None, None);
    let (mut endpoint, mut addresses, mut dns, mut keepalive) =
        (None, Vec::new(), Vec::new(), None);
    let (mut listen_port, mut allowed_ips, mut peers_seen) = (None, Vec::new(), 0usize);

    for (n, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') {
            let close = line
                .find(']')
                .ok_or_else(|| format!("строка {}: секция без ]", n + 1))?;
            let name = line[1..close].trim();
            if name.eq_ignore_ascii_case("interface") {
                section = "interface";
            } else if name.eq_ignore_ascii_case("peer") {
                peers_seen += 1;
                section = "peer";
            } else {
                return Err(format!("строка {}: неизвестная секция [{name}]", n + 1));
            }
            continue;
        }
        let (key, value) = line
            .split_once('=')
            .ok_or_else(|| format!("строка {}: ожидалось Ключ = Значение", n + 1))?;
        let (key, value) = (key.trim(), value.trim());
        // Значения только первого [Peer] — остальные игнорируются.
        let in_first_peer = section == "peer" && peers_seen == 1;
        match (section, key.to_ascii_lowercase().as_str()) {
            ("interface", "privatekey") => {
                private_key = Some(key_from_b64(value).map_err(|e| format!("PrivateKey: {e}"))?)
            }
            ("interface", "address") => addresses = value.split(',').map(str::trim).collect(),
            ("interface", "dns") => dns = value.split(',').map(str::trim).collect(),
            ("interface", "listenport") => {
                listen_port = Some(value.parse().map_err(|_| "ListenPort: не число")?)
            }
            // MTU/SaveConfig/Table/PostUp… — на сессию не влияют.
            ("interface", _) => {}
            ("peer", "publickey") if in_first_peer => {
                peer_public = Some(key_from_b64(value).map_err(|e| format!("PublicKey: {e}"))?)
            }
            ("peer", "presharedkey") if in_first_peer => {
                preshared_key = Some(key_from_b64(value).map_err(|e| format!("PresharedKey: {e}"))?)
            }
            ("peer", "endpoint") if in_first_peer => endpoint = Some(value.to_string()),
            ("peer", "allowedips") if in_first_peer => {
                allowed_ips = value
                    .split(',')
                    .map(str::trim)
                    .map(str::to_string)
                    .collect()
            }
            ("peer", "persistentkeepalive") if in_first_peer => {
                // 0 = «off» по wg-quick
                let v: u16 = value.parse().map_err(|_| "PersistentKeepalive: не число")?;
                keepalive = (v > 0).then_some(v);
            }
            ("peer", _) => {}
            _ => return Err(format!("строка {}: ключ {key} вне секции", n + 1)),
        }
    }

    let private_key = private_key.ok_or("нет PrivateKey в [Interface]")?;
    let peer_public = peer_public.ok_or("нет [Peer] PublicKey")?;
    let endpoint = endpoint.ok_or("нет [Peer] Endpoint")?;
    let (endpoint_host, endpoint_port) = endpoint
        .rsplit_once(':')
        .ok_or_else(|| format!("Endpoint «{endpoint}» без порта"))?;
    let endpoint_port: u16 = endpoint_port
        .parse()
        .map_err(|_| "Endpoint: порт не число")?;
    if endpoint_port == 0 {
        return Err("Endpoint: порт 0".into());
    }

    // Address: берём первый IPv4 (IPv6-only конфиги не поддержаны — стек
    // proto-ipv4; v1-ограничение, отражено в docs).
    let mut address = None;
    let mut prefix = 32u8;
    for a in &addresses {
        if let Some((ip, p)) = a.split_once('/') {
            if let Ok(ip) = ip.parse::<Ipv4Addr>() {
                if address.is_none() {
                    address = Some(ip);
                    prefix = p.parse().map_err(|_| "Address: префикс не число")?;
                }
            }
        } else if let Ok(ip) = a.parse::<Ipv4Addr>() {
            if address.is_none() {
                address = Some(ip);
                prefix = 32;
            }
        }
    }
    let address = address.ok_or("Address: нужен IPv4-адрес интерфейса (IPv6-only не поддержан)")?;
    if prefix > 32 {
        return Err("Address: префикс больше 32".into());
    }

    let mut dns_v4 = Vec::new();
    for d in dns {
        match d.parse::<Ipv4Addr>() {
            Ok(ip) => dns_v4.push(ip),
            Err(_) => return Err(format!("DNS: «{d}» не IPv4-адрес")),
        }
    }

    Ok(WgConf {
        name: Path::new(file_name)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| file_name.to_string()),
        private_key,
        preshared_key,
        peer_public_key: peer_public,
        endpoint_host: endpoint_host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_string(),
        endpoint_port,
        address,
        prefix,
        dns: dns_v4,
        keepalive,
        listen_port,
        allowed_ips,
    })
}

// ---------------------------------------------------------------------------
// Хранилище профилей: wg-profiles.json (открытые поля) + DPAPI (ключи).
// ---------------------------------------------------------------------------

/// Профиль в `wg-profiles.json`. Приватный и предварительный ключи сюда НЕ
/// пишутся — они в DPAPI-blob `vpn/wg/<id>.bin`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WgProfile {
    pub id: String,
    pub name: String,
    pub endpoint_host: String,
    pub endpoint_port: u16,
    /// Публичный ключ пира, base64.
    pub peer_public_key: String,
    pub address: Ipv4Addr,
    pub prefix: u8,
    #[serde(default)]
    pub dns: Vec<Ipv4Addr>,
    #[serde(default)]
    pub keepalive: Option<u16>,
    /// Локальный UDP-порт клиента (ListenPort .conf; None — ephemeral).
    #[serde(default)]
    pub listen_port: Option<u16>,
    #[serde(default)]
    pub allowed_ips: Vec<String>,
    /// Unix-ms импорта.
    pub imported_at: i64,
}

/// Корень wg-profiles.json: версия формата + список + активный профиль
/// (Some → туннель поднимается на старте).
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
struct WgProfilesFile {
    #[serde(default)]
    wg_profiles: u32,
    #[serde(default)]
    profiles: Vec<WgProfile>,
    #[serde(default)]
    active: Option<String>,
}

fn profiles_path(dir: &Path) -> PathBuf {
    dir.join("wg-profiles.json")
}

fn key_path(dir: &Path, id: &str) -> PathBuf {
    dir.join("vpn").join("wg").join(format!("{id}.bin"))
}

fn load_profiles_file(dir: &Path) -> WgProfilesFile {
    std::fs::read_to_string(profiles_path(dir))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_profiles_file(dir: &Path, file: &WgProfilesFile) -> Result<(), String> {
    let path = profiles_path(dir);
    std::fs::create_dir_all(dir).map_err(|e| format!("создать {dir:?}: {e}"))?;
    let json = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("записать {}: {e}", path.display()))
}

/// Импорт `.conf`-файла: текст → профиль (id по ключу пира, повторный импорт
/// обновляет), приватный и предварительный ключи — в DPAPI. Возвращает профиль.
pub fn import_profile(dir: &Path, text: &str, file_name: &str) -> Result<WgProfile, String> {
    let conf = parse_conf(text, file_name)?;
    let id = conf.profile_id();

    // Секреты: один DPAPI-blob JSON-строкой — приватный ключ + PSK.
    let mut secrets = serde_json::json!({ "privateKey": b64_encode(&conf.private_key) });
    if let Some(psk) = &conf.preshared_key {
        secrets["presharedKey"] = serde_json::Value::String(b64_encode(psk));
    }
    crate::secrets::save(&key_path(dir, &id), &secrets.to_string())?;

    let profile = WgProfile {
        id,
        name: conf.name,
        endpoint_host: conf.endpoint_host,
        endpoint_port: conf.endpoint_port,
        peer_public_key: b64_encode(&conf.peer_public_key),
        address: conf.address,
        prefix: conf.prefix,
        dns: conf.dns,
        keepalive: conf.keepalive,
        listen_port: conf.listen_port,
        allowed_ips: conf.allowed_ips,
        imported_at: now_ms(),
    };
    let mut file = load_profiles_file(dir);
    file.wg_profiles = 1;
    match file.profiles.iter_mut().find(|p| p.id == profile.id) {
        Some(slot) => *slot = profile.clone(), // upsert: тот же пир
        None => file.profiles.push(profile.clone()),
    }
    save_profiles_file(dir, &file)?;
    Ok(profile)
}

/// Секреты профиля из DPAPI: (приватный ключ, PSK). None — blob нет/битый.
fn load_keys(dir: &Path, id: &str) -> Option<([u8; 32], Option<[u8; 32]>)> {
    let raw = crate::secrets::load(&key_path(dir, id))?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let private_key = key_from_b64(v.get("privateKey")?.as_str()?).ok()?;
    let psk = v
        .get("presharedKey")
        .and_then(|s| s.as_str())
        .and_then(|s| key_from_b64(s).ok());
    Some((private_key, psk))
}

/// Список профилей (порядок импорта).
pub fn list_profiles(dir: &Path) -> Vec<WgProfile> {
    load_profiles_file(dir).profiles
}

/// Активный профиль + его секреты: то, что поднимается в туннель.
pub fn active_profile(dir: &Path) -> Option<(WgProfile, [u8; 32], Option<[u8; 32]>)> {
    let file = load_profiles_file(dir);
    let id = file.active?;
    let profile = file.profiles.into_iter().find(|p| p.id == id)?;
    let (private_key, psk) = load_keys(dir, &id)?;
    Some((profile, private_key, psk))
}

/// Id активного профиля (без чтения секретов — спискам/удалению хватает).
pub fn active_id(dir: &Path) -> Option<String> {
    load_profiles_file(dir).active
}

/// Профиль по id + секреты из DPAPI (поднятие туннеля по явному выбору).
pub fn profile_with_keys(dir: &Path, id: &str) -> Option<(WgProfile, [u8; 32], Option<[u8; 32]>)> {
    let profile = load_profiles_file(dir)
        .profiles
        .into_iter()
        .find(|p| p.id == id)?;
    let (private_key, psk) = load_keys(dir, id)?;
    Some((profile, private_key, psk))
}

/// Сделать профиль активным (None — выключить туннель).
pub fn set_active(dir: &Path, id: Option<&str>) -> Result<(), String> {
    let mut file = load_profiles_file(dir);
    if let Some(id) = id {
        if !file.profiles.iter().any(|p| p.id == id) {
            return Err(format!("профиль {id} не найден"));
        }
    }
    file.active = id.map(str::to_string);
    save_profiles_file(dir, &file)
}

/// Удалить профиль и его секрет (идемпотентно). Возвращает, был ли профиль.
pub fn remove_profile(dir: &Path, id: &str) -> Result<bool, String> {
    let mut file = load_profiles_file(dir);
    let before = file.profiles.len();
    file.profiles.retain(|p| p.id != id);
    let removed = file.profiles.len() < before;
    if file.active.as_deref() == Some(id) {
        file.active = None;
    }
    save_profiles_file(dir, &file)?;
    crate::secrets::clear(&key_path(dir, id));
    Ok(removed)
}

// ---------------------------------------------------------------------------
// Сессия: ручка клиента + нить туннеля.
// ---------------------------------------------------------------------------

/// Живое состояние туннеля (пополняет нить, читает статус IPC).
#[derive(Debug, Clone, PartialEq)]
pub struct WgLiveStatus {
    /// Connecting — handshake не завершён/рестарт; Connected — туннель жив;
    /// Error — фатально на последней попытке (нить продолжает ретраи).
    pub state: WgLiveState,
    pub detail: String,
    pub endpoint: String,
    /// Сколько мс назад был последний handshake (None — не было).
    pub last_handshake_ms: Option<u64>,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    /// RTT ICMP-эхом до DNS-сервера профиля через туннель (задача 6.5;
    /// None — ответа нет дольше [`PING_TIMEOUT`] или сервер не отвечает).
    pub ping_ms: Option<u64>,
    /// Unix-ms запуска сессии.
    pub since_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WgLiveState {
    Connecting,
    Connected,
    Error,
}

impl WgLiveState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Connecting => "connecting",
            Self::Connected => "connected",
            Self::Error => "error",
        }
    }
}

/// Команды в нить туннеля. Канал bounded: `send` данных соединений
/// блокируется при переполнении — это и есть backpressure TCP.
enum Cmd {
    /// Открыть TCP-соединение через туннель.
    TcpConnect {
        dst: SocketAddrV4,
        reply: SyncSender<Result<WgStreamHalfs, String>>,
    },
    /// Резолв имени DNS-сервером туннеля (UDP внутри стека).
    Resolve {
        host: String,
        reply: SyncSender<Result<Ipv4Addr, String>>,
    },
    StreamData(u32, Vec<u8>),
    StreamClose(u32),
    /// Смена сети/адреса: пересоздать сокет и сессию, handshake заново.
    NetworkChanged,
    /// Подписчик статистики (vpn:stats, задача 6.5) — после старта сессии.
    StatsSink(OnStatsChange),
    Shutdown,
}

/// Поток соединения для роутера. Половины работают независимо (нить чтения и
/// нить записи pipe): ReadHalf блокируется до данных/EOF, WriteHalf кладёт
/// данные в bounded-канал нити туннеля. Drop обеих половин закрывает сокет.
/// Будильник нити туннеля: recv_from с таймаутом на Windows просыпается по
/// системному тику (~15,6 мс) — данные из канала команд ждали бы его. Wake —
/// однобайтовая датаграмма в СОБСТВЕННЫЙ сокет: приход датаграммы (не таймер)
/// будит мгновенно. Адрес живёт под RwLock: roaming пересоздаёт сокет.
#[derive(Clone)]
struct WgWake {
    sock: Arc<StdUdp>,
    addr: Arc<std::sync::RwLock<SocketAddr>>,
}

impl WgWake {
    fn ping(&self) {
        let addr = *self.addr.read().unwrap_or_else(|p| p.into_inner());
        let _ = self.sock.send_to(&[WAKE_BYTE], addr);
    }
}

/// Маркер wake-датаграммы (реальные пакеты WireGuard крупнее и с MAC —
/// перепутать нельзя).
const WAKE_BYTE: u8 = 0xFF;

pub struct WgStream {
    id: u32,
    to_thread: SyncSender<Cmd>,
    wake: WgWake,
    from_thread: Arc<Mutex<Receiver<Vec<u8>>>>,
}

impl WgStream {
    /// Разделить поток на половины чтения/записи (обе — Send, для двух нитей
    /// pipe роутера). Drop WriteHalf закрывает соединение в туннеле.
    pub fn split(self) -> (WgReadHalf, WgWriteHalf) {
        let WgStream {
            id,
            to_thread,
            wake,
            from_thread,
        } = self;
        (
            WgReadHalf {
                from_thread,
                leftover: Vec::new(),
            },
            WgWriteHalf {
                id,
                to_thread,
                wake,
            },
        )
    }
}

/// Результат TcpConnect: поток и его id (нулевые половины собирает caller).
pub struct WgStreamHalfs {
    pub stream: WgStream,
}

pub struct WgReadHalf {
    from_thread: Arc<Mutex<Receiver<Vec<u8>>>>,
    leftover: Vec<u8>,
}

impl Read for WgReadHalf {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if !self.leftover.is_empty() {
            let n = self.leftover.len().min(buf.len());
            buf[..n].copy_from_slice(&self.leftover[..n]);
            self.leftover.drain(..n);
            return Ok(n);
        }
        let rx = self.from_thread.lock().unwrap_or_else(|p| p.into_inner());
        match rx.recv() {
            // Пустой Vec — EOF из стека (FIN/закрытие сокета).
            Ok(data) if data.is_empty() => Ok(0),
            Ok(data) => {
                let n = data.len().min(buf.len());
                buf[..n].copy_from_slice(&data[..n]);
                if n < data.len() {
                    self.leftover = data[n..].to_vec();
                }
                Ok(n)
            }
            // Нить туннеля умерла — EOF для клиента.
            Err(_) => Ok(0),
        }
    }
}

pub struct WgWriteHalf {
    id: u32,
    to_thread: SyncSender<Cmd>,
    wake: WgWake,
}

impl Write for WgWriteHalf {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.to_thread
            .send(Cmd::StreamData(self.id, buf.to_vec()))
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "туннель закрыт"))?;
        self.wake.ping();
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Drop for WgWriteHalf {
    fn drop(&mut self) {
        let _ = self.to_thread.send(Cmd::StreamClose(self.id));
        self.wake.ping();
    }
}

/// Клиентская ручка туннеля (клонируется в маршрут роутера).
#[derive(Clone)]
pub struct WgSession {
    to_thread: SyncSender<Cmd>,
    wake: WgWake,
    status: Arc<Mutex<WgLiveStatus>>,
    profile_id: String,
}

impl std::fmt::Debug for WgSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WgSession")
            .field("profile", &self.profile_id)
            .field("state", &self.status().state.as_str())
            .finish()
    }
}

/// Подписчик смены состояния туннеля (connecting/connected/error) — событие
/// vpn:state_changed контракта. Вызывается нитью туннеля только при переходах.
pub type OnStateChange = Arc<dyn Fn(&WgLiveStatus) + Send + Sync>;

/// Подписчик статистики туннеля (задача 6.5) — событие vpn:stats контракта:
/// rx/tx и ICMP-RTT пинга, не чаще раза в [`STATS_EVERY`] и только при
/// изменении чисел. Подключается после старта сессии (`set_stats_sink`).
pub type OnStatsChange = Arc<dyn Fn(&WgLiveStatus) + Send + Sync>;

impl WgSession {
    /// Поднять туннель: нить с UDP-сокетом, boringtun-сессией и smoltcp-стеком.
    /// Возврат — сразу; готовность видна в [`WgSession::status`]
    /// (Connecting → Connected после handshake). Ошибки — только фатальные
    /// (не открыть сокет/endpoint не резолвится). `on_state` — подписчик
    /// переходов состояния (None — без событий, тесты). `dead_after` — порог
    /// мёртвости для kill-switch (задача 6.4: handshake старше — соединения
    /// закрываются; приложение передаёт [`tunnel_dead_after`], тесты —
    /// короткий, чтобы не ждать протокольные 180 с).
    pub fn start(
        profile: &WgProfile,
        private_key: [u8; 32],
        psk: Option<[u8; 32]>,
        on_state: Option<OnStateChange>,
        dead_after: Duration,
    ) -> std::io::Result<WgSession> {
        let (tx, rx) = sync_channel::<Cmd>(64);
        let status = Arc::new(Mutex::new(WgLiveStatus {
            state: WgLiveState::Connecting,
            detail: "handshake…".into(),
            endpoint: format!("{}:{}", profile.endpoint_host, profile.endpoint_port),
            last_handshake_ms: None,
            rx_bytes: 0,
            tx_bytes: 0,
            ping_ms: None,
            since_ms: now_ms(),
        }));
        let runtime = Runtime::new(
            profile,
            private_key,
            psk,
            Arc::clone(&status),
            rx,
            tx.clone(),
            on_state,
            dead_after,
        )?;
        let wake = runtime.wake_handle();
        std::thread::Builder::new()
            .name("vpn-wg".into())
            .spawn(move || runtime.run())?;
        Ok(WgSession {
            to_thread: tx,
            wake,
            status,
            profile_id: profile.id.clone(),
        })
    }

    pub fn profile_id(&self) -> &str {
        &self.profile_id
    }

    /// Подключить подписчика статистики (vpn:stats, задача 6.5): rx/tx и
    /// ICMP-RTT пинга, троттлинг и дедуп — нитью туннеля. Вызывается после
    /// [`WgSession::start`]; нить просыпается будильником сразу.
    pub fn set_stats_sink(&self, cb: OnStatsChange) {
        if self.to_thread.send(Cmd::StatsSink(cb)).is_ok() {
            self.wake.ping();
        }
    }

    /// Снапшот состояния (IPC/статус).
    pub fn status(&self) -> WgLiveStatus {
        self.status
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    /// Открыть TCP-соединение через туннель (блокирующая, ≤ CONNECT_TIMEOUT).
    pub fn tcp_connect(&self, dst: SocketAddr) -> Result<WgStream, String> {
        let SocketAddr::V4(v4) = dst else {
            return Err("туннель IPv4 — адрес цели должен быть IPv4".into());
        };
        let (tx, rx) = sync_channel(1);
        self.to_thread
            .send(Cmd::TcpConnect { dst: v4, reply: tx })
            .map_err(|_| "туннель не активен".to_string())?;
        self.wake.ping();
        rx.recv_timeout(CONNECT_TIMEOUT)
            .map_err(|_| "таймаут открытия соединения в туннеле".to_string())?
            .map(|halfs| halfs.stream)
    }

    /// Резолв имени DNS-сервером туннеля (без утечек к системному резолверу).
    pub fn resolve(&self, host: &str) -> Result<Ipv4Addr, String> {
        if let Ok(ip) = host.parse::<Ipv4Addr>() {
            return Ok(ip); // уже адрес
        }
        let (tx, rx) = sync_channel(1);
        self.to_thread
            .send(Cmd::Resolve {
                host: host.to_string(),
                reply: tx,
            })
            .map_err(|_| "туннель не активен".to_string())?;
        self.wake.ping();
        rx.recv_timeout(CONNECT_TIMEOUT)
            .map_err(|_| "таймаут DNS через туннель".to_string())?
    }

    /// Roaming: смена сети/адреса (Wi-Fi↔LTE, новый NAT). Нить пересоздаст
    /// сокет и сессию — handshake уйдёт заново, сервер примет с нового адреса.
    /// Подписка на сетевые события Windows — задачи 6.4/6.5 (пока тесты
    /// и явные сетевые ошибки сокета в рантайме).
    #[allow(dead_code)]
    pub fn network_changed(&self) {
        let _ = self.to_thread.send(Cmd::NetworkChanged);
        self.wake.ping();
    }

    /// Остановить туннель (смена маршрута/профиля/выключение).
    pub fn shutdown(&self) {
        let _ = self.to_thread.send(Cmd::Shutdown);
        self.wake.ping();
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

// --- виртуальное IP-устройство: туннель ↔ smoltcp ---------------------------

/// Point-to-point IP-устройство (medium-ip): очередь пакетов из туннеля (rx —
/// забирает poll) и очередь в туннель (tx — наполняет poll).
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
        // transmit-токен выдаём всегда: на принятый пакет стек может захотеть
        // ответить (ACK) в том же poll.
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

/// Активное соединение стека.
struct StreamConn {
    handle: SocketHandle,
    /// Данные клиенту (роутеру); пустой Vec — EOF.
    to_client: SyncSender<Vec<u8>>,
    /// Данные, не влезшие в буфер отправки сокета (backpressure: доразываются
    /// в drain_sockets по мере откачки poll).
    pending: VecDeque<Vec<u8>>,
    /// Клиент закрыл свою сторону — socket.close() уже вызван (FIN).
    client_closed: bool,
    /// EOF клиенту уже отправлен (сокет дошёл до !may_recv).
    eof_sent: bool,
    /// Открытый TcpConnect ждёт установления: Established → Ok(поток),
    /// Closed до того → Err (цель отказала/недостижима за туннелем).
    connect_waiter: Option<(SyncSender<Result<WgStreamHalfs, String>>, WgStreamHalfs)>,
}

/// Ожидание DNS-ответа.
struct DnsWaiter {
    handle: SocketHandle,
    reply: SyncSender<Result<Ipv4Addr, String>>,
    created: Instant,
}

/// ICMP-пинг туннеля (задача 6.5): один долгоживущий echo-сокет; не более
/// одного ожидающего запроса — seq однозначно указывает на момент отправки.
struct PingProbe {
    handle: SocketHandle,
    seq: u16,
    /// Момент отправки ожидающего echo (None — ответ получен/просрочен).
    sent_at: Option<Instant>,
    /// Когда отправлять следующий (ритм [`PING_EVERY`]).
    next_due: Instant,
}

/// Нить туннеля: UDP-сокет + boringtun + smoltcp. Живёт до Shutdown или
/// потери отправителя команд; цикл такт TICK мс (при трафике крутится без
/// дополнительного сна — recv_to UDP сам pacing).
struct Runtime {
    profile: WgProfile,
    private_key: [u8; 32],
    psk: Option<[u8; 32]>,
    peer_public: [u8; 32],
    status: Arc<Mutex<WgLiveStatus>>,
    to_thread: SyncSender<Cmd>,
    cmd: Receiver<Cmd>,
    sock: StdUdp,
    tunn: Tunn,
    endpoint: SocketAddr,
    endpoint_resolved_at: Instant,
    iface: Interface,
    device: IpDevice,
    sockets: SocketSet<'static>,
    streams: HashMap<u32, StreamConn>,
    dns: HashMap<u16, DnsWaiter>,
    next_stream: u32,
    next_port: u16,
    started_at: Instant,
    send_errors: u32,
    /// Порог мёртвости для kill-switch (задача 6.4) — см. [`TUNNEL_DEAD_AFTER`].
    dead_after: Duration,
    /// Будильник: общий сокет отправки и актуальный адрес (обновляется при
    /// пересоздании сокета туннеля).
    wake_sock: Arc<StdUdp>,
    wake_addr: Arc<std::sync::RwLock<SocketAddr>>,
    /// Подписчик переходов состояния (None в тестах) + последнее отосланное
    /// состояние — эмит только при смене.
    on_state: Option<OnStateChange>,
    last_emitted: Option<WgLiveState>,
    /// Kill-switch эпизод уже отпечатан событием (сброс при восстановлении).
    kill_emitted: bool,
    /// Подписчик статистики vpn:stats (задача 6.5; None — не подключён).
    on_stats: Option<OnStatsChange>,
    /// Следующий разрешённый эмит статистики (троттлинг STATS_EVERY).
    next_stats_at: Instant,
    /// Последний эмит (rx, tx, ping) — без изменений молчим (панель держит
    /// последние числа; пустой туннель не топит интерфейс).
    last_stats: Option<(u64, u64, Option<u64>)>,
    /// ICMP-пинг туннеля (задача 6.5): None — DNS-сервера в профиле нет
    /// (пинг не ведём) или сокет ещё не создан.
    ping: Option<PingProbe>,
}

impl Runtime {
    /// Ручка будильника для WgSession/потоков.
    fn wake_handle(&self) -> WgWake {
        WgWake {
            sock: Arc::clone(&self.wake_sock),
            addr: Arc::clone(&self.wake_addr),
        }
    }
}

impl Runtime {
    #[allow(clippy::too_many_arguments)]
    fn new(
        profile: &WgProfile,
        private_key: [u8; 32],
        psk: Option<[u8; 32]>,
        status: Arc<Mutex<WgLiveStatus>>,
        cmd: Receiver<Cmd>,
        to_thread: SyncSender<Cmd>,
        on_state: Option<OnStateChange>,
        dead_after: Duration,
    ) -> std::io::Result<Runtime> {
        let peer_public = key_from_b64(&profile.peer_public_key)
            .map_err(|e| std::io::Error::other(format!("публичный ключ пира: {e}")))?;
        let sock = bind_udp(profile.listen_port)?;
        let local_port = sock
            .local_addr()
            .map(|a| a.port())
            .map_err(|e| std::io::Error::other(format!("порт туннеля: {e}")))?;
        let endpoint =
            resolve_endpoint(&profile.endpoint_host, profile.endpoint_port).ok_or_else(|| {
                std::io::Error::other(format!(
                    "endpoint {}:{} не резолвится",
                    profile.endpoint_host, profile.endpoint_port
                ))
            })?;
        let tunn = make_tunn(&private_key, &peer_public, &psk, profile.keepalive);

        // Стек: наш адрес из .conf, весь трафик — в туннель (default-маршрут;
        // medium-ip не делает neighbor discovery — via-адрес лишь отмечает
        // шлюз, пакеты уходят в устройство).
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
            // Слот один: переполнение возможно лишь при MAX_ADDR_COUNT < 2 —
            // не наш случай.
            let _ = addrs.push(IpCidr::new(
                IpAddress::from(profile.address),
                profile.prefix.min(32),
            ));
        });
        let _ = iface
            .routes_mut()
            .add_default_ipv4_route(default_gateway(profile.address));
        // MTU задаётся capabilities устройства (1420 — WireGuard).

        Ok(Runtime {
            profile: profile.clone(),
            private_key,
            psk,
            peer_public,
            status,
            to_thread,
            cmd,
            sock,
            tunn,
            endpoint,
            endpoint_resolved_at: Instant::now(),
            iface,
            device,
            sockets: SocketSet::new(Vec::new()),
            streams: HashMap::new(),
            dns: HashMap::new(),
            next_stream: 1,
            next_port: 30000,
            started_at: Instant::now(),
            send_errors: 0,
            dead_after,
            wake_sock: Arc::new(StdUdp::bind("127.0.0.1:0")?),
            wake_addr: Arc::new(std::sync::RwLock::new(SocketAddr::from((
                [127, 0, 0, 1],
                local_port,
            )))),
            on_state,
            last_emitted: None,
            kill_emitted: false,
            on_stats: None,
            next_stats_at: Instant::now(),
            last_stats: None,
            ping: None,
        })
    }

    fn run(mut self) {
        let mut udp_buf = [0u8; 65536];
        let mut wg_buf = vec![0u8; 65536 + 96];
        // Первый handshake инициируем явно: update_timers ретраит initiation
        // только после первого (библиотека рассчитана на TUN-поток пакетов,
        // у нас потока нет до первого соединения).
        self.kick_handshake();
        loop {
            // (1) команды: вычитываем всё накопленное (bounded-канал — send
            // клиентов блокируется, пока нить тут).
            loop {
                match self.cmd.try_recv() {
                    Ok(Cmd::TcpConnect { dst, reply }) => {
                        self.open_tcp(dst, reply);
                    }
                    Ok(Cmd::Resolve { host, reply }) => self.open_dns(&host, reply),
                    Ok(Cmd::StreamData(id, data)) => self.queue_stream(id, data),
                    Ok(Cmd::StreamClose(id)) => self.close_stream(id),
                    Ok(Cmd::NetworkChanged) => self.network_changed(),
                    Ok(Cmd::StatsSink(cb)) => self.on_stats = Some(cb),
                    Ok(Cmd::Shutdown) => return,
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => return,
                }
            }

            // (2) UDP с сервера: датаграммы → decapsulate → стек/ответ.
            // Неблокирующе: ожидание — только в конце итерации (7), где приход
            // датаграммы (включая wake) будит нить мгновенно; блокировка в
            // начале итерации добавляла бы системный тик Windows (~15,6 мс)
            // между «данные в командном канале» и «poll их отправил».
            self.recv_udp_batch(&mut udp_buf, &mut wg_buf);

            // (3) poll стека (ingress из device.rx + egress таймеры) и раздача
            // данных сокетам. Повторный проход: сегменты, залитые drain'ом в
            // сокеты, уходят в сеть ТЕМ ЖЕ тактом.
            let _ = self
                .iface
                .poll(SmolInstant::now(), &mut self.device, &mut self.sockets);
            self.drain_sockets();
            let _ = self
                .iface
                .poll(SmolInstant::now(), &mut self.device, &mut self.sockets);
            self.drain_sockets();

            // (4) исходящие IP-пакеты стека → туннель (батч).
            let tx_left = self.flush_device_tx(&mut wg_buf);

            // (5) таймеры протокола: keepalive, rekey, handshake-ретраи.
            if let TunnResult::WriteToNetwork(wg) = self.tunn.update_timers(&mut wg_buf) {
                self.send_endpoint(wg);
            }

            // (5.5) пинг туннеля ICMP-эхом (статистика задачи 6.5).
            self.ping_tick();

            // (6) статус.
            self.publish_status();

            // (7) ожидание событий: если очередь стека не опустела (батч (4)
            // обрезан) — крутимся дальше без сна. Иначе — блокирующее чтение
            // UDP до первой датаграммы (или тика): wake-датаграмма из
            // WgStream::write/команд будит нить сразу, не дожидаясь тика.
            if tx_left {
                continue;
            }
            self.sock.set_read_timeout(Some(TICK)).ok();
            match self.sock.recv_from(&mut udp_buf) {
                Ok((1, src)) if src.ip().is_loopback() && udp_buf[0] == WAKE_BYTE => {}
                Ok((n, src)) => {
                    self.decapsulate_datagram(&udp_buf[..n], src, &mut wg_buf);
                }
                Err(ref e) if is_would_block(e) => {}
                Err(e) => {
                    // Сокет умер (сеть ушла из-под ног) — это смена сети:
                    // пересоздаёмся и продолжаем.
                    eprintln!("[vpn/wg] udp: {e} — пересоздаю сессию");
                    self.network_changed();
                }
            }
        }
    }

    /// Неблокирующий дрен UDP-датаграмм (пакеты WireGuard → decapsulate,
    /// wake — пропуск).
    fn recv_udp_batch(&mut self, udp_buf: &mut [u8; 65536], wg_buf: &mut [u8]) {
        let _ = self.sock.set_nonblocking(true);
        for _ in 0..RX_BATCH {
            match self.sock.recv_from(udp_buf) {
                Ok((1, src)) if src.ip().is_loopback() && udp_buf[0] == WAKE_BYTE => {
                    continue; // будильник — не пакет WireGuard
                }
                Ok((n, src)) => self.decapsulate_datagram(&udp_buf[..n], src, wg_buf),
                Err(ref e) if is_would_block(e) => break,
                Err(e) => {
                    eprintln!("[vpn/wg] udp: {e} — пересоздаю сессию");
                    self.network_changed();
                    break;
                }
            }
        }
        let _ = self.sock.set_nonblocking(false);
    }

    /// Инкапсулировать исходящие IP-пакеты стека и отправить серверу.
    /// Возвращает true, если батч обрезан (очередь ещё не пуста — крутиться).
    fn flush_device_tx(&mut self, wg_buf: &mut [u8]) -> bool {
        let mut sent = 0;
        while sent < TX_BATCH {
            let Some(packet) = self.device.tx.pop_front() else {
                return false;
            };
            sent += 1;
            match self.tunn.encapsulate(&packet, wg_buf) {
                TunnResult::WriteToNetwork(wg) => self.send_endpoint(wg),
                TunnResult::Err(e) => {
                    eprintln!("[vpn/wg] encapsulate: {e:?}");
                    break;
                }
                _ => {}
            }
        }
        !self.device.tx.is_empty()
    }

    /// Один входящий UDP-датаграмма: расшифровка; ответы протокола — серверу,
    /// данные — в стек. Повторные вызовы с пустым датаграммом вытаскивают
    /// пакеты, скопившиеся в очереди boringtun за handshake.
    fn decapsulate_datagram(&mut self, datagram: &[u8], src: SocketAddr, wg_buf: &mut [u8]) {
        let mut src_opt = Some(src.ip());
        let mut data_opt = Some(datagram);
        loop {
            let result = match data_opt.take() {
                Some(d) => self.tunn.decapsulate(src_opt.take(), d, wg_buf),
                None => self.tunn.decapsulate(None, &[], wg_buf),
            };
            match result {
                TunnResult::WriteToNetwork(wg) => self.send_endpoint(wg),
                TunnResult::WriteToTunnelV4(packet, _) => {
                    if self.device.rx.len() < DEVICE_RX_LIMIT {
                        self.device.rx.push_back(packet.to_vec());
                    }
                }
                TunnResult::WriteToTunnelV6(_, _) => {} // стек proto-ipv4
                TunnResult::Done | TunnResult::Err(_) => break,
            }
        }
    }

    /// Послать handshake initiation (старт сессии и смена сети; повторные —
    /// сам update_timers).
    fn kick_handshake(&mut self) {
        let mut buf = [0u8; 256]; // initiation/keepalive — до 148 байт
        if let TunnResult::WriteToNetwork(pkt) =
            self.tunn.format_handshake_initiation(&mut buf, false)
        {
            self.send_endpoint(pkt);
        }
    }

    fn send_endpoint(&mut self, wg: &[u8]) {
        if let Err(e) = self.sock.send_to(wg, self.endpoint) {
            self.send_errors += 1;
            if self.send_errors <= 3 {
                eprintln!("[vpn/wg] send {}: {e}", self.endpoint);
            }
        } else {
            self.send_errors = 0;
        }
    }

    /// Открыть TCP-сокет в стеке, вернуть клиентский поток.
    /// Открыть TCP-сокет в стеке: SYN уходит, ответ вызывающему — при
    /// установлении (drain_sockets: Established → Ok, Closed → Err) —
    /// connect к недостижимой цели не «притворяется» успешным. Мёртвый
    /// туннель (kill-switch, задача 6.4) — отказ сразу, без 10 с ожидания:
    /// данные всё равно не дойдут, напрямую роутер не ходит.
    fn open_tcp(&mut self, dst: SocketAddrV4, reply: SyncSender<Result<WgStreamHalfs, String>>) {
        if self.is_tunnel_dead() {
            let _ = reply.send(Err(KILL_SWITCH_DETAIL.into()));
            return;
        }
        let mut socket = TcpSocket::new(
            TcpBuffer::new(vec![0u8; TCP_BUF]),
            TcpBuffer::new(vec![0u8; TCP_BUF]),
        );
        // Без задержки ACK: туннель уже тактируется своей нитью, лишние 10 мс
        // RTT режут пропускную способность.
        socket.set_ack_delay(None);
        let local_port = self.take_port();
        if let Err(e) = socket.connect(
            self.iface.context(),
            IpEndpoint::new(IpAddress::Ipv4(*dst.ip()), dst.port()),
            IpListenEndpoint::from(local_port),
        ) {
            let _ = reply.send(Err(format!("connect {dst}: {e:?}")));
            return;
        }
        let handle = self.sockets.add(socket);

        let id = self.next_stream;
        self.next_stream += 1;
        let (to_client, from_thread) = sync_channel::<Vec<u8>>(64);
        let halfs = WgStreamHalfs {
            stream: WgStream {
                id,
                to_thread: self.to_thread.clone(),
                wake: WgWake {
                    sock: Arc::clone(&self.wake_sock),
                    addr: Arc::clone(&self.wake_addr),
                },
                from_thread: Arc::new(Mutex::new(from_thread)),
            },
        };
        self.streams.insert(
            id,
            StreamConn {
                handle,
                to_client,
                pending: VecDeque::new(),
                client_closed: false,
                eof_sent: false,
                connect_waiter: Some((reply, halfs)),
            },
        );
    }

    /// DNS-запрос через UDP-сокет стека (в туннеле). Мёртвый туннель —
    /// отказ сразу (kill-switch, задача 6.4): запрос не дойдёт, ждать
    /// таймаута бессмысленно.
    fn open_dns(&mut self, host: &str, reply: SyncSender<Result<Ipv4Addr, String>>) {
        if self.is_tunnel_dead() {
            let _ = reply.send(Err(KILL_SWITCH_DETAIL.into()));
            return;
        }
        let Some(dns_server) = self.profile.dns.first().copied() else {
            let _ = reply.send(Err("в профиле нет DNS-сервера".into()));
            return;
        };
        let id = self.dns_id();
        let query = match dns_query_packet(id, host) {
            Ok(q) => q,
            Err(e) => {
                let _ = reply.send(Err(e));
                return;
            }
        };
        let mut socket = UdpSocket::new(
            UdpBuffer::new(vec![PacketMetadata::EMPTY; 4], vec![0u8; UDP_BUF]),
            UdpBuffer::new(vec![PacketMetadata::EMPTY; 4], vec![0u8; UDP_BUF]),
        );
        // Порт 0 smoltcp запрещает — выделяем сами.
        if let Err(e) = socket.bind(IpListenEndpoint::from(self.take_port())) {
            let _ = reply.send(Err(format!("dns bind: {e:?}")));
            return;
        }
        let handle = self.sockets.add(socket);
        let sock_ref = self.sockets.get_mut::<UdpSocket>(handle);
        let _ = sock_ref.send_slice(&query, IpEndpoint::new(IpAddress::Ipv4(dns_server), 53));
        self.dns.insert(
            id,
            DnsWaiter {
                handle,
                reply,
                created: Instant::now(),
            },
        );
    }

    fn dns_id(&mut self) -> u16 {
        self.next_stream = self.next_stream.wrapping_add(1);
        (self.next_stream % 60_000) as u16 + 1
    }

    fn take_port(&mut self) -> u16 {
        self.next_port = self.next_port.wrapping_add(1).max(30000);
        self.next_port
    }

    /// Данные от клиента → в pending соединения (dorazдаются в сокет по мере
    /// откачки poll — см. drain_sockets).
    fn queue_stream(&mut self, id: u32, data: Vec<u8>) {
        if let Some(conn) = self.streams.get_mut(&id) {
            if !conn.client_closed && !data.is_empty() {
                conn.pending.push_back(data);
            }
        }
    }

    fn close_stream(&mut self, id: u32) {
        if let Some(conn) = self.streams.get_mut(&id) {
            conn.client_closed = true;
            conn.pending.clear();
            self.sockets.get_mut::<TcpSocket>(conn.handle).close();
        }
    }

    /// Данные сокетов → клиентам (и доразгон pending в буферы отправки);
    /// EOF/закрытия; DNS-ответы.
    fn drain_sockets(&mut self) {
        let mut chunk = [0u8; 16 * 1024];
        let stream_ids: Vec<u32> = self.streams.keys().copied().collect();
        for id in stream_ids {
            let Some(conn) = self.streams.get_mut(&id) else {
                continue;
            };
            let socket = self.sockets.get_mut::<TcpSocket>(conn.handle);

            // Развязка открытия: Established/Closed до установления.
            if let Some((reply, halfs)) = conn.connect_waiter.take() {
                match socket.state() {
                    TcpState::Established => {
                        let _ = reply.send(Ok(halfs));
                    }
                    TcpState::Closed => {
                        let _ = reply.send(Err("цель за туннелем отказала в соединении".into()));
                    }
                    _ => conn.connect_waiter = Some((reply, halfs)), // ещё SYN
                }
            }

            // Dorazгон недовлезших данных клиента (backpressure).
            while let Some(head) = conn.pending.front().cloned() {
                match socket.send_slice(&head) {
                    Ok(n) if n > 0 => {
                        if n >= head.len() {
                            conn.pending.pop_front();
                        } else {
                            let rest = head[n..].to_vec();
                            conn.pending[0] = rest;
                            break;
                        }
                    }
                    _ => break, // буфер полон — на следующем такте
                }
            }

            // Приём: всё, что накопилось.
            while socket.can_recv() {
                match socket.recv_slice(&mut chunk) {
                    Ok(n) if n > 0 => {
                        if conn.to_client.send(chunk[..n].to_vec()).is_err() {
                            // Клиент ушёл, не читает — рвём соединение.
                            socket.abort();
                            break;
                        }
                    }
                    _ => break,
                }
            }

            // EOF: пир закрылся (FIN → CloseWait-семейство; в SynSent
            // may_recv=false — это НЕ EOF). Пустой Vec — сигнал клиенту.
            if !conn.eof_sent
                && matches!(
                    socket.state(),
                    TcpState::CloseWait
                        | TcpState::Closing
                        | TcpState::LastAck
                        | TcpState::Closed
                        | TcpState::TimeWait
                )
            {
                conn.eof_sent = true;
                let _ = conn.to_client.send(Vec::new());
            }

            // Сокет дошёл до конца — вынимаем из набора (и из map).
            if socket.state() == TcpState::Closed && conn.client_closed {
                let handle = conn.handle;
                self.sockets.remove(handle);
                self.streams.remove(&id);
            }
        }

        // DNS-ответы + чистка зависших ожиданий.
        let dns_ids: Vec<u16> = self.dns.keys().copied().collect();
        for id in dns_ids {
            let Some(waiter) = self.dns.get_mut(&id) else {
                continue;
            };
            if waiter.created.elapsed() > CONNECT_TIMEOUT + Duration::from_secs(5) {
                let _ = waiter.reply.send(Err("DNS: ответ не пришёл".into()));
                let handle = waiter.handle;
                self.sockets.remove(handle);
                self.dns.remove(&id);
                continue;
            }
            let socket = self.sockets.get_mut::<UdpSocket>(waiter.handle);
            if !socket.can_recv() {
                continue;
            }
            let mut buf = [0u8; UDP_BUF];
            if let Ok((n, _)) = socket.recv_slice(&mut buf) {
                let answer = parse_dns_a_answer(&buf[..n]);
                let _ = waiter.reply.send(answer);
                let handle = waiter.handle;
                self.sockets.remove(handle);
                self.dns.remove(&id);
            }
        }

        // ICMP echo-ответ пинга туннеля (задача 6.5): RTT в статус.
        self.ping_reply_rtt();
    }

    /// Roaming: пересоздать сокет и boringtun-сессию (endpoint перерезолвить —
    /// адрес сервера тоже мог смениться), handshake уйдёт заново.
    fn network_changed(&mut self) {
        match self.recreate_session() {
            Ok(()) => self.kick_handshake(),
            Err(e) => {
                let detail = format!("сеть сменилась, сессия не поднялась: {e}");
                eprintln!("[vpn/wg] {detail}");
                self.set_status(WgLiveState::Error, detail);
            }
        }
    }

    fn recreate_session(&mut self) -> Result<(), String> {
        if self.endpoint_resolved_at.elapsed() > ENDPOINT_TTL {
            self.endpoint =
                resolve_endpoint(&self.profile.endpoint_host, self.profile.endpoint_port)
                    .ok_or_else(|| {
                        format!("endpoint {} не резолвится", self.profile.endpoint_host)
                    })?;
            self.endpoint_resolved_at = Instant::now();
        }
        self.sock = bind_udp(self.profile.listen_port).map_err(|e| format!("UDP-сокет: {e}"))?;
        self.tunn = make_tunn(
            &self.private_key,
            &self.peer_public,
            &self.psk,
            self.profile.keepalive,
        );
        self.set_status(WgLiveState::Connecting, "handshake…".into());
        Ok(())
    }

    fn set_status(&mut self, state: WgLiveState, detail: String) {
        let mut s = self.status.lock().unwrap_or_else(|p| p.into_inner());
        s.state = state;
        s.detail = detail;
        drop(s);
        self.emit_state_change();
    }

    /// Событие перехода состояния (только при смене) — vpn:state_changed.
    fn emit_state_change(&mut self) {
        let snapshot = self
            .status
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        if self.last_emitted == Some(snapshot.state) {
            return;
        }
        self.last_emitted = Some(snapshot.state);
        if let Some(cb) = &self.on_state {
            cb(&snapshot);
        }
    }

    /// Туннель мёртв (kill-switch, задача 6.4): handshake старше `dead_after`
    /// (REJECT_AFTER_TIME — ключи истекли, данные не дойдут) либо его не было
    /// дольше порога с момента запуска сессии. До порога молчание двусмысленно
    /// (роуминг/rekey) — соединения живут.
    fn is_tunnel_dead(&self) -> bool {
        let (hs_ago, _, _, _, _) = self.tunn.stats();
        match hs_ago {
            Some(d) => d >= self.dead_after,
            None => self.started_at.elapsed() >= self.dead_after,
        }
    }

    /// Kill-switch (задача 6.4): закрыть ВСЕ туннельные соединения и
    /// DNS-ожидания — сокеты стека убираются, клиенты роутера получают
    /// EOF/ошибку (страница видит обрыв, а не вечную загрузку). Напрямую
    /// ничего не уходит: соединение только закрывается, маршрут остаётся за
    /// роутером. Идемпотентно (пока туннель мёртв — на каждом такте пусто);
    /// после восстановления handshake клиенты переподключаются заново.
    fn kill_tunneled(&mut self, reason: &str) {
        for (_, mut conn) in self.streams.drain() {
            if let Some((reply, _)) = conn.connect_waiter.take() {
                let _ = reply.send(Err(reason.to_string()));
            }
            let _ = conn.to_client.send(Vec::new()); // EOF клиенту
            self.sockets.remove(conn.handle);
        }
        for (_, waiter) in self.dns.drain() {
            let _ = waiter.reply.send(Err(reason.to_string()));
            self.sockets.remove(waiter.handle);
        }
    }

    /// Пинг туннеля (задача 6.5): раз в [`PING_EVERY`] ICMP-echo DNS-серверу
    /// профиля — он всегда внутри туннеля, RTT честный «до сервера».
    /// Ответа нет дольше [`PING_TIMEOUT`] — ping_ms=None: не показываем
    /// старое число (сервер может не отвечать на ICMP — трафик жив и без
    /// этого). Мёртвый/поднимающийся туннель не пингуем (ключей нет).
    fn ping_tick(&mut self) {
        let Some(dst) = self.profile.dns.first().copied() else {
            return; // DNS-сервера нет — пинг не ведём
        };
        if self.ping.is_none() {
            let mut socket = IcmpSocket::new(
                IcmpBuffer::new(vec![IcmpPacketMetadata::EMPTY; 2], vec![0u8; 32]),
                IcmpBuffer::new(vec![IcmpPacketMetadata::EMPTY; 2], vec![0u8; 32]),
            );
            if socket.bind(IcmpEndpoint::Ident(PING_IDENT)).is_err() {
                return;
            }
            let handle = self.sockets.add(socket);
            self.ping = Some(PingProbe {
                handle,
                seq: 0,
                sent_at: None,
                next_due: Instant::now(),
            });
        }
        let connected = {
            let s = self.status.lock().unwrap_or_else(|p| p.into_inner());
            s.state == WgLiveState::Connected
        };
        let now = Instant::now();
        // Решения — без пересечения заимствований: просрочка/отправка.
        let mut expired = false;
        let mut due = false;
        if let Some(p) = self.ping.as_ref() {
            if p.sent_at
                .is_some_and(|t| now.duration_since(t) > PING_TIMEOUT)
            {
                expired = true;
            } else {
                due = p.sent_at.is_none() && connected && now >= p.next_due;
            }
        }
        if expired {
            if let Some(p) = self.ping.as_mut() {
                p.sent_at = None;
            }
            self.status
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .ping_ms = None;
        }
        if !due {
            return;
        }
        let (handle, seq) = {
            let Some(p) = self.ping.as_mut() else { return };
            p.seq = p.seq.wrapping_add(1).max(1);
            p.sent_at = Some(now);
            p.next_due = now + PING_EVERY;
            (p.handle, p.seq)
        };
        let packet = icmp_echo_request(PING_IDENT, seq);
        let socket = self.sockets.get_mut::<IcmpSocket>(handle);
        if socket.send_slice(&packet, IpAddress::Ipv4(dst)).is_err() {
            // Буфер отправки полон (прошлый echo не уехал) — попробуем позже.
            if let Some(p) = self.ping.as_mut() {
                p.sent_at = None;
            }
        }
    }

    /// ICMP echo-заголовок + 8 байт метки (чексумму дописывает smoltcp при
    /// отправке — Icmpv4Repr::emit).
    fn ping_reply_rtt(&mut self) {
        let Some((handle, want_seq, sent)) = self.ping.as_ref().map(|p| {
            (
                p.handle, p.seq,
                p.sent_at, // borrow ок: копируем, не держим ссылку
            )
        }) else {
            return;
        };
        let Some(sent) = sent else { return };
        let socket = self.sockets.get_mut::<IcmpSocket>(handle);
        let mut buf = [0u8; 64];
        let mut rtt: Option<u64> = None;
        while socket.can_recv() {
            let Ok((n, _src)) = socket.recv_slice(&mut buf) else {
                break;
            };
            // Echo reply: type 0; ident уже отфильтрован сокетом (Ident).
            if n >= 8 && buf[0] == 0 && u16::from_be_bytes([buf[6], buf[7]]) == want_seq {
                rtt = Some(sent.elapsed().as_millis() as u64);
                break;
            }
        }
        if let Some(ms) = rtt {
            if let Some(p) = self.ping.as_mut() {
                p.sent_at = None;
            }
            self.status
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .ping_ms = Some(ms);
        }
    }

    fn publish_status(&mut self) {
        let (hs_ago, tx, rx, _, _) = self.tunn.stats();
        // Порог мёртвости от старта сессии — тот же, что у handshake:
        // не поднявшийся за dead_after туннель так же мёртв (ключей нет).
        let dead = match hs_ago {
            Some(d) => d >= self.dead_after,
            None => self.started_at.elapsed() >= self.dead_after,
        };
        {
            let mut s = self.status.lock().unwrap_or_else(|p| p.into_inner());
            s.tx_bytes = tx as u64;
            s.rx_bytes = rx as u64;
            if dead {
                // Kill-switch: Error + причина всегда (detail мог остаться от
                // «сеть сменилась» — пересоздание сессии падало); событие
                // уходит один раз за эпизод (форс-эмит ниже).
                s.state = WgLiveState::Error;
                s.detail = KILL_SWITCH_DETAIL.into();
            } else {
                match hs_ago {
                    Some(d) if d < HANDSHAKE_FRESH => {
                        s.last_handshake_ms = Some(d.as_millis() as u64);
                        if s.state != WgLiveState::Connected {
                            s.state = WgLiveState::Connected;
                            s.detail = "туннель жив".into();
                        }
                    }
                    Some(d) => {
                        s.last_handshake_ms = Some(d.as_millis() as u64);
                        if s.state == WgLiveState::Connected {
                            s.state = WgLiveState::Connecting;
                            s.detail = "rekey…".into();
                        }
                    }
                    None => {
                        s.last_handshake_ms = None;
                        if s.state != WgLiveState::Error {
                            s.state = WgLiveState::Connecting;
                            s.detail =
                                format!("handshake… ({} с)", self.started_at.elapsed().as_secs());
                        }
                    }
                }
            }
        }
        if dead {
            // Соединения закрываются на каждом такте мёртвости (идемпотентно:
            // после первого прохода пусто; успевшее открыться до порога —
            // накрывается этим же проходом, новое — fail-fast в open_*).
            self.kill_tunneled(KILL_SWITCH_DETAIL);
            if !self.kill_emitted {
                self.kill_emitted = true;
                // Событие kill-switch обязано уйти даже если Error уже был
                // эмитчен с другой причиной — сбрасываем дедупликацию.
                self.last_emitted = None;
            }
        } else {
            self.kill_emitted = false; // туннель ожил — новый эпизод
        }
        self.emit_state_change();
        self.emit_stats();
    }

    /// Статистика туннеля (задача 6.5): vpn:stats — rx/tx и ping не чаще
    /// раза в [`STATS_EVERY`] и только при изменении тройки (rx, tx, ping).
    /// Числа имеют смысл при живом туннеле — Connecting/Error отдаются только
    /// переходами vpn:state_changed, панель их знает.
    fn emit_stats(&mut self) {
        let snapshot = self
            .status
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        if snapshot.state != WgLiveState::Connected {
            return;
        }
        let now = Instant::now();
        if now < self.next_stats_at {
            return;
        }
        let triple = (snapshot.rx_bytes, snapshot.tx_bytes, snapshot.ping_ms);
        if self.last_stats == Some(triple) {
            return; // простой без трафика и джиттера пинга — молчим
        }
        self.last_stats = Some(triple);
        self.next_stats_at = now + STATS_EVERY;
        if let Some(cb) = &self.on_stats {
            cb(&snapshot);
        }
    }
}

fn is_would_block(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::WouldBlock
            | std::io::ErrorKind::TimedOut
            | std::io::ErrorKind::Interrupted
    )
}

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
        // Индекс своей стороны — случайное число (не 0: коллизии приёмников).
        u32::from_be_bytes([
            private_key[0] ^ peer_public[0],
            private_key[7],
            peer_public[13],
            private_key[31] ^ peer_public[1],
        ]) | 1,
        None,
    )
}

fn bind_udp(listen_port: Option<u16>) -> std::io::Result<StdUdp> {
    let sock = StdUdp::bind(SocketAddr::from(([0, 0, 0, 0], listen_port.unwrap_or(0))))?;
    // Дефолтный приёмный буфер UDP в Windows (64 КБ) теряет пачки сегментов
    // TCP-окна → ретрансмиссии → просадка пропускной способности. Поднимаем
    // до 2 МБ (socket2 уже в дереве зависимостей).
    socket2::SockRef::from(&sock).set_recv_buffer_size(2 * 1024 * 1024)?;
    socket2::SockRef::from(&sock).set_send_buffer_size(2 * 1024 * 1024)?;
    Ok(sock)
}

fn resolve_endpoint(host: &str, port: u16) -> Option<SocketAddr> {
    (host, port).to_socket_addrs().ok()?.find(|a| a.is_ipv4())
}

/// Шлюз default-маршрута стека: адрес подсети с хостом .1 (для /32 — сам
/// адрес); medium-ip не резолвит соседей — значение лишь отмечает, что
/// default-маршрут ведёт в туннель.
fn default_gateway(our: Ipv4Addr) -> Ipv4Addr {
    let o = our.octets();
    Ipv4Addr::new(o[0], o[1], o[2], 1)
}

// --- DNS: минимальный резолвер A-записей через туннель ----------------------

/// ICMP echo request для пинга туннеля (задача 6.5): 8-байтовый заголовок
/// (type/code/checksum/ident/seq) + 8 байт метки; чексумму при отправке
/// досчитывает smoltcp (Icmpv4Repr::emit).
fn icmp_echo_request(ident: u16, seq: u16) -> [u8; 16] {
    let mut pkt = [0u8; 16];
    pkt[0] = 8; // ICMP echo request
    pkt[4..6].copy_from_slice(&ident.to_be_bytes());
    pkt[6..8].copy_from_slice(&seq.to_be_bytes());
    pkt[8..16].copy_from_slice(b"DUOPULSE");
    pkt
}

fn dns_query_packet(id: u16, host: &str) -> Result<Vec<u8>, String> {
    let labels: Vec<&str> = host.trim_end_matches('.').split('.').collect();
    if labels.is_empty() || labels.iter().any(|l| l.is_empty() || l.len() > 63) {
        return Err(format!("имя «{host}» не годится для DNS-запроса"));
    }
    let mut q = vec![
        (id >> 8) as u8,
        id as u8,
        0x01,
        0x00, // RD=1
        0x00,
        0x01,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00, // один вопрос
    ];
    for label in labels {
        q.push(label.len() as u8);
        q.extend_from_slice(label.as_bytes());
    }
    q.extend_from_slice(&[0, 0x00, 0x01, 0x00, 0x01]); // корень + A + IN
    Ok(q)
}

fn parse_dns_a_answer(msg: &[u8]) -> Result<Ipv4Addr, String> {
    if msg.len() < 12 {
        return Err("DNS-ответ короче заголовка".into());
    }
    let rcode = msg[3] & 0x0F;
    if rcode != 0 {
        return Err(format!("DNS ответил кодом {rcode}"));
    }
    let questions = u16::from_be_bytes([msg[4], msg[5]]);
    let answers = u16::from_be_bytes([msg[6], msg[7]]);
    let mut pos = 12usize;
    for _ in 0..questions {
        pos = skip_dns_name(msg, pos)?;
        pos += 4; // QTYPE + QCLASS
    }
    for _ in 0..answers {
        pos = skip_dns_name(msg, pos)?;
        if msg.len() < pos + 10 {
            return Err("DNS-ответ обрезан".into());
        }
        let rtype = u16::from_be_bytes([msg[pos], msg[pos + 1]]);
        let class = u16::from_be_bytes([msg[pos + 2], msg[pos + 3]]);
        let rdlen = u16::from_be_bytes([msg[pos + 8], msg[pos + 9]]) as usize;
        let rdata = pos + 10;
        if rtype == 1 && class == 1 && rdlen == 4 && msg.len() >= rdata + 4 {
            return Ok(Ipv4Addr::new(
                msg[rdata],
                msg[rdata + 1],
                msg[rdata + 2],
                msg[rdata + 3],
            ));
        }
        pos = rdata + rdlen; // CNAME/прочее — пропустить
    }
    Err("в DNS-ответе нет A-записи".into())
}

fn skip_dns_name(msg: &[u8], mut pos: usize) -> Result<usize, String> {
    loop {
        if pos >= msg.len() {
            return Err("DNS-имя вышло за границы".into());
        }
        let len = msg[pos] as usize;
        if len & 0xC0 == 0xC0 {
            return Ok(pos + 2); // сжатая ссылка: конец имени
        }
        pos += 1 + len;
        if len == 0 {
            return Ok(pos);
        }
    }
}

// ---------------------------------------------------------------------------
// Тесты: парсер/профили без сети + loopback-стенд WireGuard (boringtun-сервер
// со smoltcp-стеком: TCP-echo, DNS-ответчик, roaming) — handshake, данные,
// keepalive, смена сети, пропускная способность, fail-closed, сквозной путь
// через SOCKS5-роутер.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use boringtun::x25519;

    const CLIENT_IP: Ipv4Addr = Ipv4Addr::new(10, 66, 77, 2);
    const SERVER_IP: Ipv4Addr = Ipv4Addr::new(10, 66, 77, 1);
    const SERVER_PORT: u16 = 5000;
    /// А-запись тестового DNS-ответчика.
    const DNS_ANSWER: Ipv4Addr = Ipv4Addr::new(203, 0, 113, 7);

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("duopulse-wg-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // --- парсер ---------------------------------------------------------------

    fn conf_text(priv_b64: &str, pub_b64: &str, endpoint: &str) -> String {
        format!(
            "[Interface]\nPrivateKey = {priv_b64}\nAddress = 10.66.77.2/24\n\
             DNS = 10.66.77.1\n\n\
             [Peer]\nPublicKey = {pub_b64}\nAllowedIPs = 0.0.0.0/0\n\
             Endpoint = {endpoint}\nPersistentKeepalive = 25\n"
        )
    }

    #[test]
    fn b64_known_vectors() {
        assert_eq!(b64_decode("").unwrap(), b"");
        assert_eq!(b64_decode("Zg==").unwrap(), b"f");
        assert_eq!(b64_decode("Zm8=").unwrap(), b"fo");
        assert_eq!(b64_decode("Zm9v").unwrap(), b"foo");
        assert_eq!(b64_decode(&b64_encode(b"foobar")).unwrap(), b"foobar");
        assert!(b64_decode("Zm9v!").is_err(), "нелегальный символ");
        assert!(b64_decode("Zg=").is_err(), "длина не кратна 4");
        assert!(b64_decode("Z=9v").is_err(), "= в середине");
    }

    #[test]
    fn conf_parser_full_and_forgiving() {
        let (client_pub, _, server_pub, _) = key_pair();
        let text = format!(
            "# комментарий\n[Interface]\n  PrivateKey={}  \nAddress = 10.66.77.2/24, fd00::2/128\nDNS = 10.66.77.1, 10.66.77.3\nMTU = 1420\n\
             [Peer]\nPublicKey = {}\nPresharedKey = {}\nAllowedIPs = 0.0.0.0/0, ::/0\nEndpoint = 127.0.0.1:51820\nPersistentKeepalive = 0\n\
             [Peer]\nPublicKey = {}\nEndpoint = 8.8.8.8:1\n",
            b64_encode(&[7u8; 32]),
            b64_encode(&server_pub),
            b64_encode(&[9u8; 32]),
            b64_encode(&client_pub),
        );
        let conf = parse_conf(&text, "my-vpn.conf").unwrap();
        assert_eq!(conf.name, "my-vpn");
        assert_eq!(conf.private_key, [7u8; 32]);
        assert_eq!(conf.peer_public_key, server_pub, "первый [Peer]");
        assert_eq!(conf.preshared_key, Some([9u8; 32]));
        assert_eq!(conf.endpoint_host, "127.0.0.1");
        assert_eq!(conf.endpoint_port, 51820);
        assert_eq!(conf.address, CLIENT_IP);
        assert_eq!(conf.prefix, 24);
        assert_eq!(conf.dns, vec![SERVER_IP, Ipv4Addr::new(10, 66, 77, 3)]);
        assert_eq!(conf.keepalive, None, "0 = выкл по wg-quick");
        assert_eq!(
            conf.profile_id(),
            b64_encode(&server_pub).replace(['+', '/', '='], "")[..10],
            "id детерминирован ключом пира"
        );
    }

    #[test]
    fn conf_parser_errors() {
        let (_, _, server_pub, _) = key_pair();
        let pub_b64 = b64_encode(&server_pub);
        assert!(parse_conf("[Interface]\nAddress = 10.0.0.1/24\n", "x.conf").is_err());
        assert!(parse_conf(
            &format!(
                "[Interface]\nPrivateKey={}\n[Peer]\nEndpoint=1.2.3.4:1\n",
                b64_encode(&[1u8; 32])
            ),
            "x.conf"
        )
        .is_err());
        assert!(parse_conf(
            &format!(
                "[Interface]\nPrivateKey={}\nAddress=10.0.0.1/24\n[Peer]\nPublicKey={pub_b64}\nEndpoint=h:0\n",
                b64_encode(&[3u8; 32])
            ),
            "x.conf"
        )
        .is_err());
        assert!(parse_conf(
            &format!(
                "[Interface]\nPrivateKey={}\nAddress=fd00::2/128\n[Peer]\nPublicKey={pub_b64}\nEndpoint=1.2.3.4:5\n",
                b64_encode(&[4u8; 32])
            ),
            "x.conf"
        )
        .unwrap_err()
        .contains("IPv4"));
        assert!(parse_conf(
            &format!(
                "[Interface]\nPrivateKey={}\nAddress=10.0.0.1/24\nDNS=not-an-ip\n[Peer]\nPublicKey={pub_b64}\nEndpoint=1.2.3.4:5\n",
                b64_encode(&[5u8; 32])
            ),
            "x.conf"
        )
        .is_err());
        assert!(parse_conf("[Bogus]\nx=1\n", "x.conf").is_err());
    }

    // --- профили + DPAPI ------------------------------------------------------

    fn sample_conf(endpoint_port: u16) -> (String, [u8; 32], [u8; 32]) {
        let (_, _, server_pub, _) = key_pair();
        let priv_b64 = b64_encode(&[7u8; 32]);
        (
            conf_text(
                &priv_b64,
                &b64_encode(&server_pub),
                &format!("127.0.0.1:{endpoint_port}"),
            ),
            [7u8; 32],
            server_pub,
        )
    }

    #[test]
    fn profiles_import_list_remove_keep_key_in_dpapi_only() {
        let dir = temp_dir("store");
        let (text, private_key, server_pub) = sample_conf(51820);

        let profile = import_profile(&dir, &text, "vpn-work.conf").unwrap();
        assert_eq!(
            profile.id,
            b64_encode(&server_pub).replace(['+', '/', '='], "")[..10]
        );
        assert_eq!(profile.name, "vpn-work");
        assert!(crate::secrets::exists(&key_path(&dir, &profile.id)));

        // В wg-profiles.json нет приватного ключа (только открытые поля).
        let raw = std::fs::read_to_string(profiles_path(&dir)).unwrap();
        assert!(
            !raw.contains(&b64_encode(&private_key)),
            "ключ в файле профилей"
        );
        // И в открытом виде в DPAPI-blob его нет.
        let blob = std::fs::read(key_path(&dir, &profile.id)).unwrap();
        let key_head = &b64_encode(&private_key)[..4];
        assert!(!blob.windows(4).any(|w| w == key_head.as_bytes()));

        // Секреты читаются обратно.
        assert_eq!(load_keys(&dir, &profile.id).unwrap().0, private_key);

        // Активация/чтение.
        set_active(&dir, Some(&profile.id)).unwrap();
        let (active, key, psk) = active_profile(&dir).unwrap();
        assert_eq!(active.id, profile.id);
        assert_eq!(key, private_key);
        assert_eq!(psk, None);
        assert_eq!(active_id(&dir).as_deref(), Some(profile.id.as_str()));

        // Повторный импорт того же пира — upsert (не копия).
        let again = import_profile(&dir, &text, "renamed.conf").unwrap();
        assert_eq!(again.id, profile.id);
        assert_eq!(again.name, "renamed");
        assert_eq!(list_profiles(&dir).len(), 1);

        // Удаление: профиль и секрет, активность снята.
        assert!(remove_profile(&dir, &profile.id).unwrap());
        assert!(list_profiles(&dir).is_empty());
        assert!(!crate::secrets::exists(&key_path(&dir, &profile.id)));
        assert_eq!(active_id(&dir), None);
        assert!(
            !remove_profile(&dir, &profile.id).unwrap(),
            "повтор — no-op"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_active_unknown_profile_rejected() {
        let dir = temp_dir("active-unknown");
        assert!(set_active(&dir, Some("nosuch")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- loopback-стенд: WG-сервер boringtun + smoltcp ------------------------

    /// Пара ключей клиента и сервера (детерминированные).
    fn key_pair() -> ([u8; 32], [u8; 32], [u8; 32], [u8; 32]) {
        let client_secret = [1u8; 32];
        let server_secret = [2u8; 32];
        let client_pub =
            *x25519::PublicKey::from(&x25519::StaticSecret::from(client_secret)).as_bytes();
        let server_pub =
            *x25519::PublicKey::from(&x25519::StaticSecret::from(server_secret)).as_bytes();
        (client_pub, client_secret, server_pub, server_secret)
    }

    /// События с серверверной стороны для статистики теста.
    #[derive(Default)]
    struct ServerStats {
        /// Внутренних IP-пакетов от клиента (включая пустые keepalive).
        rx_packets: std::sync::atomic::AtomicU64,
        dns_hits: std::sync::atomic::AtomicU64,
        tcp_connects: std::sync::atomic::AtomicU64,
    }

    /// Тестовый WG-сервер: boringtun-сессия + smoltcp-стек c TCP-echo и
    /// DNS-ответчиком. Отвечает последнему адресу клиента (roaming).
    struct TestWgServer {
        port: u16,
        stats: Arc<ServerStats>,
        stop: Arc<std::sync::atomic::AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl TestWgServer {
        /// Поднять сервер; psk должен совпасть с клиентским.
        fn start(psk: Option<[u8; 32]>) -> TestWgServer {
            let sock = StdUdp::bind("127.0.0.1:0").unwrap();
            let _ = socket2::SockRef::from(&sock).set_recv_buffer_size(2 * 1024 * 1024);
            let _ = socket2::SockRef::from(&sock).set_send_buffer_size(2 * 1024 * 1024);
            let port = sock.local_addr().unwrap().port();
            let (client_pub, _, _, server_secret) = key_pair();
            let tunn = make_tunn(&server_secret, &client_pub, &psk, None);
            let stats = Arc::new(ServerStats::default());
            let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let stats_loop = Arc::clone(&stats);
            let stop_loop = Arc::clone(&stop);
            let thread = std::thread::Builder::new()
                .name("test-wg-server".into())
                .spawn(move || server_loop(sock, tunn, stats_loop, stop_loop))
                .unwrap();
            TestWgServer {
                port,
                stats,
                stop,
                thread: Some(thread),
            }
        }
    }

    impl Drop for TestWgServer {
        fn drop(&mut self) {
            self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
            if let Some(t) = self.thread.take() {
                let _ = t.join();
            }
        }
    }

    /// Серверное соединение echo/генератора.
    struct SrvConn {
        handle: SocketHandle,
        out: VecDeque<Vec<u8>>,
        /// Сколько байт ещё догенерировать (режим gen:N).
        gen_left: usize,
    }

    fn server_loop(
        sock: StdUdp,
        mut tunn: Tunn,
        stats: Arc<ServerStats>,
        stop: Arc<std::sync::atomic::AtomicBool>,
    ) {
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
        let mut listeners = Vec::new();
        for _ in 0..4 {
            let mut l = TcpSocket::new(
                TcpBuffer::new(vec![0u8; TCP_BUF]),
                TcpBuffer::new(vec![0u8; TCP_BUF]),
            );
            l.listen(SERVER_PORT).unwrap();
            listeners.push(sockets.add(l));
        }
        let mut dns_socket = UdpSocket::new(
            UdpBuffer::new(vec![PacketMetadata::EMPTY; 4], vec![0u8; UDP_BUF]),
            UdpBuffer::new(vec![PacketMetadata::EMPTY; 4], vec![0u8; UDP_BUF]),
        );
        dns_socket.bind(53u16).unwrap();
        let dns_handle = sockets.add(dns_socket);

        let mut conns: Vec<SrvConn> = Vec::new();
        let mut last_client: Option<SocketAddr> = None;
        let mut udp_buf = [0u8; 65536];
        let mut wg_buf = vec![0u8; 65536 + 96];
        sock.set_read_timeout(Some(TICK)).unwrap();

        while !stop.load(std::sync::atomic::Ordering::Relaxed) {
            // UDP → decapsulate; ответы — последнему адресу клиента (roaming).
            match sock.recv_from(&mut udp_buf) {
                Ok((n, src)) => {
                    // Keepalive — DATA-датаграмма с пустым inner (decapsulate
                    // за него отдаёт Done) — считаем пакеты по типу: 4 = DATA.
                    if n >= 4
                        && u32::from_le_bytes([udp_buf[0], udp_buf[1], udp_buf[2], udp_buf[3]]) == 4
                    {
                        stats
                            .rx_packets
                            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
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
                                stats
                                    .rx_packets
                                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                if !pkt.is_empty() {
                                    device.rx.push_back(pkt.to_vec());
                                }
                            }
                            TunnResult::Done
                            | TunnResult::Err(_)
                            | TunnResult::WriteToTunnelV6(..) => break,
                        }
                    }
                }
                Err(ref e) if is_would_block(e) => {}
                Err(_) => return,
            }

            let _ = iface.poll(SmolInstant::now(), &mut device, &mut sockets);

            // Новые соединения: слушающий сокет стал Established — он
            // превращается в соединение, на его место встаёт свежий listener.
            let mut i = 0;
            while i < listeners.len() {
                let handle = listeners[i];
                let socket = sockets.get_mut::<TcpSocket>(handle);
                if socket.state() == TcpState::Established {
                    stats
                        .tcp_connects
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    conns.push(SrvConn {
                        handle,
                        out: VecDeque::new(),
                        gen_left: 0,
                    });
                    let mut l = TcpSocket::new(
                        TcpBuffer::new(vec![0u8; TCP_BUF]),
                        TcpBuffer::new(vec![0u8; TCP_BUF]),
                    );
                    l.listen(SERVER_PORT).unwrap();
                    listeners[i] = sockets.add(l); // слот занят — замещаем
                } else {
                    i += 1;
                }
            }

            // Echo/генератор.
            let mut chunk = [0u8; 16 * 1024];
            for conn in &mut conns {
                let socket = sockets.get_mut::<TcpSocket>(conn.handle);
                while socket.can_recv() {
                    match socket.recv_slice(&mut chunk) {
                        Ok(n) if n > 0 => {
                            if conn.gen_left == 0 {
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
                // Догенерация блоками.
                if conn.gen_left > 0 && conn.out.len() < 4 {
                    let block = conn.gen_left.min(16 * 1024);
                    conn.out.push_back(vec![b'A'; block]);
                    conn.gen_left -= block;
                }
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

            // DNS-ответчик: имена *.tun — SERVER_IP (echo за туннелем; сплит-
            // тесты задачи 6.3 резолвят туннельные домены сюда), прочие —
            // DNS_ANSWER (необслуживаемый адрес).
            let dns = sockets.get_mut::<UdpSocket>(dns_handle);
            if dns.can_recv() {
                let mut buf = [0u8; UDP_BUF];
                if let Ok((n, meta)) = dns.recv_slice(&mut buf) {
                    stats
                        .dns_hits
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let name = dns_query_name(&buf[..n]).unwrap_or_default();
                    let answer = if name.ends_with(".tun") {
                        SERVER_IP
                    } else {
                        DNS_ANSWER
                    };
                    if let Some(reply) = dns_echo_reply(&buf[..n], answer) {
                        let _ = dns.send_slice(&reply, meta.endpoint);
                    }
                }
            }

            // Доразгон попал в tx-буферы сокетов ПОСЛЕ poll — откачать сразу,
            // не дожидаясь следующего тика (RTT виртуального канала).
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

    /// Имя из вопроса DNS-запроса (стенд выбирает ответ по имени; сжатие
    /// указателей в question-секции не бывает).
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

    fn client_profile(endpoint_port: u16, keepalive: Option<u16>) -> WgProfile {
        let (_, _, server_pub, _) = key_pair();
        WgProfile {
            id: "testpeer".into(),
            name: "test".into(),
            endpoint_host: "127.0.0.1".into(),
            endpoint_port,
            peer_public_key: b64_encode(&server_pub),
            address: CLIENT_IP,
            prefix: 24,
            dns: vec![SERVER_IP],
            keepalive,
            listen_port: None,
            allowed_ips: vec!["0.0.0.0/0".into()],
            imported_at: 0,
        }
    }

    fn wait_connected(session: &WgSession, secs: u64) -> WgLiveStatus {
        let deadline = Instant::now() + Duration::from_secs(secs);
        loop {
            let st = session.status();
            if st.state == WgLiveState::Connected {
                return st;
            }
            assert!(
                Instant::now() < deadline,
                "туннель не подключился: {:?}",
                st.detail
            );
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    /// Дождаться не менее n байт с таймаутом (тестовая апертура половины;
    /// возвращает всё, что пришло в последнем чанке, без обрезки — иначе
    /// излишек терялся бы и следующий read читал поток со смещением).
    fn read_n(read: &mut WgReadHalf, n: usize, timeout: Duration) -> Vec<u8> {
        let mut out = Vec::with_capacity(n);
        let deadline = Instant::now() + timeout;
        while out.len() < n {
            assert!(
                Instant::now() < deadline,
                "прочитано {}/{} байт — таймаут",
                out.len(),
                n
            );
            let chunk = {
                let rx = read.from_thread.lock().unwrap_or_else(|p| p.into_inner());
                rx.recv_timeout(Duration::from_millis(200))
            };
            match chunk {
                Ok(data) if data.is_empty() => panic!("EOF после {} байт", out.len()),
                Ok(data) => out.extend_from_slice(&data),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => panic!("нить туннеля умерла"),
            }
        }
        out
    }

    fn start_client(profile: &WgProfile) -> WgSession {
        WgSession::start(profile, [1u8; 32], None, None, TUNNEL_DEAD_AFTER).unwrap()
    }

    // --- сценарии -------------------------------------------------------------

    #[test]
    fn handshake_connects_and_tcp_echo_flows() {
        let server = TestWgServer::start(None);
        let profile = client_profile(server.port, None);
        let session = start_client(&profile);

        let st = wait_connected(&session, 10);
        assert!(st.last_handshake_ms.is_some(), "handshake зафиксирован");

        let stream = session
            .tcp_connect(SocketAddr::new(
                std::net::IpAddr::V4(SERVER_IP),
                SERVER_PORT,
            ))
            .expect("TCP через туннель");
        let (mut read, mut write) = stream.split();
        write.write_all(b"ping").unwrap();
        let echo = read_n(&mut read, 4, Duration::from_secs(10));
        assert_eq!(echo, b"ping");

        assert_eq!(
            server
                .stats
                .tcp_connects
                .load(std::sync::atomic::Ordering::Relaxed),
            1
        );
        session.shutdown();
    }

    #[test]
    fn dns_resolves_through_tunnel_not_system() {
        let server = TestWgServer::start(None);
        let profile = client_profile(server.port, None);
        let session = start_client(&profile);
        wait_connected(&session, 10);

        // Имя не существует в системном DNS (.test) — ответит только туннель.
        let ip = session.resolve("only-inside-tunnel.test").unwrap();
        assert_eq!(ip, DNS_ANSWER);
        assert!(
            server
                .stats
                .dns_hits
                .load(std::sync::atomic::Ordering::Relaxed)
                >= 1
        );
        session.shutdown();
    }

    /// Пинг туннеля (задача 6.5): ICMP-эхо DNS-серверу профиля (в стенде это
    /// SERVER_IP — серверный стек smoltcp отвечает на echo сам); RTT
    /// оказывается в WgLiveStatus::ping_ms, туннель остаётся живым.
    #[test]
    fn ping_measures_rtt_through_tunnel() {
        let server = TestWgServer::start(None);
        let profile = client_profile(server.port, None);
        let session = start_client(&profile);
        wait_connected(&session, 10);

        let deadline = Instant::now() + Duration::from_secs(8);
        let ms = loop {
            let st = session.status();
            if let Some(ms) = st.ping_ms {
                break ms;
            }
            assert!(
                Instant::now() < deadline,
                "пинг не пришёл (статус: {:?})",
                st.detail
            );
            std::thread::sleep(Duration::from_millis(100));
        };
        assert!(ms < 2_000, "RTT loopback-стенда не бывает таким: {ms} мс");
        // Пинг не мешает данным: echo TCP по-прежнему ходит.
        let stream = session
            .tcp_connect(SocketAddr::new(
                std::net::IpAddr::V4(SERVER_IP),
                SERVER_PORT,
            ))
            .unwrap();
        let (mut read, mut write) = stream.split();
        write.write_all(b"pong").unwrap();
        assert_eq!(read_n(&mut read, 4, Duration::from_secs(10)), b"pong");
        session.shutdown();
    }

    /// Статистика туннеля (задача 6.5): событие vpn:stats несёт rx/tx и ping
    /// (троттлинг ~1 с, только при изменении) — панель VPN ведёт числа без
    /// опроса; после TCP-эха rx_bytes в событии больше нуля.
    #[test]
    fn stats_event_reports_ping_and_bytes() {
        let server = TestWgServer::start(None);
        let profile = client_profile(server.port, None);
        let session = start_client(&profile);
        wait_connected(&session, 10);

        let seen: std::sync::Arc<std::sync::Mutex<Vec<WgLiveStatus>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink_seen = std::sync::Arc::clone(&seen);
        session.set_stats_sink(std::sync::Arc::new(move |s| {
            sink_seen.lock().unwrap().push(s.clone());
        }));

        // Трафик: TCP-эхо 4 байта — событие с rx>0 обязано прийти.
        let stream = session
            .tcp_connect(SocketAddr::new(
                std::net::IpAddr::V4(SERVER_IP),
                SERVER_PORT,
            ))
            .unwrap();
        let (mut read, mut write) = stream.split();
        write.write_all(b"pong").unwrap();
        assert_eq!(read_n(&mut read, 4, Duration::from_secs(10)), b"pong");

        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            let with_numbers = seen
                .lock()
                .unwrap()
                .iter()
                .any(|s| s.ping_ms.is_some() && s.rx_bytes > 0);
            if with_numbers {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "vpn:stats не принёс ping+rx (события: {:?})",
                seen.lock().unwrap().last()
            );
            std::thread::sleep(Duration::from_millis(100));
        }
        session.shutdown();
    }

    /// Keepalive: при полном простое TCP сервер продолжает получать пакеты
    /// (PersistentKeepalive клиента гонит пустые датаграммы).
    #[test]
    fn keepalive_keeps_session_alive_when_idle() {
        let server = TestWgServer::start(None);
        let profile = client_profile(server.port, Some(1));
        let session = start_client(&profile);
        wait_connected(&session, 10);

        let before = server
            .stats
            .rx_packets
            .load(std::sync::atomic::Ordering::Relaxed);
        std::thread::sleep(Duration::from_secs(3));
        let after = server
            .stats
            .rx_packets
            .load(std::sync::atomic::Ordering::Relaxed);
        assert!(
            after - before >= 2,
            "keepalive не идёт: было {before}, стало {after}"
        );
        // Сессия жива и пропускает данные после простоя.
        let stream = session
            .tcp_connect(SocketAddr::new(
                std::net::IpAddr::V4(SERVER_IP),
                SERVER_PORT,
            ))
            .unwrap();
        let (mut read, mut write) = stream.split();
        write.write_all(b"alive").unwrap();
        assert_eq!(read_n(&mut read, 5, Duration::from_secs(10)), b"alive");
        session.shutdown();
    }

    /// Roaming: смена сети (новый UDP-сокет/порт) — повторный handshake,
    /// established-соединения не теряются, сервер отвечает на новый адрес.
    #[test]
    fn roaming_network_change_reconnects() {
        let server = TestWgServer::start(None);
        let profile = client_profile(server.port, Some(5));
        let session = start_client(&profile);
        wait_connected(&session, 10);
        let hs_before = session.status().last_handshake_ms;

        // Соединение, живущее через смену сети.
        let stream = session
            .tcp_connect(SocketAddr::new(
                std::net::IpAddr::V4(SERVER_IP),
                SERVER_PORT,
            ))
            .unwrap();
        let (mut read, mut write) = stream.split();
        write.write_all(b"before-roaming").unwrap();
        assert_eq!(
            read_n(&mut read, 14, Duration::from_secs(10)),
            b"before-roaming"
        );
        // Диагностика дублей: всё, что ещё приедет в ближайшую секунду.
        let mut extra = Vec::new();
        let drain_deadline = Instant::now() + Duration::from_secs(1);
        while Instant::now() < drain_deadline {
            let chunk = {
                let rx = read.from_thread.lock().unwrap_or_else(|p| p.into_inner());
                rx.recv_timeout(Duration::from_millis(100))
            };
            match chunk {
                Ok(data) if !data.is_empty() => extra.extend_from_slice(&data),
                Ok(_) => break, // EOF
                Err(_) => {}
            }
        }
        assert!(
            extra.is_empty(),
            "после первого эха пришёл дубль: {:?}",
            String::from_utf8_lossy(&extra)
        );

        // Сеть сменилась: сокет и сессия пересоздаются, handshake заново.
        session.network_changed();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let st = session.status();
            if st.state == WgLiveState::Connected && st.last_handshake_ms != hs_before {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "после roaming нет нового handshake: {st:?}"
            );
            std::thread::sleep(Duration::from_millis(100));
        }

        // Соединение то же (та же пара половин) — данные текут снова.
        write.write_all(b"after-roaming").unwrap();
        assert_eq!(
            read_n(&mut read, 13, Duration::from_secs(15)),
            b"after-roaming"
        );
        session.shutdown();
    }

    /// Пропускная способность download через туннель (DoD 6.2: ≥ 100 Мбит/с —
    /// замер в release: `cargo test --release wg_throughput -- --ignored
    /// --nocapture`; debug-порог ниже — шифрование без оптимизаций).
    /// DUOPULSE_WG_TPUT_MIN_MBPS перекрывает порог.
    #[test]
    #[ignore = "продолжительный: замер пропускной способности"]
    fn wg_throughput() {
        let min_mbps: f64 = std::env::var("DUOPULSE_WG_TPUT_MIN_MBPS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(25.0);
        let server = TestWgServer::start(None);
        let profile = client_profile(server.port, None);
        let session = start_client(&profile);
        wait_connected(&session, 10);

        let mib = 16usize;
        let stream = session
            .tcp_connect(SocketAddr::new(
                std::net::IpAddr::V4(SERVER_IP),
                SERVER_PORT,
            ))
            .unwrap();
        let (read, mut write) = stream.split();
        // Диагностика RTT: маленький echo отдельным соединением до генератора.
        let rtt_probe = {
            let (mut r, mut w) = session
                .tcp_connect(SocketAddr::new(
                    std::net::IpAddr::V4(SERVER_IP),
                    SERVER_PORT,
                ))
                .unwrap()
                .split();
            let t = Instant::now();
            w.write_all(b"rtt").unwrap();
            let _ = read_n(&mut r, 3, Duration::from_secs(5));
            t.elapsed()
        };
        eprintln!("[wg-throughput] RTT echo: {rtt_probe:?}");
        write
            .write_all(format!("gen:{}\n", mib * 1024 * 1024).as_bytes())
            .unwrap();
        let started = Instant::now();
        let mut got = 0usize;
        while got < mib * 1024 * 1024 {
            let chunk = {
                let rx = read.from_thread.lock().unwrap_or_else(|p| p.into_inner());
                rx.recv_timeout(Duration::from_secs(20))
                    .expect("данные кончились раньше времени")
            };
            assert!(!chunk.is_empty(), "EOF раньше времени");
            got += chunk.len();
        }
        let secs = started.elapsed().as_secs_f64();
        let mbps = got as f64 * 8.0 / 1_000_000.0 / secs;
        eprintln!(
            "[wg-throughput] {mib} МиБ за {secs:.2} с = {mbps:.0} Мбит/с (debug: {})",
            cfg!(debug_assertions)
        );
        assert!(mbps >= min_mbps, "{mbps:.0} Мбит/с < {min_mbps}");
        session.shutdown();
    }

    /// Soak (DoD 6.2: стабильность ≥ 30 мин): DUOPULSE_WG_SOAK_SECS=N держит
    /// туннель с keepalive и периодическим трафиком; печатает статистику
    /// (boringtun ренегоциирует сессию каждые ~120 с — циклы видны в логе).
    #[test]
    #[ignore = "длительный: DUOPULSE_WG_SOAK_SECS=1800"]
    fn wg_soak() {
        let secs: u64 = std::env::var("DUOPULSE_WG_SOAK_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        if secs == 0 {
            return;
        }
        let server = TestWgServer::start(None);
        let profile = client_profile(server.port, Some(15));
        let session = start_client(&profile);
        wait_connected(&session, 10);
        let started = Instant::now();
        let mut errors = 0;
        while started.elapsed().as_secs() < secs {
            std::thread::sleep(Duration::from_secs(20));
            let st = session.status();
            if st.state != WgLiveState::Connected {
                errors += 1;
            }
            let ok = (|| -> Option<bool> {
                let stream = session
                    .tcp_connect(SocketAddr::new(
                        std::net::IpAddr::V4(SERVER_IP),
                        SERVER_PORT,
                    ))
                    .ok()?;
                let (mut read, mut write) = stream.split();
                write.write_all(b"tick").ok()?;
                Some(read_n(&mut read, 4, Duration::from_secs(10)) == b"tick")
            })()
            .unwrap_or(false);
            if !ok {
                errors += 1;
            }
            eprintln!(
                "[wg-soak] +{} с: state={} rx={} tx={} hs={:?} err={errors}",
                started.elapsed().as_secs(),
                st.state.as_str(),
                st.rx_bytes,
                st.tx_bytes,
                st.last_handshake_ms,
            );
        }
        let st = session.status();
        eprintln!(
            "[wg-soak] итог: {} с, state={}, rx={} байт, tx={} байт, ошибок {errors}",
            started.elapsed().as_secs(),
            st.state.as_str(),
            st.rx_bytes,
            st.tx_bytes
        );
        assert_eq!(errors, 0, "за soak были недоступные моменты");
        session.shutdown();
    }

    /// Fail-closed: сервер недоступен — соединения через туннель НЕ выходят
    /// в открытую (клиент получает ошибку, а не прямой ход к цели).
    #[test]
    fn fail_closed_when_server_unreachable() {
        let dead = StdUdp::bind("127.0.0.1:0").unwrap();
        let dead_port = dead.local_addr().unwrap().port();
        drop(dead);

        let profile = client_profile(dead_port, None);
        let session = start_client(&profile);
        std::thread::sleep(Duration::from_millis(300));

        let verdict = session.tcp_connect(SocketAddr::new(
            std::net::IpAddr::V4(SERVER_IP),
            SERVER_PORT,
        ));
        assert!(
            verdict.is_err(),
            "соединение обязано отказать — ошибка клиенту, не прямой ход"
        );
        assert_ne!(session.status().state, WgLiveState::Connected);
        session.shutdown();
    }

    /// Сквозной путь карточки: SOCKS5-роутер (задача 6.1) → маршрут Wg →
    /// туннель → echo-сервер; домен резолвится DNS-сервером туннеля.
    #[test]
    fn socks5_router_routes_through_wg_tunnel() {
        let server = TestWgServer::start(None);
        let profile = client_profile(server.port, None);
        let session = start_client(&profile);
        wait_connected(&session, 10);

        let router = crate::vpn::router::Router::start().unwrap();
        router.set_route(crate::vpn::router::Route::Wg {
            session: session.clone(),
        });

        // IP-CONNECT: эхо через роутер → туннель → сервер.
        let mut s = connect_socks5(router.port(), &SERVER_IP.to_string(), SERVER_PORT);
        s.write_all(b"router-ping").unwrap();
        let mut buf = [0u8; 11];
        s.read_exact(&mut buf).unwrap();
        assert_eq!(&buf, b"router-ping");
        assert_eq!(
            server
                .stats
                .tcp_connects
                .load(std::sync::atomic::Ordering::Relaxed),
            1
        );

        // Домен уходит в туннель: DNS-ответчик сервера видит запрос.
        let dns_before = server
            .stats
            .dns_hits
            .load(std::sync::atomic::Ordering::Relaxed);
        // DNS_ANSWER (203.0.113.7) за туннелем никто не слушает — соединение
        // откажет после клиентского таймаута туннеля (REP=01), но резолв уже
        // прошёл через DNS туннеля (дольше таймаута tcp_connect 10 с).
        let mut probe = std::net::TcpStream::connect(("127.0.0.1", router.port())).unwrap();
        probe
            .set_read_timeout(Some(CONNECT_TIMEOUT + Duration::from_secs(5)))
            .unwrap();
        probe.write_all(&[0x05, 0x01, 0x00]).unwrap();
        let mut sel = [0u8; 2];
        probe.read_exact(&mut sel).unwrap();
        let mut req = vec![0x05, 0x01, 0x00, 0x03, 11];
        req.extend_from_slice(b"site.example");
        req.extend_from_slice(&80u16.to_be_bytes());
        probe.write_all(&req).unwrap();
        let mut rep = [0u8; 10];
        // Отказ ожидаем: адрес за туннелем никто не обслуживает.
        assert!(
            probe.read_exact(&mut rep).is_err() || rep[1] != 0x00,
            "соединение к необслуживаемому адресу обязано отказать"
        );
        assert!(
            server
                .stats
                .dns_hits
                .load(std::sync::atomic::Ordering::Relaxed)
                > dns_before,
            "резолв домена прошёл через DNS туннеля"
        );
        session.shutdown();
    }

    /// Мини-клиент SOCKS5 для роутера (no-auth, CONNECT).
    fn connect_socks5(port: u16, host: &str, target_port: u16) -> std::net::TcpStream {
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        s.write_all(&[0x05, 0x01, 0x00]).unwrap();
        let mut sel = [0u8; 2];
        s.read_exact(&mut sel).unwrap();
        assert_eq!(sel, [0x05, 0x00]);
        let mut req = vec![0x05, 0x01, 0x00, 0x03, host.len() as u8];
        req.extend_from_slice(host.as_bytes());
        req.extend_from_slice(&target_port.to_be_bytes());
        s.write_all(&req).unwrap();
        let mut rep = [0u8; 10];
        s.read_exact(&mut rep).unwrap();
        assert_eq!(rep[1], 0x00, "CONNECT отклонён: REP={}", rep[1]);
        s
    }

    // --- задача 6.3: split-tunnel сквозь роутер (критерии карточки 039) -------

    /// Критерий карточки: заблокированный домен — через туннель, YouTube и
    /// прочие — напрямую, ОДНОВРЕМЕННО (один роутер, split-политика). DNS
    /// туннельного домена спрашивает только DNS-сервер туннеля (зона .tun в
    /// системном резолвере не существует — сработай он, ответа бы не было);
    /// счётчики стенда фиксируют и резолв, и TCP. Правило правится на лету —
    /// общий стор IPC ↔ роутер. Персист правил переживает «перезапуск» —
    /// правилами rules.rs (store reload).
    #[test]
    fn split_routes_blocked_via_tunnel_and_direct_simultaneously() {
        use crate::vpn::rules::{RuleAction, RuleStore, SplitMode};

        let server = TestWgServer::start(None);
        let profile = client_profile(server.port, None);
        let session = start_client(&profile);
        wait_connected(&session, 10);

        let dir = temp_dir("split");
        let store = RuleStore::load(&dir);
        store.set_mode(SplitMode::Split).unwrap();
        store.add_rule("blocked.tun", RuleAction::Tunnel).unwrap();
        store.add_rule("youtube.com", RuleAction::Direct).unwrap();

        let router = crate::vpn::router::Router::start().unwrap();
        router.set_split(session.clone(), store.handle());

        // Журнал маршрутных решений (задача 6.5, событие vpn:route_changed):
        // шаги (1)/(2)/(4) сверяются с ним в конце теста — туннель/прямой
        // как шли, повтор домена — без второго события (дедуп).
        let routes_log: std::sync::Arc<std::sync::Mutex<Vec<(String, String)>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let routes_log_own = std::sync::Arc::clone(&routes_log);
        router.set_event_sink(std::sync::Arc::new(move |domain, route| {
            routes_log_own
                .lock()
                .unwrap()
                .push((domain.to_string(), route.to_string()));
        }));

        // (1) Заблокированный домен (поддомен правила) — через туннель:
        // резолв DNS-сервером туннеля (*.tun → SERVER_IP), TCP — echo сервера.
        let dns0 = server
            .stats
            .dns_hits
            .load(std::sync::atomic::Ordering::Relaxed);
        let tcp0 = server
            .stats
            .tcp_connects
            .load(std::sync::atomic::Ordering::Relaxed);
        let mut s = connect_socks5(router.port(), "www.blocked.tun", SERVER_PORT);
        s.write_all(b"via-tunnel").unwrap();
        let mut buf = [0u8; 10];
        s.read_exact(&mut buf).unwrap();
        assert_eq!(&buf, b"via-tunnel", "эхо пришло через туннель");
        assert_eq!(
            server
                .stats
                .dns_hits
                .load(std::sync::atomic::Ordering::Relaxed),
            dns0 + 1,
            "резолв домена прошёл DNS-сервером туннеля (утечек к системному нет)"
        );
        assert_eq!(
            server
                .stats
                .tcp_connects
                .load(std::sync::atomic::Ordering::Relaxed),
            tcp0 + 1,
            "TCP соединения — через туннель"
        );

        // (2) Прямой маршрут: местный echo (адрес-литерал — без правила и без
        // DNS, умолчание split), туннель ничего не видит. YouTube идёт этим
        // же путём — явное правило «direct» ниже. (Имя «localhost» не
        // годится: системный резолвер на Windows может отдать ::1 первым,
        // а echo слушает только IPv4 — был бы недетерминированный отказ.)
        let echo = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in echo.incoming() {
                let Ok(mut s) = stream else { break };
                let mut buf = [0u8; 256];
                if let Ok(n) = s.read(&mut buf) {
                    let _ = s.write_all(&buf[..n]);
                }
            }
        });
        let mut s = connect_socks5(router.port(), "127.0.0.1", echo_port);
        s.write_all(b"direct-hello").unwrap();
        let mut buf = [0u8; 12];
        s.read_exact(&mut buf).unwrap();
        assert_eq!(&buf, b"direct-hello", "прямой echo отвечает");
        assert_eq!(
            server
                .stats
                .tcp_connects
                .load(std::sync::atomic::Ordering::Relaxed),
            tcp0 + 1,
            "новых TCP в туннеле нет — напрямую, минуя туннель"
        );
        assert_eq!(
            server
                .stats
                .dns_hits
                .load(std::sync::atomic::Ordering::Relaxed),
            dns0 + 1,
            "новых DNS в туннеле нет"
        );
        assert_eq!(
            store.match_action("youtube.com"),
            Some(RuleAction::Direct),
            "явное правило «direct» (тот же прямой путь)"
        );

        // (3) Конфиг прокси при живом split маршрут не роняет (взаимная
        // исключительность: прокси вернётся при выключении VPN-режима).
        router.apply_config(
            &crate::proxy::ProxyConfig {
                enabled: true,
                proto: crate::proxy::ProxyProto::Socks5,
                host: "127.0.0.1".into(),
                port: 1,
                login: None,
            },
            &dir,
        );
        assert!(
            matches!(router.route(), crate::vpn::router::Route::Wg { .. }),
            "split-политика жива после apply_config прокси"
        );

        // (4) Правило добавляется на лету — общий стор: новое соединение
        // новым правилом уже маршрутизируется в туннель.
        store.add_rule("extra.tun", RuleAction::Tunnel).unwrap();
        let mut s = connect_socks5(router.port(), "extra.tun", SERVER_PORT);
        s.write_all(b"live-rule").unwrap();
        let mut buf = [0u8; 9];
        s.read_exact(&mut buf).unwrap();
        assert_eq!(&buf, b"live-rule");
        assert_eq!(
            server
                .stats
                .tcp_connects
                .load(std::sync::atomic::Ordering::Relaxed),
            tcp0 + 2,
            "правило сработало без пересборки роутера"
        );

        // (5) Журнал маршрутных решений (vpn:route_changed): решения шагов
        // (1)/(2)/(4) отражены, повторное соединение с доменом шага (1) —
        // без второго события (дедуп по домену).
        let repeat = connect_socks5(router.port(), "www.blocked.tun", SERVER_PORT);
        drop(repeat);
        std::thread::sleep(Duration::from_millis(200));
        let log = routes_log.lock().unwrap().clone();
        assert!(
            log.contains(&("www.blocked.tun".to_string(), "tunnel".to_string())),
            "туннельное решение в журнале: {log:?}"
        );
        assert!(
            log.contains(&("127.0.0.1".to_string(), "direct".to_string())),
            "прямое решение в журнале: {log:?}"
        );
        assert!(
            log.contains(&("extra.tun".to_string(), "tunnel".to_string())),
            "живое правило — туннельное решение: {log:?}"
        );
        assert_eq!(
            log.iter().filter(|(d, _)| d == "www.blocked.tun").count(),
            1,
            "повтор домена — без второго события (дедуп): {log:?}"
        );

        session.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Fail-closed в split: туннель мёртв — правило «tunnel» не «протекает»
    /// в прямые соединения (kill-switch, docs/02 §6.1): клиент получает
    /// ошибку, к цели напрямую роутер не ходит.
    #[test]
    fn split_tunnel_rule_is_fail_closed_on_dead_tunnel() {
        use crate::vpn::rules::{RuleAction, RuleStore, SplitMode};

        let dead = StdUdp::bind("127.0.0.1:0").unwrap();
        let dead_port = dead.local_addr().unwrap().port();
        drop(dead);

        let profile = client_profile(dead_port, None);
        let session = start_client(&profile);
        std::thread::sleep(Duration::from_millis(300));

        let dir = temp_dir("split-dead");
        let store = RuleStore::load(&dir);
        store.set_mode(SplitMode::Split).unwrap();
        store.add_rule("blocked.tun", RuleAction::Tunnel).unwrap();

        // Местная цель: если бы правило «протекло» напрямую, соединение
        // удалось бы — этого не должно случиться.
        let echo = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        let hits = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let hits_own = Arc::clone(&hits);
        std::thread::spawn(move || {
            for stream in echo.incoming() {
                let Ok(mut s) = stream else { break };
                hits_own.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let mut buf = [0u8; 256];
                if let Ok(n) = s.read(&mut buf) {
                    let _ = s.write_all(&buf[..n]);
                }
            }
        });

        let router = crate::vpn::router::Router::start().unwrap();
        router.set_split(session.clone(), store.handle());

        let mut probe = std::net::TcpStream::connect(("127.0.0.1", router.port())).unwrap();
        // Таймаут больше клиентского туннельного (резолв через мёртвый
        // туннель откажет по нему).
        probe
            .set_read_timeout(Some(CONNECT_TIMEOUT + Duration::from_secs(10)))
            .unwrap();
        probe.write_all(&[0x05, 0x01, 0x00]).unwrap();
        let mut sel = [0u8; 2];
        probe.read_exact(&mut sel).unwrap();
        let mut req = vec![0x05, 0x01, 0x00, 0x03, 12];
        req.extend_from_slice(b"blocked.tun");
        req.extend_from_slice(&echo_port.to_be_bytes());
        probe.write_all(&req).unwrap();
        let mut rep = [0u8; 10];
        assert!(
            probe.read_exact(&mut rep).is_err() || rep[1] != 0x00,
            "правило «tunnel» при мёртвом туннеле обязано отказать, а не идти напрямую"
        );
        assert_eq!(
            hits.load(std::sync::atomic::Ordering::Relaxed),
            0,
            "напрямую к цели роутер не ходил — fail-closed"
        );

        session.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- задача 6.4: kill-switch (DoD карточки duopulse-040) -------------------

    /// DoD 6.4: обрыв upstream СЕРЕДИНЫ передачи — установленные соединения
    /// закрываются (клиент видит EOF, а не вечную загрузку на ретрансмиссиях),
    /// состояние уходит событием (Error «kill-switch»), новые соединения к
    /// туннельной цели отказывают, напрямую к цели роутер не ходит — при живом
    /// и наблюдаемом прямом пути (умолчание split). Порог мёртвости для этой
    /// сессии — параметр (15 с, не env: параллельные тесты не задеваем):
    /// здоровая фаза (handshake + первые данные) обязана уложиться в него —
    /// запас от загрузки машины при параллельном прогоне всего пакета.
    #[test]
    fn kill_switch_dead_upstream_closes_established_and_fails_closed() {
        use crate::vpn::rules::{RuleAction, RuleStore, SplitMode};
        use std::io::Read;

        let server = TestWgServer::start(None);
        let profile = client_profile(server.port, None);
        let dead_after = Duration::from_secs(15);
        let events = Arc::new(std::sync::Mutex::new(Vec::<(WgLiveState, String)>::new()));
        let events_own = Arc::clone(&events);
        let on_state: OnStateChange = Arc::new(move |s| {
            events_own.lock().unwrap().push((s.state, s.detail.clone()));
        });
        let session =
            WgSession::start(&profile, [1u8; 32], None, Some(on_state), dead_after).unwrap();
        wait_connected(&session, 20);

        // Split: «blocked.tun» — туннель, умолчание — напрямую. Прямой echo
        // со счётчиком наблюдает «протекание»: если бы kill-switch свалился
        // в прямой ход, счётчик вырос бы без контрольного соединения.
        let dir = temp_dir("kill-switch");
        let store = RuleStore::load(&dir);
        store.set_mode(SplitMode::Split).unwrap();
        store.add_rule("blocked.tun", RuleAction::Tunnel).unwrap();
        let router = crate::vpn::router::Router::start().unwrap();
        router.set_split(session.clone(), store.handle());

        let echo = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        let direct_hits = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let hits_own = Arc::clone(&direct_hits);
        std::thread::spawn(move || {
            for stream in echo.incoming() {
                let Ok(mut s) = stream else { break };
                hits_own.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let mut buf = [0u8; 256];
                if let Ok(n) = s.read(&mut buf) {
                    let _ = s.write_all(&buf[..n]);
                }
            }
        });

        // «Загрузка страницы»: соединение к туннельной цели, генератор качает
        // (2 МиБ), первые данные получены — обрываем upstream в середине.
        let mut page = connect_socks5(router.port(), "blocked.tun", SERVER_PORT);
        page.write_all(b"gen:2097152\n").unwrap();
        let mut got = 0usize;
        let flow_deadline = Instant::now() + Duration::from_secs(12);
        while got < 16 * 1024 {
            assert!(
                Instant::now() < flow_deadline,
                "данные через туннель не пошли (healthy-фаза) — прочитано {got}"
            );
            let mut chunk = [0u8; 16 * 1024];
            page.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let n = page.read(&mut chunk).expect("чтение healthy-фазы");
            assert!(n > 0, "EOF healthy-фазы после {got} байт");
            got += n;
        }
        assert_eq!(
            direct_hits.load(std::sync::atomic::Ordering::Relaxed),
            0,
            "healthy-фаза: всё идёт туннелем, прямых нет"
        );

        // ОБРЫВ UPSTREAM: сервер WireGuard ушёл (сокет закрыт, ответов нет).
        drop(server);

        // Установленное соединение закрывается в пределах порога мёртвости
        // (+ запас): EOF/FIN, а не бесконечная загрузка. До kill-switch
        // ретрансмиссии стека держали бы его минутами. (Таймаут чтения — не
        // «закрыто»: ждём дальше, пока не EOF или обрыв трубы.)
        let kill_deadline = Instant::now() + dead_after + Duration::from_secs(20);
        page.set_read_timeout(Some(Duration::from_millis(250)))
            .unwrap();
        loop {
            let mut chunk = [0u8; 16 * 1024];
            match page.read(&mut chunk) {
                Ok(0) => break,    // FIN — kill-switch закрыл соединение
                Ok(n) => got += n, // хвост генератора до закрытия — нормально
                Err(ref e)
                    if e.kind() == std::io::ErrorKind::TimedOut
                        || e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(_) => break, // обрыв трубы (RST) — тоже закрыто
            }
            assert!(
                Instant::now() < kill_deadline,
                "kill-switch не закрыл соединение за порог+запас (прочитано {got} байт)"
            );
        }
        assert!(
            direct_hits.load(std::sync::atomic::Ordering::Relaxed) == 0,
            "после обрыва напрямую к цели роутер не ходил"
        );

        // Событие в UI: переход Error с деталью kill-switch. Эмит идёт в том
        // же такте publish_status, что и закрытие потоков, — ПОСЛЕ него:
        // под нагрузкой нить туннеля может быть вытеснена между закрытием
        // и колбэком, поэтому ждём с дедлайном, а не читаем мгновенно.
        let event_deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let fired = {
                let verdict = events.lock().unwrap();
                verdict
                    .iter()
                    .any(|(st, d)| *st == WgLiveState::Error && d.contains("kill-switch"))
            };
            if fired {
                break;
            }
            assert!(
                Instant::now() < event_deadline,
                "нет события Error kill-switch: {:?}",
                events.lock().unwrap()
            );
            std::thread::sleep(Duration::from_millis(100));
        }

        // Новое соединение к туннельной цели — отказ (fail-closed, быстро —
        // fail-fast мёртвого туннеля), а не успех напрямую.
        let mut probe = std::net::TcpStream::connect(("127.0.0.1", router.port())).unwrap();
        probe
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        probe.write_all(&[0x05, 0x01, 0x00]).unwrap();
        let mut sel = [0u8; 2];
        probe.read_exact(&mut sel).unwrap();
        let mut req = vec![0x05, 0x01, 0x00, 0x03, 12];
        req.extend_from_slice(b"blocked.tun");
        req.extend_from_slice(&SERVER_PORT.to_be_bytes());
        probe.write_all(&req).unwrap();
        let mut rep = [0u8; 10];
        let outcome = probe.read_exact(&mut rep);
        assert!(
            outcome.is_err() || rep[1] != 0x00,
            "новое соединение к туннельной цели обязано отказать, не идти напрямую"
        );

        // Прямой путь при этом жив и наблюдался счётчиком: контрольное
        // соединение умолчания split — теперь счётчик ровно 1 («напрямую не
        // уходит» — не потому, что роутер умер).
        let mut direct = connect_socks5(router.port(), "127.0.0.1", echo_port);
        direct.write_all(b"direct-ok").unwrap();
        let mut buf = [0u8; 9];
        direct
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        direct.read_exact(&mut buf).unwrap();
        assert_eq!(&buf, b"direct-ok");
        assert_eq!(
            direct_hits.load(std::sync::atomic::Ordering::Relaxed),
            1,
            "ровно одно прямое соединение — контрольное"
        );

        session.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Смена маршрута/выключение туннеля рвёт установленные соединения
    /// (kill-switch, docs/02 §6.1: «разрыв уже установленных»): stop-путь
    /// bridge — shutdown сессии + прямой маршрут — клиент видит обрыв,
    /// ничего не доживает цикл и не уходит напрямую.
    #[test]
    fn kill_switch_route_change_closes_established_connections() {
        use std::io::Read;

        let server = TestWgServer::start(None);
        let profile = client_profile(server.port, None);
        let session = start_client(&profile);
        wait_connected(&session, 10);

        let router = crate::vpn::router::Router::start().unwrap();
        router.set_route(crate::vpn::router::Route::Wg {
            session: session.clone(),
        });
        let mut page = connect_socks5(router.port(), &SERVER_IP.to_string(), SERVER_PORT);
        page.write_all(b"mid-transfer").unwrap();
        let mut buf = [0u8; 12];
        page.set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        page.read_exact(&mut buf).unwrap();
        assert_eq!(&buf, b"mid-transfer", "эхо через туннель работает");

        // Выключение туннеля (как stop_wg_tunnel в bridge): сессия гасится,
        // маршрут — прямой. Установленное соединение обязано закрыться.
        session.shutdown();
        router.set_route(crate::vpn::router::Route::Direct);
        let deadline = Instant::now() + Duration::from_secs(10);
        page.set_read_timeout(Some(Duration::from_millis(250)))
            .unwrap();
        loop {
            let mut chunk = [0u8; 64];
            match page.read(&mut chunk) {
                Ok(0) => break, // FIN — соединение закрыто
                Ok(_) => {}
                Err(ref e)
                    if e.kind() == std::io::ErrorKind::TimedOut
                        || e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(_) => break, // обрыв трубы — тоже закрыто
            }
            assert!(
                Instant::now() < deadline,
                "установленное соединение не закрылось после выключения туннеля"
            );
        }
    }
}
