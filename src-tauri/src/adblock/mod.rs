//! Блокировщик рекламы — задача 2.1 (docs/04 §1.2, docs/02 §3 «adblock»).
//!
//! Обёртка adblock-rs (движок Brave, синтаксис EasyList/uBO): сетевая
//! фильтрация **до** загрузки ресурса — решение принимает COM-перехватчик
//! WebView2 WebResourceRequested (main.rs → [`AdblockService::should_block`]).
//! Косметическая фильтрация (скрытие рекламных DOM-узлов инжектируемым
//! скриптом) — задача 2.2, через этот же движок.
//!
//! Списки: EasyList + uBO filters (ads) по умолчанию; загрузка по HTTPS,
//! кэш текстов в `profile/filters/<имя>.txt` (docs/02 §8), скомпилированный
//! движок в `engine.bin` (deserialize — сотни мс против секунд парсинга),
//! метаданные (digest/дата/число правил) — `meta.json`. Фоновое обновление:
//! на старте отсутствующие/протухшие (сутки) списки, далее проверка раз в
//! час и по команде `adblock.update_lists`.
//!
//! `DUOPULSE_ADBLOCK_LISTS="имя=путь-или-url;…"` — переопределение источников
//! (e2e-стенды: локальные файлы вместо сети); пустое значение — списков нет,
//! движок не строится. Источник-путь читается с диска, http(s) — качается.
//!
//! Настройки — ключ "adblock" в settings.json (как прокси — свой ключ):
//! `{ enabled, site_exceptions[] }`. Блокировщик включён по умолчанию —
//! это ценность продукта (docs/04 §1.2 «Меньше грузить»), а white-list
//! per-site гарантирует, что «сломанный» сайт лечится одним тумблером.
//!
//! События (docs/05 §2): `adblock:blocked_count` (батчинг: фон-нить сливает
//! накопленный дельта-счётчик раз в 400 мс — без шторма IPC на тяжёлых
//! страницах), `adblock:site_exception_changed`.

use std::collections::BTreeSet;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use adblock::lists::ParseOptions;
use adblock::request::Request;
use adblock::Engine;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::bridge::{
    emit, AdblockBlockedCount, AdblockBlockedCountEvent, AdblockListInfo, AdblockSiteException,
    AdblockSiteExceptionChangedEvent, AdblockStatusResult,
};

/// Сутки: обновлять список, если кэш старше (docs/04: «кэш, фоновое
/// обновление»; uBO/EasyList обновляются ежедневно-ежечасно).
const STALE_AFTER_MS: i64 = 24 * 60 * 60 * 1000;
/// Период фоновых проверок протухлости.
const CHECK_PERIOD: Duration = Duration::from_secs(60 * 60);
/// Период слива счётчика блокировок в UI.
const FLUSH_PERIOD: Duration = Duration::from_millis(400);
/// Таймаут загрузки списка и потолок размера ответа (EasyList ~4 МБ).
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);
const FETCH_MAX_BYTES: usize = 32 * 1024 * 1024;

/// Списки по умолчанию (docs/04 §1.2): EasyList + uBO. Проверенные базовые
/// списки без агрессивных экспериментальных (docs/04 §4 — «не ломать сайты»).
/// uBO «uBlock filters – Ads» живёт в uAssets как filters.txt (проверять
/// при обновлении: прежний ads.txt удалён апстримом и отдавал 404).
const DEFAULT_LISTS: [(&str, &str); 2] = [
    ("easylist", "https://easylist.to/easylist/easylist.txt"),
    (
        "ublock-ads",
        "https://ublockorigin.github.io/uAssets/filters/filters.txt",
    ),
];

// ---------------------------------------------------------------------------
// Источники списков
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
struct ListDef {
    name: String,
    /// http(s)-адрес или путь к локальному файлу.
    source: String,
}

