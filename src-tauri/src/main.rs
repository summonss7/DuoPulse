// DuoPulse — M0 спайк: Tauri 2 + WebView2 против YouTube (карточка duopulse-003).
// Внешний прокси SOCKS5/HTTP(S) — задача 1.8 этапа M1 (карточка duopulse-009).
// IPC-контракт bridge (команды/события UI|Content ↔ Core) — задача 1.1,
// реализация и регистрация команд — src/bridge.rs (docs/05 §1–2).
// Менеджер вкладок (мульти-webview, таб-бар) — задача 1.2, src/tabs/;
// восстановление сессии (ленивое, session.json в профиле) — задача 1.6,
// src/tabs/session.rs: сохранение при каждой мутации и при выходе (RunEvent).
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

mod adblock;
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
/// таб-бара (задача 1.2) + монитор медиа для спящего режима (задача 2.3) +
/// косметика блокировщика (задача 2.2).
pub(crate) const CONTENT_INIT_SCRIPT_M0: &str = include_str!("../../content/m0-spike.js");
pub(crate) const CONTENT_INIT_SCRIPT_HOTKEYS: &str =
    include_str!("../../content/chrome-hotkeys.js");
pub(crate) const CONTENT_INIT_SCRIPT_MEDIA: &str = include_str!("../../content/media-watch.js");
pub(crate) const CONTENT_INIT_SCRIPT_COSMETIC: &str = include_str!("../../content/cosmetic.js");

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
/// Задача 2.1: каждый http(s)-запрос проходит через движок блокировщика
/// (adblock-rs, src/adblock/): решение должно быть быстрым — обработчик
/// вызывается синхронно на UI-потоке WebView2.
///
/// Источник запроса для движка: Referer (для подресурсов), при его отсутствии
/// URL вкладки tab_id; тип запроса — из ResourceContext. Запросы с путём
/// BLOCK_TEST_PATH получают 403 + заголовок X-DuoPulse-Block: 1 (тест M0).
#[cfg(windows)]
unsafe fn install_request_blocker(
    core: &ICoreWebView2,
    env: &ICoreWebView2Environment,
    app: &AppHandle,
    tab_id: &str,
) {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
        WebResourceRequestedEventHandler,
    };
    use windows_core::{HSTRING, PWSTR};

    core.AddWebResourceRequestedFilter(&HSTRING::from("*"), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)
        .expect("AddWebResourceRequestedFilter");

    let env = env.clone();
    let app = app.clone();
    let tab_id = tab_id.to_string();
    core.add_WebResourceRequested(
        &WebResourceRequestedEventHandler::create(Box::new(move |_sender, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let request = args.Request()?;
            let mut uri_pw = PWSTR::null();
            request.Uri(&mut uri_pw)?;
            let uri = webview2_com::CoTaskMemPWSTR::from(uri_pw).to_string();
            if uri.contains(BLOCK_TEST_PATH) {
                let response = env.CreateWebResourceResponse(
                    None,
                    403,
                    &HSTRING::from("Blocked by DuoPulse"),
                    &HSTRING::from("X-DuoPulse-Block: 1\r\nAccess-Control-Allow-Origin: *"),
                )?;
                args.SetResponse(&response)?;
                return Ok(());
            }
            // Блокировщик (задача 2.1): фильтруем только http(s) — app-origin
            // (tauri://, dev-сервер vite грузится из webview без обработчика),
            // ws/wss и прочие схемы движку не нужны.
            let is_http = uri.starts_with("http://") || uri.starts_with("https://");
            if !is_http {
                return Ok(());
            }
            let rtype = resource_type_name(&args);
            let referer = referer_of(&request);
            let tab_url = app.state::<tabs::TabManager>().url_of(&tab_id);
            let blocked = app
                .state::<std::sync::Arc<adblock::AdblockService>>()
                .should_block(tab_url.as_deref(), &uri, rtype, referer.as_deref());
            if blocked {
                let response = env.CreateWebResourceResponse(
                    None,
                    403,
                    &HSTRING::from("Blocked by DuoPulse adblock"),
                    &HSTRING::from("X-DuoPulse-Block: adblock\r\nAccess-Control-Allow-Origin: *"),
                )?;
                args.SetResponse(&response)?;
            }
            Ok(())
        })),
        std::ptr::null_mut(),
    )
    .expect("add_WebResourceRequested");
}

