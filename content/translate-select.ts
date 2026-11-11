// Перевод выделенного текста (карточка duopulse-098, расширение
// duopulse-116: выбор источника и нескольких целевых языков). Пункт
// «Перевести выделение» — нативный в контекстном меню страницы (Core,
// src-tauri/src/translate_menu.rs, WebView2 ContextMenuRequested); этот
// модуль — бабл перевода у выделения: Core шлёт WebMessage
// «translate-selection-begin» («Переводим…»), затем
// «translate-selection-result» (переводы по каждому языку / ошибка).
// Смена источника/целей в бабле — WebMessage «translate-selection» обратно
// в Core (gtx-конвейер тот же), выбор запоминается в Core и ведёт подпись
// пункта меню («Перевести выделение (en → ru, ro)»).
//
// Бабл: селект цели (первый select в DOM — контракт e2e/selection), под ним
// селект источника («Авто» + языки) и чипы активных целей с «×»; выбор в селекте
// цели ДОБАВЛЯЕТ язык (переводы рядом для сравнения), «×» на чипе убирает.
// Результат — по строке на целевой язык.
//
// Стиль — гайд 06 §6 (тёмная плашка, скругление, фирменный лайм #BDFE4F);
// DOM — только CSSOM (element.style), сетевых/шрифтовых запросов нет —
// CSP любой страницы не нарушаем (паттерн overlay/hud.ts). Вне WebView2
// канал Core отсутствует (content/messaging) — модуль пассивен; бабл без
// канала переиспользует мобильная ветка (src/mobile/selection-translate.ts).

import { onCoreMessage } from "./messaging";

/** Языки селектов бабла; зеркалит LAST_LANGS-совместимые коды gtx —
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

/** Псевдокод источника «автоопределение» (gtx sl=auto). */
export const SOURCE_AUTO = "auto";

/** Максимум целевых языков одного перевода — зеркало Core (selection.rs). */
export const MAX_SELECTION_TARGETS = 4;

/** Отступ бабла от краёв вьюпорта и от якоря, px. */
const BUBBLE_MARGIN = 8;

/** Точка якоря бабла (клиентские координаты). */
export interface AnchorPoint {
  x: number;
  y: number;
}

/** Источник и цели перевода — выбор бабла, эхо Core и память меню. */
export interface SelectionLangs {
  /** Код источника ("auto" — автоопределение). */
  source: string;
  /** Целевые коды (1…MAX_SELECTION_TARGETS, без дублей). */
  targets: string[];
}

/** Результат одного целевого языка (items «translate-selection-result»). */
export interface SelectionResultItem {
  target: string;
  ok: boolean;
  translation?: string;
  detected?: string;
  error?: string;
}

/** Диагностика стендов (window.__duopulseContent.translateSelection). */
export interface SelectionTranslateStatus {
  visible: boolean;
  /** Текущий источник ("auto" — авто; "" — бабл закрыт). */
  source: string;
  /** Текущие цели перевода (коды; [] — закрыт). */
  targets: string[];
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

/** Подпись источника для селекта («Авто» — автоопределение). */
export function selectionSourceName(code: string): string {
  return code === SOURCE_AUTO ? "Авто" : selectionLangName(code);
}

/** Прочитать langs из сообщения Core: массив целей (+фолбэк поля target),
 * источник-строку; мусор отфильтровать, дубли снять. */
export function parseSelectionLangs(msg: Record<string, unknown>): SelectionLangs {
  const valid = SELECTION_LANGS.map((l) => l.code);
  const raw = Array.isArray(msg["targets"])
    ? msg["targets"]
    : typeof msg["target"] === "string"
      ? [msg["target"]]
      : [];
  const targets: string[] = [];
  for (const t of raw) {
    if (typeof t === "string" && valid.includes(t) && !targets.includes(t)) {
      targets.push(t);
      if (targets.length >= MAX_SELECTION_TARGETS) break;
    }
  }
  const source =
    typeof msg["source"] === "string" && (msg["source"] === SOURCE_AUTO || valid.includes(msg["source"]))
      ? msg["source"]
      : SOURCE_AUTO;
  if (targets.length === 0) targets.push("ru"); // цель нужна всегда (дефолт меню)
  return { source, targets };
}

/**
 * Бабл перевода: DOM без каналов (каналами владеет контроллер — десктопный
 * SelectionTranslate или мобильный). Один экземпляр на документ; позиция
 * пересчитывается на каждый показ.
 */
export class TranslateBubble {
  private root: HTMLDivElement | null = null;
  private targetSelect: HTMLSelectElement | null = null;
  private sourceSelect: HTMLSelectElement | null = null;
  private chips: HTMLDivElement | null = null;
  private original: HTMLDivElement | null = null;
  private items: HTMLDivElement | null = null;
  private _visible = false;
  private _pending = false;
  private _langs: SelectionLangs = { source: SOURCE_AUTO, targets: [] };

