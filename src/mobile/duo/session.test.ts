// Тесты duo-сессии мобильной ветки (duopulse-082): разбор player-ответа
// (мобильная обвязка над чистыми функциями content-адаптера), сшивка
// id↔baseUrl (схема id как у normalizeBaseTracks), дефолт оригинала,
// ретрай 429 при загрузке cue, пачки перевода gtx.

import { describe, expect, it, vi } from "vitest";
import { defaultOriginal, loadCuesByUrl, parsePlayerResponse, titleOfPlayerResponse, translateCueTable, zipBaseUrls, type DuoInvoke } from "./session";
import { normalizeBaseTracks, type RawCaptionList } from "../../../content/adapters/youtube";

function rawList(): RawCaptionList {
  return {
    captionTracks: [
      { languageCode: "ko", kind: "asr", baseUrl: "https://www.youtube.com/api/timedtext?v=X&lang=ko&kind=asr", name: { simpleText: "Korean (auto)" }, isTranslatable: true },
      { languageCode: "en", baseUrl: "https://www.youtube.com/api/timedtext?v=X&lang=en", name: { simpleText: "English" }, isTranslatable: true },
      { languageCode: "en", baseUrl: "https://www.youtube.com/api/timedtext?v=X&lang=en&二号", name: { simpleText: "English (2)" }, isTranslatable: false },
      { languageCode: "ru", baseUrl: "https://www.youtube.com/api/timedtext?v=X&lang=ru", name: { simpleText: "Russian" }, isTranslatable: false },
      { languageCode: "", baseUrl: "https://evil" }, // без языка — пропускается
    ],
    translationLanguages: [{ languageCode: "ru", languageName: { simpleText: "Russian" } }],
    audioTracks: [],
  };
}

function playerResponse(): unknown {
  return {
    videoDetails: { videoId: "abc12345678" },
    playabilityStatus: { status: "OK" },
    captions: { playerCaptionsTracklistRenderer: rawList() },
  };
}

describe("parsePlayerResponse", () => {
  it("разбирает список и сшивает baseUrl по схеме id адаптера", () => {
    const list = parsePlayerResponse("abc12345678", playerResponse())!;
    expect(list.base.map((t) => t.id)).toEqual(["yt:ko:asr", "yt:en", "yt:en:2", "yt:ru"]);
    // сшивка: id → baseUrl той же дорожки (дубль en получил суффикс :2)
    expect(list.urls.get("yt:en")?.endsWith("lang=en")).toBe(true);
    expect(list.urls.get("yt:en:2")).toContain("二号");
    expect(list.urls.get("yt:ko:asr")).toContain("kind=asr");
    expect(list.urls.size).toBe(4);
    expect(list.translations).toEqual([{ lang: "ru", name: "Russian" }]);
  });

  it("null без captions и при пустом списке", () => {
    expect(parsePlayerResponse("abc", { playabilityStatus: { status: "OK" } })).toBeNull();
    const empty = { captions: { playerCaptionsTracklistRenderer: { captionTracks: [], translationLanguages: [], audioTracks: [] } } };
    expect(parsePlayerResponse("abc", empty)).toBeNull();
  });

  it("asr без ручных — язык оригинала (фолбэк адаптера duopulse-070)", () => {
    const list = parsePlayerResponse("abc12345678", playerResponse())!;
    expect(list.originalLangs.has("ko")).toBe(true);
    expect(defaultOriginal(list)?.id).toBe("yt:ko:asr"); // оригинал-asr впереди ручных
  });

  it("заголовок видео — из videoDetails.title (закладки duopulse-104)", () => {
    const resp = {
      videoDetails: { videoId: "abc12345678", title: "Do schools kill creativity?" },
      captions: { playerCaptionsTracklistRenderer: rawList() },
    };
    expect(titleOfPlayerResponse(resp)).toBe("Do schools kill creativity?");
    expect(parsePlayerResponse("abc12345678", resp)!.title).toBe("Do schools kill creativity?");
    // нет videoDetails/заголовка — пустая строка, не падение
    expect(titleOfPlayerResponse(playerResponse())).toBe("");
    expect(titleOfPlayerResponse(null)).toBe("");
  });
});

