// Юнит-тесты перевода выделенного текста (карточки duopulse-098/116): канал
// Core → бабл (begin/result/ошибка, несколько целевых языков и источник),
// смена языков (эхо-запрос: замена/добавление цели, чип «×», источник),
// закрытие (×, клик мимо, Esc), якорь по выделению/клику. DOM — happy-dom;
// канал Core отсутствует (нет window.chrome.webview) — контроллер получает
// сообщения напрямую через onCoreMessage-обработчик, перехваченный тут же.
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SelectionTranslate,
  SELECTION_LANGS,
  parseSelectionLangs,
  selectionLangName,
} from "./translate-select";
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
  document.documentElement.querySelectorAll("[data-duopulse-translate]").forEach((n) => n.remove());
  coreListeners = []; // контроллеры прошлых тестов не слушают новый документ
});

describe("SELECTION_LANGS", () => {
  it("ru первый, дефолт меню Core", () => {
    expect(SELECTION_LANGS[0].code).toBe("ru");
    expect(selectionLangName("ro")).toBe("Română");
  });
});

describe("parseSelectionLangs", () => {
  it("берёт targets+source, чистит мусор и дубли, режет лимит", () => {
    const langs = parseSelectionLangs({
      targets: ["ru", "xx", "ru", "ro", "de", "fr"],
      source: "en",
    });
    expect(langs.targets).toEqual(["ru", "ro", "de", "fr"]); // лимит 4
    expect(langs.source).toBe("en");
  });

  it("фолбэк поля target и дефолты", () => {
    expect(parseSelectionLangs({ target: "de" })).toEqual({ source: "auto", targets: ["de"] });
    expect(parseSelectionLangs({})).toEqual({ source: "auto", targets: ["ru"] });
    expect(parseSelectionLangs({ targets: ["xx"], source: "zz" })).toEqual({
      source: "auto",
      targets: ["ru"],
    });
  });
});

