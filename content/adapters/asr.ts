// Распознавание речи — ASR (карточка duopulse-060): URL аудио добывает
// content-слой (контекст страницы: адаптер YouTube из player-ответа, «голое»
// видео — src/currentSrc), конвейер — в Core (WebMessage «asr-begin» →
// src/asr/pipeline.rs: самофетч через SOCKS5-роутер → декод 16 кГц моно →
// чанки 5 мин → движок (локальный whisper-server / OpenAI-совместимое
// облако) → кэш SQLite). Ответ приходит document-событием
// duopulse-asr-track — eval'ом активной вкладки на главном потоке (паттерн
// translate-track, задача 4.2). Прогресс панель получает событием контракта
// subtitles:asr_progress, здесь — только итог.
//
// Дорожка ответа — оригинал набора (source "asr", role "original"): видео
// без дорожек платформы получает строку субтитров из собственной речи.

import type { Cue, Track } from "../types";

/** Порты для юнит-тестов (jsdom без window.chrome.webview). */
export interface AsrPorts {
  /** WebMessage в Core (content/messaging postToCore). */
  post(message: Record<string, unknown>): void;
}

/** Ответ конвейера (document-событие duopulse-asr-track). */
export interface AsrReply {
  reqId: number;
  ok: boolean;
  /** Распознанные cue (ok=true). */
  cues?: { startMs: number; endMs: number; text: string }[];
  /** Язык речи (запрошенный или определённый движком). */
  lang?: string;
  /** Идентификатор движка («local:whisper» / «openai:whisper-1»). */
  engine?: string;
  /** Дорожка отдана кэшем — сети не было. */
  fromCache?: boolean;
  error?: string;
}

/** Состояние последнего запроса (диагностика/e2e). */
export interface AsrStatus {
  /** Ожидает ответа конвейера Core. */
  pending: boolean;
  lastReply: { ok: boolean; fromCache: boolean; cueCount: number; lang: string; error: string } | null;
}

let nextReqId = 1;
const pendingReplies = new Map<number, (reply: AsrReply) => void>();
const listeningDocs = new WeakSet<object>();
let status: AsrStatus = { pending: false, lastReply: null };

/** Слушатель события-ответа ставится один раз на каждый документ. */
function ensureListening(doc: Document): void {
  if (listeningDocs.has(doc)) return;
  listeningDocs.add(doc);
  doc.addEventListener("duopulse-asr-track", (e) => {
    const detail = (e as CustomEvent<AsrReply>).detail;
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
        lang: typeof detail.lang === "string" ? detail.lang : "",
        error: typeof detail.error === "string" ? detail.error : "",
      },
    };
    resolve(detail);
  });
}

/** Запрос транскрипции аудио: WebMessage с URL, ответ — промис по reqId.
 * Вкладка могла уйти навигацией — промис не резолвится; Core отменяет
 * конвейер поколением при новом запросе/уходе с видео. */
export function requestAsrTrack(
  doc: Document,
  ports: AsrPorts,
  req: { videoKey: string; url: string; lang: string },
): Promise<AsrReply> {
  ensureListening(doc);
  const reqId = nextReqId++;
  status = { ...status, pending: true };
  return new Promise((resolve) => {
    pendingReplies.set(reqId, resolve);
    ports.post({ duopulse: "asr-begin", reqId, videoKey: req.videoKey, url: req.url, lang: req.lang });
  });
}

/** Сводный статус для диагностики (window.__duopulseContent). */
export function asrStatus(): AsrStatus {
  return status;
}

/** Дорожка из ответа конвейера: asr:<lang>, оригинал набора. Битые cue
 * (не объект/без чисел) снисходительно пропускаются; пустой ответ — null. */
export function asrTrackFrom(lang: string, engine: string, cues: readonly unknown[]): Track | null {
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
  const label = engine.startsWith("openai:") ? "ASR (облако)" : "ASR";
  const name = lang ? `${label} · ${lang}` : label;
  return {
    id: `asr:${lang || "auto"}`,
    source: "asr",
    lang: lang || "auto",
    role: "original",
    cues: out,
    name,
  };
}
