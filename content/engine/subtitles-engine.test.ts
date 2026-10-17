// Движок показа (задача 3.2): часы video.currentTime, подписки
// timeupdate/seeked, offset, правило 150 мс для скачков (docs/03 §4).
// Видео подменено фейком — движку нужен только currentTime/подписки.
import { describe, expect, it, vi } from "vitest";
import {
  SubtitlesEngine,
  MIN_REMAINING_AFTER_SEEK_MS,
  OFFSET_LIMIT_MS,
  type ActiveRow,
  type VideoLike,
} from "./subtitles-engine";
import type { Track } from "../types";

function fakeVideo(): VideoLike & { fire(type: string): void } {
  const listeners = new Map<string, Array<() => void>>();
  return {
    currentTime: 0,
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) ?? []).filter((l) => l !== listener));
    },
    fire(type) {
      for (const l of listeners.get(type) ?? []) l();
    },
  };
}

/** Видео с покадровым колбэком (docs/03 §4 п.1): runFrames(n) исполняет n
 * запланированных кадров (движок перепланирует следующий в каждом). */
function frameVideo(): VideoLike & {
  canceled: number;
  framesWaiting(): number;
  runFrames(count: number): void;
} {
  const listeners = new Map<string, Array<() => void>>();
  let scheduled: Array<() => void> = [];
  let canceled = 0;
  return {
    currentTime: 0,
    addEventListener(type: string, listener: () => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.set(type, (listeners.get(type) ?? []).filter((l) => l !== listener));
    },
    requestVideoFrameCallback(cb: () => void): number {
      scheduled.push(cb);
      return scheduled.length;
    },
    cancelVideoFrameCallback(): void {
      canceled += scheduled.length;
      scheduled = [];
    },
    get canceled() {
      return canceled;
    },
    framesWaiting: () => scheduled.length,
    runFrames(count: number): void {
      for (let i = 0; i < count && scheduled.length > 0; i++) {
        const cb = scheduled.shift()!;
        cb(); // движок тикает и перепланирует следующий кадр
      }
    },
  };
}

const track = (cues: Array<[number, number, string]>): Track => ({
  id: "test:ru",
  source: "test",
  lang: "ru",
  role: "original",
  cues: cues.map(([startMs, endMs, text]) => ({ startMs, endMs, text })),
});

/** Движок + запись всех эмитов строк (снимки по смене набора). */
function harness(cues: Array<[number, number, string]>) {
  const emits: ActiveRow[][] = [];
  const onRowsChange = vi.fn((rows: ActiveRow[]) => emits.push(rows));
  const engine = new SubtitlesEngine({ onRowsChange });
  engine.setTracks([track(cues)]);
  /** Текущие строки движка (устойчивее эмитов: пустой набор не переэмитится). */
  const shown = (): ActiveRow[] => engine.state().activeRows;
  return { engine, emits, onRowsChange, shown };
}

describe("SubtitlesEngine — выбор cue по времени", () => {
  it("cue появляется на timeupdate в середине реплики и гаснет после конца", () => {
    const { engine, emits } = harness([
      [1000, 3000, "Первая"],
      [4000, 6000, "Вторая"],
    ]);
    const video = fakeVideo();
    engine.attach(video);

    video.currentTime = 2.0;
    video.fire("timeupdate");
    expect(emits[emits.length - 1]).toEqual([{ trackId: "test:ru", text: "Первая" }]);

    video.currentTime = 3.5; // пауза между репликами
    video.fire("timeupdate");
    expect(emits[emits.length - 1]).toEqual([]);

    video.currentTime = 5.0;
    video.fire("timeupdate");
    expect(emits[emits.length - 1]).toEqual([{ trackId: "test:ru", text: "Вторая" }]);

    video.currentTime = 6.5;
    video.fire("timeupdate");
    expect(emits[emits.length - 1]).toEqual([]);
  });

  it("перерисовка только при смене набора строк (не на каждый кадр)", () => {
    const { engine, onRowsChange } = harness([[1000, 30000, "Длинная"]]);
    const video = fakeVideo();
    engine.attach(video);
    onRowsChange.mockClear();

    for (let t = 1.0; t <= 5.0; t += 0.25) {
      video.currentTime = t;
      video.fire("timeupdate");
    }
    // единственный эмит — активация реплики на t=1.0, дальше набор не менялся
    expect(onRowsChange).toHaveBeenCalledTimes(1);
  });

  it("строки набора идут в порядке дорожек (оригинал сверху)", () => {
    const first: Track = { id: "a:orig", source: "test", lang: "en", role: "original", cues: [{ startMs: 0, endMs: 5000, text: "orig" }] };
    const second: Track = { id: "a:ru", source: "test", lang: "ru", role: "translation", cues: [{ startMs: 0, endMs: 5000, text: "перевод" }] };
    const emits: ActiveRow[][] = [];
    const engine = new SubtitlesEngine({ onRowsChange: (rows) => emits.push(rows) });
    engine.setTracks([first, second]);
    const video = fakeVideo();
    engine.attach(video);
    video.currentTime = 2.0;
    video.fire("timeupdate");
    expect(emits[emits.length - 1]).toEqual([
      { trackId: "a:orig", text: "orig" },
      { trackId: "a:ru", text: "перевод" },
    ]);
  });
});

