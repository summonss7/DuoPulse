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
  TabsListResult,
  VpnSetEnabledParams,
  VpnStatusResult,
} from "./gen/types";

export const bridge = {
  bridge: {
    /** bridge.version: версия контракта живого приложения. */
    version: () => invoke<BridgeVersionResult>("bridge_version"),
  },
  tabs: {
    /** tabs.list: вкладки окна (M1: единственная — "content"). */
    list: () => invoke<TabsListResult>("tabs_list"),
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
};
