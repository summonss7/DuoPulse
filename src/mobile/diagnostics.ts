// DuoPulse — лист «Диагностика» мобильной ветки (карточка duopulse-164,
// паритет 1/8 аудита duopulse-156): десктопная страница duopulse://diagnostics
// (метрики P-01..P-08, история прогонов) — десктопные бюджеты, на мобильную
// не переносится. Здесь — снимок состояния для поддержки: версия/канал/сеанс/
// память, вкладки, счётчики истории/закладок/паролей, адблок, обновления;
// данные — команда diag_snapshot Core (src-tauri/src/mobile_diag.rs; вкладки
// и метка последней проверки — состояние фронта, уходят параметрами, проверка
// по сети НЕ выполняется). «Скопировать отчёт» — mobile_clipboard_copy
// (MobileClipboardHelper) + тост строкой статуса. Секции — по группам
// (приложение/данные/блокировщик/обновления): будущие VPN/ASR (этапы 6–8
// цепочки duopulse-162) дописывают свою секцию в diagSections без переделки
// каркаса. Паттерн листа — m-sheet (history.ts), тест-хук для e2e —
// window.__duopulseMobileDiagnostics.

import { invoke } from "@tauri-apps/api/core";
import { t, uiLocale } from "../i18n";

/** Снимок diag_snapshot (зеркало Rust DiagSnapshot, camelCase). */
export interface DiagSnapshot {
  appVersion: string;
  channel: string;
  sessionSecs: number;
  rssKb: number | null;
  tabs: number;
  historyEntries: number;
  bookmarks: number;
  passwords: number;
  adblock: { enabled: boolean; ready: boolean; blockedTotal: number; seenTotal: number } | null;
  lastUpdateCheckMs: number | null;
  nowMs: number;
}

/** Состояние обновлений для листа (из updater.ts/localStorage). */
export interface DiagUpdate {
  /** Метка последней проверки, unix-ms (null — не проверяли). */
  lastCheckMs: number | null;
  /** Доступная версия баннера «⬆ Доступна версия X» (null — нет). */
  availableVersion: string | null;
}

/** Длительность сеанса строкой: «{h} ч {m} мин» / «{n} мин». */
export function sessionDur(secs: number): string {
  return secs >= 3600
    ? t("{h} ч {m} мин", {
        h: Math.floor(secs / 3600),
        m: Math.floor((secs % 3600) / 60),
      })
    : t("{n} мин", { n: Math.floor(secs / 60) });
}

