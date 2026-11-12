// GENERATED FILE — НЕ ПРАВИТЬ РУКАМИ.
// Источник: src-tauri/src/bridge.rs → bridge/contract.json (версия контракта 15); регенерация: npm run gen:bridge.

/**
 * Размер локальной модели whisper (спайк duopulse-060: base — компромисс скорость/качество ru, small — лучшее качество, дольше счёт; tiny исключён — ru WER 39 %).
 */
export type LocalModelSize = "base" | "small";
/**
 * Движок распознавания (решение автора 29.10.2026 — гибрид; выбор в настройках): локальный whisper.cpp (приватно, офлайн) или облачный OpenAI-совместимый API (OpenAI / Groq / свой whisper-server).
 */
export type AsrProviderId = "local" | "openai";
/**
 * Откуда подсказка: посещение из истории или закладка.
 */
export type HistorySource = "history" | "bookmark";
export type Nullable_PasswordsCandidateView = PasswordsCandidateView | null;
/**
 * Поисковые системы omnibox (задача 5.1): выбор по умолчанию — настройка «Поиск». Префикс — шаблон ссылки с encoded-запросом в конце (omnibox.rs).
 */
export type SearchEngine = ("google" | "bing" | "duckduckgo") | "youtube";
/**
 * Канал обновлений (задача 5.2): stable — релизы, canary — ранние сборки для тестовых машин (DoD 5.2 — обновление канарейки). Канал — сегмент пути фида: <база>/<канал>/{{target}}/{{arch}}/{{current_version}}.
 */
export type UpdateChannel = "stable" | "canary";
/**
 * Источник фида обновлений (duopulse-049): GitHub Pages (по умолчанию) или зеркало на семейном сервере Aila (updates/duopulse/, aila-163). При недоступности выбранного проверка уходит ко второму (порядок попыток и «кто ответил» — src/updater.rs); установка в любом случае идёт с minisign-подписью, источник меняет только адрес фида и пакета.
 */
export type UpdateSource = "github" | "aila";
/**
 * settings.get / settings.set: ключи настроек профиля. M1: один ключ.
 */
export type SettingsKey = "proxy";
/**
 * Тип прокси. Схемы --proxy-server у Chromium: socks5/http/https (для socks5 Chromium резолвит домены на стороне прокси).
 */
