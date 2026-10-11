//! Внешний прокси SOCKS5/HTTP(S) — VPN-инкремент A (F-12, задача 1.8, docs/02 §6.3).
//!
//! Прокси WebView2 задаётся аргументами окружения браузера только на старте,
//! поэтому настройки применяются с перезапуском приложения (docs/02 §6.1).
//! Полный локальный роутер и WireGuard — этап M6; здесь WebView2 смотрит
//! прямо на внешний прокси.
//!
//! Хранение (docs/02 §8–9): `%APPDATA%\DuoPulse\profile\`
//!   - settings.json — конфиг прокси БЕЗ пароля (+ .bak — предыдущая версия);
//!   - vpn/proxy-pass.bin — пароль прокси, зашифрованный DPAPI (только blob,
//!     открытого секрета на диске нет).

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Таймаут проверки достижимости прокси, сек.
const CHECK_TIMEOUT: Duration = Duration::from_secs(3);

/// Путь профиля: %APPDATA%\DuoPulse\profile (docs/02 §8).
pub fn profile_dir() -> PathBuf {
    let appdata = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    Path::new(&appdata).join("DuoPulse").join("profile")
}

fn settings_path(dir: &Path) -> PathBuf {
    dir.join("settings.json")
}

fn password_path(dir: &Path) -> PathBuf {
    dir.join("vpn").join("proxy-pass.bin")
}

// ---------------------------------------------------------------------------
// Конфиг
// ---------------------------------------------------------------------------

/// Тип прокси. Схемы --proxy-server у Chromium: socks5/http/https
/// (для socks5 Chromium резолвит домены на стороне прокси).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProxyProto {
    Socks5,
    Http,
    Https,
}

impl ProxyProto {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Socks5 => "socks5",
            Self::Http => "http",
            Self::Https => "https",
        }
    }
}

fn default_proto() -> ProxyProto {
    ProxyProto::Socks5
}

/// Конфиг прокси в settings.json. Пароль сюда НЕ пишется — только DPAPI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProxyConfig {
    pub enabled: bool,
    #[serde(default = "default_proto")]
    pub proto: ProxyProto,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub login: Option<String>,
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            proto: default_proto(),
            host: String::new(),
            port: 1080,
            login: None,
        }
    }
}

impl ProxyConfig {
    /// Валидация для включённого режима: адрес и порт обязаны быть осмысленными.
    pub fn validate(&self) -> Result<(), String> {
        if self.host.trim().is_empty() {
            return Err("адрес прокси не задан".into());
        }
        if self.host.chars().any(char::is_whitespace) {
            return Err("адрес прокси содержит пробелы".into());
        }
        if self.port == 0 {
            return Err("порт прокси должен быть в диапазоне 1–65535".into());
        }
        Ok(())
    }
}

/// Читает settings.json; отсутствие/повреждённый файл → дефолт (прокси выключен).
/// Ключ "password" внутри proxy игнорируется — пароль живёт только в DPAPI.
pub fn load_config(dir: &Path) -> ProxyConfig {
    let Ok(raw) = std::fs::read_to_string(settings_path(dir)) else {
        return ProxyConfig::default();
    };
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|root| root.get("proxy").cloned())
        .and_then(|p| serde_json::from_value(p).ok())
        .unwrap_or_default()
}

/// Пишет settings.json (заменяя только ключ "proxy", прочие ключи сохраняются);
/// предыдущая версия остаётся в settings.json.bak (docs/02 §8).
pub fn save_config(dir: &Path, cfg: &ProxyConfig) -> Result<(), String> {
    let path = settings_path(dir);
    let mut root: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    root["proxy"] = serde_json::to_value(cfg).map_err(|e| e.to_string())?;

    std::fs::create_dir_all(dir).map_err(|e| format!("создать {dir:?}: {e}"))?;
    if path.exists() {
        let _ = std::fs::copy(&path, dir.join("settings.json.bak"));
    }
    let json = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("записать {path:?}: {e}"))
}

// ---------------------------------------------------------------------------
// Пароль — DPAPI (docs/02 §9)
// ---------------------------------------------------------------------------

/// Шифрует пароль DPAPI (CurrentUser, без UI-промпта) и кладёт blob в vpn/proxy-pass.bin.
pub fn save_password(dir: &Path, password: &str) -> Result<(), String> {
    let blob = protect(password.as_bytes())?;
    let path = password_path(dir);
    std::fs::create_dir_all(path.parent().expect("путь с родителем"))
        .map_err(|e| format!("создать каталог пароля: {e}"))?;
    std::fs::write(&path, blob).map_err(|e| format!("записать {path:?}: {e}"))
}