describe("zipBaseUrls", () => {
  it("схема id совпадает с normalizeBaseTracks (контракт сшивки)", () => {
    const { base } = zipBaseUrls(rawList(), new Set(["ko"]));
    const direct = normalizeBaseTracks(rawList(), new Set(["ko"]));
    expect(base).toEqual(direct.base);
  });
});

const cue = (startMs: number, text: string) => ({ startMs, endMs: startMs + 2000, text });

describe("loadCuesByUrl", () => {
  const TT = "https://www.youtube.com/api/timedtext?v=X&lang=ru";

  it("429 → один повтор через 6 с → 200", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const invoke: DuoInvoke = async () => {
        calls++;
        if (calls === 1) return { status: 429, cues: [] };
        return { status: 200, cues: [cue(0, "привет")] };
      };
      const p = loadCuesByUrl(invoke, TT);
      await vi.advanceTimersByTimeAsync(6000); // прогревает микротаски + ретрай
      expect(await p).toHaveLength(1);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("повторный 429 — честная ошибка, ретраев больше нет", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const invoke: DuoInvoke = async () => {
        calls++;
        return { status: 429, cues: [] };
      };
      const p = loadCuesByUrl(invoke, TT);
      p.catch(() => undefined); // не даём висеть unhandled
      await vi.advanceTimersByTimeAsync(6000);
      await expect(p).rejects.toThrow("HTTP 429");
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("200 без cue — честная ошибка", async () => {
    const invoke: DuoInvoke = async () => ({ status: 200, cues: [] });
    await expect(loadCuesByUrl(invoke, "https://www.youtube.com/api/timedtext?v=X&lang=ru")).rejects.toThrow("без реплик");
  });
});

describe("translateCueTable", () => {
  it("режет по ~1,2 КБ, переносит тексты пачкой, маппит по индексу", async () => {
    const cues = Array.from({ length: 30 }, (_, i) => cue(i * 100, `line ${i} с длинным текстом`.repeat(3)));
    const seen: string[][] = [];
    const invoke: DuoInvoke = async (_cmd, args) => {
      const texts = (args as { texts: string[] }).texts;
      seen.push(texts);
      const total = cues.reduce((n, c) => n + c.text.length + 1, 0);
      expect(texts.join("\n").length).toBeLessThanOrEqual(1300);
      expect(total).toBeGreaterThan(1200); // исходно больше лимита — режем
      return texts.map((t) => `✓${t.slice(0, 8)}`);
    };
    const progress: string[] = [];
    const out = await translateCueTable(invoke, cues, "en", "ru", (d, t) => progress.push(`${d}/${t}`), { aborted: false });
    expect(seen.length).toBeGreaterThan(1);
    expect(out).toHaveLength(30);
    expect(out[7].text.startsWith("✓line 7")).toBe(true);
    expect(out[29].text.startsWith("✓line 29")).toBe(true);
    expect(progress[progress.length - 1]).toBe("30/30");
  });

  it("переносы внутри cue → пробел (транспорт пачек соединяет строки \\n)", async () => {
    let got: string[] = [];
    const invoke: DuoInvoke = async (_c, a) => {
      got = (a as { texts: string[] }).texts;
      return got;
    };
    await translateCueTable(invoke, [cue(0, "первая\nвторая")], "ru", "en");
    expect(got[0]).toBe("первая вторая");
  });

  it("короткий ответ Rust — честная ошибка", async () => {
    const invoke: DuoInvoke = async () => ["одна"];
    await expect(translateCueTable(invoke, [cue(0, "a"), cue(1, "b")], "en", "ru")).rejects.toThrow("не все строки");
  });
});