export type ProxyProto = "socks5" | "http" | "https";
export type Theme = "dark";
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
  AilaLoginParams: AilaLoginParams;
  AilaStatusResult: AilaStatusResult;
  AilaSyncResult: AilaSyncResult;
  AppBuildInfoResult: AppBuildInfoResult;
  AsrClearCacheResult: AsrClearCacheResult;
  AsrSettings: AsrSettings;
  AsrProviderId: AsrProviderId;
  LocalModelSize: LocalModelSize;
  AsrPrepareResult: AsrPrepareResult;
  AsrSetSettingsParams: AsrSetSettingsParams;
  AsrConfig: AsrConfig;
  AsrTestResult: AsrTestResult;
  BridgeVersionResult: BridgeVersionResult;
  DownloadBeginParams: DownloadBeginParams;
  DownloadBeginResult: DownloadBeginResult;
  DownloadCancelParams: DownloadCancelParams;
  DownloadStatusResult: DownloadStatusResult;
  DownloadJobInfo: DownloadJobInfo;
  HistoryBookmarkAddParams: HistoryBookmarkAddParams;
  HistoryBookmarkListParams: HistoryBookmarkListParams;
  HistoryBookmarkListResult: HistoryBookmarkListResult;
  BookmarkGroupRef: BookmarkGroupRef;
  HistoryBookmark: HistoryBookmark;
  HistoryBookmarkMoveParams: HistoryBookmarkMoveParams;
  HistoryBookmarkRemoveParams: HistoryBookmarkRemoveParams;
  HistoryBookmarkUpdateParams: HistoryBookmarkUpdateParams;
  HistoryDeleteRangeParams: HistoryDeleteRangeParams;
  HistoryDeleteUrlsParams: HistoryDeleteUrlsParams;
  HistoryGroupAddParams: HistoryGroupAddParams;
  BookmarkGroupInfo: BookmarkGroupInfo;
  HistoryGroupListResult: HistoryGroupListResult;
  HistoryGroupRemoveParams: HistoryGroupRemoveParams;
  HistoryGroupRenameParams: HistoryGroupRenameParams;
  HistoryGroupSetSortParams: HistoryGroupSetSortParams;
  HistoryGroupToggleBookmarkParams: HistoryGroupToggleBookmarkParams;
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
  PasswordAddParams: PasswordAddParams;
  PasswordSaveResult: PasswordSaveResult;
  Nullable_PasswordsCandidateView: Nullable_PasswordsCandidateView;
  PasswordsCandidateView: PasswordsCandidateView;
  PasswordListParams: PasswordListParams;
  PasswordListResult: PasswordListResult;
  PasswordEntry: PasswordEntry;
  PasswordRemoveParams: PasswordRemoveParams;
  PasswordsResolveParams: PasswordsResolveParams;
  PasswordRevealParams: PasswordRevealParams;
  PasswordRevealResult: PasswordRevealResult;
  PasswordUpdateParams: PasswordUpdateParams;
  PerfRunListResult: PerfRunListResult;
  PerfRun: PerfRun;
  PerfSaveRunParams: PerfSaveRunParams;
  PerfSnapshotResult: PerfSnapshotResult;
  PerfAdblock: PerfAdblock;
  PerfPhase: PerfPhase;
  PerfStartupInfo: PerfStartupInfo;
  PerfTabSwitchInfo: PerfTabSwitchInfo;
  PerfTabs: PerfTabs;
  SettingsPatch: SettingsPatch;
  DiagnosticsConfig: DiagnosticsConfig;
  DownloadConfig: DownloadConfig;
  PrivacyConfig: PrivacyConfig;
  SearchConfig: SearchConfig;
  SearchEngine: SearchEngine;
  SubtitlesConfig: SubtitlesConfig;
  SubtitlesStyleDefaults: SubtitlesStyleDefaults;
  UpdateChannel: UpdateChannel;
  UpdateSource: UpdateSource;
  UpdaterConfig: UpdaterConfig;
  SettingsExportParams: SettingsExportParams;
  SettingsExportResult: SettingsExportResult;
  ProfileCounts: ProfileCounts;
  SettingsGetParams: SettingsGetParams;
  SettingsKey: SettingsKey;
  ProxySettings: ProxySettings;
  ProxyProto: ProxyProto;
  SettingsAll: SettingsAll;
  AppearanceConfig: AppearanceConfig;
  DeeplPlan: DeeplPlan;
  ProviderId: ProviderId;
  SearchEngineInfo: SearchEngineInfo;
  Theme: Theme;
  TranslateSettings: TranslateSettings;
  SettingsImportParams: SettingsImportParams;
  ImportOutcome: ImportOutcome;
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
  TranslateClearCacheResult: TranslateClearCacheResult;
  TranslateSetSettingsParams: TranslateSetSettingsParams;
  TranslateConfig: TranslateConfig;
  TranslateTestParams: TranslateTestParams;
  TranslateTestResult: TranslateTestResult;
  UpdaterCheckResult: UpdaterCheckResult;
  UpdaterStatusResult: UpdaterStatusResult;
  UpdateInfo: UpdateInfo;
  VpnAddRuleParams: VpnAddRuleParams;
  VpnRulesResult: VpnRulesResult;
  VpnRuleInfo: VpnRuleInfo;
  VpnImportProfileParams: VpnImportProfileParams;
  VpnProfileInfo: VpnProfileInfo;
  VpnRemoveProfileParams: VpnRemoveProfileParams;
  VpnRemoveRuleParams: VpnRemoveRuleParams;
  VpnSetEnabledParams: VpnSetEnabledParams;
  VpnSetModeParams: VpnSetModeParams;
  VpnStatusResult: VpnStatusResult;
  ProxyState: ProxyState;
  VpnWgState: VpnWgState;
  VpnUseProfileParams: VpnUseProfileParams;
  AdblockBlockedCount: AdblockBlockedCount;
  AdblockSiteException: AdblockSiteException;
  DownloadFinished: DownloadFinished;
  DownloadProgress: DownloadProgress;
  PageLoaded: PageLoaded;
  PageVideoDetected: PageVideoDetected;
  PasswordsSavePrompt: PasswordsSavePrompt;
  PerfStartupMs: PerfStartupMs;
  PerfTabSwitchMs: PerfTabSwitchMs;
  SubtitlesAsrProgress: SubtitlesAsrProgress;
  SubtitlesSetApplied: SubtitlesSetApplied;
  SubtitlesTracksReady: SubtitlesTracksReady;
  SubtitlesTranslateProgress: SubtitlesTranslateProgress;
  SubtitlesTranslateUnavailable: SubtitlesTranslateUnavailable;
  VpnRouteChanged: VpnRouteChanged;
  VpnStateChanged: VpnStateChanged;
  VpnStats: VpnStats;
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
   * Загружено $replace-правил перезаписи ответов (карточка duopulse-050; живые правила uBO движок adblock-rs игнорирует — парсит их наш слой).
   */
  replaceRules: number;
  /**
   * Ответов, чьи тела реально переписаны ($replace), за сеанс.
   */
  replacedTotal: number;
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
 * aila.login: вход в аккаунт Aila (PBKDF2 на клиенте, серверу уходит только auth_hash — как у веб-клиента Aila).
 */
export interface AilaLoginParams {
  password: string;
  username: string;
}
/**
 * aila.status: состояние аккаунта Aila (этап 4 duopulse-110): вход, сервер, ревизия облачного блоба паролей и итог последней синхронизации.
 */
export interface AilaStatusResult {
  displayName: string;
  lastError?: string | null;
  lastSyncAt?: number | null;
  loggedIn: boolean;
  revision: number;
  server: string;
  username: string;
}
/**
 * aila.sync_now: итог круга синка (pull → merge → push) обоих хранилищ: пароли (этап 4) + закладки (этап 5 duopulse-111).
 */
export interface AilaSyncResult {
  /**
   * паролей применено из облака (добавлено/обновлено).
   */
  applied: number;
  /**
   * закладок/групп применено из облака.
   */
  bookmarksApplied: number;
  /**
   * закладок было в облаке до слияния (этап 5).
   */
  bookmarksPulled: number;
  /**
   * закладочный блоб отправлен на сервер.
   */
  bookmarksPushed: boolean;
  /**
   * конфликтов пароля: проигравший сохранён записью-дублем.
   */
  conflicts: number;
  /**
   * записей паролей было в облаке до слияния.
   */
  pulled: number;
  /**
   * изменения ушли на сервер (хотя бы одно хранилище).
   */
  pushed: boolean;
  revision: number;
}
/**
 * app.build_info: версия приложения и момент сборки (карточка duopulse-074: бейдж «vX.Y.Z · дата» в шапке браузера). `build_unix` — unix-секунды компиляции (DUOPULSE_BUILD_UNIX из build.rs; 0 — неизвестно), фронтенд форматирует их локальной датой пользователя.
 */
