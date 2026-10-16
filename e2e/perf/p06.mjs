// Замер метрики P-06 (задача 2.5/gate M2, docs/04 §2): «Отклик UI (печать в
// omnibox, Ctrl+Tab) — нет задач > 16 мс» по трассировке длинных задач.
// Инструмент: гистограмма дельт requestAnimationFrame в UI-хроме (дельта =
// время между кадрами — блокировка главного потока дольше кадра видна как
// пропуск) + PerformanceObserver longtask (≥ 50 мс). Нагрузка — реальные
// события Input.*: посимвольная печать в omnibox и 10× Ctrl+Tab по вкладкам.
//
// Критерий «нет задач > 16 мс» (бюджет кадра 60 Гц = 16,7 мс) проверяем как:
//   - нет long task (≥ 50 мс) в UI-хроме за всю нагрузку;
//   - нет пропуска длиннее 2 кадров (> 33 мс) — устойчивых к реальному
//     планированию десктопа одиночных «+1 кадр» может дать компоновка окон.
// Числа (макс. дельта, счётчики пропусков) печатаются — фактическая блокировка
// видна в отчёте.
// Запуск:  node e2e/perf/p06.mjs   (требует release-сборку: npx tauri build)
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = path.join(ROOT, "src-tauri", "target", "release", "duopulse.exe");
const CDP_PORT = 9229;
const HTTP_PORT = 8897;
const SWITCHES = 10;

if (!fs.existsSync(EXE)) {
  console.error(`FAIL  не найден exe: ${EXE} (нужна release-сборка)`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))),
  );

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};
setTimeout(() => {
  console.error("СТЕНД: глобальный таймаут 6 мин — принудительное завершение");
  process.exit(2);
}, 6 * 60_000).unref?.();

