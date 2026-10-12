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
use tauri::{AppHandle, Emitter, Manager, Url};

use crate::proxy;

/// Версия контракта. Несовместимое изменение схем/имён (удаление команды,
/// смена типа поля без умолчания) — bump версии + правка потребителей в той же
/// задаче. Совместимые расширения версию не меняют.
pub const CONTRACT_VERSION: u32 = 1;

/// UI-webview (полоса хрома) не попадает в список вкладок.
const UI_WEBVIEW_LABEL: &str = "main";

// ---------------------------------------------------------------------------
// Типы команд (params/result)
// ---------------------------------------------------------------------------

/// bridge.version: версия контракта живого приложения (диагностика, e2e).
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct BridgeVersionResult {
    pub version: u32,
}

/// tabs.list: вкладки окна. M1: единственная контентная вкладка "content".
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
    /// Заголовок страницы (заполнится в задаче 1.2 — таб-бар).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Активна ли вкладка (в M1 единственная — всегда true).
    pub active: bool,
}

/// nav.navigate: переход активной вкладки по URL.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct NavNavigateParams {
    pub url: String,
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

/// page.loaded: документ загружен (M3 — детектор контента; каркас с 1.1).
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[allow(dead_code)]
pub struct PageLoaded {
    pub url: String,
}

impl BridgeEvent for PageLoaded {
    const NAME: &'static str = "page.loaded";
    type Payload = Self;
}

/// page.video_detected: на странице найден <video> (M3; каркас с 1.1).
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct PageVideoDetected {
    pub video_key: String,
    pub can_tracks: bool,
}

impl BridgeEvent for PageVideoDetected {
    const NAME: &'static str = "page.video_detected";
    type Payload = Self;
}

/// vpn.state_changed: состояние маршрутизации изменилось (каркас с 1.1;
/// начнёт эмититься с локальным роутером M6, docs/02 §6).
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct VpnStateChanged {
    pub state: proxy::ProxyState,
    pub detail: String,
}

impl BridgeEvent for VpnStateChanged {
    const NAME: &'static str = "vpn.state_changed";
    type Payload = Self;
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
            "nav.navigate": { "handler": "nav_navigate", "params": schema!(NavNavigateParams),
                              "result": null },
            "nav.go_back": { "handler": "nav_go_back", "params": null, "result": null },
            "nav.go_forward": { "handler": "nav_go_forward", "params": null, "result": null },
            "nav.reload": { "handler": "nav_reload", "params": null, "result": null },
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
            "page.loaded": { "payload": schema!(PageLoaded) },
            "page.video_detected": { "payload": schema!(PageVideoDetected) },
            "vpn.state_changed": { "payload": schema!(VpnStateChanged) },
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
fn tabs_list(app: AppHandle) -> Result<TabsListResult, String> {
    let tabs = app
        .webviews()
        .into_iter()
        .filter(|(label, _)| label != UI_WEBVIEW_LABEL)
        .map(|(label, wv)| TabInfo {
            id: label,
            url: wv.url().map(|u| u.to_string()).unwrap_or_default(),
            title: None,
            active: true,
        })
        .collect();
    Ok(TabsListResult { tabs })
}

#[tauri::command]
fn nav_navigate(app: AppHandle, params: NavNavigateParams) -> Result<(), String> {
    let webview = content_webview(&app)?;
    webview
        .navigate(Url::parse(&params.url).map_err(|e| format!("некорректный URL: {e}"))?)
        .map_err(|e| format!("navigate: {e}"))
}

#[tauri::command]
fn nav_go_back(app: AppHandle) -> Result<(), String> {
    eval_content(&app, "history.back()")
}

#[tauri::command]
fn nav_go_forward(app: AppHandle) -> Result<(), String> {
    eval_content(&app, "history.forward()")
}

#[tauri::command]
fn nav_reload(app: AppHandle) -> Result<(), String> {
    eval_content(&app, "location.reload()")
}

fn content_webview(app: &AppHandle) -> Result<tauri::Webview<tauri::Wry>, String> {
    app.get_webview("content")
        .ok_or_else(|| "webview content не найден".to_string())
}

fn eval_content(app: &AppHandle, js: &str) -> Result<(), String> {
    content_webview(app)?
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
        nav_navigate,
        nav_go_back,
        nav_go_forward,
        nav_reload,
        settings_get,
        settings_set,
        vpn_set_enabled,
        vpn_status,
        vpn_test_connection,
        app_restart
    ])
}
