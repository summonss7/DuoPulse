//! Импорт логинов из Google Chrome (duopulse-183): кнопка «Импорт из Chrome»
//! на экране «Пароли». Читает профиль Chrome на этой машине и переносит
//! логины в наше хранилище (PasswordStore) — дальше они живут как свои:
//! автозаполнение форм (duopulse-108) и синк аккаунта Aila (duopulse-110).
//!
//! Формат Chrome (Windows): ключ `os_crypt.encrypted_key` в «Local State» —
//! base64("DPAPI" || блоб) → DPAPI CurrentUser → 32 байта AES-256; значения
//! `password_value` в `Login Data` — "v10"/"v11" || 12Б nonce ||
//! AES-256-GCM (шифротекст+тег). Это тот же DPAPI-профиль пользователя, под
//! которым работает DuoPulse, — расшифровка легитимна только для своих
//! данных (посторонний профиль Windows вернёт из DPAPI ошибку). Префикс
//! "v20"+ (app-bound шифрование Chrome 127+) без ключа elevation-сервиса
//! не разбирается — такие записи честно считаются «не расшифровано».
//!
//! Login Data открывается через копию в %TEMP%: живой Chrome держит SQLite
//! под локом, файл читается снапшотом. Существующие записи DuoPulse импорт
//! не перезаписывает (пара origin+логин уже есть — счётчик «уже были»),
//! дубль того же логина в нескольких профилях Chrome вносится один раз.

use super::PasswordStore;
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use rand::RngCore;
use rusqlite::Connection;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// passwords.import_chrome: перенести логины из Chrome в хранилище.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PasswordImportChromeParams {
    /// Каталог «User Data» Chrome (подставляют тесты/e2e); по умолчанию —
    /// автопоиск (Chrome → Beta → Dev → Canary в %LOCALAPPDATA%).
    #[serde(default)]
    pub source_dir: Option<String>,
}

/// Итог импорта из Chrome (кнопка показывает сводку).
#[derive(Debug, Default, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PasswordImportChromeResult {
    /// Прочитанные профили Chrome («Default», «Profile 1»…).
    pub profiles: Vec<String>,
    /// Годных записей в Login Data (с логином и паролем).
    pub found: u64,
    /// Добавлено в хранилище.
    pub added: u64,
    /// Уже были (тот же логин на том же сайте) — не тронуты.
    pub existing: u64,
    /// Пропущено (пустой логин/пароль, не web-адрес).
    pub skipped: u64,
    /// Не расшифровано (v20 app-bound или битый блоб).
    pub undecryptable: u64,
}

/// Расшифрованный логин Chrome — кандидат на импорт.
struct ChromeLogin {
    origin: String,
    url: String,
    title: String,
    username: String,
    password: String,
    created_at: i64,
}

/// Кандидаты одной записи Login Data после разбора строки.
enum RowOutcome {
    Login(ChromeLogin),
    /// Пустой логин/пароль, не web-адрес.
    Skipped,
    /// Не расшифровано (v20+ или битый блоб).
    Undecryptable,
}

/// Корневые каталоги Chrome (стабильный и каналы) в %LOCALAPPDATA%.
fn chrome_user_data_dirs() -> Vec<PathBuf> {
    let Some(local) = std::env::var_os("LOCALAPPDATA") else {
        return Vec::new();
    };
    let base = PathBuf::from(local);
    ["Google/Chrome", "Google/Chrome Beta", "Google/Chrome Dev", "Google/Chrome SxS"]
        .iter()
        .map(|rel| base.join(rel).join("User Data"))
        .filter(|p| p.join("Local State").is_file())
        .collect()
}

/// Ключ шифрования Chrome из «Local State» (DPAPI → AES-256).
fn chrome_aes_key(user_data: &Path) -> Result<[u8; 32], String> {
    let state = std::fs::read_to_string(user_data.join("Local State"))
        .map_err(|e| format!("прочитать Local State Chrome: {e}"))?;
    let json: serde_json::Value = serde_json::from_str(&state)
        .map_err(|e| format!("разобрать Local State Chrome: {e}"))?;
    let b64 = json["os_crypt"]["encrypted_key"]
        .as_str()
        .ok_or("в Local State Chrome нет os_crypt.encrypted_key")?;
    let blob = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("разобрать ключ Chrome (base64): {e}"))?;
    if !blob.starts_with(b"DPAPI") {
        return Err("ключ Chrome в неожиданном формате (нет префикса DPAPI)".into());
    }
    let plain = dpapi_unprotect(&blob[5..])?;
    if plain.len() != 32 {
        return Err(format!("ключ Chrome неожиданной длины: {}", plain.len()));
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&plain);
    Ok(key)
}

