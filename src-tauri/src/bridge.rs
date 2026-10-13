//! IPC-мост bridge — единый словарь команд/событий UI|Content ↔ Core
//! (задача 1.1, docs/05 §2). Слои общаются только через этот контракт
//! (docs/02 §1), что позволяет менять Shell (Tauri → Electron) без
//! переписывания ценностных слоёв.
//!
//! Единственный источник контракта — Rust-типы этого модуля (serde ↔ schemars):
//! из них генерируется `bridge/contract.json` (JSON Schema draft-07,
//! версионируется в git), из него — TS-типы `src/bridge/gen/types.ts`
//! (npm run gen:bridge). Ручные правки генерённых файлов исключены тестами:
//!   - cargo-тест `contract_file_is_up_to_date`: contract.json == код;
//!   - vitest `src/bridge/client.test.ts`: TS-клиент знает все команды.
//!
//! Имена в словаре — `домен.действие` (tabs.list); tauri-хендлеры — snake_case
//! (tabs_list): точки в именах Rust-функций невозможны, маппинг живёт в
//! contract.json (поле "handler") и в TS-клиенте src/bridge/client.ts.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Url};

use crate::proxy;

/// Версия контракта. Несовместимое изменение схем/имён (удаление команды,
/// смена типа поля без умолчания) — bump версии + правка потребителей в той же
/// задаче. Совместимые расширения версию не меняют.
///
/// v2 (задача 1.2): события переименованы `домен.событие` → `домен:событие`
/// (page:loaded, page:video_detected, vpn:state_changed, + новое tabs:updated):
/// tauri 2 разрешает в именах событий только alnum/`-`/`/`/`:`/`_` — точечные
/// имена не проходили валидацию listen/emit. Команды не затронуты: в tauri
/// идёт snake_case-хендлер из поля "handler", словарное имя в рантайме не звучит.
pub const CONTRACT_VERSION: u32 = 2;

// ---------------------------------------------------------------------------
// Типы команд (params/result)
// ---------------------------------------------------------------------------

/// bridge.version: версия контракта живого приложения (диагностика, e2e).
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct BridgeVersionResult {
    pub version: u32,
}

/// tabs.list: вкладки окна в порядке таб-бара (менеджер вкладок — src/tabs/).
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct TabsListResult {
    pub tabs: Vec<TabInfo>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct TabInfo {
    /// Идентификатор webview-вкладки.
    pub id: String,
    /// Текущий URL вкладки.
    pub url: String,
    /// Заголовок страницы (пусто — до первого on_document_title_changed).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Активна ли вкладка (виден её webview).
    pub active: bool,
    /// Идёт загрузка документа (пульс-индикатор вкладки, гайд 06 §3).
    pub loading: bool,
}

/// tabs.open: открыть вкладку; без url — стартовая страница (до страницы
/// «Новая вкладка» задачи 1.5). Новая вкладка становится активной.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct TabsOpenParams {
    #[serde(default)]
    pub url: Option<String>,
}

/// tabs.close: закрыть вкладку по id; активной становится соседняя.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct TabsCloseParams {
    pub id: String,
}

/// tabs.activate: сделать вкладку активной (клик по вкладке таб-бара).
#[derive(Debug, Deserialize, JsonSchema)]
pub struct TabsActivateParams {
    pub id: String,
}

/// nav.navigate: переход активной вкладки по URL.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct NavNavigateParams {
    pub url: String,
}

