//! Полные настройки профиля (задача 5.1, docs/05 §1 src/settings/):
//! settings.json + миграции (docs/05 §1). Канонический доступ к корню файла —
//! здесь (прочие модули прежде держали свои копии чтения/записи ключа);
//! пароль прокси и ключи API в файле не живут — только DPAPI (docs/02 §9).
//!
//! Разделы задачи 5.1: внешний вид (тема; v1 — тёмная фирменная, F-10),
//! поиск (поисковик omnibox по умолчанию), субтитры по умолчанию (язык
//! перевода дефолт-набора Alt+D + стиль плашки для новых вкладок),
//! приватность (очистка истории при выходе). Прокси/VPN, перевод и
//! блокировщик — свои ключи файла (proxy/translate/adblock), страница
//! «Настройки» показывает их в снапшоте settings_all.
//!
//! Миграции: файл без `settingsVersion` — версия 1 (появился с задачей 1.8);
//! каждая миграция — чистая функция корня JSON, применяется цепочкой в
//! `migrate` на старте приложения (до открытия хранилищ). Новые разделы
//! сериализуются с `#[serde(default)]` — их отсутствие валидно и без
//! миграции; миграция нужна переименованиям/переносам значений.

pub mod profile;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Версия схемы settings.json. Несовместимое изменение раздела (переименование
/// поля без умолчания, смена типа) — шаг миграции + bump здесь.
/// v3 (duopulse-085): поисковик по умолчанию YouTube → Google.
pub const SETTINGS_SCHEMA_VERSION: u32 = 3;

// ---------------------------------------------------------------------------
// Корень файла: каноническое чтение/запись ключей
// ---------------------------------------------------------------------------

/// Прочитать корень settings.json (битый/отсутствующий — пустой объект).
pub fn load_root(dir: &Path) -> serde_json::Value {
    std::fs::read_to_string(dir.join("settings.json"))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

/// Записать ключ в корень settings.json, сохранив прочие ключи; предыдущая
/// версия остаётся в settings.json.bak (docs/02 §8 — паттерн всех разделов).
pub fn write_key(dir: &Path, key: &str, value: &serde_json::Value) -> Result<(), String> {
    let path = dir.join("settings.json");
    let mut root = load_root(dir);
    root[key] = value.clone();
    std::fs::create_dir_all(dir).map_err(|e| format!("создать {dir:?}: {e}"))?;
    if path.exists() {
        let _ = std::fs::copy(&path, dir.join("settings.json.bak"));
    }
    let json = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("записать {path:?}: {e}"))
}

/// Прочитать раздел файла в тип (отсутствие/битый — дефолт типа).
fn load_section<T: for<'de> Deserialize<'de> + Default>(dir: &Path, key: &str) -> T {
    load_root(dir)
        .get(key)
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

/// Записать раздел (сериализация типа → ключ корня).
fn save_section<T: Serialize>(dir: &Path, key: &str, cfg: &T) -> Result<(), String> {
    let value = serde_json::to_value(cfg).map_err(|e| e.to_string())?;
    write_key(dir, key, &value)
}

// ---------------------------------------------------------------------------
// Миграции (docs/05 §1)
// ---------------------------------------------------------------------------

/// Применить миграции к файлу на старте: цепочка шагов от версии файла до
/// текущей. Идемпотентна (повторный запуск — no-op), пишет только когда
/// что-то изменилось. Возвращает версию до миграции (для журнала).
pub fn migrate(dir: &Path) -> u32 {
    let mut root = load_root(dir);
    let from = root
        .get("settingsVersion")
        .and_then(|v| v.as_u64())
        .unwrap_or(1) as u32;
    if from >= SETTINGS_SCHEMA_VERSION {
        return from;
    }
    let mut version = from;
    while version < SETTINGS_SCHEMA_VERSION {
        match version {
            // v1 → v2 (задача 5.1): появились разделы search/subtitles/
            // appearance/privacy — записываем дефолты, если их ещё нет
            // (serde-умолчания читали бы их и так; явная запись делает файл
            // самодокументированным на чистой машине).
            1 => {
                for (key, default) in [
                    ("search", serde_json::to_value(SearchConfig::default())),
                    (
                        "subtitles",
                        serde_json::to_value(SubtitlesConfig::default()),
                    ),
                    (
                        "appearance",
                        serde_json::to_value(AppearanceConfig::default()),
                    ),
                    ("privacy", serde_json::to_value(PrivacyConfig::default())),
                ] {
                    let default = default.unwrap_or_else(|_| serde_json::json!({}));
                    if root.get(key).is_none() {
                        root[key] = default;
                    }
                }
                version = 2;
            }
            // v2 → v3 (duopulse-085): поисковик по умолчанию — Google (был
            // YouTube). Смену делает только старому дефолту: явно выбранный
            // пользователем движок (bing/duckduckgo/youtube после v3) не
            // трогаем — «google по умолчанию, но сменить можно в настройках».
            2 => {
                if root
                    .get("search")
                    .and_then(|s| s.get("engine"))
                    .and_then(|e| e.as_str())
                    == Some("youtube")
                {
                    root["search"]["engine"] = serde_json::json!("google");
                }
                version = 3;
            }
            // Новые миграции — дописывать шаги сюда, поднимая константу выше.
            _ => unreachable!("миграция v{version} не описана"),
        }
    }
    root["settingsVersion"] = serde_json::json!(SETTINGS_SCHEMA_VERSION);
    let path = dir.join("settings.json");
    if std::fs::create_dir_all(dir).is_ok() {
        if path.exists() {
            let _ = std::fs::copy(&path, dir.join("settings.json.bak"));
        }
        if let Ok(json) = serde_json::to_string_pretty(&root) {
            let _ = std::fs::write(&path, json);
        }
    }
    from
}

// ---------------------------------------------------------------------------
// Поиск: поисковик omnibox по умолчанию (задача 5.1)
// ---------------------------------------------------------------------------

/// Поисковые системы omnibox (задача 5.1): выбор по умолчанию — настройка
/// «Поиск». Префикс — шаблон ссылки с encoded-запросом в конце (omnibox.rs).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SearchEngine {
    /// Семантика продукта (M0): DuoPulse — браузер про YouTube-субтитры.
    Youtube,
    Google,
    Bing,
    Duckduckgo,
}

impl SearchEngine {
    pub const ALL: [SearchEngine; 4] = [
        SearchEngine::Youtube,
        SearchEngine::Google,
        SearchEngine::Bing,
        SearchEngine::Duckduckgo,
    ];

    pub fn title(self) -> &'static str {
        match self {
            SearchEngine::Youtube => "YouTube",
            SearchEngine::Google => "Google",
            SearchEngine::Bing => "Bing",
            SearchEngine::Duckduckgo => "DuckDuckGo",
        }
    }

    /// Шаблон поисковой ссылки: query (percent-encoded) дописывается в конец.
    pub fn url_prefix(self) -> &'static str {
        match self {
            SearchEngine::Youtube => "https://www.youtube.com/results?search_query=",
            SearchEngine::Google => "https://www.google.com/search?q=",
            SearchEngine::Bing => "https://www.bing.com/search?q=",
            SearchEngine::Duckduckgo => "https://duckduckgo.com/?q=",
        }
    }
}

