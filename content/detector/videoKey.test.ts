// Ключ видео (docs/03 §6): YouTube id из всех форматов ссылок, прочие сайты —
// URL (+ длительность, когда известна). Чистая функция — без DOM.
import { describe, expect, it } from "vitest";
import { videoKeyFor } from "./videoKey";

describe("videoKeyFor — YouTube", () => {
  it("watch?v=…", () => {
    expect(videoKeyFor("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("yt:dQw4w9WgXcQ");
  });

  it("watch с параметрами-хвостом (t=, si=)", () => {
    expect(videoKeyFor("https://youtube.com/watch?t=42&v=abc123-_X&si=x")).toBe("yt:abc123-_X");
  });

  it("shorts/<id> и youtu.be/<id>", () => {
    expect(videoKeyFor("https://www.youtube.com/shorts/AbCdEf12345")).toBe("yt:AbCdEf12345");
    expect(videoKeyFor("https://youtu.be/dQw4w9WgXcQ?si=1")).toBe("yt:dQw4w9WgXcQ");
  });

  it("youtube-nocookie.com embed", () => {
    expect(videoKeyFor("https://www.youtube-nocookie.com/watch?v=xyz987")).toBe("yt:xyz987");
  });

  it("главная YouTube без id видео — URL-ключ", () => {
    expect(videoKeyFor("https://www.youtube.com/")).toBe("url:https://www.youtube.com/");
  });
});

describe("videoKeyFor — прочие сайты (URL + duration)", () => {
  it("без длительности — просто нормализованный URL", () => {
    expect(videoKeyFor("http://127.0.0.1:8897/")).toBe("url:http://127.0.0.1:8897/");
    expect(videoKeyFor("https://example.com/watch?x=1")).toBe("url:https://example.com/watch?x=1");
  });

  it("с длительностью — целые секунды в суффиксе", () => {
    expect(videoKeyFor("http://127.0.0.1:8897/", 30.4)).toBe("url:http://127.0.0.1:8897/:30");
    expect(videoKeyFor("https://vimeo.com/123", 125.6)).toBe("url:https://vimeo.com/123:126");
  });

  it("неизвестная/нулевая длительность (NaN, live) не попадает в ключ", () => {
    expect(videoKeyFor("https://live.example.com/stream", Number.NaN)).toBe("url:https://live.example.com/stream");
    expect(videoKeyFor("https://live.example.com/stream", 0)).toBe("url:https://live.example.com/stream");
    expect(videoKeyFor("https://live.example.com/stream", Number.POSITIVE_INFINITY)).toBe("url:https://live.example.com/stream");
  });

  it("битая строка-URL не бросает исключения", () => {
    expect(videoKeyFor("not a url ://")).toMatch(/^url:/);
  });
});
