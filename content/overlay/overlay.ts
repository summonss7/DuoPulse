// Оверлей субтитров (задача 3.4, docs/03 §5; фирменный вид — гайд 06 §6).
// DOM-слой поверх видео: pointer-events:none, z-index выше контролов плеера,
// строки набора — по строке на дорожку (1–3 в v1), порядок = порядок дорожек.
//
// Без миганий при коротких cue: контейнер и плашка создаются один раз и
// переиспользуются — смена cue обновляет текст строк на месте (без
// пересоздания контейнера fade не перезапускается); fade 80 мс — только на
// появление/исчезание плашки (docs/03 §5). Текст только через textContent.
//
// Размер колесом мыши (docs/03 §5, §8): колесо над плашкой — кегль ±10%
// (75–300%, общий для всех строк), Shift+колесо — сдвиг синхронизации
// (колбэк в движок). Плашка не перехватывает события мыши (pointer-events:
// none): попадание колесом считается геометрически, клики по плееру проходят.
//
// Авто-уменьшение кегля при переполнении (карточка 046, M5): плашка сверх
// PLATE_MAX_SHARE высоты видео (docs/03 §5) — кегль плавно уменьшается под
// потолок итерациями с замером (fit), не ниже 75%; ручное колесо работает
// поверх — его масштаб база, авто только ограничивает долей видео.

import type { ActiveRow } from "../engine/subtitles-engine";
import {
  DEFAULT_SUBTITLE_STYLE,
  MARGIN_MAX_PCT,
  PLATE_MAX_SHARE,
  fitStepPct,
  plateBackground,
  plateFontSizeCss,
  rowStyleFor,
  stepScale,
  mergeStyle,
  type SubtitleStyle,
} from "./style";

const OVERLAY_ATTR = "data-duopulse-subtitles";
/** Тёмная обводка строк для читаемости на светлом видео (гайд 06 §6: 2px). */
const TEXT_STROKE = "2px rgba(5,8,12,0.85)";

export interface SubtitlesOverlayOptions {
  /** Shift+колесо над плашкой: шаг сдвига синхронизации (±1) в движок. */
  onOffsetStep?: (direction: number) => void;
  /** Стиль изменился (колесо-размер, панель настроек 3.7) — итоговый стиль
   * наружу (set-state в Core: панель показывает актуальные значения). */
  onStyleChange?: (style: SubtitleStyle) => void;
}

export class SubtitlesOverlay {
  private readonly opts: SubtitlesOverlayOptions;
  private container: HTMLDivElement | null = null;
  private plate: HTMLDivElement | null = null;
  private rowsEl: HTMLDivElement | null = null;
  private video: HTMLVideoElement | null = null;
  private style: SubtitleStyle = { ...DEFAULT_SUBTITLE_STYLE };
  /** Строки последнего рендера: дифф-обновление текста на месте. */
  private rows: ActiveRow[] = [];
  /** Эффективный кегль: ручной масштаб, при переполнении авто-уменьшенный
   * под потолок доли видео (карточка 046); всегда ≤ style.fontScalePct.
   * В styleInfo наружу отдаётся только ручной — авто-подгон преходящ,
   * от cue к cue, и не персистится. */
  private autoPct = DEFAULT_SUBTITLE_STYLE.fontScalePct;
  /** Пересчитать авто-подгон: строки/стиль изменились (геометрия видео —
   * в fit по факту); репозиция без изменений не дёргает layout. */
  private fitDirty = true;
  private lastFitW = 0;
  private lastFitH = 0;
  private wheelBound = false;
  private repositionBound = false;
  private resizeObserver: ResizeObserver | null = null;

  constructor(opts: SubtitlesOverlayOptions = {}) {
    this.opts = opts;
  }

  /** Показать набор строк поверх видео (или обновить, если уже показан). */
  show(rows: ActiveRow[], video: HTMLVideoElement): void {
    if (rows.length === 0) {
      this.hide();
      return;
    }
    this.ensureDom();
    if (!this.container || !this.rowsEl) return;
    this.observeVideo(video);
    // Перерисовка только при смене набора строк — движок зовёт show/hide по
    // смене активного cue, не на каждый кадр (docs/03 §5 «экономия»).
    this.renderRows(rows);
    this.positionOver(video);
    this.container.style.opacity = "1";
  }

