// @vitest-environment happy-dom
// Тесты листа загрузок (duopulse-121 → 122): подписи форматов, статусы,
// полный цикл скачивания на фейковом транспорте (fetcher iframe → invoke в
// Rust), рукопожатие ping/pong с таймаутом, отмена закрытием листа.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  audioLabel,
  createMusicDownloader,
  fetchViaTransport,
  idleMusicState,
  mb,
  musicStatusText,
  subLabel,
  toB64,
  videoLabel,
  type DlMessage,
  type DlTransport,
  type DuoFormats,
  type MusicPorts,
  type MusicUiState,
} from "./download";

const FORMATS: DuoFormats = {
  title: "Test Song",
  audio: [
    { itag: 251, mime: "audio/webm", ext: "webm", url: "https://rr.example.webm/", bitrate: 160000, size: 4695276, quality: "", fps: 0, muxed: false },
    { itag: 140, mime: "audio/mp4", ext: "m4a", url: "https://rr.example.m4a/", bitrate: 129476, size: 4624883, quality: "", fps: 0, muxed: false },
    { itag: 139, mime: "audio/mp4", ext: "m4a", url: "https://rr.example.lo/", bitrate: 48000, size: 1743491, quality: "", fps: 0, muxed: false },
  ],
  video: [
    { itag: 137, mime: "video/mp4", ext: "mp4", url: "https://rr.example.1080/", bitrate: 3000000, size: 119063300, quality: "1080p", fps: 30, muxed: false },
    { itag: 136, mime: "video/mp4", ext: "mp4", url: "https://rr.example.720/", bitrate: 1500000, size: 61635771, quality: "720p", fps: 30, muxed: false },
    { itag: 18, mime: "video/mp4", ext: "mp4", url: "https://rr.example.mux/", bitrate: 500000, size: 17167538, quality: "360p", fps: 30, muxed: true },
  ],
  subs: [
    { name: "French (auto-generated)", lang: "fr", asr: true, url: "https://www.youtube.com/api/timedtext?v=1&lang=fr" },
    { name: "English", lang: "en", asr: false, url: "https://www.youtube.com/api/timedtext?v=1&lang=en" },
  ],
};

/** Фейковый транспорт (протокол v2): ping → pong, range → один data-ответ
 * с min(length, file-offset) байтами (короче запрошенного — конец файла),
 * failRange подменяет ответ N-го range-запроса (счёт с 1) ошибкой. */
function fakeTransport(script: {
  pong?: boolean;
  /** размер «файла» на любом url, байт. */
  file?: number;
  failRange?: { n: number; message: string };
}): { transport: DlTransport; posted: unknown[] } {
  const posted: unknown[] = [];
  let handler: ((m: DlMessage) => void) | null = null;
  let ranges = 0;
  const transport: DlTransport = {
    post(msg) {
      posted.push(msg);
      const m = msg as { cmd?: string; id?: string; offset?: number; length?: number };
      if (m.cmd === "ping" && script.pong !== false) {
        setTimeout(() => handler?.({ id: m.id, type: "pong" }), 0);
        return;
      }
      if (m.cmd !== "range") return;
      ranges++;
      const id = m.id ?? "";
      if (script.failRange && ranges === script.failRange.n) {
        const message = script.failRange.message;
        setTimeout(() => handler?.({ id, type: "error", message }), 1);
        return;
      }
      const offset = m.offset ?? 0;
      const bytes = Math.max(0, Math.min(m.length ?? 0, (script.file ?? 0) - offset));
      setTimeout(() => handler?.({ id, type: "data", buf: new ArrayBuffer(bytes) }), 1);
    },
    subscribe(h) {
      handler = h;
      return () => {
        handler = null;
      };
    },
  };
  return { transport, posted };
}

/** DOM-хост листа (jsdom): контейнер + iframe-заглушка не нужны — transport фейк. */
function hostFixture() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}

function ports(transport: DlTransport, invokeMock: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>): MusicPorts {
  return {
    getVideoId: () => "iG9CE55wbtY",
    host: hostFixture(),
    getFrame: () => null,
    render: (text: string) => void text,
    doInvoke: invokeMock,
    transport,
    pingTimeoutMs: 50,
  };
}

