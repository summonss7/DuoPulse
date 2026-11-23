// DuoPulse — модель индикатора загрузок кнопки «⬇» навбара (карточка
// duopulse-158; слияние индикатора с кнопкой панели «Скачать» — duopulse-222:
// две кнопки с одной и той же панелью путали): чистые счётчики и правила
// показа/подсказки, DOM не знают — применение к кнопке в
// src/download-panel/panel.ts (initDownloadButton), юнит-тесты
// dl-indicator-model.test.ts (паттерн update-badge).
import { t } from "../i18n";

/** Состояние индикатора (счётчики активных загрузок). */
export interface DlIndicatorState {
  /** Качающиеся файловые загрузки. */
  activeFiles: number;
  /** Качающиеся медиа-задания (yt-dlp). */
  activeMedia: number;
}

export const emptyDlIndicatorState = (): DlIndicatorState => ({
  activeFiles: 0,
  activeMedia: 0,
});

/** Сколько загрузок качается сейчас (файлы страниц + медиа-задания). */
export function indicatorActive(s: DlIndicatorState): number {
  return s.activeFiles + s.activeMedia;
}

/** Кнопку «⬇» показывать: http(s)-вкладка (есть что скачать со страницы)
 *  или что-то качается (пульс даже на внутренней вкладке) — иначе скрыта;
 *  одна кнопка вместо двух с одной панелью (duopulse-222). */
export function dlButtonVisible(httpTab: boolean, s: DlIndicatorState): boolean {
  return httpTab || indicatorActive(s) > 0;
}

/** Подсказка кнопки: базовая + счётчик активных («скачивается: N»). */
export function indicatorTitle(base: string, s: DlIndicatorState): string {
  const active = indicatorActive(s);
  return active > 0 ? `${base} — ${t("скачивается: {n}", { n: String(active) })}` : base;
}
