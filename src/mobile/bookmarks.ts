// DuoPulse — закладки мобильной ветки (карточка duopulse-104): группы-чипы,
// список, звёздочка в шапке плеера и перекладывание закладки пальцем между
// группами (long-press → тяга → чип группы). Данные — те же команды
// history.*, что на десктопе (lib.rs регистрирует подмножество для мобильной
// либы), клиент bridge переиспользуется как есть. Модель — как на десктопе
// (099): закладка может состоять в нескольких группах; из вида конкретной
// группы тяга на чип — перенос (убрать из текущей + добавить в целевую),
// из «Все» — добавление в целевую (остальные членства не трогаем).

import { bridge } from "../bridge";
import type { BookmarkGroupInfo, HistoryBookmark } from "../bridge";
import { MAX_GROUP_DEPTH, groupPath, groupTreeOrder } from "../chrome/groups-tree";
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
  /** Признак для звёздочки: сейчас открыто видео (url/title — из host). */

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
        <button class="m-bm-back" title="${t("К старту")}" aria-label="${t("К старту")}">
          <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5 5.5 8l4.5 4.5"/></svg>
          <b>${t("Закладки")}</b>
        </button>
        <span class="m-bm-hint">${t("удерживайте закладку и тяните на группу")}</span>
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
    this.root = this.view;

    this.back.addEventListener("click", () => this.closeView());
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
    });
  }

  // ── вид списка ──────────────────────────────────────────────────────────

  /** Открыть экран закладок (со стартового экрана). */
  async openView(): Promise<void> {
    this.view.hidden = false;
    const start = document.querySelector<HTMLElement>("#mStart");
    if (start) start.hidden = true;
    await this.reload();
  }

  closeView(): void {
    if (this.view.hidden) return;
    this.view.hidden = true;
    this.endDrag(false);
    this.closeSheet();
    const start = document.querySelector<HTMLElement>("#mStart");
    if (start) start.hidden = false;
  }

  /** Обновить экран после синка аккаунта Aila (duopulse-112): перечитать
   *  открытый список и звёздочку — данные могли прийти из облака. */
  async refreshIfOpen(): Promise<void> {
    if (this.view.hidden) return;
    await this.reload();
    await this.syncVideo();
  }

  /** Перечитать группы + закладки текущего вида. */
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
      this.bookmarks = res.bookmarks;
      this.renderChips();
      this.renderList();
      if (this.sel !== "all" && !groups.some((g) => g.id === this.sel)) {
        this.sel = "all";
        await this.reload();
      }
    } catch (e) {
      this.host.note(t("Закладки: {error}", { error: e instanceof Error ? e.message : String(e) }));
    }
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
