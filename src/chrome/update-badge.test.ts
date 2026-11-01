// DuoPulse — логика бейджа найденного обновления (карточка duopulse-067):
// показ/скрытие точки на «⋮» по итогам проверки фида. Инвариант зеркален
// книге проверок Core (updater.rs): available=true → pending есть → точка;
// «у вас последняя версия» и отказ сети — available=false → точки нет.
import { describe, expect, it } from "vitest";
import { updateBadgeState, updateBadgeTitle } from "./update-badge";
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

describe("updateBadgeState — показ/скрытие точки на «⋮»", () => {
  it("проверка нашла обновление — точка горит, версия при ней", () => {
    const st = updateBadgeState(check({ available: true, version: "0.1.3", source: "github" }));
    expect(st.on).toBe(true);
    expect(st.version).toBe("0.1.3");
  });

  it("«у вас последняя версия» — точки нет (available=false)", () => {
    const st = updateBadgeState(check({ source: "github" }));
    expect(st.on).toBe(false);
    expect(st.version).toBeNull();
  });

  it("ошибка сети/фида — точки нет (и версия не спасает)", () => {
    expect(updateBadgeState(check({ error: "GitHub: timeout" })).on).toBe(false);
    expect(updateBadgeState(check({ available: true, version: "0.1.3", error: "x" })).on).toBe(false);
  });

  it("нет события/нет версии — точки нет (оборона от пустого payload)", () => {
    expect(updateBadgeState(null).on).toBe(false);
    expect(updateBadgeState(check({ available: true })).on).toBe(false);
  });
});

describe("updateBadgeTitle — подсказка кнопки «⋮»", () => {
  it("с обновлением — версия в подсказке, без — базовый текст", () => {
    expect(updateBadgeTitle({ on: true, version: "0.1.3" })).toBe(
      "Меню браузера — доступна версия 0.1.3",
    );
    expect(updateBadgeTitle({ on: false, version: null })).toBe("Меню браузера");
    expect(updateBadgeTitle({ on: false, version: null }, "Меню")).toBe("Меню");
  });
});
