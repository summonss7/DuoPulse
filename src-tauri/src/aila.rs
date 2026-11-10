//! Аккаунт Aila и синхронизация паролей с закладками (этап 4 duopulse-110,
//! этап 5 duopulse-111): вход в аккаунт семейного сервера Aila из DuoPulse
//! и синк хранилищ между устройствами через API appdata (этап 3, карточка
//! Aila aila-386; пароли — ключ "passwords", закладки — ключ "bookmarks").
//! Без входа всё работает локально (этапы 1–2 не зависят).
//!
//! Протокол входа — как у веб-клиента Aila (app/src/lib/crypto.js):
//! POST /api/login/params {username} → соли (hex); локально выводятся
//! auth_hash = PBKDF2-SHA256(пароль, соль, 600 000, 32Б) — hex, единственное,
//! что уходит серверу, — и wrap_key (32Б), который не покидает устройство.
//! Для синка от wrap_key выводится отдельный ключ
//! HKDF-SHA256(wrap_key, salt="duopulse", info="duopulse-passwords-v1") — он
//! НЕ расшифровывает enc_vault чата Aila и хранится под DPAPI только пока
//! выполнен вход; выход — стереть. Ключ закладок (этап 5) выводится цепочкой
//! от ключа паролей: HKDF-SHA256(passwords_key, salt="duopulse",
//! info="duopulse-bookmarks-v1") — домены разделены, а сессии этапа 4
//! (под DPAPI лежит только ключ паролей) получают совместимый ключ без
//! повторного входа. Сервер во всех сценариях видит один ciphertext
//! {iv, ct} (hex) = AES-256-GCM(sync_key, JSON хранилища) на каждый ключ.
//!
//! Сессия — httpOnly-кука aila_sess (180 дней): токен тоже под DPAPI
//! (`aila.token`), несекретные username/display/server — `aila-account.json`
//! в профиле. Смена пароля Aila → wrap_key меняется → повторный вход;
//! локальные данные при этом не теряются, блобы перезаливаются новым ключом.
//!
//! Слияние паролей (по origin+username): свежий updated_at выигрывает,
//! проигравший пароль остаётся записью-дублем — конфликт не разрешается
//! молча (passwords::PasswordStore::merge_remote). Закладки — объединение
//! по url, группы — по имени, удаление — надгробием
//! (history::HistoryStore::merge_sync_doc). Триггеры синка: старт после
//! восстановления сессии, локальные правки паролей/закладок (дебаунс 3 с,
//! бэкофф при ошибках 30 с → 10 мин) и кнопка в настройках (aila.sync_now).

use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;

use crate::history::{BookmarkSyncDoc, HistoryStore};
use crate::passwords::{FullLogin, PasswordStore};

/// Семейный сервер по умолчанию (туннель Cloudflare домашнего ПК);
/// DUOPULSE_AILA_SERVER переопределяет (e2e-стенд на localhost).
pub const DEFAULT_SERVER: &str = "https://aila.skillcoin.pp.ua";
const COOKIE_NAME: &str = "aila_sess";
const APP_ID: &str = "duopulse";
const KEY_PASSWORDS: &str = "passwords";
const KEY_BOOKMARKS: &str = "bookmarks";
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

/// Ключ синка закладок (этап 5 duopulse-111): цепочка от ключа паролей —
/// HKDF-SHA256(passwords_key, salt="duopulse", info="duopulse-bookmarks-v1").
/// Цепочка, а не повторный вывод из wrap_key: под DPAPI этап 4 сохранил
/// только ключ паролей, wrap_key на устройстве не лежит — так сессии этапа 4
/// получают ключ закладок без повторного входа, а домены попарно разделены.
fn bookmarks_key_of(passwords_key: &[u8; 32]) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(Some(b"duopulse"), passwords_key);
    let mut out = [0u8; 32];
    hk.expand(b"duopulse-bookmarks-v1", &mut out).expect("32Б ок");
    out
}

/// JSON-документ облачного блоба паролей (шифруется целиком).
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultDoc {
    v: u8,
    #[serde(default)]
    logins: Vec<FullLogin>,
    #[serde(default)]
    never_save: Vec<String>,
}

/// {iv, ct} hex — формат блоба API appdata (любой сериализуемый документ).
fn seal_blob<D: serde::Serialize>(key: &[u8; 32], doc: &D) -> Result<serde_json::Value, String> {
    let plain = serde_json::to_vec(doc).map_err(|e| format!("сериализация хранилища: {e}"))?;
    let mut iv = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut iv);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("ключ AES: {e}"))?;
    let ct = cipher
        .encrypt(Nonce::from_slice(&iv), plain.as_slice())
        .map_err(|_| "зашифровать блоб синка".to_string())?;
    Ok(serde_json::json!({ "iv": encode_hex(&iv), "ct": encode_hex(&ct) }))
}

