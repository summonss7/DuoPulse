// E2E-прогон задачи 3.2 «content: детектор видео + каркас движка cue-таймлайна»
// (карточка duopulse-023). На реальном приложении (debug-exe + vite dev):
//   1) content-бандл исполняется в контентной вкладке (окно диагностики
//      window.__duopulseContent);
//   2) тест-дорожка доходит до движка (custom-событие duopulse-test-track);
//   3) детектор находит <video> (ключ url:…), событие доходит до Core
//      (метка [subtitles] в журнале приложения = эмит page:video_detected);
//   4) overlay показывает тест-cue точно по времени: границы начала/конца,
//      правило 150 мс при seek, смёрженное перекрытие, пауза;
//   5) offset (±мс) сдвигает показ;
//   6) seek вперёд/назад не оставляет «призраков» cue;
//   7) реальное воспроизведение: cue появляется по timeupdate без seek;
//   8) MutationObserver: удаление/добавление <video> перевязывает движок;
//   9) SPA-переход (pushState на /watch?v=…) пересчитывает ключ видео (yt:…);
//  10) скриншот плашки над роликом (счётчик кадров testsrc = визуальная
//      сверка таймингов).
// Задача 3.4 (полный оверлей, карточка duopulse-025):
//  11) набор из 3 дорожек: стили строк по гайду 06 §6 (белый 500 / лайм
//      #BDFE4F 85% / приглушённые 75%, обводка 2px) и плашка (градиент,
//      радиус 6, blur 2, ≤80% ширины видео) + скриншот;
//  12) позиция top с отступом 6% высоты видео, по центру;
//  13) колесо над плашкой — кегль +10% (Shift — сдвиг +100 мс);
//  14) смена смежного cue без миганий: контейнер и узлы строк не пересоздаются;
//  15) гашение нативных <track>-субтитров на время показа и возврат
//      при выключении (docs/03 §2).
//
// CDP подключается к контентной вкладке (спящий режим выключен
// DUOPULSE_SLEEP_AFTER_SECS=0 — отладчик не мешает).
//
// Запуск:  node e2e/subtitles/run.mjs [путь-к-duopulse.exe]
// Требует собранный debug-exe (cargo build) и запускает vite dev сам.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createReadStream, statSync } from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const CDP_PORT = 9233;
const HTTP_PORT = 8897;
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

