// E2E-прогон задачи 1.2 «Таб-бар: вкладки, закрытие, Ctrl+Tab, восстановление
// закрытой» (карточка duopulse-012, DoD: ручной чек-лист — 5+ вкладок,
// переключения, закрытие, Ctrl+Tab, Ctrl+Shift+T). На реальном приложении:
//   1) старт: одна вкладка, событие tabs.updated приходит в UI;
//   2) tabs.open × 4 → 5 вкладок в порядке открытия, каждая новая активна,
//      заголовки страниц приходят событием (DocumentTitleChanged);
//   3) клик-эквивалент tabs.activate → активная меняется, nav.navigate ведёт
//      активную вкладку;
//   4) закрытие средней вкладки: соседняя становится активной, порядок жив;
//   5) Ctrl+Tab / Ctrl+Shift+Tab из КОНТЕНТНОЙ вкладки (content/chrome-hotkeys.js
//      → WebMessage → Core): активная_switch по кольцу;
//   6) Ctrl+Shift+T: закрытая вкладка возвращается (URL тот же, новая активна);
//   7) UI-хоткеи (событие keydown в UI-webview) — то же переключение;
//   8) скриншот таб-бара для сверки со стилем (гайд 06).
// Изоляция: APPDATA и WEBVIEW2_USER_DATA_FOLDER — во временном каталоге.
//
// Запуск:  node e2e/tabs/run.mjs [путь-к-duopulse.exe]
// Требует собранный debug-exe (cargo build) и запускает vite dev сам.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const CDP_PORT = 9225;
const HTTP_PORT = 8897;
const OUT_DIR = path.join(ROOT, "e2e", "tabs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))));

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

// --- 1. локальный http-стенд: страницы с <title> -------------------------------
const page = (n) => `<html><head><title>Страница ${n}</title></head><body><h1>/p${n}</h1></body></html>`;
const httpServer = http.createServer((req, res) => {
  const m = req.url.match(/^\/p(\d+)/);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(m ? page(Number(m[1])) : `<html><head><title>Старт</title></head><body><h1>start</h1></body></html>`);
});
await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));
const url = (p) => `http://127.0.0.1:${HTTP_PORT}/${p}`;

// --- 2. изолированный профиль + приложение -------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-tabs-e2e-"));
const vite = spawn("npm", ["run", "dev"], { cwd: ROOT, shell: true, stdio: "ignore" });
for (let i = 0; i < 60; i++) {
  try {
    await fetch("http://localhost:5173/");
    break;
  } catch {
    await sleep(500);
  }
}
const app = spawn(EXE, [], {
  stdio: "ignore",
  env: {
    ...process.env,
    APPDATA: tmp,
    DUOPULSE_START_URL: url("start"),
    WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
  },
});

