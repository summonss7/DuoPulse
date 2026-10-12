//! Менеджер вкладок Core (задача 1.2, docs/02 §3, docs/05 §1–2): жизненный
//! цикл WebView2-инстансов «одна вкладка = один дочерний webview» под полосой
//! хрома, порядок/активная вкладка/стек закрытых для восстановления.
//! Спящий режим (M2) и восстановление сессии (задача 1.6) добавятся сюда же.
//!
//! Взаимодействие UI — только через команды/события контракта bridge
//! (`tabs.{open, close, reopen, activate, list}`, событие `tabs:updated`);
//! хендлеры-обёртки — src/bridge.rs. URL/заголовок вкладки отслеживаются
//! событиями webview (on_page_load / on_document_title_changed) и хранятся
//! в менеджере — tabs.list читает их из состояния, не опрашивая webview.

use std::collections::VecDeque;
use std::sync::Mutex;

use tauri::{
    webview::{PageLoadEvent, WebviewBuilder},
    AppHandle, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl, Window,
};

use crate::bridge::{emit, TabInfo, TabsListResult, TabsUpdated};

/// Высота полосы хрома в логических пикселях: таб-бар + навбар.
/// Синхронизирована с #app (grid-template-rows) в src/style.css.
pub(crate) const CHROME_HEIGHT: f64 = 84.0;

/// Глубина стека закрытых вкладок для tabs.reopen (Ctrl+Shift+T).
const CLOSED_STACK_CAP: usize = 25;

/// Стартовая страница: первый таб и новые вкладки (кнопка «+», tabs.open без
/// url). DUOPULSE_START_URL переопределяет для e2e-стендов; страница
/// «Новая вкладка» (docs/05 §1 pages/NewTab) придёт в задаче 1.5.
fn default_tab_url() -> String {
    std::env::var("DUOPULSE_START_URL").unwrap_or_else(|_| "https://www.youtube.com/".into())
}

/// Размер дочернего webview вкладки под полосой хрома.
fn content_rect(window: &Window<tauri::Wry>) -> (LogicalPosition<f64>, LogicalSize<f64>) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let size = window
        .inner_size()
        .unwrap_or_default()
        .to_logical::<f64>(scale);
    (
        LogicalPosition::new(0.0, CHROME_HEIGHT),
        LogicalSize::new(size.width, (size.height - CHROME_HEIGHT).max(0.0)),
    )
}

/// Состояние менеджера вкладок (регистрируется через app.manage).
pub struct TabManager {
    state: Mutex<TabsState>,
}

#[derive(Default)]
struct TabsState {
    /// Вкладки в порядке следования в таб-баре; label webview == id вкладки.
    tabs: Vec<TabEntry>,
    /// Индекс активной вкладки (None — все вкладки закрыты).
    active: Option<usize>,
    /// Счётчик id: tab-1, tab-2… Метки webview не переиспользуются.
    next_seq: u64,
    /// Стек закрытых для tabs.reopen: (url, позиция в баре на момент закрытия).
    closed: VecDeque<(String, usize)>,
}

struct TabEntry {
    id: String,
    url: String,
    title: Option<String>,
    /// Идёт загрузка документа (пульс-индикатор на вкладке, гайд 06 §3).
    loading: bool,
}

impl TabEntry {
    fn info(&self, active: bool) -> TabInfo {
        TabInfo {
            id: self.id.clone(),
            url: self.url.clone(),
            title: self.title.clone(),
            active,
            loading: self.loading,
        }
    }
}

impl Default for TabManager {
    fn default() -> Self {
        Self::new()
    }
}

