//! Экспорт cookie профиля WebView2 в Netscape-файл для yt-dlp (карточка
//! duopulse-118): анонимный yt-dlp на «подмоченных» IP получает «Sign in to
//! confirm you're not a bot» — куки приложения (юзер смотрит YouTube в
//! DuoPulse) дают живую сессию. Файл кладётся в profile/dl/cookies.txt и
//! передаётся --cookies; отсутствие/неудача расшифровки — НЕ ошибка: yt-dlp
//! стартует без кук (чистый IP работает анонимно).
//!
//! Источники: <userdata>/EBWebView/Default/Cookies (SQLite; читаем КОПИЮ —
//! базу держит процесс WebView2) и <userdata>/Local State (os_crypt.
//! encrypted_key → DPAPI → ключ AES-256-GCM). Версии v10/v11 — AES-GCM с этим
//! ключом; v20 (app-bound, новые Chrome) — не расшифровываем, пропускаем.

use std::path::{Path, PathBuf};

/// Каталог данных WebView2 приложения (EBWebView внутри). identifier профиля
/// — dev.duopulse.spike (tauri.conf.json), WebView2 складывает данные в
/// %LOCALAPPDATA%/<identifier>.
fn webview2_data_dir() -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?;
    let dir = local.join("dev.duopulse.spike");
    dir.join("EBWebView").is_dir().then_some(dir)
}

/// Ключ os_crypt: Local State → os_crypt.encrypted_key (base64, префикс
/// "DPAPI") → CryptUnprotectData → 32 байта AES.
fn os_crypt_key(dir: &Path) -> Result<Vec<u8>, String> {
    let raw = std::fs::read_to_string(dir.join("Local State"))
        .map_err(|e| format!("Local State: {e}"))?;
    let root: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("Local State json: {e}"))?;
    let b64 = root
        .get("os_crypt")
        .and_then(|c| c.get("encrypted_key"))
        .and_then(|v| v.as_str())
        .ok_or("нет os_crypt.encrypted_key")?;
    let blob = base64_decode(b64).ok_or("encrypted_key не base64")?;
    let blob = blob.strip_prefix(b"DPAPI").ok_or("encrypted_key без DPAPI-префикса")?;
    dpapi_unprotect(blob)
}

fn dpapi_unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
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
        .map_err(|e| format!("DPAPI: {e}"))?;
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        windows::Win32::Foundation::LocalFree(Some(windows::Win32::Foundation::HLOCAL(
            output.pbData as *mut core::ffi::c_void,
        )));
        Ok(bytes)
    }
}

/// Минимальный base64 (алфавит стандартный, паддинг опционален).
fn base64_decode(input: &str) -> Option<Vec<u8>> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut acc = 0u32;
    let mut bits = 0u32;
    let mut out = Vec::new();
    for &b in input.as_bytes() {
        if b == b'=' || b == b'\n' || b == b'\r' {
            continue;
        }
        let v = TABLE.iter().position(|&t| t == b)? as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

/// Расшифровать encrypted_value куки: v10/v11 — AES-256-GCM (nonce 12 байт
/// после префикса, шифротекст с tag в хвосте); прочее — пропуск.
fn decrypt_cookie(encrypted: &[u8], key: &[u8]) -> Option<String> {
    if encrypted.len() < 3 + 12 + 16 || key.len() != 32 {
        return None;
    }
    let version = &encrypted[..3];
    if version != b"v10" && version != b"v11" {
        return None; // v20 (app-bound) — не расшифровываем
    }
    let nonce = &encrypted[3..15];
    let ciphertext = &encrypted[15..];
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};
    let cipher = Aes256Gcm::new_from_slice(key).ok()?;
    let plain = cipher.decrypt(Nonce::from_slice(nonce), ciphertext).ok()?;
    String::from_utf8(plain).ok()
}

