//! DuoPulse — пароли web-оверлея мобильной ветки: захват из форм (карточка
//! duopulse-165, паритет 2/8 аудита duopulse-156) и автозаполнение
//! (duopulse-166, паритет 3/8). Хранилище на Android уже общее с десктопом
//! (passwords/mod.rs, ключ под Android Keystore), нет только контент-слоя:
//! контент-бандл в нативный WebView Android не инжектируется (канал
//! WebMessage — WebView2). Здесь замыкаются цепочки:
//!
//! ЗАХВАТ:
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
//! АВТОЗАПОЛНЕНИЕ (duopulse-166):
//!   пейлоад mobile_pass_fill.js (порт автозаполнения passwords-fill.ts,
//!   тест — src/mobile/pass-fill.test.ts) нашёл форму логина
//!     → DuopulseFill.ready() → accounts_for_overlay (логины сайта БЕЗ
//!       паролей, чистое ядро passwords/autofill.rs; инкогнито — пусто)
//!     → __dpPassAccounts([...]) в страницу → иконка-ключ у поля пароля
//!     → тап → DuopulseFill.pick() → один аккаунт: сразу заполнение;
//!       несколько: нативный лист (имена без паролей)
//!     → credential_for_overlay (reveal по факту выбора)
//!     → __dpPassFill(логин, пароль) — пароль живёт в памяти мгновение
//!       и не логируется нигде (консоль/logcat/Kotlin-Log).
//!
//! URL страницы и origin считает Kotlin по webView.url — странице не верим
//! (интерфейс доступен любому JS загруженного сайта). Пароль не логируется:
//! eprintln светит только логин@origin (паттерн main.rs десктопа) и не
//! касается ни пейлоада, ни хранилища. Инкогнито: фронт мобильной ветки
//! ставит флаг (mobile_password_incognito) — кандидат отвергается до
//! запоминания, автозаполнение выключено (только ручной ввод). Сброс
//! кандидата — reset() из teardown оверлея (мобильный аналог
//! on_tabs_changed: поверхность сабмита исчезла).
//!
//! Модуль — только мобильным таргетам либы (нужен crate::passwords, см.
//! развилку lib.rs); чистые ядра (offer_overlay/clear — passwords/prompts.rs,
//! accounts_for_url/credential_for_url — passwords/autofill.rs) живут
//! рядом с общим хранилищем и тестируются на хосте вместе с десктопом.

use std::sync::{Arc, OnceLock};

use tauri::AppHandle;
use tauri::Emitter;

use crate::passwords::{PasswordPrompts, PasswordStore, PasswordsCandidateView};

/// JS-пейлоад детекта формы логина (см. шапку); Kotlin берёт его JNI-вызовом
/// captureScript и подаёт evaluateJavascript на каждой странице оверлея.
pub const CAPTURE_SCRIPT: &str = include_str!("mobile_pass_capture.js");

/// JS-пейлоад автозаполнения (duopulse-166, см. шапку); JNI-вызов fillScript,
/// подаётся после CAPTURE_SCRIPT (маркер __dpPassFillWatch — идемпотентность).
pub const FILL_SCRIPT: &str = include_str!("mobile_pass_fill.js");

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

/// Инкогнито сейчас (лист «Диагностика»: автозаполнение паролей вкл/выкл).
pub fn is_incognito() -> bool {
    STATE
        .get()
        .map(|st| st.incognito.load(std::sync::atomic::Ordering::Relaxed))
        .unwrap_or(false)
}

/// Логины сайта для автозаполнения (duopulse-166): usernames без паролей,
/// origin — по URL вкладки (считает чистое ядро passwords/autofill.rs);
/// инкогнито и недоступное Core — пусто (иконки-ключа не будет).
pub fn accounts_for_overlay(url: &str) -> Vec<String> {
    match STATE.get() {
        Some(st) => crate::passwords::autofill::accounts_for_url(&st.store, is_incognito(), url),
        None => Vec::new(),
    }
}