impl TabManager {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(TabsState::default()),
        }
    }
    /// Снапшот списка вкладок для tabs.list / события tabs.updated.
    pub fn snapshot(&self) -> TabsListResult {
        let st = self.state.lock().expect("tabs: лок не отравлен");
        TabsListResult {
            tabs: st
                .tabs
                .iter()
                .enumerate()
                .map(|(i, t)| t.info(st.active == Some(i)))
                .collect(),
        }
    }

    /// Активный webview (цель nav.* из задачи 1.1: навигация активной вкладки).
    pub fn active_webview(&self, app: &AppHandle) -> Option<tauri::Webview<tauri::Wry>> {
        let id = {
            let st = self.state.lock().expect("tabs: лок не отравлен");
            st.active.map(|i| st.tabs[i].id.clone())?
        };
        app.get_webview(&id)
    }

    /// Первая вкладка приложения (вызывается из setup окна).
    pub fn init(&self, app: &AppHandle) -> Result<(), String> {
        self.spawn_tab(app, default_tab_url(), None)?;
        Ok(())
    }

    /// tabs.open: новая вкладка, становится активной (как в браузерах).
    /// Вызывается из async-команды: создание webview — блокирующий round-trip
    /// на главный поток, его нельзя делать на потоке цикла событий.
    pub fn open(
        &self,
        app: &AppHandle,
        url: Option<String>,
        position: Option<usize>,
    ) -> Result<TabsListResult, String> {
        self.spawn_tab(app, url.unwrap_or_else(default_tab_url), position)
    }

    /// tabs.reopen (Ctrl+Shift+T): последняя закрытая возвращается на прежнюю
    /// позицию бара. WebView2 не восстанавливает уничтоженный инстанс — вкладка
    /// создаётся заново по URL (id новый).
    pub fn reopen(&self, app: &AppHandle) -> Result<TabsListResult, String> {
        let (url, index) = {
            let mut st = self.state.lock().expect("tabs: лок не отравлен");
            st.closed
                .pop_back()
                .ok_or_else(|| "закрытых вкладок нет".to_string())?
        };
        self.spawn_tab(app, url, Some(index))
    }

    /// tabs.close: закрыть вкладку по id; активной становится соседняя
    /// (правая, иначе левая). Закрытие последней — пустой экран, таб-бар жив.
    pub fn close(&self, app: &AppHandle, id: &str) -> Result<TabsListResult, String> {
        {
            let mut st = self.state.lock().expect("tabs: лок не отравлен");
            let index = st
                .tabs
                .iter()
                .position(|t| t.id == id)
                .ok_or_else(|| format!("вкладка {id} не найдена"))?;
            let entry = st.tabs.remove(index);
            st.closed.push_back((entry.url, index));
            if st.closed.len() > CLOSED_STACK_CAP {
                st.closed.pop_front();
            }
            if let Some(a) = st.active {
                st.active = match (a, st.tabs.is_empty()) {
                    (_, true) => None,
                    (a, false) if a >= index => Some(a.min(st.tabs.len() - 1)),
                    _ => Some(a),
                };
            }
        }
        if let Some(wv) = app.get_webview(id) {
            wv.close().map_err(|e| format!("close webview: {e}"))?;
        }
        self.apply_visibility(app);
        let snapshot = self.snapshot();
        emit::<TabsUpdated>(app, &snapshot).ok();
        Ok(snapshot)
    }

    /// tabs.activate / клик по вкладке: показать webview активной, скрыть
    /// остальные, фокус — в контент.
    pub fn activate(&self, app: &AppHandle, id: &str) -> Result<TabsListResult, String> {
        {
            let mut st = self.state.lock().expect("tabs: лок не отравлен");
            let index = st
                .tabs
                .iter()
                .position(|t| t.id == id)
                .ok_or_else(|| format!("вкладка {id} не найдена"))?;
            st.active = Some(index);
        }
        self.apply_visibility(app);
        if let Some(wv) = self.active_webview(app) {
            wv.set_focus().ok();
        }
        let snapshot = self.snapshot();
        emit::<TabsUpdated>(app, &snapshot).ok();
        Ok(snapshot)
    }

    /// Переключение по кольцу (Ctrl+Tab / Ctrl+Shift+Tab).
    pub fn cycle(&self, app: &AppHandle, step: i32) -> Result<TabsListResult, String> {
        let id = {
            let st = self.state.lock().expect("tabs: лок не отравлен");
            match st.tabs.len() {
                0 => return Err("вкладок нет".to_string()),
                n => st.tabs[(st.active.unwrap_or(0) as i32 + step).rem_euclid(n as i32) as usize]
                    .id
                    .clone(),
            }
        };
        self.activate(app, &id)
    }

    /// Горячие клавиши таб-бара: из content-webview (content/chrome-hotkeys.js
    /// → WebMessageReceived, main.rs) и из UI (src/chrome/tabbar.ts).
    pub fn handle_hotkey(&self, app: &AppHandle, key: &str) {
        match key {
            "ctrl+tab" => {
                self.cycle(app, 1).ok();
            }
            "ctrl+shift+tab" => {
                self.cycle(app, -1).ok();
            }
            // Создание webview — только вне главного потока (см. open).
            "ctrl+shift+t" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let manager = app.state::<TabManager>();
                    if let Err(e) = manager.reopen(&app) {
                        eprintln!("tabs: reopen: {e}");
                    }
                });
            }
            _ => {}
        }
    }

    /// Подгонка всех webview вкладок под размер окна (событие Resized):
    /// скрытые тоже — чтобы переключение не показало старую геометрию.
    pub fn relayout(&self, app: &AppHandle) {
        let Some(window) = app.get_window("main") else {
            return;
        };
        let (pos, size) = content_rect(&window);
        let ids: Vec<String> = {
            let st = self.state.lock().expect("tabs: лок не отравлен");
            st.tabs.iter().map(|t| t.id.clone()).collect()
        };
        for id in ids {
            if let Some(wv) = app.get_webview(&id) {
                wv.set_position(pos).ok();
                wv.set_size(size).ok();
            }
        }
    }

    /// Создание webview вкладки; position — индекс вставки в бар (None — конец).
    fn spawn_tab(
        &self,
        app: &AppHandle,
        url: String,
        position: Option<usize>,
    ) -> Result<TabsListResult, String> {
        let window = app
            .get_window("main")
            .ok_or_else(|| "окно main не найдено".to_string())?;
        let parsed =
            Url::parse(&url).map_err(|e| format!("некорректный URL вкладки «{url}»: {e}"))?;

        let id = {
            let mut st = self.state.lock().expect("tabs: лок не отравлен");
            st.next_seq += 1;
            let id = format!("tab-{}", st.next_seq);
            let index = position.unwrap_or(st.tabs.len()).min(st.tabs.len());
            st.tabs.insert(
                index,
                TabEntry {
                    id: id.clone(),
                    url: parsed.to_string(),
                    title: None,
                    loading: false,
                },
            );
            st.active = Some(index);
            id
        };

        let webview = {
            let (pos, size) = content_rect(&window);
            window
                .add_child(build_tab_webview(app, &id, &parsed), pos, size)
                .map_err(|e| format!("создание webview вкладки: {e}"))?
        };

        // COM-обработчики WebView2: сетевой перехват M0, аутентификация прокси,
        // приём сообщений content (горячие клавиши) — см. main.rs.
        let app_for_handlers = app.clone();
        webview
            .with_webview(move |wv| unsafe {
                crate::install_content_handlers(wv, &app_for_handlers)
            })
            .map_err(|e| format!("установка обработчиков вкладки: {e}"))?;

        self.apply_visibility(app);
        let snapshot = self.snapshot();
        emit::<TabsUpdated>(app, &snapshot).ok();
        Ok(snapshot)
    }

    /// Показать webview активной вкладки, скрыть остальные.
    fn apply_visibility(&self, app: &AppHandle) {
        let (active_id, ids) = {
            let st = self.state.lock().expect("tabs: лок не отравлен");
            (
                st.active.map(|i| st.tabs[i].id.clone()),
                st.tabs.iter().map(|t| t.id.clone()).collect::<Vec<_>>(),
            )
        };
        for id in ids {
            let Some(wv) = app.get_webview(&id) else {
                continue;
            };
            if Some(&id) == active_id.as_ref() {
                wv.show().ok();
            } else {
                wv.hide().ok();
            }
        }
    }

    /// on_page_load: URL актуализируется на каждом переходе (в т.ч. клики по
    /// ссылкам), loading — индикатор пульса на вкладке (гайд 06 §3).
    pub(crate) fn on_page_load(&self, app: &AppHandle, id: &str, event: PageLoadEvent, url: &Url) {
        let mut st = self.state.lock().expect("tabs: лок не отравлен");
        let Some(entry) = st.tabs.iter_mut().find(|t| t.id == id) else {
            return;
        };
        entry.url = url.to_string();
        entry.loading = matches!(event, PageLoadEvent::Started);
        drop(st);
        let snapshot = self.snapshot();
        emit::<TabsUpdated>(app, &snapshot).ok();
    }

    /// on_document_title_changed: заголовок вкладки для таб-бара.
    pub(crate) fn on_title(&self, app: &AppHandle, id: &str, title: String) {
        let mut st = self.state.lock().expect("tabs: лок не отравлен");
        let Some(entry) = st.tabs.iter_mut().find(|t| t.id == id) else {
            return;
        };
        if entry.title.as_deref() == Some(title.as_str()) {
            return;
        }
        entry.title = Some(title);
        drop(st);
        let snapshot = self.snapshot();
        emit::<TabsUpdated>(app, &snapshot).ok();
    }
}

