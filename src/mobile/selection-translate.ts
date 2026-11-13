// Перевод выделенного текста — мобильная ветка (карточка duopulse-103,
// источник и несколько целей — duopulse-116). Десктоп: правый клик →
// нативный пункт «Перевести выделение» (translate_menu.rs, WebView2
// ContextMenuRequested) → бабл у выделения. В мобильном WebView нет ни
// правого клика, ни контекстного меню композитора, а единственный контент —
// кросс-доменный iframe плеера (выделение в нём недостижимо из родительской
// страницы) — поэтому вход два, оба ведут в один gtx-конвейер (команда
// duo_translate_selection: тот же эндпоинт, что duo_translate_texts,
// источник опционален — нет, так auto + детект языка):
//   1) long-press по выделяемому тексту нашей страницы (omnibox и пр. —
//      системные ручки выделения) → плавающий чип «Перевести» у выделения →
//      бабл перевода (TranslateBubble из content-модуля десктопа — DOM без
//      каналов, стиль гайд 06 §6; селект источника и чипы нескольких целей);
//   2) «Перевести текст…» в меню «⋮» шапки → лист с полем ввода (текст можно
//      вставить откуда угодно) и селектом языка (одна цель, источник — авто).
// Последние языки запоминаются в localStorage (как поисковик duopulse-085;
// инкогнито — до перезапуска), бабл и лист стартуют с них.

import {
  MAX_SELECTION_TARGETS,
  SELECTION_LANGS,
  SOURCE_AUTO,
  TranslateBubble,
  type AnchorPoint,
  type SelectionLangs,
  type SelectionResultItem,
} from "../../content/translate-select";
import { t } from "../i18n";

/** Транспорт invoke (в юнит-тестах подменяется фейком — паттерн duo/session). */
export type SelectionInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Порты конвейера перевода (тесты подменяют). */
export interface MobileSelectionPorts {
  translate(text: string, target: string, source: string): Promise<{ translation: string; detected: string }>;
  /** Последние выбранные языки ([] — не задано, берём [«ru»]). */
  loadTargets(): string[];
  saveTargets(targets: string[]): void;
}

/** Диагностика стендов (window.__duopulseMobileTranslate). */
export interface MobileSelectionState {
  /** Виден ли чип «Перевести» у выделения. */
  chip: boolean;
  /** Виден ли бабл перевода. */
  visible: boolean;
  /** Открыт ли лист «Перевести текст…». */
  sheet: boolean;
  /** Основная цель (последняя выбранная; подпись меню и листа). */
  target: string;
  /** Все цели текущего бабла (duopulse-116). */
  targets: string[];
  /** Источник текущего бабла ("auto" — автоопределение). */
  source: string;
  /** Ждём результат. */
  pending: boolean;
  /** Последняя ошибка конвейера ("" — не было). */
  lastError: string;
}

const TARGET_KEY = "duopulse.mobile.translateTarget";

/** Языки из localStorage (список через запятую) → коды SELECTION_LANGS
 * без дублей или [«ru»] (дефолт десктопа). */
export function normalizeTargets(raw: string): string[] {
  const valid = SELECTION_LANGS.map((l) => l.code);
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const code = part.trim();
    if (valid.includes(code) && !out.includes(code)) {
      out.push(code);
      if (out.length >= MAX_SELECTION_TARGETS) break;
    }
  }
  return out.length > 0 ? out : ["ru"];
}