/// Читает пароль из DPAPI-blob. None — пароль не задан или blob не читается.
pub fn load_password(dir: &Path) -> Option<String> {
    let blob = std::fs::read(password_path(dir)).ok()?;
    let plain = unprotect(&blob).ok()?;
    String::from_utf8(plain).ok()
}

pub fn clear_password(dir: &Path) {
    let _ = std::fs::remove_file(password_path(dir));
}

/// Есть ли сохранённый пароль (для UI: показать «пароль сохранён»).
pub fn has_password(dir: &Path) -> bool {
    password_path(dir).is_file()
}

#[cfg(windows)]
fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output = std::mem::zeroed();
        CryptProtectData(
            &input,
            windows_core::PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|e| format!("DPAPI CryptProtectData: {e}"))?;
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        windows::Win32::Foundation::LocalFree(Some(windows::Win32::Foundation::HLOCAL(
            output.pbData as *mut core::ffi::c_void,
        )));
        Ok(bytes)
    }
}

#[cfg(windows)]
fn unprotect(blob: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: blob.len() as u32,
            pbData: blob.as_ptr() as *mut u8,
        };
        let mut output = std::mem::zeroed();
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|e| format!("DPAPI CryptUnprotectData: {e}"))?;
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        windows::Win32::Foundation::LocalFree(Some(windows::Win32::Foundation::HLOCAL(
            output.pbData as *mut core::ffi::c_void,
        )));
        Ok(bytes)
    }
}

#[cfg(not(windows))]
fn protect(_data: &[u8]) -> Result<Vec<u8>, String> {
    Err("DPAPI доступен только на Windows".into())
}

#[cfg(not(windows))]
fn unprotect(_blob: &[u8]) -> Result<Vec<u8>, String> {
    Err("DPAPI доступен только на Windows".into())
}

// ---------------------------------------------------------------------------
// Аргументы окружения WebView2
// ---------------------------------------------------------------------------

/// Список обхода прокси: localhost и локальные адреса НИКОГДА не идут через
/// прокси (критерий карточки duopulse-009). `<local>` — все имена без точки.
pub fn bypass_list() -> String {
    let mut list = String::from("localhost;127.0.0.1;[::1];<local>;10.*;192.168.*");
    for second in 16..=31 {
        list.push_str(&format!(";172.{second}.*"));
    }
    list
}

/// Аргументы браузера для WebView2. Явные аргументы замещают дефолтные флаги
/// wry, поэтому дефолт повторяется здесь (wry-0.57: отключение msWebOOUI/
/// msPdfOOUI/msSmartScreenProtection).
pub fn browser_args(cfg: Option<&ProxyConfig>) -> String {
    const WRY_DEFAULTS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";
    match cfg.filter(|c| c.enabled) {
        None => WRY_DEFAULTS.to_string(),
        Some(c) => format!(
            "{WRY_DEFAULTS} --proxy-server={}://{}:{} --proxy-bypass-list={}",
            c.proto.as_str(),
            c.host,
            c.port,
            bypass_list()
        ),
    }
}

// ---------------------------------------------------------------------------
// Статус: вкл / выкл / ошибка (гайд 06 §2 — сигнальные цвета в UI)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProxyState {
    /// Прокси выключен — все соединения прямые.
    Off,
    /// Включён и отвечает.
    On,
    /// Включён, но недоступен — показываем сигнальный цвет ошибки.
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProxyStatus {
    pub state: ProxyState,
    pub detail: String,
}

