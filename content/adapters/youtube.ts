// YouTube-адаптер дорожек субтитров (задача 3.3, docs/03 §3.1 + §9, docs/05 §1).
// ВСЕ знания о YouTube живут здесь; остальные модули работают с абстракцией
// Track (docs/03 §9).
//
// Добыча данных (октябрь 2026, проверено пробами на живом YouTube):
// - Список дорожек — из player-ответа: путь «player-api»
//   (movie_player.getPlayerResponse) → путь «initial»
//   (window.ytInitialPlayerResponse) → «texttrack» (native TextTrack;
//   у текущего плеера YouTube пуст — последний resort по docs/03 §3.1).
// - Прямой fetch baseUrl из captionTracks возвращает 200 с пустым телом:
//   timedtext требует PO-токен (pot), которого в player-ответе нет.
// - Рабочий путь: content-бандл исполняется до скриптов страницы
//   (initialization_script) и подменяет fetch/XHR, снимая ТЕЛА ответов
//   timedtext, которые запрашивает сам плеер; адаптер программирует плеер
//   (captions.setOption track) на нужные языки — плеер грузит дорожку со
//   своим pot, хук отдаёт тело. Подпись URL не покрывает tlang, поэтому
//   переводы получаются параллельным fetch живого URL дорожки + &tlang=
//   (работает и после unloadModule). Смена lang= чужим кодом → 404, поэтому
//   базовые дорожки — только через программирование плеера (последовательно).
// - Язык оригинала — originalLangsOf: audioTracks[].original (TV/ANDROID-
//   клиенты) → renderer.audioTracks[].originalLanguage → asr-дорожка
//   (web-клиент, duopulse-070). defaultCaptionTrackIndex — рекомендация под
//   язык ИНТЕРФЕЙСА зрителя, не оригинал.

import type {
  Adapter,
  AdapterTrackList,
  BaseTrackInfo,
  LoadPorts,
  LoadedTracks,
  TrackRef,
  TranslationLangInfo,
} from "./types";
import type { Track } from "../types";
import { videoKeyFor } from "../detector/videoKey";

export const YOUTUBE_ADAPTER_VERSION = "2026.10";

/** Цепочка путей добычи по приоритету (docs/03 §9). */
export const YOUTUBE_PATHS = ["player-api", "initial", "texttrack"] as const;

// --- чистые функции над player-ответом ---------------------------------------

interface RawCaptionTrack {
  baseUrl?: unknown;
  name?: unknown;
  vssId?: unknown;
  languageCode?: unknown;
  kind?: unknown;
  isTranslatable?: unknown;
}
interface RawTranslationLang {
  languageCode?: unknown;
  languageName?: unknown;
}
export interface RawCaptionList {
  captionTracks: RawCaptionTrack[];
  translationLanguages: RawTranslationLang[];
  /** audioTracks рендерера без интерпретации (web-клиент: captionTrackIndices/
   *  defaultCaptionTrackIndex/hasDefaultTrack; язык оригинала — см.
   *  originalLangsOf). */
  audioTracks: unknown[];
}

/** Имя дорожки: {simpleText} | {runs:[{text}]} — иначе пусто. */
function textOfName(name: unknown): string {
  if (!name || typeof name !== "object") return "";
  const simple = (name as { simpleText?: unknown }).simpleText;
  if (typeof simple === "string") return simple;
  const runs = (name as { runs?: unknown }).runs;
  if (Array.isArray(runs)) {
    return runs
      .map((r) => (r && typeof r === "object" ? String((r as { text?: unknown }).text ?? "") : ""))
      .join("");
  }
  return "";
}

/** captions.playerCaptionsTracklistRenderer из player-ответа (или null). */
export function extractCaptionList(response: unknown): RawCaptionList | null {
  if (!response || typeof response !== "object") return null;
  const captions = (response as { captions?: unknown }).captions;
  if (!captions || typeof captions !== "object") return null;
  const renderer = (captions as { playerCaptionsTracklistRenderer?: unknown }).playerCaptionsTracklistRenderer;
  if (!renderer || typeof renderer !== "object") return null;
  const r = renderer as { captionTracks?: unknown; translationLanguages?: unknown; audioTracks?: unknown };
  const captionTracks = Array.isArray(r.captionTracks) ? (r.captionTracks as RawCaptionTrack[]) : [];
  const translationLanguages = Array.isArray(r.translationLanguages)
    ? (r.translationLanguages as RawTranslationLang[])
    : [];
  const audioTracks = Array.isArray(r.audioTracks) ? (r.audioTracks as unknown[]) : [];
  if (captionTracks.length === 0 && translationLanguages.length === 0) return null;
  return { captionTracks, translationLanguages, audioTracks };
}

