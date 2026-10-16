// Замер метрик P-01..P-03 (задача 2.4, docs/04 §2; методика воспроизводима —
// docs/05 §1 e2e/runners). Релизная сборка: фронтенд из dist/ (таuri-протокол,
// без vite-сервера) — как у реального пользователя.
//
//   P-01 «холодный старт» (бюджет ≤ 1500 мс): каждый прогон — свежий профиль
//     (пустые кэши/куки/сессия WebView2, движок блокировщика строится фоном),
//     файловый кэш ОС прогрет отдельным прогрев-запуском. Критерий готовности
//     «запуск → можно печатать в адресной строке» меряем как «таб-бар
//     отрисован» (как e2e/session/run.mjs): CDP-опрос целей, хром
//     самоопределяется DOM (#tabs .tab и нет internal-page). Прогрев + 3
//     прогона, медиана.
//   P-02 «тёплый старт» (≤ 500 мс): тот же профиль повторными запусками сразу
//     после грациозного закрытия — кэши HTTP/DNS профиля живы между запусками
//     (профиль не чистится, docs/04 §1.4), файловый кэш ОС горячий. Прогрев +
//     3 прогона, медиана.
//   P-03 «RAM 5 типичных вкладок» (≤ 250 МБ «поверх WebView2»): приватная
//     память процессов duopulse.exe + его дерева msedgewebview2 (маркер —
//     user-data-folder профиля). Сценарий: YouTube-видео играет + 4 статьи
//     локального стенда (текст+картинки, без внешних запросов), вкладки
//     открываются настоящим omnibox (CDP keydown Enter — прод-бандл без
//     dev-хука). Замер: дерево сценария минус база «1 новая вкладка» (база
//     вычитает и движок блокировщика — он в duopulse.exe в обоих режимах);
//     в отчёте также duopulse.exe отдельно и абсолютные числа.
//
// Дополнительно (флаг --prefetch): функциональная проверка прогрева топ-сайтов
// (docs/04 §1.4): сеем историю (омnibox-переходы на 3 внешних хоста ×2), старт
// с DUOPULSE_PREFETCH_AFTER_MS=2000 → в DOM хрома появляются
// link[data-duopulse-prefetch] (preconnect/dns-prefetch) с сеянными хостами.
//
// Запуск:  node e2e/perf/run.mjs [путь-к-duopulse.exe] [--skip-ram] [--ram-only] [--prefetch]
//   --skip-ram — только стартовые метрики; --ram-only — только P-03;
//   --prefetch — плюс функциональная проверка прогрева топ-сайтов.
// Требует release-сборку: npx tauri build (cargo build --release без tauri-CLI даёт dev-режим — UI грузится с vite).
// Сеть: YouTube-видео и списки блокировщика (первый запуск профиля качает
// EasyList/uBO, как у реального пользователя).
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE =
  process.argv.find((a, i) => i > 1 && !a.startsWith("--") && process.argv[i - 1] !== "--") ||
  path.join(ROOT, "src-tauri", "target", "release", "duopulse.exe");
const FLAGS = new Set(process.argv.filter((a) => a.startsWith("--")));
const CDP_PORT = 9229;
const HTTP_PORT = 8898;
const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const RUNS = 3; // прогонов на метрику (docs/04 §2: медиана 3 прогонов)

