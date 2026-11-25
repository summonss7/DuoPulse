// Юнит-тесты пейлоада перевода всей страницы web-оверлея (карточка
// duopulse-245, паритет десктопа 244): источник — assets/duopulse/
// page-translate.js (тот же текст, что MobileWebHelper инжектирует в
// onPageFinished оверлея), исполняем честно в happy-dom и водим через
// window.__duopulsePageTranslate.begin()/state(). Транспорт — заглушка
// window.__dpPtFetch (пейлоад читает её в момент запроса, до begin):
// разы	reply gtx dj=1 собираем сами, считаем вызовы/параметры (tl, q),
// проверяем построчный добор при смёрже строк Google и ошибки обоих хостов.
// Бар — CSSOM на documentElement: после каждого теста сносим (иначе висит
// в общем документе happy-dom, память duopulse-content-tests-documentelement-leak).
// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const payload = readFileSync(
  resolve(
    process.cwd(),
    "src-tauri/gen/android/app/src/main/assets/duopulse/page-translate.js",
  ),
  "utf8",
);

/** API пейлоада (ставит boot). */
type PtApi = {
  begin(lang?: string): Promise<void>;
  state(): {
    phase: string;
    target: string;
    nodes: number;
    done: number;
    total: number;
    lastError: string;
    bannerVisible: boolean;
  };
  stop(): void;
};

/** Заглушка транспорта (Response-подобный ответ, как читает пейлоад):
 * перевод «[tl]«строка»»; merge=true — пакетный ответ смёржен в одну строку
 * (провокация построчного добора). */
function mockTransport(merge = false) {
  const calls: Array<{ host: string; tl: string; q: string }> = [];
  const fn = vi.fn(async (url: string) => {
    const u = new URL(url);
    calls.push({
      host: u.hostname,
      tl: u.searchParams.get("tl") ?? "",
      q: u.searchParams.get("q") ?? "",
    });
    const lines = (u.searchParams.get("q") ?? "").split("\n");
    const tl = u.searchParams.get("tl") ?? "ru";
    const outLines = merge && lines.length > 1 ? [lines.join(" ")] : lines;
    const trans = outLines.map((l) => `[${tl}]«${l}»`).join("\n");
    return {
      status: 200,
      text: async () => JSON.stringify({ sentences: [{ trans }] }),
    };
  });
  return { fn, calls };
}

/** Заглушка с отказом: не-200 на оба хоста / сетевой исключение на оба. */
function mockFailure(mode: "http" | "net") {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    calls.push(url);
    if (mode === "http") return { status: 429, text: "" };
    throw new TypeError("Failed to fetch");
  });
  return { fn, calls };
}

let api: PtApi | null = null;

/** Исполнить пейлоад на текущем документе (снять маркер — как новая
 *  навигация оверлея). */
function boot(): void {
  delete (window as unknown as { __dpPageTranslate?: boolean }).__dpPageTranslate;
  delete (window as unknown as { __duopulsePageTranslate?: PtApi }).__duopulsePageTranslate;
  new Function(payload)();
  api = (window as unknown as { __duopulsePageTranslate?: PtApi }).__duopulsePageTranslate ?? null;
}

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  delete (window as unknown as { __dpPtFetch?: unknown }).__dpPtFetch;
  boot();
});

afterEach(() => {
  // наблюдатель/бар прошлых тестов не должны ловить узлы новых (payload.stop)
  api?.stop();
  api = null;
  document
    .querySelectorAll("[data-duopulse-page-bar]")
    .forEach((el) => el.remove());
  delete (window as unknown as { __dpPtFetch?: unknown }).__dpPtFetch;
});

/** Скелет страницы: абзацы с контуром пробелов, служебные теги, цифры,
 *  translate=no, contenteditable. */
const PAGE = `
  <p id="a">  Hello world  </p>
  <p id="b">Second line</p>
  <script>var x = "code";</script>
  <style>.a{color:red}</style>
  <p id="digits">12345 678</p>
  <p id="no" translate="no">Do not touch me</p>
  <div id="edit" contenteditable="true">Editable text here</div>
  <pre>preformatted</pre>
  <p id="c">Tail node</p>`;

