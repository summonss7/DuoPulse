// Юнит-тесты фолбэка ядра при деградированной сессии YouTube (duopulse-228,
// из диагностики duopulse-226): страницевой player-ответ жив (videoDetails с
// videoId), но секции captions в нём нет — адаптер переспрашивает player
// ядром (innertube ANDROID), тела дорожек качает напрямую по baseUrl
// (без PO-токена/без программирования плеера), переводы — gtx в ядре.
// Сеть изолирована фейками: fetch окна, порт corePlayerFallback, gtx-порт.

import { describe, expect, it, vi } from "vitest";
import { YouTubeAdapter, trackUrlJson3, translateCuesGtx } from "./youtube";
import type { PageWindow, YouTubeTransport } from "./youtube";
import { defaultSetIds } from "../set-defaults";
import type { SubtitlesParser } from "./types";
import type { Cue } from "../types";

const cue = (n: number, text: string): Cue => ({ startMs: n * 1000, endMs: n * 1000 + 900, text });

/** Фейковый разбор: тело-маркер «track:XX» → 2 cue. */
const fakeParser: SubtitlesParser = {
  async parse(payload) {
    const m = /^track:(\w+)$/.exec(payload.trim());
    if (!m) throw new Error("битый payload");
    return { cues: [cue(0, `track-${m[1]}-a`), cue(1, `track-${m[1]}-b`)], warnings: [] };
  },
};

class NoCallTransport implements YouTubeTransport {
  readonly usedPath = "nocall";
  began = 0;
  async begin() {
    this.began++;
    return true;
  }
  async loadBaseTrack(): Promise<{ url: string; body: string } | null> {
    throw new Error("транспорт плеера не должен зваться на фолбэк-дорожках");
  }
  async end(): Promise<void> {}
}

/** Окно с ЖИВЫМ ответом этого видео БЕЗ captions (деградированная сессия
 *  YouTube, duopulse-226) и подменённым fetch тел дорожек. */
function makeDegradedWindow(urls: { [u: string]: { ok: boolean; body?: string } }): {
  win: PageWindow;
  requested: string[];
} {
  const requested: string[] = [];
  const playerResponse = { videoDetails: { videoId: "TEST" } }; // captions нет
  const win = {
    location: { href: "https://www.youtube.com/watch?v=TEST" },
    document: { getElementById: () => ({ getPlayerResponse: () => playerResponse }) },
    fetch: ((u: string) => {
      requested.push(u);
      const hit = urls[u];
      return Promise.resolve({
        ok: hit?.ok ?? false,
        status: hit ? 200 : 404,
        text: () => Promise.resolve(hit?.body ?? ""),
      });
    }) as unknown as typeof fetch,
  } as PageWindow;
  return { win, requested };
}

/** Секции innertube-ответа ядра (ANDROID): ru asr + оригинал-маркер. */
const fallbackPlayer = {
  videoDetails: { videoId: "TEST", title: "T" },
  audioTracks: [{ languageCode: "ru", original: true }],
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        {
          baseUrl: "https://www.youtube.com/api/timedtext?v=TEST&lang=ru&fmt=srv3&sig=S",
          languageCode: "ru",
          kind: "asr",
          vssId: "a.ru",
          name: { simpleText: "Russian (auto)" },
          isTranslatable: true,
        },
      ],
      translationLanguages: [{ languageCode: "en", languageName: { simpleText: "English" } }],
    },
  },
};

const BASE_JSON3 = "https://www.youtube.com/api/timedtext?v=TEST&lang=ru&fmt=json3&sig=S";
const BASE_RAW = "https://www.youtube.com/api/timedtext?v=TEST&lang=ru&fmt=srv3&sig=S";

