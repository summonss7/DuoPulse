// Стиль плашки субтитров (задача 3.4): настройки + чистые функции для тестов.
// Фирменный вид — гайд 06 §6 (плашка-градиент, строки оригинал/перевод/
// приглушённые), поведение (позиция, колесо-размер 75–300% шаг 10) — docs/03 §5.
// Модель SubtitleStyle входит в SubtitlesState (docs/03 §6); панель настроек и
// персистентность (subtitles.set_style IPC) — задачи 3.5–3.7, здесь — дефолты,
// клампы и словарь стилей строк.
//
// Карточка duopulse-059: цвета строк (оригинал/перевод/третьи) и подложки,
// обводка вкл/выкл — настраиваются панелью «duo» (пресеты вида — в chrome-слое
// src/subtitles-panel/look-presets.ts, применяются патчем сюда), дефолты —
// настройки профиля (settings::content_defaults_script). Все цвета — hex
// #rrggbb (канонизация в clampColor: #RGB и uppercase допустимы на входе).

/** Настройки отображения субтитров (docs/03 §6: размер, позиция, прозрачность,
 * цвета строк и подложки, обводка — duopulse-059). */
export interface SubtitleStyle {
  /** Масштаб кегля, %: 75–300, шаг 10 (колесо мыши, docs/03 §5). */
  fontScalePct: number;
  /** Позиция плашки: низ (по умолчанию) или верх (docs/03 §5). */
  position: "bottom" | "top";
  /** Отступ от края видео, % его высоты (docs/03 §5 «отступ»). */
  marginPct: number;
  /** Непрозрачность подложки-градиента, 0–1 (гайд 06 §6: 0,78). */
  plateOpacity: number;
  /** Цвет строки оригинала, hex #rrggbb (гайд 06 §6: белый). */
  originalColor: string;
  /** Цвет строки перевода, hex #rrggbb (гайд 06 §6: фирменный лайм). */
  translationColor: string;
  /** Цвет третьей и далее строк, hex #rrggbb (прозрачность 0.75 — здесь же). */
  mutedColor: string;
  /** Цвет подложки-плашки, hex #rrggbb (база градиента, гайд 06 §6). */
  plateColor: string;
  /** Тёмная обводка строк для читаемости на светлом видео (гайд 06 §6). */
  textStroke: boolean;
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  fontScalePct: 100,
  position: "bottom",
  marginPct: 6,
  plateOpacity: 0.78,
  originalColor: "#ffffff",
  translationColor: "#bdfe4f",
  mutedColor: "#ffffff",
  plateColor: "#0a0e17",
  textStroke: true,
};

export const SCALE_MIN_PCT = 75;
export const SCALE_MAX_PCT = 300;
export const SCALE_STEP_PCT = 10;
export const MARGIN_MAX_PCT = 25;

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

/** Число из патча (NaN/строки/прочий мусор тест-хука и IPC — не число). */
const numOf = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/** Цвет из патча: #RGB/#RRGGBB → канонический #rrggbb; прочий мусор —
 * fallback (тест-хук/IPC/старые settings.json без новых полей). */
export function clampColor(v: unknown, fallback: string): string {
  if (typeof v !== "string") return fallback;
  const s = v.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) {
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  }
  return fallback;
}

