// Тесты монитора медиа (content/media-watch.js, задача 2.3 + фон-пауза
// карточки duopulse-117). Скрипт — IIFE без зависимостей: исполняем его source
// (include_str! в Core кладёт тот же файл) в фейковом окружении window/
// document/location и проверяем исходящие media-сообщения и фоновую паузу
// беззвучного видео.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./media-watch.js", import.meta.url), "utf8");

/** Медиа-элемент: состояние + счётчик pause() (сайт может видеть вызовы). */
type FakeEl = {
  paused: boolean;
  ended: boolean;
  muted: boolean;
  volume: number;
  pauseThrows?: boolean;
  pauseCalls: number;
  pause: () => void;
};

const el = (opts?: Partial<Omit<FakeEl, "pause" | "pauseCalls">>): FakeEl => {
  const e: FakeEl = {
    paused: false,
    ended: false,
    muted: true,
    volume: 1,
    pauseThrows: false,
    pauseCalls: 0,
    ...opts,
    pause: () => {
      e.pauseCalls++;
      if (e.pauseThrows) throw new Error("protected");
      e.paused = true;
    },
  };
  return e;
};

/** Фейковое окружение документа + установка монитора (run). */
function makeEnv(els: FakeEl[], opts?: { hidden?: boolean; internal?: boolean }) {
  const messages: { duopulse?: string; playing?: boolean }[] = [];
  const listeners = new Map<string, Set<() => void>>();
  const timers: (() => void)[] = [];
  const document = {
    hidden: opts?.hidden ?? false,
    addEventListener: (t: string, fn: () => void): void => {
      const set = listeners.get(t) ?? new Set();
      set.add(fn);
      listeners.set(t, set);
    },
    querySelectorAll: () => els,
  };
  const win: Record<string, unknown> = {
    chrome: {
      webview: {
        postMessage: (m: string): void => {
          messages.push(JSON.parse(m) as { duopulse?: string; playing?: boolean });
        },
      },
    },
  };
  const location = opts?.internal
    ? { hostname: "localhost", protocol: "http:", port: "5173" }
    : { hostname: "example.com", protocol: "https:", port: "" };
  const run = (): void => {
    new Function("window", "document", "location", "setInterval", source)(
      win,
      document,
      location,
      (fn: () => void) => {
        timers.push(fn);
        return 0;
      },
    );
  };
  return {
    messages,
    els,
    run,
    /** Скрыть/показать вкладку (Core прячет webview → visibilitychange). */
    setHidden: (hidden: boolean): void => {
      document.hidden = hidden;
      for (const fn of listeners.get("visibilitychange") ?? []) fn();
    },
    /** Событие медиа-элемента (play/pause/…) — захват на документе. */
    fire: (t: string): void => {
      for (const fn of listeners.get(t) ?? []) fn();
    },
    /** Ближайший опрос (в браузере — раз в 2 с, колбэк один и тот же). */
    tick: (): void => {
      timers[0]?.();
    },
  };
}

describe("media-watch (задача 2.3: исключение спящего режима)", () => {
  it("играющий элемент в видимой вкладке — playing=true, пауза не трогает", () => {
    const env = makeEnv([el({ muted: true })]);
    env.run();
    expect(env.messages).toEqual([{ duopulse: "media", playing: true }]);
    expect(env.els[0].pauseCalls).toBe(0);
  });

  it("нет медиа — единственное playing=false", () => {
    const env = makeEnv([]);
    env.run();
    expect(env.messages).toEqual([{ duopulse: "media", playing: false }]);
  });

  it("внутренние страницы (app-origin) — монитор не ставится", () => {
    const env = makeEnv([el()], { internal: true });
    env.run();
    expect(env.messages).toEqual([]);
  });

  it("старт медиа и стоп сообщаются событиями без дублей", () => {
    const env = makeEnv([el()]);
    env.run();
    env.els[0].paused = true;
    env.fire("pause");
    env.els[0].paused = false;
    env.fire("play");
    expect(env.messages.map((m) => m.playing)).toEqual([true, false, true]);
  });
});

describe("media-watch (карточка duopulse-117: фон-пауза беззвучного видео)", () => {
  it("беззвучное видео в скрытой вкладке — на паузу сразу, Core видит playing=false", () => {
    // вкладка открыта в фоне (middle-click): скрыта до первого скана
    const env = makeEnv([el({ muted: true })], { hidden: true });
    env.run();
    expect(env.els[0].pauseCalls).toBe(1);
    // событие pause (захват на документе) → пересчёт → сообщение в Core
    env.fire("pause");
    expect(env.messages).toEqual([{ duopulse: "media", playing: false }]);
  });

  it("переключение со вкладки (visibilitychange) ставит беззвучное видео на паузу", () => {
    const env = makeEnv([el({ muted: true })]);
    env.run(); // видима, играет → playing=true
    env.setHidden(true);
    expect(env.els[0].pauseCalls).toBe(1);
    env.fire("pause");
    expect(env.messages.map((m) => m.playing)).toEqual([true, false]);
  });

  it("видео со звуком в скрытой вкладке не трогаем — играет, playing=true", () => {
    const env = makeEnv([el({ muted: false, volume: 1 })], { hidden: true });
    env.run();
    expect(env.els[0].pauseCalls).toBe(0);
    expect(env.messages).toEqual([{ duopulse: "media", playing: true }]);
  });

  it("volume=0 — тоже беззвучное: пауза в фоне", () => {
    const env = makeEnv([el({ muted: false, volume: 0 })], { hidden: true });
    env.run();
    expect(env.els[0].pauseCalls).toBe(1);
  });

  it("звук + беззвучное видео вместе в фоне — никого не трогаем (вкладка со звуком)", () => {
    const env = makeEnv([el({ muted: false, volume: 0.5 }), el({ muted: true })], {
      hidden: true,
    });
    env.run();
    expect(env.els.map((e) => e.pauseCalls)).toEqual([0, 0]);
    expect(env.messages).toEqual([{ duopulse: "media", playing: true }]);
  });

  it("беззвучный <audio> в фоне — тоже на паузу (модель музыки в заглушенной вкладке)", () => {
    const env = makeEnv([el({ muted: true })], { hidden: true });
    env.run();
    expect(env.els[0].pauseCalls).toBe(1);
  });

  it("медиа стартовало уже в фоне (автоплей) — опрос ставит его на паузу", () => {
    const paused = el({ muted: true, paused: true });
    const env = makeEnv([paused], { hidden: true });
    env.run();
    expect(env.messages).toEqual([{ duopulse: "media", playing: false }]);
    paused.paused = false; // сайт запустил видео без событий (предзагрузка)
    env.tick();
    expect(paused.pauseCalls).toBe(1);
  });

  it("сайт перекрыл pause() — видео не паузится, состояние честно уходит (playing=true)", () => {
    const env = makeEnv([el({ muted: true, pauseThrows: true })], { hidden: true });
    env.run();
    expect(env.els[0].pauseCalls).toBe(1);
    expect(env.messages).toEqual([{ duopulse: "media", playing: true }]);
  });

  it("возврат на вкладку не запускает видео обратно — пауза остаётся (как Chrome)", () => {
    const env = makeEnv([el({ muted: true })]);
    env.run();
    env.setHidden(true);
    env.fire("pause"); // видео остановлено фоном
    env.setHidden(false);
    expect(env.els[0].pauseCalls).toBe(1);
    expect(env.messages.map((m) => m.playing)).toEqual([true, false]);
  });
});
