// Юнит-тесты ручных файлов субтитров (задача 3.6, docs/03 §3.2): язык из
// имени/заголовка VTT, отбор файлов дропа, сборка дорожек (разбор — фейковый
// парсер Core), смешивание с платформенными в наборе и поведение зоны дропа
// (поглощение только своих файлов, не мешаем сайту) — на фейках, DOM-поведение
// (реальные DragEvent) проверяет e2e.
import { describe, expect, it } from "vitest";
import {
  FileDropZone,
  buildFileTracks,
  combinedTracks,
  fileTrackFrom,
  langOfFileName,
  langOfVttHeader,
  pickSubtitleFiles,
  MAX_FILE_TRACKS,
  type DragEventLike,
} from "./file";
import type { SubtitlesParser } from "./types";
import type { Cue, Track } from "../types";

const cues = (n: number): Cue[] =>
  Array.from({ length: n }, (_, i) => ({ startMs: i * 1000, endMs: i * 1000 + 900, text: `t${i}` }));

const track = (id: string): Track => ({ id, source: "youtube", lang: id, role: "original", cues: cues(2) });

const fakeFile = (name: string, text: string): { name: string; text: () => Promise<string> } => ({
  name,
  text: () => Promise.resolve(text),
});

/** Парсер-фейк: содержимое → cue (число после «n:» в тексте), «bad» — отказ. */
const fakeParser = (failFor: string[] = []): SubtitlesParser => ({
  parse(payload: string) {
    if (failFor.some((f) => payload.includes(f))) return Promise.reject(new Error("канал до Core недоступен"));
    const n = Number(/n:(\d+)/.exec(payload)?.[1] ?? 0);
    if (n === 0) return Promise.resolve({ cues: [], warnings: ["строка 1: битый тайминг"] });
    return Promise.resolve({ cues: cues(n), warnings: [] });
  },
});

describe("язык файловой дорожки", () => {
  it("из имени файла: movie.ru.srt → ru, subs.en-US.vtt → en-US", () => {
    expect(langOfFileName("movie.ru.srt")).toBe("ru");
    expect(langOfFileName("subs.en-US.vtt")).toBe("en-US");
    expect(langOfFileName("The.Movie.2024.1080p.fr.srt")).toBe("fr");
    expect(langOfFileName("MOVIE.RU.SRT")).toBe("RU"); // регистр сохраняем (BCP-47 регион)
  });

  it("не-языковые сегменты и файл без сегмента — пусто", () => {
    expect(langOfFileName("sample.srt")).toBe("");
    expect(langOfFileName("movie.2024.srt")).toBe(""); // цифры — не язык
    expect(langOfFileName("фильм.рус.srt")).toBe(""); // кириллица — не BCP-47
    expect(langOfFileName("movie.part.srt")).toBe(""); // 4 буквы — за пределами 2–3
  });

  it("из заголовка WebVTT (LANGUAGE:) — когда в имени языка нет", () => {
    expect(langOfVttHeader("WEBVTT\nLanguage: ru\n\n00:00.000 --> 00:02.000\nпривет\n")).toBe("ru");
    expect(langOfVttHeader("WEBVTT\n\n00:00.000 --> 00:02.000\nhi\n")).toBe("");
    expect(langOfVttHeader("")).toBe("");
  });
});

describe("отбор файлов дропа", () => {
  it("только .srt/.vtt, не больше лимита, в порядке дропа", () => {
    const files = [
      fakeFile("a.srt", ""),
      fakeFile("b.vtt", ""),
      fakeFile("c.VTT", ""), // регистр не важен
      fakeFile("d.srt", ""),
      fakeFile("photo.png", ""),
      fakeFile("notes.txt", ""),
    ];
    const picked = pickSubtitleFiles(files);
    expect(picked.map((f) => f.name)).toEqual(["a.srt", "b.vtt", "c.VTT"]);
    expect(picked.length).toBe(MAX_FILE_TRACKS);
  });

  it("нет файлов субтитров — пусто (дроп не наш, сайту не мешаем)", () => {
    expect(pickSubtitleFiles([fakeFile("x.png", ""), fakeFile("y.txt", "")])).toEqual([]);
  });
});

describe("fileTrackFrom: id и дорожка", () => {
  it("file:<lang>, без языка — file:<имя>, дубликаты :2/:3", () => {
    const used = new Set<string>();
    expect(fileTrackFrom("movie.ru.srt", "ru", cues(1), used).id).toBe("file:ru");
    expect(fileTrackFrom("other.ru.srt", "ru", cues(1), used).id).toBe("file:ru:2");
    expect(fileTrackFrom("sample.srt", "", cues(1), used)).toMatchObject({ id: "file:sample", lang: "und", source: "file", role: "original" });
  });
});

describe("смешивание с дорожками платформы (docs/01 F-06)", () => {
  it("платформенные + файловые, файлы — в конец", () => {
    const c = combinedTracks([track("yt:en")], [track("file:ru"), track("file:es")]);
    expect(c.tracks.map((t) => t.id)).toEqual(["yt:en", "file:ru", "file:es"]);
    expect(c.droppedFiles).toBe(0);
  });

  it("набор ≤ 3: лишние файловые отброшены со счётом", () => {
    const c = combinedTracks([track("yt:en"), track("yt:en+ru")], [track("file:es"), track("file:fr")]);
    expect(c.tracks.map((t) => t.id)).toEqual(["yt:en", "yt:en+ru", "file:es"]);
    expect(c.droppedFiles).toBe(1);
  });

  it("без платформенных файлы идут сами (голый HTML5-видео, docs/03 §3.3)", () => {
    const c = combinedTracks([], [track("file:ru")]);
    expect(c.tracks.map((t) => t.id)).toEqual(["file:ru"]);
  });
});

