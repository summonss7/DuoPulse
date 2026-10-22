// E2E-прогон маршрутных сценариев VPN (задача 6.6, карточка duopulse-042;
// сценарий gate M6 — docs/01 §5.6). Реальное приложение + loopback WG-стенд
// (пакет e2e/wg-stand): сервер WireGuard на 127.0.0.1, внутри туннеля —
// HTTP-сервер (страницы, /video.mp4, paced /slow.bin), DNS (*.tun) и echo.
// Сценарии:
//   A. direct (режим off): локальная страница грузится напрямую;
//      «заблокированный» домен .tun без туннеля не открывается — с карточки
//      048 это собственная страница ошибки DuoPulse (webview вкладки
//      пересоздаётся, CDP-цель меняется);
//   B. tunnel, сценарий docs/01 §5.6: импорт .conf → тумблер в панели VPN →
//      handshake → http://blocked.tun/ открывается ЧЕРЕЗ туннель (DNS-запрос
//      и HTTP-хит видит только стенд), живая статистика rx/tx/ping;
//   C. gate M6: 1080p-видео (1920x1080, 4 Мбит/с) туннельным маршрутом
//      играет до конца без единого stall-события, буфер убегает вперёд;
//   D. split: правило blocked.tun → туннель (страница грузится через
//      туннель), посторонний домен — напрямую (стенд его DNS не видит),
//      локальная страница живёт при включённом туннеле;
//   F. страница ошибки (карточка 048): без правила — страница ошибки с
//      действием «этот сайт — через туннель»; клик создаёт split-правило
//      (общий стор IPC ↔ роутер) и повторная загрузка проходит туннелем;
//      внутренняя страница («Новая вкладка») страницу ошибки не показывает;
//   E. kill-switch (второй сеанс приложения, DUOPULSE_WG_DEAD_MS=20000,
//      свежий эндпоинт стенда — upsert того же профиля): загрузка большого
//      файла через туннель обрывается смертью стенда ПОСЕРЕДИНЕ передачи —
//      fetch видит обрыв (не висит вечно), новые соединения отказывают
//      (страница ошибки DuoPulse), статус Error «kill-switch» в UI; режим
//      split и профиль пережили перезапуск (автозапуск туннеля на старте).
// Изоляция: APPDATA и WEBVIEW2_USER_DATA_FOLDER — во временном каталоге,
// реальный профиль пользователя не затрагивается.
//
// Запуск:  node e2e/vpn/run.mjs [путь-к-duopulse.exe]
// Требует собранный debug-exe (cargo build); wg-stand строится сам, если
// exe нет (e2e/wg-stand/target/debug/wg-stand.exe, env E2E_WG_STAND).
// Порт локального http-стенда — env E2E_VPN_PORT (умолчание 8897).
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const WG_STAND =
  process.env.E2E_WG_STAND || path.join(ROOT, "e2e", "wg-stand", "target", "debug", "wg-stand.exe");
const VIDEO = path.join(ROOT, "e2e", "fixtures", "vpn", "video-1080p.mp4");
const CDP_PORT = 9225;
const HTTP_PORT = Number(process.env.E2E_VPN_PORT || 8897);
// Порог мёртвости kill-switch во втором сеансе (handshake старше → туннель
// мёртв): 20 с — быстрее протокольных 180 с, чтобы прогон не тянулся.
const DEAD_MS = 20000;
const SLOW_BYTES = 64 * 1024 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))));

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

const pollUntil = async (fn, timeoutMs, label, everyMs = 500) => {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(everyMs);
  }
  throw new Error(`таймаут ожидания: ${label} (последнее: ${JSON.stringify(last)?.slice(0, 200)})`);
};

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

/** Порт роутера из командной строки WebView2 (--proxy-server=socks5://127.0.0.1:N). */
const routerPortOf = (cmdline) => {
  const m = cmdline.replace(/\r?\n/g, " ").match(/--proxy-server=socks5:\/\/127\.0\.0\.1:(\d+)/);
  return m ? Number(m[1]) : null;
};

/** Мини-клиент SOCKS5 → CONNECT host:port (проба роутера из ранера).
 *  Возвращает REP-байт (0 — успех), { error } — на отказ/таймауте. */
