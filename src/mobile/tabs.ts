// DuoPulse — вкладки мобильной ветки (карточка duopulse-123): до неё плеер
// был один на всё приложение (iframe #mTab), «домой» убивал видео и после
// перезапуска приложение открывалось чистым. Здесь — много вкладок-видео:
// каждой свой iframe .m-tab (класс уже был у единственного), активная видна,
// фоновые скрыты [hidden] и поставлены на паузу (postMessage pauseVideo —
// enablejsapi=1 уже в src; display:none iframe Chromium дополнительно видит
// как hidden-документ и YouTube сам ставит паузу). Мульти-webview десктопа
// (child-webview) на Android недоступен — вкладки это iframe, не-YouTube
// адреса по-прежнему уходят в системный браузер (X-Frame-Options).
//
// Сессия живёт в localStorage (duopulse.mobile.tabs): список videoId/title +
// индекс активной; пишется на каждое изменение, в инкогнито не пишется и при
// входе в инкогнито стирается (не оставлять следов, карточка 096). Рестарт
// приложения восстанавливает вкладки: заголовки — из сессии, фоновые iframe
// грузятся лениво при первом переключении (память/трафик холодного старта),
// активная — без autoplay (жест не нужен, но автозвук после перезапуска
// приложения был бы неожиданным; пользователь нажимает play).
//
// Чистые функции (parse/план закрытия) покрыты тестами (tabs.test.ts);
// DOM-логика — MobileTabs, живой прогон на эмуляторе (как e2e/bookmarks).

/** Ключ сессии вкладок в localStorage. */
export const TABS_KEY = "duopulse.mobile.tabs";

/** Потолок вкладок: каждая — живой YouTube-плеер, на телефоне память не
 *  резиновая; свыше — открытие заменяет активную вкладку. */
export const MAX_TABS = 12;

/** videoId YouTube: 6–20 символов [\w-] (как videoIdOfEmbed). */
const VIDEO_ID_RE = /^[\w-]{6,20}$/;

/** Вкладка в рантайме: модель + её iframe (фоновые — возможно, ещё не
 *  загруженные: src присваивается при первой активации). */
export interface MobileTab {
  id: number;
  videoId: string;
  title: string;
  frame: HTMLIFrameElement;
}

/** Сохранённая сессия (localStorage): вкладки и индекс активной. */
export interface SavedTabs {
  tabs: { videoId: string; title: string }[];
  active: number;
}

/** Разбор сохранённой сессии: мусор/пусто — null, битые videoId выкидываются,
 *  активная за границами — первая, длина режется по MAX_TABS. */
export function parseSavedTabs(raw: string | null): SavedTabs | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  const tabs = v as { tabs?: unknown; active?: unknown };
  if (!tabs || !Array.isArray(tabs.tabs)) return null;
  const out: { videoId: string; title: string }[] = [];
  for (const t of tabs.tabs) {
    if (!t || typeof t !== "object") continue;
    const videoId = String((t as { videoId?: unknown }).videoId ?? "");
    if (!VIDEO_ID_RE.test(videoId)) continue;
    out.push({ videoId, title: String((t as { title?: unknown }).title ?? "").slice(0, 200) });
  }
  if (!out.length) return null;
  const list = out.slice(0, MAX_TABS);
  const active =
    typeof tabs.active === "number" && Number.isInteger(tabs.active) && tabs.active >= 0 && tabs.active < list.length
      ? tabs.active
      : 0;
  return { tabs: list, active };
}

/** Сериализация сессии для localStorage (парсится parseSavedTabs). */
export function serializeTabs(tabs: readonly { videoId: string; title: string }[], activeIdx: number): string {
  return JSON.stringify({
    tabs: tabs.map((t) => ({ videoId: t.videoId, title: t.title })),
    active: Math.max(0, Math.min(activeIdx, tabs.length - 1)),
  });
}

/** Какую вкладку активировать после закрытия closingId: закрыта фоновая —
 *  активная не меняется; закрыта активная — сосед справа, за краем списка —
 *  сосед слева; последняя — null (вкладок не осталось, стартовый экран). */
export function planAfterClose(order: readonly number[], closingId: number, activeId: number | null): number | null {
  const i = order.indexOf(closingId);
  if (i < 0) return activeId;
  if (activeId !== closingId) return activeId;
  const rest = order.filter((id) => id !== closingId);
  if (!rest.length) return null;
  return rest[Math.min(i, rest.length - 1)] ?? null;
}

