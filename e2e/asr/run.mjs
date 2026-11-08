// DuoPulse e2e-стенд ASR (карточка duopulse-060): генерация субтитров
// распознаванием речи на «голом» HTML5-видео (без дорожек платформы).
//
// Сценарий: локальная страница с <video src=speech.mp4> (SAPI-озвучка,
// генерится на стенде) → кнопка «Распознать речь (ASR)» duo-панели →
// локальный движок whisper-server.exe (env DUOPULSE_E2E_ASR_ENGINE; модель —
// DUOPULSE_E2E_ASR_MODEL, по умолчанию спайковые в %TEMP%\duopulse-asr-proto)
// → прогресс duoAsrMeta → дорожка asr:en в наборе и на плашке → повторный
// клик отдаёт из кэша (0 обращений к движку).
//
// Запуск:  node e2e/asr/run.mjs [путь-к-duopulse.exe]
// Требует собранный debug-exe (cargo build), vite dev поднимает сам.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createReadStream, statSync } from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const CDP_PORT = Number(process.env.E2E_ASR_CDP_PORT) || 9239;
const HTTP_PORT = Number(process.env.E2E_ASR_HTTP_PORT) || 8898; // 8899 занят сервисом Aila (карточка duopulse-035)
const ASSETS = path.join(ROOT, "e2e", "asr", "assets");
const ENGINE =
  process.env.DUOPULSE_E2E_ASR_ENGINE ||
  path.join(os.tmpdir(), "duopulse-asr-proto", "build", "bin", "whisper-server.exe");
const MODEL =
  process.env.DUOPULSE_E2E_ASR_MODEL ||
  path.join(os.tmpdir(), "duopulse-asr-proto", "models", "ggml-base.bin");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, opts, (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err))) : resolve(String(stdout)))));

