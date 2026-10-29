// Юнит-тесты YouTube-адаптера (задача 3.3) на записанных фикстурах
// player-ответов (e2e/fixtures/youtube/playerResponses — снапшоты живого
// YouTube, docs/03 §9: без сети). Сетевые/DOM-части (перехват fetch/XHR,
// программирование плеера, разбор в Core) изолированы портами и фейками.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  YouTubeAdapter,
  YT_NATIVE_CAPTIONS_CLASS,
  blankYouTubeCaptions,
  buildTranslationUrl,
  extractCaptionList,
  installTimedtextCapture,
  normalizeBaseTracks,
  normalizeTranslations,
  paramsOf,
  videoIdFromHref,
  videoIdOfResponse,
  type DocumentLike,
  type PageWindow,
  type PlayerElement,
  type YouTubeTransport,
} from "./youtube";
import type { SubtitlesParser } from "./types";
import type { Cue } from "../types";

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "e2e",
  "fixtures",
  "youtube",
  "playerResponses",
);

interface Fixture {
  videoId: string;
  url: string;
  title: string;
  captionTracks: Record<string, unknown>[];
  translationLanguages: Record<string, unknown>[];
}

/** Фикстура → player-ответ (обёртка captions-части в структуру ответа). */
function playerResponseOf(fx: Fixture): Record<string, unknown> {
  return {
    videoDetails: { videoId: fx.videoId, title: fx.title },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: fx.captionTracks,
        translationLanguages: fx.translationLanguages,
      },
    },
  };
}

function loadFixtures(): Fixture[] {
  return fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, f), "utf8")) as Fixture);
}

const fixtures = loadFixtures();

/** Минимальная страница для адаптера (структурная типизация, без DOM). */
function makeWindow(opts: {
  href: string;
  playerResponse?: unknown;
  initialResponse?: unknown;
  textTracks?: { language?: string; kind?: string; label?: string }[];
}): PageWindow & { ytInitialPlayerResponse?: unknown } {
  const player: PlayerElement | null =
    opts.playerResponse !== undefined
      ? { getPlayerResponse: () => opts.playerResponse }
      : null;
  return {
    location: { href: opts.href },
    document: {
      getElementById: (id: string) => (id === "movie_player" && player ? player : null),
    },
    fetch: (() => {
      throw new Error("fetch не должен зваться в этих тестах");
    }) as unknown as typeof fetch,
    ...(opts.initialResponse !== undefined ? { ytInitialPlayerResponse: opts.initialResponse } : {}),
  } as PageWindow & { ytInitialPlayerResponse?: unknown };
}

