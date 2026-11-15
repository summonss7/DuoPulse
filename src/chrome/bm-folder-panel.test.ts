// DuoPulse — перестановка закладок в панели папки (карточка duopulse-147):
// чистая panelReorder — вынуть/вставить с клампом индекса.
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
import { panelReorder } from "./bm-folder-panel";

describe("panelReorder — порядок закладок папки", () => {
  const urls = ["a", "b", "c", "d"];

  it("вынуть и вставить по индексу (0 = верх)", () => {
    expect(panelReorder(urls, "d", 0)).toEqual(["d", "a", "b", "c"]);
    expect(panelReorder(urls, "a", 2)).toEqual(["b", "c", "a", "d"]);
    expect(panelReorder(urls, "b", 3)).toEqual(["a", "c", "d", "b"]);
  });

  it("индекс клампится; вставка на свою старую позицию — нет хода", () => {
    expect(panelReorder(urls, "a", 99)).toEqual(["b", "c", "d", "a"]);
    expect(panelReorder(urls, "a", -5)).toEqual(["a", "b", "c", "d"]);
    expect(panelReorder(urls, "c", 2)).toEqual(["a", "b", "c", "d"]);
  });

  it("исходный список не мутируется", () => {
    panelReorder(urls, "a", 0);
    expect(urls).toEqual(["a", "b", "c", "d"]);
  });
});
