// Юнит-тесты доставки гарнитур (карточка duopulse-068): base64-декодер
// (woff2-сабсеты приходят строкой WebMessage'м) и снисходительный разбор
// списка лиц. Сам канал и document.fonts — рантайм WebView2, здесь — чистые
// части; ensureFontFamilyLoaded вне канала (jsdom) ничего не шлёт.
import { describe, expect, it } from "vitest";
import { base64ToBytes, decodeFaces, ensureFontFamilyLoaded } from "./fonts";

describe("base64ToBytes — декодер сабсетов из ответа Core", () => {
  it("кодирует/декодирует байты с padding и без", () => {
    expect(Array.from(base64ToBytes(""))).toEqual([]);
    expect(Array.from(base64ToBytes("Zg=="))).toEqual([0x66]);
    expect(Array.from(base64ToBytes("Zm8="))).toEqual([0x66, 0x6f]);
    expect(Array.from(base64ToBytes("Zm9v"))).toEqual([0x66, 0x6f, 0x6f]);
    expect(Array.from(base64ToBytes("Zm9vYmFy"))).toEqual([0x66, 0x6f, 0x6f, 0x62, 0x61, 0x72]);
  });

  it("woff2-магия «wOF2» из base64 d09GMg== достаётся целиком", () => {
    expect(Array.from(base64ToBytes("d09G"))).toEqual([0x77, 0x4f, 0x46]); // wOF
  });
});

describe("decodeFaces — снисходительный разбор лиц", () => {
  it("валидные лица декодируются, мусор пропускается", () => {
    const faces = [
      { weight: 400, unicodeRange: "U+0400-045F", data: "Zm9v" },
      { weight: 500 }, // без data — пропуск
      "мусор",
      { weight: 500, unicodeRange: "U+0000-00FF", data: 42 }, // data не строка
    ];
    const decoded = decodeFaces(faces);
    expect(decoded).toHaveLength(1);
    expect(decoded[0].weight).toBe("400");
    expect(decoded[0].unicodeRange).toBe("U+0400-045F");
    expect(Array.from(decoded[0].bytes)).toEqual([0x66, 0x6f, 0x6f]);
  });

  it("не-массив и undefined unicodeRange — пусто/без диапазона", () => {
    expect(decodeFaces(undefined)).toEqual([]);
    expect(decodeFaces("nope")).toEqual([]);
    expect(decodeFaces([{ weight: 400, data: "Zg==" }])[0].unicodeRange).toBeUndefined();
  });
});

describe("ensureFontFamilyLoaded — вне WebView2 канал молчит", () => {
  it("system и мусор не запрашиваются, именные — тихо без канала", () => {
    expect(() => ensureFontFamilyLoaded("system")).not.toThrow();
    expect(() => ensureFontFamilyLoaded("Comic Sans")).not.toThrow();
    expect(() => ensureFontFamilyLoaded("Inter")).not.toThrow(); // jsdom: канала нет
  });
});
