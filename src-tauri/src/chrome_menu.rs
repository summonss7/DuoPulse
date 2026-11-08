//! Нативные popup-меню хрома (карточка duopulse-086).
//!
//! Контентные webview вкладок — нативные child-инстансы WebView2, и их
//! композитор всегда рисует поверх HTML UI-webview: z-order дочерних HWND
//! между webview не действует (проверено спайком карточки — свап обёрток
//! WRY_WEBVIEW + hide/show не меняет картинку). Любое выпадающее меню,
//! выезжающее за полосу хрома (84px), физически уходило под страницу —
//! «звёздочка ничего не делает», таб-меню видно было до первого пункта.
//!
//! Отдельный webview-оверлей (окном и child-webview) не состоялся: у окна,
//! созданного скрытым, WebView2 не просыпается на show — чёрный
//! прямоугольник при живом DOM; child-webview не презентует кадры после
//! ресайза. Поэтому меню — нативные popup'ы muda (tauri::menu): системный
//! рендер поверх всех webview, модальность и Escape из коробки.
//!
//! Механика: UI-webview вызывает ui_menu_open {kind, x, y, payload} — Core
//! строит меню (пункты/доступность из payload) и показывает popup у точки
//! (x/y — клиентские логические координаты UI-webview → физические через
//! scale_factor). Выбор пункта приходит в on_menu_event (main.rs) и
//! пересылается событием «menu-action» в UI — транспорт совпадает с
//! прежним оверлеем, фронтенд (tabbar.ts/star.ts) не зависит от бэкенда.
//! Идентификаторы пунктов: «tab:<act>» и «star:g:<id группы>» /
//! «star:newgroup».

use serde_json::Value;
use tauri::menu::{ContextMenu, Menu, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, Manager, Position};

/// Таб-меню: подписи и акселераторы как в разметке index.html (до 086).
const TAB_ITEMS: &[(&str, &str, Option<&str>)] = &[
    ("newtab", "Новая вкладка", Some("Ctrl+T")),
    ("duplicate", "Дублировать вкладку", None),
    ("sleep", "Усыпить вкладку", None),
    ("close", "Закрыть вкладку", None),
    ("closeOthers", "Закрыть другие вкладки", None),
    ("reopen", "Переоткрыть закрытую", Some("Ctrl+Shift+T")),
];

fn item<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
    text: &str,
    enabled: bool,
    accel: Option<&str>,
) -> Result<MenuItem<R>, String> {
    MenuItem::with_id(app, id, text, enabled, accel).map_err(|e| format!("пункт меню: {e}"))
}

/// Меню вкладки: вкладочные действия, недоступные — из payload.disabled.
fn build_tab_menu(app: &AppHandle, payload: &Value) -> Result<Menu<tauri::Wry>, String> {
    let disabled: Vec<String> = payload
        .get("disabled")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();
    let mut items: Vec<tauri::menu::MenuItem<tauri::Wry>> = Vec::new();
    for (act, label, accel) in TAB_ITEMS {
        items.push(item(
            app,
            &format!("tab:{act}"),
            label,
            !disabled.iter().any(|d| d == act),
            *accel,
        )?);
    }
    let menu = Menu::new(app).map_err(|e| format!("меню: {e}"))?;
    for it in items {
        menu.append(&it).map_err(|e| format!("меню: {e}"))?;
    }
    Ok(menu)
}

/// Меню звёздочки: группы избранного + «Новая группа…» (без текстового
/// ввода в нативном меню — ведёт на страницу управления закладками).
fn build_star_menu(app: &AppHandle, payload: &Value) -> Result<Menu<tauri::Wry>, String> {
    let menu = Menu::new(app).map_err(|e| format!("меню: {e}"))?;
    let groups = payload
        .get("groups")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for g in &groups {
        let id = g.get("id").and_then(Value::as_i64).unwrap_or(-1);
        let name = g
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("?")
            .to_string();
        let is_default = g.get("isDefault").and_then(Value::as_bool).unwrap_or(false);
        let label = if is_default {
            format!("{name} · по умолчанию")
        } else {
            name
        };
        menu.append(&item(app, &format!("star:g:{id}"), &label, true, None)?)
            .map_err(|e| format!("меню: {e}"))?;
    }
    menu.append(&PredefinedMenuItem::separator(app).map_err(|e| format!("меню: {e}"))?)
        .map_err(|e| format!("меню: {e}"))?;
    menu.append(&item(
        app,
        "star:newgroup",
        "Новая группа… (в управлении)",
        true,
        None,
    )?)
    .map_err(|e| format!("меню: {e}"))?;
    Ok(menu)
}

/// Показать popup-меню у точки (x/y — клиентские логические координаты
/// UI-webview). Модально: команда ждёт закрытия в отдельном потоке.
#[tauri::command]
pub async fn ui_menu_open(
    app: AppHandle,
    kind: String,
    x: f64,
    y: f64,
    payload: Option<Value>,
) -> Result<(), String> {
    let payload = payload.unwrap_or(Value::Null);
    let menu = match kind.as_str() {
        "tab" => build_tab_menu(&app, &payload)?,
        "star" => build_star_menu(&app, &payload)?,
        other => return Err(format!("неизвестное меню: {other}")),
    };
    let window = app.get_window("main").ok_or("окно main не найдено")?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let origin = window.inner_position().map_err(|e| e.to_string())?;
    let px = tauri::PhysicalPosition::new(
        origin.x + (x * scale).round() as i32,
        origin.y + (y * scale).round() as i32,
    );
    // popup модален (TrackPopupMenu) — не занимаем поток IPC
    tauri::async_runtime::spawn_blocking(move || menu.popup_at(window, Position::Physical(px)))
        .await
        .map_err(|e| format!("popup: {e}"))?
        .map_err(|e| format!("popup: {e}"))?;
    Ok(())
}

/// Переслать выбор пункта в UI (подписка main.rs на on_menu_event).
pub fn emit_action(app: &AppHandle, id: &str) {
    use tauri::Emitter;
    // «tab:<act>» / «star:g:<id>» / «star:newgroup» → «menu-action»
    let action = if let Some(act) = id.strip_prefix("tab:") {
        serde_json::json!({ "menu": "tab", "act": act })
    } else if let Some(g) = id.strip_prefix("star:g:") {
        serde_json::json!({ "menu": "star", "groupId": g.parse::<i64>().unwrap_or(-1) })
    } else if id == "star:newgroup" {
        serde_json::json!({ "menu": "star", "newGroup": true })
    } else {
        return;
    };
    let _ = app.emit_to("main", "menu-action", &action);
}
