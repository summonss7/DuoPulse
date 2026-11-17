// Живой стенд карточки duopulse-180: видео открывается при включённом
// глобально duo (subtitlesLastEnabled=true, duopulse-128) — субтитры должны
// включиться САМИ (ветка video-auto): pendingEnable → список дорожек →
// дефолт-набор → прогрессивный показ. До фикса ветка была мёртвой:
// setMemory.get() возвращал undefined, проверка mem === null не срабатывала
// никогда — «открываю видео, субтитров нет, хотя они есть» (жалоба на
// watch?v=ha3Aw8Ynids, ro asr-дорожка).
//
// Проверки:
//   A) флаг предзаписан в settings.json профиля → свежая страница видит
//      lastEnabled=true (window.__DUOPULSE_DEFAULTS__);
//   B) после детекта видео enabled=true без нажатий (video-auto);
//   C) дефолт-набор загрузился: платформенная дорожка с cues>0;
//   D) оверлей включился и рисует реплики (активный текст непустой);
//   E) Core получил set-state «вкл» via video-auto.
//
// Запуск:  node e2e/subtitles/video-auto.mjs [путь-к-duopulse.exe] [videoId]
// Требует собранный debug-exe (cargo build из src-tauri) и vite dev (поднимает
// сам). Видео по умолчанию — ha3Aw8Ynids (Holy Molly, ro asr + 156 переводов).
// Рантайм-артефакт — e2e/subtitles/video-auto-last-run.json (+ .png), gitignore.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const VIDEO = process.argv[3] || "ha3Aw8Ynids";
const CDP_PORT = 9252;
const OUT_JSON = path.join(ROOT, "e2e", "subtitles", "video-auto-last-run.json");
const OUT_PNG = path.join(ROOT, "e2e", "subtitles", "video-auto-last-run.png");

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

const snapshot = (ws) => evalIn(ws, `(() => {
  const s = window.__duopulseContent?.state();
  return { key: s?.videoKey, enabled: s?.enabled,
    tracks: s?.engine?.tracks?.map(t => ({ id: t.id, cues: t.cues })) ?? [],
    overlay: s?.overlayVisible,
    active: s?.engine?.activeRows?.map(r => r.text) ?? [] };
})()`);

