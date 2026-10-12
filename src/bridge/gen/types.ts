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
  BridgeVersionResult: BridgeVersionResult;
  HistorySearchParams: HistorySearchParams;
  HistorySearchResult: HistorySearchResult;
  HistoryHit: HistoryHit;
  HistorySource: HistorySource;
  NavNavigateParams: NavNavigateParams;
  NavResolveOmniboxParams: NavResolveOmniboxParams;
  NavResolveOmniboxResult: NavResolveOmniboxResult;
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
 * history.search: подсказки omnibox — полнотекстовый поиск по истории и закладкам (FTS5, задача 1.3; хранилище — src/history/, пока временные данные, полная интеграция — задача 1.4).
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
 * vpn:state_changed: состояние маршрутизации изменилось (каркас с 1.1; начнёт эмититься с локальным роутером M6, docs/02 §6).
 */
export interface VpnStateChanged {
  detail: string;
  state: ProxyState;
}
