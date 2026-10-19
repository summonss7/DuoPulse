// E2E-прогон инкремента A «внешний прокси» (карточка duopulse-009, задача 1.8).
// Проверяет на реальном приложении:
//   1) аргументы --proxy-server/--proxy-bypass-list дошли до процесса WebView2;
//   2) внешний http-трафик content-webview идёт через локальный SOCKS5-стенд
//      (лог CONNECT), DNS — на стороне прокси (ATYP=domain);
//   3) localhost в прокси НЕ попадает (загружается напрямую);
//   4) меню «Прокси»: статус «ВКЛ», настройки читаются, тумблер сохраняет конфиг,
//      в settings.json нет пароля.
// Изоляция: приложение запускается с APPDATA и WEBVIEW2_USER_DATA_FOLDER во
// временном каталоге — реальный профиль пользователя не затрагивается.
//
// Запуск:  node e2e/proxy-a/run.mjs [путь-к-duopulse.exe]
// Требует собранный debug-exe (cargo build) и запускает vite dev сам.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startSocks5 } from "./socks5.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const CDP_PORT = 9223;
// env-переопределение: 8899 на машине автора занял сервис Aila (aila-service)
const HTTP_PORT = Number(process.env.E2E_PROXY_A_PORT || 8899);
const PROBE_URL = "http://example.com/";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))));

/** Убить только экземпляры НАШЕГО exe (перезапущенный процесс выпадает из дерева PID). */
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