/// Реестр источников: DUOPULSE_ADBLOCK_LISTS (e2e) или DEFAULT_LISTS.
/// Пустая переменная/только пробелы — списков нет (Some(vec![])).
fn list_defs() -> Vec<ListDef> {
    let Some(spec) = std::env::var("DUOPULSE_ADBLOCK_LISTS").ok() else {
        return DEFAULT_LISTS
            .iter()
            .map(|(n, s)| ListDef {
                name: (*n).into(),
                source: (*s).into(),
            })
            .collect();
    };
    if spec.trim().is_empty() {
        return vec![];
    }
    spec.split(';')
        .filter_map(|entry| {
            let entry = entry.trim();
            let (name, source) = entry.split_once('=')?;
            let (name, source) = (name.trim(), source.trim());
            if name.is_empty() || source.is_empty() {
                return None;
            }
            Some(ListDef {
                name: name.into(),
                source: source.into(),
            })
        })
        .collect()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ListMetaEntry {
    /// SipHash текста списка: совокупность меток валидности engine.bin.
    digest: u64,
    rules: u32,
    /// Успешная загрузка/чтение, unix-ms (0 — неизвестно).
    updated_at: i64,
}

/// meta.json: метки кэша по имени списка.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct ListsMeta {
    lists: std::collections::BTreeMap<String, ListMetaEntry>,
}

// ---------------------------------------------------------------------------
// Настройки (settings.json, ключ "adblock")
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Persisted {
    enabled: bool,
    site_exceptions: Vec<String>,
}

impl Default for Persisted {
    fn default() -> Self {
        Self {
            enabled: true,
            site_exceptions: vec![],
        }
    }
}

fn load_persisted(dir: &std::path::Path) -> Persisted {
    let path = dir.join("settings.json");
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Persisted::default();
    };
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|root| root.get("adblock").cloned())
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

/// Пишет ключ "adblock" в settings.json, сохраняя прочие ключи (паттерн
/// proxy::save_config, включая .bak).
fn save_persisted(dir: &std::path::Path, cfg: &Persisted) -> Result<(), String> {
    let path = dir.join("settings.json");
    let mut root: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    root["adblock"] = serde_json::to_value(cfg).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("создать {dir:?}: {e}"))?;
    if path.exists() {
        let _ = std::fs::copy(&path, dir.join("settings.json.bak"));
    }
    let json = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("записать {path:?}: {e}"))
}

// ---------------------------------------------------------------------------
// Сервис
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct ListState {
    name: String,
    source: String,
    rules: u32,
    /// Успешная загрузка/чтение, unix-ms; 0 — списка ещё не было.
    updated_at: i64,
    /// Последняя ошибка загрузки (пустая строка — нет).
    error: String,
}

struct Inner {
    enabled: bool,
    site_exceptions: BTreeSet<String>,
    engine: Option<Arc<Engine>>,
    lists: Vec<ListState>,
    blocked_total: u64,
    /// Все http(s)-запросы через перехватчик (диагностика P-07: «до/после»).
    seen_total: u64,
    /// Неслитый в UI прирост блокировок (adblock:blocked_count).
    pending_delta: u64,
    /// Запрошено принудительное обновление (adblock.update_lists force).
    force_update: bool,
}

/// Состояние Core для `adblock.*` (docs/05 §2); регистрируется через
/// `app.manage(Arc<AdblockService>)`. Нити обновления/слива запускает `start`
/// из setup — им нужен AppHandle для событий.
pub struct AdblockService {
    inner: Mutex<Inner>,
    /// Будильник нити обновления (update_lists force).
    wake: Condvar,
    profile_dir: std::path::PathBuf,
}

impl AdblockService {
    pub fn new(profile_dir: &std::path::Path) -> Self {
        let persisted = load_persisted(profile_dir);
        let lists = list_defs()
            .into_iter()
            .map(|d| ListState {
                name: d.name,
                source: d.source,
                rules: 0,
                updated_at: 0,
                error: String::new(),
            })
            .collect();
        Self {
            inner: Mutex::new(Inner {
                enabled: persisted.enabled,
                site_exceptions: persisted.site_exceptions.into_iter().collect(),
                engine: None,
                lists,
                blocked_total: 0,
                seen_total: 0,
                pending_delta: 0,
                force_update: false,
            }),
            wake: Condvar::new(),
            profile_dir: profile_dir.to_path_buf(),
        }
    }

    /// Фоновые нити: обновление списков + слив счётчика блокировок.
    /// Вызывается один раз из setup.
    pub fn start(self: &Arc<Self>, app: &AppHandle) {
        let updater = Arc::clone(self);
        std::thread::spawn(move || updater.updater_loop());
        let flusher = Arc::clone(self);
        let app = app.clone();
        std::thread::spawn(move || flusher.flusher_loop(&app));
    }

