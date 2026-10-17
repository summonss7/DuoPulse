// Стиль плашки субтитров (задача 3.4): настройки + чистые функции для тестов.
// Фирменный вид — гайд 06 §6 (плашка-градиент, строки оригинал/перевод/
// приглушённые), поведение (позиция, колесо-размер 75–300% шаг 10) — docs/03 §5.
// Модель SubtitleStyle входит в SubtitlesState (docs/03 §6); панель настроек и
// персистентность (subtitles.set_style IPC) — задачи 3.5–3.7, здесь — дефолты,
// клампы и словарь стилей строк.

/** Настройки отображения субтитров (docs/03 §6: размер, позиция, прозрачность). */
export interface SubtitleStyle {
  /** Масштаб кегля, %: 75–300, шаг 10 (колесо мыши, docs/03 §5). */
  fontScalePct: number;
  /** Позиция плашки: низ (по умолчанию) или верх (docs/03 §5). */
  position: "bottom" | "top";
  /** Отступ от края видео, % его высоты (docs/03 §5 «отступ»). */
  marginPct: number;
  /** Непрозрачность подложки-градиента, 0–1 (гайд 06 §6: 0,78). */
  plateOpacity: number;
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  fontScalePct: 100,
  position: "bottom",
  marginPct: 6,
  plateOpacity: 0.78,
};

export const SCALE_MIN_PCT = 75;
export const SCALE_MAX_PCT = 300;
export const SCALE_STEP_PCT = 10;
export const MARGIN_MAX_PCT = 25;

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

/** Число из патча (NaN/строки/прочий мусор тест-хука и IPC — не число). */
const numOf = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/** Применить патч настроек с клампами (чужие типы и поля игнорируются). */
export function mergeStyle(base: SubtitleStyle, patch: Partial<SubtitleStyle>): SubtitleStyle {
  return {
    fontScalePct: clamp(Math.round(numOf(patch.fontScalePct, base.fontScalePct)), SCALE_MIN_PCT, SCALE_MAX_PCT),
    position: patch.position === "top" || patch.position === "bottom" ? patch.position : base.position,
    marginPct: clamp(Math.round(numOf(patch.marginPct, base.marginPct)), 0, MARGIN_MAX_PCT),
    plateOpacity: clamp(numOf(patch.plateOpacity, base.plateOpacity), 0.2, 1),
  };
}

/** Шаг масштаба колесом: direction > 0 — крупнее; границы 75–300 (docs/03 §5). */
export function stepScale(currentPct: number, direction: number): number {
  const stepped = Math.round((currentPct + (direction > 0 ? SCALE_STEP_PCT : -SCALE_STEP_PCT)) / SCALE_STEP_PCT) * SCALE_STEP_PCT;
  return clamp(stepped, SCALE_MIN_PCT, SCALE_MAX_PCT);
}

/** Стиль строки набора по её номеру (гайд 06 §6): оригинал — белый 500 и
 * 100% кегля, перевод — фирменный лайм 85%/400, третья и далее — приглушённые
 * белые 75% кегля с прозрачностью 75%. */
export interface RowStyle {
  color: string;
  fontScale: number;
  weight: number;
}

const ROW_ORIGINAL: RowStyle = { color: "#FFFFFF", fontScale: 1, weight: 500 };
const ROW_TRANSLATION: RowStyle = { color: "#BDFE4F", fontScale: 0.85, weight: 400 };
const ROW_MUTED: RowStyle = { color: "rgba(255,255,255,0.75)", fontScale: 0.75, weight: 400 };

export function rowStyleFor(index: number): RowStyle {
  if (index <= 0) return ROW_ORIGINAL;
  if (index === 1) return ROW_TRANSLATION;
  return ROW_MUTED;
}

/** Подложка-плашка: полупрозрачный градиент в фирменный сине-чёрный →
 * прозрачный по вертикали (гайд 06 §6, два стопа сверху вниз). */
export function plateBackground(opacity: number): string {
  const a = clamp(opacity, 0, 1).toFixed(3);
  return `linear-gradient(rgba(10,14,23,${a}), rgba(10,14,23,0))`;
}

/** Базовый кегль плашки: от ширины видео (container query units — плашка
 * масштабируется вместе с плеером) × масштаб пользователя (docs/03 §5:
 * относительные размеры строк сохраняются, кегль общий). */
export function plateFontSizeCss(fontScalePct: number): string {
  const scale = (clamp(fontScalePct, SCALE_MIN_PCT, SCALE_MAX_PCT) / 100).toFixed(2);
  return `calc(clamp(14px, 2.6cqw, 34px) * ${scale})`;
}
