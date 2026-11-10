// Тесты закладок мобильной ветки (duopulse-104): чистые функции — план
// перекладывания между группами (move-семантика десктопа 099), подпись хоста,
// выбор чипа-цели тяги. DOM-логика (long-press, призрак, шит) — живой прогон
// на эмуляторе (e2e, прецеденты duopulse-083/102).

import { describe, expect, it } from "vitest";
import { dropTargetOf, hostLabel, planGroupDrop } from "./bookmarks";

describe("planGroupDrop (семантика 099: из вида группы — перенос, из «Все» — добавление)", () => {
  it("из вида группы в другую: убрать из текущей + добавить в целевую", () => {
    expect(planGroupDrop(5, 7, false)).toEqual({ removeFrom: 5, addTo: 7 });
  });

  it("из вида группы, закладка уже в целевой: только убрать из текущей", () => {
    expect(planGroupDrop(5, 7, true)).toEqual({ removeFrom: 5, addTo: null });
  });

  it("из «Все» в группу: добавить членство, текущих не трогаем (много-членство)", () => {
    expect(planGroupDrop("all", 7, false)).toEqual({ removeFrom: null, addTo: 7 });
  });

  it("из «Все» в группу, где уже состоит: ничего не делать", () => {
    expect(planGroupDrop("all", 7, true)).toEqual({ removeFrom: null, addTo: null });
  });

  it("перекладывание в ту же группу (вид = цель): без изменений", () => {
    expect(planGroupDrop(7, 7, false)).toEqual({ removeFrom: null, addTo: null });
  });
});

describe("hostLabel", () => {
  it("хост без www, мусор — как есть", () => {
    expect(hostLabel("https://www.youtube.com/watch?v=abc")).toBe("youtube.com");
    expect(hostLabel("http://example.com/path")).toBe("example.com");
    expect(hostLabel("не url")).toBe("не url");
  });
});

describe("dropTargetOf", () => {
  const chip = (drop?: string): HTMLElement =>
    ({ dataset: drop === undefined ? {} : { drop } }) as unknown as HTMLElement;

  it("только чипы групп с числовым data-drop — цели тяги", () => {
    expect(dropTargetOf(chip("7"))).toBe(7);
    expect(dropTargetOf(chip("-1"))).toBe(-1);
    expect(dropTargetOf(chip(""))).toBeNull();
    expect(dropTargetOf(chip("abc"))).toBeNull();
    expect(dropTargetOf(chip())).toBeNull(); // «Все»/«+» без data-drop
  });
});
