// DuoPulse — модель индикатора загрузок кнопки «⬇» навбара (карточки
// 158/222): показ/скрытие и подсказка по счётчикам активных загрузок и типу
// вкладки. Файлы и медиа считаются вместе; на внутренней вкладке кнопка
// живёт только пока что-то качается — постоянного дубля двух кнопок с одной
// панелью «Скачать» больше нет (дуопульс-222).
import { describe, expect, it } from "vitest";
import {
  dlButtonVisible,
  emptyDlIndicatorState,
  indicatorActive,
  indicatorTitle,
} from "./dl-indicator-model";

describe("dlButtonVisible — показ кнопки «⬇»", () => {
  it("покой на внутренней вкладке — кнопки нет", () => {
    expect(dlButtonVisible(false, emptyDlIndicatorState())).toBe(false);
  });

  it("http(s)-вкладка — кнопка видна и без загрузок", () => {
    expect(dlButtonVisible(true, emptyDlIndicatorState())).toBe(true);
  });

  it("качается файл или медиа — видна и на внутренней вкладке", () => {
    expect(dlButtonVisible(false, { activeFiles: 1, activeMedia: 0 })).toBe(true);
    expect(dlButtonVisible(false, { activeFiles: 0, activeMedia: 2 })).toBe(true);
  });

  it("всё закончилось на внутренней вкладке — кнопка гаснет (нет дубля, 222)", () => {
    expect(dlButtonVisible(false, { activeFiles: 0, activeMedia: 0 })).toBe(false);
  });
});

describe("indicatorActive / indicatorTitle — счётчик и подсказка", () => {
  it("активные суммируются: файлы + медиа", () => {
    expect(indicatorActive({ activeFiles: 1, activeMedia: 1 })).toBe(2);
    expect(indicatorActive(emptyDlIndicatorState())).toBe(0);
  });

  it("покой — базовый текст", () => {
    expect(indicatorTitle("Загрузки", emptyDlIndicatorState())).toBe("Загрузки");
  });

  it("активные — счётчик в подсказке", () => {
    expect(indicatorTitle("Загрузки", { activeFiles: 1, activeMedia: 1 })).toContain("2");
  });
});
