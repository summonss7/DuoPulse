//! Менеджер вкладок Core (задача 1.2, docs/02 §3, docs/05 §1–2): жизненный
//! цикл WebView2-инстансов «одна вкладка = один дочерний webview» под полосой
//! хрома, порядок/активная вкладка/стек закрытых для восстановления.
//!
//! Спящий режим (задача 2.3, docs/04 §1.3) — модуль `sleep`: долгонеактивные
//! вкладки приостанавливаются (WebView2 TrySuspend, состояние сохраняется),
//! будятся при активации; вкладки с играющим звуком/видео не усыпляются
//! (состояние сообщает content/media-watch.js).
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
//!
//! Инкогнито-вкладки (карточка duopulse-096): помечаются при создании
//! (tabs.open {incognito} / «Открыть копию в инкогнито» / ссылки из
//! инкогнито-вкладок). Среда WebView2 — отдельная (data_directory во
//! временную папку): куки/кэш/хранилища сайтов не касаются профиля и
//! удаляются при закрытии последней инкогнито-вкладки. Визиты истории не
//! пишутся (и note_title), в session.json вкладка не попадает; закладки
//! разрешены (как в браузерах). Стартовая страница — duopulse://incognito
//! («Вы перешли в режим инкогнито»); уход по адресу превращает вкладку в
//! обычную контентную (среда остаётся изолированной — она назначена
//! webview при создании).

mod session;
mod sleep;

pub(crate) use sleep::start_sleeper;

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

/// Папка данных изолированной среды WebView2 инкогнито-вкладок (карточка
/// duopulse-096): отдельная user data folder во %TEMP% — куки/кэш/хранилища
/// сайтов инкогнито не касаются профиля. Имя фиксированное (не по pid):
/// папка, оставшаяся после креша/убийства процесса, чистится следующим
/// стартом; при закрытии последней инкогнито-вкладки — тоже best effort,
/// файлы, ещё занятые средой, добьёт следующий старт.
pub(crate) fn incognito_data_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("duopulse-incognito")
}

/// Удалить данные инкогнито-среды (ошибки занятых файлов молчаливы — см.
/// incognito_data_dir).
pub(crate) fn clean_incognito_data() {
    let _ = std::fs::remove_dir_all(incognito_data_dir());
}

/// Стартовая страница: первый таб и новые вкладки (кнопка «+», tabs.open без
/// url) — фирменная «Новая вкладка» (задача 1.5, гайд 06 §7). DUOPULSE_START_URL
/// переопределяет для e2e-стендов.
fn default_tab_url() -> String {
    std::env::var("DUOPULSE_START_URL").unwrap_or_else(|_| "duopulse://newtab".into())
}

/// Полный размер окна в логических пикселях (HTML-fullscreen, карточка 062).
fn window_logical_size(window: &Window<tauri::Wry>) -> LogicalSize<f64> {
    let scale = window.scale_factor().unwrap_or(1.0);
    window
        .inner_size()
        .unwrap_or_default()
        .to_logical::<f64>(scale)
}

