//! DuoPulse — захват паролей из форм web-оверлея мобильной ветки (карточка
//! duopulse-165, паритет 2/8 аудита duopulse-156). Хранилище на Android уже
//! общее с десктопом (passwords/mod.rs, ключ под Android Keystore), нет
//! только детекта формы логина: контент-бандл в нативный WebView Android не
//! инжектируется (канал WebMessage — WebView2). Здесь замыкается цепочка:
//!
//!   пейлоад mobile_pass_capture.js (порт детекта content/passwords-fill.ts,
//!   инжекция evaluateJavascript из MobileWebHelper, источник —
//!   include_str! ниже, тест — src/mobile/pass-capture.test.ts в happy-dom)
//!     → JS-интерфейс DuopulsePass.report(json) в Kotlin (мимо консоли/logcat)
//!     → MobilePassNative.reportCandidate (JNI, сюда)
//!     → PasswordPrompts::offer_overlay (инкогнито/denylist/тот же пароль —
//!       бара нет; кандидат с паролем живёт ТОЛЬКО в памяти Core)
//!     → событие passwords:save_prompt в UI-webview (без пароля)
//!     → лист «Сохранить пароль?» (src/mobile/pass-save.ts)
//!     → mobile_password_resolve: save (upsert PasswordStore по (origin,
//!       username), как на десктопе) / never (denylist) / dismiss.
//!
//! URL страницы и origin считает Kotlin по webView.url — странице не верим
//! (интерфейс доступен любому JS загруженного сайта). Пароль не логируется:
//! eprintln светит только логин@origin (паттерн main.rs десктопа) и не
//! касается ни пейлоада, ни хранилища. Инкогнито: фронт мобильной ветки
//! ставит флаг (mobile_password_incognito) — кандидат отвергается до
//! запоминания. Сброс кандидата — reset() из teardown оверлея (мобильный
//! аналог on_tabs_changed: поверхность сабмита исчезла).
//!
//! Модуль — только мобильным таргетам либы (нужен crate::passwords, см.
//! развилку lib.rs); чистое ядро (offer_overlay/clear) живёт в
//! passwords/prompts.rs и тестируется на хосте вместе с десктопом.

use std::sync::{Arc, OnceLock};

use tauri::AppHandle;
use tauri::Emitter;

use crate::passwords::{PasswordPrompts, PasswordStore, PasswordsCandidateView};

/// JS-пейлоад детекта формы логина (см. шапку); Kotlin берёт его JNI-вызовом
/// captureScript и подаёт evaluateJavascript на каждой странице оверлея.
pub const CAPTURE_SCRIPT: &str = include_str!("mobile_pass_capture.js");

/// tab_id оверлея в кандидате: мобильных вкладок Core не знает, промпт один
/// на приложение; on_tabs_changed на мобильной ветке не зовётся (модуль tabs
/// — десктопный), сброс — reset при закрытии оверлея.
pub const OVERLAY_TAB_ID: &str = "web-overlay";

/// Имя события для UI (тот же контракт, что у bridge-события десктопа
/// PasswordsSavePrompt: camelCase, без пароля).
pub const SAVE_PROMPT_EVENT: &str = "passwords:save_prompt";

struct MobilePass {
    app: AppHandle,
    store: Arc<PasswordStore>,
    prompts: Arc<PasswordPrompts>,
    /// Инкогнито мобильной ветки (фронт ставит при переключении режима).
    incognito: std::sync::atomic::AtomicBool,
}

static STATE: OnceLock<MobilePass> = OnceLock::new();

/// Зафиксировать состояние (setup мобильной либы, до старта окна); повторные
/// вызовы — no-op. Эмиттер событий UI — AppHandle (Emitter потокобезопасен,
/// JNI-вызовы идут с нити JavaBridge).
pub fn init(app: AppHandle, store: Arc<PasswordStore>) {
    let _ = STATE.set(MobilePass {
        app,
        store,
        prompts: Arc::new(PasswordPrompts::default()),
        incognito: std::sync::atomic::AtomicBool::new(false),
    });
}

/// Инкогнито-режим мобильной ветки (mobile_password_incognito): кандидат из
/// форм не запоминается и бар не показывается.
pub fn set_incognito(on: bool) {
    if let Some(st) = STATE.get() {
        st.incognito.store(on, std::sync::atomic::Ordering::Relaxed);
    }
}

/// mobile_password_incognito: фронт ставит флаг при переключении приватного
/// режима (состояние инкогнито живёт во фронте, Core о нём не знает).
#[tauri::command]
pub fn mobile_password_incognito(on: bool) {
    set_incognito(on);
}

