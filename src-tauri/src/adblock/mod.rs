//! Блокировщик рекламы — задачи 2.1–2.2 (docs/04 §1.2, docs/02 §3 «adblock»).
//!
//! Обёртка adblock-rs (движок Brave, синтаксис EasyList/uBO): сетевая
//! фильтрация **до** загрузки ресурса — решение принимает COM-перехватчик
//! WebView2 WebResourceRequested (main.rs → [`AdblockService::should_block`]);
//! косметическая фильтрация (скрытие рекламных DOM-узлов) — задача 2.2:
//! инжектируемый скрипт content/cosmetic.js запрашивает селекторы скрытия для
//! документа ([`AdblockService::cosmetic_resources`],
//! [`AdblockService::cosmetic_generic_selectors`]) — main.rs отвечает
//! PostWebMessageAsString. Скриптлеты (`##+js(...)`, карточка duopulse-043):
//! движок собирает их в `injected_script`, content/cosmetic.js исполняет код
//! в мире страницы (<script>-элемент) — тот же тумблер/white-list, что и вся
//! косметика.
//!
//! Ресурсный набор скриптлетов (библиотека uBO-совместимых функций) — не
//! сетевой источник: родной uBO resources.txt апстрим удалил, поэтому набор
//! вкомпилирован в бинарник (scriptlets-resources.json, конвертер
//! scripts/build-adblock-resources.mjs из npm-пакета @adguard/scriptlets;
//! обновление набора = перегенерация + пересборка). Digest набора входит в
//! метки engine.json — смена набора перестраивает скомпилированный кэш.
//! `serialize_raw` ресурсы НЕ сериализует — `use_resources` вызывается и
//! после `Engine::from_rules`, и после `deserialize`.
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
use adblock::resources::Resource;
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

/// Ресурсный набор скриптлетов uBO (карточка duopulse-043): генерируется
/// scripts/build-adblock-resources.mjs из @adguard/scriptlets в формат
/// `Vec<Resource>` adblock-rs (serde). Формат function-style: движок сам
/// генерирует вызов `Имя("arg1","arg2")` и оборачивает его в try/catch.
const SCRIPTLETS_JSON: &str = include_str!("scriptlets-resources.json");

/// Встроенный список совместимости (карточка duopulse-044, P-08): точечные
/// `#@#+js`-исключения adSlots-правил uBO на YouTube (ломают SABR/SSAI-хендшейк
/// — SABR-stall первого кадра) + свой json-prune без adSlots. Подключается
/// третьим источником к DEFAULT_LISTS (см. `COMPAT_LIST_DEF`); env-переопределение
/// `DUOPULSE_ADBLOCK_LISTS` (e2e-стенды) его НЕ подхватывает — точечные прогоны
/// живут на своих списках.
const COMPAT_RULES: &str = include_str!("compat.txt");
/// Источник-маркер встроенного списка: текст не качается, а берётся из
/// `COMPAT_RULES` (обновление — пересборкой бинарника).
const COMPAT_SOURCE: &str = "builtin:";

/// Разобранный набор (один раз на процесс; ошибка формата — печатаем и
/// работаем без скриптлетов, как до карточки 043).
fn scriptlet_resources() -> &'static [Resource] {
    static RES: std::sync::OnceLock<Vec<Resource>> = std::sync::OnceLock::new();
    RES.get_or_init(|| match serde_json::from_str(SCRIPTLETS_JSON) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("adblock: ресурсный набор скриптлетов не разобран: {e}");
            vec![]
        }
    })
}

// ---------------------------------------------------------------------------
// Источники списков
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
struct ListDef {
    name: String,
    /// http(s)-адрес или путь к локальному файлу.
    source: String,
}

