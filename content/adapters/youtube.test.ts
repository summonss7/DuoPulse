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
  originalLangsOf,
  paramsOf,
  videoIdFromHref,
  videoIdOfResponse,
  type DocumentLike,
  type PageWindow,
  type PlayerElement,
  type YouTubeTransport,
} from "./youtube";
import { defaultSetIds } from "../set-defaults";
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
  /** audioTracks рендерера (web-клиент, живая запись — duopulse-070); у
   *  старых фикстур нет: записаны рекордером до захвата этого поля. */
  audioTracks?: Record<string, unknown>[];
}

/** Фикстура → player-ответ (обёртка captions-части в структуру ответа). */
function playerResponseOf(fx: Fixture): Record<string, unknown> {
  return {
    videoDetails: { videoId: fx.videoId, title: fx.title },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: fx.captionTracks,
        translationLanguages: fx.translationLanguages,
        ...(fx.audioTracks ? { audioTracks: fx.audioTracks } : {}),
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
  uiLang?: string;
}): PageWindow & { ytInitialPlayerResponse?: unknown } {
  const player: PlayerElement | null =
    opts.playerResponse !== undefined
      ? { getPlayerResponse: () => opts.playerResponse }
      : null;
  return {
    location: { href: opts.href },
    document: {
      getElementById: (id: string) => (id === "movie_player" && player ? player : null),
      ...(opts.uiLang !== undefined ? { documentElement: { lang: opts.uiLang } } : {}),
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

  it("язык оригинала (верхнеуровневые audioTracks[].original, TV/ANDROID-клиент) помечается и становится базой по умолчанию", async () => {
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

  it("duopulse-070: TED без audioTracks[].original — оригинал en по asr-дорожке, не af и не ro", async () => {
    const fx = fixtures.find((f) => f.videoId === "iG9CE55wbtY")!;
    // фикстура несёт живые renderer.audioTracks (web-клиент, 04.11.2026):
    // без original/originalLanguage; defaultCaptionTrackIndex=51 → ro —
    // рекомендация под язык интерфейса записывавшей сессии (hl=ro)
    const response = playerResponseOf(fx);
    const langs = originalLangsOf(response);
    expect(langs).toEqual(new Set(["en"])); // en-asr (vssId a.en) — оригинал
    const adapter = new YouTubeAdapter({
      win: makeWindow({ href: `https://www.youtube.com/watch?v=${fx.videoId}`, playerResponse: response }),
    });
    const list = await adapter.listTracks();
    expect(list!.base.find((b) => b.id === "yt:en")!.original).toBe(true);
    expect(list!.base.find((b) => b.id === "yt:en:asr")!.original).toBe(true);
    expect(list!.base[0].original).toBe(false); // af — первая по алфавиту
    expect(list!.base.find((b) => b.id === "yt:ro")!.original).toBe(false); // defaultCaptionTrackIndex-ловушка
    // дефолтный набор Alt+D: «оригинал + предпочитаемый перевод» (порядок
    // хозяина duopulse-094: en→ro→ru→ar — ro прежде ru), не af+перевод
    const ids = defaultSetIds(list);
    expect(ids).toEqual(["yt:en", "ro"]);
    // голый код перевода — базой становится оригинал
    const { refs } = adapter.resolveIds(["ru"]);
    expect(refs[0].baseId).toBe("yt:en");
  });

  it("duopulse-070: только asr-дорожка (Gangnam ko) — она и оригинал", () => {
    const fx = fixtures.find((f) => f.videoId === "9bZkp7q19f0")!;
    expect(originalLangsOf(playerResponseOf(fx))).toEqual(new Set(["ko"]));
  });

  it("duopulse-159: мульти-даб (Милан ru+en-US) — оригинал ru по первому audioTrackId, asr-дуб en не оригинал", async () => {
    const fx = fixtures.find((f) => f.videoId === "Rc-AVTv5nMI")!;
    // фикстура — живой web-ответ 16.11.2026: captionTracks [en:asr, ru:asr],
    // renderer.audioTracks [ru.4 (ON_RECOMMENDED), en-US.10 (OFF)] — RU-канал,
    // оригинальная озвучка первая при hl=en и hl=ro
    const response = playerResponseOf(fx);
    expect(originalLangsOf(response)).toEqual(new Set(["ru"]));
    const adapter = new YouTubeAdapter({
      win: makeWindow({ href: `https://www.youtube.com/watch?v=${fx.videoId}`, playerResponse: response }),
    });
    const list = await adapter.listTracks();
    expect(list!.base.find((b) => b.id === "yt:ru:asr")!.original).toBe(true);
    expect(list!.base.find((b) => b.id === "yt:en:asr")!.original).toBe(false);
    // дефолт-набор при предпочитаемом ru (настройка Артёма): русская база,
    // перевод ru исключён как язык оригинала → en вторым; НЕ en-asr дуба
    const ids = defaultSetIds(list, ["ru", "en", "ro", "ru", "ar"]);
    expect(ids).toEqual(["yt:ru:asr", "en"]);
  });

  it("duopulse-159: audioTrackId даба не подменяет явную пометку originalLanguage", () => {
    const response = playerResponseOf({
      videoId: "x",
      url: "",
      title: "",
      captionTracks: [
        { languageCode: "ja", vssId: ".ja" },
        { languageCode: "en", vssId: ".en" },
      ],
      translationLanguages: [],
      audioTracks: [
        { captionTrackIndices: [0], audioTrackId: "en-US.10" },
        { captionTrackIndices: [1], originalLanguage: "ja" },
      ],
    });
    expect(originalLangsOf(response)).toEqual(new Set(["ja"]));
  });

  it("duopulse-159: renderer.audioTracks без аудио-маркеров (одиночное видео) — asr-фолбэк работает", () => {
    const response = playerResponseOf({
      videoId: "x",
      url: "",
      title: "",
      captionTracks: [{ languageCode: "ko", kind: "asr", vssId: "a.ko" }],
      translationLanguages: [],
      audioTracks: [{ captionTrackIndices: [0], hasDefaultTrack: true, defaultCaptionTrackIndex: 0 }],
    });
    expect(originalLangsOf(response)).toEqual(new Set(["ko"]));
  });

  // duopulse-184 (Sam Smith vk_xq1P7vIU): 7 ручных дорожек без asr и без
  // аудио-маркеров, первым в списке zh-Hans — дефолт-набор брал китайскую
  // дорожку. Спасает п.4: defaultCaptionTrackIndex (web-ответ idx=1 → en)
  // при языке UI, отличном от индексного.
  const samSmithResponse = (): unknown =>
    playerResponseOf({
      videoId: "vk_xq1P7vIU",
      url: "",
      title: "",
      captionTracks: [
        { languageCode: "zh-Hans", vssId: ".zh-Hans" },
        { languageCode: "en", vssId: ".en", isTranslatable: true },
        { languageCode: "pt-BR", vssId: ".pt-BR" },
      ],
      translationLanguages: [{ languageCode: "ru" }, { languageCode: "en" }],
      audioTracks: [
        { captionTrackIndices: [0, 1, 2], hasDefaultTrack: true, defaultCaptionTrackIndex: 1 },
      ],
    });

  it("duopulse-184: индекс ≠ язык UI — контентный фолбэк YouTube помечается оригиналом", () => {
    expect(originalLangsOf(samSmithResponse(), "ru")).toEqual(new Set(["en"]));
    expect(originalLangsOf(samSmithResponse(), "ro-RO")).toEqual(new Set(["en"]));
  });

  it("duopulse-184: индекс совпал с языком UI или UI неизвестен — пометки нет (неразличимо)", () => {
    expect(originalLangsOf(samSmithResponse(), "en")).toEqual(new Set());
    expect(originalLangsOf(samSmithResponse())).toEqual(new Set());
    expect(originalLangsOf(samSmithResponse(), "x1")).toEqual(new Set()); // битный код UI
  });

  it("duopulse-184: asr надёжнее индекса — при asr-дорожке п.4 не применяется", () => {
    const response = playerResponseOf({
      videoId: "x",
      url: "",
      title: "",
      captionTracks: [
        { languageCode: "en", vssId: ".en" },
        { languageCode: "ru", vssId: ".ru" },
        { languageCode: "ru", kind: "asr", vssId: "a.ru" },
      ],
      translationLanguages: [],
      audioTracks: [
        { captionTrackIndices: [0, 1, 2], hasDefaultTrack: true, defaultCaptionTrackIndex: 0 },
      ],
    });
    expect(originalLangsOf(response, "ro")).toEqual(new Set(["ru"]));
  });

  it("duopulse-184: индекс вне списка/без индекса — пометки нет, дефолт прежний", () => {
    const oob = playerResponseOf({
      videoId: "x",
      url: "",
      title: "",
      captionTracks: [{ languageCode: "en", vssId: ".en" }],
      translationLanguages: [],
      audioTracks: [{ captionTrackIndices: [0], hasDefaultTrack: true, defaultCaptionTrackIndex: 7 }],
    });
    expect(originalLangsOf(oob, "ru")).toEqual(new Set());
    const noIdx = playerResponseOf({
      videoId: "x",
      url: "",
      title: "",
      captionTracks: [{ languageCode: "en", vssId: ".en" }],
      translationLanguages: [],
      audioTracks: [{ captionTrackIndices: [0], hasDefaultTrack: false, defaultCaptionTrackIndex: 0 }],
    });
    expect(originalLangsOf(noIdx, "ru")).toEqual(new Set());
  });

  it("duopulse-184: адаптер помечает en оригиналом и дефолт-набор берёт его (не zh-Hans)", async () => {
    const adapter = new YouTubeAdapter({
      win: makeWindow({
        href: "https://www.youtube.com/watch?v=vk_xq1P7vIU&list=RDvk_xq1P7vIU&start_radio=1",
        playerResponse: samSmithResponse(),
        uiLang: "ru",
      }),
    });
    const list = await adapter.listTracks();
    expect(list!.base.find((b) => b.id === "yt:en")!.original).toBe(true);
    expect(list!.base.find((b) => b.id === "yt:zh-Hans")!.original).toBe(false);
    const ids = defaultSetIds(list, ["ru", "en", "ro", "ru", "ar"]);
    expect(ids).toEqual(["yt:en", "ru"]);
  });

  it("duopulse-184: оригинал неизвестен (живой ответ без индекса) — дефолты берут en, не первую zh-Hans", async () => {
    // живой web-ответ анонимной сессии: renderer.audioTracks без
    // defaultCaptionTrackIndex/originalLanguage, дорожки все ручные
    const response = playerResponseOf({
      videoId: "vk_xq1P7vIU",
      url: "",
      title: "",
      captionTracks: [
        { languageCode: "zh-Hans", vssId: ".zh-Hans", isTranslatable: true },
        { languageCode: "en", vssId: ".en", isTranslatable: true },
        { languageCode: "pt-BR", vssId: ".pt-BR", isTranslatable: true },
      ],
      translationLanguages: [{ languageCode: "ru" }],
      audioTracks: [{ captionTrackIndices: [0, 1, 2] }],
    });
    const adapter = new YouTubeAdapter({
      win: makeWindow({
        href: "https://www.youtube.com/watch?v=vk_xq1P7vIU",
        playerResponse: response,
        uiLang: "ro-RO",
      }),
    });
    const list = await adapter.listTracks();
    expect(list!.base.every((b) => !b.original)).toBe(true); // сигнала нет
    const ids = defaultSetIds(list, ["ru"]);
    expect(ids).toEqual(["yt:en", "ru"]); // но дефолт — en (duopulse-184)
    // голый код перевода цепляется к en-базе
    const { refs } = adapter.resolveIds(["ru"]);
    expect(refs[0]!.baseId).toBe("yt:en");
  });

  it("duopulse-070: renderer.audioTracks[].originalLanguage помечается (задел на web-клиент)", () => {
    const response = playerResponseOf({
      videoId: "x",
      url: "",
      title: "",
      captionTracks: [
        { languageCode: "ja", vssId: ".ja" },
        { languageCode: "en", vssId: ".en" },
      ],
      translationLanguages: [],
      audioTracks: [{ captionTrackIndices: [0, 1], originalLanguage: "ja", hasDefaultTrack: true }],
    });
    expect(originalLangsOf(response)).toEqual(new Set(["ja"]));
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
        // clone для хука перехвата timedtext (duopulse-175: буфер и в тестах)
        clone() {
          return { text: () => Promise.resolve(hit?.body ?? "") };
        },
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

  // duopulse-175: перевод с 429 не должен держать показ готового оригинала,
  // а тело, скачанное самим плеером, — переиспользоваться без запроса.
  it("onTrack: дорожки выдаются прогрессивно (база — до перевода), failures не отдаются", async () => {
    const transUrl = "https://x/timedtext?v=TEST&lang=en&fmt=json3&pot=P&tlang=ru";
    const { win } = makeLoadWindow({ [transUrl]: { ok: true, body: "trans:ru" } });
    const transport = new FakeTransport(new Map([["en", liveEn]]));
    const adapter = await adapterWithListFor(transport, win);
    const delivered: string[] = [];
    const res = await adapter.loadTracks(
      [
        { id: "yt:en", lang: "en", role: "original", source: "youtube", languageCode: "en" },
        { id: "yt:en+ru", lang: "ru", role: "translation", source: "youtube", baseId: "yt:en" },
      ],
      {
        parser: fakeParser,
        onTrack: (t) => delivered.push(t.id),
      },
    );
    expect(delivered).toEqual(["yt:en", "yt:en+ru"]); // обе готовы — обе отданы
    expect(res.tracks.map((t) => t.id)).toEqual(delivered); // тот же состав
    // отказ базы не отдаётся прогрессивно — только в failures финала
    const transport2 = new FakeTransport(new Map([["en", null]]));
    const adapter2 = await adapterWithListFor(transport2, makeLoadWindow({}).win);
    const delivered2: string[] = [];
    await adapter2.loadTracks(
      [{ id: "yt:en", lang: "en", role: "original", source: "youtube", languageCode: "en" }],
      { parser: fakeParser, onTrack: (t) => delivered2.push(t.id) },
    );
    expect(delivered2).toEqual([]);
  });

  it("duopulse-175: перевод, скачанный плеером сам (буфер перехвата) — без fetch, даже если своя база не получена", async () => {
    const nativeUrl = "https://x/timedtext?v=TEST&lang=en&tlang=ru&fmt=json3&x=native";
    const transUrl = "https://x/timedtext?v=TEST&lang=en&fmt=json3&pot=P&tlang=ru";
    const { win, requested } = makeLoadWindow({ [nativeUrl]: { ok: true, body: "trans:ru" } });
    const capture = installTimedtextCapture(win);
    await win.fetch(nativeUrl); // плеер сам скачал ru-перевод — тело в буфере
    await new Promise((r) => setTimeout(r, 10));
    expect(capture.findTranslationFor("TEST", "en", "ru")?.body).toBe("trans:ru");
    expect(capture.findTranslationFor("TEST", "en", "es")).toBeNull(); // чужой tlang — мимо
    expect(capture.findTranslationFor("ДРУГОЕ", "en", "ru")).toBeNull(); // чужое видео — мимо
    const transport = new FakeTransport(new Map([["en", null]])); // своя база не получена
    const adapter = new YouTubeAdapter({ win, transport, capture });
    await adapter.listTracks();
    const res = await adapter.loadTracks(
      [{ id: "yt:en+ru", lang: "ru", role: "translation", source: "youtube", baseId: "yt:en" }],
      { parser: fakeParser },
    );
    expect(res.tracks.map((t) => t.id)).toEqual(["yt:en+ru"]);
    expect(requested).toEqual([nativeUrl]); // своего fetch перевода не было
  });

  it("duopulse-175: 429 перевода — максимум 2 попытки, отказ с причиной HTTP 429", async () => {
    let calls = 0;
    const { win } = makeLoadWindow({});
    const fetchImpl = (() => {
      calls++;
      return Promise.resolve({ ok: false, status: 429, text: () => Promise.resolve("") });
    }) as unknown as typeof fetch;
    const transport = new FakeTransport(new Map([["en", liveEn]]));
    const adapter = await adapterWithListFor(transport, win);
    const res = await adapter.loadTracks(
      [{ id: "yt:en+ru", lang: "ru", role: "translation", source: "youtube", baseId: "yt:en" }],
      { parser: fakeParser, fetchImpl },
    );
    expect(calls).toBe(2); // было 3 с паузами 6/12 с — квоту не долбим
    expect(res.failures[0].reason).toContain("429");
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