  constructor(
    private readonly doc: Document,
    private readonly onLangsChange: (langs: SelectionLangs) => void,
    private readonly onClose: () => void,
  ) {}

  get visible(): boolean {
    return this._visible;
  }

  get pending(): boolean {
    return this._pending;
  }

  get langs(): SelectionLangs {
    return { source: this._langs.source, targets: [...this._langs.targets] };
  }

  /** Основная цель — последняя выбранная (подпись меню, статус, e2e). */
  get target(): string {
    return this._langs.targets[this._langs.targets.length - 1] ?? "";
  }

  get targets(): string[] {
    return [...this._langs.targets];
  }

  get source(): string {
    return this._langs.source;
  }

  /** Показать/перепозиционировать бабл в состоянии «Переводим…». */
  show(anchor: AnchorPoint, langs: SelectionLangs): void {
    this.ensureDom();
    const root = this.root;
    if (!root || !this.items || !this.original) return;
    this._langs = normalizeLangs(langs);
    this._pending = true; // до syncControls — селекты блокируются сразу
    this.syncControls();
    if (this.original) this.original.textContent = "";
    this.setItemsText("Переводим…", "#93A0AE");
    this.position(root, anchor);
    this._visible = true;
  }

  /** Результат конвейера: эхо оригинала + перевод по каждому языку. */
  setResult(original: string, items: SelectionResultItem[], langs: SelectionLangs): void {
    if (!this.root || !this.items) return;
    this._langs = normalizeLangs(langs);
    this.syncControls();
    this._pending = false;
    this.setControlsDisabled(false);
    if (this.original) this.original.textContent = original;
    this.items.textContent = "";
    const auto = this._langs.source === SOURCE_AUTO;
    for (const lang of this._langs.targets) {
      const row = this.doc.createElement("div");
      const rs = row.style;
      rs.marginTop = "6px";
      const head = this.doc.createElement("div");
      const hs = head.style;
      hs.display = "flex";
      hs.alignItems = "baseline";
      hs.gap = "6px";
      const name = this.doc.createElement("span");
      const ns = name.style;
      ns.color = "#BDFE4F";
      ns.fontSize = "11px";
      ns.fontWeight = "600";
      ns.whiteSpace = "nowrap";
      name.textContent = selectionLangName(lang);
      head.append(name);
      const item = items.find((i) => i.target === lang);
      if (item?.ok) {
        const detected = item.detected ?? "";
        if (auto && detected && detected !== lang) {
          const meta = this.doc.createElement("span");
          const ms = meta.style;
          ms.color = "#93A0AE";
          ms.fontSize = "11px";
          ms.whiteSpace = "nowrap";
          meta.textContent = `${detected} → ${lang}`;
          head.append(meta);
        }
        row.append(head);
        const text = this.doc.createElement("div");
        const ts = text.style;
        ts.fontSize = "15px";
        ts.fontWeight = "500";
        ts.overflowWrap = "anywhere";
        ts.userSelect = "text";
        ts.whiteSpace = "pre-wrap";
        ts.color = "#E8EDF2";
        text.textContent = item.translation ?? "";
        row.append(text);
      } else {
        const err = this.doc.createElement("span");
        const es = err.style;
        es.color = "#FF8A80";
        es.fontSize = "12px";
        es.overflowWrap = "anywhere";
        err.textContent = `Не получилось: ${item?.error ?? "нет ответа"}`;
        head.append(err);
        row.append(head);
      }
      this.items.append(row);
    }
  }

