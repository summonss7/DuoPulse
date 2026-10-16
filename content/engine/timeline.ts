// Cue-таймлайн одной дорожки (задача 3.2, docs/03 §4): cue-таблицы
// предагрегированы — пересекающиеся интервалы смёржены, поэтому активный cue
// в любой момент один и ищется бинарным поиском по отсортированным началам.
//
// Смёрженные цепочки: перекрытие (next.start < cur.end) и вложенность склеиваются
// в один cue [first.start, max(end)] с текстами строк через \n — так перекрытия
// парсера (docs/03 §6 «перекрытия сохраняются — смёржит движок показа») показываются
// вместе, без мигания попеременных строк. Смежные cue ([1,3]+[3,5]) не сливаются:
// это обычная последовательность реплик, а не перекрытие.

import type { Cue } from "../types";

/** Отбрасывание вырожденного cue (конец ≤ начало): парсер такое не даёт
 * (diagnostics на его стороне, задача 3.1), здесь — защита движка. */
function isDegenerate(cue: Cue): boolean {
  return !(cue.endMs > cue.startMs);
}

export class CueTimeline {
  /** Отсортированы по startMs, перекрытия смёржены: next.start >= cur.end. */
  private readonly cues: Cue[];

  private constructor(cues: Cue[]) {
    this.cues = cues;
  }

  /** Предагрегация: сортировка по startMs (устойчивая) + смёрж перекрытий. */
  static build(input: Cue[]): CueTimeline {
    const sorted = [...input].filter((c) => !isDegenerate(c)).sort((a, b) => a.startMs - b.startMs);
    const merged: Cue[] = [];
    for (const cue of sorted) {
      const last = merged[merged.length - 1];
      if (last && cue.startMs < last.endMs) {
        // Перекрытие/вложение: продлеваем конец, тексты склеиваем.
        last.endMs = Math.max(last.endMs, cue.endMs);
        last.text = last.text ? `${last.text}\n${cue.text}` : cue.text;
      } else {
        merged.push({ ...cue });
      }
    }
    return new CueTimeline(merged);
  }

  get size(): number {
    return this.cues.length;
  }

  /** Активный cue в момент timeMs (полуинтервалы: конец не включён),
   * null — в паузе между репликами. Бинарный поиск: правый cue с началом ≤ t,
   * не-перекрытие гарантирует, что предыдущие уже закончились. */
  activeAt(timeMs: number): Cue | null {
    let lo = 0;
    let hi = this.cues.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.cues[mid].startMs <= timeMs) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (idx < 0) return null;
    const cue = this.cues[idx];
    return timeMs < cue.endMs ? cue : null;
  }
}
