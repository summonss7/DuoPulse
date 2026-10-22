// E2E-прогон скриптлетов блокировщика (карточка duopulse-043, критерии:
// «##+js-правила исполняются в контентной вкладке», «тумблер/white-list
// отключают инъекции»). Реальное приложение + локальный тест-лист
// (DUOPULSE_ADBLOCK_LISTS → файл), ресурсный набор вкомпилирован в бинарник.
// Через CDP в контент-вкладке:
//   1) set-constant (полное имя) устанавливает свойство, которого у страницы
//      не было: window.__dpE2eFlag === "yes" — поведение изменилось;
//   2) aopr (короткая uBO-форма) отравляет чтение: window.__dpE2ePoison
//      бросает ReferenceError;
//   3) гонка асинхронной доставки: страница успела записать __dpE2eOwn
//      до инъекции, set-constant тем не менее перезаписывает ("no");
//   4) код доставлен и исполнен: ранний скрипт NavigationStarting →
//      AddScriptToExecuteOnDocumentCreated (карточка 044: window.__duopulseSyncScriptlets,
//      __duopulseSyncAt < 1 с документа) ИЛИ асинхронный путь cosmetic.js
//      (scriptlets > 0);
//   5) сайт-исключение 127.0.0.1 → reload → инъекций нет (флаг не появился,
//      чтение не бросает, scriptlets = 0);
//   6) глобальный тумблер off → reload → инъекций нет;
//   7) возврат тумблера → reload → скриптлеты снова работают.
// Изоляция: APPDATA и WEBVIEW2_USER_DATA_FOLDER — во временном каталоге.
//
// Запуск:  node e2e/adblock/scriptlets.mjs [путь-к-duopulse.exe]
// Требует собранный debug-exe (cargo build) и запускает vite dev сам.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const CDP_PORT = 9233;
const HTTP_PORT = 8894;
const FIXTURE = path.join(ROOT, "e2e", "adblock", "scriptlets-test.txt");

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

// --- 1. локальный http-стенд: страница с поллингом состояния ----------------
const page = `<!doctype html><html><head><title>scriptlets-stand</title></head><body>
<script>
window.__dpE2eOwn = "page-first"; // инлайн-скрипт страницы успевает раньше асинхронной инъекции
window.__probe = (function () {
  var state = { own: "page-first", flag: null, aopr: "pending", scriptlets: -1, t0: Date.now() };
  setInterval(function () {
    state.flag = window.__dpE2eFlag !== undefined ? String(window.__dpE2eFlag) : null;
    state.own = String(window.__dpE2eOwn);
    try { void window.__dpE2ePoison; state.aopr = "read-ok"; } catch (e) { state.aopr = "threw"; }
    state.scriptlets = window.__duopulseCosmetic ? window.__duopulseCosmetic.scriptlets : -1;
    state.sync = window.__duopulseSyncScriptlets === true; // ранний скрипт (карточка 044)
    state.syncAt = typeof window.__duopulseSyncAt === "number" ? window.__duopulseSyncAt : null;
    state.jsLen = window.__duopulseCosmetic ? window.__duopulseCosmetic.scriptlets : -1;
    state.log = window.__duopulseCosmetic ? window.__duopulseCosmetic.log.slice(-6) : null;
  }, 100);
  return state;
})();
</script></body></html>`;
const httpServer = http.createServer((req, res) => {
  setTimeout(() => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(page);
  }, Number(process.env.DELAY_MS || 0));
});
await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));

// --- 2. изолированный профиль + тест-лист ------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-scriptlets-e2e-"));
const fixtureCopy = path.join(tmp, "scriptlets-test.txt");
fs.copyFileSync(FIXTURE, fixtureCopy);

