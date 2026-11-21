// Дорожки субтитров из плеер-фреймов кино-сайтов (карточка duopulse-199,
// техзадание из разбора duopulse-198): uakinogo.io крутит фильмы в кросс-
// доменном OOPIF-фрейме (api.embf.net/embed/…), где инлайн-конфиг
// makePlayer({... source.cc:[{url:"….vtt",name:"Eng. full - 1"},…] })
// держит подписанные .vtt (оригинальный английский + укр/рус дорожки).
//
// Контентный WebMessage-канал WebView2 во фреймы не достаёт (ответ
// PostWebMessage доставляется только top-level документу — тот же пробел,
// что у адблока до duopulse-188), но init-script бандла исполняется во ВСЕХ
// фреймах (AddScriptToExecuteOnDocumentCreated — top-level + child frames),
// а стандартный window.postMessage работает через origin-границу всегда.
// Поэтому мост — двухсторонний relay «фрейм ↔ top-документ»:
//
//   фрейм (FrameAgent):                    top (EmbedHost):
//   • VideoDetector своего документа       • «video» → виртуальное видео
//     + парсер инлайн-конфига плеера         (iframe-элемент = геометрия
//     (embf makePlayer + generic <track>)    плашки, FrameVideoProxy = часы
//   • часы: timeupdate → parent             движка с интерполяцией)
//   • fetch .vtt своим origin (CDN отдаёт   • «cues» → канонический парсер
//     ACAO только origin фрейма — топу CORS   Core (parse-subtitles), дальше
//     запрещён)                                общий конвейер набора/панели
//   • drag&drop .srt/.vtt внутри фрейма    • «file» → buildFileTracks — тот
//     (дроп над плеером раньше терялся)       же путь, что дроп по странице
//
// Всё клиентское: Rust/Core не меняется — top-бандл остаётся единственным
// голосом вкладки (состояние, панель «duo», перевод, кэш — прежние пути).

import { VideoDetector, type DetectedVideo } from "../detector";
import { pickSubtitleFiles } from "./file";
import type { VideoLike } from "../engine/subtitles-engine";
import type { Cue, Track } from "../types";

/** Маркер протокола: window.postMessage(JSON) между фреймом и top-документом.
 * Чужие postMessage страницы его не содержат — игнорируются. */
const FRAME_MSG_FIELD = "duopulseFrame";

// --- разбор инлайн-конфигов плееров ------------------------------------------

/** Дорожка субтитров из конфига плеера (подписанный URL живёт недолго —
 * читается рантаймом из фрейма, грузится тоже из фрейма). */
export interface EmbedTrackInfo {
  /** id набора: `embed:<lang>:<index>` — стабилен внутри одной загрузки. */
  id: string;
  lang: string;
  name: string;
  url: string;
  /** Дорожка языка оригинала фильма (по сигналам аудио-дубляжей плеера). */
  original: boolean;
}

/** Язык по имени дорожки плеера («Eng. full - 1» → en, «Укр. повні» → uk):
 * кино-плееры маркируют дорожки короткими префиксами; нераспознанное — und
 * (дорожка всё равно выбираема, имя видно в панели). */
export function langOfTrackName(name: string): string {
  const rules: readonly [RegExp, string][] = [
    [/^(eng|english|англ)/i, "en"],
    [/^(укр)/i, "uk"],
    [/^(рус|рос)/i, "ru"],
    [/^(pol|пол(ськ|ск)?\b|польс)/i, "pl"],
    [/^(нім|нем|ger|deutsch)/i, "de"],
    [/^(фран|fra|fre)/i, "fr"],
    [/^(ісп|исп|spa|esp)/i, "es"],
    [/^(італ|итал|ita)/i, "it"],
  ];
  for (const [re, lang] of rules) if (re.test(name)) return lang;
  return "und";
}

/** Базовый код языка без подтега и регистра — сравнение с целью перевода. */
function embedBaseLang(lang: string): string {
  return lang.trim().toLowerCase().split("-")[0] ?? "";
}

/** Решение об автопереводе дорожки плеер-фрейма (duopulse-196: дуо на
 * «других видеохостингах» — кино-плееры отдают только оригинал без tlang,
 * вторую строку-перевод поднимает облако; цель — правило дуо
 * defaultTranslationTarget: русский → en, прочие → ru). Чистая функция —
 * применение и телеметрия в duopulse-content; согласие и отказ — тот же
 * паттерн, что у файлового автоперевода (duopulse-177). */
