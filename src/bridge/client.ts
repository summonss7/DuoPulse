// Типизированный IPC-клиент bridge (задача 1.1, docs/05 §2).
// Единственный способ UI-слоя звать Core: словарь контракта «домен.действие»
// здесь отображается на snake_case-хендлеры tauri (поле "handler" в
// bridge/contract.json). Типы параметров/результатов — генерённые
// (./gen/types.ts), соответствие клиент ↔ контракт проверяет vitest.
import { invoke } from "@tauri-apps/api/core";
import type {
  AdblockSetEnabledParams,
  AdblockStatusResult,
  AppBuildInfoResult,
  AdblockUpdateListsParams,
  AsrClearCacheResult,
  AsrPrepareResult,
  AsrSetSettingsParams,
  AsrSettings,
  AsrTestResult,
  BookmarkGroupInfo,
  BridgeVersionResult,
  HistoryBookmarkAddParams,
  HistoryBookmarkListParams,
  HistoryBookmarkListResult,
  HistoryBookmarkMoveParams,
  HistoryBookmarkRemoveParams,
  HistoryBookmarkUpdateParams,
  HistoryDeleteRangeParams,
  HistoryDeleteUrlsParams,
  HistoryGroupAddParams,
  HistoryGroupListResult,
  HistoryGroupRemoveParams,
  HistoryGroupRenameParams,
  HistoryGroupSetSortParams,
  HistoryGroupToggleBookmarkParams,
  HistoryListParams,
  HistoryListResult,
  HistorySearchParams,
  HistorySearchResult,
  HistoryVisitParams,
  ImportOutcome,
  NavNavigateParams,
  NavResolveOmniboxParams,
  NavResolveOmniboxResult,
  PasswordAddParams,
  PasswordListParams,
  PasswordListResult,
  PasswordRevealParams,
  PasswordRevealResult,
  PasswordRemoveParams,
  PasswordSaveResult,
  PasswordUpdateParams,
  PasswordsCandidateView,
  PasswordsResolveParams,
  PerfRunListResult,
  PerfSaveRunParams,
  PerfSnapshotResult,
  ProfileCounts,
  ProxySettings,
  SettingsAll,
  SettingsExportParams,
  SettingsExportResult,
  SettingsGetParams,
  SettingsImportParams,
  SettingsPatch,
  SettingsSetParams,
  SubtitlesLoadFileParams,
  SubtitlesLoadFileResult,
  SubtitlesRemoveTrackParams,
  SubtitlesSetEnabledParams,
  SubtitlesSetOffsetParams,
  SubtitlesSetStyleParams,
  SubtitlesSetTracksParams,
  SubtitlesTranslateTrackParams,
  TabSubtitles,
  TabsActivateParams,
  TabsCloseParams,
  TabsListResult,
  TabsOpenParams,
  TabsSleepParams,
  TabsWakeParams,
  TranslateSetSettingsParams,
  TranslateSettings,
  TranslateTestParams,
  TranslateTestResult,
  TranslateClearCacheResult,
  UpdaterCheckResult,
  UpdaterStatusResult,
  VpnAddRuleParams,
  VpnImportProfileParams,
  VpnProfileInfo,
  VpnRemoveProfileParams,
  VpnRemoveRuleParams,
  VpnRulesResult,
  VpnSetEnabledParams,
  VpnSetModeParams,
  VpnStatusResult,
  VpnUseProfileParams,
} from "./gen/types";

