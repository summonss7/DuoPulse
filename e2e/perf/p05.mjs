// Замер метрики P-05 (задача 2.5/gate M2, docs/04 §2): «Дропы кадров 1080p60
// — 0 дропов/мин» по статистике рендера видео getVideoPlaybackQuality
// (методика M0 — e2e/m0-results/PROTOCOL.md: стабильные 1920×1080 при ~60 fps,
// дропы 3/3149 = 0.10%). Релизная сборка: DUOPULSE_START_URL=видео, качество
// форсируем hd1080 через player API, ждём первый кадр контента (скриптлеты
// убирают преролл), 5 с на разгон, затем дельта droppedVideoFrames за 60 с.
//
// Запуск:  node e2e/perf/p05.mjs [url-видео]
// Требует release-сборку (npx tauri build). Сеть: YouTube + списки блокировщика (первый запуск
// профиля качает EasyList/uBO — прогрев тем же профилем).
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = path.join(ROOT, "src-tauri", "target", "release", "duopulse.exe");
const CDP_PORT = 9229;
const VIDEO = process.argv[2] || "https://www.youtube.com/watch?v=aqz-KE-bpKQ"; // Big Buck Bunny 60fps — как M0
const MEASURE_MS = 60_000; // окно замера: дропы за минуту
const BUDGET = 0; // docs/04 §2: 0 дропов/мин

if (!fs.existsSync(EXE)) {
  console.error(`FAIL  не найден exe: ${EXE} (нужна release-сборка)`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))),
  );
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};
setTimeout(() => {
  console.error("СТЕНД: глобальный таймаут 10 мин — принудительное завершение");
  process.exit(2);
}, 10 * 60_000).unref?.();

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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-p05-"));
const launch = () =>
  spawn(EXE, [], {
    stdio: "ignore",
    env: {
      ...process.env,
      APPDATA: profile,
      DUOPULSE_START_URL: VIDEO,
      WEBVIEW2_USER_DATA_FOLDER: path.join(profile, "webview2-data"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
  });

/** Состояние видео: {ad, playing, width, height, dropped, total}. */
const VIDEO_STATE = `(function () {
  const v = document.querySelector('video');
  if (!v) return { novideo: true };
  const q = v.getVideoPlaybackQuality();
  return {
    ad: !!document.querySelector('.ad-showing, .ytp-ad-player-overlay, .ytp-ad-image-overlay'),
    playing: v.currentTime > 0.5 && !v.paused,
    width: v.videoWidth, height: v.videoHeight,
    dropped: q.droppedVideoFrames, total: q.totalVideoFrames,
  };
})()`;

const stateOf = async (ws) => evalIn(ws, VIDEO_STATE).catch(() => null);

/** Дождаться смерти процессов WebView2 профиля: осиротевший браузер держит
 *  user-data-folder и порт CDP — /json следующего запуска отвечает целями
 *  зомби-прогона (как e2e/perf/run.mjs waitWebViewDown). */
async function waitWebViewDown(prof) {
  const marker = path.join(prof, "webview2-data");
  const psCount =
    `(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" ` +
    `| Where-Object { $_.CommandLine -like '*${marker}*' }).Count`;
  const psKill =
    `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" ` +
    `| Where-Object { $_.CommandLine -like '*${marker}*' } ` +
    `| ForEach-Object { taskkill /PID $_.ProcessId /T /F }`;
  const t0 = Date.now();
  for (;;) {
    let count = -1;
    try {
      count = Number((await run("powershell", ["-NoProfile", "-Command", psCount])).trim());
    } catch {
      count = 0;
    }
    if (count <= 0) return;
    if (Date.now() - t0 > 5000) {
      try {
        await run("powershell", ["-NoProfile", "-Command", psKill]);
      } catch {}
      await sleep(1000);
      return;
    }
    await sleep(400);
  }
}

let failures = 0;
let app = null;
try {
  // прогрев: списки блокировщика + один просмотр (кэш видео тёплый — меряем
  // рендер, не сеть)
  app = launch();
  let yt = null;
  for (let i = 0; i < 90 && !yt; i++) {
    const t = (await cdpTargets()).find((x) => x.type === "page" && /youtube\.com\/watch/.test(x.url));
    if (t) yt = connect(t.webSocketDebuggerUrl);
    else await sleep(1000);
  }
  if (!yt) throw new Error("YouTube-цель не поднялась");
  let warmed = false;
  for (let i = 0; i < 120 && !warmed; i++) {
    const st = await stateOf(yt);
    if (st && !st.novideo && st.playing && !st.ad) warmed = true;
    else await sleep(1000);
  }
  if (!warmed) throw new Error("прогрев не дошёл до контента");
  yt.close();
  await gracefulClose(app);
  await waitWebViewDown(profile);

  // замер
  app = launch();
  yt = null;
  for (let i = 0; i < 90 && !yt; i++) {
    const t = (await cdpTargets()).find((x) => x.type === "page" && /youtube\.com\/watch/.test(x.url));
    if (t) yt = connect(t.webSocketDebuggerUrl);
    else await sleep(1000);
  }
  if (!yt) throw new Error("YouTube-цель не поднялась (замер)");

  // форсируем hd1080: на тёплом профиле адаптив стартует с 480p и ползёт
  // вверх медленно; setPlaybackQualityRange применившийся ДО готовности
  // плеера — тихий no-op, поэтому повторяем, пока видео не станет 1080
  let ready = null;
  for (let i = 0; i < 90 && !ready; i++) {
    await evalIn(yt, `(function () {
      const p = document.getElementById('movie_player');
      if (p && p.setPlaybackQualityRange) p.setPlaybackQualityRange('hd1080', 'hd1080');
      const v = document.querySelector('video');
      if (v) { v.muted = true; v.play().catch(() => {}); }
      return true;
    })()`).catch(() => {});
    await sleep(2000);
    const st = await stateOf(yt);
    if (st && !st.novideo && st.playing && !st.ad && st.height >= 1080) {
      ready = st;
      break;
    }
  }
  if (!ready) throw new Error("1080p-контент не играет (проверь, что видео имеет формат 1080p60)");
  check("P-05 сценарий: играет 1080p контент", ready.height >= 1080, `${ready.width}×${ready.height}`);

  await sleep(5000); // разгон декодера
  const q1 = await stateOf(yt);
  await sleep(MEASURE_MS);
  const q2 = await stateOf(yt);
  const drops = q2.dropped - q1.dropped;
  const frames = q2.total - q1.total;
  const fps = frames / (MEASURE_MS / 1000);
  check(
    `P-05 дропы кадров ≤ ${BUDGET}/мин`,
    drops <= BUDGET,
    `${drops} дропов / ${frames} кадров за минуту (${fps.toFixed(1)} fps, ${ready.width}×${ready.height}); дельта битых: ${(drops / Math.max(frames, 1) * 100).toFixed(2)}%`,
  );
  yt.close();
} catch (e) {
  failures++;
  console.error("E2E ERROR:", e.message);
} finally {
  if (app) await gracefulClose(app);
  await sleep(1000);
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {}
}

const failed = results.filter((r) => !r.ok).length + failures;
console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES: " + failed} (${results.length} проверок)`);
process.exit(failed === 0 ? 0 : 1);