/// Раздел "search" settings.json.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default, rename_all = "camelCase")]
pub struct SearchConfig {
    pub engine: SearchEngine,
}

impl Default for SearchConfig {
    fn default() -> Self {
        // duopulse-085: по умолчанию Google (прежде YouTube); выбор —
        // настройка «Поиск» на странице настроек.
        Self {
            engine: SearchEngine::Google,
        }
    }
}

pub fn load_search(dir: &Path) -> SearchConfig {
    load_section(dir, "search")
}

pub fn save_search(dir: &Path, cfg: &SearchConfig) -> Result<(), String> {
    save_section(dir, "search", cfg)
}

// ---------------------------------------------------------------------------
// Субтитры по умолчанию (задача 5.1)
// ---------------------------------------------------------------------------

/// Стиль плашки для новых вкладок: значения — та же модель, что в content-
/// оверлее (docs/03 §5); клампы при применении — в content-слое (mergeStyle).
/// Цвета строк/плашки и обводка — карточка duopulse-059; serde(default) на
/// контейнере: старые settings.json без новых полей читаются с дефолтами.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default, rename_all = "camelCase")]
pub struct SubtitlesStyleDefaults {
    /// Масштаб кегля, % (75–300).
    pub font_scale_pct: u32,
    /// Гарнитура плашки: Inter | JetBrains Mono | system (карточка 068).
    pub font_family: String,
    /// Позиция плашки: bottom|top.
    pub position: String,
    /// Отступ от края видео, % высоты (0–25).
    pub margin_pct: u32,
    /// Непрозрачность подложки, 0.2–1.
    pub plate_opacity: f64,
    /// Цвет строки оригинала, hex #rrggbb.
    pub original_color: String,
    /// Цвет строки перевода, hex #rrggbb.
    pub translation_color: String,
    /// Цвет третьей и далее строк, hex #rrggbb.
    pub muted_color: String,
    /// Цвет подложки-плашки, hex #rrggbb.
    pub plate_color: String,
    /// Тёмная обводка строк для читаемости на светлом видео.
    pub text_stroke: bool,
}

