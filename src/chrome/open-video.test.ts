// Тесты «Открыть видео…» (duopulse-176): путь Windows → file://-URL вкладки.
import { describe, expect, it } from "vitest";
import { videoFileUrl } from "./open-video";

describe("duopulse-176: videoFileUrl — путь в file://-URL", () => {
  it("обратные слэши и диск — тройной слэш", () => {
    expect(videoFileUrl("D:\\Фильмы\\фильм.mkv")).toBe(
      "file:///D:/%D0%A4%D0%B8%D0%BB%D1%8C%D0%BC%D1%8B/%D1%84%D0%B8%D0%BB%D1%8C%D0%BC.mkv",
    );
  });

  it("прямые слэши без ведущего — тоже работает", () => {
    expect(videoFileUrl("C:/Videos/a.mp4")).toBe("file:///C:/Videos/a.mp4");
    expect(videoFileUrl("/mnt/film.webm")).toBe("file:///mnt/film.webm");
  });

  it("пробел кодируется, структура пути сохраняется", () => {
    expect(videoFileUrl("E:\\My Films\\big buck bunny.m4v")).toBe(
      "file:///E:/My%20Films/big%20buck%20bunny.m4v",
    );
  });

  it("# и ? в имени файла кодируются (encodeURI их не берёт)", () => {
    expect(videoFileUrl("D:\\q#1\\what?.mkv")).toBe("file:///D:/q%231/what%3F.mkv");
  });
});
