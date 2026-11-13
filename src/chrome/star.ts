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
// Карточка duopulse-086: мини-меню групп рендерится в оверлей-окне
// menu-overlay — контентные webview рисуются поверх HTML UI, и панель под
// навбаром уходила под страницу («звёздочка ничего не делает»). Разметку
// запрашивает openOverlayMenu("star", …), клики возвращаются «menu-action».
import { bridge } from "../bridge";
import type { BookmarkGroupInfo, TabInfo } from "../bridge";
import { t } from "../i18n";
import { onOverlayMenuAction, openOverlayMenu } from "./overlay-menu";
import { refreshBmBar } from "./bmbar";

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
  btn.title = starred
    ? t("Убрать из избранного (Ctrl+D)")
    : t("Добавить в избранное — выбор группы (Ctrl+D — в «Избранное»)")
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

/** Добавить закладку в группу (действие из оверлей-меню). */
async function addTo(groupId: number | null): Promise<void> {
  if (!url) return;
  try {
    await bridge.history.bookmarkAdd({ url, title, groupId });
    await refreshState();
    void refreshBmBar(); // строка закладок (duopulse-143): чип появился сразу
  } catch (e) {
    err(e);
  }
}

/** Мини-меню групп под звёздочкой (карточка duopulse-058): список групп
 *  (по умолчанию — первой, с пометкой) и «Новая группа…» с инлайн-вводом —
 *  рендер и клики в оверлей-окне (duopulse-086), здесь только запрос. */
async function openMenu(): Promise<void> {
  try {
    const { groups } = await bridge.history.groupList();
    const r = btn.getBoundingClientRect();
    openOverlayMenu("star", r.right, r.bottom + 6, { groups });
  } catch (e) {
    err(e);
  }
}

async function toggle(): Promise<void> {
  if (!url) return;
  try {
    if (starred) {
      await bridge.history.bookmarkRemove({ url });
      await refreshState();
      void refreshBmBar(); // строка закладок: чип исчез сразу
    } else {
      await openMenu();
    }
  } catch (e) {
    err(e);
  }
}

// действия из меню (нативный popup): группа — добавить закладку;
// «Новая группа…» — нативное меню без ввода текста, ведёт в управление
onOverlayMenuAction((a) => {
  if (a.menu !== "star" || !url) return;
  if (a.newGroup === true) {
    void bridge.tabs.open({ url: "duopulse://history" }).catch(err);
  } else if (typeof a.groupId === "number") {
    void addTo(a.groupId);
  }
});

/** Смена активной вкладки/её URL (подписка chrome.ts на tabs.updated; событие
 *  приходит и после SPA-навигации — карточка 057, и после Ctrl+D из контента:
 *  Core эмитит tabs.updated по toggle_bookmark_active). */
export function setActivePage(tab: TabInfo | undefined): void {
  const external = !!tab && /^https?:/i.test(tab.url);
  const next = external ? (tab as TabInfo).url : "";
  // меню закрывается только при реальной смене страницы: tabs.updated
  // приходит и по ходу загрузки той же вкладки (loading/title) —
  // оверлей не должен мигнуть закрытием (карточка duopulse-086)
  url = next;
  title = tab?.title ?? "";
  starred = false;
  btn.hidden = !external;
  render();
  if (external) void refreshState();
}

/** Инициализация: клик, Ctrl+D (фокус в UI); закрытие меню — в оверлее. */
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
      void call.then(refreshState).then(refreshBmBar).catch(err);
    },
    true
  );
}
