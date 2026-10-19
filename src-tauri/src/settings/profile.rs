//! Экспорт/импорт профиля одним файлом (задача 5.1, DoD «переезд на чистую
//! машину за 1 файл»): настройки (весь settings.json), закладки, история,
//! кэш переводов; секреты (пароль прокси, ключи API — DPAPI на машине
//! источника) — только по явному выбору с предупреждением: в файле они
//! лежат открытым текстом, файл предназначен для переноса и хранения самим
//! пользователем.
//!
//! Формат: JSON, метка формата `duopulseProfile: 1` + версия приложения и
//! время создания. Читатель обязан переживать неизвестные поля (serde-
//! default) — файл от более новой версии импортирует то, что понятно.
//!
//! Секреты при импорте кладутся в DPAPI новой машины (CurrentUser-blob
//! источника на ней не расшифровывается — переносим расшифрованное значение).
//! Импорт идемпотентен: визиты-дубликаты (url+время) пропускаются, закладки
//! и строки кэша — upsert по ключу.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::history::{HistoryStore, VisitRow};
use crate::subtitles::cache::{TrackRow, TranslationsCache};
use crate::translate;
use crate::{history, proxy};

/// Метка формата файла профиля (несовместимые изменения формата — инкремент).
pub const PROFILE_FORMAT: u32 = 1;

/// Числа отчёта экспорта/импорта (страница настроек показывает их пользователю).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(default, rename_all = "camelCase")]
pub struct ProfileCounts {
    /// Разделы настроек, попавшие в файл/применённые из него.
    pub settings_sections: u32,
    pub bookmarks: u32,
    pub visits: u32,
    pub translated_tracks: u32,
    /// Секретов в файле/записано при импорте (0 — файл без секретов).
    pub secrets: u32,
}

/// Файл профиля (сериализация наружу — как есть; десериализация — снисходительная).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileFile {
    pub duopulse_profile: u32,
    pub app_version: String,
    /// Время создания файла, unix-ms.
    pub created_at: i64,
    /// Корень settings.json машины-источника (секретов в нём нет — DPAPI).
    pub settings: serde_json::Value,
    pub bookmarks: Vec<history::HistoryBookmark>,
    pub visits: Vec<VisitRow>,
    pub translated_tracks: Vec<TrackRow>,
    /// Секреты открытым текстом — только при экспорте с явного согласия.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secrets: Option<ProfileSecrets>,
}

/// Секреты профиля (открытым текстом в файле — только по явному выбору).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProfileSecrets {
    /// Пароль внешнего прокси (None — не задан на источнике).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_password: Option<String>,
    /// Ключи API провайдеров перевода: id провайдера → ключ.
    pub translate_api_keys: std::collections::BTreeMap<String, String>,
}

/// Разделы settings.json, переносимые профилем: неизвестные (от более новой
/// версии файла) пропускаются; переносимые парсятся в свои типы — невалидный
/// раздел = отказ импорта до любых записей (файл машины-приёмника не трогаем).
const PORTABLE_SETTINGS_KEYS: &[&str] = &[
    "proxy",
    "translate",
    "adblock",
    "search",
    "subtitles",
    "appearance",
    "privacy",
    "updater",
];

/// Прочитать файл профиля (снисходительно к неизвестным полям).
pub fn parse_file(raw: &str) -> Result<ProfileFile, String> {
    let file: ProfileFile =
        serde_json::from_str(raw).map_err(|e| format!("файл профиля не читается: {e}"))?;
    if file.duopulse_profile != PROFILE_FORMAT {
        return Err(format!(
            "неподдерживаемая версия файла профиля: {} (ожидается {PROFILE_FORMAT})",
            file.duopulse_profile
        ));
    }
    Ok(file)
}

/// Отчёт-счётчики содержимого файла (экспорт показывает их пользователю).
pub fn counts_of(file: &ProfileFile) -> ProfileCounts {
    ProfileCounts {
        settings_sections: PORTABLE_SETTINGS_KEYS
            .iter()
            .filter(|k| file.settings.get(*k).is_some())
            .count() as u32,
        bookmarks: file.bookmarks.len() as u32,
        visits: file.visits.len() as u32,
        translated_tracks: file.translated_tracks.len() as u32,
        secrets: file.secrets.as_ref().map_or(0, |s| {
            s.proxy_password.as_deref().map_or(0, |_| 1) + s.translate_api_keys.len() as u32
        }),
    }
}