/** Локальные дата-время компактно (для меток проверок и отчёта). */
export function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString(uiLocale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Секция листа: заголовок-группа + строки (строки — цельные переводы,
 *  значения уже подставлены: порядок слов в переводах свой). */
export interface DiagSection {
  title: string;
  rows: string[];
}

/** Снимок → секции (чистая — vitest). Группы: приложение, данные,
 *  блокировщик, обновления; будущие VPN/ASR — дописать сюда. */
export function diagSections(snap: DiagSnapshot, upd: DiagUpdate): DiagSection[] {
  const app: DiagSection = {
    title: t("Приложение"),
    rows: [
      t("Версия: {v}", { v: snap.appVersion }),
      t("Канал обновлений: {v}", { v: snap.channel }),
      t("Сеанс: {v}", { v: sessionDur(snap.sessionSecs) }),
      t("Память процесса: {v}", {
        v:
          snap.rssKb == null
            ? "—"
            : t("{n} МБ", { n: Math.round(snap.rssKb / 1024) }),
      }),
    ],
  };
  const data: DiagSection = {
    title: t("Данные"),
    rows: [
      t("Открыто вкладок: {n}", { n: snap.tabs }),
      t("История: {n}", { n: snap.historyEntries }),
      t("Закладки: {n}", { n: snap.bookmarks }),
      t("Пароли: {n}", { n: snap.passwords }),
    ],
  };
  const ad: DiagSection = { title: t("Блокировщик рекламы"), rows: [] };
  if (!snap.adblock) ad.rows.push(t("Адблок: недоступен"));
  else if (!snap.adblock.enabled) ad.rows.push(t("Адблок: выключен"));
  else
    ad.rows.push(
      t("Адблок: заблокировано {b} из {s} запросов", {
        b: snap.adblock.blockedTotal,
        s: snap.adblock.seenTotal,
      }),
      snap.adblock.ready ? t("списки готовы") : t("списки грузятся"),
    );
  const updates: DiagSection = {
    title: t("Обновления"),
    rows: [
      upd.availableVersion
        ? t("Обновления: доступна версия {v}", { v: upd.availableVersion })
        : upd.lastCheckMs != null
          ? t("Обновления: проверялись {d}", { d: fmtWhen(upd.lastCheckMs) })
          : t("Обновления: ещё не проверялись"),
    ],
  };
  return [app, data, ad, updates];
}

/** Полный текст отчёта (кнопка «Скопировать отчёт»): заголовок с версией
 *  и временем снимка, секции с заголовками. */
export function formatDiagReport(snap: DiagSnapshot, upd: DiagUpdate): string {
  const head = `DuoPulse ${snap.appVersion} — ${fmtWhen(snap.nowMs)}`;
  const body = diagSections(snap, upd)
    .map((s) => [s.title, ...s.rows].join("\n"))
    .join("\n\n");
  return `${head}\n\n${body}\n`;
}

/** Снимок для e2e-стендов (window.__duopulseMobileDiagnostics). */
export interface DiagnosticsSnapshot {
  open: boolean;
  sections: number;
  rows: number;
  report: string;
}

/** Контекст мобильной ветки (mobile.ts). */
export interface DiagHost {
  /** .m-content — сюда лист. */
  content: HTMLElement;
  /** Строка статуса (тосты копирования). */
  note: (text: string) => void;
  /** Открытых вкладок (состояние фронта — MobileTabs). */
  tabsCount: () => number;
  /** Метка последней проверки обновлений (localStorage, updater.ts). */
  lastUpdateCheckMs: () => number | null;
  /** Доступная версия баннера обновлений (нет — null). */
  updateAvailableVersion: () => string | null;
}

export class MobileDiagnostics {
  private readonly wrap: HTMLElement;
  private readonly listEl: HTMLElement;
  private report = "";
  private sections = 0;
  private rows = 0;

  constructor(private readonly host: DiagHost) {
    this.wrap = document.createElement("div");
    this.wrap.className = "m-sheet-wrap m-tabs-wrap";
    this.wrap.hidden = true;
    this.wrap.innerHTML = `
      <div class="m-sheet-backdrop"></div>
      <div class="m-sheet m-tabs-sheet m-diag" role="menu" aria-label="${t("Диагностика")}">
        <b class="m-tabs-head">${t("Диагностика")}</b>
        <div class="m-tabs-list m-diag-list"></div>
        <button type="button" class="m-sheet-item m-diag-copy">${t("Скопировать отчёт")}</button>
      </div>
    `;
    host.content.append(this.wrap);
    this.listEl = this.wrap.querySelector(".m-diag-list")!;
    this.wrap.querySelector(".m-sheet-backdrop")!.addEventListener("click", () => this.close());
    this.wrap.querySelector<HTMLButtonElement>(".m-diag-copy")!.addEventListener("click", () => void this.copy());
    // Тест-хук e2e-стендов (как __duopulseMobileHistory).
    (window as unknown as { __duopulseMobileDiagnostics?: () => unknown }).__duopulseMobileDiagnostics =
      () => this.snapshot();
  }

  /** Показать/спрятать лист; открытие перечитывает снимок. */
  setSheet(open: boolean): void {
    this.wrap.hidden = !open;
    if (open)
      void this.reload().catch(() => this.host.note(t("Диагностика: не удалось прочитать")));
  }

  private close(): void {
    this.setSheet(false);
  }

  private async reload(): Promise<void> {
    const lastCheck = this.host.lastUpdateCheckMs();
    const snap = await invoke<DiagSnapshot>("diag_snapshot", {
      tabs: this.host.tabsCount(),
      lastUpdateCheckMs: lastCheck,
    });
    const upd: DiagUpdate = {
      lastCheckMs: lastCheck,
      availableVersion: this.host.updateAvailableVersion(),
    };
    this.report = formatDiagReport(snap, upd);
    this.render(diagSections(snap, upd));
  }

  /** Секции: заголовок-группа, под ним строки-значения. */
  private render(sections: DiagSection[]): void {
    const kids: HTMLElement[] = [];
    let rows = 0;
    for (const s of sections) {
      const head = document.createElement("div");
      head.className = "m-diag-sec";
      head.textContent = s.title;
      kids.push(head);
      for (const row of s.rows) {
        const el = document.createElement("div");
        el.className = "m-diag-row";
        el.textContent = row;
        kids.push(el);
        rows += 1;
      }
    }
    this.sections = sections.length;
    this.rows = rows;
    this.listEl.replaceChildren(...kids);
  }

  /** Отчёт в буфер обмена (MobileClipboardHelper) + тост строкой статуса. */
  private async copy(): Promise<void> {
    if (!this.report) return;
    try {
      await invoke("mobile_clipboard_copy", { text: this.report });
      this.host.note(t("Отчёт скопирован"));
    } catch {
      this.host.note(t("Не удалось скопировать отчёт"));
    }
  }

  private snapshot(): DiagnosticsSnapshot {
    return {
      open: !this.wrap.hidden,
      sections: this.sections,
      rows: this.rows,
      report: this.report,
    };
  }
}
