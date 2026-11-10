// Перевод выделенного текста (карточка duopulse-098). Пункт «Перевести
// выделение» — нативный в контекстном меню страницы (Core, src-tauri/src/
// translate_menu.rs, WebView2 ContextMenuRequested); этот модуль — бабл
// перевода у выделения: Core шлёт WebMessage «translate-selection-begin»
// («Переводим…»), затем «translate-selection-result» (перевод / ошибка).
// Смена языка в селекте баббла — WebMessage «translate-selection» обратно в
// Core (gtx-конвейер тот же), выбранный язык запоминается в Core и ведёт
// подпись пункта меню («Перевести выделение (на ru)»).
//
// Стиль — гайд 06 §6 (тёмная плашка, скругление, фирменный лайм #BDFE4F);
// DOM — только CSSOM (element.style), сетевые/шрифтовых запросов нет —
// CSP любой страницы не нарушаем (паттерн overlay/hud.ts). Вне WebView2
// канал Core отсутствует (content/messaging) — модуль пассивен.

import { onCoreMessage } from "./messaging";

/** Языки селекта баббла; зеркалит LAST_TARGET-совместимые коды gtx —
 * список пункта меню/подписи держит Core (translate_menu.rs). */
export const SELECTION_LANGS: readonly { code: string; name: string }[] = [
  { code: "ru", name: "Русский" },
  { code: "en", name: "English" },
  { code: "uk", name: "Українська" },
  { code: "de", name: "Deutsch" },
  { code: "fr", name: "Français" },
  { code: "es", name: "Español" },
  { code: "it", name: "Italiano" },
  { code: "pt", name: "Português" },
  { code: "pl", name: "Polski" },
  { code: "tr", name: "Türkçe" },
  { code: "ro", name: "Română" },
  { code: "kk", name: "Қазақша" },
  { code: "ar", name: "العربية" },
  { code: "ja", name: "日本語" },
  { code: "zh", name: "中文" },
];

/** Отступ баббла от краёв вьюпорта и от якоря, px. */
const BUBBLE_MARGIN = 8;

/** Точка якоря баббла (клиентские координаты). */
export interface AnchorPoint {
  x: number;
  y: number;
}

/** Диагностика стендов (window.__duopulseContent.translateSelection). */
export interface SelectionTranslateStatus {
  visible: boolean;
  /** Текущий язык перевода баббла (код; "" — закрыт). */
  target: string;
  /** Последняя ошибка конвейера ("" — не было). */
  lastError: string;
  /** Ждём результат («Переводим…»). */
  pending: boolean;
}

/** Порты для юнит-тестов (jsdom/Node без window.chrome.webview). */
export interface SelectionTranslatePorts {
  post(message: Record<string, unknown>): void;
}

/** Язык по коду из SELECTION_LANGS (подписи для проверок/диагностики). */
export function selectionLangName(code: string): string {
  return SELECTION_LANGS.find((l) => l.code === code)?.name ?? code;
}

/**
 * Бабл перевода: DOM без каналов (каналами владеет SelectionTranslate).
 * Один экземпляр на документ; позиция пересчитывается на каждый показ.
 */
export class TranslateBubble {
  private root: HTMLDivElement | null = null;
  private select: HTMLSelectElement | null = null;
  private detected: HTMLSpanElement | null = null;
  private original: HTMLDivElement | null = null;
  private translation: HTMLDivElement | null = null;
  private _visible = false;
  private _target = "";

  constructor(
    private readonly doc: Document,
    private readonly onTargetChange: (code: string) => void,
    private readonly onClose: () => void,
  ) {}

  get visible(): boolean {
    return this._visible;
  }

  get target(): string {
    return this._target;
  }

