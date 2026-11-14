// DuoPulse — чистые функции дерева групп (duopulse-151): порядок дерева,
// путь имени, проверки переноса (циклы, глубина ≤ 3). Vitest без DOM.
import { describe, expect, it } from "vitest";
import {
  MAX_GROUP_DEPTH,
  canGroupMoveTo,
  groupPath,
  groupSubtreeHeight,
  groupTreeOrder,
  isGroupDescendant,
} from "./groups-tree";
import type { BookmarkGroupInfo } from "../bridge/gen/types";

const g = (over: Partial<BookmarkGroupInfo>): BookmarkGroupInfo => ({
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

describe("groupTreeOrder — порядок дерева", () => {
  it("корни по position, подгруппы следом за родителем (рекурсивно)", () => {
    const groups = [
      g({ id: 1, name: "Избранное", isDefault: true, position: 0 }),
      g({ id: 2, name: "Музыка", position: 2 }),
      g({ id: 3, name: "Видео", position: 1 }),
      g({ id: 4, name: "Джаз", parentId: 2, depth: 2, position: 5 }),
      g({ id: 5, name: "2026", parentId: 4, depth: 3, position: 6 }),
      g({ id: 6, name: "Клипы", parentId: 3, depth: 2, position: 7 }),
    ];
    expect(groupTreeOrder(groups).map((x) => x.name)).toEqual([
      "Избранное",
      "Видео",
      "Клипы",
      "Музыка",
      "Джаз",
      "2026",
    ]);
  });

  it("битый parentId (родителя нет в списке) — группа показывается как корень", () => {
    const groups = [
      g({ id: 1, name: "А", position: 0 }),
      g({ id: 2, name: "Сирота", parentId: 99, depth: 2 }),
    ];
    const order = groupTreeOrder(groups).map((x) => x.name);
    expect(order).toContain("Сирота");
    expect(order.length).toBe(2);
  });
});

describe("groupPath / потомки / высота", () => {
  const groups = [
    g({ id: 1, name: "Работа", position: 0 }),
    g({ id: 2, name: "Документы", parentId: 1, depth: 2 }),
    g({ id: 3, name: "2026", parentId: 2, depth: 3 }),
  ];
  it("путь — «Родитель › Ребёнок › …»", () => {
    expect(groupPath(groups, 1)).toBe("Работа");
    expect(groupPath(groups, 3)).toBe("Работа › Документы › 2026");
    expect(groupPath(groups, 99)).toBe("");
  });
  it("потомок определяется по цепочке родителей", () => {
    expect(isGroupDescendant(groups, 1, 3)).toBe(true);
    expect(isGroupDescendant(groups, 3, 1)).toBe(false);
    expect(isGroupDescendant(groups, 1, 1)).toBe(true);
  });
  it("высота поддерева считает саму группу", () => {
    expect(groupSubtreeHeight(groups, 3)).toBe(1);
    expect(groupSubtreeHeight(groups, 1)).toBe(3);
  });
});

describe("canGroupMoveTo — проверки переноса (drag чипа группы)", () => {
  const fav = g({ id: 1, name: "Избранное", isDefault: true });
  const work = g({ id: 2, name: "Работа", position: 1 });
  const docs = g({ id: 3, name: "Документы", parentId: 2, depth: 2 });
  const year = g({ id: 4, name: "2026", parentId: 3, depth: 3 });
  const other = g({ id: 5, name: "Прочее", position: 2 });
  const groups = [fav, work, docs, year, other];

  it("в корень — можно всем, кроме группы по умолчанию", () => {
    expect(canGroupMoveTo(groups, work.id, null)).toBe(true);
    expect(canGroupMoveTo(groups, year.id, null)).toBe(true);
    expect(canGroupMoveTo(groups, fav.id, null)).toBe(false);
  });
  it("в себя/своего потомка — цикл, нельзя", () => {
    expect(canGroupMoveTo(groups, work.id, work.id)).toBe(false);
    expect(canGroupMoveTo(groups, work.id, docs.id)).toBe(false);
    expect(canGroupMoveTo(groups, work.id, year.id)).toBe(false);
  });
  it("глубина итоговая ≤ 3", () => {
    expect(canGroupMoveTo(groups, other.id, work.id), "1+1").toBe(true);
    expect(canGroupMoveTo(groups, other.id, docs.id), "2+1").toBe(true);
    expect(canGroupMoveTo(groups, other.id, year.id), "3+1 > 3").toBe(false);
    // перенос ветки с потомками тоже считает высоту поддерева
    expect(canGroupMoveTo(groups, work.id, other.id), "высота 3 + 1 > 3").toBe(false);
    expect(canGroupMoveTo(groups, docs.id, other.id), "высота 2 + 1").toBe(true);
    expect(canGroupMoveTo(groups, work.id, 999), "нет такого родителя").toBe(false);
  });
  it("MAX_GROUP_DEPTH = 3 (как в Core)", () => {
    expect(MAX_GROUP_DEPTH).toBe(3);
  });
});
