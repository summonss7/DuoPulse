//! Мост движка блокировщика в мобильную ветку (карточка duopulse-144):
//! полный адблок десктопа (adblock-rs: EasyList + uBO + quick-fixes,
//! сетевая фильтрация до загрузки, косметика, скриптлеты) переносится на
//! Android — web-оверлей MobileWebHelper из shouldInterceptRequest спрашивает
//! движок через JNI (сетевые решения синхронно, косметику — скриптом под
//! evaluateJavascript). Сервис — тот же crate::adblock::AdblockService, что
//! у десктоп-бина: списки качаются/кэшируются тем же механизмом
//! (profile/filters мобильного профиля filesDir/profile, суточное фоновое
//! обновление), тумблер — тот же ключ "adblock" settings.json (переживает
//! перезапуск, общая семантика с десктопом).
//!
//! Модуль — только мобильным таргетам (как mobile_settings): #[tauri::command]
//! в desktop-либе быть не должно (0xc0000139, см. шапку mobile_open.rs).
//! JNI-экспорты — только Android: Kotlin-объект MobileAdblockNative
//! (gen/android) зовёт Java_dev_duopulse_mobile_MobileAdblockNative_*;
//! нативные вызовы идут с нитей загрузчика WebView (не UI), сервис за
//! мьютексом — should_block спроектирован на горячий путь. Пустая строка
//! вместо null-строк: JNI-нулевые объекты не разбираем, Kotlin передаёт "".

use std::path::Path;
use std::sync::{Arc, OnceLock};

use crate::adblock::{AdblockService, AdblockStatusResult};

/// Синглтон сервиса: инициализируется из setup мобильной либы (lib.rs).
static SERVICE: OnceLock<Arc<AdblockService>> = OnceLock::new();

/// Поднять сервис блокировщика (вызов из setup до старта окна): движок
/// восстанавливается из кэша прошлой сессии немедленно, свежие списки
/// досматривает фоновая нить (fail-open до готовности — как на десктопе,
/// карточка duopulse-077).
pub fn init(profile_dir: &Path) {
    let svc = Arc::new(AdblockService::new(profile_dir));
    svc.start_mobile();
    let _ = SERVICE.set(svc); // повторный init (не бывает) — оставляем первый
}

/// Доступ к сервису; если init не вызван (оверлей раньше setup — на практике
/// нет), поднимаем лениво на мобильном профиле, чтобы фильтрация не молчала.
fn service() -> Option<Arc<AdblockService>> {
    if let Some(svc) = SERVICE.get() {
        return Some(Arc::clone(svc));
    }
    let dir = crate::mobile_history::profile_dir().ok()?;
    let svc = Arc::new(AdblockService::new(&dir));
    svc.start_mobile();
    let _ = SERVICE.set(Arc::clone(&svc));
    Some(svc)
}

/// mobile_adblock_status: снапшот состояния (тумблер, готовность движка,
/// счётчики, списки) — настройки мобильного UI и e2e-смоук.
#[tauri::command]
pub fn mobile_adblock_status() -> Result<AdblockStatusResult, String> {
    let svc = service().ok_or_else(|| "профиль недоступен".to_string())?;
    Ok(svc.status())
}

/// mobile_adblock_set_enabled: глобальный тумблер (пишется в settings.json
/// мобильного профиля — состояние переживает перезапуск).
#[tauri::command]
pub fn mobile_adblock_set_enabled(on: bool) -> Result<AdblockStatusResult, String> {
    let svc = service().ok_or_else(|| "профиль недоступен".to_string())?;
    svc.set_enabled_mobile(on)?;
    Ok(svc.status())
}

// ---------------------------------------------------------------------------
// JNI-экспорты (только Android): вызовы MobileAdblockNative из Kotlin.
// Паника Rust не должна валить процесс браузера: тела под catch_unwind,
// строки извлекаются ДО замыкания (замыкание без &mut env — UnwindSafe),
// ошибка = fail-open/false/пусто.
// ---------------------------------------------------------------------------

#[cfg(target_os = "android")]
mod jni {
    use jni::objects::{JClass, JObject, JString};
    use jni::sys::{jboolean, jstring, JNI_FALSE, JNI_TRUE};
    use jni::JNIEnv;

    use crate::adblock::guess_request_type;

    use super::service;

