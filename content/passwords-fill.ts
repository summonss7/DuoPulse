// Жизненный цикл паролей в странице (этап 2 duopulse-108): детект формы
// логина, кандидат «Сохранить пароль?» по сабмиту и автозаполнение по клику.
//
// Канал — WebMessage (content/messaging): «password-candidate» по сабмиту
// (Core решает, показывать ли бар, — пароль живёт только в Core), ответ на
// «passwords-lookup» — список логинов сайта (без паролей), «passwords-fill»
// по клику на поле — пароль выбранного логина. Origin всегда считает Core
// по URL вкладки: страница получает пароли только своего сайта.
//
// Инкогнито (маркер window.__DUOPULSE_INCOGNITO__, карточка duopulse-096) —
// модуль пассивен: не предлагает сохранить и не заполняет.
//
// DOM- chooser нескольких аккаунтов — только CSSOM (паттерн баббла
// translate-select): теневая плашка у поля, клики по пунктам. Вне WebView2
// (jsdom-тесты, обычный браузер) канала Core нет — модуль не мешает странице.

import { onCoreMessage } from "./messaging";

/** Порты для юнит-тестов (happy-dom без window.chrome.webview). */
export interface PasswordFillPorts {
  post(message: Record<string, unknown>): void;
}

/** Диагностика стендов (window.__duopulseContent.passwords). */
export interface PasswordFillStatus {
  /** Инкогнито: модуль пассивен (не сохраняет и не заполняет). */
  incognito: boolean;
  /** Найдено полей пароля (формы логина). */
  passFields: number;
  /** Логины сайта от Core (автозаполнение доступно, когда непусто). */
  accounts: string[];
  /** Сигнатура последнего отправленного кандидата ("" — не было). */
  lastCandidate: string;
  /** Логин последнего заполнения ("" — не было). */
  lastFilled: string;
  /** Открыт ли chooser нескольких аккаунтов. */
  chooserVisible: boolean;
}

/** Пара полей формы логина: логин (может не быть) + пароль. */
interface LoginPair {
  user: HTMLInputElement | null;
  pass: HTMLInputElement;
}

/** Поля, которые могут быть логином (не пароль и не служебные типы). */
function isUsernameInput(el: Element): el is HTMLInputElement {
  if (!(el instanceof HTMLInputElement)) return false;
  const t = el.type.toLowerCase();
  return t === "text" || t === "email" || t === "tel" || t === "url" || t === "";
}

/** Поиск поля логина для поля пароля: последнее текстовое поле ДО него —
 *  в общей форме (порядок элементов) или в документе (форма не обязательна:
 *  SPA-логины без <form>). Регистрация с confirm-полем не ломает: берём
 *  поле до ПЕРВОГО поля пароля — там логин и живёт. */
export function usernameFieldFor(pass: HTMLInputElement): HTMLInputElement | null {
  const scope: ParentNode = pass.form ?? pass.ownerDocument;
  const inputs = Array.from(scope.querySelectorAll("input"));
  const passIx = inputs.indexOf(pass);
  let best: HTMLInputElement | null = null;
  for (const u of inputs) {
    if (isUsernameInput(u) && inputs.indexOf(u) < passIx) best = u;
  }
  return best;
}

/** Установить значение input «по-настоящему» (site-JS видит input/change):
 *  нативный сеттер прототипа — React/Vue-страницы не глотают значение. */
