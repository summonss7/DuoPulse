// DuoPulse — внутренняя страница «История и закладки» (задача 1.4,
// docs/05 §1 src/pages/). Открывается вкладкой duopulse://history (webview
// с меткой page-history-N грузит UI-бандл, роутер — src/main.ts; как
// chrome://history в браузерах). Данные — команды контракта history.*
// (SQLite в профиле, src-tauri/src/history/); стиль — гайд 06: фон из
// сине-чёрной группы, неон — только акценты, тёплые — внутренние детали.
//
// Секции: История — агрегат по URL, поиск FTS, удаление записи и диапазонов
// («за час/сутки/всё»), «в закладки» одним кликом; Закладки — правка
// заголовка, удаление, переход. Клик по записи открывает адрес в этой
// вкладке (страница заменяется сайтом), Ctrl/средняя кнопка — новая вкладка.
import { bridge } from "../bridge";
import type { HistoryBookmark, HistoryEntry } from "../bridge";

const ICONS = {
  history:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/></svg>',
  star:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M8 1.5l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.3l-3.8 2 .7-4.3-3.1-3 4.3-.6z"/></svg>',
  edit:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M11.3 2.2l2.5 2.5L6 12.5l-3.4.9.9-3.4z"/></svg>',
  cross:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>',
} as const;

const PAGE_SIZE = 100;
const DAY_MS = 86_400_000;

/** Секция страницы (вкладки сегмента). */
type Section = "history" | "bookmarks";

let section: Section = "history";
let query = "";
/** Загруженные записи текущей секции (для «Показать ещё» — дополнение). */
let entries: HistoryEntry[] = [];
let bookmarks: HistoryBookmark[] = [];
/** Загружено всего (серверный total — для кнопки «Показать ещё»). */
let total = 0;
let seq = 0;

const err = (e: unknown): void => console.error("history-page:", e);

// DOM (строится в initManagerPage, здесь — ссылки)
let root: HTMLElement;
let searchEl: HTMLInputElement;
let listEl: HTMLElement;
let moreBtn: HTMLButtonElement;
let moreWrap: HTMLElement;
let totalEl: HTMLElement;
let errEl: HTMLElement;
let rangeMenu: HTMLElement;

/** Заголовок группы по дате: «Сегодня», «Вчера», иначе дата. */
function dayLabel(ts: number): string {
  const day = new Date(ts);
  day.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - day.getTime()) / DAY_MS);
  if (diff === 0) return "Сегодня";
  if (diff === 1) return "Вчера";
  return day.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}

const timeOf = (ts: number): string =>
  new Date(ts).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

const dateOf = (ts: number): string =>
  new Date(ts).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });

const isBookmarked = (url: string): boolean => bookmarks.some((b) => b.url === url);

/** Открыть адрес: обычный клик — в этой вкладке, Ctrl/средняя — новая. */
function openUrl(url: string, newTab: boolean): void {
  if (newTab) {
    void bridge.tabs.open({ url }).catch(err);
  } else {
    // страница заменяется сайтом (Core: webview уходит с app-origin,
    // вкладка становится обычной — src-tauri/src/tabs/)
    void bridge.nav.navigate({ url }).catch(err);
  }
}

/** Удалить запись истории (все визиты адреса) и перечитать список. */
function deleteEntry(url: string): void {
  void bridge.history
    .deleteUrls({ urls: [url] })
    .then(reload)
    .catch(showError);
}

/** ★/☆ записи истории: добавить/убрать закладку. */
function toggleBookmark(url: string, title: string): void {
  const call = isBookmarked(url)
    ? bridge.history.bookmarkRemove({ url })
    : bridge.history.bookmarkAdd({ url, title });
  void call.then(reload).catch(showError);
}

function showError(e: unknown): void {
  errEl.textContent = String(e);
  errEl.hidden = false;
  err(e);
}

// --- рендер ---------------------------------------------------------------

/** Иконка-действие строки. */
function actBtn(cls: string, icon: keyof typeof ICONS, title: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `act ${cls}`;
  b.title = title;
  b.innerHTML = ICONS[icon];
  return b;
}

/** Общая часть строки: иконка, заголовок, адрес, время. */
function entryRow(base: { url: string; title: string }, icon: keyof typeof ICONS, timeText: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "mgr-entry";
  el.dataset.url = base.url;
  const ico = document.createElement("span");
  ico.className = "ico";
  ico.innerHTML = ICONS[icon];
  const main = document.createElement("div");
  main.className = "entry-main";
  const title = document.createElement("div");
  title.className = "entry-title";
  title.textContent = base.title.trim() || base.url;
  const url = document.createElement("div");
  url.className = "entry-url";
  url.textContent = base.url;
  main.append(title, url);
  const time = document.createElement("span");
  time.className = "entry-time";
  time.textContent = timeText;
  el.append(ico, main, time);
  return el;
}

