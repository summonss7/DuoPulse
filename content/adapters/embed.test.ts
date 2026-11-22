// Юнит-тесты дорожек плеер-фреймов (карточка duopulse-199): парсер
// инлайн-конфига embf-плеера (makePlayer → source.cc, живая фикстура с
// uakinogo/«Человек-паук: Новый день»), язык по имени дорожки, часы
// FrameVideoProxy (интерполяция между сообщениями агента) и протокол
// EmbedHost (video/cues/file/bye) на happy-dom окне.
// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import {
  EmbedHost,
  FrameVideoProxy,
  autoTranslateEmbedDecision,
  langOfTrackName,
  observePlayerApiXhr,
  parseCinemarSubtitles,
  parseMakePlayerCc,
} from "./embed";
import type { Cue, Track } from "../types";

/** Живой фрагмент эмбеда api.embf.net (duopulse-198: инлайн makePlayer,
 * пять .vtt в source.cc, аудио-дубляжи с Eng.Original; подписи вырезаны). */
const EMBF_HTML = `
<html><body><div id="player"></div>
<script>
  function makePlayer(opts) { window.__p = opts; }
  var playerBase = "https://unpkg.com/player-venom@0.3.8/dist/";
</script>
<script>
  makePlayer({
    blocked: false ,
    title: "Человек-паук: Новый день",
    id: 872909 ,
    source: {
      dash: "https://cdn.example/dash.mpd?ha=c8008cab&hc=05f2a1c",
      hls: "https://cdn.example/hls/master.m3u8?ha=c8008cab",
      audio: {"names":["MovieDalen","Red Head Sound","HDrezka Studio (Дубл.)","HDRezka Studio","TVShows","LeDoyen (укр)","Eng.Original"],"order":[1,2,3,4,5,0,6]},
      cc: [{"url":"https://cdn.example/subs/15ce3dd8d1.vtt?ha=c8008cab&t=1796045887","name":"Eng. full - 1"},{"url":"https://cdn.example/subs/4b3fafd0e1.vtt?ha=c8008cab&t=1796045887","name":"Укр. повні - 2"},{"url":"https://cdn.example/subs/38863d1849.vtt?ha=c8008cab&t=1796045887","name":"Укр. форсовані - 3"},{"url":"https://cdn.example/subs/10d4e8c570.vtt?ha=c8008cab&t=1796045887","name":"Рус. полные - 4"},{"url":"https://cdn.example/subs/d70c46316d.vtt?ha=c8008cab&t=1796045887","name":"Рус. форсированные - 5"}]
    },
    sections: [],
    p2p: { geo: ["UA","","AS48323"], tolerance: 4 }
  });
</script>
</body></html>`;

function fakeDoc(html: string): Document {
  const doc = document.implementation.createHTMLDocument("embed");
  doc.write(html);
  return doc;
}

describe("langOfTrackName", () => {
  it("префиксы кино-плееров → BCP-47", () => {
    expect(langOfTrackName("Eng. full")).toBe("en");
    expect(langOfTrackName("English subtitles")).toBe("en");
    expect(langOfTrackName("Укр. повні")).toBe("uk");
    expect(langOfTrackName("Рус. полные")).toBe("ru");
    expect(langOfTrackName("Форсовані")).toBe("und");
  });
});

describe("parseMakePlayerCc", () => {
  it("вынимает все .vtt из source.cc, оригинал — по Eng.Original в аудио", () => {
    const tracks = parseMakePlayerCc(fakeDoc(EMBF_HTML));
    expect(tracks.map((t) => `${t.lang}:${t.name}`)).toEqual([
      "en:Eng. full",
      "uk:Укр. повні",
      "uk:Укр. форсовані",
      "ru:Рус. полные",
      "ru:Рус. форсированные",
    ]);
    // Оригинал — английская дорожка (сигнал аудио-дубляжей плеера).
    expect(tracks.filter((t) => t.original).map((t) => t.lang)).toEqual(["en"]);
    // id стабилен: embed:<lang>:<index>.
    expect(tracks[0].id).toBe("embed:en:0");
    expect(tracks[4].id).toBe("embed:ru:4");
    // URL подписанный, целиком.
    expect(tracks[0].url).toContain("15ce3dd8d1.vtt?ha=c8008cab&t=1796045887");
  });

  it("без makePlayer и без <track> — пусто; <track> даёт generic-дорожки", () => {
    expect(parseMakePlayerCc(fakeDoc("<p>трейлер</p>"))).toEqual([]);
    const doc = fakeDoc(
      '<video><track kind="captions" src="https://x.example/a.vtt" label="English" srclang="en"></video>',
    );
    const tracks = parseMakePlayerCc(doc);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].lang).toBe("en");
    expect(tracks[0].name).toBe("English");
    expect(tracks[0].original).toBe(false);
  });

  it("конфиг без Eng.Original в аудио — original ни у одной дорожки", () => {
    const html = EMBF_HTML.replace('"Eng.Original"', '"Another Studio"');
    expect(parseMakePlayerCc(fakeDoc(html)).every((t) => !t.original)).toBe(true);
  });
});

