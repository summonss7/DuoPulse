// Тесты пресетов вида плашки (карточка duopulse-059): состав пресетов,
// сопоставление текущего стиля с пресетом (подсветка чипа в панели).
import { describe, expect, it } from "vitest";
import { LOOK_PRESETS, matchLookPreset, type LookSource } from "./look-presets";

const styleOf = (patch: Partial<LookSource>): LookSource => ({
  originalColor: "#ffffff",
  translationColor: "#bdfe4f",
  mutedColor: "#ffffff",
  plateColor: "#0a0e17",
  textStroke: true,
  plateOpacity: 0.78,
  ...patch,
});

describe("LOOK_PRESETS — пресеты вида (карточка 059)", () => {
  it("три пресета с разными id: фирменный / ч-б контраст / жёлтый TV", () => {
    expect(LOOK_PRESETS.map((p) => p.id)).toEqual(["brand", "mono", "tv"]);
    expect(LOOK_PRESETS.map((p) => p.label)).toEqual(["Фирменный", "Ч/б контраст", "Жёлтый TV"]);
  });

  it("все пресеты читаемы: обводка включена, подложка непрозрачнее 0,7", () => {
    for (const p of LOOK_PRESETS) {
      expect(p.patch.textStroke, p.id).toBe(true);
      expect(p.patch.plateOpacity, p.id).toBeGreaterThanOrEqual(0.7);
    }
  });

  it("цвета — канонический #rrggbb (формат input[type=color])", () => {
    for (const p of LOOK_PRESETS) {
      for (const c of [p.patch.originalColor, p.patch.translationColor, p.patch.mutedColor, p.patch.plateColor]) {
        expect(c).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });
});

describe("matchLookPreset — активный пресет по текущему стилю", () => {
  it("дефолтный вид — «фирменный»", () => {
    expect(matchLookPreset(styleOf({}))?.id).toBe("brand");
  });

  it("каждый пресет матчится своим патчем", () => {
    for (const p of LOOK_PRESETS) {
      expect(matchLookPreset(styleOf(p.patch))?.id, p.id).toBe(p.id);
    }
  });

  it("ручной цвет/обводка/прозрачность — свой вид (null)", () => {
    expect(matchLookPreset(styleOf({ originalColor: "#00ffaa" }))).toBeNull();
    expect(matchLookPreset(styleOf({ textStroke: false }))).toBeNull();
    expect(matchLookPreset(styleOf({ plateOpacity: 0.5 }))).toBeNull();
  });

  it("регистр hex — как приходит из панели (input.color всегда lowercase)", () => {
    expect(matchLookPreset(styleOf({ originalColor: "#FFFFFF" }))).toBeNull();
  });
});