/// Собрать файл профиля из живых хранилищ. `include_secrets` — явный выбор
/// пользователя (UI предупреждает: секреты попадут в файл открытым текстом).
pub fn build(
    dir: &std::path::Path,
    history: &HistoryStore,
    cache: &TranslationsCache,
    include_secrets: bool,
) -> Result<ProfileFile, String> {
    let settings = super::load_root(dir);
    let secrets = if include_secrets {
        let mut keys = std::collections::BTreeMap::new();
        for provider in translate::ProviderId::ALL {
            if let Some(key) = translate::config::load_api_key(dir, provider) {
                if !key.is_empty() {
                    keys.insert(provider.as_str().to_string(), key);
                }
            }
        }
        Some(ProfileSecrets {
            proxy_password: proxy::load_password(dir).filter(|p| !p.is_empty()),
            translate_api_keys: keys,
        })
    } else {
        None
    };
    Ok(ProfileFile {
        duopulse_profile: PROFILE_FORMAT,
        app_version: env!("CARGO_PKG_VERSION").into(),
        created_at: now_ms(),
        settings,
        bookmarks: history.dump_bookmarks()?,
        visits: history.dump_visits()?,
        translated_tracks: cache.dump()?,
        secrets,
    })
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Итог импорта: отчёт + нужен ли перезапуск (прокси применяется аргументами
/// WebView2 только на старте — docs/02 §6.1).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(default, rename_all = "camelCase")]
pub struct ImportOutcome {
    pub counts: ProfileCounts,
    /// Файл содержал секреты (применены в DPAPI).
    pub has_secrets: bool,
    /// Импортирован раздел proxy — аргументы применятся со следующего старта.
    pub needs_restart: bool,
}

/// Применить файл профиля к живым хранилищам. Порядок: сначала полная
/// валидация переносимых разделов настроек (невалидный файл ничего не меняет),
/// затем настройки, секреты, закладки, история, кэш.
pub fn apply(
    dir: &std::path::Path,
    file: &ProfileFile,
    history: &HistoryStore,
    cache: &TranslationsCache,
) -> Result<ImportOutcome, String> {
    // 1) валидация переносимых разделов до любых записей
    let mut sections = 0u32;
    let mut has_proxy = false;
    for key in PORTABLE_SETTINGS_KEYS {
        let Some(value) = file.settings.get(key) else {
            continue;
        };
        match *key {
            "proxy" => {
                let cfg: proxy::ProxyConfig = serde_json::from_value(value.clone())
                    .map_err(|e| format!("раздел proxy в файле не читается: {e}"))?;
                if cfg.enabled {
                    cfg.validate().map_err(|e| format!("proxy в файле: {e}"))?;
                }
                has_proxy = true;
            }
            "translate" => {
                let cfg: translate::TranslateConfig = serde_json::from_value(value.clone())
                    .map_err(|e| format!("раздел translate в файле не читается: {e}"))?;
                if cfg.enabled {
                    cfg.validate()
                        .map_err(|e| format!("translate в файле: {e}"))?;
                }
            }
            "search" => {
                serde_json::from_value::<super::SearchConfig>(value.clone())
                    .map_err(|e| format!("раздел search в файле не читается: {e}"))?;
            }
            "updater" => {
                serde_json::from_value::<super::UpdaterConfig>(value.clone())
                    .map_err(|e| format!("раздел updater в файле не читается: {e}"))?;
            }
            "subtitles" => {
                serde_json::from_value::<super::SubtitlesConfig>(value.clone())
                    .map_err(|e| format!("раздел subtitles в файле не читается: {e}"))?;
            }
            "appearance" | "privacy" | "adblock" => {
                // свободная форма JSON-объектов (adblock — BTreeSet/bool,
                // appearance/privacy — свои типы; строгая проверка не критична,
                // их читатели снисходительны)
                if !value.is_object() {
                    return Err(format!("раздел {key} в файле — не объект"));
                }
            }
            _ => unreachable!("список ключей фиксирован"),
        }
        sections += 1;
    }

    // 2) настройки: только переносимые ключи, прочие ключи локального файла
    //    (settingsVersion и т.п.) сохраняются
    let mut counts = ProfileCounts {
        settings_sections: sections,
        ..ProfileCounts::default()
    };
    for key in PORTABLE_SETTINGS_KEYS {
        if let Some(value) = file.settings.get(key) {
            super::write_key(dir, key, value)?;
        }
    }
    // версия схемы — текущая приложения (миграции на старте подхватят)
    super::write_key(
        dir,
        "settingsVersion",
        &serde_json::json!(super::SETTINGS_SCHEMA_VERSION),
    )?;

    // 3) секреты → DPAPI
    let mut has_secrets = false;
    if let Some(secrets) = &file.secrets {
        if let Some(password) = secrets.proxy_password.as_deref().filter(|p| !p.is_empty()) {
            proxy::save_password(dir, password)?;
            counts.secrets += 1;
        }
        for (provider_id, key) in &secrets.translate_api_keys {
            let provider = translate::ProviderId::ALL
                .into_iter()
                .find(|p| p.as_str() == provider_id)
                .ok_or_else(|| format!("в файле ключ неизвестного провайдера: {provider_id}"))?;
            if key.is_empty() {
                continue;
            }
            translate::config::save_api_key(dir, provider, key)?;
            counts.secrets += 1;
        }
        has_secrets = true;
    }

    // 4) данные
    counts.bookmarks = history.import_bookmarks(&file.bookmarks)?;
    counts.visits = history.import_visits(&file.visits)?;
    counts.translated_tracks = cache.import_rows(&file.translated_tracks)?;

    Ok(ImportOutcome {
        counts,
        has_secrets,
        needs_restart: has_proxy,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subtitles::cache::TrackRow;
    use crate::subtitles::Cue;

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("duopulse-profile-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// DoD 5.1: машина A (настройки+закладки+история+кэш+секрет) → файл →
    /// машина B с чистым профилем → импорт → всё на месте.
    #[test]
    fn clean_machine_roundtrip_one_file() {
        let dir_a = tmp_dir("a");
        let dir_b = tmp_dir("b");

        // машина A: настройки всех разделов + секреты
        proxy::save_config(
            &dir_a,
            &proxy::ProxyConfig {
                enabled: true,
                proto: proxy::ProxyProto::Http,
                host: "p.example".into(),
                port: 3128,
                login: Some("user".into()),
            },
        )
        .unwrap();
        crate::settings::save_search(
            &dir_a,
            &crate::settings::SearchConfig {
                engine: crate::settings::SearchEngine::Bing,
            },
        )
        .unwrap();
        crate::settings::save_subtitles(
            &dir_a,
            &crate::settings::SubtitlesConfig {
                default_translation_lang: "es".into(),
                style: crate::settings::SubtitlesStyleDefaults {
                    font_scale_pct: 130,
                    ..crate::settings::SubtitlesStyleDefaults::default()
                },
            },
        )
        .unwrap();
        crate::settings::save_privacy(
            &dir_a,
            &crate::settings::PrivacyConfig {
                clear_history_on_exit: true,
            },
        )
        .unwrap();
        #[cfg(windows)]
        proxy::save_password(&dir_a, "p@ss").unwrap();
        #[cfg(windows)]
        translate::config::save_api_key(&dir_a, translate::ProviderId::Deepl, "dl-key").unwrap();

        let hist_a = history::HistoryStore::open(&dir_a).unwrap();
        hist_a.visit("https://a.example/", "A").unwrap();
        hist_a.bookmark_add("https://b.example/", "B").unwrap();
        let cache_a = TranslationsCache::open(&dir_a).unwrap();
        cache_a.put(
            "yt:v1",
            "yt:en",
            "ru",
            "deepl",
            &[Cue {
                start_ms: 0,
                end_ms: 1,
                text: "привет".into(),
            }],
            10,
        );

        // экспорт с секретами
        let file = build(&dir_a, &hist_a, &cache_a, true).unwrap();
        assert!(file.secrets.is_some());
        let raw = serde_json::to_string_pretty(&file).unwrap();
        assert!(raw.contains("\"bookmarks\"") && raw.contains("\"visits\""));

        // машина B: чистый профиль + пустые хранилища
        let hist_b = history::HistoryStore::open(&dir_b).unwrap();
        let cache_b = TranslationsCache::open(&dir_b).unwrap();
        let parsed = parse_file(&raw).unwrap();
        let outcome = apply(&dir_b, &parsed, &hist_b, &cache_b).unwrap();
        assert_eq!(
            outcome.counts.settings_sections, 4,
            "proxy+search+subtitles+privacy"
        );
        assert_eq!(outcome.counts.bookmarks, 1);
        assert_eq!(outcome.counts.visits, 1);
        assert_eq!(outcome.counts.translated_tracks, 1);
        assert!(outcome.needs_restart, "proxy переехал — нужен перезапуск");
        #[cfg(windows)]
        {
            assert_eq!(outcome.counts.secrets, 2, "пароль + ключ DeepL");
            assert_eq!(proxy::load_password(&dir_b).as_deref(), Some("p@ss"));
            assert_eq!(
                translate::config::load_api_key(&dir_b, translate::ProviderId::Deepl).as_deref(),
                Some("dl-key")
            );
        }
        // настройки на месте
        assert_eq!(proxy::load_config(&dir_b).host, "p.example");
        assert_eq!(
            crate::settings::load_search(&dir_b).engine,
            crate::settings::SearchEngine::Bing
        );
        assert_eq!(
            crate::settings::load_subtitles(&dir_b).default_translation_lang,
            "es"
        );
        assert!(crate::settings::load_privacy(&dir_b).clear_history_on_exit);
        assert_eq!(
            crate::settings::load_root(&dir_b)["settingsVersion"],
            serde_json::json!(crate::settings::SETTINGS_SCHEMA_VERSION)
        );
        // данные на месте
        assert_eq!(hist_b.list("", 0, 100).unwrap().1, 1);
        assert_eq!(hist_b.bookmark_list("", 0, 100).unwrap().1, 1);
        assert!(
            cache_b.get("yt:v1", "yt:en", "ru", "deepl", 20).is_some(),
            "повторный просмотр на машине B — из кэша"
        );

        // повторный импорт того же файла — идемпотентен
        let again = apply(&dir_b, &parsed, &hist_b, &cache_b).unwrap();
        assert_eq!(again.counts.visits, 0, "дубликаты скипнуты");
        assert_eq!(hist_b.list("", 0, 100).unwrap().1, 1);

        // экспорт БЕЗ секретов: файла хватает на переезд настроек/данных,
        // секретов в файле нет
        let plain = build(&dir_a, &hist_a, &cache_a, false).unwrap();
        assert!(plain.secrets.is_none());
        assert!(!serde_json::to_string(&plain).unwrap().contains("p@ss"));

        let _ = std::fs::remove_dir_all(&dir_a);
        let _ = std::fs::remove_dir_all(&dir_b);
    }

    #[test]
    fn invalid_file_changes_nothing() {
        let dir = tmp_dir("invalid");
        let hist = history::HistoryStore::open(&dir).unwrap();
        let cache = TranslationsCache::open(&dir).unwrap();

        // не-JSON и чужая версия формата — отказ
        assert!(parse_file("{ не json").is_err());
        assert!(parse_file(r#"{"duopulseProfile":99}"#).is_err());

        // валидный формат, но битой proxy — отказ ДО записей: файл профиля
        // настроек не меняется, история/кэш не трогаются
        let file = ProfileFile {
            duopulse_profile: PROFILE_FORMAT,
            app_version: "test".into(),
            created_at: 1,
            settings: serde_json::json!({
                "proxy": {"enabled": true, "proto": "socks5", "host": "  ", "port": 1080}
            }),
            bookmarks: vec![],
            visits: vec![],
            translated_tracks: vec![],
            secrets: None,
        };
        assert!(apply(&dir, &file, &hist, &cache).is_err());
        assert!(
            !dir.join("settings.json").exists()
                || crate::settings::load_root(&dir).get("proxy").is_none(),
            "невалидный раздел не применяется"
        );

        // пустые ключи строк кэша пропускаются, не роняют импорт
        let file = ProfileFile {
            duopulse_profile: PROFILE_FORMAT,
            app_version: "test".into(),
            created_at: 1,
            settings: serde_json::json!({}),
            bookmarks: vec![],
            visits: vec![],
            translated_tracks: vec![TrackRow {
                video_key: String::new(),
                track_id: "t".into(),
                target_lang: "ru".into(),
                provider: "deepl".into(),
                cues: "[]".into(),
                cue_count: 0,
                last_used_at: 1,
            }],
            secrets: None,
        };
        let outcome = apply(&dir, &file, &hist, &cache).unwrap();
        assert_eq!(outcome.counts.translated_tracks, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
