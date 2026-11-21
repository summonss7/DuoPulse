// E2E-приёмка duopulse-205 «перетаскивание вкладок мышью» через CDP в живом
// приложении (паттерн e2e/bookmarks/bm-drag.mjs; изоляция — временный
// APPDATA, vite dev поднимает сам, требует собранного debug-exe).
//   1) сид: 4 вкладки локального стенда (A,B,C,D), активна D;
//   2) drag C перед A (синтетические DragEvent + DataTransfer) — tabs.move:
//      порядок C,A,B,D в DOM бара и в tabs.list, активной осталась D;
//   3) drag A в конец (drop правее последней) — порядок C,B,D,A;
//   4) drag D перед соседом справа — no-op: порядок не меняется;
//   5) drag активной вкладки A перед C — порядок A,C,B,D, активна A,
//      контент жив (URL активной не изменился);
//   6) повторный drag «в себя» (drop на самой вкладке) — порядок стабилен.
// Скриншот бара: %TEMP%/duopulse-205-tabbar.png.
//
// Запуск:  node e2e/tabs/tab-drag.mjs [путь-к-duopulse.exe]
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const step = (s) => console.log(`-- шаг: ${s}`);
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const EXE_PS = EXE.replaceAll("/", "\\");
const CDP_PORT = Number(process.env.CDP_PORT || 9234);
const HTTP_PORT = Number(process.env.E2E_205_PORT || 8933);
const SHOT_DIR = process.env.E2E_205_SHOTS || os.tmpdir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))),
  );
const killOurExes = async () => {
  try {
    await run("powershell", [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='duopulse.exe'" | Where-Object { $_.ExecutablePath -eq '${EXE_PS}' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }`,
    ]);
  } catch {
    /* уже мертвы — ок */
  }
};

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "OK" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

const consoleLog = [];
function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    } else if (!m.id) {
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
        consoleLog.push("[ui] " + m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
      }
      if (m.method === "Runtime.exceptionThrown") {
        consoleLog.push("[ui] EXC: " + JSON.stringify(m.params.exceptionDetails.exception ?? {}).slice(0, 300));
      }
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
  const evalIn = (expr, awaitPromise = true) =>
    send("Runtime.evaluate", { expression: expr, awaitPromise, returnByValue: true }).then((r) => {
      if (r?.exceptionDetails) {
        const d = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "?";
        return "EXC: " + String(d).slice(0, 200);
      }
      return r?.result?.value;
    });
  return { ws, send, evalIn };
}

const waitFor = async (fn, ms, stepMs = 400) => {
  for (let end = Date.now() + ms; Date.now() < end; ) {
    const v = await fn();
    if (v) return v;
    await sleep(stepMs);
  }
  return null;
};

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<html><head><title>Стенд 205 ${req.url}</title></head><body><h1>${req.url}</h1></body></html>`);
});
await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-205-e2e-"));
const vite = spawn("npm", ["run", "dev"], { cwd: ROOT, shell: true, stdio: "ignore" });
for (let i = 0; i < 60; i++) {
  try {
    await fetch("http://localhost:5173/");
    break;
  } catch {
    await sleep(500);
  }
}

await killOurExes();
const app = spawn(EXE, [], {
  stdio: "ignore",
  env: {
    ...process.env,
    APPDATA: tmp,
    DUOPULSE_START_URL: `http://127.0.0.1:${HTTP_PORT}/a`,
    DUOPULSE_ADBLOCK_LISTS: "",
    DUOPULSE_E2E_NO_SINGLE_INSTANCE: "1",
    WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
  },
});

/** id вкладок бара в порядке DOM (лапки титула — h1 локальной страницы). */
const domOrder = () =>
  ui.evalIn(
    `(() => [...document.querySelectorAll('#tabs .tab .tab-title')].map((el) => el.textContent))()`,
    false,
  );
/** Снапшот Core: порядок URL + id/URL активной. */
const coreTabs = () => ui.evalIn(`window.__duopulse.tabs.list()`, true);
const urlOf = (p) => `http://127.0.0.1:${HTTP_PORT}/${p}`;

/** Синтетический drag вкладки: перехватить по титулу, дроп в точке (x,y). */
const dragTab = (title, x, y) =>
  ui.evalIn(`(() => {
    const tabs = document.getElementById('tabs');
    const el = [...tabs.querySelectorAll('.tab')].find((t) => t.querySelector('.tab-title')?.textContent?.endsWith(${JSON.stringify(title)}));
    if (!el) return 'no-dragged';
    const dt = new DataTransfer();
    el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    tabs.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: ${x}, clientY: ${y} }));
    tabs.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: ${x}, clientY: ${y} }));
    el.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return 'ok';
  })()`, false);
/** Центр вкладки по титулу (для точек дропа). */
const tabCenter = (title) =>
  ui.evalIn(`(() => {
    const el = [...document.querySelectorAll('#tabs .tab')].find((t) => t.querySelector('.tab-title')?.textContent?.endsWith(${JSON.stringify(title)}));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top + r.height / 2 };
  })()`, false);

