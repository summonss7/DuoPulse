// E2E-смоук МОБИЛЬНОГО YouTube в web-оверлее (карточки duopulse-191/192).
//
// 191 («поиск Ютуб → тап по Ютуб — виснет»): ссылки выдачи Google несут
// app=desktop — десктопный Polymer-сайт на МОБИЛЬНОМ UA вешает WebView
// бесконечным скелетоном (рендерер не отвечает даже на CDP-eval).
//
// 192 (доработка: «верхнее меню не такое, строка ввода адреса не
// кликабельна — со всеми сайтами из поиска; YouTube верни расширенную»):
//  - адресный чип кликабелен: тап → поле ввода с текущим адресом, GO —
//    URL-догадка (example.com → https://example.com) или поиск Google;
//    YouTube-видео из ввода/выдачи — встроенный плеер;
//  - тумблер «Десктопный YouTube» в меню «⋮» (SharedPreferences duopulse_web,
//    переживает рестарт): десктопный сайт грузится с ДЕСКТОП-UA (вис 191 —
//    пара «десктопный Polymer + мобильный UA»), m.youtube переписывается на
//    www, серверный редирект goto (стартует мимо хуков с мобильного UA)
//    ловится в onPageStarted UA-мисматчем → перезапрос. ДЕФОЛТ ВЫКЛ: стенд
//    показал, что после десктопных страниц YouTube WebView оверлея клинится
//    до конца сессии (главная грузится за 4 с, следующие навигации мертвы) —
//    потому дефолт — поведение 191, а десктоп-фазы идут В КОНЦЕ сценария.
//
// Сценарий (debug-APK на эмуляторе, CDP webview_devtools_remote):
//   A (ДЕФОЛТ duopulse-210 — десктопный YouTube): 1) app=desktop-адрес →
//      www.youtube.com с десктоп-UA и ytd-app; 2) клик по видео десктопной
//      выдачи (SPA) → встроенный плеер; 3) тап по адресному чипу → поле
//      ввода с адресом → «example.com» GO → https://example.com/ (живой
//      переход YouTube→прочие = смена UA, прежде гасившая навигацию);
//      4) ввод запроса «duopulse 210» → выдача Google; 5) ЛОКАЛЬНЫЙ
//      302-редирект (имитирует google.com/goto органики) с мобильного UA →
//      перехват onPageStarted перезапрашивает десктопным UA → www десктопом
//      (регресс жалобы 210-2 «нажатие на ссылку не переходит»);
//   C (duopulse-207/210, шапка — зеркало старта): 6) состав шапки —
//      ⌂/вкладки(бейдж)/очки/⬇(при видео)/⋮ + поле/★/GO и их порядок;
//      7) звёздочка закладки — тап ★/☆; 8) «⬇» на обычной странице —
//      тост-подсказка; 9) очки — инкогнито ON (оверлей закрылся, m-private)
//      и выход кнопкой старта; 10) кнопка вкладок — лист вкладок старта
//      (оверлей спрятан, «назад» возвращает);
//   B (мобильная версия — пункт «⋮» «Мобильная версия YouTube», 210):
//      11) переключение в мобильную; 12) app=desktop → m.youtube.com,
//      параметр срезан, десктоп-разметки нет (поведение 191); 13) рестарт
//      приложения (режим пережил) + локальный goto-редирект → m.youtube.
// Запуск (APK установлен, эмулятор поднят):
//   node e2e/mobile/yt-mobile-force-smoke.mjs
// Переопределения: YT_FORCE_URL, CDP_PORT, REDIR_PORT. Результат —
// e2e/mobile/yt-mobile-force-smoke-last-run.json (gitignore, рантайм-артефакт).
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = "dev.duopulse.mobile";
const CDP_PORT = Number(process.env.CDP_PORT || 9223);
const REDIR_PORT = Number(process.env.REDIR_PORT || 8931);
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "yt-mobile-force-smoke-last-run.json");
const FORCE_URL = process.env.YT_FORCE_URL || "https://www.youtube.com/?app=desktop&hl=uk";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SERIAL = process.env.ANDROID_SERIAL ||
  execFileSync("adb", ["devices"], { encoding: "utf8" })
    .split(/\r?\n/).slice(1).find((l) => l.trim().endsWith("device"))?.split("\t")[0].trim() || "";
