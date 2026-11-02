// E2E-стенд выбора гарнитуры субтитров (карточка duopulse-068). На реальном
// приложении (debug-exe + vite dev, каркас — e2e/subtitles/run.mjs):
//   1) дефолт — Inter: computed font-family плашки содержит Inter;
//   2) duopulse-test-style {fontFamily:"JetBrains Mono"} (путь панели
//      subtitles.set_style — тот же overlay.setStyle) меняет computed
//      font-family плашки И строк живьём, без пере-включения набора: узлы
//      строк те же, текст на месте (как цвета, карточка 059);
//   3) сквозная доставка сабсетов: Core отвечает font-data (WebMessage),
//      документ получает FontFace — document.fonts.check("400 16px
//      'JetBrains Mono'") = true (кириллический глиф «с» покрывается);
//   4) «system» — системный стек без загрузки шрифта;
//   5) скриншот плашки в обеих гарнитурах (визуальная фиксация).
// Запуск:  node e2e/subtitles/font-family.mjs [путь-к-duopulse.exe]
// Требует собранный debug-exe (cargo build) и запускает vite dev сам.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createReadStream, statSync } from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const CDP_PORT = 9237;
const HTTP_PORT = 8901;
const OUT_DIR = path.join(ROOT, "e2e", "subtitles");

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

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

// --- 1. локальный http-стенд (та же тест-страница, что у run.mjs) -----------
const MIME = { ".html": "text/html; charset=utf-8", ".mp4": "video/mp4", ".vtt": "text/vtt; charset=utf-8" };
const httpServer = http.createServer((req, res) => {
  const file = path.join(
    OUT_DIR,
    path.normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^([/\\]|\.\.)+/, "") ||
      "testpage.html",
  );
  if (!fs.existsSync(file)) {
    res.writeHead(404).end("no");
    return;
  }
  const size = statSync(file).size;
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = Number(m?.[1] ?? 0);
    const end = m?.[2] ? Number(m?.[2]) : size - 1;
    res.writeHead(206, {
      "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
    });
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
      "Content-Length": size,
    });
    createReadStream(file).pipe(res);
  }
});
await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${HTTP_PORT}/`;

// --- 2. изолированный профиль + приложение ------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-fontfamily-e2e-"));
const vite = spawn("npm", ["run", "dev"], { cwd: ROOT, shell: true, stdio: "ignore" });
for (let i = 0; i < 60; i++) {
  try {
    await fetch("http://localhost:5173/");
    break;
  } catch {
    await sleep(500);
  }
}
const app = spawn(EXE, [], {
  stdio: ["ignore", "ignore", "pipe"],
  env: {
    ...process.env,
    APPDATA: tmp,
    DUOPULSE_START_URL: pageUrl,
    DUOPULSE_ADBLOCK_LISTS: "",
    DUOPULSE_SLEEP_AFTER_SECS: "0",
    WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT} --autoplay-policy=no-user-gesture-required`,
  },
});
const appLog = [];
app.stderr?.on("data", (d) => appLog.push(String(d)));

// --- 3. ждём CDP-цель контентной вкладки --------------------------------------
let targets = [];
for (let i = 0; i < 60; i++) {
  try {
    targets = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
    if (targets.some((t) => t.type === "page" && t.url.startsWith(pageUrl))) break;
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

const evalIn = async (ws, expression) => {
  const r = await ws.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception ?? r.exceptionDetails));
  return r.result?.value;
};

const waitForPage = async (ws, expr, timeoutMs, what) => {
  const t0 = Date.now();
  for (;;) {
    const v = await evalIn(ws, expr);
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`не дождались: ${what}`);
    await sleep(100);
  }
};

