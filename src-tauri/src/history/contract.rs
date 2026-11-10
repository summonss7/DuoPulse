//! Контрактные типы домена history (bridge-словарь `history.*`), карточка
//! duopulse-104: выделены из bridge.rs, чтобы мобильная либа (lib.rs) могла
//! компилировать хранилище history с его типами без всего десктопного bridge
//! (там же и команды вкладок/VPN/настроек с Windows-зависимостями). bridge.rs
//! реэкспортирует отсюда всё (`pub use`), поэтому пути `crate::bridge::*` и
//! генерация contract.json не меняются — схемы у schemars по именам типов.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

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
    /// Имена групп закладки «Имя · Имя» (карточка duopulse-058; только у
    /// подсказок-закладок, вне групп — null).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
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
#[serde(rename_all = "camelCase")]
pub struct HistoryBookmarkAddParams {
    pub url: String,
    #[serde(default)]
    pub title: String,
    /// Группа закладки (карточка duopulse-058): null — группа по умолчанию
    /// («Избранное»), id — выбранная в мини-меню звёздочки.
    #[serde(default)]
    pub group_id: Option<i64>,
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
    /// Фильтр групп (карточка duopulse-058): null — все; -1 — без группы;
    /// id — члены группы в её порядке сортировки.
    #[serde(default)]
    pub group_id: Option<i64>,
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
    /// Группы закладки (карточка duopulse-058; пусто — без группы). В файле
    /// профиля id — машины-источника (импорт мапит по имени).
    #[serde(default)]
    pub groups: Vec<BookmarkGroupRef>,
}

/// Ссылка на группу в строке закладки: id + имя (для UI-меток и профиля).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkGroupRef {
    pub id: i64,
    pub name: String,
}

/// Строка дампа/импорта групп (файл профиля, карточка duopulse-058): id —
/// машины-источника (импорт мапит по имени), position/sortBy/isDefault —
/// как в BookmarkGroupInfo.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkGroupRow {
    pub id: i64,
    pub name: String,
    pub position: u32,
    /// manual | title | added.
    pub sort_by: String,
    pub is_default: bool,
}

// --- карточка duopulse-058: группы избранного --------------------------------

/// Группа закладок для UI: имя, позиция в ряду групп, режим сортировки
/// (manual | title | added), флаг «по умолчанию» и число закладок.
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkGroupInfo {
    pub id: i64,
    pub name: String,
    pub position: u32,
    /// manual | title | added.
    pub sort_by: String,
    pub is_default: bool,
    pub count: u32,
}

/// history.group_list: группы с числом закладок.
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryGroupListResult {
    pub groups: Vec<BookmarkGroupInfo>,
}

/// history.group_add: создать группу (имя уникально).
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryGroupAddParams {
    pub name: String,
}

/// history.group_rename: переименовать группу.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryGroupRenameParams {
    pub id: i64,
    pub name: String,
}

/// history.group_remove: удалить группу (закладки остаются; группа по
/// умолчанию не удаляется).
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryGroupRemoveParams {
    pub id: i64,
}

/// history.group_set_sort: режим сортировки группы — manual | title | added.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryGroupSetSortParams {
    pub id: i64,
    /// manual | title | added.
    pub sort_by: String,
}

/// history.group_toggle_bookmark: членство закладки в группе вкл/выкл
/// (закладка может состоять в нескольких группах или ни в одной).
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryGroupToggleBookmarkParams {
    pub url: String,
    pub group_id: i64,
    pub on: bool,
}

/// history.bookmark_move: переставить закладку внутри группы (drag&drop;
/// позиция 0 = верх, за пределами списка — клампится).
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryBookmarkMoveParams {
    pub url: String,
    pub group_id: i64,
    pub position: u32,
}
