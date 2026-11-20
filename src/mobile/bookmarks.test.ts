// Тесты закладок мобильной ветки (duopulse-104): чистые функции — план
// перекладывания между группами (move-семантика десктопа 099), подпись хоста,
// выбор чипа-цели тяги. DOM-логика тяги (long-press, призрак, шит) — живой
// прогон на эмуляторе (e2e, прецеденты duopulse-083/102); открытие/закрытие
// экрана из меню «⋮» поверх видео (duopulse-193) — happy-dom ниже.

// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(true),
}));

import { dropTargetOf, hostLabel, planGroupDrop, MobileBookmarks } from "./bookmarks";

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
