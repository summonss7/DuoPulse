// DuoPulse — модель строки закладок (карточка duopulse-143): чипы —
// закладки группы по умолчанию и без группы, папки — группы бар-уровня
// (корневые и подгруппы «Избранного», duopulse-151) с закладками или
// подгруппами; пустое избранное строку скрывает.
import { describe, expect, it, vi } from "vitest";

// bmbar тянет tauri-транспорт (panel-window/bridge) — вне приложения их
// слушатели не живут, мокаем до импорта модуля
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve() }));
import {
  badgeHost,
  badgeLetter,
  badgeHue,
  bmBarModel,
  chipReorder,
  chipView,
  folderReorderAllowed,
  faviconUrl,
  bmFolderPanelHeight,
  isExternalBmDrag,
  parseDragPayload,
  uniqueGroupName,
  BM_DRAG_MIME,
} from "./bmbar";
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

  it("папки: группы-не-по-умолчанию по position; пустые тоже видны (duopulse-160)", () => {
    const groups = [
      group({ id: 7, name: "Избранное", isDefault: true, position: 0, count: 2 }),
      group({ id: 3, name: "Музыка", position: 2, count: 5 }),
      group({ id: 9, name: "Видео", position: 1, count: 4 }),
      group({ id: 11, name: "Пустая", position: 3, count: 0 }),
    ];
    const m = bmBarModel(groups, [bm("https://a/", "A")], []);
    expect(m.folders).toEqual([
      { id: 9, name: "Видео", parentId: null },
      { id: 3, name: "Музыка", parentId: null },
      { id: 11, name: "Пустая", parentId: null },
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
    expect(m.folders).toEqual([{ id: 5, name: "Видео", parentId: null }]);
  });

  it("duopulse-151: подгруппа папки не выходит на строку — она в меню родителя", () => {
    const groups = [
      group({ id: 7, name: "Избранное", isDefault: true, count: 1 }),
      group({ id: 3, name: "Музыка", count: 2 }),
      group({ id: 4, name: "Джаз", parentId: 3, depth: 2, count: 1 }),
    ];
    const m = bmBarModel(groups, [bm("https://a/", "A")], []);
    expect(m.folders).toEqual([{ id: 3, name: "Музыка", parentId: null }]);
  });

  it("duopulse-151: подгруппа «Избранного» — папка строки; папка с одними подгруппами видна", () => {
    const groups = [
      group({ id: 7, name: "Избранное", isDefault: true, count: 1 }),
      group({ id: 3, name: "Ещё", parentId: 7, depth: 2, count: 0 }),
      group({ id: 4, name: "Вложенная", parentId: 3, depth: 3, count: 2 }),
      group({ id: 5, name: "Пустой корень", count: 0 }),
    ];
    const m = bmBarModel(groups, [bm("https://a/", "A")], []);
    // пустой корень тоже на строке (duopulse-160: созданная группа видна)
    expect(m.folders).toEqual([
      { id: 3, name: "Ещё", parentId: 7 },
      { id: 5, name: "Пустой корень", parentId: null },
    ]);
  });

  it("duopulse-149: пустой заголовок чипа остаётся пустым (чип-значок)", () => {
    const m = bmBarModel([group({ isDefault: true })], [bm("https://x.example/page")], []);
    expect(m.chips[0].title).toBe("");
  });
});

