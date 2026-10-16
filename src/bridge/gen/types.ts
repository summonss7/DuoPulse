// GENERATED FILE — НЕ ПРАВИТЬ РУКАМИ.
// Источник: src-tauri/src/bridge.rs → bridge/contract.json (версия контракта 2); регенерация: npm run gen:bridge.

/**
 * Откуда подсказка: посещение из истории или закладка.
 */
export type HistorySource = "history" | "bookmark";
/**
 * settings.get / settings.set: ключи настроек профиля. M1: один ключ.
 */
export type SettingsKey = "proxy";
/**
 * Тип прокси. Схемы --proxy-server у Chromium: socks5/http/https (для socks5 Chromium резолвит домены на стороне прокси).
 */
export type ProxyProto = "socks5" | "http" | "https";
export type ProxyState = "off" | "on" | "error";

/**
 * Реестр типов IPC-контракта bridge (все поля — ссылки на типы).
 */
export interface DuoPulseBridgeContract {
  AdblockSetEnabledParams: AdblockSetEnabledParams;
  AdblockStatusResult: AdblockStatusResult;
  AdblockListInfo: AdblockListInfo;
  AdblockUpdateListsParams: AdblockUpdateListsParams;
  BridgeVersionResult: BridgeVersionResult;
  HistoryBookmarkAddParams: HistoryBookmarkAddParams;
  HistoryBookmarkListParams: HistoryBookmarkListParams;
  HistoryBookmarkListResult: HistoryBookmarkListResult;
  HistoryBookmark: HistoryBookmark;
  HistoryBookmarkRemoveParams: HistoryBookmarkRemoveParams;
  HistoryBookmarkUpdateParams: HistoryBookmarkUpdateParams;
  HistoryDeleteRangeParams: HistoryDeleteRangeParams;
  HistoryDeleteUrlsParams: HistoryDeleteUrlsParams;
  HistoryListParams: HistoryListParams;
  HistoryListResult: HistoryListResult;
  HistoryEntry: HistoryEntry;
  HistorySearchParams: HistorySearchParams;
  HistorySearchResult: HistorySearchResult;
  HistoryHit: HistoryHit;
  HistorySource: HistorySource;
  HistoryVisitParams: HistoryVisitParams;
  NavNavigateParams: NavNavigateParams;
  NavResolveOmniboxParams: NavResolveOmniboxParams;
  NavResolveOmniboxResult: NavResolveOmniboxResult;
  PerfRunListResult: PerfRunListResult;
  PerfRun: PerfRun;
  PerfSaveRunParams: PerfSaveRunParams;
  PerfSnapshotResult: PerfSnapshotResult;
  PerfAdblock: PerfAdblock;
  PerfPhase: PerfPhase;
  PerfStartupInfo: PerfStartupInfo;
  PerfTabSwitchInfo: PerfTabSwitchInfo;
  PerfTabs: PerfTabs;
  SettingsGetParams: SettingsGetParams;
  SettingsKey: SettingsKey;
  ProxySettings: ProxySettings;
  ProxyProto: ProxyProto;
  SettingsSetParams: SettingsSetParams;
  ProxyConfig: ProxyConfig;
  TabsActivateParams: TabsActivateParams;
  TabsListResult: TabsListResult;
  TabInfo: TabInfo;
  TabsCloseParams: TabsCloseParams;
  TabsOpenParams: TabsOpenParams;
  TabsSleepParams: TabsSleepParams;
  TabsWakeParams: TabsWakeParams;
  VpnSetEnabledParams: VpnSetEnabledParams;
  VpnStatusResult: VpnStatusResult;
  ProxyState: ProxyState;
  AdblockBlockedCount: AdblockBlockedCount;
  AdblockSiteException: AdblockSiteException;
  PageLoaded: PageLoaded;
  PageVideoDetected: PageVideoDetected;
  PerfStartupMs: PerfStartupMs;
  PerfTabSwitchMs: PerfTabSwitchMs;
  VpnStateChanged: VpnStateChanged;
}
/**
 * adblock.set_enabled: site=None — глобальный тумблер; Some — исключение сайта (white-list, docs/04 §1.2). on=true снимает исключение.
 */