/// hex #rgb/#rrggbb → канонический #rrggbb ( lowercase); прочее — None.
fn normalize_hex_color(value: &str) -> Option<String> {
    let s = value.trim().to_ascii_lowercase();
    let hex = s.strip_prefix('#')?;
    if hex.len() == 3 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        let b = hex.as_bytes();
        return Some(format!(
            "#{}{}{}{}{}{}",
            b[0] as char, b[0] as char, b[1] as char, b[1] as char, b[2] as char, b[2] as char
        ));
    }
    if hex.len() == 6 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Some(format!("#{hex}"));
    }
    None
}

impl Default for SubtitlesStyleDefaults {
    fn default() -> Self {
        Self {
            font_scale_pct: 100,
            font_family: "Inter".into(),
            position: "bottom".into(),
            margin_pct: 6,
            plate_opacity: 0.78,
            original_color: "#ffffff".into(),
            translation_color: "#bdfe4f".into(),
            muted_color: "#ffffff".into(),
            plate_color: "#0a0e17".into(),
            text_stroke: true,
        }
    }
}

/// Раздел "subtitles" settings.json — дефолты субтитров (задача 5.1):
/// язык перевода дефолт-набора Alt+D («оригинал + <язык>») и стиль плашки
/// для вкладок, где пользователь ещё не менял стиль вручную.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default, rename_all = "camelCase")]
pub struct SubtitlesConfig {
    /// Язык перевода дефолт-набора, код 2–3 буквы («ru»).
    pub default_translation_lang: String,
    pub style: SubtitlesStyleDefaults,
}

impl Default for SubtitlesConfig {
    fn default() -> Self {
        Self {
            default_translation_lang: "ru".into(),
            style: SubtitlesStyleDefaults::default(),
        }
    }
}

impl SubtitlesConfig {
    /// Нормализация перед сохранением: язык — нижний регистр, позиция —
    /// известное значение, кегль/отступ/непрозрачность — клампы content-слоя;
    /// цвета — канонический #rrggbb (мусор — дефолт, карточка 059).
    pub fn normalized(mut self) -> Self {
        self.default_translation_lang = self.default_translation_lang.trim().to_ascii_lowercase();
        if self.default_translation_lang.is_empty() {
            self.default_translation_lang = "ru".into();
        }
        if self.style.position != "top" {
            self.style.position = "bottom".into();
        }
        if !crate::subtitles::fonts::is_valid_family(&self.style.font_family) {
            self.style.font_family = "Inter".into();
        }
        self.style.font_scale_pct = self.style.font_scale_pct.clamp(75, 300);
        self.style.margin_pct = self.style.margin_pct.min(25);
        self.style.plate_opacity = self.style.plate_opacity.clamp(0.2, 1.0);
        let defaults = SubtitlesStyleDefaults::default();
        let fix = |v: String, fallback: &str| {
            normalize_hex_color(&v).unwrap_or_else(|| fallback.to_string())
        };
        self.style.original_color = fix(self.style.original_color, &defaults.original_color);
        self.style.translation_color =
            fix(self.style.translation_color, &defaults.translation_color);
        self.style.muted_color = fix(self.style.muted_color, &defaults.muted_color);
        self.style.plate_color = fix(self.style.plate_color, &defaults.plate_color);
        self
    }
}

