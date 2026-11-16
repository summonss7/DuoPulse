// DuoPulse — история посещений мобильной ветки (duopulse-156: паритет базовых
// функций с десктопом — на десктопе визиты пишет Core из on_page_load и есть
// страница duopulse://history; на мобильной обёртке Core загрузок вкладок не
// видит, поэтому визиты пишет фронт ветки: видео-вкладки — из onTabActive,
// страницы web-оверлея — хук __duopulseVisit из onPageFinished Kotlin-хелпера).
// Хранилище и команды — те же history.visit/list/delete_urls/delete_range
// (SQLite в профиле, HistoryStore общий с десктопом; дедуп визитов 60 с —
// внутри стора). Здесь — запись (record: инкогнито молчит) и лист «История»
// в меню «⋮»: группы по дням («Сегодня»/«Вчера»/дата), тап — открыть, ✕ —
// удалить адрес, «Очистить историю» — delete_range за всё время.
import { bridge } from "../bridge";
import type { HistoryEntry } from "../bridge";
import { t, uiLocale } from "../i18n";

/** Страница выдачи листа (как у страницы истории десктопа). */
const PAGE_LIMIT = 100;

/** Контекст мобильной ветки (mobile.ts). */
export interface HistoryHost {
  /** .m-content — сюда лист. */
  content: HTMLElement;
  /** Строка статуса. */
  note: (text: string) => void;
  /** Инкогнито: визиты не пишем (записи листа при этом видны). */
  isPrivate: () => boolean;
  /** Открыть адрес (видео — вкладкой, прочее — web-оверлей). */
  open: (url: string) => void;
}