/** videoDetails.videoId ответа — защита от устаревшего ответа при SPA. */
export function videoIdOfResponse(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const id = (response as { videoDetails?: { videoId?: unknown } }).videoDetails?.videoId;
  return typeof id === "string" && id ? id : null;
}

/** Языки оригинала видео: выбор базы перевода по умолчанию и пометка в
 * списке; определить не удалось — пусто. Источники по приоритету (живые
 * пробы web-клиента, карточка duopulse-070, 04.11.2026):
 * 1. верхнеуровневые audioTracks[].original — формы ANDROID/TV-клиентов
 *    (web-клиент их не отдаёт);
 * 2. captions.playerCaptionsTracklistRenderer.audioTracks[].originalLanguage —
 *    web-клиент пробы 04.11.2026 поля ещё не отдаёт, задел на будущее;
 * 3. фолбэк — asr-дорожка: авто-субтитры генерятся из оригинального звука
 *    (TED iG9CE55wbtY: en-asr → en; Gangnam 9bZkp7q19f0: ko-asr → ko).
 * defaultCaptionTrackIndex НЕ использовать — это рекомендация под язык
 * ИНТЕРФЕЙСА зрителя (проба: UI ro → индекс дорожки ro), не оригинал. */
export function originalLangsOf(response: unknown): Set<string> {
  const out = new Set<string>();
  if (!response || typeof response !== "object") return out;
  const add = (lang: unknown): void => {
    if (typeof lang === "string" && lang) out.add(lang);
  };
  const top = (response as { audioTracks?: unknown }).audioTracks;
  if (Array.isArray(top)) {
    for (const t of top) {
      if (!t || typeof t !== "object") continue;
      const track = t as { languageCode?: unknown; original?: unknown };
      if (track.original === true) add(track.languageCode);
    }
  }
  const raw = extractCaptionList(response);
  if (!raw) return out;
  for (const t of raw.audioTracks) {
    if (t && typeof t === "object") add((t as { originalLanguage?: unknown }).originalLanguage);
  }
  for (const t of raw.captionTracks) {
    if (t.kind === "asr") add(t.languageCode);
  }
  return out;
}

/** Идентификаторы базовых дорожек: yt:<lang> / yt:<lang>:asr; дубликаты — :2, :3…
 * (несколько дорожек одного языка бывают manual+asr и региональные варианты). */
export function normalizeBaseTracks(
  raw: RawCaptionList,
  originalLangs: Set<string> = new Set(),
): { base: BaseTrackInfo[]; warnings: string[] } {
  const warnings: string[] = [];
  const base: BaseTrackInfo[] = [];
  const seen = new Map<string, number>();
  for (const t of raw.captionTracks) {
    const lang = typeof t.languageCode === "string" ? t.languageCode : "";
    if (!lang) {
      warnings.push("дорожка без languageCode — пропущена");
      continue;
    }
    const kind = t.kind === "asr" ? "asr" : "manual";
    const stem = kind === "asr" ? `yt:${lang}:asr` : `yt:${lang}`;
    const n = (seen.get(stem) ?? 0) + 1;
    seen.set(stem, n);
    base.push({
      id: n === 1 ? stem : `${stem}:${n}`,
      lang,
      name: textOfName(t.name),
      kind,
      vssId: typeof t.vssId === "string" ? t.vssId : "",
      translatable: t.isTranslatable === true,
      original: originalLangs.has(lang),
    });
  }
  return { base, warnings };
}

export function normalizeTranslations(raw: RawCaptionList): TranslationLangInfo[] {
  const out: TranslationLangInfo[] = [];
  for (const l of raw.translationLanguages) {
    if (typeof l.languageCode === "string" && l.languageCode) {
      out.push({ lang: l.languageCode, name: textOfName(l.languageName) });
    }
  }
  return out;
}

/** YouTube id из URL: watch?v=, /shorts/, youtu.be (та же логика, что
 * videoKeyFor — единый источник детекта YouTube). */
