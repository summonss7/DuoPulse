// Тесты истории посещений мобильной ветки (duopulse-156): чистые функции
// группировки по дням — ключ местного дня и заголовок «Сегодня»/«Вчера»/
// дата (как у страницы истории десктопа). DOM-логика листа (запись, лист,
// удаление) — живой прогон на эмуляторе (хук __duopulseMobileHistory).

import { describe, expect, it } from "vitest";
import { dayKeyOf, dayLabelOf } from "./history";

describe("dayKeyOf (местный день YYYY-MM-DD)", () => {
  it("локальная дата с ведущими нулями", () => {
    expect(dayKeyOf(new Date(2026, 10, 16, 23, 59).getTime())).toBe("2026-11-16");
    expect(dayKeyOf(new Date(2026, 0, 2, 0, 0).getTime())).toBe("2026-01-02");
  });
  it("полночь и конец суток — один день", () => {
    const a = new Date(2026, 4, 9, 0, 0).getTime();
    expect(dayKeyOf(a)).toBe(dayKeyOf(a + 86_399_000));
  });
});

describe("dayLabelOf (заголовок группы)", () => {
  const now = new Date(2026, 10, 16, 12, 0).getTime();

  it("сегодня и вчера", () => {
    expect(dayLabelOf(now, now)).toBe("Сегодня");
    expect(dayLabelOf(now - 86_400_000, now)).toBe("Вчера");
  });
  it("вчерашняя полночь и позавчерашний вечер — «Вчера» (местные дни)", () => {
    expect(dayLabelOf(new Date(2026, 10, 15, 0, 0).getTime(), now)).toBe("Вчера");
    expect(dayLabelOf(new Date(2026, 10, 14, 23, 0).getTime(), now)).not.toBe("Вчера");
  });
  it("давний визит — полная дата, не «Сегодня»/«Вчера»", () => {
    const label = dayLabelOf(new Date(2026, 7, 3, 10, 0).getTime(), now);
    expect(label).not.toBe("Сегодня");
    expect(label).not.toBe("Вчера");
    expect(label).toMatch(/2026/);
  });
});
