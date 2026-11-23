// Юнит-тесты детекта языка метаданных (duopulse-221): фикстуры — живые
// тексты YouTube-видео (пробы 23.11.2026), без сети.

import { describe, expect, it } from "vitest";
import { detectMetaLanguage } from "./meta-lang";

describe("detectMetaLanguage", () => {
  it("французское музыкальное видео жалобы (Uhi00MoqpNg) — fr", () => {
    // Живые videoDetails: описание канала Mylène Farmer на французском.
    expect(
      detectMetaLanguage({
        title: "Mylène Farmer - Ainsi soit je... (Stade de France Live)",
        author: "Mylène Farmer",
        shortDescription:
          'Mylène Farmer - "Ainsi soit je... (Stade de France Live)"\n' +
          'Extrait du film "Mylène Farmer - Stade de France" disponible en DVD, Blu-ray & CD\n' +
          "Dans les bacs ➛ https://mylenefarmerlive.lnk.to/StadeDeFrance\n" +
          '--\nSingle disponible dans le best-of "Histoires de" ➛ https://lnk.to/MyleneFarmerHistoiresDe\n--',
      }),
    ).toBe("fr");
  });

  it("английское описание — en", () => {
    expect(
      detectMetaLanguage({
        title: "Official Live Performance",
        author: "Some Band",
        shortDescription:
          "The new single is available now on all platforms. Watch the full video and subscribe to the channel for more music.",
      }),
    ).toBe("en");
  });

  it("испанское описание — es (акценты различают música/musique)", () => {
    expect(
      detectMetaLanguage({
        title: "Despacito",
        author: "Luis Fonsi",
        shortDescription:
          "Escucha el nuevo álbum disponible en todas las plataformas. Vídeo oficial de la canción.",
      }),
    ).toBe("es");
  });

  it("немецкое описание — de", () => {
    expect(
      detectMetaLanguage({
        title: "Neues Lied",
        author: "Eine Band",
        shortDescription:
          "Das neue Album ist jetzt verfügbar. Offizielle Musik zum Anhören und Konzerte gibt es hier.",
      }),
    ).toBe("de");
  });

  it("русское описание — ru (кириллица)", () => {
    expect(
      detectMetaLanguage({
        title: "Новая песня",
        author: "Канал",
        shortDescription: "Новый клип доступен на всех площадках. Слушайте альбом и смотрите концерт.",
      }),
    ).toBe("ru");
  });

  it("украинское описание — uk (і/ї/є решают против ru)", () => {
    expect(
      detectMetaLanguage({
        title: "Нова пісня",
        author: "Гурт",
        shortDescription: "Новий кліп доступний на всіх платформах. Слухайте альбом і дивіться кліп тут.",
      }),
    ).toBe("uk");
  });

  it("двуязычное описание без отрыва — null (фолбэк прежний)", () => {
    expect(
      detectMetaLanguage({
        title: "Clip",
        shortDescription:
          "Le clip officiel de la chanson. The official video of the song is available here with subtitles.",
      }),
    ).toBeNull();
  });

  it("пустые метаданные — null", () => {
    expect(detectMetaLanguage({})).toBeNull();
    expect(detectMetaLanguage(undefined)).toBeNull();
    expect(detectMetaLanguage({ title: 42, shortDescription: null })).toBeNull();
  });

  it("короткий текст без уверенности — null", () => {
    expect(detectMetaLanguage({ title: "Ainsi soit je...", author: "Mylène Farmer" })).toBeNull();
  });

  it("японское название (кана) — ja", () => {
    expect(detectMetaLanguage({ title: "ふたりの季節", shortDescription: "新しいシングル" })).toBe("ja");
  });
});
