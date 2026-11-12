// DuoPulse — логика бара «Появилась новая версия» (карточка duopulse-127):
// показ поверх таб-бара по итогам проверки фида, «Отмена» гасит до
// перезапуска (отклонённая версия), новая версия показывает бар снова.
import { describe, expect, it } from "vitest";
import { updateBarState, updateBarText } from "./update-bar";
import type { UpdaterCheckResult } from "../bridge/gen/types";

const check = (over: Partial<UpdaterCheckResult>): UpdaterCheckResult => ({
  available: false,
  version: null,
  notes: null,
  dateUnix: 0,
  source: null,
  checkedAtUnix: 1,
  error: null,
  ...over,
});

describe("updateBarState — показ/скрытие бара обновления", () => {
  it("проверка нашла обновление — бар показан с версией", () => {
    const st = updateBarState(check({ available: true, version: "0.1.29", source: "github" }), null);
    expect(st.show).toBe(true);
    expect(st.version).toBe("0.1.29");
  });

  it("эта версия уже отклонена «Отменой» — бара нет, версия помнится", () => {
    const st = updateBarState(check({ available: true, version: "0.1.29" }), "0.1.29");
    expect(st.show).toBe(false);
    expect(st.version).toBe("0.1.29");
  });

  it("отклонена старая — новая версия снова показывает бар", () => {
    expect(updateBarState(check({ available: true, version: "0.1.30" }), "0.1.29").show).toBe(true);
  });

  it("«последняя версия» и ошибка сети — бара нет", () => {
    expect(updateBarState(check({ source: "github" }), null).show).toBe(false);
    expect(updateBarState(check({ error: "GitHub: timeout" }), null).show).toBe(false);
    expect(updateBarState(check({ available: true, version: "0.1.29", error: "x" }), null).show).toBe(false);
  });

  it("пустой payload / версия не указана — бара нет (оборона)", () => {
    expect(updateBarState(null, null).show).toBe(false);
    expect(updateBarState(check({ available: true }), null).show).toBe(false);
  });
});

describe("updateBarText — текст бара", () => {
  it("версия + заметки релиза, если фид их дал", () => {
    const st = { show: true, version: "0.1.29" };
    expect(updateBarText(st)).toBe("Появилась новая версия 0.1.29");
    expect(updateBarText(st, "фиксы субтитров")).toBe("Появилась новая версия 0.1.29 — фиксы субтитров");
  });

  it("скрытый бар — пустой текст", () => {
    expect(updateBarText({ show: false, version: null })).toBe("");
  });
});
