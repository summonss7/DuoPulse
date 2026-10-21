// E2E-прогон маршрутных сценариев VPN (задача 6.6, карточка duopulse-042;
// сценарий gate M6 — docs/01 §5.6). Реальное приложение + loopback WG-стенд
// (пакет e2e/wg-stand): сервер WireGuard на 127.0.0.1, внутри туннеля —
// HTTP-сервер (страницы, /video.mp4, paced /slow.bin), DNS (*.tun) и echo.
// Сценарии:
//   A. direct (режим off): локальная страница грузится напрямую;
//      «заблокированный» домен .tun без туннеля не открывается (ERR);
//   B. tunnel, сценарий docs/01 §5.6: импорт .conf → тумблер в панели VPN →
//      handshake → http://blocked.tun/ открывается ЧЕРЕЗ туннель (DNS-запрос
//      и HTTP-хит видит только стенд), живая статистика rx/tx/ping;
//   C. gate M6: 1080p-видео (1920x1080, 4 Мбит/с) туннельным маршрутом
//      играет до конца без единого stall-события, буфер убегает вперёд;
//   D. split: правило blocked.tun → туннель (страница грузится через
//      туннель), посторонний домен — напрямую (стенд его DNS не видит),
//      локальная страница живёт при включённом туннеле;
//   E. kill-switch (второй сеанс приложения, DUOPULSE_WG_DEAD_MS=20000,
//      свежий эндпоинт стенда — upsert того же профиля): загрузка большого
//      файла через туннель обрывается смертью стенда ПОСЕРЕДИНЕ передачи —
//      fetch видит обрыв (не висит вечно), новые соединения отказывают
//      (ERR-страница), статус Error «kill-switch» в UI; режим split и
//      профиль пережили перезапуск (автозапуск туннеля на старте).
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

const vite = spawn("npm", ["run", "dev"], { cwd: ROOT, shell: true, stdio: "ignore" });
for (let i = 0; i < 60; i++) {
  try {
    await fetch("http://localhost:5173/");
    break;
  } catch {
    await sleep(500);
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
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
  };
  if (deadMs) appEnv.DUOPULSE_WG_DEAD_MS = String(deadMs);
  app = spawn(EXE, [], { stdio: "ignore", env: appEnv });

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

  const { contentWs, uiWs } = await startApp(null); // сеанс 1: порог kill-switch протокольный
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

  const rA2 = await navigate(contentWs, "http://blocked.tun/");
  check(
    "A2 direct (off): «заблокированный» домен без туннеля — ERR-страница",
    rA2.error !== undefined && /^ERR_/.test(rA2.error),
    `load=${JSON.stringify(rA2).slice(0, 80)}`,
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

  const rB3 = await navigate(contentWs, "http://blocked.tun/");
  const dns1 = dnsNames(stand1);
  const hits1 = httpHits(stand1);
  check(
    "B3 §5.6: заблокированный сайт открывается ЧЕРЕЗ туннель",
    rB3.loaded && /tunnel ok/i.test(rB3.text ?? ""),
    `load=${JSON.stringify(rB3).slice(0, 60)}`,
  );
  check(
    "B3 DNS и HTTP видел только стенд туннеля (утечек к системному нет)",
    dns1.includes("blocked.tun") && hits1.some((h) => h.path === "/") &&
      dns1.every((n) => n.endsWith(".tun")),
    `dns=[${dns1.join(",")}], http=[${hits1.map((h) => h.path).join(",")}]`,
  );

  const wgStat = await vpnStatus(uiWs);
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
       const r = { stalls: 0, w: 0, h: 0, aheadMax: 0, ev: [] };
       let started = false;
       const fin = (x) => { window.__videoSettled = x; };
       v.addEventListener('loadedmetadata', () => { r.w = v.videoWidth; r.h = v.videoHeight; r.ev.push('meta'); });
       v.addEventListener('timeupdate', () => {
         if (v.currentTime > 0.05) started = true;
         const end = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0;
         r.aheadMax = Math.max(r.aheadMax, end - v.currentTime);
       });
       v.addEventListener('waiting', () => { if (started) r.stalls++; r.ev.push('wait'); });
       v.addEventListener('stalled', () => { if (started) r.stalls++; r.ev.push('stall'); });
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
    "C1 gate M6: 1080p (1920x1080) через туннель играет до конца без буферизации",
    video?.w === 1920 && video?.h === 1080 && video?.ended === true && video?.stalls === 0,
    `probe=${JSON.stringify(vprobe)}, http=${JSON.stringify(videoHttp)}, video=${JSON.stringify(video)}`,
  );
  check(
    "C1 буфер убегает вперёд (_download_ обгоняет воспроизведение)",
    (video?.aheadMax ?? 0) > 5,
    `aheadMax=${((video?.aheadMax ?? 0)).toFixed(1)} с`,
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
  const { contentWs, uiWs } = await startApp(DEAD_MS);

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
  const rEnav = await navigate(contentWs, "http://blocked.tun/");
  if (!rEnav.loaded) console.log(`(навигация перед slow: ${JSON.stringify(rEnav).slice(0, 80)})`);
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

  // Новые соединения к туннельной цели отказывают (fail-closed быстро).
  const rE2 = await navigate(contentWs, "http://blocked.tun/after-kill");
  check(
    "E2 kill-switch: новые соединения — ERR-страница (напрямую не пошли)",
    rE2.error !== undefined && /^ERR_/.test(rE2.error),
    `load=${JSON.stringify(rE2).slice(0, 60)}`,
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
  await openVpnPanel(uiWs);
  await sleep(600);
  const panelErr = await evalIn(uiWs, `document.getElementById('vpnPanelStatus').dataset.state`);
  const shieldErr = await evalIn(uiWs, `document.getElementById('vpnBtn').dataset.vpn`);
  check(
    "E3 kill-switch: панель и щит показывают ошибку kill-switch",
    panelErr === "error" && shieldErr === "error" && stK != null,
    `panel=${panelErr}, shield=${shieldErr}, detail=${JSON.stringify(stK?.detail ?? "").slice(0, 60)}`,
  );

  // Прямой путь жив: контрольная страница грузится напрямую.
  const rE4 = await navigate(contentWs, `http://127.0.0.1:${HTTP_PORT}/alive-check`);
  check(
    "E4 kill-switch: прямой маршрут жив (контрольная страница грузится)",
    rE4.loaded,
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