/// DPAPI-расшифровка (CurrentUser): свой секрет — secrets.rs, чужой блоб
/// Chrome — здесь. Не-Windows хост честно отказывает.
#[cfg(windows)]
fn dpapi_unprotect(blob: &[u8]) -> Result<Vec<u8>, String> {
    crate::secrets::unprotect_blob(blob)
}

#[cfg(not(windows))]
fn dpapi_unprotect(_blob: &[u8]) -> Result<Vec<u8>, String> {
    Err("импорт из Chrome поддерживается на Windows".into())
}

/// Профили Chrome с Login Data (папки «Default», «Profile N»).
fn chrome_profiles(user_data: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(user_data) else {
        return out;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_profile = name == "Default"
            || (name.starts_with("Profile ") && name["Profile ".len()..].chars().all(|c| c.is_ascii_digit()));
        if is_profile {
            let login_data = entry.path().join("Login Data");
            if login_data.is_file() {
                out.push((name, login_data));
            }
        }
    }
    out.sort();
    out
}

/// Метка времени Chrome (микросекунды с 1601-01-01) → unix-миллисекунды.
/// Ноль/мусор/переполнение — сейчас (запись не должна датироваться 1601-м).
fn chrome_time_to_ms(chrome_us: i64) -> i64 {
    const EPOCH_DIFF_MS: i64 = 11_644_473_600_000;
    chrome_us
        .checked_div(1000)
        .and_then(|sec| sec.checked_sub(EPOCH_DIFF_MS))
        .filter(|ms| *ms > 0)
        .unwrap_or_else(super::now_ms)
}

/// Расшифровать password_value: "v10"/"v11" — AES-256-GCM ключом из Local
/// State; без префикса — старый формат (голый DPAPI); "v20"+ — app-bound.
fn decrypt_password(key: &[u8; 32], blob: &[u8]) -> Result<String, String> {
    if blob.starts_with(b"v10") || blob.starts_with(b"v11") {
        if blob.len() < 3 + 12 + 16 {
            return Err("битый блоб v10 (короче nonce+тега)".into());
        }
        let (nonce, ct) = blob[3..].split_at(12);
        let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("ключ AES: {e}"))?;
        let pt = cipher
            .decrypt(Nonce::from_slice(nonce), ct)
            .map_err(|_| "AES-256-GCM не сошёлся (другой ключ Chrome)".to_string())?;
        return String::from_utf8(pt).map_err(|e| format!("пароль не utf-8: {e}"));
    }
    // v20/v21 — app-bound шифрование Chrome 127+ (нужен elevation-сервис
    // Chrome, DuoPulse его не дергает) и неизвестные префиксы — отказ.
    if blob.starts_with(b"v20") || blob.starts_with(b"v21") {
        return Err("app-bound шифрование Chrome (v20+)".into());
    }
    let plain = dpapi_unprotect(blob)?;
    String::from_utf8(plain).map_err(|e| format!("пароль не utf-8: {e}"))
}

