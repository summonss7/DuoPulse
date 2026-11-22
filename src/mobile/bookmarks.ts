// DuoPulse — закладки мобильной ветки (карточка duopulse-104): группы-чипы,
// список, звёздочка в шапке плеера и перекладывание закладки пальцем между
// группами (long-press → тяга → чип группы). duopulse-193: экран открывается
// не только со стартового экрана, но и пунктом «Закладки» меню «⋮» — поверх
// открытого видео («назад» возвращает к видео, не к старту). Данные — те же команды
// history.*, что на десктопе (lib.rs регистрирует подмножество для мобильной
// либы), клиент bridge переиспользуется как есть. Модель — как на десктопе
// (099): закладка может состоять в нескольких группах; из вида конкретной
// группы тяга на чип — перенос (убрать из текущей + добавить в целевую),
// из «Все» — добавление в целевую (остальные членства не трогаем).
// duopulse-219: строка закладок ПОД адресом (паритет десктопной bmbar,
// пожелание «переходить по закладкам прямо оттуда») — по умолчанию включена,
// переключатель в меню «⋮»; и сортировка списка закладок (алфавит/обратно/
// по дате) — кнопка «⇅» в шапке экрана.

import { bridge } from "../bridge";
import type { BookmarkGroupInfo, HistoryBookmark } from "../bridge";
import { MAX_GROUP_DEPTH, groupPath, groupTreeOrder } from "../chrome/groups-tree";
import { bmBarModel, badgeHue, badgeHost, badgeLetter } from "../chrome/bmbar";
import { t } from "../i18n";

/** Что выбрал пользователь в ряду чипов: «Все» или конкретная группа. */
export type GroupSel = "all" | number;

/** План перекладывания (чистая функция — семантика 099, тестируется):
 *  view — текущий вид списка, target — чип-группа, onTarget — закладка уже
 *  состоит в целевой группе. Убрать из текущей — только при переносе из вида
 *  группы; добавить — если в целевой ещё нет. null — шаг не нужен. */
export function planGroupDrop(
  view: GroupSel,
  target: number,
  onTarget: boolean,
): { removeFrom: number | null; addTo: number | null } {
  if (view === target) return { removeFrom: null, addTo: null }; // вид = цель: ничего
  return {
    removeFrom: typeof view === "number" ? view : null,
    addTo: onTarget ? null : target,
  };
}

/** Подпись строки закладки: хост ссылки («www.youtube.com»). */
export function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Чип — валидная цель тяги: группа (число), не текущий вид списка. */
export function dropTargetOf(chip: HTMLElement): number | null {
  const d = chip.dataset.drop;
  if (!d) return null;
  const id = Number(d);
  return Number.isFinite(id) && d !== "" ? id : null;
}

/** Задержка long-press до старта тяги, мс (как перетаскивание на рабочем
 *  столе Android; короче — конфликт со скроллом списка). */
export const LONG_PRESS_MS = 350;

// ── duopulse-219: сортировка списка и строка под адресом ───────────────────

/** Режим сортировки экрана закладок: manual — как загружено (позиции группы
 *  / свежие первыми в «Все»), остальные — пересортируют показ; режим живёт
 *  в localStorage (настройка вида, не данных). */
export type BmSortMode = "manual" | "title" | "title_desc" | "added" | "added_asc";

/** Ключ localStorage строки под адресом: "off" — скрыта (по умолчанию вкл). */
const BMBAR_PREF = "duopulse.mobile.bmbar";
/** Ключ localStorage режима сортировки экрана закладок. */
const BMSORT_PREF = "duopulse.mobile.bmsort";

/** Строка закладок под адресом включена (чистая, тестится): по умолчанию —
 *  да (пожелание Артёма), «off» в localStorage её прячет. */
export function bmBarEnabled(get: (k: string) => string | null = (k) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}): boolean {
  return get(BMBAR_PREF) !== "off";
}

/** Прочитать сохранённый режим сортировки (чистая, тестится): мусор — manual. */
export function bmSortModeOf(get: (k: string) => string | null = (k) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}): BmSortMode {
  const v = get(BMSORT_PREF);
  return v === "title" || v === "title_desc" || v === "added" || v === "added_asc" ? v : "manual";
}

/** Пересортировать список для показа (чистая, тестится): manual — копия как
 *  загружено; алфавит — localeCompare base (как COLLATE NOCASE ядра),
 *  тайбрейк url; даты — новые/старые первыми. Исходный массив не трогаем. */