/** Запись истории: ★ (в закладках/нет), ✕ (удалить). */
function historyRow(e: HistoryEntry): HTMLDivElement {
  const marked = isBookmarked(e.url);
  const row = entryRow(
    e,
    marked ? "star" : "history",
    e.visitCount > 1 ? `${timeOf(e.lastVisitedAt)} · ×${e.visitCount}` : timeOf(e.lastVisitedAt),
  );
  if (marked) row.classList.add("marked");
  const star = actBtn("act-star", "star", marked ? "Убрать из закладок" : "В закладки");
  if (marked) star.classList.add("on");
  const del = actBtn("act-del", "cross", "Удалить из истории");
  row.append(star, del);
  return row;
}

/** Закладка: ✎ (правка заголовка), ✕ (удалить). */
function bookmarkRow(b: HistoryBookmark): HTMLDivElement {
  const row = entryRow(b, "star", dateOf(b.addedAt));
  const edit = actBtn("act-edit", "edit", "Переименовать");
  const del = actBtn("act-del", "cross", "Удалить закладку");
  row.append(edit, del);
  return row;
}

/** Правка заголовка закладки: инлайн-инпут вместо заголовка (Enter/blur —
 * сохранить, Esc — отменить). */
function beginEdit(row: HTMLElement, b: HistoryBookmark): void {
  const titleEl = row.querySelector(".entry-title");
  if (!titleEl || row.querySelector(".entry-edit")) return;
  const input = document.createElement("input");
  input.className = "entry-edit";
  input.type = "text";
  input.value = b.title.trim() || b.url;
  input.spellcheck = false;
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const save = (): void => {
    if (done) return;
    done = true;
    const title = input.value.trim();
    if (title && title !== (b.title.trim() || b.url)) {
      void bridge.history
        .bookmarkUpdate({ url: b.url, title })
        .then(reload)
        .catch(showError);
    } else {
      reload();
    }
  };
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") save();
    if (ev.key === "Escape") {
      done = true;
      reload();
    }
    ev.stopPropagation();
  });
  input.addEventListener("blur", save);
}

/** Полный перерисов списка текущей секции (группировка по дням — история). */
function render(): void {
  errEl.hidden = true;
  const kids: HTMLElement[] = [];
  if (section === "history") {
    let currentDay = "";
    for (const e of entries) {
      const day = dayLabel(e.lastVisitedAt);
      if (day !== currentDay) {
        currentDay = day;
        const head = document.createElement("div");
        head.className = "mgr-group";
        head.textContent = day;
        kids.push(head);
      }
      kids.push(historyRow(e));
    }
  } else {
    for (const b of bookmarks) kids.push(bookmarkRow(b));
  }
  if (!kids.length) {
    const empty = document.createElement("div");
    empty.className = "mgr-empty";
    empty.textContent =
      section === "history"
        ? query
          ? "По запросу ничего не найдено"
          : "История пуста — посещённые страницы появятся здесь"
        : query
          ? "По запросу ничего не найдено"
          : "Закладок нет — добавьте ★ из истории";
    kids.push(empty);
  }
  listEl.replaceChildren(...kids);
  const shown = section === "history" ? entries.length : bookmarks.length;
  moreWrap.hidden = shown >= total;
  totalEl.textContent = query
    ? `${shown} из ${total}`
    : total > 0
      ? String(total)
      : "";
}

// --- загрузка данных --------------------------------------------------------

/** Перечитать секцию (+ список закладок для звёздочек), offset=0. */
async function reload(): Promise<void> {
  return loadPage(false);
}

/** Загрузить страницу данных; append — дополнить («Показать ещё»). */
async function loadPage(append: boolean): Promise<void> {
  const my = ++seq;
  if (!append) {
    entries = [];
    bookmarks = [];
  }
  try {
    if (section === "history") {
      const [res, marks] = await Promise.all([
        bridge.history.list({ query: query || null, offset: append ? entries.length : 0, limit: PAGE_SIZE }),
        // звёздочки нужны независимо от секции-фильтра — полный список
        bridge.history.bookmarkList({ query: null, offset: 0, limit: 500 }),
      ]);
      if (my !== seq) return;
      total = res.total;
      entries = append ? entries.concat(res.entries) : res.entries;
      bookmarks = marks.bookmarks;
    } else {
      const res = await bridge.history.bookmarkList({
        query: query || null,
        offset: append ? bookmarks.length : 0,
        limit: PAGE_SIZE,
      });
      if (my !== seq) return;
      total = res.total;
      bookmarks = append ? bookmarks.concat(res.bookmarks) : res.bookmarks;
      // счётчик звёздочек в другой секции — обновим и его
      if (!query) {
        const marks = await bridge.history.bookmarkList({ query: null, offset: 0, limit: 500 });
        if (my !== seq) return;
        bookmarks = marks.bookmarks;
      }
    }
    render();
  } catch (e) {
    showError(e);
  }
}

// --- сборка страницы --------------------------------------------------------

/** Кнопка сегмента секций. */
function sectionBtn(name: Section, label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "mgr-tab";
  b.dataset.sec = name;
  b.textContent = label;
  b.addEventListener("click", () => switchSection(name));
  return b;
}

function switchSection(next: Section): void {
  if (section === next) return;
  section = next;
  query = "";
  searchEl.value = "";
  rangeMenu.hidden = true;
  syncTabs();
  void reload();
}

