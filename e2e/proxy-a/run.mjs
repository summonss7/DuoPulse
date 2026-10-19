// E2E-прогон локального SOCKS5-роутера (карточка duopulse-037, задача 6.1;
// прежний стенд инкремента A — карточка duopulse-009). Проверяет на реальном
// приложении:
//   1) аргументы WebView2 ПОСТОЯННО указывают на роутер (socks5://127.0.0.1:
//      <port>, --proxy-bypass-list), независимо от режима прокси;
//   2) внешний http-трафик идёт WebView2 → роутер → внешний SOCKS5-стенд
//      (лог CONNECT), DNS — на стороне маршрута (ATYP=domain);
//   3) localhost в роутер не попадает (bypass — загружается напрямую);
//   4) меню «Прокси»: статус, настройки, пароль не возвращается в форму;
//   5) МИГРАЦИЯ ИНКРЕМЕНТА A: тумблер вкл/выкл переключает режим роутером
//      БЕЗ перезапуска (выкл — страницы грузятся напрямую, вкл — через прокси);
//   6) путь с паролем: роутер подставляет креденшалы из DPAPI (RFC 1929);
//   7) FAIL-CLOSED: битый upstream — уровень роутера (REP≠0, цель не
//      получает соединений) и уровень страницы (ERR_-страница);
//   8) после перезапуска приложения роутер и режим на месте.
// Изоляция: приложение запускается с APPDATA и WEBVIEW2_USER_DATA_FOLDER во
// временном каталоге — реальный профиль пользователя не затрагивается.
//
// Запуск:  node e2e/proxy-a/run.mjs [путь-к-duopulse.exe]
// Требует собранный debug-exe (cargo build) и запускает vite dev сам.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startSocks5 } from "./socks5.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const CDP_PORT = 9223;
// env-переопределение: 8899 на машине автора занял сервис Aila (aila-service)
const HTTP_PORT = Number(process.env.E2E_PROXY_A_PORT || 8899);

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

/** Порт роутера из командной строки WebView2 (--proxy-server=socks5://127.0.0.1:N). */
const routerPortOf = (cmdline) => {
  const m = cmdline.replace(/\r?\n/g, " ").match(/--proxy-server=socks5:\/\/127\.0\.0\.1:(\d+)/);
  return m ? Number(m[1]) : null;
};

/** Свободный «мёртвый» порт: слушатель подняли и закрыли. */
const deadPort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

/** Проба уровня роутера: мини-клиент SOCKS5 → CONNECT host:port.
 *  Возвращает REP-байт (0 — успех) или { error }. */
const socks5Probe = (routerPort, host, port, timeoutMs = 8000) =>
  new Promise((resolve) => {
    const s = net.connect(routerPort, "127.0.0.1");
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => done({ error: "timeout" }));
    s.on("error", (e) => done({ error: String(e) }));
    s.on("connect", () => s.write(Buffer.from([0x05, 0x01, 0x00])));
    let stage = 0;
    s.on("data", (buf) => {
      if (stage === 0) {
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
          Buffer.from(host, "latin1"),
          Buffer.from([port >> 8, port & 0xff]),
        ]);
        s.write(req);
        stage = 1;
      } else {
        done({ rep: buf[1] });
      }
    });
  });

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

/** Ждать, пока страница не загрузится (readyState complete) или не покажет
 *  сетевую ошибку (ERR_… на странице ошибки Chromium). */
const waitForLoad = async (ws, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await evalIn(ws, `document.readyState`).catch(() => "");
    if (state === "complete") {
      const text = await evalIn(ws, `document.body ? document.body.innerText.slice(0, 400) : ""`).catch(() => "");
      if (/ERR_[A-Z_]+/.test(text)) return { error: text.match(/ERR_[A-Z_]+/)[0] };
      return { loaded: true };
    }
    await sleep(400);
  }
  return { error: "timeout" };
};

const navigate = async (ws, url) => {
  await ws.send("Page.navigate", { url });
  return waitForLoad(ws);
};

