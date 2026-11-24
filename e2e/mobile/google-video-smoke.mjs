// E2E-смоук ВИДЕО-РЕЗУЛЬТАТОВ ВЫДАЧИ GOOGLE в web-оверлее (карточка duopulse-236,
// жалоба «ищу видео, открываю из списка — блокировка рекламы не срабатывает,
// открывается прямо на сайте Google в поиске»).
//
// Причина: в мобильной выдаче Google миниатюра «▶» ролика YouTube — кнопка
// «Відтворити в Google»: видео играет плеером Google В ДОКУМЕНТЕ выдачи
// (адрес google.com/search…#sv=<токен>) — навигации нет, хуки оверлея
// (shouldOverrideUrlLoading / onPageStarted / DPURL) молчат. Фикс:
// document-start пейлоад assets/duopulse/google-video.js (клик по
// «▶»/заголовку результата [data-vid] гасит и репортит DPYT:<id> консолью →
// onConsole → встроенный плеер).
//
// Сценарий (debug-APK на эмуляторе, CDP webview_devtools_remote, НАСТОЯЩИЕ
// тапы adb input tap по границам WebView оверлея):
//   1) выдача Google в оверлее, в разметке есть видео-результаты YouTube
//      ([data-vid] + ссылка на ролик) — разметка изменилась — смоук скажет;
//   2) пейлоад в документе выдачи (маркер __dpGoogleVideo);
//   3) тап по «▶» → встроенный плеер с id этого ролика (хук
//      __duopulseOpenVideo в UI-webview + омнибокс watch?v=<id>), оверлей
//      спрятан; в logcat нет загрузки страницы YouTube;
//   4) «назад» → выдача на месте: адрес без #sv= (плеер Google не открывался);
//   5) тап по заголовку → тот же плеер; «назад» → выдача;
//   6) вкладка «Відео» (udm=7) — тап по «▶» → плеер;
//   7) «Про цей результат» — НЕ наш: плеер не открывался, оверлей виден;
//   8) Enter (клавиатура/D-pad) по сфокусированной «▶» → плеер, один репорт;
//   9) инкогнито-оверлей (приватный профиль WebView): пейлоад на месте, тап
//      по «▶» → плеер; возврат в обычный режим — пейлоад на месте.
//
// Маркер «плеер Google открыт» — адрес с #sv=<токен>: контроль 24.11.2026
// (перехват нейтрализован в самой странице — preventDefault/stopPropagation
// отключены, DPYT проглочен; клик ушёл обработчикам Google) даёт ровно этот
// хэш. iframe youtube.com/embed маркером НЕ годится: в спокойной выдаче
// всегда лежит скрытая заготовка плеера 0×0 (embed/?enablejsapi…) — первый
// вариант проверки на ней падал ложным «плеер открывался».
// Запуск (APK установлен, эмулятор поднят):
//   node e2e/mobile/google-video-smoke.mjs
// Переопределения: Q (запрос), CDP_PORT, ANDROID_SERIAL. Скриншоты —
// %TEMP%/duopulse-236-*.png. Результат —
// e2e/mobile/google-video-smoke-last-run.json (gitignore, рантайм-артефакт).
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = "dev.duopulse.mobile";
const CDP_PORT = Number(process.env.CDP_PORT || 9223);
const Q = process.env.Q || "котики смешные видео";
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "google-video-smoke-last-run.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cut = (u, n = 110) => String(u || "").slice(0, n);

const SERIAL = process.env.ANDROID_SERIAL ||
  execFileSync("adb", ["devices"], { encoding: "utf8" })
    .split(/\r?\n/).slice(1).find((l) => l.trim().endsWith("device"))?.split("\t")[0].trim() || "";
if (!SERIAL) throw new Error("эмулятор не найден (adb devices)");
const adb = (...args) =>
  execFileSync("adb", ["-s", SERIAL, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024,
  });
const shot = (name) => {
  const p = join(tmpdir(), `duopulse-236-${name}.png`);
  writeFileSync(p, execFileSync("adb", ["-s", SERIAL, "exec-out", "screencap", "-p"], { maxBuffer: 16 * 1024 * 1024 }));
  console.log(`скриншот: ${p}`);
};

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok, ...(extra ? { extra } : {}) });
  console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
};