let failures = 0;
try {
  const target = targets.find((t) => t.type === "page" && t.url.startsWith(pageUrl));
  if (!target) throw new Error("CDP-цель вкладки не найдена: " + targets.map((t) => t.url).join(", "));
  const tab = connect(target.webSocketDebuggerUrl);

  await waitForPage(tab, `typeof window.__duopulseContent === "object"`, 10000, "content-бандл");
  await waitForPage(tab, `document.getElementById("v")?.readyState >= 1`, 10000, "метаданные видео");
  await evalIn(tab, `(function () { document.dispatchEvent(new CustomEvent("duopulse-test-track")); return true; })()`);

  // Плашка с живой репликой: cue в текущий момент времени (0,5–2 с достаточно).
  await evalIn(tab, `(async function () { const v = document.getElementById("v"); v.currentTime = 1; await v.play(); return true; })()`);
  await waitForPage(
    tab,
    `document.querySelector("[data-duopulse-subtitles] .duopulse-subtitles-row")?.textContent.length > 0`,
    8000,
    "строка оверлея",
  );

  // Метки узлов строк до смены гарнитуры: живая смена — узлы те же (059).
  const before = await evalIn(
    tab,
    `(function () {
       const rows = [...document.querySelectorAll(".duopulse-subtitles-row")];
       return { text: rows.map((r) => r.textContent), marked: rows.map((r) => (r.__ffProbe = true, true)) };
     })()`,
  );

  // (1) дефолт Inter: computed font-family плашки и строк содержит Inter.
  const inter = await evalIn(
    tab,
    `(function () {
       const plate = document.querySelector("[data-duopulse-subtitles] > div");
       const row = document.querySelector(".duopulse-subtitles-row");
       return { plate: getComputedStyle(plate).fontFamily, row: getComputedStyle(row).fontFamily };
     })()`,
  );
  check(
    "дефолт Inter: computed font-family плашки содержит Inter (строки наследуют)",
    /Inter/.test(inter.plate),
    inter.plate,
  );

  // Сабсет Inter доставлен Core (font-request → font-data → FontFace): документ
  // рендерит кириллический текст фактическим Inter, не фолбэком.
  const interLoaded = await waitForPage(
    tab,
    `document.fonts.check("400 16px Inter") || document.fonts.check("500 16px Inter")`,
    8000,
    "FontFace Inter из font-data",
  );
  check("сабсеты Inter доставлены в документ (document.fonts.check)", interLoaded === true);

  // (2) живая смена на JetBrains Mono без пере-включения набора.
  await evalIn(
    tab,
    `(function () {
       document.dispatchEvent(new CustomEvent("duopulse-test-style", { detail: { fontFamily: "JetBrains Mono" } }));
       return true;
     })()`,
  );
  const jbm = await evalIn(
    tab,
    `(function () {
       const plate = document.querySelector("[data-duopulse-subtitles] > div");
       const rows = [...document.querySelectorAll(".duopulse-subtitles-row")];
       return {
         plate: getComputedStyle(plate).fontFamily,
         row: getComputedStyle(rows[0]).fontFamily,
         sameNodes: rows.every((r) => r.__ffProbe === true),
         text: rows.map((r) => r.textContent),
       };
     })()`,
  );
  check(
    "живая смена: computed font-family строк = 'JetBrains Mono' (первая в стеке)",
    jbm.row.includes("'JetBrains Mono'") || jbm.row.includes("JetBrains Mono"),
    jbm.row,
  );
  check("живая смена: узлы строк не пересозданы (тот же DOM, текст на месте)", jbm.sameNodes && jbm.text.join("|") === before.text.join("|"), jbm.text.join("|"));

  // (3) сабсеты JetBrains Mono доставлены (400/500) — кириллица покрыта.
  const jbmLoaded = await waitForPage(
    tab,
    `document.fonts.check("400 16px 'JetBrains Mono'") && document.fonts.check("500 16px 'JetBrains Mono'")`,
    8000,
    "FontFace JetBrains Mono из font-data",
  );
  check("сабсеты JetBrains Mono доставлены (400 и 500, document.fonts.check)", jbmLoaded === true);

  // (5а) скриншот плашки в JetBrains Mono.
  await sleep(300); // fade/подгон кегля успокоились
  const shot1 = await tab.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT_DIR, "shot-overlay-font-jetbrains.png"), Buffer.from(shot1.data, "base64"));

  // (4) «system»: системный стек, без загрузки шрифта (Inter/JBM остаются в
  // document.fonts — они уже загружены, но computed плашки — системный стек).
  await evalIn(
    tab,
    `(function () {
       document.dispatchEvent(new CustomEvent("duopulse-test-style", { detail: { fontFamily: "system" } }));
       return true;
     })()`,
  );
  const sys = await evalIn(
    tab,
    `(function () {
       const plate = document.querySelector("[data-duopulse-subtitles] > div");
       const row = document.querySelector(".duopulse-subtitles-row");
       return { plate: getComputedStyle(plate).fontFamily, row: getComputedStyle(row).fontFamily };
     })()`,
  );
  check(
    "«system»: computed font-family — системный стек без именных гарнитур",
    !/Inter|JetBrains/.test(sys.row),
    sys.row,
  );

  // Мусорное значение — остаёмся на прежней гарнитуре (кламп mergeStyle).
  await evalIn(
    tab,
    `(function () {
       document.dispatchEvent(new CustomEvent("duopulse-test-style", { detail: { fontFamily: "Comic Sans" } }));
       return true;
     })()`,
  );
  const junk = await evalIn(tab, `getComputedStyle(document.querySelector(".duopulse-subtitles-row")).fontFamily`);
  check("мусорное fontFamily игнорируется (computed не изменился)", junk === sys.row, junk);

  tab.close();
} catch (e) {
  failures++;
  console.error("ОШИБКА стенда:", e.message);
  console.error(appLog.slice(-30).join(""));
} finally {
  try {
    app.kill();
  } catch {}
  try {
    vite.kill();
  } catch {}
  httpServer.close();
  await killOurExes();
}

failures += results.filter((r) => !r.ok).length;
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} проверок пройдено`);
process.exit(failures ? 1 : 0);
