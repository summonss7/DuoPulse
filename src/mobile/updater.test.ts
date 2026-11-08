// Тесты чистой части OTA мобильной ветки (duopulse-083): калитка тихой
// проверки, метка localStorage, разметка исхода проверки в UI-состояние.
import { describe, expect, it } from "vitest";
import { mb, shouldSilentCheck, uiFromCheck, type MobileUpdateCheck } from "./updater";

function check(partial: Partial<MobileUpdateCheck>): MobileUpdateCheck {
  return {
    status: "latest",
    current: "0.1.7",
    latest: null,
    notes: null,
    publishedAt: null,
    asset: null,
    error: null,
    ...partial,
  };
}

describe("shouldSilentCheck", () => {
  const period = 10 * 60 * 1000;

  it("не проверяли — проверяем", () => {
    expect(shouldSilentCheck(null, 123, period)).toBe(true);
  });

  it("внутри периода — тишина, после его выхода — проверяем", () => {
    expect(shouldSilentCheck(1000, 1000 + period - 1, period)).toBe(false);
    expect(shouldSilentCheck(1000, 1000 + period, period)).toBe(false);
    expect(shouldSilentCheck(1000, 1000 + period + 1, period)).toBe(true);
  });

  it("битая метка — как не проверяли", () => {
    // readLastCheck превращает битое в null; калитка должна это покрывать
    expect(shouldSilentCheck(null, Date.now(), period)).toBe(true);
  });
});

describe("uiFromCheck", () => {
  it("available — баннер с версией и notes (и тихая, и ручная)", () => {
    const ui = uiFromCheck(check({ status: "available", latest: "0.1.8", notes: "Субтитры и перевод" }), false);
    expect(ui).toEqual({ kind: "available", version: "0.1.8", notes: "Субтитры и перевод" });
    expect(uiFromCheck(check({ status: "available", latest: "0.1.8", notes: null }), true)).toEqual({
      kind: "available",
      version: "0.1.8",
      notes: null,
    });
  });

  it("latest: ручная — «✓ последняя», тихая — ничего", () => {
    expect(uiFromCheck(check({ current: "0.1.8" }), true)).toEqual({ kind: "latest", version: "0.1.8" });
    expect(uiFromCheck(check({ current: "0.1.8" }), false)).toEqual({ kind: "idle" });
  });

  it("network-error/bad-manifest: ручная — ошибка, тихая — тишина (§5)", () => {
    for (const status of ["network-error", "bad-manifest"] as const) {
      expect(uiFromCheck(check({ status, error: "HTTP 500" }), true)).toEqual({
        kind: "error",
        message: "HTTP 500",
      });
      expect(uiFromCheck(check({ status, error: "HTTP 500" }), false)).toEqual({ kind: "idle" });
    }
  });
});

describe("mb", () => {
  it("округляет в целые МБ, минимум 1", () => {
    expect(mb(0)).toBe("1 МБ");
    expect(mb(512 * 1024)).toBe("1 МБ");
    expect(mb(7.6 * 1024 * 1024)).toBe("8 МБ");
  });
});
