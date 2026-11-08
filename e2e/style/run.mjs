// E2E-сверка фирменного UI-хрома с гайдом 06 (задача 1.5, карточка duopulse-015).
// DoD: «чек-лист соответствия (гайд 06 §9) проходит по всем экранам хрома» и
// «скриншоты основных экранов приложены к отчёту». Здесь — автоматизируемая
// часть: детерминированные проверки токенов/шрифтов/поведения + скриншоты
// e2e/style/*.png; визуальная сверка по снимкам — e2e/style/CHECKLIST.md.
//
//   1) стартовая вкладка — duopulse://newtab (default_tab_url), tabs.open({}) —
//      тоже новая вкладка;
//   2) страница «Новая вкладка»: 8 плиток топ-сайтов из локальной истории
//      (группировка по хосту), Enter в omnibox-подсказке навигает вкладку;
//   3) фирменные шрифты загружены локально (Space Grotesk/Inter/JetBrains Mono),
//      внешних сетевых запросов страница не делает (наблюдение ресурсов);
//   4) токены стиля в живом DOM: фон/шрифты/скругления/свечение активной
//      вкладки (гайд 06 §2–§5);
//   5) скриншоты экранов: newtab, хром (таб-бар+навбар), подсказки omnibox,
//      контекстное меню вкладки, главное меню, меню прокси, страница истории.
//
// Изоляция: APPDATA и WEBVIEW2_USER_DATA_FOLDER — во временном каталоге.
// Запуск:  node e2e/style/run.mjs [путь-к-duopulse.exe]
// Требует собранный debug-exe (cargo build) и запускает vite dev сам.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const CDP_PORT = 9227;
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