// --- CDP ----------------------------------------------------------------------
async function startApp() {
  adb("shell", "am", "force-stop", PKG);
  adb("shell", "am", "start", "-n", `${PKG}/.MainActivity`);
  let pid = "";
  for (let i = 0; i < 30 && !pid; i++) {
    try { pid = adb("shell", "pidof", PKG).trim(); } catch { /* pidof без процесса — код 1 */ }
    if (!pid) await sleep(500);
  }
  if (!pid) throw new Error("процесс приложения не поднялся");
  adb("forward", `tcp:${CDP_PORT}`, `localabstract:webview_devtools_remote_${pid}`);
}

const targets = async () => {
  try {
    return (await (await fetch(`http://localhost:${CDP_PORT}/json`)).json()).filter((t) => t.type === "page");
  } catch {
    return [];
  }
};

async function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let i = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  // таймаут на КАЖДЫЙ eval (спрятанный оверлей страницей не отвечает —
  // промис без таймаута висит вечно; мёртвые цели прошлых сессий — в /json)
  const evalJs = (expr, ms = 6000) => new Promise((res, rej) => {
    const id = ++i;
    const to = setTimeout(() => { pending.delete(id); rej(new Error("eval-timeout")); }, ms);
    pending.set(id, (m) => {
      clearTimeout(to);
      m.error ? rej(new Error(m.error.message)) : res(m.result.result.value);
    });
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
  return { evalJs, close: () => ws.close() };
}

/** UI-webview DuoPulse (DOM-предикат: глобал видеовхода мобильной ветки). */
async function uiPage() {
  for (let a = 0; a < 40; a++) {
    for (const t of await targets()) {
      if (!t.url.includes("tauri.localhost")) continue;
      const c = await connect(t).catch(() => null);
      if (!c) continue;
      const ok = await c.evalJs("typeof window.__duopulseOpenVideo").catch(() => "");
      if (ok === "function") return { c, t };
      c.close();
    }
    await sleep(1000);
  }
  throw new Error("UI-webview DuoPulse не найден в CDP-целях");
}

/** invoke-команда Tauri с ретраями (UI-webview под нагрузкой отвечает
 *  медленно). */
async function invoke(cmd, args) {
  for (let i = 0; i < 3; i++) {
    const r = await ui.c.evalJs(
      `window.__TAURI_INTERNALS__.invoke('${cmd}', ${JSON.stringify(args)})`, 12000
    ).catch((e) => `err:${e.message}`);
    if (!String(r).startsWith("err:")) return r;
    await sleep(2500);
  }
  return "err:retries";
}

/** Живая цель оверлея (http(s), не tauri.localhost, отвечает на eval). */
async function overlayConn() {
  for (const t of await targets()) {
    if (!t.url.startsWith("http") || t.url.includes("tauri.localhost")) continue;
    const c = await connect(t).catch(() => null);
    if (!c) continue;
    const ok = await c.evalJs("1", 4000).catch(() => null);
    if (ok === 1) return c;
    c.close();
  }
  return null;
}

/** Состояние документа оверлея: адрес, готовность, видео-результаты Google. */
const SNAP = `JSON.stringify((() => {
  const yt = (u) => /youtube\\.com\\/(watch\\?|shorts\\/|live\\/|embed\\/)|youtu\\.be\\//i.test(u || '');
  const rs = [...document.querySelectorAll('[data-vid]')];
  return {
    url: location.href, ready: document.readyState, hooked: window.__dpGoogleVideo === true,
    results: rs.length,
    yt: rs.filter((c) => yt(c.getAttribute('data-surl')) || yt(c.getAttribute('data-curl'))).length,
    // плеер Google в документе выдачи — адрес с #sv=<токен> (контроль в шапке)
    googlePlayer: /[#&]sv=/.test(location.hash),
    title: document.title,
  };
})())`;
async function overlaySnap() {
  const c = await overlayConn();
  if (!c) return null;
  const raw = await c.evalJs(SNAP, 8000).catch(() => "");
  c.close();
  try { return JSON.parse(raw); } catch { return null; }
}

/** Первый видео-результат YouTube обычного ролика (не Shorts) — помечаем
 *  data-dp236 и скроллим в центр; null — в разметке нет. */
const PICK = `(() => {
  const c = [...document.querySelectorAll('[data-vid]')].find((x) =>
    !x.getAttribute('data-issv') && /^https?:\\/\\/(www\\.)?youtube\\.com\\/watch\\?/.test(x.getAttribute('data-surl') || ''));
  if (!c) return 'null';
  document.querySelectorAll('[data-dp236]').forEach((x) => x.removeAttribute('data-dp236'));
  c.setAttribute('data-dp236', '1');
  c.scrollIntoView({ block: 'center' });
  return JSON.stringify({ id: c.getAttribute('data-vid'), surl: c.getAttribute('data-surl') });
})()`;

/** CSS-прямоугольник помеченного элемента SEL (видимого) + масштаб. */
const RECT = (sel) => `(() => {
  const all = [...document.querySelectorAll(${JSON.stringify(sel)})];
  const a = all.find((x) => { const r = x.getBoundingClientRect(); return r.width > 8 && r.height > 8; }) || all[0];
  if (!a) return 'null';
  a.scrollIntoView({ block: 'center' });
  const r = a.getBoundingClientRect();
  return JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height, dpr: devicePixelRatio * (visualViewport.scale || 1),
    label: (a.getAttribute('aria-label') || a.innerText || '').replace(/\\s+/g, ' ').slice(-70) });
})()`;

// --- нативный UI: uiautomator dump → WebView-узлы -----------------------------
/** Границы [l,t,r,b] всех WebView на экране. */
async function webViews() {
  for (let a = 0; a < 6; a++) {
    try {
      // успех — только свежий дамп: не добравшись до покоя («could not get idle
      // state» — играет видео), команда может выйти без ошибки, файл прежний —
      // прочли бы прошлое состояние экрана
      const out = adb("shell", "uiautomator", "dump", "/sdcard/uidump.xml");
      if (!/dumped to/.test(out)) throw new Error("dump не записан");
      const xml = adb("shell", "cat", "/sdcard/uidump.xml").replace(/\r/g, "");
      const wvs = [...xml.matchAll(/<node[^>]*class="android\.webkit\.WebView"[^>]*>/g)]
        .map((m) => m[0].match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/).slice(1).map(Number));
      if (wvs.length) return wvs;
    } catch { /* dump гонится за анимацией — повтор */ }
    await sleep(400);
  }
  return [];
}
/** WebView оверлея (шапка оверлея нативная — его верх ниже 200 px; когда
 *  оверлей спрятан, на экране один UI-webview приложения) либо null. */
