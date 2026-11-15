// DuoPulse — строка закладок под навбаром, как в Chrome (карточка
// duopulse-143): основные закладки (группа по умолчанию «Избранное» и
// без группы) — чипами с бейджем-буквой домена, группы-папки — кнопкой с
// пиктограммой. Пустое избранное — строка скрыта; показ/скрытие меняет
// высоту #app — Core сообщаем фактическую высоту (tabs.set_chrome_height),
// webview вкладок кладётся ниже.
// Обновление: старт, правки звёздочки (refreshBmBar из star.ts) и смена
// вкладок (tabs.updated — правки на странице управления и синк Aila
// подхватываются при первом же переключении).
// duopulse-151: подгруппы — папки на строке это корневые группы и дети
// группы по умолчанию; чип можно перетащить на папку — закладка
// перекладывается в неё (из «Избранного» уходит, как в Chrome).
// duopulse-147: перетаскивание мышкой — чипы меняются местами (порядок
// пишется в «Избранное» командой bmbar_reorder, безгрупповые чипы
// усыновляются группой), папки переставляются среди сестринских
// (group_reorder) или вкладываются в другую папку (group_move); меню
// папки — панель-webview bmfolder (chrome_panel.rs): богаче нативного
// меню (бейджи-домены, подсветки) и умеет drag&drop внутри папки.
import { listen } from "@tauri-apps/api/event";
import { bridge } from "../bridge";
import type { BookmarkGroupInfo, HistoryBookmark } from "../bridge";
import { groupTreeOrder, canGroupMoveTo } from "./groups-tree";
import { openPanel, closePanel } from "./panel-window";

const err = (e: unknown): void => console.error("bmbar:", e);

/** Строка в разметке (чистая модель выше не знает DOM — как update-bar). */
const bar = (): HTMLElement => document.getElementById("bmbar") as HTMLElement;

/** Модель строки: чипы — закладки группы по умолчанию (в её порядке) +
 * без группы; папки — группы бар-уровня (корневые и подгруппы «Избранного»)
 * с закладками или подгруппами. parentId папки — для перестановки среди
 * сестринских (duopulse-147). */
export interface BmBarModel {
  visible: boolean;
  chips: { url: string; title: string }[];
  folders: { id: number; name: string; parentId: number | null }[];
}

/** Чистая модель строки (тестится без DOM): группы + члены группы по
 * умолчанию + безгрупповые закладки. */
export function bmBarModel(
  groups: BookmarkGroupInfo[],
  defaultMembers: HistoryBookmark[],
  ungrouped: HistoryBookmark[],
): BmBarModel {
  const defId = groups.find((g) => g.isDefault)?.id ?? null;
  const folders = groupTreeOrder(groups)
    .filter(
      (g) =>
        !g.isDefault &&
        (g.parentId == null || g.parentId === defId) &&
        (g.count > 0 || groups.some((o) => o.parentId === g.id)),
    )
    .map((g) => ({ id: g.id, name: g.name, parentId: g.parentId ?? null }));
  const chip = (b: HistoryBookmark) => ({
    url: b.url,
    title: b.title.trim() || b.url,
  });
  const chips = [...defaultMembers.map(chip), ...ungrouped.map(chip)];
  return { visible: chips.length > 0 || folders.length > 0, chips, folders };
}

/** Новый порядок чипов после drag&drop (чистая, тестится): dragged
 * вынимается и вставляется перед beforeUrl (null — в конец). */
export function chipReorder(
  urls: string[],
  dragged: string,
  beforeUrl: string | null,
): string[] {
  if (beforeUrl === dragged) return urls.slice(); // перед самим собой — нет хода
  const rest = urls.filter((u) => u !== dragged);
  const at = beforeUrl === null ? rest.length : rest.indexOf(beforeUrl);
  rest.splice(at < 0 ? rest.length : at, 0, dragged);
  return rest;
}

/** Можно ли бросить папку dragged перед папкой before (перестановка среди
 * сестринских — тот же родитель; null — в конец своих сестёр). Чужой
 * родитель — нельзя: порядок строки следует дереву групп. */
export function folderReorderAllowed(
  folders: { id: number; parentId: number | null }[],
  dragged: number,
  before: number | null,
): boolean {
  const d = folders.find((f) => f.id === dragged);
  if (!d) return false;
  if (before === null) return true;
  const b = folders.find((f) => f.id === before);
  return !!b && b.parentId === d.parentId;
}

/** Цвет бейджа домена: hue из суммы кодов — у каждого сайта свой стабильный
 * приглушённый цвет (фавиконов в DuoPulse нет, бейдж-буква как в новых
 * вкладках платформ). */
