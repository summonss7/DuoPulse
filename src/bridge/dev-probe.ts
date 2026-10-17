// e2e-хук: bridge-клиент в window.__duopulse — только в dev-сборке vite
// (import.meta.env.DEV), в прод-бандле отсутствует. Используется CDP-стендами
// (e2e/bridge/run.mjs, e2e/tabs/run.mjs) для сквозных проверок UI → Core → ответ.
// Журналы последних событий (Core → UI, тоже только dev):
//   __duopulseTabsEvents — tabs:updated (задача 1.2);
//   __duopulseAdblockEvents — adblock:blocked_count (задача 2.1);
//   __duopulseSubtitlesEvents — subtitles:tracks_ready/set_applied (задача 3.7).
import { listen } from "@tauri-apps/api/event";
import { bridge } from "./client";

if (import.meta.env.DEV) {
  (window as unknown as { __duopulse: typeof bridge }).__duopulse = bridge;
  const events: unknown[] = [];
  void listen("tabs:updated", (ev) => {
    events.push(ev.payload);
    if (events.length > 50) events.shift();
  });
  (window as unknown as { __duopulseTabsEvents: unknown[] }).__duopulseTabsEvents = events;

  const adblockEvents: unknown[] = [];
  void listen("adblock:blocked_count", (ev) => {
    adblockEvents.push(ev.payload);
    if (adblockEvents.length > 50) adblockEvents.shift();
  });
  (window as unknown as { __duopulseAdblockEvents: unknown[] }).__duopulseAdblockEvents =
    adblockEvents;

  const subtitlesEvents: unknown[] = [];
  void listen(bridge.events.subtitlesTracksReady, (ev) => {
    subtitlesEvents.push({ kind: "tracks_ready", payload: ev.payload });
    if (subtitlesEvents.length > 80) subtitlesEvents.shift();
  });
  void listen(bridge.events.subtitlesSetApplied, (ev) => {
    subtitlesEvents.push({ kind: "set_applied", payload: ev.payload });
    if (subtitlesEvents.length > 80) subtitlesEvents.shift();
  });
  (window as unknown as { __duopulseSubtitlesEvents: unknown[] }).__duopulseSubtitlesEvents =
    subtitlesEvents;
}
