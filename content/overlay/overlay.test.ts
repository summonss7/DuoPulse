// duopulse-200, DOM-уровень потолка строки: гигантский cue (окно ASR
// музыкальной секции живого клипа — 587 знаков / 22 строки, плейн-ветка
// парсера json3 без aAppend склеивает окно целиком) рендерится хвостом
// не длиннее MAX_ROW_LINES строк — плашка не растёт «на весь экран». Геометрия
// видео в happy-dom нулевая (плашка скрыта), но строки уже в DOM — их и
// проверяем; обычные реплики проходят без изменений.
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import type { ActiveRow } from "../engine/subtitles-engine";
import { SubtitlesOverlay } from "./overlay";
import { MAX_ROW_LINES } from "./style";

const row = (text: string, top = false): ActiveRow => ({ trackId: "yt:ro:asr", text, top });

beforeEach(() => {
  // контейнер плашки живёт в общем документе файла — чистим между тестами
  document.querySelectorAll("[data-duopulse-subtitles]").forEach((n) => n.remove());
});

describe("SubtitlesOverlay.renderRows — потолок строки (duopulse-200)", () => {
  it("гигантский cue рендерится хвостом ≤ MAX_ROW_LINES строк с меткой «…»", () => {
    const overlay = new SubtitlesOverlay();
    const giant = Array.from({ length: 22 }, (_, i) => `строка ${i}`).join("\n");
    overlay.show([row(giant)], document.createElement("video"));
    const el = document.querySelector<HTMLElement>("[data-duopulse-subtitles] .duopulse-subtitles-row");
    expect(el).not.toBeNull();
    const shown = el!.textContent ?? "";
    expect(shown.startsWith("…")).toBe(true);
    expect(shown.split("\n").length).toBe(MAX_ROW_LINES);
    expect(shown).toContain("строка 21"); // хвост — живая реплика, а не голова окна
  });

  it("плашка-верх (duopulse-178) подчиняется тому же потолку", () => {
    const overlay = new SubtitlesOverlay();
    overlay.show(
      [row("нормальная реплика"), row(`${"длинно ".repeat(80)}\nи ещё\nи ещё`, true)],
      document.createElement("video"),
    );
    const top = document.querySelector<HTMLElement>(
      "[data-duopulse-subtitles] [style*='translateX'] .duopulse-subtitles-row",
    );
    expect(top).not.toBeNull();
    expect((top!.textContent ?? "").startsWith("…")).toBe(true);
    expect((top!.textContent ?? "").split("\n").length).toBeLessThanOrEqual(MAX_ROW_LINES);
  });

  it("обычная реплика и двухстрочный диалог — без обрезки", () => {
    const overlay = new SubtitlesOverlay();
    overlay.show([row("Привет"), row("— Сколько?\n— Пять")], document.createElement("video"));
    const rows = [...document.querySelectorAll<HTMLElement>(".duopulse-subtitles-row")].map(
      (el) => el.textContent,
    );
    expect(rows).toEqual(["Привет", "— Сколько?\n— Пять"]);
  });
});