describe("канал Core → бабл", () => {
  it("begin показывает «Переводим…» с языками из меню", () => {
    const { ctrl } = makeHarness();
    postFromCore({
      duopulse: "translate-selection-begin",
      reqId: 7,
      source: "auto",
      targets: ["ru", "ro"],
    });
    const bubble = document.querySelector("[data-duopulse-translate]")!;
    expect(bubble.textContent).toContain("Переводим…");
    expect(ctrl.state()).toMatchObject({
      visible: true,
      source: "auto",
      targets: ["ru", "ro"],
      pending: true,
    });
    // пока переводим — селекты заблокированы и запросов нет
    const select = bubble.querySelector("select") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(
      (bubble.querySelector('select[aria-label="Язык оригинала"]') as HTMLSelectElement).disabled,
    ).toBe(true);
  });

  it("result рендерит перевод на каждый язык, эхо оригинала и детект", () => {
    const { ctrl } = makeHarness();
    postFromCore({ duopulse: "translate-selection-begin", reqId: 7, targets: ["ru", "ro"] });
    postFromCore({
      duopulse: "translate-selection-result",
      reqId: 7,
      ok: true,
      original: "hello world",
      items: [
        { target: "ru", ok: true, translation: "привет мир", detected: "en" },
        { target: "ro", ok: true, translation: "salut lumea", detected: "en" },
      ],
    });
    const bubble = document.querySelector("[data-duopulse-translate]")!;
    expect(bubble.textContent).toContain("hello world");
    expect(bubble.textContent).toContain("привет мир");
    expect(bubble.textContent).toContain("salut lumea");
    expect(bubble.textContent).toContain("en → ru"); // детект → цель
    expect(ctrl.state()).toMatchObject({ pending: false, targets: ["ru", "ro"] });
  });

  it("частичная ошибка живёт в своей строке, не глушит второй язык", () => {
    makeHarness();
    postFromCore({ duopulse: "translate-selection-begin", reqId: 7, targets: ["ru", "de"] });
    postFromCore({
      duopulse: "translate-selection-result",
      reqId: 7,
      ok: true,
      original: "hello",
      items: [
        { target: "ru", ok: true, translation: "привет", detected: "en" },
        { target: "de", ok: false, error: "слишком много запросов" },
      ],
    });
    const bubble = document.querySelector("[data-duopulse-translate]")!;
    expect(bubble.textContent).toContain("привет");
    expect(bubble.textContent).toContain("Не получилось: слишком много запросов");
  });

  it("общая ошибка конвейера (кулдаун) — текст ошибки в бабле", () => {
    const { ctrl } = makeHarness();
    postFromCore({ duopulse: "translate-selection-begin", reqId: 7, targets: ["ru"] });
    postFromCore({
      duopulse: "translate-selection-result",
      reqId: 7,
      ok: false,
      error: "бесплатный сервис перевода просит подождать ~118 с",
    });
    const bubble = document.querySelector("[data-duopulse-translate]")!;
    expect(bubble.textContent).toContain("Не получилось");
    expect(bubble.textContent).toContain("подождать");
    expect(ctrl.state().lastError).toContain("подождать");
  });

  it("устаревший ответ (reqId не тот) не затирает новый запрос", () => {
    const { posted } = makeHarness();
    postFromCore({ duopulse: "translate-selection-begin", reqId: 7, targets: ["ru"] });
    postFromCore({
      duopulse: "translate-selection-result",
      reqId: 7,
      ok: true,
      original: "hello",
      items: [{ target: "ru", ok: true, translation: "привет", detected: "en" }],
    });
    const bubble = document.querySelector("[data-duopulse-translate]")!;
    // смена языка — собственный reqId контроллера
    const select = bubble.querySelector("select") as HTMLSelectElement;
    select.value = "en";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(bubble.textContent).toContain("Переводим…");
    // ответ на СТАРЫЙ reqId меню — мимо, бабл ждёт собственный
    postFromCore({
      duopulse: "translate-selection-result",
      reqId: 7,
      ok: true,
      original: "hello",
      items: [{ target: "ru", ok: true, translation: "старый ответ", detected: "en" }],
    });
    expect(bubble.textContent).toContain("Переводим…");
    expect(bubble.textContent).not.toContain("старый ответ");
    // собственный reqId — принимается
    const own = posted[0]["reqId"] as number;
    postFromCore({
      duopulse: "translate-selection-result",
      reqId: own,
      ok: true,
      original: "hello",
      items: [{ target: "en", ok: true, translation: "hello itself", detected: "en" }],
    });
    expect(document.querySelector("[data-duopulse-translate]")!.textContent).toContain(
      "hello itself",
    );
  });

  it("ответ после закрытия бабла игнорируется", () => {
    makeHarness();
    postFromCore({ duopulse: "translate-selection-begin", reqId: 7, targets: ["ru"] });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    postFromCore({
      duopulse: "translate-selection-result",
      reqId: 7,
      ok: true,
      original: "hello",
      items: [{ target: "ru", ok: true, translation: "привет", detected: "en" }],
    });
    expect(document.querySelector("[data-duopulse-translate]")).toBeNull();
  });
});