  /** Показать/перепозиционировать бабл в состоянии «Переводим…». */
  show(anchor: AnchorPoint, target: string): void {
    this.ensureDom();
    const root = this.root;
    if (!root || !this.translation || !this.original || !this.detected) return;
    this._target = target;
    if (this.select && this.select.value !== target) this.select.value = target;
    if (this.select) this.select.disabled = true; // пока нечего перевести
    this.detected.textContent = "";
    this.original.textContent = "";
    this.translation.textContent = "Переводим…";
    this.translation.style.color = "#93A0AE";
    this.position(root, anchor);
    this._visible = true;
  }

  /** Результат конвейера: перевод + эхо оригинала + детект языка. */
  setResult(translation: string, original: string, detected: string, target: string): void {
    this._target = target;
    if (this.select && this.select.value !== target) this.select.value = target;
    if (this.select) this.select.disabled = false; // снова можно менять язык
    if (this.detected) {
      this.detected.textContent = detected && detected !== target ? `${detected} → ${target}` : target;
    }
    if (this.original) this.original.textContent = original;
    if (this.translation) {
      this.translation.textContent = translation;
      this.translation.style.color = "#E8EDF2";
    }
  }

  /** Ошибка конвейера (сеть/лимит/пустой ответ) — текст в бабле. */
  setError(message: string): void {
    if (this.select) this.select.disabled = false;
    if (this.detected) this.detected.textContent = "";
    if (this.original) this.original.textContent = "";
    if (this.translation) {
      this.translation.textContent = `Не получилось: ${message}`;
      this.translation.style.color = "#FF8A80";
    }
  }

  /** Снова «Переводим…» (смена языка), позиция прежняя. */
  setLoading(): void {
    if (this.select) this.select.disabled = true;
    if (this.detected) this.detected.textContent = "";
    if (this.translation) {
      this.translation.textContent = "Переводим…";
      this.translation.style.color = "#93A0AE";
    }
  }

  close(): void {
    if (this.root) this.root.remove();
    this.root = null;
    this.select = null;
    this.detected = null;
    this.original = null;
    this.translation = null;
    this._visible = false;
    this._target = "";
  }

  /** Клик/тач мимо бабла — закрыть (контроллер слушает на document). */
  isInside(target: EventTarget | null): boolean {
    return this.root !== null && this.root.contains(target as Node | null);
  }

  private position(root: HTMLDivElement, anchor: AnchorPoint): void {
    const vw = this.doc.defaultView?.innerWidth ?? 0;
    const vh = this.doc.defaultView?.innerHeight ?? 0;
    root.style.visibility = "hidden";
    root.style.left = "0px";
    root.style.top = "0px";
    const w = root.offsetWidth || 320;
    const h = root.offsetHeight || 120;
    // по горизонтали — к точке клика, не выезжая за край
    let x = anchor.x - Math.min(48, w / 2);
    x = Math.max(BUBBLE_MARGIN, Math.min(x, vw - w - BUBBLE_MARGIN));
    if (vw > 0 && x + w + BUBBLE_MARGIN > vw) x = Math.max(BUBBLE_MARGIN, vw - w - BUBBLE_MARGIN);
    // по вертикали — под якорем, над — если снизу не влезает
    let y = anchor.y + 14;
    if (vh > 0 && y + h + BUBBLE_MARGIN > vh) y = Math.max(BUBBLE_MARGIN, anchor.y - h - 14);
    root.style.left = `${Math.round(x)}px`;
    root.style.top = `${Math.round(y)}px`;
    root.style.visibility = "visible";
  }