/// nav.resolve_omnibox: разобрать ввод адресной строки — адрес (с догадкой
/// схемы) или поисковый запрос; результат — готовый URL для nav.navigate
/// (задача 1.3, разбор — src/omnibox.rs).
#[derive(Debug, Deserialize, JsonSchema)]
pub struct NavResolveOmniboxParams {
    pub input: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NavResolveOmniboxResult {
    pub url: String,
    /// Ввод распознан как поисковый запрос (не как адрес).
    pub is_search: bool,
}

/// history.search: подсказки omnibox — полнотекстовый поиск по истории и
/// закладкам (FTS5, задача 1.3; хранилище — src/history/, SQLite в профиле —
/// задача 1.4).
#[derive(Debug, Deserialize, JsonSchema)]
pub struct HistorySearchParams {
    pub query: String,
    /// Максимум подсказок в ответе (по умолчанию 8, диапазон 1–20).
    #[serde(default = "default_suggest_limit")]
    pub limit: u32,
}

fn default_suggest_limit() -> u32 {
    8
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HistorySearchResult {
    pub hits: Vec<HistoryHit>,
}

/// Откуда подсказка: посещение из истории или закладка.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum HistorySource {
    History,
    Bookmark,
}

impl HistorySource {
    /// Обратное преобразование (не-«bookmark» считается историей).
    pub fn from_db(s: &str) -> Self {
        if s == "bookmark" {
            Self::Bookmark
        } else {
            Self::History
        }
    }
}

/// Одна подсказка omnibox: источник, адрес и заголовок страницы.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HistoryHit {
    pub source: HistorySource,
    pub url: String,
    pub title: String,
}

// --- задача 1.4: история и закладки (SQLite в профиле, src/history/) --------

/// history.visit: записать посещение. Core записывает визиты сам (on_page_load
/// вкладок, только http/https); команда в словаре — для e2e-стендов и будущих
/// источников (docs/05 §2).
#[derive(Debug, Deserialize, JsonSchema)]
pub struct HistoryVisitParams {
    pub url: String,
    #[serde(default)]
    pub title: String,
}

/// history.list: история для страницы управления — агрегат по URL.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryListParams {
    /// FTS-фильтр по заголовку/адресу (префиксные токены); пустой — всё.
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub offset: u32,
    /// Страница выдачи (по умолчанию 100, максимум 500).
    #[serde(default = "default_list_limit")]
    pub limit: u32,
}

fn default_list_limit() -> u32 {
    100
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryListResult {
    pub entries: Vec<HistoryEntry>,
    /// Всего URL, подходящих под фильтр (пагинация).
    pub total: u32,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub url: String,
    /// Заголовок последнего визита (может быть пуст до on_title).
    pub title: String,
    /// Последнее посещение, unix-ms.
    pub last_visited_at: i64,
    pub visit_count: u32,
}

/// history.delete_urls: удалить из истории все визиты перечисленных адресов.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct HistoryDeleteUrlsParams {
    pub urls: Vec<String>,
}

/// history.delete_range: удалить визиты за [fromMs..=toMs] (unix-ms);
/// fromMs=0, toMs=«будущее» — вся история (закладки не трогаются).
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryDeleteRangeParams {
    pub from_ms: i64,
    pub to_ms: i64,
}

/// history.bookmark_add: добавить закладку (url — ключ; повторное добавление
/// обновляет заголовок, пустой заголовок сохраняет прежний).
#[derive(Debug, Deserialize, JsonSchema)]
pub struct HistoryBookmarkAddParams {
    pub url: String,
    #[serde(default)]
    pub title: String,
}

/// history.bookmark_remove: удалить закладку (идемпотентна).
#[derive(Debug, Deserialize, JsonSchema)]
pub struct HistoryBookmarkRemoveParams {
    pub url: String,
}

/// history.bookmark_update: переименовать закладку (правка на странице
/// управления); несуществующая — ошибка.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct HistoryBookmarkUpdateParams {
    pub url: String,
    pub title: String,
}

/// history.bookmark_list: закладки для страницы управления.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryBookmarkListParams {
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub offset: u32,
    #[serde(default = "default_bookmark_limit")]
    pub limit: u32,
}

fn default_bookmark_limit() -> u32 {
    200
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryBookmarkListResult {
    pub bookmarks: Vec<HistoryBookmark>,
    pub total: u32,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryBookmark {
    pub url: String,
    pub title: String,
    /// Добавлена, unix-ms.
    pub added_at: i64,
}

/// settings.get: ключ, значение которого читаем.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct SettingsGetParams {
    pub key: SettingsKey,
}

/// settings.get / settings.set: ключи настроек профиля. M1: один ключ.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SettingsKey {
    Proxy,
}

/// Значение ключа "proxy" для UI: конфиг прокси + факт наличия пароля в DPAPI
/// (сам пароль наружу не отдаётся).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProxySettings {
    pub enabled: bool,
    pub proto: proxy::ProxyProto,
    pub host: String,
    pub port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login: Option<String>,
    pub has_password: bool,
}