/** Подсветка активной секции и видимость «Очистить историю». */
function syncTabs(): void {
  for (const b of root.querySelectorAll<HTMLButtonElement>(".mgr-tab")) {
    b.classList.toggle("active", b.dataset.sec === section);
  }
  (root.querySelector(".mgr-actions") as HTMLElement).hidden = section !== "history";
}

/** Диапазоны очистки истории: [подпись, fromMs относительно now]. */
const RANGES: [string, number | "all"][] = [
  ["За последний час", 3_600_000],
  ["За последние сутки", DAY_MS],
  ["Всю историю", "all"],
];

function buildRangeMenu(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "mgr-actions";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mgr-clear";
  btn.textContent = "Очистить историю";
  rangeMenu = document.createElement("div");
  rangeMenu.className = "mgr-menu";
  rangeMenu.hidden = true;
  for (const [label, range] of RANGES) {
    const item = document.createElement("button");
    item.type = "button";
    item.textContent = label;
    item.addEventListener("click", () => {
      rangeMenu.hidden = true;
      const now = Date.now();
      const from = range === "all" ? 0 : now - range;
      void bridge.history
        .deleteRange({ fromMs: from, toMs: now + 60_000 })
        .then(reload)
        .catch(showError);
    });
    rangeMenu.append(item);
  }
  btn.addEventListener("click", () => {
    rangeMenu.hidden = !rangeMenu.hidden;
  });
  wrap.append(btn, rangeMenu);
  return wrap;
}

/** Точка входа webview внутренней страницы (вызывается из src/main.ts —
 * модуль импортируется ради побочного эффекта). */
export function initManagerPage(): void {
  document.title = "История и закладки — DuoPulse";
  document.body.classList.add("internal-page");
  // разметка хрома из index.html странице не нужна
  document.getElementById("app")?.remove();

  root = document.createElement("div");
  root.className = "mgr";

  const head = document.createElement("header");
  head.className = "mgr-head";
  const logo = document.createElement("div");
  logo.className = "mgr-logo";
  logo.textContent = "Duo";
  const pulse = document.createElement("span");
  pulse.textContent = "Pulse";
  logo.append(pulse);
  const title = document.createElement("h1");
  title.className = "mgr-title";
  title.textContent = "История и закладки";
  searchEl = document.createElement("input");
  searchEl.type = "text";
  searchEl.className = "mgr-search";
  searchEl.placeholder = "Поиск по истории и закладкам";
  searchEl.spellcheck = false;
  searchEl.autocomplete = "off";
  let timer: number | undefined;
  searchEl.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      query = searchEl.value.trim();
      void reload();
    }, 200);
  });
  head.append(logo, title, searchEl);

  const tabs = document.createElement("nav");
  tabs.className = "mgr-tabs";
  tabs.append(sectionBtn("history", "История"), sectionBtn("bookmarks", "Закладки"));
  tabs.append(buildRangeMenu());

  listEl = document.createElement("main");
  listEl.className = "mgr-list";

  moreWrap = document.createElement("footer");
  moreWrap.className = "mgr-more";
  moreBtn = document.createElement("button");
  moreBtn.type = "button";
  moreBtn.textContent = "Показать ещё";
  moreBtn.addEventListener("click", () => void loadPage(true));
  totalEl = document.createElement("span");
  totalEl.className = "mgr-total";
  moreWrap.append(moreBtn, totalEl);

  errEl = document.createElement("div");
  errEl.className = "mgr-error";
  errEl.hidden = true;

  root.append(head, tabs, errEl, listEl, moreWrap);
  document.body.append(root);

  // клики по записям: действие (★/✕/✎) или переход; делегирование
  listEl.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".mgr-entry");
    if (!row) return;
    const url = row.dataset.url ?? "";
    if ((e.target as HTMLElement).closest(".act-star")) {
      const title = row.querySelector(".entry-title")?.textContent ?? "";
      toggleBookmark(url, title);
      return;
    }
    if ((e.target as HTMLElement).closest(".act-del")) {
      deleteEntry(url);
      return;
    }
    if ((e.target as HTMLElement).closest(".act-edit")) {
      const b = bookmarks.find((m) => m.url === url);
      if (b) beginEdit(row, b);
      return;
    }
    openUrl(url, e.ctrlKey || e.metaKey);
  });
  listEl.addEventListener("auxclick", (e) => {
    if (e.button !== 1) return; // средняя кнопка — новая вкладка
    const row = (e.target as HTMLElement).closest<HTMLElement>(".mgr-entry");
    if (row?.dataset.url) openUrl(row.dataset.url, true);
  });

  // закрытие меню диапазонов кликом мимо
  window.addEventListener("mousedown", (e) => {
    if (!rangeMenu.hidden && !(e.target as HTMLElement).closest(".mgr-actions")) {
      rangeMenu.hidden = true;
    }
  }, true);

  syncTabs();
  void reload();
}

// модуль импортируется роутером src/main.ts — стартуем сразу
initManagerPage();