/// Реестр источников: DUOPULSE_ADBLOCK_LISTS (e2e) или DEFAULT_LISTS +
/// встроенный compat-список. Пустая переменная/только пробелы — списков нет
/// (Some(vec![])).
fn list_defs() -> Vec<ListDef> {
    let Some(spec) = std::env::var("DUOPULSE_ADBLOCK_LISTS").ok() else {
        let mut defs: Vec<ListDef> = DEFAULT_LISTS
            .iter()
            .map(|(n, s)| ListDef {
                name: (*n).into(),
                source: (*s).into(),
            })
            .collect();
        defs.push(ListDef {
            name: "duopulse-compat".into(),
            source: COMPAT_SOURCE.into(),
        });
        return defs;
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
    /// Кэш ответов раннего канала по URL (карточка 044): холодный расчёт
    /// `url_cosmetic_resources` 0,2–0,9 с — дедупликация в-flight расчётов
    /// (разогрев с NavigationStarting и запрос document-start делят один).
    early_cache: std::collections::HashMap<String, Arc<EarlySlot>>,
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
                early_cache: std::collections::HashMap::new(),
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
        // тумблер/сайт-исключение меняют ответ для URL — кэш раннего канала
        // недействителен (карточка 044: состояние решается на момент запроса)
        guard.early_cache.clear();
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

    // --- косметическая фильтрация (задача 2.2) ------------------------------

    /// Селекторы скрытия для документа (задача 2.2): host-специфичные правила
    /// (`example.com##…`) и misc-generic (`##div[class^="ad"]…` — всё, что не
    /// keyed class/id), минус unhide-исключения хоста. Массовые generic
    /// class/id-правила движок отдаёт отдельно по классам/идам страницы —
    /// [`Self::cosmetic_generic_selectors`]. Скриптлеты (`##+js`, карточка
    /// duopulse-043): движок собирает код по ресурсному набору uBO в
    /// `injected_script` (function-style вызовы в try/catch) — content-скрипт
    /// исполняет его в мире страницы.
    ///
    /// Вызывается из WebMessageReceived при создании каждого документа: только
    /// короткий лок + клон `Arc<Engine>`, расчёт в памяти (кэш по хостам).
    pub fn cosmetic_resources(&self, url: &str) -> CosmeticResources {
        let guard = self.inner.lock().expect("adblock: лок не отравлен");
        if !guard.enabled {
            return CosmeticResources {
                active: false,
                ready: guard.engine.is_some(),
                hide: vec![],
                generichide: false,
                injected_script: String::new(),
            };
        }
        let Some(engine) = guard.engine.clone() else {
            // списки ещё грузятся — скрипту стоит повторить запрос (ready=false)
            return CosmeticResources {
                active: true,
                ready: false,
                hide: vec![],
                generichide: false,
                injected_script: String::new(),
            };
        };
        if source_host_exempted(&guard.site_exceptions, url) {
            return CosmeticResources {
                active: false,
                ready: true,
                hide: vec![],
                generichide: false,
                injected_script: String::new(),
            };
        }
        drop(guard);
        let res = engine.url_cosmetic_resources(url);
        let mut hide: Vec<String> = res.hide_selectors.into_iter().collect();
        hide.sort_unstable();
        CosmeticResources {
            active: true,
            ready: true,
            hide,
            generichide: res.generichide,
            injected_script: res.injected_script,
        }
    }

    /// Generic class/id-селекторы скрытия (задача 2.2): движок матчит классы и
    /// иды, реально присутствующие в DOM страницы, против generic-правил
    /// (`##.ad`, `###banner`, `##.k > .x`) с учётом unhide-исключений хоста
    /// (и `$generichide` — скрипт при нём generic-запросы не шлёт). Потолок
    /// входов — защита от гигантских страниц.
    pub fn cosmetic_generic_selectors(
        &self,
        url: &str,
        classes: &[String],
        ids: &[String],
    ) -> Vec<String> {
        /// Максимум классов/идов за запрос (страница шлёт дельты с своим
        /// потолком; здесь — граница доверия).
        const MAX_TOKENS: usize = 5000;
        let guard = self.inner.lock().expect("adblock: лок не отравлен");
        if !guard.enabled || source_host_exempted(&guard.site_exceptions, url) {
            return vec![];
        }
        let Some(engine) = guard.engine.clone() else {
            return vec![];
        };
        drop(guard);
        let classes = &classes[..classes.len().min(MAX_TOKENS)];
        let ids = &ids[..ids.len().min(MAX_TOKENS)];
        let exceptions = engine.url_cosmetic_resources(url).exceptions;
        let mut selectors =
            engine.hidden_class_id_selectors(classes.iter(), ids.iter(), &exceptions);
        selectors.sort_unstable();
        selectors.dedup();
        selectors
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
            let (text, updated_at, error) = if def.source == COMPAT_SOURCE {
                // Встроенный список совместимости (карточка 044): текст
                // вкомпилирован; пишем его в кэш для единообразия меток.
                atomic_write(&path, COMPAT_RULES.as_bytes());
                (Some(COMPAT_RULES.to_string()), now, String::new())
            } else if need_fetch {
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
            guard.early_cache.clear();
            return;
        }

        // Скомпилированный кэш валиден, если набор digest'ов совпал; digest
        // ресурсного набора скриптлетов — в том же наборе (смена набора при
        // обновлении бинарника перестраивает engine.bin).
        let mut digests: Vec<u64> = defs
            .iter()
            .map(|d| meta.lists.get(&d.name).map(|m| m.digest).unwrap_or(0))
            .collect();
        digests.push(digest(SCRIPTLETS_JSON));
        let engine = match load_compiled(&filters_dir, &digests) {
            // serialize_raw ресурсы не хранит — подключаем после deserialize
            Some(mut e) => {
                e.use_resources(scriptlet_resources().iter().cloned());
                Some(e)
            }
            None => {
                let rules = texts.iter().flat_map(|(_, t)| t.lines());
                let mut engine = Engine::from_rules(rules, ParseOptions::default());
                engine.use_resources(scriptlet_resources().iter().cloned());
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
            // правила могли измениться — ответы раннего канала по тем же URL
            // больше не действительны (карточка 044)
            guard.early_cache.clear();
        }
    }

    /// Косметические ресурсы с кэшем/дедупликацией (карточка 044): разогрев
    /// (NavigationStarting) и запрос раннего канала (document-start) делят
    /// один расчёт; повторные URL — из кэша. Потолок ожидания в-flight
    /// расчёта — `wait_ms` (None — ждать без потолка; тесты/разогрев).
    pub fn cosmetic_resources_cached(&self, url: &str, wait_ms: Option<u64>) -> CosmeticResources {
        let slot = {
            let mut guard = self.inner.lock().expect("adblock: лок не отравлен");
            if let Some(slot) = guard.early_cache.get(url) {
                if let Some(res) = slot.done.lock().expect("early: лок слота").as_ref() {
                    return res.clone();
                }
                slot.clone()
            } else {
                // простое ограничение памяти: пожинаем всё разом
                if guard.early_cache.len() >= 64 {
                    guard.early_cache.clear();
                }
                let slot = Arc::new(EarlySlot::default());
                guard.early_cache.insert(url.to_string(), slot.clone());
                slot.clone()
            }
        };
        let done = slot.done.lock().expect("early: лок слота");
        if let Some(res) = done.as_ref() {
            return res.clone();
        }
        // атомарно занимаем роль «считающего»; проигравшие ждут результата
        // (с потолком wait_ms — чтобы document-start не блокировал парсер дольше)
        let already_computing = slot
            .computing
            .swap(true, std::sync::atomic::Ordering::AcqRel);
        if already_computing {
            let (guard, _timed_out) = match wait_ms.map(Duration::from_millis) {
                Some(w) => {
                    let (g, res) = slot
                        .cv
                        .wait_timeout(done, w)
                        .expect("early: лок слота не отравлен");
                    (g, res.timed_out())
                }
                None => {
                    let g = slot.cv.wait(done).expect("early: лок слота не отравлен");
                    (g, false)
                }
            };
            if let Some(res) = guard.as_ref() {
                return res.clone();
            }
            // расчёт не успел — честный ready=false, скрипт уйдёт на async-путь
            return CosmeticResources {
                active: true,
                ready: false,
                hide: vec![],
                generichide: false,
                injected_script: String::new(),
            };
        }
        // мы считаем (лок inner НЕ держим), публикуем, будим ждущих
        drop(done);
        let res = self.cosmetic_resources(url);
        // Мемоизируем ТОЛЬКО окончательные ответы (фильтрация выключена /
        // готова). Промежуточный (движок строится: active=true, ready=false)
        // не кэшируем и освобождаем роль «считающего» — иначе следующий
        // запрос того же URL вечно получал бы «не готово» (тест
        // early_endpoint_serves_active_resources_and_gates).
        let final_state = !res.active || res.ready;
        {
            let mut done = slot.done.lock().expect("early: лок слота");
            if final_state {
                *done = Some(res.clone());
            } else {
                slot.computing
                    .store(false, std::sync::atomic::Ordering::Release);
            }
        }
        slot.cv.notify_all();
        res
    }

    /// Разогрев кэша косметических ресурсов для URL (карточка duopulse-044):
    /// холодный `url_cosmetic_resources` по EasyList+uBO — 0,2–0,9 с; ранний
    /// синхронный канал (start_early_endpoint) блокирующе ждёт ответ на
    /// document-start — без разогрева код скриптлетов приходит ПОСЛЕ того, как
    /// инлайн-скрипты страницы прочли свои глобалы (YouTube: реклама проходит).
    /// Вызывается с NavigationStarting (main.rs): сетевой запрос документа
    /// (~0,2–0,4 с) идёт параллельно расчёту — к document-start кэш тёплый.
    pub fn prewarm(&self, url: &str) {
        // движок может строиться (свежий профиль качает списки): ждём готовности
        // с потолком ~10 с, затем считаем и наполняем кэш
        for _ in 0..100 {
            let ready = {
                let guard = self.inner.lock().expect("adblock: лок не отравлен");
                guard.enabled && guard.engine.is_some() || !guard.enabled
            };
            if ready {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = self.cosmetic_resources_cached(url, None);
    }

    // --- ранний синхронный канал (карточка duopulse-044) ---------------------

    /// Поднять loopback-эндпоинт ранней косметики: content/cosmetic.js на
    /// старте каждого документа делает БЛОКИРУЮЩИЙ XHR
    /// `GET http://127.0.0.1:<port>/duopulse-cosmetic?url=<href>` (единицы мс —
    /// движок в памяти) и применяет скриптлеты/скрытия ДО инлайн-скриптов
    /// страницы — тайминг uBO. Асинхронный WebMessage-путь доставляет код
    /// через ~150–600 мс — YouTube успевает прочесть встроенный
    /// ytInitialPlayerResponse, и «no-ads»-состояние собирается слишком поздно
    /// (SSAI-реклама стартует) — корень SABR-stall метрики P-08. Эндпоинт
    /// решает состояние НА МОМЕНТ запроса: тумблер/сайт-исключение действуют
    /// на следующий документ без гонок. Порт — эфемерный (экземпляры
    /// приложения не конфликтуют); None — слушать не удалось, скрипт остаётся
    /// на асинхронном пути.
    pub fn start_early_endpoint(self: &Arc<Self>) -> Option<u16> {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).ok()?;
        let port = listener.local_addr().ok()?.port();
        let svc = Arc::clone(self);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else {
                    continue;
                };
                let svc = Arc::clone(&svc);
                std::thread::spawn(move || serve_early(stream, &svc));
            }
        });
        Some(port)
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
        guard.early_cache.clear();
    }
}