describe("извлечение списка из player-ответа (фикстуры живого YouTube)", () => {
  it("фикстуры записаны и их ≥ 10 (DoD 3.3 требует 10 видео)", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(10);
  });

  for (const fx of fixtures) {
    it(`${fx.videoId}: полный список — дорожки, id, asr, переводы`, () => {
      const response = playerResponseOf(fx);
      expect(videoIdOfResponse(response)).toBe(fx.videoId);
      const raw = extractCaptionList(response);
      expect(raw).not.toBeNull();
      const { base } = normalizeBaseTracks(raw!);
      expect(base.length).toBe(fx.captionTracks.length);
      expect(new Set(base.map((b) => b.id)).size).toBe(base.length); // id уникальны
      for (let i = 0; i < base.length; i++) {
        const src = fx.captionTracks[i];
        expect(base[i].lang).toBe(src.languageCode);
        expect(base[i].kind).toBe(src.kind === "asr" ? "asr" : "manual");
        expect(base[i].name.length).toBeGreaterThan(0); // имя локализовано, но не пустое
      }
      const translations = normalizeTranslations(raw!);
      expect(translations.length).toBe(fx.translationLanguages.length);
      expect(translations.some((t) => t.lang === "ru")).toBe(true); // ru-перевод есть у всех фикстур
    });
  }

  it("язык оригинала (audioTracks.original) помечается и становится базой по умолчанию", async () => {
    const fxOriginal = fixtures.find((f) => f.videoId === "iG9CE55wbtY")!; // TED: 65 дорожек, первая — af
    const response = playerResponseOf(fxOriginal);
    (response as { audioTracks?: unknown }).audioTracks = [
      { languageCode: "en", original: true },
      { languageCode: "ru" },
    ];
    const adapter = new YouTubeAdapter({
      win: makeWindow({ href: `https://www.youtube.com/watch?v=${fxOriginal.videoId}`, playerResponse: response }),
    });
    const list = await adapter.listTracks();
    const en = list!.base.find((b) => b.id === "yt:en")!;
    expect(en.original).toBe(true);
    expect(list!.base[0].original).toBe(false); // af — не оригинал
    // голый код перевода клеится к базе-оригиналу, не к первой дорожке
    const { refs } = adapter.resolveIds(["ru"]);
    expect(refs[0].baseId).toBe("yt:en");
  });

  it("asr-дорожка и ручная одного языка получают разные id (yt:en / yt:en:asr)", () => {
    const raw = extractCaptionList(
      playerResponseOf({
        videoId: "x",
        url: "",
        title: "",
        captionTracks: [
          { languageCode: "en", vssId: ".en" },
          { languageCode: "en", kind: "asr", vssId: "a.en" },
        ],
        translationLanguages: [],
      }),
    )!;
    const { base } = normalizeBaseTracks(raw);
    expect(base.map((b) => b.id)).toEqual(["yt:en", "yt:en:asr"]);
  });

  it("дубликаты одного языка нумеруются, битые дорожки диагностируются", () => {
    const raw = extractCaptionList(
      playerResponseOf({
        videoId: "x",
        url: "",
        title: "",
        captionTracks: [
          { languageCode: "pt" },
          { languageCode: "pt" },
          { noLang: true },
        ],
        translationLanguages: [],
      }),
    )!;
    const { base, warnings } = normalizeBaseTracks(raw);
    expect(base.map((b) => b.id)).toEqual(["yt:pt", "yt:pt:2"]);
    expect(warnings).toHaveLength(1); // дорожка без languageCode
  });

  it("имя дорожки: runs склеиваются, мусор не валит извлечение", () => {
    expect(extractCaptionList(null)).toBeNull();
    expect(extractCaptionList({})).toBeNull();
    expect(extractCaptionList({ captions: {} })).toBeNull();
    const raw = extractCaptionList({
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { languageCode: "fr", name: { runs: [{ text: "français" }, { text: " (auto)" }] } },
          ],
          translationLanguages: [],
        },
      },
    })!;
    expect(normalizeBaseTracks(raw).base[0].name).toBe("français (auto)");
  });
});

describe("URL-утилиты", () => {
  it("videoIdFromHref: watch/shorts/youtu.be; прочее — null", () => {
    expect(videoIdFromHref("https://www.youtube.com/watch?v=abc123&t=1")).toBe("abc123");
    expect(videoIdFromHref("https://youtube.com/shorts/XYZ_9")).toBe("XYZ_9");
    expect(videoIdFromHref("https://youtu.be/q1w2e3")).toBe("q1w2e3");
    expect(videoIdFromHref("https://example.com/watch?v=abc")).toBeNull();
  });

  it("paramsOf: точное сравнение значений (en ≠ en-GB)", () => {
    const p = paramsOf("https://x/api/timedtext?v=Q&lang=en&fmt=json3");
    expect(p.get("lang")).toBe("en");
    expect(p.get("v")).toBe("Q");
    expect(p.has("tlang")).toBe(false);
  });

  it("buildTranslationUrl: добавляет tlang, существующий заменяет, параметры живого URL сохраняет", () => {
    const live = "https://x/api/timedtext?v=Q&caps=asr&signature=S&pot=P&fmt=json3";
    expect(buildTranslationUrl(live, "ru")).toBe(live + "&tlang=ru");
    expect(buildTranslationUrl(live + "&tlang=de", "ru")).toBe(live + "&tlang=ru");
    expect(buildTranslationUrl(live, "zh-CN")).toBe(live + "&tlang=zh-CN"); // кодировка сохранена (RFC)
  });
});