export interface AutoTranslateEmbedArgs {
  platformTracks: readonly Track[];
  translateTracks: readonly Track[];
  fileTracks: readonly Track[];
  /** Целевой язык — defaultTranslationTarget(языка оригинала). */
  targetLang: string;
  /** lastDuoEnabled() === true — согласие (показ включён/был включён). */
  consent: boolean;
  /** Автоперевод за это видео уже снимали — не навязываемся. */
  declined: boolean;
}

export interface AutoTranslateEmbedDecision {
  run: boolean;
  /** Дорожка-источник (run=true). */
  source: Track | null;
}

export function autoTranslateEmbedDecision(args: AutoTranslateEmbedArgs): AutoTranslateEmbedDecision {
  // Сценарий «дефолт-набор»: ровно одна платформенная дорожка — оригинал
  // плеер-фрейма (пользователь ещё не собирал свой состав), файлов нет.
  const solo =
    args.platformTracks.length === 1
      ? args.platformTracks[0]
      : null;
  const source = solo && solo.source === "embed" && solo.role === "original" ? solo : null;
  const target = embedBaseLang(args.targetLang);
  const run =
    args.consent &&
    !args.declined &&
    source !== null &&
    source.cues.length > 0 &&
    embedBaseLang(source.lang) !== "" &&
    embedBaseLang(source.lang) !== "und" &&
    target !== "" &&
    embedBaseLang(source.lang) !== target &&
    args.fileTracks.length === 0 &&
    !args.translateTracks.some((t) => embedBaseLang(t.lang) === target);
  return { run, source: run ? source : null };
}

/** Выдержка строкового литерала JS (`"…"`/`'…'`) с JSON-эскейпами; null —
 * литерал не на позиции (или не строка). */
function jsStringAt(src: string, pos: number): string | null {
  const q = src[pos];
  if (q !== '"' && q !== "'") return null;
  let out = "";
  for (let i = pos + 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") {
      const next = src[i + 1];
      if (next === undefined) return null;
      // Стандартные эскейпы литералов; \uXXXX понимает и JSON.parse кавычки.
      if (next === "u") {
        const hex = src.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 5;
          continue;
        }
        return null;
      }
      const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" };
      out += map[next] ?? next;
      i++;
      continue;
    }
    if (ch === q) return out;
    out += ch;
  }
  return null;
}

/** Позиция ДВОЕТОЧИЯ ключа в JS-объектном литерале: ключ бывает закавычен
 * (JSON-стиль `"url":`) или голым (`url:`); -1 — ключ не найден. Конфиг
 * плеера — невалидный JSON (функции внутри), разбор точечный, по ключу. */
function keyColonPos(src: string, key: string, from = 0): number {
  const quoted = src.indexOf(`"${key}":`, from);
  const bare = src.indexOf(`${key}:`, from);
  if (quoted >= 0 && (bare < 0 || quoted < bare)) return quoted + key.length + 2; // "…":
  if (bare >= 0) return bare + key.length; // …:
  return -1;
}

/** Значение ключа `key` (строка или число) от позиции from. */
function jsFieldValue(src: string, key: string, from = 0): string | null {
  const colon = keyColonPos(src, key, from);
  if (colon < 0) return null;
  let i = colon + 1;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] === '"' || src[i] === "'") return jsStringAt(src, i);
  const num = /^\d+(\.\d+)?/.exec(src.slice(i, i + 24));
  return num ? num[0] : null;
}

/** Сбалансированный скан от открывающей `[`: тело массива до парной `]`
 * (учитывая строковые литералы — скобки внутри строк не считаются). */
