// Перевод всей страницы (карточка duopulse-244): как «Перевести…» в Chrome.
// Входы: пункт «Перевести страницу» нативного контекстного меню (Core,
// src-tauri/src/translate_menu.rs — WebMessage «translate-page» {target}) и
// пункт «⋮»-меню (bridge translate.page_begin — document-событие
// duopulse-translate-page, паттерн subtitles.translate_track). Контент
// собирает текстовые узлы документа, водит пачки (≤ 40 строк / ≤ 1200
// символов) бесплатным gtx (WebMessage «gtx-translate» — конвейер
// yt_fallback, тот же, что у фолбэк-дорожек), меняет textContent с
// сохранением оригиналов в Map. Бар сверху (CSSOM, гайд 06 §6): селект цели
// (языки — те же, что у бабла выделения), «Оригинал»/«Показать перевод»,
// «×» (спрятать бар; перевод живёт). Смена цели — восстановить оригиналы и
// перевести заново; MutationObserver дочитывает динамически добавленные
// узлы, пока перевод активен. Жизнь — до навигации документа (SPA-смена
// URL документ не убивает — перевод остаётся, как остатки DOM страницы).
//
// DOM — только CSSOM (element.style), сетевых/шрифтовых запросов нет — CSP
// страницы не нарушаем (паттерн overlay/hud.ts, translate-select.ts).
// Вне WebView2 канала Core нет (content/messaging) — модуль пассивен.
// Переводим только top-level документ (бандл во фреймы не стартует).

import { onCoreMessage } from "./messaging";
import { requestGtxTranslate } from "./adapters/core-bridge";
import { SELECTION_LANGS, selectionLangName } from "./translate-select";

/** Строк в одной пачке gtx (лимит Core — GTX_BATCH_MAX_LINES=60, yt_fallback;
 * запас — на случай будущих правок и построчного фолбэка). */
const MAX_LINES_PER_BATCH = 40;
/** Символов в одной пачке (GET-query; с запасом до ~8 КБ адреса). */
const MAX_CHARS_PER_BATCH = 1200;
/** Пауза между пачками, мс: бесплатный gtx всплески считает абузом. */
const BATCH_STAGGER_MS = 150;
/** Пауза накопления новых узлов MutationObserver до запроса, мс. */
const MUTATION_DEBOUNCE_MS = 700;
/** Минимальная длина непробельного текста узла. */
const MIN_TEXT_LEN = 2;
/** Атрибут бара — свои узлы не собираем и не переводим. */
const BAR_ATTR = "data-duopulse-page-bar";

/** Теги без видимого текста (или с машинным: код, разметка). */
const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "TEXTAREA",
  "TITLE",
  "CODE",
  "PRE",
  "KBD",
  "SAMP",
  "VAR",
  "SVG",
  "IFRAME",
  "OBJECT",
  "CANVAS",
  "AUDIO",
  "VIDEO",
  "MAP",
]);

/** Фаза перевода страницы (диагностика/бар). */
export type PageTranslatePhase = "idle" | "translating" | "translated" | "original" | "error";

/** Состояние перевода страницы (window.__duopulseContent.pageTranslate). */
export interface PageTranslateStatus {
  phase: PageTranslatePhase;
  /** Целевой код ("ru"; "" — ещё не начинали). */
  target: string;
  /** Узлов в переводе (запомненные оригиналы). */
  nodes: number;
  /** Узлов переведено / всего (прогресс translating). */
  done: number;
  total: number;
  /** Последняя ошибка конвейера ("" — не было). */
  lastError: string;
  /** Бар виден. */
  bannerVisible: boolean;
}

/** Порты для юнит-тестов (jsdom/Node без window.chrome.webview). */
export interface PageTranslatePorts {
  post(message: Record<string, unknown>): void;
}

/** Транспорт перевода пачек — подменяется тестами. */
export type GtxRequest = (
  texts: string[],
  from: string,
  to: string,
) => Promise<string[] | { error: string } | null>;

/** Пробельный контур оригинала: сохранить отступы узла при замене
 * (ленивый regexp рвётся на чисто-пробельных строках — режем по индексам). */
export function splitEdges(text: string): { lead: string; core: string; trail: string } {
  const start = text.length - text.trimStart().length;
  const end = text.trimEnd().length;
  const core = text.slice(start, Math.max(end, start));
  return { lead: text.slice(0, start), core, trail: text.slice(Math.max(end, start)) };
}