pub fn load_subtitles(dir: &Path) -> SubtitlesConfig {
    load_section(dir, "subtitles")
}

pub fn save_subtitles(dir: &Path, cfg: &SubtitlesConfig) -> Result<(), String> {
    save_section(dir, "subtitles", cfg)
}

/// Initialization-script для контентных вкладок: дефолты субтитров до скриптов
/// страницы (content-бандл читает window.__DUOPULSE_DEFAULTS__). JSON —
/// валидный JS-объектный литерал; чтение файла — на каждую вкладку, чтобы
/// новые вкладки видели свежесохранённые настройки.
pub fn content_defaults_script(dir: &Path) -> String {
    let subs = load_subtitles(dir);
    let value = serde_json::json!({
        "subtitles": {
            "defaultTranslationLang": subs.default_translation_lang,
            "style": {
                "fontScalePct": subs.style.font_scale_pct,
                "fontFamily": subs.style.font_family,
                "position": subs.style.position,
                "marginPct": subs.style.margin_pct,
                "plateOpacity": subs.style.plate_opacity,
                "originalColor": subs.style.original_color,
                "translationColor": subs.style.translation_color,
                "mutedColor": subs.style.muted_color,
                "plateColor": subs.style.plate_color,
                "textStroke": subs.style.text_stroke,
            },
        },
    });
    let json = serde_json::to_string(&value).unwrap_or_else(|_| "{}".into());
    let mut js = String::from(";(window.__DUOPULSE_DEFAULTS__=");
    js.push_str(&json);
    js.push_str(");");
    js
}

// ---------------------------------------------------------------------------
// Внешний вид (F-10: тема тёмная v1) и приватность
// ---------------------------------------------------------------------------

/// Раздел "appearance" settings.json. v1 — только тёмная фирменная тема
/// (docs/01 F-10, ROADMAP M5): светлая — за пределами карточки 5.1, значение
/// фиксировано, селект страницы показывает её единственной активной опцией.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(default, rename_all = "lowercase")]
pub struct AppearanceConfig {
    pub theme: Theme,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Dark,
}

impl Default for AppearanceConfig {
    fn default() -> Self {
        Self { theme: Theme::Dark }
    }
}

pub fn load_appearance(dir: &Path) -> AppearanceConfig {
    load_section(dir, "appearance")
}

/// Раздел "privacy" settings.json (задача 5.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct PrivacyConfig {
    /// Очищать историю посещений при выходе из браузера.
    pub clear_history_on_exit: bool,
}

pub fn load_privacy(dir: &Path) -> PrivacyConfig {
    load_section(dir, "privacy")
}

pub fn save_privacy(dir: &Path, cfg: &PrivacyConfig) -> Result<(), String> {
    save_section(dir, "privacy", cfg)
}

// ---------------------------------------------------------------------------
// Автообновление (задача 5.2): канал и автопроверка
// ---------------------------------------------------------------------------

/// Канал обновлений (задача 5.2): stable — релизы, canary — ранние сборки
/// для тестовых машин (DoD 5.2 — обновление канарейки). Канал — сегмент пути
/// фида: <база>/<канал>/{{target}}/{{arch}}/{{current_version}}.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    Stable,
    Canary,
}

impl UpdateChannel {
    /// Сегмент пути фида обновлений.
    pub fn path(self) -> &'static str {
        match self {
            UpdateChannel::Stable => "stable",
            UpdateChannel::Canary => "canary",
        }
    }
}