describe("SubtitlesEngine — seek (docs/03 §4: правило 150 мс)", () => {
  it("скачок в хвост реплики с остатком < 150 мс — cue не показывается", () => {
    const { engine, shown } = harness([[1000, 3000, "Первая"]]);
    const video = fakeVideo();
    engine.attach(video);

    video.currentTime = 3.0 - (MIN_REMAINING_AFTER_SEEK_MS - 40) / 1000; // остаток 110 мс
    video.fire("seeked");
    expect(shown()).toEqual([]);
  });

  it("скачок с остатком ≥ 150 мс — cue показывается", () => {
    const { engine, shown } = harness([[1000, 3000, "Первая"]]);
    const video = fakeVideo();
    engine.attach(video);

    video.currentTime = 2.8; // остаток 200 мс
    video.fire("seeked");
    expect(shown()).toEqual([{ trackId: "test:ru", text: "Первая" }]);
  });

  it("подавленный скачком cue не «вспыхивает» на остатке при продолжении показа", () => {
    const { engine, shown } = harness([[1000, 3000, "Первая"], [4000, 6000, "Вторая"]]);
    const video = fakeVideo();
    engine.attach(video);

    video.currentTime = 2.9; // остаток 100 мс — подавлен
    video.fire("seeked");
    expect(shown()).toEqual([]);

    video.currentTime = 2.95; // продолжение: до конца 50 мс — не вспыхивает
    video.fire("timeupdate");
    expect(shown()).toEqual([]);

    video.currentTime = 2.99; // всё ещё та же реплика в последних мс
    video.fire("timeupdate");
    expect(shown()).toEqual([]);

    video.currentTime = 5.0; // следующая реплика — показывается
    video.fire("timeupdate");
    expect(shown()).toEqual([{ trackId: "test:ru", text: "Вторая" }]);
  });

  it("программный скачок без seeked распознаётся по |Δt| > 250 мс", () => {
    const { engine, shown } = harness([[1000, 3000, "Первая"], [10000, 13000, "Дальняя"]]);
    const video = fakeVideo();
    engine.attach(video);

    video.currentTime = 2.5;
    video.fire("timeupdate");
    expect(shown()).toEqual([{ trackId: "test:ru", text: "Первая" }]);

    // Реплика [1000,3000] «осталась» в прошлом при t=12 — активна «Дальняя»;
    // назад по таймлайну призраков нет:
    video.currentTime = 2.95; // Δ ≈ 9.5 c назад, остаток 50 мс — подавлена
    video.fire("timeupdate");
    expect(shown()).toEqual([]);
  });

  it("скачок назад по таймлайну не оставляет призраков предыдущего cue", () => {
    const { engine, shown } = harness([[1000, 3000, "A"], [12000, 15000, "D"]]);
    const video = fakeVideo();
    engine.attach(video);

    video.currentTime = 13.0;
    video.fire("seeked");
    expect(shown()).toEqual([{ trackId: "test:ru", text: "D" }]);

    video.currentTime = 2.0;
    video.fire("seeked");
    expect(shown()).toEqual([{ trackId: "test:ru", text: "A" }]);
  });
});

describe("SubtitlesEngine — offset (docs/03 §4: применяется к набору)", () => {
  it("положительный offset показывает субтитры позже", () => {
    const { engine, shown } = harness([[1000, 3000, "Первая"]]);
    const video = fakeVideo();
    engine.attach(video);

    engine.setOffset(500);
    video.currentTime = 1.4; // без сдвига реплика уже идёт (1400 > 1000)
    video.fire("timeupdate");
    expect(shown()).toEqual([]); // со сдвигом +500 начало на 1500 — ещё рано

    video.currentTime = 1.6;
    video.fire("timeupdate");
    expect(shown()).toEqual([{ trackId: "test:ru", text: "Первая" }]);
  });

  it("отрицательный offset показывает субтитры раньше", () => {
    const { engine, emits } = harness([[2000, 4000, "Реплика"]]);
    const video = fakeVideo();
    engine.attach(video);

    engine.setOffset(-1000);
    video.currentTime = 1.2; // реплика начнётся на 2000-1000=1000 — уже идёт
    video.fire("timeupdate");
    expect(emits[emits.length - 1]).toEqual([{ trackId: "test:ru", text: "Реплика" }]);
  });

  it("offset зажимается пределом ±10 c", () => {
    const { engine } = harness([[0, 1000, "x"]]);
    engine.setOffset(999_999);
    expect(engine.getOffset()).toBe(OFFSET_LIMIT_MS);
    engine.setOffset(-999_999);
    expect(engine.getOffset()).toBe(-OFFSET_LIMIT_MS);
  });

  it("смена offset мгновенно пересчитывает строку (без ожидания timeupdate)", () => {
    const { engine, shown } = harness([[1000, 3000, "Первая"]]);
    const video = fakeVideo();
    engine.attach(video);

    video.currentTime = 1.2;
    video.fire("timeupdate");
    expect(shown()).toEqual([{ trackId: "test:ru", text: "Первая" }]);

    engine.setOffset(2000); // теперь эффективное время -0.8 с — реплика ещё не началась
    expect(shown()).toEqual([]);
  });
});