/** Годен ли текстовый узел перевода: непустой, не только цифры/знаки. */
export function isTranslatableText(text: string): boolean {
  const core = splitEdges(text).core;
  if (core.length < MIN_TEXT_LEN) return false;
  // только цифры и пунктуация — не переводим (цены, счётчики, артикулы)
  return /[^\p{N}\p{P}\p{Z}\s]/u.test(core);
}

/** Свои узлы (бар перевода, бабл выделения) — не переводим. */
const DUOPULSE_UI_SLOW = "[data-duopulse-translate]";

/** Пропустить элемент целиком: служебный тег, перевод запрещён, правка. */
function skipElement(el: Element | null): boolean {
  if (!el) return false;
  if (SKIP_TAGS.has(el.tagName)) return true;
  if (el.closest(DUOPULSE_UI_SLOW)) return true; // бар/бабл — наши
  const tr = el.getAttribute("translate");
  if (tr && tr.toLowerCase() === "no") return true; // HTML translate=no
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  return false;
}

/** Собрать переводимые текстовые узлы поддерева (порядок DOM). */
export function collectTextNodes(root: Node): Text[] {
  const out: Text[] = [];
  const doc = root.ownerDocument ?? document;
  const Filter = (doc as unknown as { NodeFilter?: typeof NodeFilter }).NodeFilter ?? NodeFilter;
  const walker = doc.createTreeWalker(root, Filter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      const parent = node.parentElement;
      if (skipElement(parent)) return Filter.FILTER_REJECT;
      if (!isTranslatableText(node.nodeValue ?? "")) return Filter.FILTER_SKIP;
      return Filter.FILTER_ACCEPT;
    },
  });
  let n = walker.nextNode();
  while (n) {
    out.push(n as Text);
    n = walker.nextNode();
  }
  return out;
}

