// DuoPulse — звёздочка избранного в навбаре (карточка duopulse-057, п.5
// первого запуска: «не нашёл как добавить страницу в избранное»). Кнопка
// справа от адресной строки: состояние закладки активной вкладки
// (history.bookmark_list, до 500 — как страница управления), клик —
// history.bookmark_{add, remove}. Видна только на внешних http/https-страницах
// (внутренние duopulse:// в избранное не идут); Ctrl+D в UI дублирует клик —
// в контентной вкладке ту же команду ловит content/chrome-hotkeys.js и Core
// делает тот же toggle (tabs.updated после него обновит кнопку: chrome.ts
// подписывает setActivePage на смену вкладок). Группы избранных (несколько
// групп, сортировка) — отдельная карточка-развитие хранилища закладок.
import { bridge } from "../bridge";
import type { TabInfo } from "../bridge";

const err = (e: unknown): void => console.error("star:", e);
const btn = document.getElementById("starBtn") as HTMLButtonElement;

/** Канонический URL активной вкладки (пустой — страница не из избранных). */
let url = "";
/** Заголовок для новой закладки (document.title вкладки из снапшота). */
let title = "";
let starred = false;

function render(): void {
  btn.dataset.on = String(starred);
  btn.setAttribute("aria-pressed", String(starred));
  btn.title = starred ? "Убрать из избранного (Ctrl+D)" : "Добавить в избранное (Ctrl+D)";
}

/** Свежее состояние закладок из Core (после открытия/смены страницы и тумбла). */
async function refreshState(): Promise<void> {
  if (!url) return;
  try {
    const { bookmarks } = await bridge.history.bookmarkList({
      query: null,
      offset: 0,
      limit: 500,
    });
    starred = bookmarks.some((b) => b.url === url);
    render();
  } catch (e) {
    err(e);
  }
}

async function toggle(): Promise<void> {
  if (!url) return;
  try {
    if (starred) await bridge.history.bookmarkRemove({ url });
    else await bridge.history.bookmarkAdd({ url, title });
    await refreshState();
  } catch (e) {
    err(e);
  }
}

/** Смена активной вкладки/её URL (подписка chrome.ts на tabs.updated; событие
 *  приходит и после SPA-навигации — карточка 057, и после Ctrl+D из контента:
 *  Core эмитит tabs.updated по toggle_bookmark_active). */
export function setActivePage(tab: TabInfo | undefined): void {
  const external = !!tab && /^https?:/i.test(tab.url);
  url = external ? (tab as TabInfo).url : "";
  title = tab?.title ?? "";
  starred = false;
  btn.hidden = !external;
  render();
  if (external) void refreshState();
}

/** Инициализация: клик и Ctrl+D (фокус в UI). */
export function initStar(): void {
  btn.addEventListener("click", () => void toggle());
  window.addEventListener(
    "keydown",
    (e) => {
      if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey || e.repeat) return;
      if (e.key !== "d" && e.key !== "D") return;
      e.preventDefault();
      void toggle();
    },
    true
  );
}
