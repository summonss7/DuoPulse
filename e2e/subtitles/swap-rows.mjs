// Живой стенд карточки duopulse-181 (+ порядок duopulse-203/206): перестановка
// строк субтитров и живые правки вида. Локальная страница с видео и двумя
// тест-дорожками (ru оригинал + en перевод, перекрывающиеся cue) — без
// YouTube и его rate-limit.
//
// Проверки:
//   A) набор из 2 дорожек: правило duopulse-206 — ПЕРЕВОД всегда верхней
//      строкой (роль дорожки, не язык): en-перевод сверху, ru-оригинал снизу;
//      стили ролевые (оригинал — белый 500/1em, перевод — лайм 400/0.85em);
//   B) duopulse-set-style {swapRows:true} — строки поменялись местами,
//      цвета/веса остались при СВОИХ ролях (не переехали с позициями);
//   C) swapRows:false — порядок вернулся;
//   D) живая смена цвета перевода — перекраска на месте в любом порядке;
//   E) живая смена гарнитуры — font-family плашки обновился;
//   F) дифф-обновление при swapRows=true: смена cue тем же составом дорожек
//      обновляет textContent БЕЗ пересоздания узлов строк (bottomDisplay);
//   H) duopulse-206, иностранное видео: набор en-оригинал + ru-перевод —
//      русская строка-перевод ПЕРВОЙ (сверху), оригинал — снизу; swap —
//      оригинал сверху; цвета остаются ролевыми.
//
// Запуск:  node e2e/subtitles/swap-rows.mjs [путь-к-duopulse.exe]
// Требует собранный debug-exe (cargo build из src-tauri) и vite dev (поднимает
// сам). Рантайм-артефакт — e2e/subtitles/swap-rows-last-run.json (+ .png),
// gitignore.
import { execFile, spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const HTTP_PORT = 8898;
const CDP_PORT = 9254;
const OUT_JSON = path.join(ROOT, "e2e", "subtitles", "swap-rows-last-run.json");
const OUT_PNG = path.join(ROOT, "e2e", "subtitles", "swap-rows-last-run.png");

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
  const open = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  open.catch(() => {});
  const send = (method, params = {}) =>
    open.then(() => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
    }));
  return { send, close: () => ws.close() };
}

const evalIn = (ws, expr, timeoutMs = 30000) =>
  Promise.race([
    ws.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })
      .then((r) => r?.result?.value),
    sleep(timeoutMs).then(() => { throw new Error("eval-таймаут: " + expr.slice(0, 80)); }),
  ]);

const dispatchStyle = (ws, style) =>
  evalIn(ws, `document.dispatchEvent(new CustomEvent('duopulse-set-style', {detail: ${JSON.stringify({ style })}}))`);

/** Снимок плашки: строки [текст, цвет, вес, кегль] (DOM-узлы не возвращаем —
 *  CDP returnByValue не сериализует их; идентичность узлов — rowMarks/F). */
const plateRows = (ws) => evalIn(ws, `(() => {
  const rows = [...document.querySelectorAll('[data-duopulse-subtitles] .duopulse-subtitles-row')];
  return rows.map((el) => ({
    text: el.textContent, color: el.style.color, weight: el.style.fontWeight,
    size: el.style.fontSize }));
})()`);
const rowMarks = (ws) => evalIn(ws, `(() => {
  window.__dpRows = [...document.querySelectorAll('[data-duopulse-subtitles] .duopulse-subtitles-row')];
  return window.__dpRows.map((el) => el.textContent);
})()`);
const marksAlive = (ws) => evalIn(ws, `(() => (window.__dpRows || []).filter((el) => el.isConnected).length)()`);

// Локальная страница: видео + набор из двух дорожек задаёт ранер (тест-хук).
const PAGE_HTML = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<title>duopulse-181 swap</title><style>body{background:#101418;color:#cfd8dc;font-family:system-ui;margin:24px}</style>
</head><body><h2>duopulse-181 · перестановка строк</h2>
<video id="v" src="/assets/testsrc.mp4" muted controls autoplay preload="auto" style="width:640px;background:#000;display:block"></video>
</body></html>`;

let vite;
let app;
let httpServer;
const appLog = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-181e2e-"));
const killOurExes = async () => {
  const exeForPs = EXE.split("\\").join("\\\\");
  try {
    await run("powershell", ["-NoProfile", "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='duopulse.exe'" | Where-Object { $_.ExecutablePath -eq '${exeForPs}' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }`,
    ]);
  } catch { /* уже мертвы — ок */ }
};

