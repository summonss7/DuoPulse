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
import { t } from "../../i18n";
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

/** Player-ответ (Rust) → мобильный список дорожек. null — субтитров нет.
 * uiLang (duopulse-186, п.4 дуопульса-184) — язык, переданный в hl запроса
 * duo_yt_player: defaultCaptionTrackIndex ≠ этот язык = контентный фолбэк
 * (язык оригинала). Язык запроса и сравнения обязаны совпадать. */
export function parsePlayerResponse(videoId: string, response: unknown, uiLang?: string): MobileTrackList | null {
  const raw = extractCaptionList(response);
  if (!raw) return null;
  const originalLangs = originalLangsOf(response, uiLang);
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
 * язык оригинала (ручная, иначе asr; с duopulse-221 originalLangsOf сперва
 * пробует детект метаданных videoDetails), иначе en-ручная прежде первой
 * (duopulse-186, п.5 дуопульса-184: при неизвестном оригинале порядок
 * captionTracks нестабилен — у vk_xq1P7vIU первой шла zh-Hans, дефолт
 * включал китайскую дорожку), иначе первая ручная, иначе первая. */
export function defaultOriginal(list: MobileTrackList): BaseTrackInfo | null {
  const base = list.base;
  return (
    base.find((t) => t.original && t.kind === "manual") ??
    base.find((t) => t.original) ??
    base.find((t) => t.kind === "manual" && t.lang.split("-")[0] === "en") ??
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
    if (signal?.aborted) throw new Error(t("загрузка отменена"));
    res = await attempt();
  }
  if (res.status !== 200) throw new Error(t("YouTube отдал HTTP {status}", { status: res.status }));
  if (!res.cues.length) throw new Error(t("дорожка без реплик"));
  return res.cues;
}

/** Таймаут одного вызова duo_translate_texts, мс (duopulse-182): офлайн
 *  (airplane) может завесить ureq/DNS дольше ретраев Rust — конвейер ASR не
 *  имеет права молча висеть «занятым»; зависший вызов отбрасываем ошибкой. */
export const GTX_CALL_TIMEOUT_MS = 30_000;

/** Хосты gtx для веб-фетча (duopulse-208; порядок свой, не GTX_HOSTS Rust):
 *  канонический translate.googleapis.com сперва, clients5 — запасная рёбра
 *  (лимиты у рёбер независимые). */
export const GTX_WEB_HOSTS: readonly string[] = [
  "translate.googleapis.com",
  "clients5.google.com",
];

/** Разбор dj=1-ответа gtx: sentences[].trans, слепленные в одну строку —
 *  переносы строк пачки Google сохраняет внутри trans (семантика
 *  parse_gtx_dj Rust: предложение без trans рушит весь разбор). */
export function parseGtxDjBody(body: string): string | null {
  let v: { sentences?: Array<{ trans?: unknown }> };
  try {
    v = JSON.parse(body) as { sentences?: Array<{ trans?: unknown }> };
  } catch {
    return null;
  }
  if (!Array.isArray(v.sentences)) return null;
  let out = "";
  for (const s of v.sentences) {
    if (typeof s?.trans !== "string") return null;
    out += s.trans;
  }
  return out;
}

/** Сеансовый кэш веб-gtx (зеркалит gtx_cache Core): повторные сборки набора
 *  (смена кегля/позиции) не должны молотить рейт-лимит повторными пачками. */
const gtxWebCache = new Map<string, string[]>();
const GTX_WEB_CACHE_MAX = 200;

/** Один GET gtx фетчем UI-webview (duopulse-208): браузерный TLS-профиль
 *  Android System WebView Google не бот-блокирует, тогда как ureq-профиль
 *  Core ловит 429 «Sorry» (репро на эмуляторе; CORS эндпоинта открыт —
 *  Access-Control-Allow-Origin: *). Сеть/парс не пошли — null: вызывающий
 *  уходит на Core-транспорт; HTTP-статус — честная ошибка без фолбэка
 *  (лимит уровня адреса бьёт оба профиля, ретраи Core лишь продлят «занято»). */
async function gtxWebGet(
  from: string,
  to: string,
  joined: string,
  signal?: { aborted: boolean },
  timeoutMs: number = GTX_CALL_TIMEOUT_MS,
): Promise<string | null> {
  let httpErr: string | null = null;
  for (const host of GTX_WEB_HOSTS) {
    const url =
      `https://${host}/translate_a/single?client=gtx&dj=1` +
      `&sl=${encodeURIComponent(from)}&tl=${encodeURIComponent(to)}&dt=t&q=${encodeURIComponent(joined)}`;
    let resp: Response;
    try {
      resp = await raceCall(fetch(url), signal, timeoutMs);
    } catch (e) {
      if (signal?.aborted) throw e; // отмену не считаем транспортным отказом
      return null; // сеть/прокси WebView — остаёмся на Core-транспорте
    }
    if (resp.status !== 200) {
      httpErr = `gtx HTTP ${resp.status} (${host})`;
      continue;
    }
    const parsed = parseGtxDjBody(await resp.text());
    if (parsed !== null) return parsed;
  }
  if (httpErr) throw new Error(httpErr);
  return null;
}

/** Сброс сеансового кэша веб-gtx (изоляция тестов). */
export function clearGtxWebCache(): void {
  gtxWebCache.clear();
}

/** Перевести пачку строк веб-фетчем: пакетный GET (строки через \n), при
 *  несовпадении числа строк — построчный добор (Google смёржил короткие;
 *  схема translate_batch Rust). null — веб-транспорт не пошёл, пачка
 *  отправляется Core-путём. */
async function gtxWebBatch(
  texts: string[],
  from: string,
  to: string,
  signal?: { aborted: boolean },
  timeoutMs: number = GTX_CALL_TIMEOUT_MS,
): Promise<string[] | null> {
  const key = `${from}\u0001${to}\u0001${texts.join("\u0001")}`;
  const hit = gtxWebCache.get(key);
  if (hit) return hit;
  const joined = await gtxWebGet(from, to, texts.join("\n"), signal, timeoutMs);
  if (joined === null) return null;
  let out: string[];
  if (joined.split("\n").length === texts.length) {
    out = joined.split("\n");
  } else {
    out = [];
    for (const txt of texts) {
      if (signal?.aborted) throw new Error(t("перевод отменён"));
      const one = await gtxWebGet(from, to, txt, signal, timeoutMs);
      if (one === null) return null;
      out.push(one.trim());
    }
  }
  if (gtxWebCache.size >= GTX_WEB_CACHE_MAX) gtxWebCache.clear();
  gtxWebCache.set(key, out);
  return out;
}

/** Гонка вызова перевода с таймаутом и абортом: плоский signal ({aborted})
 *  событий не шлёт — опрашиваем; поздний ответ зависшего invoke гасим. */
function raceCall<T>(p: Promise<T>, signal: { aborted: boolean } | undefined, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      settle();
    };
    p.then(
      (v) => finish(() => resolve(v)),
      (e) => finish(() => reject(e)),
    );
    timer = setTimeout(
      () => finish(() => reject(new Error(t("нет ответа {sec} с — проверьте сеть", { sec: String(Math.round(timeoutMs / 1000)) })))),
      timeoutMs,
    );
    if (signal) {
      poll = setInterval(() => {
        if (signal.aborted) finish(() => reject(new Error(t("перевод отменён"))));
      }, 150);
    }
  });
}

