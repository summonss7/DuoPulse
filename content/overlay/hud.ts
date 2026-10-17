// HUD синхронизации субтитров (задача 3.5, docs/03 §4 п.3, §8): индикация
// сдвига «раньше/позже» + слайдер. Появляется при любом изменении offset —
// Shift+колесо по плашке, горячие клавиши Alt+[ / Alt+], команда Core
// subtitles.set_offset — и висит, пока пользователь с ним взаимодействует
// (автоскрытие через ~2,4 с простоя). Стиль — гайд 06 §6 (тёмная плашка,
// скругление 6, blur 2, фирменный лайм #BDFE4F как акцент).
//
// Единственный элемент content-слоя с pointer-events:auto — он мал и лежит
// поверх пустой части плеера; клики по видео мимо HUD проходят как раньше.

import { OFFSET_LIMIT_MS } from "../engine/subtitles-engine";

/** Шаг сдвига, мс (docs/03 §4 п.3: шаг 100 мс — колесо, клавиши, слайдер). */
export const OFFSET_STEP_MS = 100;
/** Автоскрытие HUD после последнего изменения/взаимодействия, мс. */
export const OFFSET_HUD_AUTO_HIDE_MS = 2400;

/** Индикация сдвига: «+0,3 с» / «−1,2 с» / «0 с» (одна десятая секунды). */
export function formatOffsetMs(offsetMs: number): string {
  const s = offsetMs / 1000;
  if (s === 0) return "0 с";
  return (s > 0 ? "+" : "−") + Math.abs(s).toFixed(1).replace(".", ",") + " с";
}

/** Шаг сдвига колесом/клавишей с клампом в ±10 с (docs/03 §4). */
export function stepOffset(currentMs: number, direction: number): number {
  const next = currentMs + (direction > 0 ? OFFSET_STEP_MS : -OFFSET_STEP_MS);
  return Math.max(-OFFSET_LIMIT_MS, Math.min(OFFSET_LIMIT_MS, next));
}

export interface OffsetHudOptions {
  /** Пользователь задал сдвиг слайдером/кнопкой (абсолютное значение, мс). */
  onSet(offsetMs: number): void;
}

export class OffsetHud {
  private readonly opts: OffsetHudOptions;
  private root: HTMLDivElement | null = null;
  private value: HTMLSpanElement | null = null;
  private slider: HTMLInputElement | null = null;
  private hideTimer: number | null = null;
  /** Геометрия последнего показа — обновления слайдера остаются на месте. */
  private video: HTMLVideoElement | null = null;
  private side: "top" | "bottom" = "bottom";
  private currentMs = 0;

  constructor(opts: OffsetHudOptions) {
    this.opts = opts;
  }

  get visible(): boolean {
    return this.root !== null && this.root.style.opacity === "1";
  }

  /** Текущее значение (диагностика стендов). */
  offsetMs(): number {
    return this.currentMs;
  }

  /** Показать/обновить HUD над видео: значение + позиция слайдера. side —
   * свободный край видео (противоположный плашке субтитров). */
  show(offsetMs: number, video: HTMLVideoElement, side: "top" | "bottom"): void {
    this.currentMs = offsetMs;
    this.video = video;
    this.side = side;
    this.ensureDom();
    if (!this.root || !this.value || !this.slider) return;
    const r = video.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      const s = this.root.style;
      s.left = `${r.left + r.width / 2}px`;
      s.top = side === "top" ? `${r.top + r.height * 0.06}px` : "";
      s.bottom = side === "bottom" ? `${Math.max(0, window.innerHeight - r.bottom + r.height * 0.06)}px` : "";
    }
    const label = formatOffsetMs(offsetMs);
    if (this.value.textContent !== label) this.value.textContent = label;
    if (this.slider.value !== String(offsetMs)) this.slider.value = String(offsetMs);
    this.root.style.opacity = "1";
    this.scheduleHide();
  }

  hide(): void {
    if (this.hideTimer !== null) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    if (this.root) this.root.style.opacity = "0";
  }

  private scheduleHide(): void {
    if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      this.hideTimer = null;
      if (this.root) this.root.style.opacity = "0";
    }, OFFSET_HUD_AUTO_HIDE_MS);
  }

  private ensureDom(): void {
    if (this.root?.isConnected) return;
    const root = document.createElement("div");
    root.setAttribute("data-duopulse-offset-hud", "1");
    const s = root.style;
    s.position = "fixed";
    s.left = "50%";
    s.transform = "translateX(-50%)";
    s.zIndex = "2147483647";
    s.display = "flex";
    s.alignItems = "center";
    s.gap = "10px";
    s.padding = "8px 14px";
    s.borderRadius = "6px"; // гайд 06 §6
    s.background = "rgba(10,14,23,0.92)";
    s.backdropFilter = "blur(2px)"; // гайд 06 §6
    s.color = "#E8EDF2";
    s.fontFamily = "Inter, 'Segoe UI', system-ui, sans-serif";
    s.fontSize = "13px";
    s.pointerEvents = "auto"; // единственный кликабельный элемент слоя
    s.opacity = "0";
    s.transition = "opacity 120ms";
    s.userSelect = "none";

    const caption = document.createElement("span");
    caption.textContent = "Сдвиг субтитров";
    const value = document.createElement("span");
    value.style.color = "#BDFE4F"; // фирменный лайм — гайд 06
    value.style.fontWeight = "500";
    value.style.minWidth = "5ch";
    value.style.textAlign = "center";

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = String(-OFFSET_LIMIT_MS);
    slider.max = String(OFFSET_LIMIT_MS);
    slider.step = String(OFFSET_STEP_MS);
    slider.value = "0";
    slider.style.accentColor = "#BDFE4F";
    slider.style.width = "180px";
    slider.setAttribute("aria-label", "Сдвиг субтитров, мс");

    const reset = document.createElement("button");
    reset.textContent = "Сброс";
    const rb = reset.style;
    rb.border = "none";
    rb.borderRadius = "4px";
    rb.background = "rgba(189,254,79,0.14)";
    rb.color = "#BDFE4F";
    rb.padding = "3px 10px";
    rb.fontFamily = "inherit";
    rb.fontSize = "12px";
    rb.cursor = "pointer";

    root.append(caption, value, slider, reset);
    document.documentElement.appendChild(root);

    // Ввод уходит в движок через onSet; взаимодействие держит HUD открытым.
    slider.addEventListener("input", () => {
      this.currentMs = Number(slider.value);
      this.refresh();
      this.opts.onSet(this.currentMs);
    });
    reset.addEventListener("click", () => {
      this.currentMs = 0;
      this.refresh();
      this.opts.onSet(0);
    });
    root.addEventListener("pointerenter", () => {
      if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
    });
    root.addEventListener("focusin", () => {
      if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
    });
    root.addEventListener("pointerleave", () => this.scheduleHide());
    root.addEventListener("focusout", () => this.scheduleHide());

    this.root = root;
    this.value = value;
    this.slider = slider;
  }

  /** Обновить без перепозиционирования (ввод из самого HUD). */
  private refresh(): void {
    if (!this.value || !this.slider) return;
    const label = formatOffsetMs(this.currentMs);
    if (this.value.textContent !== label) this.value.textContent = label;
    if (this.slider.value !== String(this.currentMs)) this.slider.value = String(this.currentMs);
    this.scheduleHide();
  }
}
