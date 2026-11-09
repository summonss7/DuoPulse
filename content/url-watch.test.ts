// Тесты трекера SPA-навигации (content/url-watch.js, карточки duopulse-057 и
// duopulse-100). Скрипт — IIFE без зависимостей: исполняем его source
// (include_str! в Core кладёт тот же файл) в фейковом окружении window/
// location/history/Navigation API и проверяем исходящие spa-url сообщения.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./url-watch.js", import.meta.url), "utf8");

/** Событие Navigation API 'navigate'. */
type NavEvent = { destination?: { url?: string; sameDocument?: boolean } };

/** Фейковое окружение документа + установка трекера (run). */
function makeEnv(opts?: { top?: unknown; navigation?: boolean }) {
  const messages: { duopulse?: string; url?: string }[] = [];
  const winListeners = new Map<string, Set<(e: unknown) => void>>();
  const navListeners = new Map<string, Set<(e: unknown) => void>>();
  const timers: (() => void)[] = [];
  const win: Record<string, unknown> & {
    top?: unknown;
    chrome?: unknown;
    navigation?: unknown;
  } = {
    chrome: {
      webview: {
        postMessage: (m: string): void => {
          messages.push(JSON.parse(m) as { duopulse?: string; url?: string });
        },
      },
    },
    addEventListener: (t: string, fn: (e: unknown) => void): void => {
        const set = winListeners.get(t) ?? new Set();
        set.add(fn);
        winListeners.set(t, set);
      },
  };
  win.top = opts?.top === undefined ? win : opts.top;
  if (opts?.navigation !== false) {
    win.navigation = {
      addEventListener: (t: string, fn: (e: unknown) => void): void => {
        const set = navListeners.get(t) ?? new Set();
        set.add(fn);
        navListeners.set(t, set);
      },
    };
  }
  const location = { href: "https://www.youtube.com/" };
  const history: Record<string, (...a: unknown[]) => unknown> = {
    pushState: () => undefined,
    replaceState: () => undefined,
  };
  const run = (): void => {
    new Function(
      "window",
      "location",
      "history",
      "setTimeout",
      source,
    )(win, location, history, (fn: () => void) => {
      timers.push(fn);
      return 0;
    });
  };
  return {
    messages,
    location,
    history,
    run,
    /** Коммит same-document навигации: событие уже прошло, URL применился. */
    navigate: (e: NavEvent, commitTo?: string): void => {
      if (commitTo) location.href = commitTo;
      for (const fn of navListeners.get("navigate") ?? []) fn(e);
    },
    fire: (t: string): void => {
      for (const fn of winListeners.get(t) ?? []) fn(undefined);
    },
    flushTimers: (): void => {
      while (timers.length) timers.shift()!();
    },
  };
}

describe("url-watch (карточка duopulse-057: History API)", () => {
  it("pushState сообщает новый URL", () => {
    const env = makeEnv();
    env.run();
    env.location.href = "https://www.youtube.com/watch?v=abc";
    env.history.pushState(null, "", "https://www.youtube.com/watch?v=abc");
    expect(env.messages).toEqual([
      { duopulse: "spa-url", url: "https://www.youtube.com/watch?v=abc" },
    ]);
  });

  it("popstate сообщает возврат (Back на прошлую страницу)", () => {
    const env = makeEnv();
    env.run();
    // ушли на видео (last уже /watch), затем Back: href стал прежним
    env.location.href = "https://www.youtube.com/watch?v=abc";
    env.history.pushState(null, "", "https://www.youtube.com/watch?v=abc");
    env.location.href = "https://www.youtube.com/";
    env.fire("popstate");
    expect(env.messages).toEqual([
      { duopulse: "spa-url", url: "https://www.youtube.com/watch?v=abc" },
      { duopulse: "spa-url", url: "https://www.youtube.com/" },
    ]);
  });

  it("повторная установка (тот же документ) не дублирует хуки", () => {
    const env = makeEnv();
    env.run();
    env.run();
    env.location.href = "https://www.youtube.com/feed/subscriptions";
    env.history.replaceState(null, "", "u");
    expect(env.messages).toHaveLength(1);
  });
});

describe("url-watch (карточка duopulse-100: Navigation API)", () => {
  it("same-document navigate — переход в канал YouTube сообщается", () => {
    const env = makeEnv();
    env.run();
    // YouTube: клик по каналу — navigation.navigate('/@TED'), pushState не зовётся
    env.navigate(
      {
        destination: {
          url: "https://www.youtube.com/@TED",
          sameDocument: true,
        },
      },
      "https://www.youtube.com/@TED",
    );
    expect(env.messages).toEqual([]);
    env.flushTimers(); // post — после commit навигации
    expect(env.messages).toEqual([
      { duopulse: "spa-url", url: "https://www.youtube.com/@TED" },
    ]);
  });

  it("кросс-документная навигация игнорируется — её видит on_page_load", () => {
    const env = makeEnv();
    env.run();
    env.navigate({
      destination: { url: "https://example.com/", sameDocument: false },
    });
    env.location.href = "https://example.com/";
    env.flushTimers();
    expect(env.messages).toEqual([]);
  });

  it("отменённая (не закоммиченная) навигация не репортится", () => {
    const env = makeEnv();
    env.run();
    env.navigate({
      destination: { url: "https://www.youtube.com/@TED", sameDocument: true },
    });
    env.flushTimers(); // commit не случился — location прежний
    expect(env.messages).toEqual([]);
  });

  it("дедуп: тот же URL повторно не шлётся", () => {
    const env = makeEnv();
    env.run();
    env.navigate(
      { destination: { url: "https://www.youtube.com/@TED", sameDocument: true } },
      "https://www.youtube.com/@TED",
    );
    env.flushTimers();
    env.navigate(
      { destination: { url: "https://www.youtube.com/@TED", sameDocument: true } },
      "https://www.youtube.com/@TED",
    );
    env.flushTimers();
    expect(env.messages).toHaveLength(1);
  });

  it("без Navigation API хуки History API работают", () => {
    const env = makeEnv({ navigation: false });
    env.run();
    env.location.href = "https://www.youtube.com/@TED";
    env.history.pushState(null, "", "https://www.youtube.com/@TED");
    expect(env.messages).toEqual([
      { duopulse: "spa-url", url: "https://www.youtube.com/@TED" },
    ]);
  });
});

describe("url-watch (iframe / защита)", () => {
  it("в ифрейме хуки не ставятся — адрес вкладки меняет только top", () => {
    const env = makeEnv({ top: {} });
    env.run();
    expect(env.messages).toEqual([]);
    // history не обёрнут: вызов не порождает сообщений
    env.location.href = "https://www.youtube.com/watch?v=abc";
    env.history.pushState(null, "", "https://www.youtube.com/watch?v=abc");
    env.location.href = "https://www.youtube.com/@TED";
    env.history.replaceState(null, "", "https://www.youtube.com/@TED");
    expect(env.messages).toEqual([]);
  });
});
