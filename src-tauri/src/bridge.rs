//! IPC-мост bridge — единый словарь команд/событий UI|Content ↔ Core
//! (задача 1.1, docs/05 §2). Слои общаются только через этот контракт
//! (docs/02 §1), что позволяет менять Shell (Tauri → Electron) без
//! переписывания ценностных слоёв.
//!
//! Единственный источник контракта — Rust-типы этого модуля (serde ↔ schemars):
//! из них генерируется `bridge/contract.json` (JSON Schema draft-07,
//! версионируется в git), из него — TS-типы `src/bridge/gen/types.ts`
//! (npm run gen:bridge). Ручные правки генерённых файлов исключены тестами:
//!   - cargo-тест `contract_file_is_up_to_date`: contract.json == код;
//!   - vitest `src/bridge/client.test.ts`: TS-клиент знает все команды.
//!
//! Имена в словаре — `домен.действие` (tabs.list); tauri-хендлеры — snake_case
//! (tabs_list): точки в именах Rust-функций невозможны, маппинг живёт в
//! contract.json (поле "handler") и в TS-клиенте src/bridge/client.ts.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Url};

use crate::proxy;

/// Версия контракта. Несовместимое изменение схем/имён (удаление команды,
/// смена типа поля без умолчания) — bump версии + правка потребителей в той же
/// задаче. Совместимые расширения версию не меняют.
///
/// v2 (задача 1.2): события переименованы `домен.событие` → `домен:событие`
/// (page:loaded, page:video_detected, vpn:state_changed, + новое tabs:updated):
/// tauri 2 разрешает в именах событий только alnum/`-`/`/`/`:`/`_` — точечные
/// имена не проходили валидацию listen/emit. Команды не затронуты: в tauri
/// идёт snake_case-хендлер из поля "handler", словарное имя в рантайме не звучит.
/// v2 (задача 2.5, без bump — совместимое расширение): домен perf.* — команды
/// perf.{snapshot, save_run, list_runs} и события perf:{startup_ms,
/// tab_switch_ms} (страница «Диагностика», docs/04 §2, docs/05 §2).
/// v6 (задача 5.1): домен settings вырос — команды settings.{get_all, apply,
/// export, import} (полные настройки + перенос профиля одним файлом) и
/// translate.clear_cache (приватность); settings.{get, set} (прокси-инкремент
/// M1) не изменились. По словарю docs/05 §2 экспорт/импорт ложатся сюда же.
/// v7 (задача 5.2): домен updater — команды updater.{status, check, install}
/// (автообновление: канал stable/canary, подписанные NSIS-пакеты).
pub const CONTRACT_VERSION: u32 = 7;

// ---------------------------------------------------------------------------
// Типы команд (params/result)
// ---------------------------------------------------------------------------

/// bridge.version: версия контракта живого приложения (диагностика, e2e).
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct BridgeVersionResult {
    pub version: u32,
}

/// tabs.list: вкладки окна в порядке таб-бара (менеджер вкладок — src/tabs/).
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct TabsListResult {
    pub tabs: Vec<TabInfo>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct TabInfo {
    /// Идентификатор webview-вкладки.
    pub id: String,
    /// Текущий URL вкладки.
    pub url: String,
    /// Заголовок страницы (пусто — до первого on_document_title_changed).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Активна ли вкладка (виден её webview).
    pub active: bool,
    /// Идёт загрузка документа (пульс-индикатор вкладки, гайд 06 §3).
    pub loading: bool,
    /// Спит ли вкладка (приостановлена WebView2; задача 2.3): JS/таймеры
    /// заморожены, состояние страницы сохранено, активация будит.
    pub sleeping: bool,
}

/// tabs.open: открыть вкладку; без url — стартовая страница (до страницы
/// «Новая вкладка» задачи 1.5). Новая вкладка становится активной.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct TabsOpenParams {
    #[serde(default)]
    pub url: Option<String>,
}

/// tabs.close: закрыть вкладку по id; активной становится соседняя.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct TabsCloseParams {
    pub id: String,
}

/// tabs.activate: сделать вкладку активной (клик по вкладке таб-бара).
#[derive(Debug, Deserialize, JsonSchema)]
pub struct TabsActivateParams {
    pub id: String,
}

/// tabs.sleep: усыпить вкладку вручную (задача 2.3; авто-усыпление долгих
/// простоёв — фоновая нить Core). Активная вкладка и вкладка с играющим
/// звуком/видео не усыпляются — ошибка.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct TabsSleepParams {
    pub id: String,
}

/// tabs.wake: разбудить вкладку (задача 2.3; активация и так будит — команда
/// для диагностики/e2e). Не спящая вкладка — no-op.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct TabsWakeParams {
    pub id: String,
}

/// nav.navigate: переход активной вкладки по URL.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct NavNavigateParams {
    pub url: String,
}

/// nav.resolve_omnibox: разобрать ввод адресной строки — адрес (с догадкой
/// схемы) или поисковый запрос; результат — готовый URL для nav.navigate
/// (задача 1.3, разбор — src/omnibox.rs).
#[derive(Debug, Deserialize, JsonSchema)]
pub struct NavResolveOmniboxParams {
    pub input: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NavResolveOmniboxResult {
    pub url: String,
    /// Ввод распознан как поисковый запрос (не как адрес).
    pub is_search: bool,
}

/// history.search: подсказки omnibox — полнотекстовый поиск по истории и
/// закладкам (FTS5, задача 1.3; хранилище — src/history/, SQLite в профиле —
/// задача 1.4).
#[derive(Debug, Deserialize, JsonSchema)]
pub struct HistorySearchParams {
    pub query: String,
    /// Максимум подсказок в ответе (по умолчанию 8, диапазон 1–20).
    #[serde(default = "default_suggest_limit")]
    pub limit: u32,
}

fn default_suggest_limit() -> u32 {
    8
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HistorySearchResult {
    pub hits: Vec<HistoryHit>,
}

/// Откуда подсказка: посещение из истории или закладка.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum HistorySource {
    History,
    Bookmark,
}

impl HistorySource {
    /// Обратное преобразование (не-«bookmark» считается историей).
    pub fn from_db(s: &str) -> Self {
        if s == "bookmark" {
            Self::Bookmark
        } else {
            Self::History
        }
    }
}

/// Одна подсказка omnibox: источник, адрес и заголовок страницы.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HistoryHit {
    pub source: HistorySource,
    pub url: String,
    pub title: String,
}

// --- задача 1.4: история и закладки (SQLite в профиле, src/history/) --------

/// history.visit: записать посещение. Core записывает визиты сам (on_page_load
/// вкладок, только http/https); команда в словаре — для e2e-стендов и будущих
/// источников (docs/05 §2).
#[derive(Debug, Deserialize, JsonSchema)]
pub struct HistoryVisitParams {
    pub url: String,
    #[serde(default)]
    pub title: String,
}

/// history.list: история для страницы управления — агрегат по URL.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryListParams {
    /// FTS-фильтр по заголовку/адресу (префиксные токены); пустой — всё.
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub offset: u32,
    /// Страница выдачи (по умолчанию 100, максимум 500).
    #[serde(default = "default_list_limit")]
    pub limit: u32,
}

fn default_list_limit() -> u32 {
    100
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryListResult {
    pub entries: Vec<HistoryEntry>,
    /// Всего URL, подходящих под фильтр (пагинация).
    pub total: u32,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub url: String,
    /// Заголовок последнего визита (может быть пуст до on_title).
    pub title: String,
    /// Последнее посещение, unix-ms.
    pub last_visited_at: i64,
    pub visit_count: u32,
}

/// history.delete_urls: удалить из истории все визиты перечисленных адресов.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct HistoryDeleteUrlsParams {
    pub urls: Vec<String>,
}

/// history.delete_range: удалить визиты за [fromMs..=toMs] (unix-ms);
/// fromMs=0, toMs=«будущее» — вся история (закладки не трогаются).
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryDeleteRangeParams {
    pub from_ms: i64,
    pub to_ms: i64,
}

/// history.bookmark_add: добавить закладку (url — ключ; повторное добавление
/// обновляет заголовок, пустой заголовок сохраняет прежний).
#[derive(Debug, Deserialize, JsonSchema)]
pub struct HistoryBookmarkAddParams {
    pub url: String,
    #[serde(default)]
    pub title: String,
}

/// history.bookmark_remove: удалить закладку (идемпотентна).
#[derive(Debug, Deserialize, JsonSchema)]
pub struct HistoryBookmarkRemoveParams {
    pub url: String,
}

/// history.bookmark_update: переименовать закладку (правка на странице
/// управления); несуществующая — ошибка.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct HistoryBookmarkUpdateParams {
    pub url: String,
    pub title: String,
}

/// history.bookmark_list: закладки для страницы управления.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryBookmarkListParams {
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub offset: u32,
    #[serde(default = "default_bookmark_limit")]
    pub limit: u32,
}

fn default_bookmark_limit() -> u32 {
    200
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryBookmarkListResult {
    pub bookmarks: Vec<HistoryBookmark>,
    pub total: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryBookmark {
    pub url: String,
    pub title: String,
    /// Добавлена, unix-ms.
    pub added_at: i64,
}

/// settings.get: ключ, значение которого читаем.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct SettingsGetParams {
    pub key: SettingsKey,
}

/// settings.get / settings.set: ключи настроек профиля. M1: один ключ.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SettingsKey {
    Proxy,
}

/// Значение ключа "proxy" для UI: конфиг прокси + факт наличия пароля в DPAPI
/// (сам пароль наружу не отдаётся).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProxySettings {
    pub enabled: bool,
    pub proto: proxy::ProxyProto,
    pub host: String,
    pub port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login: Option<String>,
    pub has_password: bool,
}