/// settings.set: value — значение ключа; secret — секрет ключа в DPAPI:
/// None — не менять, Some("") — удалить, Some(p) — перезаписать.
/// Для "proxy" value без пароля (пароль — только DPAPI, docs/02 §9).
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSetParams {
    pub key: SettingsKey,
    pub value: proxy::ProxyConfig,
    pub secret: Option<String>,
}

/// vpn.set_enabled: включить/выключить маршрутизацию через внешний прокси
/// (инкремент A; в M6 — выбор маршрута локальным роутером, docs/02 §6).
/// Включение с невалидным конфигом — ошибка, конфиг не меняется.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct VpnSetEnabledParams {
    pub on: bool,
}

/// vpn.status / vpn.test_connection: состояние маршрутизации.
/// state — словарь M1 (off/on/error); в M6 при WireGuard контракт расширится
/// состояниями из docs/05 §2 (connecting/connected) с bump версии.
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VpnStatusResult {
    pub state: proxy::ProxyState,
    pub detail: String,
}

// ---------------------------------------------------------------------------
// События Core → UI|Content
// ---------------------------------------------------------------------------

// Каркас событий: схемы зарегистрированы в контракте с 1.1, реальный эмит
// начинается в последующих задачах (M3 — page.*, M6 — vpn.state_changed),
// поэтому элементы пока не используются бинарём.
#[allow(dead_code)]
/// Типизированное событие контракта: имя из словаря + схема payload.
pub trait BridgeEvent {
    const NAME: &'static str;
    type Payload: Serialize + JsonSchema;
}

/// page:loaded: документ загружен (M3 — детектор контента; каркас с 1.1).
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[allow(dead_code)]
pub struct PageLoaded {
    pub url: String,
}

impl BridgeEvent for PageLoaded {
    const NAME: &'static str = "page:loaded";
    type Payload = Self;
}

/// page:video_detected: на странице найден <video> (M3; каркас с 1.1).
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct PageVideoDetected {
    pub video_key: String,
    pub can_tracks: bool,
}

impl BridgeEvent for PageVideoDetected {
    const NAME: &'static str = "page:video_detected";
    type Payload = Self;
}

/// vpn:state_changed: состояние маршрутизации изменилось (каркас с 1.1;
/// начнёт эмититься с локальным роутером M6, docs/02 §6).
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct VpnStateChanged {
    pub state: proxy::ProxyState,
    pub detail: String,
}

impl BridgeEvent for VpnStateChanged {
    const NAME: &'static str = "vpn:state_changed";
    type Payload = Self;
}

/// tabs:updated: снапшот списка вкладок после любого изменения (открытие/
/// закрытие/переключение/переход/заголовок) — таб-бар перерисовывается им
/// (задача 1.2).
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct TabsUpdated;

impl BridgeEvent for TabsUpdated {
    const NAME: &'static str = "tabs:updated";
    type Payload = TabsListResult;
}

/// Эмитить событие контракта в UI|Content.
#[allow(dead_code)]
pub fn emit<E: BridgeEvent>(app: &AppHandle, payload: &E::Payload) -> Result<(), tauri::Error> {
    app.emit(E::NAME, payload)
}

// ---------------------------------------------------------------------------
// Реестр контракта → bridge/contract.json (генерация, не править руками)
// ---------------------------------------------------------------------------

macro_rules! schema {
    ($ty:ty) => {
        serde_json::to_value(schemars::schema_for!($ty)).expect("сериализация JSON Schema")
    };
}