const socks5Probe = (routerPort, host, port, timeoutMs = 15000) =>
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
  open.catch(() => {});
  // Таймаут на каждый вызов: у цели, умершей вместе с webview (пересоздание
  // страницы ошибки, карточка 048), WebSocket.send молча виснет — без таймаута
  // стенд стоит вечно вместо внятного отказа сценария.
  const CDP_CALL_TIMEOUT_MS = 20000;
  const send = (method, params = {}) =>
    open.then(
      () =>
        new Promise((res, rej) => {
          const i = ++id;
          const timer = setTimeout(() => {
            pending.delete(i);
            rej(new Error(`CDP ${method}: нет ответа ${CDP_CALL_TIMEOUT_MS} мс`));
          }, CDP_CALL_TIMEOUT_MS);
          pending.set(i, {
            res: (v) => { clearTimeout(timer); res(v); },
            rej: (e) => { clearTimeout(timer); rej(e); },
          });
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
const waitForLoad = async (ws, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await evalIn(ws, `document.readyState`).catch(() => "");
    if (state === "complete") {
      const text = await evalIn(ws, `document.body ? document.body.innerText.slice(0, 400) : ""`).catch(() => "");
      if (/ERR_[A-Z_]+/.test(text)) return { error: text.match(/ERR_[A-Z_]+/)[0] };
      return { loaded: true, text };
    }
    await sleep(400);
  }
  return { error: "timeout" };
};

const navigate = async (ws, url) => {
  await ws.send("Page.navigate", { url });
  return waitForLoad(ws);
};

/** Ждать перехода документа на URL с префиксом (для навигаций со страницы
 *  ошибки через nav.navigate: invoke резолвится до загрузки, readyState
 *  старого документа ещё complete — waitForLoad вернул бы прошлое). */
const waitForNavigate = async (ws, urlPrefix, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await evalIn(
      ws,
      `location.href.startsWith(${JSON.stringify(urlPrefix)}) && document.readyState === 'complete'
         ? { url: location.href, text: document.body ? document.body.innerText.slice(0, 400) : '' }
         : null`,
    ).catch(() => null);
    if (r) return r;
    await sleep(400);
  }
  return null;
};

// --- цели страницы ошибки (карточка 048): webview вкладки при неудачной ---
// --- навигации пересоздаётся (page-error-N, UI-бандл) — CDP-цель меняется ---

const listTargets = async () =>
  (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).filter((t) => t.type === "page");

/** Найти цель-страницу ошибки: бандл 5173 (как UI-хром — различаем контентом)
 *  + window.__DUOPULSE_ERROR__; url — ожидаемый упавший адрес (null — любой). */
const connectErrorPage = async (url = null, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const t of await listTargets().catch(() => [])) {
      if (!/(?:localhost|127\.0\.0\.1):5173/.test(t.url)) continue;
      const ws = connect(t.webSocketDebuggerUrl);
      const ctx = await evalIn(ws, `window.__DUOPULSE_ERROR__ ?? null`).catch(() => null);
      if (ctx && (!url || ctx.url === url)) {
        await ws.send("Page.enable").catch(() => {});
        return { ws, ctx };
      }
      ws.close();
    }
    await sleep(700);
  }
  throw new Error(`страница ошибки не найдена (${url ?? "любая"})`);
};

/** Ждать на цели страницы ошибки действия (кнопки бандла могли отстать от
 *  init-скрипта) и снять их состояние. */
const errorActions = async (ws) =>
  pollUntil(
    async () => {
      const a = await evalIn(
        ws,
        `(() => {
           const bs = [...document.querySelectorAll('.err-actions button')];
           if (!bs.length) return null;
           return {
             retry: bs.some((b) => b.className.includes('primary')),
             tunnel: bs.find((b) => !b.className.includes('primary'))?.textContent ?? null,
           };
         })()`,
      ).catch(() => null);
      return a?.retry ? a : null;
    },
    10000,
    "кнопки страницы ошибки",
  );

// --- 1. локальные серверы и стенд ----------------------------------------------

