// Тесты закладок мобильной ветки (duopulse-104): чистые функции — план
// перекладывания между группами (move-семантика десктопа 099), подпись хоста,
// выбор чипа-цели тяги. DOM-логика тяги (long-press, призрак, шит) — живой
// прогон на эмуляторе (e2e, прецеденты duopulse-083/102); открытие/закрытие
// экрана из меню «⋮» поверх видео (duopulse-193) — happy-dom ниже.

// @vitest-environment happy-dom
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(true),
}));
// duopulse-219: bookmarks тянет десктопную bmbar (модель строки) — её
// panel-window на уровне модуля слушает chrome-panel-closed; мокаем event
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

import {
  bmBarEnabled,
  bmSortModeOf,
  dropTargetOf,
  hostLabel,
  planGroupDrop,
  MobileBookmarks,
  sortBookmarksView,
} from "./bookmarks";

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

// ── duopulse-193: экран закладок из меню «⋮» поверх открытого видео ────────
// Каркас мобильной ветки + заглушка history.*: openView/closeView честно
// возвращают старт-экран в состояние «как до открытия» (видео под экраном
// не должно подменяться стартом).
describe("MobileBookmarks openView/closeView (duopulse-193)", () => {
  const api = {
    history: {
      groupList: vi.fn().mockResolvedValue({ groups: [] }),
      bookmarkList: vi.fn().mockResolvedValue({ bookmarks: [], total: 0 }),
    },
  };

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="mobile">
        <div id="mUrlrow"><input id="mOmnibox"><button id="mGo"></button></div>
        <main class="m-content">
          <section id="mStart"><p class="m-hint"></p></section>
        </main>
      </div>`;
  });

  const make = (): MobileBookmarks =>
    new MobileBookmarks(
      { currentVideo: () => null, open: () => {}, note: () => {} },
      api as unknown as ConstructorParameters<typeof MobileBookmarks>[1],
    );

  it("из меню поверх видео: закрытие возвращает к видео, старт остаётся скрыт", async () => {
    const bm = make();
    const start = document.querySelector<HTMLElement>("#mStart")!;
    start.hidden = true; // открыто видео (onTabActive)
    await bm.openView();
    expect(start.hidden).toBe(true); // не показать старт под закладками
    bm.closeView();
    expect(start.hidden).toBe(true); // вернулись к видео, не к старту
  });

  it("со стартового экрана: закрытие возвращает старт", async () => {
    const bm = make();
    const start = document.querySelector<HTMLElement>("#mStart")!;
    await bm.openView();
    expect(start.hidden).toBe(true);
    bm.closeView();
    expect(start.hidden).toBe(false);
  });

  it("closeView(false) не трогает старт (закрытие всех вкладок — старт уже показан)", async () => {
    const bm = make();
    const start = document.querySelector<HTMLElement>("#mStart")!;
    start.hidden = true;
    await bm.openView();
    start.hidden = false; // onTabActive(null): вкладки кончились, старт виден
    bm.closeView(false);
    expect(start.hidden).toBe(false); // экран свернулся, старт не спрятали
  });
});

// ── duopulse-219: строка закладок под адресом + сортировка списка ──────────
const bm = (url: string, title: string, addedAt: number) => ({ url, title, addedAt, groups: [] });

describe("bmBarEnabled (duopulse-219): дефолт включена, «off» прячет", () => {
  it("нет записи или мусор — включена; off — выключена", () => {
    expect(bmBarEnabled(() => null)).toBe(true);
    expect(bmBarEnabled(() => "мусор")).toBe(true);
    expect(bmBarEnabled(() => "off")).toBe(false);
  });
});

describe("bmSortModeOf (duopulse-219)", () => {
  it("сохранённый режим читается, мусор — manual", () => {
    expect(bmSortModeOf(() => null)).toBe("manual");
    expect(bmSortModeOf(() => "мусор")).toBe("manual");
    expect(bmSortModeOf(() => "title_desc")).toBe("title_desc");
    expect(bmSortModeOf(() => "added_asc")).toBe("added_asc");
  });
});

describe("sortBookmarksView (duopulse-219)", () => {
  const list = [
    bm("https://w.example/", "Википедия", 3000),
    bm("https://g.example/", "GitHub", 2000),
    bm("https://m.example/", "mdn", 1000),
  ];

  it("manual — порядок как загружен, исходный массив не меняется", () => {
    expect(sortBookmarksView(list, "manual").map((b) => b.url)).toEqual([
      "https://w.example/",
      "https://g.example/",
      "https://m.example/",
    ]);
    expect(list[0].url).toBe("https://w.example/");
  });

  it("алфавит и обратный — зеркальные (base, без регистра)", () => {
    expect(sortBookmarksView(list, "title").map((b) => b.url)).toEqual([
      "https://g.example/",
      "https://m.example/",
      "https://w.example/",
    ]);
    expect(sortBookmarksView(list, "title_desc").map((b) => b.url)).toEqual([
      "https://w.example/",
      "https://m.example/",
      "https://g.example/",
    ]);
  });

  it("дата добавления: новые/старые первыми, тайбрейк url", () => {
    expect(sortBookmarksView(list, "added").map((b) => b.url)).toEqual([
      "https://w.example/",
      "https://g.example/",
      "https://m.example/",
    ]);
    expect(sortBookmarksView(list, "added_asc").map((b) => b.url)).toEqual([
      "https://m.example/",
      "https://g.example/",
      "https://w.example/",
    ]);
  });
});

// Строка под адресом: каркас DOM, чипы/папки, переключатель и сортировка
// показа — на happy-dom (как duopulse-193 выше); тяга — живой прогон e2e.
describe("MobileBookmarks: строка под адресом (duopulse-219)", () => {
  const groups = [
    { id: 1, name: "Избранное", position: 0, sortBy: "manual", isDefault: true, count: 1, parentId: null, depth: 1 },
    { id: 5, name: "Музыка", position: 1, sortBy: "manual", isDefault: false, count: 0, parentId: null, depth: 1 },
  ];
  const api = () => ({
    history: {
      groupList: vi.fn().mockResolvedValue({ groups }),
      bookmarkList: vi.fn().mockImplementation(({ groupId }: { groupId: number | null }) =>
        Promise.resolve(
          groupId === 1
            ? { bookmarks: [bm("https://w.example/", "Видео", 2)], total: 1 }
            : { bookmarks: [], total: 0 },
        ),
      ),
    },
  });
  const settle = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = `
      <div id="mobile">
        <div id="mUrlrow"><input id="mOmnibox"><button id="mGo"></button></div>
        <main class="m-content">
          <section id="mStart"><p class="m-hint"></p></section>
        </main>
      </div>`;
  });

  const make = (): MobileBookmarks =>
    new MobileBookmarks(
      { currentVideo: () => null, open: () => {}, note: () => {} },
      api() as unknown as ConstructorParameters<typeof MobileBookmarks>[1],
    );

  it("строка встаёт под адресом: чип закладки + папка группы, тап — открыть", async () => {
    const opened: string[] = [];
    const inst = new MobileBookmarks(
      { currentVideo: () => null, open: (u) => opened.push(u), note: () => {} },
      api() as unknown as ConstructorParameters<typeof MobileBookmarks>[1],
    );
    await settle();
    const bar = document.querySelector<HTMLElement>("#mBmBar")!;
    expect(bar).toBeTruthy();
    expect(bar.previousElementSibling?.id).toBe("mUrlrow"); // под строкой поиска
    expect(bar.hidden).toBe(false); // есть чипы
    const chip = bar.querySelector<HTMLElement>(".m-bmbar-chip[data-url]")!;
    chip.dispatchEvent(new Event("click", { bubbles: true }));
    expect(opened).toEqual(["https://w.example/"]);
    // папка-группа тоже на строке
    expect(bar.querySelector(".m-bmbar-folder")?.textContent).toContain("Музыка");
    expect(inst).toBeTruthy();
  });

  it("переключатель: выключение прячет строку, включение возвращает", async () => {
    const bmInst = make();
    await settle();
    const bar = document.querySelector<HTMLElement>("#mBmBar")!;
    expect(bar.hidden).toBe(false);
    bmInst.setBarEnabled(false);
    expect(bar.hidden).toBe(true);
    expect(localStorage.getItem("duopulse.mobile.bmbar")).toBe("off");
    bmInst.setBarEnabled(true);
    await settle();
    expect(bar.hidden).toBe(false); // снова с чипами
    expect(localStorage.getItem("duopulse.mobile.bmbar")).toBe(null);
  });

  it("папка открывает экран закладок в этой группе", async () => {
    const bmInst = make();
    await settle();
    const folder = document.querySelector<HTMLElement>(".m-bmbar-folder")!;
    folder.dispatchEvent(new Event("click", { bubbles: true }));
    await settle();
    const dbg = (window as unknown as { __bmDebug: () => { open: boolean; sel: unknown } }).__bmDebug();
    expect(dbg.open).toBe(true);
    expect(dbg.sel).toBe(5);
    bmInst.closeView();
  });

  it("сохранённый режим сортировки применяется к показу списка", async () => {
    localStorage.setItem("duopulse.mobile.bmsort", "title_desc");
    const rich = api();
    rich.history.bookmarkList.mockImplementation(({ groupId }: { groupId: number | null }) =>
      Promise.resolve(
        groupId === 1
          ? {
              bookmarks: [bm("https://w.example/", "Видео", 5), bm("https://a.example/", "Аудио", 9)],
              total: 2,
            }
          : { bookmarks: [], total: 0 },
      ),
    );
    const bmInst = new MobileBookmarks(
      { currentVideo: () => null, open: () => {}, note: () => {} },
      rich as unknown as ConstructorParameters<typeof MobileBookmarks>[1],
    );
    await bmInst.openGroup(1); // вид группы по умолчанию — обе закладки
    const dbg = (window as unknown as { __bmDebug: () => { bookmarks: { url: string }[]; sortMode: string } })
      .__bmDebug();
    expect(dbg.sortMode).toBe("title_desc");
    expect(dbg.bookmarks.map((b) => b.url)).toEqual([
      "https://w.example/",
      "https://a.example/",
    ]);
    bmInst.closeView();
  });
});

// ── duopulse-235: фавикон сайта в значках закладок ──────────────────────────
// Значок = бейдж-буква + applyFavicon (общий с десктопом): команда Core
// history.favicon отдаёт data-URL → <img> поверх бейджа, загрузка гасит букву
// (has-fav); «иконки нет» — бейдж, как прежде. Значок строки списка — внутри
// кнопки открытия (тап по иконке — открыть закладку). Сам фетч — в Rust
// (favicon.rs) и живой прогон e2e.
describe("MobileBookmarks: фавикон сайта в значках (duopulse-235)", () => {
  const invokeMock = vi.mocked(invoke);
  const icon = "data:image/png;base64,AAA";
  const withIcon = "https://fav235a.example/watch?v=1";
  const noIcon = "https://fav235b.example/";
  const bookmarks = [
    bm(withIcon, "Видео", 2),
    bm(noIcon, "Без иконки", 1),
  ];
  const api = () => ({
    history: {
      groupList: vi.fn().mockResolvedValue({ groups: [] }),
      bookmarkList: vi.fn().mockResolvedValue({ bookmarks, total: bookmarks.length }),
    },
  });
  const settle = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = `
      <div id="mobile">
        <div id="mUrlrow"><input id="mOmnibox"><button id="mGo"></button></div>
        <main class="m-content">
          <section id="mStart"><p class="m-hint"></p></section>
        </main>
      </div>`;
    // history.favicon — мок Core: одному хосту иконка, прочим «иконки нет»
    invokeMock.mockImplementation((cmd, args) => {
      if (cmd !== "history_favicon") return Promise.resolve(true);
      const { url } = (args as { params: { url: string } }).params;
      return Promise.resolve({ icon: url === withIcon ? icon : null });
    });
  });

  afterEach(() => invokeMock.mockReturnValue(Promise.resolve(true)));

  const make = (opened: string[] = []): MobileBookmarks =>
    new MobileBookmarks(
      { currentVideo: () => null, open: (u) => opened.push(u), note: () => {} },
      api() as unknown as ConstructorParameters<typeof MobileBookmarks>[1],
    );

  it("чип строки: history.favicon → img поверх бейджа, загрузка гасит букву", async () => {
    make();
    await settle();
    const badge = document.querySelector<HTMLElement>(`.m-bmbar-chip[data-url="${withIcon}"] .m-bmbar-badge`)!;
    expect(badge.textContent).toBe("В"); // до ответа Core — бейдж-буква
    await vi.waitFor(() => expect(badge.querySelector("img.bm-fav")).not.toBeNull());
    expect(invokeMock).toHaveBeenCalledWith("history_favicon", { params: { url: withIcon } });
    const img = badge.querySelector("img.bm-fav") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(icon);
    img.dispatchEvent(new Event("load"));
    expect(badge.classList.contains("has-fav")).toBe(true);
    expect(badge.style.background).toBe(""); // цвет домена уступил иконке
  });

  it("строка списка: значок внутри кнопки открытия — тап по иконке открывает", async () => {
    const opened: string[] = [];
    const inst = make(opened);
    await inst.openView();
    const row = [...document.querySelectorAll<HTMLElement>(".m-bm-row")].find((r) => r.dataset.url === withIcon)!;
    expect(row).toBeTruthy();
    const badge = row.querySelector<HTMLElement>(".m-bm-main > .m-bm-badge")!;
    expect(badge).toBeTruthy(); // не снаружи кнопки: иначе тап по значку мимо
    expect(row.querySelector(".m-bm-main > .m-bm-texts > .m-bm-title")?.textContent).toBe("Видео");
    await vi.waitFor(() => expect(badge.querySelector("img.bm-fav")).not.toBeNull());
    badge.querySelector("img.bm-fav")!.dispatchEvent(new Event("click", { bubbles: true }));
    expect(opened).toEqual([withIcon]);
  });

  it("иконки нет — остаётся бейдж-буква цветом домена", async () => {
    const inst = make();
    await inst.openView();
    const row = [...document.querySelectorAll<HTMLElement>(".m-bm-row")].find((r) => r.dataset.url === noIcon)!;
    const badge = row.querySelector<HTMLElement>(".m-bm-badge")!;
    await settle();
    await settle(); // ответ Core «иконки нет» отыграл
    expect(invokeMock).toHaveBeenCalledWith("history_favicon", { params: { url: noIcon } });
    expect(badge.querySelector("img.bm-fav")).toBeNull();
    expect(badge.classList.contains("has-fav")).toBe(false);
    expect(badge.textContent).toBe("Б");
    expect(badge.style.background).toContain("linear-gradient");
  });
});
