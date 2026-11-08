// DuoPulse — юнит-тесты мобильной развилки (duopulse-081): признак платформы
// (window.__TAURI__ есть только у мобильной обёртки) и разбор ввода omnibox
// (пара omnibox.rs + перезапись YouTube-ссылок во встраиваемый плеер).
import { describe, expect, it } from "vitest";
import { isTauriMobile, resolveMobileInput, videoIdOfEmbed, youtubeEmbedUrl } from "./platform";

describe("isTauriMobile", () => {
  it("есть __TAURI__ — мобильная обёртка", () => {
    expect(isTauriMobile({ __TAURI__: {} } as never)).toBe(true);
  });
  it("нет __TAURI__ — десктоп (withGlobalTauri: false)", () => {
    expect(isTauriMobile({} as never)).toBe(false);
  });
});

describe("youtubeEmbedUrl", () => {
  // duopulse-082: ко всем embed добавляется enablejsapi=1 — IFrame Player API
  // для duo-часов (опрос getCurrentTime постсообщениями).
  it("watch?v= → embed с enablejsapi", () => {
    expect(youtubeEmbedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      "https://www.youtube.com/embed/dQw4w9WgXcQ?enablejsapi=1",
    );
  });
  it("youtu.be/ID → embed с enablejsapi", () => {
    expect(youtubeEmbedUrl("https://youtu.be/dQw4w9WgXcQ?t=30")).toBe(
      "https://www.youtube.com/embed/dQw4w9WgXcQ?enablejsapi=1",
    );
  });
  it("m.youtube.com тоже плеер", () => {
    expect(youtubeEmbedUrl("https://m.youtube.com/watch?v=abc123_-X")).toBe(
      "https://www.youtube.com/embed/abc123_-X?enablejsapi=1",
    );
  });
  it("уже embed — канонизируется без дубля параметров", () => {
    expect(youtubeEmbedUrl("https://www.youtube.com/embed/abc?rel=0")).toBe(
      "https://www.youtube.com/embed/abc?enablejsapi=1",
    );
  });
  it("videoIdOfEmbed — id из embed-URL для duo-сессии", () => {
    expect(videoIdOfEmbed("https://www.youtube.com/embed/dQw4w9WgXcQ?enablejsapi=1")).toBe("dQw4w9WgXcQ");
    expect(videoIdOfEmbed("https://example.com/embed/short")).toBeNull();
  });
  it("не-YouTube и мусор — не плеер", () => {
    expect(youtubeEmbedUrl("https://example.com/watch?v=1")).toBeNull();
    expect(youtubeEmbedUrl("смотрим видео")).toBeNull();
  });
});

describe("resolveMobileInput", () => {
  it("полный URL — сам себе адрес", () => {
    expect(resolveMobileInput("https://example.com/page")).toEqual({
      kind: "url",
      url: "https://example.com/page",
    });
  });
  it("голый домен получает https", () => {
    expect(resolveMobileInput("example.com")).toEqual({ kind: "url", url: "https://example.com" });
    expect(resolveMobileInput("example.com/a?b=1")).toEqual({
      kind: "url",
      url: "https://example.com/a?b=1",
    });
  });
  it("localhost — http (локальная разработка, как omnibox.rs)", () => {
    expect(resolveMobileInput("localhost:8899/audio-test.html")).toEqual({
      kind: "url",
      url: "http://localhost:8899/audio-test.html",
    });
  });
  it("ссылка YouTube с видео — встраиваемый плеер", () => {
    expect(resolveMobileInput("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toEqual({
      kind: "url",
      url: "https://www.youtube.com/embed/dQw4w9WgXcQ?enablejsapi=1",
    });
    expect(resolveMobileInput("youtu.be/dQw4w9WgXcQ")).toEqual({
      kind: "url",
      url: "https://www.youtube.com/embed/dQw4w9WgXcQ?enablejsapi=1",
    });
  });
  it("текст со пробелами — поиск YouTube (кодируется)", () => {
    expect(resolveMobileInput("duo pulse тест")).toEqual({
      kind: "search",
      url: "https://www.youtube.com/results?search_query=duo%20pulse%20%D1%82%D0%B5%D1%81%D1%82",
    });
  });
  it("пустой ввод — пустой поиск", () => {
    expect(resolveMobileInput("   ")).toEqual({
      kind: "search",
      url: "https://www.youtube.com/results?search_query=",
    });
  });
});
