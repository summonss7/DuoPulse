// Пресеты быстрого переключения набора (задача 3.7, панель «duo»): чистые
// функции без DOM — юнит-тесты. Пресет — список id для subtitles.set_tracks:
// «Оригинал», «Дуо» (оригинал + предпочитаемый перевод), «Трио» (+ второй
// перевод) — сценарий docs/01 §5.1. Голый код перевода = база-оригинал
// (resolveIds адаптера, задача 3.3).

import type { BaseTrackInfo, TranslationLangInfo } from "../bridge/gen/types";

/** Предпочитаемые языки перевода по порядку (как content/set-defaults;
 * порядок хозяина — карточка duopulse-094: en → ro → ru → ar). */
export const PREFERRED_TRANSLATION_LANGS: readonly string[] = ["en", "ro", "ru", "ar"];

export interface PresetSet {
  key: string;
  label: string;
  /** id для subtitles.set_tracks. */
  ids: string[];
}

/** Пресеты из списка адаптера: оригинал = дорожка с original=true (нет —
 * первая); переводы — предпочитаемые языки по порядку, затем первый
 * доступный; перевод языка оригинала и повторы пропускаются; Duo/Трио —
 * только если платформа разрешает перевод оригинала (translatable). */
export function presetSets(base: BaseTrackInfo[], translations: TranslationLangInfo[]): PresetSet[] {
  const original = base.find((b) => b.original) ?? base[0];
  if (!original) return [];
  const pick = (skip: readonly string[]): TranslationLangInfo | undefined => {
    const ok = (t: TranslationLangInfo): boolean =>
      t.lang !== original.lang && !skip.includes(t.lang);
    for (const lang of PREFERRED_TRANSLATION_LANGS) {
      const hit = translations.find((t) => t.lang === lang && ok(t));
      if (hit) return hit;
    }
    return translations.find(ok);
  };
  const sets: PresetSet[] = [{ key: "solo", label: "Оригинал", ids: [original.id] }];
  const t1 = pick([]);
  if (t1 && original.translatable) {
    sets.push({ key: "duo", label: `Дуо ${original.lang}+${t1.lang}`, ids: [original.id, t1.lang] });
    const t2 = pick([t1.lang]);
    if (t2) {
      sets.push({ key: "trio", label: `Трио +${t2.lang}`, ids: [original.id, t1.lang, t2.lang] });
    }
  }
  return sets;
}

/** Нормализованный id для сравнения наборов: применённый перевод идёт как
 * «yt:en+ru», пресет — голым кодом «ru»; совпадение — по суффиксу. */
export function normalizeTrackId(id: string): string {
  return id.includes("+") ? id.slice(id.indexOf("+") + 1) : id;
}
