// DuoPulse — главное меню браузера (задача 1.5; docs/05 §1 src/chrome/MainMenu).
// Кнопка «⋮» в навбаре; пункты — быстрые действия поверх контракта bridge:
// новая вкладка, переоткрытие закрытой, внутренняя страница истории, прокси.
// Задача 2.1: секция блокировщика — тумблер (adblock.set_enabled), живой
// счётчик (событие adblock:blocked_count), «Отключить на этом сайте»
// (white-list активной вкладки) и «Обновить списки» (adblock.update_lists).
// Стиль — единый с контекст-меню вкладки (панель 12px, elevated, гайд 06 §5);
// открытие закрывает прочие панели хрома (меню вкладки/прокси).
// Карточка duopulse-067: точка на «⋮» о найденном обновлении (событие
// updater:check_done; логика — update-badge.ts).
import { listen } from "@tauri-apps/api/event";
import { bridge } from "../bridge";
import type { AdblockBlockedCount, AdblockStatusResult, UpdaterCheckResult } from "../bridge/gen/types";
import { updateBadgeState, updateBadgeTitle } from "./update-badge";

const err = (e: unknown): void => console.error("mainmenu:", e);
const btn = document.getElementById("mainBtn") as HTMLButtonElement;
const menu = document.getElementById("mainMenu") as HTMLDivElement;
const updateDot = document.getElementById("updateDot") as HTMLElement | null;
const adblockToggle = document.getElementById("adblockEnabled") as HTMLInputElement;
const adblockMeta = document.getElementById("adblockMeta") as HTMLDivElement;
const adblockSiteBtn = document.getElementById("adblockSite") as HTMLButtonElement;
const adblockUpdateBtn = document.getElementById("adblockUpdate") as HTMLButtonElement;

/** Прочие всплывающие панели хрома (открытие одного закрывает остальные). */
function closeOtherPanels(): void {
  (document.getElementById("tabMenu") as HTMLElement).hidden = true;
  (document.getElementById("proxyMenu") as HTMLElement).hidden = true;
  (document.getElementById("duoPanel") as HTMLElement).hidden = true;
  (document.getElementById("vpnPanel") as HTMLElement).hidden = true;
}

btn.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = menu.hidden;
  if (open) {
    closeOtherPanels();
    void refreshAdblock().catch(err);
  }
  menu.hidden = !open;
});

// закрытие кликом мимо / Escape — как у меню вкладки (tabbar.ts)
window.addEventListener(
  "mousedown",
  (e) => {
    if (!menu.hidden && !(e.target as HTMLElement).closest("#mainMenu, #mainBtn")) menu.hidden = true;
  },
  true
);
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !menu.hidden) menu.hidden = true;
});

menu.addEventListener("click", (e) => {
  const item = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
  if (!item) return;
  menu.hidden = true;
  switch (item.dataset.act) {
    case "newtab":
      void bridge.tabs.open({}).catch(err);
      break;
    case "reopen":
      void bridge.tabs.reopen().catch(err);
      break;
    case "history":
      void bridge.tabs.open({ url: "duopulse://history" }).catch(err);
      break;
    case "diagnostics":
      // «Диагностика» (задача 2.5): живые метрики + история прогонов
      void bridge.tabs.open({ url: "duopulse://diagnostics" }).catch(err);
      break;
    case "settings":
      // «Настройки» (задача 5.1): полные настройки + экспорт/импорт профиля
      void bridge.tabs.open({ url: "duopulse://settings" }).catch(err);
      break;
    case "updates":
      // «Обновления» (задача 5.2): раздел «Обновления» страницы настроек —
      // там канал/автопроверка и кнопки проверки/установки.
      void bridge.tabs.open({ url: "duopulse://settings" }).catch(err);
      break;
    case "proxy":
      // переиспользуем обработчик кнопки навбара: тумблер/статус обновятся сами
      document.getElementById("proxyBtn")?.click();
      break;
  }
});

// --- Блокировщик (задача 2.1) ---------------------------------------------

