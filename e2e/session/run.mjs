// E2E-прогон задачи 1.6 «Восстановление сессии (ленивое)» (карточка
// duopulse-016, DoD: 10 вкладок восстанавливаются, старт не деградирует > 10%).
// На реальном приложении:
//   1) старт с чистым профилем (DUOPULSE_START_URL не задан — сессия активна)
//      → открытие 9 вкладок поверх стартовой «Новой вкладки», активация 3-й:
//      session.json пишется при мутациях (10 вкладок, active=2);
//   2) удаление session.json при живом приложении + грациозное закрытие окна
//      (taskkill без /F → WM_CLOSE → RunEvent::ExitRequested) — файл
//      сохранён снова: путь сохранения при выходе работает;
//   3) рестарт с тем же профилем: таб-бар = 10 вкладок в порядке сессии,
//      заголовки/активная совпадают; в CDP ровно 1 контентная цель —
//      грузится только активная (ленивость, docs/04 §1.3);
//   4) активация ленивой вкладки (tabs.activate) → её webview появляется,
//      URL и заголовок правильные;
//   5) DUOPULSE_START_URL игнорирует сессию (детерминизм e2e-стендов);
//   6) замер старта (gate M1 «старт < 2 с» + «деградация ≤ 10%»): медиана
//      3 прогонов «старт → таб-бар отрисован» для профиля с 1 вкладкой
//      и профиля с 10 восстановленными вкладками.
// Изоляция: APPDATA и WEBVIEW2_USER_DATA_FOLDER — во временных каталогах.
//
// Запуск:  node e2e/session/run.mjs [путь-к-duopulse.exe]
// Требует собранный debug-exe (cargo build) и запускает vite dev сам.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const CDP_PORT = 9226;
const HTTP_PORT = 8899;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, opts, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** Грациозное закрытие: taskkill без /F шлёт WM_CLOSE окнам процесса —
 *  срабатывает ExitRequested и сессия сохраняется. /F добивает остаток. */
async function gracefulClose(app) {
  const pid = app.pid;
  try {
    await run("taskkill", ["/PID", String(pid)]); // WM_CLOSE, ждём завершения
  } catch {
    /* процесс мог выйти до вызова */
  }
  for (let i = 0; i < 40; i++) {
    if (app.exitCode !== null) break;
    await sleep(250);
  }
  if (app.exitCode === null) {
    try {
      await run("taskkill", ["/PID", String(pid), "/T", "/F"]);
    } catch {}
    await sleep(500);
  }
}

/** Браузерный процесс WebView2 профиля может пережить duopulse.exe на минуты
 *  (держит user-data-folder и порт CDP; повторное создание окружения с тем же
 *  user-data-folder, пока старый жив, не поднимает webview/CDP нового запуска).
 *  Даём 5 с на штатное завершение, затем добиваем профильные тест-процессы —
 *  грациозный выход приложения (сохранение сессии) уже произошёл к этому
 *  моменту, стенду больше ничего не теряется. */
async function waitWebViewDown(profile) {
  const marker = path.join(profile, "webview2-data");
  const psCount =
    `(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" ` +
    `| Where-Object { $_.CommandLine -like '*${marker}*' }).Count`;
  const psKill =
    `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" ` +
    `| Where-Object { $_.CommandLine -like '*${marker}*' } ` +
    `| ForEach-Object { taskkill /PID $_.ProcessId /T /F }`;
  const t0 = Date.now();
  for (;;) {
    let count = -1;
    try {
      count = Number((await run("powershell", ["-NoProfile", "-Command", psCount])).trim());
    } catch {
      count = 0; // CIM/PowerShell сбой — считаем, что свободно, и идём дальше
    }
    if (count <= 0) return;
    if (Date.now() - t0 > 5000) {
      try {
        await run("powershell", ["-NoProfile", "-Command", psKill]);
      } catch {}
      await sleep(1000);
      return;
    }
    await sleep(400);
  }
}

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

// сторож стенда: зависшее ожидание (полумёртвое окружение WebView2 и т.п.)
// не должно держать CI бесконечно
setTimeout(() => {
  console.error("СТЕНД: глобальный таймаут 10 мин — принудительное завершение");
  process.exit(2);
}, 10 * 60_000).unref?.();

// --- 1. локальный http-стенд: страницы с <title> -------------------------------
const page = (n) =>
  `<html><head><title>Страница ${n}</title></head><body><h1>/p${n}</h1></body></html>`;
