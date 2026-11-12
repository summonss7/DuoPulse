// DuoPulse — юнит-тесты мобильной развилки (duopulse-081): признак платформы
// (window.__TAURI__ есть только у мобильной обёртки) и разбор ввода omnibox
// (пара omnibox.rs + перезапись YouTube-ссылок во встраиваемый плеер).
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MOBILE_ENGINE,
  isTauriMobile,
  normalizeEngine,
  resolveMobileInput,
  videoIdOfEmbed,
  youtubeEmbedUrl,
} from "./platform";

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
  // duopulse-123: shorts/live/music раньше не признавались плеером и уводили
  // в системный браузер («нажатие закладки переходит в хром»)
  it("shorts → embed с enablejsapi", () => {
    expect(youtubeEmbedUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe(
      "https://www.youtube.com/embed/dQw4w9WgXcQ?enablejsapi=1",
    );
  });
  it("live → embed с enablejsapi", () => {
    expect(youtubeEmbedUrl("https://m.youtube.com/live/abc123_-X")).toBe(
      "https://www.youtube.com/embed/abc123_-X?enablejsapi=1",
    );
  });
  it("music.youtube.com/watch?v= → embed с enablejsapi", () => {
    expect(youtubeEmbedUrl("https://music.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      "https://www.youtube.com/embed/dQw4w9WgXcQ?enablejsapi=1",
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
  it("текст со пробелами — поиск (кодируется)", () => {
    // duopulse-085: поисковик по умолчанию — Google, выбор — движок
    expect(resolveMobileInput("duo pulse тест")).toEqual({
      kind: "search",
      url: "https://www.google.com/search?q=duo%20pulse%20%D1%82%D0%B5%D1%81%D1%82",
    });
  });
  it("пустой ввод — стартовая страница поисковика", () => {
    expect(resolveMobileInput("   ")).toEqual({
      kind: "search",
      url: "https://www.google.com/search?q=",
    });
  });
  it("выбранный движок задаёт префикс поиска (duopulse-085)", () => {
    expect(resolveMobileInput("rust lang", "youtube")).toEqual({
      kind: "search",
      url: "https://www.youtube.com/results?search_query=rust%20lang",
    });
    expect(resolveMobileInput("rust lang", "duckduckgo")).toEqual({
      kind: "search",
      url: "https://duckduckgo.com/?q=rust%20lang",
    });
    // адреса от движка не зависят
    expect(resolveMobileInput("example.com", "bing")).toEqual({
      kind: "url",
      url: "https://example.com",
    });
  });
});

describe("поисковик мобильной ветки (duopulse-085)", () => {
  it("по умолчанию — Google", () => {
    expect(DEFAULT_MOBILE_ENGINE).toBe("google");
  });
  it("normalizeEngine: мусор/пусто — дефолт, известный id — сам id", () => {
    expect(normalizeEngine(null)).toBe("google");
    expect(normalizeEngine("мусор")).toBe("google");
    expect(normalizeEngine("bing")).toBe("bing");
  });
});