/** Пауза плеера в iframe (прямой postMessage команды IFrame API —YT.Player
 *  на родителе для этого не нужен). Скрытие вкладки этим не лечится только
 *  если плеер ещё не инициализировался — тогда и играть нечему. */
export function pauseFrame(frame: HTMLIFrameElement): void {
  try {
    frame.contentWindow?.postMessage(
      JSON.stringify({ event: "command", func: "pauseVideo", args: [] }),
      "https://www.youtube.com",
    );
  } catch {
    /* кросс-доменный доступ не нужен, но пусть молчит */
  }
}

/** Что делает open() с видео: заменить активную вкладку (навигация в строке
 *  адреса — как вкладка Chrome) или открыть новую (закладки, «+»). */
export function planOpen(hasActive: boolean, newTab: boolean): "replace" | "create" {
  return hasActive && !newTab ? "replace" : "create";
}

/** Контекст мобильной ветки (mobile.ts). */
export interface TabsHost {
  /** .m-content — сюда вставляются iframe вкладок и лист переключателя. */
  content: HTMLElement;
  /** Шапка: сюда — кнопка-переключатель вкладок (перед «инкогнито»). */
  bar: HTMLElement;
  /** Строка статуса. */
  note: (text: string) => void;
  /** Инкогнито: сессию не писать и стереть при входе (096). */
  isPrivate: () => boolean;
  /** Активная вкладка сменилась (null — вкладок нет: стартовый экран). */
  onActive: (tab: MobileTab | null) => void;
}

/** Снимок для e2e-стендов (window.__duopulseMobileTabs). */
export interface TabsSnapshot {
  count: number;
  activeVideoId: string | null;
  tabs: { id: number; videoId: string; title: string; loaded: boolean }[];
  switcherOpen: boolean;
}

export class MobileTabs {
  private readonly frames = new Map<number, HTMLIFrameElement>();
  private readonly meta = new Map<number, { videoId: string; title: string }>();
  private order: number[] = [];
  private activeId: number | null = null;
  private seq = 0;

  /** Кнопка в шапке с бейджем количества и лист-переключатель. */
  private readonly btn: HTMLButtonElement;
  private readonly badge: HTMLElement;
  private readonly wrap: HTMLElement;
  private readonly listEl: HTMLElement;

  constructor(private readonly host: TabsHost) {
    this.btn = document.createElement("button");
    this.btn.id = "mTabsBtn";
    this.btn.className = "m-icon m-tabs-btn";
    this.btn.title = "Вкладки";
    this.btn.setAttribute("aria-label", "Вкладки");
    this.btn.innerHTML =
      '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 7h12"/></svg><span class="m-tabs-badge" hidden></span>';
    this.badge = this.btn.querySelector(".m-tabs-badge")!;
    this.btn.addEventListener("click", () => this.setSwitcher(!this.switcherOpen));
    host.bar.insertBefore(this.btn, host.bar.querySelector("#mPrivate"));

    this.wrap = document.createElement("div");
    this.wrap.className = "m-sheet-wrap m-tabs-wrap";
    this.wrap.hidden = true;
    this.wrap.innerHTML = `
      <div class="m-sheet-backdrop"></div>
      <div class="m-sheet m-tabs-sheet" role="menu" aria-label="Вкладки">
        <b class="m-tabs-head">Вкладки</b>
        <div class="m-tabs-list"></div>
        <button type="button" class="m-sheet-item m-tabs-new">+ Новая вкладка</button>
        <button type="button" class="m-sheet-item m-tabs-close-all">Закрыть все</button>
      </div>
    `;
    host.content.append(this.wrap);
    this.listEl = this.wrap.querySelector(".m-tabs-list")!;
    this.wrap.querySelector(".m-sheet-backdrop")!.addEventListener("click", () => this.setSwitcher(false));
    this.wrap.querySelector<HTMLButtonElement>(".m-tabs-new")!.addEventListener("click", () => {
      this.setSwitcher(false);
      this.newTab();
    });
    this.wrap.querySelector<HTMLButtonElement>(".m-tabs-close-all")!.addEventListener("click", () => {
      this.setSwitcher(false);
      this.closeAll();
    });

    // Тест-хук e2e-стендов (как __bmDebug/__duoDebug).
    (window as unknown as { __duopulseMobileTabs?: () => unknown }).__duopulseMobileTabs = () => this.snapshot();
  }

