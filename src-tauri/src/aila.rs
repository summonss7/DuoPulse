//! Аккаунт Aila и синхронизация паролей (этап 4 цепочки duopulse-110):
//! вход в аккаунт семейного сервера Aila из DuoPulse и синк хранилища
//! паролей между устройствами через API appdata (этап 3, карточка Aila
//! aila-386). Без входа всё работает локально (этапы 1–2 не зависят).
//!
//! Протокол входа — как у веб-клиента Aila (app/src/lib/crypto.js):
//! POST /api/login/params {username} → соли (hex); локально выводятся
//! auth_hash = PBKDF2-SHA256(пароль, соль, 600 000, 32Б) — hex, единственное,
//! что уходит серверу, — и wrap_key (32Б), который не покидает устройство.
//! Для синка от wrap_key выводится отдельный ключ
//! HKDF-SHA256(wrap_key, salt="duopulse", info="duopulse-passwords-v1") — он
//! НЕ расшифровывает enc_vault чата Aila и хранится под DPAPI только пока
//! выполнен вход; выход — стереть. Сервер во всех сценариях видит один
//! ciphertext {iv, ct} (hex) = AES-256-GCM(sync_key, JSON хранилища).
//!
//! Сессия — httpOnly-кука aila_sess (180 дней): токен тоже под DPAPI
//! (`aila.token`), несекретные username/display/server — `aila-account.json`
//! в профиле. Смена пароля Aila → wrap_key меняется → повторный вход;
//! локальные данные при этом не теряются, блоб перезаливается новым ключом.
//!
//! Слияние (по origin+username): свежий updated_at выигрывает, проигравший
//! пароль остаётся записью-дублем — конфликт не разрешается молча
//! (passwords::PasswordStore::merge_remote). Триггеры синка: старт после
//! восстановления сессии, локальные правки паролей (дебаунс 3 с, бэкофф
//! при ошибках 30 с → 10 мин) и кнопка в настройках (aila.sync_now).

use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;

use crate::passwords::{FullLogin, PasswordStore};

/// Семейный сервер по умолчанию (туннель Cloudflare домашнего ПК);
/// DUOPULSE_AILA_SERVER переопределяет (e2e-стенд на localhost).
pub const DEFAULT_SERVER: &str = "https://aila.skillcoin.pp.ua";
const COOKIE_NAME: &str = "aila_sess";
const APP_ID: &str = "duopulse";
const KEY_ID: &str = "passwords";
const PBKDF2_ITERS: u32 = 600_000;
/// Дебаунс авто-синка после локальных правок.
const SYNC_DEBOUNCE: Duration = Duration::from_secs(3);

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
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

/// PBKDF2-SHA256(пароль, соль-из-hex, 600k) → 32Б (как deriveAuthPair Aila).
fn pbkdf2_32(password: &str, salt_hex: &str) -> Result<[u8; 32], String> {
    let salt = decode_hex(salt_hex)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "соль сервера Aila не похожа на hex".to_string())?;
    let mut out = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(password.as_bytes(), &salt, PBKDF2_ITERS, &mut out);
    Ok(out)
}

/// Ключ синка: HKDF-SHA256(wrap_key, salt="duopulse", info="duopulse-passwords-v1").
fn sync_key_of(wrap_key: &[u8; 32]) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(Some(b"duopulse"), wrap_key);
    let mut out = [0u8; 32];
    hk.expand(b"duopulse-passwords-v1", &mut out).expect("32Б ок");
    out
}

/// JSON-документ облачного блоба (шифруется целиком).
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultDoc {
    v: u8,
    #[serde(default)]
    logins: Vec<FullLogin>,
    #[serde(default)]
    never_save: Vec<String>,
}

/// {iv, ct} hex — формат блоба API appdata.
fn seal_blob(key: &[u8; 32], doc: &VaultDoc) -> Result<serde_json::Value, String> {
    let plain = serde_json::to_vec(doc).map_err(|e| format!("сериализация хранилища: {e}"))?;
    let mut iv = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut iv);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("ключ AES: {e}"))?;
    let ct = cipher
        .encrypt(Nonce::from_slice(&iv), plain.as_slice())
        .map_err(|_| "зашифровать блоб синка".to_string())?;
    Ok(serde_json::json!({ "iv": encode_hex(&iv), "ct": encode_hex(&ct) }))
}

