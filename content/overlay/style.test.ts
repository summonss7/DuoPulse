// Юнит-тесты стиля плашки (задача 3.4): клампы настроек, шаг колесом,
// стили строк по гайду 06 §6, градиент подложки, кегль от масштаба,
// авто-подгон кегля при переполнении (карточка 046); цвета строк/плашки
// и обводка (карточка duopulse-059).
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUBTITLE_STYLE,
  MARGIN_MAX_PCT,
  PLATE_MAX_SHARE,
  SCALE_MAX_PCT,
  SCALE_MIN_PCT,
  clampColor,
  fitStepPct,
  hexToRgba,
  mergeStyle,
  plateBackground,
  plateFontSizeCss,
  rowStyleFor,
  stepScale,
} from "./style";

describe("mergeStyle — настройки отображения с клампами", () => {
  it("дефолт: низ, масштаб 100%, отступ 6%, подложка 0,78, фирменные цвета, обводка (гайд 06 §6)", () => {
    expect(DEFAULT_SUBTITLE_STYLE).toEqual({
      fontScalePct: 100,
      position: "bottom",
      marginPct: 6,
      plateOpacity: 0.78,
      originalColor: "#ffffff",
      translationColor: "#bdfe4f",
      mutedColor: "#ffffff",
      plateColor: "#0a0e17",
      textStroke: true,
    });
  });

  it("патч применяется, прочие поля сохраняются", () => {
    expect(mergeStyle(DEFAULT_SUBTITLE_STYLE, { position: "top" })).toEqual({
      ...DEFAULT_SUBTITLE_STYLE,
      position: "top",
    });
    expect(mergeStyle(DEFAULT_SUBTITLE_STYLE, { fontScalePct: 160 })).toEqual({
      ...DEFAULT_SUBTITLE_STYLE,
      fontScalePct: 160,
    });
  });

  it("масштаб клампится 75–300, отступ 0–25, подложка 0,2–1 (docs/03 §5)", () => {
    expect(mergeStyle(DEFAULT_SUBTITLE_STYLE, { fontScalePct: 10 }).fontScalePct).toBe(SCALE_MIN_PCT);
    expect(mergeStyle(DEFAULT_SUBTITLE_STYLE, { fontScalePct: 9999 }).fontScalePct).toBe(SCALE_MAX_PCT);
    expect(mergeStyle(DEFAULT_SUBTITLE_STYLE, { marginPct: -5 }).marginPct).toBe(0);
    expect(mergeStyle(DEFAULT_SUBTITLE_STYLE, { marginPct: 90 }).marginPct).toBe(MARGIN_MAX_PCT);
    expect(mergeStyle(DEFAULT_SUBTITLE_STYLE, { plateOpacity: 0 }).plateOpacity).toBe(0.2);
    expect(mergeStyle(DEFAULT_SUBTITLE_STYLE, { plateOpacity: 2 }).plateOpacity).toBe(1);
  });

  it("неизвестные значения игнорируются (безопасный тест-хук/IPC)", () => {
    const patched = mergeStyle(DEFAULT_SUBTITLE_STYLE, {
      position: "middle" as unknown as "bottom",
      fontScalePct: "200" as unknown as number,
    });
    expect(patched.position).toBe("bottom");
    expect(patched.fontScalePct).toBe(DEFAULT_SUBTITLE_STYLE.fontScalePct);
  });
});

describe("clampColor/hexToRgba — цвета строк и подложки (карточка 059)", () => {
  it("#RGB и #RRGGBB канонизируются к #rrggbb", () => {
    expect(clampColor("#FFDD33", "#000000")).toBe("#ffdd33");
    expect(clampColor("#fC3", "#000000")).toBe("#ffcc33");
    expect(clampColor(" #BdFe4F ", "#000000")).toBe("#bdfe4f");
  });

  it("мусор игнорируется — fallback (старые settings.json, тест-хуки)", () => {
    expect(clampColor("red", "#0a0e17")).toBe("#0a0e17");
    expect(clampColor("rgb(1,2,3)", "#0a0e17")).toBe("#0a0e17");
    expect(clampColor("#12345", "#0a0e17")).toBe("#0a0e17");
    expect(clampColor(42, "#0a0e17")).toBe("#0a0e17");
    expect(clampColor(undefined, "#0a0e17")).toBe("#0a0e17");
  });

  it("hex → rgba: прозрачность строк и градиента", () => {
    expect(hexToRgba("#0a0e17", 0.78)).toBe("rgba(10,14,23,0.780)");
    expect(hexToRgba("#ffffff", 0.75)).toBe("rgba(255,255,255,0.750)");
  });

  it("патч цветов применяется с клампами, чужие типы — базовые значения", () => {
    const brand = mergeStyle(DEFAULT_SUBTITLE_STYLE, {
      originalColor: "#FFDD33",
      plateColor: "#000000",
      textStroke: false,
    });
    expect(brand.originalColor).toBe("#ffdd33");
    expect(brand.plateColor).toBe("#000000");
    expect(brand.textStroke).toBe(false);
    const junk = mergeStyle(brand, {
      originalColor: 42 as unknown as string,
      plateColor: "жёлтый",
      textStroke: "да" as unknown as boolean,
    });
    expect(junk.originalColor).toBe("#ffdd33");
    expect(junk.plateColor).toBe("#000000");
    expect(junk.textStroke).toBe(false);
  });
});