let ui = null;
try {
  step("ждём CDP-цель UI");
  ui = await waitFor(async () => {
    try {
      const list = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
      return list.find((t) => t.type === "page" && /localhost:5173/.test(t.url) && !/panel=/.test(t.url)) ?? null;
    } catch {
      return null;
    }
  }, 60000);
  check("приложение поднялось (CDP-цель UI)", !!ui, ui?.url ?? "не дождались");
  if (!ui) throw new Error("нет CDP");
  const uiWs = connect(ui.webSocketDebuggerUrl);
  await uiWs.send("Runtime.enable").catch(() => {});
  ui = uiWs;
  await waitFor(() => ui.evalIn(`document.querySelectorAll('.tab').length > 0 ? 1 : 0`, false), 15000);

  // --- 1. сид: B,C,D поверх стартовой A, активна D --------------------------
  step("сид: вкладки A,B,C,D; активируем D");
  await ui.evalIn(`window.__duopulse.tabs.open({ url: ${JSON.stringify(urlOf("b"))} }).then(() => window.__duopulse.tabs.open({ url: ${JSON.stringify(urlOf("c"))} })).then(() => window.__duopulse.tabs.open({ url: ${JSON.stringify(urlOf("d"))} }))`);
  const seeded = await waitFor(
    () => domOrder().then((o) => (Array.isArray(o) && o.length === 4 && o.join().includes("/d") ? o : null)),
    15000,
  );
  check("сид: 4 вкладки в баре (A,B,C,D)", !!seeded, JSON.stringify(seeded));
  // активной делаем D кликом по вкладке (как пользователь)
  await ui.evalIn(`(() => { const el = [...document.querySelectorAll('#tabs .tab')].find((t) => t.querySelector('.tab-title')?.textContent?.includes('/d')); el?.click(); return !!el; })()`, false);
  const activeD = await waitFor(
    () => coreTabs().then((t) => (t?.tabs?.find((x) => x.active)?.url?.endsWith("/d") ? t : null)),
    10000,
  );
  check("D активна кликом по вкладке", !!activeD, activeD ? "" : "не дождались");

  // --- 2. drag C перед A ------------------------------------------------------
  step("drag C перед A");
  const a1 = await tabCenter("/a");
  const d1 = await dragTab("/c", a1.left + 6, a1.top);
  await sleep(700);
  const after1 = await domOrder();
  const core1 = await coreTabs();
  check(
    "tabs.move: порядок C,A,B,D (DOM и Core), активна D",
    d1 === "ok" &&
      JSON.stringify(after1) === JSON.stringify(["Стенд 205 /c", "Стенд 205 /a", "Стенд 205 /b", "Стенд 205 /d"]) &&
      core1.tabs.map((t) => t.url).join(" ") === [urlOf("c"), urlOf("a"), urlOf("b"), urlOf("d")].join(" ") &&
      core1.tabs.find((t) => t.active).url === urlOf("d"),
    JSON.stringify({ d1, after1, core: core1.tabs?.map((t) => t.url) }),
  );

  // --- 3. drag A в конец ------------------------------------------------------
  step("drag A в конец бара");
  const dLast = await tabCenter("/d");
  const d2 = await dragTab("/a", dLast.right + 14, dLast.top);
  await sleep(700);
  const after2 = await domOrder();
  check(
    "drop правее последней — A в конец",
    d2 === "ok" && after2.map((s) => s.slice(-2)).join(",") === "/c,/b,/d,/a",
    JSON.stringify(after2),
  );

  // --- 4. no-op: drag перед соседом справа ------------------------------------
  step("drag B перед D (сосед справа) — no-op");
  const d4c = await tabCenter("/d");
  const d3 = await dragTab("/b", d4c.left + 6, d4c.top);
  await sleep(700);
  const after3 = await domOrder();
  check(
    "порядок не изменился (без лишней команды)",
    d3 === "ok" && after3.map((s) => s.slice(-2)).join(",") === "/c,/b,/d,/a",
    JSON.stringify(after3),
  );

  // --- 5. drag активной вкладки ------------------------------------------------
  step("drag активной D перед C");
  const c5 = await tabCenter("/c");
  const d4 = await dragTab("/d", c5.left + 6, c5.top);
  await sleep(700);
  const after4 = await domOrder();
  const core4 = await coreTabs();
  check(
    "активная переехала первой, контент жив (URL активной не сменился)",
    d4 === "ok" &&
      after4.map((s) => s.slice(-2)).join(",") === "/d,/c,/b,/a" &&
      core4.tabs.find((t) => t.active)?.url === urlOf("d"),
    JSON.stringify({ after4, active: core4.tabs?.find((t) => t.active)?.url }),
  );

  // --- 6. drop на самой вкладке ------------------------------------------------
  step("drop тянущейся на себе самой");
  const b6 = await tabCenter("/b");
  const d5 = await dragTab("/b", b6.left + 5, b6.top); // drop на месте тянущейся
  await sleep(700);
  const after5 = await domOrder();
  check(
    "перед самим собой — порядок стабилен",
    d5 === "ok" && after5.map((s) => s.slice(-2)).join(",") === "/d,/c,/b,/a",
    JSON.stringify(after5),
  );

  // --- скриншот бара ------------------------------------------------------------
  const barShot = await ui
    .send("Page.captureScreenshot", {
      format: "png",
      clip: await ui
        .evalIn(`(() => { const r = document.getElementById('tabbar').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 }; })()`, false)
        .then((c) => c ?? undefined),
    })
    .catch(() => null);
  if (barShot) {
    fs.writeFileSync(path.join(SHOT_DIR, "duopulse-205-tabbar.png"), Buffer.from(barShot.data, "base64"));
    console.log("скриншот:", path.join(SHOT_DIR, "duopulse-205-tabbar.png"));
  }
} catch (e) {
  check("стенд завершился без падения", false, String(e));
} finally {
  try { app.kill(); } catch {}
  try { vite.kill(); } catch {}
  try { httpServer.close(); } catch {}
  await killOurExes();
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (consoleLog.length) {
  console.log("\nКонсоль приложения (ошибки):");
  for (const line of consoleLog) console.log("  " + line);
}
const failed = results.filter((r) => !r.ok);
console.log(`\nИтог: ${results.length - failed.length}/${results.length} проверок прошло`);
if (failed.length) {
  console.log("Провалены:\n" + failed.map((r) => `  ${r.name} — ${r.extra}`).join("\n"));
  process.exitCode = 1;
}
