// E2E-прогон задачи 2.2 «Косметическая фильтрация в content-скрипте» (карточка
// duopulse-018, DoD: селекторы скрываются сразу после парсинга, координация с
// Core через bridge). Реальное приложение + локальный тест-лист
// (DUOPULSE_ADBLOCK_LISTS → файл, сеть не нужна). Через CDP в контент-вкладке:
//   1) content/cosmetic.js запросил ресурсы (WebMessage → Core →
//      PostWebMessageAsString): __duopulseCosmetic.ready/active, <style>
//      #duopulse-cosmetic с display:none!important;
//   2) host-специфичное (127.0.0.1##.e2e-site-ad) и misc-generic
//      (##div[class="e2e-misc"]) скрыты сразу;
//   3) generic class/id (##.e2e-generic-class, ###e2e-generic-id) и complex
//      generic (##.e2e-complex > span) скрыты по классам/идам из DOM;
//   4) unhide-исключение (127.0.0.1#@#.e2e-exempt-ad) — элемент видим;
//   5) поздний узел (.e2e-late-ad, вставлен скриптом страницы через 1.5 с)
//      скрыт (MutationObserver → generic-дельта);
//   6) чистый контент не тронут (computed display ≠ none);
//   7) исключение сайта (set_enabled site on=false) → reload → ничего не
//      скрыто; возврат on=true → скрыто снова;
//   8) глобальный тумблер off → reload → ничего не скрыто.
// Изоляция: APPDATA и WEBVIEW2_USER_DATA_FOLDER — во временном каталоге.
//
// Запуск:  node e2e/adblock/cosmetic.mjs [путь-к-duopulse.exe]
// Требует собранный debug-exe (cargo build) и запускает vite dev сам.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const CDP_PORT = 9229;
const HTTP_PORT = 8895;
const FIXTURE = path.join(ROOT, "e2e", "adblock", "cosmetic-fixture.txt");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))));

/** Убить только экземпляры НАШЕГО exe. */
const killOurExes = async () => {
  try {
    await run("powershell", [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='duopulse.exe'" | Where-Object { $_.ExecutablePath -eq '${EXE}' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }`,
    ]);
  } catch {
    /* уже мертвы — ок */
  }
};

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

// --- 1. локальный http-стенд: страница с рекламными и чистыми элементами ----
const page = `<!doctype html><html><head><title>cosmetic-stand</title></head><body>
<main class="content">
<div class="e2e-site-ad">site ad</div>
<div class="e2e-generic-class">generic class ad</div>
<div id="e2e-generic-id">generic id ad</div>
<div class="e2e-complex"><span>complex ad</span></div>
<div class="e2e-misc" >misc ad</div>
<div class="e2e-exempt-ad">exempt ad (unhide)</div>
<p class="clean-content">clean content</p>
<div id="result">pending</div>
</main>
<script>
setTimeout(function () {
  document.body.insertAdjacentHTML("beforeend", '<div class="e2e-late-ad">late ad</div>');
}, 1500);
</script>
</body></html>`;
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(page);
});
await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));

// --- 2. изолированный профиль + тест-лист ------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-cosmetic-e2e-"));
const appEnv = () => ({
  ...process.env,
  APPDATA: tmp,
  DUOPULSE_START_URL: `http://127.0.0.1:${HTTP_PORT}/`,
  DUOPULSE_ADBLOCK_LISTS: `test=${FIXTURE}`,
  WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
});

// --- 3. vite dev --------------------------------------------------------------
const vite = spawn("npm", ["run", "dev"], { cwd: ROOT, shell: true, stdio: "ignore" });
for (let i = 0; i < 60; i++) {
  try {
    await fetch("http://localhost:5173/");
    break;
  } catch {
    await sleep(500);
  }
}

async function waitForTargets() {
  let targets = [];
  for (let i = 0; i < 60; i++) {
    try {
      targets = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
      const hasUi = targets.some((t) => t.type === "page" && /localhost:5173/.test(t.url));
      const hasContent = targets.some((t) => t.type === "page" && t.url.includes(":" + HTTP_PORT));
      if (hasUi && hasContent) return targets;
    } catch {
      /* поднимается */
    }
    await sleep(1000);
  }
  throw new Error("CDP-цели не поднялись");
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    }
  };
  const open = new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  open.catch(() => {});
  const send = (method, params = {}) =>
    open.then(
      () =>
        new Promise((res, rej) => {
          const i = ++id;
          pending.set(i, { res, rej });
          ws.send(JSON.stringify({ id: i, method, params }));
        }),
    );
  return { send, close: () => ws.close() };
}

const evalIn = async (ws, expression) => {
  const r = await ws.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception ?? r.exceptionDetails));
  return r.result?.value;
};

/** Видимость селектора: computed display (скрыт движком → 'none'). */
const displayOf = (ws, sel) =>
  evalIn(
    ws,
    `(function () { var el = document.querySelector(${JSON.stringify(sel)}); return el ? getComputedStyle(el).display : "absent"; })()`,
  );

/** Ждать готовности косметического скрипта после (re)load. */
async function waitCosmetic(contentWs) {
  for (let i = 0; i < 30; i++) {
    const st = await evalIn(contentWs, `window.__duopulseCosmetic ?? null`);
    if (st && st.ready) return st;
    await sleep(500);
  }
  throw new Error("косметический скрипт не отчитался (__duopulseCosmetic.ready)");
}

