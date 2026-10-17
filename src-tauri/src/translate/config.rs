//! Конфигурация перевода (задача 4.1, docs/03 §7): ключ "translate" в
//! settings.json — включён ли облачный перевод, выбранный провайдер и его
//! несекретные параметры (тариф DeepL, адрес LibreTranslate). Ключи API —
//! ТОЛЬКО в DPAPI (translate/keys/<provider>.bin), по образцу пароля прокси
//! (duopulse-009): в settings.json их нет и рукописные игнорируются.
//!
//! `%APPDATA%\DuoPulse\profile\translate\keys\{deepl,google,libretranslate}.bin`

use std::path::{Path, PathBuf};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::deepl::DeeplProvider;
use super::google::GoogleProvider;
use super::libre::LibreProvider;
use super::{TranslateError, TranslationProvider};
use crate::secrets;

/// Провайдер машинного перевода (docs/03 §7, приоритет 2–3: облачный API по
/// ключу пользователя или self-hosted LibreTranslate). Перевод самой
/// платформы (YouTube tlang, приоритет 1) сюда не входит.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ProviderId {
    Deepl,
    Google,
    Libretranslate,
}

impl ProviderId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Deepl => "deepl",
            Self::Google => "google",
            Self::Libretranslate => "libretranslate",
        }
    }

    pub const ALL: [ProviderId; 3] = [Self::Deepl, Self::Google, Self::Libretranslate];
}

/// Тариф DeepL: free — api-free.deepl.com (500 тыс. знаков/мес), pro —
/// api.deepl.com; отличается только хост эндпоинта.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Default)]
#[serde(rename_all = "lowercase")]
pub enum DeeplPlan {
    #[default]
    Free,
    Pro,
}

fn default_libre_url() -> String {
    "http://localhost:5000".into()
}

/// Конфиг перевода в settings.json. Ключи API сюда НЕ пишутся — только DPAPI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TranslateConfig {
    /// Облачный перевод разрешён (выкл — только переводы платформы, tlang).
    pub enabled: bool,
    /// Выбранный провайдер (панель «Перевод»).
    pub provider: ProviderId,
    /// Тариф DeepL (host free/pro).
    #[serde(default)]
    pub deepl_plan: DeeplPlan,
    /// Адрес self-hosted LibreTranslate (base URL, без /translate).
    #[serde(default = "default_libre_url")]
    pub libretranslate_url: String,
}

impl Default for TranslateConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: ProviderId::Deepl,
            deepl_plan: DeeplPlan::Free,
            libretranslate_url: default_libre_url(),
        }
    }
}

impl TranslateConfig {
    /// Валидация включённого режима: адрес LibreTranslate обязателен и
    /// обязан быть http(s). Прочим провайдерам параметров кроме ключа не нужно.
    pub fn validate(&self) -> Result<(), String> {
        if self.provider == ProviderId::Libretranslate {
            let url = self.libretranslate_url.trim();
            if url.is_empty() {
                return Err("адрес LibreTranslate не задан".into());
            }
            if !url.starts_with("http://") && !url.starts_with("https://") {
                return Err("адрес LibreTranslate должен начинаться с http:// или https://".into());
            }
        }
        Ok(())
    }
}

/// Значение translate.get_settings для UI: конфиг + факт наличия ключей в
/// DPAPI (сами ключи наружу не отдаются — как hasPassword прокси).
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TranslateSettings {
    pub enabled: bool,
    pub provider: ProviderId,
    pub deepl_plan: DeeplPlan,
    pub libretranslate_url: String,
    /// Провайдеры, у которых сохранён ключ API (DPAPI).
    pub has_api_keys: Vec<ProviderId>,
}

/// Читает settings.json (ключ "translate"); отсутствие/повреждённый файл →
/// дефолт. Рукописные ключи API в JSON игнорируются (источник — только DPAPI).
pub fn load_config(dir: &Path) -> TranslateConfig {
    let raw = std::fs::read_to_string(dir.join("settings.json")).unwrap_or_default();
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|root| root.get("translate").cloned())
        .and_then(|t| serde_json::from_value(t).ok())
        .unwrap_or_default()
}

