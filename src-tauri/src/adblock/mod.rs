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
//! Списки: EasyList + uBO filters (ads) + живой uBO quick-fixes (SSAI-ансамбль,
//! карточка 074; оффлайн-фолбэк — встроенный снапшот) + встроенный compat;
//! загрузка по HTTPS,
//! кэш текстов в `profile/filters/<имя>.txt` (docs/02 §8), скомпилированный
//! движок в `engine.bin` (deserialize — сотни мс против секунд парсинга),
//! метаданные (digest/дата/число правил) — `meta.json`. Фоновое обновление:
//! на старте отсутствующие/протухшие (сутки) списки, далее проверка раз в
//! час и по команде `adblock.update_lists`.
//!
//! Перезапись тел ответов (`$replace`, карточка duopulse-050): движок
//! adblock-rs опцию не поддерживает — правила разбирает собственный парсер
//! из тех же текстов (подмножество `replace.rs`), решение отдаёт
//! [`AdblockService::replace_plan`], а самофетч/подмену ответа делает
//! COM-перехватчик (main.rs); счётчик переписанных — `replaced_total`.
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

pub(crate) mod replace;

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

/// Встроенный снапшот uBO quick-fixes (карточки 069/072/074): оффлайн-фолбэк
/// живого источника `QUICKFIX_URL` — первый запуск без сети/кэша работает на
/// нём, дальше список качается и обновляется как EasyList. Обновление
/// снапшота — пересборкой (замена текста в quickfix.txt).
const QUICKFIX_RULES: &str = include_str!("quickfix.txt");
/// Живой список uBO quick-fixes (карточка 074): против SSAI-преролла YouTube
/// работает только весь текущий ансамбль uBO (rpnt serverContract + правила
/// аттестации + перезапись fetch/xhr-ответов), а список меняется почти
/// ежедневно — замороженный снапшот 072 протухал за сутки. Качается и
/// обновляется (сутки/час) тем же механизмом, что EasyList; trusted — тот же
/// уровень доверия, который даёт списку сам uBO.
const QUICKFIX_URL: &str = "https://ublockorigin.github.io/uAssets/filters/quick-fixes.txt";

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
    /// Списку доверяют trusted-скриптлеты (`trusted-*`, карточки 050/061):
    /// uBO-кураторский список и наш встроенный compat — тот же уровень
    /// доверия, что даёт им сам uBO; EasyList и env-списки (e2e) — нет.
    trusted: bool,
}