describe("boot и API", () => {
  it("пейлоад ставит window.__duopulsePageTranslate (begin/state/stop)", () => {
    boot();
    expect(typeof api?.begin).toBe("function");
    expect(typeof api?.state).toBe("function");
    expect(typeof api?.stop).toBe("function");
    expect(api?.state()).toMatchObject({ phase: "idle", target: "", nodes: 0 });
  });

  it("повторный boot идемпотентен (маркер, API не перезаписан)", () => {
    boot();
    const first = api;
    new Function(payload)();
    expect(
      (window as unknown as { __duopulsePageTranslate?: PtApi }).__duopulsePageTranslate,
    ).toBe(first);
  });

  it("во фрейме (top !== window) API не появляется", () => {
    const desc = Object.getOwnPropertyDescriptor(window, "top");
    Object.defineProperty(window, "top", { value: {}, configurable: true });
    try {
      boot();
      expect(api).toBeNull();
    } finally {
      if (desc) Object.defineProperty(window, "top", desc);
    }
  });
});

describe("перевод страницы (begin)", () => {
  it("переводит текстовые узлы с контуром пробелов; служебные не трогает", async () => {
    document.body.innerHTML = PAGE;
    const tr = mockTransport();
    (window as unknown as { __dpPtFetch: unknown }).__dpPtFetch = tr.fn;
    await api!.begin("ru");
    expect(document.getElementById("a")!.textContent).toBe("  [ru]«Hello world»  ");
    expect(document.getElementById("b")!.textContent).toBe("[ru]«Second line»");
    expect(document.getElementById("c")!.textContent).toBe("[ru]«Tail node»");
    // служебные/машинные/запрещённые/правка/цифры — оригинал
    expect(document.querySelector("script")!.textContent).toContain("code");
    expect(document.getElementById("digits")!.textContent).toBe("12345 678");
    expect(document.getElementById("no")!.textContent).toBe("Do not touch me");
    expect(document.getElementById("edit")!.textContent).toBe("Editable text here");
    expect(document.querySelector("pre")!.textContent).toBe("preformatted");
    expect(api!.state()).toMatchObject({ phase: "translated", target: "ru", nodes: 3 });
  });

  it("URL запроса: client=gtx&dj=1, sl=auto, tl, q — корпус без контура", async () => {
    document.body.innerHTML = `<p>  Hello  </p>`;
    const tr = mockTransport();
    (window as unknown as { __dpPtFetch: unknown }).__dpPtFetch = tr.fn;
    await api!.begin("uk");
    expect(tr.calls.length).toBe(1);
    expect(tr.calls[0].host).toBe("translate.googleapis.com");
    expect(tr.calls[0].tl).toBe("uk");
    expect(tr.calls[0].q).toBe("Hello");
    expect(tr.fn.mock.calls[0][0]).toContain("client=gtx&dj=1");
    expect(tr.fn.mock.calls[0][0]).toContain("sl=auto");
    expect(tr.fn.mock.calls[0][0]).toContain("dt=t");
  });

  it("пачки: 45 узлов → два запроса (40 строк + хвост)", async () => {
    for (let i = 0; i < 45; i++) {
      const p = document.createElement("p");
      p.textContent = `line number ${i}`;
      document.body.append(p);
    }
    const tr = mockTransport();
    (window as unknown as { __dpPtFetch: unknown }).__dpPtFetch = tr.fn;
    await api!.begin("ru");
    expect(tr.calls.length).toBe(2);
    expect(tr.calls[0].q.split("\n").length).toBe(40);
    expect(tr.calls[1].q.split("\n").length).toBe(5);
    expect(api!.state().done).toBe(45);
  });

  it("смёрж строк Google: построчный добор доводит все строки", async () => {
    document.body.innerHTML = "<p>one</p><p>two</p><p>three</p>";
    const tr = mockTransport(true);
    (window as unknown as { __dpPtFetch: unknown }).__dpPtFetch = tr.fn;
    await api!.begin("ru");
    // пакетный запрос смёржен (1 строка в ответе) → 3 построчных добора
    expect(tr.calls.length).toBe(4);
    expect(tr.calls[0].q).toBe("one\ntwo\nthree");
    expect(tr.calls.slice(1).map((c) => c.q)).toEqual(["one", "two", "three"]);
    expect(api!.state().phase).toBe("translated");
    expect(document.body.textContent).toContain("[ru]«one»");
    expect(document.body.textContent).toContain("[ru]«two»");
  });

  it("HTTP-отказ обоих хостов: phase=error, тексты не тронуты", async () => {
    document.body.innerHTML = "<p>keep me</p>";
    const tr = mockFailure("http");
    (window as unknown as { __dpPtFetch: unknown }).__dpPtFetch = tr.fn;
    await api!.begin("ru");
    expect(tr.calls.length).toBe(2); // оба хоста попробованы
    expect(tr.calls[1]).toContain("clients5.google.com");
    expect(api!.state()).toMatchObject({ phase: "error", lastError: "gtx HTTP 429 (clients5.google.com)" });
    expect(document.body.textContent).toBe("keep me");
  });

  it("сетевой отказ/CSP: внятная ошибка, оба хоста попробованы", async () => {
    document.body.innerHTML = "<p>keep me too</p>";
    const tr = mockFailure("net");
    (window as unknown as { __dpPtFetch: unknown }).__dpPtFetch = tr.fn;
    await api!.begin("ru");
    expect(api!.state()).toMatchObject({
      phase: "error",
      lastError: "сеть/CSP страницы запретили запрос",
    });
  });

  it("пустая страница — «переведено» без запросов, бар есть", async () => {
    document.body.innerHTML = "<div></div>";
    const tr = mockTransport();
    (window as unknown as { __dpPtFetch: unknown }).__dpPtFetch = tr.fn;
    await api!.begin("ru");
    expect(tr.calls.length).toBe(0);
    expect(api!.state()).toMatchObject({ phase: "translated" });
    expect(document.querySelector("[data-duopulse-page-bar]")).not.toBeNull();
  });

  it("невалидная цель приведена к дефолту (ru), пустой вызов — ru", async () => {
    document.body.innerHTML = "<p>hello</p>";
    const tr = mockTransport();
    (window as unknown as { __dpPtFetch: unknown }).__dpPtFetch = tr.fn;
    await api!.begin("klingon");
    expect(tr.calls[0].tl).toBe("ru");
  });
});

