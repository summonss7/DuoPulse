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
// Прокси/роутер (docs/02 §6): WebView2 ПОСТОЯННО направлен на локальный
// SOCKS5-роутер Core (задача 6.1) — аргументы --proxy-server задаются на
// старте и указывают на 127.0.0.1:<port>; режим (direct/upstream) роутер
// меняет на лету, тумблер прокси перезапуска не требует. Креденшалы внешнего
// прокси (задача 1.8) подставляет роутер из DPAPI — обработчик
// BasicAuthenticationRequested больше не нужен. Если роутер не поднялся —
// деградация к поведению инкремента A (внешний прокси напрямую / без прокси).

// schemars schema!-макросы в contract_json (bridge.rs) вложены в один json!:
// с ростом словаря (v2: subtitles.load_file) глубина экспансии превысила
// дефолт макро-рекурсии rustc (128).
#![recursion_limit = "512"]
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod adblock;
mod asr;
mod bridge;
mod chrome_menu;
mod chrome_panel;
mod history;
mod omnibox;
/// Менеджер паролей (этап 1 duopulse-106): passwords.db + ключ под DPAPI.
mod passwords;
mod perf;
mod prefetch;
mod proxy;
mod secrets;
mod settings;
mod subtitles;
mod tabs;
mod translate;
mod translate_menu;
mod updater;
mod vpn;

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
/// косметика блокировщика (задача 2.2) + бандл субтитров (задача 3.2) +
/// трекер SPA-навигации (карточка duopulse-057).
pub(crate) const CONTENT_INIT_SCRIPT_M0: &str = include_str!("../../content/m0-spike.js");
pub(crate) const CONTENT_INIT_SCRIPT_HOTKEYS: &str =
    include_str!("../../content/chrome-hotkeys.js");
pub(crate) const CONTENT_INIT_SCRIPT_URL_WATCH: &str = include_str!("../../content/url-watch.js");
pub(crate) const CONTENT_INIT_SCRIPT_MEDIA: &str = include_str!("../../content/media-watch.js");
pub(crate) const CONTENT_INIT_SCRIPT_COSMETIC: &str = include_str!("../../content/cosmetic.js");
/// Субтитры (M3, задача 3.2): content/*.ts → esbuild-IIFE → content/gen/
/// (npm run build:content, входит в npm run dev/build). Генерат в .gitignore,
/// как dist/: cargo требует его до сборки — fresh clone собирает npm-шагом.
pub(crate) const CONTENT_INIT_SCRIPT_SUBTITLES: &str =
    include_str!("../../content/gen/duopulse-content.js");
/// Кнопка «Пропустить рекламу» на YouTube (карточка duopulse-076): SSAI-преролл
/// вшит в медиапоток — фильтры его не снимают; кнопка — ручная эскалация
/// (seek в конец секции → перезагрузка с &t=, «лотерея SSAI» из карточки 072).
pub(crate) const CONTENT_INIT_SCRIPT_AD_SKIP: &str = include_str!("../../content/ad-skip.js");
/// Закрытие панелей хрома кликом по контенту (карточка duopulse-090): панель —
/// child-webview, клик «мимо» уходит в документ вкладки; репорт сюда.
pub(crate) const CONTENT_INIT_SCRIPT_PANEL_CLOSE: &str =
    include_str!("../../content/panel-close.js");

/// Аргументы окружения WebView2, зафиксированные на старте приложения:
/// каждая новая вкладка наследует их (сменить можно только перезапуском).
/// С роутером (задача 6.1) здесь всегда socks5://127.0.0.1:<port> — режим
/// переключает роутер, аргументы от режима не зависят.
static STARTUP_PROXY_ARGS: OnceLock<String> = OnceLock::new();

/// Порт loopback-эндпоинта ранней косметики (adblock::start_early_endpoint,
/// карточка duopulse-044): 0 — эндпоинта нет, content/cosmetic.js работает
/// только асинхронным путём. Встраивается в init-скрипт косметики до создания
/// первой вкладки.
static EARLY_COSMETIC_PORT: OnceLock<u16> = OnceLock::new();

/// Init-скрипт косметики с портом раннего канала (плейсхолдер заменяется;
/// карточка 044).
pub(crate) fn content_init_script_cosmetic() -> String {
    crate::CONTENT_INIT_SCRIPT_COSMETIC.replace(
        "__DUOPULSE_COSMETIC_PORT__",
        &EARLY_COSMETIC_PORT
            .get()
            .map(|p| p.to_string())
            .unwrap_or_else(|| "0".into()),
    )
}

pub(crate) fn startup_proxy_args() -> &'static str {
    STARTUP_PROXY_ARGS.get().map(String::as_str).unwrap_or("")
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
/// Перезапись тел ответов ($replace, карточка duopulse-050): если запрос
/// проходит блокировку и под него есть replace-правила — обработчик берёт
/// Deferral, снимок запроса уходит в фоновую нить (самофетч через локальный
/// SOCKS5-роутер + замены в теле + CreateWebResourceResponse/SetResponse),
/// UI-поток возвращается сразу. Любой сбой — Deferral завершается без
/// ответа, и WebView2 выполняет свой сетевой запрос (слой перезаписи не
/// может ухудшить поведение страницы относительно своего отсутствия).
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
                return Ok(());
            }
            // Перезапись тела ответа ($replace, карточка duopulse-050): план
            // замен есть — уводим обработку в фон (Deferral), ответ подменяем
            // самофетчем с заменами; сбой — дефолтный сетевой запрос WebView2.
            let ops = app
                .state::<std::sync::Arc<adblock::AdblockService>>()
                .replace_plan(tab_url.as_deref(), &uri, rtype, referer.as_deref());
            if let Some(ops) = ops {
                if let Err(e) =
                    rewrite_response_in_background(&env, &args, &request, &uri, ops, &app)
                {
                    eprintln!("adblock: $replace не начат для {uri}: {e}");
                }
            }
            Ok(())
        })),
        std::ptr::null_mut(),
    )
    .expect("add_WebResourceRequested");
}