  /** Ошибка конвейера целиком (нет ни одного перевода — кулдаун gtx). */
  setError(message: string): void {
    this._pending = false;
    this.setControlsDisabled(false);
    if (this.original) this.original.textContent = "";
    if (this.items) {
      this.items.textContent = "";
      const err = this.doc.createElement("div");
      const es = err.style;
      es.fontSize = "14px";
      es.color = "#FF8A80";
      es.overflowWrap = "anywhere";
      err.textContent = `Не получилось: ${message}`;
      this.items.append(err);
    }
  }

  /** Снова «Переводим…» — контроллер перезапускает конвейер. */
  setLoading(): void {
    this._pending = true;
    this.setControlsDisabled(true);
    this.setItemsText("Переводим…", "#93A0AE");
  }

  /** Единственная строка в области результатов (загрузка/ошибка). */
  private setItemsText(text: string, color: string): void {
    if (!this.items) return;
    this.items.textContent = "";
    const div = this.doc.createElement("div");
    div.style.color = color;
    div.textContent = text;
    this.items.append(div);
  }

  close(): void {
    if (this.root) this.root.remove();
    this.root = null;
    this.targetSelect = null;
    this.sourceSelect = null;
    this.chips = null;
    this.original = null;
    this.items = null;
    this._visible = false;
    this._pending = false;
    this._langs = { source: SOURCE_AUTO, targets: [] };
  }

  /** Клик/тач мимо бабла — закрыть (контроллер слушает на document). */
  isInside(target: EventTarget | null): boolean {
    return this.root !== null && this.root.contains(target as Node | null);
  }

  /** Смена языков извне (контроллер повторяет запрос) — без событий. */
  applyLangs(langs: SelectionLangs): void {
    this._langs = normalizeLangs(langs);
    this.syncControls();
  }

  private syncControls(): void {
    this.renderChips();
    if (this.sourceSelect && this.sourceSelect.value !== this._langs.source) {
      this.sourceSelect.value = this._langs.source;
    }
    if (this.targetSelect && this.targetSelect.value !== this.target) {
      this.targetSelect.value = this.target;
    }
    this.setControlsDisabled(this._pending);
  }

  private setControlsDisabled(disabled: boolean): void {
    if (this.targetSelect) this.targetSelect.disabled = disabled;
    if (this.sourceSelect) this.sourceSelect.disabled = disabled;
    this.chips?.querySelectorAll("button").forEach((b) => {
      (b as HTMLButtonElement).disabled = disabled;
    });
  }

