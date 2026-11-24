// Юнит-тесты пейлоада перехвата видео-результатов выдачи Google в web-оверлее
// (карточка duopulse-236, жалоба «открываю видео из поиска — реклама не
// блокируется, играет прямо на сайте Google»): источник —
// assets/duopulse/google-video.js (тот же текст, что MobileWebHelper
// регистрирует document-start'ом), исполняем честно в happy-dom на скелете
// реальной разметки выдачи и смотрим, какие клики погашены (до «обработчиков
// Google» не дошли) и что улетело консолью — 'DPYT:<id>' ловит onConsole.
// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const payload = readFileSync(
  resolve(
    process.cwd(),
    "src-tauri/gen/android/app/src/main/assets/duopulse/google-video.js",
  ),
  "utf8",
);

const SERP = "https://www.google.com/search?q=%D0%BA%D0%BE%D1%82%D0%B8%D0%BA%D0%B8";
const VID = "uXdmxWetyLc";
const SHORT = "tLccf6zMC4U";
const WATCH = "https://www.youtube.com/watch?v=" + VID;

/** happy-dom API окна: типов пакета в tsconfig проекта нет (types — node,
 *  vite/client) — узкая локальная подпись вместо any. */
const happyDOM = (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM;
let logs: string[];
type Added = [string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined];
let added: Added[];

beforeEach(() => {
  logs = [];
  added = [];
  // слушатели пейлоада живут на window — снимаем после каждого теста (в
  // WebView каждая навигация даёт новый документ, там накопления нет)
  const orig = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation((type, fn, opts) => {
    added.push([type, fn, opts]);
    orig(type, fn, opts);
  });
  vi.spyOn(console, "log").mockImplementation((m: unknown) => {
    logs.push(String(m));
  });
  happyDOM.setURL(SERP);
  boot();
});

afterEach(() => {
  for (const [type, fn, opts] of added) window.removeEventListener(type, fn, opts);
  vi.restoreAllMocks();
  delete (window as unknown as { __dpGoogleVideo?: boolean }).__dpGoogleVideo;
  // у happy-dom top — собственное свойство окна (не геттер прототипа):
  // после теста с фреймом возвращаем как было
  if (topDescriptor) Object.defineProperty(window, "top", topDescriptor);
  topDescriptor = undefined;
});

/** Исполнить пейлоад на текущем документе (снять маркер — как новая навигация). */
function boot(): void {
  delete (window as unknown as { __dpGoogleVideo?: boolean }).__dpGoogleVideo;
  new Function(payload)();
}

/** Другой адрес (тот же тест): снять слушатели и исполнить заново. */
function reboot(): void {
  for (const [type, fn, opts] of added) window.removeEventListener(type, fn, opts);
  added = [];
  boot();
}

/** Тот же документ, но вложенный фрейм (top !== window). */
let topDescriptor: PropertyDescriptor | undefined;
function rebootAsFrame(): void {
  topDescriptor = Object.getOwnPropertyDescriptor(window, "top");
  Object.defineProperty(window, "top", { value: {}, configurable: true });
  reboot();
}

/** Видео-результат мобильной выдачи Google — скелет реальной разметки:
 *  контейнер [data-vid] (jsaction на нём же), ссылка-заголовок через
 *  редиректор /url?q=, «▶»-миниатюра (role=button + data-vll) с предпросмотром
 *  (собственный jsaction) и «Про цей результат» (обёртка со своим jsaction). */
function videoResult(
  attrs: Record<string, string> = {},
  href = "/url?q=" + encodeURIComponent(WATCH) + "&sa=U&ved=1",
): HTMLElement {
  const c = document.createElement("div");
  const base = {
    jscontroller: "rTuANe",
    jsaction: "JP8eqe:NT5WYc;h5M12e;clickmod:h5M12e;rcuQ6b:npT2md",
    "data-vid": VID,
    "data-surl": WATCH,
    "data-curl": WATCH,
    "data-pubr": "YouTube",
    ...attrs,
  };
  for (const [k, v] of Object.entries(base)) c.setAttribute(k, v);
  c.innerHTML = `
    <div><a href="${href}"><div role="heading">Приколы с котами</div>
      <div>YouTube · 9 квіт. 2026 р.</div></a>
      <div role="button" tabindex="0" data-vll aria-label="Приколы с котами. Відтворити в Google">
        <div jscontroller="Fy1Pv" jsaction="rtcVre:NziyQe;rcuQ6b:npT2md" data-url="https://encrypted-vtbn0.gstatic.com/video?q=x">
          <div jsname="haAclf"></div></div>
        <div jsname="zccVWc"><img></div>
        <div><svg><path></path></svg><span>20:10</span></div>
      </div>
      <div><div jsaction="rcuQ6b:npT2md;h5M12e">
        <div role="button" tabindex="0" aria-label="Про цей результат"><span><svg><path></path></svg></span></div>
      </div></div>
    </div>`;
  document.body.append(c);
  return c;
}

/** Клик по элементу: [погашен ли, дошёл ли до «обработчика Google» на document]. */
function click(el: Element): [boolean, boolean] {
  let reached = false;
  const onPage = (): void => {
    reached = true;
  };
  document.addEventListener("click", onPage);
  const e = new MouseEvent("click", { bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  document.removeEventListener("click", onPage);
  return [e.defaultPrevented, reached];
}

function key(el: Element, k: string): boolean {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e.defaultPrevented;
}

const thumb = (c: HTMLElement): HTMLElement => c.querySelector('[role="button"][data-vll]') as HTMLElement;
const about = (c: HTMLElement): HTMLElement => c.querySelector('[aria-label="Про цей результат"]') as HTMLElement;
const link = (c: HTMLElement): HTMLElement => c.querySelector("a[href]") as HTMLElement;

describe("пейлоад google-video: где работает", () => {
  it("выдача Google: миниатюра «▶» — клик погашен, до страницы не дошёл, DPYT:<id>", () => {
    const c = videoResult();
    expect((window as unknown as { __dpGoogleVideo?: boolean }).__dpGoogleVideo).toBe(true);
    expect(click(thumb(c))).toEqual([true, false]);
    expect(logs).toEqual(["DPYT:" + VID]);
  });

  it.each([
    ["YouTube, не Google", "https://www.youtube.com/watch?v=" + VID],
    ["Google, не поиск", "https://www.google.com/preferences?hl=uk"],
    ["не Google вовсе", "https://example.com/search?q=x"],
  ])("не страница поиска Google — %s: пейлоад молчит", (_name, url) => {
    happyDOM.setURL(url);
    reboot();
    const c = videoResult();
    expect(click(thumb(c))).toEqual([false, true]);
    expect(click(link(c))).toEqual([false, true]);
    expect(logs).toEqual([]);
  });

  it("внутри фрейма (top !== window) — молчит: перехватывает только главный документ", () => {
    rebootAsFrame();
    const c = videoResult();
    expect(click(thumb(c))).toEqual([false, true]);
    expect(logs).toEqual([]);
    expect(added).toEqual([]); // слушатели даже не ставятся
  });

  it("повторная инжекция на том же документе — маркер, один репорт на клик", () => {
    const c = videoResult();
    new Function(payload)();
    click(thumb(c));
    expect(logs).toEqual(["DPYT:" + VID]);
    expect(added.length).toBe(2); // слушатели не задвоены
  });
});

describe("пейлоад google-video: что перехватываем", () => {
  it("внутри миниатюры: картинка, бейдж длительности, предпросмотр с тем же jsaction", () => {
    const c = videoResult();
    const t = thumb(c);
    for (const el of [t.querySelector("img"), t.querySelector("span"), t.querySelector("[jsaction]")]) {
      const before = logs.length;
      expect(click(el as Element)).toEqual([true, false]);
      expect(logs.length).toBe(before + 1);
    }
    expect(logs).toEqual(Array(3).fill("DPYT:" + VID));
  });

  it("заголовок-ссылка /url?q=<ролик> — во встроенный плеер без перехода", () => {
    const c = videoResult();
    expect(click(link(c).querySelector("[role=heading]") as Element)).toEqual([true, false]);
    expect(logs).toEqual(["DPYT:" + VID]);
  });

  it("«Перейти» — непрозрачный токен /goto?url= (id из адреса не вывести, верим контейнеру)", () => {
    const c = videoResult();
    link(c).setAttribute("href", "/goto?url=CAESaAHEIkXXoL-7rjBN8DQ5t4w7ueYfp_");
    link(c).setAttribute("jsaction", "trigger.sCcL9b");
    expect(click(link(c))).toEqual([true, false]);
    expect(logs).toEqual(["DPYT:" + VID]);
  });

  it.each([
    ["youtu.be", "https://youtu.be/" + VID + "?t=30"],
    ["m.youtube.com/embed", "https://m.youtube.com/embed/" + VID],
    ["music.youtube.com/watch с плейлистом", "https://music.youtube.com/watch?hl=ru&list=PL1&v=" + VID],
    ["/live/", "https://www.youtube.com/live/" + VID],
  ])("прямая ссылка результата %s — id распознан", (_name, surl) => {
    const c = videoResult({ "data-surl": surl, "data-curl": surl, "data-vid": "" });
    expect(click(thumb(c))).toEqual([true, false]);
    expect(logs).toEqual(["DPYT:" + VID]);
  });

  it("Shorts (/shorts/<id>, data-issv) — id распознан", () => {
    const surl = "https://www.youtube.com/shorts/" + SHORT;
    const c = videoResult({ "data-surl": surl, "data-curl": surl, "data-vid": SHORT, "data-issv": "1" });
    expect(click(thumb(c))).toEqual([true, false]);
    expect(logs).toEqual(["DPYT:" + SHORT]);
  });

  it("прямой ссылки нет: YouTube по издателю, id из data-vid", () => {
    const c = videoResult({ "data-surl": "", "data-curl": "" });
    const t = thumb(c);
    expect(click(t)).toEqual([true, false]);
    expect(logs).toEqual(["DPYT:" + VID]);
  });

  it("миниатюра без data-vll (другой вариант разметки) — узнаём по контейнеру с jsaction", () => {
    const c = videoResult();
    const t = thumb(c);
    t.removeAttribute("data-vll");
    expect(click(t)).toEqual([true, false]);
    expect(logs).toEqual(["DPYT:" + VID]);
  });

  it("Enter/пробел по сфокусированной «▶» (div role=button клика сам не даёт)", () => {
    const c = videoResult();
    expect(key(thumb(c), "Enter")).toBe(true);
    expect(key(thumb(c), " ")).toBe(true);
    expect(key(thumb(c), "ArrowDown")).toBe(false);
    expect(logs).toEqual(["DPYT:" + VID, "DPYT:" + VID]);
  });

  it("ссылка-заголовок: keydown не трогаем — Enter и так даёт click (гасит intercept), пробел — прокрутка", () => {
    const c = videoResult();
    expect(key(link(c), "Enter")).toBe(false);
    expect(key(link(c), " ")).toBe(false);
    expect(key(c, "Enter")).toBe(false); // пустое место результата — тоже
    expect(logs).toEqual([]);
    // репорт один — с click, который породит Enter по ссылке
    expect(click(link(c))).toEqual([true, false]);
    expect(logs).toEqual(["DPYT:" + VID]);
  });
});

describe("пейлоад google-video: что не трогаем", () => {
  function expectPageOwns(el: Element): void {
    expect(click(el)).toEqual([false, true]);
    expect(logs).toEqual([]);
  }

  it("«Про цей результат» — кнопка в обёртке со своим jsaction (и клик, и Enter)", () => {
    const c = videoResult();
    expectPageOwns(about(c));
    expectPageOwns(about(c).querySelector("svg") as Element);
    expect(key(about(c), "Enter")).toBe(false);
  });

  it("пустое место результата (не кнопка, не ссылка) и мимо результата", () => {
    const c = videoResult();
    expectPageOwns(c);
    expectPageOwns(c.firstElementChild as Element);
    const aside = document.createElement("a");
    aside.href = "/url?q=" + encodeURIComponent(WATCH);
    aside.textContent = "похожая ссылка вне результата";
    document.body.append(aside);
    expectPageOwns(aside);
  });

  it("ссылка мимо редиректора результата (сайт издателя в «о результате»)", () => {
    const c = videoResult();
    link(c).setAttribute("href", "https://www.youtube.com/@domi");
    expectPageOwns(link(c));
  });

  it("ссылка /url?q= на другое (не ролик результата)", () => {
    const c = videoResult();
    link(c).setAttribute("href", "/url?q=" + encodeURIComponent("https://www.youtube.com/playlist?list=PL1"));
    expectPageOwns(link(c));
    link(c).setAttribute("href", "/url?q=" + encodeURIComponent("https://www.youtube.com/watch?v=o7TAazmKyMc"));
    expectPageOwns(link(c));
  });

  it("другой издатель (TikTok) — играет плеер Google, как прежде", () => {
    const c = videoResult({
      "data-vid": "7301234567890123456",
      "data-surl": "https://www.tiktok.com/@x/video/7301234567890123456",
      "data-curl": "https://www.tiktok.com/@x/video/7301234567890123456",
      "data-pubr": "TikTok",
    });
    expectPageOwns(thumb(c));
    expectPageOwns(link(c));
  });

  it("плейлист/канал под именем YouTube, битый id — не ролик", () => {
    const list = "https://www.youtube.com/playlist?list=PL1";
    const c = videoResult({ "data-surl": list, "data-curl": list, "data-vid": "" });
    expectPageOwns(thumb(c));
    const broken = videoResult({ "data-surl": "", "data-curl": "", "data-vid": "x" });
    expectPageOwns(thumb(broken));
    const foreign = videoResult({ "data-surl": "", "data-curl": "", "data-pubr": "Vimeo" });
    expectPageOwns(thumb(foreign));
  });
});