export interface AdblockSetEnabledParams {
  on: boolean;
  site?: string | null;
}
/**
 * adblock.status (и результат set_enabled/update_lists): снапшот состояния блокировщика для меню и e2e.
 */
export interface AdblockStatusResult {
  /**
   * Заблокировано запросов за сеанс.
   */
  blockedTotal: number;
  /**
   * Глобальный тумблер.
   */
  enabled: boolean;
  lists: AdblockListInfo[];
  /**
   * Движок построен (списки загружены/из кэша) — фильтрация активна.
   */
  ready: boolean;
  /**
   * Всех http(s)-запросов через перехватчик (диагностика P-07).
   */
  seenTotal: number;
  /**
   * Сайты-исключения (хосты).
   */
  siteExceptions: string[];
}
export interface AdblockListInfo {
  /**
   * Последняя ошибка загрузки (None — ошибок нет).
   */
  error?: string | null;
  name: string;
  /**
   * Число правил в последней загруженной версии.
   */
  rules: number;
  /**
   * http(s)-адрес или путь файла-источника.
   */
  source: string;
  /**
   * Успешная загрузка, unix-ms (0 — списка ещё не было).
   */
  updatedAt: number;
}
/**
 * adblock.update_lists: обновить списки блокировщика.
 */
export interface AdblockUpdateListsParams {
  /**
   * true — качать даже непротухшие (кнопка «Обновить списки»).
   */
  force?: boolean;
}
/**
 * bridge.version: версия контракта живого приложения (диагностика, e2e).
 */
export interface BridgeVersionResult {
  version: number;
}
/**
 * history.bookmark_add: добавить закладку (url — ключ; повторное добавление обновляет заголовок, пустой заголовок сохраняет прежний).
 */
export interface HistoryBookmarkAddParams {
  title?: string;
  url: string;
}
/**
 * history.bookmark_list: закладки для страницы управления.
 */
export interface HistoryBookmarkListParams {
  limit?: number;
  offset?: number;
  query?: string | null;
}
export interface HistoryBookmarkListResult {
  bookmarks: HistoryBookmark[];
  total: number;
}
export interface HistoryBookmark {
  /**
   * Добавлена, unix-ms.
   */
  addedAt: number;
  title: string;
  url: string;
}
/**
 * history.bookmark_remove: удалить закладку (идемпотентна).
 */
export interface HistoryBookmarkRemoveParams {
  url: string;
}
/**
 * history.bookmark_update: переименовать закладку (правка на странице управления); несуществующая — ошибка.
 */
export interface HistoryBookmarkUpdateParams {
  title: string;
  url: string;
}
/**
 * history.delete_range: удалить визиты за [fromMs..=toMs] (unix-ms); fromMs=0, toMs=«будущее» — вся история (закладки не трогаются).
 */
export interface HistoryDeleteRangeParams {
  fromMs: number;
  toMs: number;
}
/**
 * history.delete_urls: удалить из истории все визиты перечисленных адресов.
 */
export interface HistoryDeleteUrlsParams {
  urls: string[];
}
/**
 * history.list: история для страницы управления — агрегат по URL.
 */
export interface HistoryListParams {
  /**
   * Страница выдачи (по умолчанию 100, максимум 500).
   */
  limit?: number;
  offset?: number;
  /**
   * FTS-фильтр по заголовку/адресу (префиксные токены); пустой — всё.
   */
  query?: string | null;
}
export interface HistoryListResult {
  entries: HistoryEntry[];
  /**
   * Всего URL, подходящих под фильтр (пагинация).
   */
  total: number;
}
export interface HistoryEntry {
  /**
   * Последнее посещение, unix-ms.
   */
  lastVisitedAt: number;
  /**
   * Заголовок последнего визита (может быть пуст до on_title).
   */
  title: string;
  url: string;
  visitCount: number;
}
/**
 * history.search: подсказки omnibox — полнотекстовый поиск по истории и закладкам (FTS5, задача 1.3; хранилище — src/history/, SQLite в профиле — задача 1.4).
 */
export interface HistorySearchParams {
  /**
   * Максимум подсказок в ответе (по умолчанию 8, диапазон 1–20).
   */
  limit?: number;
  query: string;
}
export interface HistorySearchResult {
  hits: HistoryHit[];
}
/**
 * Одна подсказка omnibox: источник, адрес и заголовок страницы.
 */