describe("SubtitlesEngine — покадровая точность rVFC (задача 3.5, docs/03 §4 п.1)", () => {
  it("кадры видео тикают движком: cue появляется по rVFC без timeupdate", () => {
    const { engine, shown } = harness([[1000, 3000, "Первая"]]);
    const video = frameVideo();
    engine.attach(video);

    video.currentTime = 2.0;
    video.runFrames(1); // кадр отрисован — timeupdate не приходит
    expect(shown()).toEqual([{ trackId: "test:ru", text: "Первая" }]);

    video.currentTime = 3.5;
    video.runFrames(1);
    expect(shown()).toEqual([]);
  });

  it("перерисовка только при смене набора: поток кадров не спамит эмитами", () => {
    const { engine, onRowsChange } = harness([[1000, 30000, "Длинная"]]);
    const video = frameVideo();
    engine.attach(video);
    onRowsChange.mockClear();

    for (let t = 1.0; t <= 3.0; t += 0.1) {
      video.currentTime = t;
      video.runFrames(1);
    }
    expect(onRowsChange).toHaveBeenCalledTimes(1); // только активация реплики
  });

  it("detach останавливает кадровой цикл: кадры прошлого видео не тикают", () => {
    const { engine, shown } = harness([[1000, 30000, "Длинная"]]);
    const video = frameVideo();
    engine.attach(video);
    video.currentTime = 2.0;
    video.runFrames(1);
    expect(shown()).toEqual([{ trackId: "test:ru", text: "Длинная" }]);

    engine.detach();
    expect(video.canceled).toBe(1); // ожидающий кадр снят с планирования
    const waiting = video.framesWaiting();
    video.currentTime = 4.0;
    video.runFrames(10);
    expect(video.framesWaiting()).toBe(waiting);
    expect(shown()).toEqual([]);
  });

  it("резкий seek между кадрами распознаётся по |Δt| > 250 мс — призраков нет", () => {
    const { engine, shown } = harness([[1000, 3000, "A"], [12000, 15000, "D"]]);
    const video = frameVideo();
    engine.attach(video);

    video.currentTime = 13.0;
    video.runFrames(1);
    expect(shown()).toEqual([{ trackId: "test:ru", text: "D" }]);

    video.currentTime = 2.9; // Δ ≈ 10 с назад, остаток cue A — 100 мс < 150
    video.runFrames(1);
    expect(shown()).toEqual([]); // подавлено правилом 150 мс, без вспышки
  });

  it("state().frameCallback — есть ли покадровая подписка (диагностика)", () => {
    const { engine } = harness([[0, 1000, "x"]]);
    expect(engine.state().frameCallback).toBe(false); // видео ещё не привязано
    const video = frameVideo();
    engine.attach(video);
    expect(engine.state().frameCallback).toBe(true);
    engine.detach();
    expect(engine.state().frameCallback).toBe(false);
  });
});

describe("SubtitlesEngine — привязка видео", () => {
  it("detach гасит показ и снимает подписки", () => {
    const { engine, shown } = harness([[1000, 30000, "Длинная"]]);
    const video = fakeVideo();
    engine.attach(video);
    video.currentTime = 2.0;
    video.fire("timeupdate");
    expect(shown()).toEqual([{ trackId: "test:ru", text: "Длинная" }]);

    engine.detach();
    expect(shown()).toEqual([]);
    video.currentTime = 3.0;
    video.fire("timeupdate");
    expect(shown()).toEqual([]); // подписки сняты — новых эмитов нет
  });

  it("повторная attach к тому же видео не дублирует подписки", () => {
    const { engine, onRowsChange } = harness([[1000, 30000, "Длинная"]]);
    const video = fakeVideo();
    engine.attach(video);
    engine.attach(video);
    onRowsChange.mockClear();
    video.currentTime = 2.0;
    video.fire("timeupdate");
    expect(onRowsChange).toHaveBeenCalledTimes(1); // не два эмита
  });

  it("state() отражает набор, offset и привязку (диагностика стендов)", () => {
    const { engine } = harness([[1000, 3000, "x"]]);
    const video = fakeVideo();
    engine.attach(video);
    video.currentTime = 2.0;
    video.fire("timeupdate");
    const s = engine.state();
    expect(s.attached).toBe(true);
    expect(s.trackCount).toBe(1);
    expect(s.offsetMs).toBe(0);
    expect(s.activeRows).toEqual([{ trackId: "test:ru", text: "x" }]);
  });
});