export function sortBookmarksView(list: HistoryBookmark[], mode: BmSortMode): HistoryBookmark[] {
  const out = list.slice();
  const byUrl = (a: HistoryBookmark, b: HistoryBookmark): number =>
    a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
  const byTitle = (a: HistoryBookmark, b: HistoryBookmark): number =>
    a.title.trim().localeCompare(b.title.trim(), undefined, { sensitivity: "base" }) || byUrl(a, b);
  if (mode === "title") out.sort(byTitle);
  else if (mode === "title_desc") out.sort((a, b) => byTitle(b, a));
  else if (mode === "added") out.sort((a, b) => b.addedAt - a.addedAt || byUrl(a, b));
  else if (mode === "added_asc") out.sort((a, b) => a.addedAt - b.addedAt || byUrl(a, b));
  return out;
}

/** Порог «палец шевельнулся» до активации — это скролл, тягу не начинаем. */
const MOVE_CANCEL_PX = 10;

/** Транспорт invoke (тесты подменяют). */
export type BmInvoke = Pick<typeof bridge, "history">;

/** Контекст мобильной ветки, который даёт mobile.ts. */
export interface BmHost {
  /** Открытое видео (закладки на мобильной ветке — только видео YouTube):
   *  url watch-страницы и заголовок; null — видео не открыто. */
  currentVideo: () => { url: string; title: string } | null;
  /** Открыть адрес (тап по закладке — как ввод в omnibox). */
  open: (url: string) => void;
  /** Строка статуса мобильной ветки. */
  note: (text: string) => void;
}

export class MobileBookmarks {
  private readonly root: HTMLElement;
  private readonly view: HTMLElement;
  private readonly chips: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly back: HTMLElement;
  private readonly star: HTMLButtonElement;
  private readonly sheetWrap: HTMLElement;
  private readonly sheet: HTMLElement;

  private groups: BookmarkGroupInfo[] = [];
  private bookmarks: HistoryBookmark[] = [];
  private sel: GroupSel = "all";
  private starred = false;
  /** Строка закладок под адресом (duopulse-219) и режим сортировки списка. */
  private readonly barRow: HTMLElement;
  private sortBtn!: HTMLButtonElement;
  private sortMode: BmSortMode = "manual";
  /** Признак для звёздочки: сейчас открыто видео (url/title — из host). */

  /** Старт-экран был спрятан до открытия экрана закладок: при закрытии
   *  возвращаем как было (duopulse-193 — экран открывается и поверх
   *  открытого видео из меню «⋮», «назад» должен вернуть к видео, а не
   *  к старту; из меню start и так скрыт вкладкой). */
  private startWasHidden = false;

