// DuoPulse — форматтер даты сборки (бейдж версии в навбаре убран,
// карточка duopulse-078: версия и дата теперь в заголовке окна — main.rs;
// buildDateRu остаётся для страницы «Настройки», unix-момент компиляции
// кладёт build.rs через DUOPULSE_BUILD_UNIX).
import { describe, expect, it } from "vitest";
import { buildDateRu } from "./app-version";

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