/// Пароль выбранного логина сайта (reveal по факту выбора в листе):
/// инкогнито/чужой логин/сбой — None. Кроме evaluateJavascript заполнения
/// полей пароль никуда не уходит и не логируется.
pub fn credential_for_overlay(url: &str, username: &str) -> Option<String> {
    let st = STATE.get()?;
    crate::passwords::autofill::credential_for_url(&st.store, is_incognito(), url, username)
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

    use super::{accounts_for_overlay, credential_for_overlay, report_candidate, reset,
                CAPTURE_SCRIPT, FILL_SCRIPT};

    /// java.lang.String → Option<String> (пустая — «значения нет»).
    fn opt_str(env: &mut JNIEnv, s: JString) -> Option<String> {
        let raw = env.get_string(&s).ok()?.to_string_lossy().into_owned();
        (!raw.is_empty()).then_some(raw)
    }

    /// String → jstring (null при недоступной JVM — Kotlin читает как «нет»).
    fn to_jstring(env: &mut JNIEnv, s: &str) -> jstring {
        match env.new_string(s) {
            Ok(js) => js.as_raw(),
            Err(_) => JObject::null().as_raw() as jstring,
        }
    }

    /// JS-пейлоад детекта для evaluateJavascript (инжекция onPageFinished).
    #[unsafe(no_mangle)]
    pub extern "C" fn Java_dev_duopulse_mobile_MobilePassNative_captureScript(
        mut env: JNIEnv,
        _class: JClass,
    ) -> jstring {
        let script =
            std::panic::catch_unwind(|| CAPTURE_SCRIPT.to_string()).unwrap_or_default();
        to_jstring(&mut env, &script)
    }

    /// JS-пейлоад автозаполнения (duopulse-166; инжекция после captureScript).
    #[unsafe(no_mangle)]
    pub extern "C" fn Java_dev_duopulse_mobile_MobilePassNative_fillScript(
        mut env: JNIEnv,
        _class: JClass,
    ) -> jstring {
        let script = std::panic::catch_unwind(|| FILL_SCRIPT.to_string()).unwrap_or_default();
        to_jstring(&mut env, &script)
    }

    /// Логины сайта (duopulse-166): JSON-массив usernames без паролей —
    /// пустой массив «[]» и на инкогнито, и на недоступном Core (иконок нет).
    #[unsafe(no_mangle)]
    pub extern "C" fn Java_dev_duopulse_mobile_MobilePassNative_accountsFor(
        mut env: JNIEnv,
        _class: JClass,
        url: JString,
    ) -> jstring {
        let url = opt_str(&mut env, url).unwrap_or_default();
        let accounts = std::panic::catch_unwind(|| {
            serde_json::to_string(&accounts_for_overlay(&url)).unwrap_or_else(|_| "[]".into())
        })
        .unwrap_or_else(|_| "[]".to_string());
        to_jstring(&mut env, &accounts)
    }

    /// Пароль выбранного логина (reveal по факту выбора в листе): null —
    /// нет логина/инкогнито/сбой. Значение не логируется и кроме
    /// evaluateJavascript заполнения полей никуда не уходит.
    #[unsafe(no_mangle)]
    pub extern "C" fn Java_dev_duopulse_mobile_MobilePassNative_credentialFor(
        mut env: JNIEnv,
        _class: JClass,
        url: JString,
        username: JString,
    ) -> jstring {
        let url = opt_str(&mut env, url);
        let username = opt_str(&mut env, username);
        let credential = std::panic::catch_unwind(|| {
            credential_for_overlay(url.as_deref().unwrap_or(""), username.as_deref().unwrap_or(""))
        })
        .unwrap_or(None);
        match credential {
            Some(pass) => to_jstring(&mut env, &pass),
            None => JObject::null().as_raw() as jstring,
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