// --- 1. локальный http-стенд (цель перехода из omnibox-подсказки newtab) ------
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<html><head><title>Стенд ${req.url}</title></head><body><h1>${req.url}</h1></body></html>`);
});
await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));

// --- 2. изолированный профиль -------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-style-e2e-"));

// --- 3. vite dev + приложение (БЕЗ DUOPULSE_START_URL: старт = новая вкладка) --
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
  WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
  DUOPULSE_ADBLOCK_LISTS: "", // без списков: стенду не нужна сеть (задача 2.1)
};
const app = spawn(EXE, [], { stdio: "ignore", env: appEnv });

// Сторож: зависший await (например, скриншот скрытой страницы — композитор
// не даёт кадра) не должен подвешивать прогон бесконечно.
setTimeout(async () => {
  console.error("WATCHDOG: прогон не завершился за 4 минуты — принудительная остановка");
  await killOurExes().catch(() => {});
  try {
    await run("taskkill", ["/PID", String(vite.pid), "/T", "/F"]);
  } catch {}
  process.exit(2);
}, 240_000);

// --- 4. ждём CDP-цели ---------------------------------------------------------
const listTargets = async () => {
  try {
    return await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
  } catch {
    return [];
  }
};
/** UI-хром — цель с <title> «DuoPulse M0»; внутренние страницы отличает их title. */
const findByTitle = async (re) =>
  (await listTargets()).find((t) => t.type === "page" && /localhost:5173/.test(t.url) && re.test(t.title ?? ""));
const waitFor = async (fn, timeout = 20000) => {
  for (const deadline = Date.now() + timeout; ; ) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(250);
  }
};

function connect(wsUrl, onEvent) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    } else if (!m.id && onEvent) {
      onEvent(m);
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

const shot = async (ws, file) => {
  await evalIn(ws, `document.fonts.ready.then(() => true)`);
  const s = await ws.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(import.meta.dirname, file), Buffer.from(s.data, "base64"));
};

let failures = 0;
const console_ = [];
const sockets = [];
try {
  const uiTarget = await waitFor(() => findByTitle(/^DuoPulse/));
  check("UI-хром поднялся (цель CDP по <title>)", !!uiTarget, uiTarget?.title ?? "не дождались");
  const ui = connect(uiTarget.webSocketDebuggerUrl, (m) => {
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      console_.push("[ui] " + m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    }
    if (m.method === "Runtime.exceptionThrown") {
      console_.push("[ui] EXC: " + JSON.stringify(m.params.exceptionDetails.exception ?? {}).slice(0, 200));
    }
  });
  sockets.push(ui);
  await ui.send("Runtime.enable").catch(() => {});

  await waitFor(() => evalIn(ui, `typeof window.__duopulse === "object" ? 1 : 0`), 15000);
  await waitFor(() => evalIn(ui, `document.querySelectorAll('.tab').length`), 15000);

  // снапшот CDP-целей до tabs.open: стартовая «Новая вкладка» уже открыта
  // (скрыта не будет открытая позже — активная — вкладка)
  const targetsBefore = new Set(
    (await listTargets()).filter((t) => t.type === "page" && /localhost:5173/.test(t.url)).map((t) => t.id),
  );

  // --- (1) стартовая вкладка и tabs.open({}) — фирменная «Новая вкладка» -----
  const startUrl = (await evalIn(ui, `window.__duopulse.tabs.list()`))?.tabs?.find((t) => t.active)?.url ?? "";
  check(
    "стартовая вкладка — duopulse://newtab (default_tab_url, гайд 06 §7)",
    startUrl.startsWith("duopulse://newtab"),
    startUrl,
  );
  const openRes = await evalIn(ui, `window.__duopulse.tabs.open({})`);
  const openedUrl = openRes?.tabs?.find((t) => t.active)?.url ?? "";
  check("tabs.open({}) без url — тоже «Новая вкладка»", openedUrl.startsWith("duopulse://newtab"), openedUrl);

  // --- (2) сид истории: 6 хостов (youtube ×3 страницы — топ), затем свежая
  //        вкладка «Новая вкладка» соберёт плитки из живой БД
  const seed = [
    ["https://www.youtube.com/watch?v=one", "Видео 1 — YouTube"],
    ["https://www.youtube.com/watch?v=two", "Видео 2 — YouTube"],
    ["https://www.youtube.com/feed/subscriptions", "Подписки — YouTube"],
    ["https://github.com/tauri-apps/tauri", "tauri-apps/tauri"],
    ["https://github.com/rust-lang/rust", "rust-lang/rust"],
    ["https://habr.com/ru/all/", "Хабр"],
    ["https://stackoverflow.com/questions", "Stack Overflow"],
    ["https://ru.wikipedia.org/wiki/Rust", "Rust — Википедия"],
    ["https://news.ycombinator.com/", "Hacker News"],
    ["https://www.reddit.com/r/rust/", "r/rust"],
  ];
  await evalIn(
    ui,
    `(async () => {
       for (const [url, title] of ${JSON.stringify(seed)}) {
         await window.__duopulse.history.visit({ url, title });
       }
       return "ok";
     })()`,
  );

  // новая вкладка уже активна (open выше) — её цель = НОВАЯ цель UI-бандла
  // (стартовая «Новая вкладка» тоже живёт в списке целей, но скрыта — скриншот
  // скрытой страницы подвешивает композитор, поэтому снимаем только активную)
  const ntpTarget = await waitFor(async () => {
    const list = await listTargets();
    return (
      list.find(
        (t) =>
          t.type === "page" &&
          /localhost:5173/.test(t.url) &&
          !targetsBefore.has(t.id) &&
          /^Новая вкладка$/.test(t.title ?? ""),
      ) ?? null
    );
  }, 20000);
  check("страница «Новая вкладка» открыта вкладкой (webview UI-бандла)", !!ntpTarget, ntpTarget?.title ?? "не дождались");
  const ntp = connect(ntpTarget.webSocketDebuggerUrl, (m) => {
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      console_.push("[ntp] " + m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    }
    if (m.method === "Runtime.exceptionThrown") {
      console_.push("[ntp] EXC: " + JSON.stringify(m.params.exceptionDetails.exception ?? {}).slice(0, 200));
    }
  });
  sockets.push(ntp);
  await ntp.send("Runtime.enable").catch(() => {});

  const tiles = await waitFor(async () => {
    const t = await evalIn(ntp, `[...document.querySelectorAll('.ntp-tile')].map((x) => x.dataset.url)`);
    return t?.length === 8 ? t : null;
  }, 15000);
  check("«Новая вкладка»: ровно 8 плиток топ-сайтов", !!tiles, tiles?.join(", ") ?? "не дождались");
  check(
    "плитки — из локальной истории, сгруппированы по хосту (youtube топ)",
    !!tiles && tiles[0].includes("youtube.com") && tiles.filter((u) => u.includes("github.com")).length === 1,
    tiles?.slice(0, 4).join(", "),
  );

  // --- (3) шрифты локальные, внешних запросов страница не делает --------------
  // fonts.check по кириллице требует загруженного сабсета — форсируем load
  const fonts = await evalIn(
    ntp,
    `Promise.all([
       document.fonts.load("500 13px Inter", "Ы"),
       document.fonts.load("700 56px 'Space Grotesk'", "Pulse"),
       document.fonts.load("400 13px 'JetBrains Mono'", "0"),
     ]).then(() => ({
       logo: document.fonts.check("700 56px 'Space Grotesk'"),
       ui: document.fonts.check("400 13px Inter"),
       uiCyr: document.fonts.check("500 13px Inter", "Ы"),
       mono: document.fonts.check("400 13px 'JetBrains Mono'"),
     }))`,
  );
  check(
    "фирменные шрифты загружены (Space Grotesk/Inter+кириллица/JetBrains Mono)",
    fonts?.logo === true && fonts?.ui === true && fonts?.uiCyr === true && fonts?.mono === true,
    JSON.stringify(fonts),
  );
  // внешними считаем адреса вне localhost-семейства (ipc.localhost — внутренний
  // IPC-origin Tauri, по сети не ходит)
  const extReqs = await evalIn(
    ntp,
    `performance.getEntriesByType('resource').filter((r) => !/^https?:\\/\\/([^\\/]*localhost|127\\.0\\.0\\.1)(:|\\/)/.test(r.name)).map((r) => r.name)`,
  );
  check("«Новая вкладка» не делает внешних запросов (гайд 06 §7)", Array.isArray(extReqs) && extReqs.length === 0, JSON.stringify(extReqs));

  // --- (4) токены стиля в живом DOM (гайд 06 §2–§5) ----------------------------
  const styleUi = await evalIn(
    ui,
    `(() => {
       const cs = (el) => getComputedStyle(el);
       const app = document.getElementById('app');
       const tab = document.querySelector('.tab.active');
       const omnibox = document.getElementById('omnibox');
       const menu = document.getElementById('mainMenu');
       return {
         bg: cs(app).backgroundColor,
         tabGlow: cs(tab).boxShadow !== 'none', // --glow-neon (color-mix → color(srgb …) в computed)
         omniboxFont: cs(omnibox).fontFamily.includes('JetBrains Mono'),
         omniboxRadius: cs(omnibox).borderRadius,
         menuRadius: cs(menu).borderRadius,
         bodyFont: cs(document.body).fontFamily.includes('Inter'),
       };
     })()`,
  );
  check(
    "хром: фон --bg-base rgb(10,14,23), шрифт Inter, omnibox моно 8px, панель 12px, активная вкладка светится неоном",
    styleUi?.bg === "rgb(10, 14, 23)" &&
      styleUi?.tabGlow === true &&
      styleUi?.omniboxFont === true &&
      styleUi?.omniboxRadius === "8px" &&
      styleUi?.menuRadius === "12px" &&
      styleUi?.bodyFont === true,
    JSON.stringify(styleUi),
  );
  const styleNtp = await evalIn(
    ntp,
    `(() => {
       const cs = (el) => getComputedStyle(el);
       return {
         bg: cs(document.querySelector('.ntp')).backgroundColor,
         logoFont: cs(document.querySelector('.ntp-logo')).fontFamily.includes('Space Grotesk'),
         logoAnim: cs(document.querySelector('.ntp-logo')).animationName === 'ntp-pulse',
         tileBg: cs(document.querySelector('.ntp-tile')).backgroundColor,
         tileRadius: cs(document.querySelector('.ntp-tile')).borderRadius,
       };
     })()`,
  );
  check(
    "«Новая вкладка»: фон --bg-base, логотип Space Grotesk с ambient-пульсом 3с, плитки --bg-surface 12px",
    styleNtp?.bg === "rgb(10, 14, 23)" &&
      styleNtp?.logoFont === true &&
      styleNtp?.logoAnim === true &&
      styleNtp?.tileBg === "rgb(17, 29, 43)" &&
      styleNtp?.tileRadius === "12px",
    JSON.stringify(styleNtp),
  );
  await shot(ntp, "newtab.png");

  // --- (5) omnibox-подсказка newtab: Enter навигает вкладку -------------------
  const goUrl = `http://127.0.0.1:${HTTP_PORT}/ntp-go`;
  await evalIn(
    ntp,
    `(() => {
       const i = document.querySelector('.ntp-search input');
       i.focus(); i.value = ${JSON.stringify(goUrl)};
       i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
       return true;
     })()`,
  );
  const ntpGo = await waitFor(async () => {
    const res = await evalIn(ui, `window.__duopulse.tabs.list()`);
    return res?.tabs?.find((t) => t.active)?.url === goUrl ? goUrl : null;
  }, 10000);
  check("omnibox-подсказка «Новой вкладки»: Enter — переход по разобранному адресу", ntpGo === goUrl, ntpGo ?? "не дождались");

  // --- (6) главное меню: пункты открывают заявленное ---------------------------
  await evalIn(ui, `document.getElementById('mainBtn').click()`);
  const menuOpen = await evalIn(ui, `!document.getElementById('mainMenu').hidden`);
  await shot(ui, "main-menu.png");
  await evalIn(ui, `document.querySelector('#mainMenu button[data-act="history"]').click()`);
  const histOpened = await waitFor(async () => {
    const res = await evalIn(ui, `window.__duopulse.tabs.list()`);
    return res?.tabs?.find((t) => t.active)?.url?.startsWith("duopulse://history") ?? false;
  }, 15000);
  check("главное меню: «История и закладки» открывает duopulse://history", menuOpen && histOpened === true);
  const histTarget = await waitFor(() => findByTitle(/^История и закладки/));
  if (histTarget) {
    const hist = connect(histTarget.webSocketDebuggerUrl, (m) => {
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
        console_.push("[history] " + m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
      }
    });
    sockets.push(hist);
    await waitFor(() => evalIn(hist, `document.querySelectorAll('.mgr-entry').length >= 5`), 15000);
    await shot(hist, "history.png");
    hist.close();
  }

  // --- (7) меню прокси ----------------------------------------------------------
  await evalIn(ui, `document.getElementById('proxyBtn').click()`);
  await waitFor(() => evalIn(ui, `!document.getElementById('proxyMenu').hidden`));
  await shot(ui, "proxy-menu.png");

  // --- (8) скриншоты: хром, подсказки omnibox, контекст-меню вкладки -----------
  // (подсказки закрываем явно: программный blur при позднем ответе FTS может
  // не закрыть дропдаун — снимки хрома должны быть без случайных панелей)
  const closePanels = `(() => {
     document.getElementById('proxyMenu').hidden = true;
     document.getElementById('mainMenu').hidden = true;
     document.getElementById('suggest').hidden = true;
     document.getElementById('omnibox').blur();
     return true;
   })()`;
  await evalIn(ui, closePanels);
  await evalIn(
    ui,
    `(() => {
       const i = document.getElementById('omnibox');
       i.focus(); i.value = 'rust';
       i.dispatchEvent(new Event('input'));
       return true;
     })()`,
  );
  await waitFor(() => evalIn(ui, `!document.getElementById('suggest').hidden && document.querySelectorAll('.suggest-item').length > 0`));
  await shot(ui, "omnibox-suggest.png");

  await evalIn(ui, closePanels);
  await evalIn(ui, `document.getElementById('suggest').hidden`);
  // контекст-меню вкладки (карточка duopulse-086) — нативный popup muda
  // поверх webview: DOM-меню больше нет, CDP-снимок не делаем
  await evalIn(ui, closePanels);
  await shot(ui, "chrome.png");

  // стартовая newtab-вкладка (index 0) ещё жива — снимем и её кадр
  await evalIn(ui, `window.__duopulse.tabs.list()`);
  ui.close();
} catch (e) {
  failures++;
  console.error("E2E ERROR:", e.message);
} finally {
  for (const s of sockets) s.close();
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
if (console_.length) console.log(`\nконсоль UI:\n  ${console_.join("\n  ")}`);
console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES: " + failed} (${results.length} проверок)`);
console.log("скриншоты: e2e/style/{newtab,chrome,omnibox-suggest,tab-menu,main-menu,proxy-menu,history}.png");
process.exit(failed === 0 ? 0 : 1);
