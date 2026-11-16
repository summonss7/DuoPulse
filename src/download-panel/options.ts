// DuoPulse — чистые помощники панели загрузки (карточка duopulse-118):
// разбор «мм:сс» диапазона, подписи качеств/форматов и сбор списка языков
// субтитров из снапшота Core (BaseTrackInfo/TranslationLangInfo).
// Видимые строки — через t() (i18n, карточка duopulse-137): в ru t() возвращает
// исходник, тесты на ru-тексты не меняются.
import { t } from "../i18n";
import type { BaseTrackInfo, FileDlInfo, TranslationLangInfo } from "../bridge/gen/types";

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
  { value: "best", label: t("лучшее") },
  { value: "1080", label: "1080p" },
  { value: "720", label: "720p" },
  { value: "480", label: "480p" },
  { value: "360", label: "360p" },
];

export const AUDIO_FORMAT_OPTIONS: { value: "m4a" | "mp3"; label: string }[] = [
  { value: "m4a", label: t("m4a (без перекодировки)") },
  { value: "mp3", label: t("mp3 (конвертация)") },
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
    label: `${b.name}${b.kind === "asr" ? t(" (авто)") : ""}${b.original ? " •" : ""}`,
  }));
  for (const tr of translations) {
    out.push({ value: tr.lang, label: `${tr.name}${t(" (перевод)")}` });
  }
  return out;
}

/** Подпись фазы задания для панели. */
export function phaseLabel(phase: string): string {
  switch (phase) {
    case "prepare":
      return t("подготовка");
    case "tools":
      return t("докачка инструментов (один раз)");
    case "download":
      return t("загрузка");
    case "convert":
      return t("обработка (ffmpeg)");
    case "subs":
      return t("получение дорожки");
    case "done":
      return t("готово");
    case "canceled":
      return t("отменено");
    case "error":
      return t("ошибка");
    default:
      return phase;
  }
}

/** Подпись режима. */
export function modeLabel(mode: string): string {
  switch (mode) {
    case "video":
      return t("видео");
    case "audio":
      return t("музыка");
    case "subs":
      return t("субтитры");
    default:
      return mode;
  }
}

/** Байты → «843 КБ» / «12.4 МБ» / «2.5 ГБ» (карточка duopulse-158):
 *  десятые — до сотни единиц, дальше — целое. */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return `0 ${t("Б")}`;
  if (n < 1024) return `${Math.round(n)} ${t("Б")}`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 100 ? 1 : 0)} ${t("КБ")}`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 100 ? 1 : 0)} ${t("МБ")}`;
  return `${(mb / 1024).toFixed(2)} ${t("ГБ")}`;
}

/** Скорость байт/с → «1,2 МБ/с» (0 — пустая строка). */
export function fmtSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "";
  return `${fmtBytes(bytesPerSec)}/${t("с")}`;
}

/** Строка статуса файловой загрузки для секции «Файлы» (duopulse-158):
 *  активная — «12,4 МБ · 1,2 МБ/с», итог — «готово · путь» / причина. */
export function fileDlStatusText(f: FileDlInfo): string {
  if (f.state === "active") {
    const bits = [t("скачивается"), fmtBytes(f.received)];
    const speed = fmtSpeed(f.speed);
    if (speed) bits.push(speed);
    return bits.join(" · ");
  }
  if (f.state === "done") return t("готово");
  return f.error ?? t("ошибка");
}
