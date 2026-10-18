// Облачный перевод дорожки (задача 4.2, docs/03 §7): cues — у content-слоя,
// конвейер — в Core (WebMessage «translate-track» → src/translate/pipeline.rs:
// кэш SQLite → пачки ≤ 2 КБ с контекстом предыдущей → провайдер → кэш).
// Ответ приходит document-событием duopulse-translate-track — eval'ом активной
// вкладки на главном потоке (паттерн duopulse-file-track, задача 3.6).
// Прогресс панель получает событием контракта subtitles:translate_progress —
// напрямую из Core (WebMessage-канал его не доставляет), здесь — только итог.
//
// Дорожка ответа — полноценный участник набора (source "translate"): тайминги
// наследуются у исходной (переводим тексты, не сетку cue).

import type { Cue, Track } from "../types";

/** Порты для юнит-тестов (jsdom без window.chrome.webview). */
export interface CloudTranslatePorts {
  /** WebMessage в Core (content/messaging postToCore). */
  post(message: Record<string, unknown>): void;
}

/** Ответ конвейера (document-событие duopulse-translate-track). */
export interface CloudTranslateReply {
  reqId: number;
  ok: boolean;
  /** Переведённые cue (ok=true): сетка таймингов исходной дорожки. */
  cues?: { startMs: number; endMs: number; text: string }[];
  /** Имя дорожки для панели («DeepL → ru»). */
  name?: string;
  /** Дорожка отдана кэшем — сети не было (DoD 4.2). */
  fromCache?: boolean;
  error?: string;
}

/** Состояние одной выполняемой просьбы (диагностика/e2e). */
export interface CloudTranslateStatus {
  /** Ожидает ответа конвейера Core. */
  pending: boolean;
  /** Последний итог: ok / текст ошибки. */
  lastReply: { ok: boolean; fromCache: boolean; cueCount: number; name: string; error: string } | null;
}

let nextReqId = 1;
const pendingReplies = new Map<number, (reply: CloudTranslateReply) => void>();
const listeningDocs = new WeakSet<object>();
let status: CloudTranslateStatus = { pending: false, lastReply: null };

/** Слушатель события-ответа ставится один раз на каждый документ. */
function ensureListening(doc: Document): void {
  if (listeningDocs.has(doc)) return;
  listeningDocs.add(doc);
  doc.addEventListener("duopulse-translate-track", (e) => {
    const detail = (e as CustomEvent<CloudTranslateReply>).detail;
    if (!detail || typeof detail !== "object" || typeof detail.reqId !== "number") return;
    const resolve = pendingReplies.get(detail.reqId);
    if (!resolve) return;
    pendingReplies.delete(detail.reqId);
    status = {
      pending: pendingReplies.size > 0,
      lastReply: {
        ok: detail.ok === true,
        fromCache: detail.fromCache === true,
        cueCount: Array.isArray(detail.cues) ? detail.cues.length : 0,
        name: typeof detail.name === "string" ? detail.name : "",
        error: typeof detail.error === "string" ? detail.error : "",
      },
    };
    resolve(detail);
  });
}

/** Запрос перевода дорожки: WebMessage с cue, ответ — промис по reqId.
 * Вкладка могла уйти навигацией (ответ не придёт) — промис не резолвится,
 * набор не трогаем; конвейер Core прервать нельзя, но ответ просто некому
 * доставить (ошибка доставки не критична, pipeline.rs). */
export function requestCloudTranslation(
  doc: Document,
  ports: CloudTranslatePorts,
  req: {
    videoKey: string;
    trackId: string;
    sourceLang: string;
    targetLang: string;
    cues: readonly Cue[];
  },
): Promise<CloudTranslateReply> {
  ensureListening(doc);
  const reqId = nextReqId++;
  status = { ...status, pending: true };
  return new Promise((resolve) => {
    pendingReplies.set(reqId, resolve);
    ports.post({
      duopulse: "translate-track",
      reqId,
      videoKey: req.videoKey,
      trackId: req.trackId,
      sourceLang: req.sourceLang,
      targetLang: req.targetLang,
      cues: req.cues.map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text })),
    });
  });
}

/** Сводный статус для диагностики (window.__duopulseContent). */
export function cloudTranslateStatus(): CloudTranslateStatus {
  return status;
}

/** Дорожка из ответа конвейера: сетка таймингов исходной, текст — перевод.
 * Битые cue (не объект/без чисел) снисходительно пропускаются (паттерн
 * duopulse-file-track); пустой ответ — null (дорожку не строим). */
export function cloudTrackFrom(
  targetLang: string,
  name: string,
  cues: readonly unknown[],
): Track | null {
  const out: Cue[] = [];
  for (const c of cues) {
    if (!c || typeof c !== "object") continue;
    const cue = c as Record<string, unknown>;
    if (typeof cue["startMs"] !== "number" || typeof cue["endMs"] !== "number") continue;
    out.push({
      startMs: cue["startMs"],
      endMs: cue["endMs"],
      text: String(cue["text"] ?? ""),
    });
  }
  if (out.length === 0) return null;
  return {
    id: `cloud:${targetLang}`,
    source: "translate",
    lang: targetLang,
    role: "translation",
    cues: out,
    name,
  };
}