export function videoIdFromHref(href: string): string | null {
  const key = videoKeyFor(href, undefined);
  return key.startsWith("yt:") ? key.slice(3) : null;
}

/** Страница YouTube с видео (для установки перехвата до скриптов страницы). */
export function isYouTubeHref(href: string): boolean {
  return videoIdFromHref(href) !== null;
}

// --- гашение нативных субтитров плеера (docs/03 §2) ---------------------------

/** Класс на <html> страницы: пока активен наш показ, нативная панель
 * субтитров плеера скрыта CSS-правилом ниже; снимается при выключении. */
export const YT_NATIVE_CAPTIONS_CLASS = "duopulse-yt-captions-off";
const YT_NATIVE_CAPTIONS_STYLE_ID = "duopulse-yt-captions-off-style";
/** DOM-слой, в котором плеер рисует свои субтитры (знание YouTube — здесь). */
const YT_NATIVE_CAPTIONS_CSS =
  `.${YT_NATIVE_CAPTIONS_CLASS} .ytp-caption-window-container{display:none!important}`;

/** Минимальный document для гашения (структурная типизация — тесты без DOM). */
export interface DocumentLike {
  documentElement: {
    classList: { add(cls: string): void; remove(cls: string): void; contains(cls: string): boolean };
    appendChild(node: unknown): unknown;
  };
  getElementById(id: string): unknown;
  createElement(tag: string): { textContent: string; id: string };
}

/** Скрыть/показать нативные субтитры плеера, пока активен наш показ (docs/03
 * §2: рендерим сами, нативные гасим). CSS, а не unloadModule(captions):
 * переживает перезагрузку модуля плеером и не мешает добыче дорожек
 * (программирование captions.setOption продолжает работать). */
export function blankYouTubeCaptions(doc: DocumentLike, blank: boolean): void {
  const list = doc.documentElement.classList;
  if (blank) {
    if (!doc.getElementById(YT_NATIVE_CAPTIONS_STYLE_ID)) {
      const style = doc.createElement("style");
      style.id = YT_NATIVE_CAPTIONS_STYLE_ID;
      style.textContent = YT_NATIVE_CAPTIONS_CSS;
      doc.documentElement.appendChild(style);
    }
    list.add(YT_NATIVE_CAPTIONS_CLASS);
  } else {
    list.remove(YT_NATIVE_CAPTIONS_CLASS); // правило остаётся — класс снят, CSS не активен
  }
}

// --- URL-утилиты --------------------------------------------------------------

/** Параметры query точным сравнением (lang=en не совпадает с lang=en-GB). */
export function paramsOf(url: string): Map<string, string> {
  const query = url.split("?")[1];
  const out = new Map<string, string>();
  if (!query) return out;
  for (const part of query.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq < 0) out.set(part, "");
    else out.set(part.slice(0, eq), part.slice(eq + 1));
  }
  return out;
}

/** URL перевода: живой URL дорожки + tlang (fmt дорожки не трогаем — игрок
 * запрашивает json3; повторный tlang заменяем). */
export function buildTranslationUrl(liveUrl: string, tlang: string): string {
  const [head, query = ""] = liveUrl.split("?");
  const kept: string[] = [];
  for (const part of query.split("&")) {
    if (part.startsWith("tlang=")) continue;
    if (part) kept.push(part);
  }
  kept.push(`tlang=${encodeURIComponent(tlang)}`);
  return `${head}?${kept.join("&")}`;
}

// --- перехват timedtext (ставится до скриптов страницы) -----------------------

export interface TimedtextCapture {
  url: string;
  body: string;
  at: number;
}

export interface TimedtextCaptureSource {
  /** Снятые ответы (для диагностики/повторного использования). */
  all(): TimedtextCapture[];
  /** Ждать ответ своей дорожки: v=<videoId>&lang=<languageCode> без tlang
   * (реклама отфильтровывается по v=). null — таймаут. */
  waitFor(videoId: string, languageCode: string, timeoutMs: number): Promise<TimedtextCapture | null>;
  /** Уже снятый ответ дорожки (без ожидания). */
  findFor(videoId: string, languageCode: string): TimedtextCapture | null;
}