  private ensureDom(): void {
    if (this.root?.isConnected) return;
    const root = this.doc.createElement("div");
    root.setAttribute("data-duopulse-translate", "1");
    const s = root.style;
    s.position = "fixed";
    s.zIndex = "2147483647";
    s.maxWidth = "min(420px, calc(100vw - 16px))";
    s.padding = "10px 12px";
    s.borderRadius = "8px"; // гайд 06 §6
    s.border = "1px solid rgba(189,254,79,0.25)";
    s.background = "rgba(10,14,23,0.96)";
    s.backdropFilter = "blur(4px)";
    s.color = "#E8EDF2";
    s.fontFamily = "Inter, 'Segoe UI', system-ui, sans-serif";
    s.fontSize = "14px";
    s.lineHeight = "1.45";
    s.pointerEvents = "auto";
    s.boxShadow = "0 8px 24px rgba(0,0,0,0.4)";

    // шапка: селект языка · детект → цель · закрыть
    const header = this.doc.createElement("div");
    const hs = header.style;
    hs.display = "flex";
    hs.alignItems = "center";
    hs.gap = "8px";
    hs.marginBottom = "6px";

    const select = this.doc.createElement("select");
    const ss = select.style;
    ss.background = "rgba(189,254,79,0.14)";
    ss.color = "#BDFE4F";
    ss.border = "1px solid rgba(189,254,79,0.3)";
    ss.borderRadius = "4px";
    ss.padding = "2px 4px";
    ss.fontFamily = "inherit";
    ss.fontSize = "12px";
    ss.maxWidth = "140px";
    select.setAttribute("aria-label", "Язык перевода");
    for (const l of SELECTION_LANGS) {
      const opt = this.doc.createElement("option");
      opt.value = l.code;
      opt.textContent = l.name;
      select.append(opt);
    }
    select.addEventListener("change", () => {
      this._target = select.value;
      this.onTargetChange(select.value);
    });

    const detected = this.doc.createElement("span");
    const ds = detected.style;
    ds.fontSize = "11px";
    ds.color = "#93A0AE";
    ds.whiteSpace = "nowrap";
    ds.overflow = "hidden";
    ds.textOverflow = "ellipsis";

    const closeBtn = this.doc.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "×";
    closeBtn.setAttribute("aria-label", "Закрыть перевод");
    const cs = closeBtn.style;
    cs.border = "none";
    cs.background = "transparent";
    cs.color = "#93A0AE";
    cs.fontSize = "16px";
    cs.lineHeight = "1";
    cs.cursor = "pointer";
    cs.padding = "0 2px";
    cs.marginLeft = "auto";
    closeBtn.addEventListener("click", () => this.onClose());

    header.append(select, detected, closeBtn);

    // тело: оригинал (приглушён, сворачивается) + перевод (главный текст)
    const original = this.doc.createElement("div");
    const os = original.style;
    os.fontSize = "11px";
    os.color = "#93A0AE";
    os.maxHeight = "4.2em";
    os.overflowY = "auto";
    os.overflowWrap = "anywhere";
    os.marginBottom = "4px";
    os.userSelect = "text";

    const translation = this.doc.createElement("div");
    const ts = translation.style;
    ts.fontSize = "15px";
    ts.fontWeight = "500";
    ts.overflowWrap = "anywhere";
    ts.userSelect = "text";
    ts.whiteSpace = "pre-wrap";

    root.append(header, original, translation);
    this.doc.documentElement.appendChild(root);

    this.root = root;
    this.select = select;
    this.detected = detected;
    this.original = original;
    this.translation = translation;
  }
}

/**
 * Контроллер перевода выделения: канал Core ↔ бабл. start() ставит слушатели
 * (contextmenu — якорь бабла; WebMessage begin/result; закрытие по клику
 * мимо и Esc). Вне WebView2 (нет канала Core) start() можно не вызывать.
 */
export class SelectionTranslate {
  private readonly bubble: TranslateBubble;
  private lastCtx: AnchorPoint = { x: 16, y: 16 };
  /** reqId собственных запросов (смена языка); ответы Core идут с эхом. */
  private nextReqId = 1;
  /** Оригинал последнего перевода (эхо результата) — для смены языка. */
  private originalText = "";
  private status: SelectionTranslateStatus = { visible: false, target: "", lastError: "", pending: false };
  private detach: (() => void) | null = null;