if (!SERIAL) throw new Error("эмулятор не найден (adb devices)");
const adb = (...args) =>
  execFileSync("adb", ["-s", SERIAL, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const shot = (name) => {
  const p = join(tmpdir(), `duopulse-192-${name}.png`);
  writeFileSync(p, execFileSync("adb", ["-s", SERIAL, "exec-out", "screencap", "-p"], { maxBuffer: 16 * 1024 * 1024 }));
  console.log(`скриншот: ${p}`);
};

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok, ...(extra ? { extra } : {}) });
  console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
};

// --- локальный 302-редиректор: эмулирует google.com/goto выдачи ----------
// (эмулятор видит хост как 10.0.2.2; cleartext-http в debug-сборке разрешён)
const redir = createServer((req, res) => {
  res.writeHead(302, { Location: FORCE_URL });
  res.end();
});
await new Promise((r) => redir.listen(REDIR_PORT, "0.0.0.0", r));

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
  // таймаут на КАЖДЫЙ eval (грабли duopulse-192: занятая/спрятанная страница
  // не отвечает минутами — промис без таймаута мёртв навсегда)
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
 *  медленно — один прогон 192 повис именно на invoke-эвале). */
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

/** Один опрос оверлея без ожидания (null — цели нет/рендерер молчит).
 *  Мёртвая/занятая цель не должна глушить опрос — пробуем следующую. */
async function overlayStateNoWait() {
  for (const t of await targets()) {
    if (!t.url.startsWith("http") || t.url.includes("tauri.localhost")) continue;
    const c = await connect(t).catch(() => null);
    if (!c) continue;
    const raw = await c.evalJs(
      `JSON.stringify({url: location.href, ready: document.readyState, ` +
      `desktop: !!document.querySelector('ytd-app, #masthead'), ua: navigator.userAgent})`
    ).catch(() => "");
    c.close();
    try { return JSON.parse(raw); } catch { /* занятая цель — следующая */ }
  }
  return null;
}

/** Оверлей — цель НЕ tauri.localhost с http(s)-адресом; ждём готовности:
 *  readyState complete и стабильный адрес (settleMs>0 — два совпадения). */
async function overlayState(timeoutMs = 30000, settleMs = 0) {
  const t0 = Date.now();
  let last = { url: "", ready: "", desktop: null, ua: "" };
  let prevUrl = null;
  for (;;) {
    const st = await overlayStateNoWait();
    if (st) {
      last = st;
      if (st.ready === "complete") {
        if (!settleMs) return st;
        if (prevUrl === st.url) return st;
        prevUrl = st.url;
      }
    }
    if (Date.now() - t0 > timeoutMs) return last;
    await sleep(settleMs ? 1500 : 2000);
  }
}