/// Размер дочернего webview вкладки под полосой хрома.
fn content_rect(window: &Window<tauri::Wry>) -> (LogicalPosition<f64>, LogicalSize<f64>) {
    let full = window_logical_size(window);
    (
        LogicalPosition::new(0.0, CHROME_HEIGHT),
        LogicalSize::new(full.width, (full.height - CHROME_HEIGHT).max(0.0)),
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
    /// Стек закрытых для tabs.reopen: (url, позиция в баре на момент закрытия,
    /// инкогнито ли была — восстановление сохраняет приватность вкладки).
    closed: VecDeque<(String, usize, bool)>,
    /// Вкладка в HTML-fullscreen (карточка duopulse-062): видео развёрнуто
    /// на весь экран — webview этой вкладки растянут на всё окно (поверх
    /// полосы хрома), окно — borderless-fullscreen. None — обычный режим.
    fullscreen_tab: Option<String>,
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
    /// Спит (задача 2.3): webview приостановлен WebView2 TrySuspend —
    /// рендер-процессы заморожены, состояние страницы сохранено; будится
    /// при активации.
    sleeping: bool,
    /// Играет звук/видео (content/media-watch.js, задача 2.3): исключение
    /// спящего режима.
    media_playing: bool,
    /// unix-ms последней активности (активация/открытие/стоп медиа) — отсчёт
    /// таймаута спящего режима (задача 2.3).
    last_active_ms: i64,
    /// Инкогнито-вкладка (карточка duopulse-096): изолированная среда
    /// WebView2, без визитов истории и в session.json не попадает.
    incognito: bool,
}

impl TabEntry {
    fn info(&self, active: bool) -> TabInfo {
        TabInfo {
            id: self.id.clone(),
            url: self.url.clone(),
            title: self.title.clone(),
            active,
            loading: self.loading,
            sleeping: self.sleeping,
            incognito: self.incognito,
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

    /// id активной вкладки (бар «Сохранить пароль?» предлагается только ей,
    /// этап 2 duopulse-108 — как бабл Chrome).
    pub fn active_id(&self) -> Option<String> {
        let st = self.state.lock().expect("tabs: лок не отравлен");
        st.active.map(|i| st.tabs[i].id.clone())
    }

    /// Текущий URL вкладки по id — для сетевого перехватчика (задача 2.1:
    /// запасной источник запроса движка adblock). Вызывается из COM-колбэка
    /// WebView2 — лок берётся с падением в None, паника туда невозможна.
    pub fn url_of(&self, id: &str) -> Option<String> {
        let st = self.state.lock().ok()?;
        st.tabs.iter().find(|t| t.id == id).map(|t| t.url.clone())
    }

    /// Инкогнито-вкладка ли (карточка duopulse-096) — наследование приватности
    /// ссылками «в новом окне» (NewWindowRequested из вкладки-источника).
    pub fn is_incognito(&self, id: &str) -> bool {
        self.state
            .lock()
            .expect("tabs: лок не отравлен")
            .tabs
            .iter()
            .find(|t| t.id == id)
            .is_some_and(|t| t.incognito)
    }

    /// Первая вкладка приложения (вызывается из setup окна): восстановление
    /// сессии из профиля (задача 1.6) либо стартовая страница. DUOPULSE_START_URL
    /// (e2e-стенды) сессию игнорирует — старт детерминирован.
    ///
    /// Оба пути ставят вкладки лениво (записи в баре без webview): материализация
    /// — задача по сигналу цикла событий (main.rs, RunEvent::Ready). Создание
    /// webview внутри setup — блокирующий round-trip на ещё не качающий цикл:
    /// задерживал старт цикла (и с ним первую отрисовку таб-бара) — задача 2.4
    /// перевела сюда и свежий старт (раньше первая вкладка создавалась в setup).
    pub fn init(&self, _app: &AppHandle) -> Result<(), String> {
        let restore = if std::env::var("DUOPULSE_START_URL").is_err() {
            session::load(&crate::proxy::profile_dir())
        } else {
            None
        };
        match restore {
            Some(session) => self.restore_entries(session),
            None => self.spawn_lazy_first()?,
        }
        Ok(())
    }

    /// Первая вкладка свежего старта (сессии нет): ленивая запись со стартовым
    /// URL, webview создаёт spawn_restore_materialize по RunEvent::Ready —
    /// как у восстановленных вкладок (задача 2.4, docs/04 §1.3).
    fn spawn_lazy_first(&self) -> Result<(), String> {
        let url = default_tab_url();
        let parsed =
            Url::parse(&url).map_err(|e| format!("некорректный стартовый URL «{url}»: {e}"))?;
        let name = internal_page_name(&parsed);
        let mut st = self.state.lock().expect("tabs: лок не отравлен");
        st.next_seq += 1;
        let seq = st.next_seq;
        let id = name.map_or_else(|| format!("tab-{seq}"), |n| format!("page-{n}-{seq}"));
        st.tabs.push(TabEntry {
            id,
            // канонический адрес: для внутренних страниц Url сериализует
            // «duopulse://history» как «duopulse://history/»
            url: parsed.to_string(),
            title: None,
            loading: false,
            internal: name.is_some(),
            lazy: true,
            sleeping: false,
            media_playing: false,
            last_active_ms: now_ms(),
            incognito: false,
        });
        st.active = Some(0);
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
                sleeping: false,
                media_playing: false,
                last_active_ms: now_ms(),
                incognito: false, // сессия инкогнито-вкладок не сохраняется
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
        // материализуются только ленивые вкладки восстановленной сессии —
        // инкогнито туда не попадает (не сохраняется, карточка 096)
        self.spawn_webview(app, id, &parsed, internal, false)?;
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
    /// incognito (карточка duopulse-096) — приватная вкладка: изолированная
    /// среда, без истории и сессии; без url стартует со страницы
    /// duopulse://incognito. Вызывается из async-команды: создание webview —
    /// блокирующий round-trip на главный поток, его нельзя делать на потоке
    /// цикла событий.
    pub fn open(
        &self,
        app: &AppHandle,
        url: Option<String>,
        position: Option<usize>,
        incognito: bool,
    ) -> Result<TabsListResult, String> {
        let url = url.unwrap_or_else(|| {
            if incognito {
                "duopulse://incognito".to_string()
            } else {
                default_tab_url()
            }
        });
        self.spawn_tab(app, url, position, true, incognito)
    }

    /// «Открыть ссылку в новом окне» без перехода (карточка duopulse-088):
    /// NewWindowRequested (target=_blank, средняя кнопка, пункт контекстного
    /// меню) открывает вкладку в фоне — активной остаётся текущая, фокус не
    /// крадётся; пользователь переключается сам, когда захочет. Ссылка из
    /// инкогнито-вкладки наследует приватность (как в браузерах).
    pub fn open_background(
        &self,
        app: &AppHandle,
        url: String,
        incognito: bool,
    ) -> Result<TabsListResult, String> {
        self.spawn_tab(app, url, None, false, incognito)
    }

    /// tabs.reopen (Ctrl+Shift+T): последняя закрытая возвращается на прежнюю
    /// позицию бара. WebView2 не восстанавливает уничтоженный инстанс — вкладка
    /// создаётся заново по URL (id новый); инкогнито-вкладка восстанавливается
    /// инкогнито (карточка duopulse-096).
    pub fn reopen(&self, app: &AppHandle) -> Result<TabsListResult, String> {
        let (url, index, incognito) = {
            let mut st = self.state.lock().expect("tabs: лок не отравлен");
            st.closed
                .pop_back()
                .ok_or_else(|| "закрытых вкладок нет".to_string())?
        };
        self.spawn_tab(app, url, Some(index), true, incognito)
    }

    /// tabs.close: закрыть вкладку по id; активной становится соседняя
    /// (правая, иначе левая). Закрытие последней — пустой экран, таб-бар жив.
    /// Закрытие последней инкогнито-вкладки чистит данные изолированной
    /// среды (карточка duopulse-096; best effort — см. incognito_data_dir).
    pub fn close(&self, app: &AppHandle, id: &str) -> Result<TabsListResult, String> {
        let was_last_incognito = {
            let mut st = self.state.lock().expect("tabs: лок не отравлен");
            let index = st
                .tabs
                .iter()
                .position(|t| t.id == id)
                .ok_or_else(|| format!("вкладка {id} не найдена"))?;
            let entry = st.tabs.remove(index);
            st.closed.push_back((entry.url, index, entry.incognito));
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
            entry.incognito && !st.tabs.iter().any(|t| t.incognito)
        };
        // Закрыта вкладка-владелец HTML-fullscreen (карточка 062) — выходим
        // из fullscreen: вебview уничтожается и события выхода можно не ждать.
        self.exit_fullscreen(app, None);
        if let Some(wv) = app.get_webview(id) {
            wv.close().map_err(|e| format!("close webview: {e}"))?;
        }
        if was_last_incognito {
            // после close webview файлы среды освобождаются не мгновенно;
            // пауза в фоне + проверка, что новые инкогнито-вкладки не успели
            // открыться (не снести свежую среду)
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(800));
                let st = app.state::<TabManager>();
                if !st
                    .state
                    .lock()
                    .map(|s| s.tabs.iter().any(|t| t.incognito))
                    .unwrap_or(true)
                {
                    clean_incognito_data();
                }
            });
        }
        self.apply_visibility(app);
        Ok(self.finish(app))
    }

    /// tabs.activate / клик по вкладке: показать webview активной, скрыть
    /// остальные, фокус — в контент. Спящая вкладка (задача 2.3) просыпается:
    /// явный Resume + сброс отсчёта простоя. Ленивая вкладка сессии (задача
    /// 1.6) становится активной сразу (бар переключается), её webview создаёт
    /// вызывающая async-команда (materialize) — webview-создание нельзя
    /// делать на потоке цикла событий.
    pub fn activate(&self, app: &AppHandle, id: &str) -> Result<TabsListResult, String> {
        // Метрика переключения вкладок (задача 2.5, perf:tab_switch_ms):
        // смена видимости webview + фокус; ленивая материализация — фон,
        // в счёт не входит (переключение видно пользователю уже здесь).
        let t0 = std::time::Instant::now();
        let (wake, switched) = {
            let mut st = self.state.lock().expect("tabs: лок не отравлен");
            let index = st
                .tabs
                .iter()
                .position(|t| t.id == id)
                .ok_or_else(|| format!("вкладка {id} не найдена"))?;
            let switched = st.active != Some(index);
            st.active = Some(index);
            let entry = &mut st.tabs[index];
            entry.last_active_ms = now_ms();
            (std::mem::replace(&mut entry.sleeping, false), switched)
        };
        if wake {
            self.resume_webview(app, id);
        }
        // Переключение с вкладки в HTML-fullscreen (карточка 062) — выходим
        // из fullscreen (как браузеры); повторная активация владельца — остаётся.
        self.exit_fullscreen(app, Some(id));
        self.apply_visibility(app);
        if let Some(wv) = self.active_webview(app) {
            wv.set_focus().ok();
        }
        if switched {
            crate::perf::note_tab_switch(app, t0.elapsed().as_millis() as u64);
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
            // Закладка активной вкладки вкл/выкл (карточка duopulse-057):
            // дублирует звёздочку навбара для фокуса в контенте; итоговое
            // состояние UI видит по событию tabs.updated (finish).
            "ctrl+d" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let manager = app.state::<TabManager>();
                    if let Err(e) = manager.toggle_bookmark_active(&app) {
                        eprintln!("tabs: закладка (ctrl+d): {e}");
                    }
                });
            }
            // Новая вкладка (карточка duopulse-075): как и прочие действия с
            // созданием webview — вне потока цикла событий.
            "ctrl+t" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let manager = app.state::<TabManager>();
                    if let Err(e) = manager.open(&app, None, None, false) {
                        eprintln!("tabs: new tab (ctrl+t): {e}");
                    }
                });
            }
            // Инкогнито-вкладка (карточка duopulse-096): как ctrl+t — вне
            // потока цикла событий (создание webview).
            "ctrl+shift+n" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let manager = app.state::<TabManager>();
                    if let Err(e) = manager.open(&app, None, None, true) {
                        eprintln!("tabs: new incognito tab (ctrl+shift+n): {e}");
                    }
                });
            }
            _ => {}
        }
    }

    /// Ctrl+D: закладка активной вкладки — добавить/убрать (внешние http/https
    /// адреса; внутренние страницы и прочие схемы не закладываются). Ответ —
    /// стала ли страница закладкой; событие tabs.updated обновит звёздочку.
    /// Правка — пометка на синк аккаунта Aila (этап 5 duopulse-111).
    fn toggle_bookmark_active(&self, app: &AppHandle) -> Result<bool, String> {
        let (url, title) = {
            let st = self.state.lock().expect("tabs: лок не отравлен");
            let entry = st
                .active
                .and_then(|i| st.tabs.get(i))
                .ok_or("активной вкладки нет")?;
            let parsed = Url::parse(&entry.url).map_err(|e| format!("url вкладки: {e}"))?;
            if entry.internal || !matches!(parsed.scheme(), "http" | "https") {
                return Ok(false);
            }
            (parsed.to_string(), entry.title.clone().unwrap_or_default())
        };
        let added = app
            .state::<std::sync::Arc<crate::history::HistoryStore>>()
            .toggle_bookmark(&url, &title)?;
        // и добавление, и удаление — правка хранилища: надгробие/новая
        // закладка должны уехать в облако (этап 5 duopulse-111)
        app.state::<std::sync::Arc<crate::aila::AilaAccount>>()
            .schedule_sync();
        self.finish(app);
        Ok(added)
    }

    /// Активная вкладка ещё без webview (ленивая, задача 1.6)? Навигационным
    /// командам «назад/вперёд/обновить» по ленивой вкладке нечего делать —
    /// документа и истории ещё не существует.
    pub fn active_is_lazy(&self) -> bool {
        let st = self.state.lock().expect("tabs: лок не отравлен");
        st.active.is_some_and(|i| st.tabs[i].lazy)
    }

    /// Грузится ли хоть одна вкладка (задача 2.4): признак «UI не простой»
    /// для прогрева топ-сайтов — пока страница грузится, сетевой стек занят
    /// её запросами и раунд прогрева пропускается.
    pub fn any_loading(&self) -> bool {
        let st = self.state.lock().expect("tabs: лок не отравлен");
        st.tabs.iter().any(|t| t.loading)
    }

    /// Подгонка всех webview вкладок под размер окна (событие Resized):
    /// скрытые тоже — чтобы переключение не показало старую геометрию.
    /// Вкладка в HTML-fullscreen (карточка 062) растягивается на всё окно
    /// (0,0 — поверх полосы хрома), остальные — под хромом как обычно.
    pub fn relayout(&self, app: &AppHandle) {
        let Some(window) = app.get_window("main") else {
            return;
        };
        let (pos, size) = content_rect(&window);
        let full = window_logical_size(&window);
        let (fullscreen_tab, ids): (Option<String>, Vec<String>) = {
            let st = self.state.lock().expect("tabs: лок не отравлен");
            (
                st.fullscreen_tab.clone(),
                st.tabs.iter().map(|t| t.id.clone()).collect(),
            )
        };
        for id in ids {
            let Some(wv) = app.get_webview(&id) else {
                continue;
            };
            if Some(&id) == fullscreen_tab.as_ref() {
                wv.set_position(LogicalPosition::new(0.0, 0.0)).ok();
                wv.set_size(full).ok();
            } else {
                wv.set_position(pos).ok();
                wv.set_size(size).ok();
            }
        }
    }

    /// HTML-fullscreen во вкладке (карточка duopulse-062): документ вызвал
    /// requestFullscreen/exitFullscreen — WebView2 сообщает
    /// ContainsFullScreenElementChanged. Вход: окно уходит в borderless-
    /// fullscreen (рамок нет), webview вкладки растягивается на всё окно —
    /// полоса хрома не остаётся полосой поверх видео. Выход: обратный
    /// переход. Учитывается только активная вкладка — фоновая не должна
    /// уводить окно (браузеры при переключении вкладок выходят из
    /// fullscreen). Вызывается из COM-колбэка на главном потоке: только
    /// состояние под локом, оконные вызовы — после снятия лока.
    pub(crate) fn on_fullscreen(&self, app: &AppHandle, id: &str, contains: bool) {
        let Some(window) = app.get_window("main") else {
            return;
        };
        let mut relayout_needed = false;
        {
            let mut st = self.state.lock().expect("tabs: лок не отравлен");
            if contains {
                let is_active = st.active.is_some_and(|i| st.tabs[i].id == id);
                if !is_active || st.fullscreen_tab.is_some() {
                    return; // фоновая вкладка или уже в fullscreen
                }
                st.fullscreen_tab = Some(id.to_string());
                relayout_needed = true;
            } else if st.fullscreen_tab.as_deref() == Some(id) {
                st.fullscreen_tab = None;
                relayout_needed = true;
            }
        }
        if relayout_needed {
            let _ = window.set_fullscreen(contains);
            self.relayout(app);
        }
    }

    /// Выйти из HTML-fullscreen при закрытии вкладки-владельца или
    /// переключении на другую (карточка 062): окну возвращаются рамки,
    /// вкладки — геометрия под полосой хрома. except — вкладка, за которой
    /// fullscreen сохраняется (повторная активация вкладки-владельца).
    /// True — вышли.
    fn exit_fullscreen(&self, app: &AppHandle, except: Option<&str>) -> bool {
        let exited = {
            let mut st = self.state.lock().expect("tabs: лок не отравлен");
            let keep = except.is_some_and(|keep| st.fullscreen_tab.as_deref() == Some(keep));
            if st.fullscreen_tab.is_some() && !keep {
                st.fullscreen_tab = None;
                true
            } else {
                false
            }
        };
        if exited {
            if let Some(window) = app.get_window("main") {
                let _ = window.set_fullscreen(false);
            }
            self.relayout(app);
        }
        exited
    }

    /// Создание webview вкладки; position — индекс вставки в бар (None — конец);
    /// activate — стать активной (tabs.open/Ctrl+T — как в браузерах) или
    /// открыться в фоне (карточка duopulse-088: «новое окно» не крадёт фокус).
    /// `duopulse://<имя>` — внутренняя страница (webview с UI-бандлом).
    /// incognito (карточка duopulse-096) — изолированная среда WebView2; такой
    /// вкладке разрешён только старт с duopulse://incognito (webview грузит
    /// UI-бандл с полным набором content-скриптов — уход с внутренней страницы
    /// делает вкладку обычной контентной, как у страницы ошибки, карточка 048).
    fn spawn_tab(
        &self,
        app: &AppHandle,
        url: String,
        position: Option<usize>,
        activate: bool,
        incognito: bool,
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
                    sleeping: false,
                    media_playing: false,
                    last_active_ms: now_ms(),
                    incognito,
                },
            );
            // Фоновое открытие (карточка duopulse-088): активной остаётся
            // текущая вкладка — перехода на новую нет; активных нет (пустой
            // бар) — держать фон неоткуда, новая становится активной.
            if activate || st.active.is_none() {
                st.active = Some(index);
            }
            id
        };

        self.spawn_webview(app, &id, &parsed, internal.is_some(), incognito)?;
        self.apply_visibility(app);
        if !activate {
            // Создание webview может перехватить фокус — возвращаем его
            // активной (прежней) вкладке: пользователь продолжает её читать.
            if let Some(wv) = self.active_webview(app) {
                wv.set_focus().ok();
            }
        }
        Ok(self.finish(app))
    }

    /// Создание webview по назначенному id вкладки (общая часть spawn_tab и
    /// materialize). Вызывать только вне потока цикла событий: add_child —
    /// блокирующий round-trip на главный поток (см. open). Инкогнито-вкладка
    /// (карточка duopulse-096) — отдельная среда WebView2 (data_directory во
    /// временную папку) и старт с UI-бандла: набор content-скриптов тот же,
    /// что у контентных вкладок — уход со страницы инкогнито на сайт работает
    /// полноценно (блокировщик, субтитры), среда остаётся изолированной.
    fn spawn_webview(
        &self,
        app: &AppHandle,
        id: &str,
        url: &Url,
        internal: bool,
        incognito: bool,
    ) -> Result<(), String> {
        let window = app
            .get_window("main")
            .ok_or_else(|| "окно main не найдено".to_string())?;
        let builder = if incognito {
            build_tab_webview(app, id, WebviewUrl::App("index.html".into()), true)
                // маркер для e2e/страницы инкогнито (роутер — по метке webview);
                // сам маркер — первым скриптом внутри build_tab_webview
                .data_directory(incognito_data_dir())
        } else if internal {
            build_page_webview(id)
        } else {
            build_tab_webview(app, id, WebviewUrl::External(url.clone()), false)
        };
        // Новый webview встанет выше панели по композитору (порядок создания,
        // спайк 086) — панель закрываем заранее (duopulse-090).
        crate::chrome_panel::close_if_open(app);
        let webview = {
            let (pos, size) = content_rect(&window);
            window
                .add_child(builder, pos, size)
                .map_err(|e| format!("создание webview вкладки: {e}"))?
        };
        // Инкогнито-вкладка с адресом сайта («открыть копию в инкогнито»,
        // ссылки из приватных вкладок): среда назначается только при создании,
        // поэтому webview стартует с UI-бандла — сразу уводим его на адрес;
        // внутренние страницы (duopulse://incognito) живут в самом бандле.
        if incognito && !internal {
            webview
                .navigate(url.clone())
                .map_err(|e| format!("navigate инкогнито-вкладки: {e}"))?;
        }

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
        // Кандидат бара «Сохранить пароль?» чужой активной вкладке не живёт
        // (этап 2 duopulse-108): сабмит был в другой вкладке/вкладка закрыта.
        app.state::<crate::passwords::PasswordPrompts>()
            .on_tabs_changed(
                snapshot
                    .tabs
                    .iter()
                    .find(|t| t.active)
                    .map(|t| t.id.as_str()),
            );
        snapshot
    }

    /// Сохранить сессию в профиль (session.json). Сессия некритична: ошибка
    /// записи логируется, работа браузера продолжается. DUOPULSE_START_URL
    /// (e2e-стенды) — не сохранять, чтобы стенды не мутировали профили.
    /// Инкогнито-вкладки в сессию не попадают (карточка duopulse-096):
    /// проекция — session_projection.
    pub(crate) fn persist_session(&self) {
        if std::env::var("DUOPULSE_START_URL").is_ok() {
            return;
        }
        let (tabs, active) = {
            let st = self.state.lock().expect("tabs: лок не отравлен");
            session_projection(&st.tabs, st.active)
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

    /// SPA-навигация документа (карточка duopulse-057): history.pushState/
    /// replaceState/popstate сообщаются content/url-watch.js — новой загрузки
    /// документа (on_page_load) не происходит, адрес вкладки актуализируется
    /// здесь: omnibox, история (визит с текущим заголовком — заголовок новый
    /// документ подтянет on_title → note_title) и сессия видят каждый
    /// переход. Флаги loading/internal не трогаем: документ тот же. Вызывается
    /// из COM-колбэка на главном потоке — фильтры под локом и finish,
    /// как у on_page_load.
    pub(crate) fn on_spa_url(&self, app: &AppHandle, id: &str, url: &str) {
        let Ok(parsed) = Url::parse(url) else {
            return;
        };
        if !matches!(parsed.scheme(), "http" | "https") {
            return;
        }
        let canonical = parsed.to_string();
        let (visit_url, visit_title) = {
            let mut st = self.state.lock().expect("tabs: лок не отравлен");
            let Some(entry) = st.tabs.iter_mut().find(|t| t.id == id) else {
                return;
            };
            if entry.internal || entry.url == canonical {
                return;
            }
            entry.url = canonical.clone();
            // инкогнито (карточка duopulse-096): адрес вкладки актуализируется
            // (omnibox), визит истории не пишется
            if entry.incognito {
                (String::new(), String::new())
            } else {
                (canonical, entry.title.clone().unwrap_or_default())
            }
        };
        if visit_url.is_empty() {
            self.finish(app);
            return;
        }
        if let Err(e) = app
            .state::<std::sync::Arc<crate::history::HistoryStore>>()
            .visit(&visit_url, &visit_title)
        {
            eprintln!("history: визит SPA не записан ({visit_url}): {e}");
        }
        self.finish(app);
    }

    /// on_page_load: URL актуализируется на каждом переходе (в т.ч. клики по
    /// ссылкам), loading — индикатор пульса на вкладке (гайд 06 §3). Для
    /// внешних http/https документов Finished записывает визит истории
    /// (задача 1.4). Внутренняя страница держит канонический duopulse://…,
    /// пока webview в app-origin: уход по внешнему адресу превращает вкладку
    /// в обычную.
    pub(crate) fn on_page_load(&self, app: &AppHandle, id: &str, event: PageLoadEvent, url: &Url) {
        if matches!(event, PageLoadEvent::Started) {
            // Новый документ вкладки: состояние субтитров прошлого документа
            // (список дорожек, набор) не актуально — чистим до первых
            // сообщений нового документа (задача 3.7).
            app.state::<crate::subtitles::service::SubtitlesService>()
                .reset_tab(id);
        }
        let mut st = self.state.lock().expect("tabs: лок не отравлен");
        let Some(entry) = st.tabs.iter_mut().find(|t| t.id == id) else {
            return;
        };
        let record_visit = matches!(event, PageLoadEvent::Finished)
            && matches!(url.scheme(), "http" | "https")
            && !entry.incognito // инкогнито: без визитов истории (duopulse-096)
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
                .state::<std::sync::Arc<crate::history::HistoryStore>>()
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
        // инкогнито (duopulse-096): заголовок в истории не подтягивается —
        // визитов инкогнито нет, note_title обновил бы последний визит обычной
        // навигации по совпавшему URL
        let note = if entry.internal || entry.incognito {
            None
        } else {
            Some(entry.url.clone())
        };
        drop(st);
        if let Some(url) = note {
            if let Err(e) = app
                .state::<std::sync::Arc<crate::history::HistoryStore>>()
                .note_title(&url, &title)
            {
                eprintln!("history: заголовок не обновлён ({url}): {e}");
            }
        }
        self.finish(app);
    }

    /// NavigationCompleted с ошибкой (карточка duopulse-048, docs/02 §6.2):
    /// неудачная навигация внешней страницы превращает вкладку в собственную
    /// страницу ошибки duopulse://error — с адресом, причиной и действием
    /// «этот сайт — через туннель». Вызывается из COM-колбэка на главном
    /// потоке: только фильтры под локом, пересоздание webview — async-задачей
    /// (round-trip создания нельзя делать на потоке цикла событий, см. open).
    pub(crate) fn on_nav_failed(&self, app: &AppHandle, tab_id: &str, status: i32) {
        let url = {
            let st = self.state.lock().expect("tabs: лок не отравлен");
            let Some(entry) = st.tabs.iter().find(|t| t.id == tab_id) else {
                return;
            };
            let parsed = Url::parse(&entry.url).ok();
            if !should_show_error_page(entry.internal, parsed.as_ref(), status) {
                return;
            }
            entry.url.clone()
        };
        let app = app.clone();
        let tab_id = tab_id.to_string();
        tauri::async_runtime::spawn(async move {
            let manager = app.state::<TabManager>();
            if let Err(e) = manager.show_error_page(&app, &tab_id, &url, status) {
                eprintln!("tabs: страница ошибки не показана ({url}): {e}");
            }
        });
    }

    /// Замена webview вкладки на страницу ошибки: прежний webview (ERR-страница
    /// Chromium) закрывается, новый с меткой page-error-<N> грузит UI-бандл —
    /// метка матчит роутер src/main.ts и capability page-* (IPC для кнопки
    /// «через туннель»). Контекст (адрес/причина) — init-скриптом до бандла.
    /// Content-скрипты ставятся как у контентных вкладок: «Повторить» уводит
    /// webview на сайт, и он должен работать полноценно (блокировщик, субтитры).
    /// Канонический адрес вкладки (omnibox, сессия) остаётся адресом сайта —
    /// как в браузерах: рестарт загрузит сайт заново, не страницу ошибки.
    fn show_error_page(
        &self,
        app: &AppHandle,
        old_id: &str,
        url: &str,
        status: i32,
    ) -> Result<(), String> {
        let new_id = {
            let mut st = self.state.lock().expect("tabs: лок не отравлен");
            // seq берём до поиска entry: и то и другое через DerefMut guard,
            // живой mutable-borrow tabs не даёт тронуть next_seq после.
            st.next_seq += 1;
            let seq = st.next_seq;
            let entry = st
                .tabs
                .iter_mut()
                .find(|t| t.id == old_id)
                .ok_or_else(|| format!("вкладка {old_id} не найдена"))?;
            // Пока задача дошла до выполнения, вкладка могла уйти с упавшего
            // адреса (Finished новой навигации) — ошибка уже не про неё.
            if entry.url != url {
                return Ok(());
            }
            let new_id = format!("page-error-{seq}");
            entry.id = new_id.clone();
            entry.internal = true; // app-origin загрузки не трогают URL вкладки
            entry.title = None;
            entry.loading = false;
            entry.sleeping = false;
            entry.media_playing = false;
            entry.last_active_ms = now_ms();
            new_id
        };
        if let Some(wv) = app.get_webview(old_id) {
            wv.close()
                .map_err(|e| format!("закрытие webview вкладки: {e}"))?;
        }
        let window = app
            .get_window("main")
            .ok_or_else(|| "окно main не найдено".to_string())?;
        let script = format!(
            "window.__DUOPULSE_ERROR__ = {};",
            serde_json::json!({ "url": url, "code": status, "reason": describe_web_error(status) })
        );
        let builder = build_tab_webview(app, &new_id, WebviewUrl::App("index.html".into()), false)
            .initialization_script(script);
        let (pos, size) = content_rect(&window);
        let webview = window
            .add_child(builder, pos, size)
            .map_err(|e| format!("создание webview страницы ошибки: {e}"))?;
        let app_for_handlers = app.clone();
        let id_for_handlers = new_id;
        webview
            .with_webview(move |wv| unsafe {
                crate::install_content_handlers(wv, &app_for_handlers, &id_for_handlers)
            })
            .map_err(|e| format!("установка обработчиков страницы ошибки: {e}"))?;
        self.apply_visibility(app);
        self.finish(app);
        Ok(())
    }
}

/// Текущее время, unix-ms (метка сохранения сессии, отсчёт простоя вкладок).
pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Проекция вкладок для session.json (карточка duopulse-096): инкогнито-вкладки
/// не сохраняются — ни URL, ни заголовки (приватность переживает рестарт).
/// Активная инкогнито переносится на ближайшую обычную слева (как браузеры:
/// закрытие приватного окна возвращает туда, откуда пришли), слева обычных
/// нет — на первую обычную; обычных нет совсем — пустая сессия (старт с чистого
/// листа, session::load вернёт None).
fn session_projection(
    tabs: &[TabEntry],
    active: Option<usize>,
) -> (Vec<SessionTab>, Option<usize>) {
    let normal: Vec<usize> = tabs
        .iter()
        .enumerate()
        .filter(|(_, t)| !t.incognito)
        .map(|(i, _)| i)
        .collect();
    if normal.is_empty() {
        return (Vec::new(), None);
    }
    let chosen = match active {
        Some(a) if !tabs[a].incognito => a,
        // активная инкогнито: ближайшая обычная слева, иначе первая обычная
        Some(a) => normal
            .iter()
            .copied()
            .filter(|&i| i < a)
            .max()
            .unwrap_or(normal[0]),
        None => normal[0],
    };
    let out = normal
        .iter()
        .map(|&i| SessionTab {
            url: tabs[i].url.clone(),
            title: tabs[i].title.clone(),
        })
        .collect();
    (out, normal.iter().position(|&i| i == chosen))
}

// --- страница ошибки загрузки (карточка duopulse-048, docs/02 §6.2) -----------
// Значения COREWEBVIEW2_WEB_ERROR_STATUS, участвующие в решениях: числа
// стабильны в API WebView2; словарь живёт здесь, чтобы модуль не зависел от
// виндового крейта (юнит-тесты фильтра гоняются везде).

/// Навигация отменена (Esc, перебита новой) — не ошибка сайта, страницу
/// ошибки не показываем.
const WEB_ERROR_OPERATION_CANCELED: i32 = 14;

/// Человекочитаемая причина для страницы ошибки (дефолт — «сайт недоступен»).
pub(crate) fn describe_web_error(status: i32) -> &'static str {
    match status {
        1 => "имя в сертификате сайта не совпадает с адресом",
        2 => "сертификат сайта истёк",
        3 | 5 => "сертификат сайта недействителен",
        4 => "сертификат сайта отозван",
        6 => "сервер недоступен",
        7 => "превышено время ожидания ответа",
        8 => "сервер вернул некорректный ответ",
        9 | 12 => "не удаётся подключиться к серверу",
        10 | 11 => "соединение прервано",
        13 => "домен не найден (DNS)",
        15 => "цикл или сбой перенаправления",
        16 => "неожиданная ошибка сети",
        17 => "сервер требует авторизацию",
        18 => "прокси требует авторизацию",
        _ => "сайт недоступен",
    }
}