  get count(): number {
    return this.order.length;
  }

  get active(): MobileTab | null {
    if (this.activeId === null) return null;
    const frame = this.frames.get(this.activeId) ?? null;
    const m = this.meta.get(this.activeId);
    return frame && m ? { id: this.activeId, videoId: m.videoId, title: m.title, frame } : null;
  }

  /** Если активная вкладка не загружена — null (плеера нет). */
  get activeFrame(): HTMLIFrameElement | null {
    return this.active?.frame ?? null;
  }

  private get switcherOpen(): boolean {
    return !this.wrap.hidden;
  }

  /** Открыть видео: заменить активную вкладку или создать новую (план —
   *  planOpen; на потолке MAX_TABS всегда замена — последней вкладки, если
   *  активной нет). */
  open(videoId: string, title = "", newTab = false): void {
    const cur = this.active;
    if (cur && planOpen(cur !== null, newTab) === "replace") {
      this.meta.set(cur.id, { videoId, title });
      this.loadFrame(cur.id);
      this.activate(cur.id);
      return;
    }
    if (this.order.length >= MAX_TABS) {
      const id = cur?.id ?? this.order[this.order.length - 1];
      this.meta.set(id, { videoId, title });
      this.loadFrame(id);
      this.activate(id);
      this.host.note(`Максимум ${MAX_TABS} вкладок — видео открыто в последней`);
      return;
    }
    const id = ++this.seq;
    this.meta.set(id, { videoId, title });
    this.frames.set(id, this.makeFrame());
    this.order.push(id);
    this.activate(id);
  }

  /** Указать заголовок видео (mobile.ts после duo-загрузки) — для списка
   *  вкладок и сохранённой сессии. */
  setTitle(videoId: string, title: string): void {
    for (const id of this.order) {
      const m = this.meta.get(id);
      if (m?.videoId === videoId && title && title !== m.title) {
        m.title = title;
        this.persist();
        if (this.switcherOpen) this.renderSwitcher();
      }
    }
  }

  /** Активировать вкладку (переключение из листа; загрузка ленивой рамки). */
  switchTo(id: number): void {
    if (!this.order.includes(id)) return;
    this.activate(id);
  }

  /** «Домой»/«+ Новая вкладка»: активной вкладки нет, видео сняты с пауз —
   *  вкладки остаются жить в фоне и в списке. */
  newTab(): void {
    this.deactivateActive();
    this.activeId = null;
    this.persist();
    this.renderBadge();
    this.host.onActive(null);
  }

  /** Закрыть вкладку (крестик в листе). */
  close(id: number): void {
    if (!this.order.includes(id)) return;
    const next = planAfterClose(this.order, id, this.activeId);
    const frame = this.frames.get(id);
    if (frame) {
      if (this.activeId === id) pauseFrame(frame);
      frame.remove();
    }
    this.frames.delete(id);
    this.meta.delete(id);
    this.order = this.order.filter((x) => x !== id);
    if (this.activeId === id) {
      this.activeId = null;
      if (next !== null) this.activate(next);
      else {
        this.persist();
        this.renderBadge();
        this.host.onActive(null);
      }
    } else {
      this.persist();
      this.renderBadge();
    }
    if (this.switcherOpen) {
      if (!this.order.length) this.setSwitcher(false);
      else this.renderSwitcher();
    }
  }

  /** Закрыть всё (выход из инкогнито): на стартовый экран. */
  closeAll(): void {
    for (const id of this.order) {
      const frame = this.frames.get(id);
      if (frame) {
        pauseFrame(frame);
        frame.remove();
      }
    }
    this.frames.clear();
    this.meta.clear();
    this.order = [];
    this.activeId = null;
    this.persist();
    this.renderBadge();
    this.host.onActive(null);
  }

  /** Стереть сохранённую сессию (вход в инкогнито — не оставлять следов). */
  clearPersisted(): void {
    try {
      localStorage.removeItem(TABS_KEY);
    } catch {
      /* нет localStorage — нечего стирать */
    }
  }

  /** Восстановить сессию после перезапуска (parseSavedTabs уже проверил):
   *  фоновые — ленивые, активная грузится сразу. Пусто — ничего. */
  restore(saved: SavedTabs): void {
    for (const t of saved.tabs) {
      const id = ++this.seq;
      this.meta.set(id, { videoId: t.videoId, title: t.title });
      this.frames.set(id, this.makeFrame());
      this.order.push(id);
    }
    this.activate(saved.tabs.length ? this.order[Math.min(saved.active, this.order.length - 1)] : this.order[0]);
    if (this.order.length) this.host.note(`Восстановлено вкладок: ${this.order.length}`);
  }