/// Пишет settings.json (заменяя только ключ "translate", прочие — в т.ч.
/// "proxy" — сохраняются); предыдущая версия остаётся в .bak (docs/02 §8).
pub fn save_config(dir: &Path, cfg: &TranslateConfig) -> Result<(), String> {
    let path = dir.join("settings.json");
    let mut root: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    root["translate"] = serde_json::to_value(cfg).map_err(|e| e.to_string())?;

    std::fs::create_dir_all(dir).map_err(|e| format!("создать {dir:?}: {e}"))?;
    if path.exists() {
        let _ = std::fs::copy(&path, dir.join("settings.json.bak"));
    }
    let json = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("записать {path:?}: {e}"))
}

// --- ключи API — DPAPI -------------------------------------------------------

fn api_key_path(dir: &Path, provider: ProviderId) -> PathBuf {
    dir.join("translate")
        .join("keys")
        .join(format!("{}.bin", provider.as_str()))
}

pub fn save_api_key(dir: &Path, provider: ProviderId, key: &str) -> Result<(), String> {
    secrets::save(&api_key_path(dir, provider), key)
}

pub fn load_api_key(dir: &Path, provider: ProviderId) -> Option<String> {
    secrets::load(&api_key_path(dir, provider))
}

pub fn clear_api_key(dir: &Path, provider: ProviderId) {
    secrets::clear(&api_key_path(dir, provider));
}

pub fn has_api_key(dir: &Path, provider: ProviderId) -> bool {
    secrets::exists(&api_key_path(dir, provider))
}

/// Загруженные ключи всех провайдеров (для сборки выбранного).
#[derive(Debug, Clone, Default)]
pub struct ApiKeys {
    pub deepl: Option<String>,
    pub google: Option<String>,
    pub libretranslate: Option<String>,
}

impl ApiKeys {
    pub fn load(dir: &Path) -> Self {
        Self {
            deepl: load_api_key(dir, ProviderId::Deepl),
            google: load_api_key(dir, ProviderId::Google),
            libretranslate: load_api_key(dir, ProviderId::Libretranslate),
        }
    }

    fn of(&self, provider: ProviderId) -> Option<String> {
        match provider {
            ProviderId::Deepl => self.deepl.clone(),
            ProviderId::Google => self.google.clone(),
            ProviderId::Libretranslate => self.libretranslate.clone(),
        }
    }
}

/// Собрать выбранного провайдера с его ключом (нет обязательного ключа —
/// Config-ошибка: панель просит заполнить; ключ LibreTranslate не обязателен).
pub fn build_provider(
    cfg: &TranslateConfig,
    keys: &ApiKeys,
) -> Result<Box<dyn TranslationProvider>, TranslateError> {
    let non_empty = |k: Option<String>| k.filter(|k| !k.trim().is_empty());
    match cfg.provider {
        ProviderId::Deepl => {
            let key = non_empty(keys.of(ProviderId::Deepl)).ok_or_else(|| {
                TranslateError::Config("нет ключа DeepL — сохраните в панели «Перевод»".into())
            })?;
            Ok(Box::new(DeeplProvider::new(cfg.deepl_plan, key)))
        }
        ProviderId::Google => {
            let key = non_empty(keys.of(ProviderId::Google)).ok_or_else(|| {
                TranslateError::Config(
                    "нет ключа Google Translate — сохраните в панели «Перевод»".into(),
                )
            })?;
            Ok(Box::new(GoogleProvider::new(key)))
        }
        ProviderId::Libretranslate => Ok(Box::new(LibreProvider::new(
            cfg.libretranslate_url.trim().trim_end_matches('/'),
            non_empty(keys.of(ProviderId::Libretranslate)),
        ))),
    }
}

/// Снапшот настроек для UI (translate.get_settings).
pub fn settings_view(dir: &Path) -> TranslateSettings {
    let cfg = load_config(dir);
    let has_api_keys = ProviderId::ALL
        .into_iter()
        .filter(|p| has_api_key(dir, *p))
        .collect();
    TranslateSettings {
        enabled: cfg.enabled,
        provider: cfg.provider,
        deepl_plan: cfg.deepl_plan,
        libretranslate_url: cfg.libretranslate_url,
        has_api_keys,
    }
}

