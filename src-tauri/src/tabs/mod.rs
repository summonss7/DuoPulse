//! Менеджер вкладок Core (задача 1.2, docs/02 §3, docs/05 §1–2): жизненный
//! цикл WebView2-инстансов «одна вкладка = один дочерний webview» под полосой
//! хрома, порядок/активная вкладка/стек закрытых для восстановления.
//! Спящий режим (M2) добавится сюда же.
//!
//! Восстановление сессии (задача 1.6, docs/04 §1.3 «отложенная активация»):
//! список вкладок сохраняется в профиль при каждом изменении и при выходе
//! (session.json, `session`-модуль); на старте таб-бар восстанавливается весь,
//! но webview создаётся только для активной — остальные стоят в баре лениво
//! (`TabEntry::lazy`) и материализуются при первом обращении (activate/
//! navigate). DUOPULSE_START_URL (e2e-стенды) отключает сессию — старт
//! детерминирован.
//!
//! Взаимодействие UI — только через команды/события контракта bridge
//! (`tabs.{open, close, reopen, activate, list}`, событие `tabs:updated`);
//! хендлеры-обёртки — src/bridge.rs. URL/заголовок вкладки отслеживаются
//! событиями webview (on_page_load / on_document_title_changed) и хранятся
//! в менеджере — tabs.list читает их из состояния, не опрашивая webview.
//!
//! Внутренние страницы (задача 1.4): вкладка с url `duopulse://<имя>` грузит
//! UI-бандл (WebviewUrl::App) в webview с меткой `page-<имя>-N` — как
//! chrome://history в браузерах. Канонический адрес вкладки остаётся
//! `duopulse://<имя>`, пока webview живёт в app-origin (уход по внешнему
//! адресу — превращает вкладку в обычную). IPC доступен внутренним страницам
//! через capability `page-*` (src-tauri/capabilities/pages.json), контентные
//! вкладки (tab-*) его не имеют.
//!
//! Визиты истории (задача 1.4): on_page_load(Finished) внешних http/https
//! страниц пишет HistoryStore.visit; заголовок страницы (on_title)
//! подтягивает note_title.

mod session;

use std::collections::VecDeque;
use std::sync::Mutex;

use tauri::{
    webview::{PageLoadEvent, WebviewBuilder},
    AppHandle, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl, Window,
};

use crate::bridge::{emit, TabInfo, TabsListResult, TabsUpdated};
use crate::tabs::session::{Session, SessionTab};

/// Высота полосы хрома в логических пикселях: таб-бар + навбар.
/// Синхронизирована с #app (grid-template-rows) в src/style.css.
pub(crate) const CHROME_HEIGHT: f64 = 84.0;

/// Глубина стека закрытых вкладок для tabs.reopen (Ctrl+Shift+T).
const CLOSED_STACK_CAP: usize = 25;