/** Нарезать узлы на пачки (порядок сохраняется). */
export function chunkNodes(nodes: readonly Text[]): Text[][] {
  const chunks: Text[][] = [];
  let cur: Text[] = [];
  let chars = 0;
  for (const node of nodes) {
    const len = (node.nodeValue ?? "").length;
    if (cur.length > 0 && (cur.length >= MAX_LINES_PER_BATCH || chars + len > MAX_CHARS_PER_BATCH)) {
      chunks.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(node);
    chars += len;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

/** Подготовить пачку к запросу: тексты без пробельного контура. */
function chunkTexts(nodes: readonly Text[]): string[] {
  return nodes.map((n) => splitEdges(n.nodeValue ?? "").core);
}

/**
 * Контроллер перевода страницы: входы (WebMessage контекстного меню,
 * document-событие «⋮»-меню), сбор/замена узлов, бар, наблюдатель мутаций.
 * Один экземпляр на документ.
 */
export class PageTranslate {
  /** Оригиналы переведённых узлов (восстановление «Оригинал»). */
  private originals = new Map<Text, string>();
  private phase: PageTranslatePhase = "idle";
  private target = "";
  private done = 0;
  private total = 0;
  private lastError = "";
  /** Поколение запроса: отменяет ответы прошлых стартов. */
  private generation = 0;
  private banner: HTMLDivElement | null = null;
  private statusLabel: HTMLSpanElement | null = null;
  private targetSelect: HTMLSelectElement | null = null;
  private toggleBtn: HTMLButtonElement | null = null;
  private observer: MutationObserver | null = null;
  /** Отложенный перевод накопленных мутаций. */
  private mutationTimer = 0;
  private pendingMutationNodes: Text[] = [];
  private detach: (() => void) | null = null;

  constructor(
    private readonly doc: Document,
    private readonly ports: PageTranslatePorts,
    private readonly gtx: GtxRequest = defaultGtx(doc, ports),
  ) {}

  /** Слушатели входов; идемпотентен. */
  start(): void {
    if (this.detach) return;
    const onEvent = (e: Event): void => {
      const detail = (e as CustomEvent<{ target?: unknown }>).detail;
      const target = typeof detail?.target === "string" ? detail.target : "";
      void this.begin(target || "ru");
    };
    this.doc.addEventListener("duopulse-translate-page", onEvent);
    const offCore = onCoreMessage((msg) => {
      if (msg["duopulse"] === "translate-page") {
        const target = typeof msg["target"] === "string" ? msg["target"] : "";
        void this.begin(target || "ru");
      }
    });
    this.detach = () => {
      this.doc.removeEventListener("duopulse-translate-page", onEvent);
      offCore();
      this.detach = null;
    };
  }

  /** Диагностика (window.__duopulseContent.pageTranslate). */
  state(): PageTranslateStatus {
    return {
      phase: this.phase,
      target: this.target,
      nodes: this.originals.size,
      done: this.done,
      total: this.total,
      lastError: this.lastError,
      bannerVisible: this.banner !== null,
    };
  }

  /** Вход пользователя: старт/продолжение перевода страницы. */
  async begin(target: string): Promise<void> {
    const code = normalizeLang(target);
    if (!code) return;
    // повторный вход с той же целью: показать бар (перевод уже стоит)
    if (this.phase === "translated" && code === this.target) {
      this.showBanner(); // перевод уже стоит — только вернуть бар
      return;
    }
    // смена цели / показ оригинала / повтор после ошибки: оригиналы на место
    // (память Map) и полный прогон заново — перевода «без сети» не храним
    this.stopObserver();
    this.restoreOriginals();
    this.target = code;
    this.generation++;
    const gen = this.generation;
    this.lastError = "";
    this.phase = "translating";
    this.done = 0;
    const nodes = this.doc.body ? collectTextNodes(this.doc.body) : [];
    this.total = nodes.length;
    this.showBanner();
    this.updateLabel();
    if (nodes.length === 0) {
      this.phase = "translated"; // пустая страница — «переведено» без запросов
      this.updateLabel();
      return;
    }
    for (const chunk of chunkNodes(nodes)) {
      if (gen !== this.generation) return; // сменили цель/выключили
      await this.translateChunk(chunk, code, gen);
      if (gen !== this.generation) return;
      if (BATCH_STAGGER_MS > 0) {
        await new Promise((r) => setTimeout(r, BATCH_STAGGER_MS));
      }
    }
    if (gen !== this.generation) return;
    this.phase = "translated";
    this.updateLabel();
    this.startObserver();
  }

  /** Показать оригинал (кнопка бара): вернуть все textContent. */
  showOriginal(): void {
    if (this.phase !== "translated" && this.phase !== "error") return;
    this.generation++; // отменяет идущие пачки
    this.stopObserver();
    this.restoreOriginals();
    this.phase = "original";
    this.updateLabel();
  }

  /** Смена цели в баре: запомнить в Core (подпись меню), перевести заново. */
  retarget(target: string): void {
    const code = normalizeLang(target);
    if (!code || code === this.target) return;
    this.ports.post({ duopulse: "translate-page-set-target", target: code });
    void this.begin(code);
  }

  /** Спрятать бар (перевод остаётся; меню вернёт бар). */
  hideBanner(): void {
    if (this.banner) {
      this.banner.remove();
      this.banner = null;
      this.statusLabel = null;
      this.targetSelect = null;
      this.toggleBtn = null;
    }
  }

  /** Остановить контроллер целиком (юзнит-тесты): слушатели, наблюдатель,
   * таймеры, бар; переведённые узлы остаются как есть (документ теста
   * живёт дольше контроллера, восстановление — restoreOriginals в begin). */
  stop(): void {
    this.generation++;
    this.stopObserver();
    this.hideBanner();
    this.phase = "idle";
    this.detach?.();
  }

  private async translateChunk(chunk: Text[], code: string, gen: number): Promise<void> {
    const texts = chunkTexts(chunk);
    const reply = await this.gtx(texts, "auto", code);
    if (gen !== this.generation) return;
    if (!reply || !Array.isArray(reply)) {
      this.fail(reply && typeof (reply as { error?: unknown }).error === "string"
        ? (reply as { error: string }).error
        : "ядро не ответило");
      return;
    }
    const lines = reply as string[];
    for (let i = 0; i < chunk.length; i++) {
      const node = chunk[i];
      const line = typeof lines[i] === "string" ? lines[i] : "";
      if (!line) continue; // пустой перевод — узел остаётся оригиналом
      if (!this.originals.has(node)) this.originals.set(node, node.nodeValue ?? "");
      const edges = splitEdges(this.originals.get(node) ?? node.nodeValue ?? "");
      node.nodeValue = edges.lead + line + edges.trail;
      this.done++;
    }
    this.updateLabel();
  }

  private fail(message: string): void {
    // отмена идущих пачек этого прогона: кулдаун gtx гасит и следующие —
    // частичный перевод остаётся, повтор из бара/меню пойдёт с нуля
    this.generation++;
    this.phase = "error";
    this.lastError = message;
    this.updateLabel();
  }

  /** Оригиналы на место (перевод снят). */
  private restoreOriginals(): void {
    for (const [node, original] of this.originals) {
      node.nodeValue = original;
    }
    this.originals.clear();
    this.done = 0;
  }

  private updateLabel(): void {
    if (!this.statusLabel) return;
    if (this.phase === "translating") {
      const pct = this.total > 0 ? Math.min(99, Math.round((this.done / this.total) * 100)) : 0;
      this.statusLabel.textContent = `Переводим… ${pct}%`;
    } else if (this.phase === "translated") {
      this.statusLabel.textContent = `Переведено на ${selectionLangName(this.target)}`;
    } else if (this.phase === "original") {
      this.statusLabel.textContent = `Оригинал (${selectionLangName(this.target)})`;
    } else if (this.phase === "error") {
      this.statusLabel.textContent = `Не получилось: ${this.lastError}`;
    }
    if (this.toggleBtn) {
      this.toggleBtn.textContent = this.phase === "original" ? "Показать перевод" : "Оригинал";
    }
  }

  private showBanner(): void {
    if (this.banner?.isConnected) {
      this.updateLabel();
      return;
    }
    this.hideBanner();
    const doc = this.doc;
    const root = doc.createElement("div");
    root.setAttribute(BAR_ATTR, "1");
    root.setAttribute("data-duopulse-translate", "page");
    const s = root.style;
    s.position = "fixed";
    s.top = "8px";
    s.left = "50%";
    s.transform = "translateX(-50%)";
    s.zIndex = "2147483647";
    s.maxWidth = "min(560px, calc(100vw - 16px))";
    s.display = "flex";
    s.alignItems = "center";
    s.gap = "8px";
    s.padding = "6px 10px";
    s.borderRadius = "8px"; // гайд 06 §6
    s.border = "1px solid rgba(189,254,79,0.25)";
    s.background = "rgba(10,14,23,0.96)";
    s.backdropFilter = "blur(4px)";
    s.color = "#E8EDF2";
    s.fontFamily = "Inter, 'Segoe UI', system-ui, sans-serif";
    s.fontSize = "13px";
    s.lineHeight = "1.4";
    s.pointerEvents = "auto";
    s.boxShadow = "0 8px 24px rgba(0,0,0,0.4)";
    // на узких окнах бар переносится, не выезжая за экран
    s.flexWrap = "wrap";

    const status = doc.createElement("span");
    const ss = status.style;
    ss.color = "#BDFE4F";
    ss.fontSize = "12px";
    ss.fontWeight = "600";
    ss.whiteSpace = "nowrap";
    ss.overflow = "hidden";
    ss.textOverflow = "ellipsis";
    ss.maxWidth = "260px";

    const targetSelect = doc.createElement("select");
    const ts = targetSelect.style;
    ts.background = "rgba(189,254,79,0.14)";
    ts.color = "#BDFE4F";
    ts.border = "1px solid rgba(189,254,79,0.3)";
    ts.borderRadius = "4px";
    ts.padding = "2px 4px";
    ts.fontFamily = "inherit";
    ts.fontSize = "12px";
    targetSelect.setAttribute("aria-label", "Язык перевода страницы");
    for (const l of SELECTION_LANGS) {
      const opt = doc.createElement("option");
      opt.value = l.code;
      opt.textContent = l.name;
      targetSelect.append(opt);
    }
    targetSelect.value = this.target || "ru";
    targetSelect.addEventListener("change", () => {
      this.retarget(targetSelect.value);
    });

    const toggle = doc.createElement("button");
    toggle.type = "button";
    toggle.textContent = "Оригинал";
    toggle.setAttribute("aria-label", "Показать оригинал страницы");
    const gs = toggle.style;
    gs.border = "1px solid rgba(255,255,255,0.2)";
    gs.background = "rgba(255,255,255,0.06)";
    gs.color = "#E8EDF2";
    gs.borderRadius = "4px";
    gs.padding = "3px 8px";
    gs.fontFamily = "inherit";
    gs.fontSize = "12px";
    gs.cursor = "pointer";
    toggle.addEventListener("click", () => {
      if (this.phase === "original") void this.begin(this.target);
      else this.showOriginal();
    });

    const closeBtn = doc.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "×";
    closeBtn.setAttribute("aria-label", "Спрятать панель перевода");
    const cs = closeBtn.style;
    cs.border = "none";
    cs.background = "transparent";
    cs.color = "#93A0AE";
    cs.fontSize = "16px";
    cs.lineHeight = "1";
    cs.cursor = "pointer";
    cs.padding = "0 2px";
    closeBtn.addEventListener("click", () => this.hideBanner());

    root.append(status, targetSelect, toggle, closeBtn);
    doc.documentElement.appendChild(root);
    this.banner = root;
    this.statusLabel = status;
    this.targetSelect = targetSelect;
    this.toggleBtn = toggle;
    this.updateLabel();
  }

  /** Наблюдатель динамики: новые текстовые узлы переводятся, пока показан
   * перевод (childList; свои замены узлов уже в originals — пропускаем). */
  private startObserver(): void {
    if (this.observer || !this.doc.body) return;
    const obs = this.doc.defaultView?.MutationObserver ?? null;
    if (!obs) return;
    this.observer = new obs((records) => this.onMutations(records));
    this.observer.observe(this.doc.body, { childList: true, subtree: true, characterData: true });
  }

  private stopObserver(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.mutationTimer) {
      clearTimeout(this.mutationTimer);
      this.mutationTimer = 0;
    }
    this.pendingMutationNodes = [];
  }

  private onMutations(records: MutationRecord[]): void {
    if (this.phase !== "translated") return;
    let fresh = false;
    for (const r of records) {
      if (r.type === "characterData") {
        // собственная замена узла (он уже в originals) — не динамика;
        // правка стороннего текста — не трогаем (v1)
        continue;
      }
      for (const node of r.addedNodes) {
        if (!(node.nodeType === 3)) {
          // элементы — спускаемся внутрь (в т.ч. целые поддеревья)
          if (node.nodeType === 1 && !skipElement(node as Element)) {
            for (const t of collectTextNodes(node)) {
              if (!this.originals.has(t)) {
                this.pendingMutationNodes.push(t);
                fresh = true;
              }
            }
          }
          continue;
        }
        const t = node as Text;
        if (this.originals.has(t)) continue;
        if (!isTranslatableText(t.nodeValue ?? "")) continue;
        if (skipElement(t.parentElement)) continue;
        this.pendingMutationNodes.push(t);
        fresh = true;
      }
    }
    if (!fresh) return;
    if (this.mutationTimer) clearTimeout(this.mutationTimer);
    this.mutationTimer = setTimeout(() => {
      this.mutationTimer = 0;
      void this.translateMutations();
    }, MUTATION_DEBOUNCE_MS) as unknown as number;
  }

  /** Перевод накопленных мутаций (дочитка динамики). */
  private async translateMutations(): Promise<void> {
    if (this.phase !== "translated") {
      this.pendingMutationNodes = [];
      return;
    }
    const nodes = this.pendingMutationNodes.filter((n) => n.isConnected);
    this.pendingMutationNodes = [];
    if (nodes.length === 0) return;
    const gen = this.generation;
    const code = this.target;
    this.total = Math.max(this.total, this.originals.size + nodes.length);
    for (const chunk of chunkNodes(nodes)) {
      if (gen !== this.generation) return;
      await this.translateChunk(chunk, code, gen);
    }
  }
}

/** Код языка: trim/нижний регистр; валиден из SELECTION_LANGS. */
function normalizeLang(lang: string): string {
  const code = lang.trim().toLowerCase();
  return SELECTION_LANGS.some((l) => l.code === code) ? code : "";
}

/** Продовый транспорт: WebMessage «gtx-translate» (конвейер yt_fallback). */
function defaultGtx(doc: Document, ports: PageTranslatePorts): GtxRequest {
  return async (texts, from, to) => {
    const reply = await requestGtxTranslate(doc, { post: (m) => ports.post(m) }, texts, from, to);
    if (!reply) return null;
    if (reply.ok !== true) return { error: typeof reply.error === "string" ? reply.error : "отказ gtx" };
    return reply.lines ?? [];
  };
}

/** Установить перевод страницы в документ (вызов из duopulse-content.ts). */
export function installPageTranslate(ports: PageTranslatePorts): PageTranslate {
  const pt = new PageTranslate(document, ports);
  pt.start();
  return pt;
}