const CAPTURE_LIMIT = 16;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function matchesTrack(c: TimedtextCapture, videoId: string, languageCode: string): boolean {
  if (!c.body) return false; // пустое тело (диагностика: нет PO-токена) не годится
  const p = paramsOf(c.url);
  return p.get("v") === videoId && p.get("lang") === languageCode && !p.has("tlang");
}

/** Подмена fetch/XHR страницы: тела timedtext-ответов — в кольцевой буфер.
 * Оригинальные вызовы не меняются (clone/readystatechange только читают);
 * идемпотентна (повторная установка возвращает действующий источник). */
export function installTimedtextCapture(win: PageWindow): TimedtextCaptureSource {
  const marked = win as { __duopulseTimedtextSource?: TimedtextCaptureSource };
  if (marked.__duopulseTimedtextSource) return marked.__duopulseTimedtextSource;
  const buffer: TimedtextCapture[] = [];
  const note = (url: string, body: string): void => {
    // Пустые тела тоже пишем (len 0): диагностика «запрос был, тела нет» —
    // матчинг дорожек их отбрасывает (matchesTrack требует тело).
    if (!url.includes("timedtext")) return;
    buffer.push({ url, body, at: Date.now() });
    if (buffer.length > CAPTURE_LIMIT) buffer.shift();
  };
  const originalFetch = win.fetch.bind(win);
  win.fetch = ((input: RequestInfo | URL | string, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as Request).url ?? input);
    const p = originalFetch(input as RequestInfo, init);
    if (url.includes("timedtext")) {
      void p
        .then((r) => r.clone().text().then((b) => note(url, b)))
        .catch(() => undefined);
    }
    return p;
  }) as typeof fetch;
  const XHR = win.XMLHttpRequest;
  if (XHR) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    XHR.prototype.open = function (this: XMLHttpRequest & { __dpUrl?: string }, ...args: unknown[]) {
      this.__dpUrl = String(args[1] ?? "");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (open as any).apply(this, args as never);
    };
    XHR.prototype.send = function (this: XMLHttpRequest & { __dpUrl?: string }, ...args: unknown[]) {
      if (this.__dpUrl?.includes("timedtext")) {
        this.addEventListener("load", () => {
          try {
            note(this.__dpUrl ?? "", this.responseText);
          } catch {
            /* доступ к телу закрыт — пропускаем */
          }
        });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (send as any).apply(this, args as never);
    };
  }
  const source: TimedtextCaptureSource = {
    all: () => buffer.slice(),
    findFor: (videoId, languageCode) => buffer.find((c) => matchesTrack(c, videoId, languageCode)) ?? null,
    async waitFor(videoId, languageCode, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = this.findFor(videoId, languageCode);
        if (hit) return hit;
        if (Date.now() >= deadline) return null;
        await sleep(200);
      }
    },
  };
  marked.__duopulseTimedtextSource = source;
  return source;
}

// --- транспорт: программирование плеера ---------------------------------------

/** Минимальный window (структурная типизация — тестируется без DOM). */
export interface PageWindow {
  location: { href: string };
  document: { getElementById(id: string): unknown };
  fetch: typeof fetch;
  XMLHttpRequest?: {
    prototype: {
      open: (...args: unknown[]) => unknown;
      send: (...args: unknown[]) => unknown;
    };
  };
}

/** Минимальный <video> для транспорта. */
export interface VideoForPlayer {
  paused: boolean;
  muted: boolean;
  play(): Promise<void>;
  pause(): void;
}

/** movie_player (страницы watch): публичные внутренности плеера YouTube. */
export interface PlayerElement {
  getPlayerResponse?(): unknown;
  getPlayerState?(): number;
  loadModule?(name: string): void;
  unloadModule?(name: string): void;
  setOption?(module: string, option: string, value: unknown): void;
  getOption?(module: string, option: string): unknown;
  classList?: { contains(cls: string): boolean };
}

export interface YouTubeTransport {
  readonly usedPath: string;
  begin(): Promise<boolean>;
  loadBaseTrack(videoId: string, languageCode: string): Promise<{ url: string; body: string } | null>;
  end(): Promise<void>;
}

/** Добыча через плеер: loadModule(captions) + setOption(track) → плеер сам
 * запрашивает timedtext (со своим pot), хук отдаёт тело. begin/end восстанав-
 * ливают состояние плеера (модуль/воспроизведение), показ не остаётся. */