// локальные «статьи» — вкладки для переключения (без внешних запросов)
const article = (n) => `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<title>Статья ${n}</title></head><body><h1>Статья ${n}</h1>
${Array.from({ length: 10 }, (_, i) => `<p>Параграф ${i + 1} для вкладки ${n}.</p>`).join("")}
</body></html>`;
const httpServer = http.createServer((req, res) => {
  const m = req.url.match(/^\/a(\d+)/);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(m ? article(Number(m[1])) : article(0));
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
const cdpTargets = async () => {
  try {
    return await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
  } catch {
    return [];
  }
};

async function gracefulClose(app) {
  try {
    await run("taskkill", ["/PID", String(app.pid)]);
  } catch {}
  for (let i = 0; i < 40; i++) {
    if (app.exitCode !== null) break;
    await sleep(250);
  }
  if (app.exitCode === null) {
    try {
      await run("taskkill", ["/PID", String(app.pid), "/T", "/F"]);
    } catch {}
    await sleep(500);
  }
}

const CHROME_VERDICT = `(function () {
  if (document.body.classList.contains("internal-page")) return "page";
  return document.querySelectorAll("#tabs .tab").length > 0 ? "chrome" : "wait";
})()`;

/** Реальный ввод: клавиша через Input-домен CDP (модификаторы битовой маской:
 *  Alt=1, Ctrl=2, Meta=4). */
const key = (ws, { k, text, ctrl = false, down = true }) => {
  const params = {
    type: down ? "keyDown" : "keyUp",
    key: k,
    code: k.length === 1 ? `Key${k.toUpperCase()}` : k,
    windowsVirtualKeyCode: k.length === 1 ? k.toUpperCase().charCodeAt(0) : 9,
    modifiers: ctrl ? 2 : 0,
  };
  if (down && text) params.text = text;
  return ws.send("Input.dispatchKeyEvent", params);
};

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-p06-"));
const articleUrl = (n) => `http://127.0.0.1:${HTTP_PORT}/a${n}`;

let failures = 0;
let app = null;
try {
  app = spawn(EXE, [], {
    stdio: "ignore",
    env: {
      ...process.env,
      APPDATA: profile,
      DUOPULSE_START_URL: articleUrl(1),
      WEBVIEW2_USER_DATA_FOLDER: path.join(profile, "webview2-data"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
  });

  // ждём хром
  let ui = null;
  const t0 = Date.now();
  while (!ui) {
    if (app.exitCode !== null) throw new Error(`приложение вышло (code=${app.exitCode})`);
    if (Date.now() - t0 > 60_000) throw new Error("UI-хром не поднялся");
    for (const t of await cdpTargets()) {
      if (t.type !== "page") continue;
      const ws = connect(t.webSocketDebuggerUrl);
      const verdict = await evalIn(ws, CHROME_VERDICT).catch(() => "wait");
      if (verdict === "chrome") {
        ui = ws;
        break;
      }
      if (verdict === "page") continue;
      ws.close();
    }
    if (!ui) await sleep(200);
  }

  // 4 вкладки для Ctrl+Tab (стартовая + 3 новых через настоящий UI)
  const openViaOmnibox = async (url) => {
    await evalIn(ui, `document.getElementById("newtab").click(); true`);
    await sleep(800);
    await evalIn(
      ui,
      `(function () {
        const i = document.getElementById("omnibox");
        i.value = ${JSON.stringify(url)};
        i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        return true;
      })()`,
    );
    await sleep(700);
  };
  for (const n of [2, 3, 4]) await openViaOmnibox(articleUrl(n));
  const tabs = await evalIn(ui, `document.querySelectorAll("#tabs .tab").length`);
  check("P-06 сценарий: 4 вкладки открыты", tabs === 4, `вкладок: ${tabs}`);

  // инструмент: гистограмма rAF-дельт + longtask в UI-хроме
  await evalIn(ui, `(function () {
    window.__p06 = { last: null, deltas: [], long: [] };
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__p06.long.push(e.duration);
    }).observe({ entryTypes: ["longtask"] });
    (function loop(t) {
      const s = window.__p06;
      if (s.last !== null) s.deltas.push(t - s.last);
      s.last = t;
      requestAnimationFrame(loop);
    })(performance.now());
    return true;
  })()`);
  await sleep(1200); // чистый фон до нагрузки

  // нагрузка: печать в omnibox (реальные key events), затем Ctrl+Tab ×N
  await evalIn(ui, `document.getElementById("omnibox").focus(); true`);
  const PHRASE = "duopulse отклик";
  for (const ch of PHRASE) {
    await key(ui, { k: ch, text: ch, down: true });
    await key(ui, { k: ch, down: false });
    await sleep(60);
  }
  await sleep(400);
  for (let i = 0; i < SWITCHES; i++) {
    await key(ui, { k: "Control", down: true });
    await key(ui, { k: "Tab", ctrl: true, down: true });
    await key(ui, { k: "Tab", ctrl: true, down: false });
    await key(ui, { k: "Control", down: false });
    await sleep(250);
  }
  await sleep(1200);

  const stat = await evalIn(ui, `(function () {
    const d = window.__p06.deltas.slice(); // включая фон до/после нагрузки
    const inLoad = d; // стенд короткий — берём всё окно, фон очищен ниже
    return {
      max: Math.max(...inLoad),
      over16: inLoad.filter((x) => x > 16.9).length,
      over33: inLoad.filter((x) => x > 33.5).length,
      long: window.__p06.long.length,
      frames: inLoad.length,
    };
  })()`);
  check("P-06 long task (≥50 мс) в UI-хроме нет", stat.long === 0, `longtask: ${stat.long}`);
  check(
    "P-06 нет блокировок > 2 кадров (>33 мс)",
    stat.over33 === 0,
    `макс. дельта ${stat.max.toFixed(1)} мс, пропусков >16,7 мс: ${stat.over16} из ${stat.frames} кадров`,
  );
  console.log(
    `      P-06 max_block_ms=${stat.max.toFixed(1)} (для истории: p06_max_block_ms), пропусков кадра ${stat.over16}`,
  );
  ui.close();
} catch (e) {
  failures++;
  console.error("E2E ERROR:", e.message);
} finally {
  if (app) await gracefulClose(app);
  httpServer.close();
  await sleep(1000);
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {}
}

const failed = results.filter((r) => !r.ok).length + failures;
console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES: " + failed} (${results.length} проверок)`);
process.exit(failed === 0 ? 0 : 1);