/// Весь словарь команд/событий одним JSON-документом.
/// params/result = null — команда без параметров/без результата (void).
// Используется генерацией контракта (npm run gen:bridge → cargo test),
// не вызывается бинарём.
#[allow(dead_code)]
pub fn contract_json() -> serde_json::Value {
    serde_json::json!({
        "version": CONTRACT_VERSION,
        "commands": {
            "bridge.version": { "handler": "bridge_version", "params": null,
                                "result": schema!(BridgeVersionResult) },
            "tabs.list": { "handler": "tabs_list", "params": null,
                           "result": schema!(TabsListResult) },
            "tabs.open": { "handler": "tabs_open", "params": schema!(TabsOpenParams),
                           "result": schema!(TabsListResult) },
            "tabs.close": { "handler": "tabs_close", "params": schema!(TabsCloseParams),
                            "result": schema!(TabsListResult) },
            "tabs.reopen": { "handler": "tabs_reopen", "params": null,
                             "result": schema!(TabsListResult) },
            "tabs.activate": { "handler": "tabs_activate", "params": schema!(TabsActivateParams),
                               "result": schema!(TabsListResult) },
            "nav.navigate": { "handler": "nav_navigate", "params": schema!(NavNavigateParams),
                              "result": null },
            "nav.resolve_omnibox": { "handler": "nav_resolve_omnibox",
                                     "params": schema!(NavResolveOmniboxParams),
                                     "result": schema!(NavResolveOmniboxResult) },
            "nav.focus_page": { "handler": "nav_focus_page", "params": null, "result": null },
            "nav.go_back": { "handler": "nav_go_back", "params": null, "result": null },
            "nav.go_forward": { "handler": "nav_go_forward", "params": null, "result": null },
            "nav.reload": { "handler": "nav_reload", "params": null, "result": null },
            "history.search": { "handler": "history_search", "params": schema!(HistorySearchParams),
                                "result": schema!(HistorySearchResult) },
            "history.visit": { "handler": "history_visit", "params": schema!(HistoryVisitParams),
                               "result": null },
            "history.list": { "handler": "history_list", "params": schema!(HistoryListParams),
                              "result": schema!(HistoryListResult) },
            "history.delete_urls": { "handler": "history_delete_urls",
                                     "params": schema!(HistoryDeleteUrlsParams),
                                     "result": null },
            "history.delete_range": { "handler": "history_delete_range",
                                      "params": schema!(HistoryDeleteRangeParams),
                                      "result": null },
            "history.bookmark_add": { "handler": "history_bookmark_add",
                                      "params": schema!(HistoryBookmarkAddParams),
                                      "result": null },
            "history.bookmark_remove": { "handler": "history_bookmark_remove",
                                         "params": schema!(HistoryBookmarkRemoveParams),
                                         "result": null },
            "history.bookmark_update": { "handler": "history_bookmark_update",
                                         "params": schema!(HistoryBookmarkUpdateParams),
                                         "result": null },
            "history.bookmark_list": { "handler": "history_bookmark_list",
                                       "params": schema!(HistoryBookmarkListParams),
                                       "result": schema!(HistoryBookmarkListResult) },
            "settings.get": { "handler": "settings_get", "params": schema!(SettingsGetParams),
                              "result": schema!(ProxySettings) },
            "settings.set": { "handler": "settings_set", "params": schema!(SettingsSetParams),
                              "result": null },
            "vpn.set_enabled": { "handler": "vpn_set_enabled", "params": schema!(VpnSetEnabledParams),
                                 "result": null },
            "vpn.status": { "handler": "vpn_status", "params": null,
                            "result": schema!(VpnStatusResult) },
            "vpn.test_connection": { "handler": "vpn_test_connection", "params": null,
                                     "result": schema!(VpnStatusResult) },
            "app.restart": { "handler": "app_restart", "params": null, "result": null },
        },
        "events": {
            "tabs:updated": { "payload": schema!(TabsListResult) },
            "page:loaded": { "payload": schema!(PageLoaded) },
            "page:video_detected": { "payload": schema!(PageVideoDetected) },
            "vpn:state_changed": { "payload": schema!(VpnStateChanged) },
        },
    })
}

#[allow(dead_code)]
fn contract_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../bridge/contract.json")
}

/// Обновляет bridge/contract.json из кода (запуск: cargo test -- --ignored,
/// обёртка — npm run gen:bridge).
#[test]
#[ignore]
fn update_contract_file() {
    let path = contract_path();
    std::fs::create_dir_all(path.parent().expect("родитель bridge/")).expect("создать bridge/");
    let json = serde_json::to_string_pretty(&contract_json()).unwrap();
    std::fs::write(&path, json + "\n").expect("записать bridge/contract.json");
}

