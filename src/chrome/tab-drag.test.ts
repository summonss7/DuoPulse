// DuoPulse — тесты модели перестановки вкладок drag&drop (карточка
// duopulse-205: чистые функции tab-drag.ts — порядок и геометрия маркера).
import { describe, expect, it } from "vitest";
import { dropBeforeId, tabReorder } from "./tab-drag";

const list = (n: number): string[] => Array.from({ length: n }, (_, i) => `tab-${i + 1}`);

describe("tabReorder", () => {
  it("перенос вперёд: последняя перед первой", () => {
    expect(tabReorder(list(4).map((id) => ({ id })), "tab-4", "tab-1")).toEqual([
      "tab-4",
      "tab-1",
      "tab-2",
      "tab-3",
    ]);
  });

  it("перенос назад: первая перед третьей", () => {
    expect(tabReorder(list(4).map((id) => ({ id })), "tab-1", "tab-3")).toEqual([
      "tab-2",
      "tab-1",
      "tab-3",
      "tab-4",
    ]);
  });

  it("в конец (beforeId null)", () => {
    expect(tabReorder(list(3).map((id) => ({ id })), "tab-1", null)).toEqual([
      "tab-2",
      "tab-3",
      "tab-1",
    ]);
  });

  it("перед соседом справа — порядок не меняется (без команды)", () => {
    expect(tabReorder(list(3).map((id) => ({ id })), "tab-2", "tab-3")).toEqual(list(3));
  });

  it("перед самим собой — нет хода", () => {
    expect(tabReorder(list(3).map((id) => ({ id })), "tab-2", "tab-2")).toEqual(list(3));
  });

  it("тянущаяся вкладка исчезла (закрылась) — список без изменений", () => {
    const tabs = list(3).map((id) => ({ id }));
    expect(tabReorder(tabs, "tab-9", "tab-1")).toEqual(list(3));
  });
});

describe("dropBeforeId", () => {
  // геометрия: 4 вкладки по 100px, курсор внутри второй половины первой
  const rects = list(4).map((id, i) => ({ id, left: i * 100, width: 100 }));
  const tabs = rects.map(({ id }) => ({ id }));

  it("курсор до центра вкладки — вставка перед ней", () => {
    expect(dropBeforeId(rects, 40, "tab-3")).toBe("tab-1");
  });

  it("курсор после центра — вставка перед следующей", () => {
    expect(dropBeforeId(rects, 60, "tab-3")).toBe("tab-2");
  });

  it("тянущаяся исключается из целей (соседи сдвигаются)", () => {
    // курсор в первой вкладке, но она тянется — цель вторая
    expect(dropBeforeId(rects, 10, "tab-1")).toBe("tab-2");
  });

  it("правее всех — в конец (null)", () => {
    expect(dropBeforeId(rects, 500, "tab-2")).toBeNull();
  });

  it("единственная вкладка тянется — цели нет", () => {
    expect(dropBeforeId([{ id: "tab-1", left: 0, width: 100 }], 50, "tab-1")).toBeNull();
  });

  it("согласована с tabReorder: полный цикл переноса", () => {
    const before = dropBeforeId(rects, 40, "tab-4");
    expect(before).toBe("tab-1");
    expect(tabReorder(tabs, "tab-4", before)).toEqual(["tab-4", "tab-1", "tab-2", "tab-3"]);
  });
});
