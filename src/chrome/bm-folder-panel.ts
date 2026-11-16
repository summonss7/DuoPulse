// DuoPulse — панель-меню папки строки закладок (карточка duopulse-147).
// Заменяет нативное muda-меню (duopulse-143): панель-webview bmfolder
// (chrome_panel.rs) показывает содержимое группы — подгруппы и закладки
// с цветными бейджами-доменами (как чипы строки), а главное — умеет
// drag&drop: закладки меняются местами внутри папки (history.bookmark_move,
// первая перестановка переводит папку на ручной порядок — иначе сортировка
// по имени/дате скроет правку), закладку можно перетащить на подгруппу —
// она переложится в неё. Клик по подгруппе — спуск внутрь (хлебная крошка
// «‹ родитель» наверху), клик по закладке — переход активной вкладкой
// (средний клик — новая вкладка), после чего панель закрывается.
// duopulse-149: правый клик по закладке — инлайн-переименование прямо в
// строке (нативное меню bmchip живёт в UI-окне, panel-webview его события
// не получает); пустое имя разрешено — строка с одним бейджем.
// duopulse-160: правый клик — мини-меню «Переименовать… / Удалить закладку»
// (HTML внутри панели: события нативного меню сюда не доезжают, а жалоба
// была «только переименовывать»); drag&drop работает и через webview-границу:
// закладку можно утащить на папку строки (другую группу) и наоборот — чип
// строки бросается в открытую папку, перенос снимает группу-источник
// (payload своего MIME-типа, общий с bmbar).
// Группа — из ?group=<id> (передал открывший, ui_panel_open query).
import { bridge } from "../bridge";
import type { BookmarkGroupInfo, HistoryBookmark } from "../bridge";
import {
  applyFavicon,
  badgeHost,
  badgeHue,
  badgeLetter,
  chipView,
  BM_DRAG_MIME,
  isExternalBmDrag,
  parseDragPayload,
} from "./bmbar";
import { beginInlineRename } from "./bm-rename";
import { closePanel } from "./panel-window";
import { t } from "../i18n";

const err = (e: unknown): void => console.error("bm-folder-panel:", e);

/** Хост-панель в разметке (панельный режим index.html?panel=bmfolder). */
const panel = (): HTMLElement => document.getElementById("bmFolder") as HTMLElement;

/** Путь спуска: группы от открытой до текущей (последняя — на экране). */
let stack: number[] = [];

/** Порядок закладок панели после drag&drop (чистая, тестится): dragged
 * вынимается и вставляется на индекс at (0 = верх, клампится). */
export function panelReorder(urls: string[], dragged: string, at: number): string[] {
  const rest = urls.filter((u) => u !== dragged);
  const to = Math.max(0, Math.min(at, rest.length));
  rest.splice(to, 0, dragged);
  return rest;
}

/** Открыть панель: группа из query, обработчики + первый рендер (вызов из
 *  panel-boot; webview панели одноразовый — слушатели вешаются один раз). */
export function openBmFolderPanel(): void {
  const g = Number(new URLSearchParams(location.search).get("group"));
  if (!Number.isFinite(g)) return;
  stack = [g];
  initBmFolderPanel();
  void renderPanel();
}

/** Рендер содержимого текущей группы стека. */
async function renderPanel(): Promise<void> {
  const cur = stack[stack.length - 1];
  try {
    const { groups } = await bridge.history.groupList();
    const curGroup = groups.find((g) => g.id === cur);
    if (!curGroup) {
      // группу удалили со страницы управления — на уровень выше (или выход)
      stack.pop();
      if (stack.length === 0) {
        closePanel();
        return;
      }
      await renderPanel();
      return;
    }
    const kids = groups
      .filter((g) => g.parentId === cur)
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    const { bookmarks } = await bridge.history.bookmarkList({
      query: null,
      groupId: cur,
      offset: 0,
      limit: 500,
    });
    renderRows(curGroup, groups, kids, bookmarks);
  } catch (e) {
    err(e);
  }
}