/// settings.set: value — значение ключа; secret — секрет ключа в DPAPI:
/// None — не менять, Some("") — удалить, Some(p) — перезаписать.
/// Для "proxy" value без пароля (пароль — только DPAPI, docs/02 §9).
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSetParams {
    pub key: SettingsKey,
    pub value: proxy::ProxyConfig,
    pub secret: Option<String>,
}

// --- задача 5.1: полные настройки + перенос профиля (src/settings/) ----------

/// Поисковик для селекта «Поиск» (id — значение настройки, title — подпись).
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SearchEngineInfo {
    pub id: crate::settings::SearchEngine,
    pub title: String,
}

/// settings.get_all: полный снапшот настроек для страницы «Настройки».
/// Прокси (settings.get M1), перевод (translate.get_settings) и блокировщик
/// (adblock.status) включены сюда же — страница показывает все разделы одной
/// командой; их живые команды остаются (хром-панели).
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SettingsAll {
    /// Версия схемы settings.json (миграции — на старте Core).
    pub schema_version: u32,
    pub appearance: crate::settings::AppearanceConfig,
    /// Текущий поисковик omnibox + доступные.
    pub search: crate::settings::SearchConfig,
    pub engines: Vec<SearchEngineInfo>,
    /// Дефолты субтитров (язык перевода набора Alt+D, стиль новых вкладок).
    pub subtitles: crate::settings::SubtitlesConfig,
    pub privacy: crate::settings::PrivacyConfig,
    /// Автообновление (задача 5.2): канал и автопроверка.
    pub updater: crate::settings::UpdaterConfig,
    pub proxy: ProxySettings,
    /// Глобальный тумблер блокировщика (исключения сайтов — adblock.status).
    pub adblock_enabled: bool,
    pub translate: crate::translate::TranslateSettings,
}

/// settings.apply: частичный патч разделов (неназванные не меняются).
/// Прокси-пароль и ключи API — только существующими командами (settings.set
/// proxy / translate.set_settings: секреты идут в DPAPI, не в патче).
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search: Option<crate::settings::SearchConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitles: Option<crate::settings::SubtitlesConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub privacy: Option<crate::settings::PrivacyConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updater: Option<crate::settings::UpdaterConfig>,
}

/// settings.export: собрать профиль в файл (задача 5.1, DoD — переезд на
/// чистую машину за 1 файл). path — абсолютный путь из нативного диалога
/// сохранения (UI); include_secrets — явный выбор пользователя (UI предупреждает:
/// пароль прокси и ключи API попадут в файл открытым текстом).
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SettingsExportParams {
    pub path: String,
    pub include_secrets: bool,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SettingsExportResult {
    /// Что вошло в файл (разделы настроек, закладки, визиты, строки кэша,
    /// секреты) + размер файла.
    pub counts: crate::settings::profile::ProfileCounts,
    pub bytes: u64,
}

/// settings.import: применить файл профиля (path — нативный диалог выбора).
/// Импорт идемпотентен (дубликаты визитов скипаются, закладки/кэш — upsert);
/// переехавший прокси применяется роутером сразу — без перезапуска
/// (задача 6.1; needs_restart зарезервировано и всегда false).
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SettingsImportParams {
    pub path: String,
}

pub type SettingsImportResult = crate::settings::profile::ImportOutcome;

/// translate.clear_cache (приватность, задача 5.1): очистить кэш переведённых
/// дорожек (translated_tracks, duopulse.db).
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TranslateClearCacheResult {
    /// Удалено строк кэша.
    pub cleared: u32,
}

/// vpn.set_enabled: включить/выключить маршрутизацию через внешний прокси
/// (инкремент A; в M6 — выбор маршрута локальным роутером, docs/02 §6).
/// Включение с невалидным конфигом — ошибка, конфиг не меняется.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct VpnSetEnabledParams {
    pub on: bool,
}

/// vpn.status / vpn.test_connection: состояние маршрутизации.
/// state — словарь M1 (off/on/error); в M6 при WireGuard контракт расширится
/// состояниями из docs/05 §2 (connecting/connected) с bump версии.
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VpnStatusResult {
    pub state: proxy::ProxyState,
    pub detail: String,
}

// --- задача 2.1: блокировщик рекламы (src/adblock/) ------------------------

/// adblock.set_enabled: site=None — глобальный тумблер; Some — исключение
/// сайта (white-list, docs/04 §1.2). on=true снимает исключение.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdblockSetEnabledParams {
    pub site: Option<String>,
    pub on: bool,
}

/// adblock.update_lists: обновить списки блокировщика.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdblockUpdateListsParams {
    /// true — качать даже непротухшие (кнопка «Обновить списки»).
    #[serde(default)]
    pub force: bool,
}

/// adblock.status (и результат set_enabled/update_lists): снапшот состояния
/// блокировщика для меню и e2e.
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdblockStatusResult {
    /// Глобальный тумблер.
    pub enabled: bool,
    /// Движок построен (списки загружены/из кэша) — фильтрация активна.
    pub ready: bool,
    /// Заблокировано запросов за сеанс.
    pub blocked_total: u64,
    /// Всех http(s)-запросов через перехватчик (диагностика P-07).
    pub seen_total: u64,
    pub lists: Vec<AdblockListInfo>,
    /// Сайты-исключения (хосты).
    pub site_exceptions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdblockListInfo {
    pub name: String,
    /// http(s)-адрес или путь файла-источника.
    pub source: String,
    /// Число правил в последней загруженной версии.
    pub rules: u32,
    /// Успешная загрузка, unix-ms (0 — списка ещё не было).
    pub updated_at: i64,
    /// Последняя ошибка загрузки (None — ошибок нет).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// --- задача 2.5: метрики производительности (src/perf/) ----------------------
// Типы команд/событий perf.* определены в src/perf.rs рядом с их логикой;
// здесь — реестр контракта и IPC-хендлеры (единое место IPC — этот модуль).

// --- задача 3.5: субтитры — синхронизация (docs/03 §4) -----------------------

/// subtitles.set_offset: сдвиг субтитров активной вкладки (±10 с, шаг 100 мс,
/// docs/03 §4 п.3). Core доставляет значение в content-слой активной вкладки
/// (eval диспатчит duopulse-set-offset); движок применяет сдвиг ко всему
/// набору без перезагрузки дорожек и показывает HUD со слайдером. Активной
/// контентной вкладки нет (или на странице нет субтитров) — no-op, не ошибка.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubtitlesSetOffsetParams {
    /// Сдвиг, мс: положительный — показывать позже. Клампится в ±10 000.
    pub offset_ms: i64,
}

/// Предел сдвига пользователя (docs/03 §4: ±10 с) — тот же, что в content-движке.
const SUBTITLES_OFFSET_LIMIT_MS: i64 = 10_000;

/// subtitles.load_file (задача 3.6, docs/03 §3.2): ручной файл субтитров с
/// диска (панель «Свои субтитры»). Чтение и разбор — в Core (канонические
/// парсеры задачи 3.1, src/subtitles), разобранные cue доставляются в
/// content-слой активной вкладки (eval диспатчит duopulse-file-track);
/// файловая дорожка входит в общий набор с дорожками платформы (docs/01 F-06).
#[derive(Debug, Deserialize, JsonSchema)]
pub struct SubtitlesLoadFileParams {
    /// Абсолютный путь к файлу .srt/.vtt.
    pub path: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubtitlesLoadFileResult {
    /// Имя файла без каталога (панель/диагностика его показывают).
    pub name: String,
    /// Разобрано cue (0 — валидных cue нет, см. warnings).
    pub cue_count: u32,
    /// Предупреждения разбора (снисходительный разбор — задача 3.1).
    pub warnings: Vec<String>,
}

// --- задача 3.7: панель настроек набора + кнопка «duo» (docs/03 §8) ----------

/// subtitles.set_tracks: применить платформенную часть набора активной
/// вкладки (порядок id = порядок строк на плашке; content-слой тот же состав
/// в другом порядке переставляет без перезагрузки дорожек).
#[derive(Debug, Deserialize, JsonSchema)]
pub struct SubtitlesSetTracksParams {
    /// id дорожек из списка адаптера («yt:en», «yt:en+ru», голый код перевода).
    pub ids: Vec<String>,
}

/// subtitles.set_enabled: включить/выключить показ набора (Alt+D, тумблер
/// панели): состав помнят обе стороны, включение восстанавливает без
/// перезагрузки (docs/03 §8 п.2).
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubtitlesSetEnabledParams {
    pub on: bool,
}

/// subtitles.remove_track: снять дорожку из набора (панель, «×» у строки):
/// файловую или платформенную, остальные — без перезагрузки.
#[derive(Debug, Deserialize, JsonSchema)]
pub struct SubtitlesRemoveTrackParams {
    pub id: String,
}

/// subtitles.translate_track (задача 4.2, docs/03 §7): перевести дорожку
/// набора активной вкладки выбранным облачным провайдером. Cues — у
/// content-слоя: команда диспатчит duopulse-translate-request в активную
/// вкладку (eval), дальше конвейер идёт WebMessage'м «translate-track»
/// (main.rs → src/translate/pipeline.rs: кэш SQLite → батчинг ≤ 2 КБ с
/// контекстом пачки → кэш); панель следит за прогрессом событием
/// subtitles:translate_progress. Команда только запускает — результат
/// асинхронный (перевод длинной дорожки — минуты).
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubtitlesTranslateTrackParams {
    /// Дорожка-источник (id из набора; по умолчанию — первая строка,
    /// не являющаяся облачным переводом, предпочтение оригиналу).
    #[serde(default)]
    pub track_id: Option<String>,
    /// Целевой язык, код («ru», «es», «pt-br»).
    pub target_lang: String,
}

/// Частичный патч стиля плашки (docs/03 §6 SubtitleStyle): неназванные поля
/// не меняются; клампы — в content-оверлее (mergeStyle, задача 3.4).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubtitlesStylePatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_scale_pct: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub margin_pct: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plate_opacity: Option<f64>,
}

/// subtitles.set_style: стиль плашки активной вкладки (размер/позиция
/// панели; то же значение меняют колесо мыши по плашке и тест-хук 3.4).
#[derive(Debug, Deserialize, JsonSchema)]
pub struct SubtitlesSetStyleParams {
    pub style: SubtitlesStylePatch,
}

/// subtitles.list_tracks: снапшот состояния субтитров активной вкладки
/// (сервис состояния, задача 3.7) — панель настроек набора и кнопка «duo»:
/// текущее видео, включён ли показ, применённый набор (порядок = строки),
/// полный список дорожек адаптера (языки/переводы), сдвиг и стиль.
pub type SubtitlesListTracksResult = crate::subtitles::service::TabSubtitles;

// --- задача 4.1: провайдеры перевода (src/translate/, docs/03 §7) ------------

/// translate.get_settings: конфиг перевода + факт наличия ключей в DPAPI
/// (сами ключи наружу не отдаются — как hasPassword прокси).
pub type TranslateGetSettingsResult = crate::translate::TranslateSettings;

/// translate.set_settings: value — конфиг без ключей (ключи — только DPAPI);
/// secret — ключ API выбранного провайдера (value.provider): None — не
/// менять, Some("") — удалить, Some(k) — перезаписать.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TranslateSetSettingsParams {
    pub value: crate::translate::TranslateConfig,
    pub secret: Option<String>,
}

