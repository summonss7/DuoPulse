// @vitest-environment happy-dom
// DuoPulse — перестановка закладок в панели папки (карточка duopulse-147):
// чистая panelReorder — вынуть/вставить с клампом индекса. duopulse-173:
// правый клик в панели — «Создать раздел…» (меню строки и пустого места,
// подгруппа внутри открытой папки, инлайн-правка имени новой строки).
// duopulse-189: контекстные меню стали нативными popup'ами (ui_menu_open):
// правый клик шлёт команду с payload, выбор возвращается событием
// menu-action в панель — тест эмулирует выбор дёрганьем колбека listen.
import { describe, expect, it, vi } from "vitest";

const { invokes, menuCbs } = vi.hoisted(() => ({
  invokes: [] as { cmd: string; args: Record<string, unknown> }[],
  // слушатели по событию: menu-action — наши, chrome-panel-closed — чужой
  menuCbs: [] as { event: string; fire: (payload: unknown) => void }[],
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    invokes.push({ cmd, args });
    return Promise.resolve();
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: (ev: { payload: unknown }) => void) => {
    menuCbs.push({ event, fire: (p) => cb({ payload: p }) });
    return Promise.resolve(() => {});
  },
}));
const bm = vi.hoisted(() => ({
  groupList: vi.fn(),
  bookmarkList: vi.fn(),
  groupAdd: vi.fn(),
  groupRename: vi.fn(),
  groupMove: vi.fn(),
  groupReorder: vi.fn(),
  groupRemove: vi.fn(),
  groupSetSort: vi.fn(),
  groupToggleBookmark: vi.fn(),
  bookmarkMove: vi.fn(),
  bookmarkRemove: vi.fn(),
  bookmarkUpdate: vi.fn(),
  favicon: vi.fn(),
}));
vi.mock("../bridge", () => ({ bridge: { history: bm } }));
import { canNestSections, openBmFolderPanel, panelReorder } from "./bm-folder-panel";

/** Последний вызов ui_menu_open (или null). */
const lastMenu = () =>
  [...invokes].reverse().find((i) => i.cmd === "ui_menu_open") ?? null;

/** Эмулировать выбор пункта меню (Core → панель-webview). */
const pickMenu = (payload: unknown) =>
  menuCbs.filter((m) => m.event === "menu-action").forEach((m) => m.fire(payload));

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

describe("duopulse-173/189: контекстные меню панели папки — нативные", () => {
  it("canNestSections: дерево ≤ 3 уровней (глубина 1–2 — можно, 3 — нет)", () => {
    expect(canNestSections(1)).toBe(true);
    expect(canNestSections(2)).toBe(true);
    expect(canNestSections(3)).toBe(false);
    expect(canNestSections(null)).toBe(true); // до первого рендера — не мешаем
  });

  it("правый клик мимо закладки → «Создать раздел…»: команда меню + выбор → подгруппа и инлайн-правка", async () => {
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

    // правый клик по пустому месту панели — нативное меню bmsection
    const empty = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
    document.getElementById("bmFolder")!.dispatchEvent(empty);
    expect(empty.defaultPrevented).toBe(true);
    expect(lastMenu()?.args).toMatchObject({ kind: "bmsection" });

    // выбор пункта: подгруппа «Новый раздел» внутри открытой группы 7
    bm.groupAdd.mockImplementation((_p: { name: string }) => {
      const g = { id: 12, name: _p.name, parentId: 7, depth: 2, position: 0, sortBy: "manual", count: 0, isDefault: false };
      groups.push(g);
      return Promise.resolve(g);
    });
    pickMenu({ menu: "bmsection", act: "section" });
    await vi.waitFor(() => expect(bm.groupAdd).toHaveBeenCalledWith({ name: "Новый раздел", parentId: 7 }));
    // новая строка отрисована и сразу в инлайн-правке имени
    const input = (await vi.waitFor(() =>
      document.querySelector<HTMLInputElement>('.bm-sub[data-sub="12"] input.bm-rename'),
    ))!;
    input.value = "Румынская";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(bm.groupRename).toHaveBeenCalledWith({ id: 12, name: "Румынская" }));
  });

  it("правый клик по закладке — меню bmrow с url и canNest по глубине; «Удалить» и «Переименовать» работают", async () => {
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

    // 3-й уровень: canNest=false (пункт «Создать раздел…» Core не добавит)
    document.querySelector(".bm-row[data-url]")!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
    );
    expect(lastMenu()?.args.payload).toMatchObject({
      url: "https://m.example/",
      canNest: false,
    });
    expect(lastMenu()?.args.kind).toBe("bmrow");

    // глубина 1: тот же клик по строке — canNest=true
    groups[0] = { ...groups[0], depth: 1, parentId: null };
    openBmFolderPanel();
    await vi.waitFor(() =>
      expect(document.querySelector(".bm-row[data-url] .bm-label")?.textContent).toBe("Фаза-1"),
    );
    document.querySelector(".bm-row[data-url]")!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
    );
    expect(lastMenu()?.args.payload).toMatchObject({
      url: "https://m.example/",
      canNest: true,
    });
    expect(lastMenu()?.args.kind).toBe("bmrow");

    // duopulse-189 (суть жалобы): выбор «Удалить» — закладка уходит из панели
    bm.bookmarkRemove.mockResolvedValue(undefined);
    bm.bookmarkList.mockImplementation(() => Promise.resolve({ bookmarks: [], total: 0 }));
    pickMenu({ menu: "bmrow", act: "delete", url: "https://m.example/" });
    await vi.waitFor(() => expect(bm.bookmarkRemove).toHaveBeenCalledWith({ url: "https://m.example/" }));
    await vi.waitFor(() => expect(document.querySelector(".bm-row[data-url]")).toBeNull());

    // «Переименовать…» — инлайн-правка на строке (вернём закладку)
    bm.bookmarkList.mockImplementation(() =>
      Promise.resolve({
        bookmarks: [{ url: "https://m.example/", title: "Фаза-1", addedAt: 1 }],
        total: 1,
      }),
    );
    openBmFolderPanel();
    await vi.waitFor(() => expect(document.querySelector(".bm-row[data-url]")).toBeTruthy());
    pickMenu({ menu: "bmrow", act: "rename", url: "https://m.example/" });
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLInputElement>(".bm-row[data-url] input.bm-rename")).toBeTruthy(),
    );

    // клик мимо закладки на 3-м уровне — меню нет (вкладывать уже нельзя);
    // дожидаемся нового рендера (openGroup станет depth 3) — в этой фазе
    // mock отдаёт «Фаза-1», метка служит только маркером рендера
    groups[0] = { ...groups[0], depth: 3 };
    openBmFolderPanel();
    await vi.waitFor(() =>
      expect(document.querySelector(".bm-row[data-url] .bm-label")?.textContent).toBe("Фаза-1"),
    );
    const before = invokes.length;
    const off = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
    document.getElementById("bmFolder")!.dispatchEvent(off);
    expect(off.defaultPrevented).toBe(false);
    expect(invokes.length).toBe(before); // команды меню не было
  });
});