/** Разметка панели: крошка-«назад», подгруппы, закладки. */
function renderRows(
  cur: BookmarkGroupInfo,
  groups: BookmarkGroupInfo[],
  kids: BookmarkGroupInfo[],
  bookmarks: HistoryBookmark[],
): void {
  const el = panel();
  el.replaceChildren();
  closeRowMenu(); // строки перестроились — меню прошлой строки уходит
  // имена для инлайн-правки (duopulse-149) — рендер уже без адреса-фолбэка
  bmTitleByUrl = new Map(bookmarks.map((b) => [b.url, b.title.trim()]));
  const parent = cur.parentId != null ? groups.find((g) => g.id === cur.parentId) : undefined;
  if (parent) {
    const back = document.createElement("button");
    back.type = "button";
    back.className = "bm-row bm-back";
    back.innerHTML =
      '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5 5.5 8l4.5 4.5"/></svg>';
    const label = document.createElement("span");
    label.className = "bm-label";
    label.textContent = parent.name;
    back.append(label);
    back.addEventListener("click", () => {
      stack.pop();
      void renderPanel();
    });
    el.append(back);
  }
  for (const k of kids) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "bm-row bm-sub";
    row.dataset.sub = String(k.id);
    row.innerHTML =
      '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M1.8 4.2c0-.6.5-1.1 1.1-1.1h3l1.4 1.6h5.8c.6 0 1.1.5 1.1 1.1v6.9c0 .6-.5 1.1-1.1 1.1H2.9c-.6 0-1.1-.5-1.1-1.1z"/></svg>';
    const label = document.createElement("span");
    label.className = "bm-label";
    label.textContent = k.name;
    const chev = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    chev.setAttribute("class", "bm-chev");
    chev.setAttribute("viewBox", "0 0 16 16");
    chev.setAttribute("width", "12");
    chev.setAttribute("height", "12");
    chev.setAttribute("fill", "none");
    chev.setAttribute("stroke", "currentColor");
    chev.setAttribute("stroke-width", "2");
    chev.setAttribute("stroke-linecap", "round");
    chev.setAttribute("stroke-linejoin", "round");
    chev.innerHTML = '<path d="M6 3.5 10.5 8 6 12.5"/>';
    row.append(label, chev);
    row.addEventListener("click", () => {
      stack.push(k.id);
      void renderPanel();
    });
    el.append(row);
  }
  if (kids.length > 0) {
    const sep = document.createElement("div");
    sep.className = "bm-sep";
    el.append(sep);
  }
  if (bookmarks.length === 0 && kids.length === 0) {
    const empty = document.createElement("div");
    empty.className = "bm-row bm-empty";
    empty.textContent = t("Папка пуста");
    el.append(empty);
    return;
  }
  for (const b of bookmarks) {
    const view = chipView(b); // подпись может быть пустой (duopulse-149)
    const host = badgeHost(b.url);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "bm-row";
    row.dataset.url = b.url;
    row.draggable = true; // перестановка внутри папки / перенос в подгруппу
    const ico = document.createElement("i");
    ico.className = "bm-ico";
    ico.textContent = badgeLetter(view.label, host);
    ico.style.background = `linear-gradient(145deg, hsl(${badgeHue(host || b.url)} 46% 46%), hsl(${badgeHue(host || b.url)} 46% 33%))`;
    applyFavicon(ico, b.url); // фавикон сайта поверх бейджа (duopulse-155)
    const label = document.createElement("span");
    label.className = "bm-label";
    label.textContent = view.label;
    const site = document.createElement("span");
    site.className = "bm-host";
    site.textContent = host || new URL(b.url).protocol.replace(":", "");
    row.append(ico, label, site);
    row.title = view.tooltip;
    el.append(row);
  }
}

/** Тянутая закладка (url) — маркеры вставки и подгруппы-цели. */
let dragUrl = "";
/** Имена закладок последнего рендера (стартовое значение input правки). */
let bmTitleByUrl = new Map<string, string>();

/** Открытое мини-меню строки (duopulse-160) — одно на панель. */
let rowMenu: HTMLElement | null = null;

/** Показать мини-меню строки закладки (duopulse-160): «Переименовать…» /
 * «Удалить закладку». Закрывается кликом мимо, Escape и любым выбором;
 * позиция клампится в границы панели (клип у webview). */