// --- 1. локальные серверы ------------------------------------------------------
let httpHits = 0;
const httpServer = http.createServer((req, res) => {
  httpHits++;
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<html><body><h1>DuoPulse local test</h1></body></html>");
});
await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));

const socks = await startSocks5({ log: (m) => console.log(`  [socks5] ${m}`) });
const socksAuth = await startSocks5({
  log: (m) => console.log(`  [socks5-auth] ${m}`),
  auth: { user: "e2e-auth", pass: "e2e-pass" },
});
const DEAD_PORT = await deadPort();
console.log(
  `socks5 на 127.0.0.1:${socks.port}, socks5-auth на 127.0.0.1:${socksAuth.port}, http-стенд на 127.0.0.1:${HTTP_PORT}`,
);

// --- 2. изолированный профиль с включённым прокси --------------------------------
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

// --- 3. vite dev + приложение ----------------------------------------------------
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

/** Подождать CDP-цели (content — страница стенда, ui — localhost:5173). */
const waitForTargets = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
      const content = targets.find((t) => t.type === "page" && t.url.includes(`:${HTTP_PORT}`));
      const ui = targets.find((t) => t.type === "page" && /localhost:5173/.test(t.url));
      if (content && ui) return { content, ui };
    } catch {
      /* приложение ещё поднимается */
    }
    await sleep(1000);
  }
  throw new Error("CDP-цели не найдены");
};

