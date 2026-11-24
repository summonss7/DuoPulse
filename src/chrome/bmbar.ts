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
// duopulse-149: правый клик по чипу/папке — нативное меню
// «Переименовать…» (chrome_menu.rs, kind bmchip/bmgroup) и инлайн-правка;
// закладке можно оставить пустое имя — чип-значок без подписи, как в
// Chrome (больше сайтов влезает в строку).
// duopulse-160: чипу в меню добавлено «Удалить» (bookmark_remove); правый
// клик по пустому месту строки — «Новая группа…» (пустые папки теперь
// видны на строке — иначе новую группу не видно и некуда перетаскивать);
// drag&drop закладки работает и ЧЕРЕЗ webview-границу (строка ↔ панель
// папки): свой MIME-тип несёт url + группу-источник, text/plain — фолбэк.
// duopulse-163: папке в меню добавлено «Удалить группу» (group_remove — с
// подгруппами, закладки остаются, как на странице управления); позиция
// нативного меню — клиентская точка окна (фикс «на три сантиметра ниже
// клика» — chrome_menu.rs раньше передавал экранные координаты).
// duopulse-219: правый клик по пустому месту — ещё и «Сортировать…»
// (алфавит/обратный/по дате добавления; порядок пишет bmbar_reorder),
// меню папки — режим живой сортировки группы (group_set_sort).
// duopulse-242: дроп папки на папку — КРАЕВЫЕ зоны (левая треть «рядом
// слева», правая «рядом справа», середина «внутрь») — раньше вся папка
// считалась «внутрь», и «поставить рядом» вкладывало папку внутрь соседки
// (жалоба Артёма: AI «левее» Network зашла внутрь, назад не достать); папка
// за правым краем последнего пункта — в конец ряда (дроп «в пустоту» молчал);
// папки перетаскиваются и МЕЖДУ webview (BM_FOLDER_MIME: строка ↔ панель
// папки), dragend обновляет строку — кросс-webview-переносы не оставляют
// устаревшего рендера.
import { listen } from "@tauri-apps/api/event";
import { bridge } from "../bridge";
import type { BookmarkGroupInfo, HistoryBookmark } from "../bridge";
import { groupTreeOrder, canGroupMoveTo } from "./groups-tree";
import { openPanel, closePanel } from "./panel-window";
import { openOverlayMenu, onOverlayMenuAction } from "./overlay-menu";
import { beginInlineRename } from "./bm-rename";
import { t } from "../i18n";

const err = (e: unknown): void => console.error("bmbar:", e);

/** Строка в разметке (чистая модель выше не знает DOM — как update-bar). */
const bar = (): HTMLElement => document.getElementById("bmbar") as HTMLElement;

/** Модель строки: чипы — закладки группы по умолчанию (в её порядке) +
 * без группы; папки — группы бар-уровня (корневые и подгруппы «Избранного»),
 * в том числе пустые (duopulse-160: папка, созданная правым кликом по
 * строке, сразу видна — в неё можно перетащить закладки, как в Chrome).
 * parentId папки — для перестановки среди сестринских (duopulse-147). */
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
    .filter((g) => !g.isDefault && (g.parentId == null || g.parentId === defId))
    .map((g) => ({ id: g.id, name: g.name, parentId: g.parentId ?? null }));
  const chip = (b: HistoryBookmark) => ({
    url: b.url,
    title: b.title.trim(),
  });
  const chips = [...defaultMembers.map(chip), ...ungrouped.map(chip)];
  return { visible: chips.length > 0 || folders.length > 0, chips, folders };
}

/** Вид чипа для рендера (чистая, тестится): подпись может быть пустой —
 * duopulse-149 разрешает закладку без названия (только значок, как в
 * Chrome); подсказка пустого чипа — один адрес. */