describe("адаптер: список дорожек по путям добычи (docs/03 §9)", () => {
  const fx = fixtures.find((f) => f.videoId === "dQw4w9WgXcQ") ?? fixtures[0];

  it("путь player-api: movie_player.getPlayerResponse", async () => {
    const adapter = new YouTubeAdapter({
      win: makeWindow({ href: `https://www.youtube.com/watch?v=${fx.videoId}`, playerResponse: playerResponseOf(fx) }),
    });
    const list = await adapter.listTracks();
    expect(list?.usedPath).toBe("player-api");
    expect(list!.base.length).toBe(fx.captionTracks.length);
  });

  it("путь initial: ytInitialPlayerResponse без movie_player", async () => {
    const adapter = new YouTubeAdapter({
      win: makeWindow({ href: `https://www.youtube.com/watch?v=${fx.videoId}`, initialResponse: playerResponseOf(fx) }),
    });
    const list = await adapter.listTracks();
    expect(list?.usedPath).toBe("initial");
    expect(list!.base.length).toBeGreaterThan(0);
  });

  it("устаревший ответ (SPA) — ждёт свежий, отдаёт с предупреждением по таймауту", async () => {
    const stale = playerResponseOf({ ...fx, videoId: "OLDID" });
    const adapter = new YouTubeAdapter({
      win: makeWindow({ href: "https://www.youtube.com/watch?v=NEWID", playerResponse: stale }),
      listTimeoutMs: 80,
    });
    const list = await adapter.listTracks();
    expect(list).not.toBeNull();
    expect(list!.warnings.some((w) => w.includes("устаревшего"))).toBe(true);
  });

  it("плеер недоступен → последний resort texttrack (пуст у текущего YouTube)", async () => {
    const adapter = new YouTubeAdapter({
      win: makeWindow({ href: "https://www.youtube.com/watch?v=X" }),
      listTimeoutMs: 50,
      getVideo: () => ({ textTracks: [] }) as never,
    });
    const list = await adapter.listTracks();
    expect(list?.usedPath).toBe("texttrack");
    expect(list!.base).toHaveLength(0);
    expect(list!.warnings.length).toBeGreaterThan(0);
  });
});

describe("адаптер: выбор дорожек по id", () => {
  const fx = fixtures.find((f) => f.videoId === "dQw4w9WgXcQ")!;
  async function adapterWithList(): Promise<YouTubeAdapter> {
    const adapter = new YouTubeAdapter({
      win: makeWindow({ href: `https://www.youtube.com/watch?v=${fx.videoId}`, playerResponse: playerResponseOf(fx) }),
    });
    await adapter.listTracks();
    return adapter;
  }

  it("id базовой дорожки → original-ref с languageCode", async () => {
    const { refs, unknown } = (await adapterWithList()).resolveIds(["yt:en"]);
    expect(unknown).toHaveLength(0);
    expect(refs[0]).toMatchObject({ id: "yt:en", lang: "en", role: "original", languageCode: "en" });
  });

  it("перевод: явная база (yt:en+ru) и голый код (ru → база по умолчанию)", async () => {
    const { refs } = (await adapterWithList()).resolveIds(["yt:en+ru", "ru"]);
    expect(refs[0]).toMatchObject({ id: "yt:en+ru", lang: "ru", role: "translation", baseId: "yt:en" });
    // голый код: база по умолчанию = ручная дорожка (не asr)
    expect(refs[1]).toMatchObject({ lang: "ru", role: "translation", baseId: "yt:en" });
  });

  it("неизвестные id диагностируются, известные собираются", async () => {
    const { refs, unknown } = (await adapterWithList()).resolveIds(["yt:en", "нет-такой"]);
    expect(refs.map((r) => r.id)).toEqual(["yt:en"]);
    expect(unknown).toEqual(["нет-такой"]);
  });
});

// --- загрузка выбранного набора: транспорт/разбор подменены -------------------

const cue = (n: number, text: string): Cue => ({ startMs: n * 1000, endMs: n * 1000 + 900, text });

/** Фейковый разбор: тело-маркер «track:XX»/«trans:XX» → 2 cue. */
const fakeParser: SubtitlesParser = {
  async parse(payload) {
    const m = /^(track|trans):(\w+)$/.exec(payload.trim());
    if (!m) throw new Error("битый payload");
    return { cues: [cue(0, `${m[1]}-${m[2]}-a`), cue(1, `${m[1]}-${m[2]}-b`)], warnings: [] };
  },
};

class FakeTransport implements YouTubeTransport {
  readonly usedPath = "fake";
  began = 0;
  ended = 0;
  loadedLangs: string[] = [];
  constructor(
    private readonly responses: Map<string, { url: string; body: string } | null>,
    private readonly beginOk = true,
  ) {}
  async begin() {
    this.began++;
    return this.beginOk;
  }
  async loadBaseTrack(_videoId: string, languageCode: string) {
    this.loadedLangs.push(languageCode);
    return this.responses.get(languageCode) ?? null;
  }
  async end() {
    this.ended++;
  }
}