describe("buildFileTracks: чтение + разбор в Core", () => {
  it("успешные файлы → дорожки с языком из имени, отказы — пофактово", async () => {
    const result = await buildFileTracks(
      [fakeFile("movie.ru.srt", "n:3"), fakeFile("subs.en.vtt", "n:2"), fakeFile("bad.de.srt", "bad"), fakeFile("empty.fr.srt", "n:0")],
      { parser: fakeParser(["bad"]) },
    );
    expect(result.tracks.map((t) => [t.id, t.lang, t.cues.length])).toEqual([
      ["file:ru", "ru", 3],
      ["file:en", "en", 2],
    ]);
    expect(result.failures).toEqual([
      { name: "bad.de.srt", reason: "канал до Core недоступен" },
      { name: "empty.fr.srt", reason: "в файле нет ни одного cue" },
    ]);
    expect(result.warnings).toEqual(["empty.fr.srt: строка 1: битый тайминг"]);
  });

  it("язык из заголовка VTT, если в имени его нет", async () => {
    const result = await buildFileTracks([fakeFile("subs.vtt", "WEBVTT\nLanguage: ru\nn:1")], { parser: fakeParser() });
    expect(result.tracks[0].lang).toBe("ru");
  });

  it("файл больше 4 МБ — отказ до разбора", async () => {
    const result = await buildFileTracks([fakeFile("big.srt", "x".repeat(4 * 1024 * 1024 + 1))], { parser: fakeParser() });
    expect(result.failures[0].reason).toContain("4 МБ");
  });
});

describe("FileDropZone: приём на window, чужие дропы не трогаем", () => {
  interface RecordedEvent {
    prevented: boolean;
    stopped: boolean;
  }

  const setup = (opts?: { hasVideo?: boolean }) => {
    const listeners = new Map<string, ((e: unknown) => void)[]>();
    const applied: unknown[] = [];
    const events: RecordedEvent[] = [];
    const hintEls: { connected: boolean; opacity: string }[] = [];
    const zone = new FileDropZone({
      win: {
        addEventListener(type: string, listener: (e: unknown) => void) {
          listeners.set(type, [...(listeners.get(type) ?? []), listener]);
        },
      },
      doc: {
        createElement() {
          const el = { connected: true, opacity: "0", style: {} as Record<string, string>, setAttribute() {} };
          hintEls.push(el as never);
          return el as never;
        },
        documentElement: { appendChild: () => {} },
      },
      parser: fakeParser(),
      hasVideo: () => opts?.hasVideo ?? true,
      onApply: (r) => applied.push(r),
    });
    zone.start();
    const fire = (type: string, e: Partial<DragEventLike> & { types?: string[]; files?: File[] }): RecordedEvent => {
      const rec: RecordedEvent = { prevented: false, stopped: false };
      const ev = {
        type,
        dataTransfer: e.dataTransfer ?? {
          types: e.types ?? ["Files"],
          files: e.files ?? [],
          dropEffect: "",
        },
        preventDefault: () => (rec.prevented = true),
        stopPropagation: () => (rec.stopped = true),
      };
      for (const l of listeners.get(type) ?? []) l(ev);
      return rec;
    };
    return { zone, fire, applied, hintEls };
  };

  const fileOf = (name: string) => ({ name, text: () => Promise.resolve("n:2") }) as never;

  it("dragenter с файлами показывает подсказку, dragleave прячет", () => {
    const { zone, fire, hintEls } = setup();
    fire("dragenter", {});
    expect(zone.hintVisible()).toBe(true);
    expect(hintEls.length).toBe(1);
    fire("dragleave", {});
    expect(zone.hintVisible()).toBe(false);
  });

  it("дроп .srt/.vtt поглощается и разбирается в дорожки", async () => {
    const { fire, applied } = setup();
    const rec = fire("drop", { files: [fileOf("movie.ru.srt")] });
    expect(rec.prevented).toBe(true);
    expect(rec.stopped).toBe(true);
    // onDrop не ждёт разбора (void …then) — макротаск покрывает его микротики.
    await new Promise((r) => setTimeout(r, 0));
    expect(applied.length).toBe(1);
    expect((applied[0] as { tracks: Track[] }).tracks[0].id).toBe("file:ru");
  });

  it("дроп без файлов субтитров — сайту (не поглощаем)", () => {
    const { fire, applied } = setup();
    const rec = fire("drop", { files: [fileOf("cat.png"), fileOf("notes.txt")] });
    expect(rec.prevented).toBe(false);
    expect(rec.stopped).toBe(false);
    expect(applied.length).toBe(0);
  });

  it("видео на странице нет — дроп не наш (docs/03 §3.2: только на <video>)", () => {
    const { fire, applied, zone } = setup({ hasVideo: false });
    const rec = fire("drop", { files: [fileOf("movie.ru.srt")] });
    expect(rec.prevented).toBe(false);
    expect(applied.length).toBe(0);
    expect(zone.hintVisible()).toBe(false);
  });

  it("dragover разрешает дроп (preventDefault), dropEffect = copy", () => {
    const { fire } = setup();
    const dt = { types: ["Files"], files: [], dropEffect: "" };
    const rec = fire("dragover", { dataTransfer: dt });
    expect(rec.prevented).toBe(true);
    expect(dt.dropEffect).toBe("copy");
  });

  it("dragover без файлов (например, перетаскивание текста) — не поглощаем", () => {
    const { fire } = setup();
    const rec = fire("dragover", { types: ["text/plain"] });
    expect(rec.prevented).toBe(false);
  });
});
