// DuoPulse — внутренняя страница «История и закладки» (задача 1.4,
// docs/05 §1 src/pages/). Открывается вкладкой duopulse://history (webview
// с меткой page-history-N грузит UI-бандл, роутер — src/main.ts; как
// chrome://history в браузерах). Данные — команды контракта history.*
// (SQLite в профиле, src-tauri/src/history/); стиль — гайд 06: фон из
// сине-чёрной группы, неон — только акценты, тёплые — внутренние детали.
//
// Секции: История — агрегат по URL, поиск FTS, удаление записи и диапазонов
// («за час/сутки/всё»), «в закладки» одним кликом; Закладки — группы
// избранного (карточка duopulse-058): создание/переименование/удаление
// групп, чипы «Все / группа… / Без группы», сортировка группы (вручную
// drag&drop / по имени / по дате), перемещение закладки между группами
// (меню папки: закладка может состоять в нескольких группах или без группы),
// правка заголовка, удаление. Перетаскивание мышью (карточка duopulse-099):
// строка закладки на чип группы — перекладывание между группами (из вида
// группы — перенос: убрать из текущей и добавить в целевую), внутри списка
// в режиме «вручную» — порядок. Клик по записи открывает адрес в этой
// вкладке (страница заменяется сайтом), Ctrl/средняя кнопка — новая вкладка.
import { bridge } from "../bridge";
import type { BookmarkGroupInfo, HistoryBookmark, HistoryEntry } from "../bridge";
import { t, uiLocale } from "../i18n";

const ICONS = {
  history:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/></svg>',
  star:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M8 1.5l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.3l-3.8 2 .7-4.3-3.1-3 4.3-.6z"/></svg>',
  edit:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M11.3 2.2l2.5 2.5L6 12.5l-3.4.9.9-3.4z"/></svg>',
  cross:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>',
  folder:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1.5 5.5v7a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1H8L6.5 4.5h-4a1 1 0 0 0-1 1z"/></svg>',
  plus:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 3v10M3 8h10"/></svg>',
} as const;

const PAGE_SIZE = 100;
const DAY_MS = 86_400_000;

/** Секция страницы (вкладки сегмента). */
type Section = "history" | "bookmarks";
/** Выбор группы в секции закладок: все | без группы | id конкретной. */
type GroupSel = "all" | "ungrouped" | number;

let section: Section = "history";
let query = "";
/** Загруженные записи текущей секции (для «Показать ещё» — дополнение). */
let entries: HistoryEntry[] = [];
let bookmarks: HistoryBookmark[] = [];
/** Группы избранного (карточка duopulse-058). */
let groups: BookmarkGroupInfo[] = [];
let groupSel: GroupSel = "all";
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
let chipsEl: HTMLElement;
let groupbarEl: HTMLElement;

/** Заголовок группы по дате: «Сегодня», «Вчера», иначе дата. */
function dayLabel(ts: number): string {
  const day = new Date(ts);
  day.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - day.getTime()) / DAY_MS);
  if (diff === 0) return t("Сегодня");
  if (diff === 1) return t("Вчера");
  return day.toLocaleDateString(uiLocale, { day: "numeric", month: "long", year: "numeric" });
}

const timeOf = (ts: number): string =>
  new Date(ts).toLocaleTimeString(uiLocale, { hour: "2-digit", minute: "2-digit" });

const dateOf = (ts: number): string =>
  new Date(ts).toLocaleDateString(uiLocale, { day: "numeric", month: "long", year: "numeric" });

const isBookmarked = (url: string): boolean => bookmarks.some((b) => b.url === url);

/** Выбранная группа (объект), если в чипах выбрана конкретная. */
const currentGroup = (): BookmarkGroupInfo | undefined =>
  typeof groupSel === "number" ? groups.find((g) => g.id === groupSel) : undefined;

/** groupId для команды bookmark_list: null — все, -1 — без группы. */
const groupParam = (): number | null =>
  groupSel === "all" ? null : groupSel === "ungrouped" ? -1 : groupSel;

