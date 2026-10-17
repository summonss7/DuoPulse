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
// Задача 3.5 (синхронизация, карточка duopulse-026):
//  16) покадровая подписка rVFC активна (docs/03 §4 п.1);
//  17) HUD сдвига: значение «+0,3 с», слайдер ±10 с/шаг 100, сброс,
//      автоскрытие; ввод слайдера применяет offset;
//  18) горячие клавиши Alt+[ / Alt+] — шаг ±100 мс, событие поглощается;
//  19) IPC subtitles.set_offset сквозно: UI → Core → eval → content;
//  20) серия быстрых seek: каждый раз ровно ожидаемая реплика, призраков нет;
//  21) кламп offset в ±10 с;
//  22) смена качества: смена src того же <video> и пересоздание элемента
//      с тем же videoKey — набор дорожек не теряется, показ продолжается.
// Задача 3.6 (ручные субтитры, карточка duopulse-027; docs/03 §3.2):
//  23) подсказка при переносе файлов (dragenter → «Отпустите…», dragleave);
//  24) дроп 2 файлов .srt/.vtt — поглощение, разбор в Core, смешивание с
//      платформенной дорожкой в одном наборе (docs/01 F-06), журнал Core;
//  25) повторный дроп замещает файловую часть набора целиком;
//  26) чужой дроп (без .srt/.vtt) — странице, набор не трогаем;
//  27) лимит набора 3: лишний файл отброшен, телеметрия «сверх набора»;
//  28) сайт-2 (site2.html): видео в плеерной обвязке, файл без платформенных;
//  29) сайт-3 (site3.html): ленивый монтаж видео — дроп до детекта не наш,
//      после — смешивание с «платформенной» дорожкой;
//  30) панельный путь IPC subtitles.load_file: Core читает файл с диска,
//      ответ команды (name/cueCount/warnings), дорожка в наборе;
//  31) clearFiles снимает файловую часть, платформенная продолжает показ.
//		Дроп эмулируется синтетическим DragEvent на window с настоящим File
//		страницы (чтение текста + разбор в Core — путь реального дропа).
// Задача 3.7 (кнопка «duo» + панель, карточка duopulse-028; docs/03 §8):
//  32) IPC subtitles.list_tracks — снапшот сервисного состояния вкладки;
//  33) кнопка «duo» в навбаре: видна при видео с дорожками, data-count=1;
//  34) клик открывает панель (состав, тумблер, слайдер), Esc закрывает;
//  35) Alt+D в странице: выкл (набор помнят), событие via=alt-d, панель
//      закрылась, кнопка погасла;
//  36) Alt+D снова: последний набор восстановлен, панель открылась;
//  37) Alt+D из хрома (subtitles.toggle) + subtitles.set_enabled(true);
//  38) subtitles.remove_track: дорожка снята, кнопка скрылась;
//  39) subtitles.set_tracks fast-path: перестановка без перезагрузки;
//  40) панельные контроли: слайдер сдвига = offset, размер/позиция — стиль;
//  41) журнал событий subtitles:set_applied (dev-хук __duopulseSubtitlesEvents).
// Полировка 046 (авто-уменьшение кегля при переполнении, M5; docs/03 §5):
//  42) короткий trio-набор: кегль не тронут — авто-подгон не срабатывает;
//  43) три длинных многострочных cue: плашка ≤ 50% высоты видео, кегль
//      авто-уменьшен, ручной масштаб (100%) не изменился; скриншот;
//  44) возврат к коротким cue: кегль восстанавливается до базового;
//  45) колесо-размер поверх авто-подгона: масштаб учтён (110%), доля
//      держится; ручное 75% — заметно ниже авто-подгона.
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

  // ===== задача 3.5: синхронизация — rVFC, HUD, клавиши, IPC, seek, качество ====

  // Возвращаем одиночную тест-дорожку (после (11) глобал — trio-набор).
  await evalIn(
    tab,
    `(function () {
       window.__DUOPULSE_TEST_TRACK__ = {
         id: "test:ru", source: "test", lang: "ru", role: "original", cues: [
           { startMs: 1000, endMs: 3000, text: "Первая реплика (1,0–3,0 с)" },
           { startMs: 3000, endMs: 5000, text: "Вторая реплика (3,0–5,0 с)" },
           { startMs: 6000, endMs: 8000, text: "Третья: начало перекрытия" },
           { startMs: 7000, endMs: 9500, text: "…и её перекрывающий хвост" },
           { startMs: 12000, endMs: 15000, text: "Финальная реплика (12–15 с)" }
         ]
       };
       document.dispatchEvent(new CustomEvent("duopulse-test-track"));
       return true;
     })()`,
  );
  await waitForPage(tab, `window.__duopulseContent?.state().engine.trackCount === 1`, 5000, "trackCount=1 (3.5)");

  // (16) покадровая подписка (docs/03 §4 п.1): WebView2/Chromium даёт rVFC —
  // движок обязан тикать каждым кадром, а не только timeupdate (~4 Гц).
  check(
    "покадровая подписка rVFC активна на привязанном видео",
    (await stateOf(tab)).engine.frameCallback === true,
    `frameCallback=${(await stateOf(tab)).engine.frameCallback}`,
  );

  // (17) HUD сдвига: событие Core duopulse-set-offset применяет offset и
  // открывает HUD со слайдером (docs/03 §4 п.3, §8).
  await evalIn(tab, `document.dispatchEvent(new CustomEvent("duopulse-set-offset", { detail: { offsetMs: 300 } }))`);
  const hud = await evalIn(
    tab,
    `(function () {
       const root = document.querySelector("[data-duopulse-offset-hud]");
       if (!root) return null;
       const slider = root.querySelector("input[type=range]");
       return { opacity: getComputedStyle(root).opacity, text: root.innerText,
                value: slider.value, min: slider.min, max: slider.max, step: slider.step };
     })()`,
  );
  check(
    "HUD сдвига: «+0,3 с», слайдер ±10 с с шагом 100 мс",
    hud !== null &&
      hud.opacity === "1" &&
      hud.text.includes("+0,3 с") &&
      hud.value === "300" &&
      hud.min === "-10000" &&
      hud.max === "10000" &&
      hud.step === "100",
    JSON.stringify(hud),
  );
  // ввод слайдера применяет offset (без перезагрузки дорожек)
  await evalIn(
    tab,
    `(function () {
       const slider = document.querySelector("[data-duopulse-offset-hud] input[type=range]");
       slider.value = "700";
       slider.dispatchEvent(new Event("input", { bubbles: true }));
       return true;
     })()`,
  );
  check(
    "ввод слайдера HUD применяет offset (700 мс), набор дорожек жив",
    (await stateOf(tab)).engine.offsetMs === 700 && (await stateOf(tab)).engine.trackCount === 1,
    `offsetMs=${(await stateOf(tab)).engine.offsetMs}`,
  );
  await evalIn(tab, `document.querySelector("[data-duopulse-offset-hud] button").click()`);
  check("кнопка «Сброс» возвращает 0", (await stateOf(tab)).engine.offsetMs === 0);
  await sleep(2600); // автоскрытие HUD (2,4 с простоя)
  check("HUD автоскрывается после простоя", (await stateOf(tab)).offsetHudVisible === false);

  // (18) горячие клавиши Alt+[ / Alt+] (docs/03 §8): шаг 100 мс, keydown
  // поглощается (dispatchEvent возвращает false при preventDefault).
  const keyOk = await evalIn(
    tab,
    `document.dispatchEvent(new KeyboardEvent("keydown", { altKey: true, code: "BracketRight", cancelable: true }))`,
  );
  check(
    "Alt+] — сдвиг на +100 мс позже, событие поглощено",
    keyOk === false && (await stateOf(tab)).engine.offsetMs === 100,
    `dispatchEvent=${keyOk}, offsetMs=${(await stateOf(tab)).engine.offsetMs}`,
  );
  await evalIn(
    tab,
    `document.dispatchEvent(new KeyboardEvent("keydown", { altKey: true, code: "BracketLeft", cancelable: true }))`,
  );
  check("Alt+[ — сдвиг на 100 мс раньше", (await stateOf(tab)).engine.offsetMs === 0);
  await evalIn(tab, `document.dispatchEvent(new CustomEvent("duopulse-set-offset", { detail: { offsetMs: 0 } }))`);
  await sleep(2600);

  // (19) IPC subtitles.set_offset сквозно: UI-хук → tauri IPC → Core →
  // eval активной вкладки → duopulse-set-offset → движок + HUD.
  const uiTarget = targets.find((t) => t.type === "page" && /localhost:5173/.test(t.url));
  if (!uiTarget) throw new Error("UI-цель CDP не найдена (нужен vite dev): " + targets.map((t) => t.url).join(", "));
  const ui = connect(uiTarget.webSocketDebuggerUrl);
  await waitForPage(ui, `typeof window.__duopulse === "object"`, 10000, "bridge-хук window.__duopulse");
  await evalIn(ui, `window.__duopulse.subtitles.setOffset({ offsetMs: 500 })`);
  await waitForPage(tab, `window.__duopulseContent?.state().engine.offsetMs === 500`, 5000, "offset 500 через IPC");
  check(
    "IPC subtitles.set_offset: UI → Core → активная вкладка (offset 500, HUD открыт)",
    (await stateOf(tab)).engine.offsetMs === 500 && (await stateOf(tab)).offsetHudVisible === true,
    `offsetMs=${(await stateOf(tab)).engine.offsetMs}`,
  );
  ui.close();
  await evalIn(tab, `document.dispatchEvent(new CustomEvent("duopulse-set-offset", { detail: { offsetMs: 0 } }))`);
  await sleep(2600);

  // (20) seek-устойчивость: серия быстрых скачков — после каждого ровно
  // ожидаемая реплика (или пусто), призраков прошлых cue нет (DoD 3.5).
  const seekSeries = [
    [2.0, "Первая реплика"],
    [13.0, "Финальная реплика"],
    [7.5, "перекрывающий хвост"], // смёрженное перекрытие — обе строки
    [4.0, "Вторая реплика"],
    [14.96, null], // хвост финальной: остаток 40 мс < 150 — не показывать
    [10.5, null], // пауза между cue
  ];
  for (const [t, expected] of seekSeries) {
    await seekTo(tab, t);
    const text = await overlayText(tab);
    const ok = expected ? text.includes(expected) : (await stateOf(tab)).engine.activeRows.length === 0;
    check(`seek → t=${t.toFixed(2)} с: ${expected ? JSON.stringify(expected) : "пусто"}`, ok, JSON.stringify(text));
  }

  // (21) кламп offset в ±10 с (docs/03 §4)
  await evalIn(tab, `document.dispatchEvent(new CustomEvent("duopulse-set-offset", { detail: { offsetMs: 999999 } }))`);
  check("кламп: 999 999 мс → +10 000", (await stateOf(tab)).engine.offsetMs === 10000);
  await evalIn(tab, `document.dispatchEvent(new CustomEvent("duopulse-set-offset", { detail: { offsetMs: -999999 } }))`);
  check("кламп: −999 999 мс → −10 000", (await stateOf(tab)).engine.offsetMs === -10000);
  await evalIn(tab, `document.dispatchEvent(new CustomEvent("duopulse-set-offset", { detail: { offsetMs: 0 } }))`);
  await sleep(2600);

  // (22) смена качества (docs/03 §4: смена качества не рассинхронизирует
  // показ). Кейс A: тот же <video>, новый поток (src) — таймлайн тот же,
  // набор и привязка движка живут, показ продолжается.
  await evalIn(
    tab,
    `(async function () {
       const v = document.getElementById("v");
       v.src = "/assets/testsrc.mp4";
       await new Promise((res) => { const d = () => { v.removeEventListener("canplay", d); res(); }; v.addEventListener("canplay", d); });
       return true;
     })()`,
  );
  await seekTo(tab, 2.0);
  const sQuality = await stateOf(tab);
  check(
    "смена качества (новый src того же <video>): набор жив, cue по времени",
    sQuality.engine.trackCount === 1 && sQuality.engine.attached === true && (await overlayText(tab)).includes("Первая реплика"),
    `trackCount=${sQuality.engine.trackCount}, text=${JSON.stringify(await overlayText(tab))}`,
  );

  // Кейс B: плеер пересоздаёт <video> (тем же ключом videoKey) — набор
  // применяется из памяти, без повторного выбора дорожек.
  await evalIn(tab, `document.getElementById("v").remove()`);
  await waitForPage(tab, `window.__duopulseContent?.state().videoKey === null`, 5000, "videoKey=null после удаления");
  await evalIn(
    tab,
    `(function () {
       const v = document.createElement("video");
       v.id = "v"; v.muted = true; v.controls = true; v.preload = "auto";
       v.src = "/assets/testsrc.mp4";
       document.body.appendChild(v);
       return true;
     })()`,
  );
  await waitForPage(
    tab,
    `(function () {
       const s = window.__duopulseContent?.state();
       return s && typeof s.videoKey === "string" && s.videoKey.endsWith(":30") && s.engine.trackCount === 1 ? true : null;
     })()`,
    8000,
    "набор пережил пересоздание <video> (тот же videoKey)",
  );
  await waitForPage(tab, `document.getElementById("v")?.readyState >= 1`, 10000, "метаданные нового видео");
  await seekTo(tab, 2.0);
  const sRecreated = await stateOf(tab);
  check(
    "пересоздание <video> с тем же videoKey: набор восстановлен без повторного выбора, cue в такт",
    sRecreated.engine.trackCount === 1 && (await overlayText(tab)).includes("Первая реплика"),
    `trackCount=${sRecreated.engine.trackCount}, videoKey=${sRecreated.videoKey}`,
  );

  // ===== задача 3.6: ручные файлы — drag&drop .srt/.vtt + смешивание ==========

  /** Синтетический drag&drop (задача 3.6): событие на window — capture-слу-
   * шатель бандла; файл — настоящий File страницы, чтение текста и разбор в
   * Core идут тем же путём, что у дропа пользователя. Возвращает dispatchEvent
   * (false ⇢ preventDefault ⇢ дроп поглощён нами, странице не ушёл). */
  const dragFiles = (ws, type, files) =>
    evalIn(
      ws,
      `(function () {
         const dt = new DataTransfer();
         for (const f of ${JSON.stringify(files)}) dt.items.add(new File([f.text], f.name, { type: "text/plain" }));
         return window.dispatchEvent(new DragEvent(${JSON.stringify(type)}, { dataTransfer: dt, bubbles: true, cancelable: true }));
       })()`,
    );

  // (23) подсказка дропа: dragenter с файлами — плашка «Отпустите…» (гайд 06),
  // dragleave прячет. Сайт №1 — testpage (платформенная часть — test:ru с 22).
  await dragFiles(tab, "dragenter", [{ name: "movie.ru.srt", text: "x" }]);
  await sleep(150);
  check(
    "подсказка дропа при переносе файла (dragenter → плашка «Отпустите»)",
    (await stateOf(tab)).dropHintVisible === true &&
      (await evalIn(tab, `document.querySelector("[data-duopulse-dropzone]")?.textContent ?? ""`)).includes("Отпустите"),
  );
  await evalIn(tab, `window.dispatchEvent(new DragEvent("dragleave", { bubbles: true, cancelable: true }))`);
  await sleep(150);
  check("dragleave прячет подсказку", (await stateOf(tab)).dropHintVisible === false);

  // (24) дроп 2 файлов на видео с платформенной дорожкой — смешанный набор
  // из 3 строк (docs/01 F-06): платформенные + файловые, файлы в конец.
  const logBefore24 = appLog.length;
  const swallowed24 = await dragFiles(tab, "drop", [
    { name: "movie.ru.srt", text: "1\n00:00:01,000 --> 00:00:03,000\nФайл: русская реплика\n" },
    { name: "subs.en.vtt", text: "WEBVTT\n\n00:00:01.000 --> 00:00:03.500\nFile: English line\n" },
  ]);
  await waitForPage(tab, `window.__duopulseContent?.state().fileTracks.length === 2`, 5000, "файловые дорожки после дропа");
  await seekTo(tab, 2.0);
  const mix = await evalIn(
    tab,
    `(function () {
       const s = window.__duopulseContent.state();
       const rows = document.querySelectorAll("[data-duopulse-subtitles] .duopulse-subtitles-row");
       return { files: s.fileTracks, trackCount: s.engine.trackCount, texts: Array.from(rows).map((r) => r.textContent) };
     })()`,
  );
  check(
    "дроп 2 файлов (.srt + .vtt) поглощён и разобран в Core: file:ru + file:en по 1 cue",
    swallowed24 === false &&
      JSON.stringify(mix.files.map((t) => [t.id, t.lang, t.cues])) ===
        JSON.stringify([
          ["file:ru", "ru", 1],
          ["file:en", "en", 1],
        ]),
    JSON.stringify(mix.files),
  );
  check(
    "смешивание (docs/01 F-06): платформенная + 2 файловых = 3 строки по порядку набора",
    mix.trackCount === 3 &&
      mix.texts.length === 3 &&
      mix.texts[0].includes("Первая реплика") &&
      mix.texts[1].includes("Файл: русская") &&
      mix.texts[2].includes("File: English"),
    JSON.stringify(mix.texts),
  );
  await sleep(400); // WebMessage file-tracks → Core (журнал)
  check(
    "Core зафиксировал дроп ([subtitles] file-tracks … via drop)",
    appLog.slice(logBefore24).join("").includes("file-tracks: применено 2") &&
      appLog.slice(logBefore24).join("").includes("(drop"),
  );

  // (25) повторный дроп замещает файловую часть набора целиком
  await dragFiles(tab, "drop", [{ name: "replacer.de.srt", text: "1\n00:00:04,000 --> 00:00:06,000\nErsatz: deutsche Zeile\n" }]);
  await waitForPage(tab, `window.__duopulseContent?.state().fileTracks.length === 1`, 5000, "замещение файловой части");
  const s25 = await stateOf(tab);
  check(
    "повторный дроп замещает файловую часть целиком (осталась file:de)",
    s25.fileTracks.length === 1 && s25.fileTracks[0].id === "file:de" && s25.engine.trackCount === 2,
    JSON.stringify(s25.fileTracks),
  );

  // (26) чужой дроп (без .srt/.vtt) — странице: не поглощаем, набор не трогаем
  const alien = await dragFiles(tab, "drop", [
    { name: "photo.png", text: "\x89PNG" },
    { name: "notes.txt", text: "hello" },
  ]);
  await sleep(200);
  check(
    "дроп без .srt/.vtt не поглощается и набор не трогает (странице)",
    alien === true && (await stateOf(tab)).fileTracks.length === 1,
  );

  // (27) лимит набора 3: платформенная + 3 файла → показаны 2 файла, лишний
  // отброшен; телеметрия «сверх набора 1» (docs/03 §1 — набор 1–3).
  const logBefore27 = appLog.length;
  await dragFiles(tab, "drop", [
    { name: "a.ru.srt", text: "1\n00:00:01,000 --> 00:00:03,000\nПервый файл\n" },
    { name: "b.en.srt", text: "1\n00:00:01,000 --> 00:00:03,000\nSecond file\n" },
    { name: "c.es.srt", text: "1\n00:00:01,000 --> 00:00:03,000\nTercer fichero\n" },
  ]);
  await waitForPage(tab, `window.__duopulseContent?.state().fileTracks.length === 3`, 5000, "3 файловые построены");
  await sleep(400);
  const s27 = await stateOf(tab);
  check(
    "лимит набора ≤ 3: платформа + 3 файла → показ 3 строк (2 файла), лишний отброшен",
    s27.engine.trackCount === 3 && s27.fileTracks.length === 3,
    `trackCount=${s27.engine.trackCount}, файлов=${s27.fileTracks.length}`,
  );
  check(
    "отброшенный файл — телеметрия в Core ([subtitles] … сверх набора 1)",
    appLog.slice(logBefore27).join("").includes("сверх набора 1"),
    appLog.slice(logBefore27).join("").split("\n").find((l) => l.includes("file-tracks")) ?? "",
  );

  // (28) сайт №2 (site2.html): видео внутри плеерной обвязки; платформенных
  // дорожек нет — файл идёт сам (голый HTML5-видео, docs/03 §3.3).
  await evalIn(tab, `location.href = "/site2.html"`);
  await waitForPage(tab, `typeof window.__duopulseContent === "object"`, 10000, "бандл на сайте-2");
  await waitForPage(tab, `document.getElementById("v")?.readyState >= 1`, 10000, "метаданные на сайте-2");
  const key2 = await waitForPage(tab, `window.__duopulseContent?.state().videoKey`, 5000, "ключ видео сайта-2");
  check(
    "сайт-2: детектор нашёл видео в обвязке (ключ url:…site2.html…)",
    typeof key2 === "string" && key2.includes("site2.html"),
    key2,
  );
  await dragFiles(tab, "drop", [{ name: "film.fr.srt", text: "1\n00:00:01,000 --> 00:00:03,000\nFichier: ligne française\n" }]);
  await waitForPage(tab, `window.__duopulseContent?.state().fileTracks.length === 1`, 5000, "файл на сайте-2");
  await seekTo(tab, 2.0);
  check(
    "сайт-2: файл сам по себе (без платформенных) — 1 строка оверлея",
    (await stateOf(tab)).engine.trackCount === 1 && (await overlayText(tab)).includes("ligne française"),
    JSON.stringify(await overlayText(tab)),
  );

  // (29) сайт №3 (site3.html): ленивый монтаж видео — дроп до детекта не наш
  // (docs/03 §3.2 «на <video> найденного детектора»); после — смешивание
  // с «платформенной» дорожкой (тест-хук имитирует адаптер платформы).
  await evalIn(tab, `location.href = "/site3.html"`);
  await waitForPage(tab, `typeof window.__duopulseContent === "object"`, 10000, "бандл на сайте-3");
  const early = await dragFiles(tab, "drop", [{ name: "early.ru.srt", text: "1\n00:00:01,000 --> 00:00:03,000\nРано\n" }]);
  await sleep(200);
  check(
    "сайт-3: дроп до появления видео не поглощается (странице), набор пуст",
    early === true && (await stateOf(tab)).fileTracks.length === 0,
  );
  await waitForPage(tab, `window.__duopulseContent?.state().videoKey !== null`, 8000, "ленивое видео смонтировано");
  await waitForPage(tab, `document.getElementById("v")?.readyState >= 1`, 10000, "метаданные на сайте-3");
  await evalIn(
    tab,
    `(function () {
       window.__DUOPULSE_TEST_TRACK__ = {
         id: "test:ru", source: "test", lang: "ru", role: "original",
         cues: [{ startMs: 6000, endMs: 8000, text: "Платформенная реплика (6–8 с)" }]
       };
       document.dispatchEvent(new CustomEvent("duopulse-test-track"));
       return true;
     })()`,
  );
  await waitForPage(tab, `window.__duopulseContent?.state().engine.trackCount === 1`, 5000, "платформенная дорожка на сайте-3");
  await dragFiles(tab, "drop", [{ name: "movie.ru.srt", text: "1\n00:00:06,000 --> 00:00:08,000\nФайл: русская реплика (6–8 с)\n" }]);
  await waitForPage(tab, `window.__duopulseContent?.state().fileTracks.length === 1`, 5000, "файл на сайте-3");
  await seekTo(tab, 7.0);
  const mix3 = await overlayText(tab);
  check(
    "сайт-3: файл лёг поверх лениво смонтированного видео и смешан с платформенной дорожкой",
    mix3.includes("Платформенная реплика") && mix3.includes("Файл: русская реплика"),
    JSON.stringify(mix3),
  );

  // (30) панельный путь (IPC subtitles.load_file, docs/03 §3.2): Core читает
  // файл с диска (tmp-каталог стенда), доставляет cue событием
  // duopulse-file-track; дорожка замещает файловую часть набора.
  const panelPath = path.join(tmp, "panel.es.vtt");
  fs.writeFileSync(panelPath, "WEBVTT\n\n00:00:06.000 --> 00:00:08.000\nHola desde el panel\n");
  const ui2Target = targets.find((t) => t.type === "page" && /localhost:5173/.test(t.url));
  if (!ui2Target) throw new Error("UI-цель CDP не найдена (нужен vite dev): " + targets.map((t) => t.url).join(", "));
  const ui2 = connect(ui2Target.webSocketDebuggerUrl);
  await waitForPage(ui2, `typeof window.__duopulse === "object"`, 10000, "bridge-хук window.__duopulse");
  const loadRes = await evalIn(ui2, `window.__duopulse.subtitles.loadFile(${JSON.stringify({ path: panelPath })})`);
  await waitForPage(
    tab,
    `window.__duopulseContent?.state().fileTracks.length === 1 && window.__duopulseContent?.state().fileTracks[0].id === "file:es"`,
    5000,
    "панельный файл применён",
  );
  check(
    "IPC subtitles.load_file: ответ команды — имя, cueCount=1, без предупреждений",
    loadRes.name === "panel.es.vtt" && loadRes.cueCount === 1 && loadRes.warnings.length === 0,
    JSON.stringify(loadRes),
  );
  await seekTo(tab, 7.5);
  const panelMix = await overlayText(tab);
  check(
    "панельный файл в наборе с платформенной (заместил дроп): 2 строки",
    panelMix.includes("Платформенная реплика") && panelMix.includes("Hola desde el panel"),
    JSON.stringify(panelMix),
  );
  ui2.close();

  // Скриншот смешанного набора (платформенная + панельный файл) + (31) clearFiles
  await sleep(300); // fade плашки
  {
    const shotMix = await tab.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT_DIR, "shot-file-mix.png"), Buffer.from(shotMix.data, "base64"));
    check("скриншот смешанного набора сохранён (shot-file-mix.png)", fs.existsSync(path.join(OUT_DIR, "shot-file-mix.png")));
  }
  await evalIn(tab, `window.__duopulseContent.clearFiles()`);
  await sleep(150);
  const s31 = await stateOf(tab);
  const text31 = await overlayText(tab);
  check(
    "clearFiles: файловая часть снята, платформенная продолжает показ",
    s31.fileTracks.length === 0 && s31.engine.trackCount === 1 && text31.includes("Платформенная реплика") && !text31.includes("Hola"),
    `файлов=${s31.fileTracks.length}, текст=${JSON.stringify(text31)}`,
  );

  // ===== задача 3.7: кнопка «duo» + панель настроек набора (docs/03 §8) =====
  // Состояние сайта-3: видео детектировано, платформенная часть test:ru
  // (1 дорожка), файловые сняты. UI-хром — отдельная CDP-цель (vite dev).

  const ui3Target = targets.find((t) => t.type === "page" && /localhost:5173/.test(t.url));
  if (!ui3Target) throw new Error("UI-цель CDP не найдена: " + targets.map((t) => t.url).join(", "));
  const ui3 = connect(ui3Target.webSocketDebuggerUrl);
  await waitForPage(ui3, `typeof window.__duopulse === "object"`, 10000, "bridge-хук window.__duopulse");

  // (32) IPC subtitles.list_tracks: снапшот сервисного состояния активной
  // вкладки (сервис Core — кэш сообщений content-слоя).
  await sleep(400); // set-state сайта-3 долетел
  const snap = await evalIn(ui3, `window.__duopulse.subtitles.listTracks()`);
  check(
    "IPC subtitles.list_tracks: снапшот активной вкладки (видео, набор, стиль)",
    snap.videoKey === (await stateOf(tab)).videoKey &&
      snap.enabled === true &&
      snap.tracks.length === 1 &&
      snap.tracks[0].id === "test:ru" &&
      snap.tracks[0].source === "test" &&
      snap.style.fontScalePct === 100,
    JSON.stringify({ videoKey: snap.videoKey, tracks: snap.tracks.map((t) => t.id), enabled: snap.enabled }),
  );

  // (33) кнопка «duo»: видна (видео с дорожками), состояние «одна дорожка»
  // (docs/03 §8 п.1: выкл / одна / дуо / три).
  await sleep(300);
  const duoBtnState = await evalIn(
    ui3,
    `(function () { const b = document.getElementById("duoBtn"); return { hidden: b.hidden, count: b.dataset.count, pressed: b.getAttribute("aria-pressed") }; })()`,
  );
  check(
    "кнопка «duo» видна в навбаре, состояние «одна дорожка» (data-count=1)",
    duoBtnState.hidden === false && duoBtnState.count === "1" && duoBtnState.pressed === "true",
    JSON.stringify(duoBtnState),
  );

  // (34) клик по кнопке открывает панель настроек; Esc закрывает.
  await evalIn(ui3, `document.getElementById("duoBtn").click()`);
  await sleep(500); // refresh() панели (tabs.list + list_tracks)
  const panelOpen = await evalIn(
    ui3,
    `(function () {
       const p = document.getElementById("duoPanel");
       const set = Array.from(p.querySelectorAll("#duoSet .duo-row .duo-name")).map((n) => n.textContent);
       const slider = p.querySelector("#duoOffset");
       return { hidden: p.hidden, rows: set, offset: slider.value, checked: p.querySelector("#duoEnabled").checked };
     })()`,
  );
  check(
    "панель «duo» открылась: набор (test:ru), тумблер включён, слайдер сдвига 0",
    panelOpen.hidden === false &&
      panelOpen.rows.length === 1 &&
      panelOpen.offset === "0" &&
      panelOpen.checked === true,
    JSON.stringify(panelOpen),
  );
  await evalIn(ui3, `window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
  await sleep(150);
  check(
    "Esc закрывает панель",
    (await evalIn(ui3, `document.getElementById("duoPanel").hidden`)) === true,
  );

  // (35) Alt+D в контентной вкладке (docs/03 §8 п.2): выключить показ —
  // состав помнят обе стороны, событие subtitles:set_applied via=alt-d
  // доходит до UI, кнопка гаснет, панель закрывается за ним (карточка 028).
  const altOff = await evalIn(
    tab,
    `document.dispatchEvent(new KeyboardEvent("keydown", { altKey: true, code: "KeyD", cancelable: true }))`,
  );
  await waitForPage(tab, `window.__duopulseContent?.state().enabled === false`, 5000, "enabled=false");
  const offState = await stateOf(tab);
  const offUi = await evalIn(
    ui3,
    `(function () {
       const evs = (window.__duopulseSubtitlesEvents ?? []).filter((e) => e.kind === "set_applied");
       return { count: document.getElementById("duoBtn").dataset.count,
                panelHidden: document.getElementById("duoPanel").hidden,
                lastVia: evs.length ? evs[evs.length - 1].payload.via : null,
                lastEnabled: evs.length ? evs[evs.length - 1].payload.enabled : null };
     })()`,
  );
  check(
    "Alt+D в странице: показ выключен (набор движка 0, поглощено), Core событие via=alt-d",
    altOff === false && offState.enabled === false && offState.engine.trackCount === 0 && offUi.count === "0",
    `dispatch=${altOff}, count=${offUi.count}, via=${offUi.lastVia}`,
  );
  check(
    "кнопка «duo» погасла (data-count=0), панель закрылась, enabled=false в событии",
    offUi.count === "0" && offUi.panelHidden === true && offUi.lastEnabled === false,
    JSON.stringify(offUi),
  );

  // (36) Alt+D снова: включение восстанавливает последний набор (тот же id),
  // панель открывается (via=alt-d), показ в такт.
  await evalIn(tab, `document.dispatchEvent(new KeyboardEvent("keydown", { altKey: true, code: "KeyD", cancelable: true }))`);
  await waitForPage(tab, `window.__duopulseContent?.state().enabled === true && window.__duopulseContent?.state().engine.trackCount === 1`, 5000, "набор восстановлен");
  const onUi = await evalIn(
    ui3,
    `(function () { return { count: document.getElementById("duoBtn").dataset.count, panelHidden: document.getElementById("duoPanel").hidden }; })()`,
  );
  check(
    "Alt+D включил: последний набор восстановлен (test:ru), кнопка «дуо-режим», панель открылась",
    onUi.count === "1" && onUi.panelHidden === false,
    JSON.stringify(onUi),
  );

  // (37) Alt+D из хрома (IPC subtitles.toggle — фокус в UI): тот же эффект.
  await evalIn(ui3, `document.getElementById("duoBtn").click()`); // закрыть панель
  await sleep(150);
  const toggleViaChrome = await evalIn(
    ui3,
    `window.dispatchEvent(new KeyboardEvent("keydown", { altKey: true, code: "KeyD", cancelable: true }))`,
  );
  await waitForPage(tab, `window.__duopulseContent?.state().enabled === false`, 5000, "toggle из хрома");
  check(
    "Alt+D в хроме (subtitles.toggle): показ выключен",
    toggleViaChrome === false && (await stateOf(tab)).enabled === false,
  );
  await evalIn(ui3, `window.__duopulse.subtitles.setEnabled({ on: true })`);
  await waitForPage(tab, `window.__duopulseContent?.state().enabled === true`, 5000, "setEnabled(true)");

  // (38) subtitles.remove_track: снять дорожку панели («×») — набор пуст,
  // кнопка «duo» скрывается (видео без дорожек, docs/03 §8 п.1).
  await evalIn(ui3, `window.__duopulse.subtitles.removeTrack(${JSON.stringify({ id: "test:ru" })})`);
  await waitForPage(tab, `window.__duopulseContent?.state().engine.trackCount === 0`, 5000, "дорожка снята");
  await sleep(400);
  check(
    "subtitles.remove_track: дорожка снята, кнопка «duo» скрылась (нет дорожек)",
    (await stateOf(tab)).engine.trackCount === 0 &&
      (await evalIn(ui3, `document.getElementById("duoBtn").hidden`)) === true,
  );
  // вернуть платформенную часть тест-хуком (кнопка снова видна)
  await evalIn(tab, `document.dispatchEvent(new CustomEvent("duopulse-test-track"))`);
  await waitForPage(ui3, `document.getElementById("duoBtn").hidden === false && document.getElementById("duoBtn").dataset.count === "1"`, 5000, "кнопка вернулась");

  // (39) subtitles.set_tracks fast-path: тот же состав в новом порядке —
  // перестановка без перезагрузки (duo-набор из 2 тест-дорожек).
  await evalIn(
    tab,
    `(function () {
       window.__DUOPULSE_TEST_TRACK__ = [
         { id: "test:ru", source: "test", lang: "ru", role: "original",
           cues: [{ startMs: 6000, endMs: 8000, text: "Строка оригинала" }] },
         { id: "test:en", source: "test", lang: "en", role: "translation",
           cues: [{ startMs: 6000, endMs: 8000, text: "Translation line" }] }
       ];
       document.dispatchEvent(new CustomEvent("duopulse-test-track"));
       return true;
     })()`,
  );
  await waitForPage(tab, `window.__duopulseContent?.state().engine.trackCount === 2`, 5000, "duo-набор");
  await evalIn(ui3, `window.__duopulse.subtitles.setTracks(${JSON.stringify({ ids: ["test:en", "test:ru"] })})`);
  await waitForPage(tab, `window.__duopulseContent?.state().engine.trackCount === 2`, 5000, "перестановка жива");
  await seekTo(tab, 7.0);
  const reordered = await overlayText(tab);
  check(
    "subtitles.set_tracks (fast-path): перестановка набора без перезагрузки — первой строкой перевод",
    reordered.indexOf("Translation line") < reordered.indexOf("Строка оригинала"),
    JSON.stringify(reordered),
  );

  // (40) панельные контроли: слайдер синхронизации — тот же offset (docs/03
  // §8 п.5); размер и позиция — subtitles.set_style в оверлей.
  await evalIn(ui3, `document.getElementById("duoBtn").click()`);
  await sleep(400);
  await evalIn(
    ui3,
    `(function () {
       const s = document.getElementById("duoOffset");
       s.value = "400";
       s.dispatchEvent(new Event("change", { bubbles: true }));
       const scale = document.getElementById("duoScale");
       scale.value = "150";
       scale.dispatchEvent(new Event("change", { bubbles: true }));
       document.querySelector('#duoPosition button[data-pos="top"]').click();
       return true;
     })()`,
  );
  await waitForPage(tab, `window.__duopulseContent?.state().engine.offsetMs === 400`, 5000, "offset из панели");
  const styledState = await stateOf(tab);
  const styleEvents = await evalIn(
    ui3,
    `(window.__duopulseSubtitlesEvents ?? []).filter((e) => e.kind === "set_applied" && e.payload.via === "style").map((e) => e.payload.style.fontScalePct + "/" + e.payload.style.position)`,
  );
  check(
    "панель: слайдер сдвига задаёт тот же offset (400 мс), размер 150%, позиция top",
    styledState.engine.offsetMs === 400 && styledState.style.fontScalePct === 150 && styledState.style.position === "top",
    `offset=${styledState.engine.offsetMs}, scale=${styledState.style.fontScalePct}, pos=${styledState.style.position}, события стиля: ${JSON.stringify(styleEvents)}`,
  );
  // вернуть стиль/сдвиг (не мешать последующим проверкам)
  await evalIn(ui3, `window.__duopulse.subtitles.setOffset({ offsetMs: 0 })`);
  await evalIn(ui3, `window.__duopulse.subtitles.setStyle({ style: { fontScalePct: 100, position: "bottom" } })`);
  await waitForPage(tab, `window.__duopulseContent?.state().style.position === "bottom"`, 5000, "стиль возвращён");

  // (41) события Core: subtitles:set_applied накапливаются в dev-журнале UI
  // (все изменения 35–40 долетели с актуальным составом).
  const evLog = await evalIn(
    ui3,
    `(window.__duopulseSubtitlesEvents ?? []).filter((e) => e.kind === "set_applied").map((e) => e.payload.via + ":" + (e.payload.enabled ? "on" : "off") + ":" + e.payload.tracks.length)`,
  );
  check(
    "журнал событий subtitles:set_applied: alt-d/panel/remove/select с составами",
    evLog.includes("alt-d:off:1") && evLog.includes("alt-d:on:1") && evLog.includes("panel:on:1") && evLog.includes("remove:on:0") && evLog.includes("select:on:2"),
    JSON.stringify(evLog.slice(-8)),
  );

  // ===== полировка 046: авто-уменьшение кегля плашки при переполнении =====
  // Возврат на главную тест-страницу (видео 640px): короткий trio — кегль
  // не тронут; три длинных многострочных cue — плашка ≤ 50% высоты видео
  // (docs/03 §5, PLATE_MAX_SHARE), кегль авто-уменьшен, ручной масштаб
  // нетронут; колесо-размер работает поверх авто-подгона.
  ui3.close();
  await evalIn(tab, `location.href = "/"`);
  await waitForPage(tab, `typeof window.__duopulseContent === "object"`, 10000, "бандл после возврата (046)");
  await waitForPage(tab, `document.getElementById("v")?.readyState >= 1`, 10000, "метаданные видео (046)");
  await applyTestTrack(tab);
  await waitForPage(tab, `window.__duopulseContent?.state().engine.trackCount === 1`, 5000, "trackCount=1 (046)");

  /** Замер плашки: кегль первой строки, высоты плашки/видео, ручной масштаб. */
  const measurePlate = () =>
    evalIn(
      tab,
      `(function () {
         const plate = document.querySelector("[data-duopulse-subtitles] > div");
         const row = document.querySelector("[data-duopulse-subtitles] .duopulse-subtitles-row");
         const v = document.getElementById("v").getBoundingClientRect();
         return {
           font: row ? parseFloat(getComputedStyle(row).fontSize) : 0,
           plateH: plate ? plate.getBoundingClientRect().height : 0,
           videoH: v.height,
           scale: window.__duopulseContent.state().style.fontScalePct,
         };
       })()`,
    );

  /** Задать trio-набор (1–3 с) с заданными текстами строк. */
  const setTrio = (ru, en, es) =>
    evalIn(
      tab,
      `(function () {
         window.__DUOPULSE_TEST_TRACK__ = [
           { id: "test:ru", source: "test", lang: "ru", role: "original", cues: [
             { startMs: 1000, endMs: 3000, text: ${JSON.stringify(ru)} } ] },
           { id: "test:en", source: "test", lang: "en", role: "translation", cues: [
             { startMs: 1000, endMs: 3000, text: ${JSON.stringify(en)} } ] },
           { id: "test:es", source: "test", lang: "es", role: "translation", cues: [
             { startMs: 1000, endMs: 3000, text: ${JSON.stringify(es)} } ] }
         ];
         document.dispatchEvent(new CustomEvent("duopulse-test-track"));
         return true;
       })()`,
    );

  // (42) короткий trio: авто-подгон не срабатывает — кегль и вид без регресса
  const SHORT = ["Оригинал: короткая реплика", "Original: short line", "Original: línea corta"];
  await setTrio(...SHORT);
  await seekTo(tab, 2.0);
  await waitForPage(
    tab,
    `document.querySelectorAll("[data-duopulse-subtitles] .duopulse-subtitles-row").length === 3`,
    5000,
    "3 строки короткого набора (046)",
  );
  const shortM = await measurePlate();
  check(
    "(42) короткие cue: авто-подгон не срабатывает (плашка много меньше 50% видео, масштаб 100)",
    shortM.scale === 100 && shortM.plateH < 0.5 * shortM.videoH * 0.75 && shortM.font > 0,
    `plate=${shortM.plateH.toFixed(0)}px/${shortM.videoH.toFixed(0)}px, кегль ${shortM.font.toFixed(1)}px`,
  );

  // (43) три длинных многострочных cue: плашка в доле 50%, кегль авто-уменьшен.
  // Многострочность — явными \n (pre-wrap): 4/3/3 строки по дорожкам, каждая
  // строка короче ширины плашки — перенос от ширины не срабатывает, высота
  // строго линейна кеглю (подгон детерминирован, без «ступеней» переноса).
  const LONG_RU = "Первая строка длинной реплики оригинала,\nвторая строка переноса — плашка растёт,\nтретья строка: набор выше половины видео,\nчетвёртая строка — ждём авто-уменьшение кегля.";
  const LONG_EN = "First line of the long original speech,\nsecond wrapped line grows the plate,\nthird line — the set exceeds half of the video.";
  const LONG_ES = "Primera línea de la réplica larga,\nsegunda línea: la placa crece,\ntercera línea — pasada la mitad del vídeo.";
  await setTrio(LONG_RU, LONG_EN, LONG_ES);
  await seekTo(tab, 2.0);
  await waitForPage(
    tab,
    `(document.querySelector("[data-duopulse-subtitles] .duopulse-subtitles-row")?.textContent ?? "").includes("авто-уменьшение кегля")`,
    5000,
    "длинный набор показан (046)",
  );
  await sleep(300); // fade 80 мс + запас на итерации подгона
  const overM = await measurePlate();
  check(
    "(43) три длинных cue: плашка ≤ 50% высоты видео, кегль авто-уменьшен, ручной масштаб не тронут",
    overM.plateH <= 0.5 * overM.videoH + 2 && overM.font < shortM.font * 0.95 && overM.scale === 100,
    `plate=${overM.plateH.toFixed(0)}px/${overM.videoH.toFixed(0)}px (потолок ${(0.5 * overM.videoH).toFixed(0)}), кегль ${shortM.font.toFixed(1)}→${overM.font.toFixed(1)}px, scale=${overM.scale}`,
  );
  {
    const shotFit = await tab.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT_DIR, "shot-overlay-autofit.png"), Buffer.from(shotFit.data, "base64"));
    check("скриншот авто-подгона сохранён (shot-overlay-autofit.png)", fs.existsSync(path.join(OUT_DIR, "shot-overlay-autofit.png")));
  }

  // (44) возврат к коротким cue: кегль восстанавливается до базового
  await setTrio(...SHORT);
  await waitForPage(
    tab,
    `Array.from(document.querySelectorAll("[data-duopulse-subtitles] .duopulse-subtitles-row")).some((r) => r.textContent.includes("short line"))`,
    5000,
    "короткий набор вернулся (046)",
  );
  const backM = await measurePlate();
  check(
    "(44) смена на короткие cue: кегль восстановился до базового (авто не «залипает»)",
    Math.abs(backM.font - shortM.font) < 0.5,
    `${backM.font.toFixed(1)} vs ${shortM.font.toFixed(1)}px`,
  );

  // (45) колесо-размер поверх авто-подгона: масштаб растёт (доля держится),
  // ручное 75% — заметно ниже авто-подгона (клампы 75–300%, docs/03 §5).
  await setTrio(LONG_RU, LONG_EN, LONG_ES);
  await seekTo(tab, 2.0);
  await sleep(300);
  await waitForPage(
    tab,
    `(document.querySelector("[data-duopulse-subtitles] .duopulse-subtitles-row")?.textContent ?? "").includes("авто-уменьшение кегля")`,
    5000,
    "длинный набор снова показан (046)",
  );
  const beforeWheel = await measurePlate();
  await evalIn(
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
  await sleep(150);
  const afterUp = await measurePlate();
  check(
    "(45a) колесо поверх авто: масштаб 100→110 учтён, плашка снова в доле 50%",
    afterUp.scale === 110 && afterUp.plateH <= 0.5 * afterUp.videoH + 2 && afterUp.font >= beforeWheel.font - 0.5,
    `scale=${afterUp.scale}, кегль ${beforeWheel.font.toFixed(1)}→${afterUp.font.toFixed(1)}px, plate=${afterUp.plateH.toFixed(0)}px`,
  );
  await evalIn(tab, `document.dispatchEvent(new CustomEvent("duopulse-test-style", { detail: { fontScalePct: 75 } }))`);
  await sleep(150);
  const at75 = await measurePlate();
  check(
    "(45b) ручное 75% поверх авто: эффективный кегль ровно 75% базового, ниже авто-подгона",
    at75.scale === 75 &&
      Math.abs(at75.font / shortM.font - 0.75) < 0.02 &&
      at75.font < beforeWheel.font - 0.5 &&
      at75.plateH < 0.5 * at75.videoH,
    `scale=75, кегль ${at75.font.toFixed(1)}px = ${(at75.font / shortM.font).toFixed(2)}×базы, авто-подгон был ${beforeWheel.font.toFixed(1)}px`,
  );
  await evalIn(tab, `document.dispatchEvent(new CustomEvent("duopulse-test-style", { detail: { fontScalePct: 100 } }))`);

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