const httpServer = http.createServer((req, res) => {
  const m = req.url.match(/^\/p(\d+)/);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(m ? page(Number(m[1])) : `<html><head><title>Старт</title></head><body><h1>start</h1></body></html>`);
});
await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));
const url = (p) => `http://127.0.0.1:${HTTP_PORT}/${p}`;

// --- 2. общие помощники ---------------------------------------------------------
const mkProfile = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `duopulse-session-${tag}-`));
const launch = (profile, extraEnv = {}) =>
  spawn(EXE, [], {
    stdio: "ignore",
    env: {
      ...process.env,
      APPDATA: profile,
      WEBVIEW2_USER_DATA_FOLDER: path.join(profile, "webview2-data"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
      ...extraEnv,
    },
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
          // таймаут: полумёртвый ws (приложение умерло) не должен подвешивать стенд
          const killer = setTimeout(() => {
            pending.delete(i);
            rej(new Error(`CDP ${method}: таймаут 10 с`));
          }, 10_000);
          pending.set(i, {
            res: (v) => {
              clearTimeout(killer);
              res(v);
            },
            rej: (e) => {
              clearTimeout(killer);
              rej(e);
            },
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

async function cdpTargets() {
  try {
    return await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
  } catch {
    return [];
  }
}

// CDP-цели app-origin (localhost:5173) — это и UI-хром (webview "main"), и
// внутренние страницы duopulse:// (тот же бандл). Хром отличаем по делу:
// он рендерит вкладки (#tabs .tab), внутренняя страница помечает body
// классом internal-page (src/pages/*.ts) — ждём, пока цель самоопределится.
const CHROME_VERDICT = `(function () {
  if (document.body.classList.contains("internal-page")) return "page";
  return document.querySelectorAll("#tabs .tab").length > 0 ? "chrome" : "wait";
})()`;

/** Старт приложения до готовности хрома (таб-бар отрисован — можно
 *  пользоваться браузером; критерий близок к P-01 «можно печатать в адресной
 *  строке», docs/04 §2). Возвращает { ms, uiWs, tabs }. */
async function measureStartup(app, timeoutMs = 60000) {
  const t0 = Date.now();
  let uiWs = null;
  const notChrome = new Set(); // только положительно опознанные внутренние страницы
  while (!uiWs) {
    if (app.exitCode !== null) {
      const ts = await cdpTargets();
      throw new Error(
        `приложение вышло (code=${app.exitCode}) до готовности хрома; цели=[${ts
          .map((t) => t.url)
          .join(" | ")}]`,
      );
    }
    if (Date.now() - t0 > timeoutMs) {
      const ts = await cdpTargets();
      throw new Error(
        `UI-хром CDP не найден: exit=${app.exitCode} signal=${app.signalCode} цели=[${ts
          .map((t) => t.url)
          .join(" | ")}]`,
      );
    }
    const targets = (await cdpTargets()).filter(
      (t) => t.type === "page" && t.url.includes("localhost:5173") && !notChrome.has(t.id),
    );
    for (const t of targets) {
      const ws = connect(t.webSocketDebuggerUrl);
      // цель должна самоопределиться: хром рендерит вкладки, внутренняя
      // страница помечает body классом internal-page (src/pages/*.ts);
      // «ещё не знаю» не приговор — вернёмся к цели следующим раундом
      const verdict = await evalIn(ws, CHROME_VERDICT).catch(() => "wait");
      if (verdict === "chrome") {
        uiWs = ws;
        break;
      }
      if (verdict === "page") notChrome.add(t.id);
      ws.close();
    }
    if (!uiWs) await sleep(25);
  }
  const ms = Date.now() - t0;
  const tabs = await evalIn(uiWs, `window.__duopulse.tabs.list()`);
  return { ms, uiWs, tabs };
}

const sessionFile = (profile) => path.join(profile, "DuoPulse", "profile", "session.json");

// --- 3. сценарий -----------------------------------------------------------------
await killOurExes(); // остатки прошлых прогонов держали бы порт CDP
const vite = spawn("npm", ["run", "dev"], { cwd: ROOT, shell: true, stdio: "ignore" });
let viteUp = false;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch("http://localhost:5173/");
    if (r.ok) {
      viteUp = true;
      break;
    }
  } catch {
    /* поднимается */
  }
  await sleep(500);
}
if (!viteUp) {
  console.error("FAIL  vite dev-сервер не поднялся за 30 с (порт 5173 занят?)");
  try {
    await run("taskkill", ["/PID", String(vite.pid), "/T", "/F"]);
  } catch {}
  process.exit(1);
}

const profile10 = mkProfile("10");
let failures = 0;
try {
  // (1) чистый профиль: стартовая «Новая вкладка» + 9 контентных, активна 3-я
  {
    const app = launch(profile10); // БЕЗ DUOPULSE_START_URL — сессия активна
    const { uiWs } = await measureStartup(app);
    for (let n = 1; n <= 9; n++) {
      await evalIn(uiWs, `window.__duopulse.tabs.open({ url: "${url("p" + n)}" })`);
      await sleep(350);
    }
    await sleep(500); // DocumentTitleChanged по вкладкам
    const tabs = (await evalIn(uiWs, `window.__duopulse.tabs.list()`)).tabs;
    const third = tabs[2];
    await evalIn(uiWs, `window.__duopulse.tabs.activate({ id: "${third.id}" })`);
    await sleep(400);

    const session = JSON.parse(fs.readFileSync(sessionFile(profile10), "utf8"));
    check(
      "мутации пишут session.json: 10 вкладок, active=2, URL/заголовки сохранены",
      session.tabs.length === 10 &&
        session.active === 2 &&
        session.tabs[0].url.startsWith("duopulse://newtab") &&
        session.tabs[3].title === "Страница 3",
      JSON.stringify({ tabs: session.tabs.length, active: session.active, t3: session.tabs[3] }),
    );

    // (2) путь выхода: удаляем сессию при живом приложении, закрываем окно
    //     грациозно (WM_CLOSE) — ExitRequested обязан сохранить файл снова
    fs.rmSync(sessionFile(profile10));
    uiWs.close();
    await gracefulClose(app);
    await waitWebViewDown(profile10);
    const savedOnExit = fs.existsSync(sessionFile(profile10));
    let exitSession = null;
    if (savedOnExit) exitSession = JSON.parse(fs.readFileSync(sessionFile(profile10), "utf8"));
    check(
      "закрытие окна сохраняет сессию (RunEvent::ExitRequested)",
      savedOnExit && exitSession.tabs.length === 10 && exitSession.active === 2,
      savedOnExit ? `tabs=${exitSession.tabs.length} active=${exitSession.active}` : "файла нет",
    );
  }

  // (3) рестарт: 10 вкладок в баре, грузится только активная
  {
    const app = launch(profile10);
    const { ms, uiWs, tabs } = await measureStartup(app);
    const restored = tabs.tabs;
    check(
      "рестарт: 10 вкладок восстановлены в порядке сессии, активна 3-я",
      restored.length === 10 &&
        restored[2].active &&
        restored[2].url.endsWith("/p2") &&
        restored[0].url.startsWith("duopulse://newtab"),
      JSON.stringify(restored.map((t) => t.url)),
    );
    check(
      "заголовки ленивых вкладок взяты из сессии (без загрузки страниц)",
      restored[5].title === "Страница 5",
      JSON.stringify(restored.map((t) => t.title)),
    );
    // активная вкладка материализуется задачей сразу после запуска цикла
    // событий (не в setup — дедлок-гонка add_child): ждём её CDP-цель
    let content = [];
    for (let i = 0; i < 40; i++) {
      content = (await cdpTargets()).filter(
        (t) => t.type === "page" && t.url.includes(`:${HTTP_PORT}`),
      );
      if (content.length === 1 && content[0].url.endsWith("/p2")) break;
      await sleep(500);
    }
    check(
      "ленивость: при старте загружена ТОЛЬКО активная (1 контентная CDP-цель)",
      content.length === 1 && content[0].url.endsWith("/p2"),
      JSON.stringify(content.map((t) => t.url)),
    );

    // (4) активация ленивой вкладки → webview появляется, URL/заголовок верны
    const lazy = restored[7];
    await evalIn(uiWs, `window.__duopulse.tabs.activate({ id: "${lazy.id}" })`);
    let materialized = null;
    for (let i = 0; i < 30; i++) {
      await sleep(300);
      materialized = (await cdpTargets()).filter(
        (t) => t.type === "page" && t.url.endsWith("/p7"),
      );
      if (materialized.length === 1) break;
    }
    const afterTabs = (await evalIn(uiWs, `window.__duopulse.tabs.list()`)).tabs;
    check(
      "активация ленивой вкладки материализует webview по сохранённому URL",
      materialized?.length === 1 && afterTabs[7].active,
      JSON.stringify({ cdp: materialized?.length, active: afterTabs[7]?.active }),
    );
    await sleep(500); // DocumentTitleChanged
    const retitled = (await evalIn(uiWs, `window.__duopulse.tabs.list()`)).tabs;
    check(
      "материализованная вкладка живая: URL обновляется, заголовок от страницы",
      retitled[7].url.endsWith("/p7") && retitled[7].title === "Страница 7",
      JSON.stringify(retitled[7]),
    );
    console.log(`      старт с 10 восстановленными вкладками: ${ms} мс`);
    uiWs.close();
    await gracefulClose(app);
    await waitWebViewDown(profile10);
  }

  // (5) DUOPULSE_START_URL игнорирует сессию (детерминизм e2e-стендов)
  {
    const app = launch(profile10, { DUOPULSE_START_URL: url("solo") });
    const { uiWs, tabs } = await measureStartup(app);
    check(
      "DUOPULSE_START_URL: сессия игнорируется, одна вкладка стартового URL",
      tabs.tabs.length === 1 && tabs.tabs[0].url.endsWith("/solo") && tabs.tabs[0].active,
      JSON.stringify(tabs.tabs.map((t) => t.url)),
    );
    uiWs.close();
    await gracefulClose(app);
    await waitWebViewDown(profile10);
  }

  // (6) замер старта: 1 вкладка vs 10 восстановленных, прогрев + 3 прогона
  const measure = async (profile, tag) => {
    const runs = [];
    for (let i = 0; i < 4; i++) {
      const app = launch(profile);
      const { ms, uiWs, tabs } = await measureStartup(app);
      uiWs.close();
      await gracefulClose(app);
      await waitWebViewDown(profile);
      if (i > 0) runs.push({ ms, tabs: tabs.tabs.length }); // первый — прогрев
      else console.log(`      прогрев ${tag}: ${ms} мс`);
      await sleep(800);
    }
    return runs;
  };

  const profile1 = mkProfile("1");
  {
    // создаём 1-вкладочную сессию (рестарты ниже её восстанавливают)
    const app = launch(profile1);
    const { uiWs } = await measureStartup(app);
    uiWs.close();
    await gracefulClose(app);
    await waitWebViewDown(profile1);
  }
  const runs1 = await measure(profile1, "1 вкладка");
  const runs10 = await measure(profile10, "10 вкладок");
  const m1 = median(runs1.map((r) => r.ms));
  const m10 = median(runs10.map((r) => r.ms));
  const degrade = ((m10 - m1) / m1) * 100;
  check(
    "профили замера: 1 вкладка восстанавливается одной, 10 — десятью",
    runs1.every((r) => r.tabs === 1) && runs10.every((r) => r.tabs === 10),
    JSON.stringify({ r1: runs1.map((r) => r.tabs), r10: runs10.map((r) => r.tabs) }),
  );
  check(
    `деградация старта ≤ 10% (1 вкладка ${m1} мс vs 10 вкладок ${m10} мс)`,
    degrade <= 10,
    `${degrade.toFixed(1)}%`,
  );
  check(
    `gate M1: старт < 2 с в обоих режимах (медианы ${m1}/${m10} мс)`,
    m1 < 2000 && m10 < 2000,
    `прогоны: 1 — ${runs1.map((r) => r.ms).join(", ")}; 10 — ${runs10.map((r) => r.ms).join(", ")}`,
  );

  fs.rmSync(profile1, { recursive: true, force: true });
} catch (e) {
  failures++;
  console.error("E2E ERROR:", e.message);
} finally {
  await killOurExes();
  try {
    await run("taskkill", ["/PID", String(vite.pid), "/T", "/F"]);
  } catch {
    /* дерево уже мертво — ок */
  }
  httpServer.close();
  await sleep(1000);
  try {
    fs.rmSync(profile10, { recursive: true, force: true });
  } catch {}
}

const failed = results.filter((r) => !r.ok).length + failures;
console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES: " + failed} (${results.length} проверок)`);
process.exit(failed === 0 ? 0 : 1);
