// Юнит-тесты перевода выделенного текста (карточка duopulse-098): канал
// Core → бабл (begin/result/ошибка), смена языка (эхо-запрос), закрытие
// (×, клик мимо, Esc), якорь по выделению/клику. DOM — happy-dom; канал
// Core отсутствует (нет window.chrome.webview) — контроллер получает
// сообщения напрямую через onCoreMessage-обработчик, перехваченный тут же.
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SelectionTranslate, SELECTION_LANGS, selectionLangName } from "./translate-select";
import type { AnchorPoint } from "./translate-select";

/** Перехват onCoreMessage: content/messaging в happy-dom без канала —
 * слушатель не ставится; дергаем сами (тот же контракт, что у Core). */
let coreListeners: ((m: Record<string, unknown>) => void)[] = [];

vi.mock("./messaging", () => ({
  onCoreMessage: (h: (m: Record<string, unknown>) => void): (() => void) => {
    coreListeners.push(h);
    return () => {
      coreListeners = coreListeners.filter((x) => x !== h);
    };
  },
  postToCore: (): void => {},
}));

function postFromCore(msg: Record<string, unknown>): void {
  for (const h of [...coreListeners]) h(msg);
}

interface Harness {
  ctrl: SelectionTranslate;
  posted: Record<string, unknown>[];
}

/** Документ с выделением «hello world» (rect имитирует конец выделения). */
function makeHarness(anchor?: AnchorPoint): Harness {
  const posted: Record<string, unknown>[] = [];
  const ctrl = new SelectionTranslate(document, { post: (m) => posted.push(m) });
  ctrl.start();
  if (anchor) {
    document.dispatchEvent(
      new MouseEvent("contextmenu", { clientX: anchor.x, clientY: anchor.y }),
    );
  }
  return { ctrl, posted };
}

function selectTextInBody(): void {
  const p = document.createElement("p");
  p.textContent = "hello world";
  document.body.append(p);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents(p);
  sel?.addRange(range);
}

beforeEach(() => {
  document.body.innerHTML = "";
  // баблы живут на documentElement — переживают body-очистку, снимаем сами
  document.documentElement
    .querySelectorAll("[data-duopulse-translate]")
    .forEach((n) => n.remove());
  coreListeners = [];
});

describe("SELECTION_LANGS", () => {
  it("ru первый, дефолт меню Core", () => {
    expect(SELECTION_LANGS[0]?.code).toBe("ru");
    expect(selectionLangName("ru")).toBe("Русский");
    expect(selectionLangName("??")).toBe("??");
  });
});

describe("канал Core → бабл", () => {
  it("begin показывает «Переводим…» с языком из меню", () => {
    const { ctrl } = makeHarness({ x: 40, y: 60 });
    postFromCore({ duopulse: "translate-selection-begin", reqId: 1, target: "ru" });
    expect(ctrl.state()).toMatchObject({ visible: true, target: "ru", pending: true });
    const root = document.querySelector("[data-duopulse-translate]");
    expect(root?.textContent).toContain("Переводим…");
  });

  it("result заполняет перевод, оригинал и детект «en → ru»", () => {
    const { ctrl } = makeHarness({ x: 40, y: 60 });
    postFromCore({ duopulse: "translate-selection-begin", reqId: 1, target: "ru" });
    postFromCore({
      duopulse: "translate-selection-result",
      reqId: 1,
      ok: true,
      target: "ru",
      detected: "en",
      translation: "привет мир",
      original: "hello world",
    });
    const root = document.querySelector("[data-duopulse-translate]");
    expect(root?.textContent).toContain("привет мир");
    expect(root?.textContent).toContain("hello world");
    expect(root?.textContent).toContain("en → ru");
    expect(ctrl.state()).toMatchObject({ visible: true, target: "ru", pending: false });
  });

  it("ошибка конвейера — текст ошибки в бабле, lastError в статусе", () => {
    const { ctrl } = makeHarness({ x: 40, y: 60 });
    postFromCore({ duopulse: "translate-selection-begin", reqId: 1, target: "ru" });
    postFromCore({
      duopulse: "translate-selection-result",
      reqId: 1,
      ok: false,
      target: "ru",
      error: "сеть недоступна",
    });
    const root = document.querySelector("[data-duopulse-translate]");
    expect(root?.textContent).toContain("Не получилось: сеть недоступна");
    expect(ctrl.state().lastError).toBe("сеть недоступна");
  });

  it("устаревший ответ (язык сменился) не затирает новый запрос", () => {
    const { ctrl, posted } = makeHarness({ x: 40, y: 60 });
    postFromCore({ duopulse: "translate-selection-begin", reqId: 1, target: "ru" });
    postFromCore({
      duopulse: "translate-selection-result",
      reqId: 1,
      ok: true,
      target: "ru",
      detected: "en",
      translation: "привет",
      original: "hi",
    });
    // пользователь переключил язык в селекте бабла
    const select = document.querySelector("[data-duopulse-translate] select") as HTMLSelectElement;
    select.value = "de";
    select.dispatchEvent(new Event("change"));
    expect(ctrl.state()).toMatchObject({ target: "de", pending: true });
    expect(posted[posted.length - 1]).toMatchObject({
      duopulse: "translate-selection",
      text: "hi",
      target: "de",
    });
    // поздний ответ старого запроса (ru) — мимо
    postFromCore({
      duopulse: "translate-selection-result",
      reqId: 1,
      ok: true,
      target: "ru",
      detected: "en",
      translation: "привет (старый)",
      original: "hi",
    });
    const root = document.querySelector("[data-duopulse-translate]");
    expect(root?.textContent).toContain("Переводим…"); // ждём de, старое не вписалось
  });

  it("ответ после закрытия бабла игнорируется", () => {
    const { ctrl } = makeHarness({ x: 40, y: 60 });
    postFromCore({ duopulse: "translate-selection-begin", reqId: 1, target: "ru" });
    ctrl.close();
    postFromCore({
      duopulse: "translate-selection-result",
      reqId: 1,
      ok: true,
      target: "ru",
      translation: "привет",
      original: "hi",
    });
    expect(document.querySelector("[data-duopulse-translate]")).toBeNull();
  });
});

