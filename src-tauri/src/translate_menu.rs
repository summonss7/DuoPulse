//! Пункт «Перевести выделение» в нативном контекстном меню страницы
//! (карточка duopulse-098).
//!
//! WebView2 умеет кастомизировать штатное меню правой кнопки (ICoreWebView2_
//! 20::add_ContextMenuRequested): в обработчике можно менять коллекцию
//! MenuItems и НЕ ставить Handled — покажется стандартное меню (назад/
//! копировать/…) с нашими добавками сверху, как у расширений переводчика в
//! Chrome. Кастомные пункты в WebView2 плоские — подменю языков API не даёт
//! (KIND_SUBMENU только для нативных пунктов), поэтому один пункт «Перевести
//! выделение (на <языки> / <источник> → <языки>)» ведёт на последний выбор
//! бабла, а полный набор — селекты/чипы в самом бабле перевода (паттерн меню
//! Chrome «Translate selection to …»; источник и несколько целей — карточка
//! duopulse-116).
//!
//! При непустом выделении (ContextMenuTarget::SelectionText) сверху меню
//! добавляются пункт и разделитель; клик — CustomItemSelected: Core шлёт
//! странице WebMessage «translate-selection-begin» (бабл «Переводим…» у
//! выделения), переводит фрагмент в фоне (src/translate/selection.rs,
//! бесплатный gtx-эндпоинт, движок с кэшем и кулдауном 429) на каждый
//! целевой язык и возвращает «translate-selection-result» с массивом
//! результатов. Смена языков в бабле — WebMessage «translate-selection» в
//! main.rs, тот же конвейер; выбор запоминается и показывается в подписи.
//!
//! Пустое выделение — меню не трогаем вовсе (штатное поведение). Бабл живёт
//! в контексте страницы (content/translate-select.ts) — рендерится поверх
//! контента композитором вкладки, слои WebView2 (карточка duopulse-086) не
//! участвуют.
//!
//! Перевод ВСЕЙ страницы (карточка duopulse-244, «как в Chrome»): пункт
//! «Перевести страницу (на <цель>)» добавляется всегда — над пунктом
//! выделения. Клик шлёт WebMessage «translate-page» {reqId, target}
//! (start_page_translate): контент-слой (content/page-translate.ts) сам
//! собирает текстовые узлы и водит пачки бесплатным gtx общим конвейером
//! «gtx-translate» (yt_fallback), Core сетью тут не занимается. Цель —
//! память last_page_target (WebMessage «translate-page-set-target» из бара
//! контента; дефолт ru). Второй вход — «⋮»-меню (bridge translate.page_begin,
//! document-событие duopulse-translate-page в активную вкладку).

#![cfg(windows)]

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use tauri::AppHandle;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2ContextMenuRequestedEventArgs, ICoreWebView2Environment,
};
use webview2_com::{ContextMenuRequestedEventHandler, CustomItemSelectedEventHandler};

use crate::translate::selection::{selection_menu_label, norm_targets, SelectionEngine};

/// Счётчик запросов перевода выделения: reqId корреляции begin/result и
/// ответов на смену языков в баббле (content различает свежий/устаревший).
static SELECTION_REQ: AtomicU64 = AtomicU64::new(1);

/// Счётчик запросов перевода страницы (duopulse-244): reqId begin-сообщений
/// контент-слою (пачки он водит сам через «gtx-translate»).
static PAGE_REQ: AtomicU64 = AtomicU64::new(1);

/// Последний выбор бабла перевода (сессия): источник («» — авто) и целевые
/// языки (дефолт [«ru»]) — подпись пункта меню ведёт на них.
static LAST_LANGS: Mutex<(String, Vec<String>)> = Mutex::new((String::new(), Vec::new()));

/// Последняя цель перевода страницы (карточка duopulse-244): выбор селекта
/// бара контента; подпись пункта меню и дефолт bridge-команды «⋮»-меню.
static LAST_PAGE_TARGET: Mutex<String> = Mutex::new(String::new());

