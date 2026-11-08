// Плашка duo мобильной ветки (этап 2, duopulse-082): строки активных реплик
// ПОВЕРХ embed-iframe (контент страницы кросс-доменный — оверлей в ней
// невозможен, рендерим у себя; источник времени — YtClock). Вид — тот же
// гайд 06 §6, что у десктопа: переиспользуем style.ts (градиент-подложка,
// строки оригинал/перевод, cqw-кегль от контейнера = ширины «видео»).

import type { ActiveRow } from "../../../content/engine/subtitles-engine";
import { defaultDuoSettings, mobilePlateStyle, type DuoMobileSettings } from "./state";
import { cssFontFamily, plateBackground, plateFontSizeCss, rowStyleFor, type SubtitleStyle } from "../../../content/overlay/style";

/** Оверлей над iframe: контейнер-плашка + строки набора. */
export class DuoOverlay {
  readonly root: HTMLDivElement;
  private readonly plate: HTMLDivElement;
  private style: SubtitleStyle = mobilePlateStyle(defaultDuoSettings());
  private lastTexts: string[] = [];

  constructor(container: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "m-duo-overlay";
    this.plate = document.createElement("div");
    this.plate.className = "m-duo-plate";
    this.root.appendChild(this.plate);
    this.root.hidden = true;
    container.appendChild(this.root);
  }

  /** Применить настройки (кегль/позиция; цвета — фиксированные гайдом 06). */
  applySettings(s: DuoMobileSettings): void {
    this.style = mobilePlateStyle(s);
    this.root.dataset.position = this.style.position;
    this.plate.style.background = plateBackground(this.style.plateOpacity, this.style.plateColor);
    this.plate.style.fontSize = plateFontSizeCss(this.style.fontScalePct);
    this.plate.style.fontFamily = cssFontFamily(this.style.fontFamily);
    this.lastTexts = []; // перекраска строк новым стилем
    this.plate.textContent = "";
  }

  /** Строки активного набора ([] — скрыть). */
  setRows(rows: ActiveRow[]): void {
    this.root.hidden = rows.length === 0;
    const texts = rows.map((r) => r.text);
    if (texts.join("\u{1}") === this.lastTexts.join("\u{1}")) return;
    this.lastTexts = texts;
    this.plate.textContent = "";
    texts.forEach((text, i) => {
      const div = document.createElement("div");
      const rowStyle = rowStyleFor(i, this.style);
      div.className = "m-duo-row" + (i > 0 ? " m-duo-row-trans" : "");
      div.textContent = text;
      div.style.color = rowStyle.color;
      this.plate.appendChild(div);
    });
  }

  remove(): void {
    this.root.remove();
  }
}