    /// java.lang.String → Option<String> (пустая строка — «значения нет»).
    fn opt_str(env: &mut JNIEnv, s: JString) -> Option<String> {
        let raw = env.get_string(&s).ok()?.to_string_lossy().into_owned();
        (!raw.is_empty()).then_some(raw)
    }

    /// Новая jstring; недоступная JVM — нулевая ссылка (Kotlin читает null
    /// как «применять нечего»).
    fn jstr_or_null(env: &mut JNIEnv, s: &str) -> jstring {
        match env.new_string(s) {
            Ok(js) => js.as_raw(),
            Err(_) => JObject::null().as_raw() as jstring,
        }
    }

    /// Решение для shouldInterceptRequest оверлея: сетевая фильтрация
    /// движком (EasyList/uBO/quick-fixes), тип запроса — по URL/Accept
    /// (Android тип ресурса не раскрывает).
    #[unsafe(no_mangle)]
    pub extern "C" fn Java_dev_duopulse_mobile_MobileAdblockNative_shouldBlock(
        mut env: JNIEnv,
        _class: JClass,
        url: JString,
        page_url: JString,
        referer: JString,
        accept: JString,
        is_main: jboolean,
    ) -> jboolean {
        // строки наружу до catch_unwind: замыкание владеет данными, не env
        let url = opt_str(&mut env, url);
        let page = opt_str(&mut env, page_url);
        let referer = opt_str(&mut env, referer);
        let accept = opt_str(&mut env, accept);
        let main = is_main != JNI_FALSE;
        let decide = || -> Option<bool> {
            let url = url?;
            let request_type = guess_request_type(&url, accept.as_deref(), main);
            let svc = service()?;
            Some(svc.should_block(page.as_deref(), &url, request_type, referer.as_deref()))
        };
        match std::panic::catch_unwind(decide) {
            Ok(Some(true)) => JNI_TRUE,
            _ => JNI_FALSE,
        }
    }

    /// Готовый JS-пейлоад косметики (скриптлеты + hide-селекторы) для
    /// evaluateJavascript оверлея; пустая строка — применять нечего.
    #[unsafe(no_mangle)]
    pub extern "C" fn Java_dev_duopulse_mobile_MobileAdblockNative_cosmeticScript(
        mut env: JNIEnv,
        _class: JClass,
        url: JString,
    ) -> jstring {
        let page = opt_str(&mut env, url);
        let build = || -> Option<String> {
            let url = page?;
            service().map(|svc| svc.cosmetic_injection_script(&url))
        };
        let script = std::panic::catch_unwind(build)
            .ok()
            .flatten()
            .unwrap_or_default();
        jstr_or_null(&mut env, &script)
    }

    /// Глобальный тумблер (settings.json) — пункт меню «⋮» оверлея.
    #[unsafe(no_mangle)]
    pub extern "C" fn Java_dev_duopulse_mobile_MobileAdblockNative_isEnabled(
        _env: JNIEnv,
        _class: JClass,
    ) -> jboolean {
        let check = || service().is_some_and(|svc| svc.status().enabled);
        if std::panic::catch_unwind(check).unwrap_or(false) {
            JNI_TRUE
        } else {
            JNI_FALSE
        }
    }

    /// Включить/выключить блокировщик (пишет settings.json мобильного
    /// профиля — состояние переживает перезапуск).
    #[unsafe(no_mangle)]
    pub extern "C" fn Java_dev_duopulse_mobile_MobileAdblockNative_setEnabled(
        _env: JNIEnv,
        _class: JClass,
        on: jboolean,
    ) {
        let apply = || {
            if let Some(svc) = service() {
                let _ = svc.set_enabled_mobile(on != JNI_FALSE);
            }
        };
        let _ = std::panic::catch_unwind(apply);
    }

    /// JSON-снапшот состояния (счётчики/списки/готовность) — диагностика
    /// e2e-смоука (хелперы пишут его в logcat).
    #[unsafe(no_mangle)]
    pub extern "C" fn Java_dev_duopulse_mobile_MobileAdblockNative_status(
        mut env: JNIEnv,
        _class: JClass,
    ) -> jstring {
        let dump = || {
            service().and_then(|svc| serde_json::to_string(&svc.status()).ok())
        };
        let json = std::panic::catch_unwind(dump)
            .ok()
            .flatten()
            .unwrap_or_else(|| "{}".into());
        jstr_or_null(&mut env, &json)
    }
}