export interface AppBuildInfoResult {
  buildUnix: number;
  version: string;
}
/**
 * asr.clear_cache (приватность): очистить кэш ASR-дорожек (asr_tracks).
 */
export interface AsrClearCacheResult {
  cleared: number;
}
/**
 * Значение asr.get_settings для UI: конфиг + факт наличия ключа (сами ключи наружу не отдаются) + состояние локального движка (exe/модель на месте).
 */
export interface AsrSettings {
  enabled: boolean;
  /**
   * whisper-server.exe найден (путь/профиль/рядом с exe).
   */
  engineFound: boolean;
  /**
   * Ключ API облака сохранён (DPAPI).
   */
  hasApiKey: boolean;
  localEnginePath: string;
  localModel: LocalModelSize;
  /**
   * Модель локального движка скачана в профиль.
   */
  modelDownloaded: boolean;
  openaiBaseUrl: string;
  openaiModel: string;
  provider: AsrProviderId;
}
/**
 * asr.prepare: скачать движок whisper-server.exe (если локальный путь не найден) и модель выбранного размера в профиль — подготовка офлайн-работы.
 */
export interface AsrPrepareResult {
  detail: string;
  /**
   * Движок на месте (был или скачался).
   */
  engineReady: boolean;
  /**
   * Модель на месте (была или скачалась).
   */
  modelReady: boolean;
  ok: boolean;
}
/**
 * asr.set_settings: value — конфиг без ключа (ключ — только DPAPI); secret — ключ API облака: None — не менять, Some("") — удалить, Some(k) — перезаписать.
 */
export interface AsrSetSettingsParams {
  secret?: string | null;
  value: AsrConfig;
}
/**
 * Конфиг ASR в settings.json. Ключ API сюда НЕ пишется — только DPAPI.
 */
export interface AsrConfig {
  /**
   * ASR разрешён (кнопка «Распознать речь» в панели).
   */
  enabled: boolean;
  /**
   * Путь к whisper-server.exe (пусто — искать: профиль → рядом с приложением → скачивание по требованию).
   */
  localEnginePath?: string;
  /**
   * Размер локальной модели whisper.
   */
  localModel?: LocalModelSize & string;
  /**
   * Base URL OpenAI-совместимого API (без /audio/transcriptions).
   */
  openaiBaseUrl?: string;
  /**
   * Модель облачного провайдера (whisper-1, whisper-large-v3-turbo, …).
   */
  openaiModel?: string;
  /**
   * Выбранный движок.
   */
  provider: AsrProviderId;
}
/**
 * asr.test: живая проверка выбранного движка (кнопка «Проверить» настроек ASR) — короткий WAV тишины в транскрипцию: успех = движок ответил (тишина без сегментов — нормальный ответ сервера, не ошибка связи).
 */
export interface AsrTestResult {
  /**
   * Диагностика панели.
   */
  detail: string;
  ok: boolean;
}
/**
 * bridge.version: версия контракта живого приложения (диагностика, e2e).
 */
export interface BridgeVersionResult {
  version: number;
}
/**
 * download.begin: что и как скачать с активной/указанной страницы.
 */
export interface DownloadBeginParams {
  /**
   * Формат аудио: mp3 (конвертация, нужен ffmpeg) либо m4a без перекодировки.
   */
  audioMp3?: boolean;
  /**
   * Каталог назначения (None — настройка «Загрузки», иначе системный Downloads).
   */
  dir?: string | null;
  /**
   * video | audio | subs.
   */
  mode: string;
  /**
   * best | 1080 | 720 | 480 | 360 (video).
   */
  quality?: string;
  /**
   * Конец диапазона (None до конца видео).
   */
  rangeEndSec?: number | null;
  /**
   * Диапазон куска, сек (video/audio): начало.
   */
  rangeStartSec?: number | null;
  /**
   * id дорожки из списка адаптера (subs): «yt:en», «yt:en+ru», «ru».
   */
  trackId?: string;
  /**
   * URL страницы/видео (для video/audio; субтитры берутся активной вкладки).
   */
  url?: string;
}
export interface DownloadBeginResult {
  jobId: number;
}
export interface DownloadCancelParams {
  jobId: number;
}
export interface DownloadStatusResult {
  /**
   * Эффективный каталог загрузок (настройка либо системный Downloads).
   */
  defaultDir: string;
  /**
   * deno.exe на месте (JS-runtime экстрактора YouTube).
   */
  denoReady: boolean;
  /**
   * ffmpeg.exe на месте (нужен качеству >360p, mp3, диапазонам).
   */
  ffmpegReady: boolean;
  /**
   * Живые и последние задания (свежие первыми).
   */
  jobs: DownloadJobInfo[];
  /**
   * yt-dlp.exe на месте (иначе докачается при первом video/audio).
   */
  ytdlpReady: boolean;
}
/**
 * Одно задание в download.status (панель показывает живые и последние).
 */