fn open_blob(key: &[u8; 32], blob: &serde_json::Value) -> Result<VaultDoc, String> {
    let iv = decode_hex(blob.get("iv").and_then(|v| v.as_str()).unwrap_or(""))
        .filter(|v| v.len() == 12)
        .ok_or("блоб синка без IV")?;
    let ct = decode_hex(blob.get("ct").and_then(|v| v.as_str()).unwrap_or(""))
        .filter(|v| !v.is_empty())
        .ok_or("блоб синка без данных")?;
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("ключ AES: {e}"))?;
    let plain = cipher
        .decrypt(Nonce::from_slice(&iv), ct.as_slice())
        .map_err(|_| {
            "не удалось расшифровать облачный блоб — похоже, пароль Aila сменился: \
             выйдите из аккаунта и войдите снова (локальные пароли на месте)"
                .to_string()
        })?;
    serde_json::from_slice(&plain).map_err(|e| format!("документ хранилища битый: {e}"))
}

/// Состояние входа (пока Some — синк активен).
#[derive(Debug, Default, Clone)]
struct Session {
    username: String,
    display_name: String,
    server: String,
    token: String,
    sync_key: [u8; 32],
    revision: u64,
    last_sync_at: Option<i64>,
    last_error: Option<String>,
}

#[derive(Default)]
struct WorkerCtl {
    dirty: bool,
    backoff_secs: u64,
}

/// Аккаунт Aila: сессия + воркер синка. Управляется main (Arc), команды —
/// bridge (aila.status/login/logout/sync_now).
pub struct AilaAccount {
    profile_dir: PathBuf,
    session: Mutex<Option<Session>>,
    ctl_pair: (Mutex<WorkerCtl>, Condvar),
}

fn http_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
}

/// JSON-запрос (POST/PUT); ответ — (статус, тело, set-cookie). Куку сессии
/// шлём заголовком вручную: хранит её профиль под DPAPI, кука ставится
/// только самим входом.
fn send_json(
    agent: &ureq::Agent,
    method: &str,
    url: &str,
    body: &serde_json::Value,
    token: Option<&str>,
) -> Result<(u16, String, Option<String>), String> {
    let mut req = match method {
        "PUT" => agent.put(url),
        _ => agent.post(url),
    }
    .set("Content-Type", "application/json");
    if let Some(t) = token {
        req = req.set("Cookie", &format!("{COOKIE_NAME}={t}"));
    }
    let resp = req
        .send_string(&serde_json::to_string(body).unwrap_or_default())
        .map_err(|e| format!("сервер Aila недоступен: {e}"))?;
    let set_cookie = resp.header("set-cookie").map(|s| s.to_string());
    let status = resp.status();
    let text = resp
        .into_string()
        .map_err(|e| format!("ответ сервера Aila: {e}"))?;
    Ok((status, text, set_cookie))
}

fn get_json(agent: &ureq::Agent, url: &str, token: &str) -> Result<(u16, String), String> {
    let resp = agent
        .get(url)
        .set("Cookie", &format!("{COOKIE_NAME}={token}"))
        .call()
        .map_err(|e| format!("сервер Aila недоступен: {e}"))?;
    let status = resp.status();
    let text = resp
        .into_string()
        .map_err(|e| format!("ответ сервера Aila: {e}"))?;
    Ok((status, text))
}

/// Значение куки aila_sess из Set-Cookie ответа входа.
fn token_of_set_cookie(header: &str) -> Option<String> {
    let pair = header.split(';').next()?;
    let (name, value) = pair.split_once('=')?;
    if name.trim() == COOKIE_NAME && !value.trim().is_empty() {
        Some(value.trim().to_string())
    } else {
        None
    }
}

/// Адрес сервера: env DUOPULSE_AILA_SERVER (e2e) или семейный по умолчанию.
pub fn server_url() -> String {
    std::env::var("DUOPULSE_AILA_SERVER")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_SERVER.to_string())
}