/** Окно с плеером, списком (en/ja + переводы ru/es) и подменённым fetch. */
function makeLoadWindow(urls: { [u: string]: { ok: boolean; body?: string } }): {
  win: PageWindow;
  requested: string[];
} {
  const requested: string[] = [];
  const playerResponse = {
    videoDetails: { videoId: "TEST" },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          { languageCode: "en", vssId: ".en", name: { simpleText: "en" } },
          { languageCode: "ja", vssId: ".ja", name: { simpleText: "ja" } },
        ],
        translationLanguages: [
          { languageCode: "ru", languageName: { simpleText: "ru" } },
          { languageCode: "es", languageName: { simpleText: "es" } },
        ],
      },
    },
  };
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

async function adapterWithListFor(transport: YouTubeTransport, win: PageWindow): Promise<YouTubeAdapter> {
  const adapter = new YouTubeAdapter({ win, transport });
  const list = await adapter.listTracks(); // наполняет resolveIds/refForBaseId
  expect(list?.base.map((b) => b.id)).toEqual(["yt:en", "yt:ja"]);
  return adapter;
}

describe("адаптер: загрузка выбранного набора 2–3 дорожек", () => {
  const liveEn = { url: "https://x/timedtext?v=TEST&lang=en&fmt=json3&pot=P", body: "track:en" };

  it("оригинал + перевод: база через транспорт, перевод — fetch поверх живого URL", async () => {
    const transUrl = "https://x/timedtext?v=TEST&lang=en&fmt=json3&pot=P&tlang=ru";
    const { win, requested } = makeLoadWindow({ [transUrl]: { ok: true, body: "trans:ru" } });
    const transport = new FakeTransport(new Map([["en", liveEn]]));
    const adapter = await adapterWithListFor(transport, win);
    const { tracks, failures, usedPath } = await adapter.loadTracks(
      [
        { id: "yt:en", lang: "en", role: "original", source: "youtube", languageCode: "en" },
        { id: "yt:en+ru", lang: "ru", role: "translation", source: "youtube", baseId: "yt:en" },
      ],
      { parser: fakeParser },
    );
    expect(failures).toHaveLength(0);
    expect(usedPath).toBe("fake");
    expect(tracks.map((t) => t.id)).toEqual(["yt:en", "yt:en+ru"]); // порядок = порядок выбора
    expect(tracks[0].cues).toHaveLength(2);
    expect(tracks[1].lang).toBe("ru");
    expect(transport.loadedLangs).toEqual(["en"]); // скрытых баз нет — одна загрузка
    expect(transport.ended).toBe(1); // плеер восстановлен
    expect(requested).toEqual([transUrl]); // tlang поверх живого URL
  });

  it("перевод без базы в наборе: база снимается скрыто, в дорожки не попадает", async () => {
    const transUrl = "https://x/timedtext?v=TEST&lang=en&fmt=json3&pot=P&tlang=es";
    const { win } = makeLoadWindow({ [transUrl]: { ok: true, body: "trans:es" } });
    const transport = new FakeTransport(new Map([["en", liveEn]]));
    const adapter = await adapterWithListFor(transport, win);
    const { tracks } = await adapter.loadTracks(
      [{ id: "yt:en+es", lang: "es", role: "translation", source: "youtube", baseId: "yt:en" }],
      { parser: fakeParser },
    );
    expect(tracks.map((t) => t.id)).toEqual(["yt:en+es"]);
    expect(transport.loadedLangs).toEqual(["en"]); // скрытая база снята
  });

  it("отказ базы не валит набор: отказ + зависимый перевод диагностируются", async () => {
    const { win } = makeLoadWindow({});
    const transport = new FakeTransport(new Map([["en", null], ["ja", { url: "https://x/t?lang=ja", body: "track:ja" }]]));
    const adapter = await adapterWithListFor(transport, win);
    const { tracks, failures } = await adapter.loadTracks(
      [
        { id: "yt:en", lang: "en", role: "original", source: "youtube", languageCode: "en" },
        { id: "yt:en+ru", lang: "ru", role: "translation", source: "youtube", baseId: "yt:en" },
        { id: "yt:ja", lang: "ja", role: "original", source: "youtube", languageCode: "ja" },
      ],
      { parser: fakeParser },
    );
    expect(tracks.map((t) => t.id)).toEqual(["yt:ja"]);
    const reasons = failures.map((f) => `${f.ref.id}:${f.reason}`);
    expect(reasons.some((r) => r.startsWith("yt:en:плеер не отдал"))).toBe(true);
    expect(reasons.some((r) => r.startsWith("yt:en+ru:базовая дорожка"))).toBe(true);
  });

  it("нет плеера — все дорожки отказом, fetch не зовётся", async () => {
    const { win, requested } = makeLoadWindow({});
    const transport = new FakeTransport(new Map(), false);
    const adapter = await adapterWithListFor(transport, win);
    const { tracks, failures, usedPath } = await adapter.loadTracks(
      [
        { id: "yt:en", lang: "en", role: "original", source: "youtube", languageCode: "en" },
        { id: "yt:en+ru", lang: "ru", role: "translation", source: "youtube", baseId: "yt:en" },
      ],
      { parser: fakeParser },
    );
    expect(tracks).toHaveLength(0);
    expect(failures).toHaveLength(2);
    expect(usedPath).toBe("недоступен");
    expect(requested).toHaveLength(0);
  });

  it("HTTP-ошибка и битый payload перевода — отказ с причиной", async () => {
    const transUrl = "https://x/timedtext?v=TEST&lang=en&fmt=json3&pot=P&tlang=ru";
    const { win } = makeLoadWindow({ [transUrl]: { ok: false, body: "" } });
    let transport = new FakeTransport(new Map([["en", liveEn]]));
    let adapter = await adapterWithListFor(transport, win);
    let res = await adapter.loadTracks(
      [{ id: "yt:en+ru", lang: "ru", role: "translation", source: "youtube", baseId: "yt:en" }],
      { parser: fakeParser },
    );
    expect(res.tracks).toHaveLength(0);
    expect(res.failures[0].reason).toContain("HTTP");

    const { win: win2 } = makeLoadWindow({ [transUrl]: { ok: true, body: "битый" } });
    transport = new FakeTransport(new Map([["en", liveEn]]));
    adapter = await adapterWithListFor(transport, win2);
    res = await adapter.loadTracks(
      [{ id: "yt:en+ru", lang: "ru", role: "translation", source: "youtube", baseId: "yt:en" }],
      { parser: fakeParser },
    );
    expect(res.failures[0].reason).toContain("разбор не удался");
  });
});

