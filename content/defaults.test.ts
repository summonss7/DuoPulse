// Тесты чтения дефолтов субтитров из window.__DUOPULSE_DEFAULTS__ (задача 5.1):
// чистые функции на объекте-холдере, без DOM.
import { describe, expect, it } from "vitest";
import {
  baseStyle,
  interfaceTranslationLang,
  lastDuoEnabled,
  preferredLangs,
  type DefaultsHolder,
} from "./defaults";
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
    expect(preferredLangs(win(undefined))).toEqual(["en", "ro", "ru", "ar"]);
    expect(preferredLangs(win({}))[0]).toBe("en");
    expect(preferredLangs(win({ subtitles: {} }))[0]).toBe("en");
    expect(preferredLangs(win({ subtitles: { defaultTranslationLang: "x" } }))[0]).toBe("en");
    expect(preferredLangs(win({ subtitles: { defaultTranslationLang: 42 } }))[0]).toBe("en");
    expect(preferredLangs(win("не объект"))[0]).toBe("en");
  });
});

describe("baseStyle (задача 5.1)", () => {
  it("патч настроек применяется с клампами", () => {
    const style = baseStyle(
      win({
        subtitles: {
          style: {
            fontScalePct: 130,
            position: "top",
            marginPct: 4,
            plateOpacity: 0.9,
            originalColor: "#FFDD33",
            plateColor: "#000000",
            textStroke: false,
          },
        },
      }),
    );
    expect(style).toEqual({
      fontScalePct: 130,
      fontFamily: "Inter",
      position: "top",
      marginPct: 4,
      plateOpacity: 0.9,
      originalColor: "#ffdd33",
      translationColor: "#bdfe4f",
      mutedColor: "#ffffff",
      plateColor: "#000000",
      textStroke: false,
      swapRows: false,
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

  it("старые settings.json без цветов — фирменные дефолты (карточка 059)", () => {
    const style = baseStyle(
      win({ subtitles: { style: { originalColor: "красный", textStroke: 1 as unknown as boolean } } }),
    );
    expect(style.originalColor).toBe("#ffffff");
    expect(style.textStroke).toBe(true);
  });

  it("без дефолтов — прежние значения content-слоя", () => {
    expect(baseStyle(win(undefined))).toEqual(DEFAULT_SUBTITLE_STYLE);
    expect(baseStyle(win({}))).toEqual(DEFAULT_SUBTITLE_STYLE);
  });
});

// duopulse-128: последнее вкл/выкл duo — новые окна стартуют в нём;
// duopulse-196: без переключений (null) показ включён ПО УМОЛЧАНИЮ.
describe("lastDuoEnabled (duopulse-128/196)", () => {
  it("boolean читается как есть", () => {
    expect(lastDuoEnabled(win({ subtitles: { lastEnabled: true } }))).toBe(true);
    expect(lastDuoEnabled(win({ subtitles: { lastEnabled: false } }))).toBe(false);
  });

  it("отсутствует/мусор — true: дуо включён по умолчанию (duopulse-196)", () => {
    expect(lastDuoEnabled(win(undefined))).toBe(true);
    expect(lastDuoEnabled(win({}))).toBe(true);
    expect(lastDuoEnabled(win({ subtitles: {} }))).toBe(true);
    expect(lastDuoEnabled(win({ subtitles: { lastEnabled: "on" } }))).toBe(true);
  });
});

describe("interfaceTranslationLang (карточка duopulse-177)", () => {
  it("язык перевода из настроек — цель автоперевода файла", () => {
    expect(
      interfaceTranslationLang(win({ subtitles: { defaultTranslationLang: "es" } })),
    ).toBe("es");
    expect(
      interfaceTranslationLang(win({ subtitles: { defaultTranslationLang: " PT-BR " } })),
    ).toBe("pt-br");
  });

  it("нет/битые настройки — «ru» (язык интерфейса, дефолт настроек Core)", () => {
    // в отличие от preferredLangs (первый «en») автоперевод целится в язык
    // интерфейса, а не в порядок предпочитаемых
    expect(interfaceTranslationLang(win(undefined))).toBe("ru");
    expect(interfaceTranslationLang(win({}))).toBe("ru");
    expect(interfaceTranslationLang(win({ subtitles: { defaultTranslationLang: 42 } }))).toBe("ru");
  });
});
