//! DuoPulse — закладки на мобильной ветке (карточка duopulse-104): те же
//! команды history.*, что регистрирует десктопный bridge.rs (имена и форма
//! аргументов `invoke(name, { params })` совпадают — фронтенд переиспользует
//! TS-клиент bridge.history без изменений), но только подмножество закладок:
//! вкладки/история посещений на мобильной обёртке не существуют (один iframe,
//! визиты не пишутся — см. шапку lib.rs). Хранилище — общее с десктопом
//! HistoryStore (SQLite в профиле); на Android каталог профиля — filesDir
//! приложения (JNI getFilesDir, как cacheDir в mobile_updater).
//!
//! Модуль компилируется только мобильными таргетами (lib.rs) — как history:
//! на десктопе команды уже есть в bridge.rs, дубль в либе не нужен.
//!
//! Этап 6 (duopulse-112): мутаторы будят воркер синка аккаунта Aila
//! (schedule_sync, как Ctrl+D десктопа на этапе 5) — локальные правки
//! закладок уезжают в облако с дебаунсом, без входа вызов — no-op.

use crate::history::contract::{
    BookmarkGroupInfo, HistoryBookmarkAddParams, HistoryBookmarkListParams,
    HistoryBookmarkListResult, HistoryBookmarkMoveParams, HistoryBookmarkRemoveParams,
    HistoryBookmarkUpdateParams, HistoryGroupAddParams, HistoryGroupListResult,
    HistoryGroupMoveParams, HistoryGroupRemoveParams, HistoryGroupRenameParams,
    HistoryGroupSetSortParams, HistoryGroupToggleBookmarkParams,
};
use crate::history::{GroupFilter, HistoryStore};

/// Каталог профиля мобильной ветки: filesDir/profile (на Android создаётся
/// приложением, изолирован от остальных). Ошибка JNI — наверх в setup.
pub fn profile_dir() -> Result<std::path::PathBuf, String> {
    files_dir().map(|d| d.join("profile"))
}

#[cfg(target_os = "android")]
fn files_dir() -> Result<std::path::PathBuf, String> {
    crate::mobile_jni::with_jni(|env, context| {
        let dir = crate::mobile_jni::call_obj(env, context, "getFilesDir", "()Ljava/io/File;")?;
        let s =
            crate::mobile_jni::call_string(env, &dir, "getAbsolutePath", "()Ljava/lang/String;")?;
        Ok(std::path::PathBuf::from(s))
    })
}

#[cfg(not(target_os = "android"))]
fn files_dir() -> Result<std::path::PathBuf, String> {
    Err("каталог профиля на этой платформе недоступен".to_string())
}

/// history.bookmark_add: добавить закладку (upsert по url); groupId — группа
/// (null — по умолчанию), как на десктопе (duopulse-058).
#[tauri::command]
pub fn history_bookmark_add(
    history: tauri::State<'_, std::sync::Arc<HistoryStore>>,
    account: tauri::State<'_, std::sync::Arc<crate::aila::AilaAccount>>,
    params: HistoryBookmarkAddParams,
) -> Result<(), String> {
    history.bookmark_add_to(&params.url, &params.title, params.group_id)?;
    account.schedule_sync();
    Ok(())
}

/// history.bookmark_remove: удалить закладку (идемпотентна).
#[tauri::command]
pub fn history_bookmark_remove(
    history: tauri::State<'_, std::sync::Arc<HistoryStore>>,
    account: tauri::State<'_, std::sync::Arc<crate::aila::AilaAccount>>,
    params: HistoryBookmarkRemoveParams,
) -> Result<(), String> {
    history.bookmark_remove(&params.url)?;
    account.schedule_sync();
    Ok(())
}

/// history.bookmark_update: переименовать закладку.
#[tauri::command]
pub fn history_bookmark_update(
    history: tauri::State<'_, std::sync::Arc<HistoryStore>>,
    account: tauri::State<'_, std::sync::Arc<crate::aila::AilaAccount>>,
    params: HistoryBookmarkUpdateParams,
) -> Result<(), String> {
    history.bookmark_update(&params.url, &params.title)?;
    account.schedule_sync();
    Ok(())
}

