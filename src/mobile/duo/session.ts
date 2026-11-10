// Duo-сессия YouTube мобильной ветки (этап 2, duopulse-082): список дорожек
// из player-ответа (добыл Rust duo_yt_player — innertube ANDROID-клиент, чьи
// baseUrl открываемы без PO-токена) и загрузка cue (duo_fetch_cues +
// parse_auto в Rust). Разбор player-ответа — чистые функции content-адаптера
// (единый источник знаний о YouTube с десктопом); здесь — их мобильная
// обвязка: сшивка id дорожек с baseUrl, ретраи 429, перевод gtx.
//
// Перевод (duopulse-082, зонд 08.11.2026): tlang YouTube мобильной ветке
// недоступен (429 без PO-токена живой сессии плеера), поэтому перевод —
// готовые дорожки видео + Google gtx поверх cue оригинала.

import type { Cue } from "../../../content/types";
import {
  buildTranslationUrl,
  extractCaptionList,
  normalizeBaseTracks,
  normalizeTranslations,
  originalLangsOf,
  type RawCaptionList,
} from "../../../content/adapters/youtube";
import type { BaseTrackInfo, TranslationLangInfo } from "../../../content/adapters/types";

/** Транспорт invoke (для юнит-тестов подменяется фейком). */
export type DuoInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface MobileTrackList {
  videoId: string;
  /** Заголовок видео (videoDetails.title player-ответа; пусто — нет в ответе).
   * Закладки (duopulse-104) используют его как имя. */
  title: string;
  base: BaseTrackInfo[];
  translations: TranslationLangInfo[];
  /** baseId → подписанный baseUrl (для загрузки cue и tlang-экспериментов). */
  urls: Map<string, string>;
  /** Языки оригинала (детект адаптера). */
  originalLangs: Set<string>;
}

/** videoDetails.title из player-ответа (закладки duopulse-104); пусто — нет. */
export function titleOfPlayerResponse(response: unknown): string {
  const details = (response as { videoDetails?: { title?: unknown } })?.videoDetails;
  return typeof details?.title === "string" ? details.title : "";
}

/** Сформировать id дорожек так же, как normalizeBaseTracks (стем + :2/:3 при
 * дублях языка), и сшить с baseUrl по порядку — normalizeBaseTracks baseUrl
 * не знает (content-слой его берёт у живого плеера), мобильная сессия знает.
 * Дорожки без languageCode оба прохода пропускают — порядок совпадает. */
export function zipBaseUrls(raw: RawCaptionList, originalLangs: Set<string>): { base: BaseTrackInfo[]; urls: Map<string, string> } {
  const { base } = normalizeBaseTracks(raw, originalLangs);
  const urls = new Map<string, string>();
  const seen = new Map<string, number>();
  let zipped = 0;
  for (const t of raw.captionTracks) {
    const lang = typeof t.languageCode === "string" ? t.languageCode : "";
    if (!lang) continue; // тот же фильтр, что normalizeBaseTracks
    const kind = t.kind === "asr" ? "asr" : "manual";
    const stem = kind === "asr" ? `yt:${lang}:asr` : `yt:${lang}`;
    const n = (seen.get(stem) ?? 0) + 1;
    seen.set(stem, n);
    const id = n === 1 ? stem : `${stem}:${n}`;
    if (typeof t.baseUrl === "string" && t.baseUrl) urls.set(id, t.baseUrl);
    zipped++;
  }
  if (zipped !== base.length) {
    // Рассинхрон схемы id (изменился адаптер) — не молчим, берём что сшилось.
    console.warn(`duo: сшивка baseUrl ${zipped}/${base.length} дорожек`);
  }
  return { base, urls };
}

