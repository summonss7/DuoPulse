// DuoPulse — бейдж версии в шапке (карточка duopulse-074): формат «vX.Y.Z ·
// дата сборки»; дата — локальная для пользователя, из unix-момента
// компиляции, который кладёт build.rs (DUOPULSE_BUILD_UNIX).
import { describe, expect, it } from "vitest";
import { buildDateRu, versionBadgeText } from "./app-version";

describe("buildDateRu — локальная дата из unix-секунд", () => {
  it("нулевого/нет момента — пустая строка (даты не знаем)", () => {
    expect(buildDateRu(0)).toBe("");
  });

  it("известный момент — дата формата DD.MM.YYYY", () => {
    // 05.11.2026 00:00 UTC — любая локаль старше UTC даст 05.11.2026
    const utc = new Date(Date.UTC(2026, 10, 5, 12)).getTime() / 1000;
    expect(buildDateRu(utc)).toMatch(/^\d{2}\.\d{2}\.2026$/);
  });
});

describe("versionBadgeText — текст бейджа в шапке", () => {
  it("версия + дата сборки", () => {
    const ts = new Date(2026, 10, 5).getTime() / 1000;
    expect(versionBadgeText("0.1.4", ts)).toBe("v0.1.4 · 05.11.2026");
  });

  it("без момента сборки — только версия (не вешаем пустую дату)", () => {
    expect(versionBadgeText("0.1.4", 0)).toBe("v0.1.4");
  });
});
