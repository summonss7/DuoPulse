// DuoPulse — модель строки закладок (карточка duopulse-143): чипы —
// закладки группы по умолчанию и без группы, папки — группы бар-уровня
// (корневые и подгруппы «Избранного», duopulse-151) с закладками или
// подгруппами; пустое избранное строку скрывает.
import { describe, expect, it } from "vitest";
import { badgeHost, badgeLetter, badgeHue, bmBarModel } from "./bmbar";
import type { BookmarkGroupInfo, HistoryBookmark } from "../bridge/gen/types";

const group = (over: Partial<BookmarkGroupInfo>): BookmarkGroupInfo => ({
  id: 1,
  name: "G",
  position: 0,
  sortBy: "manual",
  isDefault: false,
  count: 0,
  parentId: null,
  depth: 1,
  ...over,
});

const bm = (url: string, title = ""): HistoryBookmark => ({
  url,
  title,
  addedAt: 1,
  groups: [],
});

describe("bmBarModel — состав строки", () => {
  it("чипы: группа по умолчанию в её порядке + безгрупповые следом", () => {
    const groups = [group({ id: 7, name: "Избранное", isDefault: true })];
    const def = [bm("https://a.example/1", "Первый"), bm("https://a.example/2", "Второй")];
    const ung = [bm("https://b.example/", "Безгрупповая")];
    const m = bmBarModel(groups, def, ung);
    expect(m.visible).toBe(true);
    expect(m.chips.map((c) => c.url)).toEqual([
      "https://a.example/1",
      "https://a.example/2",
      "https://b.example/",
    ]);
    expect(m.folders).toEqual([]);
  });

  it("папки: непустые группы-не-по-умолчанию по position; пустые скрыты", () => {
    const groups = [
      group({ id: 7, name: "Избранное", isDefault: true, position: 0, count: 2 }),
      group({ id: 3, name: "Музыка", position: 2, count: 5 }),
      group({ id: 9, name: "Видео", position: 1, count: 4 }),
      group({ id: 11, name: "Пустая", position: 3, count: 0 }),
    ];
    const m = bmBarModel(groups, [bm("https://a/", "A")], []);
    expect(m.folders).toEqual([
      { id: 9, name: "Видео" },
      { id: 3, name: "Музыка" },
    ]);
  });

  it("пустое избранное — строка скрыта", () => {
    const groups = [group({ id: 7, name: "Избранное", isDefault: true, count: 0 })];
    expect(bmBarModel(groups, [], []).visible).toBe(false);
  });

  it("папка есть, чипов нет — строка видна", () => {
    const groups = [group({ id: 5, name: "Видео", count: 3 })];
    const m = bmBarModel(groups, [], []);
    expect(m.visible).toBe(true);
    expect(m.chips).toEqual([]);
    expect(m.folders).toEqual([{ id: 5, name: "Видео" }]);
  });

  it("duopulse-151: подгруппа папки не выходит на строку — она в меню родителя", () => {
    const groups = [
      group({ id: 7, name: "Избранное", isDefault: true, count: 1 }),
      group({ id: 3, name: "Музыка", count: 2 }),
      group({ id: 4, name: "Джаз", parentId: 3, depth: 2, count: 1 }),
    ];
    const m = bmBarModel(groups, [bm("https://a/", "A")], []);
    expect(m.folders).toEqual([{ id: 3, name: "Музыка" }]);
  });

  it("duopulse-151: подгруппа «Избранного» — папка строки; папка с одними подгруппами видна", () => {
    const groups = [
      group({ id: 7, name: "Избранное", isDefault: true, count: 1 }),
      group({ id: 3, name: "Ещё", parentId: 7, depth: 2, count: 0 }),
      group({ id: 4, name: "Вложенная", parentId: 3, depth: 3, count: 2 }),
      group({ id: 5, name: "Пустой корень", count: 0 }),
    ];
    const m = bmBarModel(groups, [bm("https://a/", "A")], []);
    expect(m.folders).toEqual([{ id: 3, name: "Ещё" }]);
  });

  it("пустой заголовок чипа — адрес (как на странице управления)", () => {
    const m = bmBarModel([group({ isDefault: true })], [bm("https://x.example/page")], []);
    expect(m.chips[0].title).toBe("https://x.example/page");
  });
});

describe("бейдж домена", () => {
  it("хост без www; нерасобранный адрес — пустая строка", () => {
    expect(badgeHost("https://www.youtube.com/watch?v=1")).toBe("youtube.com");
    expect(badgeHost("duopulse://history")).toBe("");
  });

  it("буква — первый символ заголовка, фолбэк — хост", () => {
    expect(badgeLetter("YouTube", "youtube.com")).toBe("Y");
    expect(badgeLetter("", "youtube.com")).toBe("Y");
    expect(badgeLetter("https://site.example", "")).toBe("S");
    expect(badgeLetter("", "")).toBe("•");
  });

  it("цвет стабилен и разный у разных доменов", () => {
    expect(badgeHue("youtube.com")).toBe(badgeHue("youtube.com"));
    expect(badgeHue("youtube.com")).toBeLessThan(360);
  });
});