export const bridge = {
  bridge: {
    /** bridge.version: версия контракта живого приложения. */
    version: () => invoke<BridgeVersionResult>("bridge_version"),
  },
  tabs: {
    /** tabs.list: вкладки окна в порядке таб-бара. */
    list: () => invoke<TabsListResult>("tabs_list"),
    /** tabs.open: новая вкладка (без url — стартовая), становится активной. */
    open: (params: TabsOpenParams) => invoke<TabsListResult>("tabs_open", { params }),
    /** tabs.close: закрыть вкладку; активной станет соседняя. */
    close: (params: TabsCloseParams) => invoke<TabsListResult>("tabs_close", { params }),
    /** tabs.reopen: вернуть последнюю закрытую (Ctrl+Shift+T). */
    reopen: () => invoke<TabsListResult>("tabs_reopen"),
    /** tabs.activate: сделать вкладку активной (клик по вкладке). */
    activate: (params: TabsActivateParams) => invoke<TabsListResult>("tabs_activate", { params }),
    /** tabs.sleep: усыпить вкладку (авто-усыпление простаивающих — Core). */
    sleep: (params: TabsSleepParams) => invoke<TabsListResult>("tabs_sleep", { params }),
    /** tabs.wake: разбудить вкладку (активация и так будит — диагностика). */
    wake: (params: TabsWakeParams) => invoke<TabsListResult>("tabs_wake", { params }),
  },
  nav: {
    /** nav.navigate: переход активной вкладки по URL. */
    navigate: (params: NavNavigateParams) => invoke<void>("nav_navigate", { params }),
    /** nav.resolve_omnibox: разобрать ввод адресной строки (URL vs поиск). */
    resolveOmnibox: (params: NavResolveOmniboxParams) =>
      invoke<NavResolveOmniboxResult>("nav_resolve_omnibox", { params }),
    /** nav.focus_page: вернуть фокус контенту активной вкладки (Esc из omnibox). */
    focusPage: () => invoke<void>("nav_focus_page"),
    goBack: () => invoke<void>("nav_go_back"),
    goForward: () => invoke<void>("nav_go_forward"),
    reload: () => invoke<void>("nav_reload"),
  },
  history: {
    /** history.search: подсказки omnibox — FTS-поиск по истории и закладкам. */
    search: (params: HistorySearchParams) => invoke<HistorySearchResult>("history_search", { params }),
    /** history.visit: записать посещение (Core пишет визиты и сам). */
    visit: (params: HistoryVisitParams) => invoke<void>("history_visit", { params }),
    /** history.list: история для страницы управления (агрегат по URL). */
    list: (params: HistoryListParams) => invoke<HistoryListResult>("history_list", { params }),
    /** history.delete_urls: удалить записи истории по адресам. */
    deleteUrls: (params: HistoryDeleteUrlsParams) => invoke<void>("history_delete_urls", { params }),
    /** history.delete_range: удалить историю за диапазон времени (unix-ms). */
    deleteRange: (params: HistoryDeleteRangeParams) => invoke<void>("history_delete_range", { params }),
    /** history.bookmark_add: добавить закладку (upsert по url); groupId —
     *  группа (null — «Избранное» по умолчанию), карточка duopulse-058. */
    bookmarkAdd: (params: HistoryBookmarkAddParams) => invoke<void>("history_bookmark_add", { params }),
    /** history.bookmark_remove: удалить закладку (идемпотентна). */
    bookmarkRemove: (params: HistoryBookmarkRemoveParams) => invoke<void>("history_bookmark_remove", { params }),
    /** history.bookmark_update: переименовать закладку. */
    bookmarkUpdate: (params: HistoryBookmarkUpdateParams) => invoke<void>("history_bookmark_update", { params }),
    /** history.bookmark_list: закладки (groupId: null — все, -1 — без группы,
     *  id — члены группы в её порядке сортировки; карточка duopulse-058). */
    bookmarkList: (params: HistoryBookmarkListParams) => invoke<HistoryBookmarkListResult>("history_bookmark_list", { params }),
    /** history.group_list (duopulse-058): группы избранного с числом закладок. */
    groupList: () => invoke<HistoryGroupListResult>("history_group_list"),
    /** history.group_add (duopulse-058): создать группу (имя уникально). */
    groupAdd: (params: HistoryGroupAddParams) => invoke<BookmarkGroupInfo>("history_group_add", { params }),
    /** history.group_rename (duopulse-058): переименовать группу. */
    groupRename: (params: HistoryGroupRenameParams) => invoke<void>("history_group_rename", { params }),
    /** history.group_remove (duopulse-058): удалить группу (закладки остаются;
     *  группа по умолчанию не удаляется). */
    groupRemove: (params: HistoryGroupRemoveParams) => invoke<void>("history_group_remove", { params }),
    /** history.group_set_sort (duopulse-058): сортировка группы —
     *  manual (drag&drop) | title | added. */
    groupSetSort: (params: HistoryGroupSetSortParams) => invoke<void>("history_group_set_sort", { params }),
    /** history.group_toggle_bookmark (duopulse-058): членство закладки в
     *  группе вкл/выкл (закладка может быть в нескольких группах или ни в одной). */
    groupToggleBookmark: (params: HistoryGroupToggleBookmarkParams) =>
      invoke<void>("history_group_toggle_bookmark", { params }),
    /** history.bookmark_move (duopulse-058): переставить закладку внутри
     *  группы (drag&drop; позиция 0 = верх). */
    bookmarkMove: (params: HistoryBookmarkMoveParams) => invoke<void>("history_bookmark_move", { params }),
  },
  passwords: {
    /** passwords.list (duopulse-107): записи менеджера паролей без самих
     *  паролей; фильтр по сайту/логину/названию. */
    list: (params: PasswordListParams) => invoke<PasswordListResult>("passwords_list", { params }),
    /** passwords.add (duopulse-107): сохранить логин (upsert по
     *  origin+username — повторное сохранение обновляет пароль). */
    add: (params: PasswordAddParams) => invoke<PasswordSaveResult>("passwords_add", { params }),
    /** passwords.update (duopulse-107): правка записи (переданные поля). */
    update: (params: PasswordUpdateParams) => invoke<void>("passwords_update", { params }),
    /** passwords.remove (duopulse-107): удалить запись (идемпотентна). */
    remove: (params: PasswordRemoveParams) => invoke<void>("passwords_remove", { params }),
    /** passwords.reveal (duopulse-107): расшифровать пароль записи. */
    reveal: (params: PasswordRevealParams) => invoke<PasswordRevealResult>("passwords_reveal", { params }),
    /** passwords.candidate (duopulse-108): ожидающий кандидат бара
     *  «Сохранить пароль?» — без пароля (null — бара нет). */
    candidate: () => invoke<PasswordsCandidateView | null>("passwords_candidate"),
    /** passwords.resolve_candidate (duopulse-108): решение по бару —
     *  save (upsert в хранилище) | never (denylist) | dismiss. */
    resolveCandidate: (params: PasswordsResolveParams) =>
      invoke<void>("passwords_resolve_candidate", { params }),
  },
  settings: {
    /** settings.get: значение ключа профиля. */
    get: (params: SettingsGetParams) => invoke<ProxySettings>("settings_get", { params }),
    /** settings.set: сохранить ключ; secret — секрет ключа в DPAPI. */
    set: (params: SettingsSetParams) => invoke<void>("settings_set", { params }),
    /** settings.get_all (задача 5.1): снапшот всех разделов для страницы
     * «Настройки» (внешний вид, поиск, субтитры, приватность, прокси,
     * блокировщик, перевод). */
    getAll: () => invoke<SettingsAll>("settings_get_all"),
    /** settings.apply (задача 5.1): записать названные разделы (search/
     * subtitles/privacy); неназванные не меняются. */
    apply: (params: SettingsPatch) => invoke<void>("settings_apply", { params }),
    /** settings.export (задача 5.1): профиль одним файлом — настройки,
     * закладки, история, кэш переводов; includeSecrets — секреты открытым
     * текстом (UI предупреждает). path — нативный диалог сохранения. */
    export: (params: SettingsExportParams) =>
      invoke<SettingsExportResult>("settings_export", { params }),
    /** settings.import (задача 5.1): применить файл профиля (идемпотентен;
     * переехавший прокси применяется роутером сразу — задача 6.1). */
    import: (params: SettingsImportParams) => invoke<ImportOutcome>("settings_import", { params }),
  },
  vpn: {
    /** vpn.set_enabled: включить/выключить маршрутизацию (внешний прокси). */
    setEnabled: (params: VpnSetEnabledParams) => invoke<void>("vpn_set_enabled", { params }),
    /** vpn.status: состояние маршрутизации (mode off/proxy/wg + снапшот туннеля). */
    status: () => invoke<VpnStatusResult>("vpn_status"),
    /** vpn.test_connection: явная проверка соединения (кнопка «Проверить»);
     * wg-режим — живая проба через туннель. */
    testConnection: () => invoke<VpnStatusResult>("vpn_test_connection"),
    /** vpn.import_profile (задача 6.2): `.conf` с диска → профиль (ключи в DPAPI). */
    importProfile: (params: VpnImportProfileParams) => invoke<VpnProfileInfo>("vpn_import_profile", { params }),
    /** vpn.list_profiles (задача 6.2): профили WireGuard (секретов нет). */
    listProfiles: () => invoke<VpnProfileInfo[]>("vpn_list_profiles"),
    /** vpn.remove_profile (задача 6.2): удалить профиль и секрет. */
    removeProfile: (params: VpnRemoveProfileParams) => invoke<void>("vpn_remove_profile", { params }),
    /** vpn.use_profile (задача 6.2): включить туннель (id) или выключить (null). */
    useProfile: (params: VpnUseProfileParams) => invoke<VpnStatusResult>("vpn_use_profile", { params }),
    /** vpn.set_mode (задача 6.3): режим VPN — off | global | split; действует
     *  сразу, на новые соединения (split — правила «tunnel» через туннель,
     *  остальное напрямую). */
    setMode: (params: VpnSetModeParams) => invoke<VpnStatusResult>("vpn_set_mode", { params }),
    /** vpn.get_rules (задача 6.3): режим + список split-правил. */
    getRules: () => invoke<VpnRulesResult>("vpn_get_rules"),
    /** vpn.add_rule (задача 6.3): добавить/обновить правило домен → tunnel|direct
     *  (upsert; в split действует на новые соединения сразу). */
    addRule: (params: VpnAddRuleParams) => invoke<VpnRulesResult>("vpn_add_rule", { params }),
    /** vpn.remove_rule (задача 6.3): удалить правило по домену. */
    removeRule: (params: VpnRemoveRuleParams) => invoke<VpnRulesResult>("vpn_remove_rule", { params }),
  },
  adblock: {
    /** adblock.set_enabled: глобальный тумблер (site=null) или исключение сайта. */
    setEnabled: (params: AdblockSetEnabledParams) =>
      invoke<AdblockStatusResult>("adblock_set_enabled", { params }),
    /** adblock.status: снапшот состояния блокировщика (счётчик, списки). */
    status: () => invoke<AdblockStatusResult>("adblock_status"),
    /** adblock.update_lists: фоновое обновление списков (force — даже свежих). */
    updateLists: (params: AdblockUpdateListsParams) =>
      invoke<AdblockStatusResult>("adblock_update_lists", { params }),
  },
  perf: {
    /** perf.snapshot: живой срез сеанса — старт, вкладки, RAM, блокировщик. */
    snapshot: () => invoke<PerfSnapshotResult>("perf_snapshot"),
    /** perf.save_run: сохранить прогон в историю (последние 10). */
    saveRun: (params: PerfSaveRunParams) => invoke<void>("perf_save_run", { params }),
    /** perf.list_runs: прогоны истории для графика, новые → старые. */
    listRuns: () => invoke<PerfRunListResult>("perf_list_runs"),
  },
  subtitles: {
    /** subtitles.set_offset: сдвиг субтитров активной вкладки (±10 с, шаг 100 мс,
     *  docs/03 §4) — применяется без перезагрузки дорожек. */
    setOffset: (params: SubtitlesSetOffsetParams) => invoke<void>("subtitles_set_offset", { params }),
    /** subtitles.load_file: ручной файл .srt/.vtt с диска (задача 3.6):
     *  чтение и разбор в Core, cue доставляются в активную вкладку. */
    loadFile: (params: SubtitlesLoadFileParams) =>
      invoke<SubtitlesLoadFileResult>("subtitles_load_file", { params }),
    /** subtitles.list_tracks: снапшот субтитров активной вкладки (задача 3.7):
     *  видео, показ, применённый набор, список дорожек адаптера, сдвиг, стиль. */
    listTracks: () => invoke<TabSubtitles>("subtitles_list_tracks"),
    /** subtitles.set_tracks: применить платформенную часть набора (порядок id =
     *  порядок строк; тот же состав в другом порядке — перестановка). */
    setTracks: (params: SubtitlesSetTracksParams) =>
      invoke<void>("subtitles_set_tracks", { params }),
    /** subtitles.set_enabled: включить/выключить показ набора (состав помнят
     *  обе стороны — docs/03 §8 п.2). */
    setEnabled: (params: SubtitlesSetEnabledParams) =>
      invoke<void>("subtitles_set_enabled", { params }),
    /** subtitles.toggle: переключить показ (Alt+D из хрома; на пустом наборе
     *  включение собирает дефолт «оригинал + ru» в content-слое). */
    toggle: () => invoke<void>("subtitles_toggle"),
    /** subtitles.set_style: стиль плашки активной вкладки (патч, клампы в оверлее). */
    setStyle: (params: SubtitlesSetStyleParams) => invoke<void>("subtitles_set_style", { params }),
    /** subtitles.remove_track: снять дорожку из набора (остальные без перезагрузки). */
    removeTrack: (params: SubtitlesRemoveTrackParams) =>
      invoke<void>("subtitles_remove_track", { params }),
    /** subtitles.translate_track (задача 4.2): запустить облачный перевод
     *  дорожки набора (источник — trackId или первая непереводная строка);
     *  прогресс/итог — событие subtitles:translate_progress. */
    translateTrack: (params: SubtitlesTranslateTrackParams) =>
      invoke<void>("subtitles_translate_track", { params }),
    /** subtitles.asr_start (карточка duopulse-060): распознать речь видео
     *  активной вкладки — дорожка asr:<lang> для видео без дорожек платформы;
     *  прогресс/итог — событие subtitles:asr_progress. */
    asrStart: () => invoke<void>("subtitles_asr_start"),
    /** subtitles.asr_cancel: отменить распознавание активной вкладки. */
    asrCancel: () => invoke<void>("subtitles_asr_cancel"),
  },
  asr: {
    /** asr.get_settings: конфиг ASR + наличие ключа/движка/модели. */
    getSettings: () => invoke<AsrSettings>("asr_get_settings"),
    /** asr.set_settings: сохранить конфиг; secret — ключ облака в DPAPI
     *  (undefined — не менять, "" — удалить). */
    setSettings: (params: AsrSetSettingsParams) => invoke<void>("asr_set_settings", { params }),
    /** asr.test: живая проверка выбранного движка (кнопка «Проверить»). */
    test: () => invoke<AsrTestResult>("asr_test"),
    /** asr.prepare: скачать движок whisper-server и модель в профиль. */
    prepare: () => invoke<AsrPrepareResult>("asr_prepare"),
    /** asr.clear_cache (приватность): очистить кэш ASR-дорожек. */
    clearCache: () => invoke<AsrClearCacheResult>("asr_clear_cache"),
  },
  translate: {
    /** translate.get_settings: конфиг перевода + наличие ключей в DPAPI (4.1). */
    getSettings: () => invoke<TranslateSettings>("translate_get_settings"),
    /** translate.set_settings: сохранить конфиг; secret — ключ выбранного
     *  провайдера в DPAPI (undefined — не менять, "" — удалить). */
    setSettings: (params: TranslateSetSettingsParams) =>
      invoke<void>("translate_set_settings", { params }),
    /** translate.test: живая проверка выбранного провайдера — перевод
     *  короткой фразы (кнопка «Проверить» панели «Перевод»). */
    test: (params: TranslateTestParams) => invoke<TranslateTestResult>("translate_test", { params }),
    /** translate.clear_cache (задача 5.1, приватность): очистить кэш
     *  переведённых дорожек — повторные просмотры снова в провайдер. */
    clearCache: () => invoke<TranslateClearCacheResult>("translate_clear_cache"),
  },
  updater: {
    /** updater.status (задача 5.2): текущая версия, канал/автопроверка,
     *  последняя проверка и ожидающее обновление. */
    status: () => invoke<UpdaterStatusResult>("updater_status"),
    /** updater.check (задача 5.2): проверить фид канала из настроек;
     *  отказ — в поле error результата. */
    check: () => invoke<UpdaterCheckResult>("updater_check"),
    /** updater.install (задача 5.2): скачать подписанный пакет последней
     *  проверки и установить; Windows: приложение перезапускает установщик —
     *  обещание команды при успехе не разрешается. */
    install: () => invoke<void>("updater_install"),
  },
  app: {
    /** app.restart: перезапуск (применение аргументов прокси WebView2). */
    restart: () => invoke<void>("app_restart"),
    /** app.build_info (duopulse-074): версия + unix-момент сборки — бейдж
     *  «vX.Y.Z · дата» в шапке и строка версии в настройках. */
    buildInfo: () => invoke<AppBuildInfoResult>("app_build_info"),
  },
  /** Имена событий контракта (Core → UI) для @tauri-apps/api/event.listen. */
  events: {
    /** tabs.updated: снапшот списка вкладок после любого изменения. */
    tabsUpdated: "tabs:updated",
    /** page.loaded: документ загружен (эмит — с M3, каркас с 1.1). */
    pageLoaded: "page:loaded",
    /** page.video_detected: на странице найден <video> (M3; каркас с 1.1). */
    pageVideoDetected: "page:video_detected",
    /** vpn.state_changed: состояние маршрутизации изменилось (M6; переходы
     *  туннеля несут снапшот wg — задача 6.5). */
    vpnStateChanged: "vpn:state_changed",
    /** vpn.stats (задача 6.5): живая статистика туннеля — rx/tx и ICMP-RTT;
     *  эмит не чаще раза в секунду и только при изменении. */
    vpnStats: "vpn:stats",
    /** vpn.route_changed (задача 6.5): роутер решил маршрут домена
     *  (tunnel|direct|proxy) — первый раз и при смене; off-режим молчит. */
    vpnRouteChanged: "vpn:route_changed",
    /** adblock.blocked_count: прирост блокировок (батчинг ~400 мс, задача 2.1). */
    adblockBlockedCount: "adblock:blocked_count",
    /** adblock.site_exception_changed: исключение сайта включено/снято (2.1). */
    adblockSiteExceptionChanged: "adblock:site_exception_changed",
    /** perf.startup_ms: итог старта main → Ready (задача 2.5). */
    perfStartupMs: "perf:startup_ms",
    /** perf.tab_switch_ms: переключение активной вкладки (задача 2.5). */
    perfTabSwitchMs: "perf:tab_switch_ms",
    /** subtitles.tracks_ready: адаптер вкладки выдал список дорожек (3.7). */
    subtitlesTracksReady: "subtitles:tracks_ready",
    /** subtitles.set_applied: состояние показа вкладки изменилось (3.7):
     *  кнопка «duo» и панель обновляются событием. */
    subtitlesSetApplied: "subtitles:set_applied",
    /** subtitles.translate_progress: конвейер облачного перевода дорожки
     *  (4.2): «Перевод… 12/40», итог (кэш/сеть) и ошибки. */
    subtitlesTranslateProgress: "subtitles:translate_progress",
    /** subtitles.translate_unavailable: бейдж «перевод недоступен» (4.3,
     *  docs/01 §5.4): офлайн или нет провайдера; willRetry — Core повторит
     *  сам при появлении сети. */
    subtitlesTranslateUnavailable: "subtitles:translate_unavailable",
    /** subtitles.asr_progress (карточка duopulse-060): конвейер
     *  распознавания речи — фазы model/audio/decode/transcribe/done/error. */
    subtitlesAsrProgress: "subtitles:asr_progress",
    /** updater.check_done (duopulse-067): итог проверки фида (автопроверка
     *  старта и ручные) — бейдж найденного обновления на «⋮» зажигается/
     *  гаснет по нему (available=false — «последняя версия» или отказ). */
    updaterCheckDone: "updater:check_done",
    /** passwords.save_prompt (duopulse-108): сабмит формы логина в активной
     *  вкладке заслужил бар «Сохранить пароль?» (payload без пароля). */
    passwordsSavePrompt: "passwords:save_prompt",
  } as const,
};