impl AilaAccount {
    pub fn new(profile_dir: &std::path::Path) -> Self {
        Self {
            profile_dir: profile_dir.to_path_buf(),
            session: Mutex::new(None),
            ctl_pair: (Mutex::new(WorkerCtl::default()), Condvar::new()),
        }
    }

    /// Восстановить сохранённый вход (token/sync-ключ под DPAPI). Сессия
    /// могла протухнуть — воркер это увидит первым же синком (401).
    pub fn restore(self: &Arc<Self>) {
        let json_path = self.profile_dir.join("aila-account.json");
        let Ok(text) = std::fs::read_to_string(&json_path) else {
            return;
        };
        let Ok(doc) = serde_json::from_str::<serde_json::Value>(&text) else {
            let _ = std::fs::remove_file(&json_path); // битый — не повод падать
            return;
        };
        let token_path = self.profile_dir.join("aila.token");
        let key_path = self.profile_dir.join("aila.sync.key");
        let (Some(token), Some(key_hex)) = (
            crate::secrets::load(&token_path),
            crate::secrets::load(&key_path),
        ) else {
            return;
        };
        let Some(key_bytes) = decode_hex(&key_hex).filter(|b| b.len() == 32) else {
            return;
        };
        let mut sync_key = [0u8; 32];
        sync_key.copy_from_slice(&key_bytes);
        let mut session = Session {
            username: doc["username"].as_str().unwrap_or_default().to_string(),
            display_name: doc["displayName"].as_str().unwrap_or_default().to_string(),
            server: doc["server"].as_str().unwrap_or_default().to_string(),
            token,
            sync_key,
            ..Session::default()
        };
        if session.username.is_empty() || session.server.is_empty() {
            return;
        }
        session.revision = doc["revision"].as_u64().unwrap_or(0);
        session.last_sync_at = doc["lastSyncAt"].as_i64();
        *self.session.lock().unwrap() = Some(session);
    }

    /// Воркер авто-синка: ждёт «грязно» (правки паролей/вход/повтор ошибки),
    /// дебаунсит, синкает; при ошибке — бэкофф 30с → 2м → 10м (правка за это
    /// время будит воркер сразу).
    pub fn start_worker(self: &Arc<Self>, store: Arc<PasswordStore>) {
        let account = Arc::clone(self);
        std::thread::spawn(move || {
            let (lock, cvar) = &account.ctl_pair;
            loop {
                let mut ctl = lock.lock().unwrap();
                while !ctl.dirty {
                    ctl = cvar.wait(ctl).unwrap();
                }
                ctl.dirty = false;
                drop(ctl);
                // дебаунс: правки сыплются серией — собираем одну синхронизацию
                std::thread::sleep(SYNC_DEBOUNCE);
                let res = account.sync_round(&store);
                let mut ctl = lock.lock().unwrap();
                match res {
                    Ok(_) => {
                        ctl.backoff_secs = 0;
                    }
                    Err(e) => {
                        ctl.backoff_secs = match ctl.backoff_secs {
                            0 => 30,
                            s if s >= 600 => 600,
                            s => s * 2,
                        };
                        if let Some(sess) = account.session.lock().unwrap().as_mut() {
                            sess.last_error = Some(e);
                        }
                        eprintln!("[aila] синк не удался, повтор через {}с", ctl.backoff_secs);
                        let backoff = Duration::from_secs(ctl.backoff_secs);
                        let (mut c2, _) = cvar.wait_timeout(ctl, backoff).unwrap();
                        c2.dirty = true; // повторить попытку (или свежая правка)
                    }
                }
            }
        });
    }

    /// Пометить локальные пароли изменёнными — воркер синканет с дебаунсом.
    pub fn schedule_sync(&self) {
        let (lock, cvar) = &self.ctl_pair;
        let mut ctl = lock.lock().unwrap();
        ctl.dirty = true;
        cvar.notify_all();
    }