/// COM-интерфейсы WebView2 не помечены Send, а Environment ещё и привязан к
/// нити-создателю (0x802A000C «thread that created the object»): обёртка
/// переносит их через границы нитей, а все вызовы методов — только на главном
/// потоке (run_on_main_thread; самофетч живёт в фоновой нити без COM).
/// Доступ — только через `into_inner` (метод на целом значении): точечный
/// захват `env.0` в замыкании обошёл бы обёртку и захватил бы сырой
/// интерфейс.
#[cfg(windows)]
struct SendCom<T>(T);
#[cfg(windows)]
unsafe impl<T> Send for SendCom<T> {}
#[cfg(windows)]
impl<T> SendCom<T> {
    fn into_inner(self) -> T {
        self.0
    }
}

/// Снять с запроса данные для самофетча и отправить перезапись в фоновую
/// нить. Deferral держит событие открытым до SetResponse + Complete. Ошибка —
/// событие уже нельзя «отменить» безопасно: вызывающий только логирует
/// (Deferral ещё не взят, WebView2 продолжит своим сетевым запросом).
#[cfg(windows)]
unsafe fn rewrite_response_in_background(
    env: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment,
    args: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2WebResourceRequestedEventArgs,
    request: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2WebResourceRequest,
    uri: &str,
    ops: Vec<adblock::replace::ReplaceOp>,
    app: &AppHandle,
) -> Result<(), String> {
    let mut method_pw = windows_core::PWSTR::null();
    request
        .Method(&mut method_pw)
        .map_err(|e| format!("Method: {e}"))?;
    let method = webview2_com::CoTaskMemPWSTR::from(method_pw).to_string();

    let headers = request_headers(request).map_err(|e| format!("Headers: {e}"))?;
    let body = match request.Content() {
        Ok(stream) => read_stream(&stream).map_err(|e| format!("Content: {e}"))?,
        Err(_) => None,
    };

    let deferral = args
        .GetDeferral()
        .map_err(|e| format!("GetDeferral: {e}"))?;
    // Complete обязан быть вызван ровно один раз при любом исходе:
    // - нить не поднялась → UI-нить (здесь), клон 1;
    // - run_on_main_thread не принял замыкание → рабочая нить, клон 2
    //   (недостижимо практически; Complete без SetResponse — фолббек
    //   дефолтным сетевым запросом WebView2);
    // - норма → замыкание finish на главном потоке.
    let deferral_spawn_fallback = deferral.clone();
    let deferral_dispatch_fallback = SendCom(deferral.clone());
    let svc = app
        .state::<std::sync::Arc<adblock::AdblockService>>()
        .inner()
        .clone();
    // Самофетч — тем же сетевым путём, что и WebView2 (через локальный
    // SOCKS5-роутер, задача 6.1): IP-адрес сессии согласован с остальным
    // трафиком плеера. Роутера нет — напрямую.
    let socks_port = app
        .try_state::<Option<vpn::router::Router>>()
        .and_then(|r| r.inner().as_ref().map(vpn::router::Router::port));

    let env = SendCom(env.clone());
    let args = SendCom(args.clone());
    let deferral = SendCom(deferral);
    let uri = uri.to_string();
    let app = app.clone();
    // DUOPULSE_REPLACE_DEBUG=1: журнал решений слоя перезаписи (e2e/диагностика)
    let debug = std::env::var("DUOPULSE_REPLACE_DEBUG").is_ok();
    let spawned = std::thread::Builder::new()
        .name("adblock-replace".into())
        .spawn(move || {
            // фоновая нить: только сеть, без COM (Environment привязан к
            // нити-создателю — 0x802A000C)
            let rewritten = adblock::replace::fetch_and_rewrite(
                &method,
                &uri,
                &headers,
                body.as_deref(),
                &ops,
                socks_port,
            );
            // финализация — на главном потоке (нить создания COM-объектов):
            // CreateWebResourceResponse/SetResponse/Complete
            let finish = move |rr: Option<adblock::replace::RewrittenResponse>| {
                let (env, args, deferral) =
                    (env.into_inner(), args.into_inner(), deferral.into_inner());
                if debug {
                    match &rr {
                        Some(rr) => eprintln!(
                            "[replace] {method} {uri} → {} {} (изменён: {}, тело {} Б)",
                            rr.status,
                            rr.reason,
                            rr.changed,
                            rr.body.len()
                        ),
                        None => {
                            eprintln!("[replace] {method} {uri} → самофетч не удался (фолббек)")
                        }
                    }
                }
                if let Some(rr) = rr {
                    if unsafe { set_rewritten_response(&env, &args, &rr) } && rr.changed {
                        svc.note_replaced();
                    }
                    // подмена не удалась (COM) — просто Complete без ответа:
                    // WebView2 сделает сетевой запрос сам
                }
                let _ = deferral.Complete();
            };
            if app.run_on_main_thread(move || finish(rewritten)).is_err() {
                eprintln!(
                    "adblock: $replace: не вернуться на главный поток — фолбэк без перезаписи"
                );
                let _ = deferral_dispatch_fallback.into_inner().Complete();
            }
        });
    if spawned.is_err() {
        let _ = deferral_spawn_fallback.Complete();
    }
    Ok(())
}