  hide(): void {
    if (this.container) this.container.style.opacity = "0";
  }

  get visible(): boolean {
    return this.container !== null && this.container.style.opacity === "1";
  }

  /** Текущие настройки отображения (диагностика стендов, панель — 3.7). */
  styleInfo(): SubtitleStyle {
    return { ...this.style };
  }

  /** Изменить настройки отображения (клампы — mergeStyle); применяется к
   * уже созданной плашке немедленно. */
  setStyle(patch: Partial<SubtitleStyle>): void {
    this.style = mergeStyle(this.style, patch);
    // Ручной масштаб — база авто-подгона: стартуем с него, fit при показе
    // уменьшит под потолок (колесо/панель работают поверх, карточка 046).
    this.autoPct = this.style.fontScalePct;
    this.fitDirty = true;
    if (this.plate) this.applyPlateStyle();
    if (this.container && this.video && this.visible) this.positionOver(this.video);
    this.opts.onStyleChange?.(this.styleInfo());
  }

  /** Дифф-обновление строк: при том же составе дорожек (порядок = положение)
   * обновляется только текст — элементы строк живут, пока набор не сменился;
   * контейнер не пересоздаётся никогда (без миганий, docs/03 §5). */
  private renderRows(rows: ActiveRow[]): void {
    if (!this.rowsEl) return;
    const sameShape =
      rows.length === this.rows.length && rows.every((r, i) => r.trackId === this.rows[i].trackId);
    if (sameShape) {
      rows.forEach((row, i) => {
        const el = this.rowsEl?.children[i] as HTMLElement | undefined;
        if (el && el.textContent !== row.text) el.textContent = row.text;
      });
    } else {
      this.rowsEl.replaceChildren(
        ...rows.map((row, i) => {
          const el = document.createElement("div");
          el.className = "duopulse-subtitles-row";
          el.dataset.trackId = row.trackId;
          el.textContent = row.text;
          const rs = rowStyleFor(i);
          const s = el.style;
          s.color = rs.color;
          s.fontSize = `${rs.fontScale}em`; // относительный кегль (docs/03 §5)
          s.fontWeight = String(rs.weight);
          s.webkitTextStroke = TEXT_STROKE;
          s.paintOrder = "stroke fill"; // обводка за заливкой — глифы не съедает
          return el;
        }),
      );
    }
    this.rows = rows;
    this.fitDirty = true; // текст сменился — высота могла измениться
  }

  /** Плашка по прямоугольнику видео (fixed): низ/верх по центру, отступ
   * marginPct % высоты видео; максимум 80% ширины видео (гайд 06 §6). */
  private positionOver(video: HTMLVideoElement): void {
    if (!this.container || !this.plate) return;
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
    // Низ/верх — флекс-выравниванием контейнера (top/bottom на flex-элементе
    // не работают), отступ — полем плашки к соответствующему краю.
    const margin = (Math.min(this.style.marginPct, MARGIN_MAX_PCT) / 100) * r.height;
    s.alignItems = this.style.position === "top" ? "flex-start" : "flex-end";
    this.plate.style.marginTop = this.style.position === "top" ? `${margin}px` : "";
    this.plate.style.marginBottom = this.style.position === "bottom" ? `${margin}px` : "";
    this.fit(r.width, r.height);
  }

  /** Авто-уменьшение кегля при переполнении (карточка 046, M5): плашка
   * сверх PLATE_MAX_SHARE высоты видео — кегль уменьшается пропорционально
   * переполнению, итерациями с замером (перенос строк при уменьшении меняет
   * высоту нелинейно), не ниже клампа читаемости 75%. Ручной масштаб — база
   * подгона: колесо/панель задают стартовое значение, авто только ограничивает
   * сверху долей видео. Пересчёт — по смене строк/стиля или геометрии видео. */
  private fit(videoW: number, videoH: number): void {
    if (!this.plate) return;
    if (!this.fitDirty && Math.abs(videoW - this.lastFitW) < 1 && Math.abs(videoH - this.lastFitH) < 1) return;
    this.lastFitW = videoW;
    this.lastFitH = videoH;
    this.fitDirty = false;
    const maxH = videoH * PLATE_MAX_SHARE;
    this.autoPct = this.style.fontScalePct;
    this.applyPlateStyle();
    for (let i = 0; i < 4; i++) {
      const plateH = this.plate.getBoundingClientRect().height;
      const next = fitStepPct(plateH, maxH, this.autoPct);
      if (next >= this.autoPct - 0.05) break; // влезает или достигнут кламп читаемости
      this.autoPct = next;
      this.applyPlateStyle();
    }
  }

