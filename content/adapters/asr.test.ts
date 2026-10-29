// Юнит-тесты ASR-части content-слоя (карточка duopulse-060): запрос
// транскрипции (WebMessage → document-событие-ответ) и построение дорожки
// asr:<lang>. Сети нет — Core-конвейер подменён ручным диспатчем ответа.

import { describe, expect, it, vi } from "vitest";
import { asrStatus, asrTrackFrom, requestAsrTrack, type AsrReply } from "./asr";

/** Фейковый документ: node-окружение без DOM, слушателю нужен только
 *  addEventListener + CustomEvent с detail. */
class FakeDoc extends EventTarget {
  dispatchReply(detail: AsrReply): void {
    this.dispatchEvent(new CustomEvent("duopulse-asr-track", { detail }));
  }
  dispatchJunk(detail: unknown): void {
    this.dispatchEvent(new CustomEvent("duopulse-asr-track", { detail }));
  }
}

describe("requestAsrTrack: WebMessage → промис по reqId", () => {
  it("отправляет asr-begin и резолвится ответом конвейера", async () => {
    const doc = new FakeDoc();
    const post = vi.fn();
    const pending = requestAsrTrack(doc as unknown as Document, { post }, {
      videoKey: "yt:abc",
      url: "https://googlevideo.example/audio",
      lang: "en",
    });
    expect(post).toHaveBeenCalledTimes(1);
    const msg = post.mock.calls[0][0] as Record<string, unknown>;
    expect(msg["duopulse"]).toBe("asr-begin");
    expect(msg["videoKey"]).toBe("yt:abc");
    expect(msg["url"]).toContain("googlevideo");
    const reqId = msg["reqId"] as number;
    expect(typeof reqId).toBe("number");

    doc.dispatchReply({
      reqId,
      ok: true,
      lang: "en",
      engine: "local:whisper",
      fromCache: false,
      cues: [{ startMs: 0, endMs: 900, text: "hello" }],
    });
    const reply = await pending;
    expect(reply.ok).toBe(true);
    expect(asrStatus().pending).toBe(false);
    expect(asrStatus().lastReply?.cueCount).toBe(1);
  });

  it("чужой reqId и мусорный detail игнорируются", async () => {
    const doc = new FakeDoc();
    const post = vi.fn();
    const pending = requestAsrTrack(doc as unknown as Document, { post }, {
      videoKey: "yt:x",
      url: "https://a.example/a.mp3",
      lang: "",
    });
    doc.dispatchReply({ reqId: 999_999, ok: true, cues: [] }); // чужой
    doc.dispatchJunk(null); // мусор
    doc.dispatchJunk("не объект");
    expect(asrStatus().pending).toBe(true);
    const reqId = (post.mock.calls[0][0] as Record<string, unknown>)["reqId"] as number;
    doc.dispatchReply({ reqId, ok: false, error: "нет модели" });
    const reply = await pending;
    expect(reply.ok).toBe(false);
    expect(asrStatus().lastReply?.error).toBe("нет модели");
  });
});

describe("asrTrackFrom: дорожка-оригинал из ответа", () => {
  const cues = [
    { startMs: 0, endMs: 1000, text: "первый" },
    { startMs: 1000, endMs: 2000, text: "второй" },
    { startMs: 2000, endMs: 2600, text: "третий" },
  ];

  it("строит asr:<lang> role original, битые cue пропускает", () => {
    const track = asrTrackFrom("ru", "local:whisper", [
      ...cues.slice(0, 2),
      { startMs: "x" } as unknown as Record<string, unknown>,
      null,
      cues[2],
    ]);
    expect(track).not.toBeNull();
    expect(track!.id).toBe("asr:ru");
    expect(track!.source).toBe("asr");
    expect(track!.role).toBe("original");
    expect(track!.lang).toBe("ru");
    expect(track!.cues).toHaveLength(3);
    expect(track!.name).toContain("ru");
  });

  it("имя дорожки различает облако; пустой язык — auto; пустой ответ — null", () => {
    const cloud = asrTrackFrom("en", "openai:whisper-1", cues);
    expect(cloud!.name).toContain("облако");
    const auto = asrTrackFrom("", "local:whisper", cues);
    expect(auto!.id).toBe("asr:auto");
    expect(auto!.lang).toBe("auto");
    expect(asrTrackFrom("en", "local:whisper", [])).toBeNull();
    expect(asrTrackFrom("en", "local:whisper", [{}])).toBeNull();
  });
});