/// Заголовки запроса парами (переходят в самофетч как есть, кроме
/// отфильтрованных в fetch_and_rewrite).
#[cfg(windows)]
unsafe fn request_headers(
    request: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2WebResourceRequest,
) -> Result<Vec<(String, String)>, windows_core::Error> {
    let headers = request.Headers()?;
    let it = headers.GetIterator()?;
    let mut out = Vec::new();
    loop {
        let mut has = windows_core::BOOL::default();
        it.HasCurrentHeader(&mut has)?;
        if !has.as_bool() {
            break;
        }
        let mut name = windows_core::PWSTR::null();
        let mut value = windows_core::PWSTR::null();
        it.GetCurrentHeader(&mut name, &mut value)?;
        out.push((
            webview2_com::CoTaskMemPWSTR::from(name).to_string(),
            webview2_com::CoTaskMemPWSTR::from(value).to_string(),
        ));
        let mut next = windows_core::BOOL::default();
        it.MoveNext(&mut next)?;
        if !next.as_bool() {
            break;
        }
    }
    Ok(out)
}

/// Прочитать IStream тела запроса (POST /player — единицы КБ) до конца;
/// None — тела нет/пустое. Потолок — защита от патологических тел.
#[cfg(windows)]
unsafe fn read_stream(
    stream: &windows::Win32::System::Com::IStream,
) -> Result<Option<Vec<u8>>, String> {
    const CAP: usize = 4 * 1024 * 1024;
    let mut out = Vec::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let mut read = 0u32;
        let hr = stream.Read(
            buf.as_mut_ptr() as *mut core::ffi::c_void,
            buf.len() as u32,
            Some(&mut read),
        );
        if hr.is_err() {
            return Err(format!("IStream::Read: {}", hr.0));
        }
        if read == 0 {
            break;
        }
        if out.len() + read as usize > CAP {
            return Err("тело запроса больше потолка".into());
        }
        out.extend_from_slice(&buf[..read as usize]);
    }
    Ok((!out.is_empty()).then_some(out))
}

