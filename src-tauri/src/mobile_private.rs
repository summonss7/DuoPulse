//! DuoPulse — инкогнито мобильной ветки (карточка duopulse-096).
//! Мобильная обёртка и так не пишет историю/вкладки (см. шапку lib.rs);
//! следы сеанса остаются только в куках и хранилищах сайтов системного
//! WebView (YouTube-плеер в iframe). mobile_private_cleanup вызывает
//! CookieManager.removeAllCookies+flush и WebStorage.deleteAllData через
//! JNI-рефлексию (примитивы mobile_jni.rs) — UI зовёт её при входе в
//! инкогнито (чистый старт) и при выходе (следов не остаётся); после
//! убийства процесса дочистит следующий запуск по флагу localStorage
//! (src/mobile/mobile.ts).

/// mobile.private_cleanup: удалить куки и хранилища сайтов WebView.
/// Команда — только мобильным таргетам (регистрирует mobile_run): у
/// desktop-либы #[tauri::command] быть не должно (0xc0000139, см. шапку
/// mobile_open.rs).
#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub fn mobile_private_cleanup() -> Result<String, String> {
    jni_impl::cleanup()
}

#[cfg(target_os = "android")]
mod jni_impl {
    use crate::mobile_jni::{app_class, with_jni};
    use jni::objects::{JObject, JValue};

    /// CookieManager.getInstance().removeAllCookies(null) + flush() и
    /// WebStorage.getInstance().deleteAllData(). removeAllCookies без
    /// колбэка (null) — асинхронна, flush форсирует запись в хранилище,
    /// чтобы удаление переживало паузу/выход без ожидания ответа.
    pub fn cleanup() -> Result<String, String> {
        with_jni(|env, context| {
            let null_cb = JObject::null();
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
                "removeAllCookies",
                "(Landroid/webkit/ValueCallback;)V",
                &[JValue::Object(&null_cb)],
            )
            .map_err(|e| format!("removeAllCookies: {e}"))?;
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
}

/// iOS-таргет: мобильная ветка Android-only (см. шапку lib.rs); держим
/// сигнатуру, чтобы команда компилировалась.
#[cfg(all(not(target_os = "android"), target_os = "ios"))]
mod jni_impl {
    pub fn cleanup() -> Result<String, String> {
        Err("очистка приватных данных поддержана только на Android".into())
    }
}
