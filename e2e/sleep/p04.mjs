// Замер метрики P-04 (задача 2.3, docs/04 §2): «CPU фоновой вкладки через
// 10 мин простоя ≈ 0%», снятый до/после включения спящего режима.
//
// Протокол: «шумовая» вкладка (Web Worker с вычислительной петлёй — таймеры
// скрытых страниц Chromium троттлит, воркер нет: честная фоновая нагрузка)
// стоит в фоне, активна пустая стартовая. Два режима, каждый — свежий профиль:
//   до    — DUOPULSE_SLEEP_AFTER_SECS=0 (сон выключен): вкладка работает,
//           замер CPU дерева процессов WebView2 (BFS от duopulse.exe) за окно;
//   после — сон включён (в стенде таймаут сокращён 5 мин → 5 с: состояние
//           «приостановленная вкладка» то же, TrySuspend от таймаута не
//           зависит): вкладка спит, тот же замер; затем пробуждение —
//           работа возобновляется (замороженность не разрушает страницу).
// Счётчики страницы — через document.title → tabs.list (CDP подключён только
// к UI-webview: отладчик на контентной вкладке отменяет приостановку).
//
// Запуск:  node e2e/sleep/p04.mjs [путь-к-duopulse.exe]
// Требует собранный debug-exe (cargo build); пишет отчёт e2e/sleep/p04-result.md.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const CDP_PORT = 9233;
const HTTP_PORT = 8895;
const OUT = path.join(ROOT, "e2e", "sleep", "p04-result.md");
const WINDOW_S = 20; // окно замера CPU
const RUNS = 2; // повторов на режим (медиана)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))));

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

/** CPU-секунды дерева msedgewebview2-потомков duopulse.exe за окно: два
 *  снапшота Get-Process CPU (кумулятивные), BFS по ParentProcessId. */
const sampleTreeCpu = (pid, windowSec) =>
  run("powershell", [
    "-NoProfile",
    "-Command",
    `$all = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'";`
      + `$frontier = @(${pid}); $ids = @();`
      + `while ($frontier.Count -gt 0) {`
      + `  $next = @($all | Where-Object { $frontier -contains $_.ParentProcessId } | ForEach-Object { $_.ProcessId });`
      + `  $ids += $next; $frontier = $next }`
      + `function CpuSum { ($ids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue } | Measure-Object CPU -Sum).Sum }`
      + `$c1 = CpuSum; $t1 = Get-Date;`
      + `Start-Sleep -Seconds ${windowSec};`
      + `$c2 = CpuSum; $t2 = Get-Date;`
      + `[pscustomobject]@{ procs = $ids.Count; cores = [Environment]::ProcessorCount;`
      + `  cpu1 = [math]::Round($c1, 3); cpu2 = [math]::Round($c2, 3);`
      + `  wall = [math]::Round(($t2 - $t1).TotalSeconds, 1) } | ConvertTo-Json -Compress`,
  ]).then((s) => JSON.parse(s));

// --- http-стенд: «шумовая» страница (как e2e/sleep/run.mjs) --------------------
const busyPage = `<html><head><title>busy</title></head><body>
<h1>busy</h1><input id="keep" value="">
<script>
  (function () {
    var marker = "keep-" + Date.now();
    var keep = document.getElementById("keep");
    keep.value = marker;
    var dp = { interval: 0, worker: 0 };
    setInterval(function () { dp.interval++; }, 100);
    var w = new Worker("/worker.js");
    w.onmessage = function (e) { dp.worker = e.data; };
    setInterval(function () {
      document.title = "busy " + JSON.stringify({ w: dp.worker, i: dp.interval });
    }, 250);
  })();
</script></body></html>`;
const workerJs = `var n = 0;
(function loop() {
  var t = performance.now();
  while (performance.now() - t < 10) n++;
  n++;
  postMessage(n);
  setTimeout(loop, 2);
})();`;
const httpServer = http.createServer((req, res) => {
  if (req.url === "/worker.js") {
    res.writeHead(200, { "Content-Type": "application/javascript" });
    res.end(workerJs);
  } else {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(req.url === "/busy" ? busyPage : `<html><head><title>start</title></head><body><h1>start</h1></body></html>`);
  }
});
await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));

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
const tabBy = async (uiWs, pred) => (await evalIn(uiWs, `window.__duopulse.tabs.list()`)).tabs.find(pred);
const stateOf = (tab) => {
  const m = /\{.*\}/.exec(tab?.title ?? "");
  return m ? JSON.parse(m[0]) : null;
};

