// GENERATED FILE — НЕ ПРАВИТЬ РУКАМИ.
// Источник: src-tauri/src/bridge.rs → bridge/contract.json (версия контракта 1); регенерация: npm run gen:bridge.

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
  BridgeVersionResult: BridgeVersionResult;
  NavNavigateParams: NavNavigateParams;
  SettingsGetParams: SettingsGetParams;
  SettingsKey: SettingsKey;
  ProxySettings: ProxySettings;
  ProxyProto: ProxyProto;
  SettingsSetParams: SettingsSetParams;
  ProxyConfig: ProxyConfig;
  TabsListResult: TabsListResult;
  TabInfo: TabInfo;
  VpnSetEnabledParams: VpnSetEnabledParams;
  VpnStatusResult: VpnStatusResult;
  ProxyState: ProxyState;
  PageLoaded: PageLoaded;
  PageVideoDetected: PageVideoDetected;
  VpnStateChanged: VpnStateChanged;
}
/**
 * bridge.version: версия контракта живого приложения (диагностика, e2e).
 */
export interface BridgeVersionResult {
  version: number;
}
/**
 * nav.navigate: переход активной вкладки по URL.
 */
export interface NavNavigateParams {
  url: string;
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
 * tabs.list: вкладки окна. M1: единственная контентная вкладка "content".
 */
export interface TabsListResult {
  tabs: TabInfo[];
}
export interface TabInfo {
  /**
   * Активна ли вкладка (в M1 единственная — всегда true).
   */
  active: boolean;
  /**
   * Идентификатор webview-вкладки.
   */
  id: string;
  /**
   * Заголовок страницы (заполнится в задаче 1.2 — таб-бар).
   */
  title?: string | null;
  /**
   * Текущий URL вкладки.
   */
  url: string;
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
 * page.loaded: документ загружен (M3 — детектор контента; каркас с 1.1).
 */
export interface PageLoaded {
  url: string;
}
/**
 * page.video_detected: на странице найден <video> (M3; каркас с 1.1).
 */
export interface PageVideoDetected {
  canTracks: boolean;
  videoKey: string;
}
/**
 * vpn.state_changed: состояние маршрутизации изменилось (каркас с 1.1; начнёт эмититься с локальным роутером M6, docs/02 §6).
 */
export interface VpnStateChanged {
  detail: string;
  state: ProxyState;
}
