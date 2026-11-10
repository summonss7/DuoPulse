// Перевод выделенного текста — мобильная ветка (карточка duopulse-103).
// Десктоп: правый клик → нативный пункт «Перевести выделение» (translate_menu.
// rs, WebView2 ContextMenuRequested) → бабл у выделения. В мобильном WebView
// нет ни правого клика, ни контекстного меню композитора, а единственный
// контент — кросс-доменный iframe плеера (выделение в нём недостижимо из
// родительской страницы) — поэтому вход два, оба ведут в один gtx-конвейер
// (команда duo_translate_selection: тот же эндпоинт, что duo_translate_texts,
// плюс sl=auto и детект языка):
//   1) long-press по выделяемому тексту нашей страницы (omnibox и пр. —
//      системные ручки выделения) → плавающий чип «Перевести» у выделения →
//      бабл перевода (TranslateBubble из content-модуля десктопа — DOM без
//      каналов, стиль гайд 06 §6);
//   2) «Перевести текст…» в меню «⋮» шапки → лист с полем ввода (текст можно
//      вставить откуда угодно) и селектом языка.
// Последний язык запоминается в localStorage (как поисковик duopulse-085;
// инкогнито — до перезапуска), бабл и лист стартуют с него.

import { SELECTION_LANGS, TranslateBubble, type AnchorPoint } from "../../content/translate-select";

/** Транспорт invoke (в юнит-тестах подменяется фейком — паттерн duo/session). */
export type SelectionInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Порты конвейера перевода (тесты подменяют). */
export interface MobileSelectionPorts {
  translate(text: string, target: string): Promise<{ translation: string; detected: string }>;
  /** Последний выбранный язык ("" — не задан, берём «ru»). */
  loadTarget(): string;
  saveTarget(code: string): void;
}

/** Диагностика стендов (window.__duopulseMobileTranslate). */
export interface MobileSelectionState {
  /** Виден ли чип «Перевести» у выделения. */
  chip: boolean;
  /** Виден ли бабл перевода. */
  visible: boolean;
  /** Открыт ли лист «Перевести текст…». */
  sheet: boolean;
  /** Текущий язык перевода. */
  target: string;
  /** Ждём результат. */
  pending: boolean;
  /** Последняя ошибка конвейера ("" — не было). */
  lastError: string;
}

const TARGET_KEY = "duopulse.mobile.translateTarget";

/** Язык из localStorage → код SELECTION_LANGS или «ru» (дефолт десктопа). */
function normalizeTarget(raw: string): string {
  return SELECTION_LANGS.some((l) => l.code === raw) ? raw : "ru";
}

/** Порты на tauri-командах (invoke + localStorage; incognito — не писать). */
export function createSelectionPorts(
  invoke: SelectionInvoke,
  incognito: () => boolean = () => false,
): MobileSelectionPorts {
  return {
    async translate(text, target) {
      const r = (await invoke("duo_translate_selection", { text, target })) as {
        translation?: unknown;
        detected?: unknown;
      };
      if (typeof r?.translation !== "string" || !r.translation) {
        throw new Error("пустой ответ конвейера");
      }
      return {
        translation: r.translation,
        detected: typeof r.detected === "string" ? r.detected : "",
      };
    },
    loadTarget() {
      try {
        return normalizeTarget(localStorage.getItem(TARGET_KEY) ?? "");
      } catch {
        return "ru"; // localStorage недоступен — дефолт сессии
      }
    },
    saveTarget(code) {
      try {
        if (!incognito()) localStorage.setItem(TARGET_KEY, code);
      } catch {
        /* приватный режим без localStorage — выбор живёт до перезапуска */
      }
    },
  };
}

/** Прочитанное выделение: текст (trim) + якорь для чипа/бабла. */
export interface ReadSelection {
  text: string;
  anchor: AnchorPoint;
}

/**
 * Текущее выделение документа: input/textarea (long-press в omnibox — ручки
 * системные, window.getSelection про input ничего не знает) или обычный text
 * (range-прямоугольник). Выделение внутри бабла/чипа перевода — не считаем
 * (перевод перевода по кругу). null — выделения нет/пустое.
 */
export function readSelection(doc: Document): ReadSelection | null {
  const view = doc.defaultView;
  if (!view) return null;
  const active = doc.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    const s = active.selectionStart;
    const e = active.selectionEnd;
    if (s !== null && e !== null && e > s) {
      const text = active.value.slice(s, e).trim();
      if (!text) return null;
      const r = active.getBoundingClientRect();
      return { text, anchor: { x: r.left + Math.min(120, r.width / 2), y: r.bottom } };
    }
    return null;
  }
  const sel = view.getSelection();
  const text = sel?.toString().trim() ?? "";
  if (!sel || !text) return null;
  // выделение внутри бабла/чипа/листа — мимо (перевод перевода)
  const host = sel.anchorNode?.parentElement ?? null;
  if (host?.closest("[data-duopulse-translate], .m-tr-chip, .m-tr-sheet")) return null;
  const range = sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
  const rect = range?.getBoundingClientRect();
  if (rect && (rect.width > 0 || rect.height > 0)) {
    return { text, anchor: { x: rect.right, y: rect.bottom } };
  }
  const inner = view.innerWidth ?? 0;
  return { text, anchor: { x: inner ? inner / 2 : 16, y: 80 } };
}