async function overlayWv() {
  return (await webViews()).filter((b) => b[1] > 200 && b[3] - b[1] > 800)
    .sort((a, b) => (b[2] - b[0]) * (b[3] - b[1]) - (a[2] - a[0]) * (a[3] - a[1]))[0] || null;
}

/** Настоящий тап adb по элементу SEL документа оверлея: CSS-прямоугольник →
 *  экран через границы WebView оверлея (dpr страницы). Бьём на 60 CSS-px
 *  правее левого края — в миниатюре это поле кнопки «▶». */
async function tapSel(sel) {
  const c = await overlayConn();
  if (!c) return { ok: false, why: "оверлей не отвечает" };
  let r = null;
  try {
    await c.evalJs(`(() => { const a = document.querySelector(${JSON.stringify(sel)}); if (a) a.scrollIntoView({ block: 'center' }) })()`);
    await sleep(900);
    r = JSON.parse(await c.evalJs(RECT(sel)));
  } catch { /* нет элемента */ }
  c.close();
  if (!r) return { ok: false, why: `элемент не найден: ${sel}` };
  const wv = await overlayWv();
  if (!wv) return { ok: false, why: "WebView оверлея не найден (оверлей спрятан?)" };
  const sx = Math.round(wv[0] + (r.x + Math.min(r.w, 120) / 2) * r.dpr);
  const sy = Math.round(wv[1] + (r.y + Math.min(r.h, 120) / 2) * r.dpr);
  adb("shell", "input", "tap", String(sx), String(sy));
  console.log(`  тап ${sx},${sy} ← css ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}x${Math.round(r.h)} dpr=${r.dpr.toFixed(2)} «${r.label}»`);
  return { ok: true, label: r.label };
}

