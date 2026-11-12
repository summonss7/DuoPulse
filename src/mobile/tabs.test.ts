// Тесты вкладок мобильной ветки (duopulse-123): чистые функции — разбор
// сохранённой сессии, сериализация, план закрытия вкладки и план открытия.
// DOM-логика (iframe, пауза фоновых, лист-переключатель) — живой прогон на
// эмуляторе (как e2e/bookmarks, хук __duopulseMobileTabs).

import { describe, expect, it } from "vitest";
import {
  MAX_TABS,
  parseSavedTabs,
  planAfterClose,
  planOpen,
  serializeTabs,
} from "./tabs";

describe("parseSavedTabs (сессия после перезапуска)", () => {
  it("валидная сессия читается", () => {
    const raw = serializeTabs(
      [
        { videoId: "dQw4w9WgXcQ", title: "Песня" },
        { videoId: "abc123_-Xyz", title: "" },
      ],
      1,
    );
    expect(parseSavedTabs(raw)).toEqual({
      tabs: [
        { videoId: "dQw4w9WgXcQ", title: "Песня" },
        { videoId: "abc123_-Xyz", title: "" },
      ],
      active: 1,
    });
  });

  it("битые videoId выкидываются, активная поправляется на первую", () => {
    const raw = JSON.stringify({
      tabs: [
        { videoId: "коротко", title: "мусор" },
        { videoId: "dQw4w9WgXcQ", title: "годное" },
        { videoId: 42, title: "не строка" },
      ],
      active: 9,
    });
    expect(parseSavedTabs(raw)).toEqual({
      tabs: [{ videoId: "dQw4w9WgXcQ", title: "годное" }],
      active: 0,
    });
  });

  it("пусто/мусор/нет вкладок — null (чистый старт)", () => {
    expect(parseSavedTabs(null)).toBeNull();
    expect(parseSavedTabs("")).toBeNull();
    expect(parseSavedTabs("не json")).toBeNull();
    expect(parseSavedTabs('{"tabs":[]}')).toBeNull();
    expect(parseSavedTabs('{"tabs":[{"videoId":"nope!!"}]}')).toBeNull();
  });

  it(`потолок MAX_TABS (${MAX_TABS}): лишние вкладки отрезаются`, () => {
    const many = Array.from({ length: MAX_TABS + 5 }, (_, i) => ({
      videoId: `videoId${String(i).padStart(5, "0")}`,
      title: "",
    }));
    const parsed = parseSavedTabs(JSON.stringify({ tabs: many, active: 0 }));
    expect(parsed?.tabs.length).toBe(MAX_TABS);
  });
});

describe("serializeTabs ↔ parseSavedTabs (round-trip)", () => {
  it("активная за границами зажимается в диапазон", () => {
    const raw = serializeTabs([{ videoId: "dQw4w9WgXcQ", title: "t" }], -3);
    expect(parseSavedTabs(raw)?.active).toBe(0);
    const raw2 = serializeTabs(
      [
        { videoId: "aaaaaaaaaaa", title: "" },
        { videoId: "bbbbbbbbbbb", title: "" },
      ],
      5,
    );
    expect(parseSavedTabs(raw2)?.active).toBe(1);
  });
});

describe("planAfterClose (какую вкладку активировать после закрытия)", () => {
  it("закрыта активная в середине — сосед справа", () => {
    expect(planAfterClose([1, 2, 3], 2, 2)).toBe(3);
  });
  it("закрыта последняя активная — сосед слева", () => {
    expect(planAfterClose([1, 2, 3], 3, 3)).toBe(2);
  });
  it("закрыта единственная — вкладок нет (стартовый экран)", () => {
    expect(planAfterClose([7], 7, 7)).toBeNull();
  });
  it("закрыта фоновая — активная не меняется", () => {
    expect(planAfterClose([1, 2, 3], 1, 3)).toBe(3);
  });
  it("неизвестный id — как есть (защита от гонки)", () => {
    expect(planAfterClose([1, 2], 99, 2)).toBe(2);
  });
});

describe("planOpen (заменить вкладку или создать новую)", () => {
  it("omnibox при открытом видео — замена (как вкладка Chrome)", () => {
    expect(planOpen(true, false)).toBe("replace");
  });
  it("закладка/старт-экран при открытом видео — новая вкладка", () => {
    expect(planOpen(true, true)).toBe("create");
  });
  it("видео не открыто — всегда новая", () => {
    expect(planOpen(false, false)).toBe("create");
    expect(planOpen(false, true)).toBe("create");
  });
});
