//! Язык UI мобильной ветки (карточка duopulse-138, этап 4 i18n): язык живёт
//! в Core — раздел "ui" мобильного settings.json (функции load/save общие
//! с десктопом — settings/mod.rs), каталог — профиль мобильной ветки
//! (mobile_history::profile_dir, filesDir/profile). Начальное значение
//! страница читает из window.__DUOPULSE_UI_LANG__ — init-скрипт ui_lang_init_
//! script, который либа вешает append_invoke_initialization_script: у окон
//! из конфига Tauri своего init-скрипта нет, а хук Builder-а инжектится во
//! все webview до скриптов страницы (проверено по tauri-2.12 app.rs — уходит
//! в main-frame initialization_scripts). localStorage страницы остаётся
//! живым кэшем, но инкогнито-очистка WebView (WebStorage.deleteAllData,
//! duopulse-096) его стирает — Core остаётся единственным источником.
//!
//! Модуль целиком — только мобильным таргетам (объявлен cfg в lib.rs, как
//! history/mobile_history): #[tauri::command] в desktop-либе быть не должно
//! (0xc0000139, см. шапку mobile_open.rs). Событие settings:ui_lang_changed
//! не эмитим: UI-webview на телефоне один, его перезагружает сам setUiLang
//! (location.reload).

use crate::settings::{save_ui, UiConfig};

/// mobile.ui_lang_set: записать язык UI (нормализация — UiConfig::normalized:
/// неизвестный/пустой → «ru»), вернуть сохранённое значение.
#[tauri::command]
pub fn mobile_ui_lang_set(lang: String) -> Result<String, String> {
    let cfg = UiConfig { lang }.normalized();
    let dir = crate::mobile_history::profile_dir()?;
    save_ui(&dir, &cfg)?;
    Ok(cfg.lang)
}

/// Init-скрипт языка UI мобильной ветки (аналог ui_lang_script десктопа, но
/// каталог профиля — мобильный). Недоступный каталог (не Android) — дефолт
/// «ru»: load_ui по отсутствующему пути возвращает дефолт раздела.
pub fn ui_lang_init_script() -> String {
    let dir = crate::mobile_history::profile_dir().unwrap_or_default();
    crate::settings::ui_lang_script(&dir)
}