/// Прочитать логины одного Login Data (копия в %TEMP% — живой Chrome держит
/// базу под локом). Возвращает исходы строк без склейки.
fn read_login_data(
    login_data: &Path,
    key: &[u8; 32],
) -> Result<Vec<RowOutcome>, String> {
    let temp = std::env::temp_dir().join(format!(
        "duopulse-chrome-login-{}-{:x}",
        std::process::id(),
        rand::thread_rng().next_u32()
    ));
    std::fs::copy(login_data, &temp)
        .map_err(|e| format!("скопировать Login Data (Chrome запущен и закрыл файл?): {e}"))?;
    let rows = (|| {
        let conn = Connection::open(&temp)
            .map_err(|e| format!("открыть Login Data: {e}"))?;
        // display_name появился не в каждой схеме Login Data — без колонки
        // читаем без неё
        let sql = "SELECT origin_url, username_value, password_value, date_created, \
                   COALESCE(display_name, '') FROM logins";
        let mut stmt = match conn.prepare(sql) {
            Ok(stmt) => stmt,
            Err(_) => conn
                .prepare("SELECT origin_url, username_value, password_value, date_created, '' \
                          FROM logins")
                .map_err(|e| format!("прочитать logins Chrome: {e}"))?,
        };
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Vec<u8>>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })
            .map_err(|e| format!("прочитать logins Chrome: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("разобрать logins Chrome: {e}"))
    })();
    let _ = std::fs::remove_file(&temp);
    let raw = rows?;

    let mut out = Vec::new();
    for (origin_url, username, blob, created, display_name) in raw {
        let password = if blob.is_empty() {
            String::new()
        } else {
            match decrypt_password(key, &blob) {
                Ok(p) => p,
                Err(_) => {
                    out.push(RowOutcome::Undecryptable);
                    continue;
                }
            }
        };
        if username.trim().is_empty() || password.is_empty() {
            out.push(RowOutcome::Skipped);
            continue;
        }
        let origin = match super::origin_of(&origin_url) {
            Ok(o) => o,
            Err(_) => {
                out.push(RowOutcome::Skipped); // android://, chrome:// и прочее
                continue;
            }
        };
        out.push(RowOutcome::Login(ChromeLogin {
            origin,
            url: origin_url.trim().to_string(),
            title: display_name.trim().to_string(),
            username: username.trim().to_string(),
            password,
            created_at: chrome_time_to_ms(created),
        }));
    }
    Ok(out)
}

