// Юнит-тесты payload нативного меню duo (карточка duopulse-087): состав
// вариантов, текущие отметки, дефолтный язык вне списка, пресет вида.
import { describe, expect, it } from "vitest";
import { buildDuoMenuPayload, menuFromId, menuToValue, type DuoMenuState } from "./duo-menu";
import type { AppliedTrackInfo, BaseTrackInfo, SubtitlesStyleInfo } from "../bridge/gen/types";

const style: SubtitlesStyleInfo = {
  fontScalePct: 100,
  fontFamily: "Inter",
  position: "bottom",
  marginPct: 6,
  plateOpacity: 0.78,
  originalColor: "#ffffff",
  translationColor: "#bdfe4f",
  mutedColor: "#ffffff",
  plateColor: "#0a0e17",
  textStroke: true,
};

const base: BaseTrackInfo[] = [
  { id: "yt:en", lang: "en", name: "English", original: true, kind: "caption", translatable: true },
  { id: "yt:de", lang: "de", name: "Deutsch", original: false, kind: "caption", translatable: true },
];

const tracks: AppliedTrackInfo[] = [
  { id: "yt:en", lang: "en", name: "English", source: "youtube", role: "original" },
  { id: "yt:en+ru", lang: "ru", name: "Русский", source: "youtube", role: "translation" },
];

const state: DuoMenuState = {
  enabled: true,
  videoKey: "https://x/v1",
  tracks,
  base,
  translations: [
    { lang: "ru", name: "Русский" },
    { lang: "es", name: "Español" },
  ],
  style,
};

describe("buildDuoMenuPayload", () => {
  it("отмечает текущие оригинал и платформенный перевод", () => {
    const p = buildDuoMenuPayload(state, "ru");
    expect(p.enabled).toBe(true);
    expect(p.hasVideo).toBe(true);
    const from = p.from.find((f) => f.current);
    expect(from?.id).toBe("yt:en");
    const to = p.to.find((t) => t.current);
    // платформенный перевод нормализуется «yt:en+ru» → «ru»
    expect(to?.value).toBe("ru");
    expect(to?.group).toBe("platform");
  });

  it("«Нет (только оригинал)» — первый пункт перевода и текущий без перевода", () => {
    const p = buildDuoMenuPayload(
      { ...state, tracks: [tracks[0]] },
      "ru",
    );
    expect(p.to[0]).toMatchObject({ value: "", group: "none", current: true });
    expect(p.to.slice(1).some((t) => t.current)).toBe(false);
  });

  it("облачные языки — после платформенных, с группой cloud", () => {
    const p = buildDuoMenuPayload(state, "ru");
    const groups = p.to.map((t) => t.group);
    expect(groups.indexOf("cloud")).toBeGreaterThan(groups.lastIndexOf("platform"));
    expect(p.to.some((t) => t.value === "cloud:ja")).toBe(true);
  });

  it("дефолт вне списка добавляется своим кодом", () => {
    const p = buildDuoMenuPayload(state, "PT-br");
    expect(p.defLang).toBe("pt-br");
    expect(p.defLangs.some((l) => l.code === "pt-br")).toBe(true);
  });

  it("стиль: позиция/размер и совпавший пресет вида", () => {
    const p = buildDuoMenuPayload(state, "ru");
    expect(p.style).toEqual({ position: "bottom", fontScalePct: 100, look: "brand" });
    const custom = buildDuoMenuPayload(
      { ...state, style: { ...style, plateOpacity: 0.5 } },
      "ru",
    );
    expect(custom.style.look).toBeNull();
  });

  it("без видео — флаг hasVideo гасит пункты файла/ASR (сборка в rust)", () => {
    const p = buildDuoMenuPayload({ ...state, videoKey: null }, "ru");
    expect(p.hasVideo).toBe(false);
  });
});

describe("menuFromId / menuToValue", () => {
  const p = buildDuoMenuPayload(state, "ru");
  it("индекс внутри списка — значение пункта", () => {
    expect(menuFromId(p, 1)).toBe("yt:de");
    expect(menuToValue(p, 0)).toBe("");
  });
  it("индекс мимо списка — null (пункт игнорируется)", () => {
    expect(menuFromId(p, 99)).toBeNull();
    expect(menuToValue(p, -1)).toBeNull();
  });
});