let directHits = 0;
const httpServer = http.createServer((req, res) => {
  directHits++;
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<html><body><h1>direct ok ${req.url}</h1></body></html>`);
});
await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));

if (!fs.existsSync(EXE)) {
  console.error(`нет debug-exe ${EXE} — соберите: cargo build (в src-tauri)`);
  process.exit(2);
}
if (!fs.existsSync(VIDEO)) {
  console.error(`нет фикстуры ${VIDEO}`);
  process.exit(2);
}
if (!fs.existsSync(WG_STAND)) {
  console.log("wg-stand.exe нет — собираю (e2e/wg-stand)…");
  await run("cargo", ["build", "--manifest-path", path.join(ROOT, "e2e", "wg-stand", "Cargo.toml")]);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-vpn-e2e-"));
const profileDir = path.join(tmp, "DuoPulse", "profile");

/** Поднять wg-stand: события JSONL собираются, ready — промис. Раздаёт
 *  index-страницу «/» (маркер tunnel ok) и 1080p-видео фикстуры. */
const startWgStand = (tag) => {
  const confPath = path.join(tmp, `e2e-vpn-${tag}.conf`);
  const indexPath = path.join(tmp, `index-${tag}.html`);
  fs.writeFileSync(
    indexPath,
    '<!doctype html><html><head><meta charset="utf-8"></head><body><h1>tunnel ok</h1><p>страница отдаётся WG-стендом внутри туннеля</p></body></html>',
  );
  const proc = spawn(
    WG_STAND,
    [
      "--conf", confPath,
      "--serve", `/=${indexPath}:text/html`,
      "--serve", `/${path.basename(VIDEO)}=${VIDEO}:video/mp4`,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const events = [];
  const rl = readline.createInterface({ input: proc.stdout });
  rl.on("line", (line) => {
    try {
      events.push(JSON.parse(line));
    } catch {
      /* мусорная строка — игнор */
    }
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`wg-stand ${tag} не поднялся`)), 15000);
    const watch = () => {
      const r = events.find((e) => e.ev === "ready");
      if (r) {
        clearTimeout(timer);
        resolve(r);
      } else if (events.some((e) => e.ev === "fatal")) {
        clearTimeout(timer);
        reject(new Error(`wg-stand ${tag} fatal: ${JSON.stringify(events.find((e) => e.ev === "fatal"))}`));
      } else setTimeout(watch, 200);
    };
    watch();
  });
  return { proc, events, confPath, ready };
};

/** DNS-запросы/HTTP-хиты стенда — для сверок «через туннель / не через». */
const dnsNames = (stand) => stand.events.filter((e) => e.ev === "dns").map((e) => e.name);
const httpHits = (stand, statusOk = true) =>
  stand.events.filter((e) => e.ev === "http" && (!statusOk || e.status === 200));

// --- 2. vite dev + приложение (сеанс 1) ----------------------------------------

const vite = spawn(
  "npm",
  // --host 127.0.0.1: на CI-раннере vite мог слушать только ::1 (резолв
  // localhost), а стенд и devUrl приложения ходят по IPv4.
  ["run", "dev", "--", "--host", "127.0.0.1", "--port", "5173", "--strictPort"],
  { cwd: ROOT, shell: true, stdio: ["ignore", "pipe", "pipe"] },
);
let viteLog = "";
vite.stdout?.on("data", (d) => {
  viteLog = (viteLog + String(d)).slice(-4000);
});
vite.stderr?.on("data", (d) => {
  viteLog = (viteLog + String(d)).slice(-4000);
});
vite.on("exit", (code) => console.error(`vite завершился (код ${code})`));
for (let i = 0; i < 90; i++) {
  try {
    await fetch("http://127.0.0.1:5173/");
    break;
  } catch {
    await sleep(1000);
  }
}

let app = null;
/** Запустить приложение (сеанс: deadMs — env порога kill-switch или null). */
const startApp = async (deadMs) => {
  // Гигиена: прошлый сеанс (и его WebView2-дети) обязан умереть до нового
  // запуска — иначе блокируется WEBVIEW2_USER_DATA_FOLDER и окно не создаётся.
  await killOurExes();
  await pollUntil(async () => (await webViewCmdlines()) === "", 15000, "прошлый WebView2 умер", 500);
  const appEnv = {
    ...process.env,
    APPDATA: tmp, // профиль settings/vpn — во временном каталоге
    DUOPULSE_START_URL: `http://127.0.0.1:${HTTP_PORT}/start`,
    DUOPULSE_ADBLOCK_LISTS: "", // без списков: стенду не нужна сеть (задача 2.1)
    WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"), // изоляция WebView2
    // CDP-порт — ЧЕРЕЗ ПРИЛОЖЕНИЕ (DUOPULSE_CDP_PORT → additional_browser_args
    // API): WebView2 Runtime ≥150 игнорирует WEBVIEW2_ADDITIONAL_BROWSER_
    // ARGUMENTS в elevated-процессах (GitHub Actions — админ; #5645).
    DUOPULSE_CDP_PORT: String(CDP_PORT),
  };
  if (deadMs) appEnv.DUOPULSE_WG_DEAD_MS = String(deadMs);
  app = spawn(EXE, [], { stdio: ["ignore", "ignore", "pipe"], env: appEnv });
  let appErr = "";
  app.stderr?.on("data", (d) => {
    appErr = (appErr + String(d)).slice(-8000);
  });
  app.on("exit", (code) => console.error(`приложение завершилось (код ${code})`));
  globalThis.__duopulseAppErr = () => appErr;

  /** Подождать CDP-цели (content — страница стенда, ui — localhost:5173).
   *  Холодный CI-раннер стартует медленно — 150 с; на таймауте печатаем
   *  диагностику (живы ли процессы, WebView2-runtime, vite). */
  const waitForTargets = async () => {
    for (let i = 0; i < 150; i++) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
        const content = targets.find((t) => t.type === "page" && t.url.includes(`:${HTTP_PORT}`));
        // devUrl приложения — localhost:5173 (как в tauri.conf), а vite может
        // слушать и 127.0.0.1 — матчим оба написания.
        const ui = targets.find(
          (t) => t.type === "page" && /(?:localhost|127\.0\.0\.1):5173/.test(t.url),
        );
        if (content && ui) return { content, ui };
      } catch {
        /* приложение ещё поднимается */
      }
      await sleep(1000);
    }
    try {
      const procs = await run("tasklist", ["/FI", "IMAGENAME eq duopulse.exe", "/FO", "CSV"]).catch(() => "");
      const wv2 = await run("tasklist", ["/FI", "IMAGENAME eq msedgewebview2.exe", "/FO", "CSV"]).catch(() => "");
      const vite = await fetch("http://127.0.0.1:5173/").then(() => "жив").catch((e) => `нет (${e.cause?.code ?? e.message})`);
      const cdp4 = await fetch(`http://127.0.0.1:${CDP_PORT}/json`).then(() => "ok").catch((e) => `нет (${e.cause?.code ?? e.message})`);
      const cdp6 = await fetch(`http://[::1]:${CDP_PORT}/json`).then(() => "ok").catch((e) => `нет (${e.cause?.code ?? e.message})`);
      const wvCmd = await webViewCmdlines();
      const net = await run("netstat", ["-ano"]).catch(() => "");
      const port9225 = net
        .split("\n")
        .filter((l) => l.includes(`:${CDP_PORT}`))
        .join(" | ")
        .slice(0, 300);
      console.error(
        `CDP-диагностика: duopulse=${procs.includes("duopulse.exe") ? "жив" : "НЕТ"}, ` +
          `msedgewebview2=${wv2.includes("msedgewebview2.exe") ? wv2.split("\n").length - 2 : 0} шт, vite=${vite}, ` +
          `cdp[127.0.0.1]=${cdp4}, cdp[[::1]]=${cdp6}, CDP-флаг в cmdline=${wvCmd.includes("remote-debugging-port") ? "есть" : "НЕТ"}`,
      );
      if (wvCmd) console.error(`cmdline webview (хвост): …${wvCmd.replace(/\r?\n/g, " ").slice(-700)}`);
      console.error(`netstat :${CDP_PORT}: ${port9225 || "пусто (никто не слушает)"}`);
      if (viteLog) console.error(`vite (хвост):\n${viteLog.slice(-1200)}`);
      const err = globalThis.__duopulseAppErr?.();
      if (err) console.error(`stderr приложения (хвост):\n${err.slice(-1500)}`);
    } catch {
      /* диагностика не должна ломать путь отказа */
    }
    throw new Error("CDP-цели не найдены");
  };
  const { content, ui } = await waitForTargets();
  const contentWs = connect(content.webSocketDebuggerUrl);
  const uiWs = connect(ui.webSocketDebuggerUrl);
  await contentWs.send("Page.enable");
  await uiWs.send("Runtime.enable");
  // UI-документ мог не доехать до инициализации модулей: ждём dev-хук bridge
  // и кнопку-щит; клики по панели идут через openVpnPanel с ретраями (модуль
  // панели навешивает слушатели асинхронно после загрузки).
  await pollUntil(
    async () => {
      const has = await evalIn(
        uiWs,
        `typeof window.__duopulse === 'object' && !!document.getElementById('vpnBtn')`,
      ).catch(() => false);
      return has === true;
    },
    30000,
    "UI готов (vpnBtn + __duopulse)",
  );
  return { contentWs, uiWs };
};

