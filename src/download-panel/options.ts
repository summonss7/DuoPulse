// DuoPulse — чистые помощники панели загрузки (карточка duopulse-118):
// разбор «мм:сс» диапазона, подписи качеств/форматов и сбор списка языков
// субтитров из снапшота Core (BaseTrackInfo/TranslationLangInfo).

import type { BaseTrackInfo, TranslationLangInfo } from "../bridge/gen/types";

/** «1:23» → 83; «1:23:45» → 5025; «12» → 12; мусор/отрицательное — null. */
export function parseTimeInput(value: string): number | null {
  const v = value.trim();
  if (!v || !/^\d{1,3}(:\d{1,2}){0,2}$/.test(v)) return null;
  // выравнивание справа: последний компонент — секунды, затем минуты, часы
  const nums = v.split(":").map((p) => Number(p));
  const s = nums.pop() ?? 0;
  const m = nums.pop() ?? 0;
  const h = nums.pop() ?? 0;
  if (s > 59 || m > 59) return null;
  const total = h * 3600 + m * 60 + s;
  return total > 0 ? total : null;
}

/** Секунды → «1:02:03» / «2:05» (для подписей). */
export function fmtSec(sec: number): string {
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

/** Валиден ли диапазон: старт обязателен, конец — либо пуст, либо позже старта. */
export function rangeValid(start: string, end: string): boolean {
  const s = parseTimeInput(start);
  if (s === null) return false;
  if (!end.trim()) return true;
  const e = parseTimeInput(end);
  return e !== null && e > s;
}

export const QUALITY_OPTIONS: { value: string; label: string }[] = [
  { value: "best", label: "лучшее" },
  { value: "1080", label: "1080p" },
  { value: "720", label: "720p" },
  { value: "480", label: "480p" },
  { value: "360", label: "360p" },
];

export const AUDIO_FORMAT_OPTIONS: { value: "m4a" | "mp3"; label: string }[] = [
  { value: "m4a", label: "m4a (без перекодировки)" },
  { value: "mp3", label: "mp3 (конвертация)" },
];

/** Опция выбора языка субтитров: value — trackId для download.begin. */
export interface SubsLangOption {
  value: string;
  label: string;
}

/** Список языков для выгрузки: базовые дорожки + машинные переводы.
 * Формы value — как у выбора набора: «yt:en» (база), «yt:en+ru» (перевод
 * базы), «ru» (перевод базы по умолчанию). */
export function subsLangOptions(
  base: BaseTrackInfo[],
  translations: TranslationLangInfo[],
): SubsLangOption[] {
  const out: SubsLangOption[] = base.map((b) => ({
    value: b.id,
    label: `${b.name}${b.kind === "asr" ? " (авто)" : ""}${b.original ? " •" : ""}`,
  }));
  for (const t of translations) {
    out.push({ value: t.lang, label: `${t.name} (перевод)` });
  }
  return out;
}

/** Подпись фазы задания для панели. */
export function phaseLabel(phase: string): string {
  switch (phase) {
    case "prepare":
      return "подготовка";
    case "tools":
      return "докачка инструментов (один раз)";
    case "download":
      return "загрузка";
    case "convert":
      return "обработка (ffmpeg)";
    case "subs":
      return "получение дорожки";
    case "done":
      return "готово";
    case "canceled":
      return "отменено";
    case "error":
      return "ошибка";
    default:
      return phase;
  }
}

/** Подпись режима. */
export function modeLabel(mode: string): string {
  switch (mode) {
    case "video":
      return "видео";
    case "audio":
      return "музыка";
    case "subs":
      return "субтитры";
    default:
      return mode;
  }
}
