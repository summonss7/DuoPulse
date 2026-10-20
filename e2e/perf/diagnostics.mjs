// Функциональный стенд страницы «Диагностика» (задача 2.5, DoD «график
// последних прогонов»): релизная сборка, duopulse://diagnostics. Проверяет:
//   1) страница открывается и живой срез отрисован (старт сеанса в мс);
//   2) история прогонов читается из SQLite: сеем 2 прогона с p01_ms →
//      на графике строка P-01 с двумя точками;
//   3) «Снять срез» сохраняет живой прогон (P-02 тёплый старт) в историю;
//   4) бюджеты: сеем p07_ratio_pct=79 (бюджет ≤ 60) → точка .over и последнее
//      значение красное; p05_drops_per_min=5 — сравнительная метрика без
//      порога (трактовка P-05 от 20.10.2026, docs/04 §2) → подсветки нет;
// Запуск: node e2e/perf/diagnostics.mjs [путь-к-duopulse.exe]
// Требует release-сборку: npx tauri build (cargo build --release без tauri-CLI даёт dev-режим — UI грузится с vite).
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE =
  process.argv.find((a, i) => i > 1 && !a.startsWith("--") && process.argv[i - 1] !== "--") ||
  path.join(ROOT, "src-tauri", "target", "release", "duopulse.exe");
const CDP_PORT = 9229;

if (!fs.existsSync(EXE)) {
  console.error(`FAIL  не найден exe: ${EXE} (нужна release-сборка)`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, opts, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))),
  );

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};
setTimeout(() => {
  console.error("СТЕНД: глобальный таймаут 5 мин — принудительное завершение");
  process.exit(2);
}, 5 * 60_000).unref?.();

// --- CDP (как e2e/perf/run.mjs) ------------------------------------------------
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
const cdpTargets = async () => {
  try {
    return await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
  } catch {
    return [];
  }
};

// Страница самоопределяется: internal-page + корень .diag (data-page).
const DIAG_VERDICT = `(function () {
  if (!document.body.classList.contains("internal-page")) return "wait";
  const root = document.querySelector(".diag[data-page='diagnostics']");
  return root ? "diag" : "page";
})()`;

const mkProfile = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `duopulse-diag-${tag}-`));
const launch = (profile) =>
  spawn(EXE, [], {
    stdio: "ignore",
    env: {
      ...process.env,
      APPDATA: profile,
      DUOPULSE_START_URL: "duopulse://diagnostics",
      WEBVIEW2_USER_DATA_FOLDER: path.join(profile, "webview2-data"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
  });

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

let failures = 0;
const profile = mkProfile("run");
let app = null;
try {
  // сеем историю: два прогона с p01 (первый — вне бюджета), один с p07 вне
  // бюджета + p05 (сравнительная — без порога)
  const seed = (label, metrics) =>
    run(process.execPath, [
      path.join(ROOT, "e2e", "perf", "save-run.mjs"),
      "--profile",
      path.join(profile, "DuoPulse", "profile"),
      "--label",
      label,
      "--metrics",
      JSON.stringify(metrics),
    ]);
  await seed("стенд-1", { p01_ms: 1600, p02_ms: 480 });
  await seed("стенд-2", { p01_ms: 402, p02_ms: 365, p03_mb: 48 });
  await seed("стенд-дропы", { p05_drops_per_min: 5, p07_ratio_pct: 79 });

  app = launch(profile);
  const t0 = Date.now();
  let pageWs = null;
  while (!pageWs) {
    if (app.exitCode !== null) throw new Error(`приложение вышло (code=${app.exitCode})`);
    if (Date.now() - t0 > 60_000) throw new Error("страница диагностики не поднялась за 60 с");
    for (const t of await cdpTargets()) {
      if (t.type !== "page") continue;
      const ws = connect(t.webSocketDebuggerUrl);
      const verdict = await evalIn(ws, DIAG_VERDICT).catch(() => "wait");
      if (verdict === "diag") {
        pageWs = ws;
        break;
      }
      ws.close();
    }
    if (!pageWs) await sleep(200);
  }

  // живой срез отрисован: старт сеанса в мс (страница открыта после Ready —
  // perf.snapshot уже знает итог старта)
  let liveOk = false;
  for (let i = 0; i < 20 && !liveOk; i++) {
    liveOk = await evalIn(pageWs, `(function () {
      const v = document.querySelector(".diag-stat-value");
      return !!v && /\\d+ мс/.test(v.textContent ?? "");
    })()`);
    if (!liveOk) await sleep(300);
  }
  check("живой срез: старт сеанса отрисован (мс)", liveOk);

  // график истории: строка P-01 с двумя точками сеянных прогонов
  await sleep(500);
  const p01dots = await evalIn(
    pageWs,
    `document.querySelectorAll(".diag-row[data-metric='p01_ms'] .diag-spark-dot").length`,
  );
  check("график: строка P-01 с 2 точками прогонов", p01dots === 2, `точек: ${p01dots}`);

  // вне бюджета: p07=79 при бюджете ≤ 60 — последнее значение красное (.over)
  const p07over = await evalIn(
    pageWs,
    `document.querySelector(".diag-row-last[data-metric='p07_ratio_pct']")?.classList.contains("over") ?? false`,
  );
  check("график: выход за бюджет подсвечен (P-07 вне бюджета)", p07over === true);

  // P-05 — сравнительная метрика (budgetMax null): значение есть, подсветки
  // «вне бюджета» нет (порог — контрольный браузер, docs/04 §2 от 20.10.2026)
  const p05row = await evalIn(
    pageWs,
    `(function () {
      const last = document.querySelector(".diag-row-last[data-metric='p05_drops_per_min']");
      const dots = document.querySelectorAll(".diag-row[data-metric='p05_drops_per_min'] .diag-spark-dot").length;
      return { dots, text: last?.textContent ?? "", over: last?.classList.contains("over") ?? true };
    })()`,
  );
  check(
    "график: P-05 без числового порога (строка есть, подсветки нет)",
    p05row.dots === 1 && p05row.over === false && /5/.test(p05row.text),
    `точек: ${p05row.dots}, значение: «${p05row.text}», over: ${p05row.over}`,
  );

  // «Снять срез»: клик по кнопке → в истории появился 4-й прогон
  const before = await evalIn(pageWs, `document.querySelectorAll(".diag-runs .diag-run").length`);
  await evalIn(pageWs, `document.getElementById("diagSave").click(); true`);
  let after = before;
  for (let i = 0; i < 20 && after <= before; i++) {
    await sleep(300);
    after = await evalIn(pageWs, `document.querySelectorAll(".diag-runs .diag-run").length`);
  }
  check("срез: «Снять срез» добавил прогон в историю", after === before + 1, `${before} → ${after}`);

  pageWs.close();
} catch (e) {
  failures++;
  console.error("E2E ERROR:", e.message);
} finally {
  if (app) await gracefulClose(app);
  await sleep(1000);
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {}
}

const failed = results.filter((r) => !r.ok).length + failures;
console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES: " + failed} (${results.length} проверок)`);
process.exit(failed === 0 ? 0 : 1);
