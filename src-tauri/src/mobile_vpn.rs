//! Тоннель WireGuard мобильной ветки (карточка duopulse-169, паритет 6/8
//! аудита duopulse-156): ядро десктопа — общий модуль `crate::vpn::wg`
//! (boringtun + smoltcp, без TUN-драйвера и прав — на Android UDP-сокеты
//! разрешены обычному приложению) — поднимается командами без UI (этап 8 —
//! панель). Профили — тот же `wg-profiles.json` мобильного профиля filesDir;
//! приватный ключ — ветка Android Keystore `crate::secrets` (та же пара
//! save/load, что DPAPI десктопа: блоб «v1:…» под ключом AndroidKeyStore,
//! как passwords.key — открытого текста в /data нет).
//!
//! Контракт сверен с десктопным bridge.rs (vpn.*): команды зеркаляют
//! import/list/remove/use_profiles + set_enabled + status/test_connection,
//! события `vpn:state_changed` / `vpn:stats` — те же формы (VpnStateChanged /
//! VpnStats, camelCase) — TS-клиент этапа 8 переиспользуется без переделки.
//! Отличия от десктопа: (1) import_profile принимает ТЕКСТ .conf — файлового
//! диалога на мобильном листе нет (файл читает фронтенд/стенд своим путём);
//! (2) внешнего прокси на мобильной ветке нет — mode только off | wg,
//! set_enabled поднимает/гасит тоннель активного профиля; (3) пробу
//! test_connection можно указать параметром (стенд шлёт свой хост из
//! туннеля; десктоп читает DUOPULSE_WG_PROBE из окружения — на Android env
//! процесса не задать). Kill-switch — общий wg.rs: handshake старше
//! dead_after (REJECT_AFTER_TIME 180 с) → тоннель мёртв, соединения
//! закрываются, новые отказывают сразу, напрямую ничего не уходит.
//!
//! Маршрутизация трафика ПРИЛОЖЕНИЯ через тоннель (WebView оверлея на
//! локальный роутер `crate::vpn::router`) — этап 7 цепочки duopulse-162;
//! здесь тоннель живёт сам по себе, трафик браузера пока прямой.
//!
//! Модуль — только мобильным таргетам либы (#[tauri::command] в desktop-либе
//! быть не должно — 0xc0000139, см. шапку mobile_open.rs).

use serde::{Deserialize, Serialize};
use schemars::JsonSchema;
use std::sync::{Mutex, OnceLock};
use tauri::Emitter;

use crate::proxy::ProxyState;
use crate::vpn::wg::{self, WgLiveState, WgLiveStatus, WgProfile, WgSession};

/// Живая сессия тоннеля (None — выключен). Старт/остановка — командами,
/// чтение статуса — из любого потока (WgSession::status под мьютексом).
static TUNNEL: OnceLock<Mutex<Option<WgSession>>> = OnceLock::new();

fn tunnel_slot() -> &'static Mutex<Option<WgSession>> {
    TUNNEL.get_or_init(|| Mutex::new(None))
}

/// Каталог профиля (filesDir/profile — общий с историей/паролями).
fn profile_dir() -> Result<std::path::PathBuf, String> {
    crate::mobile_history::profile_dir()
}

// ---------------------------------------------------------------------------
// DTO — зеркала bridge.rs (vpn.*): serde-формы совпадают поле в поле, чтобы
// TS-клиент мобильной ветки (этап 8) переиспользовал типы десктопа. Правки
// контракта десктопа — синхронизировать сюда.
// ---------------------------------------------------------------------------

/// Зеркало bridge::VpnStatusResult (mode на мобильной ветке: off | wg).
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VpnStatusResult {
    /// off | wg (внешнего прокси на мобильной ветке нет).
    pub mode: String,
    /// off | global | split: тоннель поднят — global (этап 7 введёт split).
    pub routing: String,
    pub state: ProxyState,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wg: Option<VpnWgState>,
}

/// Зеркало bridge::VpnWgState — живой снапшот тоннеля.
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VpnWgState {
    pub profile_id: String,
    pub profile_name: String,
    /// connecting | connected | error.
    pub state: String,
    pub endpoint: String,
    /// Сколько мс назад был последний handshake (null — не было).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_handshake_ms: Option<u64>,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    /// RTT ICMP-эхом до DNS-сервера профиля через тоннель, мс (null —
    /// ответа нет дольше 3 с; сервер может не отвечать на ICMP).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ping_ms: Option<u64>,
    /// Unix-ms запуска сессии.
    pub since_ms: i64,
}