describe("duopulse-242: меню подпапки и вынос из вложенности", () => {
  /** Открыть панель папки 7 (Network) с подпапкой 19 (AI) внутри; возвращает
   *  живой массив групп (моки переносов мутируют его — панель перерисуется). */
  const openWithSub = async (): Promise<
    { id: number; name: string; parentId: number | null; depth: number;
      position: number; sortBy: string; count: number; isDefault: boolean }[]
  > => {
    const groups = [
      { id: 7, name: "Network", parentId: null, depth: 1, position: 1, sortBy: "manual", count: 2, isDefault: false },
      { id: 19, name: "AI", parentId: 7, depth: 2, position: 10, sortBy: "manual", count: 2, isDefault: false },
    ];
    bm.groupList.mockImplementation(() => Promise.resolve({ groups }));
    bm.bookmarkList.mockResolvedValue({ bookmarks: [], total: 0 });
    bm.favicon.mockResolvedValue({ icon: null });
    window.history.replaceState(null, "", "/?panel=bmfolder&group=7");
    document.getElementById("bmFolder")!.replaceChildren();
    openBmFolderPanel();
    await vi.waitFor(() => expect(document.querySelector('.bm-sub[data-sub="19"]')).toBeTruthy());
    return groups;
  };

  it("правый клик по подпапке — меню bmsub с её id (раньше меню не было)", async () => {
    await openWithSub();
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
    document.querySelector('.bm-sub[data-sub="19"]')!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(lastMenu()?.args).toMatchObject({ kind: "bmsub", payload: { id: 19 } });
  });

  it("«Переместить на уровень выше» — groupMove под родителя открытой папки (null = строка)", async () => {
    const groups = await openWithSub();
    bm.groupMove.mockImplementation((p: { id: number; parentId: number | null }) => {
      const g = groups.find((x) => x.id === p.id);
      if (g) g.parentId = p.parentId;
      return Promise.resolve();
    });
    pickMenu({ menu: "bmsub", act: "up", groupId: 19 });
    await vi.waitFor(() => expect(bm.groupMove).toHaveBeenCalledWith({ id: 19, parentId: null }));
    // перерисовка: AI больше не ребёнок Network — ушла на уровень строки
    await vi.waitFor(() => expect(document.querySelector('.bm-sub[data-sub="19"]')).toBeNull());
  });

  it("«Удалить папку» — groupRemove, строка подпапки уходит", async () => {
    const groups = await openWithSub();
    bm.groupRemove.mockImplementation((p: { id: number }) => {
      const at = groups.findIndex((x) => x.id === p.id);
      if (at >= 0) groups.splice(at, 1);
      return Promise.resolve();
    });
    pickMenu({ menu: "bmsub", act: "delete", groupId: 19 });
    await vi.waitFor(() => expect(bm.groupRemove).toHaveBeenCalledWith({ id: 19 }));
    await vi.waitFor(() => expect(document.querySelector('.bm-sub[data-sub="19"]')).toBeNull());
  });

  it("«Переименовать…» — инлайн-правка имени подпапки на её строке", async () => {
    await openWithSub();
    bm.groupRename.mockResolvedValue(undefined);
    pickMenu({ menu: "bmsub", act: "rename", groupId: 19 });
    const input = (await vi.waitFor(() =>
      document.querySelector<HTMLInputElement>('.bm-sub[data-sub="19"] input.bm-rename'),
    ))!;
    input.value = "ИИ";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(bm.groupRename).toHaveBeenCalledWith({ id: 19, name: "ИИ" }));
  });
});
