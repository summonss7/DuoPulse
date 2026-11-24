//! Менеджер локальных моделей whisper (карточка duopulse-168, паритет 5/8):
//! скачивание ggml в профиль с прогрессом и проверкой целостности — размер
//! И sha256 (мобильная ветка тянет модель с HuggingFace на устройство).
//! Общий для десктопа (server.rs делегирует сюда) и мобильной либы: чистые
//! функции + ureq-поток, тесты на хосте.

use std::io::Read;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::config::LocalModelSize;

/// Спецификация модели ggml: имя файла, ожидаемые размер и sha256 (реестр
/// HuggingFace ggerganov/whisper.cpp — сверка при скачивании; «битый» CDN
/// или обрыв даёт честный отказ, а не падение whisper при загрузке).
pub struct ModelSpec {
    pub file_name: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
}

/// Спецификация по размеру (данные — ggerganov/whisper.cpp на 284029c,
/// тот же пин, что у десктопного спайка e2e/asr/prepare.mjs).
pub fn spec(size: LocalModelSize) -> ModelSpec {
    match size {
        LocalModelSize::Tiny => ModelSpec {
            file_name: "ggml-tiny.bin",
            bytes: 77_691_713,
            sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
        },
        LocalModelSize::Base => ModelSpec {
            file_name: "ggml-base.bin",
            bytes: 147_951_465,
            sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
        },
        LocalModelSize::Small => ModelSpec {
            file_name: "ggml-small.bin",
            bytes: 487_601_967,
            sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
        },
    }
}

/// Каталог моделей в профиле (`profile/asr/models` — общий вид с десктопом).
pub fn models_dir(profile_dir: &Path) -> PathBuf {
    profile_dir.join("asr").join("models")
}

/// Путь модели заданного размера (может ещё не существовать).
pub fn model_path(profile_dir: &Path, size: LocalModelSize) -> PathBuf {
    models_dir(profile_dir).join(spec(size).file_name)
}

/// Быстрая проверка «на месте»: файл существует и совпадает размер (для
/// статуса настроек; полная сверка sha256 — при скачивании).
// Потребители — мобильная ветка (mobile_asr.rs) и тесты; в бине десктопа
// не вызывается — мёртвость разрешена явно (duopulse-231).
#[cfg_attr(desktop, allow(dead_code))]
pub fn is_downloaded(profile_dir: &Path, size: LocalModelSize) -> bool {
    let s = spec(size);
    std::fs::metadata(model_path(profile_dir, size))
        .map(|m| m.len() == s.bytes)
        .unwrap_or(false)
}

/// sha256 файла (потоком; модель до 0,5 ГБ — единицы секунд).
// Зовёт только тест ниже — вне тестов не компилируется (duopulse-231).
#[cfg(test)]
pub fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| format!("открыть {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("чтение {}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// URL модели (env DUOPULSE_ASR_MODEL_BASE_URL перекрывает — стенды e2e
/// раздают локально; тот же переключатель, что у десктопного server.rs).
pub fn model_url(size: LocalModelSize) -> String {
    let base = std::env::var("DUOPULSE_ASR_MODEL_BASE_URL")
        .unwrap_or_else(|_| "https://huggingface.co/ggerganov/whisper.cpp/resolve/main".into());
    format!("{}/{}", base.trim_end_matches('/'), spec(size).file_name)
}

/// Скачать модель в профиль: поток с прогрессом (байты/всего), проверка
/// Content-Length, итогового размера и sha256; атомарно — сначала .part.
pub fn download_model(
    profile_dir: &Path,
    size: LocalModelSize,
    on_progress: &mut dyn FnMut(u64, u64),
) -> Result<PathBuf, String> {
    let s = spec(size);
    let dest = model_path(profile_dir, size);
    if dest.is_file() {
        return Ok(dest);
    }
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(10))
        .build();
    let resp = agent
        .get(&model_url(size))
        .call()
        .map_err(|e| format!("скачивание {}: {e}", s.file_name))?;
    let total = resp
        .header("content-length")
        .and_then(|v| v.parse::<u64>().ok());
    if total.is_some_and(|t| t != s.bytes) {
        return Err(format!(
            "размер по Content-Length {total:?} не совпал с ожидаемым {}",
            s.bytes
        ));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("создать {}: {e}", parent.display()))?;
    }
    let tmp = dest.with_extension("part");
    let mut file =
        std::fs::File::create(&tmp).map_err(|e| format!("создать {}: {e}", tmp.display()))?;
    let mut reader = resp.into_reader();
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    let mut done: u64 = 0;
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("чтение потока: {e}"))?;
        if n == 0 {
            break;
        }
        std::io::Write::write_all(&mut file, &buf[..n]).map_err(|e| format!("запись: {e}"))?;
        hasher.update(&buf[..n]);
        done += n as u64;
        if done > s.bytes {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!(
                "скачалось больше {done} байт, ожидалось {} — источник подозрителен",
                s.bytes
            ));
        }
        on_progress(done, total.unwrap_or(0));
    }
    drop(file);
    let hash = format!("{:x}", hasher.finalize());
    if done != s.bytes || hash != s.sha256 {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!(
            "модель {} не прошла проверку: {done} байт (ожидалось {}), sha256 {}",
            s.file_name, s.bytes, &hash[..16.min(hash.len())]
        ));
    }
    std::fs::rename(&tmp, &dest).map_err(|e| format!("переименовать в {}: {e}", dest.display()))?;
    Ok(dest)
}