/// Собрать ответ из переписанного тела и подменить им событие. false —
/// COM-сбой (вызывающий не считает замену сделанной).
#[cfg(windows)]
unsafe fn set_rewritten_response(
    env: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment,
    args: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2WebResourceRequestedEventArgs,
    rr: &adblock::replace::RewrittenResponse,
) -> bool {
    // Заголовки ответа + Content-Length итогового тела (контентные/хоп-
    // заголовки исходного уже отфильтрованы в fetch_and_rewrite)
    let mut headers = String::new();
    for (name, value) in &rr.headers {
        headers.push_str(name);
        headers.push_str(": ");
        headers.push_str(value);
        headers.push_str("\r\n");
    }
    headers.push_str(&format!("Content-Length: {}\r\n", rr.body.len()));
    let stream = windows::Win32::UI::Shell::SHCreateMemStream(Some(&rr.body));
    let Some(stream) = stream else {
        eprintln!("adblock: $replace: SHCreateMemStream не создал поток");
        return false;
    };
    let response = match env.CreateWebResourceResponse(
        &stream,
        rr.status as i32,
        &windows_core::HSTRING::from(rr.reason.as_str()),
        &windows_core::HSTRING::from(headers.as_str()),
    ) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("adblock: $replace: CreateWebResourceResponse: {e}");
            return false;
        }
    };
    match args.SetResponse(&response) {
        Ok(()) => true,
        Err(e) => {
            eprintln!("adblock: $replace: SetResponse: {e}");
            false
        }
    }
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
///   tabs::handle_hotkey, задача 1.2; Ctrl+D — закладка страницы, карточка
///   duopulse-057);
/// - «spa-url» — фактический URL документа после SPA-навигации
///   (content/url-watch.js, карточка duopulse-057): TabManager::on_spa_url
///   актуализирует адрес вкладки (omnibox/история/сессия);
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
/// - «translate-track» — перевод дорожки облаком (задача 4.2, docs/03 §7):
///   content-слой владеет cue дорожек, Core прогоняет конвейер
///   (src/translate/pipeline.rs: батчинг ≤ 2 КБ, контекст пачки, кэш SQLite,
///   событие subtitles:translate_progress) и отвечает document-событием
///   duopulse-translate-track eval'ом активной вкладки;
/// - «translate-selection» — смена языка в баббле перевода выделения
///   (карточка duopulse-098): текст — эхом из меню, gtx-конвейер —
///   translate_menu::translate_selection_for_page, ответ — WebMessage
///   «translate-selection-result» тому же документу;
/// - «asr-begin» — распознавание речи (карточка duopulse-060): content-слой
///   добыл URL аудио в контексте страницы (адаптер YouTube / src видео),
///   Core скачивает его тем же сетевым путём (SOCKS5-роутер), декодирует,
///   транскрибирует (локальный whisper-server / OpenAI-совместимое облако,
///   src/asr/pipeline.rs), кэширует и отвечает document-событием
///   duopulse-asr-track; прогресс — событие subtitles:asr_progress;
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
            if parsed["duopulse"] == "close-panel" {
                // клик по контенту страницы: выпадающая панель хрома — мимо
                chrome_panel::on_content_close_message(&app);
            } else if parsed["duopulse"] == "hotkey" {
                if let Some(key) = parsed["key"].as_str() {
                    app.state::<tabs::TabManager>().handle_hotkey(&app, key);
                }
            } else if parsed["duopulse"] == "spa-url" {
                // SPA-навигация документа (карточка duopulse-057):
                // pushState/replaceState/popstate из content/url-watch.js —
                // загрузки документа нет, адрес вкладки Core актуализирует
                // здесь (omnibox, история, сессия).
                if let Some(url) = parsed["url"].as_str() {
                    app.state::<tabs::TabManager>().on_spa_url(&app, &tab_id, url);
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
            } else if parsed["duopulse"] == "font-request" {
                // Гарнитура субтитров (карточка duopulse-068): контент-оверлей
                // живёт в контексте страницы, где фирменные @font-face не
                // загружены (CSP) — Core отдаёт woff2-сабсеты гарнитуры base64,
                // контент регистрирует их FontFace'ами из ArrayBuffer (без
                // сетевой загрузки — CSP не подчинён). Один запрос на гарнитуру
                // на вкладку: контент кеширует по имени.
                if let Some(family) = parsed["family"].as_str() {
                    let faces = subtitles::fonts::family_faces(family);
                    let reply = if faces.is_empty() {
                        serde_json::json!({
                            "duopulse": "font-data",
                            "family": family,
                            "ok": false,
                            "error": "гарнитура не требует доставки",
                        })
                    } else {
                        serde_json::json!({
                            "duopulse": "font-data",
                            "family": family,
                            "ok": true,
                            "faces": faces.iter().map(|f| serde_json::json!({
                                "weight": f.weight,
                                "unicodeRange": f.unicode_range,
                                "data": subtitles::fonts::base64(f.data),
                            })).collect::<Vec<_>>(),
                        })
                    };
                    post_to_page(sender.as_ref(), &reply);
                }
            } else if parsed["duopulse"] == "translate-track" {
                // Перевод дорожки облаком (задача 4.2): cues — у content-слоя,
                // конвейер (кэш → пачки → провайдер → кэш) — src/translate/.
                // Обработчик сразу уходит в spawn_blocking ( COM-поток не
                // блокируем), прогресс — событием subtitles:translate_progress.
                translate::handle_translate_request(&app, &tab_id, &parsed);
            } else if parsed["duopulse"] == "translate-selection" {
                // Смена языка в баббле перевода выделения (карточка
                // duopulse-098): текст — из меню (эхом), конвейер — тот же
                // gtx-перевод; ответ — WebMessage тому же документу.
                if let (Some(text), Some(target)) =
                    (parsed["text"].as_str(), parsed["target"].as_str())
                {
                    // выбранный в баббле язык — подпись пункта меню в след. раз
                    translate_menu::note_selection_target(target);
                    handle_selection_translate(
                        &app,
                        sender.as_ref(),
                        text,
                        target,
                        parsed["reqId"].as_u64().unwrap_or(0),
                    );
                }
            } else if parsed["duopulse"] == "asr-begin" {
                // Распознавание речи (карточка duopulse-060): URL аудио — у
                // content-слоя, конвейер (самофетч → декод → чанки → движок →
                // кэш) — src/asr/pipeline.rs; обработчик сразу уходит в
                // spawn_blocking, прогресс — subtitles:asr_progress.
                asr::pipeline::handle_asr_begin(&app, &tab_id, &parsed);
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

/// Смена языка перевода выделения (баббл, карточка duopulse-098): фоновый
/// перевод тем же gtx-конвейером, ответ — документу вкладки (COM-перенос и
/// сборка ответа — translate_menu::translate_selection_for_page).
#[cfg(windows)]
fn handle_selection_translate(
    app: &AppHandle,
    core: Option<&webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2>,
    text: &str,
    target: &str,
    req_id: u64,
) {
    if let Some(core) = core {
        translate_menu::translate_selection_for_page(app, core, text, target, req_id);
    }
}

/// Ответ документу вкладки (WebMessage-канал задачи 2.2): PostWebMessageAsString
/// доставляет строку в window.chrome.webview «message» top-level документа.
#[cfg(windows)]
pub(crate) fn post_to_page(
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
        let defaults = subtitles::service::SubtitlesStyleInfo::default();
        st.style = subtitles::service::SubtitlesStyleInfo {
            font_scale_pct: json_u32(&style, "fontScalePct"),
            // Гарнитура (карточка 068): старые бандлы поле не шлют — дефолт
            // Inter; неизвестное значение тоже молча дефолтится.
            font_family: {
                let f = json_str(&style, "fontFamily");
                if subtitles::fonts::is_valid_family(&f) {
                    f
                } else {
                    defaults.font_family
                }
            },
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
            // Цвета/обводка (карточка 059): старые бандлы их не шлют — дефолты;
            // канонизацию делает content-слой, здесь — снисходительный разбор.
            original_color: json_str(&style, "originalColor"),
            translation_color: {
                let c = json_str(&style, "translationColor");
                if c.is_empty() {
                    defaults.translation_color
                } else {
                    c
                }
            },
            muted_color: {
                let c = json_str(&style, "mutedColor");
                if c.is_empty() {
                    defaults.muted_color
                } else {
                    c
                }
            },
            plate_color: {
                let c = json_str(&style, "plateColor");
                if c.is_empty() {
                    defaults.plate_color
                } else {
                    c
                }
            },
            text_stroke: style["textStroke"].as_bool().unwrap_or(true),
        };
        if st.style.original_color.is_empty() {
            st.style.original_color = defaults.original_color;
        }
    }
    st
}

/// Полный набор COM-обработчиков для каждой вкладки: сетевой перехват M0 +
/// блокировщик (задача 2.1), аутентификация прокси (1.8), сообщения content
/// (горячие клавиши, 1.2), разогрев косметики (карточка 044). tab_id — вкладка-
/// владелец: её URL — запасной источник запроса для движка.
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
    install_content_messaging(&core, app, tab_id);
    translate_menu::install_translate_menu(&core, &env, app);
    install_new_window_handler(&core, app, tab_id);
    install_cosmetic_prewarm(&core, app, tab_id);
    install_nav_failure_watcher(&core, app, tab_id);
    install_fullscreen_watcher(&core, app, tab_id);
}

