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
//   A (дефолт, как 191): 1) app=desktop-адрес → m.youtube.com, параметр
//      срезан, readyState complete, десктоп-разметки нет; 2) клик по видео
//      мобильной выдачи → встроенный плеер; 3) тап по адресному чипу → поле
//      ввода с адресом → «example.com» GO → https://example.com/; 4) ввод
//      запроса «duopulse 192» → выдача Google;
//   B (расширенный): 5) тумблер ON через меню «⋮»; 6) app=desktop →
//      www.youtube.com с десктоп-UA и ytd-app; 7) рестарт приложения (тумблер
//      ON пережил) + ЛОКАЛЬНЫЙ 302-редирект (имитирует google.com/goto,
//      стартует с мобильного UA на свежем процессе) → www десктопом —
//      перехват onPageStarted.
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

  // ── сброс состояния: прошлый прогон оставляет тумблер ON (персистенс
  //    SharedPreferences переживает рестарты) — выключаем через меню «⋮»,
  //    чтобы фаза A стартовала с заводским дефолтом (мобильный YouTube)
  await openOverlay("https://example.com/");
  await overlayState(25000, 2000);
  if (tapNode((n) => n.desc === "Меню" || n.text === "⋮", "кнопка ⋮")) {
    await sleep(700);
    if (!tapNode((n) => (n.text || "").startsWith("✓") && (n.text || "").includes("Десктопный YouTube"), "✓ Десктопный YouTube → OFF")) {
      adb("shell", "input", "tap", "540", "1200"); // уже OFF — закрыть меню
    }
    await sleep(800);
  }

  // ── Фаза A: дефолт — поведение 191 (мобильный YouTube) ─────────────────
  await openOverlay(FORCE_URL);
  const a1 = await overlayState(45000, 4000);
  shot("a1-mobile-youtube");
  check("A1 оверлей на m.youtube.com (app=desktop срезан)",
    /^https:\/\/m\.youtube\.com\//.test(a1.url || "") && !(a1.url || "").includes("app=desktop"),
    a1.url || "цель не отвечает");
  check("A1 десктопная разметка не грузится", a1.desktop === false, `ytd-app=${a1.desktop}, ready=${a1.ready}`);
  check("A1 рендерер жив (complete)", a1.ready === "complete", `readyState=${a1.ready}`);

  // 2) клик по видео мобильной выдачи → встроенный плеер (duopulse-139)
  await openOverlay("https://m.youtube.com/results?search_query=duopulse&hl=uk");
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
    check("A2 видео из мобильной выдачи → встроенный плеер", omni.includes("watch?v="), omni.slice(0, 80));
    adb("shell", "input", "keyevent", "4"); // из плеера — к выдаче
    await sleep(1500);
  } else {
    check("A2 видео из мобильной выдачи → встроенный плеер", false, "в выдаче m.youtube не нашлось видео-ссылки");
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
      adb("shell", "input", "text", "duopulse%s192"); // %s = пробел
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

  // ── Фаза B: «расширенный» YouTube тумблером (десктоп-фазы — в конце:
  // после десктопных страниц WebView оверлея может клиниться до рестарта) ─
  // 5) меню «⋮» → «○ Десктопный YouTube» → ON
  const menuTapped = tapNode((n) => n.desc === "Меню" || n.text === "⋮", "кнопка ⋮");
  await sleep(700);
  const toggled = menuTapped &&
    tapNode((n) => (n.text || "").includes("Десктопный YouTube") && (n.text || "").startsWith("○"), "○ Десктопный YouTube");
  check("B5 тумблер «Десктопный YouTube» переключен в ON", toggled);
  await sleep(1200);

  // 6) app=desktop грузится ДЕСКТОПОМ: www остаётся www, UA десктопный,
  //    десктоп-разметка (до 191 — скелетон; на эмуляторе десктоп-страницы
  //    медленные — щедрый таймаут)
  await openOverlay(FORCE_URL);
  const b6 = await overlayState(120000, 4000);
  shot("b6-desktop-youtube");
  check("B6 расширенный: оверлей на www.youtube.com", /^https:\/\/www\.youtube\.com\//.test(b6.url || ""), b6.url || "цель не отвечает");
  check("B6 UA десктопный", !(b6.ua || "").includes("Android") && (b6.ua || "").includes("Windows"), (b6.ua || "").slice(0, 60));
  check("B6 десктопная разметка грузится (ytd-app)", b6.desktop === true, `ytd-app=${b6.desktop}, ready=${b6.ready}`);

  // 7) перезапуск + серверный редирект (как google.com/goto органики):
  //    свежий процесс, тумблер ON пережил рестарт (SharedPreferences);
  //    goto стартует app=desktop МИМО наших хуков с мобильного UA —
  //    onPageStarted обязан перезапросить десктопным UA (иначе пара
  //    «десктопный Polymer + мобильный UA» = вис 191)
  await startApp();
  ui = await uiPage();
  await openOverlay(`http://10.0.2.2:${REDIR_PORT}/goto`);
  const b7 = await overlayState(120000, 4000);
  shot("b7-after-redirect");
  check("B7 рестарт+редирект: тумблер ON жив, www десктопом",
    /^https:\/\/www\.youtube\.com\//.test(b7.url || "") && b7.desktop === true && !(b7.ua || "").includes("Android"),
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
