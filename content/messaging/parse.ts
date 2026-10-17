// Разбор payload субтитров в Core (задача 3.3): канонические парсеры —
// src-tauri/src/subtitles (задача 3.1, единый источник логики разбора),
// транспорт — WebMessage content-вкладки (docs/05 §2): запрос
// {duopulse:"parse-subtitles", reqId, payload} → ответ
// {duopulse:"subtitles-parsed", reqId, ok, cues, warnings} тому же документу.
// Вне WebView2 (jsdom-тесты, обычный браузер) канала нет — parse отвергается,
// вызывающий (адаптер) фиксирует отказ по дорожке, без падения страницы.

import { hasCoreChannel, onCoreMessage, postToCore } from "./index";
import type { SubtitlesParser } from "../adapters/types";
import type { Cue } from "../types";

const PARSE_TIMEOUT_MS = 20_000;

interface PendingParse {
  resolve: (value: { cues: Cue[]; warnings: string[] }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<number, PendingParse>();
let subscribed = false;
let reqSeq = 0;

function ensureSubscription(): boolean {
  if (subscribed) return true;
  if (!hasCoreChannel()) return false; // вне WebView2 разбора в Core не будет
  onCoreMessage((message) => {
    if (message["duopulse"] !== "subtitles-parsed") return;
    const reqId = typeof message["reqId"] === "number" ? message["reqId"] : null;
    if (reqId === null || !pending.has(reqId)) return;
    const entry = pending.get(reqId)!;
    pending.delete(reqId);
    clearTimeout(entry.timer);
    if (message["ok"] === true && Array.isArray(message["cues"])) {
      const cues: Cue[] = [];
      for (const c of message["cues"]) {
        if (!c || typeof c !== "object") continue;
        const cue = c as Record<string, unknown>;
        if (typeof cue["startMs"] !== "number" || typeof cue["endMs"] !== "number") continue;
        cues.push({ startMs: cue["startMs"], endMs: cue["endMs"], text: String(cue["text"] ?? "") });
      }
      const warnings = Array.isArray(message["warnings"])
        ? message["warnings"].filter((w): w is string => typeof w === "string")
        : [];
      entry.resolve({ cues, warnings });
    } else {
      entry.reject(new Error(String(message["error"] ?? "Core не смог разобрать payload")));
    }
  });
  subscribed = true;
  return true;
}

/** Парсер поверх WebMessage-канала до Core (строгая очередь reqId). */
export function createCoreParser(): SubtitlesParser {
  return {
    parse(payload: string): Promise<{ cues: Cue[]; warnings: string[] }> {
      if (!ensureSubscription()) {
        return Promise.reject(new Error("канал до Core недоступен"));
      }
      const reqId = ++reqSeq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(reqId);
          reject(new Error("таймаут разбора в Core"));
        }, PARSE_TIMEOUT_MS);
        pending.set(reqId, { resolve, reject, timer });
        postToCore({ duopulse: "parse-subtitles", reqId, payload });
      });
    },
  };
}