describe("перехват timedtext-ответов (хук fetch/XHR)", () => {
  function fakeWindowWithFetch(): { win: PageWindow; calls: string[] } {
    const calls: string[] = [];
    const win = {
      location: { href: "https://www.youtube.com/watch?v=Q" },
      document: { getElementById: () => null },
      fetch: ((_u: string) => {
        calls.push("fetch");
        return Promise.resolve({
          clone() {
            return { text: () => Promise.resolve("тело") };
          },
        });
      }),
    } as unknown as PageWindow;
    return { win, calls };
  }

  it("тела timedtext-ответов попадают в буфер, оригинальный вызов не тронут", async () => {
    const { win, calls } = fakeWindowWithFetch();
    const source = installTimedtextCapture(win);
    await win.fetch("https://www.youtube.com/api/timedtext?v=Q&lang=en&fmt=json3");
    await new Promise((r) => setTimeout(r, 10)); // чтение клона асинхронно
    expect(calls).toEqual(["fetch"]);
    expect(source.findFor("Q", "en")?.body).toBe("тело");
    expect(source.findFor("Q", "en-GB")).toBeNull(); // точное совпадение lang
    expect(source.findFor("ДРУГОЕ", "en")).toBeNull(); // реклама/чужое видео — мимо
  });

  it("не-timedtext fetch не пишется в буфер; повторная установка идемпотентна", async () => {
    const { win, calls } = fakeWindowWithFetch();
    const a = installTimedtextCapture(win);
    const b = installTimedtextCapture(win);
    expect(b).toBe(a); // один источник, без повторной обёртки
    await win.fetch("https://www.youtube.com/other?v=Q&lang=en");
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual(["fetch"]);
    expect(a.all()).toHaveLength(0); // не timedtext — мимо буфера
  });
});