/** Drag&drop порядка доступен: конкретная группа в режиме «вручную», без поиска. */
const dragEnabled = (): boolean => {
  const g = currentGroup();
  return !!g && g.sortBy === "manual" && !query;
};

/** Drag&drop между группами (карточка duopulse-099): доступен во всей секции
 *  закладок без поиска — строку можно тащить на чип группы. */
const groupDragEnabled = (): boolean => section === "bookmarks" && !query;

/** Чип — валидная цель перекладывания: группа (не «Все», не текущий вид) или
 *  «Без группы» при виде конкретной группы (уход из группы). */
const validDropTarget = (sel: GroupSel): boolean =>
  sel !== "all" && sel !== groupSel && (sel !== "ungrouped" || typeof groupSel === "number");

/** Sel чипа из data-атрибута («all»/«ungrouped»/строка id). */
const chipSelOf = (chip: HTMLElement): GroupSel | undefined => {
  const s = chip.dataset.sel;
  if (s === undefined) return undefined;
  return s === "all" || s === "ungrouped" ? s : Number(s);
};

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

/** ★/☆ записи истории: добавить/убрать закладку (добавление — «Избранное»). */
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
  const star = actBtn("act-star", "star", marked ? t("Убрать из закладок") : t("В закладки"));
  if (marked) star.classList.add("on");
  const del = actBtn("act-del", "cross", t("Удалить из истории"));
  row.append(star, del);
  return row;
}

/** Закладка: метки групп, папка (членства), ✎ (правка заголовка), ✕ (удалить). */
function bookmarkRow(b: HistoryBookmark): HTMLDivElement {
  const row = entryRow(b, "star", dateOf(b.addedAt));
  row.classList.add("marked");
  // метки групп строки (в группе видны и «чужие» членства — сразу видно перекрытие)
  if (b.groups?.length) {
    const badges = document.createElement("span");
    badges.className = "entry-badges";
    badges.title = t("Группы закладки");
    for (const g of b.groups) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = g.name;
      badges.append(badge);
    }
    row.append(badges);
  }
  const folder = actBtn("act-groups", "folder", t("Группы закладки"));
  const edit = actBtn("act-edit", "edit", t("Переименовать"));
  const del = actBtn("act-del", "cross", t("Удалить закладку"));
  row.append(folder, edit, del);
  if (groupDragEnabled()) {
    row.draggable = true;
    row.classList.add("draggable");
    row.title = dragEnabled()
      ? t("Перетащите внутри списка — порядок, на чип группы — переложить в неё")
      : t("Перетащите на чип группы, чтобы переложить закладку");
  }
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
    if (!kids.length) {
      const empty = document.createElement("div");
      empty.className = "mgr-empty";
      empty.textContent =
        groupSel === "ungrouped"
          ? t("Закладок без группы нет")
          : query
            ? t("По запросу ничего не найдено")
            : groupSel === "all"
              ? t("Закладок нет — добавьте ★ из истории или звёздочкой навбара")
              : t("Группа пуста — перекладывайте закладки меню папки");
      kids.push(empty);
    }
  }
  if (!kids.length) {
    const empty = document.createElement("div");
    empty.className = "mgr-empty";
    empty.textContent = query
      ? t("По запросу ничего не найдено")
      : t("История пуста — посещённые страницы появятся здесь");
    kids.push(empty);
  }
  listEl.replaceChildren(...kids);
  const shown = section === "history" ? entries.length : bookmarks.length;
  moreWrap.hidden = shown >= total;
  totalEl.textContent = query
    ? t("{n} из {total}", { n: shown, total })
    : total > 0
      ? String(total)
      : "";
}