/// Стартовая страница: первый таб и новые вкладки (кнопка «+», tabs.open без
/// url) — фирменная «Новая вкладка» (задача 1.5, гайд 06 §7). DUOPULSE_START_URL
/// переопределяет для e2e-стендов.
fn default_tab_url() -> String {
    std::env::var("DUOPULSE_START_URL").unwrap_or_else(|_| "duopulse://newtab".into())
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
    /// Внутренняя страница duopulse:// (см. модульный комментарий).
    internal: bool,
    /// Ленивая вкладка восстановленной сессии (задача 1.6): стоит в баре с
    /// сохранённым URL/заголовком, webview ещё не создан — появится при
    /// первом обращении (materialize).
    lazy: bool,
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

    /// Текущий URL вкладки по id — для сетевого перехватчика (задача 2.1:
    /// запасной источник запроса движка adblock). Вызывается из COM-колбэка
    /// WebView2 — лок берётся с падением в None, паника туда невозможна.
    pub fn url_of(&self, id: &str) -> Option<String> {
        let st = self.state.lock().ok()?;
        st.tabs.iter().find(|t| t.id == id).map(|t| t.url.clone())
    }

    /// Первая вкладка приложения (вызывается из setup окна): восстановление
    /// сессии из профиля (задача 1.6) либо стартовая страница. DUOPULSE_START_URL
    /// (e2e-стенды) сессию игнорирует — старт детерминирован.
    ///
    /// Восстановление вставляет только записи вкладок (бар отрисовывается
    /// сразу), webview активной создаёт задача по сигналу цикла событий
    /// (main.rs, RunEvent::Ready): создание webview на главном потоке до
    /// старта цикла и в первые его мгновения — гонка с дедлоком
    /// (add_child → wait_with_pump цикла, который ещё не качает сообщения).
    pub fn init(&self, app: &AppHandle) -> Result<(), String> {
        let restore = if std::env::var("DUOPULSE_START_URL").is_err() {
            session::load(&crate::proxy::profile_dir())
        } else {
            None
        };
        match restore {
            Some(session) => self.restore_entries(session),
            // свежий старт — путь задач 1.2–1.5 (внутри setup, им прошёл весь
            // e2e-парк); сессии нет — гонка восстановления его не касается
            None => {
                self.spawn_tab(app, default_tab_url(), None)?;
            }
        }
        Ok(())
    }

    /// Материализовать активную вкладку восстановленной сессии фоновой
    /// задачей (RunEvent::Ready в main.rs + короткая пауза на прогрев цикла
    /// событий). Сессии нет/активная не ленивая — no-op.
    pub fn spawn_restore_materialize(&self, app: &AppHandle) {
        if !self.has_lazy_active() {
            return;
        }
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(250));
            let manager = app.state::<TabManager>();
            if let Err(e) = manager.materialize_active(&app) {
                eprintln!("session: материализация активной вкладки: {e}");
            }
        });
    }

    /// Есть ли ленивая активная вкладка (старт с восстановлением сессии).
    fn has_lazy_active(&self) -> bool {
        let st = self.state.lock().expect("tabs: лок не отравлен");
        st.active.is_some_and(|i| st.tabs[i].lazy)
    }

    /// Восстановление сессии: все вкладки встают в бар лениво (записи без
    /// webview с сохранёнными URL/заголовками); активную материализует задача,
    /// порождённая init (материализация — только из async-контекста, см. open).
    fn restore_entries(&self, session: Session) {
        let mut st = self.state.lock().expect("tabs: лок не отравлен");
        for tab in &session.tabs {
            st.next_seq += 1;
            let seq = st.next_seq;
            let internal = internal_page_name(
                &Url::parse(&tab.url).expect("session::load гарантирует разбираемый URL вкладки"),
            );
            let id =
                internal.map_or_else(|| format!("tab-{seq}"), |name| format!("page-{name}-{seq}"));
            st.tabs.push(TabEntry {
                id,
                url: tab.url.clone(),
                title: tab.title.clone(),
                loading: false,
                internal: internal.is_some(),
                lazy: true,
            });
        }
        // session::load зажимает active в границы; None там не бывает
        st.active = Some(session.active.unwrap_or(0));
    }

    /// Материализация ленивой вкладки: webview создаётся по её сохранённому
    /// URL (id назначен при восстановлении). Не-lazy вкладка — no-op.
    /// Вызывать только вне потока цикла событий (см. open): из async-команд
    /// или setup.
    pub fn materialize(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let url = {
            let st = self.state.lock().expect("tabs: лок не отравлен");
            let entry = st
                .tabs
                .iter()
                .find(|t| t.id == id)
                .ok_or_else(|| format!("вкладка {id} не найдена"))?;
            if !entry.lazy {
                return Ok(());
            }
            entry.url.clone()
        };
        let parsed =
            Url::parse(&url).map_err(|e| format!("некорректный URL вкладки «{url}»: {e}"))?;
        let internal = internal_page_name(&parsed).is_some();
        self.spawn_webview(app, id, &parsed, internal)?;
        {
            let mut st = self.state.lock().expect("tabs: лок не отравлен");
            if let Some(entry) = st.tabs.iter_mut().find(|t| t.id == id) {
                entry.lazy = false;
            }
            // Лок обязан быть снят до apply_visibility/finish: обе берут тот же
            // Mutex, а std::sync::Mutex нереентерабелен — удержание лока здесь
            // намертво вешало поток (и с ним главный поток в on_page_load).
        }
        self.apply_visibility(app);
        Ok(())
    }

    /// Материализовать активную вкладку, если она ленивая (nav.navigate и
    /// активации по кольцу из async-контекста).
    pub fn materialize_active(&self, app: &AppHandle) -> Result<(), String> {
        let id = {
            let st = self.state.lock().expect("tabs: лок не отравлен");
            st.active.map(|i| st.tabs[i].id.clone())
        };
        match id {
            Some(id) => self.materialize(app, &id),
            None => Ok(()),
        }
    }

    /// nav.navigate активной вкладки: у ленивой вкладки webview ещё нет —
    /// новый URL подставляется в запись, и webview создаётся под него фоновой
    /// задачей (без двойной загрузки и без ожидания командой — см. activate).
    pub fn navigate_active(&self, app: &AppHandle, url: &Url) -> Result<(), String> {
        {
            let mut st = self.state.lock().expect("tabs: лок не отравлен");
            let active = st.active.ok_or("активной вкладки нет")?;
            let entry = &mut st.tabs[active];
            if entry.lazy {
                entry.url = url.to_string();
                entry.internal = internal_page_name(url).is_some();
                drop(st);
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let manager = app.state::<TabManager>();
                    if let Err(e) = manager.materialize_active(&app) {
                        eprintln!("tabs: материализация для navigate: {e}");
                    }
                });
                return Ok(());
            }
        }
        let webview = self.active_webview(app).ok_or("активной вкладки нет")?;
        webview
            .navigate(url.clone())
            .map_err(|e| format!("navigate: {e}"))
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
        Ok(self.finish(app))
    }

    /// tabs.activate / клик по вкладке: показать webview активной, скрыть
    /// остальные, фокус — в контент. Ленивая вкладка сессии (задача 1.6)
    /// становится активной сразу (бар переключается), её webview создаёт
    /// вызывающая async-команда (materialize) — webview-создание нельзя
    /// делать на потоке цикла событий.
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
        Ok(self.finish(app))
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
            // Переключение по кольцу: активация может материализовать ленивую
            // вкладку сессии (задача 1.6) — создание webview допустимо только
            // вне потока цикла событий (см. open), как у ctrl+shift+t.
            "ctrl+tab" | "ctrl+shift+tab" => {
                let step = if key == "ctrl+tab" { 1 } else { -1 };
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let manager = app.state::<TabManager>();
                    if let Err(e) = manager
                        .cycle(&app, step)
                        .and_then(|_| manager.materialize_active(&app))
                    {
                        eprintln!("tabs: cycle: {e}");
                    }
                });
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

    /// Активная вкладка ещё без webview (ленивая, задача 1.6)? Навигационным
    /// командам «назад/вперёд/обновить» по ленивой вкладке нечего делать —
    /// документа и истории ещё не существует.
    pub fn active_is_lazy(&self) -> bool {
        let st = self.state.lock().expect("tabs: лок не отравлен");
        st.active.is_some_and(|i| st.tabs[i].lazy)
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
    /// `duopulse://<имя>` — внутренняя страница (webview с UI-бандлом).
    fn spawn_tab(
        &self,
        app: &AppHandle,
        url: String,
        position: Option<usize>,
    ) -> Result<TabsListResult, String> {
        let parsed =
            Url::parse(&url).map_err(|e| format!("некорректный URL вкладки «{url}»: {e}"))?;
        let internal = internal_page_name(&parsed);

        let id = {
            let mut st = self.state.lock().expect("tabs: лок не отравлен");
            st.next_seq += 1;
            let seq = st.next_seq;
            let id =
                internal.map_or_else(|| format!("tab-{seq}"), |name| format!("page-{name}-{seq}"));
            let index = position.unwrap_or(st.tabs.len()).min(st.tabs.len());
            st.tabs.insert(
                index,
                TabEntry {
                    id: id.clone(),
                    // канонический адрес: для внутренних страниц Url сериализует
                    // «duopulse://history» как «duopulse://history/»
                    url: parsed.to_string(),
                    title: None,
                    loading: false,
                    internal: internal.is_some(),
                    lazy: false,
                },
            );
            st.active = Some(index);
            id
        };

        self.spawn_webview(app, &id, &parsed, internal.is_some())?;
        self.apply_visibility(app);
        Ok(self.finish(app))
    }

    /// Создание webview по назначенному id вкладки (общая часть spawn_tab и
    /// materialize). Вызывать только вне потока цикла событий: add_child —
    /// блокирующий round-trip на главный поток (см. open).
    fn spawn_webview(
        &self,
        app: &AppHandle,
        id: &str,
        url: &Url,
        internal: bool,
    ) -> Result<(), String> {
        let window = app
            .get_window("main")
            .ok_or_else(|| "окно main не найдено".to_string())?;
        let builder = if internal {
            build_page_webview(id)
        } else {
            build_tab_webview(app, id, url)
        };
        let webview = {
            let (pos, size) = content_rect(&window);
            window
                .add_child(builder, pos, size)
                .map_err(|e| format!("создание webview вкладки: {e}"))?
        };

        // COM-обработчики WebView2: сетевой перехват M0 + блокировщик (2.1),
        // аутентификация прокси, приём сообщений content (горячие клавиши) —
        // см. main.rs (вкладка передаётся по id: её URL — источник запросов).
        let app_for_handlers = app.clone();
        let id_for_handlers = id.to_string();
        webview
            .with_webview(move |wv| unsafe {
                crate::install_content_handlers(wv, &app_for_handlers, &id_for_handlers)
            })
            .map_err(|e| format!("установка обработчиков вкладки: {e}"))?;
        Ok(())
    }

    /// Финал любой мутации списка вкладок: снапшот, сохранение сессии
    /// (задача 1.6), событие таб-бару.
    fn finish(&self, app: &AppHandle) -> TabsListResult {
        let snapshot = self.snapshot();
        self.persist_session();
        emit::<TabsUpdated>(app, &snapshot).ok();
        snapshot
    }

    /// Сохранить сессию в профиль (session.json). Сессия некритична: ошибка
    /// записи логируется, работа браузера продолжается. DUOPULSE_START_URL
    /// (e2e-стенды) — не сохранять, чтобы стенды не мутировали профили.
    pub(crate) fn persist_session(&self) {
        if std::env::var("DUOPULSE_START_URL").is_ok() {
            return;
        }
        let (tabs, active) = {
            let st = self.state.lock().expect("tabs: лок не отравлен");
            (
                st.tabs
                    .iter()
                    .map(|t| SessionTab {
                        url: t.url.clone(),
                        title: t.title.clone(),
                    })
                    .collect::<Vec<_>>(),
                st.active,
            )
        };
        let session = Session {
            tabs,
            active,
            saved_at: now_ms(),
        };
        if let Err(e) = session::save(&crate::proxy::profile_dir(), &session) {
            eprintln!("session: не сохранена: {e}");
        }
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
    /// ссылкам), loading — индикатор пульса на вкладке (гайд 06 §3). Для
    /// внешних http/https документов Finished записывает визит истории
    /// (задача 1.4). Внутренняя страница держит канонический duopulse://…,
    /// пока webview в app-origin: уход по внешнему адресу превращает вкладку
    /// в обычную.
    pub(crate) fn on_page_load(&self, app: &AppHandle, id: &str, event: PageLoadEvent, url: &Url) {
        let mut st = self.state.lock().expect("tabs: лок не отравлен");
        let Some(entry) = st.tabs.iter_mut().find(|t| t.id == id) else {
            return;
        };
        let record_visit = matches!(event, PageLoadEvent::Finished)
            && matches!(url.scheme(), "http" | "https")
            && !(entry.internal && is_app_origin(app, url));
        if entry.internal && is_app_origin(app, url) {
            entry.loading = matches!(event, PageLoadEvent::Started);
            drop(st);
            self.finish(app);
            return;
        }
        if entry.internal {
            entry.internal = false; // webview ушёл с внутренней страницы
        }
        entry.url = url.to_string();
        entry.loading = matches!(event, PageLoadEvent::Started);
        let (visit_url, visit_title) = if record_visit {
            (url.to_string(), entry.title.clone().unwrap_or_default())
        } else {
            (String::new(), String::new())
        };
        drop(st);
        if record_visit {
            if let Err(e) = app
                .state::<crate::history::HistoryStore>()
                .visit(&visit_url, &visit_title)
            {
                eprintln!("history: визит не записан ({visit_url}): {e}");
            }
        }
        self.finish(app);
    }

    /// on_document_title_changed: заголовок вкладки для таб-бара и последнего
    /// визита истории (приходит после Finished — history.note_title).
    pub(crate) fn on_title(&self, app: &AppHandle, id: &str, title: String) {
        let mut st = self.state.lock().expect("tabs: лок не отравлен");
        let Some(entry) = st.tabs.iter_mut().find(|t| t.id == id) else {
            return;
        };
        if entry.title.as_deref() == Some(title.as_str()) {
            return;
        }
        entry.title = Some(title.clone());
        let note = if entry.internal {
            None
        } else {
            Some(entry.url.clone())
        };
        drop(st);
        if let Some(url) = note {
            if let Err(e) = app
                .state::<crate::history::HistoryStore>()
                .note_title(&url, &title)
            {
                eprintln!("history: заголовок не обновлён ({url}): {e}");
            }
        }
        self.finish(app);
    }
}

/// Текущее время, unix-ms (метка сохранения сессии, задача 1.6).
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Внутренние страницы duopulse:// (задача 1.4): адрес → имя страницы.
/// Новые страницы (настройки, диагностика) добавляются сюда + в роутер
/// src/main.ts.
fn internal_page_name(url: &Url) -> Option<&'static str> {
    match url.host_str()? {
        "history" => Some("history"),
        "newtab" => Some("newtab"), // «Новая вкладка», задача 1.5 (гайд 06 §7)
        _ => None,
    }
}

