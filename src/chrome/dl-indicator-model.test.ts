// DuoPulse — модель индикатора загрузок навбара (карточка duopulse-158):
// показ/скрытие кнопки и подсказка по счётчикам активных/свежих загрузок.
// Файлы и медиа считаются вместе; после завершения кнопка живёт на
// «свежих файловых» до конца сеанса (инвариант зеркален реестру Core).
import { describe, expect, it } from "vitest";
import { emptyDlIndicatorState, indicatorTitle, indicatorVisible } from "./dl-indicator-model";

describe("indicatorVisible — показ кнопки загрузок", () => {
  it("пустое состояние — кнопки нет", () => {
    expect(indicatorVisible(emptyDlIndicatorState())).toBe(false);
  });

  it("качается файл или медиа — кнопка видна", () => {
    expect(indicatorVisible({ activeFiles: 1, activeMedia: 0, recentFiles: 1 })).toBe(true);
    expect(indicatorVisible({ activeFiles: 0, activeMedia: 2, recentFiles: 0 })).toBe(true);
  });

  it("всё закончилось, но файлы в сеансе были — кнопка остаётся", () => {
    expect(indicatorVisible({ activeFiles: 0, activeMedia: 0, recentFiles: 3 })).toBe(true);
  });
});

describe("indicatorTitle — подсказка кнопки", () => {
  it("покой — базовый текст", () => {
    expect(indicatorTitle(emptyDlIndicatorState(), "Загрузки")).toBe("Загрузки");
  });

  it("активные суммируются: файлы + медиа", () => {
    const title = indicatorTitle({ activeFiles: 1, activeMedia: 1, recentFiles: 2 }, "Загрузки");
    expect(title).toContain("2");
  });
});
