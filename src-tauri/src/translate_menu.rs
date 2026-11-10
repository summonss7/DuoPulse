//! Пункт «Перевести выделение» в нативном контекстном меню страницы
//! (карточка duopulse-098).
//!
//! WebView2 умеет кастомизировать штатное меню правой кнопки (ICoreWebView2_
//! 20::add_ContextMenuRequested): в обработчике можно менять коллекцию
//! MenuItems и НЕ ставить Handled — покажется стандартное меню (назад/
//! копировать/…) с нашими добавками сверху, как у расширений переводчика в
//! Chrome. Кастомные пункты в WebView2 плоские — подменю языков API не даёт
//! (KIND_SUBMENU только для нативных пунктов), поэтому один пункт «Перевести
//! выделение (на <язык>)» ведёт на последний выбранный язык, а полный выбор
//! языка — селект в самом баббле перевода (паттерн меню Chrome
//! «Translate selection to …»).
//!
//! При непустом выделении (ContextMenuTarget::SelectionText) сверху меню
//! добавляются пункт и разделитель; клик — CustomItemSelected: Core шлёт
//! странице WebMessage «translate-selection-begin» (бабл «Переводим…» у
//! выделения), переводит фрагмент в фоне (src/translate/selection.rs,
//! бесплатный gtx-эндпоинт) и возвращает «translate-selection-result».
//! Смена языка в баббле — WebMessage «translate-selection» в main.rs, тот же
//! конвейер; выбранный язык запоминается и показывается в подписи пункта.
//!
//! Пустое выделение — меню не трогаем вовсе (штатное поведение). Бабл живёт
//! в контексте страницы (content/translate-select.ts) — рендерится поверх
//! контента композитором вкладки, слои WebView2 (карточка duopulse-086) не
//! участвуют.

#![cfg(windows)]

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::AppHandle;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2ContextMenuRequestedEventArgs, ICoreWebView2Environment,
};
use webview2_com::{ContextMenuRequestedEventHandler, CustomItemSelectedEventHandler};

use crate::translate::selection::{translate_selection, SelectionTranslation};

/// Счётчик запросов перевода выделения: reqId корреляции begin/result и
/// ответов на смену языка в баббле (content различает свежий/устаревший).
static SELECTION_REQ: AtomicU64 = AtomicU64::new(1);

/// Последний выбранный язык перевода выделения (сессия; дефолт «ru»):
/// подпись пункта меню ведёт на него, селект баббла меняет.
static LAST_TARGET: Mutex<String> = Mutex::new(String::new());

/// Текущий язык пункта меню: LAST_TARGET или дефолт.
fn last_target() -> String {
    let guard = LAST_TARGET.lock().unwrap();
    if guard.is_empty() {
        "ru".to_string()
    } else {
        guard.clone()
    }
}

/// Запомнить язык, выбранный в баббле (подпись пункта меню в следующий раз).
pub(crate) fn note_selection_target(lang: &str) {
    let lang = lang.trim().to_ascii_lowercase();
    if lang.is_empty() {
        return;
    }
    *LAST_TARGET.lock().unwrap() = lang;
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
        eprintln!("[translate] ContextMenuRequested не поддержан средой — меню перевода недоступно");
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

/// Добавить «Перевести выделение» в меню, если есть выделенный текст.
/// Ошибки глотаем с журналом — страница не должна страдать.
unsafe fn add_menu_item(
    core: &ICoreWebView2,
    env: &ICoreWebView2Environment,
    app: &AppHandle,
    args: &ICoreWebView2ContextMenuRequestedEventArgs,
) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment9, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND,
        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR,
    };
    use windows_core::{Interface, HSTRING, PWSTR};

    let Ok(target) = args.ContextMenuTarget() else {
        return;
    };
    let mut sel_pw = PWSTR::null();
    if target.SelectionText(&mut sel_pw).is_err() {
        return;
    }
    let selection = webview2_com::CoTaskMemPWSTR::from(sel_pw).to_string();
    let selection = selection.trim().to_string();
    if selection.is_empty() {
        return; // нечего переводить — меню штатное
    }
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

    let target = last_target();
    let label = format!("Перевести выделение (на {target})");
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
    let target_item = target;
    let res = item.add_CustomItemSelected(
        &CustomItemSelectedEventHandler::create(Box::new(move |_item, _args| {
            start_selection_translate(&app_item, &core_item, &text_item, &target_item);
            Ok(())
        })),
        std::ptr::null_mut(),
    );
    if res.is_err() {
        eprintln!("[translate] подписка на клик пункта не встала");
        return;
    }
    // Пункт меню — сверху, после него разделитель (паттерн расширений Chrome).
    let Ok(items) = args.MenuItems() else {
        return;
    };
    if items.InsertValueAtIndex(0, &item).is_err() {
        return;
    }
    if let Ok(sep) = env9.CreateContextMenuItem(
        &HSTRING::new(),
        &empty_icon,
        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR,
    ) {
        let _ = items.InsertValueAtIndex(1, &sep);
    }
    // Handled НЕ ставим: WebView2 показывает штатное меню с нашим пунктом.
}

/// Клик по пункту меню: begin-сообщение баблу (UI-поток) + фоновый перевод
/// с тем же reqId (бабл свяжет их).
fn start_selection_translate(app: &AppHandle, core: &ICoreWebView2, text: &str, target: &str) {
    let req_id = SELECTION_REQ.fetch_add(1, Ordering::Relaxed);
    let begin = serde_json::json!({
        "duopulse": "translate-selection-begin",
        "reqId": req_id,
        "target": target,
    });
    crate::post_to_page(Some(core), &begin);
    translate_selection_for_page(app, core, text, target, req_id);
}

/// Фоновый gtx-перевод фрагмента и доставка результата документу вкладки
/// (WebMessage «translate-selection-result»). Вызывается кликом пункта меню
/// и сменой языка в баббле (main.rs, «translate-selection»); COM-указатель
/// через потоки — SendCom (использование — только на главном потоке).
pub(crate) fn translate_selection_for_page(
    app: &AppHandle,
    core: &ICoreWebView2,
    text: &str,
    target: &str,
    req_id: u64,
) {
    let core = SendCom(core.clone());
    let app = app.clone();
    let text = text.to_string();
    let target = target.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let transport = crate::translate::UreqTransport::new();
        let reply = match translate_selection(&transport, &text, &target) {
            Ok(SelectionTranslation { detected, text: translated }) => serde_json::json!({
                "duopulse": "translate-selection-result",
                "reqId": req_id,
                "ok": true,
                "target": target,
                "detected": detected,
                "translation": translated,
                "original": text,
            }),
            Err(e) => serde_json::json!({
                "duopulse": "translate-selection-result",
                "reqId": req_id,
                "ok": false,
                "target": target,
                "error": e.message(),
            }),
        };
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