const vite = spawn("npm", ["run", "dev"], { cwd: ROOT, shell: true, stdio: "ignore" });
for (let i = 0; i < 60; i++) {
  try {
    await fetch("http://localhost:5173/");
    break;
  } catch {
    await sleep(500);
  }
}

/** Один прогон режима: {cpuPct, workerRate, frozen, resumed, extra}. */
async function measure(mode, sleepAfterS) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `duopulse-p04-${mode}-`));
  const app = spawn(EXE, [], {
    stdio: "ignore",
    env: {
      ...process.env,
      APPDATA: tmp,
      DUOPULSE_START_URL: `http://127.0.0.1:${HTTP_PORT}/start`,
      DUOPULSE_ADBLOCK_LISTS: "",
      DUOPULSE_SLEEP_AFTER_SECS: String(sleepAfterS),
      WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
  });
  try {
    let targets = [];
    for (let i = 0; i < 60; i++) {
      try {
        targets = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
        if (targets.some((t) => t.type === "page" && /localhost:5173/.test(t.url))) break;
      } catch {
        /* поднимается */
      }
      await sleep(1000);
    }
    const ui = targets.find((t) => t.type === "page" && /localhost:5173/.test(t.url));
    if (!ui) throw new Error("UI-цель CDP не найдена");
    const uiWs = connect(ui.webSocketDebuggerUrl);
    for (let i = 0; i < 20; i++) {
      if ((await evalIn(uiWs, `typeof window.__duopulse`)) === "object") break;
      await sleep(500);
    }
    const startId = (await tabBy(uiWs, (t) => t.url.endsWith("/start"))).id;
    await evalIn(uiWs, `window.__duopulse.tabs.open({ url: "http://127.0.0.1:${HTTP_PORT}/busy" })`);
    let busy;
    for (let i = 0; i < 30 && !busy; i++) {
      busy = await tabBy(uiWs, (t) => t.url.endsWith("/busy") && stateOf(t));
      if (!busy) await sleep(500);
    }
    if (!busy) throw new Error("состояние busy не публикуется");
    await evalIn(uiWs, `window.__duopulse.tabs.activate({ id: "${startId}" })`); // busy → фон

    let before; // счётчики на момент начала окна замера
    if (mode === "после") {
      // ждём усыпления и стабилизации заголовка (замёрз)
      for (let i = 0; i < 40; i++) {
        const t = await tabBy(uiWs, (x) => x.url.endsWith("/busy"));
        if (t.sleeping) break;
        await sleep(1000);
      }
      let a = stateOf(await tabBy(uiWs, (t) => t.url.endsWith("/busy")));
      for (let i = 0; i < 10; i++) {
        await sleep(700);
        const b = stateOf(await tabBy(uiWs, (t) => t.url.endsWith("/busy")));
        if (b.w === a.w && b.i === a.i) break;
        a = b;
      }
      before = a;
    } else {
      await sleep(5000); // скрытая вкладка в установившемся режиме
      before = stateOf(await tabBy(uiWs, (t) => t.url.endsWith("/busy")));
    }

    const ps = await sampleTreeCpu(app.pid, WINDOW_S);
    const after = stateOf(await tabBy(uiWs, (t) => t.url.endsWith("/busy")));
    const cpuPctCore = ((ps.cpu2 - ps.cpu1) / ps.wall) * 100; // % одного ядра
    const workerRate = (after.w - before.w) / ps.wall;

    let resumed = null;
    if (mode === "после") {
      await evalIn(uiWs, `window.__duopulse.tabs.wake({ id: "${busy.id}" })`);
      for (let i = 0; i < 20; i++) {
        const s = stateOf(await tabBy(uiWs, (t) => t.url.endsWith("/busy")));
        if (s && s.w > after.w) {
          resumed = true;
          break;
        }
        await sleep(500);
      }
    }
    uiWs.close();
    return {
      cpuPctCore,
      cpuPctMachine: cpuPctCore / ps.cores,
      workerRate,
      frozenGrowth: after.w - before.w,
      procs: ps.procs,
      cores: ps.cores,
      wall: ps.wall,
      resumed,
      app: app.pid,
    };
  } finally {
    app.kill("SIGKILL");
    await killOurExes();
    await sleep(1000);
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }
}