let vite;
let app;
const appLog = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-180e2e-"));
const killOurExes = async () => {
  const exeForPs = EXE.split("\\").join("\\\\");
  try {
    await run("powershell", ["-NoProfile", "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='duopulse.exe'" | Where-Object { $_.ExecutablePath -eq '${exeForPs}' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }`,
    ]);
  } catch {
    /* уже мертвы — ок */
  }
};

try {
  await killOurExes();
  // Глобальный флаг duo включён заранее (как у пользователя, который смотрел
  // с субтитрами в прошлый раз) — остальное поведение стенда не меняет.
  fs.mkdirSync(path.join(tmp, "DuoPulse", "profile"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "DuoPulse", "profile", "settings.json"),
    JSON.stringify({ subtitlesLastEnabled: true }),
  );
  vite = spawn("npm", ["run", "dev"], { cwd: ROOT, shell: true, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try { await fetch("http://localhost:5173/"); break; } catch { await sleep(500); }
  }
  app = spawn(EXE, [], {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      APPDATA: tmp,
      DUOPULSE_START_URL: `https://www.youtube.com/watch?v=${VIDEO}&hl=ru`,
      DUOPULSE_SLEEP_AFTER_SECS: "0",
      DUOPULSE_E2E_NO_SINGLE_INSTANCE: "1",
      WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT} --autoplay-policy=no-user-gesture-required`,
    },
  });
  app.stderr?.on("data", (d) => appLog.push(String(d)));

  // Ранняя сессия: куки согласия + навигация (паттерн altd-default, P-08).
  let target;
  for (let i = 0; i < 90; i++) {
    try {
      const ts = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
      target = ts.find((t) => t.type === "page" && t.url.includes("youtube.com"));
      if (target) break;
    } catch { /* поднимается */ }
    await sleep(1000);
  }
  if (!target) throw new Error("CDP-цель вкладки YouTube не найдена");
  const early = connect(target.webSocketDebuggerUrl);
  await evalIn(early, "1 + 1", 10000);
  for (const [n, v] of [
    ["CONSENT", "YES+cb.20210328-17-p0.en+FX+888"],
    ["SOCS", "CAI"],
  ]) {
    await early.send("Network.setCookie", { name: n, value: v, domain: ".youtube.com", path: "/" }).catch(() => {});
  }
  await early.send("Page.navigate", { url: `https://www.youtube.com/watch?v=${VIDEO}&hl=ru` });
  early.close();
  // Стабилизация без отладчика: неизменный URL 5 опросов подряд, ≥30 с
  // (перегрузки themeRefresh анонимной сессии должны отгреметь).
  {
    const t0 = Date.now();
    let stableUrl = null;
    let hits = 0;
    for (;;) {
      let url = null;
      try {
        const ts = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
        url = ts.find((t) => t.type === "page" && t.url.includes("youtube.com"))?.url ?? null;
      } catch { /* браузер поднимается */ }
      if (url && url === stableUrl) hits++;
      else { stableUrl = url; hits = 0; }
      if (url && hits >= 5 && Date.now() - t0 >= 30000) break;
      if (Date.now() - t0 > 240000) throw new Error(`вкладка YouTube не стабилизировалась (url=${stableUrl})`);
      await sleep(2000);
    }
  }
  const ts = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
  const tab = connect(ts.find((t) => t.type === "page" && t.url.includes("youtube.com")).webSocketDebuggerUrl);
  await evalIn(tab, "1 + 1", 10000);

  // A) дефолты доходят до контентного слоя
  const lastEnabled = await evalIn(tab, `window.__DUOPULSE_DEFAULTS__?.subtitles?.lastEnabled ?? 'absent'`);
  check("A: lastEnabled=true в __DUOPULSE_DEFAULTS__", lastEnabled === true, `получено: ${String(lastEnabled)}`);

  // B..D) наблюдение до 90 с: video-auto сам включил показ и довёл до оверлея
  const poll = [];
  let enabledEarly = false;
  let loadedTrack = null;
  let overlayText = null;
  const t0 = Date.now();
  for (;;) {
    const s = await snapshot(tab).catch(() => null);
    if (s) {
      poll.push({ at: Math.round((Date.now() - t0) / 1000), ...s });
      if (s.enabled) enabledEarly = true;
      const track = (s.tracks ?? []).find((t) => (t.cues ?? 0) > 0);
      if (track) loadedTrack = track;
      const text = (s.active ?? []).join(" ").trim();
      if (s.overlay && text) overlayText = text;
    }
    if (overlayText || Date.now() - t0 > 90000) break;
    await sleep(3000);
  }
  check("B: enabled=true без нажатий (video-auto)", enabledEarly);
  check("C: дефолт-набор загрузился (дорожка с cues>0)", !!loadedTrack,
    loadedTrack ? `${loadedTrack.id} — ${loadedTrack.cues} cues` : "");
  check("D: оверлей рисует реплики", !!overlayText, overlayText ? `«${overlayText.slice(0, 60)}»` : "");

  // E) Core получил «вкл» с via video-auto
  const autoLine = appLog.filter((l) => l.includes("via video-auto") && l.includes("вкл"));
  check("E: set-state «вкл … via video-auto» в журнале Core", autoLine.length > 0,
    autoLine.length ? autoLine[0].trim().slice(0, 80) : "строки нет");

  // Скриншот финального состояния (оверлей над видео)
  await tab.send("Page.enable").catch(() => {});
  const shot = await tab.send("Page.captureScreenshot", { format: "png" }).catch(() => null);
  if (shot?.data) fs.writeFileSync(OUT_PNG, Buffer.from(shot.data, "base64"));
  tab.close();

  fs.writeFileSync(OUT_JSON, JSON.stringify({
    video: VIDEO, exe: EXE, ts: new Date().toISOString(), results, poll,
    appLogTail: appLog.slice(-12),
  }, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} проверок пройдено` +
    (failed.length ? ` (падения: ${failed.map((f) => f.name).join("; ")})` : ""));
} finally {
  try { app?.kill(); } catch { /* best-effort */ }
  try { vite?.kill(); } catch { /* best-effort */ }
  await killOurExes();
  try { vite?.kill(); } catch { /* best-effort */ }
}
