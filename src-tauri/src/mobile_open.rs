//! DuoPulse — внешнее открытие ссылок мобильной веткой (duopulse-085).
//! Мобильный «браузер» — один iframe в UI-webview, и сайты с
//! X-Frame-Options (google.com, страницы результатов YouTube, все
//! поисковики) в него не встраиваются — ввод адреса или запроса «ничего
//! не открывал». Теперь: YouTube-видео — встраиваемый /embed-плеер (как
//! прежде, фронтенд), прочее — системный браузер через Intent ACTION_VIEW.
//! Kotlin-хелпер gen/android (MobileOpenHelper) — как установка APK в
//! mobile_updater.rs: из Rust один статический вызов (минимальная
//! JNI-поверхность), исключения гасятся в Kotlin и возвращаются строкой.
//!
//! Команда — только мобильным таргетам (регистрирует mobile_run): у
//! desktop-либы её быть не должно — #[tauri::command] в дереве либы
//! коренит muda с импортом comctl32 v6 (TaskDialogIndirect), и тест-exe
//! без манифеста падает на загрузке (0xc0000139, дуэль с v5 comctl32).
//! Валидатор схемы — чистая функция, компилируется везде и покрыт тестами.

/// Разрешён ли адрес к внешнему открытию: только http/https — Intent
/// ACTION_VIEW с произвольной строкой открыл бы и intent:///, и market://.
pub fn is_openable_url(url: &str) -> bool {
    url::Url::parse(url)
        .map(|u| u.scheme() == "https" || u.scheme() == "http")
        .unwrap_or(false)
}

/// mobile.open_url: открыть http/https-адрес в системном браузере.
/// Возврат — "opened"; отказы хелпера ("error: …") прокидываются как Err
/// (UI показывает их в строке статуса).
#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
pub fn mobile_open_url(url: String) -> Result<String, String> {
    if !is_openable_url(&url) {
        return Err(format!("схема не разрешена: {url}"));
    }
    jni_impl::open(&url)
}

#[cfg(target_os = "android")]
mod jni_impl {
    use crate::mobile_jni::{app_class, jstr, with_jni};

    /// Открытие — через Kotlin-хелпер gen/android (MobileOpenHelper.open):
    /// из Rust один статический вызов, ActivityNotFoundException и прочие
    /// исключения гасятся в Kotlin и возвращаются строкой.
    pub fn open(url: &str) -> Result<String, String> {
        with_jni(|env, context| {
            let helper = app_class(env, context, "dev.duopulse.mobile.MobileOpenHelper")?;
            let jurl = jstr(env, url)?;
            let r = env
                .call_static_method(
                    &helper,
                    "open",
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

/// iOS-таргет: внешние ссылки пока не поддержаны (Android-ветка проекта
/// единственная мобильная); держим сигнатуру, чтобы команда компилировалась.
#[cfg(all(not(target_os = "android"), target_os = "ios"))]
mod jni_impl {
    pub fn open(_url: &str) -> Result<String, String> {
        Err("внешние ссылки поддержаны только на Android".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_http_and_https_are_openable() {
        // javascript:/intent: из omnibox не проходят валидатор
        assert!(is_openable_url("https://google.com"));
        assert!(is_openable_url("http://localhost:8899/x.html"));
        assert!(!is_openable_url("javascript:alert(1)"));
        assert!(!is_openable_url("intent://x/#Intent;end"));
        assert!(!is_openable_url("market://details?id=x"));
        assert!(!is_openable_url("не адрес"));
    }
}