export class PlayerApiTransport implements YouTubeTransport {
  readonly usedPath = "player-api+capture";
  private readonly win: PageWindow;
  private readonly getVideo: () => VideoForPlayer | null;
  private readonly capture: TimedtextCaptureSource;
  private wasTrack: unknown = null;
  private startedPlay = false;
  private wasMuted = true;

  constructor(opts: { win: PageWindow; getVideo: () => VideoForPlayer | null; capture: TimedtextCaptureSource }) {
    this.win = opts.win;
    this.getVideo = opts.getVideo;
    this.capture = opts.capture;
  }

  private player(): PlayerElement | null {
    const el = this.win.document.getElementById("movie_player");
    return el && typeof (el as PlayerElement).getPlayerResponse === "function" ? (el as PlayerElement) : null;
  }

  async begin(): Promise<boolean> {
    const el = this.player();
    if (!el) return false;
    try {
      el.loadModule?.("captions");
    } catch {
      /* модуль мог быть уже загружен */
    }
    // Две причины «плеер не отдал дорожку» (e2e-телеметрия): преролл — команды
    // captions уходят рекламному плееру (его timedtext фильтруется по v=);
    // незапущенный плеер (буферизация/-1) — дорожки лениво грузятся только у
    // играющего. Ждём конца рекламы, затем фактического воспроизведения;
    // по таймауту пробуем программировать всё равно (ретрай в loadBaseTrack).
    await this.waitForContent(el, 45_000);
    try {
      this.wasTrack = el.getOption?.("captions", "track") ?? null;
    } catch {
      this.wasTrack = null;
    }
    // Плеер грузит дорожки лениво у играющего видео: короткий muted-старт,
    // если стоит на паузе (состояние вернёт end()).
    const v = this.getVideo();
    if (v && v.paused) {
      this.wasMuted = v.muted;
      try {
        v.muted = true;
        await v.play();
        this.startedPlay = true;
      } catch {
        /* play не удался — пробуем программирование всё равно */
      }
    }
    await this.waitForPlaying(el, 15_000);
    return true;
  }

  /** Кадр рекламы закончился (класс ad-showing с movie_player снят). */
  private async waitForContent(el: PlayerElement, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (el.classList?.contains("ad-showing") && Date.now() < deadline) {
      await sleep(500);
    }
  }

  /** Плеер фактически играет (getPlayerState() === 1): в буферизации (3) и
   * до старта (-1) ленивая загрузка дорожек не срабатывает. */
  private async waitForPlaying(el: PlayerElement, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (el.getPlayerState?.() === 1) return;
      await sleep(400);
    }
  }

  async loadBaseTrack(videoId: string, languageCode: string): Promise<{ url: string; body: string } | null> {
    const el = this.player();
    if (!el || !el.setOption) return null;
    const existing = this.capture.findFor(videoId, languageCode);
    if (existing) return existing;
    // Три попытки; перед каждой — дождаться программируемого состояния:
    // преролл может начаться ВНУТРИ цикла (гонка «чистая телеметрия → реклама
    // при загрузке»). Пустое тело ответа (200/0 Б — у страницы ещё нет
    // PO-токена, BotGuard решается в фоне) плеер сам не ретраит, а повторный
    // setOption той же дорожки — ноун-оп: между попытками перезапускаем
    // captions-модуль и даём странице время на токен.
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.waitForContent(el, 45_000);
      await this.waitForPlaying(el, 15_000);
      if (attempt > 0) {
        try {
          el.unloadModule?.("captions");
          el.loadModule?.("captions");
        } catch {
          /* перезапуск модуля — best-effort */
        }
        await sleep(attempt * 3000);
      }
      try {
        el.setOption("captions", "track", { languageCode });
      } catch {
        return null;
      }
      const hit = await this.capture.waitFor(videoId, languageCode, attempt < 2 ? 8_000 : 12_000);
      if (hit) return { url: hit.url, body: hit.body };
    }
    return null;
  }

  async end(): Promise<void> {
    const el = this.player();
    if (el) {
      try {
        if (this.wasTrack && typeof this.wasTrack === "object") {
          el.setOption?.("captions", "track", this.wasTrack);
        } else {
          el.unloadModule?.("captions");
        }
      } catch {
        /* восстановление best-effort */
      }
    }
    if (this.startedPlay) {
      const v = this.getVideo();
      try {
        v?.pause();
        if (v) v.muted = this.wasMuted;
      } catch {
        /* best-effort */
      }
      this.startedPlay = false;
    }
  }
}

