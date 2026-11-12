//! DuoPulse — нативный web-оверлей мобильной ветки (duopulse-126). Прежде
//! поиск и все адреса без YouTube-видео уходили в системный браузер
//! (mobile_open.rs → Intent ACTION_VIEW): страницы с X-Frame-Options в iframe
//! UI не встраиваются. Теперь поиск и обычные сайты открываются в приложении —
//! Kotlin-хелпер gen/android (MobileWebHelper) рисует WebView поверх UI Tauri
//! с мини-тулбаром (назад / адрес / «▶ duo» на YouTube-видео / закрыть);
//! YouTube-видео по-прежнему — встроенный /embed-плеер (фронтенд).
//!
//! Команда — только мобильным таргетам (регистрирует mobile_run): у
//! desktop-либы её быть не должно — #[tauri::command] в дереве либы
//! коренит muda с импортом comctl32 v6 (подробности в шапке mobile_open.rs).
//! Валидатор схемы — переиспользуем из mobile_open (чистая функция, тесты там).

#[cfg(any(target_os = "android", target_os = "ios"))]
use crate::mobile_open::is_openable_url;

/// mobile.web_open: открыть http/https-адрес в нативном web-оверлее.
/// Возврат — "opened"; отказы хелпера ("error: …") прокидываются как Err.
#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub fn mobile_web_open(url: String) -> Result<String, String> {
    if !is_openable_url(&url) {
        return Err(format!("схема не разрешена: {url}"));
    }
    jni_impl::call("open", &url)
}

/// mobile.web_close: закрыть оверлей и освободить WebView (UI зовёт при
/// «домой»/закрытии, чтобы не держать страницу в фоне).
#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub fn mobile_web_close() -> Result<String, String> {
    jni_impl::call("close", "")
}

#[cfg(target_os = "android")]
mod jni_impl {
    use crate::mobile_jni::{app_class, jstr, with_jni};

    /// Вызов статического метода MobileWebHelper (Context, String) → String —
    /// поверхность как у MobileOpenHelper: open/close, исключения гасятся
    /// в Kotlin и возвращаются строкой.
    pub fn call(method: &str, url: &str) -> Result<String, String> {
        with_jni(|env, context| {
            let helper = app_class(env, context, "dev.duopulse.mobile.MobileWebHelper")?;
            let jurl = jstr(env, url)?;
            let r = env
                .call_static_method(
                    &helper,
                    method,
                    "(Landroid/content/Context;Ljava/lang/String;)Ljava/lang/String;",
                    &[context.into(), (&jurl).into()],
                )
                .map_err(|e| format!("helper: {e}"))?
                .l()
                .map_err(|e| format!("helper: {e}"))?;
            let js = jni::objects::JString::from(r);
            env.get_string(&js)
                .map(|s| s.to_string_lossy().into_owned())
                .map_err(|e| format!("helper str: {e}"))
        })
    }
}

/// iOS-таргет: оверлей не поддержан (Android-ветка единственная мобильная);
/// держим сигнатуру, чтобы команда компилировалась.
#[cfg(all(not(target_os = "android"), target_os = "ios"))]
mod jni_impl {
    pub fn call(method: &str, _url: &str) -> Result<String, String> {
        Err(format!("web-оверлей поддержан только на Android ({method})"))
    }
}