    /// Решение для COM-перехватчика WebView2: блокировать ли запрос.
    /// Вызывается на каждом http(s)-запросе каждой вкладки — только быстрые
    /// операции: короткий лок, клон Arc<Engine>, проверка движка без лока.
    ///
    /// `tab_url` — текущий URL вкладки (запасной источник запроса), `referer`
    /// — заголовок Referer (источник для подресурсов), `request_type` —
    /// строка типа из ResourceContext («document», «script», …).
    pub fn should_block(
        &self,
        tab_url: Option<&str>,
        uri: &str,
        request_type: &str,
        referer: Option<&str>,
    ) -> bool {
        let mut guard = self.inner.lock().expect("adblock: лок не отравлен");
        guard.seen_total += 1;
        if !guard.enabled {
            return false;
        }
        let Some(engine) = guard.engine.clone() else {
            return false;
        };
        // Источник запроса: для навигации — сама цель (семантика $document),
        // для подресурсов — Referer, при его отсутствии — URL вкладки.
        let source = if request_type == "document" {
            uri
        } else {
            referer
                .filter(|r| r.starts_with("http://") || r.starts_with("https://"))
                .or(tab_url)
                .unwrap_or(uri)
        };
        if source_host_exempted(&guard.site_exceptions, source) {
            return false;
        }
        drop(guard);

        let Ok(request) = Request::new(uri, source, request_type) else {
            return false; // неразбираемый запрос — не блокируем
        };
        let blocked = engine.check_network_request(&request).matched;
        if blocked {
            let mut guard = self.inner.lock().expect("adblock: лок не отравлен");
            guard.blocked_total += 1;
            guard.pending_delta += 1;
        }
        blocked
    }

    /// adblock.status: снапшот состояния для UI/e2e.
    pub fn status(&self) -> AdblockStatusResult {
        let guard = self.inner.lock().expect("adblock: лок не отравлен");
        AdblockStatusResult {
            enabled: guard.enabled,
            ready: guard.engine.is_some(),
            blocked_total: guard.blocked_total,
            seen_total: guard.seen_total,
            lists: guard
                .lists
                .iter()
                .map(|l| AdblockListInfo {
                    name: l.name.clone(),
                    source: l.source.clone(),
                    rules: l.rules,
                    updated_at: l.updated_at,
                    error: if l.error.is_empty() {
                        None
                    } else {
                        Some(l.error.clone())
                    },
                })
                .collect(),
            site_exceptions: guard.site_exceptions.iter().cloned().collect(),
        }
    }

    /// adblock.set_enabled: site=None — глобальный тумблер; Some(host) —
    /// «блокировать/не блокировать на сайте» (white-list, docs/04 §1.2).
    pub fn set_enabled(
        &self,
        app: &AppHandle,
        site: Option<&str>,
        on: bool,
    ) -> Result<AdblockStatusResult, String> {
        let site = match site.map(normalize_site) {
            Some(Ok(host)) => Some(host),
            Some(Err(e)) => return Err(e),
            None => None,
        };
        let mut guard = self.inner.lock().expect("adblock: лок не отравлен");
        match site.as_deref() {
            None => guard.enabled = on,
            Some(host) => {
                if on {
                    guard.site_exceptions.remove(host);
                } else {
                    guard.site_exceptions.insert(host.to_string());
                }
            }
        }
        let persisted = Persisted {
            enabled: guard.enabled,
            site_exceptions: guard.site_exceptions.iter().cloned().collect(),
        };
        drop(guard);
        save_persisted(&self.profile_dir, &persisted)?;
        if let Some(host) = &site {
            emit::<AdblockSiteExceptionChangedEvent>(
                app,
                &AdblockSiteException {
                    site: host.clone(),
                    on,
                },
            )
            .ok();
        }
        Ok(self.status())
    }

    /// adblock.update_lists: разбудить нить обновления (force — качать
    /// даже свежие); статус вернётся сразу, загрузка идёт фоном.
    pub fn update_lists(&self, force: bool) -> AdblockStatusResult {
        {
            let mut guard = self.inner.lock().expect("adblock: лок не отравлен");
            if force {
                guard.force_update = true;
            }
        }
        self.wake.notify_all();
        self.status()
    }

