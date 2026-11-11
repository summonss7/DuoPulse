// Диагностический стенд «много вкладок → память/зависание» (карточка
// duopulse-115): открывает N вкладок с «тяжёлыми» локальными страницами
// (канвас-анимация + DOM-чёрн + поток подресурсов — как у живых сайтов,
// без внешней сети), меряет память дерева duopulse.exe + msedgewebview2.exe
// и задержку round-trip UI→Core (window.__duopulse.tabs.list). Зависание
// ядра видно как таймаут round-trip; утечка — как монотонный рост памяти
// после открытия всех вкладок.
//
// Запуск:  node e2e/tabs/mem-hang-probe.mjs [путь-к-duopulse.exe] [кол-во вкладок]
// HEAVY=1 — страницы «как видео-сайт»: играющее видео (canvas.captureStream →
// <video> self-loop, держит вкладку в исключении спящего режима), канвас-кадры,
// JS-куча до ~220 МБ на вкладку — модель 12 вкладок YouTube на 16-ГБ машине.
// По умолчанию: debug-exe из target/debug, 12 вкладок. Профиль и данные WebView2 —
// во временной папке (стенд ничего не мутирует в профиле пользователя).
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const TABS = Number(process.argv[3] || 12);
const CDP_PORT = 9231;
const HTTP_PORT = 8897;
const OUT = path.join(ROOT, "e2e", "tabs", "mem-hang-last-run.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))));

// --- 1. локальный стенд: «тяжёлая» страница -----------------------------------
// Канвас-анимация (рендер/GPU-кадры), DOM-чёрн (аллокации рендера), поток
// картинок/fetch (каждый запрос проходит COM-перехватчик Core — как у
// реального сайта с подресурсами).
const page = (n) => `<!doctype html><html><head><title>Heavy ${n}</title></head><body>
<canvas id=c width=640 height=360></canvas><div id=d></div><script>
const ctx = c.getContext("2d");
let t = 0;
(function draw() {
  t += 0.02;
  for (let i = 0; i < 60; i++) {
    ctx.fillStyle = "hsl(" + ((t * 40 + i * 6) % 360) + ",80%,50%)";
    ctx.fillRect((i * 37 + t * 60) % 640, (i * 53 + t * 90) % 360, 22, 16);
  }
  requestAnimationFrame(draw);
})();
let gen = 0;
setInterval(() => {
  gen++;
  const d = document.getElementById("d");
  for (let i = 0; i < 50; i++) {
    const p = document.createElement("p");
    p.textContent = "gen " + gen + " node " + i + " " + Math.random().toString(36).repeat(50);
    d.appendChild(p);
  }
  while (d.childNodes.length > 400) d.removeChild(d.firstChild);
}, 400);
setInterval(() => {
  fetch("/img?r=" + Math.random()).catch(() => {});
  fetch("/x?r=" + Math.random()).catch(() => {});
}, 500);
${process.env.HEAVY ? `
// HEAVY: играющее видео (исключение спящего режима, как вкладка YouTube)
// + JS-куча ~220 МБ (модель тяжёлого сайта).
try {
  const v = document.createElement("video");
  v.muted = true; v.playsInline = true; v.loop = true;
  v.srcObject = c.captureStream(30);
  v.play().catch(() => {});
  document.body.appendChild(v);
} catch (e) {}
const keep = [];
setInterval(() => {
  if (performance.memory && performance.memory.usedJSHeapSize > 220 * 1048576) return;
  keep.push(new Uint8Array(4 * 1048576).fill(1));
}, 200);
` : ""}
</script></body></html>`;
const GIF = Buffer.from("R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs=", "base64");
let reqTotal = 0;
const httpServer = http.createServer((req, res) => {
  reqTotal++;
  if (req.url.startsWith("/img")) {
    res.writeHead(200, { "Content-Type": "image/gif" });
    return res.end(GIF);
  }
  if (req.url.startsWith("/x")) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }
  const m = req.url.match(/^\/h(\d+)/);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(page(Number(m ? m[1] : 0)));
});
await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));
const url = (p) => `http://127.0.0.1:${HTTP_PORT}/${p}`;
// URLS=http://…,http://… — живые адреса вместо локального стенда (замер
// реальной памяти вкладок; открывается столько, сколько задано, TABS игнорируется).
const LIVE_URLS = (process.env.URLS || "").split(",").map((s) => s.trim()).filter(Boolean);