/// Зеркало bridge::VpnProfileInfo — строка списка профилей (секретов нет).
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VpnProfileInfo {
    pub id: String,
    pub name: String,
    pub endpoint: String,
    pub address: String,
    #[serde(default)]
    pub dns: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keepalive: Option<u16>,
    /// Активен сейчас (тоннель поднят этим профилем).
    pub active: bool,
}

/// mobile_vpn_import_profile: текст .conf (мобильный лист не открывает файлы
/// сам — фронтенд/стенд читает содержимое своим путём; BOM срезаем, как
/// десктопный vpn.import_profile).
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VpnImportParams {
    /// Текст файла .conf целиком.
    pub text: String,
    /// Имя профиля (имя файла без расширения); пусто — «profile».
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct VpnRemoveProfileParams {
    pub id: String,
}

/// mobile_vpn_use_profile: включить тоннель с профилем (Some) или выключить
/// (None) — семантика десктопного vpn.use_profile минус прокси.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct VpnUseProfileParams {
    #[serde(default)]
    pub id: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct VpnSetEnabledParams {
    pub on: bool,
}

/// mobile_vpn_test_connection: живая проба маршрута (кнопка «Проверить»
/// листа диагностики / стенд). Проба — DNS тоннелем + TCP + первый байт
/// ответа, как десктопная; цель — параметр (стенд шлёт хост из туннеля) или
/// умолчание one.one.one.one:80.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VpnTestParams {
    /// «host:port»; пусто — one.one.one.one:80.
    #[serde(default)]
    pub probe: Option<String>,
}

/// Событие vpn:state_changed — зеркало bridge::VpnStateChanged.
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VpnStateChanged {
    /// off | wg.
    pub mode: String,
    pub state: ProxyState,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wg: Option<VpnWgState>,
}

/// Событие vpn:stats — зеркало bridge::VpnStats.
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VpnStats {
    /// connecting | connected | error — эпоха чисел.
    pub state: String,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ping_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_handshake_ms: Option<u64>,
}

// ---------------------------------------------------------------------------
// Сессия: старт/остановка + события.
// ---------------------------------------------------------------------------

/// Поднять сессию WG с событиями vpn:state_changed / vpn:stats (общее для
/// use_profile/set_enabled). Сессия кладётся в TUNNEL вызывающим.
fn start_session(
    app: &tauri::AppHandle,
    profile: &WgProfile,
    private_key: [u8; 32],
    psk: Option<[u8; 32]>,
) -> Result<WgSession, String> {
    let (profile_id, profile_name, profile_endpoint) = (
        profile.id.clone(),
        profile.name.clone(),
        format!("{}:{}", profile.endpoint_host, profile.endpoint_port),
    );
    let app_for_events = app.clone();
    let on_state: wg::OnStateChange = std::sync::Arc::new(move |s| {
        let _ = app_for_events.emit(
            "vpn:state_changed",
            VpnStateChanged {
                mode: "wg".into(),
                state: live_state_to_proxy(s.state),
                detail: s.detail.clone(),
                wg: Some(live_to_dto(
                    s,
                    &profile_id,
                    &profile_name,
                    &profile_endpoint,
                )),
            },
        );
    });
    let session = WgSession::start(
        profile,
        private_key,
        psk,
        Some(on_state),
        // Порог мёртвости kill-switch — протокольный REJECT_AFTER_TIME
        // (DUOPULSE_WG_DEAD_MS на Android не задать — env процесса).
        wg::tunnel_dead_after(),
    )
    .map_err(|e| format!("поднять тоннель: {e}"))?;
    let app_for_stats = app.clone();
    session.set_stats_sink(std::sync::Arc::new(move |s| {
        let _ = app_for_stats.emit(
            "vpn:stats",
            VpnStats {
                state: s.state.as_str().into(),
                rx_bytes: s.rx_bytes,
                tx_bytes: s.tx_bytes,
                ping_ms: s.ping_ms,
                last_handshake_ms: s.last_handshake_ms,
            },
        );
    }));
    Ok(session)
}

/// Погасить тоннель, если поднят: сессия останавливается (установленные
/// соединения рвутся — напрямую ничего не уходит, kill-switch wg.rs),
/// событие «выключен» уходит без опроса (как десктопный stop_wg_tunnel).
fn stop_tunnel(app: &tauri::AppHandle) {
    if let Some(session) = tunnel_slot().lock().unwrap_or_else(|p| p.into_inner()).take() {
        session.shutdown();
        let _ = app.emit(
            "vpn:state_changed",
            VpnStateChanged {
                mode: "off".into(),
                state: ProxyState::Off,
                detail: "туннель выключен — соединения закрыты, трафик напрямую".into(),
                wg: None,
            },
        );
    }
}

