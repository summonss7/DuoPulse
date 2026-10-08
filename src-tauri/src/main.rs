// DuoPulse — M0 спайк: Tauri 2 + WebView2 против YouTube (карточка duopulse-003).
//
// Архитектура спайка (docs/02-architecture.md, слои Shell/UI):
//   окно "main"
//     ├─ webview UI (label "main", фронтенд из ../dist): адресная строка-заглушка
//     └─ webview "content" (дочерний, удалённые сайты): youtube.com и т.п.
//
// Проверяемые гипотезы M0:
//   1) WebView2 играет видео YouTube (1080p60/4K) — мониторит инжектируемый скрипт;
//   2) инжекция content-скрипта в каждый документ
//      (WebviewBuilder::initialization_script → AddScriptToExecuteOnDocumentCreatedAsync);
//   3) перехват сетевых запросов (on_web_resource_request → WebResourceRequested):
//      запросы с путём /duopulse_block_test_probe получают 403 + X-DuoPulse-Block: 1.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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
    let size = window.inner_size().unwrap_or_default().to_logical::<f64>(scale);
    (
        LogicalPosition::new(0.0, TOP_BAR_HEIGHT),
        LogicalSize::new(size.width, (size.height - TOP_BAR_HEIGHT).max(0.0)),
    )
}

fn build_content_webview() -> WebviewBuilder<tauri::Wry> {
    WebviewBuilder::new(
        "content",
        WebviewUrl::External(Url::parse("https://www.youtube.com/").unwrap()),
    )
    // Критерий M0: скрипт выполняется в каждом новом документе
    // (WebView2: AddScriptToExecuteOnDocumentCreatedAsync).
    .initialization_script(CONTENT_INIT_SCRIPT)
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

#[tauri::command]
fn navigate(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let webview = app
        .get_webview("content")
        .ok_or_else(|| "webview content не найден".to_string())?;
    webview
        .navigate(Url::parse(&url).map_err(|e| format!("некорректный URL: {e}"))?)
        .map_err(|e| format!("navigate: {e}"))
}

#[tauri::command]
fn go_back(app: tauri::AppHandle) -> Result<(), String> {
    eval_content(&app, "history.back()")
}

#[tauri::command]
fn go_forward(app: tauri::AppHandle) -> Result<(), String> {
    eval_content(&app, "history.forward()")
}

#[tauri::command]
fn reload(app: tauri::AppHandle) -> Result<(), String> {
    eval_content(&app, "location.reload()")
}

fn eval_content(app: &tauri::AppHandle, js: &str) -> Result<(), String> {
    app.get_webview("content")
        .ok_or_else(|| "webview content не найден".to_string())?
        .eval(js)
        .map_err(|e| format!("eval: {e}"))
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![navigate, go_back, go_forward, reload])
        .setup(|app| {
            let window = app
                .get_window("main")
                .expect("окно main создаётся из tauri.conf.json");

            // Дочерний webview с контентной частью (YouTube) — под адресной строкой.
            let (pos, size) = content_rect(&window);
            let content: Webview<tauri::Wry> = window.add_child(build_content_webview(), pos, size)?;

            // Перехват сетевых запросов (WebResourceRequested) — см. install_request_blocker.
            content.with_webview(|wv| unsafe { install_request_blocker(wv) })?;

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
        .expect("ошибка запуска DuoPulse M0");
}