export interface HistoryHit {
  source: HistorySource;
  title: string;
  url: string;
}
/**
 * history.visit: записать посещение. Core записывает визиты сам (on_page_load вкладок, только http/https); команда в словаре — для e2e-стендов и будущих источников (docs/05 §2).
 */
export interface HistoryVisitParams {
  title?: string;
  url: string;
}
/**
 * nav.navigate: переход активной вкладки по URL.
 */
export interface NavNavigateParams {
  url: string;
}
/**
 * nav.resolve_omnibox: разобрать ввод адресной строки — адрес (с догадкой схемы) или поисковый запрос; результат — готовый URL для nav.navigate (задача 1.3, разбор — src/omnibox.rs).
 */
export interface NavResolveOmniboxParams {
  input: string;
}
export interface NavResolveOmniboxResult {
  /**
   * Ввод распознан как поисковый запрос (не как адрес).
   */
  isSearch: boolean;
  url: string;
}
/**
 * perf.list_runs (результат): прогоны, новые → старые.
 */
export interface PerfRunListResult {
  runs: PerfRun[];
}
/**
 * Сохранённый прогон метрик (perf.list_runs).
 */
export interface PerfRun {
  /**
   * Время сохранения, unix-ms.
   */
  createdAt: number;
  id: number;
  label: string;
  metrics: {
    [k: string]: number;
  };
}
/**
 * perf.save_run (параметры): метки прогона и значения метрик по идентификаторам страницы (p01_ms, p02_ms, …).
 */
export interface PerfSaveRunParams {
  label?: string;
  metrics: {
    [k: string]: number;
  };
}
/**
 * perf.snapshot (результат): живой срез сеанса для страницы «Диагностика».
 */
export interface PerfSnapshotResult {
  adblock: PerfAdblock;
  /**
   * Приватная память duopulse.exe, МБ (P-03).
   */
  ramSelfMb: number;
  startup?: PerfStartupInfo | null;
  tabSwitch: PerfTabSwitchInfo;
  tabs: PerfTabs;
  uptimeMs: number;
}
/**
 * Счётчики блокировщика сеанса (perf.snapshot): контекст P-07.
 */
export interface PerfAdblock {
  blockedTotal: number;
  enabled: boolean;
  ready: boolean;
  seenTotal: number;
}
/**
 * Итог старта этого сеанса (perf.snapshot / payload perf:startup_ms без фаз).
 */
export interface PerfStartupInfo {
  /**
   * Профиль на старте был пуст — холодный старт (P-01), иначе тёплый (P-02).
   */
  cold: boolean;
  /**
   * Вход в main → RunEvent::Ready, мс.
   */
  ms: number;
  /**
   * Фазы «[startup]» (main, stores-open, setup, …, ready).
   */
  phases: PerfPhase[];
}
/**
 * Одна фаза старта: имя и накопленное время от входа в main, мс.
 */
export interface PerfPhase {
  ms: number;
  stage: string;
}
/**
 * Переключения вкладок сеанса (perf.snapshot).
 */
export interface PerfTabSwitchInfo {
  avgMs?: number | null;
  count: number;
  lastMs?: number | null;
  maxMs?: number | null;
}
/**
 * Вкладки сеанса (perf.snapshot): всего и спящих (P-04 в живом сеансе).
 */
export interface PerfTabs {
  sleeping: number;
  total: number;
}
/**
 * settings.get: ключ, значение которого читаем.
 */
export interface SettingsGetParams {
  key: SettingsKey;
}
/**
 * Значение ключа "proxy" для UI: конфиг прокси + факт наличия пароля в DPAPI (сам пароль наружу не отдаётся).
 */
export interface ProxySettings {
  enabled: boolean;
  hasPassword: boolean;
  host: string;
  login?: string | null;
  port: number;
  proto: ProxyProto;
}
/**
 * settings.set: value — значение ключа; secret — секрет ключа в DPAPI: None — не менять, Some("") — удалить, Some(p) — перезаписать. Для "proxy" value без пароля (пароль — только DPAPI, docs/02 §9).
 */