fn live_state_to_proxy(state: WgLiveState) -> ProxyState {
    match state {
        WgLiveState::Error => ProxyState::Error,
        _ => ProxyState::On,
    }
}

/// WgLiveStatus → DTO события/статуса (профиль известен вызывающему).
fn live_to_dto(s: &WgLiveStatus, id: &str, name: &str, endpoint: &str) -> VpnWgState {
    VpnWgState {
        profile_id: id.into(),
        profile_name: name.into(),
        state: s.state.as_str().into(),
        endpoint: endpoint.into(),
        last_handshake_ms: s.last_handshake_ms,
        rx_bytes: s.rx_bytes,
        tx_bytes: s.tx_bytes,
        ping_ms: s.ping_ms,
        since_ms: s.since_ms,
    }
}

/// Снапшот VPN (общее status/событиям): тоннель поднят — mode wg + живой
/// снапшот (имя профиля — из wg-profiles.json), иначе off.
fn collect_status() -> VpnStatusResult {
    let session = tunnel_slot()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    match session {
        Some(session) => {
            let s = session.status();
            let name = profile_dir()
                .map(|dir| {
                    wg::list_profiles(&dir)
                        .into_iter()
                        .find(|p| p.id == session.profile_id())
                        .map(|p| p.name)
                        .unwrap_or_default()
                })
                .unwrap_or_default();
            VpnStatusResult {
                mode: "wg".into(),
                routing: "global".into(),
                state: live_state_to_proxy(s.state),
                detail: s.detail.clone(),
                wg: Some(live_to_dto(
                    &s,
                    session.profile_id(),
                    &name,
                    &s.endpoint,
                )),
            }
        }
        None => VpnStatusResult {
            mode: "off".into(),
            routing: "off".into(),
            state: ProxyState::Off,
            detail: "VPN выключен — соединения прямые".into(),
            wg: None,
        },
    }
}

/// WgProfile → строка списка (открытые поля; секретов нет).
fn profile_info(p: &WgProfile, active: bool) -> VpnProfileInfo {
    VpnProfileInfo {
        id: p.id.clone(),
        name: p.name.clone(),
        endpoint: format!("{}:{}", p.endpoint_host, p.endpoint_port),
        address: format!("{}/{}", p.address, p.prefix),
        dns: p.dns.iter().map(|d| d.to_string()).collect(),
        keepalive: p.keepalive,
        active,
    }
}

// ---------------------------------------------------------------------------
// Команды (контракт vpn.* десктопа; имена mobile_vpn_* — пространство
// мобильной ветки, регистрирует lib.rs).
// ---------------------------------------------------------------------------

/// mobile_vpn_import_profile: текст .conf → профиль (ключи — под Android
/// Keystore через crate::secrets; в wg-profiles.json — только открытые поля).
#[tauri::command]
pub fn mobile_vpn_import_profile(params: VpnImportParams) -> Result<VpnProfileInfo, String> {
    let dir = profile_dir()?;
    let text = params.text.trim_start_matches('\u{feff}').to_string();
    let file_name = params
        .name
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| "profile.conf".into());
    let profile = wg::import_profile(&dir, &text, &file_name)?;
    let active = wg::active_id(&dir).as_deref() == Some(profile.id.as_str());
    Ok(profile_info(&profile, active))
}

/// mobile_vpn_list_profiles: профили для списка (секретов нет).
#[tauri::command]
pub fn mobile_vpn_list_profiles() -> Result<Vec<VpnProfileInfo>, String> {
    let dir = profile_dir()?;
    let active = wg::active_id(&dir);
    Ok(wg::list_profiles(&dir)
        .into_iter()
        .map(|p| {
            let is_active = active.as_deref() == Some(p.id.as_str());
            profile_info(&p, is_active)
        })
        .collect())
}

/// mobile_vpn_remove_profile: удалить профиль и секрет (активный — сначала
/// гасим тоннель, как десктоп).
#[tauri::command]
pub fn mobile_vpn_remove_profile(
    app: tauri::AppHandle,
    params: VpnRemoveProfileParams,
) -> Result<(), String> {
    let dir = profile_dir()?;
    if wg::active_id(&dir).as_deref() == Some(params.id.as_str()) {
        stop_tunnel(&app);
        let _ = wg::set_active(&dir, None);
    }
    wg::remove_profile(&dir, &params.id)?;
    Ok(())
}