/** Снапшот vpn.status() через dev-хук bridge. */
const vpnStatus = (uiWs) => evalIn(uiWs, `window.__duopulse.vpn.status()`);

/** Открыть панель VPN с ретраями: модуль панели навешивает слушатели не мгновенно
 *  (клик до инициализации теряется); проверяем видимость и давим, пока не откроется. */
const openVpnPanel = async (uiWs) => {
  for (let i = 0; i < 40; i++) {
    const visible = await evalIn(uiWs, `!document.getElementById('vpnPanel').hidden`).catch(() => false);
    if (visible === true) return;
    await evalIn(uiWs, `document.getElementById('vpnBtn').click(), true`).catch(() => {});
    await sleep(600);
  }
  throw new Error("панель VPN не открывается (UI-модуль не инициализирован?)");
};

let failures = 0;
const stand1 = startWgStand("one");
try {
  const ready1 = await stand1.ready;
  check(
    "стенд: loopback WG-сервер поднялся, клиентский .conf готов",
    fs.existsSync(stand1.confPath) && ready1.udp_port > 0,
    `udp=127.0.0.1:${ready1.udp_port}, conf=${path.basename(stand1.confPath)}`,
  );

  let { contentWs, uiWs } = await startApp(null); // сеанс 1: порог kill-switch протокольный
  console.log("сеанс 1 запущен (порог kill-switch — протокольный 180 с)");

  // --- A. direct (режим off, туннеля нет) --------------------------------------
  const rA1 = await navigate(contentWs, `http://127.0.0.1:${HTTP_PORT}/a-direct`);
  check(
    "A1 direct (off): локальная страница грузится напрямую",
    rA1.loaded && directHits >= 2,
    `load=${JSON.stringify(rA1).slice(0, 80)}`,
  );
  check(
    "A1 туннель молчит (DNS/HTTP событий нет)",
    dnsNames(stand1).length === 0 && httpHits(stand1).length === 0,
    `dns=${dnsNames(stand1).join(",") || "—"}, http=${httpHits(stand1).length}`,
  );

  // A2 (карточка 048): «заблокированный» домен без туннеля — собственная
  // страница ошибки DuoPulse вместо ERR-страницы Chromium: webview вкладки
  // пересоздаётся, прежняя CDP-цель умирает.
  await contentWs.send("Page.navigate", { url: "http://blocked.tun/" }).catch(() => {});
  contentWs.close();
  const errA = await connectErrorPage("http://blocked.tun/");
  const actA = await errorActions(errA.ws);
  check(
    "A2 (048) direct (off): неудачная навигация — своя страница ошибки (адрес, причина, действия)",
    errA.ctx?.url === "http://blocked.tun/" &&
      typeof errA.ctx?.reason === "string" &&
      errA.ctx.reason.length > 0 &&
      actA.retry &&
      /blocked\.tun/.test(actA.tunnel ?? ""),
    `ctx=${JSON.stringify(errA.ctx)}, actions=${JSON.stringify(actA)}`,
  );

  // --- B. tunnel: сценарий docs/01 §5.6 -----------------------------------------
  const info = await evalIn(uiWs, `window.__duopulse.vpn.importProfile({ path: ${JSON.stringify(stand1.confPath)} })`);
  check(
    "B1 импорт .conf стенда через bridge (ключи — в DPAPI)",
    info?.name === "e2e-vpn-one" && typeof info?.id === "string" && info.id.length > 0,
    JSON.stringify(info),
  );

  // §5.6: включение VPN «в меню браузера» — тумблер панели. Ждём, пока панель
  // доснимет профили (иначе selectedId=null и тумблер молча откатится).
  await openVpnPanel(uiWs);
  await pollUntil(
    async () =>
      (await evalIn(uiWs, `!!document.getElementById('vpnProfile') && !document.getElementById('vpnProfile').disabled && document.getElementById('vpnProfile').options.length > 0`).catch(() => false)) ===
      true,
    15000,
    "панель: список профилей готов",
  );
  await evalIn(
    uiWs,
    `((el) => { el.checked = true; el.dispatchEvent(new Event('change')); return true; })(document.getElementById('vpnEnabled'))`,
  );
  let lastStB;
  const stB = await pollUntil(
    async () => {
      lastStB = await vpnStatus(uiWs);
      return lastStB?.mode === "wg" && lastStB?.wg?.state === "connected" ? lastStB : null;
    },
    30000,
    "туннель подключился (панель: тумблер → handshake)",
  ).catch((e) => {
    throw new Error(`${e.message}; последний статус: ${JSON.stringify(lastStB)?.slice(0, 260)}`);
  });
  const panelState = await evalIn(uiWs, `document.getElementById('vpnPanelStatus').dataset.state`);
  const shieldState = await evalIn(uiWs, `document.getElementById('vpnBtn').dataset.vpn`);
  check(
    "B2 §5.6: тумблер панели VPN поднимает туннель (статус connected)",
    panelState === "connected" && shieldState === "connected" && stB.routing === "global",
    `panel=${panelState}, shield=${shieldState}, routing=${stB.routing}`,
  );

  // B3 §5.6: повторная загрузка со страницы ошибки (действие «Повторить» =
  // nav.navigate активной вкладки) — webview той же цели уходит на сайт.
  await evalIn(errA.ws, `window.__duopulse.nav.navigate({ url: "http://blocked.tun/" }), true`);
  contentWs = errA.ws;
  const rB3 = await waitForNavigate(contentWs, "http://blocked.tun/");
  const dns1 = dnsNames(stand1);
  const hits1 = httpHits(stand1);
  check(
    "B3 §5.6: заблокированный сайт открывается ЧЕРЕЗ туннель",
    rB3 != null && /tunnel ok/i.test(rB3.text ?? ""),
    `load=${JSON.stringify(rB3).slice(0, 60)}`,
  );
  check(
    "B3 DNS и HTTP видел только стенд туннеля (утечек к системному нет)",
    dns1.includes("blocked.tun") && hits1.some((h) => h.path === "/") &&
      dns1.every((n) => n.endsWith(".tun")),
    `dns=[${dns1.join(",")}], http=[${hits1.map((h) => h.path).join(",")}]`,
  );

  // Статистика (rx/handshake — сразу; ICMP-ping может опоздать на медленной
  // машине — первый ответ приходит в течение пары секунд, ждём с дедлайном).
  const wgStat = await pollUntil(
    async () => {
      const st = await vpnStatus(uiWs);
      return st?.wg?.rxBytes > 0 &&
        st?.wg?.lastHandshakeMs != null &&
        typeof st?.wg?.pingMs === "number"
        ? st
        : null;
    },
    15000,
    "живая статистика туннеля (rx/handshake/ping)",
  );
  check(
    "B4 живая статистика туннеля: rx>0, handshake и ICMP-ping на месте",
    wgStat?.wg?.rxBytes > 0 && wgStat?.wg?.lastHandshakeMs != null && typeof wgStat?.wg?.pingMs === "number",
    `rx=${wgStat?.wg?.rxBytes}, hs=${wgStat?.wg?.lastHandshakeMs} мс, ping=${wgStat?.wg?.pingMs} мс`,
  );

  // скриншот панели для протокола
  const shot = await uiWs.send("Page.captureScreenshot", { format: "png" });
  fs.mkdirSync(path.join(ROOT, "e2e", "vpn"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "e2e", "vpn", "panel-tunnel.png"), Buffer.from(shot.data, "base64"));
  console.log("скриншот панели: e2e/vpn/panel-tunnel.png");

  // --- C. gate M6: 1080p туннельным маршрутом без буферизации ---------------------
  // Сначала проба URL (мимо <video>): статус/тип/первые байты — чтобы отказ
  // элемента не был загадкой.
  const vprobe = await evalIn(
    contentWs,
    `fetch('http://blocked.tun/${path.basename(VIDEO)}')
       .then(async (res) => ({ status: res.status, type: res.headers.get('content-type'),
          len: Number(res.headers.get('content-length')) }))
       .catch((e) => ({ error: String(e) }))`,
  );
  // Проигрывание — через window-стэш и опрос: у CDP awaitPromise на длинном
  // промисе (>10 с) значение терялось (приходил {}).
  await evalIn(
    contentWs,
    `(() => {
       window.__videoSettled = null;
       const v = document.createElement('video');
       v.src = 'http://blocked.tun/${path.basename(VIDEO)}';
       v.muted = true; v.preload = 'auto';
       // netStalls — ожидания от ПУСТОГО буфера (данные кончились — маршрут
       // не успевает); stalls — все waiting (на слабом CI-раннере бывают
       // от software-декодера при полном буфере — это не сеть).
       const r = { stalls: 0, netStalls: 0, w: 0, h: 0, aheadMax: 0, ev: [], stallAhead: [] };
       let started = false;
       const fin = (x) => { window.__videoSettled = x; };
       const ahead = () => (v.buffered.length ? v.buffered.end(v.buffered.length - 1) - v.currentTime : 0);
       v.addEventListener('loadedmetadata', () => { r.w = v.videoWidth; r.h = v.videoHeight; r.ev.push('meta'); });
       v.addEventListener('timeupdate', () => {
         if (v.currentTime > 0.05) started = true;
         r.aheadMax = Math.max(r.aheadMax, ahead());
       });
       v.addEventListener('waiting', () => {
         if (!started) { r.ev.push('wait-pre'); return; }
         r.stalls++;
         const a = ahead();
         r.stallAhead.push(Math.round(a * 100) / 100);
         if (a < 0.15) r.netStalls++;
       });
       v.addEventListener('error', () => fin({ ...r, error: String(v.error && v.error.code), src: v.error && v.error.message }));
       v.addEventListener('ended', () => fin({ ...r, ended: true, t: v.currentTime }));
       document.body.appendChild(v);
       v.play().then(() => r.ev.push('play'), (e) => fin({ ...r, playError: String(e) }));
       setTimeout(() => fin({ ...r, timeout: true, t: v.currentTime,
         rs: v.readyState, ns: v.networkState, dur: v.duration }), 40000);
       return 'started';
     })()`,
  );
  const video = await pollUntil(
    async () => (await evalIn(contentWs, `window.__videoSettled`)) ?? null,
    50000,
    "видео проигралось",
    250,
  );
  const videoHttp = httpHits(stand1).filter((h) => h.path === `/${path.basename(VIDEO)}`);
  check(
    "C1 gate M6: 1080p (1920x1080) через туннель играет до конца без сетевых пауз",
    video?.w === 1920 &&
      video?.h === 1080 &&
      video?.ended === true &&
      video?.netStalls === 0,
    `probe=${JSON.stringify(vprobe)}, http=${JSON.stringify(videoHttp)}, video=${JSON.stringify(video)}`,
  );
  check(
    "C1 буфер убегает вперёд (загрузка обгоняет воспроизведение)",
    (video?.aheadMax ?? 0) > 1,
    `aheadMax=${(video?.aheadMax ?? 0).toFixed(1)} с`,
  );

  // --- D. split: правило ведёт blocked.tun в туннель, остальное — напрямую --------
  await openVpnPanel(uiWs); // переоткрытие: свежий снапшот статуса/правил
  await evalIn(uiWs, `document.getElementById('vpnMode').querySelector("button[data-mode='split']").click(), true`);
  await sleep(300);
  await evalIn(
    uiWs,
    `((i) => { i.value = 'blocked.tun'; document.getElementById('vpnRuleTunnel').click(); return true; })(document.getElementById('vpnRuleDomain'))`,
  );
  await sleep(500);
  const rules = await evalIn(uiWs, `window.__duopulse.vpn.getRules()`);
  check(
    "D1 split: режим и правило «blocked.tun → туннель» из панели",
    rules?.mode === "split" && rules?.rules?.some((r) => r.domain === "blocked.tun" && r.route === "tunnel"),
    JSON.stringify(rules),
  );

  const dnsD0 = dnsNames(stand1).length;
  const hitsD0 = httpHits(stand1).length;
  const rD2 = await navigate(contentWs, "http://blocked.tun/");
  check(
    "D2 split: правило ведёт blocked.tun через туннель",
    rD2.loaded && httpHits(stand1).length > hitsD0 && dnsNames(stand1).length > dnsD0,
    `load=${JSON.stringify(rD2).slice(0, 60)}, http=${httpHits(stand1).length}→${httpHits(stand1).length}`,
  );

  // Посторонний домен в split — умолчание direct: роутер резолвит системно
  // (NXDOMAIN → отказ), DNS туннеля его не видит.
  const cmdline = await webViewCmdlines();
  const routerPort = routerPortOf(cmdline);
  const probe = routerPort ? await socks5Probe(routerPort, "unmatched.example", 80) : { error: "нет роутера" };
  check(
    "D3 split: посторонний домен — напрямую (туннель DNS не спрашивал)",
    (probe.error !== undefined || probe.rep !== 0) && !dnsNames(stand1).includes("unmatched.example"),
    `probe=${JSON.stringify(probe)}`,
  );

  const rD4 = await navigate(contentWs, `http://127.0.0.1:${HTTP_PORT}/d-still-direct`);
  check(
    "D4 split: прямые страницы живут при включённом туннеле",
    rD4.loaded,
    `load=${JSON.stringify(rD4).slice(0, 60)}`,
  );

  await openVpnPanel(uiWs);
  await sleep(400);
  const routesText = await evalIn(uiWs, `document.getElementById('vpnRoutesList').innerText`);
  check(
    "D5 «Маршруты сеанса»: blocked.tun помечен туннелем (vpn:route_changed)",
    /blocked\.tun/.test(routesText ?? "") && /туннел/i.test(routesText ?? ""),
    JSON.stringify(routesText).slice(0, 120),
  );

  // --- F. страница ошибки → «этот сайт — через туннель» (карточка 048) -----------
  // Туннель поднят, режим split. Свежий домен зоны .tun (не в DNS-кэше
  // Chromium от B/D): без правила идёт напрямую — системный DNS отдаёт
  // NXDOMAIN → страница ошибки с действием «через туннель». Клик:
  // vpn.add_rule (общий стор IPC ↔ роутер, задача 6.3) + туннель поднят в
  // split → автоповтор загрузки по правилу (критерий 048): DNS и HTTP видит
  // только стенд (домен зоны .tun → живой HTTP-сервер стенда).
  const F_HOST = "fresh-048.tun";
  const rulesF0 = await evalIn(uiWs, `window.__duopulse.vpn.getRules()`);
  check(
    `F0 правила «${F_HOST}» нет (режим split жив)`,
    rulesF0?.mode === "split" && !rulesF0?.rules?.some((r) => r.domain === F_HOST),
    JSON.stringify(rulesF0),
  );

  const dnsF0 = dnsNames(stand1).filter((n) => n === F_HOST).length;
  const hitsF0 = httpHits(stand1).length;
  await contentWs.send("Page.navigate", { url: `http://${F_HOST}/` }).catch(() => {});
  contentWs.close();
  const errF = await connectErrorPage(`http://${F_HOST}/`);
  const actF = await errorActions(errF.ws);
  check(
    `F1 без правила — страница ошибки с действием «через туннель» (${F_HOST})`,
    errF.ctx?.url === `http://${F_HOST}/` && actF.tunnel != null && actF.tunnel.includes(F_HOST),
    `ctx=${JSON.stringify(errF.ctx)}, actions=${JSON.stringify(actF)}`,
  );
  await evalIn(
    errF.ws,
    `(() => {
       const b = [...document.querySelectorAll('.err-actions button')].find((x) => !x.className.includes('primary'));
       b.click();
       return true;
     })()`,
  );
  // Клик создал правило и повторил загрузку: тот же webview уходит на сайт.
  contentWs = errF.ws;
  const rF2 = await waitForNavigate(contentWs, `http://${F_HOST}/`);
  const rulesF = await evalIn(uiWs, `window.__duopulse.vpn.getRules()`);
  check(
    "F2 (048) клик «через туннель»: правило создано общим стором, повторная загрузка прошла туннелем",
    rulesF?.rules?.some((r) => r.domain === F_HOST && r.route === "tunnel") &&
      rF2 != null &&
      /tunnel ok/i.test(rF2.text ?? "") &&
      dnsNames(stand1).filter((n) => n === F_HOST).length > dnsF0 &&
      httpHits(stand1).length > hitsF0,
    `rules=${JSON.stringify(rulesF?.rules)}, load=${JSON.stringify(rF2).slice(0, 60)}, dns=${dnsF0}→${dnsNames(stand1).filter((n) => n === F_HOST).length}, http=${hitsF0}→${httpHits(stand1).length}`,
  );

  // Внутренние страницы ошибки не показывают (критерий 048): «Новая вкладка»
  // открывается штатно (маркер .ntp, без контекста ошибки).
  const tabsF = await evalIn(uiWs, `window.__duopulse.tabs.open({ url: "duopulse://newtab" })`);
  const ntTarget = await pollUntil(async () => {
    for (const t of await listTargets().catch(() => [])) {
      if (!/(?:localhost|127\.0\.0\.1):5173/.test(t.url)) continue;
      const ws = connect(t.webSocketDebuggerUrl);
      const isNtp = await evalIn(ws, `!!document.querySelector('.ntp')`).catch(() => false);
      if (isNtp) {
        ws.close();
        return t;
      }
      ws.close();
    }
    return null;
  }, 15000, "цель «Новая вкладка»");
  check(
    "F3 (048) внутренняя страница открывается без страницы ошибки",
    ntTarget != null && tabsF?.tabs?.length > 0,
  );
  await evalIn(
    uiWs,
    `window.__duopulse.tabs.close({ id: ${JSON.stringify(tabsF.tabs.find((t) => t.active)?.id ?? tabsF.tabs.at(-1).id)} }), true`,
  );
  await sleep(400);
  const tabsAfterF = await evalIn(uiWs, `window.__duopulse.tabs.list()`);
  check(
    "F4 (048) вкладок-ошибок не плодится (одна вкладка сайта, вкладка newtab закрыта)",
    tabsAfterF?.tabs?.every((t) => !t.url.startsWith("duopulse://error")) &&
      tabsAfterF?.tabs?.some((t) => t.url.startsWith(`http://${F_HOST}/`)),
    JSON.stringify(tabsAfterF?.tabs?.map((t) => t.url)),
  );

  // --- завершение сеанса 1 (профиль/режим остаются в профиле) --------------------
  contentWs.close();
  uiWs.close();
  app.kill("SIGKILL");
  await killOurExes();
  await sleep(1500);
} catch (e) {
  failures++;
  console.error("E2E ERROR (сеанс 1):", e.message);
}