/// Сохранить настройки (translate.set_settings): конфиг — settings.json,
/// секрет — ключ API выбранного провайдера в DPAPI (None — не менять,
/// "" — удалить, строка — перезаписать).
pub fn save_settings(
    dir: &Path,
    cfg: &TranslateConfig,
    secret: Option<&str>,
) -> Result<(), String> {
    if cfg.enabled {
        cfg.validate()?;
    }
    save_config(dir, cfg)?;
    match secret {
        None => {}
        Some("") => clear_api_key(dir, cfg.provider),
        Some(key) => save_api_key(dir, cfg.provider, key)?,
    }
    Ok(())
}

/// Живая проверка выбранного провайдера (кнопка «Проверить», один запрос без
/// ретраев): переводит короткую фразу на целевой язык.
pub fn test_provider(dir: &Path, text: &str, target_lang: &str) -> Result<String, TranslateError> {
    let cfg = load_config(dir);
    let provider = build_provider(&cfg, &ApiKeys::load(dir))?;
    eprintln!(
        "[translate] test: провайдер {} ({})",
        provider.id().as_str(),
        if cfg.enabled {
            "вкл"
        } else {
            "выкл в конфиге"
        }
    );
    let transport = super::UreqTransport::new();
    let req = super::TranslateRequest {
        texts: vec![text.to_string()],
        source_lang: String::new(), // автоопределение языка фразы
        target_lang: target_lang.to_string(),
        context_before: None,
    };
    let one_attempt = super::RetryPolicy {
        max_attempts: 1,
        base_delay_ms: 0,
    };
    super::translate_with_retries(provider.as_ref(), &transport, &req, &one_attempt).and_then(
        |mut out| {
            out.pop()
                .ok_or_else(|| TranslateError::BadResponse("пустой ответ провайдера".into()))
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("duopulse-tr-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn config_roundtrip_keeps_other_keys_and_bak() {
        let dir = tmp_dir("cfg");
        // settings.json уже содержит ключ proxy — он обязан пережить запись
        std::fs::write(
            dir.join("settings.json"),
            r#"{"proxy":{"enabled":false,"proto":"socks5","host":"h","port":1080}}"#,
        )
        .unwrap();
        let cfg = TranslateConfig {
            enabled: true,
            provider: ProviderId::Google,
            deepl_plan: DeeplPlan::Pro,
            libretranslate_url: "http://lt.local:5055".into(),
        };
        save_config(&dir, &cfg).unwrap();
        assert_eq!(load_config(&dir), cfg);

        let raw = std::fs::read_to_string(dir.join("settings.json")).unwrap();
        assert!(raw.contains("\"proxy\""), "прочие ключи сохранены: {raw}");
        assert!(
            dir.join("settings.json.bak").is_file(),
            "копия .bak создана"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn injected_api_key_in_json_is_ignored() {
        let dir = tmp_dir("inject");
        std::fs::write(
            dir.join("settings.json"),
            r#"{"translate":{"enabled":true,"provider":"deepl","deeplPlan":"free",
                "libretranslateUrl":"http://x","apiKey":"secret","api_key":"secret2"}}"#,
        )
        .unwrap();
        let cfg = load_config(&dir);
        assert_eq!(cfg.provider, ProviderId::Deepl);
        // сериализация конфига наружу не содержит ключей — их поля и нет в схеме
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(!json.contains("secret"), "{json}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn broken_or_missing_file_gives_default() {
        let dir = tmp_dir("default");
        assert_eq!(load_config(&dir), TranslateConfig::default());
        std::fs::write(dir.join("settings.json"), "{ не json").unwrap();
        assert_eq!(load_config(&dir), TranslateConfig::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn validation_requires_libre_url_when_enabled_libre() {
        let mut cfg = TranslateConfig {
            enabled: true,
            provider: ProviderId::Libretranslate,
            deepl_plan: DeeplPlan::Free,
            libretranslate_url: "  ".into(),
        };
        assert!(cfg.validate().is_err());
        cfg.libretranslate_url = "ftp://x".into();
        assert!(cfg.validate().is_err());
        cfg.libretranslate_url = "http://lt.local".into();
        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn validation_off_writes_to_tmp() {
        let dir = tmp_dir("off");
        let cfg = TranslateConfig {
            enabled: false,
            provider: ProviderId::Libretranslate,
            deepl_plan: DeeplPlan::Free,
            libretranslate_url: String::new(),
        };
        assert!(save_settings(&dir, &cfg, None).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_settings_enabled_invalid_config_rejected_nothing_written() {
        let dir = tmp_dir("reject");
        let cfg = TranslateConfig {
            enabled: true,
            provider: ProviderId::Libretranslate,
            deepl_plan: DeeplPlan::Free,
            libretranslate_url: String::new(),
        };
        assert!(save_settings(&dir, &cfg, None).is_err());
        assert!(
            !dir.join("settings.json").exists(),
            "невалидное не сохраняется"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn api_keys_dpapi_per_provider() {
        let dir = tmp_dir("keys");
        assert!(settings_view(&dir).has_api_keys.is_empty());
        save_api_key(&dir, ProviderId::Deepl, "dl-key").unwrap();
        save_api_key(&dir, ProviderId::Google, "g-key").unwrap();
        let view = settings_view(&dir);
        assert!(view.has_api_keys.contains(&ProviderId::Deepl));
        assert!(view.has_api_keys.contains(&ProviderId::Google));
        assert!(!view.has_api_keys.contains(&ProviderId::Libretranslate));
        assert_eq!(
            load_api_key(&dir, ProviderId::Deepl).as_deref(),
            Some("dl-key")
        );

        // ключи не в settings.json — только DPAPI-blob
        let raw = std::fs::read_to_string(dir.join("settings.json")).unwrap_or_default();
        assert!(!raw.contains("dl-key"), "{raw}");

        // build_provider без ключа — Config; с ключом — собирается
        let cfg = TranslateConfig {
            enabled: true,
            provider: ProviderId::Google,
            ..TranslateConfig::default()
        };
        assert!(matches!(
            build_provider(&cfg, &ApiKeys::load(&dir)).map(|p| p.id()),
            Ok(ProviderId::Google)
        ));
        let cfg_deepl = TranslateConfig {
            provider: ProviderId::Deepl,
            ..cfg
        };
        assert!(build_provider(&cfg_deepl, &ApiKeys::default()).is_err());

        clear_api_key(&dir, ProviderId::Google);
        assert!(!settings_view(&dir)
            .has_api_keys
            .contains(&ProviderId::Google));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn secret_semantics_of_save_settings() {
        let dir = tmp_dir("secret");
        let cfg = TranslateConfig {
            provider: ProviderId::Google,
            enabled: false,
            ..TranslateConfig::default()
        };

        // None — не трогает ключ (на windows проверяем фактически)
        #[cfg(windows)]
        {
            save_settings(&dir, &cfg, Some("k1")).unwrap();
            assert_eq!(
                load_api_key(&dir, ProviderId::Google).as_deref(),
                Some("k1")
            );
            save_settings(&dir, &cfg, None).unwrap();
            assert_eq!(
                load_api_key(&dir, ProviderId::Google).as_deref(),
                Some("k1"),
                "None не меняет ключ"
            );
            save_settings(&dir, &cfg, Some("k2")).unwrap();
            assert_eq!(
                load_api_key(&dir, ProviderId::Google).as_deref(),
                Some("k2")
            );
            save_settings(&dir, &cfg, Some("")).unwrap();
            assert_eq!(load_api_key(&dir, ProviderId::Google), None, "«» удаляет");
        }
        #[cfg(not(windows))]
        {
            // не-windows: сохранение секретов недоступно, конфиг пишется
            assert!(save_settings(&dir, &cfg, None).is_ok());
            assert!(save_settings(&dir, &cfg, Some("")).is_ok());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
