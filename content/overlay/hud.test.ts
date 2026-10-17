// HUD синхронизации (задача 3.5): чистые функции — формат индикации и шаг
// сдвига с клампом (docs/03 §4 п.3: ±10 с, шаг 100 мс). DOM-поведение HUD
// (появление/автоскрытие/слайдер) — e2e-стенд subtitles.
import { describe, expect, it } from "vitest";
import { formatOffsetMs, stepOffset, OFFSET_STEP_MS } from "./hud";
import { OFFSET_LIMIT_MS } from "../engine/subtitles-engine";

describe("formatOffsetMs — индикация сдвига", () => {
  it("0 — «0 с»", () => {
    expect(formatOffsetMs(0)).toBe("0 с");
  });

  it("положительный — «+» и одна десятая секунды (запятая)", () => {
    expect(formatOffsetMs(300)).toBe("+0,3 с");
    expect(formatOffsetMs(1000)).toBe("+1,0 с");
    expect(formatOffsetMs(10000)).toBe("+10,0 с");
  });

  it("отрицательный — типографский минус", () => {
    expect(formatOffsetMs(-100)).toBe("−0,1 с");
    expect(formatOffsetMs(-2500)).toBe("−2,5 с");
  });
});

describe("stepOffset — шаг сдвига колесом/клавишей (docs/03 §4)", () => {
  it("шаг 100 мс по направлению", () => {
    expect(stepOffset(0, 1)).toBe(OFFSET_STEP_MS);
    expect(stepOffset(0, -1)).toBe(-OFFSET_STEP_MS);
    expect(stepOffset(300, 1)).toBe(400);
  });

  it("кламп в ±10 с (docs/03 §4), дальше шаг не двигает", () => {
    expect(stepOffset(OFFSET_LIMIT_MS, 1)).toBe(OFFSET_LIMIT_MS);
    expect(stepOffset(-OFFSET_LIMIT_MS, -1)).toBe(-OFFSET_LIMIT_MS);
  });
});