/**
 * Контроллер перевода выделения мобильной ветки: чип у выделения → бабл
 * (TranslateBubble content-модуля), лист ручного ввода из меню «⋮». Язык —
 * один на оба входа (последний выбранный), смена в селекте бабла/листа
 * перезапускает конвейер с эхом оригинала.
 */
export class MobileSelectionTranslate {
  private readonly bubble: TranslateBubble;
  private chip: HTMLButtonElement | null = null;
  private sheet: HTMLElement | null = null;
  private cached: ReadSelection = { text: "", anchor: { x: 16, y: 16 } };
  private original = "";
  private target: string;
  private state: MobileSelectionState = {
    chip: false,
    visible: false,
    sheet: false,
    target: "ru",
    pending: false,
    lastError: "",
  };
  private detach: (() => void) | null = null;

  constructor(
    private readonly doc: Document,
    private readonly ports: MobileSelectionPorts,
  ) {
    this.target = normalizeTarget(ports.loadTarget());
    this.state.target = this.target;
    this.bubble = new TranslateBubble(
      doc,
      (code) => this.retarget(code),
      () => this.closeBubble(),
    );
  }

  /** Слушатели документа (selectionchange/select + закрытие); идемпотентен. */
  start(): void {
    if (this.detach) return;
    const onSel = (): void => this.onSelectionChanged();
    const onPointerDown = (e: Event): void => {
      const me = e as PointerEvent;
      if (
        this.bubble.visible &&
        !this.bubble.isInside(me.target) &&
        !(this.chip && this.chip.contains(me.target as Node))
      ) {
        this.closeBubble();
      }
      // тап мимо чипа при живом выделении — Android схлопнет выделение сам,
      // selectionchange спрячет чип; здесь только не мешаем
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      if (this.sheet) this.closeSheet();
      else if (this.bubble.visible) this.closeBubble();
    };
    this.doc.addEventListener("selectionchange", onSel);
    this.doc.addEventListener("select", onSel); // input/textarea-выделения
    this.doc.addEventListener("pointerdown", onPointerDown, true);
    this.doc.addEventListener("keydown", onKey, true);
    this.detach = () => {
      this.doc.removeEventListener("selectionchange", onSel);
      this.doc.removeEventListener("select", onSel);
      this.doc.removeEventListener("pointerdown", onPointerDown, true);
      this.doc.removeEventListener("keydown", onKey, true);
      this.detach = null;
    };
  }

  /** Диагностика стендов (window.__duopulseMobileTranslate). */
  stateSnapshot(): MobileSelectionState {
    return { ...this.state };
  }

  /** Снять слушатели документа (тесты; в живой странице живёт доunload). */
  stop(): void {
    this.detach?.();
    this.hideChip();
    this.closeSheet();
    this.closeBubble();
  }

  /** Выделение появилось/сменилось: кэш текста+якоря, чип к нему. */
  private onSelectionChanged(): void {
    if (this.sheet) return; // лист открыт — выделение в textarea, чип не нужен
    const read = readSelection(this.doc);
    if (!read) {
      this.hideChip();
      return;
    }
    this.cached = read;
    this.showChip(read.anchor);
  }

  private showChip(anchor: AnchorPoint): void {
    const chip = this.ensureChip();
    const view = this.doc.defaultView;
    const vw = view?.innerWidth ?? 0;
    const vh = view?.innerHeight ?? 0;
    // у конца выделения, не выезжая за края (как бабл, только компактнее)
    let x = anchor.x + 8;
    let y = anchor.y + 10;
    if (vw) x = Math.max(8, Math.min(x, vw - 96));
    if (vh && y + 36 > vh) y = Math.max(8, anchor.y - 44);
    chip.style.left = `${Math.round(x)}px`;
    chip.style.top = `${Math.round(y)}px`;
    this.state = { ...this.state, chip: true };
  }

  private hideChip(): void {
    if (this.chip) this.chip.remove();
    this.chip = null;
    this.state = { ...this.state, chip: false };
  }

