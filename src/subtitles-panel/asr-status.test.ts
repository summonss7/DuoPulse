// Тексты статуса ASR-панели (карточка duopulse-060).

import { describe, expect, it } from "vitest";
import { asrProgressText } from "./asr-status";
import type { SubtitlesAsrProgress } from "../bridge/gen/types";

function progress(patch: Partial<SubtitlesAsrProgress>): SubtitlesAsrProgress {
  return {
    tabId: "tab-1",
    videoKey: "yt:v",
    engine: "local:whisper",
    phase: "transcribe",
    done: 0,
    total: 0,
    fromCache: false,
    error: null,
    ...patch,
  };
}

describe("asrProgressText", () => {
  it("фазы работы — прогрессные подписи", () => {
    expect(asrProgressText(progress({ phase: "model", done: 30 * 1_048_576, total: 148 * 1_048_576 })))
      .toContain("Скачивание модели");
    expect(asrProgressText(progress({ phase: "model", done: 0, total: 0 })))
      .toBe("Скачивание модели ASR…");
    expect(asrProgressText(progress({ phase: "audio", done: 1, total: 0 })))
      .toBe("Скачивание аудио…");
    expect(asrProgressText(progress({ phase: "decode" })))
      .toBe("Декодирование аудио…");
    expect(asrProgressText(progress({ phase: "transcribe", done: 1, total: 4 })))
      .toBe("Распознавание… 1 / 4");
    expect(asrProgressText(progress({ phase: "transcribe", done: 0, total: 1 })))
      .toBe("Распознавание речи…");
  });

  it("итог: сеть/кэш; ошибки с текстом", () => {
    expect(asrProgressText(progress({ phase: "done", done: 212, fromCache: false })))
      .toBe("Готово: распознано 212 реплик");
    expect(asrProgressText(progress({ phase: "done", done: 5, fromCache: true })))
      .toBe("Субтитры из кэша ASR (5 реплик)");
    expect(asrProgressText(progress({ phase: "error", error: "нет модели" })))
      .toBe("ASR: нет модели");
    expect(asrProgressText(progress({ phase: "error", error: null })))
      .toBe("ASR: ошибка");
    expect(asrProgressText(progress({ phase: "неизвестная" as SubtitlesAsrProgress["phase"] })))
      .toBe("");
  });
});