/// True, если URL принадлежит app-origin (тот же origin, что у UI-webview
/// «main») — так внутренняя страница отличает свои загрузки от ухода
/// по внешнему адресу (dev: vite-сервер, прод: tauri-протокол).
fn is_app_origin(app: &AppHandle, url: &Url) -> bool {
    app.get_webview("main")
        .and_then(|wv| wv.url().ok())
        .map(|main| main.origin() == url.origin())
        .unwrap_or(false)
}

/// Сборка webview контентной вкладки: стартовый URL, content-скрипты (монитор
/// M0 + горячие клавиши таб-бара), аргументы окружения старта, трекинг
/// URL/заголовка.
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
        // Косметика блокировщика (задача 2.2): селекторы скрытия до отрисовки
        // страницы — ресурс запрашивается у Core сразу после создания
        // документа (content/cosmetic.js → main.rs → PostWebMessage).
        .initialization_script(crate::CONTENT_INIT_SCRIPT_COSMETIC)
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

/// Сборка webview внутренней страницы duopulse:// (задача 1.4): UI-бандл
/// (WebviewUrl::App), горячие клавиши таб-бара работают и на странице,
/// трекинг URL/заголовка тот же (модульный комментарий TabManager).
/// Метка webview задаётся при создании (page-<имя>-N) — SPA определяет по
/// ней страницу (src/main.ts).
fn build_page_webview(id: &str) -> WebviewBuilder<tauri::Wry> {
    let id_for_load = id.to_string();
    let id_for_title = id.to_string();
    WebviewBuilder::new(id, WebviewUrl::App("index.html".into()))
        .initialization_script(crate::CONTENT_INIT_SCRIPT_HOTKEYS)
        // Те же аргументы окружения, что у UI-webview и вкладок: WebView2 не
        // даёт смешивать environment с разными аргументами на одну папку
        // данных — контроллер не создаётся (0x8007139F).
        .additional_browser_args(crate::startup_proxy_args())
        .on_page_load(move |wv, payload| {
            let label = id_for_load.clone();
            let app = wv.app_handle().clone();
            app.state::<TabManager>()
                .on_page_load(&app, &label, payload.event(), payload.url());
        })
        .on_document_title_changed(move |wv, title| {
            let label = id_for_title.clone();
            let app = wv.app_handle().clone();
            app.state::<TabManager>().on_title(&app, &label, title);
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Реестр внутренних страниц (задача 1.5: добавлена «Новая вкладка»):
    /// duopulse:// распознаётся по хосту, внешние адреса — не внутренние.
    #[test]
    fn internal_pages_registry() {
        assert_eq!(
            internal_page_name(&Url::parse("duopulse://newtab").unwrap()),
            Some("newtab")
        );
        assert_eq!(
            internal_page_name(&Url::parse("duopulse://newtab/").unwrap()),
            Some("newtab")
        );
        assert_eq!(
            internal_page_name(&Url::parse("duopulse://history").unwrap()),
            Some("history")
        );
        assert_eq!(
            internal_page_name(&Url::parse("https://www.youtube.com/").unwrap()),
            None
        );
        assert_eq!(
            internal_page_name(&Url::parse("duopulse://settings").unwrap()),
            None
        );
    }
}