/** Снимок вызовов __duopulseOpenVideo (хук ниже): массив id по порядку. */
const playerCalls = async () => {
  try { return JSON.parse(await ui.c.evalJs("JSON.stringify(window.__dp236 || [])")); } catch { return []; }
};
const omni = () => ui.c.evalJs("(document.querySelector('#mOmnibox') || {value:''}).value").catch(() => "");

/** Дождаться: оверлей спрятан, UI позвал __duopulseOpenVideo(id), омнибокс —
 *  watch?v=<id>. */
async function openedPlayer(id, ms = 12000) {
  const t0 = Date.now();
  let calls = [], o = "";
  while (Date.now() - t0 < ms) {
    await sleep(1200);
    calls = await playerCalls();
    o = await omni();
    if (calls.includes(id) && o.includes("watch?v=" + id) && !(await overlayWv())) return { calls, omni: o };
  }
  return { calls, omni: o };
}
/** Открытие плеера ровно один раз с момента снимка before — и с нужным id
 *  (по «includes» один и тот же ролик второй раз сошёлся бы и без тапа;
 *  calls — массив: JSON-строка на endsWith(id) не кончается никогда). */
const openedOnce = (p, before, id) =>
  p.calls.length === before.length + 1 && p.calls[p.calls.length - 1] === id;

/** Открыть поиск Google в оверлее (инкогнито — по флагу: оверлей пересобирается
 *  с приватным профилем WebView) и дождаться результатов с роликами YouTube. */
async function openSerp(url, incognito = false) {
  await invoke("mobile_web_open", incognito ? { url, incognito: true } : { url });
  let s = null;
  for (let i = 0; i < 30; i++) {
    await sleep(1500);
    s = await overlaySnap();
    if (s && s.ready === "complete" && /google\.[a-z.]+\/search/.test(s.url) && s.yt > 0) break;
  }
  return s;
}

/** Снять выбор PICK в документе оверлея (id первого ролика YouTube) либо null. */
async function pickFirst() {
  const c = await overlayConn();
  const r = c ? await c.evalJs(PICK).catch(() => "null") : "null";
  if (c) c.close();
  return JSON.parse(r);
}

/** «назад» из встроенного плеера → дождаться видимого оверлея. */
async function backToOverlay() {
  adb("shell", "input", "keyevent", "4");
  for (let i = 0; i < 12; i++) { await sleep(1200); if (await overlayWv()) return true; }
  return false;
}

const SERP = `https://www.google.com/search?q=${encodeURIComponent(Q)}`;
const NAME3 = "тап по «▶» → встроенный плеер";

