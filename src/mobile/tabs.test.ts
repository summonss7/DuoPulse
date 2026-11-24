// Тесты вкладок мобильной ветки (duopulse-123): чистые функции — разбор
// сохранённой сессии, сериализация, план закрытия вкладки и план открытия.
// DOM-логика (iframe, пауза фоновых, лист-переключатель) — живой прогон на
// эмуляторе (как e2e/bookmarks, хук __duopulseMobileTabs); реплей фоновой
// музыки только активной вкладки (duopulse-237) — happy-dom ниже.

// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOSED_CAP,
  MAX_TABS,
  MobileTabs,
  parseSavedTabs,
  planAfterClose,
  planOpen,
  pushClosed,
  serializeTabs,
} from "./tabs";

describe("parseSavedTabs (сессия после перезапуска)", () => {
  it("валидная сессия читается", () => {
    const raw = serializeTabs(
      [
        { videoId: "dQw4w9WgXcQ", title: "Песня" },
        { videoId: "abc123_-Xyz", title: "" },
      ],
      1,
    );
    expect(parseSavedTabs(raw)).toEqual({
      tabs: [
        { videoId: "dQw4w9WgXcQ", title: "Песня" },
        { videoId: "abc123_-Xyz", title: "" },
      ],
      active: 1,
    });
  });

  it("битые videoId выкидываются, активная поправляется на первую", () => {
    const raw = JSON.stringify({
      tabs: [
        { videoId: "коротко", title: "мусор" },
        { videoId: "dQw4w9WgXcQ", title: "годное" },
        { videoId: 42, title: "не строка" },
      ],
      active: 9,
    });
    expect(parseSavedTabs(raw)).toEqual({
      tabs: [{ videoId: "dQw4w9WgXcQ", title: "годное" }],
      active: 0,
    });
  });

  it("пусто/мусор/нет вкладок — null (чистый старт)", () => {
    expect(parseSavedTabs(null)).toBeNull();
    expect(parseSavedTabs("")).toBeNull();
    expect(parseSavedTabs("не json")).toBeNull();
    expect(parseSavedTabs('{"tabs":[]}')).toBeNull();
    expect(parseSavedTabs('{"tabs":[{"videoId":"nope!!"}]}')).toBeNull();
  });

  it(`потолок MAX_TABS (${MAX_TABS}): лишние вкладки отрезаются`, () => {
    const many = Array.from({ length: MAX_TABS + 5 }, (_, i) => ({
      videoId: `videoId${String(i).padStart(5, "0")}`,
      title: "",
    }));
    const parsed = parseSavedTabs(JSON.stringify({ tabs: many, active: 0 }));
    expect(parsed?.tabs.length).toBe(MAX_TABS);
  });
});

describe("serializeTabs ↔ parseSavedTabs (round-trip)", () => {
  it("активная за границами зажимается в диапазон", () => {
    const raw = serializeTabs([{ videoId: "dQw4w9WgXcQ", title: "t" }], -3);
    expect(parseSavedTabs(raw)?.active).toBe(0);
    const raw2 = serializeTabs(
      [
        { videoId: "aaaaaaaaaaa", title: "" },
        { videoId: "bbbbbbbbbbb", title: "" },
      ],
      5,
    );
    expect(parseSavedTabs(raw2)?.active).toBe(1);
  });
});

describe("planAfterClose (какую вкладку активировать после закрытия)", () => {
  it("закрыта активная в середине — сосед справа", () => {
    expect(planAfterClose([1, 2, 3], 2, 2)).toBe(3);
  });
  it("закрыта последняя активная — сосед слева", () => {
    expect(planAfterClose([1, 2, 3], 3, 3)).toBe(2);
  });
  it("закрыта единственная — вкладок нет (стартовый экран)", () => {
    expect(planAfterClose([7], 7, 7)).toBeNull();
  });
  it("закрыта фоновая — активная не меняется", () => {
    expect(planAfterClose([1, 2, 3], 1, 3)).toBe(3);
  });
  it("неизвестный id — как есть (защита от гонки)", () => {
    expect(planAfterClose([1, 2], 99, 2)).toBe(2);
  });
});

describe("planOpen (заменить вкладку или создать новую)", () => {
  it("omnibox при открытом видео — замена (как вкладка Chrome)", () => {
    expect(planOpen(true, false)).toBe("replace");
  });
  it("закладка/старт-экран при открытом видео — новая вкладка", () => {
    expect(planOpen(true, true)).toBe("create");
  });
  it("видео не открыто — всегда новая", () => {
    expect(planOpen(false, false)).toBe("create");
    expect(planOpen(false, true)).toBe("create");
  });
});

