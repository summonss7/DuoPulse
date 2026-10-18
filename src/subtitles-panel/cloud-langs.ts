// Языки облачного перевода для панели «duo» (задача 4.2, docs/03 §7–8):
// чистые функции без DOM — юнит-тесты. Провайдеры понимают эти коды
// (DeepL/Google/LibreTranslate пересекаются по базовым парам); панель
// предлагает языки, которых нет среди бесплатных переводов платформы
// (tlang) и которых ещё нет в наборе.

export interface CloudLangOption {
  code: string;
  name: string;
}

/** Предлагаемые целевые языки (общее подмножество пар DeepL/Google/Libre). */
export const CLOUD_LANGS: readonly CloudLangOption[] = [
  { code: "ru", name: "Русский" },
  { code: "en", name: "English" },
  { code: "uk", name: "Українська" },
  { code: "es", name: "Español" },
  { code: "de", name: "Deutsch" },
  { code: "fr", name: "Français" },
  { code: "it", name: "Italiano" },
  { code: "pt", name: "Português" },
  { code: "pl", name: "Polski" },
  { code: "tr", name: "Türkçe" },
  { code: "ja", name: "日本語" },
  { code: "zh", name: "中文" },
  { code: "ko", name: "한국어" },
  { code: "ar", name: "العربية" },
];

/** Языки набора/переводов платформы к нижнему регистру и без подтегов
 * («PT-BR» → «pt») — сравнение с кодами облака. */
export function baseLang(lang: string): string {
  const lowered = lang.trim().toLowerCase();
  return lowered.split("-")[0] ?? "";
}

/** Языки для селекта «+ перевод в…»: исключены переводы платформы (бесплатный
 * tlang приоритетнее облака, docs/03 §7) и языки, уже стоящие в наборе.
 * hasSource=false — переводить нечего (в наборе нет строки-источника). */
export function cloudLangOptions(
  platformTranslations: readonly { lang: string }[],
  setLangs: readonly string[],
  hasSource: boolean,
): CloudLangOption[] {
  if (!hasSource) return [];
  const taken = new Set<string>();
  for (const t of platformTranslations) taken.add(baseLang(t.lang));
  for (const l of setLangs) taken.add(baseLang(l));
  return CLOUD_LANGS.filter((l) => !taken.has(l.code));
}

/** Строка статуса конвейера для панели (событие
 * subtitles:translate_progress): «Перевод… 12/40», итог и ошибки. */
export function translateProgressText(p: {
  phase: string;
  done: number;
  total: number;
  fromCache: boolean;
  provider: string;
  error?: string | null;
}): string {
  if (p.phase === "translating") return `Перевод (${p.provider})… ${p.done}/${p.total}`;
  if (p.phase === "done") return `Перевод готов${p.fromCache ? " (из кэша)" : ""}`;
  if (p.phase === "error") return `Перевод не удался: ${p.error || "ошибка"}`;
  return "";
}