/// Защита от ручных правок генерённого: файл в репо обязан совпадать с кодом.
#[test]
fn contract_file_is_up_to_date() {
    let on_disk = std::fs::read_to_string(contract_path())
        .expect("bridge/contract.json существует (запусти: npm run gen:bridge)");
    let expected = serde_json::to_string_pretty(&contract_json()).unwrap() + "\n";
    assert_eq!(
        on_disk, expected,
        "bridge/contract.json расходится с Rust-типами: перегенерируй (npm run gen:bridge)"
    );
}

/// Имена событий в реестре и в trait-константах не разъезжаются.
#[test]
fn event_names_match_registry() {
    let contract = contract_json();
    let events = contract["events"].as_object().expect("events — объект");
    for (name, event) in events {
        let payload_title = event["payload"]["title"]
            .as_str()
            .expect("title у payload")
            .to_string();
        let known: Vec<(&str, String)> = [
            (<PageLoaded as BridgeEvent>::NAME, schema!(PageLoaded)),
            (
                <PageVideoDetected as BridgeEvent>::NAME,
                schema!(PageVideoDetected),
            ),
            (
                <VpnStateChanged as BridgeEvent>::NAME,
                schema!(VpnStateChanged),
            ),
            (<TabsUpdated as BridgeEvent>::NAME, schema!(TabsListResult)),
        ]
        .into_iter()
        .map(|(n, s)| (n, s["title"].as_str().expect("title у схемы").to_string()))
        .collect();
        assert!(
            known
                .iter()
                .any(|(n, t)| *n == name.as_str() && *t == payload_title),
            "событие {name} ({payload_title}) не описано в BridgeEvent-константах"
        );
    }
}

// ---------------------------------------------------------------------------
// Команды (tauri-хендлеры) — единственное место IPC в Core
// ---------------------------------------------------------------------------

#[tauri::command]
fn bridge_version() -> BridgeVersionResult {
    BridgeVersionResult {
        version: CONTRACT_VERSION,
    }
}

#[tauri::command]
fn tabs_list(manager: tauri::State<'_, crate::tabs::TabManager>) -> TabsListResult {
    manager.snapshot()
}

/// tabs.open: async — создание webview это блокирующий round-trip на главный
/// поток, его нельзя делать на потоке цикла событий (см. tabs::open).
#[tauri::command]
async fn tabs_open(
    app: AppHandle,
    manager: tauri::State<'_, crate::tabs::TabManager>,
    params: TabsOpenParams,
) -> Result<TabsListResult, String> {
    manager.open(&app, params.url, None)
}

#[tauri::command]
fn tabs_close(
    app: AppHandle,
    manager: tauri::State<'_, crate::tabs::TabManager>,
    params: TabsCloseParams,
) -> Result<TabsListResult, String> {
    manager.close(&app, &params.id)
}

/// tabs.reopen: async — как tabs.open, создаёт webview.
#[tauri::command]
async fn tabs_reopen(
    app: AppHandle,
    manager: tauri::State<'_, crate::tabs::TabManager>,
) -> Result<TabsListResult, String> {
    manager.reopen(&app)
}

#[tauri::command]
fn tabs_activate(
    app: AppHandle,
    manager: tauri::State<'_, crate::tabs::TabManager>,
    params: TabsActivateParams,
) -> Result<TabsListResult, String> {
    manager.activate(&app, &params.id)
}

#[tauri::command]
fn nav_navigate(
    app: AppHandle,
    manager: tauri::State<'_, crate::tabs::TabManager>,
    params: NavNavigateParams,
) -> Result<(), String> {
    let webview = active_webview(&app, &manager)?;
    webview
        .navigate(Url::parse(&params.url).map_err(|e| format!("некорректный URL: {e}"))?)
        .map_err(|e| format!("navigate: {e}"))
}

#[tauri::command]
fn nav_go_back(
    app: AppHandle,
    manager: tauri::State<'_, crate::tabs::TabManager>,
) -> Result<(), String> {
    eval_active(&app, &manager, "history.back()")
}

#[tauri::command]
fn nav_go_forward(
    app: AppHandle,
    manager: tauri::State<'_, crate::tabs::TabManager>,
) -> Result<(), String> {
    eval_active(&app, &manager, "history.forward()")
}