/// Импорт логинов Chrome в хранилище: все профили всех найденных браузеров
/// Chrome, дубль (origin, логин) — один раз, существующие записи не трогаем.
pub fn import_from_chrome(
    store: &PasswordStore,
    source_dir: Option<&str>,
) -> Result<PasswordImportChromeResult, String> {
    let roots: Vec<PathBuf> = match source_dir {
        Some(dir) => {
            let p = PathBuf::from(dir.trim_end_matches('\\').trim_end_matches('/'));
            if !p.join("Local State").is_file() {
                return Err(format!("в «{}» нет Local State — это не каталог User Data Chrome", dir));
            }
            vec![p]
        }
        None => {
            let dirs = chrome_user_data_dirs();
            if dirs.is_empty() {
                return Err("Google Chrome не найден (нет профиля в %LOCALAPPDATA%\\Google\\Chrome)".into());
            }
            dirs
        }
    };

    let mut result = PasswordImportChromeResult::default();
    let mut batch: Vec<ChromeLogin> = Vec::new();
    let mut seen: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    for root in roots {
        let key = chrome_aes_key(&root)?;
        for (profile, login_data) in chrome_profiles(&root) {
            for outcome in read_login_data(&login_data, &key)? {
                match outcome {
                    RowOutcome::Login(login) => {
                        result.found += 1;
                        if seen.insert((login.origin.clone(), login.username.clone())) {
                            batch.push(login);
                        }
                    }
                    RowOutcome::Skipped => result.skipped += 1,
                    RowOutcome::Undecryptable => result.undecryptable += 1,
                }
            }
            result.profiles.push(profile);
        }
    }
    if result.profiles.is_empty() {
        return Err("в профиле Chrome нет сохранённых логинов (Login Data)".into());
    }

    let entries: Vec<super::PasswordImportEntry> = batch
        .into_iter()
        .map(|l| super::PasswordImportEntry {
            origin: l.origin,
            url: l.url,
            title: l.title,
            username: l.username,
            password: l.password,
            created_at: l.created_at,
        })
        .collect();
    let (added, existing) = store.import_batch(&entries)?;
    result.added = added;
    result.existing = existing;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::aead::Aead;

    /// Собрать синтетический «User Data» Chrome в temp: Local State с
    /// DPAPI-ключом и профили с Login Data (v10-шифрование как у живого).
    fn synthetic_chrome(dir: &Path, profiles: &[(&str, &[(&str, &str, &str, i64)])]) -> [u8; 32] {
        let mut key = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut key);
        // Local State: base64("DPAPI" || DPAPI(key))
        let mut dpapi_prefixed = b"DPAPI".to_vec();
        dpapi_prefixed.extend(crate::secrets::protect_for_test(&key).unwrap());
        let local_state = format!(
            r#"{{"os_crypt":{{"encrypted_key":"{}"}}}}"#,
            base64::engine::general_purpose::STANDARD.encode(&dpapi_prefixed)
        );
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("Local State"), local_state).unwrap();
        for (profile, rows) in profiles {
            let pdir = dir.join(profile);
            std::fs::create_dir_all(&pdir).unwrap();
            let conn = Connection::open(pdir.join("Login Data")).unwrap();
            conn.execute_batch(
                "CREATE TABLE logins (origin_url TEXT NOT NULL, username_value TEXT NOT NULL,
                 password_value BLOB NOT NULL, display_name TEXT, date_created INTEGER NOT NULL);
                 CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);",
            )
            .unwrap();
            for (i, (url, user, pass, created)) in rows.iter().enumerate() {
                conn.execute(
                    "INSERT INTO logins VALUES (?,?,?,?,?)",
                    rusqlite::params![url, user, seal_v10(&key, pass), format!("name{i}"), created],
                )
                .unwrap();
            }
        }
        key
    }

    /// Зашифровать пароль в формат Chrome v10 (nonce || AES-GCM).
    fn seal_v10(key: &[u8; 32], plain: &str) -> Vec<u8> {
        let mut nonce = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce);
        let cipher = Aes256Gcm::new_from_slice(key).unwrap();
        let ct = cipher.encrypt(Nonce::from_slice(&nonce), plain.as_bytes()).unwrap();
        let mut out = b"v10".to_vec();
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&ct);
        out
    }

    fn store() -> PasswordStore {
        let mut k = [0u8; 32];
        k[..8].copy_from_slice(&5u64.to_le_bytes());
        PasswordStore::open_in_memory(k).unwrap()
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("duopulse-chrome-import-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn decrypt_password_formats() {
        let key = {
            let mut k = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut k);
            k
        };
        // v10 roundtrip (юникод живёт)
        let blob = seal_v10(&key, "пароль-тест");
        assert_eq!(decrypt_password(&key, &blob).unwrap(), "пароль-тест");
        // чужой ключ — честная ошибка
        let mut other = [0u8; 32];
        other[..8].copy_from_slice(&9u64.to_le_bytes());
        assert!(decrypt_password(&other, &blob).is_err());
        // обрезок — ошибка, не паника
        assert!(decrypt_password(&key, b"v10short").is_err());
        // v20 — app-bound, не расшифровываем
        assert!(decrypt_password(&key, b"v20xxxxxxxxxxxxxxxxxxxxxxxx").is_err());
        // время Chrome: 2026-01-02 03:04:05 UTC → unix-мс; 0 → «сейчас»
        assert_eq!(chrome_time_to_ms(13411796645000000), 1767323045000);
        assert!(chrome_time_to_ms(0) > 1_700_000_000_000);
    }

    #[test]
    fn import_full_flow_dedup_and_stats() {
        let dir = temp_dir("full");
        synthetic_chrome(
            &dir,
            &[
                (
                    "Default",
                    &[
                        ("https://example.com/login", "artem", "s3cret", 1),
                        ("https://example.com/login", "artem", "s3cret-2", 2), // дубль в профиле
                        ("https://youtube.com/", "a@b.c", "пароль-тест", 3),
                        ("https://empty.io/", "", "x", 4),       // без логина
                        ("https://none.dev/", "u", "", 5),       // пароль пуст (блоб пустой)
                        ("android://0519d/", "u", "p", 6),       // не web-адрес
                    ],
                ),
                (
                    "Profile 1",
                    &[
                        ("https://github.com/", "dev", "gh-pass", 7),
                        ("https://example.com/login", "artem", "same-again", 8), // дубль между профилями
                    ],
                ),
                ("Profile 2", &[]), // пустой профиль — просто читается
            ],
        );
        let s = store();
        let res = import_from_chrome(&s, Some(dir.to_str().unwrap())).unwrap();
        // found считает годные строки (дубли включительно), skipped — пустые/не-web
        assert_eq!(res.found, 5);
        assert_eq!(res.added, 3);
        assert_eq!(res.skipped, 3);
        assert_eq!(res.undecryptable, 0);
        assert_eq!(res.profiles.len(), 3);
        // в хранилище — три записи: дубль внесён один раз (первый, по date_created)
        let list = s.list("", 100).unwrap();
        assert_eq!(list.total, 3);
        let ex = list.items.iter().find(|e| e.origin == "https://example.com").unwrap();
        assert_eq!(ex.username, "artem");
        assert_eq!(s.reveal(ex.id).unwrap(), "s3cret");
        // автозаполнение видит импортированное (главное желание карточки)
        assert_eq!(
            s.credential("https://github.com", "dev").unwrap().as_deref(),
            Some("gh-pass")
        );
        // повторный импорт — всё «уже были», ничего не добавилось
        let again = import_from_chrome(&s, Some(dir.to_str().unwrap())).unwrap();
        assert_eq!((again.added, again.existing), (0, 3));
        assert_eq!(s.list("", 100).unwrap().total, 3);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn existing_duo_entries_are_not_overwritten() {
        let dir = temp_dir("keep");
        synthetic_chrome(
            &dir,
            &[("Default", &[("https://example.com/", "artem", "chrome-old", 1)])],
        );
        let s = store();
        s.add("https://example.com/", Some("мой вход"), "artem", "my-newer")
            .unwrap();
        let res = import_from_chrome(&s, Some(dir.to_str().unwrap())).unwrap();
        assert_eq!((res.added, res.existing), (0, 1));
        let saved = s.list("", 10).unwrap().items.into_iter().next().unwrap();
        assert_eq!(saved.title, "мой вход");
        assert_eq!(s.reveal(saved.id).unwrap(), "my-newer");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn v20_blob_is_counted_not_fatal() {
        let dir = temp_dir("v20");
        let key = synthetic_chrome(
            &dir,
            &[("Default", &[("https://example.com/", "u", "ignored", 1)])],
        );
        // подменяем пароль на v20-блоб (app-bound Chrome 127+)
        let conn = Connection::open(dir.join("Default").join("Login Data")).unwrap();
        conn.execute(
            "UPDATE logins SET password_value = ?",
            rusqlite::params![{
                let mut b = b"v20".to_vec();
                b.extend_from_slice(&key); // любое содержимое — должен быть отказ
                b
            }],
        )
        .unwrap();
        drop(conn);
        let s = store();
        let res = import_from_chrome(&s, Some(dir.to_str().unwrap())).unwrap();
        assert_eq!((res.found, res.undecryptable, res.added), (0, 1, 0));
        assert_eq!(s.list("", 10).unwrap().total, 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn broken_source_dir_is_honest_error() {
        let s = store();
        let dir = temp_dir("empty");
        assert!(import_from_chrome(&s, Some(dir.to_str().unwrap())).is_err());
        assert!(import_from_chrome(&s, Some("Z:\\no\\such\\dir")).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Login Data без display_name (старая схема) — читается фолбэк-запросом.
    #[test]
    fn login_data_without_display_name_column() {
        let dir = temp_dir("olddb");
        let mut key = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut key);
        let mut dpapi_prefixed = b"DPAPI".to_vec();
        dpapi_prefixed.extend(crate::secrets::protect_for_test(&key).unwrap());
        std::fs::create_dir_all(dir.join("Default")).unwrap();
        std::fs::write(
            dir.join("Local State"),
            format!(
                r#"{{"os_crypt":{{"encrypted_key":"{}"}}}}"#,
                base64::engine::general_purpose::STANDARD.encode(&dpapi_prefixed)
            ),
        )
        .unwrap();
        let conn = Connection::open(dir.join("Default").join("Login Data")).unwrap();
        conn.execute_batch(
            "CREATE TABLE logins (origin_url TEXT NOT NULL, username_value TEXT NOT NULL,
             password_value BLOB NOT NULL, date_created INTEGER NOT NULL);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO logins VALUES (?,?,?,?)",
            rusqlite::params!["https://old.org/", "old", seal_v10(&key, "legacy"), 1],
        )
        .unwrap();
        drop(conn);
        let s = store();
        let res = import_from_chrome(&s, Some(dir.to_str().unwrap())).unwrap();
        assert_eq!((res.added, res.skipped), (1, 0));
        assert_eq!(
            s.credential("https://old.org", "old").unwrap().as_deref(),
            Some("legacy")
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
