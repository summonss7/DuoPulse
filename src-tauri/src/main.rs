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

// schemars schema!-макросы в contract_json (bridge.rs) вложены в один json!:
// с ростом словаря (v2: subtitles.load_file) глубина экспансии превысила
// дефолт макро-рекурсии rustc (128).
#![recursion_limit = "256"]
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod adblock;
mod bridge;
mod history;
mod omnibox;
mod perf;
mod prefetch;
mod proxy;
mod subtitles;
mod tabs;

use std::sync::OnceLock;

use tauri::{AppHandle, Manager, Window, WindowEvent};

#[cfg(windows)]
use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2, ICoreWebView2Environment};

/// Метка фазы старта: «[startup] <фаза>: N мс» от входа в main (печать +
/// накопление для страницы «Диагностика» — perf::record_phase, задачи 2.4/2.5).
fn startup_mark(stage: &str) {
    perf::record_phase(stage);
}

/// Путь-маркер для теста сетевого перехвата: такие запросы блокируются (403).
const BLOCK_TEST_PATH: &str = "/duopulse_block_test_probe";

/// Content-скрипты каждой вкладки (docs/02 §4): монитор M0 + горячие клавиши
/// таб-бара (задача 1.2) + монитор медиа для спящего режима (задача 2.3) +
/// косметика блокировщика (задача 2.2) + бандл субтитров (задача 3.2).
pub(crate) const CONTENT_INIT_SCRIPT_M0: &str = include_str!("../../content/m0-spike.js");
pub(crate) const CONTENT_INIT_SCRIPT_HOTKEYS: &str =
    include_str!("../../content/chrome-hotkeys.js");
