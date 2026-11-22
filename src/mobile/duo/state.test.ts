// Тесты настроек duo мобильной ветки (duopulse-082): дефолты, канонизация
// мусора из хранилища, клампы кегля/сдвига, персист, разбор выбора перевода.
// duopulse-201: дефолт перевода — «auto» (правило дуо duopulse-196), явный
// выбор главнее, легаси «gtx:ru» мигрирует на «auto».

import { describe, expect, it } from "vitest";
import {
  AUTO_TRANSLATION,
  defaultDuoSettings,
  loadDuoSettings,
  normalizeSettings,
  parseTranslationChoice,
  resolveTranslationChoice,
  saveDuoSettings,
} from "./state";

function memStorage(): Pick<Storage, "getItem" | "setItem"> & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe("duo mobile settings", () => {
  it("дефолты: включён по умолчанию (duo-196 «показ включён»), перевод — авто (правило дуо), кегль 100, низ, без сдвига", () => {
    const d = defaultDuoSettings();
    expect(d.enabled).toBe(true);
    expect(d.translation).toBe(AUTO_TRANSLATION);
    expect(d.originalId).toBeNull();
    expect(d.fontScalePct).toBe(100);
    expect(d.position).toBe("bottom");
    expect(d.offsetMs).toBe(0);
  });

  it("канонизация: мусорные типы → дефолты, клампы кегля и сдвига", () => {
    const n = normalizeSettings({
      enabled: "да",
      originalId: 42,
      translation: "yandex:ru",
      fontScalePct: 999,
      position: "middle",
      offsetMs: -12345,
    });
    expect(n.enabled).toBe(true);
    expect(n.originalId).toBeNull();
    expect(n.translation).toBeNull();
    expect(n.fontScalePct).toBe(300);
    expect(n.position).toBe("bottom");
    expect(n.offsetMs).toBe(-10000);
    expect(normalizeSettings({ fontScalePct: 10 }).fontScalePct).toBe(75);
    expect(normalizeSettings(null)).toEqual(defaultDuoSettings());
  });

  it("канонизация перевода (duopulse-201): легаси-дефолт gtx:ru → авто, авто/явные проходят", () => {
    expect(normalizeSettings({ translation: "gtx:ru" }).translation).toBe(AUTO_TRANSLATION);
    expect(normalizeSettings({ translation: AUTO_TRANSLATION }).translation).toBe(AUTO_TRANSLATION);
    expect(normalizeSettings({ translation: "gtx:uk" }).translation).toBe("gtx:uk");
    expect(normalizeSettings({ translation: "track:yt:ru" }).translation).toBe("track:yt:ru");
    // миграция доходит до загрузки: телефон со старым дефолтом получает правило
    const st = memStorage();
    st.map.set("duopulse.duo.mobile.v1", JSON.stringify({ ...defaultDuoSettings(), translation: "gtx:ru" }));
    expect(loadDuoSettings(st).translation).toBe(AUTO_TRANSLATION);
  });

  it("персист: save → load по кругу, битый JSON — дефолты", () => {
    const st = memStorage();
    const s = { ...defaultDuoSettings(), translation: "track:yt:ru", fontScalePct: 140 };
    saveDuoSettings(s, st);
    expect(loadDuoSettings(st)).toEqual(s);
    st.map.set("duopulse.duo.mobile.v1", "{битый");
    expect(loadDuoSettings(st)).toEqual(defaultDuoSettings());
  });

  it("выбор перевода: none / gtx / track", () => {
    expect(parseTranslationChoice(null)).toEqual({ kind: "none" });
    expect(parseTranslationChoice("gtx:uk")).toEqual({ kind: "gtx", lang: "uk" });
    expect(parseTranslationChoice("track:yt:ru")).toEqual({ kind: "track", baseId: "yt:ru" });
  });
});

describe("resolveTranslationChoice — правило дуо duopulse-196 на мобильной ветке (duopulse-201)", () => {
  it("авто: русский оригинал (и с подтегом) → gtx:en, прочие → gtx:ru", () => {
    expect(resolveTranslationChoice(AUTO_TRANSLATION, "ru")).toEqual({ kind: "gtx", lang: "en" });
    expect(resolveTranslationChoice(AUTO_TRANSLATION, "ru-RU")).toEqual({ kind: "gtx", lang: "en" });
    expect(resolveTranslationChoice(AUTO_TRANSLATION, "en")).toEqual({ kind: "gtx", lang: "ru" });
    expect(resolveTranslationChoice(AUTO_TRANSLATION, "ko")).toEqual({ kind: "gtx", lang: "ru" });
    expect(resolveTranslationChoice(AUTO_TRANSLATION, "und")).toEqual({ kind: "gtx", lang: "ru" });
  });

  it("duopulse-216: украинский оригинал — как русский, авто → gtx:en", () => {
    expect(resolveTranslationChoice(AUTO_TRANSLATION, "uk")).toEqual({ kind: "gtx", lang: "en" });
    expect(resolveTranslationChoice(AUTO_TRANSLATION, "uk-UA")).toEqual({ kind: "gtx", lang: "en" });
  });

  it("явный выбор в панели главнее правила — не перетирается", () => {
    expect(resolveTranslationChoice("gtx:uk", "ru")).toEqual({ kind: "gtx", lang: "uk" });
    expect(resolveTranslationChoice("gtx:en", "ru")).toEqual({ kind: "gtx", lang: "en" });
    expect(resolveTranslationChoice("gtx:ru", "en")).toEqual({ kind: "gtx", lang: "ru" });
  });

  it("готовая дорожка (track:) и «нет» — правило не вмешивается", () => {
    expect(resolveTranslationChoice("track:yt:en", "ru")).toEqual({ kind: "track", baseId: "yt:en" });
    expect(resolveTranslationChoice(null, "ru")).toEqual({ kind: "none" });
  });
});