let ui;
try {
  await startApp();
  ui = await uiPage();
  // хук видеовхода: записываем, с каким id Kotlin позвал встроенный плеер
  await ui.c.evalJs(`(() => { if (window.__dp236h) return 'already'; window.__dp236h = 1; window.__dp236 = [];
    const o = window.__duopulseOpenVideo; window.__duopulseOpenVideo = (id) => { window.__dp236.push(id); return o(id); }; return 'hooked' })()`);
  adb("logcat", "-c");

  // ── 1) выдача Google ─────────────────────────────────────────────────────
  const s1 = await openSerp(SERP);
  shot("serp");
  check("1 выдача Google в оверлее, видео-результаты YouTube в разметке ([data-vid])",
    !!s1 && s1.yt > 0, s1 ? `${cut(s1.url, 90)} | результатов ${s1.results}, YouTube ${s1.yt}` : "оверлей не отвечает");
  check("2 пейлоад в документе выдачи (__dpGoogleVideo)", !!s1 && s1.hooked === true, s1 ? `hooked=${s1.hooked}` : "");

  // ── 3) тап по «▶» ────────────────────────────────────────────────────────
  const first = await pickFirst();
  if (!first) {
    check(`3 ${NAME3}`, false, "видео-результат YouTube не найден в разметке");
  } else {
    const tap = await tapSel("[data-dp236] [role='button']");
    const p3 = await openedPlayer(first.id);
    shot("thumb");
    check(`3 ${NAME3} (хук __duopulseOpenVideo + омнибокс), оверлей спрятан`,
      tap.ok && openedOnce(p3, [], first.id) && !(await overlayWv()),
      `${tap.ok ? "тап" : tap.why} | calls=${JSON.stringify(p3.calls)} | омнибокс ${cut(p3.omni, 60)}`);
    const ytLoads = adb("logcat", "-d", "-v", "brief", "-s", "DuoPulseWeb").split(/\r?\n/)
      .filter((l) => /overlay-loaded: .*youtube/i.test(l));
    check("3 без промежуточной страницы YouTube (logcat overlay-loaded)",
      ytLoads.length === 0, ytLoads.map((l) => cut(l.trim(), 120)).join(" | ") || "0 загрузок");

    // ── 4) «назад» → выдача ────────────────────────────────────────────────
    await backToOverlay();
    const s4 = await overlaySnap();
    shot("back");
    check("4 «назад» → выдача на месте, плеер Google не открывался (адрес без #sv=)",
      !!s4 && /google\.[a-z.]+\/search/.test(s4.url) && s4.googlePlayer === false && s4.yt > 0 && !!(await overlayWv()),
      s4 ? `${cut(s4.url, 80)} | googlePlayer=${s4.googlePlayer}, YouTube ${s4.yt}` : "оверлей не отвечает");

    // ── 5) тап по заголовку ────────────────────────────────────────────────
    const before = await playerCalls();
    const tapT = await tapSel("[data-dp236] a[href^='/url?q='], [data-dp236] a[href^='/goto?url=']");
    const p5 = await openedPlayer(first.id);
    shot("title");
    check("5 тап по заголовку → встроенный плеер",
      tapT.ok && openedOnce(p5, before, first.id) && !(await overlayWv()),
      `${tapT.ok ? "тап" : tapT.why} | calls=${JSON.stringify(p5.calls)}`);
    await backToOverlay();
  }

  // ── 6) вкладка «Відео» ───────────────────────────────────────────────────
  const s6 = await openSerp(`${SERP}&udm=7`);
  shot("videos-tab");
  const sixth = await pickFirst();
  if (s6 && s6.yt > 0 && sixth) {
    const before6 = await playerCalls();
    const tap6 = await tapSel("[data-dp236] [role='button']");
    const p6 = await openedPlayer(sixth.id);
    check("6 вкладка «Відео»: тап по «▶» → встроенный плеер",
      tap6.ok && openedOnce(p6, before6, sixth.id) && !(await overlayWv()),
      `${tap6.ok ? "тап" : tap6.why} | calls=${JSON.stringify(p6.calls)}`);
  } else {
    check("6 вкладка «Відео»: тап по «▶» → встроенный плеер", false,
      `s6=${s6 ? `${cut(s6.url, 70)} YouTube ${s6.yt}` : "нет"} | результат=${JSON.stringify(sixth)}`);
  }
  await backToOverlay();

  // ── 7) «Про цей результат» — не наш ─────────────────────────────────────
  // кнопка результата БЕЗ data-vll в обёртке со своим jsaction — тот же
  // признак, по которому пейлоад её отпускает (на живой выдаче это ровно
  // «Про цей результат»)
  const c7 = await overlayConn();
  const mark7 = c7 ? await c7.evalJs(`(() => {
    const c = document.querySelector('[data-dp236]');
    if (!c) return 'null';
    const b = [...c.querySelectorAll('[role="button"]')].find((x) => !x.hasAttribute('data-vll') && x.closest('[jsaction]') !== c);
    if (!b) return 'null';
    b.setAttribute('data-dp236-about', '1');
    return JSON.stringify({ label: b.getAttribute('aria-label') || '' });
  })()`).catch(() => "null") : "null";
  if (c7) c7.close();
  // evalJs (returnByValue) отдаёт значение выражения — строка уже JSON
  const seventh = JSON.parse(mark7);
  if (seventh) {
    const before7 = await playerCalls();
    const tap7 = await tapSel("[data-dp236-about]");
    await sleep(4000);
    const calls7 = await playerCalls();
    shot("about");
    check("7 «Про цей результат» — не наш: плеер не открывался, оверлей виден",
      tap7.ok && calls7.length === before7.length && !!(await overlayWv()),
      `${tap7.ok ? "тап" : tap7.why} «${seventh.label}» | calls=${calls7.length}/${before7.length}`);
  } else {
    check("7 «Про цей результат» — не наш: плеер не открывался, оверлей виден", false,
      "кнопка не найдена в разметке результата (разметка изменилась?)");
  }

  // ── 8) Enter по сфокусированной «▶» (клавиатура / D-pad) ────────────────
  const NAME8 = "8 Enter (клавиатура/D-pad) по сфокусированной «▶» → плеер, один репорт";
  const s8 = await openSerp(SERP);
  // клавиша уходит в Android-фокус: касание оверлея (короткая прокрутка)
  // передаёт его WebView, фокус на миниатюре — DOM-ом
  const wv8 = await overlayWv();
  if (wv8) {
    const x8 = Math.round((wv8[0] + wv8[2]) / 2), y8 = Math.round(wv8[1] + (wv8[3] - wv8[1]) * 0.6);
    adb("shell", "input", "swipe", String(x8), String(y8), String(x8), String(y8 - 200), "300");
  } else {
    await sleep(300);
  }
  await sleep(800);
  const eighth = await pickFirst();
  const c8 = await overlayConn();
  const focused = c8 ? await c8.evalJs(`(() => {
    const a = document.querySelector("[data-dp236] [role='button']");
    if (!a) return false;
    a.scrollIntoView({ block: 'center' }); a.focus();
    return document.activeElement === a && document.hasFocus();
  })()`).catch(() => false) : false;
  if (c8) c8.close();
  if (s8 && s8.yt > 0 && eighth && focused) {
    await sleep(600);
    const before8 = await playerCalls();
    adb("shell", "input", "keyevent", "66"); // KEYCODE_ENTER
    const p8 = await openedPlayer(eighth.id);
    shot("enter");
    check(NAME8, openedOnce(p8, before8, eighth.id) && !(await overlayWv()), `calls=${JSON.stringify(p8.calls)}`);
  } else {
    check(NAME8, false, `s8=${s8 ? `YouTube ${s8.yt}` : "нет"} | результат=${JSON.stringify(eighth)} | фокус=${focused}`);
  }
  await backToOverlay();

  // ── 9) инкогнито-оверлей (приватный профиль WebView) ─────────────────────
  await invoke("mobile_web_close", {});
  await sleep(1200);
  const s9 = await openSerp(SERP, true);
  const ninth = await pickFirst();
  const profile = adb("logcat", "-d", "-v", "brief", "-s", "DuoPulseWeb").split(/\r?\n/)
    // только строки «private-profile: …» этого прогона (logcat чистится на старте)
    .filter((l) => l.includes("private-profile")).map((l) => l.replace(/^.*private-profile:\s*/, "")).pop() || "нет строки";
  check("9 инкогнито-оверлей: пейлоад в документе выдачи (__dpGoogleVideo)",
    !!s9 && s9.hooked === true, s9 ? `hooked=${s9.hooked} | профиль:${profile}` : "оверлей не отвечает");
  if (s9 && ninth) {
    const before9 = await playerCalls();
    const tap9 = await tapSel("[data-dp236] [role='button']");
    const p9 = await openedPlayer(ninth.id);
    shot("incognito");
    check("9 инкогнито-оверлей: тап по «▶» → встроенный плеер",
      tap9.ok && openedOnce(p9, before9, ninth.id) && !(await overlayWv()),
      `${tap9.ok ? "тап" : tap9.why} | calls=${JSON.stringify(p9.calls)}`);
    await backToOverlay();
  } else {
    check("9 инкогнито-оверлей: тап по «▶» → встроенный плеер", false,
      `s9=${s9 ? `YouTube ${s9.yt}` : "нет"} | результат=${JSON.stringify(ninth)}`);
  }
  await invoke("mobile_web_close", {});
  await sleep(1200);
  const s10 = await openSerp(SERP);
  check("9 возврат в обычный режим: пейлоад в документе выдачи",
    !!s10 && s10.hooked === true, s10 ? `hooked=${s10.hooked}` : "оверлей не отвечает");

  ui.c.close();
} catch (e) {
  results.push({ name: "смоук упал", ok: false, error: String(e.message || e) });
  console.log("✗ смоук упал:", e.message || e);
}
writeFileSync(OUT, JSON.stringify({ when: new Date().toISOString(), results }, null, 1));
console.log(`итог: ${results.filter((r) => r.ok).length}/${results.length} — ${OUT}`);
process.exit(results.length > 0 && results.every((r) => r.ok) ? 0 : 1);
