//! Локальный менеджер паролей (этап 1 цепочки duopulse-106): SQLite
//! `passwords.db` в профиле (`%APPDATA%\DuoPulse\profile\`) — логины сайтов.
//! Username и password хранятся ТОЛЬКО зашифрованными AES-256-GCM
//! (каждое значение со своим случайным 12-байтовым IV: `IV || ciphertext`),
//! ключ — 32 случайных байта в `passwords.key` под DPAPI (secrets.rs,
//! привязка к пользователю Windows — как пароль прокси, задача 1.8).
//! Origin/url/title — открытым текстом: нужны для поиска и автозаполнения
//! (этап 2), так же устроено Login Data в Chrome.
//!
//! Upsert — по паре (origin, username): повторное сохранение того же логина
//! на том же сайте обновляет пароль (сценарий «сменил пароль»), разные
//! логины одного сайта — отдельные записи. Логин бывает пуст — записи
//! «только пароль» (роутеры и пин-коды спрашивают один пароль, duopulse-194):
//! пара (origin, "") — законный ключ, автозаполнение заполняет только пароль.
//! Команда list пароль не отдаёт (только reveal по конкретному id —
//! экран «Пароли», duopulse-107).
//!
//! Этап 2 (duopulse-108): denylist never_save («никогда для этого сайта» —
//! бар не предлагается), accounts_for/credential — данные автозаполнения
//! (логины сайта и пароль конкретного логина по запросу content-слоя);
//! ожидающий кандидат бара — prompts.rs.
//!
//! Синхронизация с аккаунтом Aila (этап 4, duopulse-110) выведет ключ
//! блоба из wrap_key входа; локальный формат записей не изменится.

use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub mod autofill;
// Импорт из Chrome — десктоп-only (DPAPI/профиль Chrome в %LOCALAPPDATA%):
// гейт как у десктоп-секции Cargo.toml, мобильные таргеты модуль не тянут.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod import;
pub mod prompts;
// Реэкспорт — за тем же гейтом, что модуль: негейтованный ронял мобильную
// либу (unresolved import на aarch64-android, замечено в duopulse-169).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use import::{PasswordImportChromeParams, PasswordImportChromeResult};
pub use prompts::{PasswordPrompts, PasswordsCandidateView};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use rand::RngCore;
use rusqlite::Connection;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use url::Url;

