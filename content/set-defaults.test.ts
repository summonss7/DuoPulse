// Тесты дефолтного набора Alt+D (задача 3.7): defaultSetIds — «оригинал +
// предпочитаемый перевод» из списка адаптера; sameMembers — fast-path
// перестановки набора панелью; decideToggle — решение Alt+D (duopulse-066:
// «флаг поднят, набор пуст» — собрать дефолт, а не снять флаг).
import { describe, expect, it } from "vitest";
import { decideToggle, defaultSetIds, sameMembers } from "./set-defaults";
import type { AdapterTrackList } from "./adapters/types";

const list = (base: Partial<AdapterTrackList["base"][number]>[], translations: string[]): AdapterTrackList => ({
  adapter: "youtube",
  version: "test",
  usedPath: "player-api",
  base: base.map((b, i) => ({
    id: b.id ?? `yt:${b.lang ?? "en"}`,
    lang: b.lang ?? "en",
    kind: b.kind ?? "manual",
    name: b.name ?? `Track ${i}`,
    vssId: b.vssId ?? ".en",
    translatable: b.translatable ?? true,
    original: b.original ?? false,
  })),
  translations: translations.map((lang) => ({ lang, name: `T:${lang}` })),
  warnings: [],
});

describe("defaultSetIds (Alt+D на пустом наборе)", () => {
  it("оригинал + первый предпочитаемый перевод (ru)", () => {
    const ids = defaultSetIds(list([{ lang: "en", original: true }], ["es", "ru", "uk"]));
    expect(ids).toEqual(["yt:en", "ru"]); // ru предпочтительнее es, хоть и позже в списке
  });

  it("цепочка предпочтений ru → uk → en", () => {
    expect(defaultSetIds(list([{ lang: "en", original: true }], ["es"]))[1]).toBe("es");
    expect(defaultSetIds(list([{ lang: "en", original: true }], ["uk", "es"]))[1]).toBe("uk");
  });

  it("без флага original — первая базовая дорожка", () => {
    const ids = defaultSetIds(list([{ lang: "fr" }, { lang: "de" }], ["ru"]));
    expect(ids).toEqual(["yt:fr", "ru"]);
  });

  it("переводов нет — один оригинал", () => {
    expect(defaultSetIds(list([{ lang: "en", original: true }], []))).toEqual(["yt:en"]);
  });

  it("оригинал непереводимый (translatable=false) — перевод не добавляется", () => {
    const ids = defaultSetIds(list([{ lang: "en", original: true, translatable: false }], ["ru"]));
    expect(ids).toEqual(["yt:en"]);
  });

  it("перевод языка оригинала не выбирается (en-видео, только en-перевод)", () => {
    const ids = defaultSetIds(list([{ lang: "en", original: true }], ["en"]));
    expect(ids).toEqual(["yt:en"]);
  });

  it("пустой список адаптера — включать нечего", () => {
    expect(defaultSetIds(null)).toEqual([]);
    expect(defaultSetIds(list([], ["ru"]))).toEqual([]);
  });
});

describe("decideToggle (Alt+D: дефект duopulse-066)", () => {
  it("флаг поднят + пустой набор + дорожки готовы — собрать дефолт, а не снять флаг", () => {
    // Прежний код в этом состоянии выключал показ («вкл — 0 дорожек» → выкл);
    // для пользователя субтитров нет — первое нажатие должно включать дуо.
    expect(decideToggle(true, false, list([{ lang: "en", original: true }], ["ru"]))).toEqual({
      on: true,
      ids: ["yt:en", "ru"],
    });
  });

  it("показ активен (флаг + непустой набор) — выключить, помня состав", () => {
    expect(decideToggle(true, true, list([{ lang: "en", original: true }], ["ru"]))).toEqual({ on: false });
  });

  it("флаг снят + непустой набор — включить, восстановив прошлый набор (без дефолта)", () => {
    expect(decideToggle(false, true, list([{ lang: "en", original: true }], ["ru"]))).toEqual({
      on: true,
      ids: [],
    });
  });

  it("пустой набор, список дорожек не готов/пуст — включить как есть (включать нечего)", () => {
    expect(decideToggle(true, false, null)).toEqual({ on: true, ids: [] });
    expect(decideToggle(false, false, list([], []))).toEqual({ on: true, ids: [] });
  });

  it("переводов нет — дефолт из одного оригинала", () => {
    expect(decideToggle(true, false, list([{ lang: "en", original: true }], []))).toEqual({
      on: true,
      ids: ["yt:en"],
    });
  });
});

describe("sameMembers (fast-path перестановки)", () => {
  it("тот же состав в другом порядке — true", () => {
    expect(sameMembers(["yt:en", "yt:en+ru", "yt:en+es"], ["yt:en+es", "yt:en", "yt:en+ru"])).toBe(true);
  });

  it("тот же порядок — true", () => {
    expect(sameMembers(["a", "b"], ["a", "b"])).toBe(true);
  });

  it("другой состав / длина — false", () => {
    expect(sameMembers(["a", "b"], ["a", "c"])).toBe(false);
    expect(sameMembers(["a"], ["a", "b"])).toBe(false);
    expect(sameMembers([], ["a"])).toBe(false);
  });

  it("дубликаты учитываются как мультимножество", () => {
    expect(sameMembers(["a", "a", "b"], ["b", "a", "a"])).toBe(true);
    expect(sameMembers(["a", "a"], ["a", "b"])).toBe(false);
  });
});