  private ensureChip(): HTMLButtonElement {
    if (this.chip?.isConnected) return this.chip;
    const chip = this.doc.createElement("button");
    chip.type = "button";
    chip.className = "m-tr-chip";
    chip.textContent = "Перевести";
    chip.setAttribute("aria-label", "Перевести выделение");
    // pointerdown, не click: тап по кнопке уводит фокус и ручки выделения
    // схлопываются ДО click — preventDefault держит и фокус, и событие
    chip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.hideChip();
      void this.run(this.cached.text, this.target, this.cached.anchor);
    });
    this.doc.body.appendChild(chip);
    this.chip = chip;
    return chip;
  }

  /** Прогон конвейера: бабл «Переводим…» → результат/ошибка. */
  private async run(text: string, target: string, anchor: AnchorPoint): Promise<void> {
    this.original = text;
    this.target = target;
    this.bubble.show(anchor, target);
    this.state = { ...this.state, visible: true, target, pending: true };
    try {
      const r = await this.ports.translate(text, target);
      // устаревший ответ (язык сменили/бабл закрыли) — мимо
      if (!this.bubble.visible || this.bubble.target !== target) return;
      this.bubble.setResult(r.translation, text, r.detected, target);
      this.state = { ...this.state, visible: true, target, pending: false };
    } catch (e) {
      if (!this.bubble.visible) return;
      const message = e instanceof Error ? e.message : String(e);
      this.bubble.setError(message);
      this.state = { ...this.state, visible: true, lastError: message, pending: false };
    }
  }

  /** Смена языка в селекте бабла: помним выбор, повтор с эхом оригинала. */
  private retarget(code: string): void {
    if (!this.original) return; // ещё нечего переводить
    this.ports.saveTarget(code);
    const anchor = { ...this.cached.anchor };
    void this.run(this.original, code, anchor);
  }

  private closeBubble(): void {
    this.bubble.close();
    this.state = { ...this.state, visible: false, pending: false };
  }

  /** Лист «Перевести текст…» (меню «⋮»): поле ввода + язык + результат. */
  openSheet(container: HTMLElement): void {
    if (this.sheet) {
      this.sheet.querySelector("textarea")?.focus();
      return;
    }
    this.hideChip();
    this.closeBubble();
    const doc = this.doc;
    const wrap = doc.createElement("div");
    wrap.className = "m-tr-wrap";
    wrap.innerHTML = `
      <div class="m-tr-backdrop"></div>
      <div class="m-tr-sheet" role="dialog" aria-label="Перевод текста">
        <div class="m-tr-head">
          <b>Перевод текста</b>
          <button type="button" class="m-tr-close" aria-label="Закрыть">✕</button>
        </div>
        <textarea class="m-tr-input" rows="3" placeholder="Вставьте или введите текст"></textarea>
        <div class="m-tr-row">
          <select class="m-tr-lang" aria-label="Язык перевода"></select>
          <button type="button" class="m-tr-go">Перевести</button>
        </div>
        <div class="m-tr-meta" hidden></div>
        <div class="m-tr-result" hidden></div>
      </div>`;
    const sel = wrap.querySelector<HTMLSelectElement>(".m-tr-lang")!;
    for (const l of SELECTION_LANGS) {
      const opt = doc.createElement("option");
      opt.value = l.code;
      opt.textContent = l.name;
      opt.selected = l.code === this.target;
      sel.append(opt);
    }
    const input = wrap.querySelector<HTMLTextAreaElement>(".m-tr-input")!;
    const go = wrap.querySelector<HTMLButtonElement>(".m-tr-go")!;
    const meta = wrap.querySelector<HTMLElement>(".m-tr-meta")!;
    const result = wrap.querySelector<HTMLElement>(".m-tr-result")!;
    const close = (): void => this.closeSheet();
    wrap.querySelector(".m-tr-backdrop")!.addEventListener("click", close);
    wrap.querySelector<HTMLButtonElement>(".m-tr-close")!.addEventListener("click", close);

    const translate = (): void => {
      const text = input.value.trim();
      if (!text) {
        result.hidden = false;
        result.className = "m-tr-result m-tr-err";
        result.textContent = "Введите текст для перевода";
        meta.hidden = true;
        return;
      }
      const target = sel.value;
      this.ports.saveTarget(target);
      this.target = target;
      this.state = { ...this.state, sheet: true, target, pending: true };
      go.disabled = true;
      go.textContent = "Переводим…";
      result.hidden = true;
      meta.hidden = true;
      void (async () => {
        try {
          const r = await this.ports.translate(text, target);
          meta.hidden = false;
          meta.textContent =
            r.detected && r.detected !== target ? `${r.detected} → ${target}` : target;
          result.hidden = false;
          result.className = "m-tr-result";
          result.textContent = r.translation;
          this.state = { ...this.state, pending: false };
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          result.hidden = false;
          result.className = "m-tr-result m-tr-err";
          result.textContent = `Не получилось: ${message}`;
          this.state = { ...this.state, lastError: message, pending: false };
        } finally {
          go.disabled = false;
          go.textContent = "Перевести";
        }
      })();
    };
    go.addEventListener("click", translate);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) translate();
    });
    container.appendChild(wrap);
    this.sheet = wrap;
    this.state = { ...this.state, sheet: true };
    input.focus();
  }

  private closeSheet(): void {
    this.sheet?.remove();
    this.sheet = null;
    this.state = { ...this.state, sheet: false, pending: false };
  }
}

/** Установить перевод выделения в мобильной странице (mobile.ts). */
export function installMobileSelectionTranslate(
  doc: Document,
  ports: MobileSelectionPorts,
): MobileSelectionTranslate {
  const st = new MobileSelectionTranslate(doc, ports);
  st.start();
  return st;
}