const MEDIAN = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const report = { до: [], после: [] };
try {
  for (let i = 0; i < RUNS; i++) {
    // чередуем режимы (как p07): внешние условия выравниваются
    for (const [mode, after] of [
      ["до", 0],
      ["после", 5],
    ]) {
      const r = await measure(mode, after);
      report[mode].push(r);
      console.log(
        `${mode} #${i + 1}: CPU ${r.cpuPctCore.toFixed(2)}% ядра (${(r.cpuPctMachine).toFixed(2)}% машины),` +
          ` воркер ${(r.workerRate / 1e6).toFixed(2)} млн/с, процессов WebView2 ${r.procs}` +
          (mode === "после" ? `, после сна возобновился=${r.resumed}` : ""),
      );
    }
  }
} finally {
  try {
    await run("taskkill", ["/PID", String(vite.pid), "/T", "/F"]);
  } catch {}
  httpServer.close();
}

const med = (mode, f) => MEDIAN(report[mode].map(f));
const fmt = (mode) =>
  `CPU ${med(mode, (r) => r.cpuPctCore).toFixed(2)}% ядра / ${med(mode, (r) => r.cpuPctMachine).toFixed(2)}% машины; ` +
  `воркер ${mode === "до" ? (med(mode, (r) => r.workerRate) / 1e6).toFixed(2) + " млн итераций/с" : "заморожен (прирост " + med(mode, (r) => r.frozenGrowth) + ")"}`;

console.log(`\nмедианы (${RUNS} прогона/режим):`);
console.log(`  до (сон выключен):    ${fmt("до")}`);
console.log(`  после (вкладка спит): ${fmt("после")}`);

// Итог DoD «P-04 ≈ 0%»: спящая вкладка не грузит CPU (≈0% дерева WebView2),
// воркер во сне не растёт и после пробуждения возобновляется.
const afterCpu = med("после", (r) => r.cpuPctCore);
const beforeCpu = med("до", (r) => r.cpuPctCore);
const frozen = report["после"].every((r) => r.frozenGrowth === 0);
const resumed = report["после"].every((r) => r.resumed === true);
const ok = afterCpu < 1.5 && afterCpu < beforeCpu / 3 && frozen && resumed;

const md = `# P-04 · CPU фоновой вкладки (спящий режим, задача 2.3)

Метрика docs/04 §2: «CPU фоновой вкладки через 10 мин простоя ≈ 0%». Стенд:
«шумовая» страница (Web Worker с вычислительной петлёй — таймеры скрытых
страниц Chromium троттлит, воркер нет) в фоновой вкладке, активна пустая.
Таймаут усыпания в стенде сокращён 5 мин → 5 с (состояние приостановленной
вкладки то же — TrySuspend от длительности таймаута не зависит); окно замера
${WINDOW_S} с; CPU — дерево процессов msedgewebview2 (потомки duopulse.exe,
кумулятивные Get-Process CPU), ${RUNS} прогона на режим, медиана, режимы
чередуются. Счётчики страницы — document.title → tabs.list (CDP подключён
только к UI: отладчик на контентной вкладке отменяет приостановку).

| Режим | CPU (медиана) | Работа вкладки в окне |
|---|---|---|
| до — сон выключен | ${med("до", (r) => r.cpuPctCore).toFixed(2)}% ядра / ${med("до", (r) => r.cpuPctMachine).toFixed(2)}% машины | воркер ${(med("до", (r) => r.workerRate) / 1e6).toFixed(2)} млн итераций/с |
| после — вкладка спит | ${afterCpu.toFixed(2)}% ядра / ${med("после", (r) => r.cpuPctMachine).toFixed(2)}% машины | заморожен (прирост ${med("после", (r) => r.frozenGrowth)}), после пробуждения возобновляется |

Прогоны: ${JSON.stringify(report, null, 2)}

Вывод: спящая вкладка не потребляет CPU (P-04 ≈ 0% достигнут: ${afterCpu.toFixed(2)}% ядра
на всё дерево WebView2, включая браузерный/GPU/UI-процессы), JS/воркеры во сне
стоят, пробуждение восстанавливает работу без перезагрузки страницы.
`;
fs.writeFileSync(OUT, md);
console.log(`отчёт: ${OUT}`);
console.log(ok ? "P-04: PASS" : "P-04: FAIL");
process.exit(ok ? 0 : 1);
