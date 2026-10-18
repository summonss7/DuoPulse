// GENERATED FILE — НЕ ПРАВИТЬ РУКАМИ.
// Источник: src-tauri/src/bridge.rs → bridge/contract.json (версия контракта 5); регенерация: npm run gen:bridge.

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
/**
 * Тариф DeepL: free — api-free.deepl.com (500 тыс. знаков/мес), pro — api.deepl.com; отличается только хост эндпоинта.
 */
export type DeeplPlan = "free" | "pro";
/**
 * Провайдер машинного перевода (docs/03 §7, приоритет 2–3: облачный API по ключу пользователя или self-hosted LibreTranslate). Перевод самой платформы (YouTube tlang, приоритет 1) сюда не входит.
 */
export type ProviderId = "deepl" | "google" | "libretranslate";
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
  TabSubtitles: TabSubtitles;
  AppliedTrackInfo: AppliedTrackInfo;
  BaseTrackInfo: BaseTrackInfo;
  SubtitlesStyleInfo: SubtitlesStyleInfo;
  TranslationLangInfo: TranslationLangInfo;
  SubtitlesLoadFileParams: SubtitlesLoadFileParams;
  SubtitlesLoadFileResult: SubtitlesLoadFileResult;
  SubtitlesRemoveTrackParams: SubtitlesRemoveTrackParams;
  SubtitlesSetEnabledParams: SubtitlesSetEnabledParams;
  SubtitlesSetOffsetParams: SubtitlesSetOffsetParams;
  SubtitlesSetStyleParams: SubtitlesSetStyleParams;
  SubtitlesStylePatch: SubtitlesStylePatch;
  SubtitlesSetTracksParams: SubtitlesSetTracksParams;
  SubtitlesTranslateTrackParams: SubtitlesTranslateTrackParams;
  TabsActivateParams: TabsActivateParams;
  TabsListResult: TabsListResult;
  TabInfo: TabInfo;
  TabsCloseParams: TabsCloseParams;
  TabsOpenParams: TabsOpenParams;
  TabsSleepParams: TabsSleepParams;
  TabsWakeParams: TabsWakeParams;
  TranslateSettings: TranslateSettings;
  DeeplPlan: DeeplPlan;
  ProviderId: ProviderId;
  TranslateSetSettingsParams: TranslateSetSettingsParams;
  TranslateConfig: TranslateConfig;
  TranslateTestParams: TranslateTestParams;
  TranslateTestResult: TranslateTestResult;
  VpnSetEnabledParams: VpnSetEnabledParams;
  VpnStatusResult: VpnStatusResult;
  ProxyState: ProxyState;
  AdblockBlockedCount: AdblockBlockedCount;
  AdblockSiteException: AdblockSiteException;
  PageLoaded: PageLoaded;
  PageVideoDetected: PageVideoDetected;
  PerfStartupMs: PerfStartupMs;
  PerfTabSwitchMs: PerfTabSwitchMs;
  SubtitlesSetApplied: SubtitlesSetApplied;
  SubtitlesTracksReady: SubtitlesTracksReady;
  SubtitlesTranslateProgress: SubtitlesTranslateProgress;
  SubtitlesTranslateUnavailable: SubtitlesTranslateUnavailable;
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
 * Состояние субтитров одной вкладки (default — видео не найдено, показ включён: флаг управляет показом последнего набора, docs/03 §8 п.2).
 */
export interface TabSubtitles {
  /**
   * Полный список базовых дорожек адаптера (пуст — не YouTube/не получен).
   */
  base: BaseTrackInfo[];
  /**
   * Адаптер платформы дал список дорожек (кнопка «duo» видна).
   */
  canTracks: boolean;
  /**
   * Показ включён (Alt+D/панель; при false набор помнят обе стороны).
   */
  enabled: boolean;
  /**
   * Сдвиг показа, мс (±10 с, docs/03 §4).
   */
  offsetMs: number;
  /**
   * Стиль плашки.
   */
  style: SubtitlesStyleInfo;
  /**
   * Применённый набор (до 3 дорожек, порядок = порядок строк).
   */
  tracks: AppliedTrackInfo[];
  /**
   * Доступные переводы (tlang).
   */
  translations: TranslationLangInfo[];
  /**
   * Ключ текущего видео (None — видео не детектировано/ушло).
   */
  videoKey?: string | null;
}
/**
 * Базовая дорожка из player-ответа платформы (зеркало BaseTrackInfo content-адаптера, docs/03 §3.1).
 */
export interface BaseTrackInfo {
  id: string;
  /**
   * manual | asr (ручная или распознанная).
   */
  kind: string;
  lang: string;
  /**
   * Отображаемое имя (локализовано платформой).
   */
  name: string;
  /**
   * Дорожка языка оригинала (audioTracks.original).
   */
  original: boolean;
  /**
   * Платформа разрешает машинный перевод (tlang) этой дорожки.
   */
  translatable: boolean;
}
/**
 * Стиль плашки (docs/03 §6 SubtitleStyle): панель редактирует, оверлей применяет; здесь — последнее сообщённое значение.
 */
