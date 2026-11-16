// DuoPulse — модель индикатора загрузок навбара (карточка duopulse-158):
// чистые счётчики и правила показа/подсказки, DOM не знают — применение к
// кнопке в dl-indicator.ts, юнит-тесты dl-indicator-model.test.ts
// (паттерн update-badge).
import { t } from "../i18n";

/** Состояние индикатора (счётчики активных и свежих загрузок). */
export interface DlIndicatorState {
  /** Качающиеся файловые загрузки. */
  activeFiles: number;
  /** Качающиеся медиа-задания (yt-dlp). */
  activeMedia: number;
  /** Файловые загрузки сеанса (живые + завершённые). */
  recentFiles: number;
}

export const emptyDlIndicatorState = (): DlIndicatorState => ({
  activeFiles: 0,
  activeMedia: 0,
  recentFiles: 0,
});

/** Кнопку показывать: что-то качается или в сеансе были файловые загрузки. */
export function indicatorVisible(s: DlIndicatorState): boolean {
  return s.activeFiles > 0 || s.activeMedia > 0 || s.recentFiles > 0;
}

/** Подсказка кнопки: базовая «Загрузки», активные — «Загрузки — скачивается: N». */
export function indicatorTitle(s: DlIndicatorState, base = t("Загрузки")): string {
  const active = s.activeFiles + s.activeMedia;
  return active > 0 ? `${base} — ${t("скачивается: {n}", { n: String(active) })}` : base;
}