    // --- нить обновления ----------------------------------------------------

    fn updater_loop(self: Arc<Self>) {
        loop {
            let forced = {
                let mut guard = self.inner.lock().expect("adblock: лок не отравлен");
                let forced = guard.force_update;
                guard.force_update = false;
                forced
            };
            self.refresh_lists(forced);
            let guard = self.inner.lock().expect("adblock: лок не отравлен");
            // Суточные проверки не нужны, когда источники заданы окружением
            // (e2e): ждём только явного force.
            let timeout = if std::env::var("DUOPULSE_ADBLOCK_LISTS").is_ok() {
                Duration::from_secs(24 * 60 * 60)
            } else {
                CHECK_PERIOD
            };
            let (_guard, _timed_out) = self
                .wake
                .wait_timeout(guard, timeout)
                .expect("adblock: лок не отравлен");
        }
    }

    /// Один проход обновления: отсутствующие/протухшие списки → скачать;
    /// пересобрать движок, если изменился состав правил. Ошибка сети не
    /// роняет текущий движок — работает кэш до удачного обновления.
    fn refresh_lists(&self, force: bool) {
        let defs = list_defs();
        let filters_dir = self.profile_dir.join("filters");
        let _ = std::fs::create_dir_all(&filters_dir);
        let mut texts: Vec<(String, String)> = Vec::new(); // (имя, текст)
        let mut new_states: Vec<ListState> = Vec::new();
        let mut meta = read_meta(&filters_dir);
        let now = now_ms();

        for def in &defs {
            let path = list_path(&filters_dir, &def.name);
            let cached = std::fs::read_to_string(&path).ok();
            let cached_at = meta.lists.get(&def.name).map(|m| m.updated_at).unwrap_or(0);
            // Файл-источник: перечитываем при отсутствии и по force.
            // Сеть: качаем отсутствующий, протухший (>суток) или по force.
            let need_fetch = force
                || cached.is_none()
                || (def.source.starts_with("http://") || def.source.starts_with("https://"))
                    && (cached_at == 0 || now - cached_at > STALE_AFTER_MS);
            let (text, updated_at, error) = if need_fetch {
                match fetch_list(&def.source) {
                    Ok(t) => {
                        atomic_write(&path, t.as_bytes());
                        (Some(t), now, String::new())
                    }
                    Err(e) => {
                        // кэш есть — работаем на нём, ошибку покажем в статусе
                        (cached.clone(), cached_at, e.to_string())
                    }
                }
            } else {
                (cached.clone(), cached_at, String::new())
            };
            let Some(text) = text else {
                new_states.push(ListState {
                    name: def.name.clone(),
                    source: def.source.clone(),
                    rules: 0,
                    updated_at: 0,
                    error: if error.is_empty() {
                        "список ещё не загружен".into()
                    } else {
                        error
                    },
                });
                continue;
            };
            let rules = count_rules(&text);
            if error.is_empty() {
                meta.lists.insert(
                    def.name.clone(),
                    ListMetaEntry {
                        digest: digest(&text),
                        rules,
                        updated_at,
                    },
                );
            }
            new_states.push(ListState {
                name: def.name.clone(),
                source: def.source.clone(),
                rules,
                updated_at,
                error,
            });
            texts.push((def.name.clone(), text));
        }

        if defs.is_empty() {
            // Явно выключено окружением (e2e): движка не будет.
            let mut guard = self.inner.lock().expect("adblock: лок не отравлен");
            guard.engine = None;
            guard.lists = new_states;
            return;
        }

        // Скомпилированный кэш валиден, если набор digest'ов совпал.
        let digests: Vec<u64> = defs
            .iter()
            .map(|d| meta.lists.get(&d.name).map(|m| m.digest).unwrap_or(0))
            .collect();
        let engine = match load_compiled(&filters_dir, &digests) {
            Some(e) => Some(e),
            None => {
                let rules = texts.iter().flat_map(|(_, t)| t.lines());
                let engine = Engine::from_rules(rules, ParseOptions::default());
                if let Ok(bin) = engine.serialize_raw() {
                    write_compiled(&filters_dir, &bin, &digests);
                }
                Some(engine)
            }
        };
        write_meta(&filters_dir, &meta);

        let mut guard = self.inner.lock().expect("adblock: лок не отравлен");
        guard.lists = new_states;
        // Полный набор текстов → движок из них. Частичный — только если
        // движка ещё нет: один недоступный источник не должен оставлять
        // блокировщик совсем без списков (EasyList один уже полезен);
        // при живом движке частичное обновление его не трогает.
        if texts.len() == defs.len() || (!texts.is_empty() && guard.engine.is_none()) {
            guard.engine = engine.map(Arc::new);
        }
    }