/** Чипы групп секции закладок: «Все» / группы / «Без группы» / «+». */
function renderChips(): void {
  chipsEl.hidden = section !== "bookmarks";
  groupbarEl.hidden = currentGroup() === undefined;
  if (section !== "bookmarks") return;
  const kids: HTMLElement[] = [];
  const chip = (sel: GroupSel, label: string, title: string): HTMLElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mgr-chip";
    b.textContent = label;
    b.title = title;
    b.dataset.sel = String(sel); // цель drag&drop (chipSelOf)
    if (groupSel === sel) b.classList.add("active");
    b.addEventListener("click", () => {
      groupSel = sel;
      query = "";
      searchEl.value = "";
      closeMenus();
      renderChips();
      void reload();
    });
    return b;
  };
  kids.push(chip("all", t("Все"), t("Все закладки, свежие первыми")));
  for (const g of groups) {
    kids.push(
      chip(
        g.id,
        g.name,
        g.isDefault ? t("Группа по умолчанию (Ctrl+D и звёздочка)") : t("Группа закладок"),
      ),
    );
  }
  kids.push(chip("ungrouped", t("Без группы"), t("Закладки, не состоящие ни в одной группе")));
  const add = document.createElement("button");
  add.type = "button";
  add.className = "mgr-chip mgr-chip-add";
  add.title = t("Создать группу");
  add.innerHTML = ICONS.plus;
  add.addEventListener("click", () => beginAddGroup());
  kids.push(add);
  chipsEl.replaceChildren(...kids);
  renderGroupbar();
}

/** Панель выбранной группы: сортировка, переименование, удаление. */
function renderGroupbar(): void {
  const g = currentGroup();
  groupbarEl.hidden = !g;
  if (!g) return;
  groupbarEl.replaceChildren();
  const sort = document.createElement("select");
  sort.className = "mgr-sort";
  sort.title = t("Сортировка группы");
  for (const [value, label] of [
    ["manual", "Вручную"],
    ["title", "По имени"],
    ["added", "По дате"],
  ] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = t(label);
    sort.append(opt);
  }
  sort.value = g.sortBy;
  sort.addEventListener("change", () => {
    void bridge.history
      .groupSetSort({ id: g.id, sortBy: sort.value })
      .then(reload)
      .catch(showError);
  });
  const note = document.createElement("span");
  note.className = "mgr-groupbar-note";
  note.textContent = g.sortBy === "manual" ? t("перетаскивайте строки") : "";
  const rename = actBtn("act-edit", "edit", t("Переименовать группу"));
  rename.addEventListener("click", () => beginRenameGroup(g));
  const del = actBtn("act-del", "cross", g.isDefault ? t("Группу по умолчанию удалить нельзя") : t("Удалить группу"));
  del.disabled = g.isDefault;
  del.addEventListener("click", () => {
    void bridge.history
      .groupRemove({ id: g.id })
      .then(() => {
        groupSel = "all";
        void reload();
      })
      .catch(showError);
  });
  groupbarEl.append(sort, note, rename, del);
}

/** «+» → инлайн-инпут имени новой группы (Enter — создать и открыть). */
function beginAddGroup(): void {
  if (chipsEl.querySelector(".mgr-chip-input")) return;
  const input = document.createElement("input");
  input.className = "mgr-chip-input";
  input.type = "text";
  input.placeholder = t("Имя группы");
  input.spellcheck = false;
  input.maxLength = 60;
  chipsEl.append(input);
  input.focus();
  // Enter → создать; blur/Esc — убрать инпут (однократно: remove снятого
  // с DOM узла после Enter-блюра кидает NotFoundError)
  let removed = false;
  const finish = (): void => {
    if (removed) return;
    removed = true;
    input.remove();
  };
  input.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Escape") finish();
    if (ev.key === "Enter") {
      const name = input.value.trim();
      finish();
      if (!name) return;
      void bridge.history
        .groupAdd({ name })
        .then((g) => {
          groupSel = g.id;
          void reload();
        })
        .catch(showError);
    }
  });
  input.addEventListener("blur", finish);
}