  constructor(
    private readonly doc: Document,
    private readonly ports: SelectionTranslatePorts,
  ) {
    this.bubble = new TranslateBubble(
      doc,
      (code) => this.retarget(code),
      () => this.close(),
    );
  }

  /** Слушатели документа; идемпотентен. */
  start(): void {
    if (this.detach) return;
    const onCtx = (e: Event): void => {
      const me = e as MouseEvent;
      this.lastCtx = { x: me.clientX, y: me.clientY };
    };
    const onPointerDown = (e: Event): void => {
      if (this.bubble.visible && !this.bubble.isInside(e.target)) this.close();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && this.bubble.visible) this.close();
    };
    this.doc.addEventListener("contextmenu", onCtx, true);
    this.doc.addEventListener("pointerdown", onPointerDown, true);
    this.doc.addEventListener("keydown", onKey, true);
    const offCore = onCoreMessage((msg) => this.onCoreMessage(msg));
    this.detach = () => {
      this.doc.removeEventListener("contextmenu", onCtx, true);
      this.doc.removeEventListener("pointerdown", onPointerDown, true);
      this.doc.removeEventListener("keydown", onKey, true);
      offCore();
      this.detach = null;
    };
  }

  /** Диагностика (window.__duopulseContent.translateSelection). */
  state(): SelectionTranslateStatus {
    return { ...this.status };
  }

  close(): void {
    this.bubble.close();
    this.status = { visible: false, target: "", lastError: this.status.lastError, pending: false };
  }

  private anchor(): AnchorPoint {
    // Живое выделение точнее клика: конец прямоугольника выделения.
    const sel = this.doc.defaultView?.getSelection?.() ?? null;
    const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    const rect = range?.getBoundingClientRect();
    if (rect && (rect.width > 0 || rect.height > 0)) {
      return { x: rect.right, y: rect.bottom };
    }
    return this.lastCtx;
  }

  private onCoreMessage(msg: Record<string, unknown>): void {
    if (msg["duopulse"] === "translate-selection-begin") {
      const target = typeof msg["target"] === "string" ? msg["target"] : "ru";
      this.originalText = "";
      this.bubble.show(this.anchor(), target);
      this.status = { visible: true, target, lastError: this.status.lastError, pending: true };
    } else if (msg["duopulse"] === "translate-selection-result") {
      // устаревший ответ (язык уже сменили/бабл закрыли) — мимо
      const target = typeof msg["target"] === "string" ? msg["target"] : "";
      if (!this.bubble.visible || target !== this.bubble.target) return;
      if (msg["ok"] === true) {
        const translation = typeof msg["translation"] === "string" ? msg["translation"] : "";
        const original = typeof msg["original"] === "string" ? msg["original"] : "";
        const detected = typeof msg["detected"] === "string" ? msg["detected"] : "";
        this.originalText = original;
        this.bubble.setResult(translation, original, detected, target);
        this.status = { visible: true, target, lastError: this.status.lastError, pending: false };
      } else {
        const error = typeof msg["error"] === "string" ? msg["error"] : "неизвестная ошибка";
        this.bubble.setError(error);
        this.status = { visible: true, target, lastError: error, pending: false };
      }
    }
  }

  /** Смена языка в селекте баббла: повторный запрос с эхом оригинала. */
  private retarget(code: string): void {
    if (!this.originalText) return; // ещё нечего переводить (ждём первый результат)
    this.bubble.setLoading();
    this.status = { visible: true, target: code, lastError: this.status.lastError, pending: true };
    this.ports.post({
      duopulse: "translate-selection",
      reqId: this.nextReqId++,
      text: this.originalText,
      target: code,
    });
  }
}

/** Установить перевод выделения в документ (вызов из duopulse-content.ts). */
export function installSelectionTranslate(ports: SelectionTranslatePorts): SelectionTranslate {
  const st = new SelectionTranslate(document, ports);
  st.start();
  return st;
}
