// @vitest-environment happy-dom
// Тесты ASR-контроллера мобильного duo (duopulse-167): полный цикл на фейках
// (invoke Core + транспорт фетчера iframe) — кэш-хит без скачивания,
// needAudio (ping → range-чанки → append → finish), отмена, ошибки, тексты
// прогресса (порт asr-status десктопа).
import { describe, expect, it, vi } from "vitest";
import {
  asrProgressText,
  createMobileAsr,
  type AsrInvoke,
  type AsrProgressEvent,
  type AsrRunResult,
  type AsrStartResult,
  type MobileAsrSettings,
} from "./asr";
import type { DlMessage, DlTransport } from "../download";

/** Фейковый транспорт фетчера (как download.test.ts, протокол v2). */
function fakeTransport(script: { file: number }): { transport: DlTransport; ranges: () => number } {
  let handler: ((m: DlMessage) => void) | null = null;
  let ranges = 0;
  const transport: DlTransport = {
    post(msg) {
      const m = msg as { cmd?: string; id?: string; offset?: number; length?: number };
      if (m.cmd === "ping") {
        setTimeout(() => handler?.({ id: m.id, type: "pong" }), 0);
        return;
      }
      if (m.cmd !== "range") return;
      ranges++;
      const offset = m.offset ?? 0;
      const bytes = Math.max(0, Math.min(m.length ?? 0, script.file - offset));
      setTimeout(() => handler?.({ id: m.id, type: "data", buf: new ArrayBuffer(bytes) }), 1);
    },
    subscribe(h) {
      handler = h;
      return () => {
        handler = null;
      };
    },
  };
  return { transport, ranges: () => ranges };
}

const RUN: AsrRunResult = {
  cues: [
    { startMs: 0, endMs: 1500, text: "привет" },
    { startMs: 1600, endMs: 2600, text: "мир" },
  ],
  lang: "ru",
  fromCache: false,
  engine: "openai:whisper-1",
};

function fakeInvoke(script: {
  start: AsrStartResult;
  finish?: AsrRunResult | Error;
  settings?: MobileAsrSettings;
}): { invoke: AsrInvoke; calls: Array<{ cmd: string; args?: Record<string, unknown> }> } {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const invoke: AsrInvoke = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "subtitles_asr_start") return script.start;
    if (cmd === "subtitles_asr_audio_append") return 1024;
    if (cmd === "subtitles_asr_audio_finish") {
      if (script.finish instanceof Error) throw script.finish;
      return script.finish ?? RUN;
    }
    if (cmd === "subtitles_asr_cancel") return null;
    if (cmd === "asr_get_settings")
      return script.settings ?? { enabled: true, openaiBaseUrl: "https://api.openai.com/v1", openaiModel: "whisper-1", hasApiKey: true };
    if (cmd === "asr_set_settings")
      return { enabled: true, openaiBaseUrl: "x", openaiModel: "whisper-1", hasApiKey: true };
    throw new Error(`неожиданная команда: ${cmd}`);
  };
  return { invoke, calls };
}

function makeAsr(script: { start: AsrStartResult; file?: number; finish?: AsrRunResult | Error }) {
  const { invoke, calls } = fakeInvoke(script);
  const { transport, ranges } = fakeTransport({ file: script.file ?? 8 * 1024 * 1024 });
  const asr = createMobileAsr({
    getFrame: () => null,
    doInvoke: invoke,
    transport,
    pingTimeoutMs: 500,
  });
  return { asr, calls, ranges };
}