/** Player-ответ (Rust) → мобильный список дорожек. null — субтитров нет. */
export function parsePlayerResponse(videoId: string, response: unknown): MobileTrackList | null {
  const raw = extractCaptionList(response);
  if (!raw) return null;
  const originalLangs = originalLangsOf(response);
  const { base, urls } = zipBaseUrls(raw, originalLangs);
  if (base.length === 0 && raw.translationLanguages.length === 0) return null;
  return {
    videoId,
    title: titleOfPlayerResponse(response),
    base,
    translations: normalizeTranslations(raw),
    urls,
    originalLangs,
  };
}

/** Дорожка оригинала по умолчанию — как defaultBase адаптера/панели десктопа:
 * язык оригинала (ручная, иначе asr), иначе первая ручная, иначе первая. */
export function defaultOriginal(list: MobileTrackList): BaseTrackInfo | null {
  const base = list.base;
  return (
    base.find((t) => t.original && t.kind === "manual") ??
    base.find((t) => t.original) ??
    base.find((t) => t.kind === "manual") ??
    base[0] ??
    null
  );
}

/** Загрузить cue дорожки по baseUrl. 429/5xx — один повтор через 6 с (схема
 * ретраев адаптера десктопа), дальше — честная ошибка. */
export async function loadCuesByUrl(invoke: DuoInvoke, url: string, signal?: { aborted: boolean }): Promise<Cue[]> {
  interface FetchResult {
    status: number;
    cues: Cue[];
    warnings?: string[];
  }
  const attempt = async (): Promise<FetchResult> => {
    const r = (await invoke("duo_fetch_cues", { url })) as FetchResult;
    return { status: typeof r?.status === "number" ? r.status : 0, cues: Array.isArray(r?.cues) ? r.cues : [] };
  };
  let res = await attempt();
  if ((res.status === 429 || res.status >= 500) && !signal?.aborted) {
    await new Promise((r) => setTimeout(r, 6000));
    if (signal?.aborted) throw new Error("загрузка отменена");
    res = await attempt();
  }
  if (res.status !== 200) throw new Error(`YouTube отдал HTTP ${res.status}`);
  if (!res.cues.length) throw new Error("дорожка без реплик");
  return res.cues;
}

/** Перевести cue-таблицу Google gtx (Rust duo_translate_texts): пачки
 * ~1,2 КБ (лимит провайдера 2 КБ не трогаем), переносы внутри cue → пробел
 * (транспорт пачек соединяет строки \n). Прогресс — колбэком. */
export async function translateCueTable(
  invoke: DuoInvoke,
  cues: Cue[],
  from: string,
  to: string,
  onProgress?: (done: number, total: number) => void,
  signal?: { aborted: boolean },
): Promise<Cue[]> {
  const texts = cues.map((c) => c.text.replace(/\n+/g, " ").trim());
  const batches: Array<{ from: number; to: number }> = [];
  let start = 0;
  for (let i = 0; i < texts.length; i++) {
    const size = texts.slice(start, i + 1).reduce((n, t) => n + t.length + 1, 0);
    if (size > 1200 && i > start) {
      batches.push({ from: start, to: i });
      start = i;
    }
  }
  if (start < texts.length) batches.push({ from: start, to: texts.length });
  const out: string[] = new Array(texts.length);
  let done = 0;
  for (const b of batches) {
    if (signal?.aborted) throw new Error("перевод отменён");
    const chunk = texts.slice(b.from, b.to);
    const r = (await invoke("duo_translate_texts", { texts: chunk, from, to })) as string[];
    if (!Array.isArray(r) || r.length !== chunk.length) throw new Error("перевод вернул не все строки");
    for (let i = 0; i < r.length; i++) out[b.from + i] = r[i];
    done += chunk.length;
    onProgress?.(done, texts.length);
    if (batches.length > 1 && done < texts.length) {
      await new Promise((res) => setTimeout(res, 400)); // вежливая пауза между пачками (gtx рейт-лимит)
    }
  }
  return cues.map((c, i) => ({ ...c, text: out[i] || c.text }));
}

/** URL перевода tlang поверх живого baseUrl (эксперименты/будущее: подпись
 * не покрывает tlang, но без PO-токена обычно 429 — см. шапку). */
export { buildTranslationUrl };
