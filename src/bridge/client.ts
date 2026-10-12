// Типизированный IPC-клиент bridge (задача 1.1, docs/05 §2).
// Единственный способ UI-слоя звать Core: словарь контракта «домен.действие»
// здесь отображается на snake_case-хендлеры tauri (поле "handler" в
// bridge/contract.json). Типы параметров/результатов — генерённые
// (./gen/types.ts), соответствие клиент ↔ контракт проверяет vitest.
import { invoke } from "@tauri-apps/api/core";
import type {
  BridgeVersionResult,
  NavNavigateParams,
  ProxySettings,
  SettingsGetParams,
  SettingsSetParams,
  TabsActivateParams,
  TabsCloseParams,
  TabsListResult,
  TabsOpenParams,
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
  },
  nav: {
    /** nav.navigate: переход активной вкладки по URL. */
    navigate: (params: NavNavigateParams) => invoke<void>("nav_navigate", { params }),
    goBack: () => invoke<void>("nav_go_back"),
    goForward: () => invoke<void>("nav_go_forward"),
    reload: () => invoke<void>("nav_reload"),
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
  } as const,
};
