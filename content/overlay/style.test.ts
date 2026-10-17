// Юнит-тесты стиля плашки (задача 3.4): клампы настроек, шаг колесом,
// стили строк по гайду 06 §6, градиент подложки, кегль от масштаба,
// авто-подгон кегля при переполнении (карточка 046).
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUBTITLE_STYLE,
  MARGIN_MAX_PCT,
  PLATE_MAX_SHARE,
  SCALE_MAX_PCT,
  SCALE_MIN_PCT,
  fitStepPct,
  mergeStyle,
  plateBackground,
  plateFontSizeCss,
  rowStyleFor,
  stepScale,
} from "./style";

describe("mergeStyle — настройки отображения с клампами", () => {
  it("дефолт: низ, масштаб 100%, отступ 6%, подложка 0,78 (гайд 06 §6)", () => {
    expect(DEFAULT_SUBTITLE_STYLE).toEqual({
      fontScalePct: 100,
      position: "bottom",
      marginPct: 6,
      plateOpacity: 0.78,
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

describe("rowStyleFor — строки набора по гайду 06 §6", () => {
  it("первая — оригинал: белый, 100% кегля, вес 500", () => {
    expect(rowStyleFor(0)).toEqual({ color: "#FFFFFF", fontScale: 1, weight: 500 });
  });

  it("вторая — перевод: фирменный лайм #BDFE4F, 85% кегля, вес 400", () => {
    expect(rowStyleFor(1)).toEqual({ color: "#BDFE4F", fontScale: 0.85, weight: 400 });
  });

  it("третья и далее — приглушённые: белый 75% прозрачности, 75% кегля", () => {
    expect(rowStyleFor(2)).toEqual({ color: "rgba(255,255,255,0.75)", fontScale: 0.75, weight: 400 });
    expect(rowStyleFor(5)).toEqual(rowStyleFor(2));
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
    expect(plateBackground(0.78)).toBe("linear-gradient(rgba(10,14,23,0.780), rgba(10,14,23,0))");
  });

  it("базовый кегль = clamp от ширины видео × масштаб пользователя", () => {
    expect(plateFontSizeCss(100)).toBe("calc(clamp(14px, 2.6cqw, 34px) * 1.00)");
    expect(plateFontSizeCss(175)).toBe("calc(clamp(14px, 2.6cqw, 34px) * 1.75)");
  });
});