describe("подписи и статусы", () => {
  it("audio/video/sub подписи с размером и качеством", () => {
    expect(audioLabel(FORMATS.audio[1])).toBe("M4A · 129 kbps · 4.4 МБ");
    expect(audioLabel(FORMATS.audio[0])).toBe("OPUS · 160 kbps · 4.5 МБ");
    expect(audioLabel({ ...FORMATS.audio[2], size: 0, bitrate: 0 })).toBe("M4A · —");
    expect(videoLabel(FORMATS.video[0])).toBe("1080p · 114 МБ · +звук");
    expect(videoLabel(FORMATS.video[2])).toBe("360p · 16 МБ · готовый");
    expect(videoLabel({ ...FORMATS.video[1], fps: 60 })).toContain("720p 60fps");
    expect(subLabel(FORMATS.subs[0])).toBe("French (auto-generated) (авто)");
    expect(subLabel(FORMATS.subs[1])).toBe("English");
    expect(mb(0)).toBe("0 МБ");
  });

  it("строка статуса по состоянию", () => {
    const s: MusicUiState = { kind: "downloading", message: "", downloading: { label: "M4A", downloaded: 2312441, total: 4624883 } };
    expect(musicStatusText(s)).toBe("⬇ M4A: качаю 50% (2.2 МБ из 4.4 МБ)");
    expect(musicStatusText({ kind: "downloading", message: "", downloading: { label: "SRT", downloaded: 5, total: 0 } })).toBe("⬇ SRT: качаю 0%");
    expect(musicStatusText({ ...idleMusicState(), kind: "done", message: "Song.m4a · Music/DuoPulse" })).toBe("⬇ Сохранено: Song.m4a · Music/DuoPulse");
    expect(musicStatusText({ ...idleMusicState(), kind: "error", message: "HTTP 403" })).toBe("⬇ HTTP 403");
    expect(musicStatusText(idleMusicState())).toBe("");
  });

  it("toB64 кодирует куски без потерь", () => {
    expect(toB64(new Uint8Array([1, 2, 3]))).toBe("AQID");
    const big = new Uint8Array(0x9000 + 7);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    const dec = atob(toB64(big));
    expect(dec.length).toBe(big.length);
    expect(dec.charCodeAt(0x8000)).toBe(big[0x8000]);
  });
});

describe("fetchViaTransport", () => {
  it("диапазоны до конца файла: известный total и EOF по короткому ответу", async () => {
    const { transport } = fakeTransport({ file: 12 });
    // известный total: один диапазон длиной файла
    const seen: [number, number][] = [];
    await fetchViaTransport(transport, "https://rr.example/", async (c, o) => {
      seen.push([c.length, o]);
    }, undefined, 12);
    expect(seen).toEqual([[12, 0]]);
    // total неизвестен: короткий ответ (< запрошенного) — конец файла
    const seen2: [number, number][] = [];
    await fetchViaTransport(transport, "https://rr.example/", async (c, o) => {
      seen2.push([c.length, o]);
    });
    expect(seen2).toEqual([[12, 0]]);
  });

  it("сетевой сбой диапазона — повтор того же offset, файл собирается целиком", async () => {
    const { transport, posted } = fakeTransport({ file: 12, failRange: { n: 1, message: "network reset" } });
    let total = 0;
    await fetchViaTransport(transport, "https://rr.example/", async (c) => {
      total += c.length;
    }, undefined, 12);
    expect(total).toBe(12);
    const offsets = posted
      .filter((m) => (m as { cmd?: string }).cmd === "range")
      .map((m) => (m as { offset: number }).offset);
    // оба запроса — с нуля: байты приписываются только после успеха
    expect(offsets).toEqual([0, 0]);
  });

  it("HTTP 403 не ретраится — исключение наружу", async () => {
    const { transport, posted } = fakeTransport({ file: 0, failRange: { n: 1, message: "HTTP 403" } });
    await expect(
      fetchViaTransport(transport, "https://rr.example/", async () => {}, undefined, 100),
    ).rejects.toThrow("HTTP 403");
    // один запрос — повтора нет
    expect(posted.filter((m) => (m as { cmd?: string }).cmd === "range").length).toBe(1);
  });
});