describe("смена языков (эхо-запрос)", () => {
  function withResult(targets: string[], source = "auto"): Harness {
    const h = makeHarness();
    postFromCore({
      duopulse: "translate-selection-begin",
      reqId: 7,
      source,
      targets,
    });
    postFromCore({
      duopulse: "translate-selection-result",
      reqId: 7,
      ok: true,
      original: "hello world",
      items: targets.map((t) => ({
        target: t,
        ok: true,
        translation: `[${t}] hello world`,
        detected: "en",
      })),
    });
    return h;
  }

  it("пока первый перевод не пришёл, селект заблокирован и запросов нет", () => {
    const { posted } = makeHarness();
    postFromCore({ duopulse: "translate-selection-begin", reqId: 7, targets: ["ru"] });
    const select = document.querySelector(
      "[data-duopulse-translate] select",
    ) as HTMLSelectElement;
    select.value = "en";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(posted).toEqual([]);
  });

  it("смена селекта добавляет язык к активным, запрос с эхом оригинала", () => {
    const { posted } = withResult(["ru"]);
    const select = document.querySelector(
      "[data-duopulse-translate] select",
    ) as HTMLSelectElement;
    select.value = "en";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      duopulse: "translate-selection",
      text: "hello world",
      source: "auto",
      targets: ["ru", "en"],
    });
    expect(typeof posted[0]["reqId"]).toBe("number");
  });

  it("несколько целей: смена селекта — добавление языка, чип «×» убирает", () => {
    const { posted } = withResult(["ru", "ro"]);
    const select = document.querySelector(
      "[data-duopulse-translate] select",
    ) as HTMLSelectElement;
    select.value = "de";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(posted[0]).toMatchObject({ targets: ["ru", "ro", "de"] });
    // пока ответ не пришёл, чип заблокирован; ответим — и уберём язык
    postFromCore({
      duopulse: "translate-selection-result",
      reqId: posted[0]["reqId"],
      ok: true,
      original: "hello world",
      items: ["ru", "ro", "de"].map((t) => ({
        target: t,
        ok: true,
        translation: `[${t}] hello world`,
        detected: "en",
      })),
    });
    const x = document.querySelector(
      'button[aria-label="Убрать Română"]',
    ) as HTMLButtonElement;
    x.click();
    expect(posted[1]).toMatchObject({ targets: ["ru", "de"] });
    // единственный чип убрать нельзя
    const y = document.querySelector(
      'button[aria-label="Убрать Русский"]',
    ) as HTMLButtonElement;
    y.click();
    expect(posted).toHaveLength(2);
  });

  it("селект источника меняет source запроса", () => {
    const { posted } = withResult(["ru"]);
    const src = document.querySelector(
      '[data-duopulse-translate] select[aria-label="Язык оригинала"]',
    ) as HTMLSelectElement;
    src.value = "en";
    src.dispatchEvent(new Event("change", { bubbles: true }));
    expect(posted[0]).toMatchObject({ source: "en", targets: ["ru"] });
    // при явном источнике детект-метка не показывается (язык и так выбран)
    expect(document.querySelector("[data-duopulse-translate]")!.textContent).not.toContain(
      "en → ru",
    );
  });

  it("запрос уходит в загрузку («Переводим…») и статусы ведут языки", () => {
    const { ctrl } = withResult(["ru"]);
    const select = document.querySelector(
      "[data-duopulse-translate] select",
    ) as HTMLSelectElement;
    select.value = "ro";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(document.querySelector("[data-duopulse-translate]")!.textContent).toContain(
      "Переводим…",
    );
    expect(ctrl.state()).toMatchObject({ targets: ["ru", "ro"], pending: true });
  });
});

describe("закрытие бабла", () => {
  it("кнопка ×", () => {
    makeHarness();
    postFromCore({ duopulse: "translate-selection-begin", reqId: 7, targets: ["ru"] });
    (document.querySelector('button[aria-label="Закрыть перевод"]') as HTMLButtonElement).click();
    expect(document.querySelector("[data-duopulse-translate]")).toBeNull();
  });

  it("Esc и клик мимо", () => {
    makeHarness();
    postFromCore({ duopulse: "translate-selection-begin", reqId: 7, targets: ["ru"] });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector("[data-duopulse-translate]")).toBeNull();
    postFromCore({ duopulse: "translate-selection-begin", reqId: 8, targets: ["ru"] });
    document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(document.querySelector("[data-duopulse-translate]")).toBeNull();
  });

  it("клик по самому баблу не закрывает", () => {
    makeHarness();
    postFromCore({ duopulse: "translate-selection-begin", reqId: 7, targets: ["ru"] });
    const bubble = document.querySelector("[data-duopulse-translate]")!;
    bubble.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(document.querySelector("[data-duopulse-translate]")).not.toBeNull();
  });
});

describe("якорь бабла", () => {
  it("по живому выделению (конец прямоугольника)", () => {
    const { ctrl } = makeHarness({ x: 40, y: 40 });
    selectTextInBody();
    postFromCore({ duopulse: "translate-selection-begin", reqId: 7, targets: ["ru"] });
    const bubble = document.querySelector("[data-duopulse-translate]") as HTMLElement;
    expect(bubble.style.left).not.toBe("0px");
    expect(ctrl.state().visible).toBe(true);
  });

  it("по клику правой кнопкой, когда выделения нет", () => {
    makeHarness({ x: 200, y: 150 });
    postFromCore({ duopulse: "translate-selection-begin", reqId: 7, targets: ["ru"] });
    const bubble = document.querySelector("[data-duopulse-translate]") as HTMLElement;
    const left = Number.parseFloat(bubble.style.left);
    const top = Number.parseFloat(bubble.style.top);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThan(150); // под точкой клика
  });
});