describe("смена языка", () => {
  it("пока первый перевод не пришёл, селект заблокирован и запросов нет", () => {
    const { posted } = makeHarness({ x: 40, y: 60 });
    postFromCore({ duopulse: "translate-selection-begin", reqId: 1, target: "ru" });
    const select = document.querySelector("[data-duopulse-translate] select") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    select.value = "en";
    select.dispatchEvent(new Event("change"));
    expect(posted.filter((m) => m["duopulse"] === "translate-selection")).toHaveLength(0);
  });

  it("после результата смена языка шлёт эхо-запрос с reqId", () => {
    const { posted } = makeHarness({ x: 40, y: 60 });
    postFromCore({ duopulse: "translate-selection-begin", reqId: 7, target: "ru" });
    postFromCore({
      duopulse: "translate-selection-result",
      reqId: 7,
      ok: true,
      target: "ru",
      translation: "привет",
      original: "hello",
    });
    const select = document.querySelector("[data-duopulse-translate] select") as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    select.value = "fr";
    select.dispatchEvent(new Event("change"));
    const req = posted.find((m) => m["duopulse"] === "translate-selection");
    expect(req).toMatchObject({ text: "hello", target: "fr" });
    expect(typeof req?.["reqId"]).toBe("number");
  });
});

describe("закрытие бабла", () => {
  it("кнопка ×", () => {
    const { ctrl } = makeHarness({ x: 40, y: 60 });
    postFromCore({ duopulse: "translate-selection-begin", reqId: 1, target: "ru" });
    (document.querySelector("[data-duopulse-translate] button") as HTMLButtonElement).click();
    expect(ctrl.state().visible).toBe(false);
    expect(document.querySelector("[data-duopulse-translate]")).toBeNull();
  });

  it("Esc и клик мимо", () => {
    const { ctrl } = makeHarness({ x: 40, y: 60 });
    postFromCore({ duopulse: "translate-selection-begin", reqId: 1, target: "ru" });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(ctrl.state().visible).toBe(false);

    postFromCore({ duopulse: "translate-selection-begin", reqId: 2, target: "ru" });
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(ctrl.state().visible).toBe(false);
  });

  it("клик по самому баблу не закрывает", () => {
    const { ctrl } = makeHarness({ x: 40, y: 60 });
    postFromCore({ duopulse: "translate-selection-begin", reqId: 1, target: "ru" });
    const root = document.querySelector("[data-duopulse-translate]") as HTMLDivElement;
    root.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(ctrl.state().visible).toBe(true);
  });
});

describe("якорь бабла", () => {
  it("по живому выделению (конец прямоугольника)", () => {
    const { ctrl } = makeHarness({ x: 400, y: 300 });
    selectTextInBody();
    postFromCore({ duopulse: "translate-selection-begin", reqId: 1, target: "ru" });
    expect(ctrl.state().visible).toBe(true);
    const root = document.querySelector("[data-duopulse-translate]") as HTMLDivElement;
    // happy-dom rect нулевой — клампы вытащат координату клика; главное — показан
    expect(root.style.left).not.toBe("");
  });

  it("по клику правой кнопкой, когда выделения нет", () => {
    const { ctrl } = makeHarness({ x: 40, y: 60 });
    postFromCore({ duopulse: "translate-selection-begin", reqId: 1, target: "ru" });
    const root = document.querySelector("[data-duopulse-translate]") as HTMLDivElement;
    const left = Number.parseFloat(root.style.left);
    const top = Number.parseFloat(root.style.top);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThan(60); // под точкой клика
  });
});