/** Командные строки процессов WebView2 нашего экземпляра (маркер — CDP-порт). */
const webViewCmdlines = async () => {
  try {
    return await run("powershell", [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like '*remote-debugging-port=${CDP_PORT}*' } | Select-Object -ExpandProperty CommandLine`,
    ]);
  } catch {
    return "";
  }
};
const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

// --- 1. локальные серверы ----------------------------------------------------
let httpHits = 0;
const httpServer = http.createServer((req, res) => {
  httpHits++;
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<html><body><h1>DuoPulse local test</h1></body></html>");
});
await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));

const socks = await startSocks5({ log: (m) => console.log(`  [socks5] ${m}`) });
console.log(`socks5 на 127.0.0.1:${socks.port}, http-стенд на 127.0.0.1:${HTTP_PORT}`);

// --- 2. изолированный профиль с включённым прокси ------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-proxy-e2e-"));
const profile = path.join(tmp, "DuoPulse", "profile");
fs.mkdirSync(profile, { recursive: true });
fs.writeFileSync(
  path.join(profile, "settings.json"),
  JSON.stringify(
    {
      proxy: {
        enabled: true,
        proto: "socks5",
        host: "127.0.0.1",
        port: socks.port,
        login: "e2e-user",
      },
    },
    null,
    2,
  ),
);

// --- 3. vite dev + приложение -------------------------------------------------
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
  APPDATA: tmp, // профиль settings.json — во временный каталог
  DUOPULSE_START_URL: `http://127.0.0.1:${HTTP_PORT}/start`,
  DUOPULSE_ADBLOCK_LISTS: "", // без списков: стенду не нужна сеть (задача 2.1)
  WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"), // изоляция WebView2
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
};
const app = spawn(EXE, [], { stdio: "ignore", env: appEnv });

// --- 4. ждём CDP ---------------------------------------------------------------
let targets = [];
for (let i = 0; i < 60; i++) {
  try {
    targets = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
    if (targets.some((t) => t.type === "page" && t.url.includes(`:${HTTP_PORT}`))) break;
  } catch {
    /* приложение ещё поднимается */
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
  open.catch(() => {}); // close() после теста не должен рождать unhandled rejection
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
  const content = targets.find((t) => t.type === "page" && t.url.includes(`:${HTTP_PORT}`));
  const ui = targets.find((t) => t.type === "page" && /localhost:5173/.test(t.url));
  if (!content || !ui) throw new Error(`CDP-цели не найдены: ${targets.map((t) => t.url).join(", ")}`);
  const contentWs = connect(content.webSocketDebuggerUrl);
  const uiWs = connect(ui.webSocketDebuggerUrl);

  // (1) аргументы дошли до процесса WebView2 (фильтр — наш CDP-порт изолирует
  // экземпляр стенда от других запущенных копий DuoPulse/WebView2)
  const cmdline = (await webViewCmdlines()).replace(/\r?\n/g, " ");
  check(
    "--proxy-server в командной строке WebView2",
    cmdline.includes(`--proxy-server=socks5://127.0.0.1:${socks.port}`),
  );
  check(
    "--proxy-bypass-list в командной строке WebView2",
    cmdline.includes("--proxy-bypass-list=") && cmdline.includes("localhost"),
  );

  // (2) внешняя страница идёт через SOCKS5 (DNS на стороне прокси)
  await contentWs.send("Page.enable");
  await contentWs.send("Page.navigate", { url: PROBE_URL });
  await sleep(5000); // страница + подресурсы
  const proxied = socks.connects.filter((c) => c.startsWith("example.com"));
  check(
    `внешний URL (${PROBE_URL}) пошёл через прокси`,
    proxied.length > 0,
    `CONNECT-лог: ${socks.connects.join(", ") || "пусто"}`,
  );

  // (3) localhost — напрямую, никогда через прокси
  const socksBefore = socks.connects.length;
  await contentWs.send("Page.navigate", { url: `http://127.0.0.1:${HTTP_PORT}/bypass-check` });
  await sleep(3000);
  check(
    "localhost загружен напрямую (нет CONNECT на локальный адрес)",
    !socks.connects.slice(socksBefore).some((c) => c.startsWith("127.0.0.1:")),
    `новые CONNECT: ${socks.connects.slice(socksBefore).join(", ") || "нет"}`,
  );
  check("страница localhost реально загрузилась", httpHits >= 2, `http-хиты: ${httpHits}`);

  // (4) меню «Прокси» в UI: статус ВКЛ, конфиг читается, тумблер сохраняет
  await uiWs.send("Runtime.enable");
  const menuExists = await evalIn(uiWs, `!!document.getElementById('proxyMenu')`);
  check("меню «Прокси» есть в UI", menuExists === true);

  await evalIn(uiWs, `document.getElementById('proxyBtn').click(), true`);
  await sleep(2500); // открытие меню + proxy_status (проверка SOCKS5-приветствия)
  const state = await evalIn(uiWs, `document.getElementById('proxyStatus').dataset.state`);
  check("статус в меню — ВКЛ (прокси отвечает)", state === "on", `state=${state}`);

  const form = await evalIn(
    uiWs,
    `(() => { const v = id => document.getElementById(id).value;
       return { proto: v('proxyProto'), host: v('proxyHost'), port: v('proxyPort'), login: v('proxyLogin') }; })()`,
  );
  check(
    "настройки прочитаны в форму",
    form?.proto === "socks5" && form?.host === "127.0.0.1" && Number(form?.port) === socks.port && form?.login === "e2e-user",
    JSON.stringify(form),
  );

  const passPlaceholder = await evalIn(uiWs, `document.getElementById('proxyPassword').placeholder`);
  check("пароль в форму не возвращается", passPlaceholder.includes("сохранён") === false, passPlaceholder);

  // тумблер → выкл (сохранение enabled=false без перезапуска)
  await evalIn(uiWs, `document.getElementById('proxyEnabled').click(), true`);
  await sleep(1500);
  const savedOff = JSON.parse(fs.readFileSync(path.join(profile, "settings.json"), "utf8"));
  check(
    "тумблер сохранил выключение в settings.json",
    savedOff.proxy?.enabled === false,
  );
  const stateOff = await evalIn(uiWs, `document.getElementById('proxyStatus').dataset.state`);
  check("статус после выключения — ВЫКЛ", stateOff === "off", `state=${stateOff}`);
  await evalIn(uiWs, `document.getElementById('proxyEnabled').click(), true`); // вернули вкл
  await sleep(1500);

  // пароля нет в settings.json
  const rawSettings = fs.readFileSync(path.join(profile, "settings.json"), "utf8");
  check("в settings.json нет пароля", !rawSettings.includes("password"), rawSettings.slice(0, 200));

  // скриншот меню для протокола
  const shot = await uiWs.send("Page.captureScreenshot", { format: "png" });
  fs.mkdirSync(path.join(ROOT, "e2e", "proxy-a"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "e2e", "proxy-a", "menu-open.png"), Buffer.from(shot.data, "base64"));
  console.log("скриншот меню: e2e/proxy-a/menu-open.png");

  contentWs.close();
  uiWs.close();

  // --- фаза 2: применение настроек с перезапуском (критерий карточки) ----------
  app.kill("SIGKILL");
  await killOurExes();
  await sleep(1500);
  spawn(EXE, [], { stdio: "ignore", env: appEnv });
  let phase2Targets = [];
  for (let i = 0; i < 60; i++) {
    try {
      phase2Targets = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
      if (phase2Targets.some((t) => t.type === "page" && /localhost:5173/.test(t.url))) break;
    } catch { /* поднимается */ }
    await sleep(1000);
  }
  const ui2 = phase2Targets.find((t) => t.type === "page" && /localhost:5173/.test(t.url));
  if (!ui2) throw new Error("фаза 2: UI-цель не найдена");
  const ui2Ws = connect(ui2.webSocketDebuggerUrl);

  await evalIn(ui2Ws, `document.getElementById('proxyBtn').click(), true`);
  await sleep(1200);
  await evalIn(ui2Ws, `document.getElementById('proxyEnabled').click(), true`); // выкл
  await sleep(1200);
  const blockShown = await evalIn(ui2Ws, `!document.getElementById('proxyRestartBlock').hidden`);
  check("после смены настроек меню предлагает перезапуск", blockShown === true);

  // «Перезапустить сейчас» → app.restart(): старый процесс умирает, новый поднимается
  await evalIn(ui2Ws, `document.getElementById('proxyRestart').click(), true`);
  ui2Ws.close();
  for (let i = 0; i < 20; i++) {
    // ждём смерти старого экземпляра (CDP перестаёт отвечать)
    try { await fetch(`http://localhost:${CDP_PORT}/json/list`); await sleep(500); }
    catch { break; }
  }
  let phase3Targets = [];
  for (let i = 0; i < 60; i++) {
    try {
      phase3Targets = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
      if (phase3Targets.some((t) => t.type === "page" && /localhost:5173/.test(t.url))) break;
    } catch { /* новый экземпляр поднимается */ }
    await sleep(1000);
  }
  const cmdline2 = (await webViewCmdlines()).replace(/\r?\n/g, " ");
  check("после перезапуска --proxy-server исчез (прокси выключен)", !cmdline2.includes("--proxy-server="), cmdline2.slice(0, 200));

  const ui3 = phase3Targets.find((t) => t.type === "page" && /localhost:5173/.test(t.url));
  if (!ui3) throw new Error("фаза 2: UI-цель после перезапуска не найдена");
  const ui3Ws = connect(ui3.webSocketDebuggerUrl);
  await evalIn(ui3Ws, `document.getElementById('proxyBtn').click(), true`);
  await sleep(1200);
  const state3 = await evalIn(ui3Ws, `document.getElementById('proxyStatus').dataset.state`);
  check("статус после перезапуска — ВЫКЛ (без прокси)", state3 === "off", `state=${state3}`);
  const toggleOn3 = await evalIn(ui3Ws, `document.getElementById('proxyEnabled').checked`);
  check("тумблер после перезапуска в положении «выкл»", toggleOn3 === false);
  ui3Ws.close();
} catch (e) {
  failures++;
  console.error("E2E ERROR:", e.message);
} finally {
  // только экземпляры НАШЕГО exe — чужие запущенные DuoPulse не трогаем
  app.kill("SIGKILL");
  await killOurExes();
  // vite.kill() на Windows убивает только npm-оболочку — дерево npm→node
  // переживает скрипт и держит порт 5173 (strictPort) для следующих прогонов
  try {
    await run("taskkill", ["/PID", String(vite.pid), "/T", "/F"]);
  } catch {
    /* дерево уже мертво — ок */
  }
  socks.server.close();
  httpServer.close();
  await sleep(1000);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

const failed = results.filter((r) => !r.ok).length + failures;
console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES: " + failed} (${results.length} проверок)`);
process.exit(failed === 0 ? 0 : 1);