/** Eval в оверлее (текущая http-цель); null — цели нет/не отвечает. */
async function overlayEval(expr) {
  for (const t of await targets()) {
    if (!t.url.startsWith("http") || t.url.includes("tauri.localhost")) continue;
    const c = await connect(t).catch(() => null);
    if (!c) continue;
    const v = await c.evalJs(expr).catch(() => null);
    c.close();
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

// --- нативный UI: uiautomator dump → узлы (text/desc/class → центр) ------
function uiNodes() {
  for (let a = 0; a < 6; a++) {
    try {
      adb("shell", "uiautomator", "dump", "/sdcard/uidump.xml");
      const xml = adb("shell", "cat", "/sdcard/uidump.xml").replace(/\r/g, "");
      const attr = (tag, name) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? "";
      const nodes = [];
      for (const m of xml.matchAll(/<node[^>]*>/g)) {
        const b = m[0].match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
        if (!b) continue;
        nodes.push({
          text: attr(m[0], "text"), desc: attr(m[0], "content-desc"),
          cls: attr(m[0], "class"), focused: attr(m[0], "focused") === "true",
          x: Math.round((+b[1] + +b[3]) / 2), y: Math.round((+b[2] + +b[4]) / 2),
        });
      }
      if (nodes.length) return nodes;
    } catch { /* dump гонится за анимацией — повтор */ }
    sleep(400);
  }
  return [];
}

/** Тап по узлу (предикат по text/desc/class). */
function tapNode(pred, label) {
  const n = uiNodes().find(pred);
  if (!n) { console.log(`! узел не найден: ${label}`); return false; }
  adb("shell", "input", "tap", String(n.x), String(n.y));
  return true;
}

let ui;
const openOverlay = (url) => invoke("mobile_web_open", { url });
try {
  await startApp();
  ui = await uiPage();

  // ── сброс состояния: duopulse-210 — дефолт ДЕСКТОПНЫЙ YouTube; прошлый
  //    прогон мог оставить мобильный режим (персистенс SharedPreferences
  //    переживает рестарты) — включаем десктопный через меню «⋮» (пункт
  //    называет ЦЕЛЬ: при десктопе предлагает «Мобильная версия YouTube»),
  //    чтобы фаза A стартовала с заводским дефолтом
  await openOverlay("https://example.com/");
  await overlayState(25000, 2000);
  if (tapNode((n) => n.desc === "Меню" || n.text === "⋮", "кнопка ⋮")) {
    await sleep(700);
    if (!tapNode((n) => (n.text || "").includes("Десктопная версия YouTube"), "Десктопная версия YouTube → ON")) {
      adb("shell", "input", "tap", "540", "1200"); // уже десктоп — закрыть меню
    }
    await sleep(800);
  }

  // ── Фаза A: ДЕФОЛТ duopulse-210 — десктопный YouTube ──────────────────
  await openOverlay(FORCE_URL);
  const a1 = await overlayState(120000, 4000);
  shot("a1-desktop-youtube");
  check("A1 дефолт: оверлей на www.youtube.com (десктоп)",
    /^https:\/\/www\.youtube\.com\//.test(a1.url || ""), a1.url || "цель не отвечает");
  check("A1 UA десктопный", !(a1.ua || "").includes("Android") && (a1.ua || "").includes("Windows"), (a1.ua || "").slice(0, 60));
  check("A1 десктопная разметка грузится (ytd-app)", a1.desktop === true, `ytd-app=${a1.desktop}, ready=${a1.ready}`);

  // 2) клик по видео десктопной выдачи (SPA-переход) → встроенный плеер
  //    (консоль-хук DPURL, duopulse-139/210)
  await openOverlay("https://www.youtube.com/results?search_query=duopulse&hl=uk");
  await overlayState(45000, 4000);
  let videoHref = "";
  for (let i = 0; i < 20 && !videoHref; i++) {
    await sleep(2000);
    videoHref = await overlayEval(
      `(() => { const a = document.querySelector('a[href*="/watch?v="]'); return a ? a.href : '' })()`
    ) ?? "";
  }
  if (videoHref) {
    await overlayEval(
      `(() => { const a = [...document.querySelectorAll('a')].find(x => x.href === ${JSON.stringify(videoHref)}); ` +
      `if (a) { a.click(); return 'clicked' } return 'no-anchor' })()`
    );
    let omni = "";
    for (let i = 0; i < 15 && !omni.includes("watch?v="); i++) {
      await sleep(2000);
      omni = await ui.c.evalJs(`(document.querySelector('#mOmnibox') || {value:''}).value`).catch(() => "");
    }
    check("A2 видео из десктопной выдачи (SPA) → встроенный плеер", omni.includes("watch?v="), omni.slice(0, 80));
    adb("shell", "input", "keyevent", "4"); // из плеера — к выдаче
    await sleep(1500);
  } else {
    check("A2 видео из десктопной выдачи (SPA) → встроенный плеер", false, "в выдаче www.youtube не нашлось видео-ссылки");
  }

  // 3) адресная строка кликабельна: тап по чипу → поле ввода с текущим
  //    адресом в фокусе → «example.com» + GO → https://example.com/.
  //    ОСТОРОЖНО: омнибокс главного UI — тоже EditText с https-текстом
  //    (после A2 там watch?v=…); поле оверлея ищем по focused И отсутствию
  //    watch?v=, ввод сверяем по тексту ДО нажатия GO
  const editFocused = () => uiNodes().find(
    (n) => (n.cls || "").includes("EditText") && n.focused && !(n.text || "").includes("watch?v="));
  const chipTapped = tapNode((n) => n.desc === "Адресная строка", "адресный чип");
  let f = null;
  for (let i = 0; i < 8 && !f; i++) {
    f = editFocused();
    if (!f) await sleep(500);
  }
  check("A3a тап по чипу открывает поле ввода (в фокусе, с адресом)",
    chipTapped && !!f && /^https?:\/\//.test(f?.text || ""), `focused-edit=${JSON.stringify((f?.text || "").slice(0, 50))}`);
  adb("shell", "input", "text", "example.com");
  await sleep(600);
  const typed = editFocused();
  check("A3b ввод принял «example.com»", (typed?.text || "") === "example.com",
    `поле=${JSON.stringify(typed?.text || "")}`);
  adb("shell", "input", "keyevent", "66"); // GO
  const a3 = await overlayState(30000, 3000);
  shot("a3-example");
  check("A3c GO → https://example.com/ (строка адреса кликабельна)",
    /^https:\/\/example\.com\//.test(a3.url || "") && a3.ready === "complete",
    `${a3.url || "цель не отвечает"} ready=${a3.ready}`);

  // 4) ввод ПОИСКА в поле адреса: «duopulse 192» → выдача Google
  if (tapNode((n) => n.desc === "Адресная строка", "адресный чип")) {
    let g = null;
    for (let i = 0; i < 8 && !g; i++) {
      g = editFocused();
      if (!g) await sleep(500);
    }
    if (g) {
      adb("shell", "input", "text", "duopulse%s210"); // %s = пробел
      await sleep(600);
      adb("shell", "input", "keyevent", "66");
      const a4 = await overlayState(40000, 3000);
      check("A4 ввод запроса → поиск Google", (a4.url || "").includes("google.com/search"), a4.url || "цель не отвечает");
    } else {
      check("A4 ввод запроса → поиск Google", false, "поле ввода не в фокусе");
    }
  } else {
    check("A4 ввод запроса → поиск Google", false, "чип не найден");
  }

  // 5) goto-редирект десктоп-режимом (регресс жалобы 210-2 «нажатие на
  //    ссылку [органики YouTube] не переходит»): после Google UA мобильный;
  //    локальный 302 на youtube.com/?app=desktop стартует МИМО наших хуков —
  //    onPageStarted обязан сменить UA и ПЕРЕЗАПРОСИТЬ (прежде смена UA
  //    гасила навигацию — страница «отскакивала» обратно к выдаче)
  await openOverlay(`http://10.0.2.2:${REDIR_PORT}/goto`);
  const a5 = await overlayState(120000, 4000);
  shot("a5-goto-desktop");
  check("A5 goto-редирект → www.youtube.com десктопом (не отскочил)",
    /^https:\/\/www\.youtube\.com\//.test(a5.url || "") && a5.desktop === true && !(a5.ua || "").includes("Android"),
    `${a5.url || "цель не отвечает"} ytd-app=${a5.desktop} ready=${a5.ready}`);

  // ── Фаза C (duopulse-207/210): шапка оверлея — зеркало старта ─────────
  // вкладки(бейдж) + очки-инкогнито + «⬇» (при открытом видео, состояние
  // живое из __duopulseHeaderState) + звёздочка закладки в строке адреса
  {
    await openOverlay("https://example.com/");
    await overlayState(25000, 2000);
    // живое состояние старта: есть ли видео (⬇ видно ⇔ видео, как #mMusic)
    const headerState = await ui.c.evalJs(
      "window.__duopulseHeaderState ? JSON.stringify(window.__duopulseHeaderState()) : null"
    ).catch(() => null);
    const videoOpen = !!(headerState && JSON.parse(headerState).video);
    const nodes = uiNodes();
    const byDesc = (d) => nodes.find((n) => n.desc === d);
    const home = byDesc("На стартовый экран");
    const tabs = byDesc("Вкладки");
    const glasses = byDesc("Инкогнито");
    const music = byDesc("Скачать: аудио, видео или субтитры");
    const menu = nodes.find((n) => n.desc === "Меню" || n.text === "⋮");
    const edit = byDesc("Адресная строка");
    const star = nodes.find((n) => n.desc === "В избранное" || n.desc === "Убрать из избранного");
    const go = byDesc("Перейти");
    shot("c1-full-bar");
    check("C1 полный состав шапки (⌂/вкладки/очки/[⬇ при видео]/⋮/поле/★/GO)",
      !!(home && tabs && glasses && menu && edit && star && go) &&
        (!!music === videoOpen),
      `⌂=${!!home} вкладки=${!!tabs} очки=${!!glasses} ⬇=${!!music}(видео=${videoOpen}) ⋮=${!!menu} поле=${!!edit} ★=${!!star} GO=${!!go}`);
    check("C1 порядок: вкладки и очки перед «⋮», ★ между полем и GO",
      !!(tabs && glasses && menu && edit && star && go &&
        tabs.x < glasses.x && glasses.x < menu.x &&
        edit.x < star.x && star.x < go.x),
      `x: вкладки=${tabs?.x} очки=${glasses?.x} ⋮=${menu?.x} поле=${edit?.x} ★=${star?.x} GO=${go?.x}`);

    // звёздочка (иконка duopulse-210 — без текста, состояние по desc):
    // тап → закладка («Убрать из избранного»), повтор → снята («В избранное»)
    if (star) {
      adb("shell", "input", "tap", String(star.x), String(star.y));
      let st = null;
      for (let i = 0; i < 6 && !st; i++) {
        await sleep(400);
        st = uiNodes().find((n) => n.desc === "Убрать из избранного");
      }
      check("C2a тап ★ — страница в закладках (иконка залита)", !!st);
      if (st) {
        adb("shell", "input", "tap", String(st.x), String(st.y));
        let back = null;
        for (let i = 0; i < 6 && !back; i++) {
          await sleep(400);
          back = uiNodes().find((n) => n.desc === "В избранное");
        }
        check("C2b повторный тап — закладка снята (контур)", !!back);
      } else {
        check("C2b повторный тап — закладка снята (контур)", false, "звезда не включилась");
      }
    } else {
      check("C2a тап ★ — страница в закладках (иконка залита)", false, "узел ★ не найден");
      check("C2b повторный тап — закладка снята (контур)", false, "узел ★ не найден");
    }

    // «⬇» на не-видео странице: тост-подсказка (кнопка не молчит).
    // uiautomator на API 36 тосты НЕ отдаёт (окно SystemUI) — ловим
    // пикселями сырого screencap: полупрозрачный серый пилл внизу-по-центру
    // (сплошной серый прогон >80px; текст страницы даёт лишь короткие штрихи)
    const toastVisible = () => {
      try {
        const raw = execFileSync("adb", ["-s", SERIAL, "exec-out", "screencap"],
          { maxBuffer: 24 * 1024 * 1024 });
        const w = raw.readUInt32LE(0), h = raw.readUInt32LE(4);
        if (!w || !h || raw.length < 12 + w * h * 4) return false;
        for (let y = Math.floor(h * 0.88); y < h - 30; y += 4) {
          let run = 0;
          for (let x = 100; x < w - 100; x++) {
            const o = 12 + (y * w + x) * 4;
            const r = raw[o], g = raw[o + 1], b = raw[o + 2];
            const gray = Math.abs(r - g) < 24 && Math.abs(g - b) < 24;
            if (r + g + b < 680 && gray) {
              run++;
              if (run > 80) return true;
            } else {
              run = 0;
            }
          }
        }
        return false;
      } catch {
        return false;
      }
    };
    if (music) {
      adb("shell", "input", "tap", String(music.x), String(music.y));
      let toast = false;
      for (let i = 0; i < 4 && !toast; i++) {
        toast = toastVisible();
        if (!toast) await sleep(400);
      }
      check("C3 «⬇» на обычной странице — тост-подсказка", toast);
    } else {
      // duopulse-210: ⬇ видна ⇔ открыто видео (зеркало старта) — фаза C
      // после openOverlay/newTab видео-вкладки может не быть; тогда честная
      // проверка — кнопки НЕТ (не «всегда видна», как было в 207)
      check("C3 «⬇» скрыта без видео (зеркало старта)", videoOpen === false,
        `⬇=${!!music} видео=${videoOpen}`);
    }

    // очки-инкогнито: тап → режим ON (body.m-private UI-webview) и оверлей
    // закрылся (нативного «⋮» больше нет — оверлей на общем профиле WebView);
    // выход — кнопкой-очками старта (#mPrivate)
    if (glasses) {
      adb("shell", "input", "tap", String(glasses.x), String(glasses.y));
      let priv = false;
      let overlayGone = false;
      for (let i = 0; i < 10 && !(priv && overlayGone); i++) {
        await sleep(700);
        priv = await ui.c.evalJs("document.body.classList.contains('m-private')").catch(() => false);
        overlayGone = !uiNodes().some((n) => n.desc === "Меню");
      }
      check("C4a очки включают инкогнито (m-private, оверлей закрылся)",
        priv === true && overlayGone === true, `m-private=${priv} нативный ⋮ остался=${!overlayGone}`);
      await ui.c.evalJs("document.getElementById('mPrivate').click()").catch(() => {});
      let off = false;
      for (let i = 0; i < 10 && !off; i++) {
        await sleep(700);
        off = await ui.c.evalJs("!document.body.classList.contains('m-private')").catch(() => false);
      }
      check("C4b выход из инкогнито кнопкой старта", off === true);
    } else {
      check("C4a очки включают инкогнито (m-private, оверлей закрылся)", false, "узел очков не найден");
      check("C4b выход из инкогнито кнопкой старта", false, "узел очков не найден");
    }

    // кнопка вкладок (duopulse-210): тап — лист вкладок старта открылся
    // (оверлей спрятан: нативного «⋮» нет), системный «назад» возвращает
    // оверлей. C4 мог закрыть оверлей — поднимаем заново
    await openOverlay("https://example.com/");
    await overlayState(25000, 2000);
    if (tapNode((n) => n.desc === "Вкладки", "кнопка вкладок")) {
      let sheetOpen = false;
      let overlayGone = false;
      for (let i = 0; i < 10 && !(sheetOpen && overlayGone); i++) {
        await sleep(700);
        sheetOpen = await ui.c.evalJs(
          "window.__duopulseMobileTabs ? window.__duopulseMobileTabs().switcherOpen === true : false"
        ).catch(() => false);
        overlayGone = !uiNodes().some((n) => n.desc === "Меню");
      }
      check("C5 вкладки: лист старта открылся, оверлей спрятан",
        sheetOpen === true && overlayGone === true,
        `лист=${sheetOpen} оверлей остался=${!overlayGone}`);
      adb("shell", "input", "keyevent", "4"); // «назад» — скрытый оверлей
      await sleep(1200);
      const back = uiNodes().some((n) => n.desc === "Меню");
      check("C5 «назад» вернул оверлей", back === true);
    } else {
      check("C5 вкладки: лист старта открылся, оверлей спрятан", false, "кнопка вкладок не найдена");
      check("C5 «назад» вернул оверлей", false, "кнопка вкладок не найдена");
    }
  }

  // ── Фаза B: мобильная версия YouTube (duopulse-210 — пункт «⋮» называет
  // цель перехода; прежний «расширенный» режим и есть дефолт фазы A) ─────
  await openOverlay("https://example.com/");
  await overlayState(25000, 2000);
  // 11) меню «⋮» → «Мобильная версия YouTube» → мобильный режим
  const menuTapped = tapNode((n) => n.desc === "Меню" || n.text === "⋮", "кнопка ⋮");
  await sleep(700);
  const toggled = menuTapped &&
    tapNode((n) => (n.text || "").includes("Мобильная версия YouTube"), "Мобильная версия YouTube");
  check("B5 переключение на мобильную версию YouTube", toggled);
  await sleep(1200);

  // 12) app=desktop срезается (поведение 191): m.youtube, мобильный UA,
  //     десктоп-разметки нет
  await openOverlay(FORCE_URL);
  const b6 = await overlayState(60000, 4000);
  shot("b6-mobile-youtube");
  check("B6 мобильная: оверлей на m.youtube.com (app=desktop срезан)",
    /^https:\/\/m\.youtube\.com\//.test(b6.url || "") && !(b6.url || "").includes("app=desktop"),
    b6.url || "цель не отвечает");
  check("B6 мобильная: десктопной разметки нет", b6.desktop === false, `ytd-app=${b6.desktop}, ready=${b6.ready}`);

  // 13) перезапуск (режим пережил, SharedPreferences) + goto-редирект
  //     органики → m.youtube мобильной (перехват onPageStarted 191)
  await startApp();
  ui = await uiPage();
  await openOverlay(`http://10.0.2.2:${REDIR_PORT}/goto`);
  const b7 = await overlayState(60000, 4000);
  shot("b7-after-redirect");
  check("B7 рестарт+редирект: мобильный режим жив, m.youtube",
    /^https:\/\/m\.youtube\.com\//.test(b7.url || "") && b7.desktop === false,
    `${b7.url || "цель не отвечает"} ytd-app=${b7.desktop} ready=${b7.ready}`);

  ui.c.close();
} catch (e) {
  results.push({ name: "смоук упал", ok: false, error: String(e.message || e) });
  console.log("✗ смоук упал:", e.message || e);
} finally {
  redir.close();
}
writeFileSync(OUT, JSON.stringify({ when: new Date().toISOString(), results }, null, 1));
console.log(`итог: ${results.filter((r) => r.ok).length}/${results.length} — ${OUT}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