// ---------------------------------------------------------------------------
// Вспомогательные
// ---------------------------------------------------------------------------

/// Ответ content-скрипту на запрос косметических ресурсов документа (задача
/// 2.2; транспорт — main.rs, WebMessage → PostWebMessageAsString).
#[derive(Debug, Clone, Serialize)]
pub struct CosmeticResources {
    /// Фильтрация для этого URL действует (движок включён, сайт не в
    /// исключениях). false — скрываться нечему, повторять запрос не надо.
    pub active: bool,
    /// Движок построен; false при active=true — списки ещё грузятся, скрипт
    /// повторяет запрос.
    pub ready: bool,
    /// CSS-селекторы скрытия (`display:none!important`).
    pub hide: Vec<String>,
    /// `$generichide`: generic class/id-запросы для хоста не нужны.
    pub generichide: bool,
    /// Код скриптлетов `##+js(...)` для этого URL (карточка duopulse-043):
    /// определения функций + вызовы с аргументами правила; пустая строка —
    /// правил/ресурсов нет или фильтрация не действует.
    pub injected_script: String,
}

/// Слот кэша раннего канала (карточка 044): результат, будильник ждущих и
/// флаг «кто-то считает» (дедупликация разогрев/document-start).
#[derive(Default)]
struct EarlySlot {
    done: Mutex<Option<CosmeticResources>>,
    cv: Condvar,
    computing: std::sync::atomic::AtomicBool,
}