function setInputValue(el: HTMLInputElement, value: string): void {
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  desc?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Контроллер паролей документа: сканер форм логина (MutationObserver — SPA
 * рисуют формы когда вздумает), отправка кандидата по сабмиту (submit /
 * Enter в пароле / клик по сабмит-кнопке; дедуп по сигнатуре), выборка
 * логинов сайта и заполнение по клику: один аккаунт — сразу, несколько —
 * chooser у поля. start() идемпотентен.
 */
export class PasswordFill {
  private pairs: LoginPair[] = [];
  private accounts: string[] = [];
  private origin = "";
  private lastSignature = "";
  private lastFilled = "";
  private lastFocusedPair: LoginPair | null = null;
  private chooser: HTMLDivElement | null = null;
  private lookupSent = false;
  private observer: MutationObserver | null = null;
  private scanTimer: number | null = null;
  private detach: (() => void) | null = null;
  private readonly status: PasswordFillStatus;

  constructor(
    private readonly doc: Document,
    private readonly ports: PasswordFillPorts,
    incognito: boolean,
  ) {
    this.status = {
      incognito,
      passFields: 0,
      accounts: [],
      lastCandidate: "",
      lastFilled: "",
      chooserVisible: false,
    };
  }

  /** Слушатели документа; в инкогнито — пассивен (ничего не вешаем). */
  start(): void {
    if (this.detach || this.status.incognito) return;
    const onSubmit = (e: Event): void => {
      const form = e.target as HTMLElement | null;
      const pair = this.pairs.find((p) => form?.contains(p.pass));
      if (pair) this.collectCandidate(pair);
    };
    const onKey = (e: Event): void => {
      const ke = e as KeyboardEvent;
      if (ke.key !== "Enter") return;
      const pair = this.pairOf(ke.target);
      if (pair) this.collectCandidate(pair);
    };
    const onClick = (e: Event): void => {
      const pair = this.pairOf(e.target);
      if (pair) {
        this.collectCandidate(pair);
        this.onFieldActivated(pair, e);
      } else if (this.chooser && !this.chooser.contains(e.target as Node)) {
        this.closeChooser();
      }
    };
    const onFocus = (e: Event): void => {
      const pair = this.pairOf(e.target);
      if (pair) this.onFieldActivated(pair, e);
    };
    this.doc.addEventListener("submit", onSubmit, true);
    this.doc.addEventListener("keydown", onKey, true);
    this.doc.addEventListener("click", onClick, true);
    this.doc.addEventListener("focusin", onFocus, true);
    const offCore = onCoreMessage((msg) => this.onCoreMessage(msg));
    this.detach = () => {
      this.doc.removeEventListener("submit", onSubmit, true);
      this.doc.removeEventListener("keydown", onKey, true);
      this.doc.removeEventListener("click", onClick, true);
      this.doc.removeEventListener("focusin", onFocus, true);
      offCore();
      this.detach = null;
    };
    // сканер: старт + пересканирование по мере дорисовки DOM (SPA).
    // Initialization-скрипт исполняется до <html> (documentElement нет) —
    // наблюдатель вешаем по готовности документа (ловушка e2e-стенда).
    const beginScan = (): void => {
      this.scan();
      this.observer = new MutationObserver(() => this.scheduleScan());
      this.observer.observe(this.doc.documentElement, { childList: true, subtree: true });
    };
    if (this.doc.documentElement) beginScan();
    else
      this.doc.addEventListener(
        "readystatechange",
        () => {
          if (this.doc.documentElement && this.observer === null) beginScan();
        },
        { once: true },
      );
  }

  /** Диагностика (window.__duopulseContent.passwords). */
  state(): PasswordFillStatus {
    this.status.passFields = this.pairs.length;
    this.status.accounts = [...this.accounts];
    this.status.lastCandidate = this.lastSignature;
    this.status.lastFilled = this.lastFilled;
    this.status.chooserVisible = this.chooser !== null;
    return { ...this.status };
  }

  /** Пара для цели события: само поле логина/пароля либо сабмит-контрол
   *  (кнопка) её формы/контейнера. Клик по прочей странице — мимо. */
  private pairOf(target: EventTarget | null): LoginPair | null {
    const el = target as Element | null;
    if (!(el instanceof Element)) return null;
    const direct = this.pairs.find((p) => p.pass === el || p.user === el);
    if (direct) return direct;
    const submitish =
      el instanceof HTMLButtonElement ||
      (el instanceof HTMLInputElement && (el.type === "submit" || el.type === "button"));
    if (!submitish) return null;
    const inForm = this.pairs.find((p) => p.pass.form && el.closest("form") === p.pass.form);
    if (inForm) return inForm;
    // без <form>: кнопка в общем контейнере с паролем (SPA-логины)
    return this.pairs.find((p) => p.pass.closest("div,section,fieldset")?.contains(el)) ?? null;
  }

  /** Пересканирование форм (уступкой, всплеск DOM-мутаций не пересканирует). */
  private scheduleScan(): void {
    if (this.scanTimer !== null) return;
    this.scanTimer = this.doc.defaultView?.setTimeout(() => {
      this.scanTimer = null;
      this.scan();
    }, 300) ?? null;
  }

  /** Найти поля пароля и их поля логина; первый раз — запрос логинов сайта. */
  private scan(): void {
    if (this.status.incognito) return;
    const passes = Array.from(this.doc.querySelectorAll<HTMLInputElement>("input[type=password]"))
      .filter((el) => !el.disabled);
    this.pairs = passes.map((pass) => ({ user: usernameFieldFor(pass), pass }));
    if (this.pairs.length > 0 && !this.lookupSent) {
      this.lookupSent = true;
      // логины сайта (без паролей): Core отвечает, только когда есть чем заполнить
      this.ports.post({ duopulse: "passwords-lookup" });
    }
  }

  /** Сабмит: отправить кандидата в Core (дедуп по логину+паролю — повторные
   *  клики/Enter той же формы не спамят; смена пароля проходит как update). */
  private collectCandidate(pair: LoginPair): void {
    const username = (pair.user?.value ?? "").trim();
    const password = pair.pass.value ?? "";
    if (!username || !password) return; // пустое хранилище не примет — бара не будет
    const signature = `${username}|${password}`;
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    this.ports.post({
      duopulse: "password-candidate",
      url: this.doc.location?.href ?? "",
      title: this.doc.title ?? "",
      username,
      password,
    });
  }

  /** Клик/фокус на поле формы логина: есть логины сайта — заполняем (один) |
   *  выбираем (несколько). Выбор — тоже активация поля. */
  private onFieldActivated(pair: LoginPair, e: Event): void {
    this.lastFocusedPair = pair;
    if (this.accounts.length === 0) return;
    if (this.accounts.length === 1) {
      this.requestFill(this.accounts[0] as string);
      return;
    }
    // несколько аккаунтов — chooser у поля (не для повторного фокуса того же)
    const anchor = (e.target as Element) ?? pair.pass;
    this.showChooser(pair, anchor as HTMLElement);
  }

  /** Запросить пароль логина (клик по полю/пункту chooser). */
  private requestFill(username: string): void {
    this.ports.post({ duopulse: "passwords-fill", username });
  }

  private onCoreMessage(msg: Record<string, unknown>): void {
    if (msg["duopulse"] === "passwords-found") {
      const accounts = Array.isArray(msg["accounts"])
        ? msg["accounts"].filter((a): a is string => typeof a === "string")
        : [];
      this.origin = typeof msg["origin"] === "string" ? msg["origin"] : "";
      this.accounts = accounts;
    } else if (msg["duopulse"] === "passwords-fill-data") {
      const username = typeof msg["username"] === "string" ? msg["username"] : "";
      const password = typeof msg["password"] === "string" ? msg["password"] : "";
      if (!username || !password) return;
      const pair = this.lastFocusedPair ?? this.pairs[0];
      if (!pair) return;
      if (pair.user) setInputValue(pair.user, username);
      setInputValue(pair.pass, password);
      this.lastFilled = username;
    }
  }

  /** Мини-chooser аккаунтов у поля (CSSOM, как баббл перевода выделения). */
  private showChooser(pair: LoginPair, anchor: HTMLElement): void {
    this.closeChooser();
    const doc = this.doc;
    const root = doc.createElement("div");
    root.setAttribute("data-duopulse-accounts", "1");
    const s = root.style;
    s.position = "fixed";
    s.zIndex = "2147483647";
    s.minWidth = "180px";
    s.maxWidth = "min(320px, calc(100vw - 16px))";
    s.padding = "4px";
    s.borderRadius = "8px";
    s.border = "1px solid rgba(189,254,79,0.25)";
    s.background = "rgba(10,14,23,0.96)";
    s.boxShadow = "0 8px 24px rgba(0,0,0,0.4)";
    s.fontFamily = "Inter, 'Segoe UI', system-ui, sans-serif";
    s.color = "#E8EDF2";
    for (const username of this.accounts) {
      const item = doc.createElement("div");
      item.textContent = username;
      const is = item.style;
      is.padding = "6px 10px";
      is.borderRadius = "6px";
      is.fontSize = "13px";
      is.cursor = "pointer";
      is.whiteSpace = "nowrap";
      is.overflow = "hidden";
      is.textOverflow = "ellipsis";
      item.addEventListener("mouseenter", () => {
        is.background = "rgba(189,254,79,0.14)";
      });
      item.addEventListener("mouseleave", () => {
        is.background = "transparent";
      });
      item.addEventListener("click", () => {
        this.lastFocusedPair = pair;
        this.requestFill(username);
        this.closeChooser();
      });
      root.append(item);
    }
    doc.documentElement.append(root);
    // позиция: под якорем, не выезжая за низ вьюпорта
    const r = anchor.getBoundingClientRect();
    const vh = doc.defaultView?.innerHeight ?? 0;
    const h = root.offsetHeight || 90;
    let y = r.bottom + 6;
    if (vh > 0 && y + h > vh - 8) y = Math.max(8, r.top - h - 6);
    s.left = `${Math.max(8, Math.round(r.left))}px`;
    s.top = `${Math.round(y)}px`;
    this.chooser = root;
  }

  private closeChooser(): void {
    this.chooser?.remove();
    this.chooser = null;
  }
}

/** Установить модуль паролей в документ (вызов из duopulse-content.ts). */
export function installPasswordFill(ports: PasswordFillPorts): PasswordFill {
  const incognito =
    (window as unknown as { __DUOPULSE_INCOGNITO__?: number }).__DUOPULSE_INCOGNITO__ === 1;
  const fill = new PasswordFill(document, ports, incognito);
  fill.start();
  return fill;
}