describe("stepScale — колесо мыши (шаг 10%, границы 75–300)", () => {
  it("вверх/вниз на шаг", () => {
    expect(stepScale(100, 1)).toBe(110);
    expect(stepScale(100, -1)).toBe(90);
  });

  it("на границах не выходит за диапазон", () => {
    expect(stepScale(SCALE_MAX_PCT, 1)).toBe(SCALE_MAX_PCT);
    expect(stepScale(SCALE_MIN_PCT, -1)).toBe(SCALE_MIN_PCT);
  });

  it("дробный масштаб выравнивается к шагу", () => {
    expect(stepScale(103, 1)).toBe(110);
  });
});

describe("rowStyleFor — строки набора по гайду 06 §6, цвета из стиля (059)", () => {
  it("фирменный вид: белый 500 / лайм #BDFE4F / приглушённый белый с alpha 0.75", () => {
    expect(rowStyleFor(0, DEFAULT_SUBTITLE_STYLE)).toEqual({
      color: "#ffffff",
      fontScale: 1,
      weight: 500,
    });
    expect(rowStyleFor(1, DEFAULT_SUBTITLE_STYLE)).toEqual({
      color: "#bdfe4f",
      fontScale: 0.85,
      weight: 400,
    });
    expect(rowStyleFor(2, DEFAULT_SUBTITLE_STYLE)).toEqual({
      color: "rgba(255,255,255,0.750)",
      fontScale: 0.75,
      weight: 400,
    });
    expect(rowStyleFor(5, DEFAULT_SUBTITLE_STYLE)).toEqual(rowStyleFor(2, DEFAULT_SUBTITLE_STYLE));
  });

  it("пресет «жёлтый TV»: цвета строк берутся из стиля", () => {
    const tv = {
      ...DEFAULT_SUBTITLE_STYLE,
      originalColor: "#ffdd33",
      translationColor: "#ffffff",
      mutedColor: "#ffdd33",
    };
    expect(rowStyleFor(0, tv).color).toBe("#ffdd33");
    expect(rowStyleFor(1, tv).color).toBe("#ffffff");
    expect(rowStyleFor(2, tv).color).toBe("rgba(255,221,51,0.750)");
  });
});

describe("fitStepPct — авто-уменьшение кегля при переполнении (карточка 046)", () => {
  it("потолок плашки — половина высоты видео (PLATE_MAX_SHARE)", () => {
    expect(PLATE_MAX_SHARE).toBe(0.5);
  });

  it("без переполнения кегль не меняется (влезает или впритык)", () => {
    expect(fitStepPct(100, 180, 100)).toBe(100);
    expect(fitStepPct(180, 180, 100)).toBe(100);
    expect(fitStepPct(120, 180, 250)).toBe(250);
  });

  it("переполнение: кегль уменьшается пропорционально maxH/plateH", () => {
    expect(fitStepPct(200, 180, 100)).toBe(90);
    expect(fitStepPct(240, 180, 300)).toBe(225);
  });

  it("не ниже клампа читаемости 75% даже при сильном переполнении", () => {
    expect(fitStepPct(400, 100, 100)).toBe(SCALE_MIN_PCT); // «хотел» 25%
    expect(fitStepPct(200, 50, 90)).toBe(SCALE_MIN_PCT); // «хотел» 22,5%
  });

  it("некорректная геометрия (0/отрицательная) — кегль не трогаем", () => {
    expect(fitStepPct(0, 180, 100)).toBe(100);
    expect(fitStepPct(-10, 180, 100)).toBe(100);
    expect(fitStepPct(200, 0, 100)).toBe(100);
  });

  it("итерации сходятся: шаги с замером монотонно приближают высоту к потолку", () => {
    // Модель высоты: 199em-часть × кегль/100 + 16px паддинга (геометрия плашки)
    const heightOf = (pct: number) => 1.99 * pct + 16;
    let pct = 100;
    for (let i = 0; i < 4; i++) {
      const next = fitStepPct(heightOf(pct), 180, pct);
      if (next >= pct - 0.05) break;
      pct = next;
    }
    expect(pct).toBeGreaterThan(75);
    expect(pct).toBeLessThan(90);
    expect(heightOf(pct)).toBeLessThanOrEqual(180 + 1);
  });
});

describe("подложка и кегль", () => {
  it("градиент: сине-чёрный rgba(10,14,23,.78) → прозрачный (гайд 06 §6)", () => {
    expect(plateBackground(0.78, "#0a0e17")).toBe(
      "linear-gradient(rgba(10,14,23,0.780), rgba(10,14,23,0.000))",
    );
  });

  it("цвет подложки настраивается: чёрный пресет — rgba(0,0,0,…)", () => {
    expect(plateBackground(0.9, "#000000")).toBe(
      "linear-gradient(rgba(0,0,0,0.900), rgba(0,0,0,0.000))",
    );
  });

  it("базовый кегль = clamp от ширины видео × масштаб пользователя", () => {
    expect(plateFontSizeCss(100)).toBe("calc(clamp(14px, 2.6cqw, 34px) * 1.00)");
    expect(plateFontSizeCss(175)).toBe("calc(clamp(14px, 2.6cqw, 34px) * 1.75)");
  });
});