describe("бар перевода", () => {
  it("бар: статус «Переведено на Русский», селект 15 языков (ru первый), «Оригинал», «×»", async () => {
    document.body.innerHTML = "<p>hi</p>";
    const tr = mockTransport();
    (window as unknown as { __dpPtFetch: unknown }).__dpPtFetch = tr.fn;
    await api!.begin("ru");
    const bar = document.querySelector<HTMLElement>("[data-duopulse-page-bar]")!;
    expect(bar).not.toBeNull();
    const status = bar.querySelector("span")!;
    expect(status.textContent).toBe("Переведено на Русский");
    const select = bar.querySelector<HTMLSelectElement>("select")!;
    const opts = [...select.options].map((o) => o.value);
    expect(opts).toHaveLength(15);
    expect(opts[0]).toBe("ru");
    expect(opts).toContain("en");
    expect(opts).toContain("zh");
    expect(select.value).toBe("ru");
    const toggle = bar.querySelector<HTMLButtonElement>('button[aria-label="Показать оригинал страницы"]')!;
    expect(toggle.textContent).toBe("Оригинал");
    expect(bar.querySelector<HTMLButtonElement>('button[aria-label="Спрятать панель перевода"]')).not.toBeNull();
    expect(api!.state().bannerVisible).toBe(true);
  });

  it("«Оригинал»: возвращает тексты, статус меняется, кнопка — «Показать перевод»", async () => {
    document.body.innerHTML = "<p>hello</p>";
    const tr = mockTransport();
    (window as unknown as { __dpPtFetch: unknown }).__dpPtFetch = tr.fn;
    await api!.begin("ru");
    const bar = document.querySelector<HTMLElement>("[data-duopulse-page-bar]")!;
    bar.querySelector<HTMLButtonElement>('button[aria-label="Показать оригинал страницы"]')!.click();
    expect(document.body.textContent).toBe("hello");
    expect(api!.state().phase).toBe("original");
    expect(bar.querySelector("span")!.textContent).toBe("Оригинал (Русский)");
    expect(
      bar.querySelector<HTMLButtonElement>('button[aria-label="Показать оригинал страницы"]')!.textContent,
    ).toBe("Показать перевод");
    // «Показать перевод» возвращает перевод (полный прогон заново)
    const before = tr.calls.length;
    bar.querySelector<HTMLButtonElement>('button[aria-label="Показать оригинал страницы"]')!.click();
    await vi.waitFor(() => expect(api!.state().phase).toBe("translated"));
    expect(document.body.textContent).toBe("[ru]«hello»");
    expect(tr.calls.length).toBeGreaterThan(before);
  });

  it("«×» прячет бар, перевод остаётся; повторный begin возвращает бар", async () => {
    document.body.innerHTML = "<p>hello</p>";
    const tr = mockTransport();
    (window as unknown as { __dpPtFetch: unknown }).__dpPtFetch = tr.fn;
    await api!.begin("ru");
    const bar = document.querySelector<HTMLElement>("[data-duopulse-page-bar]")!;
    bar.querySelector<HTMLButtonElement>('button[aria-label="Спрятать панель перевода"]')!.click();
    expect(document.querySelector("[data-duopulse-page-bar]")).toBeNull();
    expect(api!.state().bannerVisible).toBe(false);
    expect(document.body.textContent).toBe("[ru]«hello»");
    await api!.begin("ru"); // та же цель — только бар
    expect(document.querySelector("[data-duopulse-page-bar]")).not.toBeNull();
    expect(api!.state().phase).toBe("translated");
  });

  it("смена цели в баре: полный прогон заново на uk, память цели в localStorage", async () => {
    document.body.innerHTML = "<p>hello</p>";
    const tr = mockTransport();
    (window as unknown as { __dpPtFetch: unknown }).__dpPtFetch = tr.fn;
    await api!.begin("ru");
    const bar = document.querySelector<HTMLElement>("[data-duopulse-page-bar]")!;
    const select = bar.querySelector<HTMLSelectElement>("select")!;
    select.value = "uk";
    select.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(api!.state()).toMatchObject({ phase: "translated", target: "uk" }));
    expect(document.body.textContent).toBe("[uk]«hello»");
    expect(localStorage.getItem("duopulse.pageTranslateTarget")).toBe("uk");
    expect(bar.querySelector("span")!.textContent).toBe("Переведено на Українська");
  });

  it("память цели: begin() без аргумента берёт последнюю (localStorage)", async () => {
    localStorage.setItem("duopulse.pageTranslateTarget", "de");
    document.body.innerHTML = "<p>hello</p>";
    const tr = mockTransport();
    (window as unknown as { __dpPtFetch: unknown }).__dpPtFetch = tr.fn;
    await api!.begin();
    expect(tr.calls[0].tl).toBe("de");
    expect(api!.state().target).toBe("de");
  });
});