export function chipView(b: {
  url: string;
  title: string;
}): { label: string; iconOnly: boolean; tooltip: string } {
  const label = b.title.trim();
  return {
    label,
    iconOnly: label === "",
    tooltip: label ? `${label}\n${b.url}` : b.url,
  };
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

/** Свой MIME-тип drag-слоя закладок (duopulse-160): перенос между webview
 * (строка ↔ панель папки) идёт через системный OLE-drag — text/plain
 * доезжает, но группу-источник знает только этот payload. */
export const BM_DRAG_MIME = "application/x-duopulse-bm";

/** Режим сортировки чипов строки (duopulse-219, «Сортировать…» в контекстном
 * меню строки): алфавит / обратный алфавит / дата добавления новые-старые
 * первыми. Порядок пишет bmbar_reorder (безгрупповые чипы усыновляются
 * группой по умолчанию — та же семантика, что у drag&drop duopulse-147). */
export type BarSortMode = "title" | "title_desc" | "added" | "added_asc";

/** Urls чипов строки в порядке режима (чистая, тестится): состав — как у
 * bmBarModel (группа по умолчанию + безгрупповые), тайбрейк — url, порядок
 * устойчив. localeCompare с base — «без учёта регистра», как COLLATE NOCASE. */
export function barSortUrls(
  defaultMembers: HistoryBookmark[],
  ungrouped: HistoryBookmark[],
  mode: BarSortMode,
): string[] {
  const all = [...defaultMembers, ...ungrouped];
  const byUrl = (a: HistoryBookmark, b: HistoryBookmark): number =>
    a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
  const byTitle = (a: HistoryBookmark, b: HistoryBookmark): number =>
    a.title.trim().localeCompare(b.title.trim(), undefined, { sensitivity: "base" }) || byUrl(a, b);
  if (mode === "title") all.sort(byTitle);
  else if (mode === "title_desc") all.sort((a, b) => byTitle(b, a));
  else if (mode === "added") all.sort((a, b) => b.addedAt - a.addedAt || byUrl(a, b));
  else all.sort((a, b) => a.addedAt - b.addedAt || byUrl(a, b));
  return all.map((b) => b.url);
}

/** Похоже ли на drag закладки (чистая, тестится): свой тип или просто
 * текст — External-ветка dragover/drop строки и панели папки. */
export function isExternalBmDrag(types: readonly string[]): boolean {
  return types.includes(BM_DRAG_MIME) || types.includes("text/plain");
}

/** Свой MIME-тип drag-слоя ПАПОК (duopulse-242): закладки ходят между webview
 *  (строка ↔ панель папки) под BM_DRAG_MIME, но в dragover данные читать
 *  нельзя (только types) — приёмник не отличит закладку от папки. Папки
 *  ходят под отдельным типом: строка заранее показывает краевые зоны
 *  («рядом»), а не только «внутрь». */
export const BM_FOLDER_MIME = "application/x-duopulse-bm-folder";

/** Похоже ли на drag ПАПКИ (чистая, тестится): External-ветка dragover/drop
 *  строки и панели папки. */
export function isExternalFolderDrag(types: readonly string[]): boolean {
  return types.includes(BM_FOLDER_MIME);
}

/** Payload дропа ПАПКИ (чистая, тестится): id перетаскиваемой группы;
 *  чужой/битый payload — null, дроп игнорируется. */
export function parseDragFolder(get: (mime: string) => string): number | null {
  try {
    const v = JSON.parse(get(BM_FOLDER_MIME)) as { folder?: unknown };
    return typeof v.folder === "number" && Number.isFinite(v.folder) ? v.folder : null;
  } catch {
    return null;
  }
}

/** Зона дропа по краям цели (чистая, тестится, duopulse-242): <0.3 длины —
 *  «до цели», >0.7 — «после», середина — «внутрь». Жалоба Артёма: весь
 *  диапазон над папкой считался «внутрь» — «хотел поставить рядом, а она
 *  зашла внутрь»; теперь края дают вставку рядом, как в Chrome. */
export function dropEdge(offset: number, size: number): "before" | "into" | "after" {
  if (size <= 0) return "into";
  const rel = offset / size;
  if (rel < 0.3) return "before";
  return rel > 0.7 ? "after" : "into";
}

/** Куда ставится перетаскиваемая папка при дропе на папку-цель (чистая,
 *  тестится, duopulse-242): «внутрь» — цель родителем (позиция в конец);
 *  края — родитель ЦЕЛИ и место рядом с ней (after — перед следующей
 *  сестринской, последняя — в конец). Чужой родитель не отсекается: путь
 *  «перенос под родителя → перестановка» собирает вызов drop. */
export function folderPlacement(
  zone: "before" | "into" | "after",
  targetParent: number | null,
  siblings: readonly number[],
  target: number,
): { parent: number | null; beforeId: number | null } {
  if (zone === "into") return { parent: target, beforeId: null };
  const at = siblings.indexOf(target);
  if (zone === "before") return { parent: targetParent, beforeId: at >= 0 ? target : null };
  const next = at >= 0 ? siblings[at + 1] : undefined;
  return { parent: targetParent, beforeId: next ?? null };
}

/** Payload дропа закладки: url + группа-источник (null — источник не
 * известен: фолбэк text/plain, снимаем членство только по догадке). */
export interface DragPayload {
  url: string;
  fromGroup: number | null;
}

/** Разобрать payload дропа (чистая, тестится): свой MIME — url и группа-
 * источник; иначе text/plain-адрес без источника. Не-URL (произвольный
 * выделенный текст) — null, дроп игнорируется. */
export function parseDragPayload(get: (mime: string) => string): DragPayload | null {
  const raw = get(BM_DRAG_MIME);
  if (raw) {
    try {
      const v = JSON.parse(raw) as { url?: unknown; group?: unknown };
      if (typeof v.url === "string" && looksLikeUrl(v.url)) {
        return {
          url: v.url,
          fromGroup: typeof v.group === "number" ? v.group : null,
        };
      }
    } catch {
      // не JSON — ниже фолбэк text/plain
    }
  }
  const url = get("text/plain").trim();
  return looksLikeUrl(url) ? { url, fromGroup: null } : null;
}

/** Строка разбирается как абсолютный адрес (схема любые, не только web). */
const looksLikeUrl = (s: string): boolean => {
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
};

/** Имя новой группы, не конфликтующее с существующими (duopulse-160):
 * group_add отклоняет дубликаты — «Новая группа», «Новая группа (2)», …
 * Регистр не важен — как проверка в Core (WHERE name = ?1). */
export function uniqueGroupName(base: string, existing: readonly string[]): string {
  const taken = new Set(existing.map((s) => s.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const n = `${base} (${i})`;
    if (!taken.has(n.toLowerCase())) return n;
  }
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

/** Фавиконы этого сеанса (duopulse-161): host (badgeHost — http/https без
 * www; "" — внутренние страницы и мусор, без запроса к Core) → data-URL;
 * позитив кэша Core дублируется в UI — рендеры строки частые, IPC ни к
 * чему. Негатив не запоминаем: Core держит его в SQLite 7 дней, повторный
 * вызов дёшев. */
const favMemo = new Map<string, string>();
/** Идущие запросы фавикона: строка перерисовывается часто, дедуп в полёте
 * не плодит параллельные фети одного хоста. */
const favInflight = new Map<string, Promise<string | null>>();

/** Попросить у Core фавикон хоста (кэш → фетч в фоне), без дублей в полёте. */
function faviconOf(host: string, url: string): Promise<string | null> {
  const memo = favMemo.get(host);
  if (memo) return Promise.resolve(memo);
  let p = favInflight.get(host);
  if (!p) {
    p = bridge.history
      .favicon({ url })
      .then((r) => {
        if (r.icon) favMemo.set(host, r.icon);
        return r.icon ?? null;
      })
      .catch(() => null)
      .finally(() => favInflight.delete(host));
    favInflight.set(host, p);
  }
  return p;
}

/** Показать фавикон сайта в значке чипа/строки (duopulse-161): Core разбирает
 * `<link rel=icon>` в HTML страницы (фолбэки /favicon.ico, /apple-touch-icon)
 * и отдаёт data-URL — покрывает сайты без корневого .ico, которых не видел
 * наивный img src=/favicon.ico (duopulse-155). <img> поверх бейджа-буквы;
 * загрузился — бейдж гасится (буква и градиент), иконки нет — бейдж, как
 * раньше. Кэш — в профиле (Core), повторные рендеры без сети. */
export function applyFavicon(ico: HTMLElement, url: string): void {
  const host = badgeHost(url);
  if (!host) return;
  void faviconOf(host, url).then((icon) => {
    // строка могла перерисоваться, пока Core фетчил
    if (!icon || !ico.isConnected) return;
    const img = document.createElement("img");
    img.className = "bm-fav";
    img.alt = "";
    img.decoding = "async";
    img.addEventListener("load", () => {
      ico.classList.add("has-fav");
      ico.style.background = ""; // градиент-подложка бейджа не мешает иконке
    });
    img.addEventListener("error", () => img.remove());
    img.src = icon;
    ico.append(img);
  });
}

/** Высота панели папки по содержимому (duopulse-155): точная — по числу
 * строк разметки (крошка 26px, строки 30px, разделитель 11px, паддинги 12,
 * зазоры 1px), панель без пустого поля внизу. Раньше оценка «52+строк×32»
 * с полом 160px оставляла до ~120px пустоты (жалоба Артёма). */
export function bmFolderPanelHeight(back: boolean, kids: number, bookmarks: number): number {
  const rows = (back ? 1 : 0) + kids + (bookmarks > 0 || kids > 0 ? bookmarks : 1);
  const sep = kids > 0 && bookmarks > 0 ? 1 : 0;
  const children = rows + sep;
  return 12 + (back ? 26 : 0) + (rows - (back ? 1 : 0)) * 30 + sep * 11 + (children - 1);
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
    // для сортировки строки (duopulse-219): сырые списки с added_at и текущий
    // порядок чипов (пропуск no-op записи, когда порядок уже целевой)
    sortDefMembers = defMembers;
    sortUngrouped = ungRes.bookmarks;
    chipUrlsOrder = model.chips.map((c) => c.url);
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
/** Сырые списки строки и текущий порядок чипов (сортировка duopulse-219). */
let sortDefMembers: HistoryBookmark[] = [];
let sortUngrouped: HistoryBookmark[] = [];
let chipUrlsOrder: string[] = [];
/** Имена чипов последнего рендера (стартовое значение input правки). */
let chipTitleByUrl = new Map<string, string>();

/** Тянутый чип закладки (url) — для подсветки папок-целей. */
let dragUrl = "";
/** Тянутая папка (id группы) — перестановка/вложение (duopulse-147). */
let dragFolderId: number | null = null;

/** Папка, у которой открыта панель-меню (вторая.opena — закрыть). */
let openFolderPanelId: number | null = null;

/** Рендер модели в строку (кнопки-чипы + кнопки-папки). */
function render(model: BmBarModel): void {
  bar().replaceChildren();
  // чистые имена для инлайн-правки (duopulse-149): рендер уже без адреса-
  // фолбэка, input стартует с сохранённого имени (в т.ч. пустого)
  chipTitleByUrl = new Map(model.chips.map((c) => [c.url, c.title]));
  const chip = (b: { url: string; title: string }): HTMLButtonElement => {
    const view = chipView(b);
    const el = document.createElement("button");
    el.type = "button";
    el.className = view.iconOnly ? "bm-item bm-icon-only" : "bm-item";
    el.dataset.url = b.url;
    el.draggable = true; // перетаскивание: в папку и между чипами (duopulse-147)
    const host = badgeHost(b.url);
    const ico = document.createElement("i");
    ico.className = "bm-ico";
    ico.textContent = badgeLetter(view.label, host);
    ico.style.background = `linear-gradient(145deg, hsl(${badgeHue(host || b.url)} 46% 46%), hsl(${badgeHue(host || b.url)} 46% 33%))`;
    applyFavicon(ico, b.url); // фавикон сайта, не вышел — бейдж-буква (155)
    el.append(ico);
    if (!view.iconOnly) {
      const label = document.createElement("span");
      label.className = "bm-label";
      label.textContent = view.label;
      el.append(label);
    }
    el.title = view.tooltip;
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
  // высота панели — точная по содержимому (duopulse-155): подгруппы и счёт
  // прямых закладок известны из group_list, крошка — если папка вложенная;
  // сверху ограничена окном (глубокие папки скроллятся внутри, как раньше)
  const g = groupsById.get(groupId);
  const kids = g ? [...groupsById.values()].filter((x) => x.parentId === groupId).length : 0;
  const contentH = bmFolderPanelHeight(g?.parentId != null, kids, g?.count ?? 0);
  const h = Math.min(contentH, Math.max(60, window.innerHeight - r.bottom - 10));
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
    if ((e.target as HTMLElement).closest("input")) return; // правка имени
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
    if ((e.target as HTMLElement).closest("input")) return;
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

  // --- переименование (duopulse-149) / удаление и новая группа (duopulse-160) ---
  // правый клик по чипу/папке — нативное меню «Переименовать…» + «Удалить»
  // (закладке — «Удалить», папке — «Удалить группу», duopulse-163; адрес/ид
  // группы кодируется в id пункта, снапшот не нужен); правый клик по пустому
  // месту строки — «Новая группа…»
  bar().addEventListener("contextmenu", (e) => {
    if ((e.target as HTMLElement).closest("input")) return;
    const item = (e.target as HTMLElement).closest<HTMLElement>(".bm-item");
    if (!item) {
      e.preventDefault();
      openOverlayMenu("bmbar", e.clientX, e.clientY, {});
      return;
    }
    e.preventDefault();
    const url = item.dataset.url;
    if (url !== undefined) {
      openOverlayMenu("bmchip", e.clientX, e.clientY, { url });
      return;
    }
    const fid = item.dataset.folder;
    if (fid !== undefined)
      openOverlayMenu("bmgroup", e.clientX, e.clientY, { id: Number(fid) });
  });
  onOverlayMenuAction((a) => {
    if (a.menu === "bmchip" && a.act === "rename" && typeof a.url === "string" && a.url)
      beginChipRename(a.url);
    else if (a.menu === "bmchip" && a.act === "delete" && typeof a.url === "string" && a.url)
      deleteChip(a.url);
    else if (a.menu === "bmgroup" && a.act === "rename" && typeof a.groupId === "number")
      beginFolderRename(a.groupId);
    else if (a.menu === "bmgroup" && a.act === "delete" && typeof a.groupId === "number")
      deleteFolder(a.groupId);
    else if (a.menu === "bmbar" && a.act === "newgroup") createGroupFromBar();
    // duopulse-219: сортировка чипов строки (bmbar:sort) и живая сортировка
    // папки (bmgroup:sort — режим группы, панель папки следует сама)
    else if (a.menu === "bmbar" && a.act === "sort" && typeof a.sortBy === "string")
      sortBarChips(a.sortBy as BarSortMode);
    else if (a.menu === "bmgroup" && a.act === "sort" && typeof a.groupId === "number" && typeof a.sortBy === "string")
      void bridge.history
        .groupSetSort({ id: a.groupId, sortBy: a.sortBy })
        .then(refreshBmBar)
        .catch((e) => {
          err(e);
          void refreshBmBar();
        });
  });

  // --- drag&drop (duopulse-147) -------------------------------------------
  bar().addEventListener("dragstart", (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>(".bm-item");
    if (!item) return;
    const url = item.dataset.url;
    if (url) {
      dragUrl = url;
      item.classList.add("dragging");
      // payload для приёмников в ДРУГИХ webview (панель папки): url +
      // группа-источник, чтобы перенос снимал членство там, где чип жил
      e.dataTransfer?.setData(BM_DRAG_MIME, JSON.stringify({ url, group: defMemberUrls.has(url) ? defGroupId : null }));
      e.dataTransfer?.setData("text/plain", url);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      return;
    }
    const fid = item.dataset.folder;
    if (fid !== undefined) {
      dragFolderId = Number(fid);
      item.classList.add("dragging");
      // payload для приёмников в ДРУГИХ webview (панель папки, duopulse-242):
      // id папки — приёмник знает форму подсветки по MIME-типу заранее
      e.dataTransfer?.setData(BM_FOLDER_MIME, JSON.stringify({ folder: dragFolderId }));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    }
  });
  bar().addEventListener("dragover", (e) => {
    // внешний drag (панель папки — другой webview): закладка (duopulse-160)
    // ходит только в папку-цель; папка (duopulse-242) — как своя: краевые
    // зоны «рядом»/«внутрь» на папках и выход на уровень строки
    const extBm =
      !dragUrl &&
      dragFolderId === null &&
      !!e.dataTransfer &&
      isExternalBmDrag([...e.dataTransfer.types]);
    const extFolder =
      !dragUrl &&
      dragFolderId === null &&
      !!e.dataTransfer &&
      isExternalFolderDrag([...e.dataTransfer.types]);
    if (!dragUrl && dragFolderId === null && !extBm && !extFolder) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const folder = (e.target as HTMLElement).closest<HTMLElement>(".bm-folder");
    clearDragMarks("insert");
    if (folder) {
      const folderId = Number(folder.dataset.folder);
      // ПАПКА над папкой: краевые зоны (duopulse-242) — левая треть «рядом
      // слева», правая «рядом справа» (маркер-вставка), середина — вложение
      // (подсветка); подсветки честные: показываем только то, что сработает
      // (внешнюю папку в dragover не проверить — данных нет, показываем
      // оптимистично, drop сам валидирует и молча не сработает)
      if (dragFolderId !== null || extFolder) {
        const r = folder.getBoundingClientRect();
        const zone = dropEdge(e.clientX - r.left, r.width);
        const target = groupsById.get(folderId);
        const targetParent = target?.parentId ?? null;
        const own = siblingsOfParent(targetParent).map((g) => g.id);
        const place = folderPlacement(zone, targetParent, own, folderId);
        const dragParent =
          dragFolderId !== null ? groupsById.get(dragFolderId)?.parentId ?? null : null;
        const sameParent = extFolder || dragParent === targetParent;
        if (zone === "into" || !sameParent) {
          const ok =
            extFolder || canGroupMoveTo([...groupsById.values()], dragFolderId as number, place.parent);
          if (ok) folder.classList.add("drop-target");
        } else if (place.beforeId !== null && place.beforeId !== dragFolderId) {
          folder.classList.add(zone === "before" ? "drop-before" : "drop-after");
        }
        return;
      }
      // ЧИП (свой или внешний) над папкой — перенос в неё (duopulse-151):
      // чипы между папками не ставятся (порядок строки — чипы, затем папки)
      if (dragUrl || extBm) folder.classList.add("drop-target");
      return;
    }
    if (extBm) return;
    // между пунктами: маркер-вставка у ближайшего правого соседа своего ряда
    const items = [...bar().querySelectorAll<HTMLElement>(".bm-item")];
    const next = items.find((el) => {
      const r = el.getBoundingClientRect();
      return r.left + r.width / 2 > e.clientX;
    });
    if (!next) {
      // правее последнего пункта: папка — в конец ряда (duopulse-242), чип —
      // маркер после последнего чипа (в конец чипов, до первой папки)
      const last = items[items.length - 1];
      if (dragUrl && last?.dataset.folder !== undefined) {
        const lastChip = [...items].reverse().find((el) => el.dataset.url !== undefined);
        lastChip?.classList.add("drop-after");
      } else {
        last?.classList.add("drop-after");
      }
      return;
    }
    if (dragUrl && next.dataset.url !== undefined) next.classList.add("drop-before");
    if (dragUrl && next.dataset.folder !== undefined) {
      // курсор между чипами и папками: чип встанет в конец чипов — маркер
      // после последнего чипа (duopulse-242, раньше подсветки не было вовсе)
      const lastChip = [...items].reverse().find((el) => el.dataset.url !== undefined);
      lastChip?.classList.add("drop-after");
    }
    if (dragFolderId !== null && next.dataset.folder !== undefined) {
      if (folderReorderAllowed(folderModel(), dragFolderId, Number(next.dataset.folder))) {
        next.classList.add("drop-before");
      }
    }
    if (extFolder && next.dataset.folder !== undefined) {
      next.classList.add("drop-before");
    }
  });
  bar().addEventListener("drop", (e) => {
    // внешний drag закладки (панель папки → строка, duopulse-160): только
    // в папку-цель — payload с группой-источником либо text/plain-фолбэк
    if (!dragUrl && dragFolderId === null) {
      if (!e.dataTransfer) return;
      const folder = (e.target as HTMLElement).closest<HTMLElement>(".bm-folder");
      const payload = parseDragPayload((m) => e.dataTransfer?.getData(m) ?? "");
      const extFolderId = isExternalFolderDrag([...e.dataTransfer.types])
        ? parseDragFolder((m) => e.dataTransfer?.getData(m) ?? "")
        : null;
      if (extFolderId !== null && folder) {
        // внешний drag ПАПКИ (панель → строка, duopulse-242): та же механика
        // краевых зон, что у своей папки — «рядом» или «внутрь»
        e.preventDefault();
        clearDragMarks();
        const folderId = Number(folder.dataset.folder);
        const r = folder.getBoundingClientRect();
        const zone = dropEdge(e.clientX - r.left, r.width);
        const target = groupsById.get(folderId);
        const targetParent = target?.parentId ?? null;
        const own = siblingsOfParent(targetParent).map((g) => g.id);
        void placeFolder(extFolderId, folderPlacement(zone, targetParent, own, folderId));
        return;
      }
      if (extFolderId !== null) {
        // внешняя папка на ФОН строки (мимо папок) — вынос на уровень строки
        // (root): главный жест «забрать папку из вложенности» (duopulse-242)
        e.preventDefault();
        clearDragMarks();
        void placeFolder(extFolderId, { parent: null, beforeId: null });
        return;
      }
      if (!folder || !payload) return;
      e.preventDefault();
      clearDragMarks();
      void moveChipToFolder(payload.url, Number(folder.dataset.folder), payload.fromGroup);
      return;
    }
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
      // папка → папка (duopulse-242): краевые зоны — «рядом слева/справа»
      // или «внутрь» (group_move), с проверками дерева
      clearDragMarks();
      dragFolderId = null;
      const folderId = Number(folder.dataset.folder);
      const r = folder.getBoundingClientRect();
      const zone = dropEdge(e.clientX - r.left, r.width);
      const target = groupsById.get(folderId);
      const targetParent = target?.parentId ?? null;
      const own = siblingsOfParent(targetParent).map((g) => g.id);
      void placeFolder(fid, folderPlacement(zone, targetParent, own, folderId));
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
      return;
    }
    if (fid !== null && !next) {
      // дроп правее последнего пункта — папка в конец своего ряда
      // (duopulse-242: раньше дроп «в пустоту» молча ничего не делал)
      clearDragMarks();
      dragFolderId = null;
      void bridge.history
        .groupReorder({ id: fid, beforeId: null })
        .then(refreshBmBar)
        .catch((er) => {
          err(er);
          void refreshBmBar();
        });
    }
  });
  bar().addEventListener("dragend", () => {
    dragUrl = "";
    dragFolderId = null;
    clearDragMarks();
    // дроп мог упасть в ДРУГОЙ webview (панель папки) и переложить чип/папку
    // — строка обновится сама по своему drop; здесь страхуемся от устаревания
    // после кросс-webview-переносов (duopulse-242)
    void refreshBmBar();
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
 *  группе-источнике снимается (перенос, не копия), цель добавляется
 *  идемпотентно. fromGroup известен у внешнего drags (панель папки,
 *  duopulse-160); свой чип — «Избранное», если он его член. */
async function moveChipToFolder(
  url: string,
  groupId: number,
  fromGroup: number | null = null,
): Promise<void> {
  try {
    const src = fromGroup ?? (defMemberUrls.has(url) ? defGroupId : null);
    if (src !== null && src !== groupId) {
      await bridge.history.groupToggleBookmark({ url, groupId: src, on: false });
    }
    await bridge.history.groupToggleBookmark({ url, groupId, on: true });
    await refreshBmBar();
  } catch (e) {
    err(e);
    await refreshBmBar();
  }
}

/** Удалить закладку (menu-action bmchip:delete, duopulse-160): команда
 *  идемпотентна — повторный клик по уже удалённой не ошибки. */
function deleteChip(url: string): void {
  void bridge.history
    .bookmarkRemove({ url })
    .then(refreshBmBar)
    .catch((e) => {
      err(e);
      void refreshBmBar();
    });
}

/** Удалить группу-папку строки (menu-action bmgroup:delete, duopulse-163):
 *  Core сносит группу с подгруппами, закладки остаются без членства — как
 *  «Удалить группу (с подгруппами)» страницы управления. Открытую панель
 *  этой папки закрываем — её данные устарели в момент удаления. */
function deleteFolder(id: number): void {
  if (openFolderPanelId === id) {
    openFolderPanelId = null;
    closePanel();
  }
  void bridge.history
    .groupRemove({ id })
    .then(refreshBmBar)
    .catch((e) => {
      err(e);
      void refreshBmBar();
    });
}

/** Создать группу правым кликом по строке (bmbar:newgroup, duopulse-160):
 * имя уникальное (счётчик-суффикс), папка пустая, но видна на строке —
 * сразу инлайн-правка имени (Enter — сохранить, Escape — оставить как есть). */
function createGroupFromBar(): void {
  void (async () => {
    try {
      const { groups } = await bridge.history.groupList();
      const name = uniqueGroupName(t("Новая группа"), groups.map((g) => g.name));
      const g = await bridge.history.groupAdd({ name });
      await refreshBmBar();
      beginFolderRename(g.id);
    } catch (e) {
      err(e);
      void refreshBmBar();
    }
  })();
}

/** Отсортировать чипы строки (menu-action bmbar:sort, duopulse-219): новый
 *  порядок пишется bmbar_reorder — безгрупповые чипы усыновляются группой
 *  по умолчанию (семантика drag&drop duopulse-147), сортировка группы
 *  становится ручной. Уже целевой порядок — записи нет. */
function sortBarChips(mode: BarSortMode): void {
  const urls = barSortUrls(sortDefMembers, sortUngrouped, mode);
  if (urls.join("\n") === chipUrlsOrder.join("\n")) return;
  void bridge.history
    .bmbarReorder({ urls })
    .then(refreshBmBar)
    .catch((e) => {
      err(e);
      void refreshBmBar();
    });
}

/** Инлайн-правка имени чипа (menu-action bmchip:rename, duopulse-149):
 * пустое имя разрешено — чип останется только значком. */
function beginChipRename(url: string): void {
  const btn = bar().querySelector<HTMLElement>(`.bm-item[data-url="${CSS.escape(url)}"]`);
  if (!btn) return;
  beginInlineRename({
    host: btn,
    initial: chipTitleByUrl.get(url) ?? "",
    allowEmpty: true,
    ariaLabel: t("Переименовать закладку"),
    save: (title) => {
      void bridge.history
        .bookmarkUpdate({ url, title })
        .then(refreshBmBar)
        .catch((e) => {
          err(e);
          void refreshBmBar();
        });
    },
  });
}

/** Инлайн-правка имени папки строки (bmgroup:rename): пустое запрещено —
 * папка без подписи не отличима на строке (в Chrome так же). */
function beginFolderRename(id: number): void {
  const btn = bar().querySelector<HTMLElement>(`.bm-folder[data-folder="${id}"]`);
  if (!btn) return;
  const name = groupsById.get(id)?.name ?? "";
  beginInlineRename({
    host: btn,
    initial: name,
    allowEmpty: false,
    ariaLabel: t("Переименовать группу"),
    save: (title) => {
      void bridge.history
        .groupRename({ id, name: title })
        .then(refreshBmBar)
        .catch((e) => {
          err(e);
          void refreshBmBar();
        });
    },
  });
}

/** Папка под курсором (делегированный hover) и таймер открытия. */
let hoverFolder: HTMLElement | null = null;
let hoverTimer: number | null = null;

/** Сестринские группы родителя (по позиции, из последнего рендера строки):
 *  список-контекст для вставки «рядом» с целью (folderPlacement). */
function siblingsOfParent(parent: number | null): BookmarkGroupInfo[] {
  return [...groupsById.values()]
    .filter((g) => (g.parentId ?? null) === parent)
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

/** Исполнить план дропа папки (duopulse-242, чистых шагов два): «внутрь» —
 *  перенос под родителя-цель (проверка дерева, group_move ставит в конец);
 *  «рядом» — если родитель чужой, сперва перенос под родителя ЦЕЛИ, затем
 *  перестановка перед beforeId. Оба шага идемпотентны, провал проверки —
 *  молча ничего не делаем (подсветка обмануть не должна). */
async function placeFolder(
  fid: number,
  place: { parent: number | null; beforeId: number | null },
): Promise<void> {
  try {
    const g = groupsById.get(fid);
    if (!g || g.isDefault) return;
    const sameParent = (g.parentId ?? null) === place.parent;
    if (!sameParent) {
      if (!canGroupMoveTo([...groupsById.values()], fid, place.parent)) return;
      await bridge.history.groupMove({ id: fid, parentId: place.parent });
    }
    if (place.parent !== fid && place.beforeId !== null && place.beforeId !== fid) {
      await bridge.history.groupReorder({ id: fid, beforeId: place.beforeId });
    }
    await refreshBmBar();
  } catch (e) {
    err(e);
    await refreshBmBar();
  }
}