const appEnv = () => ({
  ...process.env,
  APPDATA: tmp,
  DUOPULSE_START_URL: `http://127.0.0.1:${HTTP_PORT}/start`,
  DUOPULSE_ADBLOCK_LISTS: `test=${fixtureCopy}`,
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
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
      const ui = targets.find((t) => t.type === "page" && /localhost:5173/.test(t.url));
      const content = targets.find((t) => t.type === "page" && t.url.includes(":" + HTTP_PORT));
      if (ui && content) return { ui, content };
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

/** Дождаться условия на пробе страницы (положительные проверки). */
async function waitFor(ws, fn, timeoutMs = 15000) {
  const t0 = Date.now();
  let last;
  for (;;) {
    last = await evalIn(ws, `window.__probe`);
    if (!last || Date.now() - t0 > timeoutMs) break;
    if (fn(last)) return last;
    await sleep(200);
  }
  return last ?? {};
}

/** Пауза и срез пробы (негативные проверки: инъекций быть не должно). */
async function settle(ws, settleMs = 2500) {
  await sleep(settleMs);
  return (await evalIn(ws, `window.__probe`)) ?? {};
}

let app;
let failures = 0;
try {
  app = spawn(EXE, [], { stdio: "ignore", env: appEnv() });
  let targets = await waitForTargets();
  let uiWs = connect(targets.ui.webSocketDebuggerUrl);
  let contentWs = connect(targets.content.webSocketDebuggerUrl);

  for (let i = 0; i < 20; i++) {
    if ((await evalIn(uiWs, `typeof window.__duopulse`)) === "object") break;
    await sleep(500);
  }

  // (1)–(4) скриптлеты из тест-листа исполнились и изменили поведение страницы
  let probe = await waitFor(contentWs, (p) => p.flag === "yes" && p.aopr === "threw");
  check("set-constant (полное имя): window.__dpE2eFlag === \"yes\"", probe.flag === "yes", JSON.stringify(probe));
  check("aopr (короткая uBO-форма): чтение __dpE2ePoison бросает", probe.aopr === "threw", probe.aopr);
  check("set-constant перезаписал свойство, установленное страницей раньше (гонка доставки)", probe.own === "no", probe.own);
  check(
    "код доставлен и исполнен (ранний скрипт 044 или WebMessage)",
    probe.sync === true || probe.scriptlets > 0,
    `sync=${probe.sync} syncAt=${probe.syncAt} scriptlets=${probe.scriptlets}`,
  );
  check("ранняя инъекция до инлайн-скриптов (карточка 044): syncAt < 1000 мс", probe.sync === true && probe.syncAt !== null && probe.syncAt < 1000, `syncAt=${probe.syncAt}`);
  const cosmetic = await evalIn(contentWs, `window.__duopulseCosmetic ? { active: window.__duopulseCosmetic.active, ready: window.__duopulseCosmetic.ready } : null`);
  check("косметика active/ready", cosmetic?.active === true && cosmetic?.ready === true, JSON.stringify(cosmetic));

  // (5) сайт-исключение: инъекции выключаются
  await evalIn(uiWs, `window.__duopulse.adblock.setEnabled({ site: "127.0.0.1", on: false })`);
  await evalIn(uiWs, `window.__duopulse.nav.reload()`);
  await sleep(1500); // новый документ → новая проба
  probe = await settle(contentWs);
  check("сайт-исключение: флаг не появился", probe.flag === null, JSON.stringify(probe));
  check("сайт-исключение: чтение не бросает (aopr выключен)", probe.aopr === "read-ok", probe.aopr);
  check("сайт-исключение: scriptlets = 0", probe.scriptlets === 0, `scriptlets=${probe.scriptlets}`);
  check("сайт-исключение: ранней инъекции нет (sync-флаг не стоит)", probe.sync !== true, `sync=${probe.sync}`);

  // (6) глобальный тумблер off: инъекций нет (сайт-исключение снимаем)
  await evalIn(uiWs, `window.__duopulse.adblock.setEnabled({ site: "127.0.0.1", on: true })`);
  await evalIn(uiWs, `window.__duopulse.adblock.setEnabled({ site: null, on: false })`);
  await evalIn(uiWs, `window.__duopulse.nav.reload()`);
  await sleep(1500);
  probe = await settle(contentWs);
  check("глобальный тумблер off: флаг не появился", probe.flag === null, JSON.stringify(probe));
  check("глобальный тумблер off: scriptlets = 0", probe.scriptlets === 0, `scriptlets=${probe.scriptlets}`);
  check("глобальный тумблер off: ранней инъекции нет", probe.sync !== true, `sync=${probe.sync}`);

  // (7) тумблер обратно: скриптлеты работают снова
  await evalIn(uiWs, `window.__duopulse.adblock.setEnabled({ site: null, on: true })`);
  await evalIn(uiWs, `window.__duopulse.nav.reload()`);
  await sleep(1500);
  probe = await waitFor(contentWs, (p) => p.flag === "yes" && p.aopr === "threw");
  check("после включения: скриптлеты снова действуют", probe.flag === "yes" && probe.aopr === "threw" && (probe.sync === true || probe.scriptlets > 0), JSON.stringify(probe));

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
