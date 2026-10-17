// Дефолтный набор дорожек для Alt+D «включить субтитры» (задача 3.7,
// docs/03 §8 п.2 «последний набор»; сценарий docs/01 §5.1: лекция на
// английском → Alt+D → дуо «оригинал + ru»). На свежем видео прошлого набора
// нет — собираем из списка адаптера: оригинал + первый перевод из
// предпочитаемых языков пользователя; переводов нет — один оригинал.
// Здесь только чистые функции (тесты без DOM), применение — duopulse-content.

import type { AdapterTrackList } from "./adapters/types";

/** Предпочитаемые языки перевода по порядку (владелец смотрит en-контент,
 * интерфейс русский): первый доступный из списка и станет второй строкой. */
export const PREFERRED_TRANSLATION_LANGS: readonly string[] = ["ru", "uk", "en"];

/** Дефолтный набор: [оригинал] или [оригинал, перевод]. Оригинал — дорожка
 * с original=true (язык аудио); нет такой — первая базовая. Перевод — tlang
 * из PREFERRED_TRANSLATION_LANGS по порядку, затем первый доступный; базой
 * перевода служит оригинал (голый код перевода в resolveIds). Пустой список
 * адаптера → [] (включать нечего, Alt+D просто поднимет флаг enabled). */
export function defaultSetIds(
  list: AdapterTrackList | null,
  preferred: readonly string[] = PREFERRED_TRANSLATION_LANGS,
): string[] {
  if (!list || list.base.length === 0) return [];
  const original = list.base.find((b) => b.original) ?? list.base[0];
  const ids = [original.id];
  // Перевод языка оригинала бессмыслен — исключаем; предпочитаемые языки
  // по порядку, затем первый доступный из оставшихся.
  const candidates = list.translations.filter((t) => t.lang !== original.lang);
  const translation =
    preferred.map((lang) => candidates.find((t) => t.lang === lang)).find(Boolean) ??
    candidates[0];
  // оригинал переводим только если платформа разрешает (translatable)
  if (translation && original.translatable) ids.push(translation.lang);
  return ids;
}

/** Те же участники в другом порядке? (multiset-сравнение) — fast-path
 * перестановки набора панелью (задача 3.7): без повторной загрузки дорожек. */
export function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const count = new Map<string, number>();
  for (const id of a) count.set(id, (count.get(id) ?? 0) + 1);
  for (const id of b) {
    const left = count.get(id) ?? 0;
    if (left === 0) return false;
    count.set(id, left - 1);
  }
  return true;
}