/// Источник фида обновлений (duopulse-049): GitHub Pages (по умолчанию) или
/// зеркало на семейном сервере Aila (updates/duopulse/, aila-163). При
/// недоступности выбранного проверка уходит ко второму (порядок попыток и
/// «кто ответил» — src/updater.rs); установка в любом случае идёт с
/// minisign-подписью, источник меняет только адрес фида и пакета.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum UpdateSource {
    Github,
    Aila,
}

/// Раздел "updater" settings.json (задача 5.2). Появился после v2 —
/// сериализуется с serde-умолчаниями, миграция не нужна (отсутствие валидно).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default, rename_all = "camelCase")]
pub struct UpdaterConfig {
    /// Канал фида обновлений (stable/canary).
    pub channel: UpdateChannel,
    /// Источник фида: GitHub Pages или зеркало Aila (duopulse-049).
    pub source: UpdateSource,
    /// Тихая автопроверка на старте (установка — всегда руками, из настроек).
    pub auto_check: bool,
}

impl Default for UpdaterConfig {
    fn default() -> Self {
        Self {
            channel: UpdateChannel::Stable,
            source: UpdateSource::Github,
            auto_check: true,
        }
    }
}

pub fn load_updater(dir: &Path) -> UpdaterConfig {
    load_section(dir, "updater")
}

pub fn save_updater(dir: &Path, cfg: &UpdaterConfig) -> Result<(), String> {
    save_section(dir, "updater", cfg)
}

