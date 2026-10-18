// Тесты чтения дефолтов субтитров из window.__DUOPULSE_DEFAULTS__ (задача 5.1):
// чистые функции на объекте-холдере, без DOM.
import { describe, expect, it } from "vitest";
import { baseStyle, preferredLangs, type DefaultsHolder } from "./defaults";
import { DEFAULT_SUBTITLE_STYLE } from "./overlay/style";

const win = (value: unknown): DefaultsHolder => ({ __DUOPULSE_DEFAULTS__: value });

describe("preferredLangs (задача 5.1)", () => {
  it("настроенный язык — первым, прежний порядок следом", () => {
    const langs = preferredLangs(
      win({ subtitles: { defaultTranslationLang: "es" } }),
    );
    expect(langs[0]).toBe("es");
    expect(langs).toContain("ru");
  });

  it("язык нормализуется (регистр, пробелы, подтег)", () => {
    expect(preferredLangs(win({ subtitles: { defaultTranslationLang: " PT-BR " } }))[0]).toBe(
      "pt-br",
    );
  });

  it("мусорные значения — прежний порядок", () => {
    expect(preferredLangs(win(undefined))).toEqual(["ru", "uk", "en"]);
    expect(preferredLangs(win({}))[0]).toBe("ru");
    expect(preferredLangs(win({ subtitles: {} }))[0]).toBe("ru");
    expect(preferredLangs(win({ subtitles: { defaultTranslationLang: "x" } }))[0]).toBe("ru");
    expect(preferredLangs(win({ subtitles: { defaultTranslationLang: 42 } }))[0]).toBe("ru");
    expect(preferredLangs(win("не объект"))[0]).toBe("ru");
  });
});

describe("baseStyle (задача 5.1)", () => {
  it("патч настроек применяется с клампами", () => {
    const style = baseStyle(
      win({
        subtitles: {
          style: { fontScalePct: 130, position: "top", marginPct: 4, plateOpacity: 0.9 },
        },
      }),
    );
    expect(style).toEqual({
      fontScalePct: 130,
      position: "top",
      marginPct: 4,
      plateOpacity: 0.9,
    });
  });

  it("вышедшие за границы значения клампятся, мусор игнорируется", () => {
    const style = baseStyle(
      win({ subtitles: { style: { fontScalePct: 9999, position: "side", marginPct: 90 } } }),
    );
    expect(style.fontScalePct).toBe(300);
    expect(style.position).toBe("bottom");
    expect(style.marginPct).toBe(25);
  });

  it("без дефолтов — прежние значения content-слоя", () => {
    expect(baseStyle(win(undefined))).toEqual(DEFAULT_SUBTITLE_STYLE);
    expect(baseStyle(win({}))).toEqual(DEFAULT_SUBTITLE_STYLE);
  });
});