  /** Чипы активных целей: «Русский ×»; «×» убирает язык (если не единственный). */
  private renderChips(): void {
    if (!this.chips) return;
    this.chips.textContent = "";
    for (const code of this._langs.targets) {
      const chip = this.doc.createElement("span");
      const cs = chip.style;
      cs.display = "inline-flex";
      cs.alignItems = "center";
      cs.gap = "4px";
      cs.background = "rgba(189,254,79,0.14)";
      cs.border = "1px solid rgba(189,254,79,0.3)";
      cs.borderRadius = "10px";
      cs.padding = "1px 6px";
      cs.fontSize = "11px";
      cs.color = "#BDFE4F";
      const label = this.doc.createElement("span");
      label.textContent = selectionLangName(code);
      const x = this.doc.createElement("button");
      x.type = "button";
      x.setAttribute("aria-label", `Убрать ${selectionLangName(code)}`);
      const xs = x.style;
      xs.border = "none";
      xs.background = "transparent";
      xs.color = "#93A0AE";
      xs.fontSize = "12px";
      xs.lineHeight = "1";
      xs.cursor = "pointer";
      xs.padding = "0";
      x.textContent = "×";
      if (this._langs.targets.length <= 1) x.disabled = true; // цель нужна всегда
      x.addEventListener("click", () => {
        if (this._pending) return;
        const next = this._langs.targets.filter((t) => t !== code);
        if (next.length === 0) return;
        this.applyLangs({ ...this._langs, targets: next });
        this.setLoading();
        this.onLangsChange(this.langs);
      });
      chip.append(label, x);
      this.chips.append(chip);
    }
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

    // шапка: селект цели (первый select в DOM — контракт e2e) · закрыть
    const header = this.doc.createElement("div");
    const hs = header.style;
    hs.display = "flex";
    hs.alignItems = "center";
    hs.gap = "8px";
    hs.marginBottom = "4px";

    const targetSelect = this.doc.createElement("select");
    const ts = targetSelect.style;
    ts.background = "rgba(189,254,79,0.14)";
    ts.color = "#BDFE4F";
    ts.border = "1px solid rgba(189,254,79,0.3)";
    ts.borderRadius = "4px";
    ts.padding = "2px 4px";
    ts.fontFamily = "inherit";
    ts.fontSize = "12px";
    ts.maxWidth = "140px";
    targetSelect.setAttribute("aria-label", "Язык перевода");
    for (const l of SELECTION_LANGS) {
      const opt = this.doc.createElement("option");
      opt.value = l.code;
      opt.textContent = l.name;
      targetSelect.append(opt);
    }
    targetSelect.addEventListener("change", () => {
      if (this._pending) return;
      const v = targetSelect.value;
      if (!v || !this._langs.targets.length) return;
      // выбор в селекте всегда ДОБАВЛЯЕТ язык (сравнить переводы рядом);
      // убрать — «×» на чипе. Уже активный — ничего не делаем.
      if (this._langs.targets.includes(v)) return;
      const targets = [...this._langs.targets, v];
      this.applyLangs({ ...this._langs, targets });
      this.setLoading();
      this.onLangsChange(this.langs);
    });

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

    header.append(targetSelect, closeBtn);

    // под шапкой: селект источника («Авто» — автоопределение)
    const sourceRow = this.doc.createElement("div");
    const sr = sourceRow.style;
    sr.display = "flex";
    sr.alignItems = "center";
    sr.gap = "6px";
    sr.marginBottom = "6px";
    const sourceLabel = this.doc.createElement("span");
    const sls = sourceLabel.style;
    sls.color = "#93A0AE";
    sls.fontSize = "11px";
    sourceLabel.textContent = "с";
    const sourceSelect = this.doc.createElement("select");
    const ss = sourceSelect.style;
    ss.background = "rgba(255,255,255,0.06)";
    ss.color = "#E8EDF2";
    ss.border = "1px solid rgba(255,255,255,0.15)";
    ss.borderRadius = "4px";
    ss.padding = "1px 4px";
    ss.fontFamily = "inherit";
    ss.fontSize = "11px";
    ss.maxWidth = "140px";
    sourceSelect.setAttribute("aria-label", "Язык оригинала");
    for (const l of [{ code: SOURCE_AUTO, name: "Авто" }, ...SELECTION_LANGS]) {
      const opt = this.doc.createElement("option");
      opt.value = l.code;
      opt.textContent = l.name;
      sourceSelect.append(opt);
    }
    sourceSelect.addEventListener("change", () => {
      if (this._pending) return;
      this.applyLangs({ ...this._langs, source: sourceSelect.value });
      this.setLoading();
      this.onLangsChange(this.langs);
    });
    sourceRow.append(sourceLabel, sourceSelect);

    // чипы активных целей («×» убирает язык)
    const chips = this.doc.createElement("div");
    const chs = chips.style;
    chs.display = "flex";
    chs.flexWrap = "wrap";
    chs.gap = "4px";
    chs.marginBottom = "4px";

    // тело: оригинал (приглушён, сворачивается) + переводы по языкам
    const original = this.doc.createElement("div");
    const os = original.style;
    os.fontSize = "11px";
    os.color = "#93A0AE";
    os.maxHeight = "4.2em";
    os.overflowY = "auto";
    os.overflowWrap = "anywhere";
    os.marginBottom = "4px";
    os.userSelect = "text";

    const items = this.doc.createElement("div");
    const is = items.style;
    is.overflowWrap = "anywhere";

    root.append(header, sourceRow, chips, original, items);
    this.doc.documentElement.appendChild(root);

    this.root = root;
    this.targetSelect = targetSelect;
    this.sourceSelect = sourceSelect;
    this.chips = chips;
    this.original = original;
    this.items = items;
  }
}

/** Нормализация langs: валидные коды, без дублей, лимит целей (зеркало Core). */
function normalizeLangs(langs: SelectionLangs): SelectionLangs {
  const valid = SELECTION_LANGS.map((l) => l.code);
  const targets: string[] = [];
  for (const t of langs.targets) {
    if (valid.includes(t) && !targets.includes(t)) {
      targets.push(t);
      if (targets.length >= MAX_SELECTION_TARGETS) break;
    }
  }
  if (targets.length === 0) targets.push("ru"); // цель нужна всегда
  const source = langs.source === SOURCE_AUTO || valid.includes(langs.source) ? langs.source : SOURCE_AUTO;
  return { source, targets };
}

/**
 * Контроллер перевода выделения: канал Core ↔ бабл. start() ставит слушатели
 * (contextmenu — якорь бабла; WebMessage begin/result; закрытие по клику
 * мимо и Esc). Вне WebView2 (нет канала Core) start() можно не вызывать.
 */
export class SelectionTranslate {
  private readonly bubble: TranslateBubble;
  private lastCtx: AnchorPoint = { x: 16, y: 16 };
  /** reqId собственных запросов (смена языков); сдвиг — не пересекаться со
   * счётчиком Core (begin/result меню); ответы Core идут с эхом reqId. */
  private nextReqId = 1_000_000;
  /** reqId ожидаемого ответа (begin меню или собственный повтор). */
  private pendingReqId = 0;
  /** Оригинал последнего перевода (эхо результата) — для смены языков. */
  private originalText = "";
  private status: SelectionTranslateStatus = {
    visible: false,
    source: "",
    targets: [],
    lastError: "",
    pending: false,
  };
  private detach: (() => void) | null = null;