    /// Вход: соли → PBKDF2 → /api/login → сохранить сессию и ключ синка.
    /// При успехе локальные пароли (накопленные до входа) уходят в облако
    /// первым же синком (schedule_sync зовёт команда после login).
    pub fn login(&self, username: &str, password: &str) -> Result<(), String> {
        let username = username.trim();
        if username.is_empty() || password.is_empty() {
            return Err("имя и пароль не заполнены".into());
        }
        let server = server_url();
        let agent = http_agent();
        // 1) соли (несуществующий юзер получает фейковые — вход честно падает)
        let (_, text, _) = send_json(
            &agent, "POST",
            &format!("{server}/api/login/params"),
            &serde_json::json!({ "username": username }),
            None,
        )?;
        let params: serde_json::Value = serde_json::from_str(&text)
            .map_err(|_| "странный ответ /api/login/params".to_string())?;
        let auth_salt = params["auth_salt"].as_str().unwrap_or_default().to_string();
        let wrap_salt = params["wrap_salt"].as_str().unwrap_or_default().to_string();
        // 2) вывод ключей (600k итераций — до секунды)
        let auth_hash = encode_hex(&pbkdf2_32(password, &auth_salt)?);
        let wrap_key = pbkdf2_32(password, &wrap_salt)?;
        // 3) вход — серверу уходит только auth_hash
        let (status, text, set_cookie) = send_json(
            &agent, "POST",
            &format!("{server}/api/login"),
            &serde_json::json!({
                "username": username,
                "auth_hash": auth_hash,
                "device": "DuoPulse (настольный)",
            }),
            None,
        )?;
        match status {
            200 => {}
            401 => return Err("неверное имя или пароль".into()),
            429 => return Err("слишком много попыток входа — подождите 15 минут".into()),
            _ => return Err(format!("сервер Aila ответил {status}")),
        }
        let Some(token) = set_cookie.as_deref().and_then(token_of_set_cookie) else {
            return Err("сервер Aila не выдал сессию (нет куки aila_sess)".into());
        };
        let doc: serde_json::Value = serde_json::from_str(&text)
            .map_err(|_| "странный ответ /api/login".to_string())?;
        let display_name = doc["user"]["display_name"]
            .as_str()
            .unwrap_or(username)
            .to_string();
        // 4) ключ синка и токен под DPAPI + несекретная метка аккаунта
        let sync_key = sync_key_of(&wrap_key);
        crate::secrets::save(&self.profile_dir.join("aila.token"), &token)?;
        crate::secrets::save(&self.profile_dir.join("aila.sync.key"), &encode_hex(&sync_key))?;
        let _ = std::fs::write(
            self.profile_dir.join("aila-account.json"),
            serde_json::json!({
                "username": username,
                "displayName": display_name,
                "server": server,
            })
            .to_string(),
        );
        *self.session.lock().unwrap() = Some(Session {
            username: username.to_string(),
            display_name,
            server,
            token,
            sync_key,
            ..Session::default()
        });
        Ok(())
    }

    /// Выход: локальные пароли остаются; сессия на сервере гасится лучшим
    /// усилием (сбой сети выйти не мешает), ключи стираются.
    pub fn logout(&self) {
        let sess = self.session.lock().unwrap().take();
        if let Some(s) = &sess {
            let agent = http_agent();
            let _ = send_json(
                &agent, "POST",
                &format!("{}/api/logout", s.server),
                &serde_json::json!({}),
                Some(&s.token),
            );
        }
        crate::secrets::clear(&self.profile_dir.join("aila.token"));
        crate::secrets::clear(&self.profile_dir.join("aila.sync.key"));
        let _ = std::fs::remove_file(self.profile_dir.join("aila-account.json"));
    }

