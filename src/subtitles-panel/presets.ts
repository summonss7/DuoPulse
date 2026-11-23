// Пресеты быстрого переключения набора (задача 3.7, панель «duo»): чистые
// функции без DOM — юнит-тесты. Пресет — список id для subtitles.set_tracks:
// «Оригинал», «Дуо» (оригинал + предпочитаемый перевод), «Трио» (+ второй
// перевод) — сценарий docs/01 §5.1. Голый код перевода = база-оригинал
// (resolveIds адаптера, задача 3.3). Метки — через t() (i18n, карточка
// duopulse-137): в ru t() возвращает исходник, тесты остаются зелёными.

import type { BaseTrackInfo, TranslationLangInfo } from "../bridge/gen/types";
import { t } from "../i18n";
import { defaultTranslationTarget } from "../../content/set-defaults";

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
 * первая); переводы — цель правила дуо duopulse-196 (русский/украинский
 * оригинал → en, прочие → ru; duopulse-216) прежде предпочитаемых языков,
 * затем первый доступный;
 * перевод языка оригинала и повторы пропускаются; Duo/Трио — только если
 * платформа разрешает перевод оригинала (translatable). Порядок — тот же,
 * что собирает дефолт-набор Alt+D/video-auto (content/set-defaults):
 * пресет «Дуо» совпадает с тем, что включается сам. */
export function presetSets(base: BaseTrackInfo[], translations: TranslationLangInfo[]): PresetSet[] {
  const original = base.find((b) => b.original) ?? base[0];
  if (!original) return [];
  // цель правила — первой, затем прежний порядок (fallback, если цели нет)
  const rule = defaultTranslationTarget(original.lang);
  const order = [rule, ...PREFERRED_TRANSLATION_LANGS.filter((lang) => lang !== rule)];
  const pick = (skip: readonly string[]): TranslationLangInfo | undefined => {
    const ok = (t: TranslationLangInfo): boolean =>
      t.lang !== original.lang && !skip.includes(t.lang);
    for (const lang of order) {
      const hit = translations.find((t) => t.lang === lang && ok(t));
      if (hit) return hit;
    }
    return translations.find(ok);
  };
  const sets: PresetSet[] = [{ key: "solo", label: t("Оригинал"), ids: [original.id] }];
  const t1 = pick([]);
  if (t1 && original.translatable) {
    sets.push({
      key: "duo",
      label: t("Дуо {a}+{b}", { a: original.lang, b: t1.lang }),
      ids: [original.id, t1.lang],
    });
    const t2 = pick([t1.lang]);
    if (t2) {
      sets.push({
        key: "trio",
        label: t("Трио +{b}", { b: t2.lang }),
        ids: [original.id, t1.lang, t2.lang],
      });
    }
  }
  return sets;
}

/** Нормализованный id для сравнения наборов: применённый перевод идёт как
 * «yt:en+ru», пресет — голым кодом «ru»; совпадение — по суффиксу.
 * duopulse-232: дорожка плеер-фрейма «embed:ru:1» — тоже «ru» (языковая
 * часть id; формат cinemar «embed:cinemar:N» языка не несёт — остаётся как
 * есть, подсветка пресета просто не сработает). */
export function normalizeTrackId(id: string): string {
  if (id.startsWith("embed:")) {
    const seg = id.split(":")[1] ?? "";
    return /^[a-z]{2,3}(-[a-z0-9-]+)?$/i.test(seg) ? seg : id;
  }
  return id.includes("+") ? id.slice(id.indexOf("+") + 1) : id;
}