/// Проверка достижимости прокси: TCP-соединение + для SOCKS5 — приветствие
/// (подтверждает, что это реально SOCKS5-сервер). Без полного handshake.
pub fn check(cfg: &ProxyConfig) -> ProxyStatus {
    if !cfg.enabled {
        return ProxyStatus {
            state: ProxyState::Off,
            detail: "Прокси выключен — соединения прямые".into(),
        };
    }
    if let Err(e) = cfg.validate() {
        return ProxyStatus {
            state: ProxyState::Error,
            detail: format!("Настройки неполны: {e}"),
        };
    }

    match resolve(cfg) {
        Err(e) => ProxyStatus {
            state: ProxyState::Error,
            detail: format!("Адрес не разрешается: {e}"),
        },
        Ok(addr) => match TcpStream::connect_timeout(&addr, CHECK_TIMEOUT) {
            Err(e) => ProxyStatus {
                state: ProxyState::Error,
                detail: format!("Нет соединения с {}:{}: {e}", cfg.host, cfg.port),
            },
            Ok(mut stream) => {
                let _ = stream.set_read_timeout(Some(CHECK_TIMEOUT));
                let _ = stream.set_write_timeout(Some(CHECK_TIMEOUT));
                match cfg.proto {
                    ProxyProto::Socks5 => socks5_greeting(cfg, &mut stream),
                    ProxyProto::Http | ProxyProto::Https => ProxyStatus {
                        state: ProxyState::On,
                        detail: format!(
                            "TCP-соединение с {}:{} установлено ({}-прокси)",
                            cfg.host,
                            cfg.port,
                            cfg.proto.as_str().to_uppercase()
                        ),
                    },
                }
            }
        },
    }
}

fn resolve(cfg: &ProxyConfig) -> Result<SocketAddr, String> {
    (cfg.host.as_str(), cfg.port)
        .to_socket_addrs()
        .map_err(|e| e.to_string())?
        .next()
        .ok_or_else(|| "пустой список адресов".into())
}

/// RFC 1928 greeting: клиент [05, 01, 00] (без аутентификации); ответ [05, method]
/// достаточен как доказательство живого SOCKS5 (00 — без пароля, 02 — логин/пароль).
fn socks5_greeting(cfg: &ProxyConfig, stream: &mut TcpStream) -> ProxyStatus {
    let who = format!("{}:{}", cfg.host, cfg.port);
    let reply = (|| -> std::io::Result<[u8; 2]> {
        stream.write_all(&[0x05, 0x01, 0x00])?;
        let mut buf = [0u8; 2];
        stream.read_exact(&mut buf)?;
        Ok(buf)
    })();
    match reply {
        Ok([ver, method]) if ver == 0x05 => {
            let auth = match method {
                0x00 => "без аутентификации",
                0x02 => "запрашивает логин/пароль",
                _ => "нестандартный метод аутентификации",
            };
            ProxyStatus {
                state: ProxyState::On,
                detail: format!("SOCKS5 {who} отвечает ({auth})"),
            }
        }
        Ok(_) => ProxyStatus {
            state: ProxyState::Error,
            detail: format!("{who} отвечает, но это не SOCKS5 (проверьте тип прокси)"),
        },
        Err(e) => ProxyStatus {
            state: ProxyState::Error,
            detail: format!("SOCKS5 {who}: обмен приветствием не удался: {e}"),
        },
    }
}