/// nav.resolve_omnibox: разбор ввода адресной строки (URL vs поиск) —
/// src/omnibox.rs, правила и тесты там.
#[tauri::command]
fn nav_resolve_omnibox(params: NavResolveOmniboxParams) -> NavResolveOmniboxResult {
    let r = crate::omnibox::resolve(&params.input);
    NavResolveOmniboxResult {
        url: r.url,
        is_search: r.is_search,
    }
}

/// nav.focus_page: вернуть фокус контенту активной вкладки (Esc из omnibox —
/// задача 1.3). Вкладок нет — тихо ок (фокусить нечего).
#[tauri::command]
fn nav_focus_page(
    app: AppHandle,
    manager: tauri::State<'_, crate::tabs::TabManager>,
) -> Result<(), String> {
    if let Ok(wv) = active_webview(&app, &manager) {
        wv.set_focus().map_err(|e| format!("focus: {e}"))?;
    }
    Ok(())
}

/// history.search: подсказки omnibox по FTS5-индексу истории и закладок.
#[tauri::command]
fn history_search(
    history: tauri::State<'_, crate::history::HistoryStore>,
    params: HistorySearchParams,
) -> Result<HistorySearchResult, String> {
    Ok(HistorySearchResult {
        hits: history.search(&params.query, params.limit)?,
    })
}

/// history.visit: запись посещения (см. HistoryVisitParams — Core и сам
/// пишет визиты из on_page_load вкладок).
#[tauri::command]
fn history_visit(
    history: tauri::State<'_, crate::history::HistoryStore>,
    params: HistoryVisitParams,
) -> Result<(), String> {
    history.visit(&params.url, &params.title)
}

/// history.list: история для страницы управления (агрегат по URL).
#[tauri::command]
fn history_list(
    history: tauri::State<'_, crate::history::HistoryStore>,
    params: HistoryListParams,
) -> Result<HistoryListResult, String> {
    let (entries, total) = history.list(
        params.query.as_deref().unwrap_or(""),
        params.offset,
        params.limit,
    )?;
    Ok(HistoryListResult { entries, total })
}

/// history.delete_urls: удалить записи истории по адресам.
#[tauri::command]
fn history_delete_urls(
    history: tauri::State<'_, crate::history::HistoryStore>,
    params: HistoryDeleteUrlsParams,
) -> Result<(), String> {
    history.delete_urls(&params.urls)
}

/// history.delete_range: удалить историю за диапазон времени.
#[tauri::command]
fn history_delete_range(
    history: tauri::State<'_, crate::history::HistoryStore>,
    params: HistoryDeleteRangeParams,
) -> Result<(), String> {
    history.delete_range(params.from_ms, params.to_ms)
}

/// history.bookmark_add: добавить закладку (upsert по url).
#[tauri::command]
fn history_bookmark_add(
    history: tauri::State<'_, crate::history::HistoryStore>,
    params: HistoryBookmarkAddParams,
) -> Result<(), String> {
    history.bookmark_add(&params.url, &params.title)
}

/// history.bookmark_remove: удалить закладку.
#[tauri::command]
fn history_bookmark_remove(
    history: tauri::State<'_, crate::history::HistoryStore>,
    params: HistoryBookmarkRemoveParams,
) -> Result<(), String> {
    history.bookmark_remove(&params.url)
}

/// history.bookmark_update: переименовать закладку.
#[tauri::command]
fn history_bookmark_update(
    history: tauri::State<'_, crate::history::HistoryStore>,
    params: HistoryBookmarkUpdateParams,
) -> Result<(), String> {
    history.bookmark_update(&params.url, &params.title)
}

/// history.bookmark_list: закладки для страницы управления.
#[tauri::command]
fn history_bookmark_list(
    history: tauri::State<'_, crate::history::HistoryStore>,
    params: HistoryBookmarkListParams,
) -> Result<HistoryBookmarkListResult, String> {
    let (bookmarks, total) = history.bookmark_list(
        params.query.as_deref().unwrap_or(""),
        params.offset,
        params.limit,
    )?;
    Ok(HistoryBookmarkListResult { bookmarks, total })
}

#[tauri::command]
fn nav_reload(
    app: AppHandle,
    manager: tauri::State<'_, crate::tabs::TabManager>,
) -> Result<(), String> {
    eval_active(&app, &manager, "location.reload()")
}