function showRowMenu(row: HTMLElement, url: string, x: number, y: number): void {
  closeRowMenu();
  const menu = document.createElement("div");
  menu.className = "bm-ctx";
  const rename = document.createElement("button");
  rename.type = "button";
  rename.textContent = t("Переименовать…");
  rename.addEventListener("click", () => {
    closeRowMenu();
    beginInlineRename({
      host: row,
      initial: bmTitleByUrl.get(url) ?? "",
      allowEmpty: true, // пустое имя — только бейдж (как чип-значок строки)
      ariaLabel: t("Переименовать закладку"),
      save: (title) => {
        void bridge.history
          .bookmarkUpdate({ url, title })
          .then(renderPanel)
          .catch((e2) => {
            err(e2);
            void renderPanel();
          });
      },
    });
  });
  const del = document.createElement("button");
  del.type = "button";
  del.className = "bm-ctx-danger";
  del.textContent = t("Удалить закладку");
  del.addEventListener("click", () => {
    closeRowMenu();
    void bridge.history
      .bookmarkRemove({ url })
      .then(renderPanel)
      .catch((e2) => {
        err(e2);
        void renderPanel();
      });
  });
  menu.append(rename, del);
  document.body.append(menu);
  // размер известен после вставки — клампим, чтобы меню не вышло за панель
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
  rowMenu = menu;
}

/** Закрыть мини-меню строки (безопасно при закрытом). */
function closeRowMenu(): void {
  rowMenu?.remove();
  rowMenu = null;
}

/** Обработчики панели: клики/средний клик, drag&drop (вешаются один раз —
 *  панель перерисовывает только детей). */
let inited = false;
export function initBmFolderPanel(): void {
  if (inited) return;
  inited = true;
  // клик мимо мини-меню и Escape закрывают его (duopulse-160); capture —
  // раньше обработчиков строк, но сами пункты меню клика не теряют
  document.addEventListener(
    "click",
    (e) => {
      if (rowMenu && !rowMenu.contains(e.target as Node)) closeRowMenu();
    },
    true,
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeRowMenu();
  });
  panel().addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("input")) return; // правка имени
    const row = (e.target as HTMLElement).closest<HTMLElement>(".bm-row[data-url]");
    const url = row?.dataset.url;
    if (url) {
      void bridge.nav
        .navigate({ url })
        .then(closePanel)
        .catch(err);
    }
  });
  // средний клик — новая вкладка (как по чипу строки)
  panel().addEventListener("auxclick", (e) => {
    if (e.button !== 1) return;
    if ((e.target as HTMLElement).closest("input")) return;
    const row = (e.target as HTMLElement).closest<HTMLElement>(".bm-row[data-url]");
    const url = row?.dataset.url;
    if (url) {
      e.preventDefault();
      void bridge.tabs
        .open({ url })
        .then(closePanel)
        .catch(err);
    }
  });
  // правый клик — мини-меню закладки (duopulse-160): «Переименовать…»
  // (инлайн, duopulse-149) и «Удалить закладку»; HTML-меню внутри панели —
  // события нативного меню хрома сюда не доезжают
  panel().addEventListener("contextmenu", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".bm-row[data-url]");
    if (!row || (e.target as HTMLElement).closest("input")) return;
    const url = row.dataset.url as string;
    e.preventDefault();
    showRowMenu(row, url, e.clientX, e.clientY);
  });
  panel().addEventListener("dragstart", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".bm-row[data-url]");
    const url = row?.dataset.url;
    if (!url) return;
    dragUrl = url;
    row?.classList.add("dragging");
    // payload для приёмников в ДРУГИХ webview (строка закладок): url +
    // текущая группа — источник, чтобы перенос снимал членство здесь
    e.dataTransfer?.setData(
      BM_DRAG_MIME,
      JSON.stringify({ url, group: stack[stack.length - 1] ?? null }),
    );
    e.dataTransfer?.setData("text/plain", url);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  });
  panel().addEventListener("dragover", (e) => {
    // внешний drag закладки (чип строки — другой webview, duopulse-160):
    // цель — подгруппа или сама папка (без позиции: чужой порядок не правим)
    const external =
      !dragUrl && !!e.dataTransfer && isExternalBmDrag([...e.dataTransfer.types]);
    if (!dragUrl && !external) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    clearMarks("insert");
    const sub = (e.target as HTMLElement).closest<HTMLElement>(".bm-sub");
    if (sub) {
      sub.classList.add("drop-target");
      return;
    }
    if (external) return;
    // маркер-вставка у первой строки ниже курсора (вертикальный список)
    const rows = [...panel().querySelectorAll<HTMLElement>(".bm-row[data-url]")];
    const next = rows.find((el) => {
      const r = el.getBoundingClientRect();
      return r.top + r.height / 2 > e.clientY;
    });
    (next ?? rows[rows.length - 1])?.classList.add(next ? "drop-before" : "drop-after");
  });
  panel().addEventListener("drop", (e) => {
    if (!dragUrl && !e.dataTransfer) return;
    const sub = (e.target as HTMLElement).closest<HTMLElement>(".bm-sub");
    // внешний drag (чип строки, duopulse-160): подгруппа — перенос в неё,
    // любое другое место панели — перенос в саму папку (в конец)
    if (!dragUrl) {
      const payload = parseDragPayload((m) => e.dataTransfer?.getData(m) ?? "");
      if (!payload) return;
      e.preventDefault();
      clearMarks();
      const target = sub ? Number(sub.dataset.sub) : (stack[stack.length - 1] ?? -1);
      if (Number.isFinite(target) && target >= 0)
        void moveBookmark(payload.url, target, payload.fromGroup);
      return;
    }
    e.preventDefault();
    const url = dragUrl;
    dragUrl = "";
    clearMarks();
    if (sub) {
      void moveBookmark(url, Number(sub.dataset.sub));
      return;
    }
    const rows = [...panel().querySelectorAll<HTMLElement>(".bm-row[data-url]")];
    const next = rows.find((el) => {
      const r = el.getBoundingClientRect();
      return r.top + r.height / 2 > e.clientY;
    });
    const rest = rows.map((el) => el.dataset.url as string).filter((u) => u !== url);
    // позиция в новом списке: перед next (после вынимания) либо в конец
    const at = next ? rest.indexOf(next.dataset.url as string) : rest.length;
    if (at >= 0) void reorderBookmark(url, at);
  });
  panel().addEventListener("dragend", () => {
    dragUrl = "";
    clearMarks();
  });
}

