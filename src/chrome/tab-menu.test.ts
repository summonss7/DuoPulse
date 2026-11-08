// DuoPulse — тесты доступности пунктов таб-меню (карточка duopulse-086:
// логика осталась в UI, разметка ушла в оверлей-окно menu-overlay).
import { describe, expect, it } from "vitest";
import { tabMenuDisabled } from "./tab-menu";
import type { TabInfo } from "../bridge";

const tab = (over: Partial<TabInfo>): TabInfo =>
  ({
    id: "tab-1",
    url: "https://example.com/",
    title: "Example",
    active: false,
    loading: false,
    sleeping: false,
    ...over,
  }) as TabInfo;

describe("tabMenuDisabled", () => {
  it("без вкладки (пустое место бара) — вкладочные действия отключены", () => {
    expect(tabMenuDisabled([tab({ active: true })], null)).toEqual([
      "duplicate",
      "sleep",
      "close",
      "closeOthers",
    ]);
  });

  it("единственная вкладка — «Закрыть другие» и «Усыпить» (она активная)", () => {
    expect(tabMenuDisabled([tab({ active: true })], "tab-1")).toEqual([
      "closeOthers",
      "sleep",
    ]);
  });

  it("фоновая неспящая — всё доступно", () => {
    const list = [tab({ id: "tab-1", active: true }), tab({ id: "tab-2" })];
    expect(tabMenuDisabled(list, "tab-2")).toEqual([]);
  });

  it("активная среди нескольких — «Усыпить» отключена", () => {
    const list = [tab({ id: "tab-1", active: true }), tab({ id: "tab-2" })];
    expect(tabMenuDisabled(list, "tab-1")).toEqual(["sleep"]);
  });

  it("спящая фоновая — «Усыпить» отключена", () => {
    const list = [tab({ id: "tab-1", active: true }), tab({ id: "tab-2", sleeping: true })];
    expect(tabMenuDisabled(list, "tab-2")).toEqual(["sleep"]);
  });
});