/** hex #rrggbb → rgba(...): прозрачность строк-«приглушённых» и градиента. */
export function hexToRgba(hex: string, alpha: number): string {
  const h = clampColor(hex, "#000000");
  const r = parseInt(h.slice(1, 3), 16);
  const g = parseInt(h.slice(3, 5), 16);
  const b = parseInt(h.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${clamp(alpha, 0, 1).toFixed(3)})`;
}

/** Применить патч настроек с клампами (чужие типы и поля игнорируются). */
export function mergeStyle(base: SubtitleStyle, patch: Partial<SubtitleStyle>): SubtitleStyle {
  return {
    fontScalePct: clamp(Math.round(numOf(patch.fontScalePct, base.fontScalePct)), SCALE_MIN_PCT, SCALE_MAX_PCT),
    position: patch.position === "top" || patch.position === "bottom" ? patch.position : base.position,
    marginPct: clamp(Math.round(numOf(patch.marginPct, base.marginPct)), 0, MARGIN_MAX_PCT),
    plateOpacity: clamp(numOf(patch.plateOpacity, base.plateOpacity), 0.2, 1),
    originalColor: clampColor(patch.originalColor, base.originalColor),
    translationColor: clampColor(patch.translationColor, base.translationColor),
    mutedColor: clampColor(patch.mutedColor, base.mutedColor),
    plateColor: clampColor(patch.plateColor, base.plateColor),
    textStroke: typeof patch.textStroke === "boolean" ? patch.textStroke : base.textStroke,
  };
}

/** Шаг масштаба колесом: direction > 0 — крупнее; границы 75–300 (docs/03 §5). */
export function stepScale(currentPct: number, direction: number): number {
  const stepped = Math.round((currentPct + (direction > 0 ? SCALE_STEP_PCT : -SCALE_STEP_PCT)) / SCALE_STEP_PCT) * SCALE_STEP_PCT;
  return clamp(stepped, SCALE_MIN_PCT, SCALE_MAX_PCT);
}

/** Потолок плашки — доля высоты видео (карточка 046, docs/03 §5): при
 * превышении кегль строк плавно уменьшается (перенос длинных cue остаётся). */
export const PLATE_MAX_SHARE = 0.5;

/** Шаг авто-подгона кегля под потолок плашки (карточка 046): текущий кегль
 * pct даёт высоту plateH при потолке maxH — вернуть кегль в пропорции
 * maxH/plateH. Геометрия плашки em-линейна (паддинг 16px — малая нелинейность),
 * поэтому итерации с замером сходятся за 2–3 шага; ниже клампа читаемости 75%
 * не идём — лучше выйти за долю, чем потерять читаемость. Без переполнения
 * кегль не меняется; некорректная геометрия (≤0) — тоже. */
export function fitStepPct(plateH: number, maxH: number, pct: number): number {
  if (!(plateH > 0) || !(maxH > 0) || plateH <= maxH) return pct;
  return clamp((pct * maxH) / plateH, SCALE_MIN_PCT, SCALE_MAX_PCT);
}

/** Стиль строки набора по её номеру (гайд 06 §6): оригинал — 100% кегля и
 * вес 500, перевод — 85%/400, третья и далее — 75% кегля с прозрачностью 75%.
 * Цвета — из настроек стиля (карточка 059); веса/кегли фиксированы. */
export interface RowStyle {
  color: string;
  fontScale: number;
  weight: number;
}

export function rowStyleFor(index: number, style: Pick<SubtitleStyle,
  "originalColor" | "translationColor" | "mutedColor">): RowStyle {
  if (index <= 0) return { color: clampColor(style.originalColor, "#ffffff"), fontScale: 1, weight: 500 };
  if (index === 1) return { color: clampColor(style.translationColor, "#bdfe4f"), fontScale: 0.85, weight: 400 };
  return { color: hexToRgba(clampColor(style.mutedColor, "#ffffff"), 0.75), fontScale: 0.75, weight: 400 };
}

/** Подложка-плашка: полупрозрачный градиент цвета подложки → прозрачный по
 * вертикали (гайд 06 §6, два стопа сверху вниз; база — настраиваемая, 059). */
export function plateBackground(opacity: number, plateColor: string): string {
  return `linear-gradient(${hexToRgba(plateColor, opacity)}, ${hexToRgba(plateColor, 0)})`;
}

/** Базовый кегль плашки: от ширины видео (container query units — плашка
 * масштабируется вместе с плеером) × эффективный масштаб (ручной колесо/
 * панель, при переполнении — авто-уменьшенный, карточка 046; docs/03 §5:
 * относительные размеры строк сохраняются, кегль общий). */
export function plateFontSizeCss(fontScalePct: number): string {
  const scale = (clamp(fontScalePct, SCALE_MIN_PCT, SCALE_MAX_PCT) / 100).toFixed(2);
  return `calc(clamp(14px, 2.6cqw, 34px) * ${scale})`;
}
