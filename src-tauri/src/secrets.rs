//! DPAPI-хранилище секретов (docs/02 §9): на диске — только зашифрованный
//! CurrentUser-blob, открытого секрета нет. Общий код для пароля прокси
//! (vpn/proxy-pass.bin, задача 1.8 — прежде жил в proxy.rs) и ключей API
//! провайдеров перевода (translate/keys/*.bin, задача 4.1).
//!
//! Android (этап 6 duopulse-112): та же пара protect/unprotect через ключ
//! AES-256-GCM в системном AndroidKeyStore — Kotlin-хелпер
//! MobileKeystoreHelper (gen/android), вызов из Rust по JNI; блоб на диске —
//! base64-строка "v1:…". Хранит ключ синка/токен аккаунта Aila мобильной
//! ветки и ключ passwords.key (как DPAPI на десктопе).

use std::path::Path;

/// Зашифровать секрет DPAPI (CurrentUser, без UI-промпта).
#[cfg(windows)]
fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
    {
        use windows::Win32::Security::Cryptography::{
            CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        };
        unsafe {
            let input = CRYPT_INTEGER_BLOB {
                cbData: data.len() as u32,
                pbData: data.as_ptr() as *mut u8,
            };
            let mut output = std::mem::zeroed();
            CryptProtectData(
                &input,
                windows_core::PCWSTR::null(),
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
            .map_err(|e| format!("DPAPI CryptProtectData: {e}"))?;
            let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
            windows::Win32::Foundation::LocalFree(Some(windows::Win32::Foundation::HLOCAL(
                output.pbData as *mut core::ffi::c_void,
            )));
            Ok(bytes)
        }
    }
}

/// Зашифровать секрет ключом AndroidKeyStore (мобильная ветка, duopulse-112):
/// на диске — base64-блоб "v1:…" от MobileKeystoreHelper.
#[cfg(target_os = "android")]
fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
    let plain = std::str::from_utf8(data).map_err(|_| "секрет не utf-8".to_string())?;
    let blob = keystore_call("seal", plain)?;
    Ok(blob.into_bytes())
}

/// Платформа без хранилища секретов (ни Windows, ни Android): честная ошибка,
/// silent-fallback с открытым текстом хуже отказа.
#[cfg(not(any(windows, target_os = "android")))]
fn protect(_data: &[u8]) -> Result<Vec<u8>, String> {
    Err("хранилище секретов доступно только на Windows/Android".into())
}

/// Расшифровать DPAPI-blob.
#[cfg(windows)]
fn unprotect(blob: &[u8]) -> Result<Vec<u8>, String> {
    {
        use windows::Win32::Security::Cryptography::{
            CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        };
        unsafe {
            let input = CRYPT_INTEGER_BLOB {
                cbData: blob.len() as u32,
                pbData: blob.as_ptr() as *mut u8,
            };
            let mut output = std::mem::zeroed();
            CryptUnprotectData(
                &input,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
            .map_err(|e| format!("DPAPI CryptUnprotectData: {e}"))?;
            let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
            windows::Win32::Foundation::LocalFree(Some(windows::Win32::Foundation::HLOCAL(
                output.pbData as *mut core::ffi::c_void,
            )));
            Ok(bytes)
        }
    }
}

/// Расшифровать блоб AndroidKeyStore (мобильная ветка).
#[cfg(target_os = "android")]
fn unprotect(blob: &[u8]) -> Result<Vec<u8>, String> {
    let text = std::str::from_utf8(blob).map_err(|_| "блоб секрета не utf-8".to_string())?;
    let plain = keystore_call("unseal", text)?;
    Ok(plain.into_bytes())
}

#[cfg(not(any(windows, target_os = "android")))]
fn unprotect(_blob: &[u8]) -> Result<Vec<u8>, String> {
    Err("хранилище секретов доступно только на Windows/Android".into())
}

/// Сохранить секрет по пути (шифруется DPAPI; каталог создаётся).
pub fn save(path: &Path, secret: &str) -> Result<(), String> {
    let blob = protect(secret.as_bytes())?;
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("создать каталог секрета: {e}"))?;
        }
    }
    std::fs::write(path, blob).map_err(|e| format!("записать {path:?}: {e}"))
}

/// Прочитать секрет: None — не задан или blob не читается.
pub fn load(path: &Path) -> Option<String> {
    let blob = std::fs::read(path).ok()?;
    let plain = unprotect(&blob).ok()?;
    String::from_utf8(plain).ok()
}

/// Удалить сохранённый секрет (идемпотентно).
pub fn clear(path: &Path) {
    let _ = std::fs::remove_file(path);
}

/// Есть ли файл секрета (UI показывает «сохранён»).
pub fn exists(path: &Path) -> bool {
    path.is_file()
}

/// Статический вызов MobileKeystoreHelper.seal/unseal (Android): ответ
/// «error: …» Kotlin уже погасил исключение — превращаем в Err.
#[cfg(target_os = "android")]
fn keystore_call(method: &str, arg: &str) -> Result<String, String> {
    crate::mobile_jni::with_jni(|env, context| {
        let helper =
            crate::mobile_jni::app_class(env, context, "dev.duopulse.mobile.MobileKeystoreHelper")?;
        let jarg = crate::mobile_jni::jstr(env, arg)?;
        let r = env
            .call_static_method(
                &helper,
                method,
                "(Landroid/content/Context;Ljava/lang/String;)Ljava/lang/String;",
                &[context.into(), (&jarg).into()],
            )
            .map_err(|e| format!("keystore {method}: {e}"))?
            .l()
            .map_err(|e| format!("keystore {method}: {e}"))?;
        let js = jni::objects::JString::from(r);
        let out = env
            .get_string(&js)
            .map(|s| s.to_string_lossy().into_owned())
            .map_err(|e| format!("keystore {method}: {e}"))?;
        if let Some(err) = out.strip_prefix("error: ") {
            return Err(format!("keystore {method}: {err}"));
        }
        Ok(out)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Дефолт целевой платформы — Windows (Cargo.toml/tauri); DPAPI-тест
    // имеет смысл только там.
    #[cfg(windows)]
    #[test]
    fn roundtrip_no_plaintext_on_disk() {
        let path = std::env::temp_dir().join(format!("duopulse-secret-{}.bin", std::process::id()));
        let _ = std::fs::remove_file(&path);

        assert!(!exists(&path));
        save(&path, "klíč wörд").unwrap();
        assert!(exists(&path));
        assert_eq!(load(&path).as_deref(), Some("klíč wörд"));

        let blob = std::fs::read(&path).unwrap();
        let head = &"klíč".as_bytes()[..4];
        assert!(
            !blob.windows(4).any(|w| w == head),
            "в blob нет открытого секрета"
        );

        clear(&path);
        assert!(!exists(&path));
        assert_eq!(load(&path), None);

        // save создаёт промежуточные каталоги (translate/keys/…)
        let nested = std::env::temp_dir()
            .join(format!("duopulse-secret-{}", std::process::id()))
            .join("keys")
            .join("deepl.bin");
        save(&nested, "k").unwrap();
        assert_eq!(load(&nested).as_deref(), Some("k"));
        let _ = std::fs::remove_dir_all(nested.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn load_missing_is_none_clear_is_noop() {
        let missing = std::env::temp_dir().join("duopulse-secret-missing.bin");
        assert_eq!(load(&missing), None);
        clear(&missing); // не паникует
        assert!(!exists(&missing));
    }
}