let failures = 0;
try {
  const { content: contentT, ui: uiT } = await waitForTargets();
  console.log(
    `CDP-цели: content=${contentT.url.slice(0, 60)}, ui=${uiT.url.slice(0, 60)}`,
  );
  const contentWs = connect(contentT.webSocketDebuggerUrl);
  const uiWs = connect(uiT.webSocketDebuggerUrl);
  await contentWs.send("Page.enable");
  await uiWs.send("Runtime.enable");
  // UI-документ мог ещё не доехать до полного DOM (гонка первого прогона):
  // ждём статический маркер хрома, чтобы проверки меню не бились об пустоту.
  for (let i = 0; i < 40; i++) {
    const ready = await evalIn(uiWs, `!!document.getElementById('proxyMenu')`).catch(() => false);
    if (ready === true) break;
    await sleep(500);
  }

  // (1) аргументы: WebView2 ПОСТОЯННО на роутере (порт — фактический из cmdline)
  const cmdline = await webViewCmdlines();
  const routerPort = routerPortOf(cmdline);
  check(
    "аргументы WebView2 постоянно указывают на локальный роутер",
    routerPort !== null && routerPort > 0 && routerPort !== socks.port,
    `router=127.0.0.1:${routerPort}`,
  );
  check(
    "--proxy-bypass-list в командной строке WebView2",
    cmdline.includes("--proxy-bypass-list=") && cmdline.includes("localhost"),
  );

  // (2) внешний URL идёт WebView2 → роутер → внешний SOCKS5 (DNS у маршрута)
  const r1 = await navigate(contentWs, "http://example.com/");
  const proxied = socks.connects.filter((c) => c.startsWith("example.com"));
  check(
    `внешний URL (example.com) пошёл через роутер и прокси`,
    r1.loaded && proxied.length > 0,
    `load=${JSON.stringify(r1)}, CONNECT-лог: ${socks.connects.join(", ") || "пусто"}`,
  );
  // socks5.mjs пишет в лог цель строкой: домен в логе = Chromium прислал
  // ATYP=domain (резолв на стороне маршрута, не у клиента)
  check(
    "DNS на стороне маршрута (в CONNECT домен, не IP)",
    proxied.length > 0 && !/^\d+\.\d+\.\d+\.\d+/.test(proxied[0]),
    proxied[0] ?? "нет CONNECT",
  );

  // (3) localhost — напрямую, никогда через роутер
  const socksBefore = socks.connects.length;
  const r2 = await navigate(contentWs, `http://127.0.0.1:${HTTP_PORT}/bypass-check`);
  check(
    "localhost загружен напрямую (нет CONNECT на локальный адрес)",
    r2.loaded && !socks.connects.slice(socksBefore).some((c) => c.startsWith("127.0.0.1:")),
    `новые CONNECT: ${socks.connects.slice(socksBefore).join(", ") || "нет"}`,
  );
  check("страница localhost реально загрузилась", httpHits >= 2, `http-хиты: ${httpHits}`);

  // (4) меню «Прокси» в UI: статус ВКЛ, конфиг читается, пароль не возвращается
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
  const restartGone = await evalIn(uiWs, `!document.getElementById('proxyRestartBlock')`);
  check("блок «применяется после перезапуска» исчез из меню", restartGone === true);

  // (5) миграция инкремента A: тумблер переключает режим роутером, без перезапуска
  await evalIn(uiWs, `document.getElementById('proxyEnabled').click(), true`); // выкл
  await sleep(1500);
  const savedOff = JSON.parse(fs.readFileSync(path.join(profile, "settings.json"), "utf8"));
  check("тумблер сохранил выключение в settings.json", savedOff.proxy?.enabled === false);
  const stateOff = await evalIn(uiWs, `document.getElementById('proxyStatus').dataset.state`);
  check("статус после выключения — ВЫКЛ", stateOff === "off", `state=${stateOff}`);

  // выкл: страницы грузятся напрямую (как без роутера), в прокси ничего не идёт
  const socksAtOff = socks.connects.length;
  const r3 = await navigate(contentWs, "http://example.org/"); // свежий хост — без пула сокетов
  check(
    "режим off: страница грузится напрямую (новых CONNECT нет)",
    r3.loaded && socks.connects.length === socksAtOff,
    `load=${JSON.stringify(r3)}, CONNECT: ${socks.connects.slice(socksAtOff).join(", ") || "нет"}`,
  );

  // вкл — тот же процесс, тот же роутер: трафик снова через прокси
  await evalIn(uiWs, `document.getElementById('proxyEnabled').click(), true`);
  await sleep(1500);
  const r4 = await navigate(contentWs, "http://example.net/");
  check(
    "обратно вкл без перезапуска: трафик снова через прокси",
    r4.loaded && socks.connects.filter((c) => c.startsWith("example.net")).length > 0,
    `CONNECT: ${socks.connects.slice(socksAtOff).join(", ") || "нет"}`,
  );

  // (6) путь с паролем: роутер подставляет креденшалы из DPAPI (RFC 1929)
  await evalIn(
    uiWs,
    `(() => { document.getElementById('proxyHost').value = '127.0.0.1';
       document.getElementById('proxyPort').value = '${socksAuth.port}';
       document.getElementById('proxyLogin').value = 'e2e-auth';
       document.getElementById('proxyPassword').value = 'e2e-pass';
       document.getElementById('proxySave').click(); return true; })()`,
  );
  await sleep(2000);
  const r5 = await navigate(contentWs, "http://iana.org/");
  check(
    "прокси с паролем: подключение прошло (RFC 1929 через роутер)",
    r5.loaded &&
      socksAuth.connects.some((c) => c.startsWith("iana.org")) &&
      socksAuth.authResults.length > 0 &&
      socksAuth.authResults.every(Boolean),
    `CONNECT: ${socksAuth.connects.join(", ") || "нет"}, auth: ${socksAuth.authResults.join(",")}`,
  );
  const rawSettings = fs.readFileSync(path.join(profile, "settings.json"), "utf8");
  check("в settings.json нет пароля", !rawSettings.includes("password"), rawSettings.slice(0, 200));

  // (7) fail-closed: битый upstream — ошибка, напрямую не идёт
  await evalIn(
    uiWs,
    `(() => { document.getElementById('proxyPort').value = '${DEAD_PORT}';
       document.getElementById('proxyPassword').value = '';
       document.getElementById('proxySave').click(); return true; })()`,
  );
  await sleep(2000);
  const hitsBefore = httpHits;
  const probe = await socks5Probe(routerPort, "127.0.0.1", HTTP_PORT);
  check(
    "fail-closed (роутер): отказ upstream → REP≠0 клиенту",
    probe.rep !== undefined && probe.rep !== 0,
    `probe=${JSON.stringify(probe)}`,
  );
  await sleep(700);
  check(
    "fail-closed (роутер): напрямую к цели соединение НЕ пошло",
    httpHits === hitsBefore,
    `http-хиты: ${hitsBefore} → ${httpHits}`,
  );
  const r6 = await navigate(contentWs, "http://neverssl.com/");
  check(
    "fail-closed (страница): загрузка заканчивается ERR_-ошибкой, не прямым ходом",
    r6.error !== undefined && /^ERR_/.test(r6.error),
    `load=${JSON.stringify(r6)}`,
  );

  // восстановление: рабочий прокси снова принимает трафик
  await evalIn(
    uiWs,
    `(() => { document.getElementById('proxyPort').value = '${socks.port}';
       document.getElementById('proxyLogin').value = 'e2e-user';
       document.getElementById('proxySave').click(); return true; })()`,
  );
  await sleep(2000);
  const r7 = await navigate(contentWs, "http://example.com/");
  check("после восстановления прокси страницы снова грузятся", r7.loaded, `load=${JSON.stringify(r7)}`);

  // скриншот меню для протокола
  const shot = await uiWs.send("Page.captureScreenshot", { format: "png" });
  fs.mkdirSync(path.join(ROOT, "e2e", "proxy-a"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "e2e", "proxy-a", "menu-open.png"), Buffer.from(shot.data, "base64"));
  console.log("скриншот меню: e2e/proxy-a/menu-open.png");
  contentWs.close();
  uiWs.close();

  // --- фаза 2: перезапуск — роутер и режим на месте ------------------------------
  app.kill("SIGKILL");
  await killOurExes();
  await sleep(1500);
  spawn(EXE, [], { stdio: "ignore", env: appEnv });
  const t2 = await waitForTargets();
  const cmdline2 = await webViewCmdlines();
  const routerPort2 = routerPortOf(cmdline2);
  check(
    "после перезапуска WebView2 снова постоянно на роутере",
    routerPort2 !== null && routerPort2 > 0,
    `router=127.0.0.1:${routerPort2}`,
  );
  const ui2Ws = connect(t2.ui.webSocketDebuggerUrl);
  const content2Ws = connect(t2.content.webSocketDebuggerUrl);
  await ui2Ws.send("Runtime.enable");
  await content2Ws.send("Page.enable");

  await evalIn(ui2Ws, `document.getElementById('proxyBtn').click(), true`);
  await sleep(2500);
  const state2 = await evalIn(ui2Ws, `document.getElementById('proxyStatus').dataset.state`);
  check("после перезапуска режим прокси восстановлен (статус ВКЛ)", state2 === "on", `state=${state2}`);
  const toggle2 = await evalIn(ui2Ws, `document.getElementById('proxyEnabled').checked`);
  check("тумблер после перезапуска в положении «вкл»", toggle2 === true);

  const socksAtRestart = socks.connects.length;
  const r8 = await navigate(content2Ws, "http://example.org/");
  check(
    "после перезапуска трафик идёт через прокси (сохранённый режим)",
    r8.loaded && socks.connects.length > socksAtRestart,
    `CONNECT: ${socks.connects.slice(socksAtRestart).join(", ") || "нет"}`,
  );

  // финальный офф-режим после перезапуска: напрямую, как без роутера
  await evalIn(ui2Ws, `document.getElementById('proxyEnabled').click(), true`);
  await sleep(1500);
  const socksFinal = socks.connects.length;
  const r9 = await navigate(content2Ws, "http://www.iana.org/");
  check(
    "офф после перезапуска: страница напрямую, прокси молчит",
    r9.loaded && socks.connects.length === socksFinal,
    `load=${JSON.stringify(r9)}`,
  );
  ui2Ws.close();
  content2Ws.close();
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
  socksAuth.server.close();
  httpServer.close();
  await sleep(1000);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

const failed = results.filter((r) => !r.ok).length + failures;
console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES: " + failed} (${results.length} проверок)`);
process.exit(failed === 0 ? 0 : 1);