describe("pushClosed (стек «Восстановить вкладку», duopulse-156)", () => {
  it("закрытия копятся в порядке LIFO — восстановление с конца", () => {
    const st = pushClosed(pushClosed([], { videoId: "aaa12345678", title: "A" }), {
      videoId: "bbb12345678",
      title: "B",
    });
    expect(st).toHaveLength(2);
    expect(st[st.length - 1].videoId).toBe("bbb12345678");
  });

  it("потолок CLOSED_CAP срезает старейшие", () => {
    let st: { videoId: string; title: string }[] = [];
    for (let i = 0; i < CLOSED_CAP + 5; i++) st = pushClosed(st, { videoId: `vid${i}pad1234`, title: String(i) });
    expect(st).toHaveLength(CLOSED_CAP);
    expect(st[0].videoId).toBe("vid5pad1234");
    expect(st[st.length - 1].videoId).toBe(`vid${CLOSED_CAP + 4}pad1234`);
  });

  it("явный cap тоже уважается", () => {
    let st: { videoId: string; title: string }[] = [];
    for (let i = 0; i < 4; i++) st = pushClosed(st, { videoId: `vid${i}pad1234`, title: "" }, 2);
    expect(st).toHaveLength(2);
  });
});

describe("MobileTabs.resumeActive — реплей фоновой музыки только активной вкладки (duopulse-237)", () => {
  beforeEach(() => {
    localStorage.clear();
    // iframe вкладок не ходят в сеть: стенду нужен только postMessage
    (
      window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }
    ).happyDOM.settings.disableIframePageLoading = true;
    document.body.innerHTML = `
      <header class="m-bar-top"><button id="mPrivate"></button></header>
      <main class="m-content"></main>`;
  });

  const make = () =>
    new MobileTabs({
      content: document.querySelector<HTMLElement>(".m-content")!,
      bar: document.querySelector<HTMLElement>(".m-bar-top")!,
      note: () => {},
      isPrivate: () => false,
      onActive: () => {},
    });

  /** Окно iframe — шпион postMessage (кросс-доменное окно в happy-dom не живое). */
  const spyFrame = (frame: HTMLIFrameElement) => {
    const postMessage = vi.fn();
    Object.defineProperty(frame, "contentWindow", { value: { postMessage }, configurable: true });
    return postMessage;
  };

  /** Команды IFrame API из вызовов шпиона: имя функции + targetOrigin. */
  const commands = (spy: ReturnType<typeof vi.fn>) =>
    spy.mock.calls.map(([data, origin]) => ({
      func: (JSON.parse(data as string) as { func: string }).func,
      origin,
    }));

  it("две вкладки: playVideo уходит только во вторую (активную), фоновая молчит", () => {
    const tabs = make();
    tabs.open("aaa11111111", "", true);
    const first = spyFrame(document.querySelectorAll<HTMLIFrameElement>("iframe.m-tab")[0]);
    tabs.open("bbb22222222", "", true);
    const frames = document.querySelectorAll<HTMLIFrameElement>("iframe.m-tab");
    const second = spyFrame(frames[1]);
    expect(frames[0].hidden).toBe(true);
    expect(frames[1].hidden).toBe(false);
    // само переключение ставит прежнюю на паузу — и только это ей шлётся
    expect(commands(first)).toEqual([{ func: "pauseVideo", origin: "https://www.youtube.com" }]);
    first.mockClear();

    expect(tabs.resumeActive()).toBe(true);
    expect(commands(first)).toEqual([]);
    expect(commands(second)).toEqual([
      { func: "playVideo", origin: "https://www.youtube.com" },
    ]);
  });

  it("переключение: после возврата на первую реплей идёт первой, второй — ничего", () => {
    const tabs = make();
    tabs.open("aaa11111111", "", true);
    tabs.open("bbb22222222", "", true);
    const frames = document.querySelectorAll<HTMLIFrameElement>("iframe.m-tab");
    const first = spyFrame(frames[0]);
    const second = spyFrame(frames[1]);

    tabs.switchTo(1);
    first.mockClear();
    second.mockClear();
    expect(tabs.resumeActive()).toBe(true);
    expect(commands(first)).toEqual([{ func: "playVideo", origin: "https://www.youtube.com" }]);
    expect(commands(second)).toEqual([]);
  });

  it("активной нет («домой» / новая вкладка): false, ни одной командой не шлём", () => {
    const tabs = make();
    tabs.open("aaa11111111", "", true);
    tabs.open("bbb22222222", "", true);
    const spies = [...document.querySelectorAll<HTMLIFrameElement>("iframe.m-tab")].map(spyFrame);

    tabs.newTab();
    spies.forEach((s) => s.mockClear());
    expect(tabs.resumeActive()).toBe(false);
    spies.forEach((s) => expect(commands(s)).toEqual([]));
  });

  it("фоновая остаётся на паузе: playVideo в неё не приходит ни при переключениях, ни при реплее", () => {
    const tabs = make();
    tabs.open("aaa11111111", "", true);
    tabs.open("bbb22222222", "", true);
    const first = spyFrame(document.querySelectorAll<HTMLIFrameElement>("iframe.m-tab")[0]);

    tabs.switchTo(1);
    tabs.switchTo(2);
    first.mockClear();
    expect(tabs.resumeActive()).toBe(true);
    expect(commands(first)).toEqual([]);
  });
});