describe("контроллер листа", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function controller(invokeMock: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>) {
    const { transport } = fakeTransport({ file: 1500 });
    const p = ports(transport, invokeMock);
    const dl = createMusicDownloader(p);
    return { dl, p };
  }

  it("без видео — подсказка, лист не открывается", () => {
    const { transport } = fakeTransport({});
    const p = ports(transport, vi.fn());
    p.getVideoId = () => null;
    const dl = createMusicDownloader(p);
    dl.start();
    expect(dl.stateSnapshot().kind).toBe("error");
    expect(dl.stateSnapshot().message).toContain("откройте видео");
  });

  it("лист: форматы → тап по аудио → полный цикл begin/append/finish", async () => {
    const calls: [string, unknown?][] = [];
    const invokeMock = vi.fn((cmd: string, args?: Record<string, unknown>) => {
      calls.push([cmd, args]);
      if (cmd === "duo_mobile_formats") return Promise.resolve(FORMATS);
      if (cmd === "duo_download_begin") return Promise.resolve(`id-${calls.filter((c) => c[0] === "duo_download_begin").length}`);
      return Promise.resolve("Song.m4a · Music/DuoPulse");
    });
    const { dl, p } = controller(invokeMock);
    dl.start();
    await vi.waitFor(() => expect(dl.stateSnapshot().kind).toBe("ready"));
    // кнопки листа: 3 аудио + 3 видео + 2 субтитра
    const rows = p.host.querySelectorAll("button.m-dl-row");
    expect(rows.length).toBe(8);
    expect(rows[1].textContent).toBe("M4A · 129 kbps · 4.4 МБ");
    (rows[1] as HTMLButtonElement).click();
    await vi.waitFor(() => expect(dl.stateSnapshot().kind).toBe("done"));
    expect(dl.stateSnapshot().message).toContain("Music/DuoPulse");
    const cmds = calls.map((c) => c[0]);
    expect(cmds).toEqual(
      expect.arrayContaining(["duo_mobile_formats", "duo_download_begin", "duo_download_append", "duo_download_finish"]),
    );
    const finish = calls.find((c) => c[0] === "duo_download_finish")![1] as { args: { collection: string; ext: string } };
    expect(finish.args).toMatchObject({ collection: "audio", ext: "m4a" });
  });

  it("видео 720p: две части + finish_mux, в статусе склейка", async () => {
    const calls: [string, unknown?][] = [];
    const invokeMock = vi.fn((cmd: string, args?: Record<string, unknown>) => {
      calls.push([cmd, args]);
      if (cmd === "duo_mobile_formats") return Promise.resolve(FORMATS);
      if (cmd === "duo_download_begin") return Promise.resolve(`part${calls.filter((c) => c[0] === "duo_download_begin").length}`);
      return Promise.resolve("Song.mp4 · Movies/DuoPulse");
    });
    const { dl, p } = controller(invokeMock);
    dl.start();
    await vi.waitFor(() => expect(dl.stateSnapshot().kind).toBe("ready"));
    const rows = p.host.querySelectorAll("button.m-dl-row");
    // 720p (+звук) — вторая видео-строка: аудио(3) + видео[1]
    (rows[4] as HTMLButtonElement).click();
    await vi.waitFor(() => expect(dl.stateSnapshot().kind).toBe("done"));
    const mux = calls.find((c) => c[0] === "duo_download_finish_mux")![1] as { videoPart: string; audioPart: string };
    expect(mux.videoPart).toBe("part1");
    expect(mux.audioPart).toBe("part2");
    expect(calls.filter((c) => c[0] === "duo_download_begin").length).toBe(2);
  });

  it("видео 360p muxed — один begin, finish collection=video", async () => {
    const calls: [string, unknown?][] = [];
    const invokeMock = vi.fn((cmd: string, args?: Record<string, unknown>) => {
      calls.push([cmd, args]);
      if (cmd === "duo_mobile_formats") return Promise.resolve(FORMATS);
      if (cmd === "duo_download_begin") return Promise.resolve("only");
      return Promise.resolve("Song.mp4 · Movies/DuoPulse");
    });
    const { dl, p } = controller(invokeMock);
    dl.start();
    await vi.waitFor(() => expect(dl.stateSnapshot().kind).toBe("ready"));
    const rows = p.host.querySelectorAll("button.m-dl-row");
    (rows[5] as HTMLButtonElement).click();
    await vi.waitFor(() => expect(dl.stateSnapshot().kind).toBe("done"));
    expect(calls.filter((c) => c[0] === "duo_download_begin").length).toBe(1);
    const finish = calls.find((c) => c[0] === "duo_download_finish")![1] as { args: { collection: string } };
    expect(finish.args.collection).toBe("video");
  });

  it("субтитры — один invoke duo_download_subtitle", async () => {
    const calls: [string, unknown?][] = [];
    const invokeMock = vi.fn((cmd: string, args?: Record<string, unknown>) => {
      calls.push([cmd, args]);
      if (cmd === "duo_mobile_formats") return Promise.resolve(FORMATS);
      return Promise.resolve("Song.fr.srt · Download/DuoPulse");
    });
    const { dl, p } = controller(invokeMock);
    dl.start();
    await vi.waitFor(() => expect(dl.stateSnapshot().kind).toBe("ready"));
    const rows = p.host.querySelectorAll("button.m-dl-row");
    (rows[6] as HTMLButtonElement).click();
    await vi.waitFor(() => expect(dl.stateSnapshot().kind).toBe("done"));
    expect(calls.map((c) => c[0])).toEqual(["duo_mobile_formats", "duo_download_subtitle"]);
  });

  it("fetcher молчит — внятная ошибка рукопожатия, tmp прибран", async () => {
    const calls: [string, unknown?][] = [];
    const invokeMock = vi.fn((cmd: string, args?: Record<string, unknown>) => {
      calls.push([cmd, args]);
      if (cmd === "duo_mobile_formats") return Promise.resolve(FORMATS);
      if (cmd === "duo_download_begin") return Promise.resolve("deadbeef");
      return Promise.resolve("x");
    });
    const { transport } = fakeTransport({ pong: false });
    const p = ports(transport, invokeMock);
    const dl = createMusicDownloader(p);
    dl.start();
    await vi.waitFor(() => expect(dl.stateSnapshot().kind).toBe("ready"));
    (p.host.querySelectorAll("button.m-dl-row")[1] as HTMLButtonElement).click();
    await vi.waitFor(() => expect(dl.stateSnapshot().kind).toBe("error"));
    expect(dl.stateSnapshot().message).toContain("YouTube не отвечает");
    expect(calls.map((c) => c[0])).toContain("duo_download_abort");
  });

  it("повторный тап во время загрузки не перезапускает, закрытие отменяет", async () => {
    const invokeMock = vi.fn((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "duo_mobile_formats") return Promise.resolve(FORMATS);
      if (cmd === "duo_download_begin") return Promise.resolve("cancel-me");
      return new Promise(() => {}); // append/finish висят — «качаем»
    });
    const { transport, posted } = fakeTransport({ pong: true, file: 100 });
    const p = ports(transport, invokeMock);
    const dl = createMusicDownloader(p);
    dl.start();
    await vi.waitFor(() => expect(dl.stateSnapshot().kind).toBe("ready"));
    (p.host.querySelectorAll("button.m-dl-row")[1] as HTMLButtonElement).click();
    await vi.waitFor(() => expect(dl.stateSnapshot().kind).toBe("downloading"));
    dl.start(); // повторный тап — просто показать
    expect(dl.stateSnapshot().kind).toBe("downloading");
    (p.host.querySelector(".m-dl-close") as HTMLButtonElement).click();
    expect(dl.stateSnapshot().message).toBe("загрузка отменена");
    expect(posted.some((m) => (m as { cmd: string }).cmd === "cancel")).toBe(true);
  });
});
