// E2E перезаписи тел ответов $replace (карточка duopulse-050): слой
// модификации в COM-перехватчике WebResourceRequested — самофетч через
// локальный SOCKS5-роутер + замены в теле + подмена ответа
// (CreateWebResourceResponse). Реальное приложение + локальный тест-лист
// (DUOPULSE_ADBLOCK_LISTS → файл) и локальный HTTP-стенд:
//   1) adblock.status: replaceRules = 2 (правила без @@-исключения);
//   2) XHR /xhr-path: тело переписано "adSlots"→"no_ads" ДО страницы
//      (fetch().text() видит уже изменённый JSON, Content-Type жив);
//   3) документ /doc-path (жёсткая навигация, $doc): HTML переписан до
//      парсера — DOM содержит заменённый текст;
//   4) @@-исключение /except-path: тело НЕ трогается;
//   5) без правила /plain: тело НЕ трогается;
//   6) счётчик replacedTotal растёт только на реально изменённые тела;
//   7) сайт-исключение (adblock.set_enabled site=… on=false) гасит
//      перезапись на следующем запросе.
// Изоляция: APPDATA и WEBVIEW2_USER_DATA_FOLDER — во временном каталоге.
//
// Запуск:  node e2e/adblock/replace.mjs [путь-к-duopulse.exe]
// Требует собранный debug-exe (cargo build) и запускает vite dev сам.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const CDP_PORT = 9234;
const HTTP_PORT = 8898;
const FIXTURE = path.join(ROOT, "e2e", "adblock", "replace-test.txt");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))),
  );

/** Убить только экземпляры НАШЕГО exe (как run.mjs: путь в одинарных кавычках). */
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

// --- 1. локальный http-стенд ---------------------------------------------------
const AD_JSON = JSON.stringify({ adSlots: [{ wo: 1 }], playability: "OK" });
const hits = { xhr: 0, doc: 0, except: 0, plain: 0 };
const page = `<!doctype html><html><head><title>replace-stand</title></head><body>
<script>
window.__results = null;
async function probe() {
  const r = {};
  for (const key of ["xhr", "except", "plain"]) {
    try {
      const resp = await fetch("/" + key + "-path", { cache: "no-store" });
      r[key] = { status: resp.status, type: resp.headers.get("content-type"), body: await resp.text() };
    } catch (e) { r[key] = { error: String(e) }; }
  }
  window.__results = r;
  document.title = "probed";
}
probe();
</script></body></html>`;
const docPage = `<!doctype html><html><head><title>doc-rewrite</title></head><body>
<p>marker "adSlots" here</p>
</body></html>`;
const httpServer = http.createServer((req, res) => {
  const noCache = { "Cache-Control": "no-store" };
  if (req.url.startsWith("/xhr-path")) hits.xhr++;
  else if (req.url.startsWith("/doc-path")) hits.doc++;
  else if (req.url.startsWith("/except-path")) hits.except++;
  else if (req.url.startsWith("/plain-path")) hits.plain++;
  if (req.url === "/" || req.url.startsWith("/start")) {
    res.writeHead(200, { ...noCache, "Content-Type": "text/html; charset=utf-8" });
    res.end(page);
  } else if (req.url.startsWith("/doc-path")) {
    res.writeHead(200, { ...noCache, "Content-Type": "text/html; charset=utf-8" });
    res.end(docPage);
  } else {
    res.writeHead(200, { ...noCache, "Content-Type": "application/json" });
    res.end(AD_JSON);
  }
});
await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));

// --- 2. изолированный профиль + тест-лист ---------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-replace-e2e-"));

const appEnv = () => ({
  ...process.env,
  APPDATA: tmp,
  DUOPULSE_START_URL: `http://127.0.0.1:${HTTP_PORT}/start`,
  DUOPULSE_ADBLOCK_LISTS: `test=${FIXTURE}`,
  WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
});

// --- 3. vite dev ---------------------------------------------------------------
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
  if (r.exceptionDetails)
    throw new Error(JSON.stringify(r.exceptionDetails.exception ?? r.exceptionDetails));
  return r.result?.value;
};

/** Ждать результаты XHR-пробы (после load/reload). */
async function readProbe(contentWs) {
  for (let i = 0; i < 20; i++) {
    const r = await evalIn(contentWs, `window.__results`);
    if (r) return r;
    await sleep(500);
  }
  throw new Error("XHR-проба страницы не завершилась");
}

