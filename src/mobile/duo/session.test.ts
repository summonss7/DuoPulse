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

  // duopulse-186 (Sam Smith vk_xq1P7vIU): все дорожки ручные (asr и
  // аудио-маркеров нет), первой zh-Hans — порядок captionTracks нестабилен,
  // дефолт брал китайскую дорожку. Мобильные п.4/п.5 дуопульса-184: индекс
  // рекомендации (hl-ответ) ≠ язык UI → контентный фолбэк; без сигналов —
  // en-ручная прежде первой.
  const vevoList = (index: number | null): RawCaptionList => ({
    captionTracks: [
      { languageCode: "zh-Hans", baseUrl: "https://www.youtube.com/api/timedtext?v=X&lang=zh-Hans", name: { simpleText: "Chinese" }, isTranslatable: true },
      { languageCode: "en", baseUrl: "https://www.youtube.com/api/timedtext?v=X&lang=en", name: { simpleText: "English" }, isTranslatable: true },
      { languageCode: "ru", baseUrl: "https://www.youtube.com/api/timedtext?v=X&lang=ru", name: { simpleText: "Russian" }, isTranslatable: true },
    ],
    translationLanguages: [],
    audioTracks: index === null ? [] : [{ captionTrackIndices: [0, 1, 2], hasDefaultTrack: true, defaultCaptionTrackIndex: index }],
  });
  const vevoResponse = (index: number | null): unknown => ({
    videoDetails: { videoId: "vkxq1P7vIU0" },
    captions: { playerCaptionsTracklistRenderer: vevoList(index) },
  });

  it("duopulse-186 п.4: индекс (hl-ответ) ≠ uiLang — en помечен оригиналом", () => {
    const list = parsePlayerResponse("vkxq1P7vIU0", vevoResponse(1), "ru")!;
    expect(list.originalLangs).toEqual(new Set(["en"]));
    expect(defaultOriginal(list)?.id).toBe("yt:en"); // не yt:zh-Hans первой
  });

  it("duopulse-186 п.4: индекс совпал с языком UI или uiLang не передан — пометки нет", () => {
    expect(parsePlayerResponse("vkxq1P7vIU0", vevoResponse(2), "ru")!.originalLangs.size).toBe(0);
    expect(parsePlayerResponse("vkxq1P7vIU0", vevoResponse(1))!.originalLangs.size).toBe(0);
  });

  it("duopulse-186 п.5: без сигналов дефолт — en-ручная прежде первой (zh-Hans)", () => {
    const list = parsePlayerResponse("vkxq1P7vIU0", vevoResponse(null), "ro")!;
    expect(list.originalLangs.size).toBe(0);
    expect(defaultOriginal(list)?.id).toBe("yt:en");
  });

  it("регрессия мульти-даб (Милан): audioTrackId первого трека — ru, uiLang не мешает", () => {
    const resp = {
      videoDetails: { videoId: "rcavttv5nmi0" },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { languageCode: "ru", baseUrl: "https://www.youtube.com/api/timedtext?v=X&lang=ru", name: { simpleText: "Russian" }, isTranslatable: true },
            { languageCode: "en", baseUrl: "https://www.youtube.com/api/timedtext?v=X&lang=en", name: { simpleText: "English" }, isTranslatable: true },
            { languageCode: "en", kind: "asr", baseUrl: "https://www.youtube.com/api/timedtext?v=X&lang=en&kind=asr", name: { simpleText: "English (auto)" }, isTranslatable: true },
          ],
          translationLanguages: [],
          audioTracks: [
            { audioTrackId: "ru.4", captionTrackIndices: [0] },
            { audioTrackId: "en-US.10", captionTrackIndices: [1, 2] },
          ],
        } as RawCaptionList,
      },
    };
    const list = parsePlayerResponse("rcavttv5nmi0", resp, "en")!;
    expect(list.originalLangs).toEqual(new Set(["ru"])); // дублированный asr не «оригинал»
    expect(defaultOriginal(list)?.id).toBe("yt:ru");
  });

  it("регрессия Gangnam: asr-фолбэк жив при uiLang (п.4 не вытесняет)", () => {
    const list = parsePlayerResponse("abc12345678", playerResponse(), "ru")!;
    expect(list.originalLangs.has("ko")).toBe(true);
    expect(defaultOriginal(list)?.id).toBe("yt:ko:asr");
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

  // duopulse-182: офлайн может завесить invoke перевода без отказа — конвейер
  // ASR не должен висеть «занятым» до конца времён
  it("зависший invoke — таймаут вызова, а не вечное ожидание", async () => {
    const invoke: DuoInvoke = () => new Promise(() => {}); // никогда не отвечает
    const started = Date.now();
    await expect(
      translateCueTable(invoke, [cue(0, "привет")], "en", "ru", undefined, undefined, 300),
    ).rejects.toThrow(/нет ответа .* — проверьте сеть/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("отмена (signal) снимает зависший вызов сразу, не дожидаясь таймаута", async () => {
    const invoke: DuoInvoke = () => new Promise(() => {});
    const signal = { aborted: false };
    const started = Date.now();
    setTimeout(() => (signal.aborted = true), 120);
    await expect(
      translateCueTable(invoke, [cue(0, "привет")], "en", "ru", undefined, signal, 60_000),
    ).rejects.toThrow("перевод отменён");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("поздний ответ отброшенного вызова не роняет цикл (unhandled нет)", async () => {
    const release: { fn: ((v: string[]) => void) | null } = { fn: null };
    const invoke: DuoInvoke = () => new Promise((res) => { release.fn = res; });
    const p = translateCueTable(invoke, [cue(0, "a")], "en", "ru", undefined, undefined, 200);
    await expect(p).rejects.toThrow(/нет ответа/);
    release.fn?.(["поздно"]); // зависший invoke ожил после таймаута — тишина
    await new Promise((r) => setTimeout(r, 50));
  });
});