/// Ответ раннего канала (синхронный XHR content/cosmetic.js, карточка 044):
/// подмножество [`CosmeticResources`] в JSON; `ready=false` — скрипт остаётся
/// на асинхронном WebMessage-пути (движок строится).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EarlyResponse {
    active: bool,
    ready: bool,
    hide: Vec<String>,
    script: String,
}

/// Одно соединение раннего канала: минимальный HTTP/1.1 (GET, без тела),
/// ответ сразу с Connection: close. Блокирующий клиент ждёт единицы мс.
fn serve_early(mut stream: std::net::TcpStream, svc: &AdblockService) {
    use std::io::{Read, Write};
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut buf = [0u8; 8192];
    let Ok(n) = stream.read(&mut buf) else {
        return;
    };
    let first = String::from_utf8_lossy(&buf[..n])
        .lines()
        .next()
        .unwrap_or_default()
        .to_string();
    let path = first.split(' ').nth(1).unwrap_or_default();
    let (status, body) = early_response_for(path, svc);
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(resp.as_bytes());
}

/// Ответ по пути запроса (тесты зовут напрямую): только
/// `/duopulse-cosmetic?url=<http(s)-адрес>`.
fn early_response_for(path: &str, svc: &AdblockService) -> (&'static str, String) {
    const PREFIX: &str = "/duopulse-cosmetic?url=";
    let Some(raw) = path.strip_prefix(PREFIX) else {
        return ("404 Not Found", "{}".into());
    };
    let decoded = percent_decode(raw);
    if !(decoded.starts_with("http://") || decoded.starts_with("https://")) {
        return ("400 Bad Request", "{}".into());
    }
    // кэш/дедупликация: ждём разогрев не дольше 600 мс — дальше честный
    // ready=false (скрипт уходит на асинхронный путь, парсер не виснет)
    let res = svc.cosmetic_resources_cached(&decoded, Some(600));
    let body = serde_json::to_string(&EarlyResponse {
        active: res.active,
        ready: res.ready,
        hide: res.hide,
        script: res.injected_script,
    })
    .unwrap_or_else(|_| "{}".into());
    ("200 OK", body)
}