/// Текущая цель перевода страницы («ru», пока не выбирали другое).
pub(crate) fn last_page_target() -> String {
    let guard = LAST_PAGE_TARGET.lock().unwrap();
    if guard.is_empty() {
        "ru".into()
    } else {
        guard.clone()
    }
}

/// Запомнить цель перевода страницы (WebMessage «translate-page-set-target»
/// из бара контент-слоя, main.rs).
pub(crate) fn note_page_target(target: &str) {
    let t = target.trim().to_ascii_lowercase();
    if t.is_empty() {
        return;
    }
    *LAST_PAGE_TARGET.lock().unwrap() = t;
}

/// Движок gtx-перевода выделений: кэш фрагментов + кулдаун 429 — один на
/// приложение, состояние переживает вкладки (лимит общий на IP).
static ENGINE: OnceLock<SelectionEngine> = OnceLock::new();

fn engine() -> &'static SelectionEngine {
    ENGINE.get_or_init(SelectionEngine::new)
}

/// Текущие источник и цели пункта меню (или дефолт: авто → ru).
fn last_langs() -> (String, Vec<String>) {
    let guard = LAST_LANGS.lock().unwrap();
    if guard.1.is_empty() {
        ("auto".into(), vec!["ru".into()])
    } else {
        guard.clone()
    }
}

/// Запомнить выбор бабла (подпись пункта меню в следующий раз); пустой
/// список целей не запоминаем — меню без языка не бывает.
pub(crate) fn note_selection_langs(source: &str, targets: &[String]) {
    let targets = norm_targets(targets);
    if targets.is_empty() {
        return;
    }
    *LAST_LANGS.lock().unwrap() = (source.trim().to_ascii_lowercase(), targets);
}

/// COM-указатель через границы потоков: объект STA, используется только на
/// главном потоке (run_on_main_thread), перенос — держатель ссылки.
struct SendCom<T>(T);
unsafe impl<T> Send for SendCom<T> {}

impl<T> SendCom<T> {
    fn take(self) -> T {
        self.0
    }
}

/// Подписка на ContextMenuRequested вкладки (install_content_handlers).
pub(crate) unsafe fn install_translate_menu(
    core: &ICoreWebView2,
    env: &ICoreWebView2Environment,
    app: &AppHandle,
) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_20;
    use windows_core::Interface;
    let Ok(core20) = core.cast::<ICoreWebView2_20>() else {
        eprintln!(
            "[translate] ContextMenuRequested не поддержан средой — меню перевода недоступно"
        );
        return;
    };
    let core = core.clone();
    let env = env.clone();
    let app = app.clone();
    let res = core20.add_ContextMenuRequested(
        &ContextMenuRequestedEventHandler::create(Box::new(move |_sender, args| {
            if let Some(args) = args {
                unsafe { add_menu_item(&core, &env, &app, &args) };
            }
            Ok(())
        })),
        std::ptr::null_mut(),
    );
    if let Err(e) = res {
        eprintln!("[translate] подписка на контекстное меню: {e}");
    }
}