// ---------------------------------------------------------------------------
// Тесты
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(enabled: bool, proto: ProxyProto, host: &str, port: u16) -> ProxyConfig {
        ProxyConfig {
            enabled,
            proto,
            host: host.into(),
            port,
            login: Some("user".into()),
        }
    }

    // --- аргументы WebView2 -------------------------------------------------

    #[test]
    fn args_disabled_have_no_proxy() {
        let a = browser_args(None);
        assert!(a.contains("--disable-features=msWebOOUI"));
        assert!(!a.contains("--proxy-server"));
        assert!(!a.contains("--proxy-bypass-list"));

        let off = browser_args(Some(&cfg(false, ProxyProto::Socks5, "10.0.0.1", 1080)));
        assert!(
            !off.contains("--proxy-server"),
            "выключенный прокси не применяется"
        );
    }

    #[test]
    fn args_enabled_socks5_http_https() {
        let a = browser_args(Some(&cfg(true, ProxyProto::Socks5, "p.example", 1080)));
        assert!(a.contains("--proxy-server=socks5://p.example:1080"), "{a}");
        assert!(
            a.contains("--disable-features=msWebOOUI"),
            "дефолтные флаги wry сохранены: {a}"
        );

        let a = browser_args(Some(&cfg(true, ProxyProto::Http, "p.example", 8080)));
        assert!(a.contains("--proxy-server=http://p.example:8080"), "{a}");

        let a = browser_args(Some(&cfg(true, ProxyProto::Https, "p.example", 8443)));
        assert!(a.contains("--proxy-server=https://p.example:8443"), "{a}");
    }

    #[test]
    fn bypass_list_never_proxies_local() {
        let b = bypass_list();
        assert!(b.contains("localhost"));
        assert!(b.contains("127.0.0.1"));
        assert!(b.contains("[::1]"));
        assert!(b.contains("<local>"));
        assert!(b.contains("10.*") && b.contains("192.168.*"));
        for second in 16..=31 {
            assert!(
                b.contains(&format!("172.{second}.*")),
                "приватный диапазон 172.{second}.* в обходе: {b}"
            );
        }
        assert!(!b.contains("<-loopback>"), "реверс-обход loopback запрещён");
    }

    // --- конфиг: settings.json без пароля -----------------------------------

    #[test]
    fn config_roundtrip_and_no_password_leak() {
        let dir = std::env::temp_dir().join(format!("duopulse-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        save_config(&dir, &cfg(true, ProxyProto::Socks5, "p.example", 1080)).unwrap();
        // чей-то ручной пароль в settings.json не должен доехать до конфига
        let raw = std::fs::read_to_string(settings_path(&dir)).unwrap();
        assert!(
            !raw.contains("password"),
            "пароль не пишется в settings.json: {raw}"
        );
        let injected = raw.replace(
            "\"port\": 1080",
            "\"port\": 1080,\n    \"password\": \"secret\"",
        );
        assert_ne!(&injected, &raw, "тестовая инъекция ключа password прошла");
        std::fs::write(settings_path(&dir), injected).unwrap();

        let loaded = load_config(&dir);
        assert_eq!(loaded, cfg(true, ProxyProto::Socks5, "p.example", 1080));

        // прочие ключи settings.json сохраняются при записи
        save_config(&dir, &cfg(false, ProxyProto::Http, "h", 3128)).unwrap();
        let raw = std::fs::read_to_string(settings_path(&dir)).unwrap();
        assert!(raw.contains("\"proxy\"") && raw.contains("h"), "{raw}");
        assert!(!raw.contains("password"), "{raw}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn validation_rejects_bad_input() {
        assert!(cfg(true, ProxyProto::Socks5, "  ", 1080)
            .validate()
            .is_err());
        assert!(cfg(true, ProxyProto::Socks5, "a b", 1080)
            .validate()
            .is_err());
        assert!(cfg(true, ProxyProto::Socks5, "p.example", 0)
            .validate()
            .is_err());
        assert!(cfg(true, ProxyProto::Socks5, "p.example", 65535)
            .validate()
            .is_ok());
    }

    // --- DPAPI: пароль хранится только шифрованным ---------------------------

    #[cfg(windows)]
    #[test]
    fn password_dpapi_roundtrip() {
        let dir = std::env::temp_dir().join(format!("duopulse-test-pw-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        assert!(!has_password(&dir));
        save_password(&dir, "p@ss wörд").unwrap();
        assert!(has_password(&dir));
        assert_eq!(load_password(&dir).as_deref(), Some("p@ss wörд"));

        let blob = std::fs::read(password_path(&dir)).unwrap();
        assert!(
            !blob.windows(4).any(|w| w == b"p@ss"),
            "в blob нет открытого пароля"
        );

        clear_password(&dir);
        assert!(!has_password(&dir));
        assert_eq!(load_password(&dir), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- статус-проверка против живого сокета ---------------------------------

    #[test]
    fn status_off_when_disabled() {
        let s = check(&cfg(false, ProxyProto::Socks5, "127.0.0.1", 1));
        assert_eq!(s.state, ProxyState::Off);
    }

    #[test]
    fn status_error_on_closed_port_and_bad_config() {
        // порт почти наверняка закрыт: биндим и закрываем
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let s = check(&cfg(true, ProxyProto::Socks5, "127.0.0.1", port));
        assert_eq!(s.state, ProxyState::Error, "{:?}", s.detail);

        let s = check(&cfg(true, ProxyProto::Socks5, "", 1080));
        assert_eq!(s.state, ProxyState::Error);
    }

    #[test]
    fn status_on_for_socks5_and_http() {
        // фейковый SOCKS5: отвечает на greeting [05 00]
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                let mut b = [0u8; 2];
                if s.read_exact(&mut b).is_ok() {
                    let _ = s.write_all(&[0x05, 0x00]);
                }
            }
        });
        let s = check(&cfg(true, ProxyProto::Socks5, "127.0.0.1", port));
        assert_eq!(s.state, ProxyState::On, "{:?}", s.detail);
        server.join().unwrap();

        // HTTP-прокси: достаточно TCP
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let _ = listener.accept();
        });
        let s = check(&cfg(true, ProxyProto::Http, "127.0.0.1", port));
        assert_eq!(s.state, ProxyState::On, "{:?}", s.detail);
        server.join().unwrap();
    }
}