export interface SubtitlesStyleInfo {
  /**
   * Масштаб кегля, %: 75–300 (docs/03 §5).
   */
  fontScalePct: number;
  /**
   * Отступ от края видео, % высоты.
   */
  marginPct: number;
  /**
   * Непрозрачность подложки, 0–1 (гайд 06 §6).
   */
  plateOpacity: number;
  /**
   * bottom | top.
   */
  position: string;
}
/**
 * Дорожка применённого набора (зеркало set-state content-слоя): панель показывает состав/порядок, кнопка «duo» — количество (выкл/1/дуо/три).
 */
export interface AppliedTrackInfo {
  id: string;
  lang: string;
  /**
   * Отображаемое имя (имя платформы/слаг файла).
   */
  name: string;
  /**
   * original | translation.
   */
  role: string;
  /**
   * youtube | file | translate | test (docs/03 §6).
   */
  source: string;
}
/**
 * Язык машинного перевода (tlang), доступный для базовых дорожек.
 */
export interface TranslationLangInfo {
  lang: string;
  name: string;
}
/**
 * subtitles.load_file (задача 3.6, docs/03 §3.2): ручной файл субтитров с диска (панель «Свои субтитры»). Чтение и разбор — в Core (канонические парсеры задачи 3.1, src/subtitles), разобранные cue доставляются в content-слой активной вкладки (eval диспатчит duopulse-file-track); файловая дорожка входит в общий набор с дорожками платформы (docs/01 F-06).
 */
export interface SubtitlesLoadFileParams {
  /**
   * Абсолютный путь к файлу .srt/.vtt.
   */
  path: string;
}
export interface SubtitlesLoadFileResult {
  /**
   * Разобрано cue (0 — валидных cue нет, см. warnings).
   */
  cueCount: number;
  /**
   * Имя файла без каталога (панель/диагностика его показывают).
   */
  name: string;
  /**
   * Предупреждения разбора (снисходительный разбор — задача 3.1).
   */
  warnings: string[];
}
/**
 * subtitles.remove_track: снять дорожку из набора (панель, «×» у строки): файловую или платформенную, остальные — без перезагрузки.
 */
export interface SubtitlesRemoveTrackParams {
  id: string;
}
/**
 * subtitles.set_enabled: включить/выключить показ набора (Alt+D, тумблер панели): состав помнят обе стороны, включение восстанавливает без перезагрузки (docs/03 §8 п.2).
 */
export interface SubtitlesSetEnabledParams {
  on: boolean;
}
/**
 * subtitles.set_offset: сдвиг субтитров активной вкладки (±10 с, шаг 100 мс, docs/03 §4 п.3). Core доставляет значение в content-слой активной вкладки (eval диспатчит duopulse-set-offset); движок применяет сдвиг ко всему набору без перезагрузки дорожек и показывает HUD со слайдером. Активной контентной вкладки нет (или на странице нет субтитров) — no-op, не ошибка.
 */
export interface SubtitlesSetOffsetParams {
  /**
   * Сдвиг, мс: положительный — показывать позже. Клампится в ±10 000.
   */
  offsetMs: number;
}
/**
 * subtitles.set_style: стиль плашки активной вкладки (размер/позиция панели; то же значение меняют колесо мыши по плашке и тест-хук 3.4).
 */
export interface SubtitlesSetStyleParams {
  style: SubtitlesStylePatch;
}
/**
 * Частичный патч стиля плашки (docs/03 §6 SubtitleStyle): неназванные поля не меняются; клампы — в content-оверлее (mergeStyle, задача 3.4).
 */
export interface SubtitlesStylePatch {
  fontScalePct?: number | null;
  marginPct?: number | null;
  plateOpacity?: number | null;
  position?: string | null;
}
/**
 * subtitles.set_tracks: применить платформенную часть набора активной вкладки (порядок id = порядок строк на плашке; content-слой тот же состав в другом порядке переставляет без перезагрузки дорожек).
 */
export interface SubtitlesSetTracksParams {
  /**
   * id дорожек из списка адаптера («yt:en», «yt:en+ru», голый код перевода).
   */
  ids: string[];
}
/**
 * subtitles.translate_track (задача 4.2, docs/03 §7): перевести дорожку набора активной вкладки выбранным облачным провайдером. Cues — у content-слоя: команда диспатчит duopulse-translate-request в активную вкладку (eval), дальше конвейер идёт WebMessage'м «translate-track» (main.rs → src/translate/pipeline.rs: кэш SQLite → батчинг ≤ 2 КБ с контекстом пачки → кэш); панель следит за прогрессом событием subtitles:translate_progress. Команда только запускает — результат асинхронный (перевод длинной дорожки — минуты).
 */
