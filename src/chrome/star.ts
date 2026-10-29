// DuoPulse — звёздочка избранного в навбаре (карточка duopulse-057, п.5
// первого запуска: «не нашёл как добавить страницу в избранное»; группы —
// карточка duopulse-058). Кнопка справа от адресной строки: состояние
// закладки активной вкладки (history.bookmark_list, до 500 — как страница
// управления). Клик по незакладённой странице открывает мини-меню выбора
// группы (список групп + «Новая группа…»; null-группа — «Избранное»);
// клик по закладённой — убирает закладку. Видна только на внешних
// http/https-страницах (внутренние duopulse:// в избранное не идут);
// Ctrl+D в UI дублирует добавление в группу по умолчанию — в контентной
// вкладке ту же команду ловит content/chrome-hotkeys.js и Core делает тот
// же toggle (tabs.updated после него обновит кнопку: chrome.ts подписывает
// setActivePage на смену вкладок).
import { bridge } from "../bridge";
import type { BookmarkGroupInfo, TabInfo } from "../bridge";

const err = (e: unknown): void => console.error("star:", e);
const btn = document.getElementById("starBtn") as HTMLButtonElement;

/** Канонический URL активной вкладки (пустой — страница не из избранных). */
let url = "";
/** Заголовок для новой закладки (document.title вкладки из снапшота). */
let title = "";
let starred = false;
/** Живое мини-меню выбора группы (одно). */
let menu: HTMLDivElement | null = null;

function render(): void {
  btn.dataset.on = String(starred);
  btn.setAttribute("aria-pressed", String(starred));
  btn.title = starred
    ? "Убрать из избранного (Ctrl+D)"
    : "Добавить в избранное — выбор группы (Ctrl+D — в «Избранное»)";
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

/** Добавить закладку в группу и закрыть меню. */
async function addTo(groupId: number | null): Promise<void> {
  closeMenu();
  if (!url) return;
  try {
    await bridge.history.bookmarkAdd({ url, title, groupId });
    await refreshState();
  } catch (e) {
    err(e);
  }
}

/** Мини-меню групп под звёздочкой (карточка duopulse-058): список групп
 *  (по умолчанию — первой, с пометкой) и «Новая группа…» с инлайн-инпутом. */
async function openMenu(): Promise<void> {
  closeMenu();
  let groups: BookmarkGroupInfo[];
  try {
    ({ groups } = await bridge.history.groupList());
  } catch (e) {
    err(e);
    return;
  }
  menu = document.createElement("div");
  menu.className = "star-menu";
  menu.setAttribute("role", "menu");
  for (const g of groups) {
    const item = document.createElement("button");
    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.textContent = g.isDefault ? `${g.name} · по умолчанию` : g.name;
    item.title = g.isDefault ? "Группа по умолчанию (Ctrl+D)" : `Добавить в «${g.name}»`;
    item.addEventListener("click", () => void addTo(g.id));
    menu.append(item);
  }
  const newBtn = document.createElement("button");
  newBtn.type = "button";
  newBtn.className = "star-menu-new";
  newBtn.setAttribute("role", "menuitem");
  newBtn.textContent = "+ Новая группа…";
  newBtn.addEventListener("click", () => {
    if (menu?.querySelector(".star-menu-input")) return;
    const input = document.createElement("input");
    input.className = "star-menu-input";
    input.type = "text";
    input.placeholder = "Имя группы";
    input.spellcheck = false;
    input.maxLength = 60;
    newBtn.replaceWith(input);
    input.focus();
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      const name = input.value.trim();
      if (ev.key === "Enter" && name) {
        void bridge.history
          .groupAdd({ name })
          .then((g) => addTo(g.id))
          .catch(err);
      }
      if (ev.key === "Escape") closeMenu();
    });
    input.addEventListener("blur", () => closeMenu());
  });
  menu.append(newBtn);
  document.body.append(menu);
  // под кнопкой, не выходя за правый край окна
  const r = btn.getBoundingClientRect();
  menu.style.top = `${r.bottom + 6}px`;
  const mw = menu.getBoundingClientRect().width;
  menu.style.left = `${Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8))}px`;
}

function closeMenu(): void {
  menu?.remove();
  menu = null;
}

async function toggle(): Promise<void> {
  if (!url) return;
  try {
    if (starred) {
      await bridge.history.bookmarkRemove({ url });
      await refreshState();
    } else {
      await openMenu();
    }
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
  closeMenu();
  render();
  if (external) void refreshState();
}

/** Инициализация: клик, Ctrl+D (фокус в UI) и закрытие меню кликом мимо. */
export function initStar(): void {
  btn.addEventListener("click", () => void toggle());
  window.addEventListener(
    "keydown",
    (e) => {
      if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey || e.repeat) return;
      if (e.key !== "d" && e.key !== "D") return;
      e.preventDefault();
      if (!url) return;
      // Ctrl+D — без меню: добавить в «Избранное» / убрать
      const call = starred
        ? bridge.history.bookmarkRemove({ url })
        : bridge.history.bookmarkAdd({ url, title, groupId: null });
      void call.then(refreshState).catch(err);
    },
    true
  );
  window.addEventListener(
    "mousedown",
    (e) => {
      if (menu && !(e.target as HTMLElement).closest(".star-menu") && e.target !== btn) {
        closeMenu();
      }
    },
    true
  );
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  });
}