/// Запись логина для списка (без пароля — reveal отдельно).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PasswordEntry {
    pub id: i64,
    /// Схема+хост+порт (https://example.com) — ключ автозаполнения.
    pub origin: String,
    /// Полный адрес страницы входа (если известен).
    pub url: String,
    /// Название сайта/страницы.
    pub title: String,
    pub username: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// passwords.list: записи с фильтром (по сайту/логину/названию).
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PasswordListParams {
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PasswordListResult {
    pub items: Vec<PasswordEntry>,
    pub total: u64,
}

/// passwords.add: сохранить логин (upsert по origin+username).
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PasswordAddParams {
    /// Адрес сайта (origin выводится на стороне Core).
    pub url: String,
    #[serde(default)]
    pub title: Option<String>,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PasswordSaveResult {
    pub id: i64,
    /// true — обновили существующую запись (тот же логин на том же сайте).
    pub updated: bool,
}

/// passwords.update: правка записи (переданные поля меняются).
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PasswordUpdateParams {
    pub id: i64,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PasswordRemoveParams {
    pub id: i64,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PasswordRevealParams {
    pub id: i64,
}

/// passwords.resolve_candidate (этап 2 duopulse-108): решение по бару
/// «Сохранить пароль?» — save | never | dismiss.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PasswordsResolveParams {
    /// save — сохранить/обновить, never — «никогда для этого сайта», dismiss — закрыть.
    pub action: String,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PasswordRevealResult {
    pub password: String,
}

/// Хранилище логинов: один инстанс на процесс (main.rs manage), поток —
/// через Mutex (как HistoryStore).
pub struct PasswordStore {
    conn: Mutex<Connection>,
    key: [u8; 32],
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// Зашифровать строку: 12Б IV || AES-256-GCM (ciphertext+tag).
fn seal(key: &[u8; 32], plain: &str) -> Result<Vec<u8>, String> {
    let mut iv = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut iv);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("ключ AES: {e}"))?;
    let ct = cipher
        .encrypt(Nonce::from_slice(&iv), plain.as_bytes())
        .map_err(|_| "зашифровать значение (AES-256-GCM)".to_string())?;
    let mut out = iv.to_vec();
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Расшифровать блоб seal-формата.
fn unseal(key: &[u8; 32], blob: &[u8]) -> Result<String, String> {
    if blob.len() < 12 + 16 {
        return Err("битый шифроблоб (короче IV+тега)".into());
    }
    let (iv, ct) = blob.split_at(12);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("ключ AES: {e}"))?;
    let pt = cipher.decrypt(Nonce::from_slice(iv), ct).map_err(|_| {
        "расшифровать (AES-256-GCM): неверный ключ или данные повреждены".to_string()
    })?;
    String::from_utf8(pt).map_err(|e| format!("расшифрованное не utf-8: {e}"))
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn decode_hex(s: &str) -> Option<Vec<u8>> {
    let s = s.trim();
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok())
        .collect()
}

/// Загрузить ключ хранилища или создать (32 случайных байта, hex под DPAPI).
/// duopulse-153: существующий, но нечитаемый ключ (шифроключ ОС умер: на
/// Android Keystore-ключ не переживает снос приложения, а auto-backup
/// возвращает passwords.key; на Windows — профиль с другого пользователя)
/// больше НЕ роняет запуск ошибкой из setup-хука: сохранённые пароли всё
/// равно криптографически невосстановимы, поэтому хранилище сбрасывается —
/// passwords.key и passwords.db удаляются, ключ создаётся заново (как
/// поступают браузеры при потере OS-ключа шифрования).
fn load_or_create_key(profile_dir: &Path) -> Result<[u8; 32], String> {
    let path = profile_dir.join("passwords.key");
    if crate::secrets::exists(&path) {
        let readable = crate::secrets::load(&path)
            .and_then(|hex| decode_hex(&hex).filter(|b| b.len() == 32));
        if let Some(bytes) = readable {
            let mut key = [0u8; 32];
            key.copy_from_slice(&bytes);
            return Ok(key);
        }
        eprintln!(
            "[passwords] passwords.key не читается (ключ ОС умер: переустановка \
             на Android либо профиль с другой машины/пользователя) — хранилище \
             паролей сброшено, сохранённые пароли восстановить невозможно"
        );
        // логины зашифрованы потерянным ключом — вместе с ним невосстановимы
        let _ = std::fs::remove_file(profile_dir.join("passwords.db"));
        let _ = std::fs::remove_file(&path);
    }
    let mut key = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut key);
    crate::secrets::save(&path, &encode_hex(&key))?;
    Ok(key)
}

/// Origin адреса: схема http/https + хост + нестандартный порт; без схемы
/// дописывается https:// (форма экрана «Пароли»). Путь/запрос отбрасываются.
pub fn origin_of(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    let parsed = match Url::parse(trimmed) {
        Ok(u) => u,
        Err(_) if !trimmed.contains("://") => Url::parse(&format!("https://{trimmed}"))
            .map_err(|_| format!("не похоже на адрес: {trimmed}"))?,
        Err(e) => return Err(format!("не похоже на адрес ({e}): {trimmed}")),
    };
    match parsed.scheme() {
        "http" | "https" => {}
        other => {
            return Err(format!(
                "поддерживаются только http/https, получено {other}"
            ))
        }
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| format!("в адресе нет хоста: {trimmed}"))?;
    let mut origin = format!("{}://{host}", parsed.scheme());
    if let Some(port) = parsed.port() {
        origin.push_str(&format!(":{port}"));
    }
    Ok(origin)
}

struct LoginRow {
    id: i64,
    origin: String,
    url: String,
    title: String,
    user_enc: Vec<u8>,
    pass_enc: Vec<u8>,
    created_at: i64,
    updated_at: i64,
}

/// Все строки logins (без расшифровки; сортировка origin, id).
fn rows_of(conn: &Connection) -> Result<Vec<LoginRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, origin, url, title, user_enc, pass_enc, created_at, updated_at
             FROM logins ORDER BY origin, id",
        )
        .map_err(|e| format!("select logins: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(LoginRow {
                id: r.get(0)?,
                origin: r.get(1)?,
                url: r.get(2)?,
                title: r.get(3)?,
                user_enc: r.get(4)?,
                pass_enc: r.get(5)?,
                created_at: r.get(6)?,
                updated_at: r.get(7)?,
            })
        })
        .map_err(|e| format!("query logins: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("прочитать logins: {e}"))
}

impl PasswordStore {
    /// Открыть хранилище в профиле (создать при первом запуске).
    pub fn open(profile_dir: &Path) -> Result<Self, String> {
        let key = load_or_create_key(profile_dir)?;
        let path = profile_dir.join("passwords.db");
        let conn =
            Connection::open(&path).map_err(|e| format!("открыть {}: {e}", path.display()))?;
        let store = Self {
            conn: Mutex::new(conn),
            key,
        };
        store.migrate()?;
        Ok(store)
    }

    /// Хранилище с явным ключом (тесты крейта — и свои, и aila-синка; файл
    /// БД — во временном каталоге, ключ DPAPI не трогаем).
    #[cfg(test)]
    pub(crate) fn open_with_key(path: &Path, key: [u8; 32]) -> Result<Self, String> {
        let conn =
            Connection::open(path).map_err(|e| format!("открыть {}: {e}", path.display()))?;
        let store = Self {
            conn: Mutex::new(conn),
            key,
        };
        store.migrate()?;
        Ok(store)
    }

    /// Хранилище в памяти с явным ключом (тесты).
    #[cfg(test)]
    fn open_in_memory(key: [u8; 32]) -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| format!("память: {e}"))?;
        let store = Self {
            conn: Mutex::new(conn),
            key,
        };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&self) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS logins (
                 id         INTEGER PRIMARY KEY AUTOINCREMENT,
                 origin     TEXT NOT NULL,
                 url        TEXT NOT NULL DEFAULT '',
                 title      TEXT NOT NULL DEFAULT '',
                 user_enc   BLOB NOT NULL,
                 pass_enc   BLOB NOT NULL,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_logins_origin ON logins(origin);
             CREATE TABLE IF NOT EXISTS never_save (
                 origin     TEXT PRIMARY KEY,
                 created_at INTEGER NOT NULL
             );",
        )
        .map_err(|e| format!("миграция passwords.db: {e}"))
    }

    fn rows(&self) -> Result<Vec<LoginRow>, String> {
        let conn = self.conn.lock().unwrap();
        rows_of(&conn)
    }

    /// Записи с фильтром (регистронезависимо по origin/username/title/url).
    /// Пароли не расшифровываются — их в списке нет.
    pub fn list(&self, query: &str, limit: u32) -> Result<PasswordListResult, String> {
        let q = query.trim().to_lowercase();
        let mut items = Vec::new();
        let mut total = 0u64;
        for row in self.rows()? {
            let username = unseal(&self.key, &row.user_enc)?;
            if !q.is_empty() {
                let hay = format!("{}\n{}\n{}\n{}", row.origin, username, row.title, row.url)
                    .to_lowercase();
                if !hay.contains(&q) {
                    continue;
                }
            }
            total += 1;
            if items.len() < limit as usize {
                items.push(PasswordEntry {
                    id: row.id,
                    origin: row.origin,
                    url: row.url,
                    title: row.title,
                    username,
                    created_at: row.created_at,
                    updated_at: row.updated_at,
                });
            }
        }
        Ok(PasswordListResult { items, total })
    }

    /// Сохранить логин: upsert по (origin, username) — тот же логин на том
    /// же сайте обновляется (password/url/title), новый — отдельной записью.
    pub fn add(
        &self,
        url: &str,
        title: Option<&str>,
        username: &str,
        password: &str,
    ) -> Result<PasswordSaveResult, String> {
        let origin = origin_of(url)?;
        // логин бывает пуст (запись «только пароль»: роутеры, duopulse-194) —
        // пара (origin, "") законный ключ upsert
        if password.is_empty() {
            return Err("пароль пуст".into());
        }
        let now = now_ms();
        let mut conn = self.conn.lock().unwrap();
        for row in rows_of(&conn)? {
            if row.origin != origin {
                continue;
            }
            if unseal(&self.key, &row.user_enc)? == username {
                conn.execute(
                    "UPDATE logins SET url=?, title=?, pass_enc=?, updated_at=? WHERE id=?",
                    rusqlite::params![
                        url.trim(),
                        title.unwrap_or(row.title.as_str()),
                        seal(&self.key, password)?,
                        now,
                        row.id
                    ],
                )
                .map_err(|e| format!("обновить логин: {e}"))?;
                return Ok(PasswordSaveResult {
                    id: row.id,
                    updated: true,
                });
            }
        }
        conn.execute(
            "INSERT INTO logins (origin, url, title, user_enc, pass_enc, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?)",
            rusqlite::params![
                origin,
                url.trim(),
                title.unwrap_or(""),
                seal(&self.key, username)?,
                seal(&self.key, password)?,
                now,
                now
            ],
        )
        .map_err(|e| format!("вставить логин: {e}"))?;
        Ok(PasswordSaveResult {
            id: conn.last_insert_rowid(),
            updated: false,
        })
    }

    /// Правка записи по id (переданные поля меняются; url пересчитывает
    /// origin). Записи нет — ошибка.
    pub fn update(
        &self,
        id: i64,
        url: Option<&str>,
        title: Option<&str>,
        username: Option<&str>,
        password: Option<&str>,
    ) -> Result<(), String> {
        let mut conn = self.conn.lock().unwrap();
        let row: Option<(String, String, String)> = conn
            .query_row(
                "SELECT origin, url, title FROM logins WHERE id=?",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map(Some)
            .or_else(|e| {
                if e == rusqlite::Error::QueryReturnedNoRows {
                    Ok(None)
                } else {
                    Err(e)
                }
            })
            .map_err(|e| format!("найти логин {id}: {e}"))?;
        let Some((origin, old_url, old_title)) = row else {
            return Err(format!("логин {id} не найден"));
        };
        if let Some(p) = password {
            if p.is_empty() {
                return Err("пароль пуст".into());
            }
        }
        let (new_origin, new_url) = match url {
            Some(u) => (origin_of(u)?, u.trim().to_string()),
            None => (origin, old_url),
        };
        let user_enc = match username {
            Some(u) => Some(seal(&self.key, u)?),
            None => None,
        };
        let pass_enc = match password {
            Some(p) => Some(seal(&self.key, p)?),
            None => None,
        };
        conn.execute(
            "UPDATE logins SET origin=?, url=?, title=?, user_enc=COALESCE(?, user_enc),
             pass_enc=COALESCE(?, pass_enc), updated_at=? WHERE id=?",
            rusqlite::params![
                new_origin,
                new_url,
                title.unwrap_or(old_title.as_str()),
                user_enc,
                pass_enc,
                now_ms(),
                id
            ],
        )
        .map_err(|e| format!("обновить логин: {e}"))?;
        Ok(())
    }

    /// Удалить запись (идемпотентно).
    pub fn remove(&self, id: i64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM logins WHERE id=?", [id])
            .map_err(|e| format!("удалить логин: {e}"))?;
        Ok(())
    }

    /// Расшифровать пароль конкретной записи (экран «Пароли»).
    pub fn reveal(&self, id: i64) -> Result<String, String> {
        let conn = self.conn.lock().unwrap();
        let blob: Vec<u8> = conn
            .query_row("SELECT pass_enc FROM logins WHERE id=?", [id], |r| r.get(0))
            .map_err(|_| format!("логин {id} не найден"))?;
        unseal(&self.key, &blob)
    }

    /// Сайт в denylist «никогда не сохранять» (этап 2 duopulse-108):
    /// бар «Сохранить пароль?» сайту больше не предлагается. На уже
    /// сохранённые записи и автозаполнение не влияет.
    pub fn is_denied(&self, origin: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT 1 FROM never_save WHERE origin=?", [origin], |_| {
            Ok(())
        })
        .is_ok()
    }

    /// Добавить сайт в denylist (идемпотентно).
    pub fn deny(&self, origin: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO never_save (origin, created_at) VALUES (?,?)",
            rusqlite::params![origin, now_ms()],
        )
        .map_err(|e| format!("записать never_save: {e}"))?;
        Ok(())
    }

    /// Логины сайта (автозаполнение, этап 2): usernames расшифровываются,
    /// пароли — нет (отдаются только credential по выбору пользователя).
    pub fn accounts_for(&self, origin: &str) -> Result<Vec<String>, String> {
        let mut out = Vec::new();
        for row in self.rows()? {
            if row.origin == origin {
                out.push(unseal(&self.key, &row.user_enc)?);
            }
        }
        Ok(out)
    }

    /// Пароль конкретного логина сайта (автозаполнение по клику на поле).
    pub fn credential(&self, origin: &str, username: &str) -> Result<Option<String>, String> {
        for row in self.rows()? {
            if row.origin == origin && unseal(&self.key, &row.user_enc)? == username {
                return Ok(Some(unseal(&self.key, &row.pass_enc)?));
            }
        }
        Ok(None)
    }

    /// Все записи с расшифрованными username/password (этап 4 duopulse-110:
    /// сборка документа для облачного блоба). Вне UI-контракта — только синк.
    pub fn export_full(&self) -> Result<Vec<FullLogin>, String> {
        let mut out = Vec::new();
        for row in self.rows()? {
            out.push(FullLogin {
                origin: row.origin,
                url: row.url,
                title: row.title,
                username: unseal(&self.key, &row.user_enc)?,
                password: unseal(&self.key, &row.pass_enc)?,
                created_at: row.created_at,
                updated_at: row.updated_at,
            });
        }
        Ok(out)
    }

    /// Пакетный импорт (duopulse-183, кнопка «Импорт из Chrome»): записи,
    /// которых нет (пара origin+логин), добавляются с датами источника;
    /// существующие НЕ перезаписываются — импортёр не знает, чья версия
    /// свежее, и честно отдаёт это счётчиком existing (а не молчит дублем).
    /// Одна транзакция: список ложится целиком либо ничего.
    pub fn import_batch(&self, entries: &[PasswordImportEntry]) -> Result<(u64, u64), String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn
            .transaction()
            .map_err(|e| format!("начать транзакцию импорта: {e}"))?;
        let mut seen = std::collections::HashSet::new();
        for row in rows_of(&tx)? {
            seen.insert((row.origin, unseal(&self.key, &row.user_enc)?));
        }
        let (mut added, mut existing) = (0u64, 0u64);
        for e in entries {
            if e.password.is_empty() {
                continue; // защита импортёра от самого себя (пустой логин
                // законен — записи «только пароль» из Chrome переносятся)
            }
            if seen.contains(&(e.origin.clone(), e.username.clone())) {
                existing += 1;
                continue;
            }
            tx.execute(
                "INSERT INTO logins (origin, url, title, user_enc, pass_enc, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?)",
                rusqlite::params![
                    e.origin,
                    e.url,
                    e.title,
                    seal(&self.key, &e.username)?,
                    seal(&self.key, &e.password)?,
                    e.created_at,
                    e.created_at
                ],
            )
            .map_err(|e| format!("вставить импортируемый логин: {e}"))?;
            seen.insert((e.origin.clone(), e.username.clone()));
            added += 1;
        }
        tx.commit().map_err(|e| format!("завершить импорт: {e}"))?;
        Ok((added, existing))
    }

    /// Сайты denylist «никогда не сохранять» (синк: часть документа).
    pub fn never_save_origins(&self) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT origin FROM never_save ORDER BY origin")
            .map_err(|e| format!("select never_save: {e}"))?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| format!("query never_save: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("прочитать never_save: {e}"))
    }

    /// Влить записи из облака (этап 4): пара (origin, username) — свежий
    /// `updated_at` выигрывает; при разном пароле проигравший остаётся
    /// записью-дублем «username (дубль)» — конфликт не разрешается молча,
    /// пользователь видит обе версии. Тот же пароль — тянется только мета.
    /// Denylist — объединение списков.
    pub fn merge_remote(
        &self,
        remote: &[FullLogin],
        never_save: &[String],
    ) -> Result<MergeStats, String> {
        let mut stats = MergeStats::default();
        let mut conn = self.conn.lock().unwrap();
        for r in remote {
            if r.password.is_empty() {
                continue; // мусорный документ не ломает слияние (пустой
                // логин законен — записи «только пароль», duopulse-194)
            }
            let mut local: Option<(i64, String, i64)> = None; // (id, пароль, updated_at)
            for row in rows_of(&conn)? {
                if row.origin == r.origin && unseal(&self.key, &row.user_enc)? == r.username {
                    local = Some((row.id, unseal(&self.key, &row.pass_enc)?, row.updated_at));
                    break;
                }
            }
            let Some((id, local_pass, local_updated)) = local else {
                conn.execute(
                    "INSERT INTO logins (origin, url, title, user_enc, pass_enc, created_at, updated_at)
                     VALUES (?,?,?,?,?,?,?)",
                    rusqlite::params![
                        r.origin,
                        r.url,
                        r.title,
                        seal(&self.key, &r.username)?,
                        seal(&self.key, &r.password)?,
                        r.created_at,
                        r.updated_at
                    ],
                )
                .map_err(|e| format!("вставить облачный логин: {e}"))?;
                stats.applied += 1;
                continue;
            };
            if local_pass == r.password {
                if r.updated_at > local_updated {
                    conn.execute(
                        "UPDATE logins SET url=?, title=?, updated_at=? WHERE id=?",
                        rusqlite::params![r.url, r.title, r.updated_at, id],
                    )
                    .map_err(|e| format!("обновить облачную мету: {e}"))?;
                    stats.applied += 1;
                }
                continue;
            }
            // Пароли разные: победитель — свежий updated_at, проигравший
            // сохраняется отдельной записью-дублем.
            let taken = usernames_of(&conn, &self.key, &r.origin)?;
            if r.updated_at > local_updated {
                // облако выиграло: локальная запись переезжает в «дубль»,
                // её слот занимает облачная версию
                let dupe = free_dupe_name(&taken, &r.username);
                conn.execute(
                    "UPDATE logins SET user_enc=?, updated_at=? WHERE id=?",
                    rusqlite::params![seal(&self.key, &dupe)?, now_ms(), id],
                )
                .map_err(|e| format!("переименовать проигравший логин: {e}"))?;
                conn.execute(
                    "INSERT INTO logins (origin, url, title, user_enc, pass_enc, created_at, updated_at)
                     VALUES (?,?,?,?,?,?,?)",
                    rusqlite::params![
                        r.origin,
                        r.url,
                        r.title,
                        seal(&self.key, &r.username)?,
                        seal(&self.key, &r.password)?,
                        r.created_at,
                        r.updated_at
                    ],
                )
                .map_err(|e| format!("вставить облачный логин: {e}"))?;
                stats.applied += 1;
            } else {
                // локальная выиграла: облачная версия — дублем рядом
                let dupe = free_dupe_name(&taken, &r.username);
                conn.execute(
                    "INSERT INTO logins (origin, url, title, user_enc, pass_enc, created_at, updated_at)
                     VALUES (?,?,?,?,?,?,?)",
                    rusqlite::params![
                        r.origin,
                        r.url,
                        r.title,
                        seal(&self.key, &dupe)?,
                        seal(&self.key, &r.password)?,
                        r.created_at,
                        r.updated_at
                    ],
                )
                .map_err(|e| format!("вставить дубль конфликта: {e}"))?;
            }
            stats.conflicts += 1;
        }
        for origin in never_save {
            conn.execute(
                "INSERT OR IGNORE INTO never_save (origin, created_at) VALUES (?,?)",
                rusqlite::params![origin, now_ms()],
            )
            .map_err(|e| format!("слить never_save: {e}"))?;
        }
        Ok(stats)
    }
}