/** ✎ группы → инлайн-инпут вместо чипа (Enter — переименовать). */
function beginRenameGroup(g: BookmarkGroupInfo): void {
  const chip = [...chipsEl.querySelectorAll<HTMLButtonElement>(".mgr-chip")].find(
    (b) => b.textContent === g.name,
  );
  if (!chip || chipsEl.querySelector(".mgr-chip-input")) return;
  const input = document.createElement("input");
  input.className = "mgr-chip-input";
  input.type = "text";
  input.value = g.name;
  input.spellcheck = false;
  input.maxLength = 60;
  chip.replaceWith(input);
  input.focus();
  input.select();
  const cancel = (): void => {
    if (input.isConnected) input.replaceWith(chip);
  };
  let done = false;
  input.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Escape") {
      done = true;
      cancel();
    }
    if (ev.key === "Enter") {
      const name = input.value.trim();
      done = true;
      cancel();
      if (name && name !== g.name) {
        void bridge.history
          .groupRename({ id: g.id, name })
          .then(reload)
          .catch(showError);
      }
    }
  });
  input.addEventListener("blur", () => {
    if (!done) cancel();
  });
}

/** Меню папки закладки: членства в группах (✓ — состоит; клик — переключить). */
function openGroupsMenu(row: HTMLElement, b: HistoryBookmark): void {
  closeMenus();
  if (!groups.length) {
    showError(t("Групп ещё нет — создайте первую кнопкой «+» в ряду групп"));
    return;
  }
  const menu = document.createElement("div");
  menu.className = "mgr-menu mgr-groups-menu";
  for (const g of groups) {
    const item = document.createElement("button");
    item.type = "button";
    const on = b.groups?.some((r) => r.id === g.id) ?? false;
    item.textContent = `${on ? "✓ " : ""}${g.name}`;
    item.title = on ? t("Убрать из группы") : t("Добавить в группу");
    item.addEventListener("click", () => {
      void bridge.history
        .groupToggleBookmark({ url: b.url, groupId: g.id, on: !on })
        .then(reload)
        .catch(showError);
      closeMenus();
    });
    menu.append(item);
  }
  row.append(menu);
  rangeMenu.hidden = true;
}

/** Закрыть всплывающие меню страницы (группы закладки). */
function closeMenus(): void {
  for (const m of document.querySelectorAll(".mgr-groups-menu")) m.remove();
}

// --- drag&drop: порядок внутри группы (manual) и перекладывание между группами

/** Перетаскиваемая закладка (url) — одна на список. */
let dragUrl = "";

/** Переложить перетащённую закладку в группу-чип (карточка duopulse-099):
 *  из вида конкретной группы — «перекидывание» (убрать из текущей), затем
 *  добавить в целевую, если её там ещё нет (закладка может состоять в
 *  нескольких группах — остальные членства не трогаем). */
async function dropOnGroup(url: string, target: GroupSel): Promise<void> {
  const inTarget =
    typeof target === "number" &&
    bookmarks.find((b) => b.url === url)?.groups?.some((g) => g.id === target) === true;
  try {
    if (typeof groupSel === "number" && groupSel !== target) {
      await bridge.history.groupToggleBookmark({ url, groupId: groupSel, on: false });
    }
    if (typeof target === "number" && !inTarget) {
      await bridge.history.groupToggleBookmark({ url, groupId: target, on: true });
    }
  } catch (e) {
    showError(e);
  }
  await reload();
}

/** Снять подсветку чипов-целей (drag покинул чип / тяга закончилась). */
function clearChipMarks(): void {
  for (const c of chipsEl.querySelectorAll(".mgr-chip.drop-target")) {
    c.classList.remove("drop-target");
  }
}