describe("гашение нативных субтитров плеера (docs/03 §2)", () => {
  function fakeDoc(): DocumentLike & { classes: string[]; css: string[] } {
    const classes: string[] = [];
    const css: string[] = [];
    return {
      classes,
      css,
      documentElement: {
        classList: {
          add: (c) => {
            if (!classes.includes(c)) classes.push(c); // DOM add идемпотентен
          },
          remove: (c) => {
            const i = classes.indexOf(c);
            if (i >= 0) classes.splice(i, 1);
          },
          contains: (c) => classes.includes(c),
        },
        appendChild: (node) => {
          css.push(String((node as { textContent?: string }).textContent ?? ""));
          return node;
        },
      },
      getElementById: (id) => (id === "duopulse-yt-captions-off-style" && css.length ? { id } : null),
      createElement: () => ({ textContent: "", id: "" }),
    };
  }

  it("blank ставит класс и инжектит правило скрытия слоя плеера", () => {
    const doc = fakeDoc();
    blankYouTubeCaptions(doc, true);
    expect(doc.classes).toContain(YT_NATIVE_CAPTIONS_CLASS);
    expect(doc.css[0]).toContain(".ytp-caption-window-container");
    expect(doc.css[0]).toContain("display:none");
  });

  it("повторный blank не дублирует правило; restore снимает класс", () => {
    const doc = fakeDoc();
    blankYouTubeCaptions(doc, true);
    blankYouTubeCaptions(doc, true);
    expect(doc.css).toHaveLength(1);
    blankYouTubeCaptions(doc, false);
    expect(doc.classes).not.toContain(YT_NATIVE_CAPTIONS_CLASS);
    expect(doc.css).toHaveLength(1); // правило остаётся, CSS не активен без класса
  });
});

// --- карточка duopulse-060: аудио-поток для ASR -------------------------------

describe("audioSource: audio-only формат player-ответа (карточка duopulse-060)", () => {
  const audioFormats = (extra: Record<string, unknown>[] = []) => ({
    videoDetails: { videoId: "TEST" },
    audioTracks: [{ languageCode: "ru", original: true }],
    streamingData: {
      adaptiveFormats: [
        { mimeType: "video/mp4; codecs=avc1", url: "https://v.example/v", bitrate: 800_000 },
        { mimeType: "audio/webm; codecs=opus", url: "https://a.example/opus", bitrate: 160_000 },
        { mimeType: "audio/mp4; codecs=mp4a.40.2", url: "https://a.example/m4a", bitrate: 130_000 },
        ...extra,
      ],
    },
  });

  it("предпочитает m4a/AAC (декодер Core без opus) и берёт язык оригинала", () => {
    const adapter = new YouTubeAdapter({
      win: makeWindow({ href: "https://www.youtube.com/watch?v=TEST", playerResponse: audioFormats() }),
    });
    const src = adapter.audioSource();
    expect(src).not.toBeNull();
    expect(src!.url).toBe("https://a.example/m4a");
    expect(src!.lang).toBe("ru");
  });

  it("без m4a берёт опус высшего битрейта; зашифрованные URL пропускает", () => {
    const response = {
      videoDetails: { videoId: "TEST" },
      streamingData: {
        adaptiveFormats: [
          { mimeType: "audio/webm; codecs=opus", url: "https://a.example/opus-lo", bitrate: 90_000 },
          { mimeType: "audio/webm; codecs=opus", url: "https://a.example/opus-hi", bitrate: 200_000 },
          { mimeType: "audio/mp4", signatureCipher: "s=..&url=..", bitrate: 999_999 },
        ],
      },
    };
    const adapter = new YouTubeAdapter({
      win: makeWindow({ href: "https://www.youtube.com/watch?v=TEST", playerResponse: response }),
    });
    expect(adapter.audioSource()?.url).toBe("https://a.example/opus-hi");
  });

  it("нет аудио-форматов / нет player-ответа — null", () => {
    const adapter = new YouTubeAdapter({
      win: makeWindow({
        href: "https://www.youtube.com/watch?v=TEST",
        playerResponse: { videoDetails: { videoId: "TEST" }, streamingData: { adaptiveFormats: [] } },
      }),
    });
    expect(adapter.audioSource()).toBeNull();
    const empty = new YouTubeAdapter({
      win: makeWindow({ href: "https://www.youtube.com/watch?v=TEST" }),
    });
    expect(empty.audioSource()).toBeNull();
  });
});