const TRACKS = [
  {
    id: "test:ru", source: "test", lang: "ru", role: "original",
    cues: [
      { startMs: 6000, endMs: 9500, text: "Оригинал: реплика один" },
      { startMs: 12000, endMs: 15000, text: "Оригинал: реплика два" },
    ],
  },
  {
    id: "test:en", source: "test", lang: "en", role: "translation",
    cues: [
      { startMs: 6000, endMs: 9500, text: "Translation: line one" },
      { startMs: 12000, endMs: 15000, text: "Translation: line two" },
    ],
  },
];

// duopulse-206, фаза H: иностранное видео — en-оригинал + ru-перевод;
// правило «перевод сверху» должно поднять РУССКУЮ строку (до 203 en
// оставался верхней — проверяем смену правила по ролям, не по языку).
const TRACKS_FOREIGN = [
  {
    id: "test:en", source: "test", lang: "en", role: "original",
    cues: [
      { startMs: 6000, endMs: 9500, text: "Original: line one" },
      { startMs: 12000, endMs: 15000, text: "Original: line two" },
    ],
  },
  {
    id: "test:ru", source: "test", lang: "ru", role: "translation",
    cues: [
      { startMs: 6000, endMs: 9500, text: "Перевод: реплика один" },
      { startMs: 12000, endMs: 15000, text: "Перевод: реплика два" },
    ],
  },
];

