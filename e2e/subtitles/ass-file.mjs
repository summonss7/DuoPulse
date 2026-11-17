// E2E-стенд карточки duopulse-178: ручные субтитры .ass (Advanced SubStation
// Alpha — аниме). На реальном приложении (debug-exe + vite dev, паттерн
// e2e/subtitles/run.mjs) проверяет сквозной путь дропа:
//   1) подсказка дроп-зоны упоминает .ass (расширение признано своим);
//   2) дроп фикстуры e2e/fixtures/subtitles/sample.ass («лёгкий» аниме-релиз:
//      знаки {\an8}, \pos, караоке {\k}, fade, рисунок {\p}, Comment, \h, \N)
//      → файловая дорожка: 6 cue, override-теги вырезаны, nbsp на месте,
//      topStarts=[1000,16000] (боковой канал \an7/8/9);
//   3) оверлей: реплика {\an8} — во второй плашке-верху (у верхнего края
//      видео), диалог — в основной плашке; перекрытие знака и таблички
//      смёржено движком в две строки;
//   4) cue без верхних реплик прячет плашку-верх (display:none);
//   5) дроп .srt после .ass не ломается (замещает файловую часть набора);
//   6) скриншот обоих плашек над видео (ass-last-run.png).
// Рантайм-артефакты (ass-last-run.json/.png) — gitignore.
//
// Запуск:  node e2e/subtitles/ass-file.mjs [путь-к-duopulse.exe]
// Требует собранный debug-exe (cargo build; контент-бандл вшит в exe —
// после правок content/ пересобрать) и сам поднимает vite dev.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createReadStream, statSync } from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const CDP_PORT = 9236;
const HTTP_PORT = 8898;
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

