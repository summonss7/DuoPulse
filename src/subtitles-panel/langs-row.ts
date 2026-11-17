// Строка «Языки: с какого → на какой» панели «duo» (карточка duopulse-079,
// пожелание: «кнопка настроек, чтобы выбрал с какого языка на какой настраивать
// субтитры»). Чистые функции без DOM — юнит-тесты; рендер и IPC — duo.ts.
// Оригинал — базовая дорожка платформы; перевод — бесплатный tlang платформы
// (приоритетнее облака, docs/03 §7) или облачный (значение с префиксом cloud:).
// Строка управляет дуго-парой «оригинал + перевод»; полный набор до 3 строк —
// секцией «Набор» ниже, файлы/ASR строкой не трогаются (set_tracks меняет
// только платформенную часть).
//
// Карточка duopulse-177: на локальном видео (файл + .srt) платформенных
// дорожек нет — файловая дорожка с языком становится «оригиналом» строки
// (effectiveBase/langRowState): панель ведёт себя как на платформе, перевод —
// облачный, источник — файл (set_tracks не шлётся, файловая часть — своя).

import type { AppliedTrackInfo, BaseTrackInfo, TranslationLangInfo } from "../bridge/gen/types";
import { t } from "../i18n";
import { baseLang, cloudLangOptions, withPriorityLangsFirst } from "./cloud-langs";
import { normalizeTrackId } from "./presets";

/** Перевод строки языков: нет / платформенный / облачный. */
export type LangTo = { kind: "none" } | { kind: "platform"; lang: string } | { kind: "cloud"; lang: string };

/** Текущий выбор строки по применённому набору. */
export interface LangRowState {
  /** id базовой дорожки-оригинала (null — платформенных строк нет). */
  fromId: string | null;
  to: LangTo;
}

/** Платформенная строка набора (дорожка YouTube, не файл/перевод/ASR). */
const isPlatform = (t: AppliedTrackInfo): boolean =>
  t.source !== "file" && t.source !== "translate" && t.source !== "asr" && t.source !== "test";

/** Эффективный список «Язык видео» (duopulse-177): базовые дорожки платформы;
 * на локальном видео их нет — файловая дорожка с языком (имя вида фильм.en.srt)
 * становится оригиналом. Псевдо-база помечается kind:"file" — toChange/
 * fromChange не шлют set_tracks (файловая часть набора живёт своей, дроп/
 * «Свои субтитры» её замещают). */
export function effectiveBase(
  base: BaseTrackInfo[],
  tracks: AppliedTrackInfo[],
): BaseTrackInfo[] {
  if (base.length > 0) return base;
  return tracks
    .filter((t) => t.source === "file" && t.lang !== "und" && t.lang !== "")
    .map((t) => ({
      id: t.id,
      kind: "file",
      lang: t.lang,
      name: t.name || t.id.replace(/^file:/, ""),
      original: true,
      translatable: true,
    }));
}

/** Выбор строки по набору: оригинал — платформенная строка с role=original
 * (нет — первая платформенная; на локальном видео — файловая с языком,
 * duopulse-177); перевод — первая строка-перевод: платформенная «yt:en+ru»
 * (язык по нормализации id) или облачная «cloud:xx». */
export function langRowState(tracks: AppliedTrackInfo[]): LangRowState {
  const platform = tracks.filter(isPlatform);
  const file = tracks.find((t) => t.source === "file" && t.lang !== "und" && t.lang !== "");
  const original = platform.find((t) => t.role === "original") ?? platform[0] ?? file ?? null;
  const platformTo = platform.find((t) => t.id.includes("+"));
  if (platformTo) return { fromId: original?.id ?? null, to: { kind: "platform", lang: normalizeTrackId(platformTo.id) } };
  const cloud = tracks.find((t) => t.id.startsWith("cloud:"));
  if (cloud) return { fromId: original?.id ?? null, to: { kind: "cloud", lang: baseLang(cloud.lang) } };
  return { fromId: original?.id ?? null, to: { kind: "none" } };
}

/** Варианты селекта «Язык видео»: базовые дорожки платформы; приоритетные
 * языки хозяина — первыми (карточка duopulse-094), прочие — в порядке адаптера. */
export function fromOptions(base: BaseTrackInfo[]): { id: string; name: string }[] {
  return withPriorityLangsFirst(base, (b) => b.lang).map((b) => ({
    id: b.id,
    name: `${b.name}${b.original ? t(" · оригинал") : ""}${b.kind === "asr" ? t(" · авто") : ""} (${b.lang})`,
  }));
}

