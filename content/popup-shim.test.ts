// Тесты компенсации window.open-попапов (content/popup-shim.ts, duopulse-227).
// Сценарии — по живому кликундеру uakinogo.io (deltarockme→js10.beeparentdo,
// default()/postWindowPop: preventDefault → about:blank-попап 1×1 →
// document.write → focus → location=реклама + simulateClick).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPopupShim } from "./popup-shim";

type OpenCall = { url: string | URL | undefined; target?: string; features?: string };

/** Фейковое окно: нативный open подконтролен, таймеры/события — как в браузере. */
function makeWin(opts?: { nativeReturns?: Window | null }) {
  const openCalls: OpenCall[] = [];
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const dispatched: string[] = [];
  // node-окружение без DOM-глобалей — минимальные конструкторы событий
  class FakeEvent {
    constructor(public type: string) {}
  }
  class FakeFocusEvent extends FakeEvent {}
  const win = {
    nativeReturns: opts?.nativeReturns ?? null,
    open(url?: string | URL, target?: string, features?: string) {
      openCalls.push({ url, target, features });
      return win.nativeReturns;
    },
    addEventListener(type: string, fn: (e: unknown) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    dispatchEvent(e: { type: string }) {
      dispatched.push(e.type);
      listeners.get(e.type)?.forEach((fn) => fn(e));
      return true;
    },
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    Event: FakeEvent as unknown as typeof Event,
    FocusEvent: FakeFocusEvent as unknown as typeof FocusEvent,
  };
  return {
    win: win as unknown as Window & typeof win,
    openCalls,
    dispatched,
    fire(type: string) {
      win.dispatchEvent({ type });
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("installPopupShim: не-http попапы", () => {
  it("about:blank вместо null: document.write не падает, окно «открыто»", () => {
    const { win } = makeWin();
    installPopupShim(win);
    const popup = win.open("about:blank", "pu", "width=1,height=1");
    expect(popup).not.toBeNull();
    expect(() => popup!.document.write("<html></html>")).not.toThrow();
    expect((popup as unknown as { closed: boolean }).closed).toBe(false);
    popup!.focus();
    popup!.moveTo(19999, 19999);
    popup!.resizeTo(1, 0);
  });

  it("вызов без адреса ('' / undefined) — тоже заглушка", () => {
    const { win } = makeWin();
    installPopupShim(win);
    expect(win.open()).not.toBeNull();
    expect(win.open("")).not.toBeNull();
  });

  it("сеттер location (реклама попапа) уходит вкладкой через нативный open", () => {
    const { win, openCalls } = makeWin();
    installPopupShim(win);
    const popup = win.open("about:blank", "pu");
    (popup as unknown as { location: string }).location = "https://cdn77-fs.kinoroll.com/ad.html";
    expect(openCalls.map((c) => String(c.url))).toContain("https://cdn77-fs.kinoroll.com/ad.html");
    // location.href = … — тот же путь
    (popup as unknown as { location: { href: string } }).location.href = "https://ad.example/x";
    expect(openCalls.map((c) => String(c.url))).toContain("https://ad.example/x");
    // не-http присвоение остаётся в заглушке, никуда не зовёт
    const before = openCalls.length;
    (popup as unknown as { location: string }).location = "about:blank#x";
    expect(openCalls.length).toBe(before);
    expect((popup as unknown as { location: { toString(): string } }).location.toString()).toBe("about:blank#x");
  });

  it("через 500 мс на opener разыгрывается focus (компенсация клика)", () => {
    const { win, dispatched } = makeWin();
    installPopupShim(win);
    win.open("about:blank");
    expect(dispatched).toEqual([]);
    vi.advanceTimersByTime(499);
    expect(dispatched).toEqual([]);
    vi.advanceTimersByTime(2);
    expect(dispatched).toEqual(["focus"]);
  });

  it("повторная установка не вкладывает обёртки", () => {
    const { win, openCalls } = makeWin();
    installPopupShim(win);
    installPopupShim(win);
    win.open("about:blank");
    expect(openCalls.length).toBe(1);
  });
});

describe("installPopupShim: пути без заглушки", () => {
  it("http(s)-попап — null («заблокирован», вкладку открыло ядро)", () => {
    const { win, openCalls } = makeWin();
    installPopupShim(win);
    expect(win.open("https://example.com/", "_blank")).toBeNull();
    expect(openCalls.length).toBe(1); // нативный вызов дошёл (NewWindowRequested ядра)
  });

  it("нативный open вернул окно — проходит как есть", () => {
    const real = {} as Window;
    const { win } = makeWin({ nativeReturns: real });
    installPopupShim(win);
    expect(win.open("about:blank")).toBe(real);
  });
});

describe("installPopupShim: сценарий кликундера uakinogo (duopulse-227)", () => {
  it("preventDefault → null-попап → focus → location=реклама + клик компенсирован", () => {
    const { win, openCalls, fire } = makeWin();
    installPopupShim(win);
    // что успевает сделать кликундер ДО падения (в живом DuoPulse падал тут)
    let compensated = false;
    let prevented = false;
    const anchor = {
      clickCount: 0,
      dispatchEvent() {
        this.clickCount += 1;
      },
    };
    win.addEventListener("click", () => {
      if (compensated) {
        anchor.dispatchEvent(); // кука успеха: перехвата нет, клик идёт в ссылку
        return;
      }
      prevented = true;
      const popup = win.open("about:blank", "pu" + Math.random(), "width=1,height=1");
      popup!.document.write("<html>…</html>"); // ← без шима: TypeError, дальше никак
      win.addEventListener(
        "focus",
        () => {
          popup!.moveTo(0, 0);
          popup!.resizeTo(1, 1);
          (popup as unknown as { location: string }).location = "https://ad.example/popunder";
          compensated = true; // + utils.simulateClick по сохранённым координатам:
          anchor.dispatchEvent();
        },
        { once: true } as AddEventListenerOptions,
      );
    });
    // клик пользователя №1: перехвачен, попап «открыт», фокус ещё не вернулся
    fire("click");
    expect(prevented).toBe(true);
    expect(anchor.clickCount).toBe(0);
    // фокус вернулся (наш отложенный тик) — кликундер доиграл, клик возвращён
    vi.advanceTimersByTime(600);
    expect(compensated).toBe(true);
    expect(anchor.clickCount).toBe(1);
    expect(openCalls.map((c) => String(c.url))).toContain("https://ad.example/popunder");
    // клик №2 — сайт живёт своей жизнью (адрес открылся вкладкой ядра)
    fire("click");
    expect(anchor.clickCount).toBe(2);
  });
});