export function badgeHue(host: string): number {
  let h = 0;
  for (let i = 0; i < host.length; i++) h = (h * 31 + host.charCodeAt(i)) % 360;
  return h;
}

/** Хост адреса для бейджа (без www). Не http/https (внутренние страницы
 * duopulse:// и т.п.) или не разобрался — пустая строка: бейдж красится
 * по самому адресу. */
export function badgeHost(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    return u.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Первая буква названия/хоста для бейджа. */
export function badgeLetter(title: string, host: string): string {
  const s = (title.trim() || host).replace(/^https?:\/\//, "");
  const ch = Array.from(s)[0];
  return ch ? ch.toUpperCase() : "•";
}

/** Сообщить Core фактическую высоту хрома (#app) — под неё кладутся
 * webview вкладок; CSS-переменную --chrome-h актуализируем для якорей
 * панелей (подсказки omnibox и т.п., panel-window.chromeHeight). */
function reportChromeHeight(): void {
  const h = document.getElementById("app")?.offsetHeight || 84;
  document.documentElement.style.setProperty("--chrome-h", `${h}px`);
  void bridge.tabs.setChromeHeight({ height: h }).catch(err);
}

/** Перерисовать строку по свежим данным Core. */
export async function refreshBmBar(): Promise<void> {
  try {
    const [{ groups }, ungRes] = await Promise.all([
      bridge.history.groupList(),
      bridge.history.bookmarkList({ query: null, groupId: -1, offset: 0, limit: 500 }),
    ]);
    // группы по умолчанию может не быть (молодой профиль) — чипы тогда
    // только из безгрупповых; null в groupId означал бы «все закладки»
    const defId = groups.find((g) => g.isDefault)?.id ?? null;
    const defMembers =
      defId !== null
        ? (await bridge.history.bookmarkList({ query: null, groupId: defId, offset: 0, limit: 500 })).bookmarks
        : [];
    const model = bmBarModel(groups, defMembers, ungRes.bookmarks);
    // для drag&drop чип→папка: перенос из «Избранного» убирает членство
    defGroupId = defId;
    defMemberUrls = new Set(defMembers.map((b) => b.url));
    groupsById = new Map(groups.map((g) => [g.id, g]));
    render(model);
    const el = bar();
    el.hidden = !model.visible;
    // offsetHeight после снятия hidden — в следующем кадре разметки
    requestAnimationFrame(reportChromeHeight);
  } catch (e) {
    err(e);
  }
}

/** Группа по умолчанию и её члены (семантика переноса чипа в папку). */
let defGroupId: number | null = null;
let defMemberUrls = new Set<string>();
/** Все группы (проверки переноса папок, canGroupMoveTo). */
let groupsById = new Map<number, BookmarkGroupInfo>();

/** Тянутый чип закладки (url) — для подсветки папок-целей. */
let dragUrl = "";
/** Тянутая папка (id группы) — перестановка/вложение (duopulse-147). */
let dragFolderId: number | null = null;

/** Папка, у которой открыта панель-меню (вторая.opena — закрыть). */
let openFolderPanelId: number | null = null;

/** Рендер модели в строку (кнопки-чипы + кнопки-папки). */
function render(model: BmBarModel): void {
  bar().replaceChildren();
  const chip = (b: { url: string; title: string }): HTMLButtonElement => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "bm-item";
    el.dataset.url = b.url;
    el.draggable = true; // перетаскивание: в папку и между чипами (duopulse-147)
    const host = badgeHost(b.url);
    const ico = document.createElement("i");
    ico.className = "bm-ico";
    ico.textContent = badgeLetter(b.title, host);
    ico.style.background = `linear-gradient(145deg, hsl(${badgeHue(host || b.url)} 46% 46%), hsl(${badgeHue(host || b.url)} 46% 33%))`;
    const label = document.createElement("span");
    label.className = "bm-label";
    label.textContent = b.title;
    el.append(ico, label);
    el.title = `${b.title}\n${b.url}`;
    return el;
  };
  const folder = (f: { id: number; name: string }, first: boolean): HTMLButtonElement => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = first ? "bm-item bm-folder bm-first" : "bm-item bm-folder";
    el.dataset.folder = String(f.id);
    el.draggable = true; // перестановка среди сестёрских и в другую папку
    el.innerHTML =
      '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M1.8 4.2c0-.6.5-1.1 1.1-1.1h3l1.4 1.6h5.8c.6 0 1.1.5 1.1 1.1v6.9c0 .6-.5 1.1-1.1 1.1H2.9c-.6 0-1.1-.5-1.1-1.1z"/></svg>';
    const label = document.createElement("span");
    label.className = "bm-label";
    label.textContent = f.name;
    el.append(label);
    el.title = f.name;
    return el;
  };
  const el = bar();
  for (const c of model.chips) el.append(chip(c));
  model.folders.forEach((f, i) => el.append(folder(f, i === 0)));
}

