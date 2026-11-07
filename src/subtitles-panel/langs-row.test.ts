// Тесты строки «Языки: с какого → на какой» панели «duo» (карточка
// duopulse-079): выбор по применённому набору, варианты селекта «Перевод»,
// действия смены оригинала/перевода (набор, облачная строка, конвейер).
import { describe, expect, it } from "vitest";
import { fromChange, fromOptions, langRowState, toChange, toOptions } from "./langs-row";
import type { AppliedTrackInfo, BaseTrackInfo, TranslationLangInfo } from "../bridge/gen/types";

const base = (over: Partial<BaseTrackInfo> = {}): BaseTrackInfo => ({
  id: over.id ?? "yt:en",
  lang: over.lang ?? "en",
  kind: over.kind ?? "manual",
  name: over.name ?? "English",
  original: over.original ?? false,
  translatable: over.translatable ?? true,
});

const applied = (over: Partial<AppliedTrackInfo> = {}): AppliedTrackInfo => ({
  id: over.id ?? "yt:en",
  lang: over.lang ?? "en",
  name: over.name ?? "English",
  role: over.role ?? "original",
  source: over.source ?? "youtube",
});

const tlang = (lang: string): TranslationLangInfo => ({ lang, name: `T:${lang}` });

describe("langRowState", () => {
  it("дуо en+ru: оригинал по role, платформенный перевод по «+» в id", () => {
    const row = langRowState([applied(), applied({ id: "yt:en+ru", lang: "ru", role: "translation" })]);
    expect(row).toEqual({ fromId: "yt:en", to: { kind: "platform", lang: "ru" } });
  });

  it("облачная строка cloud:ru — to=cloud", () => {
    const row = langRowState([
      applied(),
      applied({ id: "cloud:ru", lang: "ru", role: "translation", source: "translate" }),
    ]);
    expect(row).toEqual({ fromId: "yt:en", to: { kind: "cloud", lang: "ru" } });
  });

  it("только оригинал и файловые/ASR строки: to=none, from — платформенная", () => {
    const row = langRowState([
      applied(),
      applied({ id: "asr:en", lang: "en", source: "asr" }),
      applied({ id: "file:x.srt", lang: "ru", source: "file" }),
    ]);
    expect(row).toEqual({ fromId: "yt:en", to: { kind: "none" } });
  });

  it("пустой набор — from=null, to=none", () => {
    expect(langRowState([])).toEqual({ fromId: null, to: { kind: "none" } });
  });
});

describe("fromOptions", () => {
  it("базовые дорожки с пометками оригинала и авто", () => {
    expect(fromOptions([base({ original: true }), base({ id: "yt:en:asr", kind: "asr", lang: "en" })])).toEqual([
      { id: "yt:en", name: "English · оригинал (en)" },
      { id: "yt:en:asr", name: "English · авто (en)" },
    ]);
  });
});

describe("toOptions", () => {
  it("tlang платформы (без языка оригинала) + облачные (без tlang)", () => {
    const opts = toOptions([tlang("ru"), tlang("en")], { lang: "en", translatable: true });
    expect(opts.filter((o) => o.group === "platform")).toEqual([
      { value: "ru", name: "T:ru (ru)", group: "platform" },
    ]);
    const cloud = opts.filter((o) => o.group === "cloud");
    expect(cloud.some((o) => o.value === "cloud:ru")).toBe(false); // tlang приоритетнее
    expect(cloud.some((o) => o.value === "cloud:es")).toBe(true);
    expect(cloud.some((o) => o.value === "cloud:en")).toBe(false); // язык оригинала
  });

  it("непереводимый оригинал — только облачные языки", () => {
    const opts = toOptions([tlang("ru")], { lang: "en", translatable: false });
    expect(opts.some((o) => o.group === "platform")).toBe(false);
    expect(opts.some((o) => o.value === "cloud:ru")).toBe(true);
  });
});

describe("fromChange", () => {
  it("дуо en+ru → оригинал fr: набор fr+ru (перевод прижился к новой базе)", () => {
    const actions = fromChange(
      [applied(), applied({ id: "yt:en+ru", lang: "ru", role: "translation" })],
      [base({ original: true }), base({ id: "yt:fr", lang: "fr" })],
      "yt:fr",
    );
    expect(actions).toEqual([{ type: "set", ids: ["yt:fr", "ru"] }]);
  });

  it("тот же оригинал — действий нет", () => {
    expect(fromChange([applied()], [base({ original: true })], "yt:en")).toEqual([]);
  });

  it("непереводимая база — одна дорожка, без перевода", () => {
    const actions = fromChange(
      [applied(), applied({ id: "yt:en+ru", lang: "ru", role: "translation" })],
      [base({ original: true }), base({ id: "yt:fr", lang: "fr", translatable: false })],
      "yt:fr",
    );
    expect(actions).toEqual([{ type: "set", ids: ["yt:fr"] }]);
  });
});

describe("toChange", () => {
  const baseList = [base({ original: true }), base({ id: "yt:fr", lang: "fr" })];

  it("«нет» — только оригинал; облачная строка снимается", () => {
    const actions = toChange(
      [applied(), applied({ id: "cloud:es", lang: "es", source: "translate", role: "translation" })],
      baseList,
      "",
    );
    expect(actions).toEqual([
      { type: "remove", id: "cloud:es" },
      { type: "set", ids: ["yt:en"] },
    ]);
  });

  it("tlang — дуо оригинал+перевод", () => {
    expect(toChange([applied()], baseList, "ru")).toEqual([{ type: "set", ids: ["yt:en", "ru"] }]);
  });

  it("облако — оригинал источником + конвейер; прежняя облачная строка заменяется", () => {
    const actions = toChange(
      [applied(), applied({ id: "cloud:es", lang: "es", source: "translate", role: "translation" })],
      baseList,
      "cloud:de",
    );
    expect(actions).toEqual([
      { type: "remove", id: "cloud:es" },
      { type: "set", ids: ["yt:en"] },
      { type: "translate", lang: "de" },
    ]);
  });

  it("перевод языка оригинала — без второй строки", () => {
    expect(toChange([applied()], baseList, "en")).toEqual([{ type: "set", ids: ["yt:en"] }]);
  });

  it("без оригинала в наборе — оригинал списка как источник", () => {
    expect(toChange([], baseList, "ru")).toEqual([{ type: "set", ids: ["yt:en", "ru"] }]);
  });
});