export interface DownloadJobInfo {
  error?: string | null;
  eta: string;
  jobId: number;
  /**
   * video | audio | subs.
   */
  mode: string;
  outPath?: string | null;
  /**
   * 0–100 (фазы без процентов — 0).
   */
  percent: number;
  /**
   * prepare | tools | download | convert | subs | done | error | canceled.
   */
  phase: string;
  speed: string;
}
/**
 * history.bookmark_add: добавить закладку (url — ключ; повторное добавление обновляет заголовок, пустой заголовок сохраняет прежний).
 */
export interface HistoryBookmarkAddParams {
  /**
   * Группа закладки (карточка duopulse-058): null — группа по умолчанию («Избранное»), id — выбранная в мини-меню звёздочки.
   */
  groupId?: number | null;
  title?: string;
  url: string;
}
/**
 * history.bookmark_list: закладки для страницы управления.
 */
export interface HistoryBookmarkListParams {
  /**
   * Фильтр групп (карточка duopulse-058): null — все; -1 — без группы; id — члены группы в её порядке сортировки.
   */
  groupId?: number | null;
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
  /**
   * Группы закладки (карточка duopulse-058; пусто — без группы). В файле профиля id — машины-источника (импорт мапит по имени).
   */
  groups?: BookmarkGroupRef[];
  title: string;
  url: string;
}
/**
 * Ссылка на группу в строке закладки: id + имя (для UI-меток и профиля).
 */
export interface BookmarkGroupRef {
  id: number;
  name: string;
}
/**
 * history.bookmark_move: переставить закладку внутри группы (drag&drop; позиция 0 = верх, за пределами списка — клампится).
 */
