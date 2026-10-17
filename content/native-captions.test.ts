// Юнит-тесты гашения нативных субтитров (задача 3.4, docs/03 §2): generic
// <track>-режимы и YouTube-CSS — на фейках (DOM-поведение проверяет e2e).
import { describe, expect, it } from "vitest";
import { NativeCaptionsBlanker, type VideoWithTextTracks } from "./native-captions";
import { YT_NATIVE_CAPTIONS_CLASS, type DocumentLike } from "./adapters/youtube";

function fakeDoc(): DocumentLike & { classes: string[]; styles: string[] } {
  const classes: string[] = [];
  const styles: string[] = [];
  return {
    classes,
    styles,
    documentElement: {
      classList: {
        add: (c) => {
          if (!classes.includes(c)) classes.push(c); // DOM add идемпотентен
        },
        remove: (c) => {
          const i = classes.indexOf(c);
          if (i >= 0) classes.splice(i, 1);
        },
        contains: (c) => classes.includes(c),
      },
      appendChild: (node) => {
        styles.push(String((node as { textContent?: string }).textContent ?? ""));
        return node;
      },
    },
    getElementById: (id) => (id === "duopulse-yt-captions-off-style" && styles.length ? { id } : null),
    createElement: () => ({ textContent: "", id: "" }),
  };
}

function fakeVideo(modes: string[]): VideoWithTextTracks {
  return {
    textTracks: {
      length: modes.length,
      ...Object.fromEntries(modes.map((mode, i) => [i, { mode }])),
    },
  };
}

describe("NativeCaptionsBlanker — generic textTracks", () => {
  it("показ (showing) гасится в hidden, disabled/hidden не трогаются", () => {
    const blanker = new NativeCaptionsBlanker({ doc: fakeDoc(), href: () => "https://site.test/watch" });
    const video = fakeVideo(["showing", "disabled", "hidden"]);
    blanker.blank(video);
    expect(video.textTracks[0].mode).toBe("hidden");
    expect(video.textTracks[1].mode).toBe("disabled");
    expect(video.textTracks[2].mode).toBe("hidden");
    expect(blanker.blanked).toBe(true);
  });

  it("restore возвращает исходные режимы", () => {
    const blanker = new NativeCaptionsBlanker({ doc: fakeDoc(), href: () => "https://site.test/" });
    const video = fakeVideo(["showing", "showing"]);
    blanker.blank(video);
    blanker.restore();
    expect(video.textTracks[0].mode).toBe("showing");
    expect(video.textTracks[1].mode).toBe("showing");
    expect(blanker.blanked).toBe(false);
  });

  it("повторный blank с другим видео возвращает режимы прежнему", () => {
    const blanker = new NativeCaptionsBlanker({ doc: fakeDoc(), href: () => "https://site.test/" });
    const first = fakeVideo(["showing"]);
    const second = fakeVideo(["showing"]);
    blanker.blank(first);
    blanker.blank(second);
    expect(first.textTracks[0].mode).toBe("showing"); // восстановлено
    expect(second.textTracks[0].mode).toBe("hidden");
  });

  it("без видео YouTube-часть всё равно применяется (SPA до детекта)", () => {
    const doc = fakeDoc();
    const blanker = new NativeCaptionsBlanker({ doc, href: () => "https://www.youtube.com/watch?v=abc123" });
    blanker.blank(null);
    expect(blanker.blanked).toBe(true);
    expect(doc.classes).toContain(YT_NATIVE_CAPTIONS_CLASS);
    blanker.restore();
    expect(doc.classes).not.toContain(YT_NATIVE_CAPTIONS_CLASS);
  });
});

describe("NativeCaptionsBlanker — YouTube CSS-гашение", () => {
  it("класс на <html> ставится и снимается, правило инжектится один раз", () => {
    const doc = fakeDoc();
    const blanker = new NativeCaptionsBlanker({
      doc,
      href: () => "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    blanker.blank(null);
    blanker.restore();
    blanker.blank(null); // повторное включение — стиль не дублируется
    expect(doc.styles.length).toBe(1);
    expect(doc.styles[0]).toContain(YT_NATIVE_CAPTIONS_CLASS);
    expect(doc.classes).toContain(YT_NATIVE_CAPTIONS_CLASS);
  });

  it("не-YouTube страницы класс не получают", () => {
    const doc = fakeDoc();
    const blanker = new NativeCaptionsBlanker({ doc, href: () => "https://vimeo.com/123" });
    blanker.blank(fakeVideo(["showing"]));
    expect(doc.classes).toEqual([]);
  });
});