/// Собрать cookies.txt (Netscape) для доменов YouTube/Google. Ok(None) —
/// кук нет/не вышло: запуск без --cookies.
pub fn export_for_ytdlp(profile_dl_dir: &Path) -> Option<PathBuf> {
    let dir = webview2_data_dir()?;
    let key = os_crypt_key(&dir).ok()?;
    // база залочена процессом — читаем копию
    let cookies_db = dir.join("EBWebView").join("Default").join("Cookies");
    if !cookies_db.is_file() {
        return None;
    }
    let tmp = std::env::temp_dir().join(format!("duopulse-cookies-{}.sqlite", std::process::id()));
    std::fs::copy(&cookies_db, &tmp).ok()?;
    let rows = read_cookies(&tmp);
    let _ = std::fs::remove_file(&tmp);
    let key = &key;
    let mut lines: Vec<String> = Vec::new();
    for (host, name, value, encrypted, path, expires_utc, is_secure) in rows {
        if !host.contains("youtube.com") && !host.contains("google.com") {
            continue;
        }
        let value = if !value.is_empty() {
            Some(value)
        } else {
            decrypt_cookie(&encrypted, key)
        };
        let Some(value) = value else { continue };
        if value.is_empty() {
            continue;
        }
        let subdomains = if host.starts_with('.') { "TRUE" } else { "FALSE" };
        // Chrome-эпоха: микросекунды с 1601-01-01 → unix (0/просроченные — сессия)
        let expires_unix = expires_utc.map(|us| (us / 1_000_000).saturating_sub(11_644_473_600)).unwrap_or(0);
        let line = format!(
            "{host}\t{subdomains}\t{path}\t{secure}\t{expires}\t{name}\t{value}",
            path = if path.is_empty() { "/" } else { &path },
            secure = if is_secure { "TRUE" } else { "FALSE" },
            expires = if expires_unix > 0 { expires_unix.to_string() } else { "0".into() },
        );
        lines.push(line);
    }
    if lines.is_empty() {
        return None;
    }
    let out = profile_dl_dir.join("cookies.txt");
    let body = String::from("# Netscape HTTP Cookie File\n") + &lines.join("\n") + "\n";
    std::fs::write(&out, body).ok()?;
    Some(out)
}

/// SQLite-чтение без rusqlite в зависимостях модуля download нельзя — rusqlite
/// уже в зависимостях десктопа (bundled); читаем копию базы только на чтение.
fn read_cookies(db: &Path) -> Vec<(String, String, String, Vec<u8>, String, Option<i64>, bool)> {
    use rusqlite::Connection;
    let Ok(conn) = Connection::open_with_flags(
        db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) else {
        return Vec::new();
    };
    let mut stmt = match conn.prepare(
        "SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure \
         FROM cookies",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0).unwrap_or_default(),
            r.get::<_, String>(1).unwrap_or_default(),
            r.get::<_, String>(2).unwrap_or_default(),
            r.get::<_, Vec<u8>>(3).unwrap_or_default(),
            r.get::<_, String>(4).unwrap_or_default(),
            r.get::<_, Option<i64>>(5).ok().flatten(),
            r.get::<_, i64>(6).map(|v| v != 0).unwrap_or(false),
        ))
    });
    match rows {
        Ok(rows) => rows.flatten().collect(),
        Err(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_minimal() {
        assert_eq!(base64_decode("QQ==").unwrap(), b"A");
        assert_eq!(base64_decode("QUJD").unwrap(), b"ABC");
        assert_eq!(base64_decode("YWJjZA==").unwrap(), b"abcd");
        assert!(base64_decode("!!").is_none());
    }

    #[test]
    fn decrypt_rejects_short_and_unknown_versions() {
        assert!(decrypt_cookie(b"v10", &[0u8; 32]).is_none());
        assert!(decrypt_cookie(b"v20__nonce__ciphertext", &[0u8; 32]).is_none());
        // валидная длина v20 — тоже пропуск (app-bound не поддержан)
        let mut blob = b"v20".to_vec();
        blob.extend_from_slice(&[0u8; 12 + 16 + 5]);
        assert!(decrypt_cookie(&blob, &[0u8; 32]).is_none());
    }
}
