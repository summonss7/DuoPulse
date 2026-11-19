// E2E-смоук МОБИЛЬНОГО YouTube в web-оверлее (карточка duopulse-191: «поиск
// Ютуб → тап по Ютуб — браузер виснет»). Причина: ссылки выдачи Google несут
// app=desktop — десктопный Polymer-сайт YouTube вешает WebView телефона
// бесконечным скелетоном (рендерер не отвечает даже на CDP-eval). MobileWebHelper
// выбрасывает параметр (open/shouldOverrideUrlLoading/onPageStarted — серверный
// редирект google.com/goto не проходит shouldOverride) — мобильный UA получает
// m.youtube.com. Здесь проверяем детерминированно, без выдачи Google.
//
// Сценарий (debug-APK на эмуляторе, CDP webview_devtools_remote — конвенция
// duopulse-144; у релиза нет CDP-сокета):
//   1) mobile_web_open("https://www.youtube.com/?app=desktop&hl=uk") — адрес
//      с десктоп-форсом;
//   2) оверлей приземляется на m.youtube.com БЕЗ app=desktop (параметр срезан,
//      YouTube сам отдал мобильную версию);
//   3) страница живая: readyState complete, CDP-eval отвечает быстро —
//      до фикса десктопный скелетон глушыл рендерер на минуты;
//   4) мобильная (не десктопная) разметка: нет ytd-app/#masthead;
//   5) клик по видео на главной m.youtube — встроенный плеер (омнибокс UI
//      показывает watch?v=…), путь duopulse-139 не сломан правкой.
// Запуск (APK установлен, эмулятор поднят):
//   node e2e/mobile/yt-mobile-force-smoke.mjs
// Переопределения: YT_FORCE_URL, CDP_PORT. Результат —
// e2e/mobile/yt-mobile-force-smoke-last-run.json (gitignore, рантайм-артефакт).
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = "dev.duopulse.mobile";
const CDP_PORT = Number(process.env.CDP_PORT || 9223);
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
  const p = join(tmpdir(), `duopulse-191-${name}.png`);
  writeFileSync(p, execFileSync("adb", ["-s", SERIAL, "exec-out", "screencap", "-p"], { maxBuffer: 16 * 1024 * 1024 }));
  console.log(`скриншот: ${p}`);
};

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
};

// --- CDP ----------------------------------------------------------------------
adb("shell", "am", "force-stop", PKG);
adb("shell", "am", "start", "-n", `${PKG}/.MainActivity`);
let pid = "";
for (let i = 0; i < 30 && !pid; i++) {
  try { pid = adb("shell", "pidof", PKG).trim(); } catch { /* pidof без процесса — код 1 */ }
  if (!pid) await sleep(500);
}
if (!pid) throw new Error("процесс приложения не поднялся");
adb("forward", `tcp:${CDP_PORT}`, `localabstract:webview_devtools_remote_${pid}`);

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
  const evalJs = (expr) => new Promise((res, rej) => {
    const id = ++i;
    pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result.result.value)));
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
  return { evalJs, close: () => ws.close() };
}

/** UI-webview DuoPulse (DOM-предикат: глобал видеовхода мобильной ветки). */
async function uiPage() {
  for (let a = 0; a < 40; a++) {
    for (const t of await targets()) {
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

/** Оверлей — цель НЕ tauri.localhost с http(s)-адресом. */
async function overlayPage(timeoutMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    for (const t of await targets()) {
      if (t.url.startsWith("http") && !t.url.includes("tauri.localhost")) {
        const c = await connect(t).catch(() => null);
        if (c) return { c, t };
      }
    }
    if (Date.now() - t0 > timeoutMs) throw new Error("оверлей не появился в CDP-целях");
    await sleep(1000);
  }
}

try {
  // 1) открыть адрес с десктоп-форсом YouTube
  const ui = await uiPage();
  const opened = await ui.c.evalJs(
    `window.__TAURI_INTERNALS__.invoke('mobile_web_open', { url: ${JSON.stringify(FORCE_URL)} })`
  ).catch((e) => `err:${e.message}`);
  check("mobile_web_open(app=desktop) принят", opened === "opened", String(opened));

  // 2) оверлей на m.youtube.com без app=desktop (YouTube отдал мобильную
  //    версию после среза параметра — сам редиректит www → m)
  await sleep(9000);
  const ov = await overlayPage(10000);
  shot("overlay");
  const st = await ov.c.evalJs(
    `JSON.stringify({url: location.href, ready: document.readyState, ` +
    `desktop: !!document.querySelector('ytd-app, #masthead')})`
  ).catch((e) => `err:${e.message}`);
  let page = {};
  try { page = JSON.parse(st); } catch { page = { url: String(st).slice(0, 120) }; }
  check("оверлей на m.youtube.com", /^https:\/\/m\.youtube\.com\//.test(page.url || ""), page.url || "");
  check("app=desktop срезан", !(page.url || "").includes("app=desktop"));

  // 3) рендерер живой: страница complete, eval отвечает неблокированно
  const t0 = Date.now();
  const alive = await ov.c.evalJs("document.readyState").catch(() => "timeout");
  const evalMs = Date.now() - t0;
  check("страница complete, рендерер отвечает", alive === "complete" && evalMs < 3000,
    `readyState=${alive}, eval ${evalMs} мс`);

  // 4) мобильная разметка (нет десктопных маркеров — до фикса грузился ytd-app)
  check("десктопная разметка не грузится", page.desktop === false,
    `ytd-app/masthead=${page.desktop}`);

  // 5) клик по видео в выдаче m.youtube — встроенный плеер (duopulse-139):
  //    главная без логина пуста («Try searching»), список видео даёт поиск
  //    мобильного YouTube; SPA-переход (Navigation API) ловит консоль-хук
  //    DPURL → openVideoInPlayer → омнибокс UI показывает watch?v=…
  await ui.c.evalJs(
    `window.__TAURI_INTERNALS__.invoke('mobile_web_open', { url: 'https://m.youtube.com/results?search_query=duopulse' })`
  ).catch(() => "");
  let videoHref = "";
  for (let i = 0; i < 20 && !videoHref; i++) {
    await sleep(2000);
    videoHref = await ov.c.evalJs(
      `(() => { const a = document.querySelector('a[href*="/watch?v="]'); ` +
      `return a ? a.href : '' })()`
    ).catch(() => "");
  }
  if (videoHref) {
    await ov.c.evalJs(
      `(() => { const a = [...document.querySelectorAll('a')].find(x => x.href === ${JSON.stringify(videoHref)}); ` +
      `if (a) { a.click(); return 'clicked' } return 'no-anchor' })()`
    ).catch(() => "");
    let omni = "";
    for (let i = 0; i < 15 && !omni.includes("watch?v="); i++) {
      await sleep(2000);
      omni = await ui.c.evalJs(
        `(document.querySelector('#mOmnibox') || {value:''}).value`
      ).catch(() => "");
    }
    check("видео из выдачи открывается встроенным плеером", omni.includes("watch?v="), omni.slice(0, 80));
    shot("player");
  } else {
    check("видео из выдачи открывается встроенным плеером", false, "в выдаче m.youtube не нашлось видео-ссылки");
  }
  ov.c.close(); ui.c.close();
} catch (e) {
  results.push({ name: "смоук упал", ok: false, error: String(e.message || e) });
  console.log("✗ смоук упал:", e.message || e);
}
writeFileSync(OUT, JSON.stringify({ when: new Date().toISOString(), results }, null, 1));
console.log(`итог: ${results.filter((r) => r.ok).length}/${results.length} — ${OUT}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