/// mobile_password_candidate: ожидающий кандидат без пароля (null — бара
/// нет); e2e-смоук проверяет им состояние Core.
#[tauri::command]
pub fn mobile_password_candidate() -> Option<PasswordsCandidateView> {
    STATE.get().and_then(|st| st.prompts.view())
}

/// mobile_password_resolve: решение листа «Сохранить пароль?» — save (upsert
/// хранилища), never (origin → denylist), dismiss (забыть). false — решать
/// было нечего (гонка события и листа — тихо).
#[tauri::command]
pub fn mobile_password_resolve(action: String) -> Result<bool, String> {
    let st = STATE.get().ok_or_else(|| "пароли недоступны".to_string())?;
    st.prompts.resolve(&st.store, &action)
}

/// Кандидат от пейлоада (через Kotlin): инкогнито — тихо, прочее решает
/// PasswordPrompts::offer_overlay. Бар заслужен — событие в UI без пароля.
/// Лог — только логин@origin (пароль не светится ни в logcat, ни в консоли).
pub fn report_candidate(username: &str, password: &str, url: &str, title: &str) {
    let Some(st) = STATE.get() else {
        return;
    };
    let incognito = st.incognito.load(std::sync::atomic::Ordering::Relaxed);
    match st
        .prompts
        .offer_overlay(&st.store, incognito, OVERLAY_TAB_ID, url, title, username, password)
    {
        Ok(Some(view)) => {
            eprintln!(
                "[passwords] кандидат (оверлей): {}@{} ({})",
                view.username,
                view.origin,
                if view.updated { "обновление" } else { "новый" }
            );
            let _ = st.app.emit(
                SAVE_PROMPT_EVENT,
                serde_json::json!({
                    "tabId": view.tab_id,
                    "origin": view.origin,
                    "username": view.username,
                    "updated": view.updated,
                }),
            );
        }
        Ok(None) => {}
        Err(e) => eprintln!("[passwords] кандидат отклонён: {e}"),
    }
}

/// Забыть кандидата (закрылся web-оверлей — teardown MobileWebHelper).
pub fn reset() {
    if let Some(st) = STATE.get() {
        st.prompts.clear();
    }
}

// ---------------------------------------------------------------------------
// JNI-экспорты (только Android): вызовы MobilePassNative из Kotlin. Паника
// Rust не должна валить процесс браузера: тела под catch_unwind, строки
// извлекаются ДО замыкания (паттерн mobile_adblock.rs).
// ---------------------------------------------------------------------------
#[cfg(target_os = "android")]
mod jni {
    use jni::objects::{JClass, JObject, JString};
    use jni::sys::jstring;
    use jni::JNIEnv;

    use super::{report_candidate, reset, CAPTURE_SCRIPT};

    /// java.lang.String → Option<String> (пустая — «значения нет»).
    fn opt_str(env: &mut JNIEnv, s: JString) -> Option<String> {
        let raw = env.get_string(&s).ok()?.to_string_lossy().into_owned();
        (!raw.is_empty()).then_some(raw)
    }

    /// JS-пейлоад детекта для evaluateJavascript (инжекция onPageFinished).
    #[unsafe(no_mangle)]
    pub extern "C" fn Java_dev_duopulse_mobile_MobilePassNative_captureScript(
        mut env: JNIEnv,
        _class: JClass,
    ) -> jstring {
        let script =
            std::panic::catch_unwind(|| CAPTURE_SCRIPT.to_string()).unwrap_or_default();
        match env.new_string(&script) {
            Ok(js) => js.as_raw(),
            // JVM недоступна — нулевая ссылка (Kotlin читает null как «нет пейлоада»)
            Err(_) => JObject::null().as_raw() as jstring,
        }
    }

    /// Пара из формы логина (пейлоад → DuopulsePass.report → Kotlin): URL и
    /// заголовок даёт Kotlin (webView.url/title — доверенные), Core считает
    /// origin сам. Пароль дальше памяти Core не уходит.
    #[unsafe(no_mangle)]
    pub extern "C" fn Java_dev_duopulse_mobile_MobilePassNative_reportCandidate(
        mut env: JNIEnv,
        _class: JClass,
        username: JString,
        password: JString,
        url: JString,
        title: JString,
    ) {
        let user = opt_str(&mut env, username);
        let pass = opt_str(&mut env, password);
        let url = opt_str(&mut env, url);
        let title = opt_str(&mut env, title).unwrap_or_default();
        let deliver = || -> Option<()> {
            report_candidate(&user?, &pass?, &url?, &title);
            Some(())
        };
        let _ = std::panic::catch_unwind(deliver);
    }

    /// Закрылся web-оверлей — забыть ожидающего кандидата.
    #[unsafe(no_mangle)]
    pub extern "C" fn Java_dev_duopulse_mobile_MobilePassNative_reset() {
        let _ = std::panic::catch_unwind(reset);
    }
}
