// @vitest-environment happy-dom
// DuoPulse — перестановка закладок в панели папки (карточка duopulse-147):
// чистая panelReorder — вынуть/вставить с клампом индекса. duopulse-173:
// правый клик в панели — «Создать раздел…» (меню строки и пустого места,
// подгруппа внутри открытой папки, инлайн-правка имени новой строки).
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
const bm = vi.hoisted(() => ({
  groupList: vi.fn(),
  bookmarkList: vi.fn(),
  groupAdd: vi.fn(),
  groupRename: vi.fn(),
  favicon: vi.fn(),
}));
vi.mock("../bridge", () => ({ bridge: { history: bm } }));
import { canNestSections, openBmFolderPanel, panelReorder } from "./bm-folder-panel";

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

describe("duopulse-173: «Создать раздел…» в панели папки", () => {
  it("canNestSections: дерево ≤ 3 уровней (глубина 1–2 — можно, 3 — нет)", () => {
    expect(canNestSections(1)).toBe(true);
    expect(canNestSections(2)).toBe(true);
    expect(canNestSections(3)).toBe(false);
    expect(canNestSections(null)).toBe(true); // до первого рендера — не мешаем
  });

  it("правый клик мимо закладки → «Создать раздел…»: подгруппа внутри открытой папки + инлайн-правка", async () => {
    const groups: {
      id: number; name: string; parentId: number | null; depth: number;
      position: number; sortBy: string; count: number; isDefault: boolean;
    }[] = [
      { id: 7, name: "Музыка", parentId: null, depth: 1, position: 0, sortBy: "manual", count: 1, isDefault: false },
    ];
    bm.groupList.mockImplementation(() => Promise.resolve({ groups }));
    bm.bookmarkList.mockResolvedValue({
      bookmarks: [{ url: "https://m.example/", title: "Радио", addedAt: 1 }],
      total: 1,
    });
    bm.favicon.mockResolvedValue({ icon: null });
    bm.groupRename.mockResolvedValue(undefined);
    window.history.replaceState(null, "", "/?panel=bmfolder&group=7");
    document.body.innerHTML = '<div id="bmFolder"></div>';
    openBmFolderPanel();
    await vi.waitFor(() => expect(document.querySelector(".bm-row[data-url]")).toBeTruthy());

    // правый клик по пустому месту панели — меню с единственным пунктом
    const empty = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
    document.getElementById("bmFolder")!.dispatchEvent(empty);
    expect(empty.defaultPrevented).toBe(true);
    const items = [...document.querySelectorAll(".bm-ctx button")].map((b) => b.textContent);
    expect(items).toEqual(["Создать раздел…"]);

    // выбор пункта: подгруппа «Новый раздел» внутри открытой группы 7
    bm.groupAdd.mockImplementation((_p: { name: string }) => {
      const g = { id: 12, name: _p.name, parentId: 7, depth: 2, position: 0, sortBy: "manual", count: 0, isDefault: false };
      groups.push(g);
      return Promise.resolve(g);
    });
    document.querySelector<HTMLButtonElement>(".bm-ctx button")!.click();
    await vi.waitFor(() => expect(bm.groupAdd).toHaveBeenCalledWith({ name: "Новый раздел", parentId: 7 }));
    // новая строка отрисована и сразу в инлайн-правке имени
    const input = (await vi.waitFor(() =>
      document.querySelector<HTMLInputElement>('.bm-sub[data-sub="12"] input.bm-rename'),
    ))!;
    input.value = "Румынская";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(bm.groupRename).toHaveBeenCalledWith({ id: 12, name: "Румынская" }));
  });

  it("правый клик по закладке — «Создать раздел…» вместе с переименованием и удалением; глубина 3 — пункта нет", async () => {
    const groups: {
      id: number; name: string; parentId: number | null; depth: number;
      position: number; sortBy: string; count: number; isDefault: boolean;
    }[] = [
      { id: 7, name: "2026", parentId: 3, depth: 3, position: 0, sortBy: "manual", count: 1, isDefault: false },
    ];
    bm.groupList.mockImplementation(() => Promise.resolve({ groups }));
    // фазовые подписи: ждём именно НОВЫЙ рендер (openGroup уже новой фазы)
    bm.bookmarkList.mockImplementation(() =>
      Promise.resolve({
        bookmarks: [{ url: "https://m.example/", title: groups[0].depth === 3 ? "Фаза-3" : "Фаза-1", addedAt: 1 }],
        total: 1,
      }),
    );
    document.getElementById("bmFolder")!.replaceChildren(); // чистим прошлый тест
    openBmFolderPanel();
    await vi.waitFor(() =>
      expect(document.querySelector(".bm-row[data-url] .bm-label")?.textContent).toBe("Фаза-3"),
    );

    const onRow = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
    document.querySelector(".bm-row[data-url]")!.dispatchEvent(onRow);
    let items = [...document.querySelectorAll(".bm-ctx button")].map((b) => b.textContent);
    expect(items).toEqual(["Переименовать…", "Удалить закладку"]); // 3-й уровень — без «Создать раздел…»
    document.dispatchEvent(new MouseEvent("click", { bubbles: true })); // закрыть меню

    // глубина 1: тот же клик по строке — пункт появляется первым
    groups[0] = { ...groups[0], depth: 1, parentId: null };
    openBmFolderPanel();
    await vi.waitFor(() =>
      expect(document.querySelector(".bm-row[data-url] .bm-label")?.textContent).toBe("Фаза-1"),
    );
    document.querySelector(".bm-row[data-url]")!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
    );
    items = [...document.querySelectorAll(".bm-ctx button")].map((b) => b.textContent);
    expect(items).toEqual(["Создать раздел…", "Переименовать…", "Удалить закладку"]);

    // клик мимо закладки на 3-м уровне — меню нет (вкладывать уже нельзя)
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    groups[0] = { ...groups[0], depth: 3 };
    openBmFolderPanel();
    await vi.waitFor(() =>
      expect(document.querySelector(".bm-row[data-url] .bm-label")?.textContent).toBe("Фаза-3"),
    );
    const off = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
    document.getElementById("bmFolder")!.dispatchEvent(off);
    expect(off.defaultPrevented).toBe(false);
    expect(document.querySelector(".bm-ctx")).toBeNull();
  });
});