    /// Один круг синхронизации: pull → merge → push (если разошлись).
    /// Возвращает (записей в облаке, применено, конфликтов, push?, revision).
    fn sync_round(
        self: &Arc<Self>,
        store: &PasswordStore,
    ) -> Result<(u64, u64, u64, bool, u64), String> {
        let (server, token, sync_key) = {
            let guard = self.session.lock().unwrap();
            let s = guard.as_ref().ok_or("нет входа в аккаунт Aila")?;
            (s.server.clone(), s.token.clone(), s.sync_key)
        };
        let agent = http_agent();
        let url = format!("{server}/api/appdata?app={APP_ID}&key={KEY_ID}");
        // --- pull ---
        let (status, text) = get_json(&agent, &url, &token)?;
        match status {
            200 => {}
            401 => return Err("сессия Aila истекла — выйдите и войдите снова".into()),
            _ => return Err(format!("GET appdata: сервер ответил {status}")),
        }
        let pulled: serde_json::Value =
            serde_json::from_str(&text).map_err(|_| "странный ответ /api/appdata".to_string())?;
        let mut revision = pulled["revision"].as_u64().unwrap_or(0);
        let remote_doc = match pulled["blob"].as_object() {
            Some(blob) if !blob.is_empty() => Some(open_blob(&sync_key, &pulled["blob"])?),
            _ => None,
        };
        let (remote_logins, remote_never, remote_count) = match remote_doc.as_ref() {
            Some(doc) => (doc.logins.clone(), doc.never_save.clone(), doc.logins.len() as u64),
            None => (Vec::new(), Vec::new(), 0),
        };
        // --- merge (локальные правки при этом остаются — push ниже) ---
        let stats = store.merge_remote(&remote_logins, &remote_never)?;
        // --- push, если документы разошлись ---
        let local_doc = VaultDoc {
            v: 1,
            logins: store.export_full()?,
            never_save: store.never_save_origins()?,
        };
        let same_as_remote = remote_doc
            .as_ref()
            .map(|d| serde_json::to_value(d).ok() == serde_json::to_value(&local_doc).ok())
            == Some(true);
        let mut pushed = false;
        if !same_as_remote {
            let blob = seal_blob(&sync_key, &local_doc)?;
            let (status, text, _) = send_json(
                &agent, "PUT",
                &format!("{server}/api/appdata"),
                &serde_json::json!({
                    "app": APP_ID, "key": KEY_ID, "blob": blob, "if_match": revision,
                }),
                Some(&token),
            )?;
            match status {
                200 => {
                    let doc: serde_json::Value = serde_json::from_str(&text)
                        .map_err(|_| "странный ответ PUT appdata".to_string())?;
                    revision = doc["revision"].as_u64().unwrap_or(revision);
                    pushed = true;
                }
                409 => {
                    // второе устройство успело записать — вливаем свежий блоб
                    // и повторяем один раз; постоянный конфликт решит
                    // следующий круг (последняя запись выигрывает)
                    let winner: serde_json::Value = serde_json::from_str(&text)
                        .map_err(|_| "странный ответ конфликта appdata".to_string())?;
                    let winner_doc = match winner["blob"].as_object() {
                        Some(b) if !b.is_empty() => Some(open_blob(&sync_key, &winner["blob"])?),
                        _ => None,
                    };
                    if let Some(d) = winner_doc {
                        store.merge_remote(&d.logins, &d.never_save)?;
                    }
                    revision = winner["revision"].as_u64().unwrap_or(revision);
                    let merged = VaultDoc {
                        v: 1,
                        logins: store.export_full()?,
                        never_save: store.never_save_origins()?,
                    };
                    let (status2, text2, _) = send_json(
                        &agent, "PUT",
                        &format!("{server}/api/appdata"),
                        &serde_json::json!({
                            "app": APP_ID, "key": KEY_ID,
                            "blob": seal_blob(&sync_key, &merged)?,
                            "if_match": revision,
                        }),
                        Some(&token),
                    )?;
                    match status2 {
                        200 => {
                            let doc: serde_json::Value = serde_json::from_str(&text2)
                                .map_err(|_| "странный ответ PUT appdata".to_string())?;
                            revision = doc["revision"].as_u64().unwrap_or(revision);
                            pushed = true;
                        }
                        409 => {
                            return Err(
                                "конфликт синка не разрешился за два круга — повтор позже".into()
                            )
                        }
                        _ => return Err(format!("PUT appdata: сервер ответил {status2}")),
                    }
                }
                401 => return Err("сессия Aila истекла — выйдите и войдите снова".into()),
                _ => return Err(format!("PUT appdata: сервер ответил {status}")),
            }
        }
        let mut guard = self.session.lock().unwrap();
        if let Some(s) = guard.as_mut() {
            s.revision = revision;
            s.last_sync_at = Some(now_ms());
            s.last_error = None;
            let _ = std::fs::write(
                self.profile_dir.join("aila-account.json"),
                serde_json::json!({
                    "username": s.username,
                    "displayName": s.display_name,
                    "server": s.server,
                    "revision": revision,
                    "lastSyncAt": s.last_sync_at,
                })
                .to_string(),
            );
        }
        Ok((remote_count, stats.applied, stats.conflicts, pushed, revision))
    }

