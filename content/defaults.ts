// Дефолты субтитров из настроек профиля (задача 5.1): Core кладёт их в
// window.__DUOPULSE_DEFAULTS__ initialization-скриптом ДО бандла субтитров
// (каждая вкладка — свежие значения на момент создания). Здесь — единое
// чтение с снисходительным разбором: настройки могут отсутствовать (старый
// бинарник, тесты) — работают прежние дефолты set-defaults/style.
import { DEFAULT_SUBTITLE_STYLE, mergeStyle, type SubtitleStyle } from "./overlay/style";
import { PREFERRED_TRANSLATION_LANGS } from "./set-defaults";

/** Форма window.__DUOPULSE_DEFAULTS__ (JSON из Core, content_defaults_script). */
interface DuoPulseDefaults {
  subtitles?: {
    defaultTranslationLang?: unknown;
    style?: unknown;
  };
}

/** Объект, содержащий дефолты (сам window в бандле, заглушки в тестах). */
export type DefaultsHolder = { __DUOPULSE_DEFAULTS__?: unknown };

/** Прочитать сырой объект дефолтов (отсутствует/битый — undefined). */
function rawDefaults(holder: DefaultsHolder = window as unknown as DefaultsHolder): DuoPulseDefaults | undefined {
  const value = holder.__DUOPULSE_DEFAULTS__;
  return typeof value === "object" && value !== null ? (value as DuoPulseDefaults) : undefined;
}

/** Языковой код (2–3 буквы + необязательный подтег — как is_lang_code Core). */
function isLangCode(lang: string): boolean {
  const parts = lang.split("-");
  const primary = parts[0] ?? "";
  const sub = parts[1] ?? "";
  const primaryOk =
    primary.length >= 2 && primary.length <= 3 && /^[a-z]+$/.test(primary);
  const subOk =
    sub === "" || (sub.length >= 2 && sub.length <= 8 && /^[a-z0-9]+$/i.test(sub));
  return primaryOk && subOk;
}

/** Предпочитаемые языки перевода дефолт-набора Alt+D: язык из настроек —
 *  первым, затем прежний порядок (fallback, если настроенного нет в списке
 *  переводов платформы). */
export function preferredLangs(holder: DefaultsHolder = window as unknown as DefaultsHolder): readonly string[] {
  const lang = rawDefaults(holder)?.subtitles?.defaultTranslationLang;
  if (typeof lang === "string") {
    const code = lang.trim().toLowerCase();
    if (isLangCode(code)) return [code, ...PREFERRED_TRANSLATION_LANGS];
  }
  return PREFERRED_TRANSLATION_LANGS;
}

/** Базовый стиль плашки новых вкладок: дефолты content-слоя + патч настроек
 *  (клампы mergeStyle отсекают мусорные значения). */
export function baseStyle(holder: DefaultsHolder = window as unknown as DefaultsHolder): SubtitleStyle {
  const style = rawDefaults(holder)?.subtitles?.style;
  if (style !== undefined) {
    return mergeStyle(DEFAULT_SUBTITLE_STYLE, style as Partial<SubtitleStyle>);
  }
  return { ...DEFAULT_SUBTITLE_STYLE };
}
