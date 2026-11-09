// DuoPulse — транспорт child-webview панелей хрома (карточка duopulse-090).
// Контентные webview вкладок — нативные child-инстансы WebView2, их
// композитор всегда рисует поверх HTML UI-webview (спайк 086), поэтому
// панели хрома с контролами (тумблеры, инпуты, слайдеры) живут в СВОЁМ
// child-webview «chrome-panel» внутри окна main: создаётся ПОСЛЕ вкладок —
// композитор кладёт его поверх (порядок создания, спайк 086), закрывается
// разрушением. Отдельное popup-ОКНО не состоялось (webview не грузит
// страницу — белое полотно без CDP-цели, та же стена, что у спайка).
//
// ВАЖНО (ловушка спайка, подтверждена 090): child-webview НЕЛЬЗЯ ресайзить
// после создания — презентация кадров гаснет (живой DOM, белое полотно).
// Поэтому окно панели создаётся сразу точного размера: хост-разметку меряем
// клоном в UI-webview ДО открытия; если контент меняется позже — панель
// скроллится внутри (CSS panel-режима), размер не трогаем.
//
// Здесь: open/close (Core — chrome_panel.rs), трекинг открытой панели для
// кнопок-тумблеров (событие «chrome-panel-closed») и якорь с замером.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type PanelKind = "main" | "proxy" | "vpn" | "duo" | "suggest";

/** Хост-элемент панели в разметке index.html (панельный режим показывает его). */
export const PANEL_HOST: Record<PanelKind, string> = {
  main: "mainMenu",
  proxy: "proxyMenu",
  vpn: "vpnPanel",
  duo: "duoPanel",
  suggest: "suggest",
};

/** Этот webview — панель? (панельный режим UI-бандла, ?panel=<kind>). */
export function panelKind(): PanelKind | null {
  const v = new URLSearchParams(location.search).get("panel");
  return v === "main" || v === "proxy" || v === "vpn" || v === "duo" || v === "suggest" ? v : null;
}

/** Какая панель сейчас открыта (кнопка-тумблер: повторный клик — закрыть). */
let openKind: PanelKind | null = null;

void listen("chrome-panel-closed", () => {
  openKind = null;
});

export function currentPanel(): PanelKind | null {
  return openKind;
}

/** Открыть панель-webview (x/y/w/h — клиентские логические координаты
 *  UI-webview; Core клампит в окно main). Ресайз после открытия запрещён —
 *  размер должен быть точным сразу (см. комментарий модуля). */
export function openPanel(kind: PanelKind, x: number, y: number, w: number, h: number): void {
  openKind = kind;
  void invoke("ui_panel_open", { kind, x, y, w, h }).catch((e) => {
    openKind = null;
    console.error("panel-window:", e);
  });
}

/** Закрыть панель (идемпотентно: панели нет — тихо). */
export function closePanel(): void {
  openKind = null;
  void invoke("ui_panel_close").catch((e) => console.error("panel-window:", e));
}

/** Высота полосы хрома (панели открываются под ней; синхронизирована с
 *  CHROME_HEIGHT Core — var(--chrome-h) в style.css). */
export function chromeHeight(): number {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--chrome-h"));
  return Number.isFinite(v) && v > 0 ? v : 84;
}

/** Замер скрытой панели клоном (visibility:hidden вне экрана): ширина — из
 *  CSS хоста, высота — текущий контент разметки; панель дорисует данные уже
 *  в своём окне (нехватка высоты — внутренний скролл, не ресайз). */
function measureHost(kind: PanelKind): { w: number; h: number } {
  const host = document.getElementById(PANEL_HOST[kind]);
  if (!host) return { w: 320, h: 400 };
  const clone = host.cloneNode(true) as HTMLElement;
  clone.hidden = false;
  // left+right из CSS растянули бы клон на окно (main-menu: right:8px) —
  // правый якорь снимаем, ширину считает shrink-to-fit от контента
  clone.style.cssText =
    "position:fixed;left:-9999px;top:0;right:auto;visibility:hidden;pointer-events:none;";
  document.body.append(clone);
  const r = clone.getBoundingClientRect();
  clone.remove();
  const w = Math.ceil(r.width) || 320;
  const h = Math.ceil(r.height) || 400;
  return { w, h };
}

/** Геометрия панельного окна у якоря: под полосой хрома, выравнивание левым
 *  (duo/suggest) или правым (main/proxy/vpn — как в разметке) краем кнопки.
 *  suggest — шириной с адресную строку, высота от числа строк (передаётся). */
export function anchorPanel(
  kind: PanelKind,
  el: HTMLElement,
  align: "left" | "right" = "right",
  suggestH?: number,
): { x: number; y: number; w: number; h: number } {
  const y = Math.round(chromeHeight());
  if (kind === "suggest") {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y, w: Math.round(r.width), h: suggestH ?? 100 };
  }
  const { w, h } = measureHost(kind);
  const r = el.getBoundingClientRect();
  const x = align === "right" ? r.right - w : r.left;
  return { x: Math.round(x), y, w, h };
}