/// Тип запроса для движка adblock-rs из ResourceContext (строки — словарь
/// Brave-движка: «document», «script», …; всё нераспознанное — «other»).
#[cfg(windows)]
unsafe fn resource_type_name(
    args: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2WebResourceRequestedEventArgs,
) -> &'static str {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_CSP_VIOLATION_REPORT,
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH,
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FONT, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE,
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MEDIA, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_OTHER,
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_PING, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT,
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_STYLESHEET, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET,
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST,
    };
    let mut ctx = COREWEBVIEW2_WEB_RESOURCE_CONTEXT_OTHER;
    if args.ResourceContext(&mut ctx).is_err() {
        return "other";
    }
    match ctx {
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT => "document",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_STYLESHEET => "stylesheet",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT => "script",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE => "image",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FONT => "font",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MEDIA => "media",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST
        | COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH => "xhr",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET => "websocket",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_PING => "ping",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_CSP_VIOLATION_REPORT => "csp_report",
        // manifest/web worker/service worker/event source/signed exchange/прочее
        _ => "other",
    }
}

/// Заголовок Referer запроса — источник подресурса для движка (кросс-доменные
/// правила и $domain-исключения). Отсутствует/пустой — None.
#[cfg(windows)]
unsafe fn referer_of(
    request: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2WebResourceRequest,
) -> Option<String> {
    use windows_core::{HSTRING, PWSTR};
    let headers = request.Headers().ok()?;
    let mut value = PWSTR::null();
    headers
        .GetHeader(&HSTRING::from("Referer"), &mut value)
        .ok()?;
    let value = webview2_com::CoTaskMemPWSTR::from(value).to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

/// Сообщения content-слоя вкладки (window.chrome.webview.postMessage):
/// - «hotkey» — горячие клавиши таб-бара (content/chrome-hotkeys.js →
///   tabs::handle_hotkey, задача 1.2);
/// - «media» — состояние медиа документа (content/media-watch.js, задача
///   2.3: играет звук/видео → вкладка не усыпляется); вкладка-отправитель —
///   tab_id (обработчик ставится на каждый webview отдельно);
/// - «cosmetic»/«cosmetic-generic» — запросы косметических ресурсов документа
///   (content/cosmetic.js, задача 2.2): селекторы скрытия из adblock-rs
///   возвращаются тому же webview PostWebMessageAsString (доставляется только
///   top-level документу — скрипт во фреймах запросы не шлёт); в том же
///   ответе — код скриптлетов `##+js` (injectedScript, карточка duopulse-043);
/// - прочие (IPC tauri обрабатывает свои параллельно) игнорируются.
#[cfg(windows)]
unsafe fn install_content_messaging(core: &ICoreWebView2, app: &AppHandle, tab_id: &str) {
    use webview2_com::WebMessageReceivedEventHandler;
    use windows_core::PWSTR;

    let app = app.clone();
    let tab_id = tab_id.to_string();
    core.add_WebMessageReceived(
        &WebMessageReceivedEventHandler::create(Box::new(move |sender, args| {
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
            } else if parsed["duopulse"] == "media" {
                if let Some(playing) = parsed["playing"].as_bool() {
                    app.state::<tabs::TabManager>()
                        .on_media(&app, &tab_id, playing);
                }
            } else if parsed["duopulse"] == "cosmetic" {
                if let Some(url) = parsed["url"].as_str() {
                    let res = app
                        .state::<std::sync::Arc<adblock::AdblockService>>()
                        .cosmetic_resources(url);
                    let reply = serde_json::json!({
                        "duopulse": "cosmetic-resources",
                        "url": url,
                        "active": res.active,
                        "ready": res.ready,
                        "hide": res.hide,
                        "generichide": res.generichide,
                        "injectedScript": res.injected_script,
                    });
                    post_to_page(sender.as_ref(), &reply);
                }
            } else if parsed["duopulse"] == "cosmetic-generic" {
                if let Some(url) = parsed["url"].as_str() {
                    let classes: Vec<String> = parsed["classes"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .filter_map(|v| v.as_str().map(str::to_string))
                                .collect()
                        })
                        .unwrap_or_default();
                    let ids: Vec<String> = parsed["ids"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .filter_map(|v| v.as_str().map(str::to_string))
                                .collect()
                        })
                        .unwrap_or_default();
                    let selectors = app
                        .state::<std::sync::Arc<adblock::AdblockService>>()
                        .cosmetic_generic_selectors(url, &classes, &ids);
                    let reply = serde_json::json!({
                        "duopulse": "cosmetic-generic-selectors",
                        "url": url,
                        "selectors": selectors,
                    });
                    post_to_page(sender.as_ref(), &reply);
                }
            }
            Ok(())
        })),
        std::ptr::null_mut(),
    )
    .expect("add_WebMessageReceived");
}

