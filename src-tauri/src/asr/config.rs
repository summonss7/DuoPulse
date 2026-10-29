//! Конфигурация ASR (карточка duopulse-060): ключ "asr" в settings.json —
//! включён ли ASR, выбранный движок (локальный whisper / OpenAI-совместимое
//! облако) и его несекретные параметры. Ключ API — ТОЛЬКО в DPAPI
//! (`profile/asr/keys/openai.bin`), по образцу перевода (translate/config.rs):
//! в settings.json его нет и рукописные игнорируются.

use std::path::{Path, PathBuf};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::secrets;

/// Движок распознавания (решение автора 29.10.2026 — гибрид; выбор в
/// настройках): локальный whisper.cpp (приватно, офлайн) или облачный
/// OpenAI-совместимый API (OpenAI / Groq / свой whisper-server).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AsrProviderId {
    Local,
    Openai,
}

/// Размер локальной модели whisper (спайк duopulse-060: base — компромисс
/// скорость/качество ru, small — лучшее качество, дольше счёт; tiny исключён
/// — ru WER 39 %).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Default)]
#[serde(rename_all = "lowercase")]
pub enum LocalModelSize {
    #[default]
    Base,
    Small,
}

impl LocalModelSize {
    /// Имя файла модели ggml (HuggingFace ggerganov/whisper.cpp).
    pub fn file_name(self) -> &'static str {
        match self {
            Self::Base => "ggml-base.bin",
            Self::Small => "ggml-small.bin",
        }
    }

    /// Ожидаемый размер скачивания, байт (проверка целостности по длине).
    pub fn bytes(self) -> u64 {
        match self {
            Self::Base => 147_951_465,
            Self::Small => 487_601_967,
        }
    }
}

fn default_openai_url() -> String {
    "https://api.openai.com/v1".into()
}

fn default_openai_model() -> String {
    "whisper-1".into()
}

/// Конфиг ASR в settings.json. Ключ API сюда НЕ пишется — только DPAPI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AsrConfig {
    /// ASR разрешён (кнопка «Распознать речь» в панели).
    pub enabled: bool,
    /// Выбранный движок.
    pub provider: AsrProviderId,
    /// Размер локальной модели whisper.
    #[serde(default)]
    pub local_model: LocalModelSize,
    /// Путь к whisper-server.exe (пусто — искать: профиль → рядом с приложением
    /// → скачивание по требованию).
    #[serde(default)]
    pub local_engine_path: String,
    /// Base URL OpenAI-совместимого API (без /audio/transcriptions).
    #[serde(default = "default_openai_url")]
    pub openai_base_url: String,
    /// Модель облачного провайдера (whisper-1, whisper-large-v3-turbo, …).
    #[serde(default = "default_openai_model")]
    pub openai_model: String,
}

impl Default for AsrConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: AsrProviderId::Local,
            local_model: LocalModelSize::Base,
            local_engine_path: String::new(),
            openai_base_url: default_openai_url(),
            openai_model: default_openai_model(),
        }
    }
}

impl AsrConfig {
    /// Валидация включённого режима: облаку нужен base URL http(s) и модель.
    pub fn validate(&self) -> Result<(), String> {
        if self.provider == AsrProviderId::Openai {
            let url = self.openai_base_url.trim();
            if url.is_empty() {
                return Err("адрес OpenAI-совместимого API не задан".into());
            }
            if !url.starts_with("http://") && !url.starts_with("https://") {
                return Err("адрес API должен начинаться с http:// или https://".into());
            }
            if self.openai_model.trim().is_empty() {
                return Err("модель облачного провайдера не задана".into());
            }
        }
        Ok(())
    }
}

/// Значение asr.get_settings для UI: конфиг + факт наличия ключа (сами ключи
/// наружу не отдаются) + состояние локального движка (exe/модель на месте).
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AsrSettings {
    pub enabled: bool,
    pub provider: AsrProviderId,
    pub local_model: LocalModelSize,
    pub local_engine_path: String,
    pub openai_base_url: String,
    pub openai_model: String,
    /// Ключ API облака сохранён (DPAPI).
    pub has_api_key: bool,
    /// whisper-server.exe найден (путь/профиль/рядом с exe).
    pub engine_found: bool,
    /// Модель локального движка скачана в профиль.
    pub model_downloaded: bool,
}

/// Читает settings.json (ключ "asr"); отсутствие/повреждённый файл → дефолт.
pub fn load_config(dir: &Path) -> AsrConfig {
    let raw = std::fs::read_to_string(dir.join("settings.json")).unwrap_or_default();
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|root| root.get("asr").cloned())
        .and_then(|a| serde_json::from_value(a).ok())
        .unwrap_or_default()
}

/// Пишет settings.json (заменяя только ключ "asr"); предыдущая версия — .bak.
pub fn save_config(dir: &Path, cfg: &AsrConfig) -> Result<(), String> {
    let path = dir.join("settings.json");
    let mut root: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    root["asr"] = serde_json::to_value(cfg).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("создать {dir:?}: {e}"))?;
    if path.exists() {
        let _ = std::fs::copy(&path, dir.join("settings.json.bak"));
    }
    let json = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("записать {path:?}: {e}"))
}