// --- адаптер -------------------------------------------------------------------

export interface YouTubeAdapterOptions {
  win: PageWindow;
  getVideo?: () => VideoForPlayer | null;
  /** Транспорт добычи (тесты подменяют); по умолччанию — PlayerApiTransport. */
  transport?: YouTubeTransport;
  /** Буфер перехвата (installTimedtextCapture); для транспорта по умолчанию. */
  capture?: TimedtextCaptureSource;
  /** Ожидание player-ответа при listTracks, мс (SPA-навигация). */
  listTimeoutMs?: number;
}

const LIST_POLL_MS = 300;

export class YouTubeAdapter implements Adapter {
  readonly id = "youtube" as const;
  readonly version = YOUTUBE_ADAPTER_VERSION;
  readonly paths = YOUTUBE_PATHS;
  private readonly opts: YouTubeAdapterOptions;
  private lastList: AdapterTrackList | null = null;

  constructor(opts: YouTubeAdapterOptions) {
    this.opts = opts;
  }

  matches(href: string): boolean {
    return videoKeyFor(href, undefined).startsWith("yt:");
  }

  /** Аудио-поток для ASR (карточка duopulse-060): audio-only формат
   *  player-ответа (streamingData.adaptiveFormats). Предпочтение m4a/AAC
   *  (декодер Core — symphonia, opus не умеет), из них — максимальный битрейт
   *  с прямым url; URL зашифрованы (signatureCipher) или отсутствуют — null
   *  (Core их не добудет, панель предложит ручной путь). Язык — оригинал
   *  аудио (originalLangsOf), иначе пусто (whisper определит сам). */
  audioSource(): { url: string; lang: string } | null {
    const found = this.playerResponse();
    if (!found) return null;
    const formats = (found.response as { streamingData?: { adaptiveFormats?: unknown } })
      ?.streamingData?.adaptiveFormats;
    if (!Array.isArray(formats)) return null;
    interface AudioFormat {
      mimeType?: unknown;
      url?: unknown;
      bitrate?: unknown;
    }
    const audios = formats.filter((f): f is AudioFormat => {
      if (!f || typeof f !== "object") return false;
      const mime = (f as AudioFormat).mimeType;
      const url = (f as AudioFormat).url;
      return (
        typeof mime === "string" &&
        mime.startsWith("audio/") &&
        typeof url === "string" &&
        url.length > 0
      );
    });
    if (audios.length === 0) return null;
    const score = (f: AudioFormat): number =>
      (typeof f.mimeType === "string" && f.mimeType.startsWith("audio/mp4") ? 1_000_000_000 : 0) +
      (typeof f.bitrate === "number" ? f.bitrate : 0);
    const best = audios.reduce((a, b) => (score(b) > score(a) ? b : a));
    const langs = originalLangsOf(found.response);
    return { url: best.url as string, lang: langs.values().next().value ?? "" };
  }

