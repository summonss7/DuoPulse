// DuoPulse — M0 спайк: Tauri 2 + WebView2 против YouTube (карточка duopulse-003).
// Внешний прокси SOCKS5/HTTP(S) — задача 1.8 этапа M1 (карточка duopulse-009).
// IPC-контракт bridge (команды/события UI|Content ↔ Core) — задача 1.1,
// реализация и регистрация команд — src/bridge.rs (docs/05 §1–2).
//
// Архитектура спайка (docs/02-architecture.md, слои Shell/UI):
//   окно "main"
//     ├─ webview UI (label "main", фронтенд из ../dist): адресная строка + меню «Прокси»
//     └─ webview "content" (дочерний, удалённые сайты): youtube.com и т.п.
//
// Проверяемые гипотезы M0:
//   1) WebView2 играет видео YouTube (1080p60/4K) — мониторит инжектируемый скрипт;
//   2) инжекция content-скрипта в каждый документ
//      (WebviewBuilder::initialization_script → AddScriptToExecuteOnDocumentCreatedAsync);
//   3) перехват сетевых запросов (on_web_resource_request → WebResourceRequested):
//      запросы с путём /duopulse_block_test_probe получают 403 + X-DuoPulse-Block: 1.
//
// Прокси (duopulse-009, docs/02 §6.3 «A»): конфиг читается ДО создания webview —
// аргументы окружения WebView2 (--proxy-server/--proxy-bypass-list) задаются только
// на старте, смена настроек применяется перезапуском приложения.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod proxy;

use tauri::{
    webview::{Webview, WebviewBuilder},
    LogicalPosition, LogicalSize, Manager, Url, WebviewUrl, Window, WindowEvent,
};

/// Высота UI-полосы (адресная строка) в логических пикселях.
/// Синхронизирована с #app { height } в src/style.css.
const TOP_BAR_HEIGHT: f64 = 52.0;

/// Путь-маркер для теста сетевого перехвата: такие запросы блокируются (403).
const BLOCK_TEST_PATH: &str = "/duopulse_block_test_probe";

const CONTENT_INIT_SCRIPT: &str = include_str!("../../content/m0-spike.js");

/// Размер дочернего webview под адресной строкой.
fn content_rect(window: &Window<tauri::Wry>) -> (LogicalPosition<f64>, LogicalSize<f64>) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let size = window
        .inner_size()
        .unwrap_or_default()
        .to_logical::<f64>(scale);
    (
        LogicalPosition::new(0.0, TOP_BAR_HEIGHT),
        LogicalSize::new(size.width, (size.height - TOP_BAR_HEIGHT).max(0.0)),
    )
}

fn build_content_webview(proxy_args: &str) -> WebviewBuilder<tauri::Wry> {
    // DUOPULSE_START_URL переопределяет стартовую страницу content-webview —
    // используется e2e-стендами (например, звуковой тест duopulse-006,
    // e2e/m0-audio/audio-test.html) вместо ручного ввода адреса.
    let start_url =
        std::env::var("DUOPULSE_START_URL").unwrap_or_else(|_| "https://www.youtube.com/".into());
    WebviewBuilder::new(
        "content",
        WebviewUrl::External(Url::parse(&start_url).expect("DUOPULSE_START_URL: некорректный URL")),
    )
    // Критерий M0: скрипт выполняется в каждом новом документе
    // (WebView2: AddScriptToExecuteOnDocumentCreatedAsync).
    .initialization_script(CONTENT_INIT_SCRIPT)
    // Аргументы те же, что у UI-webview: окружение WebView2 создаётся первым
    // webview, но дублируем для устойчивости к порядку создания.
    .additional_browser_args(proxy_args)
}

/// Аутентификация прокси: WebView2 не принимает логин/пароль внутри --proxy-server,
/// на вызов 407 (basic challenge) отвечает событие BasicAuthenticationRequested —
/// подставляем сохранённые креденшалы (логин из settings.json, пароль из DPAPI).
#[cfg(windows)]
unsafe fn install_proxy_auth(wv: tauri::webview::PlatformWebview) {
    use webview2_com::{
        BasicAuthenticationRequestedEventHandler, Microsoft::Web::WebView2::Win32::ICoreWebView2_10,
    };
    use windows_core::{Interface, HSTRING};

    let core = wv.controller().CoreWebView2().expect("CoreWebView2");
    let core10: ICoreWebView2_10 = core
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
unsafe fn install_request_blocker(wv: tauri::webview::PlatformWebview) {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
        WebResourceRequestedEventHandler,
    };
    use windows_core::{HSTRING, PWSTR};

    let core = wv.controller().CoreWebView2().expect("CoreWebView2");
    core.AddWebResourceRequestedFilter(&HSTRING::from("*"), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)
        .expect("AddWebResourceRequestedFilter");

    let env = wv.environment();
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

fn main() {
    // IPC-контракт bridge (задача 1.1): все команды/события — src/bridge.rs.
    bridge::register(tauri::Builder::default())
        .setup(|app| {
            // Прокси задаётся аргументами окружения WebView2 только на старте
            // (docs/02 §6.1) — конфиг читаем ДО создания webview.
            let proxy_cfg = proxy::load_config(&proxy::profile_dir());
            let proxy_args = proxy::browser_args(Some(&proxy_cfg));

            // Окно создаётся кодом (не из tauri.conf.json), чтобы подставить
            // аргументы: UI-webview и дочерний content-webview делят одно
            // окружение WebView2 — прокси действует на оба (localhost обходит).
            tauri::WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("DuoPulse")
                .inner_size(1360.0, 860.0)
                .min_inner_size(800.0, 600.0)
                .resizable(true)
                .additional_browser_args(&proxy_args)
                .build()?;
            let window: Window<tauri::Wry> =
                app.get_window("main").expect("окно main создано выше");

            // Дочерний webview с контентной частью (YouTube) — под адресной строкой.
            let (pos, size) = content_rect(&window);
            let content: Webview<tauri::Wry> =
                window.add_child(build_content_webview(&proxy_args), pos, size)?;

            // Перехват сетевых запросов (WebResourceRequested) — см. install_request_blocker.
            content.with_webview(|wv| unsafe { install_request_blocker(wv) })?;

            // Ответ на вызовы аутентификации прокси (407/basic) — см. install_proxy_auth.
            #[cfg(windows)]
            content.with_webview(|wv| unsafe { install_proxy_auth(wv) })?;

            // Держим контентный webview растянутым при изменении размера окна.
            let window_for_events = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::Resized(_) = event {
                    let (pos, size) = content_rect(&window_for_events);
                    let _ = content.set_position(pos);
                    let _ = content.set_size(size);
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("ошибка запуска DuoPulse");
}
