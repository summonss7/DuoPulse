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
//! «star:newgroup», «bmfolder:<url>» (папка строки закладок, duopulse-143).

use serde_json::Value;
use tauri::menu::{CheckMenuItem, ContextMenu, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, Position};

/// Таб-меню: подписи и акселераторы как в разметке index.html (до 086).
/// Инкогнито-пункты — карточка duopulse-096.
const TAB_ITEMS: &[(&str, &str, Option<&str>)] = &[
    ("newtab", "Новая вкладка", Some("Ctrl+T")),
    (
        "newIncognito",
        "Новая вкладка инкогнито",
        Some("Ctrl+Shift+N"),
    ),
    ("duplicate", "Дублировать вкладку", None),
    ("openIncognito", "Открыть копию в инкогнито", None),
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

/// Меню папки строки закладок (карточка duopulse-143): закладки группы в её
/// порядке сортировки (manual/title/added — как на странице управления),
/// до 500; пустая — один неактивный пункт. Идентификатор пункта — url
/// закладки, выбор уходит в UI событием menu-action.
/// duopulse-151: подгруппы — подменю той же сборки (рекурсивно, дерево ≤ 3);
/// идут перед закладками, как папки в меню Chrome.
fn build_bmfolder_menu(app: &AppHandle, payload: &Value) -> Result<Menu<tauri::Wry>, String> {
    let group_id = payload
        .get("groupId")
        .and_then(Value::as_i64)
        .ok_or("папка закладок не указана")?;
    let history = app.state::<std::sync::Arc<crate::history::HistoryStore>>();
    let mut menu = Menu::new(app).map_err(|e| format!("меню: {e}"))?;
    let kids = child_groups(&history, group_id);
    if !kids.is_empty() {
        for g in &kids {
            let sub = build_group_submenu(app, &history, g)?;
            menu.append(&sub).map_err(|e| format!("меню: {e}"))?;
        }
        menu.append(&PredefinedMenuItem::separator(app).map_err(|e| format!("меню: {e}"))?)
            .map_err(|e| format!("меню: {e}"))?;
    }
    let (bookmarks, _) = history.bookmark_list(
        "",
        crate::history::GroupFilter::Group(group_id),
        0,
        500,
    )?;
    if bookmarks.is_empty() && kids.is_empty() {
        menu.append(&item(app, "bmfolder:none", "Папка пуста", false, None)?)
            .map_err(|e| format!("меню: {e}"))?;
        return Ok(menu);
    }
    for b in &bookmarks {
        let label = b.title.trim();
        let label = if label.is_empty() { b.url.as_str() } else { label };
        menu.append(&item(app, &format!("bmfolder:{}", b.url), label, true, None)?)
            .map_err(|e| format!("меню: {e}"))?;
    }
    Ok(menu)
}

/// Дочерние группы папки (по позициям) — подменю bmfolder.
fn child_groups(
    history: &std::sync::Arc<crate::history::HistoryStore>,
    parent: i64,
) -> Vec<crate::history::contract::BookmarkGroupInfo> {
    history
        .group_list()
        .unwrap_or_default()
        .into_iter()
        .filter(|g| g.parent_id == Some(parent))
        .collect()
}

/// Подменю подгруппы: её подгруппы (рекурсивно), затем закладки.
fn build_group_submenu(
    app: &AppHandle,
    history: &std::sync::Arc<crate::history::HistoryStore>,
    group: &crate::history::contract::BookmarkGroupInfo,
) -> Result<Submenu<tauri::Wry>, String> {
    let sub = Submenu::with_id(
        app,
        format!("bmfolder:g:{}", group.id),
        &group.name,
        true,
    )
    .map_err(|e| format!("подменю: {e}"))?;
    let kids = child_groups(history, group.id);
    if !kids.is_empty() {
        for g in &kids {
            let inner = build_group_submenu(app, history, g)?;
            sub.append(&inner).map_err(|e| format!("подменю: {e}"))?;
        }
        sub.append(&PredefinedMenuItem::separator(app).map_err(|e| format!("меню: {e}"))?)
            .map_err(|e| format!("меню: {e}"))?;
    }
    let (bookmarks, _) = history.bookmark_list(
        "",
        crate::history::GroupFilter::Group(group.id),
        0,
        500,
    )?;
    if bookmarks.is_empty() && kids.is_empty() {
        sub.append(&item(app, "bmfolder:none", "Пусто", false, None)?)
            .map_err(|e| format!("подменю: {e}"))?;
        return Ok(sub);
    }
    for b in &bookmarks {
        let label = b.title.trim();
        let label = if label.is_empty() { b.url.as_str() } else { label };
        sub.append(&item(app, &format!("bmfolder:{}", b.url), label, true, None)?)
            .map_err(|e| format!("подменю: {e}"))?;
    }
    Ok(sub)
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
        // label — с путём вложенности («Родитель › Ребёнок», duopulse-151);
        // остался name — плоский список (старый payload)
        let label = g
            .get("label")
            .and_then(Value::as_str)
            .map(String::from)
            .or_else(|| g.get("name").and_then(Value::as_str).map(String::from))
            .unwrap_or_else(|| "?".into());
        let is_default = g.get("isDefault").and_then(Value::as_bool).unwrap_or(false);
        let label = if is_default {
            format!("{label} · по умолчанию")
        } else {
            label
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

/// Шаги размера плашки в меню duo (точный размер слайдером — панель/страница
/// настроек; в меню — быстрый выбор, клампы — в content-слое).
const DUO_SCALES: &[i32] = &[75, 100, 125, 150, 175, 200, 250, 300];

fn check<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
    text: &str,
    checked: bool,
) -> Result<CheckMenuItem<R>, String> {
    CheckMenuItem::with_id(app, id, text, true, checked, None::<&str>)
        .map_err(|e| format!("пункт меню: {e}"))
}

fn separator<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<PredefinedMenuItem<R>, String> {
    PredefinedMenuItem::separator(app).map_err(|e| format!("меню: {e}"))
}

fn submenu<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
    text: &str,
    items: &[&dyn tauri::menu::IsMenuItem<R>],
) -> Result<Submenu<R>, String> {
    Submenu::with_id_and_items(app, id, text, true, items).map_err(|e| format!("подменю: {e}"))
}

/// Меню кнопки duo (карточка duopulse-087: «не могу найти, где настроить
/// языки субтитров и формат плашки» — HTML-панель уходит под страницу, вход
/// в настройки субтитров стал нативным меню поверх webview). Состав:
/// показ набора, языки текущего видео (оригинал/перевод), перевод по
/// умолчанию для новых видео, формат плашки (позиция/размер/вид), сдвиг
/// синхронизации, свои субтитры, ASR, переход на страницу настроек.
/// Варианты и текущие отметки считает UI (payload), здесь — только сборка
/// muda-меню: чекбоксы по флагу current, подменю для списков.
fn build_duo_menu(app: &AppHandle, payload: &Value) -> Result<Menu<tauri::Wry>, String> {
    let menu = Menu::new(app).map_err(|e| format!("меню: {e}"))?;
    let append = |it: &dyn tauri::menu::IsMenuItem<tauri::Wry>| -> Result<(), String> {
        menu.append(it).map_err(|e| format!("меню: {e}"))
    };

    let enabled = payload
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let has_video = payload
        .get("hasVideo")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    append(
        &CheckMenuItem::with_id(
            app,
            "duo:toggle",
            "Показ субтитров",
            true,
            enabled,
            Some("Alt+D"),
        )
        .map_err(|e| format!("пункт меню: {e}"))?,
    )?;

    // --- языки текущего видео: оригинал и перевод (подменю, ✓ текущий)
    let from: Vec<Value> = payload
        .get("from")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let to: Vec<Value> = payload
        .get("to")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !from.is_empty() || !to.is_empty() {
        append(&separator(app)?)?;
    }
    if !from.is_empty() {
        let mut items: Vec<CheckMenuItem<tauri::Wry>> = Vec::new();
        for (i, f) in from.iter().enumerate() {
            items.push(check(
                app,
                &format!("duo:from:{i}"),
                f.get("name").and_then(Value::as_str).unwrap_or("?"),
                f.get("current").and_then(Value::as_bool).unwrap_or(false),
            )?);
        }
        let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
            items.iter().map(|i| i as _).collect();
        append(&submenu(app, "duo-from", "Язык видео", &refs)?)?;
    }
    if !to.is_empty() {
        // «Нет» и платформенные — до разделителя, облачные — после
        let (mut head, mut cloud): (
            Vec<CheckMenuItem<tauri::Wry>>,
            Vec<CheckMenuItem<tauri::Wry>>,
        ) = (Vec::new(), Vec::new());
        for (i, t) in to.iter().enumerate() {
            let item = check(
                app,
                &format!("duo:to:{i}"),
                t.get("name").and_then(Value::as_str).unwrap_or("?"),
                t.get("current").and_then(Value::as_bool).unwrap_or(false),
            )?;
            if t.get("group").and_then(Value::as_str) == Some("cloud") {
                cloud.push(item);
            } else {
                head.push(item);
            }
        }
        let sep = (!cloud.is_empty()).then(|| separator(app)).transpose()?;
        let mut refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
            head.iter().map(|i| i as _).collect();
        if let Some(s) = &sep {
            refs.push(s);
        }
        for it in &cloud {
            refs.push(it);
        }
        append(&submenu(app, "duo-to", "Перевод", &refs)?)?;
    }

    // --- перевод по умолчанию для новых видео (settings.subtitles)
    let def_langs: Vec<Value> = payload
        .get("defLangs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !def_langs.is_empty() {
        let mut items: Vec<CheckMenuItem<tauri::Wry>> = Vec::new();
        let def = payload.get("defLang").and_then(Value::as_str).unwrap_or("");
        for l in &def_langs {
            let code = l.get("code").and_then(Value::as_str).unwrap_or("");
            let name = l.get("name").and_then(Value::as_str).unwrap_or(code);
            items.push(check(
                app,
                &format!("duo:deflang:{code}"),
                &format!("{name} ({code})"),
                code == def,
            )?);
        }
        let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
            items.iter().map(|i| i as _).collect();
        append(&submenu(
            app,
            "duo-deflang",
            "Перевод по умолчанию (новые видео)",
            &refs,
        )?)?;
    }

    // --- формат плашки: позиция, размер, вид (пресеты)
    append(&separator(app)?)?;
    let style = payload.get("style").cloned().unwrap_or_default();
    let position = style
        .get("position")
        .and_then(Value::as_str)
        .unwrap_or("bottom");
    let mut pos_items: Vec<CheckMenuItem<tauri::Wry>> = Vec::new();
    for (pos, label) in [("bottom", "Низ"), ("top", "Верх")] {
        pos_items.push(check(
            app,
            &format!("duo:pos:{pos}"),
            label,
            position == pos,
        )?);
    }
    let pos_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
        pos_items.iter().map(|i| i as _).collect();
    append(&submenu(app, "duo-pos", "Позиция плашки", &pos_refs)?)?;

    let scale = style
        .get("fontScalePct")
        .and_then(Value::as_i64)
        .unwrap_or(100) as i32;
    let mut scale_items: Vec<CheckMenuItem<tauri::Wry>> = Vec::new();
    for pct in DUO_SCALES {
        scale_items.push(check(
            app,
            &format!("duo:scale:{pct}"),
            &format!("{pct}%"),
            *pct == scale,
        )?);
    }
    let scale_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
        scale_items.iter().map(|i| i as _).collect();
    append(&submenu(app, "duo-scale", "Размер плашки", &scale_refs)?)?;

    let look = style.get("look").and_then(Value::as_str);
    let mut look_items: Vec<CheckMenuItem<tauri::Wry>> = Vec::new();
    for p in payload
        .get("lookPresets")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let id = p.get("id").and_then(Value::as_str).unwrap_or("");
        let label = p.get("label").and_then(Value::as_str).unwrap_or(id);
        look_items.push(check(
            app,
            &format!("duo:look:{id}"),
            label,
            look == Some(id),
        )?);
    }
    look_items.push(check(
        app,
        "duo:look:custom",
        "Свои (точные — на странице настроек)",
        look.is_none(),
    )?);
    let look_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
        look_items.iter().map(|i| i as _).collect();
    append(&submenu(app, "duo-look", "Вид плашки", &look_refs)?)?;

    // --- синхронизация: шаг слайдера панели 100 мс, здесь по 0,5 с
    let mut off_items: Vec<MenuItem<tauri::Wry>> = Vec::new();
    for (delta, label) in [
        (-500, "Раньше на 0,5 с"),
        (0, "Сброс (0 с)"),
        (500, "Позже на 0,5 с"),
    ] {
        off_items.push(
            MenuItem::with_id(
                app,
                &format!("duo:offset:{delta}"),
                label,
                true,
                None::<&str>,
            )
            .map_err(|e| format!("пункт меню: {e}"))?,
        );
    }
    let off_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
        off_items.iter().map(|i| i as _).collect();
    append(&submenu(
        app,
        "duo-offset",
        "Синхронизация (сдвиг субтитров)",
        &off_refs,
    )?)?;

    // --- свои субтитры / ASR / полный вход в настройки
    append(&separator(app)?)?;
    append(
        &MenuItem::with_id(
            app,
            "duo:file",
            "Свои субтитры… (.srt / .vtt)",
            has_video,
            None::<&str>,
        )
        .map_err(|e| format!("пункт меню: {e}"))?,
    )?;
    append(
        &MenuItem::with_id(
            app,
            "duo:asr",
            "Распознать речь (ASR)…",
            has_video,
            None::<&str>,
        )
        .map_err(|e| format!("пункт меню: {e}"))?,
    )?;
    append(&separator(app)?)?;
    // Полная панель duo (карточка 090): все контролы набора/стиля — в popup-окне
    // над webview; пункт из 087 остаётся быстрым входом.
    append(
        &MenuItem::with_id(
            app,
            "duo:panel",
            "Полная панель субтитров…",
            true,
            None::<&str>,
        )
        .map_err(|e| format!("пункт меню: {e}"))?,
    )?;
    append(
        &MenuItem::with_id(
            app,
            "duo:settings",
            "Все настройки субтитров…",
            true,
            None::<&str>,
        )
        .map_err(|e| format!("пункт меню: {e}"))?,
    )?;
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
        "duo" => build_duo_menu(&app, &payload)?,
        "bmfolder" => build_bmfolder_menu(&app, &payload)?,
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
    // «tab:<act>» / «star:g:<id>» / «star:newgroup» / «duo:<act>[:<парам>]»
    let action = if let Some(act) = id.strip_prefix("tab:") {
        serde_json::json!({ "menu": "tab", "act": act })
    } else if let Some(g) = id.strip_prefix("star:g:") {
        serde_json::json!({ "menu": "star", "groupId": g.parse::<i64>().unwrap_or(-1) })
    } else if id == "star:newgroup" {
        serde_json::json!({ "menu": "star", "newGroup": true })
    } else if let Some(url) = id.strip_prefix("bmfolder:") {
        // папка строки закладок (duopulse-143): пункт — url закладки
        // («none» — заглушка пустой папки, не действие)
        if url == "none" || url.is_empty() {
            return;
        }
        serde_json::json!({ "menu": "bmfolder", "url": url })
    } else if let Some(rest) = id.strip_prefix("duo:") {
        let (act, param) = rest.split_once(':').unwrap_or((rest, ""));
        match act {
            // индексы — в payload, с которым меню построено (duo.ts хранит снапшот)
            "toggle" => serde_json::json!({ "menu": "duo", "act": "toggle" }),
            "from" | "to" => serde_json::json!({
                "menu": "duo", "act": act,
                "index": param.parse::<usize>().unwrap_or(usize::MAX),
            }),
            "deflang" => serde_json::json!({ "menu": "duo", "act": "deflang", "lang": param }),
            "pos" => serde_json::json!({ "menu": "duo", "act": "pos", "pos": param }),
            "scale" => serde_json::json!({
                "menu": "duo", "act": "scale",
                "pct": param.parse::<i32>().unwrap_or(100),
            }),
            "look" => serde_json::json!({ "menu": "duo", "act": "look", "look": param }),
            "offset" => serde_json::json!({
                "menu": "duo", "act": "offset",
                "deltaMs": param.parse::<i64>().unwrap_or(0),
            }),
            "file" => serde_json::json!({ "menu": "duo", "act": "file" }),
            "asr" => serde_json::json!({ "menu": "duo", "act": "asr" }),
            "panel" => serde_json::json!({ "menu": "duo", "act": "panel" }),
            "settings" => serde_json::json!({ "menu": "duo", "act": "settings" }),
            _ => return,
        }
    } else {
        return;
    };
    let _ = app.emit_to("main", "menu-action", &action);
}