/// history.bookmark_list: закладки (groupId: null — все, -1 — без группы,
/// id — члены группы в её порядке).
#[tauri::command]
pub fn history_bookmark_list(
    history: tauri::State<'_, std::sync::Arc<HistoryStore>>,
    params: HistoryBookmarkListParams,
) -> Result<HistoryBookmarkListResult, String> {
    let group = match params.group_id {
        None => GroupFilter::All,
        Some(-1) => GroupFilter::Ungrouped,
        Some(id) => GroupFilter::Group(id),
    };
    let (bookmarks, total) = history.bookmark_list(
        params.query.as_deref().unwrap_or(""),
        group,
        params.offset,
        params.limit,
    )?;
    Ok(HistoryBookmarkListResult { bookmarks, total })
}

/// history.group_list: группы с числом закладок.
#[tauri::command]
pub fn history_group_list(
    history: tauri::State<'_, std::sync::Arc<HistoryStore>>,
) -> Result<HistoryGroupListResult, String> {
    Ok(HistoryGroupListResult {
        groups: history.group_list()?,
    })
}

/// history.group_add: создать группу (duopulse-151: parentId — подгруппа).
#[tauri::command]
pub fn history_group_add(
    history: tauri::State<'_, std::sync::Arc<HistoryStore>>,
    account: tauri::State<'_, std::sync::Arc<crate::aila::AilaAccount>>,
    params: HistoryGroupAddParams,
) -> Result<BookmarkGroupInfo, String> {
    let group = history.group_add(&params.name, params.parent_id)?;
    account.schedule_sync();
    Ok(group)
}

/// history.group_move: переложить группу в другого родителя (duopulse-151).
#[tauri::command]
pub fn history_group_move(
    history: tauri::State<'_, std::sync::Arc<HistoryStore>>,
    account: tauri::State<'_, std::sync::Arc<crate::aila::AilaAccount>>,
    params: HistoryGroupMoveParams,
) -> Result<(), String> {
    history.group_move(params.id, params.parent_id)?;
    account.schedule_sync();
    Ok(())
}

/// history.group_rename: переименовать группу.
#[tauri::command]
pub fn history_group_rename(
    history: tauri::State<'_, std::sync::Arc<HistoryStore>>,
    account: tauri::State<'_, std::sync::Arc<crate::aila::AilaAccount>>,
    params: HistoryGroupRenameParams,
) -> Result<(), String> {
    history.group_rename(params.id, &params.name)?;
    account.schedule_sync();
    Ok(())
}

/// history.group_remove: удалить группу (закладки остаются).
#[tauri::command]
pub fn history_group_remove(
    history: tauri::State<'_, std::sync::Arc<HistoryStore>>,
    account: tauri::State<'_, std::sync::Arc<crate::aila::AilaAccount>>,
    params: HistoryGroupRemoveParams,
) -> Result<(), String> {
    history.group_remove(params.id)?;
    account.schedule_sync();
    Ok(())
}

/// history.group_set_sort: режим сортировки группы (manual | title | added).
#[tauri::command]
pub fn history_group_set_sort(
    history: tauri::State<'_, std::sync::Arc<HistoryStore>>,
    account: tauri::State<'_, std::sync::Arc<crate::aila::AilaAccount>>,
    params: HistoryGroupSetSortParams,
) -> Result<(), String> {
    history.group_set_sort(params.id, &params.sort_by)?;
    account.schedule_sync();
    Ok(())
}

/// history.group_toggle_bookmark: членство закладки в группе вкл/выкл
/// (перекладывание пальцем между группами — duopulse-104).
#[tauri::command]
pub fn history_group_toggle_bookmark(
    history: tauri::State<'_, std::sync::Arc<HistoryStore>>,
    account: tauri::State<'_, std::sync::Arc<crate::aila::AilaAccount>>,
    params: HistoryGroupToggleBookmarkParams,
) -> Result<(), String> {
    history.group_toggle_bookmark(&params.url, params.group_id, params.on)?;
    account.schedule_sync();
    Ok(())
}

/// history.bookmark_move: переставить закладку внутри группы (позиция 0 — верх).
#[tauri::command]
pub fn history_bookmark_move(
    history: tauri::State<'_, std::sync::Arc<HistoryStore>>,
    account: tauri::State<'_, std::sync::Arc<crate::aila::AilaAccount>>,
    params: HistoryBookmarkMoveParams,
) -> Result<(), String> {
    history.bookmark_move(&params.url, params.group_id, params.position)?;
    account.schedule_sync();
    Ok(())
}