/// Право на trusted-скриптлеты ВКЛЮЧЕНО решением автора 29.10.2026 (карточка
/// 061, вопрос duopulse_061_choice_20261029): живые trusted-replace-xhr-
/// response uBO убирают SSAI-рекламу в части свежих сессий (замер 050: 2/3,
/// P-07 19% ≤ 60%), плата — обёртки fetch/XHR на youtube-документах (~+8%
/// к P-08, замер 050); откат — убрать имя из списка ниже. До 29.10 доверие
/// было выключено экспериментом 050 (решение А автора от 22.10).
/// duopulse-quickfix (карточка 074) — живой кураторский список uBO
/// quick-fixes: тот же уровень доверия, который даёт ему сам uBO.
fn trusted_list(name: &str) -> bool {
    matches!(name, "ublock-ads" | "duopulse-compat" | "duopulse-quickfix")
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
                trusted: trusted_list(n),
            })
            .collect();
        defs.push(ListDef {
            name: "duopulse-compat".into(),
            source: COMPAT_SOURCE.into(),
            trusted: trusted_list("duopulse-compat"),
        });
        // Карточка 074: живой список uBO quick-fixes (URL, качается как
        // EasyList; оффлайн-фолбэк — встроенный снапшот) — trusted-источник,
        // как compat.
        defs.push(ListDef {
            name: "duopulse-quickfix".into(),
            source: QUICKFIX_URL.into(),
            trusted: trusted_list("duopulse-quickfix"),
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
                trusted: false,
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
    /// Нетрастед-списки (EasyList и env-источники e2e): живёт в скомпилированном
    /// кэше `engine.bin` (deserialize — сотни мс против секунд парсинга).
    engine: Option<Arc<Engine>>,
    /// Trusted-списки (uBO-кураторские + compat): ВСЕГДА пересобирается из
    /// текстов, никогда не сериализуется. Причина — баг adblock-rs 0.9.8
    /// (карточка duopulse-080): `serialize_raw` выбрасывает PermissionMask
    /// скриптлет-правил (data_format/v0.rs: `for (f, _mask) in bin`), а
    /// `deserialize` восстанавливает её пустой — любой движок из engine.bin
    /// теряет ВСЕ trusted-скриптлеты (rpnt serverContract, аттестация
    /// trusted-edit-inbound-object, trusted-rpfr — ансамбль против SSAI
    /// YouTube), оставались только нетрастед (json-prune…) и сетевые правила,
    /// и серверный преролл (USDAI) проигрывался в каждой сессии после первой.
    trusted_engine: Option<Arc<Engine>>,
    lists: Vec<ListState>,
    blocked_total: u64,
    /// Все http(s)-запросы через перехватчик (диагностика P-07: «до/после»).
    seen_total: u64,
    /// Неслитый в UI прирост блокировок (adblock:blocked_count).
    pending_delta: u64,
    /// $replace-правила из сырых текстов списков (движок их отбрасывает —
    /// UnrecognisedOption; карточка duopulse-050), включая @@-исключения.
    replace_rules: Vec<replace::ReplaceRule>,
    /// Ответов, чьи тела реально переписаны ($replace, диагностика).
    replaced_total: u64,
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
                trusted_engine: None,
                lists,
                blocked_total: 0,
                seen_total: 0,
                pending_delta: 0,
                replace_rules: Vec::new(),
                replaced_total: 0,
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
        let engine = guard.engine.clone();
        let trusted_engine = guard.trusted_engine.clone();
        if engine.is_none() && trusted_engine.is_none() {
            return false;
        }
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
        // Двухдвижковая схема (карточка 080): основной кэш + trusted-движок из
        // текстов; сетевые правила trusted-списков (uBO quick-fixes: SSAI-медиа
        // googlevideo с неправдоподобным expire и пр.) живут здесь.
        let blocked = engine
            .as_ref()
            .is_some_and(|e| e.check_network_request(&request).matched)
            || trusted_engine
                .as_ref()
                .is_some_and(|e| e.check_network_request(&request).matched);
        if blocked {
            let mut guard = self.inner.lock().expect("adblock: лок не отравлен");
            guard.blocked_total += 1;
            guard.pending_delta += 1;
        }
        blocked
    }

    /// План перезаписи тела ответа ($replace, карточка duopulse-050): ops для
    /// URL, если живое правило совпало и не погашено @@-исключением. Вызов —
    /// из COM-перехватчика ПОСЛЕ should_block=false; тумблер/сайт-исключения
    /// действуют так же, как на блокировки. None — переписывать нечего.
    pub fn replace_plan(
        &self,
        tab_url: Option<&str>,
        uri: &str,
        request_type: &str,
        referer: Option<&str>,
    ) -> Option<Vec<replace::ReplaceOp>> {
        let guard = self.inner.lock().expect("adblock: лок не отравлен");
        if !guard.enabled || guard.replace_rules.is_empty() {
            return None;
        }
        // Источник запроса — та же логика, что в should_block (document —
        // сама цель, подресурсы — Referer/URL вкладки)
        let source = if request_type == "document" {
            uri
        } else {
            referer
                .filter(|r| r.starts_with("http://") || r.starts_with("https://"))
                .or(tab_url)
                .unwrap_or(uri)
        };
        if source_host_exempted(&guard.site_exceptions, source) {
            return None;
        }
        let source_host = replace::host_of(source);
        if guard
            .replace_rules
            .iter()
            .any(|r| r.exception && r.matches(uri, request_type, source_host.as_deref()))
        {
            return None;
        }
        let ops: Vec<replace::ReplaceOp> = guard
            .replace_rules
            .iter()
            .filter(|r| !r.exception && r.matches(uri, request_type, source_host.as_deref()))
            .flat_map(|r| r.ops.iter().cloned())
            .collect();
        if ops.is_empty() {
            None
        } else {
            Some(ops)
        }
    }

    /// Отметить успешную перезапись тела ответа (счётчик диагностики,
    /// adblock.status.replacedTotal).
    pub fn note_replaced(&self) {
        let mut guard = self.inner.lock().expect("adblock: лок не отравлен");
        guard.replaced_total += 1;
    }

    /// adblock.status: снапшот состояния для UI/e2e.
    pub fn status(&self) -> AdblockStatusResult {
        let guard = self.inner.lock().expect("adblock: лок не отравлен");
        AdblockStatusResult {
            enabled: guard.enabled,
            ready: guard.engine.is_some() || guard.trusted_engine.is_some(),
            blocked_total: guard.blocked_total,
            seen_total: guard.seen_total,
            replace_rules: guard.replace_rules.iter().filter(|r| !r.exception).count() as u32,
            replaced_total: guard.replaced_total,
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
                ready: guard.engine.is_some() || guard.trusted_engine.is_some(),
                hide: vec![],
                generichide: false,
                injected_script: String::new(),
            };
        }
        let engine = guard.engine.clone();
        let trusted_engine = guard.trusted_engine.clone();
        if engine.is_none() && trusted_engine.is_none() {
            // списки ещё грузятся — скрипту стоит повторить запрос (ready=false)
            return CosmeticResources {
                active: true,
                ready: false,
                hide: vec![],
                generichide: false,
                injected_script: String::new(),
            };
        }
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
        // Слияние двух движков (карточка 080): скрытия — объединением и
        // дедупликацией, generichide — ИЛИ, скриптлеты — конкатенацией
        // (trusted-скриптлеты даёт только свежий trusted-движок — кэш
        // engine.bin их теряет вместе с PermissionMask).
        let mut hide: Vec<String> = Vec::new();
        let mut generichide = false;
        let mut injected_script = String::new();
        for engine in engine.iter().chain(trusted_engine.iter()) {
            let res = engine.url_cosmetic_resources(url);
            hide.extend(res.hide_selectors.into_iter());
            generichide = generichide || res.generichide;
            if !res.injected_script.is_empty() {
                if !injected_script.is_empty() {
                    injected_script.push('\n');
                }
                injected_script.push_str(&res.injected_script);
            }
        }
        hide.sort_unstable();
        hide.dedup();
        CosmeticResources {
            active: true,
            ready: true,
            hide,
            generichide,
            injected_script,
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
        let engine = guard.engine.clone();
        let trusted_engine = guard.trusted_engine.clone();
        if engine.is_none() && trusted_engine.is_none() {
            return vec![];
        }
        drop(guard);
        let classes = &classes[..classes.len().min(MAX_TOKENS)];
        let ids = &ids[..ids.len().min(MAX_TOKENS)];
        // Оба движка (карточка 080), каждый со своими исключениями хоста.
        let mut selectors: Vec<String> = Vec::new();
        for engine in engine.iter().chain(trusted_engine.iter()) {
            let exceptions = engine.url_cosmetic_resources(url).exceptions;
            selectors.extend(engine.hidden_class_id_selectors(classes.iter(), ids.iter(), &exceptions));
        }
        selectors.sort_unstable();
        selectors.dedup();
        selectors
    }

    // --- нить обновления ----------------------------------------------------

    fn updater_loop(self: Arc<Self>) {
        // Карточка 077: движок из кэша прошлой сессии публикуем ДО сетевого
        // прохода — refresh_lists при протухших списках сначала качает их.
        self.restore_from_cache();
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

    /// Карточка 077: восстановить движок из дискового кэша прошлой сессии
    /// БЕЗ сети — до первого refresh_lists. Раньше движок публиковался только
    /// после refresh_lists, а тот при протухших (>суток) списках сначала их
    /// СКАЧИВАЕТ (секунды до тайм-аута на каждый сетевой список) — всё это
    /// время should_block fail-open, и первое после запуска браузера видео
    /// получало SSAI/клиентскую рекламу, а после F5 («рекламы нет и не будет»)
    /// движок уже готов. Кэш есть почти всегда: публикуем движок мгновенно,
    /// сеть досмотрит обновления следом и подменит движок при изменениях.
    fn restore_from_cache(&self) {
        let defs = list_defs();
        if defs.is_empty() {
            return; // списки выключены окружением (e2e)
        }
        let filters_dir = self.profile_dir.join("filters");
        let meta = read_meta(&filters_dir);
        // Тексты только с диска: compat — встроенный, quickfix без кэша —
        // встроенный снапшот (как в refresh_lists, карточка 074), прочие —
        // файлы кэша; источники (URL) не трогаем — сети здесь нет.
        let mut texts: Vec<(String, String, bool)> = Vec::new();
        let mut states: Vec<ListState> = Vec::new();
        for def in &defs {
            let path = list_path(&filters_dir, &def.name);
            let text = if def.source == COMPAT_SOURCE {
                Some(COMPAT_RULES.to_string())
            } else {
                std::fs::read_to_string(&path).ok().or_else(|| {
                    (def.name == "duopulse-quickfix").then(|| QUICKFIX_RULES.to_string())
                })
            };
            let Some(text) = text else {
                continue; // кэша нет — первый запуск, дождёмся сети
            };
            states.push(ListState {
                name: def.name.clone(),
                source: def.source.clone(),
                rules: count_rules(&text),
                updated_at: meta
                    .lists
                    .get(&def.name)
                    .map(|m| m.updated_at)
                    .unwrap_or(0),
                error: String::new(),
            });
            texts.push((def.name.clone(), text, def.trusted));
        }
        if texts.is_empty() {
            return;
        }
        // Полный набор текстов: годится и без engine.bin (смена бинарника —
        // digest'ы не совпали) — соберём и закэшируем. Частичный: только
        // скомпилированный кэш с совпавшими digest'ами прошлой сессии.
        let digests = compiled_digests(&defs, &meta);
        let engine = if texts.len() == defs.len() {
            compiled_or_from_texts(&filters_dir, &digests, &texts)
        } else {
            load_compiled(&filters_dir, &digests).map(|mut e| {
                e.use_resources(scriptlet_resources().iter().cloned());
                e
            })
        };
        let trusted = trusted_engine_from_texts(&texts).map(Arc::new);
        if engine.is_none() && trusted.is_none() {
            return;
        }
        let mut guard = self.inner.lock().expect("adblock: лок не отравлен");
        if guard.engine.is_some() || guard.trusted_engine.is_some() {
            return; // refresh уже успел — не откатываем его движки
        }
        if engine.is_some() {
            guard.engine = engine.map(Arc::new);
        }
        if trusted.is_some() {
            guard.trusted_engine = trusted;
        }
        // $replace-правила — из тех же кэш-текстов
        guard.replace_rules = texts
            .iter()
            .flat_map(|(_, t, _)| replace::parse_replace_rules(t))
            .collect();
        guard.lists = states;
    }

    /// Один проход обновления: отсутствующие/протухшие списки → скачать;
    /// пересобрать движок, если изменился состав правил. Ошибка сети не
    /// роняет текущий движок — работает кэш до удачного обновления.
    fn refresh_lists(&self, force: bool) {
        let defs = list_defs();
        let filters_dir = self.profile_dir.join("filters");
        let _ = std::fs::create_dir_all(&filters_dir);
        let mut texts: Vec<(String, String, bool)> = Vec::new(); // (имя, текст, trusted)
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
                        if cached.is_none() && def.name == "duopulse-quickfix" {
                            // Оффлайн-запуск без кэша (карточка 074): лучше
                            // протухший встроенный снапшот ансамбля, чем
                            // пустой список; кэш пишем — до удачной загрузки.
                            atomic_write(&path, QUICKFIX_RULES.as_bytes());
                            (Some(QUICKFIX_RULES.to_string()), now, String::new())
                        } else {
                            // кэш есть — работаем на нём, ошибку покажем в статусе
                            (cached.clone(), cached_at, e.to_string())
                        }
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
            texts.push((def.name.clone(), text, def.trusted));
        }

        if defs.is_empty() {
            // Явно выключено окружением (e2e): движка не будет.
            let mut guard = self.inner.lock().expect("adblock: лок не отравлен");
            guard.engine = None;
            guard.trusted_engine = None;
            guard.lists = new_states;
            guard.replace_rules = Vec::new();
            guard.early_cache.clear();
            return;
        }

        let digests = compiled_digests(&defs, &meta);
        let engine = compiled_or_from_texts(&filters_dir, &digests, &texts);
        write_meta(&filters_dir, &meta);

        let mut guard = self.inner.lock().expect("adblock: лок не отравлен");
        guard.lists = new_states;
        // Полный набор текстов → движки из них. Частичный — только если
        // движка ещё нет: один недоступный источник не должен оставлять
        // блокировщик совсем без списков (EasyList один уже полезен);
        // при живом движке частичное обновление его не трогает.
        // Trusted-движок — всегда из текстов (карточка 080), дёшево.
        if texts.len() == defs.len() || (!texts.is_empty() && guard.engine.is_none()) {
            guard.engine = engine.map(Arc::new);
            guard.trusted_engine = trusted_engine_from_texts(&texts).map(Arc::new);
            // $replace-правила — из тех же текстов, что построили движок
            guard.replace_rules = texts
                .iter()
                .flat_map(|(_, t, _)| replace::parse_replace_rules(t))
                .collect();
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

    /// Тестам: подставить trusted-движок (карточка 080, двухдвижковая схема).
    #[cfg(test)]
    fn set_trusted_engine(&self, engine: Engine) {
        let mut guard = self.inner.lock().unwrap();
        guard.trusted_engine = Some(Arc::new(engine));
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
/// Набор digest'ов валидности engine.bin (общий для refresh и restore).
/// Карточка 080: engine.bin — только НЕТРАСТЕД-списки (trusted-движок не
/// сериализуется вовсе — см. [`AdblockService`] / `Inner::trusted_engine`);
/// маркер формата `enginesplit` гонит одну внеплановую пересборку при смене
/// схемы (старый bin содержал все списки). Ресурсный набор скриптлетов —
/// в том же наборе (смена набора при обновлении бинарника перестраивает
/// engine.bin).
fn compiled_digests(defs: &[ListDef], meta: &ListsMeta) -> Vec<u64> {
    let mut digests: Vec<u64> = defs
        .iter()
        .filter(|d| !d.trusted)
        .map(|d| meta.lists.get(&d.name).map(|m| m.digest).unwrap_or(0))
        .collect();
    digests.push(digest(SCRIPTLETS_JSON));
    digests.push(digest("enginesplit:trusted-v2"));
    digests
}

/// Trusted-движок из текстов доверенных списков (карточка 080): собирается
/// при каждом старте/обновлении и НИКОГДА не проходит serialize→deserialize —
/// roundtrip adblock-rs стирает PermissionMask скриптлет-правил, без маски
/// trusted-скриптлеты (rpnt/trusted-*) не инъецируются. Парсинг сотен/тысяч
/// правил — десятки мс против секунд EasyList. Сетевые правила trusted-списков
/// тоже здесь (uBO quick-fixes: блокировка SSAI-медиа googlevideo).
fn trusted_engine_from_texts(texts: &[(String, String, bool)]) -> Option<Engine> {
    let mut set = adblock::lists::FilterSet::new(false);
    let mut any = false;
    for (_, text, trusted) in texts {
        if !trusted {
            continue;
        }
        any = true;
        set.add_filters(
            text.lines(),
            ParseOptions {
                permissions: adblock::resources::PermissionMask::from_bits(1),
                ..ParseOptions::default()
            },
        );
    }
    if !any {
        return None;
    }
    let mut engine = Engine::from_filter_set(set, true);
    engine.use_resources(scriptlet_resources().iter().cloned());
    Some(engine)
}

/// Движок по digest'ам: скомпилированный кэш, иначе сборка из текстов.
/// serialize_raw ресурсы не хранит — подключаем после deserialize.
/// Собирается ТОЛЬКО из нетрастед-текстов (карточка 080): trusted-списки
/// живёт в отдельном несериализуемом движке (`trusted_engine_from_texts`) —
/// права у кэша всё равно теряются. Собранный движок пишется в engine.bin
/// по тем же digest'ам.
fn compiled_or_from_texts(
    filters_dir: &std::path::Path,
    digests: &[u64],
    texts: &[(String, String, bool)],
) -> Option<Engine> {
    if let Some(mut e) = load_compiled(filters_dir, digests) {
        e.use_resources(scriptlet_resources().iter().cloned());
        return Some(e);
    }
    let mut set = adblock::lists::FilterSet::new(false);
    for (_, text, trusted) in texts {
        if *trusted {
            continue;
        }
        set.add_filters(text.lines(), ParseOptions::default());
    }
    let mut engine = Engine::from_filter_set(set, true);
    engine.use_resources(scriptlet_resources().iter().cloned());
    if let Ok(bin) = engine.serialize_raw() {
        write_compiled(filters_dir, &bin, digests);
    }
    Some(engine)
}

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
                    source: "C:\\tmp\\a.txt".into(),
                    trusted: false,
                },
                ListDef {
                    name: "b".into(),
                    source: "https://x.test/b.txt".into(),
                    trusted: false,
                },
            ]
        );
        let _guard = EnvGuard::set("DUOPULSE_ADBLOCK_LISTS", "  ");
        assert!(list_defs().is_empty());
    }

    #[test]
    fn default_lists_trusted_marks() {
        // Решение автора 29.10.2026 (карточка 061): доверие включено только
        // кураторским источникам uBO и нашему compat; EasyList и env-списки
        // (e2e) — без доверия (как в самом uBO)
        let _env = ENV_LOCK.lock().unwrap();
        std::env::remove_var("DUOPULSE_ADBLOCK_LISTS");
        let defs = list_defs();
        let by_name = |n: &str| defs.iter().find(|d| d.name == n).map(|d| d.trusted);
        assert_eq!(
            by_name("ublock-ads"),
            Some(true),
            "uBO-кураторский список доверен"
        );
        assert_eq!(by_name("duopulse-compat"), Some(true), "compat доверен");
        assert_eq!(
            by_name("duopulse-quickfix"),
            Some(true),
            "quickfix доверен (карточка 069)"
        );
        assert_eq!(by_name("easylist"), Some(false), "EasyList — без доверия");
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
    fn restore_from_cache_publishes_engine_before_network() {
        // Карточка 077: после перезапуска движок поднимается из кэша ДО
        // сетевого прохода refresh_lists (раньше на время скачивания
        // протухших списков should_block был fail-open — «первая реклама
        // после запуска, после F5 — нет»).
        let _env = ENV_LOCK.lock().unwrap();
        let dir =
            std::env::temp_dir().join(format!("duopulse-adblock-restore-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // первый запуск: файловый источник строит и кэширует движок
        let list = dir.join("list.txt");
        std::fs::write(&list, "/alwaysblocked/*\n").unwrap();
        let _guard = EnvGuard::set("DUOPULSE_ADBLOCK_LISTS", &format!("t={}", list.display()));
        let profile = dir.join("profile");
        std::fs::create_dir_all(&profile).unwrap();
        let s = AdblockService::new(&profile);
        s.refresh_lists(false);
        assert!(s.status().ready, "предусловие: кэш создан");

        // перезапуск: источник — «мертвый» URL, refresh_lists его не скачал бы;
        // restore_from_cache поднимает движок без сети
        let _guard2 =
            EnvGuard::set("DUOPULSE_ADBLOCK_LISTS", "t=https://nonexistent.invalid/list.txt");
        let s2 = AdblockService::new(&profile);
        assert!(!s2.status().ready, "до restore движка ещё нет");
        s2.restore_from_cache();
        assert!(s2.status().ready, "карточка 077: движок из кэша без сети");
        assert!(s2.should_block(None, "https://any.test/alwaysblocked/ad.js", "script", None));
        assert!(!s2.should_block(None, "https://any.test/ok.js", "script", None));
        // статусы списков заполнены из кэша, а не «список ещё не загружен»
        let st = s2.status();
        assert_eq!(st.lists.len(), 1);
        assert_eq!(st.lists[0].rules, 1);
        assert!(st.lists[0].error.is_none(), "{:?}", st.lists[0].error);

        // пустой кэш (первый запуск): restore честно оставляет движок None
        let fresh = dir.join("fresh-profile");
        std::fs::create_dir_all(&fresh).unwrap();
        let s3 = AdblockService::new(&fresh);
        s3.restore_from_cache();
        assert!(!s3.status().ready, "без кэша движок ждёт сеть, как раньше");

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
    fn trusted_scriptlet_injects_with_granted_permission() {
        // Карточка 050: механизм per-list-доверия (FilterSet + PermissionMask,
        // refresh_lists) — живые правила trusted-replace-xhr-response uBO
        // инъенцируются, когда списку выданы trusted-права парсинга
        let mut set = adblock::lists::FilterSet::new(false);
        set.add_filters(
            [r#"www.youtube.com##+js(trusted-replace-xhr-response, '"adSlots"', '"no_ads"', /player?/)"#],
            ParseOptions {
                permissions: adblock::resources::PermissionMask::from_bits(1),
                ..ParseOptions::default()
            },
        );
        let mut engine = Engine::from_filter_set(set, true);
        engine.use_resources(scriptlet_resources().iter().cloned());
        let s = service();
        s.set_engine(engine);
        let res = s.cosmetic_resources("https://www.youtube.com/watch?v=x");
        assert!(
            res.injected_script.contains("trustedReplaceXhrResponse"),
            "trusted-скриптлет инъенцируется с правами: {}",
            &res.injected_script[..res.injected_script.len().min(200)]
        );
    }

    // --- карточка duopulse-069: rpnt-порт (trusted-replace-node-text) ---------

    #[test]
    fn quickfix_prevent_dom_bypass_injected_on_youtube() {
        // Карточка duopulse-075: живые правила quick-fixes
        // `##+js(trusted-prevent-dom-bypass, Node.prototype.appendChild, fetch|Request)`
        // были мертвы — ресурса не было ни в пакете, ни у нас. Порт
        // (scripts/prevent-dom-bypass-scriptlet.js) подключён конвертером:
        // правила инъецируются на YouTube (анти-байпас about:blank iframe).
        let mut set = adblock::lists::FilterSet::new(false);
        set.add_filters(
            QUICKFIX_RULES.lines(),
            ParseOptions {
                permissions: adblock::resources::PermissionMask::from_bits(1),
                ..ParseOptions::default()
            },
        );
        let mut engine = Engine::from_filter_set(set, true);
        engine.use_resources(scriptlet_resources().iter().cloned());
        let s = service();
        s.set_engine(engine);
        let res = s.cosmetic_resources("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
        assert!(
            res.injected_script.matches("trustedPreventDOMBypass(").count() >= 2,
            "оба trusted-prevent-dom-bypass правила quickfix инъецируются (fetch и Request): {}",
            &res.injected_script[..res.injected_script.len().min(300)]
        );
        // Внутри порта — семантика uBO: делегирование пропатченного метода
        // родителя встроенному контексту и замена контекста целиком.
        assert!(res.injected_script.contains("contentWindow"));
        assert!(res.injected_script.contains("[object Window]"));
    }

    #[test]
    fn quickfix_servercontract_rpnt_injected_on_youtube() {
        // Встроенный quickfix-снапшот (QUICKFIX_RULES, тот же trusted-режим,
        // что выдаётся списку duopulse-quickfix в refresh_lists): гигантское
        // правило serverContract инъецируется в injected_script — ранний
        // doc-start-канал (cosmetic.js) исполнит его до инлайн-скриптов
        // страницы, до чтения ytInitialPlayerResponse.
        let mut set = adblock::lists::FilterSet::new(false);
        set.add_filters(
            QUICKFIX_RULES.lines(),
            ParseOptions {
                permissions: adblock::resources::PermissionMask::from_bits(1),
                ..ParseOptions::default()
            },
        );
        let mut engine = Engine::from_filter_set(set, true);
        engine.use_resources(scriptlet_resources().iter().cloned());
        let s = service();
        s.set_engine(engine);
        let res = s.cosmetic_resources("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
        let _ = std::fs::write(
            std::env::temp_dir().join("duopulse-rpnt-injected.js"),
            &res.injected_script,
        );
        assert!(
            res.injected_script.contains("trustedReplaceNodeText("),
            "rpnt-правило quickfix инъецируется на YouTube: {}",
            &res.injected_script[..res.injected_script.len().min(300)]
        );
        // Replacement дошёл целиком (экранирование запятых `\,` из списка
        // снято движком — normalize_arg): ключевые фрагменты замены на месте,
        // включая $1-подстановку и НЕэкранированную запятую в хвосте.
        for needle in [
            "serverContract",
            "sedCount",
            "js_ld",
            "})();$1",
            "Promise.prototype.then,i)})();$1",
        ] {
            assert!(
                res.injected_script.contains(needle),
                "аргументы правила дошли до инъекции: нет {needle:?}"
            );
        }
        let other = s.cosmetic_resources("https://example.com/");
        assert!(
            !other.injected_script.contains("trustedReplaceNodeText"),
            "правило хост-специфично для www.youtube.com"
        );
    }

    #[test]
    fn rpnt_alias_requires_trusted_list() {
        // uBO-алиас rpnt замаплен на trusted-replace-node-text (базового
        // replace-node-text в пакете @adguard/scriptlets нет, карточка 069):
        // из недоверенных списков (EasyList, env-списки e2e) замены с
        // произвольным JS на страницу не попадают — PermissionMask.
        let e = scriptlet_engine(&["a.test##+js(rpnt, script, foo, bar)"]);
        let s = service();
        s.set_engine(e);
        let res = s.cosmetic_resources("https://a.test/");
        assert!(
            !res.injected_script.contains("trustedReplaceNodeText"),
            "rpnt из untrusted-списка не инъецируется"
        );
    }

    // --- карточка duopulse-080: двухдвижковая схема (кэш + trusted) --------

    #[test]
    fn serialize_roundtrip_drops_trusted_scriptlets() {
        // Корень 080: serialize_raw adblock-rs 0.9.8 выбрасывает PermissionMask
        // скриптлет-правил (data_format/v0.rs: `for (f, _mask) in bin`),
        // deserialize восстанавливает её пустой — движок из engine.bin терял
        // ВСЕ trusted-скриптлеты uBO (rpnt serverContract, аттестация
        // trusted-edit-inbound-object, trusted-rpfr — ансамбль против SSAI
        // YouTube), и серверный преролл играл в каждой сессии после первой.
        // Тест фиксирует баг библиотеки как факт — почва для split-схемы.
        let texts = vec![(
            "q".to_string(),
            "a.test##+js(rpnt, script, foo, bar)".to_string(),
            true,
        )];
        let mut engine = trusted_engine_from_texts(&texts).unwrap();
        let s = service();
        s.set_engine(trusted_engine_from_texts(&texts).unwrap());
        let live = s.cosmetic_resources("https://a.test/");
        assert!(
            live.injected_script.contains("trustedReplaceNodeText("),
            "живой движок (из текстов) инъецирует rpnt"
        );
        // тот же движок после serialize→deserialize (путь engine.bin)
        let bytes = engine.serialize_raw().unwrap();
        let mut restored = Engine::default();
        restored.deserialize(&bytes).unwrap();
        restored.use_resources(scriptlet_resources().iter().cloned());
        let s2 = service();
        s2.set_engine(restored);
        let dead = s2.cosmetic_resources("https://a.test/");
        assert!(
            !dead.injected_script.contains("trustedReplaceNodeText("),
            "баг adblock-rs: roundtrip кэша стирает trusted-скриптлеты"
        );
    }

    #[test]
    fn two_engine_scheme_keeps_trusted_rules_over_cache() {
        // Фикс 080: engine.bin — только нетрастед-списки, trusted-движок
        // всегда пересобирается из текстов. После «перезапуска» (кэш +
        // trusted-тексты) trusted-скриптлеты инъецируются, сетевые правила
        // работают из ОБОИХ движков (uBO quick-fixes блокирует SSAI-медиа).
        // Нетрастед-текст trusted-движка не строит (изоляция прав, 050).
        assert!(
            trusted_engine_from_texts(&[("e".into(), "b.test##+js(rpnt, x, y)".into(), false)])
                .is_none(),
            "нетрастед-тексты не дают trusted-движка"
        );
        let s = service();
        // нетрастед-кэш: сетевое правило блокируется основным движком
        let mut cache = Engine::from_rules(["/untrustednet/*"], ParseOptions::default());
        cache.use_resources(scriptlet_resources().iter().cloned());
        s.set_engine(cache);
        // trusted-движок из текстов: rpnt-скриптлет + своё сетевое правило
        let texts = vec![(
            "q".to_string(),
            "a.test##+js(rpnt, script, foo, bar)\n/trustednet/*".to_string(),
            true,
        )];
        s.set_trusted_engine(trusted_engine_from_texts(&texts).unwrap());
        let res = s.cosmetic_resources("https://a.test/");
        assert!(
            res.injected_script.contains("trustedReplaceNodeText("),
            "trusted-скриптлет доезжает через отдельный движок"
        );
        assert!(
            s.should_block(None, "https://a.test/untrustednet/x.js", "script", None),
            "сетевое правило нетрастед-движка работает"
        );
        assert!(
            s.should_block(None, "https://a.test/trustednet/x.js", "script", None),
            "сетевое правило trusted-движка (SSAI-медиа uBO) работает"
        );
    }

    // --- карточка duopulse-072: ансамбль quick-fixes (edit-inbound+rpfr+replace)

    #[test]
    fn quickfix_ensemble_injected_on_youtube() {
        // Полный ансамбль из quickfix-снапшота: 7 правил аттестации
        // trusted-edit-inbound-object (порт uBO 1.75.4) + 4 trusted-rpfr —
        // всё инъецируется в doc-start-канал на YouTube; аргументы доходят
        // целиком (экранирование `\,` движок снимает при парсинге скриптлетов).
        let mut set = adblock::lists::FilterSet::new(false);
        set.add_filters(
            QUICKFIX_RULES.lines(),
            ParseOptions {
                permissions: adblock::resources::PermissionMask::from_bits(1),
                ..ParseOptions::default()
            },
        );
        let mut engine = Engine::from_filter_set(set, true);
        engine.use_resources(scriptlet_resources().iter().cloned());
        let s = service();
        s.set_engine(engine);
        let res = s.cosmetic_resources("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
        let eio_calls = res
            .injected_script
            .matches("trustedEditInboundObject(\"")
            .count();
        assert_eq!(eio_calls, 7, "7 правил edit-inbound инъецируются");
        // ключевые фрагменты живых правил (jsonPath-редакторы, repl, ${now})
        for needle in [
            "attestationRequest",
            "clientScreen",
            "8AUB",
            "YAHI",
            "${now}",
            "#reloadxhr",
            "createCommentParams",
        ] {
            assert!(
                res.injected_script.contains(needle),
                "аргументы edit-inbound дошли: нет {needle:?}"
            );
        }
        // rpfr-варианты adPlacements/adSlots → no_ads. Считаем ВЫЗОВЫ —
        // needle с `("` не задевает определение `…Response(){` в инъекции.
        let rpfr_calls = res
            .injected_script
            .matches("trustedReplaceFetchResponse(\"")
            .count();
        assert_eq!(rpfr_calls, 4, "4 trusted-rpfr-правила инъецируются");
        // host-специфичность: чужой домен — ничего из ансамбля
        let other = s.cosmetic_resources("https://example.com/");
        assert!(!other.injected_script.contains("trustedEditInboundObject"));
        assert!(!other
            .injected_script
            .contains("trustedReplaceFetchResponse"));
    }

    #[test]
    fn edit_inbound_requires_trusted_list() {
        // Скриптлет правит ПРОИЗВОЛЬНЫЕ объекты в вызовах любых методов —
        // из недоверенных списков (env-списки e2e, EasyList) не инъецируется,
        // только trusted-источники (duopulse-quickfix/compat, ublock-ads).
        let e = scriptlet_engine(&[
            "a.test##+js(trusted-edit-inbound-object, JSON.stringify, 0, .a=1)",
        ]);
        let s = service();
        s.set_engine(e);
        let res = s.cosmetic_resources("https://a.test/");
        assert!(
            !res.injected_script.contains("trustedEditInboundObject"),
            "edit-inbound из untrusted-списка не инъецируется"
        );
    }

    #[test]
    fn quickfix_network_replace_rules_parsed() {
        // 8 живых $xhr,1p,replace= правил из quickfix-снапшота разбираются
        // сетевым слоем (replace.rs, карточка 050): adPlacements/adSlots →
        // no_ads на /playlist, /watch, /player, /get_watch. Проверяем сам
        // парсер+матчер (сервис подхватывает те же тексты в refresh_lists).
        let rules = replace::parse_replace_rules(QUICKFIX_RULES);
        assert_eq!(rules.len(), 8, "правил $replace в quickfix-снапшоте");
        assert!(
            rules.iter().all(|r| !r.exception),
            "все правила — рабочие (не @@-исключения)"
        );
        // матч: XHR /player с 1p-источника youtube.com — оба правила
        let player = rules
            .iter()
            .filter(|r| {
                r.matches(
                    "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
                    "xhr",
                    Some("www.youtube.com"),
                )
            })
            .count();
        assert_eq!(player, 2, "adPlacements+adSlots на /player");
        // get_watch (||youtube.com/… — поддомен www матчится)
        let gw = rules
            .iter()
            .filter(|r| {
                r.matches(
                    "https://www.youtube.com/youtubei/v1/get_watch?videoId=x",
                    "xhr",
                    Some("www.youtube.com"),
                )
            })
            .count();
        assert_eq!(gw, 2, "adPlacements+adSlots на /get_watch");
        // не-xhr тип — правила $xhr не действуют
        assert!(!rules.iter().any(|r| {
            r.matches(
                "https://www.youtube.com/youtubei/v1/player?x=1",
                "document",
                Some("www.youtube.com"),
            )
        }));
    }

    // --- карточка duopulse-074: живой quick-fixes, слой fetch/xhr-ответов ---

    /// Движок из текстов с trusted-правами (паттерн тестов 072).
    fn trusted_engine(texts: &[&str]) -> Engine {
        let mut set = adblock::lists::FilterSet::new(false);
        for t in texts {
            set.add_filters(
                t.lines(),
                ParseOptions {
                    permissions: adblock::resources::PermissionMask::from_bits(1),
                    ..ParseOptions::default()
                },
            );
        }
        let mut engine = Engine::from_filter_set(set, true);
        engine.use_resources(scriptlet_resources().iter().cloned());
        engine
    }

    #[test]
    fn quickfix_full_snapshot_injects_response_layer() {
        // Снапшот 074 добавил к ансамблю 072 слой перезаписи fetch/xhr-
        // ответов uBO (json-prune-fetch-response, json-prune-xhr-response,
        // trusted-replace-xhr-response) + анти-байпас (rmnt = remove-node-
        // text, nano-stb = adjust-setTimeout; ресурсы есть в пакете).
        // trusted-prevent-dom-bypass ресурса не имеет — правило инертно
        // (движок пропускает неизвестный скриптлет молча) и остальные
        // инъекции не ломает.
        let s = service();
        s.set_engine(trusted_engine(&[QUICKFIX_RULES]));
        let res = s.cosmetic_resources("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
        // ансамбль 072 жив
        let eio_calls = res.injected_script.matches("trustedEditInboundObject(\"").count();
        assert_eq!(eio_calls, 7, "7 правил edit-inbound инъецируются");
        let rpfr_calls = res.injected_script.matches("trustedReplaceFetchResponse(\"").count();
        assert_eq!(rpfr_calls, 4, "4 trusted-rpfr-правила инъецируются");
        // слой 074: перезапись ответов
        let fetch_prune = res.injected_script.matches("jsonPruneFetchResponse(\"").count();
        assert!(fetch_prune >= 3, "json-prune-fetch-response: {fetch_prune}");
        let xhr_prune = res.injected_script.matches("jsonPruneXhrResponse(\"").count();
        assert!(xhr_prune >= 1, "json-prune-xhr-response: {xhr_prune}");
        let xhr_replace = res
            .injected_script
            .matches("trustedReplaceXhrResponse(\"")
            .count();
        // 2 правила www.youtube.com (третье — tv.youtube.com, ниже)
        assert!(xhr_replace >= 2, "trusted-replace-xhr-response: {xhr_replace}");
        let tv = s.cosmetic_resources("https://tv.youtube.com/");
        assert!(
            tv.injected_script.matches("trustedReplaceXhrResponse(\"").count() >= 1,
            "tv.youtube-вариант инъецируется на tv"
        );
        // анти-байпас (алиасы пакета)
        assert!(
            res.injected_script.matches("removeNodeText(\"").count() >= 1,
            "rmnt → remove-node-text"
        );
        assert!(
            res.injected_script.matches("adjustSetTimeout(\"").count() >= 1,
            "nano-stb → adjust-setTimeout"
        );
        // сайт-специфичность слоя
        let other = s.cosmetic_resources("https://example.com/");
        assert!(!other.injected_script.contains("trustedReplaceXhrResponse"));
        assert!(!other.injected_script.contains("jsonPruneFetchResponse"));
    }

    #[test]
    fn compat_exception_neutralizes_firefox_json_prune() {
        // Живой quick-fixes несёт клиентскую adSlots-обрезку ТОЛЬКО в
        // env_firefox-ветке (json-prune … legacyImportant); наш парсер
        // директивы !#if не понимает (это комментарий) — правило
        // активировалось бы. Точное исключение в compat гасит его (линия
        // 044: клиентская adSlots-обрезка ломает SABR-хендшейк в DuoPulse).
        let live_rule = "youtube.com##+js(json-prune, playerResponse.adPlacements playerResponse.playerAds playerResponse.adSlots adPlacements playerAds adSlots legacyImportant)";
        let s = service();
        s.set_engine(trusted_engine(&[live_rule, COMPAT_RULES]));
        let res = s.cosmetic_resources("https://www.youtube.com/watch?v=x");
        assert!(
            !res.injected_script.contains("legacyImportant"),
            "правило погашено исключением compat"
        );
        // контроль механизма: без compat-исключения правило активно
        let s2 = service();
        s2.set_engine(trusted_engine(&[live_rule]));
        let res2 = s2.cosmetic_resources("https://www.youtube.com/watch?v=x");
        assert!(
            res2.injected_script.contains("legacyImportant"),
            "без исключения json-prune инъецируется"
        );
    }

    #[test]
    fn compat_expire_rule_blocks_ssai_media_requests() {
        // Адаптация сетевого правила uBO quick-fixes #29059 (compat.txt):
        // SSAI-медиа-сегменты идут с неправдоподобным expire (regex апстрима
        // отсекает правдоподобный диапазон текущей эпохи); оригинал падает
        // в adblock-rs на опции method= — адаптация без неё.
        let s = service();
        s.set_engine(trusted_engine(&[COMPAT_RULES]));
        assert!(
            s.should_block(
                Some("https://www.youtube.com/watch?v=x"),
                "https://rr5---sn-4g5lznle.googlevideo.com/videoplayback?expire=2094204800&mn=sn-x",
                "xhr",
                Some("https://www.youtube.com/"),
            ),
            "SSAI-подобный expire (2094…) блокируется"
        );
        assert!(
            !s.should_block(
                Some("https://www.youtube.com/watch?v=x"),
                "https://rr5---sn-4g5lznle.googlevideo.com/videoplayback?expire=1793900000&mn=sn-x",
                "xhr",
                Some("https://www.youtube.com/"),
            ),
            "правдоподобный expire (эпоха+6ч) не тронут"
        );
    }

    #[test]
    fn quickfix_offline_fallback_to_builtin_snapshot() {
        // Живой quick-fixes недоступен, кэша нет (первый запуск без сети,
        // карточка 074): движок строится из встроенного снапшота, а не
        // пустует. Адрес 127.0.0.1:1 — мгновенный отказ соединения.
        let _env = ENV_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("duopulse-adblock-qf-fb-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let _guard = EnvGuard::set(
            "DUOPULSE_ADBLOCK_LISTS",
            "duopulse-quickfix=http://127.0.0.1:1/qf.txt",
        );
        let profile = dir.join("profile");
        std::fs::create_dir_all(&profile).unwrap();
        let s = AdblockService::new(&profile);
        s.refresh_lists(false);
        let st = s.status();
        assert!(st.ready, "движок построен из снапшот-фолбэка");
        assert_eq!(st.lists.len(), 1);
        assert!(st.lists[0].rules > 0, "в снапшоте есть правила");
        assert!(st.lists[0].error.is_none(), "{:?}", st.lists[0].error);
        // кэш записан текстом снапшота — следующий старт без сети пойдёт в
        // ту же ветку (кэш есть → оффлайн-кэш, не фолбэк)
        assert!(profile.join("filters").join("duopulse-quickfix.txt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn trusted_rpfr_alias_resolves() {
        // Находка ревизии 061: 2 живых правила trusted-rpfr в filters.txt были
        // мертвы без алиаса — теперь резолвятся в trusted-replace-fetch-response
        // (из доверенного списка).
        let mut set = adblock::lists::FilterSet::new(false);
        set.add_filters(
            ["a.test##+js(trusted-rpfr, /x/, y)"],
            ParseOptions {
                permissions: adblock::resources::PermissionMask::from_bits(1),
                ..ParseOptions::default()
            },
        );
        let mut engine = Engine::from_filter_set(set, true);
        engine.use_resources(scriptlet_resources().iter().cloned());
        let s = service();
        s.set_engine(engine);
        let res = s.cosmetic_resources("https://a.test/");
        assert!(
            res.injected_script.contains("trustedReplaceFetchResponse"),
            "алиас trusted-rpfr резолвится: {}",
            &res.injected_script[..res.injected_script.len().min(200)]
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
    fn compat_neutralizes_adslots_on_all_hosts() {
        let rules: Vec<&str> = UBO_YOUTUBE_RULES
            .iter()
            .copied()
            .chain(COMPAT_RULES.lines())
            .collect();
        let mut e = Engine::from_rules(rules.iter().copied(), ParseOptions::default());
        e.use_resources(scriptlet_resources().iter().cloned());
        let s = service();
        s.set_engine(e);
        // Клиентские adSlots-скриптлеты uBO нейтрализованы на ВСЕХ хостах
        // (карточки 044/050: клиентское вырезание = SABR-stall; преролл
        // снимает сетевой слой $replace на XHR /player — эксперимент 050
        // без исключений на www вернул столл 13–15 с)
        for host in ["www.youtube.com", "m.youtube.com"] {
            let res = s.cosmetic_resources(&format!("https://{host}/watch?v=x"));
            assert!(res.active && res.ready);
            assert!(
                res.injected_script
                    .contains(r#"setConstant("ytInitialPlayerResponse.playerAds", "undefined")"#),
                "{host}: playerAds вырезается клиентски (P-07)"
            );
            assert!(
                !res.injected_script
                    .contains(r#"setConstant("ytInitialPlayerResponse.adSlots", "undefined")"#),
                "{host}: set adSlots нейтрализован"
            );
            assert!(
                !res.injected_script.contains(
                    r#""playerResponse.adPlacements playerResponse.playerAds playerResponse.adSlots adPlacements playerAds adSlots important""#
                ),
                "{host}: json-prune с adSlots нейтрализован"
            );
            // наш json-prune без adSlots действует
            assert!(
                res.injected_script.contains(
                    r#"jsonPrune("playerResponse.adPlacements playerResponse.playerAds adPlacements playerAds")"#
                ),
                "{host}: собственный prune"
            );
        }
        // чужой хост — ничего (как у исходных правил)
        assert!(s
            .cosmetic_resources("https://other.test/")
            .injected_script
            .is_empty());
    }

    // --- карточка duopulse-050: $replace-перезапись ответов -------------------

    #[test]
    fn compat_has_no_network_replace_rules() {
        // $doc-перепись /watch экспериментально убрана (журнал 050): преролл
        // она не убивала (SSAI зашит серверно), задержку самофетча 1,4 МБ
        // добавляла; сетевой слой $replace живёт на живых xhr-правилах uBO
        assert!(replace::parse_replace_rules(COMPAT_RULES).is_empty());
    }

    #[test]
    fn replace_plan_from_lists_toggles_and_counters() {
        let _env = ENV_LOCK.lock().unwrap();
        let dir =
            std::env::temp_dir().join(format!("duopulse-adblock-replace-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let list = dir.join("list.txt");
        std::fs::write(
            &list,
            "/alwaysblocked/*\n||127.0.0.1/replace$xhr,1p,replace=/\"k\"/\"v\"/\n",
        )
        .unwrap();
        let _guard = EnvGuard::set("DUOPULSE_ADBLOCK_LISTS", &format!("t={}", list.display()));
        let profile = dir.join("profile");
        std::fs::create_dir_all(&profile).unwrap();
        let s = AdblockService::new(&profile);
        s.refresh_lists(false);

        // план замен: XHR с 1p-источником на 127.0.0.1
        let plan = s.replace_plan(
            Some("http://127.0.0.1:8895/"),
            "http://127.0.0.1:8895/replace?x=1",
            "xhr",
            Some("http://127.0.0.1:8895/page"),
        );
        let ops = plan.expect("правило совпало");
        assert_eq!(ops.len(), 1);
        // не-xhr тип — правила $xhr не действуют
        assert!(s
            .replace_plan(
                Some("http://127.0.0.1:8895/"),
                "http://127.0.0.1:8895/replace?x=1",
                "document",
                None,
            )
            .is_none());
        // 3p-источник — правило 1p не действует
        assert!(s
            .replace_plan(
                None,
                "http://127.0.0.1:8895/replace?x=1",
                "xhr",
                Some("https://other.test/page"),
            )
            .is_none());
        // чужой путь — нет правил
        assert!(s
            .replace_plan(
                Some("http://127.0.0.1:8895/"),
                "http://127.0.0.1:8895/elsewhere",
                "xhr",
                Some("http://127.0.0.1:8895/page"),
            )
            .is_none());

        // диагностика: счётчики в статусе
        let st = s.status();
        assert_eq!(st.replace_rules, 1);
        assert_eq!(st.replaced_total, 0);
        s.note_replaced();
        s.note_replaced();
        assert_eq!(s.status().replaced_total, 2);

        // тумблер/сайт-исключение гасят перезапись, как и блокировки
        {
            let mut g = s.inner.lock().unwrap();
            g.enabled = false;
        }
        assert!(s
            .replace_plan(
                None,
                "http://127.0.0.1:8895/replace?x=1",
                "xhr",
                Some("http://127.0.0.1:8895/page"),
            )
            .is_none());
        {
            let mut g = s.inner.lock().unwrap();
            g.enabled = true;
            g.site_exceptions.insert("127.0.0.1".into());
        }
        assert!(s
            .replace_plan(
                None,
                "http://127.0.0.1:8895/replace?x=1",
                "xhr",
                Some("http://127.0.0.1:8895/page"),
            )
            .is_none());

        let _ = std::fs::remove_dir_all(&dir);
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
        assert!(
            defs.iter().any(|d| d.source == QUICKFIX_URL),
            "quick-fixes — живой URL (карточка 074)"
        );
        assert_eq!(
            defs.iter()
                .filter(|d| d.source != COMPAT_SOURCE && d.source != QUICKFIX_URL)
                .count(),
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