/** Локальная перестановка + фиксация позиции в Core. */
function reorder(droppedOn: HTMLElement, after: boolean): void {
  const from = bookmarks.findIndex((b) => b.url === dragUrl);
  if (from < 0) return;
  const toRow = droppedOn.closest<HTMLElement>(".mgr-entry");
  if (!toRow || toRow.dataset.url === dragUrl) return;
  const toIdx = bookmarks.findIndex((b) => b.url === toRow.dataset.url);
  if (toIdx < 0) return;
  const insert = toIdx + (after ? 1 : 0) - (from < toIdx + (after ? 1 : 0) ? 1 : 0);
  const [moved] = bookmarks.splice(from, 1);
  bookmarks.splice(insert, 0, moved);
  render();
  const gid = groupSel;
  if (typeof gid !== "number") return;
  void bridge.history
    .bookmarkMove({ url: dragUrl, groupId: gid, position: insert })
    .catch((e) => {
      showError(e);
      void reload();
    });
}

function clearDropMarks(): void {
  for (const el of listEl.querySelectorAll(".drop-before, .drop-after")) {
    el.classList.remove("drop-before", "drop-after");
  }
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
      const [res, gl] = await Promise.all([
        bridge.history.bookmarkList({
          query: query || null,
          groupId: groupParam(),
          offset: append ? bookmarks.length : 0,
          limit: PAGE_SIZE,
        }),
        bridge.history.groupList(),
      ]);
      if (my !== seq) return;
      total = res.total;
      bookmarks = append ? bookmarks.concat(res.bookmarks) : res.bookmarks;
      groups = gl.groups;
      // выбранная группа исчезла (удалена в другом окне) — «Все»
      if (typeof groupSel === "number" && !groups.some((g) => g.id === groupSel)) {
        groupSel = "all";
      }
    }
    renderChips();
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
  groupSel = "all";
  closeMenus();
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
  btn.textContent = t("Очистить историю");
  rangeMenu = document.createElement("div");
  rangeMenu.className = "mgr-menu";
  rangeMenu.hidden = true;
  for (const [label, range] of RANGES) {
    const item = document.createElement("button");
    item.type = "button";
    item.textContent = t(label);
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
  document.title = t("История и закладки — DuoPulse");
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
  title.textContent = t("История и закладки");
  searchEl = document.createElement("input");
  searchEl.type = "text";
  searchEl.className = "mgr-search";
  searchEl.placeholder = t("Поиск по истории и закладкам");
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
  tabs.append(sectionBtn("history", t("История")), sectionBtn("bookmarks", t("Закладки")));
  tabs.append(buildRangeMenu());

  chipsEl = document.createElement("div");
  chipsEl.className = "mgr-chips";
  chipsEl.hidden = true;
  groupbarEl = document.createElement("div");
  groupbarEl.className = "mgr-groupbar";
  groupbarEl.hidden = true;

  listEl = document.createElement("main");
  listEl.className = "mgr-list";

  moreWrap = document.createElement("footer");
  moreWrap.className = "mgr-more";
  moreBtn = document.createElement("button");
  moreBtn.type = "button";
  moreBtn.textContent = t("Показать ещё");
  moreBtn.addEventListener("click", () => void loadPage(true));
  totalEl = document.createElement("span");
  totalEl.className = "mgr-total";
  moreWrap.append(moreBtn, totalEl);

  errEl = document.createElement("div");
  errEl.className = "mgr-error";
  errEl.hidden = true;

  root.append(head, tabs, chipsEl, groupbarEl, errEl, listEl, moreWrap);
  document.body.append(root);

  // клики по записям: действие (★/✕/✎/папка) или переход; делегирование
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
      if (section === "history") deleteEntry(url);
      else void bridge.history.bookmarkRemove({ url }).then(reload).catch(showError);
      return;
    }
    if ((e.target as HTMLElement).closest(".act-edit")) {
      const b = bookmarks.find((m) => m.url === url);
      if (b) beginEdit(row, b);
      return;
    }
    if ((e.target as HTMLElement).closest(".act-groups")) {
      const b = bookmarks.find((m) => m.url === url);
      if (b) openGroupsMenu(row, b);
      return;
    }
    if ((e.target as HTMLElement).closest(".mgr-groups-menu")) return;
    openUrl(url, e.ctrlKey || e.metaKey);
  });
  listEl.addEventListener("auxclick", (e) => {
    if (e.button !== 1) return; // средняя кнопка — новая вкладка
    const row = (e.target as HTMLElement).closest<HTMLElement>(".mgr-entry");
    if (row?.dataset.url) openUrl(row.dataset.url, true);
  });

  // drag&drop: порядок внутри группы (режим «вручную») + перекладывание
  // между группами тягой на чип (карточка duopulse-099)
  listEl.addEventListener("dragstart", (e) => {
    if (!groupDragEnabled()) {
      e.preventDefault();
      return;
    }
    const row = (e.target as HTMLElement).closest<HTMLElement>(".mgr-entry");
    if (!row?.dataset.url) return;
    dragUrl = row.dataset.url;
    row.classList.add("dragging");
    e.dataTransfer?.setData("text/plain", dragUrl); // Firefox требует данных
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  });
  listEl.addEventListener("dragover", (e) => {
    if (!dragUrl || !dragEnabled()) return; // подсветка порядка — только manual
    const row = (e.target as HTMLElement).closest<HTMLElement>(".mgr-entry");
    if (!row || row.dataset.url === dragUrl) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    clearDropMarks();
    const after = e.clientY > row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
    row.classList.add(after ? "drop-after" : "drop-before");
  });
  listEl.addEventListener("drop", (e) => {
    if (!dragUrl || !dragEnabled()) return;
    const row = (e.target as HTMLElement).closest<HTMLElement>(".mgr-entry");
    if (!row) return;
    e.preventDefault();
    const after = row.classList.contains("drop-after");
    clearDropMarks();
    reorder(row, after);
    dragUrl = "";
  });
  listEl.addEventListener("dragend", () => {
    dragUrl = "";
    clearDropMarks();
    clearChipMarks();
    listEl.querySelector(".dragging")?.classList.remove("dragging");
  });
  // чипы групп — цели перекладывания: подсветка на пролёте, drop — перенос
  chipsEl.addEventListener("dragover", (e) => {
    if (!dragUrl) return;
    const chip = (e.target as HTMLElement).closest<HTMLElement>(".mgr-chip");
    const sel = chip ? chipSelOf(chip) : undefined;
    if (!chip || chip.classList.contains("mgr-chip-add") || sel === undefined) return;
    if (!validDropTarget(sel)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    clearChipMarks();
    chip.classList.add("drop-target");
  });
  chipsEl.addEventListener("dragleave", (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>(".mgr-chip");
    if (chip && !chip.contains(e.relatedTarget as Node | null)) {
      chip.classList.remove("drop-target");
    }
  });
  chipsEl.addEventListener("drop", (e) => {
    if (!dragUrl) return;
    const chip = (e.target as HTMLElement).closest<HTMLElement>(".mgr-chip");
    const sel = chip ? chipSelOf(chip) : undefined;
    if (sel === undefined || !validDropTarget(sel)) return;
    e.preventDefault();
    const url = dragUrl;
    dragUrl = "";
    clearChipMarks();
    listEl.querySelector(".dragging")?.classList.remove("dragging");
    void dropOnGroup(url, sel);
  });
  listEl.addEventListener("scroll", closeMenus, { passive: true });

  // закрытие меню диапазонов/групп кликом мимо
  window.addEventListener("mousedown", (e) => {
    if (!rangeMenu.hidden && !(e.target as HTMLElement).closest(".mgr-actions")) {
      rangeMenu.hidden = true;
    }
    if (!(e.target as HTMLElement).closest(".mgr-groups-menu") &&
        !(e.target as HTMLElement).closest(".act-groups")) {
      closeMenus();
    }
  }, true);

  syncTabs();
  void reload();
}

// модуль импортируется роутером src/main.ts — стартуем сразу
initManagerPage();
