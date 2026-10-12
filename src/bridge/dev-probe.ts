// e2e-хук: bridge-клиент в window.__duopulse — только в dev-сборке vite
// (import.meta.env.DEV), в прод-бандле отсутствует. Используется CDP-стендами
// (e2e/bridge/run.mjs, e2e/tabs/run.mjs) для сквозных проверок UI → Core → ответ.
// window.__duopulseTabsEvents — журнал последних событий tabs:updated
// (Core → UI, задача 1.2), тоже только в dev.
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
}