const killOurExes = async () => {
  // одинарные кавычки PS: бэкслаш не спецсимвол, пути вставляются как есть
  // (экранирование \\ ломало сравнение — whisper-server оставался жив)
  try {
    await run("powershell", [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='duopulse.exe' or Name='whisper-server.exe'" | Where-Object { $_.ExecutablePath -eq '${EXE}' -or $_.ExecutablePath -eq '${ENGINE}' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }`,
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

// --- 1. ассеты: SAPI-озвучка → speech.mp4 (детерминированный скрипт) ---------
const SENTENCES = [
  "Welcome to the evening update.",
  "Researchers at a small laboratory in northern California have built a battery that can charge in under five minutes.",
  "The team tested the design on two hundred cycles and observed almost no loss of capacity.",
  "Meanwhile engineers in Munich presented a robot that can sort packages twice as fast as last year model.",
  "In financial news the central bank kept the interest rate unchanged.",
  "Analysts expected a small increase so markets reacted positively in early trading.",
  "Finally a reminder that the city marathon will close several bridges this Sunday.",
  "Thank you for listening and have a pleasant evening.",
];

async function makeAssets() {
  fs.mkdirSync(ASSETS, { recursive: true });
  const mp4 = path.join(ASSETS, "speech.mp4");
  if (fs.existsSync(mp4)) return mp4;
  if (!fs.existsSync(ENGINE)) throw new Error(`whisper-server.exe не найден: ${ENGINE} (DUOPULSE_E2E_ASR_ENGINE)`);
  if (!fs.existsSync(MODEL)) throw new Error(`модель не найдена: ${MODEL} (DUOPULSE_E2E_ASR_MODEL)`);
  const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SelectVoice('Microsoft David Desktop')
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth.SetOutputToWaveFile('${mp4.replace(/\\/g, "\\")}.wav', $fmt)
$synth.Speak(@'
${SENTENCES.join(" ")}
'@)
$synth.SetOutputToNull()
`;
  await run("powershell", ["-NoProfile", "-Command", ps]);
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", `${mp4}.wav`,
    "-f", "lavfi", "-i", "color=c=0x101418:s=640x360:r=24",
    "-shortest", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart",
    mp4,
  ]);
  fs.rmSync(`${mp4}.wav`);
  return mp4;
}

// --- 2. локальный http: страница + mp4 (Range обязателен) ---------------------
const PAGE = `<!doctype html><meta charset="utf-8"><title>asr</title>
<body style="margin:0;background:#111">
<video id="v" src="/speech.mp4" controls autoplay muted style="width:640px"></video>
</body>`;
const MIME = { ".mp4": "video/mp4" };
const httpServer = http.createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(PAGE);
    return;
  }
  const file = path.join(ASSETS, path.normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^([/\\]|\.\.)+/, ""));
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

// --- 3. профиль: настройки ASR + модель ----------------------------------------
await makeAssets();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-asr-e2e-"));
const profile = path.join(tmp, "DuoPulse", "profile");
fs.mkdirSync(path.join(profile, "asr", "models"), { recursive: true });
fs.copyFileSync(MODEL, path.join(profile, "asr", "models", path.basename(MODEL)));
fs.writeFileSync(
  path.join(profile, "settings.json"),
  JSON.stringify({
    asr: {
      enabled: true,
      provider: "local",
      localModel: "base",
      localEnginePath: ENGINE,
    },
  }),
);

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

// --- 4. CDP -------------------------------------------------------------------
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
    await sleep(200);
  }
};

let failed = 0;
try {
  const tabTarget = targets.find((t) => t.type === "page" && t.url.startsWith(pageUrl));
  if (!tabTarget) throw new Error("контентная цель CDP не найдена: " + targets.map((t) => t.url).join(", "));
  const tab = connect(tabTarget.webSocketDebuggerUrl);
  const stateOf = async () => evalIn(tab, `window.__duopulseContent?.state()`);

  // (1) видео детектировано, дорожек платформы нет — сценарий карточки 060
  await waitForPage(tab, `!!window.__duopulseContent?.state()?.videoKey`, 15000, "детект видео");
  const st1 = await stateOf();
  check(
    "(1) «голое» видео детектировано (videoKey), дорожек платформы нет",
    typeof st1.videoKey === "string" && st1.videoKey.startsWith("url:") && st1.canTracks === false,
    `videoKey=${st1.videoKey}`,
  );

  // (2) панель duo: кнопка ASR видна
  const uiTarget = targets.find((t) => t.type === "page" && /localhost:5173/.test(t.url));
  if (!uiTarget) throw new Error("UI-цель CDP не найдена (нужен vite dev)");
  const ui = connect(uiTarget.webSocketDebuggerUrl);
  await waitForPage(ui, `typeof window.__duopulse === "object"`, 10000, "bridge-хук window.__duopulse");
  await waitForPage(ui, `!document.getElementById("duoBtn").hidden`, 10000, "кнопка duo видна");
  // панель — тест-событием (карточка 087: клик кнопки открывает нативное меню)
  await evalIn(ui, `window.dispatchEvent(new CustomEvent("duo:open-panel"))`);
  await waitForPage(ui, `!document.getElementById("duoPanel").hidden`, 5000, "панель duo открыта");
  const btnState = await evalIn(
    ui,
    `(function () { const b = document.getElementById("duoAsrBtn"); return { exists: !!b, hidden: !b || b.offsetParent === null }; })()`,
  );
  check("(2) кнопка «Распознать речь (ASR)» есть в панели duo", btnState.exists && !btnState.hidden);

  // (3) настройки: движок/модель на месте, провайдер локальный
  const asrSettings = await evalIn(ui, `window.__duopulse.asr.getSettings()`);
  check(
    "(3) asr.getSettings: enabled, local, движок и модель на месте",
    asrSettings.enabled === true &&
      asrSettings.provider === "local" &&
      asrSettings.engineFound === true &&
      asrSettings.modelDownloaded === true,
  );

  // (4) клик → конвейер: прогресс-мета доходит до «Готово», whisper-server
  // поднялся (метка [asr] в журнале Core)
  await evalIn(ui, `document.getElementById("duoAsrBtn").click()`);
  const doneText = await waitForPage(
    ui,
    `(function () { const m = document.getElementById("duoAsrMeta"); const t = m && !m.hidden ? m.textContent : ""; return /^Готово|^ASR:/.test(t) ? t : ""; })()`,
    120_000,
    "прогресс ASR до готовности/ошибки",
  );
  check(
    "(4) прогресс дошёл до готовности (локальный whisper)",
    doneText.startsWith("Готово"),
    doneText,
  );

  // (5) дорожка asr:en в наборе content-слоя, cue на плашке
  const st2 = await stateOf();
  const asrTrack = (st2.asrTracks ?? [])[0];
  check(
    "(5) дорожка asr:en в наборе, cue распознаны, плашка показывает",
    !!asrTrack &&
      asrTrack.id === "asr:en" &&
      asrTrack.cues >= 4 &&
      st2.engine.trackCount >= 1 &&
      st2.overlayVisible === true,
    `asr=${asrTrack?.id}, cues=${asrTrack?.cues}, trackCount=${st2.engine.trackCount}`,
  );

  // (6) качество: транскрипт содержит слова скрипта (WER-спайк: base en 3–8 %)
  const plateText = await waitForPage(
    tab,
    `(function () { const rows = window.__duopulseContent?.state().engine.activeRows ?? []; return rows.length ? rows.map((r) => r.text).join(" ") : ""; })()`,
    8000,
    "активные cue на плашке",
  ).catch(() => "");
  check(
    "(6) транскрипт осмысленный (слова скрипта на плашке или в cue)",
    /evening|battery|financial|marathon|weekend|listening/i.test(plateText || JSON.stringify(st2.asrTracks)),
    (plateText || "").slice(0, 80),
  );

  // (7) снапшот панели: дорожка source "asr" (subtitles:list_tracks)
  const snap = await evalIn(ui, `window.__duopulse.subtitles.listTracks()`);
  const snapAsr = (snap.tracks ?? []).find((t) => t.source === "asr");
  check(
    "(7) subtitles.list_tracks: дорожка source=asr (role original)",
    !!snapAsr && snapAsr.role === "original" && /^asr:/.test(snapAsr.id),
    snapAsr?.id ?? "нет",
  );

  // (8) кэш: повторный клик — «из кэша», без нового запуска конвейера
  await evalIn(ui, `document.getElementById("duoAsrBtn").click()`);
  const cacheText = await waitForPage(
    ui,
    `(function () { const m = document.getElementById("duoAsrMeta"); const t = m && !m.hidden ? m.textContent : ""; return /из кэша|^ASR:/.test(t) ? t : ""; })()`,
    15_000,
    "кэш-хит ASR",
  );
  check("(8) повторное распознавание — из кэша", cacheText.includes("из кэша"), cacheText);

  // (9) отмена: команда отвечает (конвейер поколения гаснет молча)
  const cancelOk = await evalIn(ui, `window.__duopulse.subtitles.asrCancel().then(() => true).catch((e) => String(e))`);
  check("(9) subtitles.asr_cancel отвечает ok", cancelOk === true, String(cancelOk));

  // (10) журнал Core: метки конвейера [asr]
  const logText = appLog.join("");
  check(
    "(10) журнал Core: запрос ASR и старт whisper-server",
    logText.includes("[asr] запрос") && logText.includes("[asr] whisper-server"),
  );

  tab.close();
  ui.close();
} catch (e) {
  failed++;
  console.error("СТЕНД УПАЛ:", e);
  console.error(appLog.join("").slice(-4000));
} finally {
  const passed = results.filter((r) => r.ok).length;
  console.log(results.some((r) => !r.ok) || failed ? `FAILURES: ${results.filter((r) => !r.ok).length + failed}` : "ALL PASS");
  console.log(`итог: ${passed}/${results.length} проверок`);
  try {
    app.kill();
  } catch {}
  await killOurExes();
  try {
    await run("powershell", ["-NoProfile", "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'vite' -and $_.ExecutablePath -like '*node*' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }`]);
  } catch {}
  httpServer.close();
  await sleep(1500); // процессы отпускают файлы профиля не мгновенно
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* файлы ещё заняты — временный каталог почистит ОС */
  }
  process.exit(results.some((r) => !r.ok) || failed ? 1 : 0);
}