/// translate.test: живая проверка выбранного провайдера (кнопка «Проверить»
/// панели «Перевод») — перевод короткой фразы; text/target_lang опциональны
/// (дефолт «DuoPulse» → ru).
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TranslateTestParams {
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub target_lang: Option<String>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TranslateTestResult {
    pub ok: bool,
    /// Диагностика панели: подпись успеха или текст ошибки.
    pub detail: String,
    /// Перевод пробной фразы (ok=true).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translated: Option<String>,
}

// ---------------------------------------------------------------------------
// События Core → UI|Content
// ---------------------------------------------------------------------------

// Каркас событий: схемы зарегистрированы в контракте с 1.1, реальный эмит
// начинается в последующих задачах (M3 — page.*, M6 — vpn.state_changed),
// поэтому элементы пока не используются бинарём.
#[allow(dead_code)]
/// Типизированное событие контракта: имя из словаря + схема payload.
pub trait BridgeEvent {
    const NAME: &'static str;
    type Payload: Serialize + JsonSchema;
}

/// page:loaded: документ загружен (M3 — детектор контента; каркас с 1.1).
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[allow(dead_code)]
pub struct PageLoaded {
    pub url: String,
}

impl BridgeEvent for PageLoaded {
    const NAME: &'static str = "page:loaded";
    type Payload = Self;
}

/// page:video_detected: на странице найден <video> (M3; каркас с 1.1).
/// tab_id — вкладка-источник (задача 3.7: кнопка «duo»/панель следят только
/// за активной вкладкой).
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct PageVideoDetected {
    pub tab_id: String,
    pub video_key: String,
    pub can_tracks: bool,
}

impl BridgeEvent for PageVideoDetected {
    const NAME: &'static str = "page:video_detected";
    type Payload = Self;
}

/// subtitles:tracks_ready: адаптер вкладки выдал полный список дорожек
/// видео (docs/05 §2) — панель наполняет выбор языков/переводов.
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubtitlesTracksReady {
    pub tab_id: String,
    pub video_key: String,
    pub base: Vec<crate::subtitles::service::BaseTrackInfo>,
    pub translations: Vec<crate::subtitles::service::TranslationLangInfo>,
}

#[derive(Debug, Clone)]
pub struct SubtitlesTracksReadyEvent;

impl BridgeEvent for SubtitlesTracksReadyEvent {
    const NAME: &'static str = "subtitles:tracks_ready";
    type Payload = SubtitlesTracksReady;
}

/// subtitles:set_applied: состояние показа вкладки изменилось (состав набора,
/// включён ли показ, сдвиг, стиль; docs/05 §2) — кнопка «duo» (выкл/1/дуо/три)
/// и панель обновляются событием; via — источник изменения (телеметрия:
/// alt-d/panel/select/drop/video/lost/…).
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubtitlesSetApplied {
    pub tab_id: String,
    /// None — видео ушло со страницы (детектор onVideoLost).
    pub video_key: Option<String>,
    pub enabled: bool,
    pub tracks: Vec<crate::subtitles::service::AppliedTrackInfo>,
    pub offset_ms: i64,
    pub style: crate::subtitles::service::SubtitlesStyleInfo,
    pub via: String,
}

#[derive(Debug, Clone)]
pub struct SubtitlesSetAppliedEvent;

impl BridgeEvent for SubtitlesSetAppliedEvent {
    const NAME: &'static str = "subtitles:set_applied";
    type Payload = SubtitlesSetApplied;
}

/// subtitles:translate_progress: конвейер перевода дорожки (задача 4.2,
/// docs/05 §2) — панель показывает «Перевод… 12/40» и итог (кэш/сеть/ошибка).
/// Тип и эмит — src/translate/pipeline.rs рядом с конвейером.
pub type SubtitlesTranslateProgress = crate::translate::SubtitlesTranslateProgress;

/// subtitles:translate_unavailable: бейдж «перевод недоступен» (задача 4.3,
/// docs/01 §5.4, docs/05 §2) — офлайн или нет провайдера; will_retry=true —
/// Core повторит сам при появлении сети (финал — обычный translate_progress).
/// Тип и эмит — src/translate/watcher.rs.
pub type SubtitlesTranslateUnavailable = crate::translate::SubtitlesTranslateUnavailable;

/// vpn:state_changed: состояние маршрутизации изменилось (каркас с 1.1;
/// начнёт эмититься с локальным роутером M6, docs/02 §6).
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct VpnStateChanged {
    pub state: proxy::ProxyState,
    pub detail: String,
}

impl BridgeEvent for VpnStateChanged {
    const NAME: &'static str = "vpn:state_changed";
    type Payload = Self;
}

/// adblock:blocked_count: прирост блокировок (батчинг ~400 мс в Core,
/// задача 2.1) — счётчик в главном меню.
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdblockBlockedCount {
    /// Прирост с прошлого события.
    pub delta: u64,
    /// Всего за сеанс.
    pub total: u64,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct AdblockBlockedCountEvent;

impl BridgeEvent for AdblockBlockedCountEvent {
    const NAME: &'static str = "adblock:blocked_count";
    type Payload = AdblockBlockedCount;
}

/// adblock:site_exception_changed: включено/снято исключение сайта
/// (payload события; on=false — сайт добавлен в white-list).
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdblockSiteException {
    pub site: String,
    pub on: bool,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct AdblockSiteExceptionChangedEvent;

impl BridgeEvent for AdblockSiteExceptionChangedEvent {
    const NAME: &'static str = "adblock:site_exception_changed";
    type Payload = AdblockSiteException;
}

/// tabs:updated: снапшот списка вкладок после любого изменения (открытие/
/// закрытие/переключение/переход/заголовок) — таб-бар перерисовывается им
/// (задача 1.2).
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct TabsUpdated;

impl BridgeEvent for TabsUpdated {
    const NAME: &'static str = "tabs:updated";
    type Payload = TabsListResult;
}

/// Эмитить событие контракта в UI|Content.
#[allow(dead_code)]
pub fn emit<E: BridgeEvent>(app: &AppHandle, payload: &E::Payload) -> Result<(), tauri::Error> {
    app.emit(E::NAME, payload)
}

// ---------------------------------------------------------------------------
// Реестр контракта → bridge/contract.json (генерация, не править руками)
// ---------------------------------------------------------------------------

macro_rules! schema {
    ($ty:ty) => {
        serde_json::to_value(schemars::schema_for!($ty)).expect("сериализация JSON Schema")
    };
}

/// Весь словарь команд/событий одним JSON-документом.
/// params/result = null — команда без параметров/без результата (void).
// Используется генерацией контракта (npm run gen:bridge → cargo test),
// не вызывается бинарём.
#[allow(dead_code)]
pub fn contract_json() -> serde_json::Value {
    serde_json::json!({
        "version": CONTRACT_VERSION,
        "commands": {
            "bridge.version": { "handler": "bridge_version", "params": null,
                                "result": schema!(BridgeVersionResult) },
            "tabs.list": { "handler": "tabs_list", "params": null,
                           "result": schema!(TabsListResult) },
            "tabs.open": { "handler": "tabs_open", "params": schema!(TabsOpenParams),
                           "result": schema!(TabsListResult) },
            "tabs.close": { "handler": "tabs_close", "params": schema!(TabsCloseParams),
                            "result": schema!(TabsListResult) },
            "tabs.reopen": { "handler": "tabs_reopen", "params": null,
                             "result": schema!(TabsListResult) },
            "tabs.activate": { "handler": "tabs_activate", "params": schema!(TabsActivateParams),
                               "result": schema!(TabsListResult) },
            "tabs.sleep": { "handler": "tabs_sleep", "params": schema!(TabsSleepParams),
                            "result": schema!(TabsListResult) },
            "tabs.wake": { "handler": "tabs_wake", "params": schema!(TabsWakeParams),
                           "result": schema!(TabsListResult) },
            "nav.navigate": { "handler": "nav_navigate", "params": schema!(NavNavigateParams),
                              "result": null },
            "nav.resolve_omnibox": { "handler": "nav_resolve_omnibox",
                                     "params": schema!(NavResolveOmniboxParams),
                                     "result": schema!(NavResolveOmniboxResult) },
            "nav.focus_page": { "handler": "nav_focus_page", "params": null, "result": null },
            "nav.go_back": { "handler": "nav_go_back", "params": null, "result": null },
            "nav.go_forward": { "handler": "nav_go_forward", "params": null, "result": null },
            "nav.reload": { "handler": "nav_reload", "params": null, "result": null },
            "history.search": { "handler": "history_search", "params": schema!(HistorySearchParams),
                                "result": schema!(HistorySearchResult) },
            "history.visit": { "handler": "history_visit", "params": schema!(HistoryVisitParams),
                               "result": null },
            "history.list": { "handler": "history_list", "params": schema!(HistoryListParams),
                              "result": schema!(HistoryListResult) },
            "history.delete_urls": { "handler": "history_delete_urls",
                                     "params": schema!(HistoryDeleteUrlsParams),
                                     "result": null },
            "history.delete_range": { "handler": "history_delete_range",
                                      "params": schema!(HistoryDeleteRangeParams),
                                      "result": null },
            "history.bookmark_add": { "handler": "history_bookmark_add",
                                      "params": schema!(HistoryBookmarkAddParams),
                                      "result": null },
            "history.bookmark_remove": { "handler": "history_bookmark_remove",
                                         "params": schema!(HistoryBookmarkRemoveParams),
                                         "result": null },
            "history.bookmark_update": { "handler": "history_bookmark_update",
                                         "params": schema!(HistoryBookmarkUpdateParams),
                                         "result": null },
            "history.bookmark_list": { "handler": "history_bookmark_list",
                                       "params": schema!(HistoryBookmarkListParams),
                                       "result": schema!(HistoryBookmarkListResult) },
            "settings.get": { "handler": "settings_get", "params": schema!(SettingsGetParams),
                              "result": schema!(ProxySettings) },
            "settings.set": { "handler": "settings_set", "params": schema!(SettingsSetParams),
                              "result": null },
            "settings.get_all": { "handler": "settings_get_all", "params": null,
                                  "result": schema!(SettingsAll) },
            "settings.apply": { "handler": "settings_apply", "params": schema!(SettingsPatch),
                                "result": null },
            "settings.export": { "handler": "settings_export",
                                 "params": schema!(SettingsExportParams),
                                 "result": schema!(SettingsExportResult) },
            "settings.import": { "handler": "settings_import",
                                 "params": schema!(SettingsImportParams),
                                 "result": schema!(SettingsImportResult) },
            "vpn.set_enabled": { "handler": "vpn_set_enabled", "params": schema!(VpnSetEnabledParams),
                                 "result": null },
            "vpn.status": { "handler": "vpn_status", "params": null,
                            "result": schema!(VpnStatusResult) },
            "vpn.test_connection": { "handler": "vpn_test_connection", "params": null,
                                     "result": schema!(VpnStatusResult) },
            "adblock.set_enabled": { "handler": "adblock_set_enabled",
                                      "params": schema!(AdblockSetEnabledParams),
                                      "result": schema!(AdblockStatusResult) },
            "adblock.status": { "handler": "adblock_status", "params": null,
                                 "result": schema!(AdblockStatusResult) },
            "adblock.update_lists": { "handler": "adblock_update_lists",
                                       "params": schema!(AdblockUpdateListsParams),
                                       "result": schema!(AdblockStatusResult) },
            "perf.snapshot": { "handler": "perf_snapshot", "params": null,
                                "result": schema!(crate::perf::PerfSnapshotResult) },
            "perf.save_run": { "handler": "perf_save_run",
                                "params": schema!(crate::perf::PerfSaveRunParams),
                                "result": null },
            "perf.list_runs": { "handler": "perf_list_runs", "params": null,
                                 "result": schema!(crate::perf::PerfRunListResult) },
            "subtitles.set_offset": { "handler": "subtitles_set_offset",
                                       "params": schema!(SubtitlesSetOffsetParams),
                                       "result": null },
            "subtitles.load_file": { "handler": "subtitles_load_file",
                                      "params": schema!(SubtitlesLoadFileParams),
                                      "result": schema!(SubtitlesLoadFileResult) },
            "subtitles.list_tracks": { "handler": "subtitles_list_tracks",
                                        "params": null,
                                        "result": schema!(SubtitlesListTracksResult) },
            "subtitles.set_tracks": { "handler": "subtitles_set_tracks",
                                       "params": schema!(SubtitlesSetTracksParams),
                                       "result": null },
            "subtitles.set_enabled": { "handler": "subtitles_set_enabled",
                                        "params": schema!(SubtitlesSetEnabledParams),
                                        "result": null },
            "subtitles.toggle": { "handler": "subtitles_toggle", "params": null, "result": null },
            "subtitles.set_style": { "handler": "subtitles_set_style",
                                      "params": schema!(SubtitlesSetStyleParams),
                                      "result": null },
            "subtitles.remove_track": { "handler": "subtitles_remove_track",
                                         "params": schema!(SubtitlesRemoveTrackParams),
                                         "result": null },
            "subtitles.translate_track": { "handler": "subtitles_translate_track",
                                            "params": schema!(SubtitlesTranslateTrackParams),
                                            "result": null },
            "translate.get_settings": { "handler": "translate_get_settings", "params": null,
                                         "result": schema!(TranslateGetSettingsResult) },
            "translate.set_settings": { "handler": "translate_set_settings",
                                         "params": schema!(TranslateSetSettingsParams),
                                         "result": null },
            "translate.test": { "handler": "translate_test", "params": schema!(TranslateTestParams),
                                 "result": schema!(TranslateTestResult) },
            "translate.clear_cache": { "handler": "translate_clear_cache", "params": null,
                                        "result": schema!(TranslateClearCacheResult) },
            "updater.status": { "handler": "updater_status", "params": null,
                                "result": schema!(crate::updater::UpdaterStatusResult) },
            "updater.check": { "handler": "updater_check", "params": null,
                               "result": schema!(crate::updater::UpdaterCheckResult) },
            "updater.install": { "handler": "updater_install", "params": null,
                                 "result": null },
            "app.restart": { "handler": "app_restart", "params": null, "result": null },
        },
        "events": {
            "tabs:updated": { "payload": schema!(TabsListResult) },
            "page:loaded": { "payload": schema!(PageLoaded) },
            "page:video_detected": { "payload": schema!(PageVideoDetected) },
            "vpn:state_changed": { "payload": schema!(VpnStateChanged) },
            "adblock:blocked_count": { "payload": schema!(AdblockBlockedCount) },
            "adblock:site_exception_changed": { "payload": schema!(AdblockSiteException) },
            "perf:startup_ms": { "payload": schema!(crate::perf::PerfStartupMs) },
            "perf:tab_switch_ms": { "payload": schema!(crate::perf::PerfTabSwitchMs) },
            "subtitles:tracks_ready": { "payload": schema!(SubtitlesTracksReady) },
            "subtitles:set_applied": { "payload": schema!(SubtitlesSetApplied) },
            "subtitles:translate_progress": { "payload": schema!(SubtitlesTranslateProgress) },
            "subtitles:translate_unavailable": { "payload": schema!(SubtitlesTranslateUnavailable) },
        },
    })
}

#[allow(dead_code)]
fn contract_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../bridge/contract.json")
}

/// Обновляет bridge/contract.json из кода (запуск: cargo test -- --ignored,
/// обёртка — npm run gen:bridge).
#[test]
#[ignore]
fn update_contract_file() {
    let path = contract_path();
    std::fs::create_dir_all(path.parent().expect("родитель bridge/")).expect("создать bridge/");
    let json = serde_json::to_string_pretty(&contract_json()).unwrap();
    std::fs::write(&path, json + "\n").expect("записать bridge/contract.json");
}

/// Защита от ручных правок генерённого: файл в репо обязан совпадать с кодом.
#[test]
fn contract_file_is_up_to_date() {
    let on_disk = std::fs::read_to_string(contract_path())
        .expect("bridge/contract.json существует (запусти: npm run gen:bridge)");
    let expected = serde_json::to_string_pretty(&contract_json()).unwrap() + "\n";
    assert_eq!(
        on_disk, expected,
        "bridge/contract.json расходится с Rust-типами: перегенерируй (npm run gen:bridge)"
    );
}

/// Имена событий в реестре и в trait-константах не разъезжаются.
#[test]
fn event_names_match_registry() {
    let contract = contract_json();
    let events = contract["events"].as_object().expect("events — объект");
    for (name, event) in events {
        let payload_title = event["payload"]["title"]
            .as_str()
            .expect("title у payload")
            .to_string();
        let known: Vec<(&str, String)> = [
            (<PageLoaded as BridgeEvent>::NAME, schema!(PageLoaded)),
            (
                <PageVideoDetected as BridgeEvent>::NAME,
                schema!(PageVideoDetected),
            ),
            (
                <VpnStateChanged as BridgeEvent>::NAME,
                schema!(VpnStateChanged),
            ),
            (<TabsUpdated as BridgeEvent>::NAME, schema!(TabsListResult)),
            (
                <AdblockBlockedCountEvent as BridgeEvent>::NAME,
                schema!(AdblockBlockedCount),
            ),
            (
                <AdblockSiteExceptionChangedEvent as BridgeEvent>::NAME,
                schema!(AdblockSiteException),
            ),
            (
                <crate::perf::PerfStartupEvent as BridgeEvent>::NAME,
                schema!(crate::perf::PerfStartupMs),
            ),
            (
                <crate::perf::PerfTabSwitchEvent as BridgeEvent>::NAME,
                schema!(crate::perf::PerfTabSwitchMs),
            ),
            (
                <SubtitlesTracksReadyEvent as BridgeEvent>::NAME,
                schema!(SubtitlesTracksReady),
            ),
            (
                <SubtitlesSetAppliedEvent as BridgeEvent>::NAME,
                schema!(SubtitlesSetApplied),
            ),
            (
                <crate::translate::pipeline::SubtitlesTranslateProgressEvent as BridgeEvent>::NAME,
                schema!(SubtitlesTranslateProgress),
            ),
            (
                <crate::translate::watcher::SubtitlesTranslateUnavailableEvent as BridgeEvent>::NAME,
                schema!(SubtitlesTranslateUnavailable),
            ),
        ]
        .into_iter()
        .map(|(n, s)| (n, s["title"].as_str().expect("title у схемы").to_string()))
        .collect();
        assert!(
            known
                .iter()
                .any(|(n, t)| *n == name.as_str() && *t == payload_title),
            "событие {name} ({payload_title}) не описано в BridgeEvent-константах"
        );
    }
}

// ---------------------------------------------------------------------------
// Команды (tauri-хендлеры) — единственное место IPC в Core
// ---------------------------------------------------------------------------

#[tauri::command]
fn bridge_version() -> BridgeVersionResult {
    BridgeVersionResult {
        version: CONTRACT_VERSION,
    }
}

#[tauri::command]
fn tabs_list(manager: tauri::State<'_, crate::tabs::TabManager>) -> TabsListResult {
    manager.snapshot()
}

/// tabs.open: async — создание webview это блокирующий round-trip на главный
/// поток, его нельзя делать на потоке цикла событий (см. tabs::open).
#[tauri::command]
async fn tabs_open(
    app: AppHandle,
    manager: tauri::State<'_, crate::tabs::TabManager>,
    params: TabsOpenParams,
) -> Result<TabsListResult, String> {
    manager.open(&app, params.url, None)
}

#[tauri::command]
fn tabs_close(
    app: AppHandle,
    manager: tauri::State<'_, crate::tabs::TabManager>,
    service: tauri::State<'_, crate::subtitles::service::SubtitlesService>,
    params: TabsCloseParams,
) -> Result<TabsListResult, String> {
    service.remove_tab(&params.id); // кэш состояния субтитров вкладки (3.7)
    manager.close(&app, &params.id)
}

/// tabs.reopen: async — как tabs.open, создаёт webview.
#[tauri::command]
async fn tabs_reopen(
    app: AppHandle,
    manager: tauri::State<'_, crate::tabs::TabManager>,
) -> Result<TabsListResult, String> {
    manager.reopen(&app)
}

/// tabs.activate: смена активной — состояние сразу (бар переключается),
/// webview ленивой вкладки создаёт фоновая задача (паттерн reopen —
/// создание webview не ждётся командой: add_child на горячем цикле событий
/// бывает медленным, команда обязана отвечать мгновенно).
#[tauri::command]
async fn tabs_activate(
    app: AppHandle,
    manager: tauri::State<'_, crate::tabs::TabManager>,
    params: TabsActivateParams,
) -> Result<TabsListResult, String> {
    let snapshot = manager.activate(&app, &params.id)?;
    let app = app.clone();
    let id = params.id;
    tauri::async_runtime::spawn(async move {
        let manager = app.state::<crate::tabs::TabManager>();
        if let Err(e) = manager.materialize(&app, &id) {
            eprintln!("tabs: материализация {id}: {e}");
            return;
        }
        if let Some(wv) = manager.active_webview(&app) {
            wv.set_focus().ok();
        }
    });
    Ok(snapshot)
}

/// tabs.sleep: усыпить вкладку (задача 2.3). Сам TrySuspend асинхронен —
/// команда отвечает снапшотом сразу, факт сна подтверждает tabs:updated.
#[tauri::command]
fn tabs_sleep(
    app: AppHandle,
    manager: tauri::State<'_, crate::tabs::TabManager>,
    params: TabsSleepParams,
) -> Result<TabsListResult, String> {
    manager.sleep_by_id(&app, &params.id)
}

/// tabs.wake: разбудить вкладку (задача 2.3; активация будит сама —
/// команда для диагностики/e2e).
#[tauri::command]
fn tabs_wake(
    app: AppHandle,
    manager: tauri::State<'_, crate::tabs::TabManager>,
    params: TabsWakeParams,
) -> Result<TabsListResult, String> {
    manager.wake_by_id(&app, &params.id)
}

/// nav.navigate: async — переход в ленивой вкладке сессии (задача 1.6)
/// создаёт webview (round-trip на главный поток — только из async-контекста).
#[tauri::command]
async fn nav_navigate(
    app: AppHandle,
    manager: tauri::State<'_, crate::tabs::TabManager>,
    params: NavNavigateParams,
) -> Result<(), String> {
    let url = Url::parse(&params.url).map_err(|e| format!("некорректный URL: {e}"))?;
    manager.navigate_active(&app, &url)
}

#[tauri::command]
fn nav_go_back(
    app: AppHandle,
    manager: tauri::State<'_, crate::tabs::TabManager>,
) -> Result<(), String> {
    eval_active(&app, &manager, "history.back()")
}

#[tauri::command]
fn nav_go_forward(
    app: AppHandle,
    manager: tauri::State<'_, crate::tabs::TabManager>,
) -> Result<(), String> {
    eval_active(&app, &manager, "history.forward()")
}

/// nav.resolve_omnibox: разбор ввода адресной строки (URL vs поиск) —
/// src/omnibox.rs, правила и тесты там. Задача 5.1: поисковик — настройка
/// «Поиск» (settings.json "search"), дефолт YouTube.
#[tauri::command]
fn nav_resolve_omnibox(params: NavResolveOmniboxParams) -> NavResolveOmniboxResult {
    let prefix = crate::settings::load_search(&proxy::profile_dir())
        .engine
        .url_prefix();
    let r = crate::omnibox::resolve_with(&params.input, prefix);
    NavResolveOmniboxResult {
        url: r.url,
        is_search: r.is_search,
    }
}

/// nav.focus_page: вернуть фокус контенту активной вкладки (Esc из omnibox —
/// задача 1.3). Вкладок нет — тихо ок (фокусить нечего).
#[tauri::command]
fn nav_focus_page(
    app: AppHandle,
    manager: tauri::State<'_, crate::tabs::TabManager>,
) -> Result<(), String> {
    if let Ok(wv) = active_webview(&app, &manager) {
        wv.set_focus().map_err(|e| format!("focus: {e}"))?;
    }
    Ok(())
}

/// history.search: подсказки omnibox по FTS5-индексу истории и закладок.
#[tauri::command]
fn history_search(
    history: tauri::State<'_, crate::history::HistoryStore>,
    params: HistorySearchParams,
) -> Result<HistorySearchResult, String> {
    Ok(HistorySearchResult {
        hits: history.search(&params.query, params.limit)?,
    })
}

/// history.visit: запись посещения (см. HistoryVisitParams — Core и сам
/// пишет визиты из on_page_load вкладок).
#[tauri::command]
fn history_visit(
    history: tauri::State<'_, crate::history::HistoryStore>,
    params: HistoryVisitParams,
) -> Result<(), String> {
    history.visit(&params.url, &params.title)
}

/// history.list: история для страницы управления (агрегат по URL).
#[tauri::command]
fn history_list(
    history: tauri::State<'_, crate::history::HistoryStore>,
    params: HistoryListParams,
) -> Result<HistoryListResult, String> {
    let (entries, total) = history.list(
        params.query.as_deref().unwrap_or(""),
        params.offset,
        params.limit,
    )?;
    Ok(HistoryListResult { entries, total })
}

/// history.delete_urls: удалить записи истории по адресам.
#[tauri::command]
fn history_delete_urls(
    history: tauri::State<'_, crate::history::HistoryStore>,
    params: HistoryDeleteUrlsParams,
) -> Result<(), String> {
    history.delete_urls(&params.urls)
}

/// history.delete_range: удалить историю за диапазон времени.
#[tauri::command]
fn history_delete_range(
    history: tauri::State<'_, crate::history::HistoryStore>,
    params: HistoryDeleteRangeParams,
) -> Result<(), String> {
    history.delete_range(params.from_ms, params.to_ms)
}

/// history.bookmark_add: добавить закладку (upsert по url).
#[tauri::command]
fn history_bookmark_add(
    history: tauri::State<'_, crate::history::HistoryStore>,
    params: HistoryBookmarkAddParams,
) -> Result<(), String> {
    history.bookmark_add(&params.url, &params.title)
}

/// history.bookmark_remove: удалить закладку.
#[tauri::command]
fn history_bookmark_remove(
    history: tauri::State<'_, crate::history::HistoryStore>,
    params: HistoryBookmarkRemoveParams,
) -> Result<(), String> {
    history.bookmark_remove(&params.url)
}

/// history.bookmark_update: переименовать закладку.
#[tauri::command]
fn history_bookmark_update(
    history: tauri::State<'_, crate::history::HistoryStore>,
    params: HistoryBookmarkUpdateParams,
) -> Result<(), String> {
    history.bookmark_update(&params.url, &params.title)
}

/// history.bookmark_list: закладки для страницы управления.
#[tauri::command]
fn history_bookmark_list(
    history: tauri::State<'_, crate::history::HistoryStore>,
    params: HistoryBookmarkListParams,
) -> Result<HistoryBookmarkListResult, String> {
    let (bookmarks, total) = history.bookmark_list(
        params.query.as_deref().unwrap_or(""),
        params.offset,
        params.limit,
    )?;
    Ok(HistoryBookmarkListResult { bookmarks, total })
}

#[tauri::command]
fn nav_reload(
    app: AppHandle,
    manager: tauri::State<'_, crate::tabs::TabManager>,
) -> Result<(), String> {
    eval_active(&app, &manager, "location.reload()")
}

fn active_webview(
    app: &AppHandle,
    manager: &tauri::State<'_, crate::tabs::TabManager>,
) -> Result<tauri::Webview<tauri::Wry>, String> {
    manager
        .active_webview(app)
        .ok_or_else(|| "активной вкладки нет".to_string())
}

fn eval_active(
    app: &AppHandle,
    manager: &tauri::State<'_, crate::tabs::TabManager>,
    js: &str,
) -> Result<(), String> {
    match manager.active_webview(app) {
        // Ленивая вкладка сессии (задача 1.6): документа и истории ещё нет —
        // back/forward/reload по ней нечего делать, это не ошибка.
        None if manager.active_is_lazy() => Ok(()),
        None => Err("активной вкладки нет".to_string()),
        Some(wv) => wv.eval(js).map_err(|e| format!("eval: {e}")),
    }
}

#[tauri::command]
fn settings_get(params: SettingsGetParams) -> Result<ProxySettings, String> {
    match params.key {
        SettingsKey::Proxy => {
            let dir = proxy::profile_dir();
            let cfg = proxy::load_config(&dir);
            Ok(proxy_settings(&cfg, &dir))
        }
    }
}

#[tauri::command]
fn settings_set(app: tauri::AppHandle, params: SettingsSetParams) -> Result<(), String> {
    match params.key {
        SettingsKey::Proxy => save_proxy(&app, &params.value, params.secret),
    }
}

// --- задача 5.1: полные настройки + перенос профиля (src/settings/) ----------

/// settings.get_all: снапшот всех разделов для страницы «Настройки».
#[tauri::command]
fn settings_get_all(
    adblock: tauri::State<'_, std::sync::Arc<crate::adblock::AdblockService>>,
) -> Result<SettingsAll, String> {
    let dir = proxy::profile_dir();
    let proxy_cfg = proxy::load_config(&dir);
    Ok(SettingsAll {
        schema_version: crate::settings::SETTINGS_SCHEMA_VERSION,
        appearance: crate::settings::load_appearance(&dir),
        search: crate::settings::load_search(&dir),
        engines: crate::settings::SearchEngine::ALL
            .into_iter()
            .map(|id| SearchEngineInfo {
                title: id.title().into(),
                id,
            })
            .collect(),
        subtitles: crate::settings::load_subtitles(&dir),
        privacy: crate::settings::load_privacy(&dir),
        updater: crate::settings::load_updater(&dir),
        proxy: proxy_settings(&proxy_cfg, &dir),
        adblock_enabled: adblock.status().enabled,
        translate: crate::translate::settings_view(&dir),
    })
}

/// settings.apply: записать названные разделы настроек (search/subtitles/
/// privacy; внешний вид v1 фиксирован — поле не в патче). Субтитры
/// нормализуются (язык, клампы стиля) до записи.
#[tauri::command]
fn settings_apply(params: SettingsPatch) -> Result<(), String> {
    let dir = proxy::profile_dir();
    if let Some(search) = params.search {
        crate::settings::save_search(&dir, &search)?;
    }
    if let Some(subtitles) = params.subtitles {
        crate::settings::save_subtitles(&dir, &subtitles.normalized())?;
    }
    if let Some(privacy) = params.privacy {
        crate::settings::save_privacy(&dir, &privacy)?;
    }
    if let Some(updater) = params.updater {
        crate::settings::save_updater(&dir, &updater)?;
    }
    Ok(())
}

/// settings.export: собрать профиль в один файл (задача 5.1). path — из
/// нативного диалога сохранения (UI); include_secrets — явный выбор
/// пользователя. Файлы/SQLite — sync-команда (паттерн history.*: короткие
/// обращения, действие редкое и инициируется пользователем).
#[tauri::command]
fn settings_export(
    history: tauri::State<'_, crate::history::HistoryStore>,
    cache: tauri::State<'_, std::sync::Arc<crate::subtitles::cache::TranslationsCache>>,
    params: SettingsExportParams,
) -> Result<SettingsExportResult, String> {
    let dir = proxy::profile_dir();
    let file = crate::settings::profile::build(&dir, &history, &cache, params.include_secrets)?;
    let counts = crate::settings::profile::counts_of(&file);
    let json =
        serde_json::to_string_pretty(&file).map_err(|e| format!("сериализация профиля: {e}"))?;
    let path = std::path::Path::new(&params.path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("создать каталог файла: {e}"))?;
    }
    std::fs::write(path, &json).map_err(|e| format!("записать {}: {e}", path.display()))?;
    let bytes = std::fs::metadata(path)
        .map(|m| m.len())
        .unwrap_or(json.len() as u64);
    Ok(SettingsExportResult { counts, bytes })
}

/// settings.import: применить файл профиля (настройки, секреты, закладки,
/// история, кэш переводов). Импорт идемпотентен; переехавший прокси
/// применяется роутером сразу — без перезапуска (задача 6.1).
#[tauri::command]
fn settings_import(
    app: tauri::AppHandle,
    history: tauri::State<'_, crate::history::HistoryStore>,
    cache: tauri::State<'_, std::sync::Arc<crate::subtitles::cache::TranslationsCache>>,
    params: SettingsImportParams,
) -> Result<SettingsImportResult, String> {
    let raw = std::fs::read_to_string(&params.path)
        .map_err(|e| format!("прочитать {}: {}", params.path, e))?;
    let file = crate::settings::profile::parse_file(&raw)?;
    let dir = proxy::profile_dir();
    let result = crate::settings::profile::apply(&dir, &file, &history, &cache)?;
    // Задача 6.1: роутер подхватывает импортированный прокси на лету.
    crate::vpn::router::apply_saved(&app, &dir);
    Ok(result)
}

/// vpn.set_enabled: переключить флаг прокси в сохранённом конфиге.
/// Включение валидирует сохранённый адрес (не форму UI — форма сохраняется
/// отдельной командой settings.set). Действует сразу — роутером (задача 6.1).
#[tauri::command]
fn vpn_set_enabled(app: tauri::AppHandle, params: VpnSetEnabledParams) -> Result<(), String> {
    let dir = proxy::profile_dir();
    let mut cfg = proxy::load_config(&dir);
    cfg.enabled = params.on;
    save_proxy(&app, &cfg, None)
}

#[tauri::command]
async fn vpn_status() -> Result<VpnStatusResult, String> {
    check_vpn().await
}

/// vpn.test_connection: та же проверка достижимости, что и в vpn.status —
/// по явному запросу пользователя (кнопка «Проверить»); в M6 дополнится
/// пингом/IP-эхом через маршрут.
#[tauri::command]
async fn vpn_test_connection() -> Result<VpnStatusResult, String> {
    check_vpn().await
}

async fn check_vpn() -> Result<VpnStatusResult, String> {
    let status = tauri::async_runtime::spawn_blocking(|| {
        proxy::check(&proxy::load_config(&proxy::profile_dir()))
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(VpnStatusResult {
        state: status.state,
        detail: status.detail,
    })
}

/// app.restart: перезапуск приложения (применение аргументов прокси WebView2 —
/// docs/02 §6.1, смена настроек действует со следующего старта).
#[tauri::command]
fn app_restart(app: AppHandle) {
    app.restart();
}

// --- задача 5.2: автообновление (src/updater.rs) ----------------------------

/// updater.status: снапшот автообновления — текущая версия, канал/автопроверка
/// (раздел настроек), последняя проверка и ожидающее обновление.
#[tauri::command]
fn updater_status(
    app: AppHandle,
    updater: tauri::State<'_, crate::updater::UpdaterService>,
) -> crate::updater::UpdaterStatusResult {
    let cfg = crate::settings::load_updater(&proxy::profile_dir());
    updater.status(
        app.package_info().version.to_string(),
        cfg.channel,
        cfg.auto_check,
    )
}

/// updater.check: проверить фид канала из настроек (async — сеть плагина);
/// найденный пакет запоминается в сервисе до install/следующей проверки.
/// Отказ — в поле error результата (не Err): UI показывает причину.
#[tauri::command]
async fn updater_check(
    app: AppHandle,
    updater: tauri::State<'_, crate::updater::UpdaterService>,
) -> Result<crate::updater::UpdaterCheckResult, String> {
    let channel = crate::settings::load_updater(&proxy::profile_dir()).channel;
    Ok(crate::updater::run_check(&app, &updater, channel).await)
}

/// updater.install: скачать подписанный пакет последней проверки и установить.
/// Windows: плагин запускает NSIS (/P /UPDATE /R) и завершает процесс — при
/// успехе команда не возвращается, приложение поднимет установщик.
#[tauri::command]
async fn updater_install(
    updater: tauri::State<'_, crate::updater::UpdaterService>,
) -> Result<(), String> {
    crate::updater::install_pending(&updater).await
}

/// adblock.set_enabled: глобальный тумблер или исключение сайта (задача 2.1).
#[tauri::command]
fn adblock_set_enabled(
    app: AppHandle,
    adblock: tauri::State<'_, std::sync::Arc<crate::adblock::AdblockService>>,
    params: AdblockSetEnabledParams,
) -> Result<AdblockStatusResult, String> {
    adblock.set_enabled(&app, params.site.as_deref(), params.on)
}

/// adblock.status: снапшот состояния блокировщика (меню, e2e, P-07).
#[tauri::command]
fn adblock_status(
    adblock: tauri::State<'_, std::sync::Arc<crate::adblock::AdblockService>>,
) -> AdblockStatusResult {
    adblock.status()
}

/// adblock.update_lists: фоновое обновление списков; force — даже свежих.
/// Команда отвечает сразу (текущий статус), загрузка продолжается в фоне.
#[tauri::command]
fn adblock_update_lists(
    adblock: tauri::State<'_, std::sync::Arc<crate::adblock::AdblockService>>,
    params: AdblockUpdateListsParams,
) -> AdblockStatusResult {
    adblock.update_lists(params.force)
}

/// perf.snapshot: живой срез сеанса для страницы «Диагностика» (задача 2.5) —
/// старт и его фазы, переключения вкладок, RAM оболочки, вкладки, счётчики
/// блокировщика.
#[tauri::command]
fn perf_snapshot(
    manager: tauri::State<'_, crate::tabs::TabManager>,
    adblock: tauri::State<'_, std::sync::Arc<crate::adblock::AdblockService>>,
) -> crate::perf::PerfSnapshotResult {
    let tabs = manager.snapshot();
    let ad = adblock.status();
    crate::perf::PerfSnapshotResult {
        startup: crate::perf::startup_info(),
        tab_switch: crate::perf::tab_switch_info(),
        ram_self_mb: crate::perf::ram_self_mb(),
        uptime_ms: crate::perf::uptime_ms(),
        tabs: crate::perf::PerfTabs {
            total: tabs.tabs.len() as u32,
            sleeping: tabs.tabs.iter().filter(|t| t.sleeping).count() as u32,
        },
        adblock: crate::perf::PerfAdblock {
            ready: ad.ready,
            enabled: ad.enabled,
            blocked_total: ad.blocked_total,
            seen_total: ad.seen_total,
        },
    }
}

/// perf.save_run: сохранить прогон метрик в историю (последние 10,
/// docs/04 §3) — срез живого сеанса со страницы или итог эталонного
/// e2e-прогона (e2e/perf/save-run.mjs).
#[tauri::command]
fn perf_save_run(
    store: tauri::State<'_, crate::perf::PerfStore>,
    params: crate::perf::PerfSaveRunParams,
) -> Result<(), String> {
    store.save_run(&params.label, &params.metrics)
}

/// perf.list_runs: прогоны истории для графика, новые → старые.
#[tauri::command]
fn perf_list_runs(
    store: tauri::State<'_, crate::perf::PerfStore>,
) -> Result<crate::perf::PerfRunListResult, String> {
    Ok(crate::perf::PerfRunListResult {
        runs: store.list_runs()?,
    })
}

/// subtitles.set_offset (задача 3.5): сдвиг субтитров активной вкладки.
/// Доставка — eval в активный webview (как nav.*): документ диспатчит
/// duopulse-set-offset, content-бандл применяет сдвиг движком (кламп ±10 с —
/// и здесь, и в движке) без перезагрузки дорожек и открывает HUD (docs/03 §4).
/// Ленивая вкладка без документа — тихо ок (применять нечего).
#[tauri::command]
fn subtitles_set_offset(
    app: AppHandle,
    manager: tauri::State<'_, crate::tabs::TabManager>,
    params: SubtitlesSetOffsetParams,
) -> Result<(), String> {
    let offset_ms = params
        .offset_ms
        .clamp(-SUBTITLES_OFFSET_LIMIT_MS, SUBTITLES_OFFSET_LIMIT_MS);
    let js = format!(
        "document.dispatchEvent(new CustomEvent('duopulse-set-offset',{{detail:{{offsetMs:{offset_ms}}}}}))"
    );
    match manager.active_webview(&app) {
        None if manager.active_is_lazy() => Ok(()),
        None => Err("активной вкладки нет".to_string()),
        Some(wv) => wv.eval(&js).map_err(|e| format!("eval: {e}")),
    }
}

/// subtitles.load_file (задача 3.6): ручной файл .srt/.vtt с диска — чтение и
/// разбор в Core, доставка cue в content-слой активной вкладки (eval диспатчит
/// duopulse-file-track, паттерн subtitles.set_offset; файловая дорожка входит
/// в общий набор — docs/01 F-06). Файл читается на блокирующем пуле (spawn_
/// blocking), ответ команды — итог разбора для панели. Ленивая вкладка без
/// документа — доставка пропускается (не ошибка, как у set_offset).
///
/// eval — строго на главном потоке (run_on_main_thread): sync-команды tauri
/// исполняются там сами, а у async-команда с tokio-пула ExecuteScript в
/// апартментном COM WebView2 тихо не исполнялся (e2e 3.6: Ok без эффекта).
#[tauri::command]
async fn subtitles_load_file(
    app: AppHandle,
    manager: tauri::State<'_, crate::tabs::TabManager>,
    params: SubtitlesLoadFileParams,
) -> Result<SubtitlesLoadFileResult, String> {
    let track = {
        let path = std::path::PathBuf::from(&params.path);
        tauri::async_runtime::spawn_blocking(move || crate::subtitles::read_manual_file(&path))
            .await
            .map_err(|e| e.to_string())?? // join-ошибка, затем отказ чтения файла
    };
    // JSON — валидный JS-объектный литерал: вкладывается как detail события.
    let detail = serde_json::json!({
        "name": track.name,
        "cues": track.cues.iter().map(|c| serde_json::json!({
            "startMs": c.start_ms, "endMs": c.end_ms, "text": c.text,
        })).collect::<Vec<_>>(),
        "warnings": track.warnings.iter()
            .map(|w| format!("строка {}: {}", w.line, w.message))
            .collect::<Vec<_>>(),
    });
    // Склейка без format!: тройные экранирования скобок однажды уже дали
    // SyntaxError в eval (тихий Ok у ExecuteScript — e2e 3.6 ловил час).
    let detail_json =
        serde_json::to_string(&detail).map_err(|e| format!("сериализация detail: {e}"))?;
    let mut js =
        String::from("document.dispatchEvent(new CustomEvent('duopulse-file-track',{detail:");
    js.push_str(&detail_json);
    js.push_str("}))");
    match manager.active_webview(&app) {
        None if manager.active_is_lazy() => {}
        None => return Err("активной вкладки нет".to_string()),
        Some(wv) => {
            let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
            app.run_on_main_thread(move || {
                let _ = tx.send(wv.eval(&js).map_err(|e| format!("eval: {e}")));
            })
            .map_err(|e| format!("планирование на главном потоке: {e}"))?;
            rx.recv().map_err(|e| format!("eval-канал: {e}"))??;
        }
    }
    Ok(SubtitlesLoadFileResult {
        name: track.name,
        cue_count: track.cues.len() as u32,
        warnings: track
            .warnings
            .iter()
            .map(|w| format!("строка {}: {}", w.line, w.message))
            .collect(),
    })
}

// --- задача 3.7: панель настроек набора + кнопка «duo» (docs/03 §8) ----------

/// Диспатч document-события в активную контентную вкладку (паттерн
/// subtitles.set_offset, задачи 3.5–3.7). JS собирается конкатенацией без
/// format!: тройные скобки в eval уже давали тихий SyntaxError (e2e 3.6).
/// Ленивая вкладка без документа — тихо ок (применять нечего).
fn eval_active_event(
    app: &AppHandle,
    manager: &tauri::State<'_, crate::tabs::TabManager>,
    event: &str,
    detail: &serde_json::Value,
) -> Result<(), String> {
    let detail_json =
        serde_json::to_string(detail).map_err(|e| format!("сериализация detail: {e}"))?;
    let mut js = String::from("document.dispatchEvent(new CustomEvent('");
    js.push_str(event);
    js.push_str("',{detail:");
    js.push_str(&detail_json);
    js.push_str("}))");
    match manager.active_webview(app) {
        None if manager.active_is_lazy() => Ok(()),
        None => Err("активной вкладки нет".to_string()),
        Some(wv) => wv.eval(&js).map_err(|e| format!("eval: {e}")),
    }
}

/// Идентификатор активной вкладки (нет активной — пусто: снапшот пустого
/// состояния, панель покажет «видео не найдено»).
fn active_tab_id(manager: &tauri::State<'_, crate::tabs::TabManager>) -> String {
    manager
        .snapshot()
        .tabs
        .into_iter()
        .find(|t| t.active)
        .map(|t| t.id)
        .unwrap_or_default()
}

/// subtitles.list_tracks: снапшот состояния субтитров активной вкладки
/// (сервис состояния — кэш сообщений content-слоя, задача 3.7).
#[tauri::command]
fn subtitles_list_tracks(
    manager: tauri::State<'_, crate::tabs::TabManager>,
    service: tauri::State<'_, crate::subtitles::service::SubtitlesService>,
) -> SubtitlesListTracksResult {
    service.snapshot(&active_tab_id(&manager))
}

/// subtitles.set_tracks: применить платформенную часть набора активной
/// вкладки — eval диспатчит duopulse-select-tracks (content-слой задачи
/// 3.3+3.7: загрузка выбранных дорожек, fast-path перестановки).
#[tauri::command]
fn subtitles_set_tracks(
    app: AppHandle,
    manager: tauri::State<'_, crate::tabs::TabManager>,
    params: SubtitlesSetTracksParams,
) -> Result<(), String> {
    if params.ids.len() > 3 {
        return Err("набор — до 3 дорожек (docs/03 §1)".to_string());
    }
    eval_active_event(
        &app,
        &manager,
        "duopulse-select-tracks",
        &serde_json::json!({ "ids": params.ids }),
    )
}

/// subtitles.set_enabled: включить/выключить показ набора активной вкладки
/// (тумблер панели; состав помнят обе стороны — docs/03 §8 п.2).
#[tauri::command]
fn subtitles_set_enabled(
    app: AppHandle,
    manager: tauri::State<'_, crate::tabs::TabManager>,
    params: SubtitlesSetEnabledParams,
) -> Result<(), String> {
    eval_active_event(
        &app,
        &manager,
        "duopulse-toggle",
        &serde_json::json!({ "enabled": params.on, "via": "panel" }),
    )
}

/// subtitles.toggle: переключить показ набора (Alt+D из хрома — в странице
/// клавишу ловит сам content-слой; без detail — «переключить», включение на
/// пустом наборе собирает дефолт «оригинал + ru» в content-слое).
#[tauri::command]
fn subtitles_toggle(
    app: AppHandle,
    manager: tauri::State<'_, crate::tabs::TabManager>,
) -> Result<(), String> {
    eval_active_event(&app, &manager, "duopulse-toggle", &serde_json::json!({}))
}

/// subtitles.set_style: стиль плашки активной вкладки (панель: размер/
/// позиция; патч — неназванные поля не меняются).
#[tauri::command]
fn subtitles_set_style(
    app: AppHandle,
    manager: tauri::State<'_, crate::tabs::TabManager>,
    params: SubtitlesSetStyleParams,
) -> Result<(), String> {
    let style = serde_json::to_value(&params.style).map_err(|e| format!("стиль: {e}"))?;
    eval_active_event(
        &app,
        &manager,
        "duopulse-set-style",
        &serde_json::json!({ "style": style }),
    )
}

/// subtitles.remove_track: снять дорожку из набора активной вкладки (панель,
/// «×» у строки) — eval диспатчит duopulse-remove-track.
#[tauri::command]
fn subtitles_remove_track(
    app: AppHandle,
    manager: tauri::State<'_, crate::tabs::TabManager>,
    params: SubtitlesRemoveTrackParams,
) -> Result<(), String> {
    eval_active_event(
        &app,
        &manager,
        "duopulse-remove-track",
        &serde_json::json!({ "id": params.id }),
    )
}

/// Языковой код из панели: 2–3 буквы + необязательный подтег («pt-br»).
fn is_lang_code(lang: &str) -> bool {
    let mut parts = lang.splitn(2, '-');
    let primary = parts.next().unwrap_or_default();
    let sub = parts.next().unwrap_or_default();
    (2..=3).contains(&primary.len())
        && primary.bytes().all(|b| b.is_ascii_lowercase())
        && (sub.is_empty()
            || (2..=8).contains(&sub.len()) && sub.bytes().all(|b| b.is_ascii_alphanumeric()))
}

/// subtitles.translate_track: запустить облачный перевод дорожки набора
/// активной вкладки (задача 4.2, docs/03 §7). Источник — trackId или лучшая
/// строка набора по снапшоту сервиса (первая не-переводная, предпочтение
/// оригиналу); cues в Core нет — eval диспатчит duopulse-translate-request,
/// content-слой ответит WebMessage'м «translate-track» с cue (конвейер —
/// src/translate/pipeline.rs). Прогресс/итог — события
/// subtitles:translate_progress, команда возвращается сразу.
#[tauri::command]
fn subtitles_translate_track(
    app: AppHandle,
    manager: tauri::State<'_, crate::tabs::TabManager>,
    service: tauri::State<'_, crate::subtitles::service::SubtitlesService>,
    params: SubtitlesTranslateTrackParams,
) -> Result<(), String> {
    let lang = params.target_lang.trim().to_ascii_lowercase();
    if !is_lang_code(&lang) {
        return Err("целевой язык — код из 2–3 букв (ru, es, pt-br)".into());
    }
    let snap = service.snapshot(&active_tab_id(&manager));
    let track_id = params
        .track_id
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .or_else(|| {
            // Дефолт-источник: оригинал, иначе первая не-облачная строка.
            snap.tracks
                .iter()
                .find(|t| t.source != "translate" && t.role == "original")
                .or_else(|| snap.tracks.iter().find(|t| t.source != "translate"))
                .map(|t| t.id.clone())
        })
        .filter(|id| snap.tracks.iter().any(|t| &t.id == id))
        .ok_or_else(|| "в наборе нет дорожки-источника — добавьте дорожку или файл".to_string())?;
    eval_active_event(
        &app,
        &manager,
        "duopulse-translate-request",
        &serde_json::json!({ "trackId": track_id, "targetLang": lang }),
    )
}

fn proxy_settings(cfg: &proxy::ProxyConfig, dir: &std::path::Path) -> ProxySettings {
    ProxySettings {
        enabled: cfg.enabled,
        proto: cfg.proto,
        host: cfg.host.clone(),
        port: cfg.port,
        login: cfg.login.clone(),
        has_password: proxy::has_password(dir),
    }
}

// --- задача 4.1: команды перевода (src/translate/, docs/03 §7) ---------------

/// translate.get_settings: снапшот настроек перевода для панели «Перевод».
#[tauri::command]
fn translate_get_settings() -> Result<TranslateGetSettingsResult, String> {
    Ok(crate::translate::settings_view(&proxy::profile_dir()))
}

/// translate.set_settings: сохранить конфиг (settings.json, ключ "translate")
/// и секрет выбранного провайдера (DPAPI). Включённый конфиг валидируется.
#[tauri::command]
fn translate_set_settings(params: TranslateSetSettingsParams) -> Result<(), String> {
    crate::translate::save_settings(
        &proxy::profile_dir(),
        &params.value,
        params.secret.as_deref(),
    )
}

/// translate.test: один живой запрос выбранного провайдера (кнопка
/// «Проверить» панели). HTTP блокирующий — spawn_blocking; ретраев нет
/// (одна попытка — быстрая обратная связь), результат всегда ок=true/false
/// с диагностикой, Err — только транспорт команды не поднялся.
#[tauri::command]
async fn translate_test(params: TranslateTestParams) -> Result<TranslateTestResult, String> {
    let text = params
        .text
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| "DuoPulse dual subtitles".into());
    let target_lang = params
        .target_lang
        .filter(|l| !l.trim().is_empty())
        .unwrap_or_else(|| "ru".into());
    let dir = proxy::profile_dir();
    let translated = tauri::async_runtime::spawn_blocking(move || {
        crate::translate::test_provider(&dir, &text, &target_lang)
    })
    .await
    .map_err(|e| e.to_string())?;
    match translated {
        Ok(t) => Ok(TranslateTestResult {
            ok: true,
            detail: "провайдер отвечает".into(),
            translated: Some(t),
        }),
        Err(e) => Ok(TranslateTestResult {
            ok: false,
            detail: e.message(),
            translated: None,
        }),
    }
}

/// translate.clear_cache (приватность, задача 5.1): очистить кэш переведённых
/// дорожек — повторные просмотры снова пойдут в провайдер.
#[tauri::command]
fn translate_clear_cache(
    cache: tauri::State<'_, std::sync::Arc<crate::subtitles::cache::TranslationsCache>>,
) -> TranslateClearCacheResult {
    TranslateClearCacheResult {
        cleared: cache.clear() as u32,
    }
}

fn save_proxy(
    app: &tauri::AppHandle,
    cfg: &proxy::ProxyConfig,
    secret: Option<String>,
) -> Result<(), String> {
    if cfg.enabled {
        cfg.validate()?;
    }
    let dir = proxy::profile_dir();
    proxy::save_config(&dir, cfg)?;
    match secret.as_deref() {
        None => {}
        Some("") => proxy::clear_password(&dir),
        Some(p) => proxy::save_password(&dir, p)?,
    }
    // Задача 6.1: режим применяет роутер — сразу, без перезапуска.
    crate::vpn::router::apply_saved(app, &dir);
    Ok(())
}

/// Регистрация всех команд контракта на билдере Tauri (docs/05 §1:
/// IPC-хендлеры живут в bridge.rs, main — только сборка приложения).
pub fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.invoke_handler(tauri::generate_handler![
        bridge_version,
        tabs_list,
        tabs_open,
        tabs_close,
        tabs_reopen,
        tabs_activate,
        tabs_sleep,
        tabs_wake,
        nav_navigate,
        nav_resolve_omnibox,
        nav_focus_page,
        nav_go_back,
        nav_go_forward,
        nav_reload,
        history_search,
        history_visit,
        history_list,
        history_delete_urls,
        history_delete_range,
        history_bookmark_add,
        history_bookmark_remove,
        history_bookmark_update,
        history_bookmark_list,
        settings_get,
        settings_set,
        settings_get_all,
        settings_apply,
        settings_export,
        settings_import,
        vpn_set_enabled,
        vpn_status,
        vpn_test_connection,
        adblock_set_enabled,
        adblock_status,
        adblock_update_lists,
        perf_snapshot,
        perf_save_run,
        perf_list_runs,
        subtitles_set_offset,
        subtitles_load_file,
        subtitles_list_tracks,
        subtitles_set_tracks,
        subtitles_set_enabled,
        subtitles_toggle,
        subtitles_set_style,
        subtitles_remove_track,
        subtitles_translate_track,
        translate_get_settings,
        translate_set_settings,
        translate_test,
        translate_clear_cache,
        updater_status,
        updater_check,
        updater_install,
        app_restart
    ])
}