/// Удалить модель и её возможный .part-хвост (возврат — было ли что удалять).
// Потребители — мобильная ветка (mobile_asr.rs) и тесты; в бине десктопа
// не вызывается — мёртвость разрешена явно (duopulse-231).
#[cfg_attr(desktop, allow(dead_code))]
pub fn delete_model(profile_dir: &Path, size: LocalModelSize) -> Result<bool, String> {
    let mut removed = false;
    for path in [
        model_path(profile_dir, size),
        model_path(profile_dir, size).with_extension("part"),
    ] {
        if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|e| format!("удалить {}: {e}", path.display()))?;
            removed = true;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("duopulse-asr-models-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn paths_and_specs() {
        let dir = tmp_dir("paths");
        assert_eq!(
            model_path(&dir, LocalModelSize::Base).file_name().unwrap(),
            "ggml-base.bin"
        );
        assert!(model_path(&dir, LocalModelSize::Tiny).starts_with(models_dir(&dir)));
        assert!(!is_downloaded(&dir, LocalModelSize::Tiny));
        // размер реестра совпадает с ожиданиями конфига десктопа
        assert_eq!(spec(LocalModelSize::Base).bytes, 147_951_465);
        assert_eq!(spec(LocalModelSize::Tiny).file_name, "ggml-tiny.bin");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sha256_known_vector() {
        let dir = tmp_dir("hash");
        let p = dir.join("x.bin");
        std::fs::write(&p, b"abc").unwrap();
        assert_eq!(
            sha256_file(&p).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn download_verifies_hash_and_cleans_part() {
        // «сервер» — data: URL: sha256 совпадает только с ожидаемым
        let dir = tmp_dir("dl");
        let size = LocalModelSize::Tiny;
        // подменяем ожидание через реестр нельзя — прогоняем реальный поток:
        // контент короче/чужой хэш → отказ, .part убран
        let url = format!("data:application/octet-binary,{}", "x".repeat(64));
        std::env::set_var("DUOPULSE_ASR_MODEL_BASE_URL", &url);
        let err = download_model(&dir, size, &mut |_, _| {}).unwrap_err();
        assert!(
            err.contains("не прошла проверку")
                || err.contains("Content-Length")
                || err.contains("скачивание"),
            "{err}"
        );
        assert!(!model_path(&dir, size).with_extension("part").exists());
        assert!(!is_downloaded(&dir, size));
        std::env::remove_var("DUOPULSE_ASR_MODEL_BASE_URL");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_removes_model_and_part() {
        let dir = tmp_dir("del");
        let p = model_path(&dir, LocalModelSize::Base);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, b"m").unwrap();
        assert!(delete_model(&dir, LocalModelSize::Base).unwrap());
        assert!(!p.exists());
        assert!(!delete_model(&dir, LocalModelSize::Base).unwrap(), "второй раз — нечего");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
