// Тесты чистого ядра детектора замерзания плеера (duopulse-082, живой смоук
// 08.11: после сворачивания WebView-плеер YouTube замирает при кэше state=1).
// Само лечение (reload iframe + revive) — интеграционно, см. смоук карточки.

import { describe, expect, it } from "vitest";
import { FREEZE_MS, freezeStep } from "./clock";

const T0 = 1_000_000;

describe("freezeStep (детектор замерзания)", () => {
  it("время идёт при игре — момент прогресса свежий", () => {
    expect(freezeStep(T0, T0 + 150, 0.15, 1, true)).toBe(T0 + 150);
  });

  it("играет, но время стоит на видимой странице — копится (замерзание)", () => {
    // единственный случай, когда момент прогресса НЕ обновляется
    expect(freezeStep(T0, T0 + 150, 0, 1, true)).toBe(T0);
    expect(freezeStep(T0, T0 + 150, -0.001, 1, true)).toBe(T0);
  });

  it("пауза (state≠1) — детектор разряжен, копить нельзя", () => {
    expect(freezeStep(T0, T0 + 150, 0, 2, true)).toBe(T0 + 150);
    expect(freezeStep(T0, T0 + 150, 0, 0, true)).toBe(T0 + 150); // ended
    expect(freezeStep(T0, T0 + 150, 0, 3, true)).toBe(T0 + 150); // buffering
  });

  it("страница скрыта (фон) — затишье легитимно, детектор разряжен", () => {
    expect(freezeStep(T0, T0 + 10_000, 0, 1, false)).toBe(T0 + 10_000);
  });

  it("порог — 5 с: затык буферизации короче порога лечения не зовёт", () => {
    expect(FREEZE_MS).toBe(5000);
    expect(FREEZE_MS).toBeGreaterThan(4000); // буферизационные паузы 3–4 с — ложных срабатываний нет
  });
});
