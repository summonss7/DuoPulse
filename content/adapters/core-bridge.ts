// Мост content → Core для фолбэка дорожек YouTube (карточка duopulse-228):
// запросы с сетевой работой в ядре — WebMessage с reqId, ответ —
// document-событием eval'ом вкладки (паттерн duopulse-asr-track, карточка
// duopulse-060; WebMessage-ответы PostWebMessageAsString приходят ТОЛЬКО
// top-level документу, а фолбэк нужен и там — потому событием).
//
// - yt-fallback: player-ответ innertube (ANDROID) для видео, чей страницевой
//   ответ без captions (деградированная анонимная сессия YouTube, см. шапку
//   src-tauri/src/yt_fallback.rs). Ядро отдаёт сырые объекты captionTracks/
//   translationLanguages — все знания о YouTube остаются в адаптере.
// - gtx-translate: перевод пачки cue-текстов бесплатным gtx — переводы
//   tlang на фолбэк-дорожках невозможны (подпись baseUrl их не покрывает).
//
// Вне WebView2 (jsdom-тесты, обычный браузер) ответ не приходит — таймаут
// честно завершает промис отказом, адаптер деградирует прежним путём.

/** Порты для юнит-тестов (jsdom без window.chrome.webview). */
export interface CoreBridgePorts {
  /** WebMessage в Core (content/messaging postToCore). */
  post(message: Record<string, unknown>): void;
}

/** Ответ «yt-fallback» (событие duopulse-yt-fallback). */
export interface YtFallbackReply {
  reqId: number;
  ok: boolean;
  /** Сырые объекты captionTracks (ok=true, может быть пуст при их отсутствии). */
  tracks?: unknown[];
  /** Сырые объекты translationLanguages. */
  translations?: unknown[];
  error?: string;
}

/** Ответ «gtx-translate» (событие duopulse-gtx-translate). */
export interface GtxTranslateReply {
  reqId: number;
  ok: boolean;
  lines?: string[];
  error?: string;
}

const FALLBACK_TIMEOUT_MS = 20_000;
const GTX_TIMEOUT_MS = 60_000;

let nextReqId = 1;
const pending = new Map<string, { resolve: (v: never) => void; timer: number }>();
const listeningDocs = new WeakSet<object>();

function ensureListening(doc: Document): void {
  if (listeningDocs.has(doc)) return;
  listeningDocs.add(doc);
  doc.addEventListener("duopulse-yt-fallback", onReply);
  doc.addEventListener("duopulse-gtx-translate", onReply);
}

function onReply(e: Event): void {
  const detail = (e as CustomEvent<Record<string, unknown>>).detail;
  if (!detail || typeof detail !== "object" || typeof detail["reqId"] !== "number") return;
  const waiter = pending.get(`${e.type}:${detail["reqId"]}`);
  if (!waiter) return;
  pending.delete(`${e.type}:${detail["reqId"]}`);
  clearTimeout(waiter.timer);
  (waiter.resolve as (v: unknown) => void)(detail);
}

/** Запрос с reqId и таймаутом: Core отвечает document-событием event. */
function request<T>(doc: Document, ports: CoreBridgePorts, event: string, message: Record<string, unknown>, timeoutMs: number): Promise<T | null> {
  ensureListening(doc);
  const reqId = nextReqId++;
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      pending.delete(`${event}:${reqId}`);
      resolve(null);
    }, timeoutMs);
    pending.set(`${event}:${reqId}`, {
      resolve: resolve as (v: never) => void,
      timer,
    });
    ports.post({ duopulse: message["duopulse"], reqId, ...message });
  });
}

/** Дорожки видео фолбэком ядра (null — ответа нет: канал/таймаут). */
export function requestYtFallback(
  doc: Document,
  ports: CoreBridgePorts,
  videoId: string,
): Promise<YtFallbackReply | null> {
  return request<YtFallbackReply>(doc, ports, "duopulse-yt-fallback", { duopulse: "yt-fallback", videoId }, FALLBACK_TIMEOUT_MS);
}

/** Перевод пачки текстов gtx в ядре (null — ответа нет). */
export function requestGtxTranslate(
  doc: Document,
  ports: CoreBridgePorts,
  texts: string[],
  from: string,
  to: string,
): Promise<GtxTranslateReply | null> {
  return request<GtxTranslateReply>(
    doc,
    ports,
    "duopulse-gtx-translate",
    { duopulse: "gtx-translate", texts, from, to },
    GTX_TIMEOUT_MS,
  );
}
