// E2E-прогон задачи 1.1 «IPC-мост bridge» (карточка duopulse-011, DoD:
// команда tabs.list проходит UI → Core → ответ).
// На реальном приложении проверяет через CDP в UI-webview:
//   1) bridge.version — живое приложение отдаёт версию контракта;
//   2) tabs.list — сквозной вызов UI → Core → ответ: единственная вкладка
//      tab-N с URL стартовой страницы (менеджер вкладок — задача 1.2);
//   3) nav.navigate / nav.go_back / nav.go_forward / nav.reload — навигация
//      через bridge меняет URL вкладки (проверяется повторным tabs.list);
//   4) settings.get / settings.set / vpn.status — прокси-словарь контракта
//      (включая отказ валидации при включении без адреса).
// Изоляция: APPDATA и WEBVIEW2_USER_DATA_FOLDER — во временном каталоге,
// реальный профиль пользователя не затрагивается.
//
// Запуск:  node e2e/bridge/run.mjs [путь-к-duopulse.exe]
// Требует собранный debug-exe (cargo build) и запускает vite dev сам.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const CDP_PORT = 9224;
const HTTP_PORT = 8898;

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

// --- 1. локальный http-стенд (стартовая страница + страница №2) ---------------
let hits = { start: 0, page2: 0 };
const httpServer = http.createServer((req, res) => {
  if (req.url.startsWith("/page2")) hits.page2++;
  else hits.start++;
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<html><body><h1>${req.url}</h1></body></html>`);
});
await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));

// --- 2. изолированный профиль (без прокси) -------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-bridge-e2e-"));

// --- 3. vite dev + приложение ---------------------------------------------------
const vite = spawn("npm", ["run", "dev"], { cwd: ROOT, shell: true, stdio: "ignore" });
for (let i = 0; i < 60; i++) {
  try {
    await fetch("http://localhost:5173/");
    break;
  } catch {
    await sleep(500);
  }
}

const appEnv = {
  ...process.env,
  APPDATA: tmp,
  DUOPULSE_START_URL: `http://127.0.0.1:${HTTP_PORT}/start`,
  WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
};
const app = spawn(EXE, [], { stdio: "ignore", env: appEnv });

// --- 4. ждём CDP: UI (vite) и content (стенд) -----------------------------------
let targets = [];
for (let i = 0; i < 60; i++) {
  try {
    targets = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
    const hasUi = targets.some((t) => t.type === "page" && /localhost:5173/.test(t.url));
    const hasContent = targets.some((t) => t.type === "page" && t.url.includes(":" + HTTP_PORT));
    if (hasUi && hasContent) break;
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

let failures = 0;
try {
  const ui = targets.find((t) => t.type === "page" && /localhost:5173/.test(t.url));
  if (!ui) throw new Error("UI-цель CDP не найдена: " + targets.map((t) => t.url).join(", "));
  const uiWs = connect(ui.webSocketDebuggerUrl);

  // dev-хук bridge (src/bridge/dev-probe.ts): модуль UI исполняется асинхронно
  // после загрузки страницы — ждём готовности.
  let probeExists;
  for (let i = 0; i < 20; i++) {
    probeExists = await evalIn(uiWs, `typeof window.__duopulse`);
    if (probeExists === "object") break;
    await sleep(500);
  }
  check("dev-хук window.__duopulse доступен в UI", probeExists === "object", `typeof=${probeExists}`);

  // (1) bridge.version
  const version = await evalIn(uiWs, `window.__duopulse.bridge.version()`);
  check("bridge.version: приложение отдаёт версию контракта", version?.version === 2, JSON.stringify(version));

  // (2) tabs.list — СКВОЗНОЙ DoD-тест: UI → Core → ответ
  const tabs = await evalIn(uiWs, `window.__duopulse.tabs.list()`);
  check(
    "tabs.list: единственная вкладка со стартовым URL",
    tabs?.tabs?.length === 1 &&
      /^tab-\d+$/.test(tabs.tabs[0].id) &&
      tabs.tabs[0].url.includes(`127.0.0.1:${HTTP_PORT}/start`) &&
      tabs.tabs[0].active === true,
    JSON.stringify(tabs),
  );

  // (3) навигация через bridge: navigate → go_back → go_forward → reload
  await evalIn(uiWs, `window.__duopulse.nav.navigate({ url: "http://127.0.0.1:${HTTP_PORT}/page2" })`);
  await sleep(2500);
  const afterNav = await evalIn(uiWs, `window.__duopulse.tabs.list()`);
  check("nav.navigate: URL вкладки сменился на page2", afterNav?.tabs?.[0]?.url?.includes("/page2") === true, JSON.stringify(afterNav));

  await evalIn(uiWs, `window.__duopulse.nav.goBack()`);
  await sleep(2000);
  const afterBack = await evalIn(uiWs, `window.__duopulse.tabs.list()`);
  check("nav.goBack: вернулись на стартовую", afterBack?.tabs?.[0]?.url?.includes("/start") === true, JSON.stringify(afterBack));

  await evalIn(uiWs, `window.__duopulse.nav.goForward()`);
  await sleep(2000);
  const afterFwd = await evalIn(uiWs, `window.__duopulse.tabs.list()`);
  check("nav.goForward: снова page2", afterFwd?.tabs?.[0]?.url?.includes("/page2") === true, JSON.stringify(afterFwd));

  const hitsBefore = hits.page2;
  await evalIn(uiWs, `window.__duopulse.nav.reload()`);
  await sleep(2000);
  check("nav.reload: страница перезагрузилась", hits.page2 > hitsBefore, `page2-хиты: ${hitsBefore} → ${hits.page2}`);

  // (4) словарь прокси: settings/vpn через bridge
  const settings = await evalIn(uiWs, `window.__duopulse.settings.get({ key: "proxy" })`);
  check(
    "settings.get: свежий профиль — прокси выключен",
    settings?.enabled === false && settings?.proto === "socks5",
    JSON.stringify(settings),
  );

  const saved = await evalIn(
    uiWs,
    `window.__duopulse.settings.set({ key: "proxy", value: { enabled: false, proto: "socks5", host: "127.0.0.1", port: 1080, login: null } })`,
  );
  check("settings.set: сохранил конфиг (без включения)", saved === null, JSON.stringify(saved));
  const reread = await evalIn(uiWs, `window.__duopulse.settings.get({ key: "proxy" })`);
  check("settings.get: сохранённое читается назад", reread?.host === "127.0.0.1" && reread?.port === 1080, JSON.stringify(reread));

  const rawSettings = fs.readFileSync(path.join(tmp, "DuoPulse", "profile", "settings.json"), "utf8");
  check("settings.set: в settings.json нет пароля", !rawSettings.includes("password"), rawSettings.slice(0, 120));

  const badEnable = await evalIn(
    uiWs,
    `window.__duopulse.settings.set({ key: "proxy", value: { enabled: true, proto: "socks5", host: "", port: 0, login: null } }).then(() => "ok", e => String(e))`,
  );
  check("settings.set: включение с пустым адресом отклонено", badEnable !== "ok", String(badEnable).slice(0, 80));

  const vpnToggle = await evalIn(
    uiWs,
    `window.__duopulse.vpn.setEnabled({ on: false }).then(() => "ok", e => String(e))`,
  );
  check("vpn.setEnabled: выключение проходит", vpnToggle === "ok", String(vpnToggle).slice(0, 80));

  const status = await evalIn(uiWs, `window.__duopulse.vpn.status()`);
  check("vpn.status: состояние off без прокси", status?.state === "off", JSON.stringify(status));

  uiWs.close();
} catch (e) {
  failures++;
  console.error("E2E ERROR:", e.message);
} finally {
  app.kill("SIGKILL");
  await killOurExes();
  // vite.kill() на Windows убивает только npm-оболочку — дерево npm→node
  // переживает скрипт и держит порт 5173 (strictPort) для следующих прогонов
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