let app;
let failures = 0;
try {
  await killOurExes();
  // stderr приложения — в лог: диагностика COM-ошибок слоя перезаписи
  const errLog = fs.openSync(path.join(tmp, "stderr.log"), "a");
  app = spawn(EXE, [], { stdio: ["ignore", "ignore", errLog], env: appEnv() });
  const targets = await waitForTargets();
  const uiWs = connect(targets.find((t) => t.type === "page" && /localhost:5173/.test(t.url)).webSocketDebuggerUrl);
  const contentWs = connect(targets.find((t) => t.type === "page" && t.url.includes(":" + HTTP_PORT)).webSocketDebuggerUrl);

  for (let i = 0; i < 20; i++) {
    if ((await evalIn(uiWs, `typeof window.__duopulse`)) === "object") break;
    await sleep(500);
  }

  // (1) статус: $replace-правила тест-листа загружены (replacedTotal может
  // уже быть 1 — проба страницы стартует с load, раньше опроса)
  let st = await evalIn(uiWs, `window.__duopulse.adblock.status()`);
  check(
    "adblock.status: replaceRules=2 (xhr+doc, без @@-исключения)",
    st?.ready === true && st?.replaceRules === 2 && st?.replacedTotal <= 1,
    `replaceRules=${st?.replaceRules} replacedTotal=${st?.replacedTotal}`,
  );

  // (2)-(5) XHR-проба: xhr переписан, except/plain — нет
  let probe = await readProbe(contentWs);
  check(
    "XHR /xhr-path: тело переписано до страницы (\"adSlots\"→\"no_ads\", Content-Type жив)",
    probe.xhr?.status === 200 &&
      probe.xhr.type === "application/json" &&
      probe.xhr.body.includes('"no_ads"') &&
      !probe.xhr.body.includes("adSlots"),
    JSON.stringify(probe.xhr),
  );
  check(
    "XHR /except-path: @@-исключение — тело не тронуто",
    probe.except?.status === 200 && probe.except.body.includes('"adSlots"'),
    JSON.stringify(probe.except),
  );
  check(
    "XHR /plain-path: без правила — тело не тронуто",
    probe.plain?.status === 200 && probe.plain.body.includes('"adSlots"'),
    JSON.stringify(probe.plain),
  );
  check(
    "сервер видел по одному запросу на эндпоинт (без двойных сетевых ходок)",
    hits.xhr === 1 && hits.except === 1 && hits.plain === 1,
    JSON.stringify(hits),
  );

  // (6) счётчик: ровно одно реально переписанное тело
  st = await evalIn(uiWs, `window.__duopulse.adblock.status()`);
  check("счётчик replacedTotal=1 (только /xhr-path)", st?.replacedTotal === 1, `replacedTotal=${st?.replacedTotal}`);

  // (3) жёсткая навигация $doc: HTML переписан до парсера
  await evalIn(contentWs, `location.href = "/doc-path?r=" + Math.random()`);
  let docMark = null;
  for (let i = 0; i < 30; i++) {
    docMark = await evalIn(contentWs, `document.body ? document.body.innerText : null`).catch(() => null);
    if (docMark && docMark.includes("marker")) break;
    await sleep(500);
  }
  check(
    "документ /doc-path ($doc): DOM собран из переписанного HTML (no_ads, без adSlots)",
    docMark !== null && docMark.includes('"no_ads"') && !docMark.includes('"adSlots"'),
    JSON.stringify(docMark),
  );
  st = await evalIn(uiWs, `window.__duopulse.adblock.status()`);
  check("счётчик replacedTotal=2 (+документ)", st?.replacedTotal === 2, `replacedTotal=${st?.replacedTotal}`);

  // (7) сайт-исключение гасит перезапись (проверка на следующем запросе)
  await evalIn(uiWs, `window.__duopulse.adblock.setEnabled({ site: "127.0.0.1", on: false })`);
  await evalIn(contentWs, `location.href = "/start?r=" + Math.random()`);
  probe = await readProbe(contentWs);
  check(
    "сайт-исключение: перезапись выключена (adSlots на месте)",
    probe.xhr?.body.includes('"adSlots"'),
    JSON.stringify(probe.xhr?.body),
  );
  st = await evalIn(uiWs, `window.__duopulse.adblock.status()`);
  check("счётчик replacedTotal не растёт при исключении", st?.replacedTotal === 2, `replacedTotal=${st?.replacedTotal}`);

  uiWs.close();
  contentWs.close();
} catch (e) {
  failures++;
  console.error("E2E ERROR:", e.message);
} finally {
  try {
    if (app?.pid) await run("taskkill", ["/PID", String(app.pid), "/T", "/F"]);
  } catch {}
  await killOurExes();
  try {
    await run("taskkill", ["/PID", String(vite.pid), "/T", "/F"]);
  } catch {}
  httpServer.close();
  // при падениях stderr приложения полезнее временных файлов
  failures += results.filter((r) => !r.ok).length;
  if (failures > 0) {
    try {
      const log = fs.readFileSync(path.join(tmp, "stderr.log"), "utf8");
      console.log(`--- stderr приложения ---\n${log.split("\n").slice(-30).join("\n")}`);
    } catch {}
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
  await sleep(500);
}

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} проверок прошли`);
console.log(failures === 0 ? "ALL PASS" : `FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