describe("duopulse-228: список дорожек фолбэком ядра", () => {
  it("успех: список строится из секций innertube, дорожки с baseUrl, note для панели", async () => {
    const { win } = makeDegradedWindow({});
    const adapter = new YouTubeAdapter({
      win,
      corePlayerFallback: async () => ({ ok: true, player: fallbackPlayer }),
    });
    const list = await adapter.listTracks();
    expect(list?.usedPath).toBe("core-innertube");
    expect(list?.base.map((b) => b.id)).toEqual(["yt:ru:asr"]);
    expect(list?.base[0].baseUrl).toContain("timedtext");
    // ANDROID отдаёт audioTracks[].original — язык оригинала размечен
    expect(list?.base[0].original).toBe(true);
    expect(list?.translations.map((t) => t.lang)).toEqual(["en"]);
    expect(list?.note).toContain("фолбэком");
  });

  it("переводы доступны для дефолта: набор оригинал + перевод", async () => {
    const { win } = makeDegradedWindow({});
    const adapter = new YouTubeAdapter({
      win,
      corePlayerFallback: async () => ({ ok: true, player: fallbackPlayer }),
    });
    const list = await adapter.listTracks();
    expect(defaultSetIds(list)).toEqual(["yt:ru:asr", "en"]);
  });

  it("фолбэк подтвердил отсутствие дорожек — note «У видео нет субтитров»", async () => {
    const { win } = makeDegradedWindow({});
    const adapter = new YouTubeAdapter({
      win,
      corePlayerFallback: async () => ({ ok: true, player: { videoDetails: { videoId: "TEST" } } }),
    });
    const list = await adapter.listTracks();
    expect(list?.base).toHaveLength(0);
    expect(list?.note).toBe("У видео нет субтитров");
  });

  it("отказ ядра — note с причиной различим в панели", async () => {
    const { win } = makeDegradedWindow({});
    const adapter = new YouTubeAdapter({
      win,
      corePlayerFallback: async () => ({ ok: false, error: "innertube HTTP 429" }),
    });
    const list = await adapter.listTracks();
    expect(list?.base).toHaveLength(0);
    expect(list?.note).toContain("фолбэк не удался");
    expect(list?.note).toContain("429");
  });

  it("ядро не ответило — прежний путь (texttrack), без note", async () => {
    const { win } = makeDegradedWindow({});
    const adapter = new YouTubeAdapter({
      win,
      listTimeoutMs: 50,
      corePlayerFallback: async () => null,
    });
    const list = await adapter.listTracks();
    expect(list?.usedPath).toBe("texttrack");
    expect(list?.note ?? "").toBe("");
  });

  it("фолбэк НЕ включается при живых captions страницевого ответа (регресс обычного пути)", async () => {
    // Окно с нормальным ответом (captions есть) — как makeLoadWindow основного файла
    const requested: string[] = [];
    const playerResponse = {
      videoDetails: { videoId: "TEST" },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ languageCode: "en", vssId: ".en", name: { simpleText: "en" } }],
          translationLanguages: [],
        },
      },
    };
    const win = {
      location: { href: "https://www.youtube.com/watch?v=TEST" },
      document: { getElementById: () => ({ getPlayerResponse: () => playerResponse }) },
      fetch: (() => {
        throw new Error("fetch не должен зваться");
      }) as unknown as typeof fetch,
    } as PageWindow;
    const fallback = vi.fn(async () => {
      throw new Error("фолбэк не должен зваться");
    });
    const adapter = new YouTubeAdapter({ win, corePlayerFallback: fallback });
    const list = await adapter.listTracks();
    expect(list?.base.map((b) => b.id)).toEqual(["yt:en"]); // дорожки как раньше
    expect(fallback).not.toHaveBeenCalled();
    expect(requested).toHaveLength(0);
  });

  it("фолбэк НЕ включается на заглушечном ответе (videoId не совпал)", async () => {
    const fallback = vi.fn(async () => null);
    // shorts-заглушка movie_player: ответ без videoDetails — не живой ответ
    const win = {
      location: { href: "https://www.youtube.com/shorts/AbCdEfGhIjK" },
      document: { getElementById: () => ({ getPlayerResponse: () => ({ playerConfig: {} }) }) },
      fetch: (() => {
        throw new Error("fetch не должен зваться");
      }) as unknown as typeof fetch,
    } as PageWindow;
    const adapter = new YouTubeAdapter({ win, corePlayerFallback: fallback, listTimeoutMs: 50 });
    const list = await adapter.listTracks();
    expect(fallback).not.toHaveBeenCalled(); // живого ответа этого видео нет
    expect(list?.usedPath).toBe("texttrack");
  });
});