/** Перевести cue-таблицу Google gtx: сперва веб-фетч UI-webview
 * (duopulse-208 — браузерный TLS-профиль обходит бот-блок gtx), транспорт
 * не пошёл — прежний путь Core (Rust duo_translate_texts, ureq): пачки
 * ~1,2 КБ (лимит провайдера 2 КБ не трогаем), переносы внутри cue → пробел
 * (транспорт пачек соединяет строки \n). Прогресс — колбэком. Таймаут
 * вызова — duopulse-182 (зависший офлайн-транспорт не держит конвейер). */
export async function translateCueTable(
  invoke: DuoInvoke,
  cues: Cue[],
  from: string,
  to: string,
  onProgress?: (done: number, total: number) => void,
  signal?: { aborted: boolean },
  timeoutMs: number = GTX_CALL_TIMEOUT_MS,
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
    if (signal?.aborted) throw new Error(t("перевод отменён"));
    const chunk = texts.slice(b.from, b.to);
    let r = await gtxWebBatch(chunk, from, to, signal, timeoutMs);
    if (r === null) {
      r = (await raceCall(invoke("duo_translate_texts", { texts: chunk, from, to }), signal, timeoutMs)) as string[];
    }
    if (!Array.isArray(r) || r.length !== chunk.length) throw new Error(t("перевод вернул не все строки"));
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
