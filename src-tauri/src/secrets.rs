//! DPAPI-хранилище секретов (docs/02 §9): на диске — только зашифрованный
//! CurrentUser-blob, открытого секрета нет. Общий код для пароля прокси
//! (vpn/proxy-pass.bin, задача 1.8 — прежде жил в proxy.rs) и ключей API
//! провайдеров перевода (translate/keys/*.bin, задача 4.1).

use std::path::Path;

/// Зашифровать секрет DPAPI (CurrentUser, без UI-промпта).
fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
    #[cfg(windows)]
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
    #[cfg(not(windows))]
    {
        let _ = data;
        Err("DPAPI доступен только на Windows".into())
    }
}

/// Расшифровать DPAPI-blob.
fn unprotect(blob: &[u8]) -> Result<Vec<u8>, String> {
    #[cfg(windows)]
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
    #[cfg(not(windows))]
    {
        let _ = blob;
        Err("DPAPI доступен только на Windows".into())
    }
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