/// Страница ошибки загрузки (карточка duopulse-048): NavigationCompleted без
/// успеха отдаётся TabManager::on_nav_failed — вкладка превращается в
/// duopulse://error с адресом, причиной и действием «этот сайт — через
/// туннель». Отменённые навигации (WebErrorStatus OPERATION_CANCELED — Esc,
/// перебита новой) и внутренние страницы отфильтровывает TabManager (у него
/// состояние вкладки). Вызывается после подписки wry на то же событие —
/// on_page_load(Finished) успевает актуализировать URL вкладки.
#[cfg(windows)]
unsafe fn install_nav_failure_watcher(core: &ICoreWebView2, app: &AppHandle, tab_id: &str) {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN,
        NavigationCompletedEventHandler,
    };
    use windows_core::BOOL;

    let app = app.clone();
    let tab_id = tab_id.to_string();
    let res = core.add_NavigationCompleted(
        &NavigationCompletedEventHandler::create(Box::new(move |_sender, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let mut ok = BOOL::default();
            if args.IsSuccess(&mut ok).is_err() || ok.as_bool() {
                return Ok(());
            }
            let mut status = COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN;
            if args.WebErrorStatus(&mut status).is_err() {
                return Ok(());
            }
            app.state::<tabs::TabManager>()
                .on_nav_failed(&app, &tab_id, status.0);
            Ok(())
        })),
        std::ptr::null_mut(),
    );
    if let Err(e) = res {
        eprintln!("error-page: NavigationCompleted не установлен: {e}");
    }
}

/// «Открыть в новой вкладке» (карточка duopulse-057): target=_blank, средняя
/// кнопка и пункт контекстного меню WebView2 поднимают NewWindowRequested —
/// без обработчика запрос попросту умирает (popup-окон у WebView2 нет).
/// Любой http(s)-запрос становится новой вкладкой DuoPulse (Handled=true,
/// создание webview — async-задачей: round-trip создания нельзя делать на
/// потоке цикла событий, см. tabs::open); прочие схемы (about:blank и т.п.)
/// блокируются. Попап-фильтра по IsUserInitiated нет: в живом рантайме
/// (пробы карточки 057) WebView2 сообщает true даже скриптовому window.open
/// при загрузке страницы — фильтр бы только дал ложные блокировки.
/// Вкладка открывается в ФОНЕ, без перехода на неё (карточка duopulse-088:
/// «открыть ссылку в новом окне» не должно переключать на новое окно —
/// активной остаётся текущая, см. tabs::open_background).
#[cfg(windows)]
unsafe fn install_new_window_handler(core: &ICoreWebView2, app: &AppHandle, tab_id: &str) {
    use webview2_com::NewWindowRequestedEventHandler;
    use windows_core::PWSTR;

    let app = app.clone();
    let tab_id = tab_id.to_string();
    let res = core.add_NewWindowRequested(
        &NewWindowRequestedEventHandler::create(Box::new(move |_sender, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let mut uri_pw = PWSTR::null();
            args.Uri(&mut uri_pw)?;
            let uri = webview2_com::CoTaskMemPWSTR::from(uri_pw).to_string();
            // любое окно закрываем сами: popup-окно WebView2 не создаём
            args.SetHandled(true)?;
            if !(uri.starts_with("http://") || uri.starts_with("https://")) {
                return Ok(()); // чужая схема — блокировано
            }
            let app = app.clone();
            let tab_id = tab_id.clone();
            tauri::async_runtime::spawn(async move {
                let manager = app.state::<tabs::TabManager>();
                // ссылка из инкогнито-вкладки открывается инкогнито (096)
                let incognito = manager.is_incognito(&tab_id);
                if let Err(e) = manager.open_background(&app, uri.clone(), incognito) {
                    eprintln!("tabs: new-window не открыл {uri}: {e}");
                }
            });
            Ok(())
        })),
        std::ptr::null_mut(),
    );
    if let Err(e) = res {
        eprintln!("tabs: NewWindowRequested не установлен: {e}");
    }
}