// --- ключ API облака — DPAPI --------------------------------------------------

fn api_key_path(dir: &Path) -> PathBuf {
    dir.join("asr").join("keys").join("openai.bin")
}

pub fn save_api_key(dir: &Path, key: &str) -> Result<(), String> {
    secrets::save(&api_key_path(dir), key)
}

pub fn load_api_key(dir: &Path) -> Option<String> {
    secrets::load(&api_key_path(dir))
}

pub fn clear_api_key(dir: &Path) {
    secrets::clear(&api_key_path(dir));
}

pub fn has_api_key(dir: &Path) -> bool {
    secrets::exists(&api_key_path(dir))
}

/// Снапшот настроек для UI (asr.get_settings).
pub fn settings_view(dir: &Path) -> AsrSettings {
    let cfg = load_config(dir);
    AsrSettings {
        engine_found: super::server::engine_exe_path(dir, &cfg).is_some(),
        model_downloaded: super::server::model_path(dir, cfg.local_model).is_file(),
        enabled: cfg.enabled,
        provider: cfg.provider,
        local_model: cfg.local_model,
        local_engine_path: cfg.local_engine_path,
        openai_base_url: cfg.openai_base_url,
        openai_model: cfg.openai_model,
        has_api_key: has_api_key(dir),
    }
}

/// Сохранить настройки (asr.set_settings): конфиг — settings.json, секрет —
/// ключ API в DPAPI (None — не менять, "" — удалить, строка — перезаписать).
pub fn save_settings(dir: &Path, cfg: &AsrConfig, secret: Option<&str>) -> Result<(), String> {
    if cfg.enabled {
        cfg.validate()?;
    }
    save_config(dir, cfg)?;
    match secret {
        None => {}
        Some("") => clear_api_key(dir),
        Some(key) => save_api_key(dir, key)?,
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("duopulse-asr-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn config_roundtrip_keeps_other_keys_and_bak() {
        let dir = tmp_dir("cfg");
        std::fs::write(
            dir.join("settings.json"),
            r#"{"proxy":{"enabled":false},"translate":{"enabled":false}}"#,
        )
        .unwrap();
        let cfg = AsrConfig {
            enabled: true,
            provider: AsrProviderId::Openai,
            local_model: LocalModelSize::Small,
            local_engine_path: String::new(),
            openai_base_url: "https://api.groq.com/openai/v1".into(),
            openai_model: "whisper-large-v3-turbo".into(),
        };
        save_config(&dir, &cfg).unwrap();
        assert_eq!(load_config(&dir), cfg);
        let raw = std::fs::read_to_string(dir.join("settings.json")).unwrap();
        assert!(
            raw.contains("\"translate\""),
            "прочие ключи сохранены: {raw}"
        );
        assert!(dir.join("settings.json.bak").is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_or_broken_file_gives_default_and_ignores_secrets() {
        let dir = tmp_dir("default");
        assert_eq!(load_config(&dir), AsrConfig::default());
        std::fs::write(
            dir.join("settings.json"),
            r#"{"asr":{"enabled":true,"provider":"openai","apiKey":"leak"}}"#,
        )
        .unwrap();
        let cfg = load_config(&dir);
        assert_eq!(cfg.provider, AsrProviderId::Openai);
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(!json.contains("leak"), "{json}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn validation_openai_needs_url_and_model() {
        let mut cfg = AsrConfig {
            enabled: true,
            provider: AsrProviderId::Openai,
            ..AsrConfig::default()
        };
        assert!(cfg.validate().is_ok(), "дефолтный URL валиден");
        cfg.openai_base_url = "  ".into();
        assert!(cfg.validate().is_err());
        cfg.openai_base_url = "ftp://x".into();
        assert!(cfg.validate().is_err());
        cfg.openai_base_url = "http://127.0.0.1:8080".into();
        cfg.openai_model = String::new();
        assert!(cfg.validate().is_err());
        cfg.openai_model = "whisper-1".into();
        assert!(cfg.validate().is_ok());
        // локальному провайдеру параметры не нужны
        cfg.provider = AsrProviderId::Local;
        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn save_settings_rejects_invalid_nothing_written() {
        let dir = tmp_dir("reject");
        let cfg = AsrConfig {
            enabled: true,
            provider: AsrProviderId::Openai,
            openai_base_url: String::new(),
            ..AsrConfig::default()
        };
        assert!(save_settings(&dir, &cfg, None).is_err());
        assert!(!dir.join("settings.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn secret_semantics_dpapi() {
        let dir = tmp_dir("secret");
        let cfg = AsrConfig::default();
        save_settings(&dir, &cfg, Some("k1")).unwrap();
        assert_eq!(load_api_key(&dir).as_deref(), Some("k1"));
        save_settings(&dir, &cfg, None).unwrap();
        assert_eq!(load_api_key(&dir).as_deref(), Some("k1"), "None не меняет");
        save_settings(&dir, &cfg, Some("")).unwrap();
        assert_eq!(load_api_key(&dir), None, "«» удаляет");
        assert!(has_api_key(&dir) == false);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