describe("duopulse-228: загрузка фолбэк-дорожек без программирования плеера", () => {
  it("тела качаются напрямую (fmt=json3 первым), перевод gtx, транспорт не трогается", async () => {
    const { win, requested } = makeDegradedWindow({
      [BASE_JSON3]: { ok: true, body: "track:ru" },
    });
    const transport = new NoCallTransport();
    const gtx = vi.fn(async (texts: string[], from: string, to: string) => {
      expect(from).toBe("ru");
      expect(to).toBe("en");
      return texts.map((t) => `en:${t}`);
    });
    const adapter = new YouTubeAdapter({
      win,
      transport,
      corePlayerFallback: async () => ({ ok: true, player: fallbackPlayer }),
      gtxTranslate: gtx,
    });
    await adapter.listTracks();
    const delivered: string[] = [];
    const { tracks, failures, usedPath } = await adapter.loadTracks(
      [
        { id: "yt:ru:asr", lang: "ru", role: "original", source: "youtube", languageCode: "ru" },
        { id: "yt:ru:asr+en", lang: "en", role: "translation", source: "youtube", baseId: "yt:ru:asr" },
      ],
      { parser: fakeParser, onTrack: (t) => delivered.push(t.id) },
    );
    expect(failures).toHaveLength(0);
    expect(usedPath).toBe("core-innertube+direct");
    expect(tracks.map((t) => t.id)).toEqual(["yt:ru:asr", "yt:ru:asr+en"]);
    // перевод gtx: метки базы сохранены, тексты переведены
    expect(tracks[1].cues.map((c) => c.text)).toEqual(["en:track-ru-a", "en:track-ru-b"]);
    expect(tracks[1].cues[0].startMs).toBe(0);
    expect(gtx).toHaveBeenCalledWith(["track-ru-a", "track-ru-b"], "ru", "en");
    expect(transport.began).toBe(0); // плеер страницы не программировался
    expect(requested).toEqual([BASE_JSON3]); // json3-вариант сработал первым
    expect(delivered).toEqual(["yt:ru:asr", "yt:ru:asr+en"]); // прогрессивная выдача
  });

  it("скрытая база перевода качается без показа; json3 404 → исходный URL", async () => {
    const { win, requested } = makeDegradedWindow({
      [BASE_JSON3]: { ok: false },
      [BASE_RAW]: { ok: true, body: "track:ru" },
    });
    const adapter = new YouTubeAdapter({
      win,
      transport: new NoCallTransport(),
      corePlayerFallback: async () => ({ ok: true, player: fallbackPlayer }),
      gtxTranslate: async (texts) => texts,
    });
    await adapter.listTracks();
    const delivered: string[] = [];
    const { tracks, failures } = await adapter.loadTracks(
      [{ id: "yt:ru:asr+en", lang: "en", role: "translation", source: "youtube", baseId: "yt:ru:asr" }],
      { parser: fakeParser, onTrack: (t) => delivered.push(t.id) },
    );
    expect(tracks.map((t) => t.id)).toEqual(["yt:ru:asr+en"]);
    expect(failures).toHaveLength(0);
    // скрытая база не показывается, оба варианта URL испробованы
    expect(delivered).toEqual(["yt:ru:asr+en"]);
    expect(requested).toEqual([BASE_JSON3, BASE_RAW]);
  });

  it("тело дорожки не получено — честный отказ с пометкой фолбэка", async () => {
    const { win } = makeDegradedWindow({}); // все URL — 404
    const adapter = new YouTubeAdapter({
      win,
      transport: new NoCallTransport(),
      corePlayerFallback: async () => ({ ok: true, player: fallbackPlayer }),
    });
    await adapter.listTracks();
    const { tracks, failures } = await adapter.loadTracks(
      [{ id: "yt:ru:asr", lang: "ru", role: "original", source: "youtube", languageCode: "ru" }],
      { parser: fakeParser },
    );
    expect(tracks).toHaveLength(0);
    expect(failures[0].reason).toContain("фолбэк");
  });

  it("отказ gtx — перевод отказом, оригинал показан (прогрессивный показ)", async () => {
    const { win } = makeDegradedWindow({ [BASE_JSON3]: { ok: true, body: "track:ru" } });
    const adapter = new YouTubeAdapter({
      win,
      transport: new NoCallTransport(),
      corePlayerFallback: async () => ({ ok: true, player: fallbackPlayer }),
      gtxTranslate: async () => {
        throw new Error("gtx HTTP 429");
      },
    });
    await adapter.listTracks();
    const { tracks, failures } = await adapter.loadTracks(
      [
        { id: "yt:ru:asr", lang: "ru", role: "original", source: "youtube", languageCode: "ru" },
        { id: "yt:ru:asr+en", lang: "en", role: "translation", source: "youtube", baseId: "yt:ru:asr" },
      ],
      { parser: fakeParser },
    );
    expect(tracks.map((t) => t.id)).toEqual(["yt:ru:asr"]);
    expect(failures[0].reason).toContain("gtx");
  });
});

describe("duopulse-228: translateCuesGtx и trackUrlJson3 (чистые)", () => {
  it("пачки ~1,2 КБ и ≤50 строк, метки базы сохранены", async () => {
    const cues: Cue[] = Array.from({ length: 120 }, (_, i) => cue(i, `строка ${i}`));
    const batches: string[][] = [];
    const out = await translateCuesGtx(cues, "ru", "en", async (texts) => {
      batches.push(texts);
      return texts.map((t) => `en|${t}`);
    });
    expect(batches.length).toBeGreaterThanOrEqual(3); // 120 строк режутся
    expect(batches.every((b) => b.length <= 50)).toBe(true);
    expect(out).toHaveLength(120);
    expect(out[7].text).toBe("en|строка 7");
    expect(out[7].startMs).toBe(7000); // метки базы
  });

  it("перевод вернул не все строки — отказ", async () => {
    const cues = [cue(0, "a"), cue(1, "b")];
    await expect(
      translateCuesGtx(cues, "ru", "en", async () => ["одна"]),
    ).rejects.toThrow("не все строки");
  });

  it("trackUrlJson3: fmt заменяется/дописывается, подпись не тронута", () => {
    expect(trackUrlJson3("https://x/t?v=Q&fmt=srv3&sig=S")).toBe("https://x/t?v=Q&fmt=json3&sig=S");
    expect(trackUrlJson3("https://x/t?v=Q&sig=S")).toBe("https://x/t?v=Q&sig=S&fmt=json3");
    expect(trackUrlJson3("https://x/t")).toBe("https://x/t?fmt=json3");
  });
});