try {
  await killOurExes();
  const subsDir = path.join(ROOT, "e2e", "subtitles");
  httpServer = http.createServer((req, res) => {
    if (req.url === "/" || req.url === "/swap.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE_HTML);
      return;
    }
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
    const file = path.join(subsDir, rel);
    if (rel.startsWith("assets/") && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { "content-type": rel.endsWith(".mp4") ? "video/mp4" : "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));

  vite = spawn("npm", ["run", "dev"], { cwd: ROOT, shell: true, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try { await fetch("http://localhost:5173/"); break; } catch { await sleep(500); }
  }
  app = spawn(EXE, [], {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      APPDATA: tmp,
      DUOPULSE_START_URL: `http://127.0.0.1:${HTTP_PORT}/swap.html`,
      DUOPULSE_SLEEP_AFTER_SECS: "0",
      DUOPULSE_E2E_NO_SINGLE_INSTANCE: "1",
      WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT} --autoplay-policy=no-user-gesture-required`,
    },
  });
  app.stderr?.on("data", (d) => appLog.push(String(d)));

  let target;
  for (let i = 0; i < 90; i++) {
    try {
      const ts = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
      target = ts.find((t) => t.type === "page" && t.url.includes("127.0.0.1"));
      if (target) break;
    } catch { /* поднимается */ }
    await sleep(1000);
  }
  if (!target) throw new Error("CDP-цель вкладки стенда не найдена");
  const tab = connect(target.webSocketDebuggerUrl);
  await evalIn(tab, "1 + 1", 10000);

  // Стабилизация: бандл отдал диагностику.
  for (let i = 0; i < 30; i++) {
    const ready = await evalIn(tab, `!!window.__duopulseContent?.state && !!document.querySelector('video')`);
    if (ready) break;
    await sleep(1000);
  }

  // Набор: две дорожки, показ на перекрытии 6–9,5 с.
  await evalIn(tab, `(() => {
    window.__DUOPULSE_TEST_TRACK__ = ${JSON.stringify(TRACKS)};
    document.dispatchEvent(new CustomEvent('duopulse-test-track'));
    const v = document.querySelector('video');
    v.currentTime = 7; v.play().catch(() => {});
  })()`);
  let rows = [];
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const s = await evalIn(tab, `window.__duopulseContent?.state?.() ?? null`);
    const active = s?.engine?.activeRows ?? [];
    if (s?.overlayVisible && active.length >= 2) {
      rows = await plateRows(tab);
      if (rows.length >= 2) break;
    }
  }
  check("A1: оверлей рисует 2 строки", rows.length === 2, rows.map((r) => r.text).join(" / "));
  check("A2: правило duopulse-206 — перевод (en) сверху, ru-оригинал снизу",
    rows[0]?.text?.startsWith("Translation") && rows[1]?.text?.startsWith("Оригинал"),
    rows.map((r) => r.text).join(" / "));
  check("A3: перевод — фирменный лайм 400/0.85em (роль, не место)",
    rows[0]?.color === "rgb(189, 254, 79)" && rows[0]?.weight === "400" && rows[0]?.size === "0.85em",
    `${rows[0]?.color} ${rows[0]?.weight} ${rows[0]?.size}`);
  check("A4: оригинал — белый 500/1em (роль)",
    rows[1]?.color === "rgb(255, 255, 255)" && rows[1]?.weight === "500" && rows[1]?.size === "1em",
    `${rows[1]?.color} ${rows[1]?.weight} ${rows[1]?.size}`);

  // B) перестановка: строки меняются местами, стили остаются ролевыми.
  await dispatchStyle(tab, { swapRows: true });
  await sleep(400);
  rows = await plateRows(tab);
  check("B1: swapRows=true — обратный порядок (ru-оригинал сверху)",
    rows[0]?.text?.startsWith("Оригинал") && rows[1]?.text?.startsWith("Translation"),
    rows.map((r) => r.text).join(" / "));
  check("B2: цвета НЕ переехали — оригинал остался белым 1em/500",
    rows[0]?.color === "rgb(255, 255, 255)" && rows[0]?.size === "1em" && rows[0]?.weight === "500",
    `${rows[0]?.color} ${rows[0]?.size}`);
  check("B3: перевод остался лаймом 0.85em",
    rows[1]?.color === "rgb(189, 254, 79)" && rows[1]?.size === "0.85em",
    `${rows[1]?.color} ${rows[1]?.size}`);

  // F) при swapRows=true смена cue тем же составом — дифф без пересоздания
  // (ru-оригинал при swap=true сверху — ждём его «реплика два»).
  await rowMarks(tab);
  await evalIn(tab, `(() => { const v = document.querySelector('video'); v.currentTime = 13; return true; })()`);
  for (let i = 0; i < 20; i++) {
    await sleep(400);
    const txt = await evalIn(tab, `([...document.querySelectorAll('[data-duopulse-subtitles] .duopulse-subtitles-row')].map((r) => r.textContent).join("|"))`);
    if (txt.includes("реплика два") && txt.includes("line two")) break;
  }
  const alive = await marksAlive(tab);
  check("F: смена cue при swap — узлы строк живы (дифф, без пересоздания)", alive === 2, `живых узлов: ${alive}`);

  // C) назад: порядок вернулся.
  await dispatchStyle(tab, { swapRows: false });
  await sleep(400);
  rows = await plateRows(tab);
  check("C: swapRows=false — снова перевод (en) сверху", rows[0]?.text?.startsWith("Translation"),
    rows.map((r) => r.text).join(" / "));

  // D) живая смена цвета перевода (как пункт меню «Цвет перевода»).
  await dispatchStyle(tab, { translationColor: "#ffd54d" });
  await sleep(300);
  rows = await plateRows(tab);
  const transRow = rows.find((r) => r.text?.startsWith("Translation"));
  check("D: цвет перевода живо сменился на жёлтый", transRow?.color === "rgb(255, 213, 77)",
    `${transRow?.color}`);
  await dispatchStyle(tab, { translationColor: "#bdfe4f" }); // вернуть фирменный

  // E) живая смена гарнитуры (пункт меню «Шрифт плашки»).
  await dispatchStyle(tab, { fontFamily: "JetBrains Mono" });
  await sleep(400);
  const plateFont = await evalIn(tab, `(() => {
    const plate = document.querySelector('[data-duopulse-subtitles] > div');
    return plate?.style.fontFamily ?? '';
  })()`);
  check("E: гарнитура плашки живо сменилась на JetBrains Mono", plateFont.includes("JetBrains Mono"), plateFont);

  // H) duopulse-206: иностранное видео (en-оригинал + ru-перевод) —
  // русский перевод ПЕРВОЙ строкой, оригинал — снизу; swap поднимает
  // оригинал; цвета остаются ролевыми (перевод — лайм, где бы ни стоял).
  await evalIn(tab, `(() => {
    window.__DUOPULSE_TEST_TRACK__ = ${JSON.stringify(TRACKS_FOREIGN)};
    document.dispatchEvent(new CustomEvent('duopulse-test-track'));
    const v = document.querySelector('video');
    v.currentTime = 7; v.play().catch(() => {});
  })()`);
  rows = [];
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    rows = await plateRows(tab);
    if (rows.length >= 2 && rows.some((r) => r.text?.startsWith("Перевод"))) break;
  }
  check("H1: иностранное видео — русский ПЕРЕВОД сверху (duopulse-206)",
    rows[0]?.text?.startsWith("Перевод") && rows[1]?.text?.startsWith("Original"),
    rows.map((r) => r.text).join(" / "));
  check("H2: цвета ролевые — перевод лайм сверху, оригинал белый снизу",
    rows[0]?.color === "rgb(189, 254, 79)" && rows[0]?.size === "0.85em" &&
      rows[1]?.color === "rgb(255, 255, 255)" && rows[1]?.size === "1em",
    rows.map((r) => `${r.color} ${r.size}`).join(" / "));
  await dispatchStyle(tab, { swapRows: true });
  await sleep(400);
  rows = await plateRows(tab);
  check("H3: swapRows=true — оригинал (en) сверху, перевод снизу",
    rows[0]?.text?.startsWith("Original") && rows[1]?.text?.startsWith("Перевод") &&
      rows[1]?.color === "rgb(189, 254, 79)",
    rows.map((r) => r.text).join(" / "));
  await dispatchStyle(tab, { swapRows: false });
  await sleep(400);
  rows = await plateRows(tab);
  check("H4: swapRows=false — снова перевод (ru) сверху", rows[0]?.text?.startsWith("Перевод"),
    rows.map((r) => r.text).join(" / "));

  // G) Alt+D не задет рефакторингом: синтетический keydown (как в run.mjs 35)
  // выключает показ, повторный — включает (контроль регрессии оверлея).
  const beforeEnabled = await evalIn(tab, `window.__duopulseContent?.state?.().enabled`);
  await evalIn(tab, `document.dispatchEvent(new KeyboardEvent('keydown', { altKey: true, code: 'KeyD', cancelable: true }))`);
  let midEnabled = null;
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    midEnabled = await evalIn(tab, `window.__duopulseContent?.state?.().enabled`);
    if (midEnabled === false) break;
  }
  await evalIn(tab, `document.dispatchEvent(new KeyboardEvent('keydown', { altKey: true, code: 'KeyD', cancelable: true }))`);
  let backEnabled = null;
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    backEnabled = await evalIn(tab, `window.__duopulseContent?.state?.().enabled`);
    if (backEnabled === true) break;
  }
  check("G: Alt+D жив (выкл → вкл), оверлей-рефакторинг путь не задел",
    beforeEnabled === true && midEnabled === false && backEnabled === true,
    `${beforeEnabled} → ${midEnabled} → ${backEnabled}`);

  await tab.send("Page.enable").catch(() => {});
  const shot = await tab.send("Page.captureScreenshot", { format: "png" }).catch(() => null);
  if (shot?.data) fs.writeFileSync(OUT_PNG, Buffer.from(shot.data, "base64"));
  tab.close();

  fs.writeFileSync(OUT_JSON, JSON.stringify({
    exe: EXE, ts: new Date().toISOString(), results, appLogTail: appLog.slice(-12),
  }, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} проверок пройдено` +
    (failed.length ? ` (падения: ${failed.map((f) => f.name).join("; ")})` : ""));
} finally {
  try { app?.kill(); } catch { /* best-effort */ }
  try { vite?.kill(); } catch { /* best-effort */ }
  try { httpServer?.close(); } catch { /* best-effort */ }
  await killOurExes();
  try { vite?.kill(); } catch { /* best-effort */ }
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
}