describe("duopulse-149: chipView — вид чипа", () => {
  it("обычная закладка: подпись + подсказка «имя, адрес»", () => {
    expect(chipView({ url: "https://a.example/", title: "Сайт" })).toEqual({
      label: "Сайт",
      iconOnly: false,
      tooltip: "Сайт\nhttps://a.example/",
    });
  });

  it("пустое имя — только значок, подсказка один адрес", () => {
    expect(chipView({ url: "https://a.example/", title: "" })).toEqual({
      label: "",
      iconOnly: true,
      tooltip: "https://a.example/",
    });
    expect(chipView({ url: "https://a.example/", title: "   " }).iconOnly).toBe(true);
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

describe("duopulse-147: переупорядочивание drag&drop", () => {
  it("chipReorder: вынуть и вставить перед целью; null — в конец", () => {
    const urls = ["a", "b", "c", "d"];
    expect(chipReorder(urls, "a", "c")).toEqual(["b", "a", "c", "d"]);
    expect(chipReorder(urls, "d", "a")).toEqual(["d", "a", "b", "c"]);
    expect(chipReorder(urls, "b", null)).toEqual(["a", "c", "d", "b"]);
    expect(chipReorder(urls, "b", "b")).toEqual(urls); // перед собой — нет хода
    expect(chipReorder(urls, "a", "нет")).toEqual(["b", "c", "d", "a"]); // цель пропала — конец
  });

  it("folderReorderAllowed: только сестринские (тот же родитель)", () => {
    const folders = [
      { id: 1, parentId: null },
      { id: 2, parentId: null },
      { id: 3, parentId: 7 },
      { id: 4, parentId: 7 },
    ];
    expect(folderReorderAllowed(folders, 1, 2)).toBe(true);
    expect(folderReorderAllowed(folders, 1, null)).toBe(true);
    expect(folderReorderAllowed(folders, 3, 4)).toBe(true);
    expect(folderReorderAllowed(folders, 1, 3)).toBe(false); // корень перед подгруппой
    expect(folderReorderAllowed(folders, 3, 1)).toBe(false);
    expect(folderReorderAllowed(folders, 99, null)).toBe(false); // нет такой папки
  });
});

describe("duopulse-155: фавикон сайта и высота панели папки", () => {
  it("faviconUrl: /favicon.ico корня, схема адреса; внутренние страницы — пусто", () => {
    expect(faviconUrl("https://www.youtube.com/watch?v=1")).toBe("https://www.youtube.com/favicon.ico");
    expect(faviconUrl("http://192.168.31.1/")).toBe("http://192.168.31.1/favicon.ico");
    expect(faviconUrl("http://localhost:8080/x")).toBe("http://localhost:8080/favicon.ico");
    expect(faviconUrl("duopulse://history")).toBe("");
    expect(faviconUrl("не адрес")).toBe("");
  });

  it("bmFolderPanelHeight: точная по строкам (крошка 26, строки 30, сеп 11, паддинги 12, зазоры 1)", () => {
    // жалоба Артёма: 2 закладки давали панель 148px при контенте 73px
    expect(bmFolderPanelHeight(false, 0, 2)).toBe(12 + 2 * 30 + 1);
    expect(bmFolderPanelHeight(false, 0, 1)).toBe(12 + 30); // одна — без зазора
    expect(bmFolderPanelHeight(false, 0, 0)).toBe(12 + 30); // пустая папка — строка «Папка пуста»
    expect(bmFolderPanelHeight(true, 0, 1)).toBe(12 + 26 + 30 + 1); // крошка + закладка
    expect(bmFolderPanelHeight(false, 2, 3)).toBe(12 + 5 * 30 + 11 + 5); // 2 подгруппы + сеп + 3
    expect(bmFolderPanelHeight(false, 2, 0)).toBe(12 + 2 * 30 + 1); // только подгруппы — без сепа
  });
});

describe("duopulse-160: drag через webview-границу и новая группа", () => {
  it("isExternalBmDrag: свой MIME или text/plain; пустой набор — нет", () => {
    expect(isExternalBmDrag([BM_DRAG_MIME])).toBe(true);
    expect(isExternalBmDrag(["text/plain"])).toBe(true);
    expect(isExternalBmDrag(["text/uri-list"])).toBe(false);
    expect(isExternalBmDrag([])).toBe(false);
  });

  it("parseDragPayload: свой MIME — url + группа-источник", () => {
    const data = new Map([
      [BM_DRAG_MIME, JSON.stringify({ url: "https://a.example/w", group: 5 })],
      ["text/plain", "https://a.example/w"],
    ]);
    expect(parseDragPayload((m) => data.get(m) ?? "")).toEqual({
      url: "https://a.example/w",
      fromGroup: 5,
    });
  });

  it("parseDragPayload: фолбэк text/plain — адрес без группы-источника", () => {
    expect(parseDragPayload((m) => (m === "text/plain" ? "https://a.example/x" : ""))).toEqual({
      url: "https://a.example/x",
      fromGroup: null,
    });
  });

  it("parseDragPayload: произвольный текст и битый JSON — null (дроп игнорируется)", () => {
    expect(parseDragPayload(() => "просто выделенный текст")).toBe(null);
    expect(parseDragPayload((m) => (m === BM_DRAG_MIME ? "{не json" : ""))).toBe(null);
    // свой MIME без URL-строки — тоже нет дропа
    expect(
      parseDragPayload((m) => (m === BM_DRAG_MIME ? JSON.stringify({ group: 3 }) : "")),
    ).toBe(null);
  });

  it("uniqueGroupName: свободное имя как есть, занятое — счётчик-суффикс", () => {
    expect(uniqueGroupName("Новая группа", ["Музыка"])).toBe("Новая группа");
    expect(uniqueGroupName("Новая группа", ["Новая группа"])).toBe("Новая группа (2)");
    expect(uniqueGroupName("Новая группа", ["Новая группа", "Новая группа (2)"])).toBe(
      "Новая группа (3)",
    );
    // регистр не важен — как проверка дубликата в Core
    expect(uniqueGroupName("Музыка", ["МУЗЫКА"])).toBe("Музыка (2)");
  });
});