// ---------------------------------------------------------------------------
// Тесты
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("duopulse-settings-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn write_key_keeps_other_keys_and_bak() {
        let dir = tmp_dir("root");
        write_key(&dir, "proxy", &serde_json::json!({"enabled": true})).unwrap();
        write_key(&dir, "search", &serde_json::json!({"engine": "google"})).unwrap();
        let root = load_root(&dir);
        assert_eq!(root["proxy"]["enabled"], serde_json::json!(true));
        assert_eq!(root["search"]["engine"], serde_json::json!("google"));
        assert!(
            dir.join("settings.json.bak").is_file(),
            "предыдущая версия — в .bak"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrate_v1_adds_sections_and_version() {
        let dir = tmp_dir("migrate");
        // файл эпохи задач 1.8–4.3: только proxy, без версии схемы
        std::fs::write(
            dir.join("settings.json"),
            r#"{"proxy":{"enabled":false,"proto":"socks5","host":"","port":1080}}"#,
        )
        .unwrap();
        let from = migrate(&dir);
        assert_eq!(from, 1);
        let root = load_root(&dir);
        assert_eq!(root["settingsVersion"], serde_json::json!(3));
        assert_eq!(root["proxy"]["host"], serde_json::json!(""), "старое живо");
        for key in ["search", "subtitles", "appearance", "privacy"] {
            assert!(root.get(key).is_some(), "раздел {key} появился");
        }
        assert_eq!(load_search(&dir).engine, SearchEngine::Google);
        assert_eq!(
            load_subtitles(&dir).default_translation_lang,
            "ru",
            "дефолт языка перевода"
        );
        assert!(!load_privacy(&dir).clear_history_on_exit);
        // идемпотентность: повторный запуск — no-op (версия не меняется, .bak не растёт)
        assert_eq!(migrate(&dir), SETTINGS_SCHEMA_VERSION);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrate_fresh_file_creates_everything() {
        let dir = tmp_dir("fresh");
        assert_eq!(migrate(&dir), 1, "пустой профиль считается v1");
        assert_eq!(
            load_root(&dir)["settingsVersion"],
            serde_json::json!(SETTINGS_SCHEMA_VERSION)
        );
        assert_eq!(load_search(&dir), SearchConfig::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrate_v2_youtube_default_flips_to_google() {
        // duopulse-085: профиль эпохи v2 с материализованным дефолтом
        // «youtube» — миграция переводит на новый дефолт Google…
        let dir = tmp_dir("migrate-v2");
        std::fs::write(
            dir.join("settings.json"),
            r#"{"settingsVersion":2,"search":{"engine":"youtube"}}"#,
        )
        .unwrap();
        assert_eq!(migrate(&dir), 2);
        assert_eq!(load_search(&dir).engine, SearchEngine::Google);
        // идемпотентность: повторный прогон уже мигрированного — no-op
        assert_eq!(migrate(&dir), 3);
        assert_eq!(load_search(&dir).engine, SearchEngine::Google);
        // …а явно выбранный движок не трогает
        std::fs::write(
            dir.join("settings.json"),
            r#"{"settingsVersion":2,"search":{"engine":"duckduckgo"}}"#,
        )
        .unwrap();
        migrate(&dir);
        assert_eq!(load_search(&dir).engine, SearchEngine::Duckduckgo);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_config_roundtrip_and_engines() {
        let dir = tmp_dir("search");
        save_search(
            &dir,
            &SearchConfig {
                engine: SearchEngine::Duckduckgo,
            },
        )
        .unwrap();
        assert_eq!(load_search(&dir).engine, SearchEngine::Duckduckgo);
        // битый раздел — дефолт, остальное живо
        write_key(&dir, "search", &serde_json::json!("мусор")).unwrap();
        assert_eq!(load_search(&dir), SearchConfig::default());
        let _ = std::fs::remove_dir_all(&dir);

        for engine in SearchEngine::ALL {
            assert!(engine.url_prefix().starts_with("https://"));
            assert!(!engine.title().is_empty());
        }
        assert_ne!(
            SearchEngine::Google.url_prefix(),
            SearchEngine::Bing.url_prefix()
        );
    }

    #[test]
    fn subtitles_config_normalizes_and_roundtrips() {
        let cfg = SubtitlesConfig {
            default_translation_lang: "  ES ".into(),
            style: SubtitlesStyleDefaults {
                font_scale_pct: 999,
                font_family: "Comic Sans".into(), // не из списка — дефолт Inter
                position: "top".into(),
                margin_pct: 90,
                plate_opacity: 5.0,
                original_color: "#FFDD33".into(),
                translation_color: "red".into(), // не hex — дефолт
                muted_color: "#fC3".into(),
                plate_color: "#000".into(),
                text_stroke: false,
            },
        }
        .normalized();
        assert_eq!(cfg.default_translation_lang, "es");
        assert_eq!(cfg.style.font_scale_pct, 300, "кламп кегля");
        assert_eq!(
            cfg.style.font_family, "Inter",
            "гарнитура не из списка — дефолт"
        );
        assert_eq!(cfg.style.position, "top");
        assert_eq!(cfg.style.margin_pct, 25, "кламп отступа");
        assert_eq!(cfg.style.plate_opacity, 1.0, "кламп непрозрачности");
        assert_eq!(cfg.style.original_color, "#ffdd33", "#RRGGBB → lower");
        assert_eq!(
            cfg.style.translation_color, "#bdfe4f",
            "мусор — фирменный дефолт"
        );
        assert_eq!(cfg.style.muted_color, "#ffcc33", "#RGB разворачивается");
        assert_eq!(cfg.style.plate_color, "#000000");
        assert!(!cfg.style.text_stroke);
        // неизвестная позиция и пустой язык — к дефолтам
        let cfg = SubtitlesConfig {
            default_translation_lang: String::new(),
            style: SubtitlesStyleDefaults {
                position: "диагонально".into(),
                ..SubtitlesStyleDefaults::default()
            },
        }
        .normalized();
        assert_eq!(cfg.default_translation_lang, "ru");
        assert_eq!(cfg.style.position, "bottom");

        let dir = tmp_dir("subs");
        save_subtitles(&dir, &cfg).unwrap();
        assert_eq!(load_subtitles(&dir), cfg);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn subtitles_config_old_file_without_colors_gets_defaults() {
        // settings.json до duopulse-059: раздел без полей цветов — дефолты,
        // serde(default) контейнера добирает их из Default::default().
        let dir = tmp_dir("subs-old");
        write_key(
            &dir,
            "subtitles",
            &serde_json::json!({"defaultTranslationLang": "de",
                                 "style": {"fontScalePct": 140, "position": "top",
                                           "marginPct": 8, "plateOpacity": 0.9}}),
        )
        .unwrap();
        let cfg = load_subtitles(&dir);
        assert_eq!(cfg.style.font_scale_pct, 140);
        assert_eq!(cfg.style.original_color, "#ffffff");
        assert_eq!(cfg.style.translation_color, "#bdfe4f");
        assert_eq!(cfg.style.plate_color, "#0a0e17");
        assert!(cfg.style.text_stroke);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn content_defaults_script_is_valid_json_literal() {
        let dir = tmp_dir("script");
        save_subtitles(
            &dir,
            &SubtitlesConfig {
                default_translation_lang: "uk".into(),
                style: SubtitlesStyleDefaults {
                    font_scale_pct: 120,
                    font_family: "JetBrains Mono".into(),
                    position: "top".into(),
                    margin_pct: 4,
                    plate_opacity: 0.9,
                    original_color: "#ffdd33".into(),
                    translation_color: "#ffffff".into(),
                    muted_color: "#ffdd33".into(),
                    plate_color: "#000000".into(),
                    text_stroke: false,
                },
            },
        )
        .unwrap();
        let js = content_defaults_script(&dir);
        assert!(js.starts_with(";(window.__DUOPULSE_DEFAULTS__="));
        assert!(js.ends_with(");"));
        let json = &js[";(window.__DUOPULSE_DEFAULTS__=".len()..js.len() - 2];
        let parsed: serde_json::Value = serde_json::from_str(json).expect("JSON-литерал валиден");
        assert_eq!(parsed["subtitles"]["defaultTranslationLang"], "uk");
        assert_eq!(parsed["subtitles"]["style"]["fontScalePct"], 120);
        assert_eq!(parsed["subtitles"]["style"]["fontFamily"], "JetBrains Mono");
        assert_eq!(parsed["subtitles"]["style"]["originalColor"], "#ffdd33");
        assert_eq!(parsed["subtitles"]["style"]["plateColor"], "#000000");
        assert_eq!(parsed["subtitles"]["style"]["textStroke"], false);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn privacy_config_roundtrip() {
        let dir = tmp_dir("privacy");
        save_privacy(
            &dir,
            &PrivacyConfig {
                clear_history_on_exit: true,
            },
        )
        .unwrap();
        assert!(load_privacy(&dir).clear_history_on_exit);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn updater_config_roundtrip_and_defaults() {
        // отсутствие/битый раздел — дефолт (stable, github, автопроверка вкл)
        let dir = tmp_dir("updater");
        assert_eq!(
            load_updater(&dir),
            UpdaterConfig {
                channel: UpdateChannel::Stable,
                source: UpdateSource::Github,
                auto_check: true,
            }
        );
        write_key(&dir, "updater", &serde_json::json!("мусор")).unwrap();
        assert_eq!(load_updater(&dir), UpdaterConfig::default());
        // старый файл без source (до duopulse-049) — source по умолчанию
        write_key(
            &dir,
            "updater",
            &serde_json::json!({"channel": "canary", "autoCheck": false}),
        )
        .unwrap();
        assert_eq!(
            load_updater(&dir),
            UpdaterConfig {
                channel: UpdateChannel::Canary,
                source: UpdateSource::Github,
                auto_check: false,
            }
        );

        save_updater(
            &dir,
            &UpdaterConfig {
                channel: UpdateChannel::Canary,
                source: UpdateSource::Aila,
                auto_check: false,
            },
        )
        .unwrap();
        assert_eq!(
            load_updater(&dir),
            UpdaterConfig {
                channel: UpdateChannel::Canary,
                source: UpdateSource::Aila,
                auto_check: false,
            }
        );
        // каналы знают сегмент пути фида (подписи селекта — в UI)
        assert_eq!(UpdateChannel::Canary.path(), "canary");
        assert_eq!(UpdateChannel::Stable.path(), "stable");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