/// Декодирование %XX (encodeURIComponent: «+» остаётся «+», пробел — %20).
fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = |b: u8| -> Option<u8> {
                match b {
                    b'0'..=b'9' => Some(b - b'0'),
                    b'a'..=b'f' => Some(b - b'a' + 10),
                    b'A'..=b'F' => Some(b - b'A' + 10),
                    _ => None,
                }
            };
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

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

    // --- задача 2.2: косметическая фильтрация --------------------------------

    #[test]
    fn cosmetic_hostname_specific_and_misc_generic() {
        let s = service();
        s.set_engine(engine(&[
            "example.com##.site-ad",
            "other.test##.wrong-host",
            "##.generic-ad",
            "###generic-ad-id",
            "##div.misc-ad",
        ]));
        let res = s.cosmetic_resources("https://example.com/page");
        assert!(res.active && res.ready && !res.generichide);
        assert!(res.hide.contains(&".site-ad".to_string()));
        assert!(
            res.hide.contains(&"div.misc-ad".to_string()),
            "misc-generic селекторы приходят сразу (не keyed class/id): {:?}",
            res.hide
        );
        assert!(
            !res.hide.contains(&".wrong-host".to_string()),
            "чужой хост не действует"
        );
        assert!(
            !res.hide
                .iter()
                .any(|h| h.starts_with(".generic-ad") || h.starts_with("#generic")),
            "простые generic class/id — отдельным запросом по DOM, не здесь: {:?}",
            res.hide
        );

        // generic по классам/идам, реально присутствующим на странице
        let sel = s.cosmetic_generic_selectors(
            "https://example.com/page",
            &["generic-ad".into(), "clean".into()],
            &["generic-ad-id".into()],
        );
        assert_eq!(
            sel,
            vec!["#generic-ad-id".to_string(), ".generic-ad".to_string()],
            "чистые классы/иды не матчатся"
        );
    }

    #[test]
    fn cosmetic_complex_generic_keyed_by_class() {
        let s = service();
        s.set_engine(engine(&["##.e2e-complex > span"]));
        // комплексное generic-правило всплывает, только когда класс есть в DOM
        assert!(s
            .cosmetic_generic_selectors("https://a.test/", &[], &[])
            .is_empty());
        assert_eq!(
            s.cosmetic_generic_selectors("https://a.test/", &["e2e-complex".into()], &[]),
            vec![".e2e-complex > span".to_string()]
        );
    }

    #[test]
    fn cosmetic_e2e_fixture_full_set() {
        // Полный набор e2e/adblock/cosmetic-fixture.txt + все классы/иды стенда:
        // regression на взаимодействие правил внутри одного движка.
        let s = service();
        s.set_engine(engine(&[
            "##.e2e-generic-class",
            "###e2e-generic-id",
            "##.e2e-complex > span",
            "##div[class=\"e2e-misc\"]",
            "##.e2e-exempt-ad",
            "##.e2e-late-ad",
            "127.0.0.1##.e2e-site-ad",
            "127.0.0.1#@#.e2e-exempt-ad",
        ]));
        let classes: Vec<String> = [
            "content",
            "e2e-complex",
            "e2e-generic-class",
            "e2e-misc",
            "e2e-site-ad",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let ids: Vec<String> = ["e2e-generic-id", "result"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let sel = s.cosmetic_generic_selectors("http://127.0.0.1:8895/", &classes, &ids);
        assert_eq!(
            sel,
            vec![
                "#e2e-generic-id".to_string(),
                ".e2e-complex > span".to_string(),
                ".e2e-generic-class".to_string(),
            ],
            "unhide-исключение гасит .e2e-exempt-ad; misc — не class/id-keyed"
        );
    }

    #[test]
    fn cosmetic_unhide_exception_blocks_generic() {
        let s = service();
        s.set_engine(engine(&["##.generic-ad", "example.com#@#.generic-ad"]));
        // на хосте с unhide-исключением generic-правило не действует…
        assert!(s
            .cosmetic_generic_selectors("https://example.com/", &["generic-ad".into()], &[])
            .is_empty());
        // …на остальных — действует
        assert_eq!(
            s.cosmetic_generic_selectors("https://other.test/", &["generic-ad".into()], &[]),
            vec![".generic-ad".to_string()]
        );
    }

    #[test]
    fn cosmetic_generichide_suppresses_generic() {
        let s = service();
        s.set_engine(engine(&[
            "@@||example.com^$generichide",
            "##div.misc-ad",
            "example.com##.site-ad",
        ]));
        let res = s.cosmetic_resources("https://example.com/");
        assert!(res.generichide, "$generichide-исключение распознано");
        assert!(
            res.hide.contains(&".site-ad".to_string()),
            "host-специфичные действуют и при $generichide"
        );
        assert!(
            !res.hide.contains(&"div.misc-ad".to_string()),
            "misc-generic подавлен $generichide"
        );
    }

    #[test]
    fn cosmetic_disabled_site_exception_and_not_ready() {
        let s = service(); // движка ещё нет
        let res = s.cosmetic_resources("https://a.test/");
        assert!(res.active && !res.ready && res.hide.is_empty());

        s.set_engine(engine(&["##.ad"]));
        {
            let mut g = s.inner.lock().unwrap();
            g.enabled = false;
        }
        let res = s.cosmetic_resources("https://a.test/");
        assert!(!res.active, "глобальный тумблер выключен — скрывать нечего");

        {
            let mut g = s.inner.lock().unwrap();
            g.enabled = true;
            g.site_exceptions.insert("a.test".into());
        }
        let res = s.cosmetic_resources("https://a.test/");
        assert!(!res.active, "сайт в исключениях — косметики нет");
        assert!(s
            .cosmetic_generic_selectors("https://a.test/", &["ad".into()], &[])
            .is_empty());
    }

    // --- карточка duopulse-043: скриптлеты ##+js --------------------------------

    /// Движок с правилами и ресурсным набором (как строит refresh_lists).
    fn scriptlet_engine(rules: &[&str]) -> Engine {
        let mut e = Engine::from_rules(rules.iter().copied(), ParseOptions::default());
        e.use_resources(scriptlet_resources().iter().cloned());
        e
    }

    #[test]
    fn scriptlet_resources_embedded_set_is_valid() {
        let res = scriptlet_resources();
        assert!(
            res.len() > 90,
            "набор из бинарника разбирается и полный: {}",
            res.len()
        );
        let mut names = std::collections::BTreeSet::new();
        let mut aliases = std::collections::BTreeSet::new();
        for r in res {
            assert!(
                r.name.ends_with(".js") && !r.name.is_empty(),
                "{:?}",
                r.name
            );
            assert!(!names.contains(&r.name), "дубль имени {}", r.name);
            names.insert(r.name.clone());
            for a in &r.aliases {
                assert!(!aliases.contains(a), "дубль алиаса {a}");
                aliases.insert(a.clone());
            }
        }
        // топ-скриптлеты живого uBO filters.txt (журнал карточки 043)
        for needed in [
            "aopr.js",
            "acs.js",
            "set.js",
            "aeld.js",
            "nostif.js",
            "aopw.js",
            "nowoif.js",
            "nobab.js",
            "json-prune.js",
            "no-fetch-if.js",
        ] {
            assert!(
                names.contains(needed) || aliases.contains(needed),
                "нет {needed}"
            );
        }
    }

    #[test]
    fn scriptlet_rule_injects_function_call_with_args() {
        let s = service();
        s.set_engine(scriptlet_engine(&[
            "127.0.0.1##+js(set-constant, player.adFlag, yes)",
            "example.com##+js(aopr, atob)",
        ]));
        let res = s.cosmetic_resources("http://127.0.0.1:8895/page");
        assert!(res.active && res.ready);
        // function-style: определение функции + вызов с аргументами правила
        assert!(
            res.injected_script.contains("function setConstant("),
            "нет определения функции"
        );
        assert!(
            res.injected_script
                .contains(r#"setConstant("player.adFlag", "yes")"#),
            "нет вызова с аргументами: {}",
            &res.injected_script[..res.injected_script.len().min(300)]
        );
        // чужой хост — ничего
        let other = s.cosmetic_resources("https://other.test/");
        assert!(other.injected_script.is_empty());
        // алиас-форма правила (aopr на example.com)
        let aliased = s.cosmetic_resources("https://example.com/x");
        assert!(aliased
            .injected_script
            .contains("abortOnPropertyRead(\"atob\")"));
    }

    #[test]
    fn scriptlet_multihost_ubo_youtube_rule_injects() {
        // дословные правила живого uBO filters.txt (мультихостовое условие +
        // короткий алиас set + магическое значение undefined)
        let s = service();
        s.set_engine(scriptlet_engine(&[
            "m.youtube.com,music.youtube.com,tv.youtube.com,www.youtube.com,youtubekids.com,youtube-nocookie.com##+js(set, ytInitialPlayerResponse.playerAds, undefined)",
            "m.youtube.com,music.youtube.com,tv.youtube.com,www.youtube.com,youtubekids.com,youtube-nocookie.com##+js(set, ytInitialPlayerResponse.adSlots, undefined)",
            "m.youtube.com,music.youtube.com,tv.youtube.com,www.youtube.com,youtubekids.com,youtube-nocookie.com##+js(json-prune, playerResponse.adPlacements playerResponse.playerAds playerResponse.adSlots adPlacements playerAds adSlots important)",
        ]));
        let res = s.cosmetic_resources("https://www.youtube.com/watch?v=x");
        assert!(res.active && res.ready);
        assert!(
            res.injected_script.contains("function setConstant("),
            "нет setConstant: {}",
            &res.injected_script[..res.injected_script.len().min(200)]
        );
        assert!(
            res.injected_script
                .contains(r#"setConstant("ytInitialPlayerResponse.playerAds", "undefined")"#),
            "нет вызова с undefined: {}",
            &res.injected_script[..res.injected_script.len().min(300)]
        );
        assert!(
            res.injected_script.contains("function jsonPrune("),
            "нет jsonPrune"
        );
        // хост вне списка — ничего
        let other = s.cosmetic_resources("https://example.com/");
        assert!(other.injected_script.is_empty());
    }

    #[test]
    fn scriptlet_trusted_requires_permission() {
        let s = service();
        s.set_engine(scriptlet_engine(&[
            "127.0.0.1##+js(trusted-set-cookie, a, b)",
        ]));
        let res = s.cosmetic_resources("http://127.0.0.1:8895/");
        // ParseOptions::default() (untrusted) — trusted-* не инъенцируется
        assert!(
            res.injected_script.is_empty(),
            "trusted-скриптлет без доверия не должен попадать в инъекцию"
        );
    }

    #[test]
    fn scriptlets_disabled_by_toggle_and_site_exception() {
        let s = service();
        s.set_engine(scriptlet_engine(&["a.test##+js(set-constant, flag, yes)"]));
        {
            let mut g = s.inner.lock().unwrap();
            g.enabled = false;
        }
        let res = s.cosmetic_resources("https://a.test/");
        assert!(
            !res.active && res.injected_script.is_empty(),
            "тумблер выключен — скриптлетов нет"
        );
        {
            let mut g = s.inner.lock().unwrap();
            g.enabled = true;
            g.site_exceptions.insert("a.test".into());
        }
        let res = s.cosmetic_resources("https://a.test/");
        assert!(
            !res.active && res.injected_script.is_empty(),
            "сайт в исключениях — скриптлетов нет"
        );
    }

    // --- карточка duopulse-044: compat-список против SABR-stall ----------------

    /// Дословные YouTube-правила живого uBO filters.txt (uAssets 20–22.10.2026;
    /// оба варианта текста json-prune: до 21.10 — с www, после — без) —
    /// аргументы исключений compat-списка обязаны совпадать с ними до символа.
    const UBO_YOUTUBE_RULES: [&str; 6] = [
        "m.youtube.com,music.youtube.com,tv.youtube.com,www.youtube.com,youtubekids.com,youtube-nocookie.com##+js(set, ytInitialPlayerResponse.playerAds, undefined)",
        "m.youtube.com,music.youtube.com,tv.youtube.com,www.youtube.com,youtubekids.com,youtube-nocookie.com##+js(set, ytInitialPlayerResponse.adPlacements, undefined)",
        "m.youtube.com,music.youtube.com,tv.youtube.com,www.youtube.com,youtubekids.com,youtube-nocookie.com##+js(set, ytInitialPlayerResponse.adSlots, undefined)",
        "m.youtube.com,music.youtube.com,tv.youtube.com,www.youtube.com,youtubekids.com,youtube-nocookie.com##+js(set, playerResponse.adPlacements, undefined)",
        "m.youtube.com,music.youtube.com,tv.youtube.com,www.youtube.com,youtubekids.com,youtube-nocookie.com##+js(json-prune, playerResponse.adPlacements playerResponse.playerAds playerResponse.adSlots adPlacements playerAds adSlots important)",
        "m.youtube.com,music.youtube.com,tv.youtube.com,youtubekids.com,youtube-nocookie.com##+js(json-prune, playerResponse.adPlacements playerResponse.playerAds playerResponse.adSlots adPlacements playerAds adSlots important)",
    ];

    #[test]
    fn compat_neutralizes_adslots_and_adds_prune_without_it() {
        let rules: Vec<&str> = UBO_YOUTUBE_RULES
            .iter()
            .copied()
            .chain(COMPAT_RULES.lines())
            .collect();
        let mut e = Engine::from_rules(rules.iter().copied(), ParseOptions::default());
        e.use_resources(scriptlet_resources().iter().cloned());
        let s = service();
        s.set_engine(e);
        let res = s.cosmetic_resources("https://www.youtube.com/watch?v=x");
        assert!(res.active && res.ready);
        // playerAds/adPlacements вырезаются как раньше (P-07: рекламы нет)
        assert!(res
            .injected_script
            .contains(r#"setConstant("ytInitialPlayerResponse.playerAds", "undefined")"#));
        assert!(res
            .injected_script
            .contains(r#"setConstant("ytInitialPlayerResponse.adPlacements", "undefined")"#));
        // adSlots больше не трогаем — SABR/SSAI-хендшейк проходит штатно
        assert!(
            !res.injected_script
                .contains(r#"setConstant("ytInitialPlayerResponse.adSlots", "undefined")"#),
            "set adSlots должен быть нейтрализован"
        );
        assert!(
            !res.injected_script.contains(
                r#""playerResponse.adPlacements playerResponse.playerAds playerResponse.adSlots adPlacements playerAds adSlots""#
            ),
            "json-prune с adSlots должен быть нейтрализован"
        );
        // наш json-prune без adSlots действует
        assert!(res
            .injected_script
            .contains(r#"jsonPrune("playerResponse.adPlacements playerResponse.playerAds adPlacements playerAds")"#));
        // новый текст json-prune (без www, uAssets 21.10+) нейтрализован на
        // своих хостах: adSlots не вырезается и на m.youtube.com
        let mres = s.cosmetic_resources("https://m.youtube.com/watch?v=x");
        assert!(mres.active && mres.ready);
        assert!(
            !mres.injected_script.contains(
                r#""playerResponse.adPlacements playerResponse.playerAds playerResponse.adSlots adPlacements playerAds adSlots""#
            ),
            "json-prune с adSlots нейтрализован и на m.youtube.com (новый текст без www)"
        );
        assert!(mres
            .injected_script
            .contains(r#"jsonPrune("playerResponse.adPlacements playerResponse.playerAds adPlacements playerAds")"#));
        // чужой хост — ничего (как у исходных правил)
        assert!(s
            .cosmetic_resources("https://other.test/")
            .injected_script
            .is_empty());
    }

    #[test]
    fn compat_only_with_default_lists() {
        let _env = ENV_LOCK.lock().unwrap();
        let _guard = EnvGuard::set("DUOPULSE_ADBLOCK_LISTS", "a=C:\\tmp\\a.txt");
        assert!(
            !list_defs().iter().any(|d| d.source == COMPAT_SOURCE),
            "env-переопределение (e2e) не тянет compat-список"
        );
        std::env::remove_var("DUOPULSE_ADBLOCK_LISTS");
        let defs = list_defs();
        assert!(defs.iter().any(|d| d.source == COMPAT_SOURCE));
        assert_eq!(
            defs.iter().filter(|d| d.source != COMPAT_SOURCE).count(),
            DEFAULT_LISTS.len(),
            "сетевые списки не задвоены"
        );
    }

    // --- ранний синхронный канал (карточка 044) --------------------------------

    #[test]
    fn early_endpoint_serves_active_resources_and_gates() {
        let s = service();
        // движка ещё нет → active+not-ready: скрипт остаётся на async-пути
        let (status, body) = early_response_for(
            "/duopulse-cosmetic?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dx",
            &s,
        );
        assert_eq!(status, "200 OK");
        assert!(
            body.contains(r#""active":true"#) && body.contains(r#""ready":false"#),
            "{body}"
        );

        s.set_engine(scriptlet_engine(&[
            "www.youtube.com##+js(set, ytInitialPlayerResponse.playerAds, undefined)",
            "www.youtube.com##.mastad",
        ]));
        let (_, body) = early_response_for(
            "/duopulse-cosmetic?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dx",
            &s,
        );
        assert!(
            body.contains(r#""active":true"#) && body.contains(r#""ready":true"#),
            "{body}"
        );
        assert!(
            body.contains("ytInitialPlayerResponse.playerAds"),
            "код скриптлета в ответе: {body}"
        );
        assert!(
            body.contains(".mastad"),
            "селекторы скрытия в ответе: {body}"
        );

        // выключенный блокировщик — active=false (тумблер действует на
        // следующий документ без гонок)
        {
            let mut g = s.inner.lock().unwrap();
            g.enabled = false;
        }
        let (_, body) = early_response_for(
            "/duopulse-cosmetic?url=https%3A%2F%2Fwww.youtube.com%2Fwatch",
            &s,
        );
        assert!(body.contains(r#""active":false"#), "{body}");
    }

    #[test]
    fn early_endpoint_rejects_bad_paths_and_schemes() {
        let s = service();
        let (status, _) = early_response_for("/duopulse-cosmetic?url=ftp%3A%2F%2Fx", &s);
        assert_eq!(status, "400 Bad Request", "только http(s)");
        let (status, _) = early_response_for("/elsewhere?url=https%3A%2F%2Fa.test", &s);
        assert_eq!(status, "404 Not Found");
        // percent-декодирование: %2F → /, «+» остаётся «+» (encodeURIComponent)
        assert_eq!(percent_decode("a%2Fb%3Fc%2Bd%20e"), "a/b?c+d e");
    }

    #[test]
    fn engine_cache_rebuilds_when_resource_digest_changes() {
        // Скомпилированный движок валиден только при совпадении ВСЕХ меток,
        // включая digest ресурсного набора: имитируем engine.json со старым
        // набором меток — load_compiled обязан отказаться от кэша.
        let dir =
            std::env::temp_dir().join(format!("duopulse-adblock-scriptlet-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let filters = dir.join("filters");
        std::fs::create_dir_all(&filters).unwrap();
        let mut digests = vec![1u64];
        digests.push(digest(SCRIPTLETS_JSON));
        write_compiled(&filters, b"stale", &digests[..digests.len() - 1]);
        assert!(
            load_compiled(&filters, &digests).is_none(),
            "старые метки (без digest скриптлетов) не принимаются"
        );
        write_compiled(&filters, b"stale", &digests);
        // байты не движка — deserialize не пройдёт, но метки уже с digest
        assert!(load_compiled(&filters, &digests).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