/// Добавить «Перевести страницу» (всегда, duopulse-244) и «Перевести
/// выделение» (при непустом выделении) в контекстное меню.
/// Ошибки глотаем с журналом — страница не должна страдать.
unsafe fn add_menu_item(
    core: &ICoreWebView2,
    env: &ICoreWebView2Environment,
    app: &AppHandle,
    args: &ICoreWebView2ContextMenuRequestedEventArgs,
) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment9, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND,
    };
    use windows_core::{Interface, HSTRING, PWSTR};

    // выделение может быть пустым — пункт страницы добавляется и тогда
    let selection = args
        .ContextMenuTarget()
        .ok()
        .and_then(|target| {
            let mut sel_pw = PWSTR::null();
            target.SelectionText(&mut sel_pw).ok().map(|_| sel_pw)
        })
        .map(|sel_pw| webview2_com::CoTaskMemPWSTR::from(sel_pw).to_string())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let Ok(env9) = env.cast::<ICoreWebView2Environment9>() else {
        eprintln!("[translate] CreateContextMenuItem не поддержан средой");
        return;
    };
    // Пустой поток вместо null-иконки: Param<IStream> не принимает None,
    // пустая иконка у пункта — норм (иконок у штатных пунктов часто нет).
    let Some(empty_icon) = windows::Win32::UI::Shell::SHCreateMemStream(Some(&[])) else {
        eprintln!("[translate] SHCreateMemStream не создал пустую иконку");
        return;
    };

    // Пункт «Перевести выделение» — при непустом выделении (duopulse-098);
    // вставка ПЕРВЫМ, чтобы пункт страницы ниже лёг над ним.
    if !selection.is_empty() {
        let (source, targets) = last_langs();
        let label = selection_menu_label(&source, &targets);
        let Ok(item) = env9.CreateContextMenuItem(
            &HSTRING::from(label),
            &empty_icon,
            COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND,
        ) else {
            eprintln!("[translate] пункт меню не создан");
            return;
        };
        let core_item = core.clone();
        let app_item = app.clone();
        let text_item = selection;
        let source_item = source;
        let targets_item = targets;
        let res = item.add_CustomItemSelected(
            &CustomItemSelectedEventHandler::create(Box::new(move |_item, _args| {
                start_selection_translate(&app_item, &core_item, &text_item, &source_item, &targets_item);
                Ok(())
            })),
            std::ptr::null_mut(),
        );
        if res.is_err() {
            eprintln!("[translate] подписка на клик пункта не встала");
            return;
        }
        // Пункт меню — сверху, после него разделитель (паттерн расширений Chrome).
        if insert_top(&env9, &args, &empty_icon, &item).is_err() {
            return;
        }
    }
    // Пункт «Перевести страницу» (duopulse-244) — над выделением, как
    // «Перевести на…» в Chrome; в меню всегда (выделение не обязательно).
    // Вставка в 0/1 поверх выделения даёт порядок
    // [страница, сеп, выделение, сеп, штатные…].
    let page_target = last_page_target();
    let page_label = format!("Перевести страницу (на {page_target})");
    let Ok(page) = env9.CreateContextMenuItem(
        &HSTRING::from(page_label),
        &empty_icon,
        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND,
    ) else {
        eprintln!("[translate] пункт меню страницы не создан");
        return;
    };
    let core_page = core.clone();
    let res = page.add_CustomItemSelected(
        &CustomItemSelectedEventHandler::create(Box::new(move |_item, _args| {
            start_page_translate(&core_page);
            Ok(())
        })),
        std::ptr::null_mut(),
    );
    if res.is_err() {
        eprintln!("[translate] подписка на клик пункта страницы не встала");
        return;
    }
    let _ = insert_top(&env9, &args, &empty_icon, &page);
    // Handled НЕ ставим: WebView2 показывает штатное меню с нашими пунктами.
}

/// Вставить пункт меню первым (индекс 0) с разделителем (индекс 1).
unsafe fn insert_top(
    env9: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment9,
    args: &ICoreWebView2ContextMenuRequestedEventArgs,
    empty_icon: &windows::Win32::System::Com::IStream,
    item: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2ContextMenuItem,
) -> Result<(), ()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR;
    use windows_core::HSTRING;
    let Ok(items) = args.MenuItems() else {
        return Err(());
    };
    if items.InsertValueAtIndex(0, item).is_err() {
        return Err(());
    }
    if let Ok(sep) = env9.CreateContextMenuItem(
        &HSTRING::new(),
        empty_icon,
        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR,
    ) {
        let _ = items.InsertValueAtIndex(1, &sep);
    }
    Ok(())
}