pub(crate) const CONTENT_INIT_SCRIPT_MEDIA: &str = include_str!("../../content/media-watch.js");
pub(crate) const CONTENT_INIT_SCRIPT_COSMETIC: &str = include_str!("../../content/cosmetic.js");
/// Субтитры (M3, задача 3.2): content/*.ts → esbuild-IIFE → content/gen/
/// (npm run build:content, входит в npm run dev/build). Генерат в .gitignore,
/// как dist/: cargo требует его до сборки — fresh clone собирает npm-шагом.
pub(crate) const CONTENT_INIT_SCRIPT_SUBTITLES: &str =
    include_str!("../../content/gen/duopulse-content.js");

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
/// - «video» — детектор <video> нашёл/сменял ключевое видео (content-бандл
///   субтитров, задача 3.2): Core эмитит событие контракта page:video_detected
///   в UI (payload PageVideoDetected — videoKey/canTracks, docs/05 §2) и
///   чистит состояние субтитров вкладки в сервисе (задача 3.7: список/набор
///   прошлого видео не актуальны);
/// - «tracks» — YouTube-адаптер выдал список дорожек видео (задача 3.3):
///   полный список (базовые + переводы) уходит в сервис состояния (3.7) и
///   событием subtitles:tracks_ready — панель наполняет выбор языков;
/// - «set-state» — content-слой сообщил состояние показа (задача 3.7:
///   состав набора, enabled, offset, стиль — источник изменения в via):
///   сервис состояния + событие subtitles:set_applied (кнопка «duo»/панель);
/// - «file-tracks» — файловые дорожки применились к набору (задача 3.6:
///   drag&drop или subtitles.load_file); журнал [subtitles];
/// - «parse-subtitles» — разбор payload дорожки каноническими парсерами
///   src/subtitles (задача 3.1) по запросу content-слоя (задача 3.3):
///   ответ {duopulse:"subtitles-parsed", reqId, ok, cues, warnings} приходит
///   тому же документу PostWebMessageAsString;
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
            } else if parsed["duopulse"] == "video" {
                // Детектор <video> content-бандла субтитров (задача 3.2):
                // проброс в UI событием контракта. Детектор эмитит только по
                // факту (новое видео/смена ключа), повторов не бывает.
                // Задача 3.7: tab_id — кнопка «duo»/панель следят за активной
                // вкладкой; сервис состояния чистит прошлое видео.
                if let (Some(video_key), Some(can_tracks)) = (
                    parsed["videoKey"].as_str(),
                    parsed["canTracks"].as_bool(),
                ) {
                    eprintln!("[subtitles] video detected: {video_key} (tab {tab_id}, canTracks={can_tracks})");
                    let service = app.state::<subtitles::service::SubtitlesService>();
                    service.on_video(&tab_id, video_key, can_tracks);
                    let _ = bridge::emit::<bridge::PageVideoDetected>(
                        &app,
                        &bridge::PageVideoDetected {
                            tab_id: tab_id.clone(),
                            video_key: video_key.to_string(),
                            can_tracks,
                        },
                    );
                }
            } else if parsed["duopulse"] == "tracks" {
                // Полный список дорожек от YouTube-адаптера (задача 3.3) в
                // сервис состояния + событие subtitles:tracks_ready (3.7):
                // панель наполняет выбор языков/переводов.
                if let Some(video_key) = parsed["videoKey"].as_str() {
                    let base = parse_base_tracks(&parsed["base"]);
                    let translations = parse_translation_langs(&parsed["translations"]);
                    eprintln!(
                        "[subtitles] tracks: {video_key} — {} дорожек, {} переводов (путь {}, tab {tab_id})",
                        base.len(),
                        translations.len(),
                        parsed["path"].as_str().unwrap_or("?"),
                    );
                    let service = app.state::<subtitles::service::SubtitlesService>();
                    let st = service.on_tracks(&tab_id, video_key, base, translations);
                    let _ = bridge::emit::<bridge::SubtitlesTracksReadyEvent>(
                        &app,
                        &bridge::SubtitlesTracksReady {
                            tab_id: tab_id.clone(),
                            video_key: video_key.to_string(),
                            base: st.base,
                            translations: st.translations,
                        },
                    );
                }
            } else if parsed["duopulse"] == "set-state" {
                // Состояние показа content-слоя (задача 3.7): сервис состояния
                // + событие subtitles:set_applied — кнопка «duo» (выкл/1/дуо/
                // три) и панель обновляются; via — источник изменения.
                let state = parse_set_state(&parsed);
                let via = parsed["via"].as_str().unwrap_or("?").to_string();
                eprintln!(
                    "[subtitles] set-state: {} — {} дорожек (via {via}, tab {tab_id})",
                    if state.enabled { "вкл" } else { "выкл" },
                    state.tracks.len(),
                );
                let service = app.state::<subtitles::service::SubtitlesService>();
                let st = service.on_set_state(&tab_id, state);
                let _ = bridge::emit::<bridge::SubtitlesSetAppliedEvent>(
                    &app,
                    &bridge::SubtitlesSetApplied {
                        tab_id: tab_id.clone(),
                        video_key: st.video_key.clone(),
                        enabled: st.enabled,
                        tracks: st.tracks.clone(),
                        offset_ms: st.offset_ms,
                        style: st.style.clone(),
                        via,
                    },
                );
            } else if parsed["duopulse"] == "file-tracks" {
                // Файловые дорожки в наборе (задача 3.6): журнал до сервисной
                // обвязки subtitles.* (панель — задача 3.7).
                let applied = parsed["applied"].as_u64().unwrap_or(0);
                let failures = parsed["failures"].as_u64().unwrap_or(0);
                let dropped = parsed["dropped"].as_u64().unwrap_or(0);
                let via = parsed["via"].as_str().unwrap_or("drop");
                eprintln!(
                    "[subtitles] file-tracks: применено {applied}, отказов {failures}, сверх набора {dropped} ({via}, tab {tab_id})"
                );
            } else if parsed["duopulse"] == "parse-subtitles" {
                // Разбор payload дорожки в Core (задача 3.3): канонические
                // парсеры задачи 3.1, формат — автодетект по содержимому.
                if let (Some(req_id), Some(payload)) =
                    (parsed["reqId"].as_u64(), parsed["payload"].as_str())
                {
                    let parsed_cues = if payload.len() > 4 * 1024 * 1024 {
                        eprintln!(
                            "[subtitles] parse reqId={req_id}: payload {} КБ — сверх лимита",
                            payload.len() / 1024
                        );
                        None
                    } else {
                        Some(subtitles::parse_auto(payload))
                    };
                    let reply = match parsed_cues {
                        Some(out) => serde_json::json!({
                            "duopulse": "subtitles-parsed",
                            "reqId": req_id,
                            "ok": true,
                            "cues": out.cues.iter().map(|c| serde_json::json!({
                                "startMs": c.start_ms, "endMs": c.end_ms, "text": c.text,
                            })).collect::<Vec<_>>(),
                            "warnings": out.warnings.iter()
                                .map(|w| format!("строка {}: {}", w.line, w.message))
                                .collect::<Vec<_>>(),
                        }),
                        None => serde_json::json!({
                            "duopulse": "subtitles-parsed",
                            "reqId": req_id,
                            "ok": false,
                            "error": "payload слишком большой",
                        }),
                    };
                    post_to_page(sender.as_ref(), &reply);
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

// --- разбор сообщений content-слоя субтитров (задача 3.7, снисходительно) ---

fn json_str(v: &serde_json::Value, key: &str) -> String {
    v[key].as_str().unwrap_or_default().to_string()
}

fn json_bool(v: &serde_json::Value, key: &str) -> bool {
    v[key].as_bool().unwrap_or(false)
}

fn json_u32(v: &serde_json::Value, key: &str) -> u32 {
    v[key].as_u64().map(|n| n as u32).unwrap_or(0)
}

/// «tracks».base — базовые дорожки адаптера (content BaseTrackInfo).
fn parse_base_tracks(value: &serde_json::Value) -> Vec<subtitles::service::BaseTrackInfo> {
    value
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter(|v| !v["id"].as_str().unwrap_or("").is_empty())
                .map(|v| subtitles::service::BaseTrackInfo {
                    id: json_str(v, "id"),
                    lang: json_str(v, "lang"),
                    kind: json_str(v, "kind"),
                    name: json_str(v, "name"),
                    original: json_bool(v, "original"),
                    translatable: json_bool(v, "translatable"),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// «tracks».translations — языки машинного перевода (tlang).
fn parse_translation_langs(
    value: &serde_json::Value,
) -> Vec<subtitles::service::TranslationLangInfo> {
    value
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter(|v| !v["lang"].as_str().unwrap_or("").is_empty())
                .map(|v| subtitles::service::TranslationLangInfo {
                    lang: json_str(v, "lang"),
                    name: json_str(v, "name"),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// «set-state» — состояние показа вкладки: состав набора, enabled, offset,
/// стиль (клампы остаются за content-слоем; здесь — снисходительный разбор).
fn parse_set_state(value: &serde_json::Value) -> subtitles::service::TabSubtitles {
    let mut st = subtitles::service::TabSubtitles::fresh();
    st.video_key = value["videoKey"].as_str().map(str::to_string);
    st.enabled = value["enabled"].as_bool().unwrap_or(true);
    st.offset_ms = value["offsetMs"].as_i64().unwrap_or(0);
    if let Some(tracks) = value["tracks"].as_array() {
        st.tracks = tracks
            .iter()
            .filter(|t| !t["id"].as_str().unwrap_or("").is_empty())
            .map(|t| subtitles::service::AppliedTrackInfo {
                id: json_str(t, "id"),
                lang: json_str(t, "lang"),
                source: json_str(t, "source"),
                name: json_str(t, "name"),
                role: json_str(t, "role"),
            })
            .collect();
    }
    if let Some(style) = value["style"].as_object() {
        let style = serde_json::Value::Object(style.clone());
        st.style = subtitles::service::SubtitlesStyleInfo {
            font_scale_pct: json_u32(&style, "fontScalePct"),
            position: {
                let p = json_str(&style, "position");
                if p.is_empty() {
                    "bottom".to_string()
                } else {
                    p
                }
            },
            margin_pct: json_u32(&style, "marginPct"),
            plate_opacity: style["plateOpacity"].as_f64().unwrap_or(0.78),
        };
    }
    st
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
    startup_mark("main");
    // IPC-контракт bridge (задача 1.1): все команды/события — src/bridge.rs.
    // Менеджер вкладок (задача 1.2) — состояние Core для tabs.* и nav.*.
    // История и закладки (задача 1.4) — SQLite в профиле (docs/02 §8):
    // duopulse.db, запись визитов — из on_page_load вкладок (src/tabs/).
    // Блокировщик (задача 2.1) — src/adblock/: движок adblock-rs + списки;
    // нити обновления/слива счётчика стартуют в setup (нужен AppHandle).
    // Метрики (задача 2.5): профиль существовал до запуска → тёплый старт
    // (P-02), пустой → холодный (P-01); проверка ДО открытия хранилищ.
    let profile_dir = proxy::profile_dir();
    perf::set_cold(!profile_dir.join("duopulse.db").exists());
    let adblock_service = std::sync::Arc::new(adblock::AdblockService::new(&profile_dir));
    let history_store = history::HistoryStore::open(&profile_dir)
        .expect("открыть/создать duopulse.db в профиле (docs/02 §8)");
    let perf_store = perf::PerfStore::open(&profile_dir)
        .expect("открыть/создать таблицу perf_runs в duopulse.db (задача 2.5)");
    startup_mark("stores-open");
    let adblock_for_setup = std::sync::Arc::clone(&adblock_service);
    bridge::register(tauri::Builder::default())
        .plugin(tauri_plugin_dialog::init())
        .manage(tabs::TabManager::new())
        .manage(history_store)
        .manage(perf_store)
        .manage(adblock_service)
        .manage(subtitles::service::SubtitlesService::new())
        .setup(move |app| {
            startup_mark("setup");
            // Фон блокировщика: обновление списков (кэш → движок → сеть) и
            // батчинг счётчика adblock:blocked_count (задача 2.1).
            adblock_for_setup.start(app.handle());
            // Спящий режим вкладок (задача 2.3): нить авто-усыпления
            // долгих простоев (DUOPULSE_SLEEP_AFTER_SECS=0 — выключена).
            tabs::start_sleeper(app.handle().clone());
            // Прогрев топ-сайтов (задача 2.4, docs/04 §1.4): preconnect/
            // dns-prefetch частых хостов истории при простое UI.
            prefetch::start(app.handle().clone());
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
            startup_mark("window-built");
            let app = app.handle().clone();
            let window: Window<tauri::Wry> =
                app.get_window("main").expect("окно main создано выше");
            // Первая вкладка (стартовый URL / DUOPULSE_START_URL) — задача 1.2;
            // ленивая постановка + материализация по Ready — задача 2.4.
            app.state::<tabs::TabManager>().init(&app)?;
            startup_mark("tab-init");

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
                startup_mark("ready");
                // Метрики старта (задача 2.5): итог main → Ready уходит на
                // страницу «Диагностика» (событие perf:startup_ms + срез
                // perf.snapshot); фазы — в [startup]-логе stderr.
                perf::emit_startup(app);
                // Восстановление сессии (задача 1.6): webview активной вкладки
                // создаётся только когда цикл событий гарантированно качает
                // сообщения (в setup и первые его мгновения — гонка с дедлоком
                // создания webview, см. tabs::init). Задача 2.4: свежий старт
                // идёт тем же путём — первая вкладка тоже ленивая.
                app.state::<tabs::TabManager>()
                    .spawn_restore_materialize(app);
            }
        });
}
