// Тесты пресетов панели «duo» (задача 3.7): Оригинал / Дуо / Трио из списка
// адаптера (предпочитаемые переводы ru→uk→en), нормализация id для сверки
// с применённым набором (перевод «yt:en+ru» ≡ «ru»).
import { describe, expect, it } from "vitest";
import { normalizeTrackId, presetSets } from "./presets";
import type { BaseTrackInfo, TranslationLangInfo } from "../bridge/gen/types";

const base = (over: Partial<BaseTrackInfo> = {}): BaseTrackInfo => ({
  id: over.id ?? "yt:en",
  lang: over.lang ?? "en",
  kind: over.kind ?? "manual",
  name: over.name ?? "English",
  original: over.original ?? false,
  translatable: over.translatable ?? true,
});

const tlang = (lang: string): TranslationLangInfo => ({ lang, name: `T:${lang}` });

describe("presetSets", () => {
  it("оригинал + предпочитаемые переводы: Оригинал / Дуо en+ru / Трио +es", () => {
    const sets = presetSets([base({ original: true })], [tlang("es"), tlang("ru"), tlang("pl")]);
    expect(sets.map((s) => s.ids)).toEqual([
      ["yt:en"],
      ["yt:en", "ru"],
      ["yt:en", "ru", "es"],
    ]);
  });

  it("без переводов — только «Оригинал»", () => {
    expect(presetSets([base({ original: true })], []).map((s) => s.key)).toEqual(["solo"]);
  });

  it("оригинал без флага original — первая дорожка списка", () => {
    const sets = presetSets([base({ lang: "fr", id: "yt:fr" }), base({ lang: "de" })], [tlang("ru")]);
    expect(sets[0].ids).toEqual(["yt:fr"]);
  });

  it("duopulse-070: TED-форма (первая af, оригинал en/en-asr) — «Дуо en+ru», не af+ru", () => {
    // Реальная форма с iG9CE55wbtY: 65 дорожек по алфавиту, первая af;
    // originalLangsOf детектит en по asr-дорожке → помечены yt:en и yt:en:asr
    const sets = presetSets(
      [
        base({ id: "yt:af", lang: "af", name: "afrikaans" }),
        base({ id: "yt:en", lang: "en", name: "english", original: true }),
        base({ id: "yt:en:asr", lang: "en", kind: "asr", name: "english (auto)", original: true }),
        base({ id: "yt:ro", lang: "ro", name: "română" }),
      ],
      [tlang("ru"), tlang("es")],
    );
    expect(sets.find((s) => s.key === "duo")!.label).toBe("Дуо en+ru");
    expect(sets.find((s) => s.key === "duo")!.ids).toEqual(["yt:en", "ru"]);
    expect(sets[0].ids).toEqual(["yt:en"]); // «Оригинал» — ручная en, не af
  });

  it("оригинал непереводимый — Duo/Трио не строятся", () => {
    const sets = presetSets([base({ original: true, translatable: false })], [tlang("ru")]);
    expect(sets.map((s) => s.key)).toEqual(["solo"]);
  });

  it("перевод языка оригинала пропускается (en-видео, en-перевод)", () => {
    const sets = presetSets([base({ original: true })], [tlang("en"), tlang("uk")]);
    expect(sets[1].ids).toEqual(["yt:en", "uk"]);
  });

  it("duopulse-094: порядок предпочтений en → ro → ru → ar", () => {
    // en — язык оригинала → ro прежде ru в «Дуо»
    const sets = presetSets([base({ original: true })], [tlang("ru"), tlang("ro"), tlang("ar")]);
    expect(sets.find((s) => s.key === "duo")!.ids).toEqual(["yt:en", "ro"]);
    expect(sets.find((s) => s.key === "trio")!.ids).toEqual(["yt:en", "ro", "ru"]);
  });

  it("второй перевод не повторяет первый (Трио)", () => {
    const sets = presetSets([base({ original: true })], [tlang("ru"), tlang("ru")]);
    expect(sets.map((s) => s.key)).toEqual(["solo", "duo"]); // третий не построится
  });

  it("пустой список — нет пресетов", () => {
    expect(presetSets([], [tlang("ru")])).toEqual([]);
  });
});

describe("normalizeTrackId", () => {
  it("перевод: суффикс после «+»", () => {
    expect(normalizeTrackId("yt:en+ru")).toBe("ru");
    expect(normalizeTrackId("yt:fr+es")).toBe("es");
  });

  it("базовая дорожка — как есть", () => {
    expect(normalizeTrackId("yt:en")).toBe("yt:en");
    expect(normalizeTrackId("file:ru")).toBe("file:ru");
  });
});