  private applyPlateStyle(): void {
    if (!this.plate) return;
    const p = this.plate.style;
    p.fontSize = plateFontSizeCss(this.autoPct);
    p.background = plateBackground(this.style.plateOpacity);
  }

  private ensureDom(): void {
    if (this.container?.isConnected) return;
    const container = document.createElement("div");
    container.setAttribute(OVERLAY_ATTR, "1");
    const s = container.style;
    s.position = "fixed";
    s.pointerEvents = "none";
    s.zIndex = "2147483647"; // выше контролов плеера, ниже панелей DuoPulse (docs/03 §5)
    s.opacity = "0";
    s.transition = "opacity 80ms"; // docs/03 §5: fade 80 мс, без мигания
    s.display = "flex";
    s.alignItems = "flex-end"; // низ по умолчанию; верх — positionOver
    s.justifyContent = "center";
    s.containerType = "size"; // кегль в cqw: плашка масштабируется с плеером
    const plate = document.createElement("div");
    const p = plate.style;
    p.maxWidth = "80%"; // гайд 06 §6
    p.padding = "8px 16px";
    p.borderRadius = "6px"; // гайд 06 §6
    p.backdropFilter = "blur(2px)"; // гайд 06 §6
    p.fontFamily = "Inter, 'Segoe UI', system-ui, sans-serif";
    p.textAlign = "center";
    p.whiteSpace = "pre-wrap"; // многострочные cue
    p.lineHeight = "1.3";
    const rows = document.createElement("div");
    const r = rows.style;
    r.display = "flex";
    r.flexDirection = "column";
    r.gap = "0.22em"; // разделитель строк набора (гайд 06 §6 разделителей не задаёт)
    plate.appendChild(rows);
    container.appendChild(plate);
    document.documentElement.appendChild(container);
    this.container = container;
    this.plate = plate;
    this.rowsEl = rows;
    this.applyPlateStyle();
    this.bindReposition();
    this.bindWheel();
  }

  /** Геометрия плашки следует за видео: ресайз окна, скролл страницы,
   * полноэкранный/театральный режимы (docs/03 §10) — без пересчёта строк. */
  private bindReposition(): void {
    if (this.repositionBound) return;
    this.repositionBound = true;
    const reposition = (): void => {
      if (this.video && this.container?.isConnected) this.positionOver(this.video);
    };
    window.addEventListener("resize", reposition, { passive: true });
    window.addEventListener("scroll", reposition, { passive: true, capture: true });
    document.addEventListener("fullscreenchange", reposition, { passive: true });
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(reposition);
    }
  }

  /** Колесо над плашкой: размер (Shift — сдвиг, docs/03 §8). Плашка
   * pointer-events:none, поэтому попадание считается по её прямоугольнику;
   * событие гасится, чтобы страница под плашкой не скроллилась. */
  private bindWheel(): void {
    if (this.wheelBound) return;
    this.wheelBound = true;
    window.addEventListener(
      "wheel",
      (e) => {
        if (!this.plate || !this.visible || this.rows.length === 0) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return; // зум браузера не трогаем
        const r = this.plate.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const direction = e.deltaY < 0 ? 1 : -1;
        if (e.shiftKey) this.opts.onOffsetStep?.(direction);
        else this.setStyle({ fontScalePct: stepScale(this.style.fontScalePct, direction) });
      },
      { capture: true, passive: false },
    );
  }

  /** Отслеживание CSS-бокса видео (fullscreen/театр/миниплеер) — после
   * первого показа; наблюдатель переживает смены видео без подписок. */
  observeVideo(video: HTMLVideoElement): void {
    if (this.resizeObserver && this.video === video) return;
    this.video = video;
    this.resizeObserver?.disconnect();
    this.resizeObserver?.observe(video);
  }
}
