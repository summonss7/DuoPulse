// DuoPulse — таб-бар (задача 1.2; docs/05 §1 src/chrome/TabBar, стиль — гайд 06).
// Список вкладок приходит событием контракта tabs.updated (Core → UI) и
// командой tabs.list на старте; действия уходят командами tabs.{open, close,
// reopen, activate}. Когда фокус в UI (эти слушатели), Ctrl+Tab /
// Ctrl+Shift+Tab активируют соседнюю вкладку по локальному списку, Ctrl+Shift+T
// зовёт tabs.reopen; когда фокус в контенте, те же клавиши приходят из
// content/chrome-hotkeys.js через Core — обе стороны сходятся на одном списке.
import { listen } from "@tauri-apps/api/event";
import { bridge } from "../bridge";
import type { TabInfo, TabsListResult } from "../bridge";

const err = (e: unknown): void => console.error("tabbar:", e);

/** Подписчики на смену списка вкладок (omnibox-синхронизация в main.ts). */
type TabsListener = (tabs: TabInfo[]) => void;
const listeners = new Set<TabsListener>();
export function onTabsChanged(cb: TabsListener): void {
  listeners.add(cb);
}

/** Последний известный список вкладок (для хоткеев и контекст-меню). */
let tabs: TabInfo[] = [];

const tabsEl = document.getElementById("tabs") as HTMLDivElement;
const newtabBtn = document.getElementById("newtab") as HTMLButtonElement;
const menuEl = document.getElementById("tabMenu") as HTMLDivElement;
/** Вкладка, для которой открыто контекстное меню. */
let menuTabId: string | null = null;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

/** Заголовок вкладки: document.title, до первого события — хост URL. */
function titleOf(tab: TabInfo): string {
  return tab.title?.trim() || hostOf(tab.url);
}

/** Снапшот → DOM: полный перерисовка списка (вкладок единицы, слушателей
 *  на элементах нет — события делегированы контейнеру). */
function render(): void {
  tabsEl.replaceChildren(
    ...tabs.map((tab) => {
      const el = document.createElement("div");
      el.className = tab.active ? "tab active" : "tab";
      el.dataset.id = tab.id;
      el.dataset.loading = String(tab.loading);
      el.setAttribute("role", "tab");
      el.setAttribute("aria-selected", String(tab.active));
      el.title = tab.url;
      const title = document.createElement("span");
      title.className = "tab-title";
      title.textContent = titleOf(tab);
      const close = document.createElement("button");
      close.className = "tab-close";
      close.type = "button";
      close.title = "Закрыть вкладку";
      // линейная иконка 1.5px — как остальные иконки хрома (гайд 06 §5)
      close.innerHTML =
        '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
      el.append(title, close);
      return el;
    })
  );
}

/** Применить снапшот (событие или ответ команды) и оповестить подписчиков. */
function apply(result: TabsListResult): void {
  tabs = result.tabs;
  render();
  for (const cb of listeners) cb(tabs);
}

function tabElement(target: EventTarget | null): HTMLElement | null {
  return (target as HTMLElement | null)?.closest<HTMLElement>(".tab") ?? null;
}

function closeTab(id: string): void {
  void bridge.tabs.close({ id }).then(apply, err);
}

/** Ctrl+Tab / Ctrl+Shift+Tab: соседняя вкладка по кольцу. */
function cycle(step: number): void {
  const n = tabs.length;
  if (!n) return;
  const i = Math.max(
    tabs.findIndex((t) => t.active),
    0
  );
  const next = tabs[(i + step + n) % n];
  void bridge.tabs.activate({ id: next.id }).then(apply, err);
}

// --- события списка (делегирование: клик/средняя кнопка/правая кнопка) -------
tabsEl.addEventListener("click", (e) => {
  const tab = tabElement(e.target);
  if (!tab) return;
  if ((e.target as HTMLElement).closest(".tab-close")) {
    closeTab(tab.dataset.id as string);
    return;
  }
  void bridge.tabs.activate({ id: tab.dataset.id as string }).then(apply, err);
});

tabsEl.addEventListener("auxclick", (e) => {
  if (e.button !== 1) return; // средняя кнопка — закрыть
  const tab = tabElement(e.target);
  if (tab) closeTab(tab.dataset.id as string);
});

tabsEl.addEventListener("contextmenu", (e) => {
  const tab = tabElement(e.target);
  if (!tab) return;
  e.preventDefault();
  openMenu(tab.dataset.id as string, e.clientX, e.clientY);
});

// колесо — горизонтальная прокрутка полосы вкладок
tabsEl.addEventListener("wheel", (e) => {
  if (tabsEl.scrollWidth <= tabsEl.clientWidth) return;
  tabsEl.scrollLeft += e.deltaY + e.deltaX;
  e.preventDefault();
});

newtabBtn.addEventListener("click", () => {
  void bridge.tabs.open({}).then(apply, err);
});

// --- контекстное меню вкладки -------------------------------------------------
function openMenu(id: string, x: number, y: number): void {
  menuTabId = id;
  for (const btn of menuEl.querySelectorAll("button[data-act]")) {
    (btn as HTMLButtonElement).disabled = false;
  }
  const tab = tabs.find((t) => t.id === id);
  if (tab && tabs.length <= 1) {
    // «Закрыть другие» безсмысленна для единственной вкладки
    (menuEl.querySelector('[data-act="closeOthers"]') as HTMLButtonElement).disabled = true;
  }
  menuEl.hidden = false;
  const appRect = tabsEl.offsetParent?.getBoundingClientRect();
  const left = Math.min(
    x - (appRect?.left ?? 0),
    (appRect?.width ?? x) - menuEl.offsetWidth - 8
  );
  menuEl.style.left = `${Math.max(8, left)}px`;
  menuEl.style.top = `${y - (appRect?.top ?? 0) + 6}px`;
}

function closeMenu(): void {
  menuEl.hidden = true;
  menuTabId = null;
}

menuEl.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
  if (!btn || !menuTabId) return;
  const id = menuTabId;
  const tab = tabs.find((t) => t.id === id);
  closeMenu();
  switch (btn.dataset.act) {
    case "duplicate":
      if (tab) void bridge.tabs.open({ url: tab.url }).then(apply, err);
      break;
    case "close":
      closeTab(id);
      break;
    case "closeOthers":
      void (async () => {
        for (const other of tabs.filter((t) => t.id !== id)) {
          await bridge.tabs.close({ id: other.id });
        }
      })().catch(err);
      break;
    case "reopen":
      void bridge.tabs.reopen().then(apply, err);
      break;
  }
});

// закрытие меню кликом мимо / Escape / прокруткой списка
window.addEventListener(
  "mousedown",
  (e) => {
    if (!menuEl.hidden && !(e.target as HTMLElement).closest("#tabMenu")) closeMenu();
  },
  true
);
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !menuEl.hidden) closeMenu();
});

// --- горячие клавиши таб-бара в UI (в контенте — content/chrome-hotkeys.js) ---
window.addEventListener(
  "keydown",
  (e) => {
    if (!e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === "Tab") {
      cycle(e.shiftKey ? -1 : 1);
    } else if (e.shiftKey && !e.repeat && (e.key === "t" || e.key === "T")) {
      void bridge.tabs.reopen().then(apply, err);
    } else {
      return;
    }
    e.preventDefault();
  },
  true
);

/** Инициализация таб-бара: первичный список + подписка на события Core. */
export function initTabBar(): void {
  void bridge.tabs.list().then(apply, err);
  void listen<TabsListResult>(bridge.events.tabsUpdated, (ev) => apply(ev.payload));
}
