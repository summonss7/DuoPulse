//! DuoPulse — инкогнито мобильной ветки (карточка duopulse-096).
//! Мобильная обёртка и так не пишет историю/вкладки (см. шапку lib.rs);
//! следы сеанса остаются в куках и хранилищах сайтов системного WebView.
//! С карточки duopulse-211 инкогнито-оверлей живёт на ИЗОЛИРОВАННОМ профиле
//! WebView (ProfileStore) — его данные сносит teardown оверлея. Общий
//! (дефолтный) профиль — это нормальные логины пользователя (Ютуб/Google и
//! прочие), и с карточки duopulse-247 (жалоба «постоянно нужно входить в
//! аккаунт») инкогнито его больше НЕ вытирает: mobile_private_cleanup чистит
//! только WebStorage (следы iframe-плеера UI-webview, он на общем профиле),
//! а приём кук общего профиля на время инкогнито гасит mobile_private_cookies
//! (плеер играет анонимно — новых кук нет, прежние целы; деграда без
//! MULTI_PROFILE — оверлей тоже на общем профиле и тоже без кук). UI зовёт
//! пару при входе/выходе из режима; после убийства процесса дочистит
//! следующий запуск по флагу localStorage (src/mobile/mobile.ts).

/// mobile.private_cleanup: удалить хранилища сайтов WebView (куки НЕ
/// трогаем — duopulse-247). Команда — только мобильным таргетам
/// (регистрирует mobile_run): у desktop-либы #[tauri::command] быть не
/// должно (0xc0000139, см. шапку mobile_open.rs).
#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub fn mobile_private_cleanup() -> Result<String, String> {
    jni_impl::cleanup()
}

/// mobile.private_cookies: включить/выключить приём кук дефолтного профиля
/// WebView на время инкогнито (duopulse-247): куки не пишутся и не
/// отправляются — след нет, нормальные логины не повреждаются.
#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub fn mobile_private_cookies(on: bool) -> Result<String, String> {
    jni_impl::cookies(on)
}

#[cfg(target_os = "android")]
mod jni_impl {
    use crate::mobile_jni::{app_class, with_jni};
    use jni::objects::JValue;

    /// CookieManager.getInstance().flush() и
    /// WebStorage.getInstance().deleteAllData(). Куки НЕ трогаем (duopulse-247:
    /// removeAllCookies сносил и нормальные логины пользователя — «постоянно
    /// нужно входить в аккаунт»); flush форсирует запись текущих кук в
    /// хранилище, чтобы пережили паузу/выход без ожидания. WebStorage —
    /// следы iframe-плеера UI-webview (youtube-origin на общем профиле).
    pub fn cleanup() -> Result<String, String> {
        with_jni(|env, context| {
            let cookies = app_class(env, context, "android/webkit/CookieManager")?;
            let mgr = env
                .call_static_method(
                    &cookies,
                    "getInstance",
                    "()Landroid/webkit/CookieManager;",
                    &[],
                )
                .map_err(|e| format!("CookieManager.getInstance: {e}"))?
                .l()
                .map_err(|e| format!("CookieManager.getInstance: {e}"))?;
            env.call_method(&mgr, "flush", "()V", &[])
                .map_err(|e| format!("CookieManager.flush: {e}"))?;

            let storage = app_class(env, context, "android/webkit/WebStorage")?;
            let stor = env
                .call_static_method(
                    &storage,
                    "getInstance",
                    "()Landroid/webkit/WebStorage;",
                    &[],
                )
                .map_err(|e| format!("WebStorage.getInstance: {e}"))?
                .l()
                .map_err(|e| format!("WebStorage.getInstance: {e}"))?;
            env.call_method(&stor, "deleteAllData", "()V", &[])
                .map_err(|e| format!("deleteAllData: {e}"))?;
            Ok("cleaned".into())
        })
    }

    /// CookieManager.getInstance().setAcceptCookie(on): на время инкогнито
    /// общий профиль не принимает (и не шлёт) куки — след нет, прежние
    /// логины целы (duopulse-247). Инстанция getInstance() — дефолтный
    /// профиль: изолированный профиль инкогнито (duopulse-211) и его куки
    /// не затрагивает.
    pub fn cookies(on: bool) -> Result<String, String> {
        with_jni(|env, context| {
            let cookies = app_class(env, context, "android/webkit/CookieManager")?;
            let mgr = env
                .call_static_method(
                    &cookies,
                    "getInstance",
                    "()Landroid/webkit/CookieManager;",
                    &[],
                )
                .map_err(|e| format!("CookieManager.getInstance: {e}"))?
                .l()
                .map_err(|e| format!("CookieManager.getInstance: {e}"))?;
            env.call_method(
                &mgr,
                "setAcceptCookie",
                "(Z)V",
                &[JValue::Bool(on.into())],
            )
            .map_err(|e| format!("setAcceptCookie: {e}"))?;
            Ok(if on { "on".into() } else { "off".into() })
        })
    }
}

/// iOS-таргет: мобильная ветка Android-only (см. шапку lib.rs); держим
/// сигнатуры, чтобы команды компилировались.
#[cfg(all(not(target_os = "android"), target_os = "ios"))]
mod jni_impl {
    pub fn cleanup() -> Result<String, String> {
        Err("очистка приватных данных поддержана только на Android".into())
    }

    pub fn cookies(_on: bool) -> Result<String, String> {
        Err("блокировка кук поддержана только на Android".into())
    }
}
