// e2e-хук: bridge-клиент в window.__duopulse — только в dev-сборке vite
// (import.meta.env.DEV), в прод-бандле отсутствует. Используется CDP-стендами
// (e2e/bridge/run.mjs) для сквозных проверок UI → Core → ответ.
import { bridge } from "./client";

if (import.meta.env.DEV) {
  (window as unknown as { __duopulse: typeof bridge }).__duopulse = bridge;
}
