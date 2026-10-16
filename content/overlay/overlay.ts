// Оверлей субтитров — каркас задачи 3.2 (docs/03 §5): DOM-слой поверх видео,
// pointer-events:none, строки набора (по строке на дорожку). Полная плашка —
// фирменные стили, позиция/отступ, колесо-размер, полноэкранная компоновка —
// задача 3.4; здесь достаточно рендера, чтобы двигок показывал cue точно по
// времени. Текст только через textContent (инъекций в страницу нет).

import type { ActiveRow } from "../engine/subtitles-engine";

const OVERLAY_ATTR = "data-duopulse-subtitles";

export class SubtitlesOverlay {
  private container: HTMLDivElement | null = null;
  private rowsEl: HTMLDivElement | null = null;

  /** Показать набор строк поверх видео (или обновить, если уже показан). */
  show(rows: ActiveRow[], video: HTMLVideoElement): void {
    if (rows.length === 0) {
      this.hide();
      return;
    }
    this.ensureDom();
    if (!this.container || !this.rowsEl) return;
    // Перерисовка только при смене набора строк — движок зовёт show/hide по
    // смене активного cue, не на каждый кадр (docs/03 §5 «экономия»).
    const nextSignature = rows.map((r) => `${r.trackId}\u0000${r.text}`).join("\u0001");
    if (this.container.dataset.signature !== nextSignature) {
      this.container.dataset.signature = nextSignature;
      this.rowsEl.replaceChildren(
        ...rows.map((row, i) => {
          const el = document.createElement("div");
          el.className = "duopulse-subtitles-row";
          el.textContent = row.text;
          // Относительные размеры строк набора (docs/03 §5; полный стиль — 3.4):
          // первая — белый 100%, вторая — фирменный лайм ~85%, далее приглушённые.
          if (i === 1) el.style.color = "#BDFE4F";
          else if (i >= 2) el.style.color = "rgba(255,255,255,0.75)";
          return el;
        }),
      );
    }
    this.positionOver(video);
    this.container.style.opacity = "1";
  }

  hide(): void {
    if (this.container) this.container.style.opacity = "0";
  }

  get visible(): boolean {
    return this.container !== null && this.container.style.opacity === "1";
  }

  /** Каркас 3.2: плашка привязана к прямоугольнику видео в окне (fixed);
   * полный позиционный блок с настройками — задача 3.4. */
  private positionOver(video: HTMLVideoElement): void {
    if (!this.container) return;
    const r = video.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) {
      this.hide();
      return;
    }
    const s = this.container.style;
    s.left = `${r.left}px`;
    s.top = `${r.top}px`;
    s.width = `${r.width}px`;
    s.height = `${r.height}px`;
  }

  private ensureDom(): void {
    if (this.container?.isConnected) return;
    const container = document.createElement("div");
    container.setAttribute(OVERLAY_ATTR, "1");
    const s = container.style;
    s.position = "fixed";
    s.pointerEvents = "none";
    s.zIndex = "2147483647";
    s.opacity = "0";
    s.transition = "opacity 80ms"; // docs/03 §5: fade 80 мс, без мигания
    s.display = "flex";
    s.alignItems = "flex-end";
    s.justifyContent = "center";
    const plate = document.createElement("div");
    const p = plate.style;
    p.marginBottom = "6%"; // низ по центру (docs/03 §5, позиция по умолчанию)
    p.maxWidth = "90%";
    p.padding = "8px 16px";
    p.borderRadius = "8px";
    p.background =
      "linear-gradient(rgba(8,12,10,0.72), rgba(8,12,10,0.72))"; // подложка-затемнение для читаемости
    p.fontFamily = "'Segoe UI', system-ui, sans-serif";
    p.textAlign = "center";
    p.whiteSpace = "pre-wrap"; // многострочные cue
    const rows = document.createElement("div");
    const r = rows.style;
    r.display = "flex";
    r.flexDirection = "column";
    r.gap = "2px";
    // Базовый кегль — от ширины видео (container query units): плашка масштабируется
    // вместе с плеером; слайдер/колесо-размер — задача 3.4.
    container.style.containerType = "size";
    plate.style.fontSize = "clamp(14px, 2.6cqw, 34px)";
    plate.appendChild(rows);
    container.appendChild(plate);
    document.documentElement.appendChild(container);
    this.container = container;
    this.rowsEl = rows;
  }
}
