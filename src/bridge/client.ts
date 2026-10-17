// Типизированный IPC-клиент bridge (задача 1.1, docs/05 §2).
// Единственный способ UI-слоя звать Core: словарь контракта «домен.действие»
// здесь отображается на snake_case-хендлеры tauri (поле "handler" в
// bridge/contract.json). Типы параметров/результатов — генерённые
// (./gen/types.ts), соответствие клиент ↔ контракт проверяет vitest.
import { invoke } from "@tauri-apps/api/core";
import type {
  AdblockSetEnabledParams,
  AdblockStatusResult,
  AdblockUpdateListsParams,
  BridgeVersionResult,
  HistoryBookmarkAddParams,
  HistoryBookmarkListParams,
  HistoryBookmarkListResult,
  HistoryBookmarkRemoveParams,
  HistoryBookmarkUpdateParams,
  HistoryDeleteRangeParams,
  HistoryDeleteUrlsParams,
  HistoryListParams,
  HistoryListResult,
  HistorySearchParams,
  HistorySearchResult,
  HistoryVisitParams,
  NavNavigateParams,
  NavResolveOmniboxParams,
  NavResolveOmniboxResult,
  PerfRunListResult,
  PerfSaveRunParams,
  PerfSnapshotResult,
  ProxySettings,
  SettingsGetParams,
  SettingsSetParams,
  SubtitlesSetOffsetParams,
  TabsActivateParams,
  TabsCloseParams,
  TabsListResult,
  TabsOpenParams,
  TabsSleepParams,
  TabsWakeParams,
  VpnSetEnabledParams,
  VpnStatusResult,
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
    /** history.bookmark_add: добавить закладку (upsert по url). */
    bookmarkAdd: (params: HistoryBookmarkAddParams) => invoke<void>("history_bookmark_add", { params }),
    /** history.bookmark_remove: удалить закладку (идемпотентна). */
    bookmarkRemove: (params: HistoryBookmarkRemoveParams) => invoke<void>("history_bookmark_remove", { params }),
    /** history.bookmark_update: переименовать закладку. */
    bookmarkUpdate: (params: HistoryBookmarkUpdateParams) => invoke<void>("history_bookmark_update", { params }),
    /** history.bookmark_list: закладки для страницы управления. */
    bookmarkList: (params: HistoryBookmarkListParams) => invoke<HistoryBookmarkListResult>("history_bookmark_list", { params }),
  },
  settings: {
    /** settings.get: значение ключа профиля. */
    get: (params: SettingsGetParams) => invoke<ProxySettings>("settings_get", { params }),
    /** settings.set: сохранить ключ; secret — секрет ключа в DPAPI. */
    set: (params: SettingsSetParams) => invoke<void>("settings_set", { params }),
  },
  vpn: {
    /** vpn.set_enabled: включить/выключить маршрутизацию (внешний прокси). */
    setEnabled: (params: VpnSetEnabledParams) => invoke<void>("vpn_set_enabled", { params }),
    /** vpn.status: состояние маршрутизации (с проверкой достижимости). */
    status: () => invoke<VpnStatusResult>("vpn_status"),
    /** vpn.test_connection: явная проверка соединения (кнопка «Проверить»). */
    testConnection: () => invoke<VpnStatusResult>("vpn_test_connection"),
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
  },
  app: {
    /** app.restart: перезапуск (применение аргументов прокси WebView2). */
    restart: () => invoke<void>("app_restart"),
  },
  /** Имена событий контракта (Core → UI) для @tauri-apps/api/event.listen. */
  events: {
    /** tabs.updated: снапшот списка вкладок после любого изменения. */
    tabsUpdated: "tabs:updated",
    /** page.loaded: документ загружен (эмит — с M3, каркас с 1.1). */
    pageLoaded: "page:loaded",
    /** page.video_detected: на странице найден <video> (M3; каркас с 1.1). */
    pageVideoDetected: "page:video_detected",
    /** vpn.state_changed: состояние маршрутизации изменилось (M6; каркас). */
    vpnStateChanged: "vpn:state_changed",
    /** adblock.blocked_count: прирост блокировок (батчинг ~400 мс, задача 2.1). */
    adblockBlockedCount: "adblock:blocked_count",
    /** adblock.site_exception_changed: исключение сайта включено/снято (2.1). */
    adblockSiteExceptionChanged: "adblock:site_exception_changed",
    /** perf.startup_ms: итог старта main → Ready (задача 2.5). */
    perfStartupMs: "perf:startup_ms",
    /** perf.tab_switch_ms: переключение активной вкладки (задача 2.5). */
    perfTabSwitchMs: "perf:tab_switch_ms",
  } as const,
};