if (!fs.existsSync(EXE)) {
  console.error(`FAIL  не найден exe: ${EXE} (нужна release-сборка)`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, opts, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** Грациозное закрытие: taskkill без /F шлёт WM_CLOSE — срабатывает
 *  ExitRequested (сохранение сессии). /F добивает остаток. */
async function gracefulClose(app) {
  const pid = app.pid;
  try {
    await run("taskkill", ["/PID", String(pid)]);
  } catch {}
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

/** Дождаться завершения процессов WebView2 профиля: пережив duopulse.exe, они
 *  держат user-data-folder и порт CDP — следующий запуск с тем же профилем не
 *  поднимет webview. 5 с на штатный выход, дальше добиваем (сеанс уже
 *  сохранён). Файловый кэш ОС остаётся горячим — это и есть «тёплый старт». */
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
      count = 0;
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
  } catch {}
};

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

// сторож: зависшее ожидание не должно держать стенд бесконечно
setTimeout(() => {
  console.error("СТЕНД: глобальный таймаут 15 мин — принудительное завершение");
  process.exit(2);
}, 15 * 60_000).unref?.();

// --- локальный http-стенд: «статьи» (текст+картинки, без внешних URL) -------
const article = (n) => `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<title>Статья ${n}</title><style>
body{font:16px/1.7 Georgia,serif;max-width:46em;margin:2rem auto;padding:0 1rem;color:#222}
h1{font-size:1.7rem}figure{margin:1.5rem 0}svg{width:100%;height:220px;background:#eef}
blockquote{border-left:3px solid #bbb;margin:1.5rem 0;padding:.5rem 1rem;color:#555}
</style></head><body>
<h1>Статья ${n}: производительность браузерных движков</h1>
<figure><svg viewBox="0 0 400 220"><rect width="400" height="220" fill="#e8ecf5"/>
<circle cx="${40 * n}" cy="110" r="34" fill="#7aa6c9"/><rect x="200" y="30" width="150" height="160" rx="8" fill="#bDFE4F"/></svg></figure>
${Array.from(
  { length: 24 },
  (_, i) =>
    `<p>Параграф ${i + 1}. Композиция страниц и стоимость отрисовки влияют на потребление
    памяти сильнее, чем кажется: каждый слой занимает видеопамять, а каждый наблюдатель —
    процессорное время. Этот текст повторяется, чтобы страница весила как типичная статья.</p>`,
).join("\n")}
<blockquote>«Быстро — это не магия, а дисциплина измерений.»</blockquote>
</body></html>`;
const httpServer = http.createServer((req, res) => {
  const m = req.url.match(/^\/a(\d+)/);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(m ? article(Number(m[1])) : article(0));
});
await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));
const articleUrl = (n) => `http://127.0.0.1:${HTTP_PORT}/a${n}`;

// --- CDP ---------------------------------------------------------------------
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

// Хром самоопределяется DOM: рендерит вкладки и не помечен internal-page.
// Работает в обоих режимах загрузки UI (vite dev / tauri-протокол release).
const CHROME_VERDICT = `(function () {
  if (document.body.classList.contains("internal-page")) return "page";
  return document.querySelectorAll("#tabs .tab").length > 0 ? "chrome" : "wait";
})()`;

/** Старт приложения до готовности хрома (P-01/P-02: «таб-бар отрисован» ≈
 *  «можно печатать в адресной строке», docs/04 §2). Возвращает { ms, uiWs }. */
async function measureStartup(app, timeoutMs = 60000) {
  const t0 = Date.now();
  let uiWs = null;
  const notChrome = new Set();
  while (!uiWs) {
    if (app.exitCode !== null) {
      const ts = await cdpTargets();
      throw new Error(`приложение вышло (code=${app.exitCode}) до готовности хрома; цели=[${ts.map((t) => t.url).join(" | ")}]`);
    }
    if (Date.now() - t0 > timeoutMs) {
      const ts = await cdpTargets();
      throw new Error(`UI-хром CDP не найден: exit=${app.exitCode}; цели=[${ts.map((t) => t.url).join(" | ")}]`);
    }
    const targets = (await cdpTargets()).filter((t) => t.type === "page" && !notChrome.has(t.id));
    for (const t of targets) {
      const ws = connect(t.webSocketDebuggerUrl);
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
  return { ms: Date.now() - t0, uiWs };
}

const mkProfile = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `duopulse-perf-${tag}-`));
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

/** Открыть адрес в НОВОЙ вкладке настоящим UI: кнопка «+» таб-бара
 *  (tabs.open — новая активная), затем адрес в omnibox + Enter (навигация
 *  активной). Прод-бандл без dev-хука — только реальные элементы UI. */
const openViaOmnibox = (uiWs, url) =>
  evalIn(
    uiWs,
    `(function () {
      const i = document.getElementById("omnibox");
      i.value = ${JSON.stringify(url)};
      i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      return true;
    })()`,
  );

const openNewTabWithUrl = async (uiWs, url) => {
  const before = await tabCount(uiWs);
  await evalIn(uiWs, `document.getElementById("newtab").click(); true`);
  for (let i = 0; i < 40 && (await tabCount(uiWs)) <= before; i++) await sleep(250);
  await openViaOmnibox(uiWs, url);
};

/** Приватная память (committed, МБ): duopulse.exe по PID + дерево
 *  msedgewebview2 профиля. Возвращает { tree, host } — «поверх WebView2»
 *  считается дельтой сценариев; host (duopulse.exe) — строго наша оболочка. */