// --- 2. изолированный профиль + приложение ------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-memprobe-"));
const vite = spawn("npm", ["run", "dev"], { cwd: ROOT, shell: true, stdio: "ignore" });
for (let i = 0; i < 60; i++) {
  try {
    await fetch("http://localhost:5173/");
    break;
  } catch {
    await sleep(500);
  }
}
const appErr = fs.openSync(path.join(tmp, "app-stderr.log"), "a");
const app = spawn(EXE, [], {
  stdio: ["ignore", "ignore", appErr],
  env: {
    ...process.env,
    APPDATA: tmp,
    DUOPULSE_START_URL: LIVE_URLS[0] || url("h0"),
    DUOPULSE_ADBLOCK_LISTS: "",
    WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT} --autoplay-policy=no-user-gesture-required`,
  },
});

// --- 3. CDP -------------------------------------------------------------------
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
// Живые URL: EEA-consent страховка (вне EEA безвредна) — как e2e/youtube.
if (LIVE_URLS.some((u) => u.includes("youtube.com"))) {
  const first = targets.find((t) => t.type === "page" && !/localhost:5173/.test(t.url));
  if (first) {
    const w = connect(first.webSocketDebuggerUrl);
    await w.send("Network.enable");
    for (const [name, value] of [
      ["CONSENT", "YES+cb.20210328-17-p0.en+FX+888"],
      ["SOCS", "CAI"],
    ]) {
      await w.send("Network.setCookie", { name, value, domain: ".youtube.com", path: "/" }).catch(() => {});
    }
    w.close();
  }
}
const evalIn = async (ws, expression, timeoutMs = 20000) => {
  const r = await Promise.race([
    ws.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }),
    sleep(timeoutMs).then(() => Promise.reject(new Error(`TIMEOUT ${timeoutMs}ms: ${expression.slice(0, 60)}`))),
  ]);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception ?? r.exceptionDetails));
  return r.result?.value;
};

// --- 4. память дерева процессов -----------------------------------------------
const ps = (s) => s.replace(/'/g, "''"); // single-quoted PS-строка: экранировать только кавычки
const mem = async () => {
  const out = await run("powershell", ["-NoProfile", "-Command", `
    $app = Get-CimInstance Win32_Process -Filter "Name='duopulse.exe'" | Where-Object { $_.ExecutablePath -eq '${ps(EXE)}' }
    $wv = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like '*${ps(path.join(tmp, "webview2-data"))}*' }
    $tot = ($app | Measure-Object WorkingSetSize -Sum).Sum
    $cnt = ($app | Measure-Object).Count
    $wvsum = ($wv | Measure-Object WorkingSetSize -Sum).Sum
    $wvcnt = ($wv | Measure-Object).Count
    $max = ($wv | Measure-Object WorkingSetSize -Maximum).Maximum
    $free = [Math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1kb)
    "$cnt $tot $wvcnt $wvsum $max $free"`]);
  const [cnt, tot, wvcnt, wvsum, max, free] = out.trim().split(/\s+/).map(Number);
  return { app: cnt, appMb: Math.round((tot || 0) / 1048576), wv: wvcnt, wvMb: Math.round((wvsum || 0) / 1048576), wvMaxMb: Math.round((max || 0) / 1048576), sysFreeMb: free };
};

const samples = [];
const log = (tag, extra = "") => {
  const line = { t: Math.round(process.uptime()), tag, ...extra };
  samples.push(line);
  console.log(`[+${String(line.t).padStart(4)}s] ${tag}  app=${extra.appMb ?? "-"}МБ wv=${extra.wv ?? "-"}шт/${extra.wvMb ?? "-"}МБ sysFree=${extra.sysFreeMb ?? "-"}МБ ${extra.note ?? ""}`);
};

// --- 5. прогон ----------------------------------------------------------------
const ui = targets.find((t) => t.type === "page" && /localhost:5173/.test(t.url));
if (!ui) throw new Error("UI-цель CDP не найдена");
const uiWs = connect(ui.webSocketDebuggerUrl);
for (let i = 0; i < 20; i++) {
  if ((await evalIn(uiWs, `typeof window.__duopulse`)) === "object") break;
  await sleep(500);
}

const rt = async (label) => {
  const t0 = Date.now();
  try {
    await evalIn(uiWs, `window.__duopulse.tabs.list()`);
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, err: String(e.message || e) };
  }
};

let openLat = [];
try {
  log("baseline", { ...(await mem()) });
  // открытие вкладок подряд (как пользователь), с замером каждой
  const openList = LIVE_URLS.length ? LIVE_URLS.slice(1) : Array.from({ length: TABS - 1 }, (_, i) => url("h" + (i + 1)));
  for (const u of openList) {
    const t0 = Date.now();
    await evalIn(uiWs, `window.__duopulse.tabs.open({ url: "${u}" })`);
    openLat.push(Date.now() - t0);
    await sleep(1200);
  }
  log(`opened ${TABS}`, { ...(await mem()), note: `open lat: max=${Math.max(...openLat)}ms avg=${Math.round(openLat.reduce((a, b) => a + b, 0) / openLat.length)}ms req=${reqTotal}` });

  // наблюдение 90 с: рост памяти = утечка/давление; таймауты = зависание
  let worst = { ms: 0 };
  for (let i = 0; i < 9; i++) {
    await sleep(10000);
    const m = await mem();
    const r = await rt();
    if (!r.ok) {
      log("RT-FAIL", { ...m, note: r.err });
      throw new Error("UI/Core round-trip завис: " + r.err);
    }
    worst = r.ms > worst.ms ? r : worst;
    log("watch", { ...m, note: `rt=${r.ms}ms req=${reqTotal}` });
  }

  // стресс: 20 быстрых переключений вкладок
  const ids = (await evalIn(uiWs, `window.__duopulse.tabs.list()`)).tabs.map((t) => t.id);
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) {
    await evalIn(uiWs, `window.__duopulse.tabs.activate({ id: "${ids[i % ids.length]}" })`);
    await sleep(150);
  }
  const switchMs = Date.now() - t0;
  const final = await mem();
  const rtFinal = await rt();
  log("stress-done", { ...final, note: `20 переключений за ${switchMs}ms, rt=${rtFinal.ms}ms ok=${rtFinal.ok}` });

  const report = {
    exe: EXE,
    tabs: TABS,
    samples,
    openLat,
    worstRtMs: worst.ms,
    switch20Ms: switchMs,
    stderrTail: fs.readFileSync(path.join(tmp, "app-stderr.log"), "utf8").split(/\r?\n/).slice(-40),
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\nOK: отчёт ${OUT}; worst rt=${worst.ms}ms; 20 переключений ${switchMs}ms; памяти всего app+wv=${final.appMb + final.wvMb}МБ`);
} catch (e) {
  const report = {
    exe: EXE,
    tabs: TABS,
    samples,
    openLat,
    error: String(e.message || e),
    stderrTail: fs.readFileSync(path.join(tmp, "app-stderr.log"), "utf8").split(/\r?\n/).slice(-60),
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.error("ПРОВАЛ: " + e.message + " — детали " + OUT);
  process.exitCode = 1;
} finally {
  try {
    await run("powershell", ["-NoProfile", "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='duopulse.exe'" | Where-Object { $_.ExecutablePath -eq '${ps(EXE)}' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }`]);
  } catch { /* уже мертвы */ }
  uiWs.close();
  app.kill();
  // npm-обёртка умирает, node/vite-ребёнок на 5173 остаётся — дерево целиком
  try {
    await run("powershell", ["-NoProfile", "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*vite*bin*vite.js*' -and $_.CommandLine -like '*DuoPulse*' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }`]);
  } catch { /* уже мертвы */ }
  vite.kill();
  httpServer.close();
  try { fs.closeSync(appErr); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} // stderr уже в отчёте
  setTimeout(() => process.exit(process.exitCode || 0), 1500).unref();
}
