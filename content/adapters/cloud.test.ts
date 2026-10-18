// Юнит-тесты облачного перевода дорожки (задача 4.2, docs/03 §7): запрос
// уходит WebMessage'м с cue и reqId, ответ document-событием
// duopulse-translate-track резолвит свой промис (чужой reqId — нет), дорожка
// ответа наследует сетку таймингов; битые cue снисходительно пропускаются.
import { describe, expect, it } from "vitest";
import { cloudTrackFrom, requestCloudTranslation, cloudTranslateStatus } from "./cloud";
import type { Cue } from "../types";

type Listener = (e: { detail: unknown }) => void;

/** Фейковый документ: ловит слушатель события-ответа конвейера. */
function fakeDoc(): { doc: Document; reply: (detail: unknown) => void } {
  const listeners: Listener[] = [];
  const doc = {
    addEventListener: (_t: string, l: Listener) => listeners.push(l),
  } as unknown as Document;
  return {
    doc,
    reply: (detail) => listeners.forEach((l) => l({ detail })),
  };
}

const cue = (text: string, start: number): Cue => ({ startMs: start, endMs: start + 1500, text });

describe("requestCloudTranslation (WebMessage → событие-ответ)", () => {
  it("запрос несёт reqId и cue; ответ по reqId резолвит промис", async () => {
    const d = fakeDoc();
    const posted: Record<string, unknown>[] = [];
    const p = requestCloudTranslation(
      d.doc,
      { post: (m) => posted.push(m) },
      {
        videoKey: "yt:v1",
        trackId: "yt:en",
        sourceLang: "en",
        targetLang: "ru",
        cues: [cue("hello", 0), cue("world", 2000)],
      },
    );
    expect(posted).toHaveLength(1);
    expect(posted[0]["duopulse"]).toBe("translate-track");
    expect(posted[0]["targetLang"]).toBe("ru");
    expect(posted[0]["cues"]).toEqual([
      { startMs: 0, endMs: 1500, text: "hello" },
      { startMs: 2000, endMs: 3500, text: "world" },
    ]);
    const reqId = posted[0]["reqId"] as number;
    d.reply({ reqId, ok: true, cues: [{ startMs: 0, endMs: 1500, text: "привет" }], fromCache: false });
    const reply = await p;
    expect(reply.ok).toBe(true);
    expect(reply.fromCache).toBe(false);
    expect(cloudTranslateStatus().lastReply?.cueCount).toBe(1);
  });

  it("чужой/битый reqId не резолвит промис", async () => {
    const d = fakeDoc();
    const posted: Record<string, unknown>[] = [];
    const p = requestCloudTranslation(
      d.doc,
      { post: (m) => posted.push(m) },
      { videoKey: "v", trackId: "t", sourceLang: "", targetLang: "ru", cues: [cue("x", 0)] },
    );
    const reqId = posted[0]["reqId"] as number;
    d.reply({ reqId: reqId + 999, ok: false, error: "не наш" });
    d.reply({ noReqId: true });
    d.reply({ reqId, ok: false, error: "облачный перевод выключен" });
    const reply = await p;
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("выключен");
    expect(cloudTranslateStatus().lastReply?.ok).toBe(false);
    expect(cloudTranslateStatus().pending).toBe(false);
  });

  it("параллельные запросы различаются reqId", async () => {
    const d = fakeDoc();
    const posted: Record<string, unknown>[] = [];
    const p1 = requestCloudTranslation(d.doc, { post: (m) => posted.push(m) }, {
      videoKey: "v", trackId: "a", sourceLang: "", targetLang: "ru", cues: [cue("1", 0)],
    });
    const p2 = requestCloudTranslation(d.doc, { post: (m) => posted.push(m) }, {
      videoKey: "v", trackId: "a", sourceLang: "", targetLang: "es", cues: [cue("1", 0)],
    });
    expect(posted[0]["reqId"]).not.toBe(posted[1]["reqId"]);
    expect(cloudTranslateStatus().pending).toBe(true);
    d.reply({ reqId: posted[1]["reqId"], ok: true, cues: [{ startMs: 0, endMs: 1, text: "hola" }] });
    d.reply({ reqId: posted[0]["reqId"], ok: true, cues: [{ startMs: 0, endMs: 1, text: "привет" }] });
    expect((await p2).cues?.[0]?.text).toBe("hola");
    expect((await p1).cues?.[0]?.text).toBe("привет");
  });
});

describe("cloudTrackFrom (дорожка из ответа конвейера)", () => {
  it("id cloud:<lang>, source translate, сетка таймингов ответа", () => {
    const track = cloudTrackFrom("ru", "DeepL → ru", [
      { startMs: 0, endMs: 1500, text: "привет" },
      { startMs: 2000, endMs: 3500, text: "мир" },
    ]);
    expect(track).toMatchObject({
      id: "cloud:ru",
      source: "translate",
      lang: "ru",
      role: "translation",
      name: "DeepL → ru",
    });
    expect(track?.cues).toHaveLength(2);
  });

  it("битые cue пропускаются; пустой ответ — null (дорожку не строим)", () => {
    const track = cloudTrackFrom("ru", "", [
      null,
      "строка",
      { startMs: "x", endMs: 1, text: "не числа" },
      { startMs: 0, endMs: 1, text: "годный" },
    ]);
    expect(track?.cues).toHaveLength(1);
    expect(track?.cues[0].text).toBe("годный");
    expect(cloudTrackFrom("ru", "", [])).toBeNull();
    expect(cloudTrackFrom("ru", "", [{}])).toBeNull();
  });
});
