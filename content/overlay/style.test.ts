// Юнит-тесты стиля плашки (задача 3.4): клампы настроек, шаг колесом,
// стили строк по гайду 06 §6, градиент подложки, кегль от масштаба,
// авто-подгон кегля при переполнении (карточка 046); цвета строк/плашки
// и обводка (карточка duopulse-059).
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUBTITLE_STYLE,
  FONT_FAMILY_VALUES,
  MARGIN_MAX_PCT,
  PLATE_MAX_SHARE,
  SCALE_MAX_PCT,
  SCALE_MIN_PCT,
  clampColor,
  cssFontFamily,
  fitStepPct,
  hexToRgba,
  isRuUaLang,
  mergeStyle,
  plateBackground,
  plateFontSizeCss,
  rowDisplayOrder,
  rowStyleFor,
  stepScale,
  visibleRowText,
} from "./style";

describe("mergeStyle — настройки отображения с клампами", () => {
  it("дефолт: Inter, низ, масштаб 100%, отступ 6%, подложка 0,78, фирменные цвета, обводка (гайд 06 §6)", () => {
    expect(DEFAULT_SUBTITLE_STYLE).toEqual({
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
      swapRows: false,
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
    expect(mergeStyle(DEFAULT_SUBTITLE_STYLE, { fontFamily: "JetBrains Mono" })).toEqual({
      ...DEFAULT_SUBTITLE_STYLE,
      fontFamily: "JetBrains Mono",
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

describe("fontFamily — гарнитура плашки (карточка duopulse-068)", () => {
  it("список: только фирменные с кириллическими сабсетами + системная", () => {
    expect(FONT_FAMILY_VALUES).toEqual(["Inter", "JetBrains Mono", "system"]);
  });

  it("mergeStyle принимает значения из списка, мусор игнорирует", () => {
    expect(mergeStyle(DEFAULT_SUBTITLE_STYLE, { fontFamily: "system" }).fontFamily).toBe("system");
    expect(mergeStyle(DEFAULT_SUBTITLE_STYLE, { fontFamily: "Comic Sans" }).fontFamily).toBe("Inter");
    expect(
      mergeStyle({ ...DEFAULT_SUBTITLE_STYLE, fontFamily: "system" }, { position: "top" }).fontFamily,
    ).toBe("system");
  });

  it("cssFontFamily: именная гарнитура с фолбэком, system — системный стек", () => {
    expect(cssFontFamily("Inter")).toBe("Inter, 'Segoe UI', system-ui, sans-serif");
    expect(cssFontFamily("JetBrains Mono")).toBe("'JetBrains Mono', Consolas, 'Courier New', monospace");
    expect(cssFontFamily("system")).toBe("system-ui, 'Segoe UI', sans-serif");
    // неизвестное значение — стек дефолта Inter (снисходительно)
    expect(cssFontFamily("Comic Sans")).toBe("Inter, 'Segoe UI', system-ui, sans-serif");
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

// duopulse-181: перестановка строк (перевод сверху) — патч и порядок показа.
describe("swapRows (duopulse-181)", () => {
  it("дефолт false, патч bool, мусор игнорируется", () => {
    expect(DEFAULT_SUBTITLE_STYLE.swapRows).toBe(false);
    expect(mergeStyle(DEFAULT_SUBTITLE_STYLE, { swapRows: true }).swapRows).toBe(true);
    expect(mergeStyle({ ...DEFAULT_SUBTITLE_STYLE, swapRows: true }, {}).swapRows).toBe(true);
    expect(
      mergeStyle(DEFAULT_SUBTITLE_STYLE, { swapRows: "yes" as unknown as boolean }).swapRows,
    ).toBe(false);
  });

  it("rowDisplayOrder: без перестановки — порядок дорожек, с ней — обратный", () => {
    expect(rowDisplayOrder(["en", "ru"], false)).toEqual([0, 1]);
    expect(rowDisplayOrder(["en", "ru", "ro"], true)).toEqual([1, 2, 0]); // правило → разворот
    expect(rowDisplayOrder(["en"], true)).toEqual([0]);
    expect(rowDisplayOrder([], true)).toEqual([]);
  });

  // duopulse-203: правило хозяина — иностранный язык (не ru/uk) всегда
  // верхней строкой: русский/украинский клип = перевод сверху, оригинал низ.
  it("rowDisplayOrder: ru/uk-строки уходят вниз, иностранные — вверх (duopulse-203)", () => {
    // Русский клип: оригинал ru + перевод en → en сверху, ru снизу.
    expect(rowDisplayOrder(["ru", "en"], false)).toEqual([1, 0]);
    // Украинский клип: оригинал uk + перевод ru → оба ru/uk — порядок движка.
    expect(rowDisplayOrder(["uk", "ru"], false)).toEqual([0, 1]);
    // Иностранный клип: оригинал en + перевод ru — прежний порядок (en сверху).
    expect(rowDisplayOrder(["en", "ru"], false)).toEqual([0, 1]);
    // Подтеги («ru-RU») и регистр не мешают правилу.
    expect(rowDisplayOrder(["ru-RU", "en-US"], false)).toEqual([1, 0]);
    // Три строки: ru-оригинал + en-перевод + ro — ru вниз, en/ro на месте.
    expect(rowDisplayOrder(["ru", "en", "ro"], false)).toEqual([1, 2, 0]);
    // Язык неизвестен (und/файл) — строка не ru/uk, остаётся на месте.
    expect(rowDisplayOrder(["ru", undefined], false)).toEqual([1, 0]);
    // swapRows переворачивает ИТОГОВЫЙ порядок (ручная перестановка поверх правила).
    expect(rowDisplayOrder(["ru", "en"], true)).toEqual([0, 1]);
  });

  it("isRuUaLang: первичный подтег ru/uk, без него — false", () => {
    expect(isRuUaLang("ru")).toBe(true);
    expect(isRuUaLang("uk")).toBe(true);
    expect(isRuUaLang("ru-RU")).toBe(true);
    expect(isRuUaLang("UK")).toBe(true);
    expect(isRuUaLang("en")).toBe(false);
    expect(isRuUaLang("")).toBe(false);
    expect(isRuUaLang(undefined)).toBe(false);
  });
});

// duopulse-200: потолок строки плашки — «субтитры на весь экран» (tlang-окна
// ASR-переводов и лирика: cue по много строк/символов) не рендерятся целиком.
describe("visibleRowText — потолок строки (duopulse-200)", () => {
  it("обычные реплики и двухстрочные диалоги проходят без изменений", () => {
    expect(visibleRowText("Привет")).toBe("Привет");
    expect(visibleRowText("")).toBe("");
    expect(visibleRowText("— Сколько?\n— Пять")).toBe("— Сколько?\n— Пять");
    expect(visibleRowText("а".repeat(240))).toBe("а".repeat(240));
  });

  it("трёхстрочный потолок: показан хвост cue с меткой «…»", () => {
    expect(visibleRowText("один\nдва\nтри\nчетыре\nпять")).toBe("…три\nчетыре\nпять");
  });

  it("символьный потолок: хвост до 240 знаков, рез по границе слова, метка «…»", () => {
    const words = Array.from({ length: 60 }, (_, i) => `слово${i}`).join(" ");
    const out = visibleRowText(words);
    expect(out.startsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(241); // «…» + ≤240
    expect(out.slice(1)).toMatch(/^слово\d+ /); // без полуслова в начале
    expect(out).toMatch(/слово59$/); // хвост, а не голова
  });

  it("потолок строк в длинном тексте: последние 3 строки даже после реза символов", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `строка номер ${i} с текстом`).join("\n");
    const out = visibleRowText(lines);
    expect(out.startsWith("…")).toBe(true);
    expect(out.split("\n").length).toBe(3);
    expect(out).toContain("строка номер 39");
  });

  it("CRLF нормализуется до LF (cue Windows-вида)", () => {
    expect(visibleRowText("раз\r\nдва\r\nтри\r\nчетыре")).toBe("…два\nтри\nчетыре");
  });
});