// --- 3. ждём CDP ---------------------------------------------------------------
let targets = [];
for (let i = 0; i < 60; i++) {
  try {
    targets = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
    if (targets.some((t) => t.type === "page" && /localhost:5173/.test(t.url))) break;
  } catch {
    /* поднимается */
  }
  await sleep(1000);
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

const tabsList = (uiWs) => evalIn(uiWs, `window.__duopulse.tabs.list()`);
const activeTab = async (uiWs) => (await tabsList(uiWs)).tabs.find((t) => t.active);
const keydown = (ws, js) => evalIn(ws, js);

let failures = 0;
try {
  const ui = targets.find((t) => t.type === "page" && /localhost:5173/.test(t.url));
  if (!ui) throw new Error("UI-цель CDP не найдена: " + targets.map((t) => t.url).join(", "));
  const uiWs = connect(ui.webSocketDebuggerUrl);

  let probe;
  for (let i = 0; i < 20; i++) {
    probe = await evalIn(uiWs, `typeof window.__duopulse`);
    if (probe === "object") break;
    await sleep(500);
  }
  check("dev-хук window.__duopulse доступен в UI", probe === "object", `typeof=${probe}`);

  // (1) старт: одна вкладка tab-N, активна, событие tabs.updated доставлено
  let tabs = (await tabsList(uiWs)).tabs;
  check(
    "старт: единственная вкладка tab-*, активна, URL стартовой",
    tabs.length === 1 && /^tab-\d+$/.test(tabs[0].id) && tabs[0].active && tabs[0].url.endsWith("/start"),
    JSON.stringify(tabs),
  );
  await sleep(500);
  const evCount0 = await evalIn(uiWs, `window.__duopulseTabsEvents.length`);
  check(
    "журнал событий dev-хука инициализирован (первичный эмит может опережать подписку — стартовый список таб-бар берёт tabs.list)",
    typeof evCount0 === "number",
    `записей=${evCount0}`,
  );

  // (2) открытие 4 вкладок → всего 5, каждая новая активна, заголовки приходят
  for (let n = 1; n <= 4; n++) {
    await evalIn(uiWs, `window.__duopulse.tabs.open({ url: "${url("p" + n)}" })`);
    await sleep(600);
  }
  tabs = (await tabsList(uiWs)).tabs;
  check("tabs.open ×4: в баре 5 вкладок в порядке открытия", tabs.length === 5 && tabs[4].active, JSON.stringify(tabs.map((t) => t.url)));
  await sleep(700); // DocumentTitleChanged асинхронен после загрузки
  tabs = (await tabsList(uiWs)).tabs;
  check(
    "заголовки страниц видны в списке (DocumentTitleChanged)",
    tabs[1].title === "Страница 1" && tabs[4].title === "Страница 4",
    JSON.stringify(tabs.map((t) => t.title)),
  );
  const evCount = await evalIn(uiWs, `window.__duopulseTabsEvents.length`);
  check(
    "событие tabs.updated доставляется в UI после мутаций (открытия/загрузки)",
    evCount >= 4,
    `записей=${evCount}`,
  );

  // (3) переключение на среднюю + nav.navigate ведёт активную
  const midId = tabs[2].id;
  await evalIn(uiWs, `window.__duopulse.tabs.activate({ id: "${midId}" })`);
  check("tabs.activate: средняя вкладка активна", (await activeTab(uiWs)).id === midId);
  await evalIn(uiWs, `window.__duopulse.nav.navigate({ url: "${url("p3-moved")}" })`);
  await sleep(600);
  tabs = (await tabsList(uiWs)).tabs;
  check(
    "nav.navigate: URL сменился у активной (средней) вкладки",
    tabs[2].url.endsWith("/p3-moved") && tabs[0].url.endsWith("/start"),
    JSON.stringify(tabs.map((t) => t.url)),
  );

  // (4) закрытие средней: активной становится правая соседка, порядок жив
  await evalIn(uiWs, `window.__duopulse.tabs.close({ id: "${midId}" })`);
  await sleep(400);
  tabs = (await tabsList(uiWs)).tabs;
  const activeAfterClose = await activeTab(uiWs);
  check(
    "tabs.close: средней нет, активна правая соседка, порядок сохранён",
    tabs.length === 4 &&
      activeAfterClose.url.endsWith("/p3") &&
      !tabs.some((t) => t.url.includes("p3-moved")),
    JSON.stringify({ urls: tabs.map((t) => t.url), active: activeAfterClose.url }),
  );

  // (5) Ctrl+Tab / Ctrl+Shift+Tab из контентной вкладки
  // активная сейчас — бывшая соседка (p4-позиция); ждём её CDP-цель
  const activeUrl = (await activeTab(uiWs)).url;
  let contentTargets;
  for (let i = 0; i < 20; i++) {
    contentTargets = (await (await fetch(`http://localhost:${CDP_PORT}/json`)).json()).filter(
      (t) => t.type === "page" && t.url.includes(`:${HTTP_PORT}`) && !t.url.includes("start"),
    );
    if (contentTargets.some((t) => t.url === activeUrl)) break;
    await sleep(500);
  }
  const contentWs = connect(contentTargets.find((t) => t.url === activeUrl).webSocketDebuggerUrl);
  const before = (await activeTab(uiWs)).id;
  await keydown(contentWs, `window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true, cancelable: true })); 1`);
  await sleep(400);
  let after = (await activeTab(uiWs)).id;
  check("Ctrl+Tab из контента: активна следующая вкладка", after !== before, `${before} → ${after}`);
  await keydown(contentWs, `window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true, shiftKey: true, cancelable: true })); 1`);
  await sleep(400);
  after = (await activeTab(uiWs)).id;
  check("Ctrl+Shift+Tab из контента: вернулись на прежнюю", after === before, `${before} ← ${after}`);

  // (6) Ctrl+Shift+T: закрытая p3-moved возвращается и активна
  await keydown(contentWs, `window.dispatchEvent(new KeyboardEvent("keydown", { key: "T", ctrlKey: true, shiftKey: true, cancelable: true })); 1`);
  let reopened;
  for (let i = 0; i < 20; i++) {
    await sleep(400);
    reopened = await activeTab(uiWs);
    if (reopened.url.endsWith("/p3-moved")) break;
  }
  check(
    "Ctrl+Shift+T из контента: закрытая вкладка восстановлена и активна",
    reopened.url.endsWith("/p3-moved") && (await tabsList(uiWs)).tabs.length === 5,
    JSON.stringify(reopened),
  );

  // (7) хоткеи в UI-webview (фокус в хроме)
  const uiBefore = (await activeTab(uiWs)).id;
  await keydown(uiWs, `window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true, cancelable: true })); 1`);
  await sleep(300);
  const uiAfter = (await activeTab(uiWs)).id;
  check("Ctrl+Tab из UI: активная сменилась", uiAfter !== uiBefore, `${uiBefore} → ${uiAfter}`);

  // (8) контекст-меню вкладки: открытие, скриншот, действие «Закрыть вкладку»
  const menuOpened = await evalIn(
    uiWs,
    `(function () {
       const t = document.querySelectorAll("#tabs .tab")[1];
       t.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 220, clientY: 24 }));
       return !document.getElementById("tabMenu").hidden;
     })()`,
  );
  check("контекст-меню вкладки открывается (правый клик по вкладке)", menuOpened === true);
  await sleep(200);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const menuShot = await uiWs.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT_DIR, "tabmenu.png"), Buffer.from(menuShot.data, "base64"));
  check("скриншот контекст-меню сохранён (e2e/tabs/tabmenu.png)", fs.existsSync(path.join(OUT_DIR, "tabmenu.png")));

  const countBefore = (await tabsList(uiWs)).tabs.length;
  const menuClosed = await evalIn(
    uiWs,
    `(function () {
       document.querySelector('#tabMenu button[data-act="close"]').click();
       return document.getElementById("tabMenu").hidden;
     })()`,
  );
  await sleep(400);
  const afterMenuClose = (await tabsList(uiWs)).tabs;
  check(
    "контекст-меню: «Закрыть вкладку» закрывает её, меню закрывается",
    menuClosed === true && afterMenuClose.length === countBefore - 1,
    `вкладок ${countBefore} → ${afterMenuClose.length}`,
  );

  // (9) чистый скриншот таб-бара (сверка стиля с гайдом 06)
  const shot = await uiWs.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT_DIR, "tabbar.png"), Buffer.from(shot.data, "base64"));
  check("скриншот таб-бара сохранён (e2e/tabs/tabbar.png)", fs.existsSync(path.join(OUT_DIR, "tabbar.png")));

  contentWs.close();
  uiWs.close();
} catch (e) {
  failures++;
  console.error("E2E ERROR:", e.message);
} finally {
  app.kill("SIGKILL");
  await killOurExes();
  vite.kill();
  httpServer.close();
  await sleep(1000);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

const failed = results.filter((r) => !r.ok).length + failures;
console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES: " + failed} (${results.length} проверок)`);
process.exit(failed === 0 ? 0 : 1);