/// mobile_vpn_use_profile: включить тоннель с профилем (Some — перезапуск
/// сессии, повторное включение того же профиля применяет свежий импорт) или
/// выключить (None — тоннель гасится, выбор профиля снимается).
#[tauri::command]
pub fn mobile_vpn_use_profile(
    app: tauri::AppHandle,
    params: VpnUseProfileParams,
) -> Result<VpnStatusResult, String> {
    let dir = profile_dir()?;
    stop_tunnel(&app);
    if let Some(id) = &params.id {
        let (profile, private_key, psk) = wg::profile_with_keys(&dir, id).ok_or_else(|| {
            format!("профиль {id} не найден или его ключи не читаются (импортируйте .conf заново)")
        })?;
        let session = start_session(&app, &profile, private_key, psk)?;
        wg::set_active(&dir, Some(id))?;
        *tunnel_slot().lock().unwrap_or_else(|p| p.into_inner()) = Some(session);
    } else {
        wg::set_active(&dir, None)?;
    }
    Ok(collect_status())
}

/// mobile_vpn_set_enabled: тумблер тоннеля (у десктопа — внешний прокси;
/// мобильной ветке прокси не нужен — включение поднимает тоннель активного
/// профиля, выключение гасит; выбранный профиль сохраняется).
#[tauri::command]
pub fn mobile_vpn_set_enabled(
    app: tauri::AppHandle,
    params: VpnSetEnabledParams,
) -> Result<VpnStatusResult, String> {
    let dir = profile_dir()?;
    if !params.on {
        stop_tunnel(&app);
        return Ok(collect_status());
    }
    let already_up = tunnel_slot()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .is_some();
    if already_up {
        return Ok(collect_status());
    }
    let (profile, private_key, psk) = wg::active_profile(&dir).ok_or_else(|| {
        "нет активного профиля WireGuard — сначала импортируйте и выберите .conf".to_string()
    })?;
    let session = start_session(&app, &profile, private_key, psk)?;
    *tunnel_slot().lock().unwrap_or_else(|p| p.into_inner()) = Some(session);
    Ok(collect_status())
}

/// mobile_vpn_status: снапшот тоннеля (endpoint, возраст handshake, rx/tx,
/// ping) — лист диагностики и стенды.
#[tauri::command]
pub fn mobile_vpn_status() -> VpnStatusResult {
    collect_status()
}

/// mobile_vpn_test_connection: живая проба через тоннель (DNS тоннелем +
/// TCP + первый байт ответа, замер мс) — как десктопная test_vpn_route,
/// цель можно задать параметром (стенды; умолчание one.one.one.one:80).
#[tauri::command]
pub async fn mobile_vpn_test_connection(
    params: Option<VpnTestParams>,
) -> Result<VpnStatusResult, String> {
    let probe = params
        .and_then(|p| p.probe)
        .filter(|p| !p.trim().is_empty())
        .or_else(|| std::env::var("DUOPULSE_WG_PROBE").ok())
        .unwrap_or_else(|| "one.one.one.one:80".into());
    tauri::async_runtime::spawn_blocking(move || {
        let mut status = collect_status();
        if status.mode != "wg" {
            return status;
        }
        let Some(session) = tunnel_slot()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
        else {
            return status;
        };
        let started = std::time::Instant::now();
        let verdict = (|| -> Result<usize, String> {
            let (host, port) = probe
                .rsplit_once(':')
                .ok_or_else(|| format!("проба «{probe}» без порта"))?;
            let ip = session.resolve(host)?;
            let stream = session.tcp_connect(std::net::SocketAddr::new(
                std::net::IpAddr::V4(ip),
                port.parse().map_err(|_| "порт пробы не число".to_string())?,
            ))?;
            let (mut reply_reader, mut request_writer) = stream.split();
            use std::io::{Read, Write};
            request_writer
                .write_all(format!("HEAD / HTTP/1.0\r\nHost: {host}\r\n\r\n").as_bytes())
                .map_err(|e| format!("запрос: {e}"))?;
            let mut first = [0u8; 1];
            reply_reader
                .read_exact(&mut first)
                .map(|_| 1)
                .map_err(|e| format!("ответ: {e}"))
        })();
        match verdict {
            Ok(_) => {
                status.state = ProxyState::On;
                status.detail = format!(
                    "тоннель: ответ от {probe} за {} мс",
                    started.elapsed().as_millis()
                );
            }
            Err(e) => {
                status.state = ProxyState::Error;
                status.detail = format!("тоннель до {probe}: {e}");
            }
        }
        status
    })
    .await
    .map_err(|e| e.to_string())
}