/// Ответ документу вкладки (WebMessage-канал задачи 2.2): PostWebMessageAsString
/// доставляет строку в window.chrome.webview «message» top-level документа.
#[cfg(windows)]
fn post_to_page(
    sender: Option<&webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2>,
    value: &serde_json::Value,
) {
    if let Some(core) = sender {
        // Доставка Best-effort: страница могла уже уйти навигацией — ошибка не критична.
        let _ =
            unsafe { core.PostWebMessageAsString(&windows_core::HSTRING::from(value.to_string())) };
    }
}

/// Полный набор COM-обработчиков для каждой вкладки: сетевой перехват M0 +
/// блокировщик (задача 2.1), аутентификация прокси (1.8), сообщения content
/// (горячие клавиши, 1.2). tab_id — вкладка-владелец: её URL — запасной
/// источник запроса для движка.
#[cfg(windows)]
pub(crate) unsafe fn install_content_handlers(
    wv: tauri::webview::PlatformWebview,
    app: &AppHandle,
    tab_id: &str,
) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2, ICoreWebView2Environment};

    let controller = wv.controller();
    let core: ICoreWebView2 = controller.CoreWebView2().expect("CoreWebView2 вкладки");
    let env: ICoreWebView2Environment = wv.environment();
    install_request_blocker(&core, &env, app, tab_id);
    install_proxy_auth(&core);
    install_content_messaging(&core, app, tab_id);
}

/// Нешиндовс-фолбэк: без COM (сборка проекта — только Windows, см. Cargo.toml).
#[cfg(not(windows))]
pub(crate) unsafe fn install_content_handlers(
    _wv: tauri::webview::PlatformWebview,
    _app: &AppHandle,
    _tab_id: &str,
) {
}

fn main() {
    // IPC-контракт bridge (задача 1.1): все команды/события — src/bridge.rs.
    // Менеджер вкладок (задача 1.2) — состояние Core для tabs.* и nav.*.
    // История и закладки (задача 1.4) — SQLite в профиле (docs/02 §8):
    // duopulse.db, запись визитов — из on_page_load вкладок (src/tabs/).
    // Блокировщик (задача 2.1) — src/adblock/: движок adblock-rs + списки;
    // нити обновления/слива счётчика стартуют в setup (нужен AppHandle).
    let adblock_service = std::sync::Arc::new(adblock::AdblockService::new(&proxy::profile_dir()));
    let history_store = history::HistoryStore::open(&proxy::profile_dir())
        .expect("открыть/создать duopulse.db в профиле (docs/02 §8)");
    let adblock_for_setup = std::sync::Arc::clone(&adblock_service);
    bridge::register(tauri::Builder::default())
        .manage(tabs::TabManager::new())
        .manage(history_store)
        .manage(adblock_service)
        .setup(move |app| {
            // Фон блокировщика: обновление списков (кэш → движок → сеть) и
            // батчинг счётчика adblock:blocked_count (задача 2.1).
            adblock_for_setup.start(app.handle());
            // Спящий режим вкладок (задача 2.3): нить авто-усыпления
            // долгих простоев (DUOPULSE_SLEEP_AFTER_SECS=0 — выключена).
            tabs::start_sleeper(app.handle().clone());
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
        .build(tauri::generate_context!())
        .expect("ошибка сборки DuoPulse")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                // Сохранение сессии при выходе (задача 1.6): при закрытии окна
                // (ExitRequested) и на финальном Exit (в т.ч. после app.restart).
                // Запись идемпотентна — менеджер вкладок в момент выхода ещё жив,
                // состояние списка не меняется между событиями.
                app.state::<tabs::TabManager>().persist_session();
            }
            if let tauri::RunEvent::Ready = event {
                // Восстановление сессии (задача 1.6): webview активной вкладки
                // создаётся только когда цикл событий гарантированно качает
                // сообщения (в setup и первые его мгновения — гонка с дедлоком
                // создания webview, см. tabs::init).
                app.state::<tabs::TabManager>()
                    .spawn_restore_materialize(app);
            }
        });
}