/** Варианты селекта «Перевод»: платформенные tlang (кроме языка оригинала;
 * непереводимый оригинал — tlang платформы нельзя, остаётся облако) и облачные
 * языки. Текущий выбор не фильтруется — значение селекта всегда среди вариантов. */
export function toOptions(
  translations: TranslationLangInfo[],
  from: { lang: string; translatable: boolean } | null,
): { value: string; name: string; group: "platform" | "cloud" }[] {
  const fromLang = from ? baseLang(from.lang) : "";
  const platform = withPriorityLangsFirst(
    (from?.translatable === false ? [] : translations).filter((t) => baseLang(t.lang) !== fromLang),
    (t) => t.lang,
  ).map((t) => ({ value: t.lang, name: `${t.name} (${t.lang})`, group: "platform" as const }));
  // Непереводимый оригинал — tlang платформы недоступен вовсе: его языки
  // остаются кандидата́ми облака (cloudLangOptions исключает tlang из облака).
  const cloud = cloudLangOptions(
    from?.translatable === false ? [] : translations,
    fromLang ? [fromLang] : [],
    true,
  ).map((l) => ({
    value: `cloud:${l.code}`,
    name: t("{name} — облако ({code})", { name: l.name, code: l.code }),
    group: "cloud" as const,
  }));
  return [...platform, ...cloud];
}

/** Действие смены языка строки (порядок исполнения важен). */
export type LangAction =
  | { type: "set"; ids: string[] } // subtitles.set_tracks — платформенная часть
  | { type: "remove"; id: string } // subtitles.remove_track — облачная строка
  | { type: "translate"; lang: string }; // subtitles.translate_track — облако

/** Смена оригинала: новый id первым, платформенные переводы приживаются к нему
 * (голый код перевода резолвится базой-оригиналом, задача 3.3), непереводимый
 * оригинал остаётся один; облачная строка живёт своей частью — не трогаем.
 * Файловый «оригинал» (duopulse-177) один и несменяем — действий нет. */
export function fromChange(
  tracks: AppliedTrackInfo[],
  base: BaseTrackInfo[],
  newFromId: string,
): LangAction[] {
  const target = base.find((b) => b.id === newFromId);
  if (!target) return [];
  if (target.kind === "file") return [];
  const { fromId, to } = langRowState(tracks);
  const ids = [target.id];
  if (to.kind === "platform" && target.translatable && baseLang(to.lang) !== baseLang(target.lang)) {
    ids.push(to.lang);
  }
  return fromId === target.id ? [] : [{ type: "set", ids }];
}

/** Смена перевода: «нет» — гасим и платформенный перевод, и облачную строку;
 * tlang — дуо «оригинал + перевод»; облако — оригинал как источник и запуск
 * конвейера (прежнюю облачную строку снимаем — строка держит одну пару).
 * Файловый оригинал (duopulse-177): set_tracks не шлём — файловая часть набора
 * живёт своей (дроп/«Свои субтитры»), меняем только облачную строку. */
export function toChange(
  tracks: AppliedTrackInfo[],
  base: BaseTrackInfo[],
  value: string,
): LangAction[] {
  const { fromId } = langRowState(tracks);
  const original = base.find((b) => b.id === fromId) ?? base.find((b) => b.original) ?? base[0];
  if (!original) return [];
  const fileOriginal = original.kind === "file";
  const actions: LangAction[] = [];
  const cloud = tracks.find((t) => t.id.startsWith("cloud:"));
  if (cloud && value !== `cloud:${baseLang(cloud.lang)}`) actions.push({ type: "remove", id: cloud.id });
  if (value === "") {
    if (!fileOriginal) actions.push({ type: "set", ids: [original.id] });
    return actions;
  }
  if (value.startsWith("cloud:")) {
    if (!fileOriginal) actions.push({ type: "set", ids: [original.id] });
    actions.push({ type: "translate", lang: value.slice("cloud:".length) });
    return actions;
  }
  // платформенный tlang: перевод языка оригинала бессмыслен (set-defaults)
  if (baseLang(value) === baseLang(original.lang)) return actions.length ? actions : [{ type: "set", ids: [original.id] }];
  actions.push({ type: "set", ids: [original.id, value] });
  return actions;
}