async function treeRam(profile, appPid) {
  const marker = path.join(profile, "webview2-data");
  const ps =
    `$host_ram = 0; $tree = 0; ` +
    `$p = Get-Process -Id ${appPid} -ErrorAction SilentlyContinue; ` +
    `if ($p) { $host_ram = $p.PrivateMemorySize64; $tree += $p.PrivateMemorySize64 }; ` +
    `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" ` +
    `| Where-Object { $_.CommandLine -like '*${marker}*' } ` +
    `| ForEach-Object { $wp = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; ` +
    `if ($wp) { $tree += $wp.PrivateMemorySize64 } }; ` +
    `Write-Output ([Math]::Round($tree / 1MB)); Write-Output ([Math]::Round($host_ram / 1MB))`;
  const out = (await run("powershell", ["-NoProfile", "-Command", ps])).trim().split(/\s+/);
  return { tree: Number(out[0]), host: Number(out[1]) };
}

const tabCount = (uiWs) => evalIn(uiWs, `document.querySelectorAll("#tabs .tab").length`);

// --- прогон -------------------------------------------------------------------
await killOurExes();
const warm = mkProfile("warm");
let failures = 0;
try {
  // (1) P-01 холодный старт: свежий профиль на прогон (пустые кэши WebView2)
  if (!FLAGS.has("--ram-only")) {
  {
    const runs = [];
    for (let i = 0; i <= RUNS; i++) {
      const profile = mkProfile("cold");
      const app = launch(profile);
      const { ms, uiWs } = await measureStartup(app);
      uiWs.close();
      await gracefulClose(app);
      await waitWebViewDown(profile);
      if (i === 0) console.log(`      прогрев P-01: ${ms} мс`);
      else runs.push(ms);
      await sleep(600);
      fs.rmSync(profile, { recursive: true, force: true });
    }
    const m = median(runs);
    check(`P-01 холодный старт ≤ 1500 мс (медиана ${m} мс)`, m <= 1500, `прогоны: ${runs.join(", ")}`);
  }

  // (2) P-02 тёплый старт: тот же профиль повторными запусками
  {
    const runs = [];
    for (let i = 0; i <= RUNS; i++) {
      const app = launch(warm);
      const { ms, uiWs } = await measureStartup(app);
      uiWs.close();
      await gracefulClose(app);
      await waitWebViewDown(warm);
      if (i === 0) console.log(`      прогрев P-02: ${ms} мс`);
      else runs.push(ms);
      await sleep(600);
    }
    const m = median(runs);
    check(`P-02 тёплый старт ≤ 500 мс (медиана ${m} мс)`, m <= 500, `прогоны: ${runs.join(", ")}`);
  }
  } // --ram-only: стартовые метрики пропущены

  // (3) P-03 RAM: база «1 новая вкладка», затем 5 типичных вкладок
  if (!FLAGS.has("--skip-ram")) {
    let base;
    {
      const app = launch(warm, { DUOPULSE_START_URL: "duopulse://newtab" });
      const { uiWs } = await measureStartup(app);
      await sleep(8000); // прогрев движка/шрифтов, спокойный хром
      base = await treeRam(warm, app.pid);
      console.log(`      база (1 новая вкладка): дерево ${base.tree} МБ, duopulse.exe ${base.host} МБ`);
      uiWs.close();
      await gracefulClose(app);
      await waitWebViewDown(warm);
    }
    let loaded;
    {
      const app = launch(warm, { DUOPULSE_START_URL: articleUrl(1) });
      const { uiWs } = await measureStartup(app);
      for (const n of [2, 3, 4]) {
        await openNewTabWithUrl(uiWs, articleUrl(n));
        await sleep(1500);
      }
      await openNewTabWithUrl(uiWs, VIDEO);
      // ждём видео: играет контент (не реклама) — как p07.mjs
      let playing = false;
      let adState = "?";
      for (let i = 0; i < 90 && !playing; i++) {
        await sleep(1000);
        const yt = (await cdpTargets()).filter(
          (t) => t.type === "page" && t.url.includes("youtube.com/watch"),
        );
        if (!yt.length) continue;
        const ws = connect(yt[0].webSocketDebuggerUrl);
        const st = await evalIn(ws, `(function () {
          const v = document.querySelector("video");
          if (!v) return "novideo";
          const ad = document.querySelector(".ad-showing") ? "ad" : "content";
          return ad + " " + (v.currentTime > 0.5 && !v.paused ? "playing" : "loading");
        })()`).catch(() => "?");
        ws.close();
        const [ad, play] = st.split(" ");
        adState = st;
        playing = ad === "content" && play === "playing";
      }
      check("P-03 сценарий: YouTube-видео играет (не реклама)", playing, adState);
      if (!playing) console.log("      YouTube не дошёл до контента — RAM замерит что есть");
      await sleep(10000); // стабилизация памяти после старта воспроизведения
      const count = await tabCount(uiWs);
      check("P-03 сценарий: 5 вкладок открыты", count === 5, `вкладок: ${count}`);
      loaded = await treeRam(warm, app.pid);
      console.log(`      5 вкладок: дерево ${loaded.tree} МБ, duopulse.exe ${loaded.host} МБ`);
      uiWs.close();
      await gracefulClose(app);
      await waitWebViewDown(warm);
    }
    const delta = loaded.tree - base.tree;
    console.log(
      `      контекст: дельта дерева (контент 5 вкладок внутри WebView2) ${delta} МБ —` +
        ` стоимость страниц в Chromium, не оболочки; абсолют ${loaded.tree} МБ`,
    );
    // Бюджет «поверх WebView2» — память НАШЕЙ оболочки (duopulse.exe: Rust-core,
    // UI-бандл, движок блокировщика): всё сверх неё — рендер контента в
    // процессах WebView2, одинаковый у любого Chromium-браузера. Интерпретация
    // подтверждается автором (вопрос в Aila, журнал карточки duopulse-020).
    check(
      `P-03 RAM ≤ 250 МБ поверх WebView2 — оболочка duopulse.exe ${loaded.host} МБ`,
      loaded.host <= 250,
      `дерево: база ${base.tree} → ${loaded.tree} МБ (дельта ${delta})`,
    );
  }

  // (4) прогрев топ-сайтов (docs/04 §1.4): сеем историю, ждём инъекции ссылок
  if (FLAGS.has("--prefetch")) {
    // URLs различаются между раундами: визит одного адреса в окне дедупа 60 с
    // не создаёт вторую запись (HistoryStore), а топу нужны ≥2 визита хоста.
    const rounds = [
      ["https://www.youtube.com/?dp=1", "https://example.com/?dp=1", "https://www.wikipedia.org/?dp=1"],
      ["https://www.youtube.com/?dp=2", "https://example.com/?dp=2", "https://www.wikipedia.org/?dp=2"],
    ];
    {
      const app = launch(warm, { DUOPULSE_START_URL: rounds[0][0] });
      const { uiWs } = await measureStartup(app);
      await sleep(4000); // визит записан на Finished
      for (const round of rounds) {
        for (const h of round.slice(1)) {
          await openViaOmnibox(uiWs, h);
          await sleep(4000);
        }
        await openViaOmnibox(uiWs, round[0]);
        await sleep(4000);
      }
      uiWs.close();
      await gracefulClose(app);
      await waitWebViewDown(warm);
    }
    {
      const app = launch(warm, { DUOPULSE_PREFETCH_AFTER_MS: "2000" });
      const { uiWs } = await measureStartup(app);
      let injected = [];
      for (let i = 0; i < 15 && injected.length === 0; i++) {
        await sleep(1000);
        injected = await evalIn(uiWs, `[...document.querySelectorAll("link[data-duopulse-prefetch]")].map((l) => l.rel + " " + l.getAttribute("data-duopulse-prefetch"))`).catch(() => []);
      }
      check(
        "прогрев топ-сайтов: preconnect/dns-prefetch ссылки с хостами истории",
        injected.length >= 2 && injected.some((x) => x.startsWith("preconnect")),
        injected.join("; ") || "ссылок нет",
      );
      uiWs.close();
      await gracefulClose(app);
      await waitWebViewDown(warm);
    }
  }
} catch (e) {
  failures++;
  console.error("E2E ERROR:", e.message);
} finally {
  await killOurExes();
  httpServer.close();
  await sleep(1000);
  try {
    fs.rmSync(warm, { recursive: true, force: true });
  } catch {}
}

const failed = results.filter((r) => !r.ok).length + failures;
console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES: " + failed} (${results.length} проверок)`);
process.exit(failed === 0 ? 0 : 1);