export interface HistoryBookmarkMoveParams {
  groupId: number;
  position: number;
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
 * history.group_add: создать группу (имя уникально).
 */
export interface HistoryGroupAddParams {
  name: string;
}
/**
 * Группа закладок для UI: имя, позиция в ряду групп, режим сортировки (manual | title | added), флаг «по умолчанию» и число закладок.
 */
export interface BookmarkGroupInfo {
  count: number;
  id: number;
  isDefault: boolean;
  name: string;
  position: number;
  /**
   * manual | title | added.
   */
  sortBy: string;
}
/**
 * history.group_list: группы с числом закладок.
 */
export interface HistoryGroupListResult {
  groups: BookmarkGroupInfo[];
}
/**
 * history.group_remove: удалить группу (закладки остаются; группа по умолчанию не удаляется).
 */
export interface HistoryGroupRemoveParams {
  id: number;
}
/**
 * history.group_rename: переименовать группу.
 */
export interface HistoryGroupRenameParams {
  id: number;
  name: string;
}
/**
 * history.group_set_sort: режим сортировки группы — manual | title | added.
 */
export interface HistoryGroupSetSortParams {
  id: number;
  /**
   * manual | title | added.
   */
  sortBy: string;
}
/**
 * history.group_toggle_bookmark: членство закладки в группе вкл/выкл (закладка может состоять в нескольких группах или ни в одной).
 */
export interface HistoryGroupToggleBookmarkParams {
  groupId: number;
  on: boolean;
  url: string;
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
  /**
   * Имена групп закладки «Имя · Имя» (карточка duopulse-058; только у подсказок-закладок, вне групп — null).
   */
  group?: string | null;
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
 * passwords.add: сохранить логин (upsert по origin+username).
 */
export interface PasswordAddParams {
  password: string;
  title?: string | null;
  /**
   * Адрес сайта (origin выводится на стороне Core).
   */
  url: string;
  username: string;
}
export interface PasswordSaveResult {
  id: number;
  /**
   * true — обновили существующую запись (тот же логин на том же сайте).
   */
  updated: boolean;
}
/**
 * Вид кандидата для UI (без пароля) — событие и passwords.candidate.
 */
export interface PasswordsCandidateView {
  origin: string;
  tabId: string;
  /**
   * true — логин уже сохранён, бар предлагает обновить пароль.
   */
  updated: boolean;
  username: string;
}
/**
 * passwords.list: записи с фильтром (по сайту/логину/названию).
 */
export interface PasswordListParams {
  limit?: number | null;
  query?: string | null;
}
export interface PasswordListResult {
  items: PasswordEntry[];
  total: number;
}
/**
 * Запись логина для списка (без пароля — reveal отдельно).
 */
export interface PasswordEntry {
  createdAt: number;
  id: number;
  /**
   * Схема+хост+порт (https://example.com) — ключ автозаполнения.
   */
  origin: string;
  /**
   * Название сайта/страницы.
   */
  title: string;
  updatedAt: number;
  /**
   * Полный адрес страницы входа (если известен).
   */
  url: string;
  username: string;
}
export interface PasswordRemoveParams {
  id: number;
}
/**
 * passwords.resolve_candidate (этап 2 duopulse-108): решение по бару «Сохранить пароль?» — save | never | dismiss.
 */
export interface PasswordsResolveParams {
  /**
   * save — сохранить/обновить, never — «никогда для этого сайта», dismiss — закрыть.
   */
  action: string;
}
export interface PasswordRevealParams {
  id: number;
}
export interface PasswordRevealResult {
  password: string;
}
/**
 * passwords.update: правка записи (переданные поля меняются).
 */
export interface PasswordUpdateParams {
  id: number;
  password?: string | null;
  title?: string | null;
  url?: string | null;
  username?: string | null;
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
 * settings.apply: частичный патч разделов (неназванные не меняются). Прокси-пароль и ключи API — только существующими командами (settings.set proxy / translate.set_settings: секреты идут в DPAPI, не в патче).
 */
export interface SettingsPatch {
  diagnostics?: DiagnosticsConfig | null;
  downloads?: DownloadConfig | null;
  privacy?: PrivacyConfig | null;
  search?: SearchConfig | null;
  subtitles?: SubtitlesConfig | null;
  updater?: UpdaterConfig | null;
}
/**
 * Раздел "diagnostics" settings.json (карточка duopulse-129): видимость диагностического бейджа M0 (content/m0-spike.js — слева внизу: инжекция, сетевой перехват, fps/дропы кадров). По умолчанию ВЫКЛЮЧЕН — раньше бейдж показывался всегда («окошко слева внизу при просмотре видео» — пожелание Артёма). Раздел после v3 — serde-умолчания, миграция не нужна.
 */
export interface DiagnosticsConfig {
  /**
   * Показывать диагностический бейдж M0 на страницах видео.
   */
  m0Badge?: boolean;
}
/**
 * Раздел "downloads" settings.json. Появился после v3 — сериализуется с serde-умолчаниями, миграция не нужна (отсутствие валидно).
 */
export interface DownloadConfig {
  /**
   * Каталог загрузок (None — системный Downloads).
   */
  dir?: string | null;
}
/**
 * Раздел "privacy" settings.json (задача 5.1).
 */
export interface PrivacyConfig {
  /**
   * Очищать историю посещений при выходе из браузера.
   */
  clearHistoryOnExit?: boolean;
}
/**
 * Раздел "search" settings.json.
 */
export interface SearchConfig {
  engine?: SearchEngine & string;
}
/**
 * Раздел "subtitles" settings.json — дефолты субтитров (задача 5.1): язык перевода дефолт-набора Alt+D («оригинал + <язык>») и стиль плашки для вкладок, где пользователь ещё не менял стиль вручную.
 */
export interface SubtitlesConfig {
  /**
   * Язык перевода дефолт-набора, код 2–3 буквы («ru»).
   */
  defaultTranslationLang?: string;
  style?: SubtitlesStyleDefaults;
}
/**
 * Стиль плашки для новых вкладок: значения — та же модель, что в content- оверлее (docs/03 §5); клампы при применении — в content-слое (mergeStyle). Цвета строк/плашки и обводка — карточка duopulse-059; serde(default) на контейнере: старые settings.json без новых полей читаются с дефолтами.
 */
export interface SubtitlesStyleDefaults {
  /**
   * Гарнитура плашки: Inter | JetBrains Mono | system (карточка 068).
   */
  fontFamily?: string;
  /**
   * Масштаб кегля, % (75–300).
   */
  fontScalePct?: number;
  /**
   * Отступ от края видео, % высоты (0–25).
   */
  marginPct?: number;
  /**
   * Цвет третьей и далее строк, hex #rrggbb.
   */
  mutedColor?: string;
  /**
   * Цвет строки оригинала, hex #rrggbb.
   */
  originalColor?: string;
  /**
   * Цвет подложки-плашки, hex #rrggbb.
   */
  plateColor?: string;
  /**
   * Непрозрачность подложки, 0.2–1.
   */
  plateOpacity?: number;
  /**
   * Позиция плашки: bottom|top.
   */
  position?: string;
  /**
   * Тёмная обводка строк для читаемости на светлом видео.
   */
  textStroke?: boolean;
  /**
   * Цвет строки перевода, hex #rrggbb.
   */
  translationColor?: string;
}
/**
 * Раздел "updater" settings.json (задача 5.2). Появился после v2 — сериализуется с serde-умолчаниями, миграция не нужна (отсутствие валидно).
 */
export interface UpdaterConfig {
  /**
   * Тихая автопроверка на старте (установка — всегда руками, из настроек).
   */
  autoCheck?: boolean;
  /**
   * Канал фида обновлений (stable/canary).
   */
  channel?: UpdateChannel & string;
  /**
   * Источник фида: GitHub Pages или зеркало Aila (duopulse-049).
   */
  source?: UpdateSource & string;
}
/**
 * settings.export: собрать профиль в файл (задача 5.1, DoD — переезд на чистую машину за 1 файл). path — абсолютный путь из нативного диалога сохранения (UI); include_secrets — явный выбор пользователя (UI предупреждает: пароль прокси и ключи API попадут в файл открытым текстом).
 */
export interface SettingsExportParams {
  includeSecrets: boolean;
  path: string;
}
export interface SettingsExportResult {
  bytes: number;
  /**
   * Что вошло в файл (разделы настроек, закладки, визиты, строки кэша, секреты) + размер файла.
   */
  counts: ProfileCounts;
}
/**
 * Числа отчёта экспорта/импорта (страница настроек показывает их пользователю).
 */
export interface ProfileCounts {
  /**
   * ASR-дорожки в файле/применённые (карточка duopulse-060; у старых файлов поля нет — 0).
   */
  asrTracks?: number;
  /**
   * Группы избранного в файле/применённые (карточка duopulse-058; у файлов старых версий поля нет — 0).
   */
  bookmarkGroups?: number;
  bookmarks?: number;
  /**
   * Секретов в файле/записано при импорте (0 — файл без секретов).
   */
  secrets?: number;
  /**
   * Разделы настроек, попавшие в файл/применённые из него.
   */
  settingsSections?: number;
  translatedTracks?: number;
  visits?: number;
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
 * settings.get_all: полный снапшот настроек для страницы «Настройки». Прокси (settings.get M1), перевод (translate.get_settings) и блокировщик (adblock.status) включены сюда же — страница показывает все разделы одной командой; их живые команды остаются (хром-панели).
 */
export interface SettingsAll {
  /**
   * Глобальный тумблер блокировщика (исключения сайтов — adblock.status).
   */
  adblockEnabled: boolean;
  appearance: AppearanceConfig;
  /**
   * Распознавание речи (карточка duopulse-060): движок/модель/ключ.
   */
  asr: AsrSettings;
  /**
   * Диагностика (карточка duopulse-129): бейдж M0 на страницах видео.
   */
  diagnostics: DiagnosticsConfig;
  /**
   * Загрузки (карточка duopulse-118): каталог видео/аудио/субтитров.
   */
  downloads: DownloadConfig;
  engines: SearchEngineInfo[];
  privacy: PrivacyConfig;
  proxy: ProxySettings;
  /**
   * Версия схемы settings.json (миграции — на старте Core).
   */
  schemaVersion: number;
  /**
   * Текущий поисковик omnibox + доступные.
   */
  search: SearchConfig;
  /**
   * Дефолты субтитров (язык перевода набора Alt+D, стиль новых вкладок).
   */
  subtitles: SubtitlesConfig;
  translate: TranslateSettings;
  /**
   * Автообновление (задача 5.2): канал и автопроверка.
   */
  updater: UpdaterConfig;
}
/**
 * Раздел "appearance" settings.json. v1 — только тёмная фирменная тема (docs/01 F-10, ROADMAP M5): светлая — за пределами карточки 5.1, значение фиксировано, селект страницы показывает её единственной активной опцией.
 */
export interface AppearanceConfig {
  theme?: Theme & string;
}
/**
 * Поисковик для селекта «Поиск» (id — значение настройки, title — подпись).
 */
export interface SearchEngineInfo {
  id: SearchEngine;
  title: string;
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
 * settings.import: применить файл профиля (path — нативный диалог выбора). Импорт идемпотентен (дубликаты визитов скипаются, закладки/кэш — upsert); переехавший прокси применяется роутером сразу — без перезапуска (задача 6.1; needs_restart зарезервировано и всегда false).
 */
export interface SettingsImportParams {
  path: string;
}
/**
 * Итог импорта: отчёт о применённом. Поле needs_restart зарезервировано (было «прокси применится со следующего старта»); с локальным роутером (задача 6.1, docs/02 §6.1) переехавший прокси применяется сразу — bridge::settings_import дёргает роутер после записи файла.
 */
export interface ImportOutcome {
  counts?: ProfileCounts;
  /**
   * Файл содержал секреты (применены в DPAPI).
   */
  hasSecrets?: boolean;
  /**
   * Зарезервировано; всегда false — перезапуск импорту не нужен.
   */
  needsRestart?: boolean;
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
   * Дорожка языка оригинала (детект — originalLangsOf контента: audioTracks[].original / .originalLanguage / asr-фолбэк).
   */
  original: boolean;
  /**
   * Платформа разрешает машинный перевод (tlang) этой дорожки.
   */
  translatable: boolean;
}
/**
 * Стиль плашки (docs/03 §6 SubtitleStyle): панель редактирует, оверлей применяет; здесь — последнее сообщённое значение. Цвета строк/плашки и обводка — карточка duopulse-059, гарнитура — duopulse-068.
 */
export interface SubtitlesStyleInfo {
  /**
   * Гарнитура плашки: Inter | JetBrains Mono | system (карточка 068; список — subtitles::fonts::FONT_FAMILY_VALUES, дефолт Inter).
   */
  fontFamily: string;
  /**
   * Масштаб кегля, %: 75–300 (docs/03 §5).
   */
  fontScalePct: number;
  /**
   * Отступ от края видео, % высоты.
   */
  marginPct: number;
  /**
   * Цвет третьей и далее строк, hex #rrggbb.
   */
  mutedColor: string;
  /**
   * Цвет строки оригинала, hex #rrggbb.
   */
  originalColor: string;
  /**
   * Цвет подложки-плашки, hex #rrggbb.
   */
  plateColor: string;
  /**
   * Непрозрачность подложки, 0–1 (гайд 06 §6).
   */
  plateOpacity: number;
  /**
   * bottom | top.
   */
  position: string;
  /**
   * Тёмная обводка строк (читаемость на светлом видео).
   */
  textStroke: boolean;
  /**
   * Цвет строки перевода, hex #rrggbb.
   */
  translationColor: string;
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
 * Частичный патч стиля плашки (docs/03 §6 SubtitleStyle): неназванные поля не меняются; клампы — в content-оверлее (mergeStyle, задача 3.4). Цвета строк/плашки и обводка — карточка duopulse-059 (hex #rrggbb / bool), гарнитура — duopulse-068 (Inter | JetBrains Mono | system).
 */
export interface SubtitlesStylePatch {
  fontFamily?: string | null;
  fontScalePct?: number | null;
  marginPct?: number | null;
  mutedColor?: string | null;
  originalColor?: string | null;
  plateColor?: string | null;
  plateOpacity?: number | null;
  position?: string | null;
  textStroke?: boolean | null;
  translationColor?: string | null;
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
   * Инкогнито-вкладка (карточка duopulse-096): изолированная среда, без истории и сессии — значок-шпион в таб-баре, подсказки истории в omnibox скрыты.
   */
  incognito: boolean;
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
 * tabs.open: открыть вкладку; без url — стартовая страница (до страницы «Новая вкладка» задачи 1.5). Новая вкладка становится активной. incognito (карточка duopulse-096) — приватная вкладка: без url стартует со страницы duopulse://incognito.
 */
export interface TabsOpenParams {
  incognito?: boolean;
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
 * translate.clear_cache (приватность, задача 5.1): очистить кэш переведённых дорожек (translated_tracks, duopulse.db).
 */
export interface TranslateClearCacheResult {
  /**
   * Удалено строк кэша.
   */
  cleared: number;
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
 * Итог проверки фида: что нашли (или почему не смогли посмотреть).
 */
export interface UpdaterCheckResult {
  /**
   * Есть пакет новее текущей версии.
   */
  available: boolean;
  /**
   * Время проверки, unix-мс.
   */
  checkedAtUnix: number;
  /**
   * Дата публикации пакета, unix-секунды (available=true).
   */
  dateUnix: number;
  /**
   * Отказ проверки (сеть/фид/подпись манифеста): available=false.
   */
  error?: string | null;
  /**
   * Заметки о релизу (available=true, фид указал).
   */
  notes?: string | null;
  /**
   * Источник, ответивший проверкой (github/aila, duopulse-049): выбранной базой или зеркалом-фолбэком; None — ответа не было (error).
   */
  source?: UpdateSource | null;
  /**
   * Версия найденного пакета (available=true).
   */
  version?: string | null;
}
/**
 * updater.status: состояние автообновления для страницы «Настройки».
 */
export interface UpdaterStatusResult {
  autoCheck: boolean;
  /**
   * Канал, источник и автопроверка — раздел "updater" настроек.
   */
  channel: UpdateChannel;
  /**
   * Версия работающего приложения (package_info).
   */
  currentVersion: string;
  /**
   * Последняя проверка (ручная или автопроверка старта).
   */
  lastCheck?: UpdaterCheckResult | null;
  /**
   * Обновление, найденное последней удачной проверкой (ждёт решения).
   */
  pending?: UpdateInfo | null;
  source: UpdateSource;
}
/**
 * Доступное обновление (найдено проверкой, ждёт решения пользователя).
 */
export interface UpdateInfo {
  /**
   * Дата публикации пакета, unix-секунды (0 — фид не указал).
   */
  dateUnix: number;
  /**
   * Заметки о релизе (notes/body манифеста).
   */
  notes?: string | null;
  /**
   * Версия пакета на фиде (semver, новее текущей).
   */
  version: string;
}
/**
 * vpn.add_rule: добавить/обновить правило (upsert по домену — повторно добавленный сайт меняет маршрут, а не плодит строки). В split-режиме действует на новые соединения сразу (общий стор с роутером).
 */
export interface VpnAddRuleParams {
  domain: string;
  /**
   * tunnel | direct.
   */
  route: string;
}
/**
 * Результат команд правил: режим + список (порядок добавления).
 */
export interface VpnRulesResult {
  /**
   * off | global | split.
   */
  mode: string;
  rules: VpnRuleInfo[];
}
/**
 * Строка списка правил (vpn.get_rules/add_rule/remove_rule).
 */
export interface VpnRuleInfo {
  /**
   * Unix-ms добавления.
   */
  addedAt: number;
  /**
   * Домен правила (суффикс по границе меток: example.com ловит и sub.example.com).
   */
  domain: string;
  /**
   * tunnel | direct.
   */
  route: string;
}
/**
 * vpn.import_profile: путь к `.conf` (нативный диалог выбора, UI — задача 6.5; e2e/диагностика — путь напрямую). Приватный ключ уходит в DPAPI, в wg-profiles.json — только открытые поля.
 */
export interface VpnImportProfileParams {
  path: string;
}
/**
 * Профиль WireGuard для списка UI (секретов нет).
 */
export interface VpnProfileInfo {
  /**
   * Активен сейчас (туннель поднят этим профилем).
   */
  active: boolean;
  address: string;
  dns?: string[];
  endpoint: string;
  id: string;
  keepalive?: number | null;
  name: string;
}
export interface VpnRemoveProfileParams {
  id: string;
}
export interface VpnRemoveRuleParams {
  domain: string;
}
/**
 * vpn.set_enabled: включить/выключить маршрутизацию через внешний прокси (инкремент A; в M6 — выбор маршрута локальным роутером, docs/02 §6). Включение с невалидным конфигом — ошибка, конфиг не меняется. Взаимно исключаем с туннелем WireGuard: vpn.use_profile при включении гасит прокси.
 */
export interface VpnSetEnabledParams {
  on: boolean;
}
/**
 * vpn.set_mode (задача 6.3, docs/02 §6.2): режим VPN. off — погасить туннель, весь трафик напрямую (маршрут возвращается к конфигу прокси); global — весь трафик через туннель (нужен активный профиль WireGuard); split — туннель только для правил «tunnel», YouTube и прочее — напрямую (F-12). Действует сразу, на новые соединения.
 */
export interface VpnSetModeParams {
  /**
   * off | global | split.
   */
  mode: string;
}
/**
 * vpn.status / vpn.test_connection / vpn.use_profile / vpn.set_mode: состояние маршрутизации. mode — фактический маршрут роутера: off | proxy | wg; routing — vpn-режим задачи 6.3 (off | global | split); при wg заполнено поле wg (живой снапшот туннеля, задача 6.2), иначе состояние прокси.
 */
export interface VpnStatusResult {
  detail: string;
  /**
   * off | proxy | wg.
   */
  mode: string;
  /**
   * off | global | split (docs/02 §6.2; с настройками прокси независим — routing описывает туннель, mode — фактический маршрут).
   */
  routing: string;
  /**
   * Словарь M1 (off/on/error) в рамках текущего mode.
   */
  state: ProxyState;
  wg?: VpnWgState | null;
}
/**
 * Живое состояние туннеля WireGuard (vpn/wg.rs).
 */
export interface VpnWgState {
  endpoint: string;
  /**
   * Сколько мс назад был последний handshake (null — не было).
   */
  lastHandshakeMs?: number | null;
  /**
   * RTT ICMP-эхом до DNS-сервера профиля через туннель, мс (задача 6.5; null — ответа нет дольше 3 с: сервер может не отвечать на ICMP, трафик при этом жив).
   */
  pingMs?: number | null;
  profileId: string;
  profileName: string;
  rxBytes: number;
  /**
   * Unix-ms запуска сессии.
   */
  sinceMs: number;
  /**
   * connecting | connected | error.
   */
  state: string;
  txBytes: number;
}
/**
 * vpn.use_profile: включить туннель с профилем (Some) или выключить (None). Включение мгновенно гасит режим прокси (маршруты взаимоисключимы до split-правил задачи 6.3) и поднимает роутер на Route::Wg; выключение возвращает маршрут по конфигу прокси (off/upstream). Повторное включение того же профиля — перезапуск туннеля (применение свежего импорта).
 */
export interface VpnUseProfileParams {
  id?: string | null;
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
 * download:finished — задание завершилось (успех/отмена/ошибка).
 */
export interface DownloadFinished {
  canceled: boolean;
  error?: string | null;
  jobId: number;
  /**
   * video | audio | subs.
   */
  mode: string;
  ok: boolean;
  path?: string | null;
}
/**
 * download:progress — живой прогресс задания.
 */
export interface DownloadProgress {
  eta: string;
  jobId: number;
  percent: number;
  /**
   * tools | download | convert | subs.
   */
  phase: string;
  speed: string;
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
 * passwords:save_prompt (этап 2 duopulse-108): сабмит формы логина в активной вкладке заслужил бар «Сохранить пароль?» — UI открывает панель pwsave под полосой хрома. Пароль в payload НЕТ — он ждёт решения в Core (passwords/prompts.rs), кнопки бара зовут passwords.resolve_candidate.
 */
export interface PasswordsSavePrompt {
  origin: string;
  tabId: string;
  /**
   * true — логин уже сохранён, бар спрашивает «Обновить пароль?».
   */
  updated: boolean;
  username: string;
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
export interface SubtitlesAsrProgress {
  done: number;
  /**
   * Движок конвейера: "local:whisper" / "openai:<model>".
   */
  engine: string;
  error?: string | null;
  /**
   * Дорожка отдана из кэша — сети не было.
   */
  fromCache: boolean;
  /**
   * model | audio | decode | transcribe | done | error.
   */
  phase: string;
  tabId: string;
  total: number;
  videoKey: string;
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
 * vpn:route_changed (задача 6.5, docs/05 §2): роутер решил маршрут домена — панель VPN видит, как режим и split-правила ложатся на живые соединения. Событие уходит при ПЕРВОМ решении домена и смене маршрута (дедуп в роутере); прямой off-режим решений не сообщает (весь трафик напрямую).
 */
export interface VpnRouteChanged {
  /**
   * Домен (или IP-литерал) соединения.
   */
  domain: string;
  /**
   * tunnel | direct | proxy.
   */
  route: string;
}
/**
 * vpn:state_changed: состояние маршрутизации изменилось (каркас с 1.1; реально эмитится с M6 — смена режима роутера и переходы туннеля WG connecting/connected/error, задача 6.2; kill-switch задачи 6.4 — Error «туннель мёртв» при обрыве upstream и Off «выключен» при остановке). Задача 6.5: переходы туннеля несут снапшот wg (профиль + rx/tx/ping) — панель VPN и индикатор-щит обновляются одним событием.
 */
export interface VpnStateChanged {
  detail: string;
  /**
   * off | proxy | wg.
   */
  mode: string;
  state: ProxyState;
  wg?: VpnWgState | null;
}
/**
 * vpn:stats (задача 6.5, docs/05 §2): живая статистика туннеля — rx/tx и ICMP-RTT до DNS-сервера туннеля; панель VPN и индикатор-щит ведут числа без опроса. Эмит — нитью туннеля не чаще раза в секунду и только при изменении (простой без трафика — молчание, панель держит последние числа).
 */
export interface VpnStats {
  /**
   * Сколько мс назад последний handshake (null — не было).
   */
  lastHandshakeMs?: number | null;
  /**
   * RTT ICMP-эхом, мс (null — ответа нет дольше 3 с; сервер может не отвечать на ICMP — трафик жив и без этого).
   */
  pingMs?: number | null;
  rxBytes: number;
  /**
   * connecting | connected | error — эпоха чисел (переходы — отдельным событием vpn:state_changed).
   */
  state: string;
  txBytes: number;
}