// --- 3. сеанс 2: kill-switch (порог мёртвости 20 с, свежий эндпоинт) -----------

const stand2 = startWgStand("two");
try {
  const ready2 = await stand2.ready;
  console.log(`сеанс 2: wg-stand #2 udp=127.0.0.1:${ready2.udp_port}, DUOPULSE_WG_DEAD_MS=${DEAD_MS}`);
  let { contentWs, uiWs } = await startApp(DEAD_MS);
  // Перезапуск: режим split и профиль восстановились — туннель автостартовал
  // (эндпоинт ещё старый/мёртвый — обновим upsert-импортом того же пира).
  const st0 = await vpnStatus(uiWs);
  const persisted =
    st0?.routing === "split" && st0?.mode === "wg" && fs.existsSync(path.join(profileDir, "vpn", "split-rules.json"));
  const info2 = await evalIn(uiWs, `window.__duopulse.vpn.importProfile({ path: ${JSON.stringify(stand2.confPath)} })`);
  const st1 = await evalIn(uiWs, `window.__duopulse.vpn.useProfile({ id: ${JSON.stringify(info2.id)} })`);
  let lastStE;
  const stE = await pollUntil(
    async () => {
      lastStE = await vpnStatus(uiWs);
      return lastStE?.mode === "wg" && lastStE?.wg?.state === "connected" ? lastStE : null;
    },
    30000,
    "сеанс 2: туннель подключился к свежему эндпоинту",
  ).catch((e) => {
    throw new Error(`${e.message}; последний статус: ${JSON.stringify(lastStE)?.slice(0, 260)}`);
  });
  check(
    "E0 перезапуск: split-режим и профиль пережили рестарт; upsert того же пира перевёл на новый эндпоинт",
    persisted && info2?.id?.length > 0 && stE?.routing === "split",
    `routing0=${st0?.routing}, mode0=${st0?.mode}, routing=${stE?.routing}`,
  );

  // Загрузка большого файла через туннель; обрываем upstream посередине.
  // Туннель после upsert-эндпоинта мог ещё догонять: мгновенный отказ первого
  // хода — вкладка уходит в страницу ошибки (карточка 048), цель вкладки
  // пересоздаётся — навигация повторяется со страницы ошибки (nav.navigate).
  let rEnav = await navigate(contentWs, "http://blocked.tun/").catch((e) => ({ error: String(e) }));
  for (let tries = 0; !rEnav?.loaded && tries < 3; tries++) {
    console.log(`(навигация к blocked.tun не прошла (${JSON.stringify(rEnav).slice(0, 70)}), ретрай ${tries + 1})`);
    await sleep(2000);
    const errNav = await connectErrorPage("http://blocked.tun/", 10000).catch(() => null);
    if (!errNav) break;
    await evalIn(errNav.ws, `window.__duopulse.nav.navigate({ url: "http://blocked.tun/" }), true`);
    contentWs = errNav.ws;
    rEnav = await waitForNavigate(contentWs, "http://blocked.tun/");
    rEnav = rEnav ? { loaded: true } : { error: "timeout" };
  }
  if (!rEnav?.loaded) console.log(`(навигация перед slow так и не прошла: ${JSON.stringify(rEnav).slice(0, 80)})`);
  else console.log("навигация к blocked.tun прошла, грузим большой файл…");
  await evalIn(
    contentWs,
    `(() => {
       window.__slowResult = null; window.__slowReceived = 0;
       fetch('http://blocked.tun/slow.bin?bytes=${SLOW_BYTES}')
         .then((res) => {
           const reader = res.body.getReader();
           const pump = () => reader.read().then(({ done, value }) => {
             if (done) { window.__slowResult = { received: window.__slowReceived, done: true }; return; }
             window.__slowReceived += value.length;
             return pump();
           });
           return pump();
         })
         .catch((e) => { window.__slowResult = { received: window.__slowReceived, error: String(e) }; });
       return true;
     })()`,
  );
  await pollUntil(
    async () => {
      const r = await evalIn(contentWs, `window.__slowResult`).catch(() => null);
      if (r && r.received < 512 * 1024) {
        throw new Error(`fetch оборвался раньше порога: ${JSON.stringify(r).slice(0, 140)}`);
      }
      const got = await evalIn(contentWs, `window.__slowReceived`).catch(() => 0);
      return got >= 512 * 1024 ? got : null;
    },
    30000,
    "передача пошла (≥512 КБ через туннель)",
    200,
  );
  console.log("обрываю upstream (kill wg-stand #2) посередине передачи…");
  try {
    await run("taskkill", ["/PID", String(stand2.proc.pid), "/T", "/F"]);
  } catch {
    /* уже умер — тоже сценарий обрыва */
  }
  const slowResult = await pollUntil(
    async () => {
      const r = await evalIn(contentWs, `window.__slowResult`).catch(() => null);
      return r ?? null;
    },
    DEAD_MS + 40000,
    "kill-switch закрыл установленную передачу (fetch увидел обрыв)",
    300,
  );
  check(
    "E1 kill-switch: обрыв upstream посередине передачи — соединение закрыто (не висит)",
    slowResult != null &&
      slowResult.received < SLOW_BYTES &&
      (slowResult.error !== undefined || slowResult.done === true),
    JSON.stringify(slowResult).slice(0, 140),
  );

  // Новые соединения к туннельной цели отказывают (fail-closed быстро):
  // с карточки 048 — страница ошибки DuoPulse (webview пересоздаётся).
  await contentWs.send("Page.navigate", { url: "http://blocked.tun/after-kill" }).catch(() => {});
  contentWs.close();
  const errE = await connectErrorPage("http://blocked.tun/after-kill");
  check(
    "E2 kill-switch: новые соединения — страница ошибки DuoPulse (напрямую не пошли)",
    errE.ctx?.url === "http://blocked.tun/after-kill",
    `ctx=${JSON.stringify(errE.ctx)}`,
  );

  // Статус в UI: Error с деталью kill-switch (щит и панель). После смерти
  // сервера сессия может пересоздаваться (WSAECONNRESET от мёртвого UDP-порта
  // → roaming-рекреация, счётчики в 0) — эпизоды Error рекуррентны, окно
  // 60 с ловит минимум один надёжно.
  const stHist = [];
  let lastSt;
  const stK = await pollUntil(
    async () => {
      lastSt = await vpnStatus(uiWs);
      stHist.push(`${lastSt?.wg?.state}/${(lastSt?.detail ?? "").slice(0, 24)}`);
      if (stHist.length > 40) stHist.shift();
      // Деталь kill-switch — на верхнем уровне снапшота (в wg-полях её нет).
      return lastSt?.wg?.state === "error" && /kill-switch/i.test(lastSt?.detail ?? "")
        ? lastSt
        : null;
    },
    60000,
    "статус Error «kill-switch» в vpn.status",
  ).catch((e) => {
    throw new Error(`${e.message}; история: ${stHist.join(" | ").slice(0, 300)}`);
  });
  // Панель и щит: после смерти сервера эпизоды Error рекуррентны (между ними
  // Connecting — сессия пересоздаётся по WSAECONNRESET), поэтому читаем
  // состояние опросом до error-эпизода, а не один раз.
  await openVpnPanel(uiWs);
  const ui = await pollUntil(
    async () => {
      const [panelErr, shieldErr] = await Promise.all([
        evalIn(uiWs, `document.getElementById('vpnPanelStatus').dataset.state`).catch(() => ""),
        evalIn(uiWs, `document.getElementById('vpnBtn').dataset.vpn`).catch(() => ""),
      ]);
      return panelErr === "error" && shieldErr === "error" ? { panelErr, shieldErr } : null;
    },
    45000,
    "панель и щит показали ошибку kill-switch",
  ).catch((e) => {
    throw new Error(`${e.message}; статус: ${JSON.stringify(lastSt)?.slice(0, 200)}`);
  });
  check(
    "E3 kill-switch: панель и щит показывают ошибку kill-switch",
    ui != null && stK != null,
    `panel=${ui?.panelErr}, shield=${ui?.shieldErr}, detail=${JSON.stringify(stK?.detail ?? "").slice(0, 60)}`,
  );

  // Прямой путь жив: контрольная страница грузится напрямую — уходим со
  // страницы ошибки её же действием (страница активной вкладки).
  await evalIn(
    errE.ws,
    `window.__duopulse.nav.navigate({ url: "http://127.0.0.1:${HTTP_PORT}/alive-check" }), true`,
  );
  contentWs = errE.ws;
  const rE4 = await waitForNavigate(contentWs, `http://127.0.0.1:${HTTP_PORT}/`);
  check(
    "E4 kill-switch: прямой маршрут жив (контрольная страница грузится)",
    rE4 != null,
    `load=${JSON.stringify(rE4).slice(0, 60)}`,
  );

  // Выключение тумблера гасит туннель.
  await evalIn(
    uiWs,
    `((el) => { el.checked = false; el.dispatchEvent(new Event('change')); return true; })(document.getElementById('vpnEnabled'))`,
  );
  await sleep(1200);
  const stOff = await vpnStatus(uiWs);
  check(
    "E5 тумблер выкл: туннель погашен (routing off)",
    stOff?.mode !== "wg" && stOff?.routing === "off",
    `mode=${stOff?.mode}, routing=${stOff?.routing}`,
  );

  contentWs.close();
  uiWs.close();
} catch (e) {
  failures++;
  console.error("E2E ERROR (сеанс 2):", e.message);
} finally {
  app?.kill("SIGKILL");
  await killOurExes();
  for (const stand of [stand1, stand2]) {
    try {
      stand.proc.kill();
    } catch {
      /* уже мёртв */
    }
  }
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