/// Клик «Перевести страницу»: begin-сообщение контент-слою (content/
/// page-translate.ts) — он сам собирает текстовые узлы и водит пачки
/// бесплатным gtx (WebMessage «gtx-translate», конвейер фолбэк-дорожек);
/// ядро сетью здесь не занимается. Мы уже на главном потоке (COM-обработчик).
fn start_page_translate(core: &ICoreWebView2) {
    let req_id = PAGE_REQ.fetch_add(1, Ordering::Relaxed);
    let begin = serde_json::json!({
        "duopulse": "translate-page",
        "reqId": req_id,
        "target": last_page_target(),
    });
    crate::post_to_page(Some(core), &begin);
}

/// Клик по пункту меню: begin-сообщение баблу (UI-поток) + фоновый перевод
/// с тем же reqId (бабл свяжет их).
fn start_selection_translate(
    app: &AppHandle,
    core: &ICoreWebView2,
    text: &str,
    source: &str,
    targets: &[String],
) {
    let req_id = SELECTION_REQ.fetch_add(1, Ordering::Relaxed);
    let begin = serde_json::json!({
        "duopulse": "translate-selection-begin",
        "reqId": req_id,
        "source": source,
        "targets": targets,
    });
    crate::post_to_page(Some(core), &begin);
    translate_selection_for_page(app, core, text, source, targets, req_id);
}

/// Пауза между целевыми языками одного перевода: несколько запросов подряд
/// бесплатный gtx-эндпоинт считает всплеском (duopulse-116).
const TARGET_STAGGER_MS: u64 = 400;

/// Фоновый gtx-перевод фрагмента на каждый целевой язык (последовательно,
/// с паузами) и доставка результата документу вкладки (WebMessage
/// «translate-selection-result» с items по языкам). Вызывается кликом
/// пункта меню и сменой языков в бабле (main.rs, «translate-selection»);
/// COM-указатель через потоки — SendCom (использование — только на
/// главном потоке).
pub(crate) fn translate_selection_for_page(
    app: &AppHandle,
    core: &ICoreWebView2,
    text: &str,
    source: &str,
    targets: &[String],
    req_id: u64,
) {
    let core = SendCom(core.clone());
    let app = app.clone();
    let text = text.to_string();
    let source = source.to_string();
    let targets = norm_targets(targets);
    tauri::async_runtime::spawn_blocking(move || {
        let transport = crate::translate::UreqTransport::new();
        let mut items = Vec::with_capacity(targets.len());
        for (i, target) in targets.iter().enumerate() {
            if i > 0 {
                std::thread::sleep(std::time::Duration::from_millis(TARGET_STAGGER_MS));
            }
            let item = match engine().translate(&transport, &text, &source, target) {
                Ok(t) => serde_json::json!({
                    "target": target,
                    "ok": true,
                    "translation": t.text,
                    "detected": t.detected,
                }),
                Err(e) => serde_json::json!({
                    "target": target,
                    "ok": false,
                    "error": e.message(),
                }),
            };
            items.push(item);
        }
        let all_failed = !items.is_empty() && items.iter().all(|i| i["ok"] != true);
        let reply = serde_json::json!({
            "duopulse": "translate-selection-result",
            "reqId": req_id,
            "ok": !all_failed,
            "source": source,
            "targets": targets,
            "original": text,
            "items": items,
            // общая ошибка — только когда не удалось ни один язык
            // (кулдаун gtx): иначе ошибки живут в своих items
            "error": if all_failed { items[0]["error"].clone() } else { serde_json::Value::Null },
        });
        // COM STA: PostWebMessageAsString — только на главном потоке;
        // SendCom доехал сюда (spawn_blocking Send), снимаем обёртку внутри.
        let res = app.run_on_main_thread(move || {
            let core = core.take();
            crate::post_to_page(Some(&core), &reply);
        });
        if res.is_err() {
            eprintln!("[translate] результат не доставлен: главный поток недоступен");
        }
    });
}
