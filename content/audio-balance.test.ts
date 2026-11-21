// DuoPulse — тесты поканального баланса 5.1/7.1 (duopulse-204): чистые
// функции матрицы/нормализации/безопасности src из content/audio-balance.ts.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUDIO_CONFIG,
  DEFAULT_AUDIO_GAINS,
  UPMIX_BASE,
  edgeNeedsLowpass,
  gainMultipliers,
  matrixEdges,
  normalizeAudioConfig,
  normalizeGains,
  readAudioDefaults,
  safeSrcForHook,
} from "./audio-balance";

const g = (patch: Partial<typeof DEFAULT_AUDIO_GAINS>) => ({ ...DEFAULT_AUDIO_GAINS, ...patch });

describe("normalizeGains", () => {
  it("мусор и пропуски — дефолт 100, значения клампятся 0–200", () => {
    expect(normalizeGains(undefined)).toEqual(DEFAULT_AUDIO_GAINS);
    expect(normalizeGains({ frontLeft: 150 })).toEqual(g({ frontLeft: 150 }));
    expect(normalizeGains({ frontLeft: 400, backRight: -5 })).toEqual(g({ frontLeft: 200, backRight: 0 }));
    expect(normalizeGains({ frontLeft: "louder", center: null })).toEqual(DEFAULT_AUDIO_GAINS);
  });
});

describe("normalizeAudioConfig / readAudioDefaults", () => {
  it("дефолт выключен и нейтрален (бит-точный путь звука)", () => {
    expect(DEFAULT_AUDIO_CONFIG.applyToPlayback).toBe(false);
    expect(normalizeAudioConfig(undefined)).toEqual(DEFAULT_AUDIO_CONFIG);
    expect(normalizeAudioConfig({ applyToPlayback: "yes" }).applyToPlayback).toBe(false);
  });
  it("читает window.__DUOPULSE_DEFAULTS__.audio снисходительно", () => {
    const cfg = readAudioDefaults({ __DUOPULSE_DEFAULTS__: { audio: { applyToPlayback: true, gains: { lfe: 40 } } } });
    expect(cfg.applyToPlayback).toBe(true);
    expect(cfg.gains.lfe).toBe(40);
    expect(cfg.gains.frontRight).toBe(100);
    expect(readAudioDefaults({}).applyToPlayback).toBe(false);
  });
});

describe("matrixEdges", () => {
  it("выключено — бит-точный passthrough (стерео — фронты, 5.1 — диагональ)", () => {
    expect(matrixEdges(2, DEFAULT_AUDIO_GAINS, false, 6)).toEqual([
      { from: 0, to: 0, gain: 1 },
      { from: 1, to: 1, gain: 1 },
    ]);
    expect(matrixEdges(6, DEFAULT_AUDIO_GAINS, false, 6)).toEqual(
      [0, 1, 2, 3, 4, 5].map((i) => ({ from: i, to: i, gain: 1 })),
    );
  });

  it("стерео → 5.1: фронты 1:1, центр/саб суммой по два ребра, тыл от своего фронта", () => {
    const edges = matrixEdges(2, DEFAULT_AUDIO_GAINS, true, 6);
    expect(edges.filter((e) => e.to === 0)).toEqual([{ from: 0, to: 0, gain: 1 }]);
    expect(edges.filter((e) => e.to === 1)).toEqual([{ from: 1, to: 1, gain: 1 }]);
    const c = edges.filter((e) => e.to === 2);
    expect(c).toHaveLength(2);
    expect(c[0].gain).toBeCloseTo(0.5 * UPMIX_BASE[2], 10);
    const lfe = edges.filter((e) => e.to === 3);
    expect(lfe).toHaveLength(2);
    expect(lfe[0].gain).toBeCloseTo(0.5 * UPMIX_BASE[3], 10);
    expect(edges).toContainEqual({ from: 0, to: 4, gain: UPMIX_BASE[4] });
    expect(edges).toContainEqual({ from: 1, to: 5, gain: UPMIX_BASE[5] });
    expect(edges.find((e) => e.to > 5)).toBeUndefined();
  });

  it("усиление пользователя умножает свою колонку", () => {
    const edges = matrixEdges(2, g({ frontLeft: 200, sideRight: 50 }), true, 6);
    expect(edges.find((e) => e.to === 0)?.gain).toBe(2);
    expect(edges.find((e) => e.to === 5)?.gain).toBeCloseTo(0.35 * 0.5, 10);
  });

  it("стерео-устройство (out 2) — только фронты: даунмикс не подмешает тыл", () => {
    const edges = matrixEdges(2, DEFAULT_AUDIO_GAINS, true, 2);
    expect(edges.map((e) => e.to)).toEqual([0, 1]);
  });

  it("родная 5.1 дорожка — поканальное усиление без апмикса", () => {
    const edges = matrixEdges(6, g({ center: 150, lfe: 0 }), true, 6);
    expect(edges).toHaveLength(6);
    expect(edges[2]).toEqual({ from: 2, to: 2, gain: 1.5 });
    expect(edges[3]).toEqual({ from: 3, to: 3, gain: 0 });
    expect(edges.find((e) => e.from !== e.to)).toBeUndefined();
  });

  it("7.1: задняя пара на индексах 6/7 от своего фронта", () => {
    const edges = matrixEdges(2, DEFAULT_AUDIO_GAINS, true, 8);
    expect(edges).toContainEqual({ from: 0, to: 6, gain: UPMIX_BASE[6] });
    expect(edges).toContainEqual({ from: 1, to: 7, gain: UPMIX_BASE[7] });
  });
});

describe("edgeNeedsLowpass", () => {
  it("синтезированный из стерео саб — через lowpass, родная дорожка — как есть", () => {
    expect(edgeNeedsLowpass(2, { from: 0, to: 3, gain: 0.4 })).toBe(true);
    expect(edgeNeedsLowpass(6, { from: 3, to: 3, gain: 1 })).toBe(false);
    expect(edgeNeedsLowpass(2, { from: 0, to: 0, gain: 1 })).toBe(false);
  });
});

describe("gainMultipliers", () => {
  it("порядок SPEAKER_LAYOUT, проценты → множители", () => {
    expect(gainMultipliers(g({ frontLeft: 0, backRight: 200 }))).toEqual([0, 1, 1, 1, 1, 1, 1, 2]);
  });
});

describe("safeSrcForHook", () => {
  const origin = "https://www.youtube.com";
  it("blob/data (MSE YouTube) и same-origin — можно, кросс-домен — нет", () => {
    expect(safeSrcForHook({ currentSrc: "blob:https://www.youtube.com/123" }, origin)).toBe(true);
    expect(safeSrcForHook({ currentSrc: "data:audio/wav;base64,…" }, origin)).toBe(true);
    expect(safeSrcForHook({ currentSrc: "https://www.youtube.com/file.mp4" }, origin)).toBe(true);
    expect(safeSrcForHook({ src: "/relative/file.mp4" }, origin)).toBe(true);
    expect(safeSrcForHook({ currentSrc: "https://cdn.other.com/file.mp4" }, origin)).toBe(false);
    expect(safeSrcForHook({ currentSrc: "" }, origin)).toBe(false);
  });
  it("явный crossOrigin — страница обещала CORS, кросс-домен разрешён", () => {
    expect(safeSrcForHook({ currentSrc: "https://cdn.other.com/f.mp4", crossOrigin: "anonymous" }, origin)).toBe(true);
  });
});