export interface SubtitlesTranslateTrackParams {
  /**
   * Целевой язык, код («ru», «es», «pt-br»).
   */
  targetLang: string;
  /**
   * Дорожка-источник (id из набора; по умолчанию — первая строка, не являющаяся облачным переводом, предпочтение оригиналу).
   */
  trackId?: string | null;
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
 * Значение translate.get_settings для UI: конфиг + факт наличия ключей в DPAPI (сами ключи наружу не отдаются — как hasPassword прокси).
 */
export interface TranslateSettings {
  deeplPlan: DeeplPlan;
  enabled: boolean;
  /**
   * Провайдеры, у которых сохранён ключ API (DPAPI).
   */
  hasApiKeys: ProviderId[];
  libretranslateUrl: string;
  provider: ProviderId;
}
/**
 * translate.set_settings: value — конфиг без ключей (ключи — только DPAPI); secret — ключ API выбранного провайдера (value.provider): None — не менять, Some("") — удалить, Some(k) — перезаписать.
 */
export interface TranslateSetSettingsParams {
  secret?: string | null;
  value: TranslateConfig;
}
/**
 * Конфиг перевода в settings.json. Ключи API сюда НЕ пишутся — только DPAPI.
 */
export interface TranslateConfig {
  /**
   * Тариф DeepL (host free/pro).
   */
  deeplPlan?: DeeplPlan & string;
  /**
   * Облачный перевод разрешён (выкл — только переводы платформы, tlang).
   */
  enabled: boolean;
  /**
   * Адрес self-hosted LibreTranslate (base URL, без /translate).
   */
  libretranslateUrl?: string;
  /**
   * Выбранный провайдер (панель «Перевод»).
   */
  provider: ProviderId;
}
/**
 * translate.test: живая проверка выбранного провайдера (кнопка «Проверить» панели «Перевод») — перевод короткой фразы; text/target_lang опциональны (дефолт «DuoPulse» → ru).
 */
export interface TranslateTestParams {
  targetLang?: string | null;
  text?: string | null;
}
export interface TranslateTestResult {
  /**
   * Диагностика панели: подпись успеха или текст ошибки.
   */
  detail: string;
  ok: boolean;
  /**
   * Перевод пробной фразы (ok=true).
   */
  translated?: string | null;
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
 * page:video_detected: на странице найден <video> (M3; каркас с 1.1). tab_id — вкладка-источник (задача 3.7: кнопка «duo»/панель следят только за активной вкладкой).
 */
export interface PageVideoDetected {
  canTracks: boolean;
  tabId: string;
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
 * subtitles:set_applied: состояние показа вкладки изменилось (состав набора, включён ли показ, сдвиг, стиль; docs/05 §2) — кнопка «duo» (выкл/1/дуо/три) и панель обновляются событием; via — источник изменения (телеметрия: alt-d/panel/select/drop/video/lost/…).
 */
export interface SubtitlesSetApplied {
  enabled: boolean;
  offsetMs: number;
  style: SubtitlesStyleInfo;
  tabId: string;
  tracks: AppliedTrackInfo[];
  via: string;
  /**
   * None — видео ушло со страницы (детектор onVideoLost).
   */
  videoKey?: string | null;
}
/**
 * subtitles:tracks_ready: адаптер вкладки выдал полный список дорожек видео (docs/05 §2) — панель наполняет выбор языков/переводов.
 */
export interface SubtitlesTracksReady {
  base: BaseTrackInfo[];
  tabId: string;
  translations: TranslationLangInfo[];
  videoKey: string;
}
/**
 * Payload события: табл-контекст + фаза конвейера.
 */
export interface SubtitlesTranslateProgress {
  /**
   * Переведено cue / всего.
   */
  done: number;
  /**
   * Текст ошибки (phase=error).
   */
  error?: string | null;
  /**
   * Дорожка отдана из кэша — сети не было.
   */
  fromCache: boolean;
  /**
   * translating | done | error.
   */
  phase: string;
  /**
   * Провайдер (deepl/google/libretranslate) — чей ключ/квота в работе.
   */
  provider: string;
  tabId: string;
  targetLang: string;
  total: number;
  trackId: string;
  videoKey: string;
}
/**
 * Бейдж «перевод недоступен» (задача 4.3, docs/03 §7): панель показывает его в строке статуса конвейера; will_retry=true — Core повторяет сам, финал придёт обычным subtitles:translate_progress.
 */
export interface SubtitlesTranslateUnavailable {
  /**
   * Человекочитаемое описание (журнал/подсказка бейджа).
   */
  detail: string;
  /**
   * offline | no_provider (выключен/нет ключа).
   */
  reason: string;
  tabId: string;
  targetLang: string;
  trackId: string;
  videoKey: string;
  /**
   * true — Core повторит сам при появлении сети (бейдж держится).
   */
  willRetry: boolean;
}
/**
 * vpn:state_changed: состояние маршрутизации изменилось (каркас с 1.1; начнёт эмититься с локальным роутером M6, docs/02 §6).
 */
export interface VpnStateChanged {
  detail: string;
  state: ProxyState;
}
