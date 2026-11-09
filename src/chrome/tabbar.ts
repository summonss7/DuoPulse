// DuoPulse — таб-бар (задача 1.2; docs/05 §1 src/chrome/TabBar, стиль — гайд 06).
// Список вкладок приходит событием контракта tabs.updated (Core → UI) и
// командой tabs.list на старте; действия уходят командами tabs.{open, close,
// reopen, activate}. Когда фокус в UI (эти слушатели), Ctrl+Tab /
// Ctrl+Shift+Tab активируют соседнюю вкладку по локальному списку, Ctrl+Shift+T
// зовёт tabs.reopen; когда фокус в контенте, те же клавиши приходят из
// content/chrome-hotkeys.js через Core — обе стороны сходятся на одном списке.
//
// Контекстное меню вкладки (карточка duopulse-086) рендерится в оверлей-окне
// menu-overlay: контентные webview рисуются поверх HTML UI, и панель,
// выезжающая за полосу хрома, уходила под страницу. Логика (доступность
// пунктов, действия) остаётся здесь: открытие — openOverlayMenu с payload,
// клики по пунктам возвращаются событием «menu-action».
import { listen } from "@tauri-apps/api/event";
import { bridge } from "../bridge";
import type { TabInfo, TabsListResult } from "../bridge";
import { onOverlayMenuAction, openOverlayMenu } from "./overlay-menu";
import { tabMenuDisabled } from "./tab-menu";

const err = (e: unknown): void => console.error("tabbar:", e);

/** Подписчики на смену списка вкладок (omnibox-синхронизация в main.ts). */
type TabsListener = (tabs: TabInfo[]) => void;
const listeners = new Set<TabsListener>();
export function onTabsChanged(cb: TabsListener): void {
  listeners.add(cb);
}

/** Последний известный список вкладок (для хоткеев и контекст-меню). */
let tabs: TabInfo[] = [];

const tabbarEl = document.getElementById("tabbar") as HTMLDivElement;
const tabsEl = document.getElementById("tabs") as HTMLDivElement;
const newtabBtn = document.getElementById("newtab") as HTMLButtonElement;

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
      if (tab.incognito) el.classList.add("incognito");
      el.dataset.id = tab.id;
      el.dataset.loading = String(tab.loading);
      el.dataset.sleeping = String(tab.sleeping);
      el.setAttribute("role", "tab");
      el.setAttribute("aria-selected", String(tab.active));
      el.title = tab.sleeping
        ? `${tab.url} — спящая вкладка (активируйте, чтобы разбудить)`
        : tab.incognito
          ? `${tab.url} — вкладка инкогнито (история не сохраняется)`
          : tab.url;
      if (tab.incognito) {
        // инкогнито-вкладка (карточка duopulse-096): значок-шпион + тёмная
        // подложка — приватные вкладки отличимы с одного взгляда
        const spy = document.createElement("span");
        spy.className = "tab-incognito";
        spy.title = "Инкогнито";
        spy.innerHTML =
          '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5 5 4h6l1 2.5"/><path d="M3 6.5h10"/><circle cx="5.5" cy="10.5" r="2"/><circle cx="10.5" cy="10.5" r="2"/><path d="M7.5 10.5h1"/></svg>';
        el.append(spy);
      }
      if (tab.sleeping) {
        // спящая вкладка (задача 2.3): луна + приглушённый заголовок
        const moon = document.createElement("span");
        moon.className = "tab-sleep";
        moon.innerHTML =
          '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 9.5A6 6 0 1 1 6.5 2.5a4.7 4.7 0 0 0 7 7z"/></svg>';
        el.append(moon);
      }
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

// правый клик по вкладке — её меню; по пустому месту таб-бара (карточка
// duopulse-075: «возле вкладок нет "создать новую вкладку"») — то же меню
// без вкладочного контекста: доступна «Новая вкладка», вкладочные действия
// отключены (карточка duopulse-086: панель — в оверлей-окне над webview)
tabbarEl.addEventListener("contextmenu", (e) => {
  const tab = tabElement(e.target);
  e.preventDefault();
  openMenu((tab?.dataset.id as string) ?? null, e.clientX, e.clientY);
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

// --- контекстное меню вкладки (оверлей, карточка duopulse-086) ---------------

function openMenu(id: string | null, x: number, y: number): void {
  // прочие панели хрома закрываются (единое «одно меню на экран», mainmenu.ts)
  for (const other of ["mainMenu", "proxyMenu", "duoPanel", "vpnPanel"]) {
    const node = document.getElementById(other);
    if (node) node.hidden = true;
  }
  openOverlayMenu("tab", x, y, { id, disabled: tabMenuDisabled(tabs, id) });
}

/** Исполнить действие таб-меню (клик в оверлее пришёл «menu-action»). */
function runMenuAction(act: string, id: string | null): void {
  const tab = id ? tabs.find((t) => t.id === id) : null;
  switch (act) {
    case "newtab":
      void bridge.tabs.open({}).then(apply, err);
      break;
    case "newIncognito":
      void bridge.tabs.open({ incognito: true }).then(apply, err);
      break;
    case "duplicate":
      // дубликат сохраняет приватность вкладки (карточка 096)
      if (tab) void bridge.tabs.open({ url: tab.url, incognito: tab.incognito }).then(apply, err);
      break;
    case "openIncognito":
      if (tab) void bridge.tabs.open({ url: tab.url, incognito: true }).then(apply, err);
      break;
    case "close":
      if (id) closeTab(id);
      break;
    case "closeOthers":
      if (!id) break;
      void (async () => {
        for (const other of tabs.filter((t) => t.id !== id)) {
          await bridge.tabs.close({ id: other.id });
        }
      })().catch(err);
      break;
    case "reopen":
      void bridge.tabs.reopen().then(apply, err);
      break;
    case "sleep":
      // ручное усыпление (задача 2.3); фон сна подтверждает tabs.updated
      if (id) void bridge.tabs.sleep({ id }).then(apply, err);
      break;
  }
}

onOverlayMenuAction((a) => {
  if (a.menu !== "tab") return;
  runMenuAction(String(a.act ?? ""), (a.id as string | null) ?? null);
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
    } else if (e.shiftKey && !e.repeat && (e.key === "n" || e.key === "N")) {
      // инкогнито-вкладка (карточка 096): в контенте то же ловит
      // content/chrome-hotkeys.js через Core
      void bridge.tabs.open({ incognito: true }).then(apply, err);
    } else if (!e.shiftKey && !e.repeat && (e.key === "t" || e.key === "T")) {
      // новая вкладка (карточка duopulse-075): в контенте то же ловит
      // content/chrome-hotkeys.js через Core
      void bridge.tabs.open({}).then(apply, err);
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