  constructor(
    private readonly doc: Document,
    private readonly ports: SelectionTranslatePorts,
  ) {
    this.bubble = new TranslateBubble(
      doc,
      (langs) => this.retarget(langs),
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
    return { ...this.status, targets: [...this.status.targets] };
  }

  close(): void {
    this.bubble.close();
    this.pendingReqId = 0;
    this.status = {
      ...this.status,
      visible: false,
      source: "",
      targets: [],
      pending: false,
    };
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
      const langs = parseSelectionLangs(msg);
      this.pendingReqId = typeof msg["reqId"] === "number" ? msg["reqId"] : 0;
      this.originalText = "";
      this.bubble.show(this.anchor(), langs);
      this.status = {
        visible: true,
        source: langs.source,
        targets: langs.targets,
        lastError: this.status.lastError,
        pending: true,
      };
    } else if (msg["duopulse"] === "translate-selection-result") {
      // устаревший ответ (языки уже сменили/бабл закрыли) — мимо
      if (!this.bubble.visible) return;
      if (msg["reqId"] !== this.pendingReqId) return;
      const langs = this.bubble.langs;
      if (msg["ok"] === true) {
        const items: SelectionResultItem[] = Array.isArray(msg["items"])
          ? msg["items"].filter(
              (i): i is SelectionResultItem =>
                typeof i === "object" && i !== null && typeof i["target"] === "string",
            )
          : [];
        const original = typeof msg["original"] === "string" ? msg["original"] : "";
        this.originalText = original || this.originalText;
        this.bubble.setResult(original, items, langs);
        this.status = {
          ...this.status,
          visible: true,
          source: langs.source,
          targets: langs.targets,
          pending: false,
        };
      } else {
        const error = typeof msg["error"] === "string" ? msg["error"] : "неизвестная ошибка";
        this.bubble.setError(error);
        this.status = {
          ...this.status,
          visible: true,
          lastError: error,
          pending: false,
        };
      }
    }
  }

  /** Смена источника/целей в бабле: повторный запрос с эхом оригинала. */
  private retarget(langs: SelectionLangs): void {
    if (!this.originalText) return; // ещё нечего переводить (ждём первый результат)
    this.status = {
      ...this.status,
      source: langs.source,
      targets: langs.targets,
      pending: true,
    };
    const reqId = this.nextReqId++;
    this.pendingReqId = reqId;
    this.ports.post({
      duopulse: "translate-selection",
      reqId,
      text: this.originalText,
      source: langs.source,
      targets: langs.targets,
    });
  }
}

/** Установить перевод выделения в документ (вызов из duopulse-content.ts). */
export function installSelectionTranslate(ports: SelectionTranslatePorts): SelectionTranslate {
  const st = new SelectionTranslate(document, ports);
  st.start();
  return st;
}