describe("createMobileAsr — полный конвейер", () => {
  it("кэш-хит: start вернул done — скачивания нет, cues приходят как есть", async () => {
    const { asr, calls } = makeAsr({
      start: { status: "done", ...RUN, fromCache: true },
    });
    const r = await asr.recognize("iG9CE55wbtY", "ru");
    expect(r.fromCache).toBe(true);
    expect(r.cues).toHaveLength(2);
    // только start — ни append, ни finish
    expect(calls.map((c) => c.cmd)).toEqual(["subtitles_asr_start"]);
    expect(asr.stateSnapshot().busy).toBe(false);
  });

  it("needAudio: ping → диапазоны → append-чанки → finish возвращает дорожку", async () => {
    const { asr, calls, ranges } = makeAsr({
      start: { status: "needAudio", url: "https://rr.example.googlevideo.com/audio", size: 8 * 1024 * 1024 },
      file: 8 * 1024 * 1024,
    });
    const r = await asr.recognize("iG9CE55wbtY", "");
    expect(r.lang).toBe("ru");
    expect(r.cues[0].text).toBe("привет");
    // порядок команд конвейера
    expect(calls[0].cmd).toBe("subtitles_asr_start");
    const appends = calls.filter((c) => c.cmd === "subtitles_asr_audio_append");
    expect(appends.length).toBeGreaterThanOrEqual(1); // 8 МБ = 2 чанка по 4 МБ
    expect(appends[0].args?.videoId).toBe("iG9CE55wbtY");
    expect(typeof appends[0].args?.b64).toBe("string");
    expect(calls[calls.length - 1].cmd).toBe("subtitles_asr_audio_finish");
    expect(ranges()).toBeGreaterThanOrEqual(2);
    expect(asr.stateSnapshot().busy).toBe(false);
    expect(asr.stateSnapshot().lastError).toBeNull();
  });

  it("ошибка облака в finish — прокидывается, snapshot помнит причину", async () => {
    const { asr } = makeAsr({
      start: { status: "needAudio", url: "https://rr.example.googlevideo.com/audio", size: 1024 },
      file: 1024,
      finish: new Error("слишком много запросов: HTTP 429"),
    });
    await expect(asr.recognize("iG9CE55wbtY", "ru")).rejects.toThrow("429");
    expect(asr.stateSnapshot().lastError).toContain("429");
  });

  it("отмена: cancel гасит активный прогон (распознавание отменено)", async () => {
    const { asr, calls } = makeAsr({
      start: { status: "needAudio", url: "https://rr.example.googlevideo.com/audio", size: 5 * 1024 * 1024 },
      file: 5 * 1024 * 1024,
    });
    const p = asr.recognize("iG9CE55wbtY", "ru");
    asr.cancel("iG9CE55wbtY");
    await expect(p).rejects.toThrow("распознавание отменено");
    expect(calls.some((c) => c.cmd === "subtitles_asr_cancel")).toBe(true);
  });

  it("настройки: load/save ходят командами asr_get/set_settings", async () => {
    const { asr, calls } = makeAsr({ start: { status: "done", ...RUN } });
    const s = await asr.loadSettings();
    expect(s.hasApiKey).toBe(true);
    await asr.saveSettings({ enabled: true, openaiBaseUrl: "http://127.0.0.1:8899/v1", openaiModel: "whisper-1", apiKey: "sk-test" });
    const set = calls.find((c) => c.cmd === "asr_set_settings");
    expect(set?.args?.args).toMatchObject({ enabled: true, openaiModel: "whisper-1" });
  });
});

describe("asrProgressText — статусы конвейера", () => {
  const base: AsrProgressEvent = {
    tabId: "iG9CE55wbtY",
    videoKey: "iG9CE55wbtY",
    engine: "openai:whisper-1",
    phase: "transcribe",
    done: 1,
    total: 3,
    fromCache: false,
  };
  it("фазы конвейера — человеческие строки", () => {
    expect(asrProgressText({ ...base, phase: "transcribe", done: 2, total: 5 })).toContain("2 / 5");
    expect(asrProgressText({ ...base, phase: "transcribe", total: 1 })).toContain("Распознавание");
    expect(asrProgressText({ ...base, phase: "decode" })).toContain("Декодирование");
    expect(asrProgressText({ ...base, phase: "audio", done: 2 * 1048576, total: 8 * 1048576 })).toContain("8");
    expect(asrProgressText({ ...base, phase: "done", done: 42, fromCache: true })).toContain("кэша");
    expect(asrProgressText({ ...base, phase: "done", done: 42 })).toContain("42");
    expect(asrProgressText({ ...base, phase: "error", error: "HTTP 401" })).toContain("HTTP 401");
    expect(asrProgressText({ ...base, phase: "что-то" })).toBe("");
  });
});

// Окружение без Tauri: tauriInvoke по умолчанию не должен использоваться в
// тестах (порты подменены) — но модуль импортирует @tauri-apps/api/core;
// vi.mock не нужен: createMobileAsr берёт doInvoke из портов.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