/// Показывать ли страницу ошибки для завершившейся навигации: только внешние
/// http/https-страницы (внутренние duopulse:// и app-origin бандл не считаются)
/// и только настоящие сбои — отменённая навигация (Esc, перебитая новой) не
/// ошибка сайта.
fn should_show_error_page(internal: bool, url: Option<&Url>, status: i32) -> bool {
    if internal || status == WEB_ERROR_OPERATION_CANCELED {
        return false;
    }
    matches!(url.map(|u| u.scheme()), Some("http" | "https"))
}

/// Внутренние страницы duopulse:// (задача 1.4): адрес → имя страницы.
/// Новые страницы добавляются сюда + в роутер src/main.ts.
fn internal_page_name(url: &Url) -> Option<&'static str> {
    match url.host_str()? {
        "history" => Some("history"),
        "newtab" => Some("newtab"), // «Новая вкладка», задача 1.5 (гайд 06 §7)
        "diagnostics" => Some("diagnostics"), // «Диагностика», задача 2.5
        "settings" => Some("settings"), // «Настройки», задача 5.1
        "passwords" => Some("passwords"), // «Пароли», этап 1 duopulse-106
        "error" => Some("error"),   // страница ошибки загрузки, карточка 048
        "incognito" => Some("incognito"), // стартовая страница инкогнито, 096
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

/// Сборка webview контентной вкладки: стартовый URL (External сайта; для
/// страницы ошибки — App-бандл, см. show_error_page), content-скрипты (монитор
/// M0 + горячие клавиши таб-бара), аргументы окружения старта, трекинг
/// URL/заголовка.
fn build_tab_webview(
    app: &AppHandle,
    id: &str,
    start: WebviewUrl,
    incognito: bool,
) -> WebviewBuilder<tauri::Wry> {
    let app_for_load = app.clone();
    let app_for_title = app.clone();
    let builder = WebviewBuilder::new(id, start);
    // Маркер инкогнито (карточка duopulse-096) — ПЕРВЫМ инициализационным
    // скриптом: контент-скрипты ниже читают его при старте (passwords-fill
    // этапа 2 duopulse-108 гасит сохранение/автозаполнение по нему).
    let builder = if incognito {
        builder.initialization_script("window.__DUOPULSE_INCOGNITO__ = 1;")
    } else {
        builder
    };
    builder
        // Критерий M0: скрипт выполняется в каждом новом документе
        // (WebView2: AddScriptToExecuteOnDocumentCreatedAsync).
        .initialization_script(crate::CONTENT_INIT_SCRIPT_M0)
        // Горячие клавиши таб-бара в контенте (задача 1.2) — до скриптов
        // страницы, чтобы перехват нельзя было снять.
        .initialization_script(crate::CONTENT_INIT_SCRIPT_HOTKEYS)
        // Трекер SPA-навигации (карточка duopulse-057): pushState/replaceState
        // не порождают загрузки документа — адрес вкладки актуализируется
        // сообщением из страницы (TabManager::on_spa_url).
        .initialization_script(crate::CONTENT_INIT_SCRIPT_URL_WATCH)
        // Монитор медиа для спящего режима (задача 2.3): играет звук/видео —
        // вкладка не усыпляется (сообщение → TabManager::on_media).
        .initialization_script(crate::CONTENT_INIT_SCRIPT_MEDIA)
        // Косметика блокировщика (задача 2.2): селекторы скрытия до отрисовки
        // страницы — ресурс запрашивается у Core сразу после создания
        // документа (content/cosmetic.js → main.rs → PostWebMessage).
        .initialization_script(crate::content_init_script_cosmetic())
        // Дефолты субтитров из настроек (задача 5.1): до бандла субтитров —
        // window.__DUOPULSE_DEFAULTS__ (язык перевода дефолт-набора Alt+D,
        // стиль плашки новых вкладок). Читается при создании каждой вкладки:
        // новые вкладки видят свежесохранённые настройки.
        .initialization_script(crate::settings::content_defaults_script(
            &crate::proxy::profile_dir(),
        ))
        // Бандл субтитров (задача 3.2): детектор <video> + движок cue-таймлайна
        // + оверлей; обнаруженное видео уходит в Core сообщением «video»
        // (main.rs → событие контракта page:video_detected, docs/05 §2).
        .initialization_script(crate::CONTENT_INIT_SCRIPT_SUBTITLES)
        // Кнопка «Пропустить рекламу» (карточка duopulse-076): активна только
        // на watch-страницах YouTube (host-проверка внутри скрипта).
        .initialization_script(crate::CONTENT_INIT_SCRIPT_AD_SKIP)
        // Закрытие панелей хрома кликом (duopulse-090): репорт из документа.
        .initialization_script(crate::CONTENT_INIT_SCRIPT_PANEL_CLOSE)
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
            internal_page_name(&Url::parse("duopulse://diagnostics").unwrap()),
            Some("diagnostics")
        );
        assert_eq!(
            internal_page_name(&Url::parse("duopulse://settings").unwrap()),
            Some("settings"),
            "страница «Настройки» (задача 5.1)"
        );
        assert_eq!(
            internal_page_name(&Url::parse("https://www.youtube.com/").unwrap()),
            None
        );
        assert_eq!(
            internal_page_name(&Url::parse("duopulse://unknown").unwrap()),
            None
        );
        assert_eq!(
            internal_page_name(&Url::parse("duopulse://error?url=https://x").unwrap()),
            Some("error"),
            "страница ошибки (карточка 048) — внутренняя"
        );
        assert_eq!(
            internal_page_name(&Url::parse("duopulse://incognito").unwrap()),
            Some("incognito"),
            "стартовая страница инкогнито (карточка 096)"
        );
    }

    /// Черновик вкладки для тестов проекции сессии.
    fn entry(url: &str, incognito: bool) -> TabEntry {
        TabEntry {
            id: String::new(),
            url: url.into(),
            title: None,
            loading: false,
            internal: false,
            lazy: false,
            sleeping: false,
            media_playing: false,
            last_active_ms: 0,
            incognito,
        }
    }

    /// Проекция сессии (карточка duopulse-096): инкогнито-вкладки не
    /// сохраняются, активная инкогнито переносится на ближайшую обычную
    /// слева (нет слева — первая обычная), все инкогнито — пустая сессия.
    #[test]
    fn session_projection_drops_incognito() {
        let tabs = vec![
            entry("https://a.example/", false),
            entry("https://secret.example/", true),
            entry("https://b.example/", false),
            entry("https://c.example/", false),
        ];
        // активная — инкогнито: ближайшая обычная слева (a), инкогнито выпала
        let (out, active) = session_projection(&tabs, Some(1));
        assert_eq!(
            out.iter().map(|t| t.url.as_str()).collect::<Vec<_>>(),
            vec![
                "https://a.example/",
                "https://b.example/",
                "https://c.example/"
            ]
        );
        assert_eq!(active, Some(0));
        // активная — обычная: она и остаётся
        let (_, active) = session_projection(&tabs, Some(2));
        assert_eq!(active, Some(1));
        // инкогнито левее всех обычных: активной становится первая обычная
        let mixed = vec![
            entry("https://x.example/", true),
            entry("https://y.example/", false),
        ];
        let (out, active) = session_projection(&mixed, Some(0));
        assert_eq!(out.len(), 1);
        assert_eq!(active, Some(0));
        // только инкогнито — пустая сессия (свежий старт после рестарта)
        let only = vec![entry("https://x.example/", true)];
        let (out, active) = session_projection(&only, Some(0));
        assert!(out.is_empty());
        assert_eq!(active, None);
    }

    /// Фильтр страницы ошибки (карточка 048): отмена (Esc, перебитая
    /// навигация) и внутренние страницы кнопку/страницу не показывают,
    /// внешние http/https — показывают.
    #[test]
    fn error_page_filters() {
        let site = Url::parse("https://blocked.example/").unwrap();
        // отменённая навигация — не ошибка сайта (критерий карточки)
        assert!(!should_show_error_page(false, Some(&site), 14));
        // внутренняя страница / app-origin бандл (в т.ч. повторная ошибка
        // поверх страницы ошибки, пока вкладка не ушла «Повторить»)
        assert!(!should_show_error_page(true, Some(&site), 13));
        assert!(!should_show_error_page(true, None, 13));
        // не-внешние схемы (tauri:// бандл, file://, about:)
        assert!(!should_show_error_page(
            false,
            Some(&Url::parse("tauri://localhost/index.html").unwrap()),
            13
        ));
        assert!(!should_show_error_page(false, None, 13));
        // настоящий сетевой сбой внешней страницы — показываем
        assert!(should_show_error_page(false, Some(&site), 13));
        assert!(should_show_error_page(false, Some(&site), 0));
    }

    /// Словарь причин: ключевые статусы дают осмысленный текст, неизвестный
    /// код — честный дефолт «сайт недоступен».
    #[test]
    fn error_page_reasons() {
        assert_eq!(describe_web_error(13), "домен не найден (DNS)");
        assert_eq!(describe_web_error(7), "превышено время ожидания ответа");
        assert_eq!(describe_web_error(14), "сайт недоступен");
        assert_eq!(describe_web_error(99), "сайт недоступен");
    }
}