fn active_webview(
    app: &AppHandle,
    manager: &tauri::State<'_, crate::tabs::TabManager>,
) -> Result<tauri::Webview<tauri::Wry>, String> {
    manager
        .active_webview(app)
        .ok_or_else(|| "активной вкладки нет".to_string())
}

fn eval_active(
    app: &AppHandle,
    manager: &tauri::State<'_, crate::tabs::TabManager>,
    js: &str,
) -> Result<(), String> {
    active_webview(app, manager)?
        .eval(js)
        .map_err(|e| format!("eval: {e}"))
}

#[tauri::command]
fn settings_get(params: SettingsGetParams) -> Result<ProxySettings, String> {
    match params.key {
        SettingsKey::Proxy => {
            let dir = proxy::profile_dir();
            let cfg = proxy::load_config(&dir);
            Ok(proxy_settings(&cfg, &dir))
        }
    }
}

#[tauri::command]
fn settings_set(params: SettingsSetParams) -> Result<(), String> {
    match params.key {
        SettingsKey::Proxy => save_proxy(&params.value, params.secret),
    }
}

/// vpn.set_enabled: переключить флаг прокси в сохранённом конфиге.
/// Включение валидирует сохранённый адрес (не форму UI — форма сохраняется
/// отдельной командой settings.set).
#[tauri::command]
fn vpn_set_enabled(params: VpnSetEnabledParams) -> Result<(), String> {
    let dir = proxy::profile_dir();
    let mut cfg = proxy::load_config(&dir);
    cfg.enabled = params.on;
    save_proxy(&cfg, None)
}

#[tauri::command]
async fn vpn_status() -> Result<VpnStatusResult, String> {
    check_vpn().await
}

/// vpn.test_connection: та же проверка достижимости, что и в vpn.status —
/// по явному запросу пользователя (кнопка «Проверить»); в M6 дополнится
/// пингом/IP-эхом через маршрут.
#[tauri::command]
async fn vpn_test_connection() -> Result<VpnStatusResult, String> {
    check_vpn().await
}

async fn check_vpn() -> Result<VpnStatusResult, String> {
    let status = tauri::async_runtime::spawn_blocking(|| {
        proxy::check(&proxy::load_config(&proxy::profile_dir()))
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(VpnStatusResult {
        state: status.state,
        detail: status.detail,
    })
}

/// app.restart: перезапуск приложения (применение аргументов прокси WebView2 —
/// docs/02 §6.1, смена настроек действует со следующего старта).
#[tauri::command]
fn app_restart(app: AppHandle) {
    app.restart();
}

fn proxy_settings(cfg: &proxy::ProxyConfig, dir: &std::path::Path) -> ProxySettings {
    ProxySettings {
        enabled: cfg.enabled,
        proto: cfg.proto,
        host: cfg.host.clone(),
        port: cfg.port,
        login: cfg.login.clone(),
        has_password: proxy::has_password(dir),
    }
}

fn save_proxy(cfg: &proxy::ProxyConfig, secret: Option<String>) -> Result<(), String> {
    if cfg.enabled {
        cfg.validate()?;
    }
    let dir = proxy::profile_dir();
    proxy::save_config(&dir, cfg)?;
    match secret.as_deref() {
        None => {}
        Some("") => proxy::clear_password(&dir),
        Some(p) => proxy::save_password(&dir, p)?,
    }
    Ok(())
}

/// Регистрация всех команд контракта на билдере Tauri (docs/05 §1:
/// IPC-хендлеры живут в bridge.rs, main — только сборка приложения).
pub fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.invoke_handler(tauri::generate_handler![
        bridge_version,
        tabs_list,
        tabs_open,
        tabs_close,
        tabs_reopen,
        tabs_activate,
        nav_navigate,
        nav_resolve_omnibox,
        nav_focus_page,
        nav_go_back,
        nav_go_forward,
        nav_reload,
        history_search,
        history_visit,
        history_list,
        history_delete_urls,
        history_delete_range,
        history_bookmark_add,
        history_bookmark_remove,
        history_bookmark_update,
        history_bookmark_list,
        settings_get,
        settings_set,
        vpn_set_enabled,
        vpn_status,
        vpn_test_connection,
        app_restart
    ])
}