/// Разогрев кэша косметических ресурсов на NavigationStarting (карточка
/// duopulse-044): ранний синхронный канал (content/cosmetic.js →
/// adblock::start_early_endpoint) блокирующе ждёт ресурсы на document-start;
/// холодный расчёт `url_cosmetic_resources` по EasyList+uBO — 0,2–0,9 с, и без
/// разогрева код скриптлетов приходит после того, как инлайн-скрипты страницы
/// прочли свои глобалы (на YouTube — проходит SSAI-реклама). Событие стреляет
/// до сетевого запроса документа — расчёт идёт параллельно загрузке, к
/// document-start кэш тёплый; расчёт в фоновой нити (движок потокобезопасен,
/// обработчик — на UI-потоке). Стартовый URL вкладки разгоняем сразу: его
/// NavigationStarting может опередить установку обработчика.
#[cfg(windows)]
unsafe fn install_cosmetic_prewarm(core: &ICoreWebView2, app: &AppHandle, tab_id: &str) {
    use webview2_com::NavigationStartingEventHandler;
    use windows_core::PWSTR;

    fn prewarm_async(app: &AppHandle, url: String) {
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return;
        }
        let svc = app
            .state::<std::sync::Arc<adblock::AdblockService>>()
            .inner()
            .clone();
        std::thread::spawn(move || svc.prewarm(&url));
    }

    if let Some(start) = app.state::<tabs::TabManager>().url_of(tab_id) {
        prewarm_async(app, start);
    }

    let app_for_nav = app.clone();
    let res = core.add_NavigationStarting(
        &NavigationStartingEventHandler::create(Box::new(move |_sender, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let mut uri = PWSTR::null();
            args.Uri(&mut uri)?;
            prewarm_async(
                &app_for_nav,
                webview2_com::CoTaskMemPWSTR::from(uri).to_string(),
            );
            Ok(())
        })),
        std::ptr::null_mut(),
    );
    if let Err(e) = res {
        eprintln!("cosmetic-prewarm: NavigationStarting не установлен: {e}");
    }
}