    /// Синхронизировать сейчас (кнопка в настройках): тот же круг, что у
    /// воркера, но синхронно — статистика уходит в UI.
    pub fn sync_now(
        self: &Arc<Self>,
        store: &PasswordStore,
    ) -> Result<(u64, u64, u64, bool, u64), String> {
        self.sync_round(store)
    }

    /// Снимок состояния для UI:
    /// (вход?, username, display, сервер, revision, последний синк, ошибка).
    pub fn status(&self) -> (bool, String, String, String, u64, Option<i64>, Option<String>) {
        let guard = self.session.lock().unwrap();
        match guard.as_ref() {
            None => (false, String::new(), String::new(), server_url(), 0, None, None),
            Some(s) => (
                true,
                s.username.clone(),
                s.display_name.clone(),
                s.server.clone(),
                s.revision,
                s.last_sync_at,
                s.last_error.clone(),
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(seed: u64) -> [u8; 32] {
        let mut k = [0u8; 32];
        k[..8].copy_from_slice(&seed.to_le_bytes());
        k
    }

    #[test]
    fn hex_roundtrip() {
        assert_eq!(encode_hex(&[0xde, 0xad]), "dead");
        assert_eq!(decode_hex("dead").unwrap(), vec![0xde, 0xad]);
        assert!(decode_hex("abc").is_none());
        assert!(decode_hex("zz").is_none());
    }

    #[test]
    fn pbkdf2_deterministic_and_salt_sensitive() {
        // формат/детерминизм; точное совпадение с веб-клиентом Aila
        // (те же параметры PBKDF2-SHA256/600k/hex-соль) проверено живым
        // входом в e2e (e2e/passwords/sync.mjs)
        let a = pbkdf2_32("пароль", "0011223344556677").unwrap();
        let b = pbkdf2_32("пароль", "0011223344556677").unwrap();
        assert_eq!(a, b);
        assert_ne!(a, pbkdf2_32("пароль0", "0011223344556677").unwrap());
        assert_ne!(a, pbkdf2_32("пароль", "ff11223344556677").unwrap());
        assert!(pbkdf2_32("пароль", "не-hex!").is_err());
    }

    #[test]
    fn sync_key_is_hkdf_of_wrap_key() {
        let wrap = key(7);
        let k1 = sync_key_of(&wrap);
        assert_eq!(k1, sync_key_of(&wrap)); // детерминизм
        assert_ne!(k1, wrap); // не сам wrap_key (чата Aila не касается)
        assert_ne!(k1, sync_key_of(&key(8)));
        // другой info → другой ключ
        let hk = Hkdf::<Sha256>::new(Some(b"duopulse"), &wrap);
        let mut other = [0u8; 32];
        hk.expand(b"other-info", &mut other).expect("ок");
        assert_ne!(k1, other);
    }

    #[test]
    fn blob_roundtrip_and_wrong_key_fails() {
        let doc = VaultDoc {
            v: 1,
            logins: vec![FullLogin {
                origin: "https://example.com".into(),
                url: "https://example.com/login".into(),
                title: "Example".into(),
                username: "artem".into(),
                password: "s3cret!".into(),
                created_at: 1,
                updated_at: 2,
            }],
            never_save: vec!["https://spam.io".into()],
        };
        let blob = seal_blob(&key(1), &doc).unwrap();
        // сервер видит только hex-поля
        assert_eq!(blob["iv"].as_str().unwrap().len(), 24);
        assert!(!blob["ct"].as_str().unwrap().contains("s3cret"));
        let back = open_blob(&key(1), &blob).unwrap();
        assert_eq!(back.logins.len(), 1);
        assert_eq!(back.logins[0].password, "s3cret!");
        assert_eq!(back.never_save, vec!["https://spam.io".to_string()]);
        // чужой ключ — честная ошибка
        assert!(open_blob(&key(2), &blob).is_err());
        assert!(open_blob(&key(1), &serde_json::json!({ "iv": "xx", "ct": "yy" })).is_err());
    }

    #[test]
    fn set_cookie_parsing() {
        assert_eq!(
            token_of_set_cookie("aila_sess=abc123; Path=/; HttpOnly; Max-Age=15552000"),
            Some("abc123".to_string())
        );
        assert_eq!(token_of_set_cookie("other=x; aila_sess=y"), None);
        assert_eq!(token_of_set_cookie("aila_sess="), None);
        assert_eq!(token_of_set_cookie(""), None);
    }

    #[test]
    fn store_merge_scenarios() {
        // изоляция от DPAPI: явный ключ, БД в temp-каталоге
        let dir = std::env::temp_dir().join(format!("duopulse-aila-merge-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = PasswordStore::open_with_key(&dir.join("m.db"), key(3)).unwrap();
        // локальная запись ДО входа — при первом синке уезжает в облако
        store
            .add("https://example.com/login", Some("Example"), "artem", "local-pass")
            .unwrap();

        // облако: тот же сайт, тот же юзер, СТАРЫЙ пароль — локальная
        // выигрывает, облачный пароль остаётся записью-дублем
        let remote_old = FullLogin {
            origin: "https://example.com".into(),
            url: "https://example.com/login".into(),
            title: "Example".into(),
            username: "artem".into(),
            password: "cloud-old".into(),
            created_at: 1,
            updated_at: 1,
        };
        let st = store.merge_remote(std::slice::from_ref(&remote_old), &[]).unwrap();
        assert_eq!((st.applied, st.conflicts), (0, 1));
        let full = store.export_full().unwrap();
        assert_eq!(full.len(), 2);
        assert!(full.iter().any(|f| f.password == "local-pass" && f.username == "artem"));
        assert!(full
            .iter()
            .any(|f| f.password == "cloud-old" && f.username.contains("дубль")));

        // облако: тот же сайт, тот же юзер, НОВЫЙ пароль (свежее) —
        // выигрывает, прежние пароли остаются дублями (ничего не потеряно)
        let remote_new = FullLogin {
            origin: "https://example.com".into(),
            url: "https://example.com/login".into(),
            title: "Example".into(),
            username: "artem".into(),
            password: "cloud-new".into(),
            created_at: 1,
            updated_at: now_ms() + 1000,
        };
        let st = store.merge_remote(std::slice::from_ref(&remote_new), &[]).unwrap();
        assert_eq!(st.applied, 1);
        let full = store.export_full().unwrap();
        assert!(full
            .iter()
            .any(|f| f.password == "cloud-new" && f.username == "artem"));
        assert!(full.iter().any(|f| f.password == "local-pass"));
        assert!(full.iter().any(|f| f.password == "cloud-old"));

        // тот же пароль, свежая мета — обновление без дубля
        let same = FullLogin {
            origin: "https://example.com".into(),
            url: "https://example.com/signin".into(),
            title: "Example 2".into(),
            username: "artem".into(),
            password: "cloud-new".into(),
            created_at: 1,
            updated_at: now_ms() + 2000,
        };
        let before = store.export_full().unwrap().len();
        let st = store.merge_remote(std::slice::from_ref(&same), &[]).unwrap();
        assert_eq!(st.conflicts, 0);
        assert_eq!(store.export_full().unwrap().len(), before);

        // denylist — объединение
        store.merge_remote(&[], &["https://spam.io".into()]).unwrap();
        assert!(store.is_denied("https://spam.io"));
        drop(store); // SQLite держит файл — закрываем до удаления каталога
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