/// Кандидат пакетного импорта (duopulse-183: перенос логинов из Chrome).
/// origin уже посчитан импортёром (origin_of), даты — из источника.
pub struct PasswordImportEntry {
    pub origin: String,
    pub url: String,
    pub title: String,
    pub username: String,
    pub password: String,
    pub created_at: i64,
}

/// Полная запись логина (синк, этап 4): пароль расшифрован — сериализуется
/// только в облачный блоб (шифруется ключом синка до отправки).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FullLogin {
    pub origin: String,
    pub url: String,
    pub title: String,
    pub username: String,
    pub password: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Итог слияния облачного набора в локальное хранилище.
#[derive(Debug, Default, Clone, Copy, Serialize)]
pub struct MergeStats {
    /// записей добавлено/обновлено из облака.
    pub applied: u64,
    /// конфликтов пароля: проигравший сохранён записью-дублем.
    pub conflicts: u64,
}

/// Юзернеймы сайта (для поиска свободного имени дубля) — расшифровываются
/// ключом хранилища.
fn usernames_of(conn: &Connection, key: &[u8; 32], origin: &str) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for row in rows_of(conn)? {
        if row.origin == origin {
            out.push(unseal(key, &row.user_enc)?);
        }
    }
    Ok(out)
}

/// Свободное имя для записи-дубля конфликта: «user (дубль)», «user (дубль 2)»…
fn free_dupe_name(taken: &[String], username: &str) -> String {
    let mut name = format!("{username} (дубль)");
    let mut n = 2;
    while taken.iter().any(|u| *u == name) {
        name = format!("{username} (дубль {n})");
        n += 1;
    }
    name
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> [u8; 32] {
        let mut k = [0u8; 32];
        k[..8].copy_from_slice(&1u64.to_le_bytes());
        k
    }

    fn store() -> PasswordStore {
        PasswordStore::open_in_memory(key()).unwrap()
    }

    #[test]
    fn seal_roundtrip_and_unique_ivs() {
        let k = key();
        let blob = seal(&k, "пароль 123").unwrap();
        assert_eq!(unseal(&k, &blob).unwrap(), "пароль 123");
        // случайный IV: одинаковый открытый текст — разные блобы
        let blob2 = seal(&k, "пароль 123").unwrap();
        assert_ne!(blob, blob2);
        // чужой ключ не расшифровывает
        let mut other = [0u8; 32];
        other[..8].copy_from_slice(&9u64.to_le_bytes());
        assert!(unseal(&other, &blob).is_err());
        assert!(unseal(&k, &[]).is_err());
        assert!(unseal(&k, &[0u8; 20]).is_err());
    }

    #[test]
    fn add_list_reveal_roundtrip() {
        let s = store();
        let saved = s
            .add(
                "https://example.com/login",
                Some("Example — вход"),
                "artem",
                "s3cret!",
            )
            .unwrap();
        assert!(!saved.updated);
        let res = s.list("", 100).unwrap();
        assert_eq!(res.total, 1);
        let e = &res.items[0];
        assert_eq!(e.origin, "https://example.com");
        assert_eq!(e.username, "artem");
        assert_eq!(e.title, "Example — вход");
        // в PasswordEntry попросту нет поля password — секрет наружу только
        // через reveal
        assert_eq!(s.reveal(e.id).unwrap(), "s3cret!");
    }

    #[test]
    fn db_has_no_plaintext_secrets() {
        let s = store();
        s.add("https://example.com/", None, "artem", "supersecret")
            .unwrap();
        // сырой файл: логина-username и пароля в открытом виде быть не должно
        // (проверяем через страницу БД — в памяти смотрим текстом)
        let conn = s.conn.lock().unwrap();
        let dump: String = conn
            .query_row("SELECT origin || char(10) || hex(user_enc) || char(10) || hex(pass_enc) FROM logins", [], |r| r.get(0))
            .unwrap();
        drop(conn);
        assert!(dump.contains("https://example.com"));
        assert!(!dump.contains("supersecret"));
        assert!(!dump.contains("617274656d")); // hex("artem")
    }

    #[test]
    fn upsert_same_login_updates() {
        let s = store();
        let first = s.add("https://example.com/", None, "artem", "old").unwrap();
        let second = s
            .add(
                "https://example.com/signin",
                Some("Example"),
                "artem",
                "new",
            )
            .unwrap();
        assert!(second.updated);
        assert_eq!(first.id, second.id);
        assert_eq!(s.list("", 100).unwrap().total, 1);
        assert_eq!(s.reveal(first.id).unwrap(), "new");
        // другой логин того же сайта — отдельная запись
        let third = s.add("https://example.com/", None, "alya", "x").unwrap();
        assert!(!third.updated);
        assert_eq!(s.list("", 100).unwrap().total, 2);
    }

    #[test]
    fn query_filter_case_insensitive() {
        let s = store();
        s.add("https://YouTube.com/", None, "artem", "x").unwrap();
        s.add("https://example.com/", None, "YouTuber", "y")
            .unwrap();
        assert_eq!(s.list("youtube", 100).unwrap().total, 2);
        assert_eq!(s.list("ARTEM", 100).unwrap().total, 1);
        assert_eq!(s.list("zzz", 100).unwrap().total, 0);
        assert_eq!(s.list("", 1).unwrap().items.len(), 1);
        assert_eq!(s.list("", 1).unwrap().total, 2);
    }

    #[test]
    fn update_changes_fields() {
        let s = store();
        let saved = s.add("https://example.com/", None, "artem", "old").unwrap();
        s.update(saved.id, None, Some("Example"), None, Some("new"))
            .unwrap();
        let e = &s.list("", 10).unwrap().items[0];
        assert_eq!(
            (e.username.as_str(), e.title.as_str()),
            ("artem", "Example")
        );
        assert_eq!(s.reveal(saved.id).unwrap(), "new");
        // смена адреса пересчитывает origin
        s.update(
            saved.id,
            Some("https://other.org/x"),
            None,
            Some("artem2"),
            None,
        )
        .unwrap();
        let e = &s.list("", 10).unwrap().items[0];
        assert_eq!(e.origin, "https://other.org");
        assert_eq!(e.username, "artem2");
        assert!(s.update(9999, None, None, None, Some("x")).is_err());
    }

    #[test]
    fn remove_is_idempotent() {
        let s = store();
        let saved = s.add("https://example.com/", None, "a", "b").unwrap();
        s.remove(saved.id).unwrap();
        s.remove(saved.id).unwrap();
        assert_eq!(s.list("", 10).unwrap().total, 0);
        assert!(s.reveal(saved.id).is_err());
    }

    #[test]
    fn origin_rules() {
        assert_eq!(
            origin_of("https://example.com/a?b=1").unwrap(),
            "https://example.com"
        );
        assert_eq!(origin_of("example.com").unwrap(), "https://example.com");
        assert_eq!(
            origin_of("http://example.com:8080/x").unwrap(),
            "http://example.com:8080"
        );
        assert_eq!(
            origin_of("https://example.com:443/").unwrap(),
            "https://example.com"
        );
        assert!(origin_of("ftp://example.com/").is_err());
        assert!(origin_of("не адрес").is_err());
    }

    #[test]
    fn key_file_persists_and_dead_key_resets() {
        let dir = std::env::temp_dir().join(format!("duopulse-pw-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // чистый запуск — ключ создаётся
        let k1 = load_or_create_key(&dir).unwrap();
        // второй запуск — тот же ключ (DPAPI roundtrip)
        let k2 = load_or_create_key(&dir).unwrap();
        assert_eq!(k1, k2);
        // файл существует, но не читается DPAPI (ключ ОС умер) — duopulse-153:
        // НЕ ошибка, а сброс — свежий ключ, старый не возвращается
        std::fs::write(dir.join("passwords.key"), b"garbage-not-dpapi").unwrap();
        let k3 = load_or_create_key(&dir).unwrap();
        assert_ne!(k3, k1, "мёртвый ключ — сброс на свежий");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// duopulse-153: сценарий телефона Артёма — снос приложения убил ключ
    /// Keystore, auto-backup вернул passwords.key и passwords.db. Открытие
    /// хранилища обязано жить (раньше — ошибка из setup-хука → краш на
    /// старте), невосстановимые логины сбрасываются, новое сохранение работает.
    #[test]
    fn dead_os_key_resets_store_and_app_opens() {
        let dir = std::env::temp_dir().join(format!("duopulse-pw-dead-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        {
            // было рабочее хранилище с записью
            let s = PasswordStore::open(&dir).unwrap();
            s.add("https://example.com/", None, "u", "p").unwrap();
            assert_eq!(s.list("", 10).unwrap().total, 1);
        }
        // ключ ОС умер: файл больше не расшифровывается
        std::fs::write(dir.join("passwords.key"), b"garbage-not-dpapi").unwrap();
        // ранее load_or_create_key возвращал ошибку → паника setup-хука
        let s = PasswordStore::open(&dir).unwrap();
        assert_eq!(s.list("", 10).unwrap().total, 0, "логины сброшены");
        // новое сохранение шифруется свежим ключом и читается
        s.add("https://other.org/", None, "artem", "secret").unwrap();
        assert_eq!(s.list("", 10).unwrap().total, 1);
        drop(s);
        // переоткрытие — данные на месте
        let s = PasswordStore::open(&dir).unwrap();
        assert_eq!(s.list("", 10).unwrap().total, 1);
        drop(s);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn open_with_file_and_reopen() {
        let dir = std::env::temp_dir().join(format!("duopulse-pw-file-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("t.db");
        {
            let s = PasswordStore::open_with_key(&db, key()).unwrap();
            s.add("https://example.com/", None, "u", "p").unwrap();
        }
        // повторное открытие тем же ключом — данные читаются
        let s = PasswordStore::open_with_key(&db, key()).unwrap();
        assert_eq!(s.list("", 10).unwrap().total, 1);
        // другим ключом — данные не расшифровываются (честная ошибка)
        let mut other = [0u8; 32];
        other[..8].copy_from_slice(&7u64.to_le_bytes());
        let s2 = PasswordStore::open_with_key(&db, other).unwrap();
        assert!(s2.list("", 10).is_err());
        drop(s2);
        drop(s);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn denylist_silences_only_prompts() {
        let s = store();
        assert!(!s.is_denied("https://example.com"));
        s.deny("https://example.com").unwrap();
        s.deny("https://example.com").unwrap(); // идемпотентно
        assert!(s.is_denied("https://example.com"));
        assert!(!s.is_denied("https://other.org"));
        // сохранённые до deny записи остаются и читаются автозаполнением
        s.add("https://example.com/", None, "artem", "x").unwrap();
        assert_eq!(
            s.accounts_for("https://example.com").unwrap(),
            vec!["artem"]
        );
        assert_eq!(
            s.credential("https://example.com", "artem")
                .unwrap()
                .as_deref(),
            Some("x")
        );
    }

    #[test]
    fn password_only_login_roundtrip() {
        let s = store();
        // роутер просит только пароль (duopulse-194): пустой логин — законный ключ
        let saved = s.add("http://192.168.31.1/", Some("Роутер"), "", "admin-pass").unwrap();
        assert!(!saved.updated);
        let res = s.list("", 10).unwrap();
        assert_eq!(res.total, 1);
        assert_eq!(res.items[0].username, "");
        assert_eq!(res.items[0].origin, "http://192.168.31.1");
        assert_eq!(s.reveal(saved.id).unwrap(), "admin-pass");
        // автозаполнение: пустой логин в списке, пароль по нему
        assert_eq!(s.accounts_for("http://192.168.31.1").unwrap(), vec![""]);
        assert_eq!(
            s.credential("http://192.168.31.1", "")
                .unwrap()
                .as_deref(),
            Some("admin-pass")
        );
        // смена пароля роутера — upsert по (origin, "")
        let again = s
            .add("http://192.168.31.1/", None, "", "new-pass")
            .unwrap();
        assert!(again.updated);
        assert_eq!(again.id, saved.id);
        assert_eq!(s.list("", 10).unwrap().total, 1);
        // именованный логин того же сайта живёт рядом отдельной записью
        s.add("http://192.168.31.1/", None, "guest", "g").unwrap();
        let mut acc = s.accounts_for("http://192.168.31.1").unwrap();
        acc.sort();
        assert_eq!(acc, vec!["", "guest"]);
    }

    #[test]
    fn import_keeps_password_only_entries() {
        let s = store();
        // Chrome хранит записи «только пароль» с пустым username_value —
        // импорт переносит их; мусор (пустое всё) отсеивается
        let (added, existing) = s
            .import_batch(&[
                PasswordImportEntry {
                    // origin импортёр уже нормализовал (origin_of): без слэша
                    origin: "http://192.168.31.1".into(),
                    url: "http://192.168.31.1/".into(),
                    title: "Роутер".into(),
                    username: String::new(),
                    password: "router-pass".into(),
                    created_at: 1000,
                },
                PasswordImportEntry {
                    origin: "https://junk.io/".into(),
                    url: String::new(),
                    title: String::new(),
                    username: String::new(),
                    password: String::new(),
                    created_at: 1000,
                },
            ])
            .unwrap();
        assert_eq!((added, existing), (1, 0));
        assert_eq!(
            s.credential("http://192.168.31.1", "")
                .unwrap()
                .as_deref(),
            Some("router-pass")
        );
        assert_eq!(s.list("", 10).unwrap().total, 1);
    }

    #[test]
    fn accounts_and_credential_scoped_by_origin() {
        let s = store();
        s.add("https://example.com/", None, "artem", "p1").unwrap();
        s.add("https://example.com/", None, "alya", "p2").unwrap();
        s.add("https://other.org/", None, "artem", "p3").unwrap();
        let mut accounts = s.accounts_for("https://example.com").unwrap();
        accounts.sort();
        assert_eq!(accounts, vec!["alya", "artem"]);
        // чужой сайт и чужой логин — пусто
        assert!(s.accounts_for("https://none.io").unwrap().is_empty());
        assert!(s
            .credential("https://example.com", "ghost")
            .unwrap()
            .is_none());
        assert!(s.credential("https://other.org", "alya").unwrap().is_none());
        assert_eq!(
            s.credential("https://other.org", "artem")
                .unwrap()
                .as_deref(),
            Some("p3")
        );
    }
}