  constructor(
    private readonly host: BmHost,
    private readonly api: BmInvoke = bridge,
  ) {
    // Скелет: секция внутри .m-content (поверх старт-экрана), звёздочка — в
    // строке адреса (вторая строка шапки, рядом с →; duopulse-105), шит (низ)
    // — общий для выбора группы и меню чипа.
    const urlrow = document.querySelector<HTMLElement>("#mobile #mUrlrow");
    const content = document.querySelector<HTMLElement>("#mobile .m-content");
    if (!urlrow || !content) throw new Error("mobile: нет каркаса для закладок");

    this.star = document.createElement("button");
    this.star.id = "mStar";
    this.star.className = "m-icon";
    this.star.hidden = true;
    this.star.title = t("В избранное");
    this.star.setAttribute("aria-label", t("В избранное"));
    this.star.innerHTML =
      '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M8 2.2l1.7 3.6 3.9.5-2.9 2.7.8 3.9L8 11l-3.5 1.9.8-3.9-2.9-2.7 3.9-.5z"/></svg>';
    urlrow.insertBefore(this.star, urlrow.querySelector("#mGo"));

    this.view = document.createElement("section");
    this.view.id = "mBookmarks";
    this.view.className = "m-bm";
    this.view.hidden = true;
    this.view.innerHTML = `
      <div class="m-bm-head">
        <button class="m-bm-back" title="${t("Закрыть")}" aria-label="${t("Закрыть")}">
          <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5 5.5 8l4.5 4.5"/></svg>
          <b>${t("Закладки")}</b>
        </button>
        <span class="m-bm-hint">${t("удерживайте закладку и тяните на группу")}</span>
        <button class="m-bm-sort" title="${t("Сортировка")}" aria-label="${t("Сортировка")}">
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3v10M5 13l-2.5-2.5M5 13l2.5-2.5M11 13V3M11 3 8.5 5.5M11 3l2.5 2.5"/></svg>
        </button>
      </div>
      <div class="m-bm-chips" role="tablist"></div>
      <div class="m-bm-list"></div>
    `;
    content.append(this.view);

    this.sheetWrap = document.createElement("div");
    this.sheetWrap.className = "m-sheet-wrap";
    this.sheetWrap.hidden = true;
    this.sheetWrap.innerHTML = `
      <div class="m-sheet-backdrop"></div>
      <div class="m-sheet" role="menu"></div>
    `;
    content.append(this.sheetWrap);

    this.back = this.view.querySelector(".m-bm-back")!;
    this.chips = this.view.querySelector(".m-bm-chips")!;
    this.listEl = this.view.querySelector(".m-bm-list")!;
    this.sheet = this.sheetWrap.querySelector(".m-sheet")!;
    this.sortBtn = this.view.querySelector(".m-bm-sort")!;
    this.root = this.view;

    // duopulse-219: строка закладок под адресом — в шапке, рядом после
    // .m-urlrow (последний ряд шапки); в тест-фикстуре родитель попроще —
    // цепляем к нему, логика та же. Пустая/выключенная — hidden.
    this.barRow = document.createElement("div");
    this.barRow.id = "mBmBar";
    this.barRow.className = "m-bmbar";
    this.barRow.hidden = true;
    urlrow.parentElement?.insertBefore(this.barRow, urlrow.nextSibling);

    this.back.addEventListener("click", () => this.closeView());
    this.sortBtn.addEventListener("click", () => this.openSortSheet());
    this.sheetWrap.querySelector(".m-sheet-backdrop")!.addEventListener("click", () => this.closeSheet());
    this.star.addEventListener("click", () => void this.onStar());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this.closeSheet();
        this.closeView();
      }
    });

    // Тяга: long-press по строке → палец на чип группы. Скролл глушим
    // preventDefault на touchmove (non-passive) только пока тяга активна —
    // до её старта список скроллится свободно.
    this.listEl.addEventListener("touchmove", (e) => {
      if (this.drag.active) e.preventDefault();
    }, { passive: false });
    // long-press на тачу рождает системное контекстное меню/выделение —
    // глушим в списке и чипах (тяга наша)
    this.view.addEventListener("contextmenu", (e) => e.preventDefault());
    this.listEl.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    window.addEventListener("pointermove", (e) => this.onPointerMove(e), true);
    window.addEventListener("pointerup", (e) => this.onPointerUp(e), true);
    window.addEventListener("pointercancel", () => this.endDrag(false), true);

    // Кнопка на стартовом экране — «Закладки».
    const startBtn = document.querySelector("#mStart");
    if (startBtn) {
      const btn = document.createElement("button");
      btn.className = "m-quick m-bm-open";
      btn.textContent = t("Закладки");
      btn.addEventListener("click", () => void this.openView());
      startBtn.insertBefore(btn, startBtn.querySelector(".m-hint"));
    }

    // Тест-хук e2e-стендов (как __duoDebug): снапшот состояния + syncVideo.
    (window as unknown as { __bmDebug?: () => unknown }).__bmDebug = () => ({
      open: !this.view.hidden,
      sel: this.sel,
      groups: this.groups,
      bookmarks: this.bookmarks,
      starred: this.starred,
      drag: this.drag.active,
      sortMode: this.sortMode,
      barHidden: this.barRow.hidden,
      barChips: this.barRow.children.length,
    });

    // duopulse-219: стартовый показ строки под адресом и режим сортировки
    this.sortMode = bmSortModeOf();
    void this.refreshBar();
  }

  // ── строка закладок под адресом (duopulse-219) ───────────────────────────

  /** Перерисовать строку под адресом по свежим данным Core: чипы — группа
   *  по умолчанию + безгрупповые (модель десктопной строки), папки — корневые
   *  группы и дети «Избранного»; тап по чипу — открыть, по папке — экран
   *  закладок в этой группе. Выключена настройкой или пустая — скрыта. */
  async refreshBar(): Promise<void> {
    if (!bmBarEnabled()) {
      this.barRow.hidden = true;
      return;
    }
    try {
      const [{ groups }, ung] = await Promise.all([
        this.api.history.groupList(),
        this.api.history.bookmarkList({ query: null, groupId: -1, offset: 0, limit: 500 }),
      ]);
      const defId = groups.find((g) => g.isDefault)?.id ?? null;
      const defMembers =
        defId !== null
          ? (await this.api.history.bookmarkList({ query: null, groupId: defId, offset: 0, limit: 500 })).bookmarks
          : [];
      this.renderBar(bmBarModel(groups, defMembers, ung.bookmarks));
    } catch {
      this.barRow.hidden = true; // история недоступна — строку не показываем
    }
  }

  private renderBar(model: ReturnType<typeof bmBarModel>): void {
    const chip = (url: string, title: string): HTMLButtonElement => {
      const label = title.trim();
      const el = document.createElement("button");
      el.type = "button";
      el.className = label ? "m-bmbar-chip" : "m-bmbar-chip m-bmbar-icon";
      el.dataset.url = url;
      el.title = label ? `${label}\n${url}` : url;
      // бейдж-буква с цветом домена — как чипы десктопной строки
      const host = badgeHost(url);
      const ico = document.createElement("i");
      ico.className = "m-bmbar-badge";
      ico.textContent = badgeLetter(label, host);
      ico.style.background = `linear-gradient(145deg, hsl(${badgeHue(host || url)} 46% 46%), hsl(${badgeHue(host || url)} 46% 33%))`;
      el.append(ico);
      if (label) {
        const span = document.createElement("span");
        span.className = "m-bmbar-label";
        span.textContent = label;
        el.append(span);
      }
      el.addEventListener("click", () => this.host.open(url));
      return el;
    };
    const folder = (id: number, name: string): HTMLButtonElement => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "m-bmbar-chip m-bmbar-folder";
      el.innerHTML =
        '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M1.8 4.2c0-.6.5-1.1 1.1-1.1h3l1.4 1.6h5.8c.6 0 1.1.5 1.1 1.1v6.9c0 .6-.5 1.1-1.1 1.1H2.9c-.6 0-1.1-.5-1.1-1.1z"/></svg>';
      const span = document.createElement("span");
      span.className = "m-bmbar-label";
      span.textContent = name;
      el.append(span);
      el.title = name;
      el.addEventListener("click", () => void this.openGroup(id));
      return el;
    };
    this.barRow.replaceChildren(
      ...model.chips.map((c) => chip(c.url, c.title)),
      ...model.folders.map((f) => folder(f.id, f.name)),
    );
    this.barRow.hidden = !(model.chips.length > 0 || model.folders.length > 0);
  }

  /** Показать/спрятать строку под адресом (переключатель меню «⋮»):
   *  настройка — localStorage, переживает перезапуск; в инкогнито-очистке
   *  WebView теряется — возвращается дефолт «включена». */
  setBarEnabled(on: boolean): void {
    try {
      if (on) localStorage.removeItem(BMBAR_PREF);
      else localStorage.setItem(BMBAR_PREF, "off");
    } catch {
      /* без localStorage — настройка живёт до перезапуска */
    }
    if (on) void this.refreshBar();
    else this.barRow.hidden = true;
  }

  /** Открыть экран закладок сразу в группе (тап по папке строки, duopulse-219):
   *  поворот вида без отдельного API — sel + обычный openView/reload. */
  async openGroup(groupId: number): Promise<void> {
    this.sel = groupId;
    await this.openView();
  }

  // ── вид списка ──────────────────────────────────────────────────────────

  /** Открыть экран закладок (со стартового экрана или из меню «⋮» поверх
   *  открытого видео/PDF — duopulse-193). */
  async openView(): Promise<void> {
    const start = document.querySelector<HTMLElement>("#mStart");
    if (this.view.hidden && start) this.startWasHidden = start.hidden;
    if (start) start.hidden = true;
    this.view.hidden = false;
    await this.reload();
  }

  /** Закрыть экран. restore=false — не трогать старт-экран: вызывающий уже
   *  выставил его сам (закрытие всех вкладок — onTabActive(null)). */
  closeView(restore = true): void {
    if (this.view.hidden) return;
    this.view.hidden = true;
    this.endDrag(false);
    this.closeSheet();
    const start = document.querySelector<HTMLElement>("#mStart");
    if (start && restore) start.hidden = this.startWasHidden;
  }

  /** Обновить экран после синка аккаунта Aila (duopulse-112): перечитать
   *  открытый список и звёздочку — данные могли прийти из облака. Строку под
   *  адресом обновляем и при закрытом экране (duopulse-219: синк меняет чипы). */
  async refreshIfOpen(): Promise<void> {
    void this.refreshBar();
    if (this.view.hidden) return;
    await this.reload();
    await this.syncVideo();
  }

  /** Перечитать группы + закладки текущего вида; показ списка — в режиме
   *  сортировки экрана (duopulse-219), строка под адресом — тоже свежая. */
  async reload(): Promise<void> {
    try {
      const [{ groups }, res] = await Promise.all([
        this.api.history.groupList(),
        this.api.history.bookmarkList({
          query: null,
          groupId: this.sel === "all" ? null : this.sel,
          offset: 0,
          limit: 500,
        }),
      ]);
      this.groups = groups;
      this.bookmarks = sortBookmarksView(res.bookmarks, this.sortMode);
      this.renderChips();
      this.renderList();
      if (this.sel !== "all" && !groups.some((g) => g.id === this.sel)) {
        this.sel = "all";
        await this.reload();
      }
    } catch (e) {
      this.host.note(t("Закладки: {error}", { error: e instanceof Error ? e.message : String(e) }));
    }
    void this.refreshBar();
  }

  /** Шит режима сортировки списка (duopulse-219): настройка вида — данные и
   *  порядок групп не меняются; активный режим отмечен галочкой. */
  private openSortSheet(): void {
    this.closeSheet();
    const modes: readonly [BmSortMode, string][] = [
      ["manual", "Как загружено"],
      ["title", "По алфавиту"],
      ["title_desc", "По алфавиту (обратно)"],
      ["added", "По дате добавления (сначала новые)"],
      ["added_asc", "По дате добавления (сначала старые)"],
    ];
    for (const [mode, label] of modes) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "m-sheet-item";
      b.textContent = `${mode === this.sortMode ? "✓ " : ""}${t(label)}`;
      b.addEventListener("click", () => {
        this.sortMode = mode;
        try {
          if (mode === "manual") localStorage.removeItem(BMSORT_PREF);
          else localStorage.setItem(BMSORT_PREF, mode);
        } catch {
          /* без localStorage — режим живёт до перезапуска */
        }
        this.closeSheet();
        this.renderList();
      });
      this.sheet.append(b);
    }
    this.sheetWrap.hidden = false;
  }

  private renderChips(): void {
    const kids: HTMLElement[] = [];
    const chip = (label: string, sel: GroupSel | null, title: string, drop?: string): HTMLElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "m-bm-chip";
      b.textContent = label;
      b.title = title;
      if (sel !== null) {
        b.dataset.sel = String(sel);
        if (this.sel === sel) b.classList.add("m-on");
      }
      if (drop !== undefined) b.dataset.drop = drop;
      kids.push(b);
      return b;
    };
    chip(t("Все"), "all", t("Все закладки"));
    for (const g of groupTreeOrder(this.groups)) {
      const c = chip(
        // Имя группы — данные из БД; дефолтная «Избранное» создаётся Core
        // с русским именем — показываем перевод (duopulse-138, RTL-аудит).
        // duopulse-151: подгруппы — с отступом «· » по глубине
        `${g.depth > 1 ? `${"· ".repeat(g.depth - 1)}` : ""}${g.isDefault ? t(g.name) : g.name} · ${g.count}`,
        g.id,
        g.isDefault ? t("Группа по умолчанию (звёздочка без выбора)") : groupPath(this.groups, g.id),
      );
      c.dataset.drop = String(g.id); // цель тяги (dropTargetOf)
      this.armChipLongPress(c, g);
    }
    const add = chip("+", null, t("Новая группа"));
    add.classList.add("m-bm-chip-add");
    add.addEventListener("click", () => this.editGroupName(null));
    this.chips.replaceChildren(...kids);
    for (const c of this.chips.querySelectorAll<HTMLButtonElement>(".m-bm-chip[data-sel]")) {
      c.addEventListener("click", () => {
        const s = c.dataset.sel!;
        this.sel = s === "all" ? "all" : Number(s);
        void this.reload();
      });
    }
  }

  /** long-press по чипу группы — переименовать/удалить (кнопка «+» и «Все»
   *  не участвуют). До активации — обычный тап-выбор вида. */
  private armChipLongPress(chip: HTMLElement, g: BookmarkGroupInfo): void {
    let timer = 0;
    let moved = false;
    chip.addEventListener("pointerdown", () => {
      moved = false;
      timer = window.setTimeout(() => {
        if (!moved) this.openChipMenu(g);
      }, LONG_PRESS_MS);
    });
    chip.addEventListener("pointermove", () => {
      moved = true;
    });
    const cancel = (): void => {
      window.clearTimeout(timer);
    };
    chip.addEventListener("pointerup", cancel);
    chip.addEventListener("pointercancel", cancel);
    chip.addEventListener("pointerleave", cancel);
  }

  private openChipMenu(g: BookmarkGroupInfo): void {
    this.closeSheet();
    const mk = (label: string, fn: () => void): HTMLElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "m-sheet-item";
      b.textContent = label;
      b.addEventListener("click", () => {
        this.closeSheet();
        fn();
      });
      return b;
    };
    this.sheet.append(mk(t("Переименовать…"), () => this.editGroupName(g)));
    // duopulse-151: подгруппа внутри группы (до 3 уровней)
    if (g.depth < MAX_GROUP_DEPTH) {
      this.sheet.append(
        mk(t("Создать подгруппу…"), () => this.editGroupName(null, g.id)),
      );
    }
    if (!g.isDefault) {
      this.sheet.append(
        mk(t("Удалить группу «{name}» (закладки останутся)", { name: g.name }), () => {
          void this.api.history
            .groupRemove({ id: g.id })
            .then(() => this.reload())
            .catch((e) => this.host.note(t("Группа: {error}", { error: e })));
        }),
      );
    }
    this.sheetWrap.hidden = false;
  }

  /** Инлайн-ввод имени группы: новая (g=null; parent — подгруппа этого
   *  родителя, duopulse-151) или переименование. */
  private editGroupName(g: BookmarkGroupInfo | null, parent?: number): void {
    this.closeSheet();
    const existing = this.chips.querySelector<HTMLInputElement>(".m-bm-chip-input");
    if (existing) existing.remove();
    const input = document.createElement("input");
    input.className = "m-bm-chip-input";
    input.type = "text";
    input.placeholder = g ? t("Новое имя группы") : parent != null ? t("Имя подгруппы") : t("Имя группы");
    input.value = g?.name ?? "";
    let done = false;
    const cancel = (): void => {
      done = true;
      input.remove();
      void this.reload();
    };
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Escape") cancel();
      if (ev.key === "Enter") {
        const name = input.value.trim();
        done = true;
        input.remove();
        if (!name || (g && name === g.name)) {
          void this.reload();
          return;
        }
        const call = g
          ? this.api.history.groupRename({ id: g.id, name })
          : this.api.history.groupAdd({ name, parentId: parent ?? null });
        void call.then(() => this.reload()).catch((e) => this.host.note(t("Группа: {error}", { error: e })));
      }
    });
    input.addEventListener("blur", () => {
      if (!done) cancel();
    });
    if (g) {
      const chipEl = [...this.chips.querySelectorAll<HTMLElement>(".m-bm-chip")].find(
        (c) => c.dataset.sel === String(g.id),
      );
      (chipEl ?? this.chips.lastElementChild as HTMLElement).replaceWith(input);
    } else {
      this.chips.append(input);
    }
    input.focus();
  }

  private renderList(): void {
    const rows: HTMLElement[] = [];
    if (this.bookmarks.length === 0) {
      const empty = document.createElement("p");
      empty.className = "m-bm-empty";
      empty.textContent =
        this.groups.length > 1 || this.sel !== "all"
          ? t("В этой группе пока пусто — добавьте видео звёздочкой в строке адреса")
          : t("Закладок пока нет: откройте видео и нажмите звёздочку в строке адреса");
      this.listEl.replaceChildren(empty);
      return;
    }
    for (const b of this.bookmarks) {
      const row = document.createElement("div");
      row.className = "m-bm-row";
      row.dataset.url = b.url;
      const main = document.createElement("button");
      main.type = "button";
      main.className = "m-bm-main";
      main.title = b.url;
      const title = document.createElement("span");
      title.className = "m-bm-title";
      title.textContent = b.title || hostLabel(b.url);
      const sub = document.createElement("span");
      sub.className = "m-bm-sub";
      const names = (b.groups ?? []).map((r) => r.name).join(" · ");
      sub.textContent = names ? `${hostLabel(b.url)} · ${names}` : hostLabel(b.url);
      main.append(title, sub);
      main.addEventListener("click", () => {
        this.closeView();
        this.host.open(b.url);
      });
      const ren = document.createElement("button");
      ren.type = "button";
      ren.className = "m-bm-act";
      ren.title = t("Переименовать");
      ren.setAttribute("aria-label", t("Переименовать закладку"));
      ren.textContent = "✎";
      ren.addEventListener("click", () => this.editBookmarkTitle(row, b));
      const del = document.createElement("button");
      del.type = "button";
      del.className = "m-bm-act";
      del.title = t("Удалить закладку");
      del.setAttribute("aria-label", t("Удалить закладку"));
      del.textContent = "✕";
      del.addEventListener("click", () => {
        void this.api.history
          .bookmarkRemove({ url: b.url })
          .then(() => this.reload())
          .catch((e) => this.host.note(t("Закладка: {error}", { error: String(e) })));
      });
      row.append(main, ren, del);
      rows.push(row);
    }
    this.listEl.replaceChildren(...rows);
  }

  /** Инлайн-переименование закладки (✎ в строке). */
  private editBookmarkTitle(row: HTMLElement, b: HistoryBookmark): void {
    const main = row.querySelector<HTMLElement>(".m-bm-main")!;
    const input = document.createElement("input");
    input.className = "m-bm-rename";
    input.type = "text";
    input.value = b.title;
    let done = false;
    const cancel = (): void => {
      done = true;
      input.remove();
      main.hidden = false;
    };
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Escape") cancel();
      if (ev.key === "Enter") {
        const title = input.value.trim();
        done = true;
        input.remove();
        main.hidden = false;
        if (title && title !== b.title) {
          void this.api.history
            .bookmarkUpdate({ url: b.url, title })
            .then(() => this.reload())
            .catch((e) => this.host.note(t("Закладка: {error}", { error: String(e) })));
        }
      }
    });
    input.addEventListener("blur", () => {
      if (!done) cancel();
    });
    main.hidden = true;
    row.insertBefore(input, main);
    input.focus();
  }

  // ── звёздочка в шапке плеера ────────────────────────────────────────────

  /** Синхронизировать звёздочку с открытым видео (вызывает mobile.ts при
   *  каждом открытии/закрытии плеера). */
  async syncVideo(): Promise<void> {
    const video = this.host.currentVideo();
    this.star.hidden = !video;
    this.starred = false;
    if (!video) {
      this.renderStar();
      return;
    }
    try {
      const { bookmarks } = await this.api.history.bookmarkList({
        query: null,
        offset: 0,
        limit: 500,
      });
      this.starred = bookmarks.some((b) => b.url === video.url);
    } catch {
      /* без истории закладок звезда просто не подсвечена */
    }
    this.renderStar();
  }

  private renderStar(): void {
    this.star.dataset.on = String(this.starred);
    this.star.setAttribute("aria-pressed", String(this.starred));
    this.star.title = this.starred ? t("Убрать из закладок") : t("В закладки — выбор группы");
  }

  private async onStar(): Promise<void> {
    const video = this.host.currentVideo();
    if (!video) return;
    if (this.starred) {
      try {
        await this.api.history.bookmarkRemove({ url: video.url });
        await this.syncVideo();
        void this.refreshBar(); // строка под адресом (duopulse-219)
        this.host.note(t("Закладка удалена"));
      } catch (e) {
        this.host.note(t("Закладка: {error}", { error: String(e) }));
      }
      return;
    }
    await this.openGroupPicker(video.url, video.title);
  }

  /** Шит выбора группы для новой закладки (как мини-меню звёздочки десктопа):
   *  список групп + «Новая группа…» с инлайн-вводом. */
  private async openGroupPicker(url: string, title: string): Promise<void> {
    this.closeSheet();
    let groups: BookmarkGroupInfo[];
    try {
      groups = (await this.api.history.groupList()).groups;
    } catch (e) {
      this.host.note(t("Закладки: {error}", { error: String(e) }));
      return;
    }
    const pick = (groupId: number | null): void => {
      this.closeSheet();
      void this.api.history
        .bookmarkAdd({ url, title, groupId })
        .then(() => this.syncVideo())
        .then(() => this.refreshBar()) // строка под адресом (duopulse-219)
        .then(() => this.host.note(t("Добавлено в закладки")))
        .catch((e) => this.host.note(t("Закладка: {error}", { error: String(e) })));
    };
    for (const g of groupTreeOrder(groups)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "m-sheet-item";
      // duopulse-151: подгруппы — с отступом по глубине и путём в подсказке
      b.textContent = g.isDefault
        ? t("{name} (по умолчанию)", { name: g.name })
        : `${g.depth > 1 ? `${"· ".repeat(g.depth - 1)}` : ""}${g.name}`;
      b.title = groupPath(groups, g.id);
      b.addEventListener("click", () => pick(g.id));
      this.sheet.append(b);
    }
    const newG = document.createElement("button");
    newG.type = "button";
    newG.className = "m-sheet-item m-sheet-new";
    newG.textContent = t("Новая группа…");
    newG.addEventListener("click", () => {
      this.closeSheet();
      const input = document.createElement("input");
      input.className = "m-sheet-input";
      input.type = "text";
      input.placeholder = t("Имя группы");
      let done = false;
      const submit = (): void => {
        if (done) return;
        done = true;
        const name = input.value.trim();
        input.remove();
        if (!name) return;
        void this.api.history
          .groupAdd({ name })
          .then((g) => this.api.history.bookmarkAdd({ url, title, groupId: g.id }))
          .then(() => this.syncVideo())
          .then(() => this.refreshBar()) // строка под адресом (duopulse-219)
          .then(() => this.host.note(t("Добавлено в «{name}»", { name })))
          .catch((e) => this.host.note(t("Закладка: {error}", { error: String(e) })));
      };
      input.addEventListener("keydown", (ev) => {
        ev.stopPropagation();
        if (ev.key === "Enter") submit();
        if (ev.key === "Escape") {
          done = true;
          input.remove();
        }
      });
      input.addEventListener("blur", () => submit());
      this.sheetWrap.hidden = false;
      this.sheet.append(input);
      input.focus();
    });
    this.sheet.append(newG);
    this.sheetWrap.hidden = false;
  }

  closeSheet(): void {
    this.sheetWrap.hidden = true;
    this.sheet.replaceChildren();
  }

  // ── сенсорная тяга: long-press → чип группы ─────────────────────────────

  /** Состояние тяги: source row (url), стартовые координаты, таймер
   *  активации, признак активной тяги, «призрак» под пальцем. */
  private readonly drag: {
    url: string;
    row: HTMLElement | null;
    startX: number;
    startY: number;
    offsetX: number;
    offsetY: number;
    timer: number;
    active: boolean;
    ghost: HTMLElement | null;
    hint: HTMLElement | null;
  } = { url: "", row: null, startX: 0, startY: 0, offsetX: 0, offsetY: 0, timer: 0, active: false, ghost: null, hint: null };

  private onPointerDown(e: PointerEvent): void {
    if (this.drag.active) return;
    const row = (e.target as HTMLElement).closest<HTMLElement>(".m-bm-row");
    if (!row || !row.dataset.url) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // кнопки строки (✎/✕) — клики, не тяга; во время инлайн-правки тоже
    if ((e.target as HTMLElement).closest(".m-bm-act")) return;
    if (row.querySelector(".m-bm-rename")) return;
    this.drag.url = row.dataset.url;
    this.drag.row = row;
    this.drag.startX = e.clientX;
    this.drag.startY = e.clientY;
    const r = row.getBoundingClientRect();
    this.drag.offsetX = e.clientX - r.left;
    this.drag.offsetY = e.clientY - r.top;
    this.drag.timer = window.setTimeout(() => this.beginDrag(), LONG_PRESS_MS);
  }

  private beginDrag(): void {
    const row = this.drag.row;
    if (!row || !row.isConnected) return;
    this.drag.active = true;
    try {
      navigator.vibrate?.(20);
    } catch {
      /* без вибрации не критично */
    }
    const ghost = row.cloneNode(true) as HTMLElement;
    ghost.classList.add("m-bm-ghost");
    ghost.style.width = `${row.getBoundingClientRect().width}px`;
    document.body.append(ghost);
    this.drag.ghost = ghost;
    row.classList.add("m-bm-drag-src");
    document.body.classList.add("m-bm-dragging");
    const hint = document.createElement("div");
    hint.className = "m-bm-drag-hint";
    hint.textContent = t("Тяните на группу");
    document.body.append(hint);
    this.drag.hint = hint;
    this.moveGhost(this.drag.startX, this.drag.startY);
  }

  private moveGhost(x: number, y: number): void {
    const ghost = this.drag.ghost;
    if (!ghost) return;
    ghost.style.left = `${x - this.drag.offsetX}px`;
    ghost.style.top = `${y - this.drag.offsetY}px`;
    const hint = this.drag.hint;
    if (hint) {
      hint.style.left = `${x}px`;
      hint.style.top = `${y - 44}px`;
    }
    // подсветка чипа-цели под пальцем (призрак не ловит события)
    for (const c of this.chips.querySelectorAll(".m-bm-chip.drop-target")) {
      c.classList.remove("drop-target");
    }
    const chip = this.chipAt(x, y);
    if (chip) chip.classList.add("drop-target");
  }

  /** Чип-цель под точкой: только группа (data-drop) и не текущий вид. */
  private chipAt(x: number, y: number): HTMLElement | null {
    const ghost = this.drag.ghost;
    const wasHidden = ghost?.style.visibility;
    if (ghost) ghost.style.visibility = "hidden";
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    if (ghost) ghost.style.visibility = wasHidden ?? "";
    const chip = el?.closest<HTMLElement>(".m-bm-chip") ?? null;
    if (!chip) return null;
    const target = dropTargetOf(chip);
    if (target === null || target === this.sel) return null;
    return chip;
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.drag.row) return;
    if (!this.drag.active) {
      const dx = e.clientX - this.drag.startX;
      const dy = e.clientY - this.drag.startY;
      if (Math.hypot(dx, dy) > MOVE_CANCEL_PX) this.cancelPending();
      return;
    }
    e.preventDefault();
    this.moveGhost(e.clientX, e.clientY);
  }

  private cancelPending(): void {
    window.clearTimeout(this.drag.timer);
    this.drag.row = null;
    this.drag.url = "";
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.drag.active) {
      this.cancelPending();
      return;
    }
    const chip = this.chipAt(e.clientX, e.clientY);
    const target = chip ? dropTargetOf(chip) : null;
    const url = this.drag.url;
    this.endDrag(false);
    if (target === null || !url) return;
    void this.dropOnGroup(url, target);
  }

  /** Завершить тягу (сброс — без применения). */
  private endDrag(_apply: boolean): void {
    window.clearTimeout(this.drag.timer);
    this.drag.row?.classList.remove("m-bm-drag-src");
    this.drag.ghost?.remove();
    this.drag.hint?.remove();
    document.body.classList.remove("m-bm-dragging");
    for (const c of this.chips.querySelectorAll(".m-bm-chip.drop-target")) {
      c.classList.remove("drop-target");
    }
    this.drag.url = "";
    this.drag.row = null;
    this.drag.timer = 0;
    this.drag.active = false;
    this.drag.ghost = null;
    this.drag.hint = null;
  }

  /** Применить перекладывание (семантика 099, план — planGroupDrop). */
  private async dropOnGroup(url: string, target: number): Promise<void> {
    const b = this.bookmarks.find((x) => x.url === url);
    const onTarget = b?.groups?.some((g) => g.id === target) === true;
    const plan = planGroupDrop(this.sel, target, onTarget);
    try {
      if (plan.removeFrom !== null) {
        await this.api.history.groupToggleBookmark({ url, groupId: plan.removeFrom, on: false });
      }
      if (plan.addTo !== null) {
        await this.api.history.groupToggleBookmark({ url, groupId: plan.addTo, on: true });
      }
      const name = this.groups.find((g) => g.id === target)?.name ?? String(target);
      this.host.note(
        plan.removeFrom !== null
          ? t("Переложено в «{name}»", { name })
          : t("Добавлено в «{name}»", { name }),
      );
    } catch (e) {
      this.host.note(t("Перекладывание: {error}", { error: String(e) }));
    }
    await this.reload();
  }
}
