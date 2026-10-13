// DuoPulse — M0 спайк: Tauri 2 + WebView2 против YouTube (карточка duopulse-003).
// Внешний прокси SOCKS5/HTTP(S) — задача 1.8 этапа M1 (карточка duopulse-009).
// IPC-контракт bridge (команды/события UI|Content ↔ Core) — задача 1.1,
// реализация и регистрация команд — src/bridge.rs (docs/05 §1–2).
// Менеджер вкладок (мульти-webview, таб-бар) — задача 1.2, src/tabs/.
//
// Архитектура (docs/02-architecture.md, слои Shell/UI):
//   окно "main"
//     ├─ webview UI (label "main", фронтенд из ../dist): таб-бар + адресная строка
//     └─ webview вкладок "tab-N" (дочерние, удалённые сайты): активная видна,
//        остальные скрыты; жизненным циклом управляет src/tabs/ (задача 1.2)
//
// Проверяемые гипотезы M0 (сохранены на каждой вкладке):
//   1) WebView2 играет видео YouTube (1080p60/4K) — мониторит инжектируемый скрипт;
//   2) инжекция content-скрипта в каждый документ
//      (WebviewBuilder::initialization_script → AddScriptToExecuteOnDocumentCreatedAsync);
//   3) перехват сетевых запросов (WebResourceRequested):
//      запросы с путём /duopulse_block_test_probe получают 403 + X-DuoPulse-Block: 1.
//
// Прокси (duopulse-009, docs/02 §6.3 «A»): конфиг читается ДО создания webview —
// аргументы окружения WebView2 (--proxy-server/--proxy-bypass-list) задаются только
// на старте, смена настроек применяется перезапуском приложения. Аргументы старта
// фиксируются в STARTUP_PROXY_ARGS — новые вкладки создаются с теми же.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod history;
mod omnibox;
mod proxy;
mod tabs;

use std::sync::OnceLock;

use tauri::{AppHandle, Manager, Window, WindowEvent};

#[cfg(windows)]
use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2, ICoreWebView2Environment};

/// Путь-маркер для теста сетевого перехвата: такие запросы блокируются (403).
const BLOCK_TEST_PATH: &str = "/duopulse_block_test_probe";

/// Content-скрипты каждой вкладки (docs/02 §4): монитор M0 + горячие клавиши
/// таб-бара (задача 1.2).
pub(crate) const CONTENT_INIT_SCRIPT_M0: &str = include_str!("../../content/m0-spike.js");
pub(crate) const CONTENT_INIT_SCRIPT_HOTKEYS: &str =
    include_str!("../../content/chrome-hotkeys.js");

/// Аргументы окружения WebView2, зафиксированные на старте приложения:
/// каждая новая вкладка наследует их (сменить можно только перезапуском).
static STARTUP_PROXY_ARGS: OnceLock<String> = OnceLock::new();

pub(crate) fn startup_proxy_args() -> &'static str {
    STARTUP_PROXY_ARGS.get().map(String::as_str).unwrap_or("")
}

/// Аутентификация прокси: WebView2 не принимает логин/пароль внутри --proxy-server,
/// на вызов 407 (basic challenge) отвечает событие BasicAuthenticationRequested —
/// подставляем сохранённые креденшалы (логин из settings.json, пароль из DPAPI).
#[cfg(windows)]
unsafe fn install_proxy_auth(core: &ICoreWebView2) {
    use webview2_com::BasicAuthenticationRequestedEventHandler;
    use windows_core::{Interface, HSTRING};

    let core10: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_10 = core
        .cast()
        .expect("ICoreWebView2_10 (BasicAuthentication, WebView2 SDK 1.0.1155+)");
    core10
        .add_BasicAuthenticationRequested(
            &BasicAuthenticationRequestedEventHandler::create(Box::new(|_sender, args| {
                let Some(args) = args else {
                    return Ok(());
                };
                // Читаем при каждом вызове: настройки могли сохранить уже после старта.
                let dir = proxy::profile_dir();
                let cfg = proxy::load_config(&dir);
                let login = cfg.login.clone().unwrap_or_default();
                let password = proxy::load_password(&dir).unwrap_or_default();
                if login.is_empty() && password.is_empty() {
                    return Ok(()); // креденшалов нет — не отвечаем на вызов
                }
                let response = args.Response()?;
                response.SetUserName(&HSTRING::from(&login))?;
                response.SetPassword(&HSTRING::from(&password))?;
                Ok(())
            })),
            std::ptr::null_mut(),
        )
        .expect("add_BasicAuthenticationRequested");
}