describe("динамика (MutationObserver)", () => {
  it("новые узлы дочитываются после дебаунса, свои замены не гоняют конвейер", async () => {
    document.body.innerHTML = "<p>hello</p>";
    const tr = mockTransport();
    (window as unknown as { __dpPtFetch: unknown }).__dpPtFetch = tr.fn;
    await api!.begin("ru");
    const late = document.createElement("p");
    late.textContent = "late node";
    document.body.append(late);
    await vi.waitFor(() => expect(late.textContent).toBe("[ru]«late node»"), {
      timeout: 3000,
    });
    expect(api!.state().nodes).toBe(2);
    // правка переведённого узла (characterData) не перезапускает запросы
    const before = tr.calls.length;
    document.querySelector("p")!.firstChild!.nodeValue = "edited manual";
    await new Promise((r) => setTimeout(r, 1000));
    expect(tr.calls.length).toBe(before);
  });
});

describe("stop()", () => {
  it("гасит бар и фазу, останавливает наблюдателя", async () => {
    document.body.innerHTML = "<p>hello</p>";
    const tr = mockTransport();
    (window as unknown as { __dpPtFetch: unknown }).__dpPtFetch = tr.fn;
    await api!.begin("ru");
    api!.stop();
    expect(document.querySelector("[data-duopulse-page-bar]")).toBeNull();
    expect(api!.state()).toMatchObject({ phase: "idle", bannerVisible: false });
    const late = document.createElement("p");
    late.textContent = "late node";
    document.body.append(late);
    await new Promise((r) => setTimeout(r, 1000));
    expect(late.textContent).toBe("late node"); // наблюдатель снят
  });
});