/** Порты на tauri-командах (invoke + localStorage; incognito — не писать). */
export function createSelectionPorts(
  invoke: SelectionInvoke,
  incognito: () => boolean = () => false,
): MobileSelectionPorts {
  return {
    async translate(text, target, source) {
      const r = (await invoke("duo_translate_selection", { text, target, source })) as {
        translation?: unknown;
        detected?: unknown;
      };
      if (typeof r?.translation !== "string" || !r.translation) {
        throw new Error(t("пустой ответ конвейера"));
      }
      return {
        translation: r.translation,
        detected: typeof r.detected === "string" ? r.detected : "",
      };
    },
    loadTargets() {
      try {
        return normalizeTargets(localStorage.getItem(TARGET_KEY) ?? "");
      } catch {
        return ["ru"]; // localStorage недоступен — дефолт сессии
      }
    },
    saveTargets(targets) {
      try {
        if (!incognito()) localStorage.setItem(TARGET_KEY, targets.join(","));
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
 * (перевод перевода по кругу). null — выделения нет/пусто.
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
 * (TranslateBubble content-модуля), лист ручного ввода из меню «⋮». Языки —
 * источник + список целей на бабл (последние выбранные, localStorage),
 * смена селектов/чипов бабла перезапускает конвейер с эхом оригинала.
 */
export class MobileSelectionTranslate {
  private readonly bubble: TranslateBubble;
  private chip: HTMLButtonElement | null = null;
  private sheet: HTMLElement | null = null;
  private cached: ReadSelection = { text: "", anchor: { x: 16, y: 16 } };
  private original = "";
  private langs: SelectionLangs;
  /** Токен актуального прогона: устаревшие ответы (языки сменили/бабл
   * закрыли) не трогают бабл. */
  private runToken = 0;
  private state: MobileSelectionState = {
    chip: false,
    visible: false,
    sheet: false,
    target: "ru",
    targets: ["ru"],
    source: SOURCE_AUTO,
    pending: false,
    lastError: "",
  };
  private detach: (() => void) | null = null;

  constructor(
    private readonly doc: Document,
    private readonly ports: MobileSelectionPorts,
  ) {
    const loaded = ports.loadTargets();
    this.langs = { source: SOURCE_AUTO, targets: loaded.length > 0 ? loaded : ["ru"] };
    this.state = {
      ...this.state,
      target: this.primary(this.langs),
      targets: [...this.langs.targets],
    };
    this.bubble = new TranslateBubble(
      doc,
      (langs) => this.onLangsChange(langs),
      () => this.closeBubble(),
    );
  }

  /** Основная цель — последняя выбранная (подписи, статус, e2e). */
  private primary(langs: SelectionLangs): string {
    return langs.targets[langs.targets.length - 1] ?? "ru";
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
    return { ...this.state, targets: [...this.state.targets] };
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
    chip.textContent = t("Перевести");
    chip.setAttribute("aria-label", t("Перевести выделение"));
    // pointerdown, не click: тап по кнопке уводит фокус и ручки выделения
    // схлопываются ДО click — preventDefault держит и фокус, и событие
    chip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.hideChip();
      void this.run(this.cached.text, this.langs, this.cached.anchor);
    });
    this.doc.body.appendChild(chip);
    this.chip = chip;
    return chip;
  }

  /** Прогон конвейера: бабл «Переводим…» → перевод на каждую цель
   * (последовательно — бюджет gtx мал) → результат/ошибки по языкам. */
  private async run(text: string, langs: SelectionLangs, anchor: AnchorPoint): Promise<void> {
    const token = ++this.runToken;
    this.original = text;
    this.langs = langs;
    this.bubble.show(anchor, langs);
    this.state = {
      ...this.state,
      visible: true,
      target: this.primary(langs),
      targets: [...langs.targets],
      source: langs.source,
      pending: true,
    };
    const items: SelectionResultItem[] = [];
    let lastError = "";
    for (const target of langs.targets) {
      try {
        const r = await this.ports.translate(text, target, langs.source);
        items.push({ target, ok: true, translation: r.translation, detected: r.detected });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        lastError = message;
        items.push({ target, ok: false, error: message });
      }
    }
    // устаревший ответ (языки сменили/бабл закрыли) — мимо
    if (!this.bubble.visible || token !== this.runToken) return;
    if (items.length === 1 && !items[0].ok) {
      this.bubble.setError(items[0].error ?? t("нет ответа"));
    } else {
      this.bubble.setResult(text, items, langs);
    }
    this.state = {
      ...this.state,
      visible: true,
      pending: false,
      lastError: lastError || this.state.lastError,
    };
  }

  /** Смена источника/целей в бабле: помним выбор, повтор с эхом оригинала. */
  private onLangsChange(langs: SelectionLangs): void {
    if (!this.original) return; // ещё нечего переводить
    this.langs = langs;
    this.ports.saveTargets(langs.targets);
    this.state = {
      ...this.state,
      target: this.primary(langs),
      targets: [...langs.targets],
      source: langs.source,
    };
    const anchor = { ...this.cached.anchor };
    void this.run(this.original, langs, anchor);
  }

  private closeBubble(): void {
    this.runToken++; // летящие ответы закрывающегося бабла не догонят
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
      <div class="m-tr-sheet" role="dialog" aria-label="${t("Перевод текста")}">
        <div class="m-tr-head">
          <b>${t("Перевод текста")}</b>
          <button type="button" class="m-tr-close" aria-label="${t("Закрыть")}">✕</button>
        </div>
        <textarea class="m-tr-input" rows="3" dir="auto" placeholder="${t("Вставьте или введите текст")}"></textarea>
        <div class="m-tr-row">
          <select class="m-tr-lang" aria-label="${t("Язык перевода")}"></select>
          <button type="button" class="m-tr-go">${t("Перевести")}</button>
        </div>
        <div class="m-tr-meta" hidden></div>
        <div class="m-tr-result" hidden></div>
      </div>`;
    const sel = wrap.querySelector<HTMLSelectElement>(".m-tr-lang")!;
    for (const l of SELECTION_LANGS) {
      const opt = doc.createElement("option");
      opt.value = l.code;
      opt.textContent = l.name;
      opt.selected = l.code === this.primary(this.langs);
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
        result.textContent = t("Введите текст для перевода");
        meta.hidden = true;
        return;
      }
      const target = sel.value;
      this.ports.saveTargets([target]);
      this.langs = { ...this.langs, targets: [target] };
      this.state = { ...this.state, sheet: true, target, targets: [target], pending: true };
      go.disabled = true;
      go.textContent = t("Переводим…");
      result.hidden = true;
      meta.hidden = true;
      void (async () => {
        try {
          const r = await this.ports.translate(text, target, SOURCE_AUTO);
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
          result.textContent = t("Не получилось: {message}", { message });
          this.state = { ...this.state, lastError: message, pending: false };
        } finally {
          go.disabled = false;
          go.textContent = t("Перевести");
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
