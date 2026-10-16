// Таймлайн cue (задача 3.2): смёрженные цепочки перекрытий + бинарный поиск
// активного cue (docs/03 §4: «cue-таблицы предагрегированы: пересекающиеся
// интервалы смёржены»). Границы — полуинтервалы [start, end).
import { describe, expect, it } from "vitest";
import { CueTimeline } from "./timeline";
import type { Cue } from "../types";

const cue = (startMs: number, endMs: number, text: string): Cue => ({ startMs, endMs, text });

describe("CueTimeline.build — предагрегация", () => {
  it("сортирует вход по startMs (устойчиво)", () => {
    const tl = CueTimeline.build([cue(2000, 3000, "b"), cue(1000, 1500, "a"), cue(1500, 1800, "c")]);
    expect(tl.size).toBe(3);
    expect(tl.activeAt(1200)?.text).toBe("a");
    expect(tl.activeAt(2200)?.text).toBe("b");
  });

  it("смёрживает цепочку перекрытий в один cue с текстами через \\n", () => {
    const tl = CueTimeline.build([cue(6000, 8000, "первая"), cue(7000, 9500, "вторая")]);
    expect(tl.size).toBe(1);
    const active = tl.activeAt(7500);
    expect(active?.startMs).toBe(6000);
    expect(active?.endMs).toBe(9500);
    expect(active?.text).toBe("первая\nвторая");
  });

  it("вложенный cue продлевает конец, не ломая порядок", () => {
    const tl = CueTimeline.build([cue(1000, 5000, "обёртка"), cue(2000, 3000, "внутри")]);
    expect(tl.size).toBe(1);
    expect(tl.activeAt(4500)?.text).toBe("обёртка\nвнутри");
    expect(tl.activeAt(5500)).toBeNull();
  });

  it("смежные cue (конец == начало следующего) НЕ сливаются", () => {
    const tl = CueTimeline.build([cue(1000, 3000, "a"), cue(3000, 5000, "b")]);
    expect(tl.size).toBe(2);
    expect(tl.activeAt(2999)?.text).toBe("a");
    expect(tl.activeAt(3000)?.text).toBe("b");
  });

  it("отбрасывает вырожденные cue (конец ≤ начало)", () => {
    const tl = CueTimeline.build([cue(1000, 1000, "точка"), cue(2000, 1000, "инверт"), cue(100, 900, "ок")]);
    expect(tl.size).toBe(1);
    expect(tl.activeAt(500)?.text).toBe("ок");
  });

  it("не мутирует входный массив", () => {
    const input = [cue(2000, 3000, "b"), cue(1000, 2000, "a")];
    CueTimeline.build(input);
    expect(input[0].startMs).toBe(2000);
  });
});

describe("CueTimeline.activeAt — бинарный поиск", () => {
  const tl = CueTimeline.build([cue(1000, 3000, "A"), cue(3500, 5000, "B"), cue(12000, 15000, "D")]);

  it("начало включается, конец — нет (полуинтервалы)", () => {
    expect(tl.activeAt(999)).toBeNull();
    expect(tl.activeAt(1000)?.text).toBe("A");
    expect(tl.activeAt(2999)?.text).toBe("A");
    expect(tl.activeAt(3000)).toBeNull();
  });

  it("пауза между cue и за пределами таймлайна", () => {
    expect(tl.activeAt(3200)).toBeNull();
    expect(tl.activeAt(4999)?.text).toBe("B");
    expect(tl.activeAt(0)).toBeNull();
    expect(tl.activeAt(999999)).toBeNull();
  });

  it("отрицательное время (offset больше currentTime) — до таймлайна", () => {
    expect(tl.activeAt(-500)).toBeNull();
  });

  it("находит cue в середине большого таймлайна (логарифма хватает)", () => {
    const cues: Cue[] = [];
    for (let i = 0; i < 5000; i++) cues.push(cue(i * 2000, i * 2000 + 1800, `cue-${i}`));
    const big = CueTimeline.build(cues);
    expect(big.size).toBe(5000);
    expect(big.activeAt(4_321_000)?.text).toBe("cue-2160"); // [4320000, 4321800)
    expect(big.activeAt(4_321_900)).toBeNull(); // пауза cue-2160..cue-2161
  });
});