/// Сборка webview вкладки: стартовый URL, content-скрипты (монитор M0 +
/// горячие клавиши таб-бара), аргументы окружения старта, трекинг URL/заголовка.
fn build_tab_webview(app: &AppHandle, id: &str, url: &Url) -> WebviewBuilder<tauri::Wry> {
    let app_for_load = app.clone();
    let app_for_title = app.clone();
    WebviewBuilder::new(id, WebviewUrl::External(url.clone()))
        // Критерий M0: скрипт выполняется в каждом новом документе
        // (WebView2: AddScriptToExecuteOnDocumentCreatedAsync).
        .initialization_script(crate::CONTENT_INIT_SCRIPT_M0)
        // Горячие клавиши таб-бара в контенте (задача 1.2) — до скриптов
        // страницы, чтобы перехват нельзя было снять.
        .initialization_script(crate::CONTENT_INIT_SCRIPT_HOTKEYS)
        // Аргументы те же, что у UI-webview: окружение WebView2 создаётся
        // первым webview, но дублируем для устойчивости к порядку создания.
        .additional_browser_args(crate::startup_proxy_args())
        .on_page_load(move |wv, payload| {
            // label webview == id вкладки, но берём фактический label —
            // единая правда о источнике события.
            let label = wv.label().to_string();
            app_for_load.state::<TabManager>().on_page_load(
                &app_for_load,
                &label,
                payload.event(),
                payload.url(),
            );
        })
        .on_document_title_changed(move |wv, title| {
            let label = wv.label().to_string();
            app_for_title
                .state::<TabManager>()
                .on_title(&app_for_title, &label, title);
        })
}