/** Открыть меню папки у кнопки — панель-webview bmfolder (duopulse-147):
 * бейджи закладок, drag&drop внутри папки. Повторный клик по той же папке
 * закрывает меню (тумблер, как у нативного). */
function openFolderMenu(btn: HTMLElement): void {
  const groupId = Number(btn.dataset.folder);
  if (!Number.isFinite(groupId)) return;
  if (openFolderPanelId === groupId) {
    openFolderPanelId = null;
    closePanel();
    return;
  }
  openFolderPanelId = groupId;
  const r = btn.getBoundingClientRect();
  // размер окна панели — по числу пунктов (подгруппы + закладки), как меню
  // Chrome: растёт со списком, но не выше окна; контент дальше скроллится
  const g = groupsById.get(groupId);
  const rows = 1 + (g?.count ?? 0);
  const h = Math.min(52 + rows * 32, Math.max(160, window.innerHeight - r.bottom - 10));
  openPanel(
    "bmfolder",
    Math.round(r.left),
    Math.round(r.bottom + 2),
    340,
    Math.round(h),
    false,
    `&group=${groupId}`,
  );
}

/** Инициализация строки: клики/средний клик, наведение папок, обновление
 * по tabs.updated (дебаунс — правки со страницы управления и синк
 * подхватываются первым переключением), drag&drop (duopulse-147). */
export function initBmBar(): void {
  bar().addEventListener("click", (e) => {
    const folder = (e.target as HTMLElement).closest<HTMLElement>(".bm-folder");
    if (folder) {
      if (hoverTimer !== null) window.clearTimeout(hoverTimer);
      openFolderMenu(folder);
      return;
    }
    const item = (e.target as HTMLElement).closest<HTMLElement>(".bm-item:not(.bm-folder)");
    const url = item?.dataset.url;
    if (url) void bridge.nav.navigate({ url }).catch(err);
  });
  // средний клик по чипу — новая вкладка (как на панели закладок Chrome)
  bar().addEventListener("auxclick", (e) => {
    if (e.button !== 1) return;
    const item = (e.target as HTMLElement).closest<HTMLElement>(".bm-item:not(.bm-folder)");
    const url = item?.dataset.url;
    if (url) {
      e.preventDefault();
      void bridge.tabs.open({ url }).catch(err);
    }
  });
  // наведение на папку (делегирование): открытие после паузы 250 мс —
  // пролёт мыши по бару папки не раскрывает (как меню Chrome); во время
  // drag&drop меню не открывается (курсор несёт чип/папку)
  bar().addEventListener("pointerover", (e) => {
    const folder = (e.target as HTMLElement).closest<HTMLElement>(".bm-folder");
    if (folder === hoverFolder) return;
    hoverFolder = folder;
    if (hoverTimer !== null) window.clearTimeout(hoverTimer);
    hoverTimer = null;
    if (folder && !dragUrl && dragFolderId === null) {
      hoverTimer = window.setTimeout(() => {
        hoverTimer = null;
        if (openFolderPanelId !== Number(folder.dataset.folder)) openFolderMenu(folder);
      }, 250);
    }
  });
  bar().addEventListener("pointerleave", () => {
    hoverFolder = null;
    if (hoverTimer !== null) {
      window.clearTimeout(hoverTimer);
      hoverTimer = null;
    }
  });
  // панель-меню закрылась (Escape, клик мимо) — тумблер папки сбрасывается
  void listen("chrome-panel-closed", () => {
    openFolderPanelId = null;
  });

  // --- drag&drop (duopulse-147) -------------------------------------------
  bar().addEventListener("dragstart", (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>(".bm-item");
    if (!item) return;
    const url = item.dataset.url;
    if (url) {
      dragUrl = url;
      item.classList.add("dragging");
      e.dataTransfer?.setData("text/plain", url);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      return;
    }
    const fid = item.dataset.folder;
    if (fid !== undefined) {
      dragFolderId = Number(fid);
      item.classList.add("dragging");
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    }
  });
  bar().addEventListener("dragover", (e) => {
    if (!dragUrl && dragFolderId === null) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const folder = (e.target as HTMLElement).closest<HTMLElement>(".bm-folder");
    clearDragMarks("insert");
    if (folder) {
      // на папке: чип — перенос в неё (duopulse-151), папка — вложение
      if ((dragUrl && folder.dataset.url === undefined) || dragFolderId !== null) {
        folder.classList.add("drop-target");
      }
      return;
    }
    // между пунктами: маркер-вставка у ближайшего правого соседа своего ряда
    const items = [...bar().querySelectorAll<HTMLElement>(".bm-item")];
    const next = items.find((el) => {
      const r = el.getBoundingClientRect();
      return r.left + r.width / 2 > e.clientX;
    });
    if (!next) {
      const last = items[items.length - 1];
      last?.classList.add("drop-after");
      return;
    }
    if (dragUrl && next.dataset.url !== undefined) next.classList.add("drop-before");
    if (dragFolderId !== null && next.dataset.folder !== undefined) {
      if (folderReorderAllowed(folderModel(), dragFolderId, Number(next.dataset.folder))) {
        next.classList.add("drop-before");
      }
    }
  });
  bar().addEventListener("drop", (e) => {
    if (!dragUrl && dragFolderId === null) return;
    e.preventDefault();
    const folder = (e.target as HTMLElement).closest<HTMLElement>(".bm-folder");
    const url = dragUrl;
    const fid = dragFolderId;
    if (folder && url) {
      // чип → папка: закладка перекладывается в группу папки (duopulse-151)
      clearDragMarks();
      dragUrl = "";
      void moveChipToFolder(url, Number(folder.dataset.folder));
      return;
    }
    if (folder && fid !== null) {
      // папка → папка: вложение (group_move), с проверками дерева
      clearDragMarks();
      dragFolderId = null;
      const target = Number(folder.dataset.folder);
      const g = [...groupsById.values()];
      if (canGroupMoveTo(g, fid, target)) {
        void bridge.history
          .groupMove({ id: fid, parentId: target })
          .then(refreshBmBar)
          .catch((er) => {
            err(er);
            void refreshBmBar();
          });
      }
      return;
    }
    // вставка между пунктами: ближайший правый сосед своего ряда
    const items = [...bar().querySelectorAll<HTMLElement>(".bm-item")];
    const next = items.find((el) => {
      const r = el.getBoundingClientRect();
      return r.left + r.width / 2 > e.clientX;
    });
    if (url) {
      const urls = items
        .filter((el) => el.dataset.url !== undefined)
        .map((el) => el.dataset.url as string);
      const beforeUrl = next?.dataset.url ?? null;
      const reordered = chipReorder(urls, url, beforeUrl);
      clearDragMarks();
      dragUrl = "";
      if (reordered.join("\n") !== urls.join("\n")) {
        void bridge.history
          .bmbarReorder({ urls: reordered })
          .then(refreshBmBar)
          .catch((er) => {
            err(er);
            void refreshBmBar();
          });
      }
      return;
    }
    if (fid !== null && next?.dataset.folder !== undefined) {
      const before = Number(next.dataset.folder);
      if (before !== fid && folderReorderAllowed(folderModel(), fid, before)) {
        clearDragMarks();
        dragFolderId = null;
        void bridge.history
          .groupReorder({ id: fid, beforeId: before })
          .then(refreshBmBar)
          .catch((er) => {
            err(er);
            void refreshBmBar();
          });
      }
    }
  });
  bar().addEventListener("dragend", () => {
    dragUrl = "";
    dragFolderId = null;
    clearDragMarks();
  });
  void refreshBmBar();
}