  private playerResponse(): { response: unknown; path: string } | null {
    const el = this.opts.win.document.getElementById("movie_player") as PlayerElement | null;
    if (el && typeof el.getPlayerResponse === "function") {
      try {
        const response = el.getPlayerResponse();
        if (response && typeof response === "object") return { response, path: "player-api" };
      } catch {
        /* плеер недоступен — следующий путь */
      }
    }
    const initial = (this.opts.win as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse;
    if (initial && typeof initial === "object") return { response: initial, path: "initial" };
    return null;
  }

  async listTracks(): Promise<AdapterTrackList | null> {
    const expectedId = videoIdFromHref(this.opts.win.location.href);
    const deadline = Date.now() + (this.opts.listTimeoutMs ?? 6_000);
    let stale: { list: AdapterTrackList; path: string } | null = null;
    for (;;) {
      const found = this.playerResponse();
      if (found) {
        const raw = extractCaptionList(found.response);
        if (raw) {
          const list = this.buildList(raw, found.path, found.response);
          const responseId = videoIdOfResponse(found.response);
          if (!expectedId || responseId === expectedId) {
            this.lastList = list;
            return list;
          }
          stale = { list, path: found.path }; // ответ прошлого видео (SPA) — ждём свежий
        }
      }
      if (Date.now() >= deadline) break;
      await sleep(LIST_POLL_MS);
    }
    if (stale) {
      stale.list.warnings.push(`player-ответ видео ${expectedId ?? "?"} не дождались — список устаревшего видео`);
      this.lastList = stale.list;
      return stale.list;
    }
    // Последний resort (docs/03 §3.1): native TextTrack — у текущего плеера
    // YouTube пуст (субтитры рендерит своим DOM-слоем), путь остаётся на случай
    // изменения платформы.
    const video = this.opts.getVideo?.();
    const tracks = (video as unknown as { textTracks?: { language?: string; kind?: string; label?: string }[] } | null)
      ?.textTracks ?? [];
    const base: BaseTrackInfo[] = [];
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (!t.language || (t.kind !== "captions" && t.kind !== "subtitles")) continue;
      base.push({
        id: `yt:tt:${t.language}:${i}`,
        lang: t.language,
        name: t.label ?? t.language,
        kind: "manual",
        vssId: "",
        translatable: false,
        original: false,
      });
    }
    const list: AdapterTrackList = {
      adapter: "youtube",
      version: this.version,
      usedPath: "texttrack",
      base,
      translations: [],
      warnings: base.length ? [] : ["player-ответ недоступен, native TextTrack пуст"],
    };
    this.lastList = list;
    return list;
  }

  private buildList(raw: RawCaptionList, usedPath: string, response: unknown): AdapterTrackList {
    const { base, warnings } = normalizeBaseTracks(raw, originalLangsOf(response));
    return {
      adapter: "youtube",
      version: this.version,
      usedPath,
      base,
      translations: normalizeTranslations(raw),
      warnings,
    };
  }

  /** Базовая дорожка по умолчанию для голого кода перевода («ru» → yt:en+ru):
   * язык оригинала (ручная, иначе asr), иначе первая ручная, иначе первая. */
  private defaultBase(): BaseTrackInfo | null {
    const base = this.lastList?.base ?? [];
    return (
      base.find((t) => t.original && t.kind === "manual") ??
      base.find((t) => t.original) ??
      base.find((t) => t.kind === "manual") ??
      base[0] ??
      null
    );
  }

  /** Выбранные id (из listTracks/диагностики) → дорожки к загрузке.
   * Формы: «yt:en» (база), «yt:en+ru» (перевод базы), «ru» (перевод базы
   * по умолчанию), «yt:en:asr» — конкретная asr-дорожка языка. */
  resolveIds(ids: string[]): { refs: TrackRef[]; unknown: string[] } {
    const refs: TrackRef[] = [];
    const unknown: string[] = [];
    for (const id of ids) {
      const baseInfo = this.lastList?.base.find((b) => b.id === id);
      if (baseInfo) {
        refs.push({ id: baseInfo.id, lang: baseInfo.lang, role: "original", source: "youtube", languageCode: baseInfo.lang });
        continue;
      }
      const plus = id.split("+");
      if (plus.length === 2) {
        const [baseId, tlang] = plus;
        const host = this.lastList?.base.find((b) => b.id === baseId);
        if (host) {
          refs.push({ id, lang: tlang, role: "translation", source: "youtube", baseId: host.id });
          continue;
        }
      }
      if (this.lastList?.translations.some((t) => t.lang === id)) {
        const host = this.defaultBase();
        if (host) {
          refs.push({ id: `${host.id}+${id}`, lang: id, role: "translation", source: "youtube", baseId: host.id });
          continue;
        }
      }
      unknown.push(id);
    }
    return { refs, unknown };
  }

  private refForBaseId(baseId: string): TrackRef | null {
    const info = this.lastList?.base.find((b) => b.id === baseId);
    if (!info) return null;
    return { id: info.id, lang: info.lang, role: "original", source: "youtube", languageCode: info.lang };
  }

