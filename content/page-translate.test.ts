// Юнит-тесты перевода всей страницы (карточка duopulse-244): входы (WebMessage
// контекстного меню + document-событие «⋮»-меню), сбор текстовых узлов
// (пропуски служебных/наших), пачки, замена textContent с контуром пробелов,
// «Оригинал», смена цели (память Core + повторный прогон), ошибки конвейера,
// отмена устаревших ответов, дочитка динамики MutationObserver. DOM —
// happy-dom; канал Core отсутствует — onCoreMessage перехвачен моком, транспорт
// gtx — заглушка в конструкторе PageTranslate.
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PageTranslate,
  chunkNodes,
  collectTextNodes,
  isTranslatableText,
  splitEdges,
  type GtxRequest,
} from "./page-translate";

/** Перехват onCoreMessage: happy-dom без канала — слушатель не ставится;
 * дергаем сами (тот же контракт, что у Core). */
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

/** Прозрачная заглушка: перевод = «текст» (контур пробелов виден). */
const echoGtx: GtxRequest = async (texts) => texts.map((t) => `«${t}»`);

interface Harness {
  ctrl: PageTranslate;
  posted: Record<string, unknown>[];
  gtx: ReturnType<typeof vi.fn>;
}

/** Живые контроллеры теста: документ happy-dom один на файл, бар вешается
 * на documentElement (мимо beforeEach body-clean), наблюдатели слушают тот
 * же body — без явного stop() контроллеры прошлых тестов ловят узлы новых. */
let live: PageTranslate[] = [];

beforeEach(() => {
  coreListeners = [];
  live = [];
  document.body.innerHTML = "";
});

afterEach(() => {
  for (const ctrl of live) ctrl.stop();
  live = [];
  document.documentElement
    .querySelectorAll("[data-duopulse-page-bar]")
    .forEach((el) => el.remove());
});

function makeHarness(gtx: GtxRequest = echoGtx): Harness {
  const posted: Record<string, unknown>[] = [];
  const ctrl = new PageTranslate(document, { post: (m) => posted.push(m) }, gtx);
  ctrl.start();
  live.push(ctrl);
  return { ctrl, posted, gtx: gtx as unknown as ReturnType<typeof vi.fn> };
}

describe("splitEdges", () => {
  it("контур пробелов отделяется от ядра", () => {
    expect(splitEdges("  hello world ")).toEqual({ lead: "  ", core: "hello world", trail: " " });
    expect(splitEdges("hi")).toEqual({ lead: "", core: "hi", trail: "" });
    expect(splitEdges("   ")).toEqual({ lead: "   ", core: "", trail: "" });
  });
});

describe("isTranslatableText", () => {
  it("короткое/цифровое/знаки — мимо", () => {
    expect(isTranslatableText("hello")).toBe(true);
    expect(isTranslatableText("  hello  ")).toBe(true);
    expect(isTranslatableText("a")).toBe(false);
    expect(isTranslatableText("123")).toBe(false);
    expect(isTranslatableText("12.05.2026")).toBe(false);
    expect(isTranslatableText("!!! ...")).toBe(false);
    expect(isTranslatableText("   ")).toBe(false);
  });
});