/** Снять подсветки: mark="insert" — только маркеры (каждый dragover). */
function clearMarks(mark: "insert" | "all" = "all"): void {
  for (const el of panel().querySelectorAll(".bm-row.drop-before, .bm-row.drop-after")) {
    el.classList.remove("drop-before", "drop-after");
  }
  if (mark === "all") {
    for (const el of panel().querySelectorAll(".bm-sub.drop-target")) {
      el.classList.remove("drop-target");
    }
    panel().querySelector(".bm-row.dragging")?.classList.remove("dragging");
  }
}

/** Переставить закладку внутри папки; ручной порядок — предусловие
 *  (иначе сортировка по имени/дате скроет правку), первая перестановка
 *  переводит папку на manual. */
async function reorderBookmark(url: string, at: number): Promise<void> {
  const gid = stack[stack.length - 1];
  try {
    const { groups } = await bridge.history.groupList();
    const g = groups.find((x) => x.id === gid);
    if (g && g.sortBy !== "manual") {
      await bridge.history.groupSetSort({ id: gid, sortBy: "manual" });
    }
    await bridge.history.bookmarkMove({ url, groupId: gid, position: at });
    await renderPanel();
  } catch (e) {
    err(e);
    await renderPanel();
  }
}

/** Переложить закладку в подгруппу (drop на строку подгруппы): членство в
 *  текущей папке снимается (перенос, как у чипа строки на папку). fromGroup
 *  известен у внешнего drags (чип строки, duopulse-160) — снимаем его. */
async function moveBookmark(
  url: string,
  target: number,
  fromGroup: number | null = null,
): Promise<void> {
  const gid = stack[stack.length - 1];
  try {
    const src = fromGroup ?? gid;
    if (src !== target) {
      await bridge.history.groupToggleBookmark({ url, groupId: src, on: false });
    }
    await bridge.history.groupToggleBookmark({ url, groupId: target, on: true });
    await renderPanel();
  } catch (e) {
    err(e);
    await renderPanel();
  }
}