  /** Показать/спрятать контент вкладок (просмотрщик PDF поверх). */
  setVisible(visible: boolean): void {
    for (const frame of this.frames.values()) {
      if (visible && this.frames.get(this.activeId ?? -1) === frame) frame.hidden = false;
      else frame.hidden = true;
    }
  }

  private makeFrame(): HTMLIFrameElement {
    const f = document.createElement("iframe");
    f.className = "m-tab";
    f.title = "Страница";
    f.hidden = true;
    f.allow = "autoplay; fullscreen; encrypted-media; picture-in-picture";
    f.referrerPolicy = "no-referrer-when-downgrade";
    this.host.content.append(f);
    return f;
  }

  /** src вкладки: канонический embed (как был у единственного #mTab). */
  private loadFrame(id: number): void {
    const m = this.meta.get(id);
    const frame = this.frames.get(id);
    if (!m || !frame) return;
    frame.src = `https://www.youtube.com/embed/${m.videoId}?enablejsapi=1`;
  }

  /** Скрыть и поставить на паузу прежнюю активную (если была). */
  private deactivateActive(): void {
    if (this.activeId === null) return;
    const frame = this.frames.get(this.activeId);
    if (frame) {
      pauseFrame(frame);
      frame.hidden = true;
    }
  }

  private activate(id: number): void {
    this.deactivateActive();
    this.activeId = id;
    const frame = this.frames.get(id)!;
    if (!frame.src || frame.src === "about:blank") this.loadFrame(id); // ленивая рамка
    frame.hidden = false;
    this.persist();
    this.renderBadge();
    this.host.onActive(this.active);
  }

  private renderBadge(): void {
    this.badge.textContent = String(this.order.length || "");
    this.badge.hidden = this.order.length === 0;
    this.btn.title = this.order.length ? `Вкладки (${this.order.length})` : "Вкладки";
  }

  private setSwitcher(open: boolean): void {
    this.wrap.hidden = !open;
    if (open) this.renderSwitcher();
  }

  /** Список вкладок в листе: заголовок/ID, активная подсвечена, ✕ закрывает. */
  private renderSwitcher(): void {
    const rows: HTMLElement[] = [];
    for (const id of this.order) {
      const m = this.meta.get(id)!;
      const row = document.createElement("div");
      row.className = "m-tabs-row" + (id === this.activeId ? " m-on" : "");
      const main = document.createElement("button");
      main.type = "button";
      main.className = "m-tabs-main";
      main.textContent = m.title || `видео ${m.videoId}`;
      main.addEventListener("click", () => {
        this.setSwitcher(false);
        this.switchTo(id);
      });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "m-tabs-del";
      del.title = "Закрыть вкладку";
      del.setAttribute("aria-label", "Закрыть вкладку");
      del.textContent = "✕";
      del.addEventListener("click", () => this.close(id));
      row.append(main, del);
      rows.push(row);
    }
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "m-bm-empty";
      empty.textContent = "Вкладок нет — откройте видео или нажмите «+ Новая вкладка»";
      rows.push(empty);
    }
    this.listEl.replaceChildren(...rows);
  }

  private snapshot(): TabsSnapshot {
    return {
      count: this.order.length,
      activeVideoId: this.active?.videoId ?? null,
      tabs: this.order.map((id) => {
        const m = this.meta.get(id)!;
        const f = this.frames.get(id);
        return { id, videoId: m.videoId, title: m.title, loaded: !!f?.src && f.src !== "about:blank" };
      }),
      switcherOpen: this.switcherOpen,
    };
  }

  /** Сессия в localStorage: в инкогнито не пишем (и стираем на входе). */
  private persist(): void {
    if (this.host.isPrivate()) return;
    try {
      if (!this.order.length) {
        localStorage.removeItem(TABS_KEY);
        return;
      }
      const tabs = this.order.map((id) => this.meta.get(id)!);
      localStorage.setItem(TABS_KEY, serializeTabs(tabs, this.order.indexOf(this.activeId ?? this.order[0])));
    } catch {
      /* нет localStorage — сессия живёт до перезапуска */
    }
  }
}