let app;
let failures = 0;
try {
  app = spawn(EXE, [], { stdio: "ignore", env: appEnv() });
  let targets = await waitForTargets();
  const uiWs = connect(targets.find((t) => t.type === "page" && /localhost:5173/.test(t.url)).webSocketDebuggerUrl);
  const contentWs = connect(targets.find((t) => t.type === "page" && t.url.includes(":" + HTTP_PORT)).webSocketDebuggerUrl);

  for (let i = 0; i < 20; i++) {
    if ((await evalIn(uiWs, `typeof window.__duopulse`)) === "object") break;
    await sleep(500);
  }

  // (1) скрипт отчитался, фильтрация активна, style-элемент на месте
  const st = await waitCosmetic(contentWs);
  check(
    "cosmetic.js: ready+active, счётчики скрытия > 0",
    st.active === true && st.hiddenSelectors > 0,
    JSON.stringify(st),
  );
  const styleInfo = await evalIn(
    contentWs,
    `(function () { var el = document.getElementById('duopulse-cosmetic'); return el ? { blocked: window.__duopulseCosmetic.styleBlocked, text: el.textContent } : null; })()`,
  );
  check(
    "style #duopulse-cosmetic с display:none!important (CSP не мешает)",
    !!styleInfo && styleInfo.blocked === false && styleInfo.text.includes("display:none!important"),
    JSON.stringify(styleInfo)?.slice(0, 160),
  );

  // (2) host-специфичное + misc-generic — скрыты сразу
  check("host-специфичное .e2e-site-ad скрыто", (await displayOf(contentWs, ".e2e-site-ad")) === "none");
  check("misc-generic div[class=e2e-misc] скрыт", (await displayOf(contentWs, "div[class='e2e-misc']")) === "none");

  // (3) generic class/id + complex generic — скрыты по классам/идам из DOM
  check("generic .e2e-generic-class скрыт", (await displayOf(contentWs, ".e2e-generic-class")) === "none");
  check("generic #e2e-generic-id скрыт", (await displayOf(contentWs, "#e2e-generic-id")) === "none");
  check("complex-generic .e2e-complex > span скрыт", (await displayOf(contentWs, ".e2e-complex > span")) === "none");

  // (4) unhide-исключение хоста
  const exempt = await displayOf(contentWs, ".e2e-exempt-ad");
  check("unhide-исключение: .e2e-exempt-ad видим", exempt !== "none", exempt);

  // (5) поздний узел — MutationObserver → generic-дельта
  for (let i = 0; i < 20; i++) {
    const el = await evalIn(contentWs, `document.querySelector('.e2e-late-ad') ? getComputedStyle(document.querySelector('.e2e-late-ad')).display : "absent"`);
    if (el === "none") break;
    await sleep(500);
  }
  check("поздний узел .e2e-late-ad скрыт (observer)", (await displayOf(contentWs, ".e2e-late-ad")) === "none");

  // (6) чистый контент не тронут
  const clean = await displayOf(contentWs, ".clean-content");
  check("чистый контент .clean-content видим", clean !== "none", clean);

  // (7) исключение сайта → reload → ничего не скрыто; возврат → скрыто
  await evalIn(uiWs, `window.__duopulse.adblock.setEnabled({ site: "127.0.0.1", on: false })`);
  await evalIn(uiWs, `window.__duopulse.nav.reload()`);
  await sleep(2500); // reload + парсинг + первый обмен ресурсами
  const stExc = await waitCosmetic(contentWs);
  const visibleUnderException =
    (await displayOf(contentWs, ".e2e-site-ad")) !== "none" &&
    (await displayOf(contentWs, ".e2e-generic-class")) !== "none";
  check("сайт-исключение: скрытий нет (active=false)", stExc.active === false && visibleUnderException, JSON.stringify(stExc));

  await evalIn(uiWs, `window.__duopulse.adblock.setEnabled({ site: "127.0.0.1", on: true })`);
  await evalIn(uiWs, `window.__duopulse.nav.reload()`);
  await sleep(2500);
  await waitCosmetic(contentWs);
  check(
    "возврат исключения: скрытия снова работают",
    (await displayOf(contentWs, ".e2e-site-ad")) === "none" && (await displayOf(contentWs, ".e2e-generic-class")) === "none",
  );

  // (8) глобальный тумблер off → reload → ничего не скрыто
  await evalIn(uiWs, `window.__duopulse.adblock.setEnabled({ site: null, on: false })`);
  await evalIn(uiWs, `window.__duopulse.nav.reload()`);
  await sleep(2500);
  const stOff = await waitCosmetic(contentWs);
  check(
    "глобальный тумблер off: скрытий нет",
    stOff.active === false && (await displayOf(contentWs, ".e2e-site-ad")) !== "none",
    JSON.stringify(stOff),
  );

  uiWs.close();
  contentWs.close();
} catch (e) {
  failures++;
  console.error("E2E ERROR:", e.message);
} finally {
  if (app?.kill) app.kill("SIGKILL");
  await killOurExes();
  try {
    await run("taskkill", ["/PID", String(vite.pid), "/T", "/F"]);
  } catch {
    /* дерево уже мертво — ок */
  }
  httpServer.close();
  await sleep(1000);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

const failed = results.filter((r) => !r.ok).length + failures;
console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES: " + failed} (${results.length} проверок)`);
process.exit(failed === 0 ? 0 : 1);