/// Критерий M0: сетевой перехват через WebView2 WebResourceRequested.
///
/// ВАЖНО: tauri `on_web_resource_request` срабатывает только на запросы к
/// собственному tauri://-протоколу приложения, поэтому для внешних http/https
/// запросов регистрируем нативный COM-обработчик:
/// AddWebResourceRequestedFilter("*", ALL) + add_WebResourceRequested.
/// Запросы с путём BLOCK_TEST_PATH получают 403 + заголовок X-DuoPulse-Block: 1.
#[cfg(windows)]
unsafe fn install_request_blocker(core: &ICoreWebView2, env: &ICoreWebView2Environment) {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
        WebResourceRequestedEventHandler,
    };
    use windows_core::{HSTRING, PWSTR};

    core.AddWebResourceRequestedFilter(&HSTRING::from("*"), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)
        .expect("AddWebResourceRequestedFilter");

    let env = env.clone();
    core.add_WebResourceRequested(
        &WebResourceRequestedEventHandler::create(Box::new(move |_sender, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let mut uri_pw = PWSTR::null();
            args.Request()?.Uri(&mut uri_pw)?;
            let uri = webview2_com::CoTaskMemPWSTR::from(uri_pw).to_string();
            if uri.contains(BLOCK_TEST_PATH) {
                let response = env.CreateWebResourceResponse(
                    None,
                    403,
                    &HSTRING::from("Blocked by DuoPulse"),
                    &HSTRING::from("X-DuoPulse-Block: 1\r\nAccess-Control-Allow-Origin: *"),
                )?;
                args.SetResponse(&response)?;
            }
            Ok(())
        })),
        std::ptr::null_mut(),
    )
    .expect("add_WebResourceRequested");
}

/// Сообщения content-слоя вкладки (window.chrome.webview.postMessage, задача 1.2):
/// горячие клавиши таб-бара из content/chrome-hotkeys.js → tabs::handle_hotkey.
/// Прочие сообщения (IPC tauri обрабатывает свои параллельно) игнорируются.
#[cfg(windows)]
unsafe fn install_content_messaging(core: &ICoreWebView2, app: &AppHandle) {
    use webview2_com::WebMessageReceivedEventHandler;
    use windows_core::PWSTR;

    let app = app.clone();
    core.add_WebMessageReceived(
        &WebMessageReceivedEventHandler::create(Box::new(move |_sender, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let mut msg_pw = PWSTR::null();
            if args.TryGetWebMessageAsString(&mut msg_pw).is_err() {
                return Ok(()); // бинарное сообщение — не наше
            }
            let msg = webview2_com::CoTaskMemPWSTR::from(msg_pw).to_string();
            let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&msg) else {
                return Ok(());
            };
            if parsed["duopulse"] == "hotkey" {
                if let Some(key) = parsed["key"].as_str() {
                    app.state::<tabs::TabManager>().handle_hotkey(&app, key);
                }
            }
            Ok(())
        })),
        std::ptr::null_mut(),
    )
    .expect("add_WebMessageReceived");
}

/// Полный набор COM-обработчиков для каждой вкладки: сетевой перехват M0,
/// аутентификация прокси (1.8), сообщения content (горячие клавиши, 1.2).
#[cfg(windows)]
pub(crate) unsafe fn install_content_handlers(
    wv: tauri::webview::PlatformWebview,
    app: &AppHandle,
) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2, ICoreWebView2Environment};

    let controller = wv.controller();
    let core: ICoreWebView2 = controller.CoreWebView2().expect("CoreWebView2 вкладки");
    let env: ICoreWebView2Environment = wv.environment();
    install_request_blocker(&core, &env);
    install_proxy_auth(&core);
    install_content_messaging(&core, app);
}

/// Нешиндовс-фолбэк: без COM (сборка проекта — только Windows, см. Cargo.toml).
#[cfg(not(windows))]
pub(crate) unsafe fn install_content_handlers(
    _wv: tauri::webview::PlatformWebview,
    _app: &AppHandle,
) {
}

fn main() {
    // IPC-контракт bridge (задача 1.1): все команды/события — src/bridge.rs.
    // Менеджер вкладок (задача 1.2) — состояние Core для tabs.* и nav.*.
    // История и закладки (задача 1.4) — SQLite в профиле (docs/02 §8):
    // duopulse.db, запись визитов — из on_page_load вкладок (src/tabs/).
    let history_store = history::HistoryStore::open(&proxy::profile_dir())
        .expect("открыть/создать duopulse.db в профиле (docs/02 §8)");
    bridge::register(tauri::Builder::default())
        .manage(tabs::TabManager::new())
        .manage(history_store)
        .setup(|app| {
            // Прокси задаётся аргументами окружения WebView2 только на старте
            // (docs/02 §6.1) — конфиг читаем ДО создания webview; аргументы
            // фиксируем для всех будущих вкладок (STARTUP_PROXY_ARGS).
            let proxy_cfg = proxy::load_config(&proxy::profile_dir());
            let proxy_args = proxy::browser_args(Some(&proxy_cfg));
            STARTUP_PROXY_ARGS
                .set(proxy_args.clone())
                .expect("STARTUP_PROXY_ARGS инициализируется один раз");

            // Окно создаётся кодом (не из tauri.conf.json), чтобы подставить
            // аргументы: UI-webview и дочерние webview вкладок делят одно
            // окружение WebView2 — прокси действует на все (localhost обходит).
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("DuoPulse")
            .inner_size(1360.0, 860.0)
            .min_inner_size(800.0, 600.0)
            .resizable(true)
            .additional_browser_args(&proxy_args)
            .build()?;
            let app = app.handle().clone();
            let window: Window<tauri::Wry> =
                app.get_window("main").expect("окно main создано выше");

            // Первая вкладка (стартовый URL / DUOPULSE_START_URL) — задача 1.2.
            app.state::<tabs::TabManager>().init(&app)?;

            // Все вкладки растягиваются при изменении размера окна (в т.ч.
            // скрытые — чтобы активация не показала старую геометрию).
            window.on_window_event(move |event| {
                if let WindowEvent::Resized(_) = event {
                    app.state::<tabs::TabManager>().relayout(&app);
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("ошибка запуска DuoPulse");
}
