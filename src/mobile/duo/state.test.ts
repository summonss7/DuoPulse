// Тесты настроек duo мобильной ветки (duopulse-082): дефолты, канонизация
// мусора из хранилища, клампы кегля/сдвига, персист, разбор выбора перевода.

import { describe, expect, it } from "vitest";
import {
  defaultDuoSettings,
  loadDuoSettings,
  normalizeSettings,
  parseTranslationChoice,
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
  it("дефолты: включено, перевод gtx:ru, кегль 100, низ, без сдвига", () => {
    const d = defaultDuoSettings();
    expect(d.enabled).toBe(true);
    expect(d.translation).toBe("gtx:ru");
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