/// HTML-fullscreen во вкладке (карточка duopulse-062): WebView2 сообщает
/// ContainsFullScreenElementChanged, TabManager::on_fullscreen уводит окно
/// в borderless-fullscreen и растягивает webview вкладки на всё окно —
/// развёрнутое видео занимает весь экран без рамок и полосы хрома.
/// (tauri-runtime-wry по этому же событию переключает fullscreen самого
/// окна, но webview вкладки остаётся под полосой хрома — геометрией
/// владеет TabManager.)
#[cfg(windows)]
unsafe fn install_fullscreen_watcher(core: &ICoreWebView2, app: &AppHandle, tab_id: &str) {
    use webview2_com::ContainsFullScreenElementChangedEventHandler;
    use windows_core::BOOL;

    let app = app.clone();
    let tab_id = tab_id.to_string();
    let res = core.add_ContainsFullScreenElementChanged(
        &ContainsFullScreenElementChangedEventHandler::create(Box::new(move |sender, _args| {
            let Some(sender) = sender else {
                return Ok(());
            };
            let mut contains = BOOL::default();
            if sender.ContainsFullScreenElement(&mut contains).is_err() {
                return Ok(());
            }
            app.state::<tabs::TabManager>()
                .on_fullscreen(&app, &tab_id, contains.as_bool());
            Ok(())
        })),
        std::ptr::null_mut(),
    );
    if let Err(e) = res {
        eprintln!("fullscreen: ContainsFullScreenElementChanged не установлен: {e}");
    }
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
    // Данные инкогнито-среды прошлого запуска (карточка duopulse-096):
    // папка во %TEMP% могла остаться после креша/убийства процесса — чистим
    // до создания любых webview (среда реюзает папку по имени).
    tabs::clean_incognito_data();
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
    // Миграции settings.json (задача 5.1): до открытия хранилищ и чтения
    // конфигов — все разделы видят актуальную схему.
    let migrated_from = settings::migrate(&profile_dir);
    if migrated_from < settings::SETTINGS_SCHEMA_VERSION {
        eprintln!(
            "[settings] settings.json мигрирован: v{migrated_from} → v{}",
            settings::SETTINGS_SCHEMA_VERSION
        );
    }
    let adblock_service = std::sync::Arc::new(adblock::AdblockService::new(&profile_dir));
    let history_store = history::HistoryStore::open(&profile_dir)
        .expect("открыть/создать duopulse.db в профиле (docs/02 §8)");
    // Локальный менеджер паролей (этап 1 duopulse-106): passwords.db в профиле,
    // username/password — только AES-256-GCM, ключ в passwords.key под DPAPI.
    let password_store = passwords::PasswordStore::open(&profile_dir)
        .expect("открыть/создать passwords.db и ключ DPAPI в профиле");
    let perf_store = perf::PerfStore::open(&profile_dir)
        .expect("открыть/создать таблицу perf_runs в duopulse.db (задача 2.5)");
    // Кэш переведённых дорожек (задача 4.2, docs/03 §7): та же duopulse.db,
    // таблица translated_tracks — повторный просмотр без сети (DoD 4.2).
    let translations_cache = std::sync::Arc::new(
        subtitles::cache::TranslationsCache::open(&profile_dir)
            .expect("открыть/создать таблицу translated_tracks в duopulse.db"),
    );
    // Очередь переводов в работе (задача 4.3): дедуп запросов по ключу и
    // офлайн-цикл автоповтора (watcher.rs, docs/01 §5.4).
    let translation_jobs = std::sync::Arc::new(translate::watcher::TranslationJobs::default());
    // Кэш ASR-дорожек (карточка duopulse-060): та же duopulse.db, таблица
    // asr_tracks — повторный просмотр видео без скачивания аудио; поколения
    // задач ASR — отмена конвейера при новом запросе/уходе с видео.
    let asr_cache = asr::cache::AsrCache::open(&profile_dir)
        .expect("открыть/создать таблицу asr_tracks в duopulse.db");
    let asr_jobs = std::sync::Arc::new(asr::pipeline::AsrJobs::default());
    // Split-правила и vpn-режим (задача 6.3, docs/02 §6.2): vpn/split-rules.json,
    // общий стор IPC ↔ роутер — правки действуют на новые соединения сразу.
    let rules_store = vpn::rules::RuleStore::load(&profile_dir);
    // Локальный SOCKS5-роутер (задача 6.1, docs/02 §6.1): WebView2 постоянно
    // направлен на 127.0.0.1:<port>, режим (direct/upstream/split) переключается
    // на лету — перезапуск для смены прокси больше не нужен. Не поднялся —
    // деградация к поведению инкремента A (аргументы по конфигу напрямую).
    let router = match vpn::router::Router::start() {
        Ok(router) => {
            router.apply_config(&proxy::load_config(&profile_dir), &profile_dir);
            Some(router)
        }
        Err(e) => {
            eprintln!(
                "[vpn] SOCKS5-роутер не поднялся: {e} — трафик по старой схеме, прокси без роутера"
            );
            None
        }
    };
    let router_port = router.as_ref().map(vpn::router::Router::port);
    startup_mark("stores-open");
    let adblock_for_setup = std::sync::Arc::clone(&adblock_service);
    bridge::register(tauri::Builder::default())
        .on_menu_event(|app, event| {
            chrome_menu::emit_action(app, &event.id.0);
        })
        .plugin(tauri_plugin_dialog::init())
        // Автообновление (задача 5.2): конфиг plugins.updater (pubkey/фид) и
        // состояние UpdaterExt::updater_builder — драйвится из src/updater.rs.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(tabs::TabManager::new())
        .manage(history_store)
        .manage(password_store)
        .manage(perf_store)
        .manage(adblock_service)
        .manage(subtitles::service::SubtitlesService::new())
        .manage(translations_cache)
        .manage(translation_jobs)
        .manage(asr_cache)
        .manage(asr_jobs)
        .manage(updater::UpdaterService::new())
        .manage(router)
        .manage(rules_store)
        .setup(move |app| {
            startup_mark("setup");
            // Фон блокировщика: обновление списков (кэш → движок → сеть) и
            // батчинг счётчика adblock:blocked_count (задача 2.1).
            adblock_for_setup.start(app.handle());
            // Ранний синхронный канал косметики (карточка duopulse-044):
            // до создания вкладок — порт вшивается в init-скрипт косметики.
            if let Some(port) = adblock_for_setup.start_early_endpoint() {
                let _ = EARLY_COSMETIC_PORT.set(port);
            }
            // Спящий режим вкладок (задача 2.3): нить авто-усыпления
            // долгих простоев (DUOPULSE_SLEEP_AFTER_SECS=0 — выключена).
            tabs::start_sleeper(app.handle().clone());
            // Прогрев топ-сайтов (задача 2.4, docs/04 §1.4): preconnect/
            // dns-prefetch частых хостов истории при простое UI.
            prefetch::start(app.handle().clone());
            // Аргументы WebView2 задаются только на старте (docs/02 §6.1).
            // С роутером (задача 6.1) — ПОСТОЯННО socks5://127.0.0.1:<port>,
            // от режима не зависят; фолбэк без роутера — поведение инкремента
            // A (внешний прокси напрямую / без прокси). Фиксируем для всех
            // будущих вкладок (STARTUP_PROXY_ARGS).
            let mut proxy_args = match router_port {
                Some(port) => proxy::router_browser_args(port),
                None => proxy::browser_args(Some(&proxy::load_config(&proxy::profile_dir()))),
            };
            // CDP e2e-стендов (задача 6.6): WebView2 Runtime ≥150 игнорирует
            // WEBVIEW2_*-переменные окружения в elevated-процессах (шаги
            // GitHub Actions — администратор; WebView2Feedback #5645), поэтому
            // порт прокидываем аргументом через API — его elevated не режет.
            if let Some(port) = std::env::var("DUOPULSE_CDP_PORT")
                .ok()
                .and_then(|v| v.trim().parse::<u16>().ok())
                .filter(|p| *p > 0)
            {
                proxy_args.push_str(&format!(" --remote-debugging-port={port}"));
            }
            STARTUP_PROXY_ARGS
                .set(proxy_args.clone())
                .expect("STARTUP_PROXY_ARGS инициализируется один раз");

            // Туннель WireGuard (задача 6.2): активный профиль wg-profiles.json
            // поднимается на старте в сохранённом vpn-режиме (задача 6.3:
            // global — весь трафик в туннель, split — только правила «tunnel»,
            // off — не поднимается; события vpn:state_changed — из
            // bridge::apply_wg_saved).
            bridge::apply_wg_saved(app.handle());

            // События маршрутных решений (задача 6.5, vpn:route_changed):
            // роутер сообщает первый маршрут домена и его смену — панель VPN
            // видит, как split-правила ложатся на живые соединения.
            if let Some(router) = app.try_state::<Option<vpn::router::Router>>() {
                if let Some(router) = router.inner().as_ref() {
                    let app_for_events = app.handle().clone();
                    router.set_event_sink(std::sync::Arc::new(move |domain, route| {
                        let _ = bridge::emit::<bridge::VpnRouteChangedEvent>(
                            &app_for_events,
                            &bridge::VpnRouteChanged {
                                domain: domain.to_string(),
                                route: route.to_string(),
                            },
                        );
                    }));
                }
            }

            // Окно создаётся кодом (не из tauri.conf.json), чтобы подставить
            // аргументы: UI-webview и дочерние webview вкладок делят одно
            // окружение WebView2 — прокси действует на все (localhost обходит).
            // Заголовок с версией и датой/временем сборки (карточки
            // duopulse-062, duopulse-078): версия — из tauri.conf.json
            // (package_info), единственный источник для release.mjs и фидов
            // обновлений; момент сборки — build.rs (DUOPULSE_BUILD_UNIX).
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title(window_title(
                &app.package_info().version.to_string(),
                build_unix_stamp(),
            ))
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
            // Сдвиг/ресайз main закрывает панель-окно хрома (duopulse-090):
            // якорь панели у кнопки устаревает.
            window.on_window_event(move |event| {
                if let WindowEvent::Resized(_) = event {
                    chrome_panel::close_on_main_geometry_change(&app);
                    app.state::<tabs::TabManager>().relayout(&app);
                }
                if let WindowEvent::Moved(_) = event {
                    chrome_panel::close_on_main_geometry_change(&app);
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("ошибка сборки DuoPulse")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                // Локальный whisper-server ASR (карточка duopulse-060): гасим
                // дочерний процесс, чтобы не остался висеть после выхода.
                asr::server::global().shutdown();
                // Сохранение сессии при выходе (задача 1.6): при закрытии окна
                // (ExitRequested) и на финальном Exit (в т.ч. после app.restart).
                // Запись идемпотентна — менеджер вкладок в момент выхода ещё жив,
                // состояние списка не меняется между событиями.
                app.state::<tabs::TabManager>().persist_session();
                // Приватность (задача 5.1): очищать историю при выходе —
                // настройка privacy.clearHistoryOnExit; вся история (диапазон
                // до «будущего»), закладки не трогаются (как на странице
                // управления). app.restart тоже проходит здесь — после
                // перезапуска для применения прокси история будет чиста.
                if settings::load_privacy(&proxy::profile_dir()).clear_history_on_exit {
                    let far = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as i64 + 86_400_000)
                        .unwrap_or(i64::MAX / 4);
                    if let Err(e) = app.state::<history::HistoryStore>().delete_range(0, far) {
                        eprintln!("[settings] очистка истории при выходе: {e}");
                    }
                }
                // Инкогнито (карточка duopulse-096): данные изолированной
                // среды WebView2 (куки/кэш приватных вкладок) не должны
                // пережить выход — добиваем best effort (занятые файлы
                // дочистит следующий старт, чистка в main()).
                tabs::clean_incognito_data();
            }
            if let tauri::RunEvent::Ready = event {
                startup_mark("ready");
                // Метрики старта (задача 2.5): итог main → Ready уходит на
                // страницу «Диагностика» (событие perf:startup_ms + срез
                // perf.snapshot); фазы — в [startup]-логе stderr.
                perf::emit_startup(app);
                // Автопроверка обновлений (задача 5.2): тихая, отложена на
                // 20 с — не мешает метрикам старта; найденное обновление
                // ждёт решения на странице «Настройки» (установка — руками).
                // Отказы (фид ещё не поднят) — только журнал.
                let updater_app = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(20));
                    let service = updater_app.state::<updater::UpdaterService>();
                    tauri::async_runtime::block_on(updater::auto_check_if_enabled(
                        &updater_app,
                        &service,
                    ));
                });
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

/// Момент сборки из build.rs (DUOPULSE_BUILD_UNIX); 0 — момент неизвестен
/// (ранний кэш без скрипта). Отдельно от window_title для лёгких тестов.
fn build_unix_stamp() -> u64 {
    env!("DUOPULSE_BUILD_UNIX").parse::<u64>().unwrap_or(0)
}

/// Заголовок главного окна: «DuoPulse 0.1.6 · 07.11.2026 14:32» — версия
/// + локальные дата/время сборки (карточка duopulse-078; до этого версия
/// дублировалась бейджем в навбаре от CARGO_PKG_VERSION и отставала на
/// релиз, если Cargo.toml забыли поднять). Без момента сборки — только
/// версия.
fn window_title(version: &str, build_unix: u64) -> String {
    // 0 — момент неизвестен (build.rs не сработал/раный кэш): без штампа
    let stamp = (build_unix > 0)
        .then(|| chrono::DateTime::from_timestamp(build_unix as i64, 0))
        .flatten()
        .map(|dt| {
            dt.with_timezone(&chrono::Local)
                .format("%d.%m.%Y %H:%M")
                .to_string()
        });
    match stamp {
        Some(s) => format!("DuoPulse {version} · {s}"),
        None => format!("DuoPulse {version}"),
    }
}

#[cfg(test)]
mod tests {
    use super::{build_unix_stamp, window_title};
    use chrono::TimeZone;

    #[test]
    fn title_with_build_stamp() {
        // Дата/время зависят от зоны — проверяем форму, а не точные цифры.
        assert_eq!(
            window_title("0.1.6", 1_762_300_000),
            format!(
                "DuoPulse 0.1.6 · {}",
                chrono::Local
                    .timestamp_opt(1_762_300_000, 0)
                    .unwrap()
                    .format("%d.%m.%Y %H:%M")
            )
        );
    }

    #[test]
    fn title_without_build_stamp() {
        assert_eq!(window_title("0.1.6", 0), "DuoPulse 0.1.6");
    }

    #[test]
    fn build_stamp_parses_env() {
        // build.rs всегда кладёт число — парсинг не должен молча давать 0
        assert!(build_unix_stamp() > 0);
    }
}