    // --- нить слива счётчика --------------------------------------------------

    fn flusher_loop(self: &Arc<Self>, app: &AppHandle) {
        loop {
            std::thread::sleep(FLUSH_PERIOD);
            let (delta, total) = {
                let mut guard = self.inner.lock().expect("adblock: лок не отравлен");
                if guard.pending_delta == 0 {
                    continue;
                }
                let d = guard.pending_delta;
                guard.pending_delta = 0;
                (d, guard.blocked_total)
            };
            emit::<AdblockBlockedCountEvent>(app, &AdblockBlockedCount { delta, total }).ok();
        }
    }

    /// Тестам: подставить готовый движок без списков/сети.
    #[cfg(test)]
    fn set_engine(&self, engine: Engine) {
        let mut guard = self.inner.lock().unwrap();
        guard.engine = Some(Arc::new(engine));
    }
}

// ---------------------------------------------------------------------------
// Вспомогательные
// ---------------------------------------------------------------------------

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Нормализация адреса сайта для исключения: URL → хост, нижний регистр,
/// без порта и «www.». Пустой результат — ошибка.
fn normalize_site(input: &str) -> Result<String, String> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err("пустой адрес сайта".into());
    }
    let host = if raw.contains("://") {
        tauri::Url::parse(raw)
            .ok()
            .and_then(|u| u.host_str().map(str::to_string))
            .ok_or_else(|| format!("не разобрать адрес «{raw}»"))?
    } else {
        raw.to_string()
    };
    let host = host.to_lowercase();
    let host = host.trim_start_matches("www.").to_string();
    if host.is_empty() || host.contains(char::is_whitespace) || host.contains('/') {
        return Err(format!("некорректный адрес сайта «{input}»"));
    }
    Ok(host)
}

/// Исключение действует на сайт-источник: точное совпадение хоста или
/// любого родительского домена («example.org» покрывает «news.example.org»).
fn source_host_exempted(exceptions: &BTreeSet<String>, source: &str) -> bool {
    let Some(host) = tauri::Url::parse(source)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
    else {
        return false;
    };
    let lower = host.to_lowercase();
    let mut rest: &str = lower.trim_start_matches("www.");
    loop {
        if exceptions.contains(rest) {
            return true;
        }
        match rest.split_once('.') {
            Some((_, parent)) => rest = parent,
            None => return false,
        }
    }
}

/// Число правил в тексте списка (для статуса): непустые строки без
/// комментариев «!» и метаданных uBO «# …».
fn count_rules(text: &str) -> u32 {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('!') && !l.starts_with('#'))
        .count() as u32
}

/// Стабильный (в рамках бинарника) digest текста списка: SipHash с
/// фиксированными ключами. Назначение — метка валидности engine.bin,
/// не криптография.
fn digest(text: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut h);
    h.finish()
}

fn list_path(filters_dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    // имя источника — наше (DEFAULT_LISTS/env), не пользовательский ввод
    filters_dir.join(format!("{name}.txt"))
}

fn meta_path(filters_dir: &std::path::Path) -> std::path::PathBuf {
    filters_dir.join("meta.json")
}

fn engine_paths(filters_dir: &std::path::Path) -> (std::path::PathBuf, std::path::PathBuf) {
    (
        filters_dir.join("engine.bin"),
        filters_dir.join("engine.json"),
    )
}