function bracketBody(src: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      const s = jsStringAt(src, i);
      if (s === null) return null;
      i += s.length + 1; // перескакиваем литерал целиком (+ кавычки)
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

/** Текст инлайн-<script>ов документа, содержащий вызов плеера (embf:
 * makePlayer({...})). Конфиг исполняется при загрузке, но его литерал
 * остаётся в DOM — читаем после DCL, когда плеер уже строится. */
function playerConfigText(doc: Document): string {
  let out = "";
  for (const s of Array.from(doc.querySelectorAll("script"))) {
    const text = s.textContent ?? "";
    if (text.includes("makePlayer(")) out += `\n${text}`;
  }
  return out;
}

/** Дорожки .vtt из конфига embf-плеера: массив `cc:[{url,name},…]` внутри
 * аргумента makePlayer плюс аудио-дубляжи `source.audio.names` (сигнал
 * «Eng.Original» помечает язык оригинала). Карточка duopulse-198 §2:
 * подписанные URL краткоживущие — использовать сразу после чтения. */
export function parseMakePlayerCc(doc: Document): EmbedTrackInfo[] {
  const src = playerConfigText(doc);
  const tracks: EmbedTrackInfo[] = [];
  const seen = new Set<string>();
  // cc:[ — первый массив после ключа (внутри source:{…}).
  const ccAt = src.indexOf("cc:");
  let originalLang = "";
  if (src && ccAt >= 0) {
    // Аудио-дубляжи рядом (source.audio.names — массив): «Eng.Original» в
    // списке — сигнал языка оригинала фильма. Берём names только между
    // audio: и cc:, чтобы не поймать чужой ключ из другого места скрипта.
    const audioAt = src.lastIndexOf("audio:", ccAt);
    let audioNames: string | null = null;
    if (audioAt >= 0) {
      const region = src.slice(audioAt, ccAt);
      const colon = keyColonPos(region, "names");
      const open = colon >= 0 ? region.indexOf("[", colon) : -1;
      audioNames = open >= 0 ? bracketBody(region, open) : null;
    }
    if (audioNames && /(eng|english|англ)[.\s]*original/i.test(audioNames)) originalLang = "en";
    const open = src.indexOf("[", ccAt);
    const body = open >= 0 ? bracketBody(src, open) : null;
    if (body !== null) {
      for (let i = 0; i < body.length; i++) {
        if (body[i] !== "{") continue;
        // Объект {url,name} мал — разбираем ключами по позиции объекта.
        const end = findObjectEnd(body, i);
        if (end === null) break;
        const chunk = body.slice(i, end);
        i = end;
        const url = jsFieldValue(chunk, "url");
        if (!url || !/^https?:\/\//i.test(url)) continue;
        if (seen.has(url)) continue;
        seen.add(url);
        const rawName = jsFieldValue(chunk, "name") ?? `track ${seen.size}`;
        const name = rawName.replace(/\s*-\s*\d+\s*$/, ""); // «Eng. full - 1» → «Eng. full»
        const lang = langOfTrackName(rawName);
        tracks.push({
          id: `embed:${lang}:${seen.size - 1}`,
          lang,
          name,
          url,
          original: originalLang !== "" && lang === originalLang,
        });
      }
    }
  }
  // Generic-путь: <track> в DOM (плееры, вкладывающие субтитры элементом).
  for (const t of Array.from(doc.querySelectorAll("track"))) {
    const el = t as HTMLTrackElement;
    const url = el.src;
    if (!url || !/^https?:/i.test(url) || seen.has(url)) continue;
    const kind = (el.kind || "").toLowerCase();
    if (kind && kind !== "captions" && kind !== "subtitles") continue;
    seen.add(url);
    const name = el.label || el.getAttribute("srclang") || `track ${seen.size}`;
    const lang = el.srclang || langOfTrackName(name);
    tracks.push({ id: `embed:${lang}:${seen.size - 1}`, lang, name, url, original: false });
  }
  return tracks;
}

/** Конец объектного литерала `{…}` от pos (баланс скобок со строками). */
function findObjectEnd(src: string, pos: number): number | null {
  let depth = 0;
  for (let i = pos; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      const s = jsStringAt(src, i);
      if (s === null) return null;
      i += s.length + 1;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

// --- агент во фрейме ----------------------------------------------------------

/** Документ — фрейм (не top-level): сюда контент-канал Core не достаёт,
 * полноценный бандл не нужен — работает агент-ретранслятор. */
export function isFrameContext(): boolean {
  try {
    return window.parent !== window;
  } catch {
    return false;
  }
}

interface FrameAgentClock {
  t: number;
  paused: boolean;
  rate: number;
}

/** Агент плеер-фрейма: детект <video> своего документа + дорожки конфига
 * плеера + часы воспроизведения + загрузка .vtt своим origin + ретрансляция
 * drag&drop. Живёт до навигации фрейма (новый документ — новый агент). */
export function startFrameAgent(): void {
  const w = window as unknown as { __duopulseFrameAgent?: unknown };
  if (w.__duopulseFrameAgent) return;
  w.__duopulseFrameAgent = true;

  const post = (msg: Record<string, unknown>): void => {
    try {
      window.parent.postMessage({ [FRAME_MSG_FIELD]: true, ...msg }, "*");
    } catch {
      /* фрейм выгружается — тихо */
    }
  };

  let currentKey: string | null = null;
  let currentUrl: string | null = null;
  let reportedTracks = 0;
  let videoEl: HTMLVideoElement | null = null;
  let lastClockSent = 0;

  const sendClock = (force = false): void => {
    if (!videoEl || !currentKey) return;
    const now = Date.now();
    if (!force && now - lastClockSent < 100) return; // ~10 Гц потолок
    lastClockSent = now;
    const clock: FrameAgentClock = {
      t: videoEl.currentTime,
      paused: videoEl.paused,
      rate: videoEl.playbackRate,
    };
    post({ type: "clock", videoKey: currentKey, ...clock });
  };

  const announce = (): void => {
    if (!currentKey) return;
    // Треки перечитываем на каждый анонс: конфиг статичен, но детект видео
    // приходит и позже DCL (плеер строит DOM скриптом), а <track> плеер может
    // добавить со задержкой.
    const tracks = parseMakePlayerCc(document);
    reportedTracks = tracks.length;
    post({
      type: "video",
      videoKey: currentKey,
      url: currentUrl ?? location.href,
      tracks: tracks.map((t) => ({ ...t })),
    });
  };

  const attachClock = (el: HTMLVideoElement): void => {
    if (videoEl === el) return;
    if (videoEl) {
      videoEl.removeEventListener("timeupdate", onClockEvent);
      videoEl.removeEventListener("pause", onClockEvent);
      videoEl.removeEventListener("play", onClockEvent);
      videoEl.removeEventListener("seeked", onClockEvent);
      videoEl.removeEventListener("ratechange", onClockEvent);
    }
    videoEl = el;
    el.addEventListener("timeupdate", onClockEvent);
    el.addEventListener("pause", onClockEvent);
    el.addEventListener("play", onClockEvent);
    el.addEventListener("seeked", onClockEvent);
    el.addEventListener("ratechange", onClockEvent);
  };
  const onClockEvent = (): void => sendClock();

  const detector = new VideoDetector({
    onVideo(video: DetectedVideo): void {
      currentKey = video.videoKey;
      currentUrl = video.url;
      attachClock(video.el);
      announce();
      // Поздние <track>/конфиг (плеер достраивает DOM): один пере-анонс.
      window.setTimeout(() => {
        if (currentKey === video.videoKey && parseMakePlayerCc(document).length !== reportedTracks) {
          announce();
        }
      }, 2000);
    },
    onVideoLost(): void {
      post({ type: "bye", videoKey: currentKey });
      currentKey = null;
      videoEl = null;
    },
  });
  detector.start();

  // Сердцебиение: events зависли (плеер глушит timeupdate в фоне) —
  // top-прокси держит свежие часы раз в секунду.
  window.setInterval(() => sendClock(true), 1000);

  // Загрузка дорожки: URL подписан под origin фрейма — fetch отсюда
  // (CDN отдаёт ACAO только api.embf.net, топу CORS запрещён).
  window.addEventListener("message", (e: MessageEvent) => {
    const data = e.data as Record<string, unknown> | null;
    if (!data || !(FRAME_MSG_FIELD in data)) return;
    if (data["type"] !== "load" || typeof data["reqId"] !== "number" || typeof data["url"] !== "string") return;
    const reqId = data["reqId"];
    const url = data["url"] as string;
    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const payload = await r.text();
        post({ type: "cues", reqId, ok: true, payload });
      })
      .catch((err: unknown) => {
        post({ type: "cues", reqId, ok: false, error: String((err as Error)?.message ?? err) });
      });
  });

  // Drag&drop внутри фрейма: дроп над областью плеера адресуется документу
  // ФРЕЙМА — top-бандл его не видел вовсе (duopulse-198: «ручной .srt на
  // странице фильма не заводился»). Файлы читаем здесь, разбор — в топе.
  const dropped = (e: DragEvent): void => {
    const dt = e.dataTransfer;
    if (!dt || !Array.from(dt.types ?? []).includes("Files")) return;
    const files = pickSubtitleFiles(Array.from(dt.files ?? []));
    if (files.length === 0) return; // не наш дроп — сайту/плееру
    e.preventDefault();
    e.stopPropagation();
    // File.text() читает файл целиком (реальные File из dataTransfer);
    // разбор — в топе (агент не имеет канала до парсеров Core).
    void Promise.all(
      files.slice(0, 3).map(async (f) => ({ name: f.name, text: await f.text() })),
    )
      .then((list) => {
        for (const f of list) if (f.text) post({ type: "file", name: f.name, text: f.text });
      })
      .catch(() => {
        /* чтение упало — файл молча пропускаем */
      });
  };
  const allowDrop = (e: DragEvent): void => {
    const dt = e.dataTransfer;
    if (!dt || !Array.from(dt.types ?? []).includes("Files")) return;
    e.preventDefault(); // разрешить дроп (иначе браузер откроет файл)
    dt.dropEffect = "copy";
  };
  window.addEventListener("dragover", allowDrop, { capture: true, passive: false });
  window.addEventListener("drop", dropped, { capture: true });

  window.addEventListener("pagehide", () => {
    if (currentKey) post({ type: "bye", videoKey: currentKey });
  });

  w.__duopulseFrameAgent = {
    state(): { videoKey: string | null; tracks: number; url: string } {
      return { videoKey: currentKey, tracks: reportedTracks, url: currentUrl ?? location.href };
    },
  };
}

// --- часы топ-документа -------------------------------------------------------

/** Часы кадра фрейма в топ-документе: VideoLike для движка — время
 * интерполируется между сообщениями фрейма (timeupdate ~4 Гц + сердцебиение
 * 1 Гц), подписки timeupdate тикают своим интервалом (нативных событий нет). */
export class FrameVideoProxy implements VideoLike {
  private t = 0;
  private wall = 0;
  private paused = true;
  private rate = 1;
  private listeners = new Map<string, Set<() => void>>();
  private timer: number | null = null;

  get currentTime(): number {
    if (this.paused) return this.t;
    const elapsed = (performance.now() - this.wall) / 1000;
    return this.t + elapsed * this.rate;
  }

  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
    if (type === "timeupdate" && this.timer === null) {
      // Частота нативного timeupdate (~4 Гц): движок живёт как на обычном
      // видео, покадровой точности rVFC через границу фрейма нет.
      this.timer = window.setInterval(() => this.fire("timeupdate"), 250);
    }
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** Новое состояние часов от агента фрейма. */
  update(t: number, paused: boolean, rate: number): void {
    this.t = t;
    this.wall = performance.now();
    this.paused = paused;
    this.rate = rate;
    this.fire("timeupdate");
  }

  /** Остановить интервал (видео фрейма ушло). */
  dispose(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.listeners.clear();
  }

  private fire(type: string): void {
    for (const l of this.listeners.get(type) ?? []) l();
  }
}

// --- хост в top-документе -----------------------------------------------------

/** Виртуальное видео из фрейма: iframe — геометрия плашки/скриншотов,
 * proxy — часы движка. el приводится к HTMLVideoElement только ради
 * существующих сигнатур оверлея/HUD (используют rect и ResizeObserver). */
export interface FrameVideo {
  videoKey: string;
  url: string;
  el: HTMLVideoElement;
  proxy: FrameVideoProxy;
  tracks: EmbedTrackInfo[];
}

export interface EmbedHostHandlers {
  /** Фрейм сообщил видео (первично или обновило дорожки того же ключа). */
  onVideo(video: FrameVideo): void;
  /** Видео фрейма ушло (навигация/удаление iframe). */
  onGone(videoKey: string): void;
  /** Ручной файл, брошенный внутри фрейма (текст уже прочитан агентом). */
  onFile(name: string, text: string): void;
}

/** Состояние хоста (диагностика e2e: __duopulseContent.state().embed). */
export interface EmbedHostState {
  frames: number;
  videoKey: string | null;
  tracks: { id: string; lang: string; name: string }[];
}

/** Приём сообщений агентов фреймов в top-документе: событие «message»,
 * источник матчится с iframe страницы (их contentWindow уникален). */
export class EmbedHost {
  private readonly handlers: EmbedHostHandlers;
  private frame: { el: HTMLIFrameElement; key: string; proxy: FrameVideoProxy; tracks: EmbedTrackInfo[] } | null = null;
  private pending = new Map<number, (r: { ok: boolean; payload?: string; error?: string }) => void>();
  private reqSeq = 0;
  private watchdog: number | null = null;

  constructor(handlers: EmbedHostHandlers) {
    this.handlers = handlers;
  }

  start(): void {
    window.addEventListener("message", (e: MessageEvent) => this.onMessage(e));
    // Сторож: iframe удалён из DOM (переключение плееров/SPA) — сообщение
    // «bye» не придёт, но и часов больше нет.
    this.watchdog = window.setInterval(() => this.checkAlive(), 1000);
  }

  private onMessage(e: MessageEvent): void {
    const data = e.data as Record<string, unknown> | null;
    if (!data || typeof data !== "object" || !(FRAME_MSG_FIELD in data)) return;
    const type = data["type"];
    if (type === "clock") {
      const key = data["videoKey"];
      if (typeof key === "string" && this.frame?.key === key) {
        this.frame.proxy.update(
          Number(data["t"]) || 0,
          data["paused"] === true,
          Number(data["rate"]) || 1,
        );
      }
      return;
    }
    if (type === "cues") {
      const reqId = Number(data["reqId"]);
      const resolve = this.pending.get(reqId);
      if (resolve) {
        this.pending.delete(reqId);
        resolve({ ok: data["ok"] === true, payload: typeof data["payload"] === "string" ? data["payload"] : undefined, error: typeof data["error"] === "string" ? data["error"] : undefined });
      }
      return;
    }
    if (type === "file") {
      const name = typeof data["name"] === "string" ? data["name"] : "";
      const text = typeof data["text"] === "string" ? data["text"] : "";
      if (name && text) this.handlers.onFile(name, text);
      return;
    }
    if (type === "bye") {
      const key = data["videoKey"];
      if (typeof key === "string") this.dropFrame(key);
      return;
    }
    if (type !== "video") return;
    // «video»: найти iframe отправителя по contentWindow.
    const el = this.iframeBySource(e.source);
    if (!el) return; // фрейм без элемента (уже удалён) — мимо
    const key = typeof data["videoKey"] === "string" ? data["videoKey"] : "";
    if (!key) return;
    const url = typeof data["url"] === "string" ? data["url"] : "";
    const tracks = Array.isArray(data["tracks"])
      ? (data["tracks"] as EmbedTrackInfo[]).filter(
          (t) => t && typeof t.url === "string" && typeof t.id === "string",
        )
      : [];
    if (this.frame && this.frame.key !== key) this.frame.proxy.dispose();
    const proxy = this.frame && this.frame.key === key ? this.frame.proxy : new FrameVideoProxy();
    this.frame = { el, key, proxy, tracks };
    this.handlers.onVideo({ videoKey: key, url, el: el as unknown as HTMLVideoElement, proxy, tracks });
  }

  /** iframe по source окна сообщения (protected — подмена в тестах). */
  protected iframeBySource(source: MessageEvent["source"]): HTMLIFrameElement | null {
    if (!source || source === window) return null;
    for (const f of Array.from(document.querySelectorAll("iframe"))) {
      const el = f as HTMLIFrameElement;
      if (el.contentWindow === source) return el;
    }
    return null;
  }

  private dropFrame(key: string): void {
    if (this.frame?.key !== key) return;
    this.frame.proxy.dispose();
    this.frame = null;
    this.handlers.onGone(key);
  }

  private checkAlive(): void {
    if (this.frame && !this.frame.el.isConnected) this.dropFrame(this.frame.key);
  }

  /** Загрузить .vtt дорожку через агента фрейма и разобрать парсером Core.
   * Возвращает cues; сбой сети/протухшая подпись — исключение (дорожка
   * получит пофактовый отказ, как у yt-загрузчика). */
  loadTrack(url: string, parse: (payload: string) => Promise<{ cues: Cue[]; warnings: string[] }>): Promise<Cue[]> {
    const frame = this.frame;
    if (!frame) return Promise.reject(new Error("плеер-фрейм недоступен"));
    const reqId = ++this.reqSeq;
    return new Promise<{ payload: string }>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error("таймаут загрузки дорожки из фрейма"));
      }, 15000);
      this.pending.set(reqId, (r) => {
        window.clearTimeout(timer);
        if (r.ok && r.payload !== undefined) resolve({ payload: r.payload });
        else reject(new Error(r.error || "фрейм не смог загрузить дорожку"));
      });
      frame.el.contentWindow?.postMessage({ [FRAME_MSG_FIELD]: true, type: "load", reqId, url }, "*");
    }).then((r) => parse(r.payload).then((parsed) => parsed.cues));
  }

  state(): EmbedHostState {
    return {
      frames: this.frame ? 1 : 0,
      videoKey: this.frame?.key ?? null,
      tracks: (this.frame?.tracks ?? []).map((t) => ({ id: t.id, lang: t.lang, name: t.name })),
    };
  }
}
