// Тесты чистых функций просмотрщика PDF (карточка duopulse-119): сборка
// байтов из base64-кусков (мобильный канал mobile_pdf_chunk), листание и
// зум с границами. DOM-часть (createMobilePdf) — живой прогон на Android.
import { describe, expect, it } from "vitest";

import {
  ZOOM_MAX,
  ZOOM_MIN,
  assembleBytes,
  clampZoom,
  turnPage,
} from "./pdf";

describe("assembleBytes", () => {
  it("склеивает куски в исходные байты", () => {
    // "DuoPulse" в трёх кусках base64 (с padding у последнего)
    const bytes = new TextEncoder().encode("DuoPulse PDF");
    const b64 = btoa(String.fromCharCode(...bytes));
    const mid = Math.floor(b64.length / 2);
    const out = assembleBytes([b64.slice(0, mid), b64.slice(mid)]);
    expect(new TextDecoder().decode(out)).toBe("DuoPulse PDF");
  });

  it("пустой список — пустой документ", () => {
    expect(assembleBytes([]).length).toBe(0);
  });
});

describe("turnPage", () => {
  it("ходит в границах и не выходит за края", () => {
    expect(turnPage(1, 5, -1)).toBe(1);
    expect(turnPage(5, 5, 1)).toBe(5);
    expect(turnPage(2, 5, 1)).toBe(3);
    expect(turnPage(4, 5, -3)).toBe(1);
    expect(turnPage(1, 1, 1)).toBe(1);
  });
});

describe("clampZoom", () => {
  it("держит зум в [ZOOM_MIN, ZOOM_MAX]", () => {
    expect(clampZoom(0)).toBe(ZOOM_MIN);
    expect(clampZoom(99)).toBe(ZOOM_MAX);
    expect(clampZoom(1.25)).toBe(1.25);
  });
});