fn read_meta(filters_dir: &std::path::Path) -> ListsMeta {
    std::fs::read_to_string(meta_path(filters_dir))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_meta(filters_dir: &std::path::Path, meta: &ListsMeta) {
    let Ok(json) = serde_json::to_string_pretty(meta) else {
        return;
    };
    atomic_write(&meta_path(filters_dir), json.as_bytes());
}

/// engine.json хранит digest'ы, под которые скомпилирован engine.bin.
fn load_compiled(filters_dir: &std::path::Path, digests: &[u64]) -> Option<Engine> {
    let (bin_path, marks_path) = engine_paths(filters_dir);
    let expected = serde_json::to_string(digests).ok()?;
    if std::fs::read_to_string(&marks_path).ok()? != expected {
        return None;
    }
    let bytes = std::fs::read(&bin_path).ok()?;
    let mut engine = Engine::default();
    engine.deserialize(&bytes).ok()?;
    Some(engine)
}

fn write_compiled(filters_dir: &std::path::Path, bytes: &[u8], digests: &[u64]) {
    let (bin_path, marks_path) = engine_paths(filters_dir);
    if let Ok(m) = serde_json::to_string(digests) {
        atomic_write(&marks_path, m.as_bytes());
        atomic_write(&bin_path, bytes);
    }
}

/// Атомарная запись (tmp + rename) — паттерн session.rs.
fn atomic_write(path: &std::path::Path, bytes: &[u8]) {
    let tmp = path.with_extension("tmp");
    if std::fs::write(&tmp, bytes)
        .and_then(|_| std::fs::rename(&tmp, path))
        .is_err()
    {
        eprintln!("adblock: не записан {:?}", path);
    }
}

/// Загрузка списка: http(s) через ureq (rustls), иначе файл с диска.
fn fetch_list(source: &str) -> Result<String, String> {
    if !(source.starts_with("http://") || source.starts_with("https://")) {
        return std::fs::read_to_string(source).map_err(|e| format!("файл {source}: {e}"));
    }
    let agent = ureq::AgentBuilder::new()
        .timeout(FETCH_TIMEOUT)
        .redirects(5)
        .build();
    let resp = agent
        .get(source)
        .call()
        .map_err(|e| format!("загрузка {source}: {e}"))?;
    if resp.status() != 200 {
        return Err(format!("загрузка {source}: HTTP {}", resp.status()));
    }
    let mut buf = String::new();
    use std::io::Read;
    let mut reader = resp.into_reader().take(FETCH_MAX_BYTES as u64);
    reader
        .read_to_string(&mut buf)
        .map_err(|e| format!("чтение {source}: {e}"))?;
    Ok(buf)
}

// ---------------------------------------------------------------------------
// Тесты (без сети)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Тесты, трогающие DUOPULSE_ADBLOCK_LISTS, идут под общим локом: cargo
    /// запускает юнит-тесты параллельно, а переменная — одна на процесс.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn service() -> AdblockService {
        let _env = ENV_LOCK.lock().unwrap();
        let dir =
            std::env::temp_dir().join(format!("duopulse-adblock-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::env::remove_var("DUOPULSE_ADBLOCK_LISTS");
        AdblockService::new(&dir)
    }

    fn engine(rules: &[&str]) -> Engine {
        Engine::from_rules(rules.iter().copied(), ParseOptions::default())
    }

    #[test]
    fn blocks_by_rule_and_respects_exception_rule() {
        let s = service();
        s.set_engine(engine(&[
            "||ads.example.com^",
            "||fine.example.com^",
            "@@||fine.example.com^$script",
        ]));
        assert!(s.should_block(
            Some("https://news.example.org/article"),
            "https://ads.example.com/pixel.js",
            "script",
            Some("https://news.example.org/article"),
        ));
        // правило-исключение $script перекрывает блок-правило того же хоста
        assert!(!s.should_block(
            Some("https://news.example.org/"),
            "https://fine.example.com/lib.js",
            "script",
            Some("https://news.example.org/"),
        ));
        // не-script запрос к тому же хосту — блок-правило действует
        assert!(s.should_block(
            Some("https://news.example.org/"),
            "https://fine.example.com/img.png",
            "image",
            Some("https://news.example.org/"),
        ));
        // чистый ресурс
        assert!(!s.should_block(
            Some("https://news.example.org/"),
            "https://cdn.example.org/app.js",
            "script",
            Some("https://news.example.org/"),
        ));
    }

    #[test]
    fn global_toggle_and_counters() {
        let s = service();
        s.set_engine(engine(&["/blocked/*"]));
        assert!(s.should_block(None, "https://a.test/blocked/x.js", "script", None));
        {
            let mut g = s.inner.lock().unwrap();
            g.enabled = false;
        }
        assert!(!s.should_block(None, "https://a.test/blocked/x.js", "script", None));
        let st = s.status();
        assert_eq!(st.seen_total, 2, "seen считается и при выключенном");
        assert_eq!(st.blocked_total, 1);
    }

    #[test]
    fn site_exception_subdomains_and_www() {
        let s = service();
        s.set_engine(engine(&["/blocked/*"]));
        {
            let mut g = s.inner.lock().unwrap();
            g.site_exceptions.insert("example.org".into());
        }
        // поддомен источника исключён
        assert!(!s.should_block(
            Some("https://news.example.org/"),
            "https://cdn.example.org/blocked/a.js",
            "script",
            Some("https://news.example.org/"),
        ));
        // www-вариант источника тоже
        assert!(!s.should_block(
            Some("https://www.example.org/"),
            "https://cdn.example.org/blocked/a.js",
            "script",
            Some("https://www.example.org/"),
        ));
        // другой сайт — блокировка работает
        assert!(s.should_block(
            Some("https://other.test/"),
            "https://cdn.example.org/blocked/a.js",
            "script",
            Some("https://other.test/"),
        ));
    }

    #[test]
    fn document_type_uses_request_url_as_source() {
        let s = service();
        // $document-правило: навигация на рекламный хост режется
        s.set_engine(engine(&["||pop.example.com^$document"]));
        assert!(s.should_block(None, "https://pop.example.com/landing", "document", None));
        // тот же хост как подресурс $document-правилом не трогается
        assert!(!s.should_block(
            Some("https://site.test/"),
            "https://pop.example.com/img.png",
            "image",
            Some("https://site.test/"),
        ));
    }

    #[test]
    fn referer_preferred_over_tab_url() {
        let s = service();
        s.set_engine(engine(&["/blocked/*"]));
        // Referer указывает на исключённый iframe-хост, вкладка — другой сайт
        {
            let mut g = s.inner.lock().unwrap();
            g.site_exceptions.insert("frame.test".into());
        }
        assert!(!s.should_block(
            Some("https://top.test/"),
            "https://cdn.test/blocked/a.js",
            "script",
            Some("https://frame.test/embed"),
        ));
    }

    #[test]
    fn normalize_site_variants() {
        assert_eq!(normalize_site("www.YouTube.com").unwrap(), "youtube.com");
        assert_eq!(
            normalize_site("https://news.example.org/x?y=1").unwrap(),
            "news.example.org"
        );
        assert!(normalize_site("  ").is_err());
        assert!(normalize_site("no spaces allowed").is_err());
    }

    #[test]
    fn persisted_default_on_and_roundtrip() {
        let dir = std::env::temp_dir().join(format!("duopulse-adblock-cfg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(
            load_persisted(&dir).enabled,
            "из коробки блокировщик включён"
        );

        save_persisted(
            &dir,
            &Persisted {
                enabled: false,
                site_exceptions: vec!["example.org".into()],
            },
        )
        .unwrap();
        let p = load_persisted(&dir);
        assert!(!p.enabled);
        assert_eq!(p.site_exceptions, vec!["example.org".to_string()]);

        // прочие ключи settings.json сохраняются
        let raw = std::fs::read_to_string(dir.join("settings.json")).unwrap();
        assert!(raw.contains("\"adblock\""), "{raw}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn env_lists_parse() {
        let _env = ENV_LOCK.lock().unwrap();
        let _guard = EnvGuard::set(
            "DUOPULSE_ADBLOCK_LISTS",
            "a=C:\\tmp\\a.txt;b=https://x.test/b.txt",
        );
        let defs = list_defs();
        assert_eq!(
            defs,
            vec![
                ListDef {
                    name: "a".into(),
                    source: "C:\\tmp\\a.txt".into()
                },
                ListDef {
                    name: "b".into(),
                    source: "https://x.test/b.txt".into()
                },
            ]
        );
        let _guard = EnvGuard::set("DUOPULSE_ADBLOCK_LISTS", "  ");
        assert!(list_defs().is_empty());
    }

    /// Запрещённые в тестах гонки с другими тестами env-мутации: Rust-тесты
    /// в одном крейте идут последовательно (по умолчанию), но переменную
    /// чистим сразу.
    struct EnvGuard;
    impl EnvGuard {
        fn set(k: &str, v: &str) -> Self {
            std::env::set_var(k, v);
            EnvGuard
        }
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            std::env::remove_var("DUOPULSE_ADBLOCK_LISTS");
        }
    }

    #[test]
    fn cache_roundtrip_file_source_builds_engine() {
        let _env = ENV_LOCK.lock().unwrap();
        let dir =
            std::env::temp_dir().join(format!("duopulse-adblock-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let list = dir.join("list.txt");
        std::fs::write(&list, "! заголовок\n/alwaysblocked/*\n").unwrap();

        let _guard = EnvGuard::set("DUOPULSE_ADBLOCK_LISTS", &format!("t={}", list.display()));
        let profile = dir.join("profile");
        std::fs::create_dir_all(&profile).unwrap();
        let s = AdblockService::new(&profile);
        s.refresh_lists(false);

        let st = s.status();
        assert!(st.ready, "движок построен из файлового источника");
        assert_eq!(st.lists.len(), 1);
        assert_eq!(st.lists[0].rules, 1, "комментарий не считается правилом");
        assert!(st.lists[0].error.is_none(), "{:?}", st.lists[0].error);
        assert!(s.should_block(None, "https://any.test/alwaysblocked/ad.js", "script", None));
        assert!(!s.should_block(None, "https://any.test/ok.js", "script", None));

        // кэш записан: текст, мета, скомпилированный движок
        assert!(profile.join("filters").join("t.txt").exists());
        assert!(profile.join("filters").join("engine.bin").exists());
        assert!(profile.join("filters").join("meta.json").exists());

        // повторный проход подхватывает compiled-кэш (digest не изменился)
        let s2 = AdblockService::new(&profile);
        s2.refresh_lists(false);
        assert!(s2.status().ready);
        assert!(s2.should_block(None, "https://any.test/alwaysblocked/ad.js", "script", None));

        // смена списка (digest) → пересборка движка
        std::fs::write(&list, "! v2\n/alwaysblocked/*\n/second/*\n").unwrap();
        let s3 = AdblockService::new(&profile);
        s3.refresh_lists(true);
        let st3 = s3.status();
        assert_eq!(st3.lists[0].rules, 2);
        assert!(s3.should_block(None, "https://any.test/second/x.js", "script", None));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn partial_lists_still_build_engine_when_none() {
        let _env = ENV_LOCK.lock().unwrap();
        let dir =
            std::env::temp_dir().join(format!("duopulse-adblock-partial-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let good = dir.join("good.txt");
        std::fs::write(&good, "/alwaysblocked/*\n").unwrap();
        let missing = dir.join("no-such-file.txt");

        // один источник доступен, второй нет: движок строится из того, что есть
        let _guard = EnvGuard::set(
            "DUOPULSE_ADBLOCK_LISTS",
            &format!("g={};m={}", good.display(), missing.display()),
        );
        let profile = dir.join("profile");
        std::fs::create_dir_all(&profile).unwrap();
        let s = AdblockService::new(&profile);
        s.refresh_lists(false);

        let st = s.status();
        assert!(st.ready, "частичная доступность не оставляет без движка");
        assert_eq!(st.lists.len(), 2);
        assert!(
            st.lists
                .iter()
                .find(|l| l.name == "m")
                .unwrap()
                .error
                .is_some(),
            "недоступный источник помечен ошибкой"
        );
        assert!(s.should_block(None, "https://any.test/alwaysblocked/ad.js", "script", None));

        // источник ожил + force — движок пересобирается полным
        std::fs::write(&missing, "/second/*\n").unwrap();
        s.refresh_lists(true);
        let st2 = s.status();
        assert!(st2.ready);
        assert!(
            st2.lists.iter().all(|l| l.error.is_none()),
            "{:?}",
            st2.lists
        );
        assert!(s.should_block(None, "https://any.test/second/x.js", "script", None));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn count_rules_ignores_comments_and_blanks() {
        assert_eq!(count_rules("! c\n\n  \n[AdGuard]\na=b\nc\n# meta\n"), 3);
    }
}