// --- 1. локальный http-стенд: тест-страница + видео (Range обязателен) ------
const ROOT_WWW = path.join(ROOT, "e2e", "subtitles");
const MIME = { ".html": "text/html; charset=utf-8", ".mp4": "video/mp4", ".vtt": "text/vtt; charset=utf-8" };
const httpServer = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = path.join(
    ROOT_WWW,
    path.normalize(urlPath).replace(/^([/\\]|\.\.)+/, "") || "testpage.html",
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
      "Accept-Ranges": "bytes",
    });
    createReadStream(file).pipe(res);
  }
});
await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${HTTP_PORT}/`;

// --- 2. изолированный профиль + приложение ------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-subtitles-e2e-"));
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
  stdio: ["ignore", "ignore", "pipe"], // stderr — метки [subtitles] из Core
  env: {
    ...process.env,
    APPDATA: tmp,
    DUOPULSE_START_URL: pageUrl,
    DUOPULSE_ADBLOCK_LISTS: "", // без списков: стенду не нужна сеть
    DUOPULSE_SLEEP_AFTER_SECS: "0", // отладчик на вкладке + сон несовместимы
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

/** Ждать условие в контексте страницы (опрос 100 мс — реакции бандла быстрые). */
const waitForPage = async (ws, expr, timeoutMs, what) => {
  const t0 = Date.now();
  for (;;) {
    const v = await evalIn(ws, expr);
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`не дождались: ${what}`);
    await sleep(100);
  }
};

/** Seek в странице: обещание резолвится после события seeked видео. */
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
const overlayText = (ws) =>
  evalIn(ws, `document.querySelector("[data-duopulse-subtitles]")?.innerText ?? ""`);

/** Применить window.__DUOPULSE_TEST_TRACK__ (глобал оставляет инлайн-скрипт
 * страницы). Смена videoKey чистит набор (привязка к видео, docs/03 §6),
 * поэтому ранер задаёт дорожку в детерминированные моменты — после
 * успокоения детектора, а не инлайн-скриптом при разборе (гонка с очисткой). */
const applyTestTrack = (ws) =>
  evalIn(ws, `(function () { document.dispatchEvent(new CustomEvent("duopulse-test-track")); return true; })()`);

let failures = 0;
try {
  const target = targets.find((t) => t.type === "page" && t.url.startsWith(pageUrl));
  if (!target) throw new Error("CDP-цель вкладки не найдена: " + targets.map((t) => t.url).join(", "));
  const tab = connect(target.webSocketDebuggerUrl);

  // Бандл + метаданные видео должны быть готовы до проверок таймингов.
  await waitForPage(tab, `typeof window.__duopulseContent === "object"`, 10000, "content-бандл");
  check(
    "content-бандл исполнился в контентной вкладке (окно __duopulseContent)",
    (await evalIn(tab, `typeof window.__duopulseContent`)) === "object",
  );
  await waitForPage(tab, `document.getElementById("v")?.readyState >= 1`, 10000, "метаданные видео");
  await applyTestTrack(tab); // после loadedmetadata-уточнения ключа (см. выше)

  // (1) тест-дорожка дошла до движка
  await waitForPage(tab, `window.__duopulseContent?.state().engine.trackCount === 1`, 5000, "trackCount=1");
  check("тест-дорожка загружена в движок (duopulse-test-track)", (await stateOf(tab)).engine.trackCount === 1);

  // (2) детектор: ключ видео url:… (+ длительность после loadedmetadata)
  const s0 = await stateOf(tab);
  check(
    "детектор нашёл <video>, ключ url:… с длительностью",
    typeof s0.videoKey === "string" && s0.videoKey.startsWith(`url:${pageUrl}`) && s0.videoKey.endsWith(":30"),
    s0.videoKey,
  );

  // (3) событие дошло до Core (метка обработчика = источник page:video_detected)
  await sleep(500);
  const logText = appLog.join("");
  check(
    "Core получил детект и эмитит page:video_detected ([subtitles] в журнале)",
    logText.includes("[subtitles] video detected"),
    logText.split("\n").find((l) => l.includes("[subtitles]")) ?? "",
  );

  // (4) cue точно по времени: границы, правило 150 мс, пауза
  await seekTo(tab, 2.0);
  let text = await overlayText(tab);
  check("cue A в середине реплики (t=2,0)", text.includes("Первая реплика"), JSON.stringify(text));

  await seekTo(tab, 0.8);
  check("до начала cue A (t=0,8) — плашки нет", (await stateOf(tab)).engine.activeRows.length === 0);

  await seekTo(tab, 2.8); // до конца A остаётся 200 мс ≥ 150 — показать
  check("seek с остатком 200 мс — cue A показывается", (await overlayText(tab)).includes("Первая реплика"));

  await seekTo(tab, 2.99); // остаток 10 мс < 150 — не показывать
  check(
    "seek в хвост cue A (остаток 10 мс < 150) — не показывается",
    (await stateOf(tab)).engine.activeRows.length === 0,
  );

  await seekTo(tab, 4.0);
  text = await overlayText(tab);
  check("смежный cue B (t=4,0) — не слит с A", text.includes("Вторая реплика") && !text.includes("Первая"), JSON.stringify(text));

  await seekTo(tab, 7.5);
  text = await overlayText(tab);
  check(
    "перекрывающиеся cue смёржены (t=7,5 — обе строки одной плашкой)",
    text.includes("начало перекрытия") && text.includes("перекрывающий хвост"),
    JSON.stringify(text),
  );

  await seekTo(tab, 10.5);
  check("пауза между cue (t=10,5) — пусто", (await stateOf(tab)).engine.activeRows.length === 0);

  // (5) offset: +500 мс сдвигает показ позже
  await evalIn(tab, `document.dispatchEvent(new CustomEvent("duopulse-test-offset", { detail: { offsetMs: 500 } }))`);
  await seekTo(tab, 1.4); // без сдвига реплика уже идёт — со сдвигом ещё нет
  check("offset +500: t=1,4 — cue A ещё не показан", (await stateOf(tab)).engine.activeRows.length === 0);
  await seekTo(tab, 1.6);
  check("offset +500: t=1,6 — cue A показан", (await overlayText(tab)).includes("Первая реплика"));
  await evalIn(tab, `document.dispatchEvent(new CustomEvent("duopulse-test-offset", { detail: { offsetMs: 0 } }))`);

  // (6) seek вперёд/назад — призраков нет
  await seekTo(tab, 13.0);
  text = await overlayText(tab);
  check("cue D (t=13,0)", text.includes("Финальная реплика"), JSON.stringify(text));
  await seekTo(tab, 2.0);
  text = await overlayText(tab);
  check(
    "seek назад (13→2 с): ровно одна реплика, призраков нет",
    text.includes("Первая реплика") && !text.includes("Финальная"),
    JSON.stringify(text),
  );

  // (7) реальное воспроизведение: cue приходит по timeupdate без seek
  await evalIn(
    tab,
    `(async () => {
       const v = document.getElementById("v");
       v.currentTime = 0.95;
       await new Promise((res) => { const d = () => { v.removeEventListener("seeked", d); res(); }; v.addEventListener("seeked", d); });
       await v.play();
       return true;
     })()`,
  );
  await waitForPage(
    tab,
    `window.__duopulseContent?.state().engine.activeRows.some((r) => r.text.includes("Первая реплика"))`,
    5000,
    "cue A при живом воспроизведении",
  );
  check(
    "живое воспроизведение: cue A появился по timeupdate (после 1,0 с)",
    (await stateOf(tab)).engine.activeRows.some((r) => r.text.includes("Первая реплика")),
  );
  await evalIn(tab, `document.getElementById("v").pause()`);

  // (8) MutationObserver: удаление и добавление <video>
  await evalIn(tab, `document.getElementById("v").remove()`);
  await waitForPage(tab, `window.__duopulseContent?.state().videoKey === null`, 5000, "videoKey=null после удаления");
  check("удаление <video> отвязало движок (videoKey=null)", (await stateOf(tab)).videoKey === null);
  await evalIn(
    tab,
    `(function () {
       const v = document.createElement("video");
       v.id = "v"; v.muted = true; v.controls = true; v.preload = "auto";
       v.src = "/assets/testsrc.mp4";
       const tr = document.createElement("track"); // как в исходной разметке (для 15)
       tr.src = "/assets/native.vtt"; tr.kind = "subtitles"; tr.srclang = "en"; tr.label = "Native test";
       v.appendChild(tr);
       document.body.appendChild(v);
       return true;
     })()`,
  );
  await waitForPage(tab, `window.__duopulseContent?.state().videoKey !== null`, 5000, "повторный детект");
  const s8 = await stateOf(tab);
  check("MutationObserver: добавленный <video> подхвачен детектором", typeof s8.videoKey === "string" && s8.videoKey.startsWith(`url:${pageUrl}`), s8.videoKey);

  // (9) SPA-переход: pushState меняет URL без перезагрузки — детектор замечает
  // (опрос href) и пересчитывает ключ; Core переэмитит. yt:-маппинг watch?v=
  // покрыт юнит-тестами videoKeyFor: pushState не может сменить origin, здесь
  // хост остаётся 127.0.0.1 — ключ остаётся url:-вида с новым путём.
  await evalIn(tab, `history.pushState(null, "", "/watch?v=abc123XYZ")`);
  const spaKey = `url:${pageUrl}watch?v=abc123XYZ:30`;
  await waitForPage(tab, `window.__duopulseContent?.state().videoKey === ${JSON.stringify(spaKey)}`, 4000, "ключ после SPA");
  check(
    "SPA-переход (pushState /watch?v=) пересчитал ключ видео и переэмитил",
    (await stateOf(tab)).videoKey === spaKey,
  );

  // (10) скриншот: плашка над роликом (t=2,0 — счётчик кадров testsrc ≈ 60).
  // Возврат URL из SPA-стиля — детектор пересчитает ключ (очистив набор),
  // ждём успокоения и задаём дорожку заново.
  await evalIn(tab, `history.pushState(null, "", "/")`);
  await waitForPage(
    tab,
    `window.__duopulseContent?.state().videoKey === ${JSON.stringify(`url:${pageUrl}:30`)}`,
    4000,
    "ключ после возврата на /",
  );
  await applyTestTrack(tab);
  await seekTo(tab, 2.0);
  await sleep(300); // fade 80 мс
  const geom = await evalIn(
    tab,
    `(function () {
       const v = document.getElementById("v").getBoundingClientRect();
       const o = document.querySelector("[data-duopulse-subtitles]")?.getBoundingClientRect();
       if (!o) return null;
       return { video: { x: v.x, y: v.y, w: v.width, h: v.height },
                overlay: { x: o.x, y: o.y, w: o.width, h: o.height } };
     })()`,
  );
  check(
    "плашка геометрически поверх видео (rect плашки внутри rect видео)",
    !!geom &&
      geom.overlay.x >= geom.video.x - 1 &&
      geom.overlay.y >= geom.video.y - 1 &&
      geom.overlay.x + geom.overlay.w <= geom.video.x + geom.video.w + 1 &&
      geom.overlay.y + geom.overlay.h <= geom.video.y + geom.video.h + 1,
    geom ? JSON.stringify(geom.overlay) : "нет плашки",
  );
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const shot = await tab.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT_DIR, "shot-overlay.png"), Buffer.from(shot.data, "base64"));
  check(
    "скриншот с плашкой сохранён (e2e/subtitles/shot-overlay.png)",
    fs.existsSync(path.join(OUT_DIR, "shot-overlay.png")),
  );

  // ===== задача 3.4: полный оверлей (стили/позиция/колесо/гашение) ==========

  // (11) набор из 3 дорожек: стили строк по гайду 06 §6 и плашка (градиент,
  // радиус 6, blur 2, макс 80% ширины видео)
  await evalIn(
    tab,
    `(function () {
       window.__DUOPULSE_TEST_TRACK__ = [
         { id: "test:ru", source: "test", lang: "ru", role: "original", cues: [
           { startMs: 1000, endMs: 3000, text: "Оригинал: реплика A (1–3 с)" },
           { startMs: 3000, endMs: 5000, text: "Оригинал: реплика B (3–5 с)" } ] },
         { id: "test:en", source: "test", lang: "en", role: "translation", cues: [
           { startMs: 1000, endMs: 3000, text: "Original: line A (1–3 s)" },
           { startMs: 3000, endMs: 5000, text: "Original: line B (3–5 s)" } ] },
         { id: "test:es", source: "test", lang: "es", role: "translation", cues: [
           { startMs: 1000, endMs: 3000, text: "Original: línea A (1–3 s)" },
           { startMs: 3000, endMs: 5000, text: "Original: línea B (3–5 s)" } ] }
       ];
       document.dispatchEvent(new CustomEvent("duopulse-test-track"));
       return true;
     })()`,
  );
  await seekTo(tab, 2.0);
  const trio = await waitForPage(
    tab,
    `(function () {
       const rows = document.querySelectorAll("[data-duopulse-subtitles] .duopulse-subtitles-row");
       return rows.length === 3 && rows[2].textContent.includes("línea A") ? true : null;
     })()`,
    5000,
    "плашка из 3 строк",
  );
  const styles = await evalIn(
    tab,
    `(function () {
       const plate = document.querySelector("[data-duopulse-subtitles] > div");
       const rows = document.querySelectorAll("[data-duopulse-subtitles] .duopulse-subtitles-row");
       const v = document.getElementById("v").getBoundingClientRect();
       const cs = rows.length === 3 ? [0, 1, 2].map((i) => getComputedStyle(rows[i])) : [];
       return {
         rows: rows.length,
         texts: Array.from(rows).map((r) => r.textContent),
         colors: cs.map((c) => c.color),
         weights: cs.map((c) => c.fontWeight),
         sizes: cs.map((c) => parseFloat(c.fontSize)),
         stroke: cs.length ? cs[0].webkitTextStrokeWidth : null,
         radius: plate ? getComputedStyle(plate).borderTopLeftRadius : null,
         blur: plate ? getComputedStyle(plate).backdropFilter : null,
         bg: plate ? getComputedStyle(plate).backgroundImage : null,
         plateW: plate ? plate.getBoundingClientRect().width : 0,
         videoW: v.width,
       };
     })()`,
  );
  check(
    "3 строки набора: тексты дорожек по порядку",
    trio === true && styles.rows === 3 && styles.texts[0].includes("Оригинал") && styles.texts[1].includes("Original: line") && styles.texts[2].includes("línea"),
    JSON.stringify(styles.texts),
  );
  check(
    "стили строк по гайду 06 §6: белый 500 / лайм #BDFE4F 85% / приглушённые 75%",
    styles.colors[0] === "rgb(255, 255, 255)" &&
      styles.colors[1] === "rgb(189, 254, 79)" &&
      styles.colors[2] === "rgba(255, 255, 255, 0.75)" &&
      styles.weights[0] === "500" &&
      Math.abs(styles.sizes[1] / styles.sizes[0] - 0.85) < 0.02 &&
      Math.abs(styles.sizes[2] / styles.sizes[0] - 0.75) < 0.02,
    `цвета ${styles.colors.join(" | ")}; кегли ${styles.sizes.map((s) => s.toFixed(1)).join("/")}`,
  );
  check(
    "плашка по гайду 06 §6: обводка 2px, радиус 6px, blur(2px), градиент, ≤80% ширины видео",
    styles.stroke === "2px" &&
      styles.radius === "6px" &&
      String(styles.blur).includes("blur(2px)") &&
      String(styles.bg).includes("linear-gradient") &&
      styles.plateW <= styles.videoW * 0.8 + 1,
    `stroke=${styles.stroke} radius=${styles.radius} blur=${styles.blur} plate=${styles.plateW.toFixed(0)}/${styles.videoW.toFixed(0)}`,
  );
  fs.mkdirSync(OUT_DIR, { recursive: true });
  {
    const shot3 = await tab.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT_DIR, "shot-overlay-3rows.png"), Buffer.from(shot3.data, "base64"));
    check("скриншот trio-плашки сохранён (shot-overlay-3rows.png)", fs.existsSync(path.join(OUT_DIR, "shot-overlay-3rows.png")));
  }

  // (12) позиция: верх по центру с отступом 6% высоты видео (docs/03 §5)
  await evalIn(tab, `document.dispatchEvent(new CustomEvent("duopulse-test-style", { detail: { position: "top" } }))`);
  const topGeom = await evalIn(
    tab,
    `(function () {
       const v = document.getElementById("v").getBoundingClientRect();
       const o = document.querySelector("[data-duopulse-subtitles] > div").getBoundingClientRect();
       return { videoY: v.y, videoH: v.height, plateY: o.y, cx: o.x + o.width / 2, videoCX: v.x + v.width / 2 };
     })()`,
  );
  const topMargin = topGeom.plateY - topGeom.videoY;
  check(
    "позиция top: плашка у верха видео, отступ 6% высоты, по центру",
    topMargin >= 0.06 * topGeom.videoH - 2 && topMargin <= 0.06 * topGeom.videoH + 8 && Math.abs(topGeom.cx - topGeom.videoCX) < 4,
    `отступ ${topMargin.toFixed(1)}px (6% = ${(0.06 * topGeom.videoH).toFixed(1)}), центр ${topGeom.cx.toFixed(0)} vs ${topGeom.videoCX.toFixed(0)}`,
  );
  await evalIn(tab, `document.dispatchEvent(new CustomEvent("duopulse-test-style", { detail: { position: "bottom" } }))`);

  // (13) колесо мыши над плашкой: кегль ±10% (75–300), Shift — сдвиг (docs/03 §8)
  const baseSize = styles.sizes[0];
  const wheeled = await evalIn(
    tab,
    `(function () {
       const plate = document.querySelector("[data-duopulse-subtitles] > div");
       const r = plate.getBoundingClientRect();
       const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
       const el = document.elementFromPoint(cx, cy) || document.getElementById("v");
       el.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
       return true;
     })()`,
  );
  const afterWheel = await evalIn(
    tab,
    `(function () {
       const row = document.querySelector("[data-duopulse-subtitles] .duopulse-subtitles-row");
       return { scale: window.__duopulseContent.state().style.fontScalePct, size: parseFloat(getComputedStyle(row).fontSize) };
     })()`,
  );
  check(
    "колесо над плашкой: масштаб 100→110%, кегль вырос ~на 10%",
    wheeled === true && afterWheel.scale === 110 && afterWheel.size > baseSize * 1.08,
    `scale=${afterWheel.scale}, ${baseSize.toFixed(1)}→${afterWheel.size.toFixed(1)}px`,
  );
  await evalIn(
    tab,
    `(function () {
       const plate = document.querySelector("[data-duopulse-subtitles] > div");
       const r = plate.getBoundingClientRect();
       const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
       const el = document.elementFromPoint(cx, cy) || document.getElementById("v");
       el.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, clientX: cx, clientY: cy, bubbles: true, cancelable: true, shiftKey: true }));
       return true;
     })()`,
  );
  check(
    "Shift+колесо: сдвиг синхронизации +100 мс (docs/03 §8)",
    (await stateOf(tab)).engine.offsetMs === 100,
    `offsetMs=${(await stateOf(tab)).engine.offsetMs}`,
  );
  await evalIn(tab, `document.dispatchEvent(new CustomEvent("duopulse-test-offset", { detail: { offsetMs: 0 } }))`);
  await evalIn(tab, `document.dispatchEvent(new CustomEvent("duopulse-test-style", { detail: { fontScalePct: 100 } }))`);

  // (14) без миганий: смена cue не пересоздаёт контейнер/строки, fade не мигает
  // (идентичность узлов проверяется метками: returnByValue CDP узлы не несёт)
  await evalIn(
    tab,
    `(function () {
       const c = document.querySelector("[data-duopulse-subtitles]");
       c.dataset.dpE2eMark = "container";
       c.querySelector(".duopulse-subtitles-row").dataset.dpE2eMark = "row0";
       return c.querySelector(".duopulse-subtitles-row").textContent;
     })()`,
  );
  const textBefore = await overlayText(tab);
  await seekTo(tab, 4.0); // реплика B (смежная с A, без паузы)
  const switchState = await evalIn(
    tab,
    `(function () {
       const c = document.querySelector("[data-duopulse-subtitles]");
       const row0 = c.querySelector(".duopulse-subtitles-row");
       return {
         containerMarked: c.dataset.dpE2eMark === "container",
         rowMarked: row0.dataset.dpE2eMark === "row0",
         rowCount: c.querySelectorAll(".duopulse-subtitles-row").length,
         opacity: getComputedStyle(c).opacity,
         text: row0.textContent,
       };
     })()`,
  );
  check(
    "смена смежного cue без миганий: тот же контейнер и узел строки, opacity 1",
    switchState.containerMarked &&
      switchState.rowMarked &&
      switchState.opacity === "1" &&
      textBefore.includes("реплика A") &&
      switchState.text.includes("реплика B"),
    `${JSON.stringify(textBefore.split("\n")[0])} → ${JSON.stringify(switchState.text)}`,
  );

  // (15) гашение нативных субтитров, пока активен наш показ (docs/03 §2)
  await waitForPage(tab, `document.getElementById("v").textTracks.length >= 1`, 5000, "native <track> загружен");
  await evalIn(
    tab,
    `(function () {
       document.getElementById("v").textTracks[0].mode = "showing";
       return true;
     })()`,
  );
  await evalIn(tab, `document.dispatchEvent(new CustomEvent("duopulse-test-track"))`); // пере-blank скроет включённую нативную дорожку
  await sleep(200);
  const nativeHidden = await evalIn(
    tab,
    `(function () {
       const modes = Array.from(document.getElementById("v").textTracks).map((t) => t.mode);
       return { modes, blanked: window.__duopulseContent.state().nativeBlanked };
     })()`,
  );
  check(
    "нативные <track>-субтитры погашены на время показа (showing → hidden)",
    nativeHidden.blanked === true && nativeHidden.modes[0] === "hidden",
    JSON.stringify(nativeHidden),
  );
  await evalIn(
    tab,
    `(function () {
       window.__DUOPULSE_TEST_TRACK__ = { clear: true };
       document.dispatchEvent(new CustomEvent("duopulse-test-track"));
       return true;
     })()`,
  );
  await sleep(200);
  const nativeBack = await evalIn(
    tab,
    `(function () {
       const modes = Array.from(document.getElementById("v").textTracks).map((t) => t.mode);
       return { modes, blanked: window.__duopulseContent.state().nativeBlanked };
     })()`,
  );
  check(
    "выключение показа возвращает нативные субтитры (hidden → showing)",
    nativeBack.blanked === false && nativeBack.modes[0] === "showing",
    JSON.stringify(nativeBack),
  );

  tab.close();
} catch (e) {
  failures++;
  console.error("E2E ERROR:", e.message);
} finally {
  app.kill("SIGKILL");
  await killOurExes();
  const subLog = appLog.join("").split("\n").filter((l) => l.includes("[subtitles]"));
  if (subLog.length) console.log("\n--- журнал приложения ([subtitles]) ---\n" + subLog.slice(-8).join("\n"));
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
console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES: " + failed} (${results.length} проверок)`);
process.exit(failed === 0 ? 0 : 1);
