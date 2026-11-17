// Тесты чистых функций мобильного проигрывателя (duopulse-179): URL
// протокола mobilevideo — путь целиком одним сегментом (слэши/кириллица
// кодируются), маркеры busy/noperm — общие с PDF (pdf.ts, их тесты там).
import { describe, expect, it } from "vitest";
import { isBusyError, isNoPermError } from "./pdf";
import { mobileVideoUrl } from "./video";

describe("mobileVideoUrl", () => {
  it("кодирует путь целиком в один сегмент", () => {
    expect(mobileVideoUrl("/data/user/0/dev.duopulse.mobile/cache/video/1-f.mp4")).toBe(
      "http://mobilevideo.localhost/v/" +
        encodeURIComponent("/data/user/0/dev.duopulse.mobile/cache/video/1-f.mp4"),
    );
  });

  it("кириллица и пробелы не ломают URL", () => {
    const url = mobileVideoUrl("/data/…/cache/video/2-фильм меняет всё.mkv");
    expect(url.startsWith("http://mobilevideo.localhost/v/")).toBe(true);
    expect(url).not.toContain(" ");
    expect(url).not.toContain("фильм");
    expect(decodeURIComponent(url.slice("http://mobilevideo.localhost/v/".length))).toBe(
      "/data/…/cache/video/2-фильм меняет всё.mkv",
    );
  });
});

describe("маркеры мобильного take (общие с PDF)", () => {
  it("busy распознаётся и в строке, и в Error", () => {
    expect(isBusyError("busy: копирование видео ещё идёт")).toBe(true);
    expect(isBusyError(new Error("busy: …"))).toBe(true);
    expect(isBusyError("noperm: …")).toBe(false);
  });

  it("noperm распознаётся", () => {
    expect(isNoPermError("noperm: нет доступа к файлу")).toBe(true);
    expect(isNoPermError("busy: …")).toBe(false);
  });
});