/** Локальный день визита (YYYY-MM-DD по часам устройства) — ключ группы. */
export function dayKeyOf(tsMs: number): string {
  const d = new Date(tsMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Заголовок группы по дню — как у страницы истории десктопа: «Сегодня»,
 *  «Вчера», иначе полная дата локалью UI. */
export function dayLabelOf(tsMs: number, nowMs: number): string {
  const day = new Date(tsMs);
  const now = new Date(nowMs);
  const diff = Math.floor(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()) /
      86_400_000,
  );
  if (diff === 0) return t("Сегодня");
  if (diff === 1) return t("Вчера");
  return day.toLocaleDateString(uiLocale, { day: "numeric", month: "long", year: "numeric" });
}

/** Снимок для e2e-стендов (window.__duopulseMobileHistory). */
export interface HistorySnapshot {
  open: boolean;
  total: number;
  entries: number;
}

export class MobileHistory {
  private readonly wrap: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly moreBtn: HTMLButtonElement;
  private entries: HistoryEntry[] = [];
  private total = 0;

  constructor(private readonly host: HistoryHost) {
    this.wrap = document.createElement("div");
    this.wrap.className = "m-sheet-wrap m-tabs-wrap";
    this.wrap.hidden = true;
    this.wrap.innerHTML = `
      <div class="m-sheet-backdrop"></div>
      <div class="m-sheet m-tabs-sheet m-hist" role="menu" aria-label="${t("История")}">
        <b class="m-tabs-head">${t("История")}</b>
        <div class="m-tabs-list"></div>
        <button type="button" class="m-sheet-item m-hist-more" hidden>${t("Показать ещё")}</button>
        <button type="button" class="m-sheet-item m-hist-clear">${t("Очистить историю")}</button>
      </div>
    `;
    host.content.append(this.wrap);
    this.listEl = this.wrap.querySelector(".m-tabs-list")!;
    this.moreBtn = this.wrap.querySelector<HTMLButtonElement>(".m-hist-more")!;
    this.wrap.querySelector(".m-sheet-backdrop")!.addEventListener("click", () => this.close());
    this.moreBtn.addEventListener("click", () => void this.loadMore());
    this.wrap.querySelector<HTMLButtonElement>(".m-hist-clear")!.addEventListener("click", () => {
      void this.clear();
    });
    // Тест-хук e2e-стендов (как __duopulseMobileTabs).
    (window as unknown as { __duopulseMobileHistory?: () => unknown }).__duopulseMobileHistory =
      () => this.snapshot();
  }

  /** Записать посещение (видео-вкладка / страница оверлея): инкогнито —
   *  молча не пишем; http(s) только, длины урезаны (хук зовёт Kotlin). */
  record(url: string, title: string): void {
    if (this.host.isPrivate()) return;
    if (!/^https?:\/\//i.test(url)) return;
    void bridge.history
      .visit({ url: url.slice(0, 2000), title: title.slice(0, 300) })
      .catch(() => {});
  }

  /** Показать/спрятать лист; открытие перечитывает выдачу. */
  setSheet(open: boolean): void {
    this.wrap.hidden = !open;
    if (open) void this.reload().catch(() => this.host.note(t("История: не удалось прочитать")));
  }

  private close(): void {
    this.setSheet(false);
  }

  private async reload(): Promise<void> {
    const res = await bridge.history.list({ offset: 0, limit: PAGE_LIMIT });
    this.entries = res.entries;
    this.total = res.total;
    this.render();
  }

  private async loadMore(): Promise<void> {
    const res = await bridge.history.list({ offset: this.entries.length, limit: PAGE_LIMIT });
    // свежие удаления могли сдвинуть окно — дедуп по url
    const known = new Set(this.entries.map((e) => e.url));
    this.entries = [...this.entries, ...res.entries.filter((e) => !known.has(e.url))];
    this.total = res.total;
    this.render();
  }

  private async remove(url: string): Promise<void> {
    await bridge.history.deleteUrls({ urls: [url] });
    this.entries = this.entries.filter((e) => e.url !== url);
    this.total = Math.max(0, this.total - 1);
    this.render();
  }

  private async clear(): Promise<void> {
    await bridge.history.deleteRange({ fromMs: 0, toMs: Date.now() + 86_400_000 });
    this.entries = [];
    this.total = 0;
    this.render();
    this.host.note(t("История очищена"));
  }

  /** Список группами по дням: заголовок дня, строки «время · заголовок». */
  private render(): void {
    const rows: HTMLElement[] = [];
    const now = Date.now();
    let lastDay = "";
    for (const e of this.entries) {
      const key = dayKeyOf(e.lastVisitedAt);
      if (key !== lastDay) {
        lastDay = key;
        const head = document.createElement("div");
        head.className = "m-hist-day";
        head.textContent = dayLabelOf(e.lastVisitedAt, now);
        rows.push(head);
      }
      const row = document.createElement("div");
      row.className = "m-tabs-row";
      const main = document.createElement("button");
      main.type = "button";
      main.className = "m-tabs-main";
      const time = new Date(e.lastVisitedAt).toLocaleTimeString(uiLocale, {
        hour: "2-digit",
        minute: "2-digit",
      });
      main.innerHTML = "";
      const title = document.createElement("span");
      title.className = "m-hist-title";
      title.textContent = e.title || e.url;
      const sub = document.createElement("span");
      sub.className = "m-hist-sub";
      sub.textContent = e.visitCount > 1 ? `${time} · ${t("посещений: {n}", { n: e.visitCount })}` : time;
      main.append(title, sub);
      main.addEventListener("click", () => {
        this.close();
        this.host.open(e.url);
      });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "m-tabs-del";
      del.title = t("Убрать из истории");
      del.setAttribute("aria-label", t("Убрать из истории"));
      del.textContent = "✕";
      del.addEventListener("click", () => void this.remove(e.url));
      row.append(main, del);
      rows.push(row);
    }
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "m-bm-empty";
      empty.textContent = t("История пуста");
      rows.push(empty);
    }
    this.moreBtn.hidden = this.entries.length >= this.total;
    this.listEl.replaceChildren(...rows);
  }

  private snapshot(): HistorySnapshot {
    return {
      open: !this.wrap.hidden,
      total: this.total,
      entries: this.entries.length,
    };
  }
}
