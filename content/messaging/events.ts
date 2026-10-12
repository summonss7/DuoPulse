// Контракт событий Core → Content-слой (docs/05 §1: content/messaging — канал
// до Core). Имена и payload — из IPC-контракта bridge (генерённые типы
// ../../src/bridge/gen/types.ts, источник — src-tauri/src/bridge.rs).
// Подписка/канал появятся с content-бандлом M3 (docs/05 §3, задача 3.2);
// до этого файл фиксирует словарь событий для content-разработки.
import type {
  PageLoaded,
  PageVideoDetected,
  VpnStateChanged,
} from "../../src/bridge/gen/types";

/** Имена событий контракта (Core → UI|Content). */
export const BRIDGE_EVENT_NAMES = {
  pageLoaded: "page.loaded",
  pageVideoDetected: "page.video_detected",
  vpnStateChanged: "vpn.state_changed",
} as const;

/** payload по имени события. */
export type BridgeEventPayloads = {
  [BRIDGE_EVENT_NAMES.pageLoaded]: PageLoaded;
  [BRIDGE_EVENT_NAMES.pageVideoDetected]: PageVideoDetected;
  [BRIDGE_EVENT_NAMES.vpnStateChanged]: VpnStateChanged;
};