/** Хост активной вкладки (http/https) — цель site-исключения; иначе null. */
let adblockSiteHost: string | null = null;

/** Хост исключён: точное совпадение или родительский домен (как в Core). */
function isExempted(host: string, exceptions: string[]): boolean {
  return exceptions.some((x) => host === x || host.endsWith("." + x));
}

/** Хост http(s)-URL или null (внутренние страницы/пустой экран). */
function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname : null;
  } catch {
    return null;
  }
}

/** Последний статус (label site-кнопки) — обновляется в renderAdblock. */
let lastStatus: AdblockStatusResult | null = null;

function renderAdblock(st: AdblockStatusResult): void {
  lastStatus = st;
  adblockToggle.checked = st.enabled;
  const parts = [`Заблокировано: ${st.blockedTotal}`];
  if (!st.ready) parts.push(st.enabled ? "списки загружаются…" : "списки не загружены");
  else {
    const bad = st.lists.find((l) => l.error);
    const fresh = st.lists.every((l) => l.updatedAt > 0);
    if (bad) parts.push(`ошибка списка: ${bad.name}`);
    else if (fresh) {
      const t = new Date(Math.max(...st.lists.map((l) => l.updatedAt)));
      parts.push(`списки: ${t.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`);
    }
  }
  adblockMeta.textContent = parts.join(" · ");

  if (adblockSiteHost && st.enabled) {
    const exempted = isExempted(adblockSiteHost, st.siteExceptions);
    adblockSiteBtn.hidden = false;
    adblockSiteBtn.textContent = exempted ? "Блокировать на этом сайте" : "Отключить на этом сайте";
  } else {
    adblockSiteBtn.hidden = true;
  }
}

/** Снапшот из Core + хост активной вкладки → перерисовать секцию. */
async function refreshAdblock(): Promise<void> {
  const [st, tabs] = await Promise.all([bridge.adblock.status(), bridge.tabs.list()]);
  adblockSiteHost = hostOf(tabs.tabs.find((t) => t.active)?.url);
  renderAdblock(st);
}

adblockToggle.addEventListener("change", () => {
  void bridge.adblock
    .setEnabled({ site: null, on: adblockToggle.checked })
    .then(renderAdblock)
    .catch(err);
});

adblockSiteBtn.addEventListener("click", () => {
  if (!adblockSiteHost) return;
  const st = lastStatus;
  const on = st ? isExempted(adblockSiteHost, st.siteExceptions) : true; // выключено → включить
  void bridge.adblock
    .setEnabled({ site: adblockSiteHost, on })
    .then(renderAdblock)
    .catch(err);
});

adblockUpdateBtn.addEventListener("click", () => {
  adblockMeta.textContent = "Списки: обновление запущено…";
  void bridge.adblock.updateLists({ force: true }).catch(err);
  // загрузка идёт фоном (Core отвечает сразу) — обновим панель по готовности
  setTimeout(() => void refreshAdblock().catch(err), 1500);
});

void listen<AdblockBlockedCount>(bridge.events.adblockBlockedCount, (ev) => {
  // счётчик живой и при закрытом меню — открытие покажет актуальное число
  const idx = adblockMeta.textContent?.indexOf(" · ");
  const head = `Заблокировано: ${ev.payload.total}`;
  adblockMeta.textContent = idx && idx > 0 ? head + adblockMeta.textContent!.slice(idx) : head;
  if (lastStatus) lastStatus.blockedTotal = ev.payload.total;
});

// --- Бейдж найденного обновления (duopulse-067) ------------------------------

void listen<UpdaterCheckResult>(bridge.events.updaterCheckDone, (ev) => {
  // точка на «⋮» о pending-обновлении: итог любой проверки (автопроверка
  // старта и ручная из настроек); ошибки/«последняя версия» гасят, установка
  // перезапускает приложение — индикатора в новом сеансе просто нет.
  const st = updateBadgeState(ev.payload);
  if (updateDot) updateDot.hidden = !st.on;
  btn.title = updateBadgeTitle(st);
});
