// Языки облачного перевода для панели «duo» (задача 4.2, docs/03 §7–8):
// чистые функции без DOM — юнит-тесты. Провайдеры понимают эти коды
// (DeepL/Google/LibreTranslate пересекаются по базовым парам); панель
// предлагает языки, которых нет среди бесплатных переводов платформы
// (tlang) и которых ещё нет в наборе.

export interface CloudLangOption {
  code: string;
  name: string;
}

/** Приоритетные языки хозяина (карточка duopulse-094): первыми во всех
 * списках языков субтитров — английский, румынский, русский, арабский,
 * далее остальные. Сравнение — по базовому коду (baseLang: «EN-US» → en). */
export const PRIORITY_LANG_ORDER: readonly string[] = ["en", "ro", "ru", "ar"];

/** Предлагаемые целевые языки (общее подмножество пар DeepL/Google/Libre);
 * ro добавлен по карточке duopulse-094 (DeepL/Google понимают, Libre —
 * зависит от инстанса), порядок — приоритетные языки первыми. */
export const CLOUD_LANGS: readonly CloudLangOption[] = [
  { code: "en", name: "English" },
  { code: "ro", name: "Română" },
  { code: "ru", name: "Русский" },
  { code: "ar", name: "العربية" },
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
];

/** Языки набора/переводов платформы к нижнему регистру и без подтегов
 * («PT-BR» → «pt») — сравнение с кодами облака. */
export function baseLang(lang: string): string {
  const lowered = lang.trim().toLowerCase();
  return lowered.split("-")[0] ?? "";
}

/** Приоритет языка в списке настроек (карточка duopulse-094): 0..n — позиция
 * в PRIORITY_LANG_ORDER, прочие — после приоритетных; применяется stable-сортом,
 * относительный порядок прочих не меняется. */
export function langPriority(lang: string): number {
  const i = PRIORITY_LANG_ORDER.indexOf(baseLang(lang));
  return i === -1 ? PRIORITY_LANG_ORDER.length : i;
}

/** Список языков с приоритетными первыми (stable): en→ro→ru→ar, затем как было. */
export function withPriorityLangsFirst<T>(items: readonly T[], langOf: (item: T) => string): T[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => {
      const d = langPriority(langOf(a.item)) - langPriority(langOf(b.item));
      return d !== 0 ? d : a.i - b.i;
    })
    .map((x) => x.item);
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

/** Текст бейджа «перевод недоступен» (событие subtitles:translate_unavailable,
 * задача 4.3, docs/01 §5.4): офлайн — с обещанием автоповтора, нет провайдера
 * (выключен/нет ключа) — с подсказкой панели «Перевод». */
export function translateUnavailableText(p: {
  reason: string;
  detail: string;
  willRetry: boolean;
}): string {
  if (p.reason === "offline" || p.willRetry) {
    return "Перевод недоступен (нет сети) — повторим, когда сеть появится";
  }
  return `Перевод недоступен: ${p.detail || "нет провайдера"}`;
}