fn open_blob<D: serde::de::DeserializeOwned>(key: &[u8; 32], blob: &serde_json::Value) -> Result<D, String> {
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
             выйдите из аккаунта и войдите снова (локальные данные на месте)"
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
    bookmarks_key: [u8; 32],
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

    /// Восстановить сохранённый вход (token/sync-ключи под DPAPI). Ответ —
    /// был ли вход восстановлен (main тогда будит воркер первым синком).
    /// Сессия могла протухнуть — воркер это увидит первым же синком (401).
    pub fn restore(self: &Arc<Self>) -> bool {
        let json_path = self.profile_dir.join("aila-account.json");
        let Ok(text) = std::fs::read_to_string(&json_path) else {
            eprintln!("[aila] restore: нет aila-account.json");
            return false;
        };
        let Ok(doc) = serde_json::from_str::<serde_json::Value>(&text) else {
            let _ = std::fs::remove_file(&json_path); // битый — не повод падать
            eprintln!("[aila] restore: aila-account.json битый — удалён");
            return false;
        };
        let token_path = self.profile_dir.join("aila.token");
        let key_path = self.profile_dir.join("aila.sync.key");
        let (Some(token), Some(key_hex)) = (
            crate::secrets::load(&token_path),
            crate::secrets::load(&key_path),
        ) else {
            eprintln!(
                "[aila] restore: DPAPI-секреты не читаются (token={}, key={})",
                token_path.exists(),
                key_path.exists()
            );
            return false;
        };
        let Some(key_bytes) = decode_hex(&key_hex).filter(|b| b.len() == 32) else {
            eprintln!("[aila] restore: aila.sync.key не hex-32Б");
            return false;
        };
        let mut sync_key = [0u8; 32];
        sync_key.copy_from_slice(&key_bytes);
        let mut session = Session {
            username: doc["username"].as_str().unwrap_or_default().to_string(),
            display_name: doc["displayName"].as_str().unwrap_or_default().to_string(),
            server: doc["server"].as_str().unwrap_or_default().to_string(),
            token,
            sync_key,
            bookmarks_key: bookmarks_key_of(&sync_key),
            ..Session::default()
        };
        if session.username.is_empty() || session.server.is_empty() {
            eprintln!("[aila] restore: аккаунт без username/server");
            return false;
        }
        session.revision = doc["revision"].as_u64().unwrap_or(0);
        session.last_sync_at = doc["lastSyncAt"].as_i64();
        eprintln!("[aila] restore: сессия {} восстановлена", session.username);
        *self.session.lock().unwrap() = Some(session);
        true
    }

    /// Воркер авто-синка: ждёт «грязно» (правки паролей/закладок/вход/повтор
    /// ошибки), дебаунсит, синкает оба хранилища; при ошибке — бэкофф 30с →
    /// 2м → 10м (правка за это время будит воркер сразу).
    pub fn start_worker(self: &Arc<Self>, passwords: Arc<PasswordStore>, history: Arc<HistoryStore>) {
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
                let res = account.sync_round(&passwords, &history);
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
                            sess.last_error = Some(e.clone());
                        }
                        eprintln!(
                            "[aila] синк не удался: {e} — повтор через {}с",
                            ctl.backoff_secs
                        );
                        let backoff = Duration::from_secs(ctl.backoff_secs);
                        let (mut c2, _) = cvar.wait_timeout(ctl, backoff).unwrap();
                        c2.dirty = true; // повторить попытку (или свежая правка)
                    }
                }
            }
        });
    }

    /// Пометить локальные данные изменёнными — воркер синканет с дебаунсом.
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
        // 4) ключи синка и токен под DPAPI + несекретная метка аккаунта
        //    (ключ закладок выводится цепочкой от ключа паролей — restore
        //    пересчитает его из сохранённого aila.sync.key без wrap_key)
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
            bookmarks_key: bookmarks_key_of(&sync_key),
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

    /// Один круг синхронизации одного ключа appdata: pull → merge → push
    /// (если разошлись). `merge` вливает удалённый документ (None — облако
    /// пусто) в локальное хранилище и возвращает локальный документ к отправке;
    /// `count_of` — число записей документа (статистика «было в облаке»).
    /// Ответ — (записей было в облаке, push?, revision после круга).
    fn appdata_round<D, F>(
        agent: &ureq::Agent,
        server: &str,
        token: &str,
        key_id: &str,
        sync_key: &[u8; 32],
        count_of: impl Fn(&D) -> u64,
        mut merge: F,
    ) -> Result<(u64, bool, u64), String>
    where
        D: serde::Serialize + serde::de::DeserializeOwned,
        F: FnMut(Option<&D>) -> Result<D, String>,
    {
        let url = format!("{server}/api/appdata?app={APP_ID}&key={key_id}");
        // --- pull ---
        let (status, text) = get_json(agent, &url, token)?;
        match status {
            200 => {}
            401 => return Err("сессия Aila истекла — выйдите и войдите снова".into()),
            _ => return Err(format!("GET appdata: сервер ответил {status}")),
        }
        let pulled: serde_json::Value =
            serde_json::from_str(&text).map_err(|_| "странный ответ /api/appdata".to_string())?;
        let mut revision = pulled["revision"].as_u64().unwrap_or(0);
        let remote_doc: Option<D> = match pulled["blob"].as_object() {
            Some(blob) if !blob.is_empty() => Some(open_blob(sync_key, &pulled["blob"])?),
            _ => None,
        };
        let remote_count = remote_doc.as_ref().map(count_of).unwrap_or(0);
        // --- merge (локальные правки при этом остаются — push ниже) ---
        let local_doc = merge(remote_doc.as_ref())?;
        // --- push, если документы разошлись ---
        let same_as_remote = remote_doc
            .as_ref()
            .map(|d| serde_json::to_value(d).ok() == serde_json::to_value(&local_doc).ok())
            == Some(true);
        let mut pushed = false;
        if !same_as_remote {
            let blob = seal_blob(sync_key, &local_doc)?;
            let (status, text, _) = send_json(
                agent, "PUT",
                &format!("{server}/api/appdata"),
                &serde_json::json!({
                    "app": APP_ID, "key": key_id, "blob": blob, "if_match": revision,
                }),
                Some(token),
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
                    let winner_doc: Option<D> = match winner["blob"].as_object() {
                        Some(b) if !b.is_empty() => Some(open_blob(sync_key, &winner["blob"])?),
                        _ => None,
                    };
                    let merged = merge(winner_doc.as_ref())?;
                    revision = winner["revision"].as_u64().unwrap_or(revision);
                    let (status2, text2, _) = send_json(
                        agent, "PUT",
                        &format!("{server}/api/appdata"),
                        &serde_json::json!({
                            "app": APP_ID, "key": key_id,
                            "blob": seal_blob(sync_key, &merged)?,
                            "if_match": revision,
                        }),
                        Some(token),
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
        Ok((remote_count, pushed, revision))
    }

    /// Один круг синхронизации обоих хранилищ: пароли, затем закладки.
    /// Ошибка первого прерывает круг (бэкофф повторит оба; слияния
    /// идемпотентны). Возвращает статистику паролей (в облаке, применено,
    /// конфликтов, push?, revision) и закладок (в облаке, применено, push?).
    fn sync_round(
        self: &Arc<Self>,
        passwords: &PasswordStore,
        history: &HistoryStore,
    ) -> Result<((u64, u64, u64, bool, u64), (u64, u64, bool)), String> {
        let (server, token, sync_key, bookmarks_key) = {
            let guard = self.session.lock().unwrap();
            let s = guard.as_ref().ok_or("нет входа в аккаунт Aila")?;
            (
                s.server.clone(),
                s.token.clone(),
                s.sync_key,
                s.bookmarks_key,
            )
        };
        let agent = http_agent();
        // --- пароли (ключ "passwords") ---
        let mut pw_stats = crate::passwords::MergeStats::default();
        let (pw_pulled, pw_pushed, revision) = Self::appdata_round::<VaultDoc, _>(
            &agent,
            &server,
            &token,
            KEY_PASSWORDS,
            &sync_key,
            |d: &VaultDoc| d.logins.len() as u64,
            |remote| {
                if let Some(d) = remote {
                    pw_stats = passwords.merge_remote(&d.logins, &d.never_save)?;
                }
                Ok(VaultDoc {
                    v: 1,
                    logins: passwords.export_full()?,
                    never_save: passwords.never_save_origins()?,
                })
            },
        )?;
        // --- закладки (ключ "bookmarks", этап 5 duopulse-111) ---
        let mut bm_stats = crate::history::BookmarkMergeStats::default();
        let (bm_pulled, bm_pushed, _bm_revision) = Self::appdata_round::<BookmarkSyncDoc, _>(
            &agent,
            &server,
            &token,
            KEY_BOOKMARKS,
            &bookmarks_key,
            |d: &BookmarkSyncDoc| d.bookmarks.len() as u64,
            |remote| {
                if let Some(d) = remote {
                    bm_stats = history.merge_sync_doc(d)?;
                }
                history.export_sync_doc()
            },
        )?;
        let mut guard = self.session.lock().unwrap();
        eprintln!(
            "[aila] круг: пароли pulled={pw_pulled} applied={} conflicts={} pushed={pw_pushed} rev={revision}; \
             закладки pulled={bm_pulled} applied={} removed={} pushed={bm_pushed}",
            pw_stats.applied,
            pw_stats.conflicts,
            bm_stats.applied,
            bm_stats.removed,
        );
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
        Ok((
            (pw_pulled, pw_stats.applied, pw_stats.conflicts, pw_pushed, revision),
            (bm_pulled, bm_stats.applied, bm_pushed),
        ))
    }

    /// Синхронизировать сейчас (кнопка в настройках): тот же круг, что у
    /// воркера, но синхронно — статистика уходит в UI.
    pub fn sync_now(
        self: &Arc<Self>,
        passwords: &PasswordStore,
        history: &HistoryStore,
    ) -> Result<((u64, u64, u64, bool, u64), (u64, u64, bool)), String> {
        self.sync_round(passwords, history)
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

    /// Ключ закладок (этап 5) — цепочка от ключа паролей: детерминированная
    /// (restore из aila.sync.key даёт ту же), отделена от ключа паролей и от
    /// чужих аккаунтов.
    #[test]
    fn bookmarks_key_chains_from_passwords_key() {
        let pw = sync_key_of(&key(7));
        let bm = bookmarks_key_of(&pw);
        assert_eq!(bm, bookmarks_key_of(&pw)); // детерминизм (restore совместим)
        assert_ne!(bm, pw); // отделён от блоба паролей
        assert_ne!(bm, bookmarks_key_of(&sync_key_of(&key(8))));
        // прямой вывод из wrap_key дал бы ДРУГОЙ ключ — цепочка единственный
        // канонический путь (иначе машины не сошлись бы)
        let hk = Hkdf::<Sha256>::new(Some(b"duopulse"), &key(7));
        let mut direct = [0u8; 32];
        hk.expand(b"duopulse-bookmarks-v1", &mut direct).expect("ок");
        assert_ne!(bm, direct);
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
        let back: VaultDoc = open_blob(&key(1), &blob).unwrap();
        assert_eq!(back.logins.len(), 1);
        assert_eq!(back.logins[0].password, "s3cret!");
        assert_eq!(back.never_save, vec!["https://spam.io".to_string()]);
        // чужой ключ — честная ошибка
        assert!(open_blob::<VaultDoc>(&key(2), &blob).is_err());
        assert!(open_blob::<VaultDoc>(&key(1), &serde_json::json!({ "iv": "xx", "ct": "yy" })).is_err());
    }

    /// Блоб закладок (этап 5): тот же {iv, ct}-формат, ключ закладок отличен
    /// от ключа паролей — чужой блоб не расшифровывается.
    #[test]
    fn bookmarks_blob_roundtrip_with_own_key() {
        use crate::history::{SyncBookmark, SyncGroup, SyncTombstone};
        let doc = BookmarkSyncDoc {
            v: 1,
            bookmarks: vec![SyncBookmark {
                url: "https://yt.example/".into(),
                title: "YouTube".into(),
                added_at: 1,
                updated_at: 2,
                groups: vec!["Избранное".into()],
            }],
            groups: vec![SyncGroup {
                name: "Избранное".into(),
                sort_by: "manual".into(),
                created_at: 1,
            }],
            tombstones: vec![SyncTombstone {
                kind: "bookmark".into(),
                key: "https://gone.example/".into(),
                deleted_at: 3,
            }],
        };
        let bm_key = bookmarks_key_of(&key(1));
        let blob = seal_blob(&bm_key, &doc).unwrap();
        assert!(!blob["ct"].as_str().unwrap().contains("yt.example"));
        let back: BookmarkSyncDoc = open_blob(&bm_key, &blob).unwrap();
        assert_eq!(back.bookmarks[0].url, "https://yt.example/");
        assert_eq!(back.tombstones[0].key, "https://gone.example/");
        // ключ паролей чужой для блоба закладок — честная ошибка
        assert!(open_blob::<BookmarkSyncDoc>(&key(2), &blob).is_err());
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
