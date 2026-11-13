// DuoPulse — строка закладок под навбаром, как в Chrome (карточка
// duopulse-143): основные закладки (группа по умолчанию «Избранное» и
// без группы) — чипами с бейджем-буквой домена, группы-папки — кнопкой с
// пиктограммой: наведение (задержка ~250 мс, как меню Chrome) или клик
// открывают нативное меню папки (chrome_menu.rs, поверх контентных webview);
// выбор пункта навигирует активную вкладку. Пустое избранное — строка
// скрыта; показ/скрытие меняет высоту #app — Core сообщаем фактическую
// высоту (tabs.set_chrome_height), webview вкладок кладётся ниже.
// Обновление: старт, правки звёздочки (refreshBmBar из star.ts) и смена
// вкладок (tabs.updated — правки на странице управления и синк Aila
// подхватываются при первом же переключении).
import { bridge } from "../bridge";
import type { BookmarkGroupInfo, HistoryBookmark } from "../bridge";
import { onOverlayMenuAction, openOverlayMenu } from "./overlay-menu";

const err = (e: unknown): void => console.error("bmbar:", e);

/** Строка в разметке (чистая модель выше не знает DOM — как update-bar). */
const bar = (): HTMLElement => document.getElementById("bmbar") as HTMLElement;

/** Модель строки: чипы — закладки группы по умолчанию (в её порядке) +
 * безгрупповые; папки — прочие непустые группы по position. */
export interface BmBarModel {
  visible: boolean;
  chips: { url: string; title: string }[];
  folders: { id: number; name: string }[];
}

/** Чистая модель строки (тестится без DOM): группы + члены группы по
 * умолчанию + безгрупповые закладки. */
export function bmBarModel(
  groups: BookmarkGroupInfo[],
  defaultMembers: HistoryBookmark[],
  ungrouped: HistoryBookmark[],
): BmBarModel {
  const folders = groups
    .filter((g) => !g.isDefault && g.count > 0)
    .sort((a, b) => a.position - b.position)
    .map((g) => ({ id: g.id, name: g.name }));
  const chip = (b: HistoryBookmark) => ({
    url: b.url,
    title: b.title.trim() || b.url,
  });
  const chips = [...defaultMembers.map(chip), ...ungrouped.map(chip)];
  return { visible: chips.length > 0 || folders.length > 0, chips, folders };
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
    render(model);
    const el = bar();
    el.hidden = !model.visible;
    // offsetHeight после снятия hidden — в следующем кадре разметки
    requestAnimationFrame(reportChromeHeight);
  } catch (e) {
    err(e);
  }
}

/** Рендер модели в строку (кнопки-чипы + кнопки-папки). */
function render(model: BmBarModel): void {
  bar().replaceChildren();
  const chip = (b: { url: string; title: string }): HTMLButtonElement => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "bm-item";
    el.dataset.url = b.url;
    const host = badgeHost(b.url);
    const ico = document.createElement("i");
    ico.className = "bm-ico";
    ico.textContent = badgeLetter(b.title, host);
    ico.style.background = `hsl(${badgeHue(host || b.url)} 42% 40%)`;
    const label = document.createElement("span");
    label.className = "bm-label";
    label.textContent = b.title;
    el.append(ico, label);
    el.title = `${b.title}\n${b.url}`;
    return el;
  };
  const folder = (f: { id: number; name: string }): HTMLButtonElement => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "bm-item bm-folder";
    el.dataset.folder = String(f.id);
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
  for (const f of model.folders) el.append(folder(f));
}

/** Открыть меню папки у кнопки (наведение с задержкой или клик). */
function openFolderMenu(btn: HTMLElement): void {
  const groupId = Number(btn.dataset.folder);
  if (!Number.isFinite(groupId)) return;
  const r = btn.getBoundingClientRect();
  openOverlayMenu("bmfolder", r.left, r.bottom + 2, { groupId });
}

/** Инициализация строки: клики/средний клик, наведение папок, выбор пункта
 * меню папки, обновление по tabs.updated (дебаунс — правки со страницы
 * управления и синк подхватываются первым переключением). */
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
  // пролёт мыши по бару папки не раскрывает (как меню Chrome)
  bar().addEventListener("pointerover", (e) => {
    const folder = (e.target as HTMLElement).closest<HTMLElement>(".bm-folder");
    if (folder === hoverFolder) return;
    hoverFolder = folder;
    if (hoverTimer !== null) window.clearTimeout(hoverTimer);
    hoverTimer = null;
    if (folder) {
      hoverTimer = window.setTimeout(() => {
        hoverTimer = null;
        openFolderMenu(folder);
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
  // выбор закладки в меню папки — переход активной вкладкой
  onOverlayMenuAction((a) => {
    if (a.menu !== "bmfolder" || typeof a.url !== "string") return;
    void bridge.nav.navigate({ url: a.url }).catch(err);
  });
  void refreshBmBar();
}

/** Папка под курсором (делегированный hover) и таймер открытия. */
let hoverFolder: HTMLElement | null = null;
let hoverTimer: number | null = null;