describe("FrameVideoProxy", () => {
  it("интерполирует время между сообщениями агента и тикает timeupdate", () => {
    // performance тоже фейковый: интерполяция прокси идёт по performance.now
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
    try {
      const proxy = new FrameVideoProxy();
      const ticks: number[] = [];
      proxy.addEventListener("timeupdate", () => ticks.push(proxy.currentTime));
      proxy.update(10, false, 1); // играет с 10 с
      expect(proxy.currentTime).toBeCloseTo(10, 1);
      vi.advanceTimersByTime(250); // интервал прокси ~4 Гц
      expect(ticks.length).toBeGreaterThanOrEqual(1);
      expect(proxy.currentTime).toBeGreaterThan(10);
      // Скорость 2x учитывается, пауза замораживает.
      proxy.update(20, false, 2);
      vi.advanceTimersByTime(500);
      expect(proxy.currentTime).toBeCloseTo(21, 1);
      proxy.update(21, true, 1);
      vi.advanceTimersByTime(1000);
      expect(proxy.currentTime).toBe(21);
      proxy.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("EmbedHost (протокол relay)", () => {
  interface HostEvents {
    video: { videoKey: string; tracks: number }[];
    gone: string[];
    files: { name: string; text: string }[];
  }

  function makeHost(): { host: EmbedHost; events: HostEvents } {
    const events: HostEvents = { video: [], gone: [], files: [] };
    const host = new EmbedHost({
      onVideo: (v) => events.video.push({ videoKey: v.videoKey, tracks: v.tracks.length }),
      onGone: (key) => events.gone.push(key),
      onFile: (name, text) => events.files.push({ name, text }),
    });
    (host as unknown as { iframeBySource: () => HTMLIFrameElement | null }).iframeBySource =
      () => document.createElement("iframe"); // подмена protected-метода
    host.start();
    return { host, events };
  }

  const msg = (data: Record<string, unknown>): void => {
    window.dispatchEvent(new MessageEvent("message", { data }));
  };

  it("video → onVideo; повтор того же ключа — не дублирует, часы идут", async () => {
    const { host, events } = makeHost();
    msg({ duopulseFrame: true, type: "video", videoKey: "k1", url: "https://p.example/e", tracks: [{ id: "embed:en:0", lang: "en", name: "Eng", url: "https://x/a.vtt", original: true }] });
    msg({ duopulseFrame: true, type: "video", videoKey: "k1", url: "https://p.example/e", tracks: [] });
    expect(events.video).toEqual([{ videoKey: "k1", tracks: 1 }, { videoKey: "k1", tracks: 0 }]);
    msg({ duopulseFrame: true, type: "clock", videoKey: "k1", t: 5, paused: false, rate: 1 });
    expect(host.state().videoKey).toBe("k1");
    expect(host.state().tracks.map((t) => t.id)).toEqual([]);
  });

  it("file/bye — ручной файл из фрейма и уход видео", () => {
    const { events } = makeHost();
    msg({ duopulseFrame: true, type: "video", videoKey: "k2", url: "u", tracks: [] });
    msg({ duopulseFrame: true, type: "file", name: "movie.en.srt", text: "1\n00:00:01,000 --> 00:00:02,000\nHi" });
    msg({ duopulseFrame: true, type: "bye", videoKey: "k2" });
    expect(events.files).toEqual([{ name: "movie.en.srt", text: expect.stringContaining("Hi") }]);
    expect(events.gone).toEqual(["k2"]);
  });

  it("loadTrack — запрос в фрейм и cues по ответу агента", async () => {
    const { host } = makeHost();
    msg({ duopulseFrame: true, type: "video", videoKey: "k3", url: "u", tracks: [{ id: "embed:en:0", lang: "en", name: "Eng", url: "https://x/a.vtt", original: true }] });
    // contentWindow в happy-dom пуст — postMessage в фрейм уходит вникуда;
    // ответ агента эмулируем общим сообщением по reqId запроса.
    const replyCues: Cue[] = [{ startMs: 1000, endMs: 2000, text: "Hi" }];
    const pending = host.loadTrack("https://x/a.vtt", async (payload) => {
      expect(payload).toContain("WEBVTT");
      return { cues: replyCues, warnings: [] };
    });
    // Ответ агента приходит общим сообщением: reqId=1 (первый запрос).
    msg({ duopulseFrame: true, type: "cues", reqId: 1, ok: true, payload: "WEBVTT\n\n00:01.000 --> 00:02.000\nHi" });
    await expect(pending).resolves.toEqual(replyCues);
  });

  it("чужие postMessage (без маркера) игнорируются", () => {
    const { events } = makeHost();
    msg({ type: "video", videoKey: "spoofed" });
    window.dispatchEvent(new MessageEvent("message", { data: "string-not-object" }));
    expect(events.video).toEqual([]);
  });
});

// Автоперевод дорожки плеер-фрейма (duopulse-196): чистое решение — когда
// облачная строка-перевод поднимается сама (согласие + дефолт-набор из
// одного оригинала), цель — правило дуо defaultTranslationTarget.
describe("autoTranslateEmbedDecision (duopulse-196)", () => {
  const cue: Cue = { startMs: 0, endMs: 1, text: "hi" };
  const embedTrack = (over: Partial<Track> = {}): Track => ({
    id: "embed:en:0",
    source: "embed",
    lang: "en",
    role: "original",
    cues: [cue],
    ...over,
  });
  const args = (over: Partial<Parameters<typeof autoTranslateEmbedDecision>[0]> = {}) => ({
    platformTracks: [embedTrack()],
    translateTracks: [],
    fileTracks: [],
    targetLang: "ru",
    consent: true,
    declined: false,
    ...over,
  });

  it("дефолт-набор с согласием — переводить (en → ru)", () => {
    const d = autoTranslateEmbedDecision(args());
    expect(d.run).toBe(true);
    expect(d.source?.id).toBe("embed:en:0");
  });

  it("без согласия/после отказа — не трогать", () => {
    expect(autoTranslateEmbedDecision(args({ consent: false })).run).toBe(false);
    expect(autoTranslateEmbedDecision(args({ declined: true })).run).toBe(false);
  });

  it("цель равна языку оригинала — не переводить; правило ru → en живо", () => {
    // en-оригинал с целью en — бессмысленный перевод
    expect(autoTranslateEmbedDecision(args({ targetLang: "en" })).run).toBe(false);
    // русский оригинал → en (правило дуо duopulse-196)
    const toEn = args({ platformTracks: [embedTrack({ id: "embed:ru:3", lang: "ru" })], targetLang: "en" });
    expect(autoTranslateEmbedDecision(toEn).run).toBe(true);
    // русский оригинал с целью ru — нет
    const same = args({ platformTracks: [embedTrack({ id: "embed:ru:3", lang: "ru" })], targetLang: "ru" });
    expect(autoTranslateEmbedDecision(same).run).toBe(false);
  });

  it("не дефолт-набор (свой состав/файлы/готовый перевод) — не вмешиваться", () => {
    const second = embedTrack({ id: "embed:uk:1", lang: "uk", role: "translation" });
    expect(autoTranslateEmbedDecision(args({ platformTracks: [embedTrack(), second] })).run).toBe(false);
    expect(autoTranslateEmbedDecision(args({ fileTracks: [embedTrack({ id: "file:en", source: "file" })] })).run).toBe(false);
    const cloud = { id: "cloud:ru", source: "translate", lang: "ru", role: "translation", cues: [cue] } as Track;
    expect(autoTranslateEmbedDecision(args({ translateTracks: [cloud] })).run).toBe(false);
  });

  it("без cue/неизвестный язык — не переводить; без сигнала оригинала — переводить (duopulse-225)", () => {
    // cinemar языка аудио не даёт: solo-дорожка дефолт-набора с ролью
    // translation — всё равно строка-оригинал, вторую строку поднимает облако
    expect(
      autoTranslateEmbedDecision(args({ platformTracks: [embedTrack({ role: "translation" })] })).run,
    ).toBe(true);
    expect(autoTranslateEmbedDecision(args({ platformTracks: [embedTrack({ cues: [] })] })).run).toBe(false);
    expect(
      autoTranslateEmbedDecision(args({ platformTracks: [embedTrack({ lang: "und" })], targetLang: "ru" })).run,
    ).toBe(false);
  });
});

describe("FrameVideoProxy + движок (сквозные часы)", () => {
  it("clock-сообщения ведут время движка — активные строки появляются", async () => {
    const { SubtitlesEngine } = await import("../engine/subtitles-engine");
    const proxy = new FrameVideoProxy();
    const rowsSeen: number[] = [];
    const engine = new SubtitlesEngine({
      onRowsChange(rows) {
        rowsSeen.push(rows.length);
      },
    });
    engine.setTracks([
      { id: "embed:en:0", source: "embed", lang: "en", role: "original", cues: [
        { startMs: 1000, endMs: 2500, text: "Hi" },
        { startMs: 3000, endMs: 4500, text: "There" },
      ] },
    ]);
    engine.attach(proxy);
    expect(engine.state().attached).toBe(true);
    // 0.5 с — пауза: реплики нет
    proxy.update(0.5, true, 1);
    expect(engine.state().activeRows.length).toBe(0);
    // 1.2 c играет — активна «Hi»
    proxy.update(1.2, false, 1);
    expect(engine.state().activeRows.map((r) => r.text)).toEqual(["Hi"]);
    // 3.5 с — «There»
    proxy.update(3.5, false, 1);
    expect(engine.state().activeRows.map((r) => r.text)).toEqual(["There"]);
    proxy.dispose();
  });
});

describe("parseCinemarSubtitles (duopulse-225)", () => {
  const resolve = (u: string): string => new URL(u, "https://cinemar.cc").href;
  /** Живой ответ POST /api/playlist/load (Дьявол носит Прада 2, дубляж
   * TVShows): Русский + English, URL относительны origin плеера. */
  const PAYLOAD = JSON.stringify({
    file: "https://cfnd.cinemap.cc/…/hls.m3u8",
    duration: 7216,
    subtitle:
      "[Русский]/static/subtitle/543/114543/bf4950/rus.vtt,[English]/static/subtitle/543/114543/bf4950/eng.vtt",
  });

  it("вынимает дорожки из поля subtitle, URL — абсолютные, язык по имени", () => {
    const tracks = parseCinemarSubtitles(PAYLOAD, resolve);
    expect(tracks.map((t) => `${t.lang}:${t.name}`)).toEqual(["ru:Русский", "en:English"]);
    expect(tracks[0].url).toBe("https://cinemar.cc/static/subtitle/543/114543/bf4950/rus.vtt");
    expect(tracks[1].url).toBe("https://cinemar.cc/static/subtitle/543/114543/bf4950/eng.vtt");
    // языка аудио плеер не сообщает — сигнала оригинала нет
    expect(tracks.every((t) => !t.original)).toBe(true);
    // id — стабильный префикс, не пересекающийся с нумерацией makePlayer
    expect(tracks.map((t) => t.id)).toEqual(["embed:cinemar:0", "embed:cinemar:1"]);
  });

  it("не-JSON / без subtitle / абсолютные URL — устойчиво", () => {
    expect(parseCinemarSubtitles("не json", resolve)).toEqual([]);
    expect(parseCinemarSubtitles(JSON.stringify({ file: "https://x/hls.m3u8" }), resolve)).toEqual([]);
    const abs = parseCinemarSubtitles(
      JSON.stringify({ subtitle: "[English]https://cdn.example/e.vtt" }),
      resolve,
    );
    expect(abs).toHaveLength(1);
    expect(abs[0].url).toBe("https://cdn.example/e.vtt");
  });
});

describe("observePlayerApiXhr (duopulse-225)", () => {
  /** Минимальный XHR-двойник: обёртка должна работать поверх любого базового
   * класса (реальный — happy-dom XHR без сети в тесте не нужен). */
  class FakeXHR {
    responseText = "";
    private listener: (() => void) | null = null;
    openedUrl = "";
    sentBody: unknown = null;
    addEventListener(_type: string, l: () => void): void {
      this.listener = l;
    }
    open(_method: string, url: string | URL): void {
      this.openedUrl = String(url);
    }
    send(body?: unknown): void {
      this.sentBody = body ?? null;
    }
    fireLoad(): void {
      this.listener?.();
    }
  }

  it("ответ playlist/load уходит в apply; чужие URL и повторная обёртка — нет", () => {
    const saved = window.XMLHttpRequest;
    const payloads: string[] = [];
    try {
      window.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
      observePlayerApiXhr((p) => payloads.push(p));
      const first = window.XMLHttpRequest;
      // повторный вызов не оборачивает второй раз
      observePlayerApiXhr((p) => payloads.push(p));
      expect(window.XMLHttpRequest).toBe(first);

      const xhr = new (window.XMLHttpRequest as unknown as new () => FakeXHR & { dpUrl?: string })();
      xhr.responseText = '{"subtitle":"[English]/e.vtt"}';
      xhr.open("POST", "/api/playlist/load");
      xhr.send(null);
      expect(xhr.sentBody).toBeNull(); // send проброшен базовому классу
      xhr.fireLoad();
      expect(payloads).toEqual(['{"subtitle":"[English]/e.vtt"}']);

      // чужой URL — слушатель не вешается
      const other = new (window.XMLHttpRequest as unknown as new () => FakeXHR & { dpUrl?: string })();
      other.responseText = '{"subtitle":"[English]/e.vtt"}';
      other.open("POST", "/api/other");
      other.send(null);
      other.fireLoad();
      expect(payloads).toHaveLength(1);
    } finally {
      window.XMLHttpRequest = saved;
    }
  });
});