// --- 1. локальный http-стенд: тест-страница 3.2 + видео -----------------------
const ROOT_WWW = path.join(ROOT, "e2e", "subtitles");
const MIME = { ".html": "text/html; charset=utf-8", ".mp4": "video/mp4", ".vtt": "text/vtt; charset=utf-8" };
const httpServer = http.createServer((req, res) => {
  const file = path.join(ROOT_WWW, path.normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^([/\\]|\.\.)+/, "") || "testpage.html");
  if (!fs.existsSync(file)) {
    res.writeHead(404).end("no");
    return;
  }
  const size = statSync(file).size;
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = Number(m?.[1] ?? 0);
    const end = m?.[2] ? Number(m[2]) : size - 1;
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-ass-e2e-"));
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
    DUOPULSE_E2E_NO_SINGLE_INSTANCE: "1",
    WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT} --autoplay-policy=no-user-gesture-required`,
  },
});
const appLog = [];
app.stderr?.on("data", (d) => appLog.push(String(d)));

// --- 3. CDP-цель контентной вкладки -------------------------------------------
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
const target = targets.find((t) => t.type === "page" && t.url.startsWith(pageUrl));
if (!target) throw new Error("CDP-цель вкладки не найдена: " + targets.map((t) => t.url).join(", "));

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
const tab = connect(target.webSocketDebuggerUrl);

const evalIn = async (ws, expression) => {
  const r = await Promise.race([
    ws.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("evalIn timeout 25s: " + expression.slice(0, 80))), 25000)),
  ]);
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

const seekTo = (ws, t) =>
  evalIn(
    ws,
    `(async () => {
       const v = document.getElementById("v");
       if (Math.abs(v.currentTime - ${t}) >= 0.001) {
         await new Promise((res) => {
           const done = () => { v.removeEventListener("seeked", done); res(); };
           v.addEventListener("seeked", done);
           v.currentTime = ${t};
         });
       }
       return v.currentTime;
     })()`,
  );

const stateOf = (ws) => evalIn(ws, `window.__duopulseContent?.state() ?? null`);

/** Синтетический drag&drop (паттерн run.mjs): настоящий File страницы. */
const dragFiles = (ws, type, files) =>
  evalIn(
    ws,
    `(function () {
       const dt = new DataTransfer();
       for (const f of ${JSON.stringify(files)}) dt.items.add(new File([f.text], f.name, { type: "text/plain" }));
       return window.dispatchEvent(new DragEvent(${JSON.stringify(type)}, { dataTransfer: dt, bubbles: true, cancelable: true }));
     })()`,
  );

// --- 4. проверки ---------------------------------------------------------------
try {
  await waitForPage(tab, `!!window.__duopulseContent && !!document.getElementById("v")`, 15000, "бандл и видео");
  await waitForPage(tab, `window.__duopulseContent.state().videoKey?.startsWith("url:")`, 10000, "детект видео");

  const assText = fs.readFileSync(path.join(ROOT, "e2e", "fixtures", "subtitles", "sample.ass"), "utf8");

  // (1) подсказка дроп-зоны упоминает .ass
  await dragFiles(tab, "dragenter", [{ name: "anime.ru.ass", text: "x" }]);
  await sleep(150);
  const hintText = await evalIn(tab, `document.querySelector("[data-duopulse-dropzone]")?.textContent ?? ""`);
  check("подсказка дропа упоминает .ass (расширение признано)", hintText.includes(".ass"), hintText);
  await evalIn(tab, `window.dispatchEvent(new DragEvent("dragleave", { bubbles: true, cancelable: true }))`);

  // (2) дроп фикстуры sample.ass → дорожка с чистым текстом и topStarts
  const logBefore = appLog.length;
  const swallowed = await dragFiles(tab, "drop", [{ name: "Знак_школы.ass", text: assText }]);
  await waitForPage(tab, `window.__duopulseContent?.state().fileTracks.length === 1`, 8000, "файловая дорожка .ass");
  const st = await stateOf(tab);
  const track = st.fileTracks[0];
  check(
    "дроп .ass поглощён и разобран в Core: 6 cue (рисунок/Comment выброшены)",
    swallowed === false && track.id === "file:Знак_школы" && track.cues === 6,
    JSON.stringify(track),
  );
  // Точность разбора (теги вырезаны, nbsp, \N) — cargo-тест фикстуры
  // sample.ass; здесь — сквозной транспорт до дорожки и оверлея.
  check(
    "topStarts (\\an7/8/9) дошёл до дорожки: [1000, 16000]",
    JSON.stringify(track.topStarts) === JSON.stringify([1000, 16000]),
    JSON.stringify(track.topStarts),
  );
  const logSlice = appLog.slice(logBefore).join("");
  check("Core зафиксировал file-tracks (telemetry)", logSlice.includes("file-tracks"), logSlice.slice(-200));

  // (3) оверлей: 2.0 c — знак {\an8} в плашке-верху, табличка в основной
  await seekTo(tab, 2.0);
  await sleep(250);
  const plates = await evalIn(
    tab,
    `(function () {
       const c = document.querySelector("[data-duopulse-subtitles]");
       const plates = c ? Array.from(c.children) : [];
       return plates.map((p) => ({ display: p.style.display, pos: p.style.position, text: p.innerText }));
     })()`,
  );
  const main = plates[0] ?? {};
  const top = plates[1] ?? {};
  // Знак (1–3 с) и табличка (1,5–3,5 с) перекрываются — движок смёржил их
  // в один cue (docs/03 §4), флаг верха — по старту слитого cue (старт знака
  // в topStarts) → слитая реплика целиком в плашке-верху (v1, duopulse-178).
  check(
    "оверлей: {\an8}-знак — в плашке-верху (position:absolute у верхнего края); перекрытие со табличкой смёржено туда же",
    top.display !== "none" &&
      top.pos === "absolute" &&
      (top.text ?? "").includes("ШКОЛА АРИСУ — эпизод 1") &&
      (top.text ?? "").includes("Табличка у входа"),
    JSON.stringify(plates),
  );

  // скриншот с обеими плашками
  const shot = await tab.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT_DIR, "ass-last-run.png"), Buffer.from(shot.data, "base64"));

  // (4) 4.5 c — только нижние реплики: плашка-верх спрятана
  await seekTo(tab, 4.5);
  await sleep(250);
  const st45 = await evalIn(
    tab,
    `(function () {
       const c = document.querySelector("[data-duopulse-subtitles]");
       const plates = c ? Array.from(c.children) : [];
       return { top: plates[1]?.style.display ?? "?", main: plates[0]?.innerText ?? "" };
     })()`,
  );
  check(
    "без верхних реплик плашка-верх скрыта (display:none), основная показывает диалог",
    st45.top === "none" && st45.main.includes("Привет!"),
    JSON.stringify(st45),
  );

  // (5) 17 c — верхняя реплика снова показана
  await seekTo(tab, 17.0);
  await sleep(250);
  const st17 = await evalIn(
    tab,
    `(function () {
       const c = document.querySelector("[data-duopulse-subtitles]");
       const plates = c ? Array.from(c.children) : [];
       return { top: plates[1]?.innerText ?? "", topDisplay: plates[1]?.style.display ?? "?" };
     })()`,
  );
  check(
    "финальный {\an8}-знак — снова в плашке-верху",
    st17.topDisplay !== "none" && st17.top.includes("Конец серии"),
    JSON.stringify(st17),
  );

  // (6) .srt после .ass не ломается: замещает файловую часть набора
  const srtText = "1\n00:00:01,000 --> 00:00:03,000\nФайл: русская реплика\n";
  await dragFiles(tab, "drop", [{ name: "movie.ru.srt", text: srtText }]);
  await waitForPage(tab, `window.__duopulseContent?.state().fileTracks.length === 1 && window.__duopulseContent.state().fileTracks[0].id === "file:ru"`, 8000, "замещение .srt");
  const stSrt = await stateOf(tab);
  check(
    "дроп .srt после .ass замещает файловую часть (file:ru, текст без изменений)",
    stSrt.fileTracks[0].cues === 1,
    JSON.stringify(stSrt.fileTracks[0]),
  );
} finally {
  // --- 5. уборка ---------------------------------------------------------------
  fs.writeFileSync(path.join(OUT_DIR, "ass-last-run.json"), JSON.stringify({ started: new Date().toISOString(), url: pageUrl, results }, null, 2));
  tab.close();
  await killOurExes();
  try {
    vite.kill();
    await run("powershell", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*vite*' -and $_.ExecutablePath -like '*node*' } | Where-Object { $_.CommandLine -like '*DuoPulse*' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }`]);
  } catch {
    /* npm-оболочку уже убили */
  }
  httpServer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? `\nOK: ${results.length}/${results.length}` : `\nПРОВАЛОВ: ${failed.length}/${results.length}`);
process.exit(failed.length === 0 ? 0 : 1);