/** Папки строки как модель перестановки (parentId из последнего рендера). */
function folderModel(): { id: number; parentId: number | null }[] {
  return [...groupsById.values()]
    .filter((g) => !g.isDefault)
    .map((g) => ({ id: g.id, parentId: g.parentId ?? null }));
}

/** Снять подсветку переноса: mark="insert" — только маркеры-вставки
 * (каждый dragover), иначе всё (папки-цели, тянущийся пункт). */
function clearDragMarks(mark: "insert" | "all" = "all"): void {
  for (const el of bar().querySelectorAll(".bm-item.drop-before, .bm-item.drop-after")) {
    el.classList.remove("drop-before", "drop-after");
  }
  if (mark === "all") {
    for (const f of bar().querySelectorAll(".bm-folder.drop-target")) {
      f.classList.remove("drop-target");
    }
    bar().querySelector(".bm-item.dragging")?.classList.remove("dragging");
  }
}

/** Переложить закладку в группу папки (drop чипа на папку): членство в
 *  «Избранном» снимается (перенос, не копия), цель добавляется идемпотентно. */
async function moveChipToFolder(url: string, groupId: number): Promise<void> {
  try {
    if (defGroupId !== null && defGroupId !== groupId && defMemberUrls.has(url)) {
      await bridge.history.groupToggleBookmark({ url, groupId: defGroupId, on: false });
    }
    await bridge.history.groupToggleBookmark({ url, groupId, on: true });
    await refreshBmBar();
  } catch (e) {
    err(e);
    await refreshBmBar();
  }
}

/** Папка под курсором (делегированный hover) и таймер открытия. */
let hoverFolder: HTMLElement | null = null;
let hoverTimer: number | null = null;