  async loadTracks(refs: TrackRef[], ports: LoadPorts): Promise<LoadedTracks> {
    const failures: LoadedTracks["failures"] = [];
    const parsedById = new Map<string, Track>();
    // fetch адаптера — через окно страницы (в проде обёрнут перехватом, в
    // тестах подменяется фейком)
    const fetchImpl: typeof fetch =
      ports.fetchImpl ??
      ((input, init) => this.opts.win.fetch(input as RequestInfo | URL, init));
    const basesWanted = refs.filter((r) => r.role === "original");
    const translations = refs.filter((r) => r.role === "translation");
    // Переводу нужна живая URL его базы: скрыто снимаем и те базы, которых
    // нет в наборе (их cue в набор не попадают).
    const hiddenBaseIds = Array.from(
      new Set(translations.map((t) => t.baseId).filter((id): id is string => !!id)),
    ).filter((id) => !basesWanted.some((b) => b.id === id));

    const transport =
      this.opts.transport ??
      new PlayerApiTransport({
        win: this.opts.win,
        getVideo: () => this.opts.getVideo?.() ?? null,
        capture: this.opts.capture ?? installTimedtextCapture(this.opts.win),
      });
    const videoId = videoIdFromHref(this.opts.win.location.href) ?? "";
    const liveUrls = new Map<string, string>();

    const parseInto = async (ref: TrackRef, payload: string): Promise<void> => {
      try {
        const { cues } = await ports.parser.parse(payload);
        if (!cues.length) {
          failures.push({ ref, reason: "дорожка без cue" });
          return;
        }
        parsedById.set(ref.id, { id: ref.id, source: "youtube", lang: ref.lang, role: ref.role, cues });
      } catch (e) {
        failures.push({ ref, reason: `разбор не удался: ${errorMessage(e)}` });
      }
    };

    let began = false;
    try {
      began = await transport.begin();
    } catch {
      began = false;
    }
    if (began) {
      const loadBase = async (ref: TrackRef, collect: boolean): Promise<void> => {
        const cap = await transport.loadBaseTrack(videoId, ref.languageCode ?? ref.lang);
        if (!cap) {
          failures.push({ ref, reason: "плеер не отдал дорожку (таймаут)" });
          return;
        }
        liveUrls.set(ref.id, cap.url);
        if (collect) await parseInto(ref, cap.body);
      };
      for (const ref of basesWanted) await loadBase(ref, true);
      for (const id of hiddenBaseIds) {
        const ref = this.refForBaseId(id);
        if (ref) await loadBase(ref, false);
      }
      await transport.end();
    } else {
      for (const ref of refs) failures.push({ ref, reason: "плеер страницы недоступен" });
    }

    // Переводы — параллельным fetch поверх живых URL (подпись не покрывает
    // tlang); без живых URL (плеер недоступен) не пробуем — уже отказаны.
    // 429/5xx — платформа рейт-лимитит серийные запросы: повтор с паузой.
    // Таймаут на попытку (duopulse-092): зависший после SSAI-цепочки запрос
    // не резолвился никогда — selectTracks вис без failures; таймаут даёт
    // честный отказ, ретрай включения (1.5 с в enableSubs) — второй шанс.
    const TRANSLATION_TIMEOUT_MS = 20_000;
    const fetchTranslation = async (url: string): Promise<{ ok: boolean; status: number; body: string }> => {
      let res: Awaited<ReturnType<typeof fetchImpl>> | null = null;
      for (let i = 0; i < 3; i++) {
        res = await fetchImpl(url, {
          credentials: "include",
          signal: AbortSignal.timeout(TRANSLATION_TIMEOUT_MS),
        });
        if (res.status !== 429 && res.status < 500) break;
        await sleep((i + 1) * 6_000);
      }
      const body = res ? await res.text().catch(() => "") : "";
      return { ok: res?.ok ?? false, status: res?.status ?? 0, body };
    };
    if (began) {
      await Promise.all(
        translations.map(async (ref) => {
          const live = ref.baseId ? liveUrls.get(ref.baseId) : undefined;
          if (!live) {
            failures.push({ ref, reason: "базовая дорожка не получена" });
            return;
          }
          try {
            const res = await fetchTranslation(buildTranslationUrl(live, ref.lang));
            if (!res.ok) {
              failures.push({ ref, reason: `HTTP ${res.status}` });
              return;
            }
            if (!res.body) {
              failures.push({ ref, reason: "пустой ответ перевода" });
              return;
            }
            await parseInto(ref, res.body);
          } catch (e) {
            failures.push({ ref, reason: errorMessage(e) });
          }
        }),
      );
    }
    const tracks = refs.map((r) => parsedById.get(r.id)).filter((t): t is Track => !!t);
    return { tracks, failures, usedPath: began ? transport.usedPath : "недоступен" };
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