export interface SettingsSetParams {
  key: SettingsKey;
  secret?: string | null;
  value: ProxyConfig;
}
/**
 * Конфиг прокси в settings.json. Пароль сюда НЕ пишется — только DPAPI.
 */
export interface ProxyConfig {
  enabled: boolean;
  host?: string;
  login?: string | null;
  port?: number;
  proto?: ProxyProto & string;
}
/**
 * tabs.activate: сделать вкладку активной (клик по вкладке таб-бара).
 */
export interface TabsActivateParams {
  id: string;
}
/**
 * tabs.list: вкладки окна в порядке таб-бара (менеджер вкладок — src/tabs/).
 */
export interface TabsListResult {
  tabs: TabInfo[];
}
export interface TabInfo {
  /**
   * Активна ли вкладка (виден её webview).
   */
  active: boolean;
  /**
   * Идентификатор webview-вкладки.
   */
  id: string;
  /**
   * Идёт загрузка документа (пульс-индикатор вкладки, гайд 06 §3).
   */
  loading: boolean;
  /**
   * Спит ли вкладка (приостановлена WebView2; задача 2.3): JS/таймеры заморожены, состояние страницы сохранено, активация будит.
   */
  sleeping: boolean;
  /**
   * Заголовок страницы (пусто — до первого on_document_title_changed).
   */
  title?: string | null;
  /**
   * Текущий URL вкладки.
   */
  url: string;
}
/**
 * tabs.close: закрыть вкладку по id; активной становится соседняя.
 */
export interface TabsCloseParams {
  id: string;
}
/**
 * tabs.open: открыть вкладку; без url — стартовая страница (до страницы «Новая вкладка» задачи 1.5). Новая вкладка становится активной.
 */
export interface TabsOpenParams {
  url?: string | null;
}
/**
 * tabs.sleep: усыпить вкладку вручную (задача 2.3; авто-усыпление долгих простоёв — фоновая нить Core). Активная вкладка и вкладка с играющим звуком/видео не усыпляются — ошибка.
 */
export interface TabsSleepParams {
  id: string;
}
/**
 * tabs.wake: разбудить вкладку (задача 2.3; активация и так будит — команда для диагностики/e2e). Не спящая вкладка — no-op.
 */
export interface TabsWakeParams {
  id: string;
}
/**
 * vpn.set_enabled: включить/выключить маршрутизацию через внешний прокси (инкремент A; в M6 — выбор маршрута локальным роутером, docs/02 §6). Включение с невалидным конфигом — ошибка, конфиг не меняется.
 */
export interface VpnSetEnabledParams {
  on: boolean;
}
/**
 * vpn.status / vpn.test_connection: состояние маршрутизации. state — словарь M1 (off/on/error); в M6 при WireGuard контракт расширится состояниями из docs/05 §2 (connecting/connected) с bump версии.
 */
export interface VpnStatusResult {
  detail: string;
  state: ProxyState;
}
/**
 * adblock:blocked_count: прирост блокировок (батчинг ~400 мс в Core, задача 2.1) — счётчик в главном меню.
 */
export interface AdblockBlockedCount {
  /**
   * Прирост с прошлого события.
   */
  delta: number;
  /**
   * Всего за сеанс.
   */
  total: number;
}
/**
 * adblock:site_exception_changed: включено/снято исключение сайта (payload события; on=false — сайт добавлен в white-list).
 */
export interface AdblockSiteException {
  on: boolean;
  site: string;
}
/**
 * page:loaded: документ загружен (M3 — детектор контента; каркас с 1.1).
 */
export interface PageLoaded {
  url: string;
}
/**
 * page:video_detected: на странице найден <video> (M3; каркас с 1.1).
 */
export interface PageVideoDetected {
  canTracks: boolean;
  videoKey: string;
}
/**
 * payload события perf:startup_ms (фазы страница берёт perf.snapshot'ом).
 */
export interface PerfStartupMs {
  cold: boolean;
  ms: number;
}
/**
 * payload события perf:tab_switch_ms.
 */
export interface PerfTabSwitchMs {
  ms: number;
}
/**
 * vpn:state_changed: состояние маршрутизации изменилось (каркас с 1.1; начнёт эмититься с локальным роутером M6, docs/02 §6).
 */
export interface VpnStateChanged {
  detail: string;
  state: ProxyState;
}