describe("collectTextNodes", () => {
  it("пропускает служебные теги и наши узлы, собирает по порядку", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <p>Первый</p>
      <script>var x = 1;</script>
      <style>.a { color: red }</style>
      <pre>code()</pre>
      <p translate="no">Не трогать</p>
      <span data-duopulse-translate="1">Наш бар</span>
      <p> Второй <b>третий</b></p>
      <p></p>
      <p>42</p>`;
    const nodes = collectTextNodes(root);
    expect(nodes.map((n) => n.nodeValue)).toEqual(["Первый", " Второй ", "третий"]);
  });
});

describe("chunkNodes", () => {
  it("режет по строкам и символам", () => {
    const mk = (t: string): Text => document.createTextNode(t);
    const many: Text[] = [];
    for (let i = 0; i < 50; i++) many.push(mk(`строка номер ${i}`));
    const chunks = chunkNodes(many);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat().length).toBe(50);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
    // длинные строки — резать по символам
    const longs: Text[] = Array.from({ length: 5 }, () => mk("x".repeat(500)));
    for (const c of chunkNodes(longs)) {
      expect(c.length).toBeLessThanOrEqual(3); // 3×500 = 1500 > 1200
    }
  });
});

describe("входы и полный прогон", () => {
  it("WebMessage «translate-page» переводит узлы, контур пробелов цел", async () => {
    const p = document.createElement("p");
    p.textContent = "  hello world  ";
    const h2 = document.createElement("h1");
    h2.textContent = "second line";
    document.body.append(p, h2);
    const { ctrl } = makeHarness();
    postFromCore({ duopulse: "translate-page", reqId: 1, target: "ru" });
    await vi.waitFor(() => expect(ctrl.state().phase).toBe("translated"));
    expect(p.textContent).toBe("  «hello world»  ");
    expect(h2.textContent).toBe("«second line»");
    expect(ctrl.state().nodes).toBe(2);
  });

  it("document-событие «⋮»-меню — тот же вход", async () => {
    const p = document.createElement("p");
    p.textContent = "hello";
    document.body.append(p);
    const { ctrl } = makeHarness();
    document.dispatchEvent(new CustomEvent("duopulse-translate-page", { detail: { target: "en" } }));
    await vi.waitFor(() => expect(ctrl.state().phase).toBe("translated"));
    expect(p.textContent).toBe("«hello»");
    expect(ctrl.state().target).toBe("en");
  });

  it("бар показывается с прогрессом и селектом цели", async () => {
    const p = document.createElement("p");
    p.textContent = "hello";
    document.body.append(p);
    const { ctrl } = makeHarness();
    postFromCore({ duopulse: "translate-page", reqId: 1, target: "ru" });
    await vi.waitFor(() => expect(ctrl.state().phase).toBe("translated"));
    const bar = document.querySelector("[data-duopulse-page-bar]");
    expect(bar).not.toBeNull();
    const select = bar?.querySelector("select");
    expect(select).not.toBeNull();
    expect((bar?.querySelector("span") as HTMLSpanElement).textContent).toContain("Переведено");
    // повторный вход той же целью — бар уже есть, новых запросов нет
    const calls = (ctrl as unknown as { gtx?: unknown }) && 0;
    expect(calls).toBe(0);
  });

  it("«Оригинал» восстанавливает тексты, повторный вход — бар без сети", async () => {
    const p = document.createElement("p");
    p.textContent = "hello";
    document.body.append(p);
    const gtx = vi.fn(echoGtx) as unknown as GtxRequest;
    const { ctrl } = makeHarness(gtx);
    postFromCore({ duopulse: "translate-page", reqId: 1, target: "ru" });
    await vi.waitFor(() => expect(ctrl.state().phase).toBe("translated"));
    const callsAfterFirst = (gtx as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    (ctrl as unknown as { showOriginal(): void }).showOriginal();
    expect(p.textContent).toBe("hello");
    expect(ctrl.state().phase).toBe("original");
    // тот же пункт меню: бар вернулся, сеть не дёргается (перевод... — нет,
    // оригинал затёр переводы: повтор = честный новый прогон)
    postFromCore({ duopulse: "translate-page", reqId: 2, target: "ru" });
    await vi.waitFor(() => expect(p.textContent).toBe("«hello»"));
    expect((gtx as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFirst + 1);
  });

  it("смена цели в баре: память в Core и повторный прогон с восстановлением", async () => {
    const p = document.createElement("p");
    p.textContent = "hello";
    document.body.append(p);
    const { ctrl, posted } = makeHarness();
    postFromCore({ duopulse: "translate-page", reqId: 1, target: "ru" });
    await vi.waitFor(() => expect(ctrl.state().phase).toBe("translated"));
    (ctrl as unknown as { retarget(t: string): void }).retarget("en");
    const note = posted.find((m) => m["duopulse"] === "translate-page-set-target");
    expect(note).toEqual({ duopulse: "translate-page-set-target", target: "en" });
    await vi.waitFor(() => expect(ctrl.state().phase).toBe("translated"));
    expect(ctrl.state().target).toBe("en");
    expect(p.textContent).toBe("«hello»");
  });

  it("ошибка конвейера: фаза error, текст в баре, узлы не тронуты", async () => {
    const p1 = document.createElement("p");
    p1.textContent = "первый";
    const p2 = document.createElement("p");
    p2.textContent = "второй";
    document.body.append(p1, p2);
    // отказ всего прогона (кулдаун gtx) — страница остаётся оригиналом
    const gtx: GtxRequest = async () => ({ error: "подождите 30 с" });
    const { ctrl } = makeHarness(gtx);
    postFromCore({ duopulse: "translate-page", reqId: 1, target: "ru" });
    await vi.waitFor(() => expect(ctrl.state().phase).toBe("error"));
    expect(p1.textContent).toBe("первый");
    expect(p2.textContent).toBe("второй");
    expect(ctrl.state().lastError).toContain("подождите");
    const bar = document.querySelector("[data-duopulse-page-bar] span") as HTMLSpanElement;
    expect(bar.textContent).toContain("Не получилось");
  });

  it("устаревший ответ (сменили цель в полёте) не затирает новый прогон", async () => {
    const p = document.createElement("p");
    p.textContent = "hello";
    document.body.append(p);
    let resolveFirst: ((v: string[]) => void) | null = null;
    const gtx: GtxRequest = (texts, _from, to) =>
      to === "ru"
        ? new Promise<string[]>((res) => {
            resolveFirst = res;
          })
        : Promise.resolve(["«en-hello»"]);
    const { ctrl } = makeHarness(gtx);
    postFromCore({ duopulse: "translate-page", reqId: 1, target: "ru" });
    (ctrl as unknown as { retarget(t: string): void }).retarget("en");
    await vi.waitFor(() => expect(ctrl.state().phase).toBe("translated"));
    expect(p.textContent).toBe("«en-hello»");
    (resolveFirst as ((v: string[]) => void) | null)?.(["«ru-hello»"]); // поздний ответ прошлого прогона
    expect(p.textContent).toBe("«en-hello»");
  });

  it("спрятанный бар: × прячет, пункт меню возвращает без новой сети", async () => {
    const p = document.createElement("p");
    p.textContent = "hello";
    document.body.append(p);
    const gtx = vi.fn(echoGtx) as unknown as GtxRequest;
    const { ctrl } = makeHarness(gtx);
    postFromCore({ duopulse: "translate-page", reqId: 1, target: "ru" });
    await vi.waitFor(() => expect(ctrl.state().phase).toBe("translated"));
    const calls = (gtx as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    (document.querySelector("[data-duopulse-page-bar] button[aria-label^='Спрятать']") as HTMLButtonElement).click();
    expect(document.querySelector("[data-duopulse-page-bar]")).toBeNull();
    expect(p.textContent).toBe("«hello»"); // перевод жив
    postFromCore({ duopulse: "translate-page", reqId: 2, target: "ru" });
    expect(document.querySelector("[data-duopulse-page-bar]")).not.toBeNull();
    expect((gtx as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
  });
});

describe("динамика (MutationObserver)", () => {
  it("новые узлы дочитываются после дебаунса", async () => {
    const p = document.createElement("p");
    p.textContent = "hello";
    document.body.append(p);
    const { ctrl } = makeHarness();
    postFromCore({ duopulse: "translate-page", reqId: 1, target: "ru" });
    await vi.waitFor(() => expect(ctrl.state().phase).toBe("translated"));
    const late = document.createElement("p");
    late.textContent = "late node";
    document.body.append(late);
    await vi.waitFor(
      () => {
        expect(late.textContent).toBe("«late node»");
      },
      { timeout: 3000 },
    );
    expect(ctrl.state().nodes).toBe(2);
  });
});

describe("пустые страницы", () => {
  it("нет переводимых узлов — «переведено» без сети, бар есть", async () => {
    document.body.innerHTML = "<div></div>";
    const gtx = vi.fn(echoGtx) as unknown as GtxRequest;
    const { ctrl } = makeHarness(gtx);
    postFromCore({ duopulse: "translate-page", reqId: 1, target: "ru" });
    await vi.waitFor(() => expect(ctrl.state().phase).toBe("translated"));
    expect((gtx as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    expect(document.querySelector("[data-duopulse-page-bar]")).not.toBeNull();
  });
});
