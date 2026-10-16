// Замер метрики P-08 (задача 2.5/gate M2, docs/04 §2): «Время до первого
// кадра видео (повторный просмотр) ≤ времени в Chrome+uBO (не хуже)».
// Повторный просмотр = тёплый кэш профиля (2 прогрев-просмотра), затем
// 3 замеренных запуска на браузер, медиана; отсчёт — запуск процесса →
// первый кадр КОНТЕНТА (currentTime > 0.5, не пауза, не реклама; реклама
// детектируется и репортится, но в DuoPulse её нет — скриптлеты).
//
// Трактовка «Chrome+uBO» (описана в отчёте gate): DuoPulse блокирует теми же
// списками EasyList/uBO, что и uBO; сравнение с ЧИСТЫМ Chrome — без блокировки
// (Chrome грузит больше ad-запросов, на повторном просмотре с частотным капом
// реклама обычно не показывается). Если DuoPulse ≤ чистого Chrome, планка
// «не хуже Chrome+uBO» выполняется с запасом на накладные расходы uBO.
// Запуск:  node e2e/perf/p08.mjs [url-видео]
// Требует release-сборку DuoPulse (npx tauri build) и установленный Chrome.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const DUO_EXE = path.join(ROOT, "src-tauri", "target", "release", "duopulse.exe");
const CHROME_EXE =
  process.env.CHROME_EXE || path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe");
const VIDEO = process.argv[2] || "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const RUNS = 3;
const WARMUPS = 2;

if (!fs.existsSync(DUO_EXE)) {
  console.error(`FAIL  не найден exe: ${DUO_EXE} (нужна release-сборка)`);
  process.exit(1);
}
if (!fs.existsSync(CHROME_EXE)) {
  console.error(`FAIL  не найден Chrome: ${CHROME_EXE} (переопредели CHROME_EXE)`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))),
  );
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

setTimeout(() => {
  console.error("СТЕНД: глобальный таймаут 15 мин — принудительное завершение");
  process.exit(2);
}, 15 * 60_000).unref?.();

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

/** Первый кадр контента в youtube-цели браузера на порту cdpPort.
 *  Возвращает { ms, adSeen } от t0 или null, пока не дождались. */
async function waitFirstFrame(cdpPort, t0, timeoutMs) {
  const deadline = t0 + timeoutMs;
  let ws = null;
  let adSeen = false;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://localhost:${cdpPort}/json`)).json();
      const yt = targets.find((x) => x.type === "page" && /youtube\.com\/watch/.test(x.url));
      if (yt && !ws) ws = connect(yt.webSocketDebuggerUrl);
      if (ws) {
        const st = await evalIn(
          ws,
          `(function () {
            const ad = !!document.querySelector('.ad-showing, .ytp-ad-player-overlay, .ytp-ad-image-overlay');
            if (ad) window.__p08ad = true;
            const v = document.querySelector('video');
            if (!v) return { novideo: true };
            if (v.paused) { v.muted = true; v.play().catch(() => {}); }
            return { ad: window.__p08ad === true, frame: v.currentTime > 0.5 && !v.paused };
          })()`,
        ).catch(() => null);
        if (st && !st.novideo) {
          if (st.ad) adSeen = true;
          if (st.frame) {
            ws.close();
            return { ms: Date.now() - t0, adSeen };
          }
        }
      }
    } catch {
      /* браузер ещё поднимается */
    }
    await sleep(120);
  }
  ws?.close();
  return null;
}

async function killTree(pid) {
  try {
    await run("taskkill", ["/PID", String(pid), "/T", "/F"]);
  } catch {}
}

// --- DuoPulse (релизная сборка, тёплый профиль) ------------------------------
const duoProfile = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-p08-duo-"));
const launchDuo = () =>
  spawn(DUO_EXE, [], {
    stdio: "ignore",
    env: {
      ...process.env,
      APPDATA: duoProfile,
      DUOPULSE_START_URL: VIDEO,
      WEBVIEW2_USER_DATA_FOLDER: path.join(duoProfile, "webview2-data"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9232",
    },
  });

// --- Chrome (чистый профиль, тёплый) -----------------------------------------
const chromeProfile = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-p08-chrome-"));
const launchChrome = () =>
  spawn(CHROME_EXE, [
    `--user-data-dir=${chromeProfile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=9233",
    "--window-size=1360,860",
    VIDEO,
  ], { stdio: "ignore" });

/** Дождаться смерти процессов WebView2 профиля DuoPulse: осиротевший браузер
 *  держит user-data-folder и порт CDP — следующий прогон получит зомби-цели
 *  (как e2e/perf/run.mjs waitWebViewDown). */
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

/** Прогрев+замеры одного браузера: launch → ждём кадр → kill; возвращает
 *  массив { ms, adSeen } замеренных прогонов. settle — ждать полной смерти
 *  процессов профиля (DuoPulse/WebView2), чтобы порт и папка освободились. */
async function measureBrowser(name, launch, cdpPort, settle) {
  const out = [];
  const total = WARMUPS + RUNS;
  for (let i = 0; i < total; i++) {
    const app = launch();
    const t0 = Date.now();
    const r = await waitFirstFrame(cdpPort, t0, 120_000);
    await sleep(i < WARMUPS ? 8000 : 2500); // прогрев досматривает ролик (кэш/кап рекламы)
    await killTree(app.pid);
    if (settle) await settle();
    await sleep(1200);
    if (!r) throw new Error(`${name}: первый кадр не дождан в прогоне ${i + 1}`);
    if (i >= WARMUPS) {
      out.push(r);
      console.log(`  ${name} прогон ${i - WARMUPS + 1}: ${r.ms} мс${r.adSeen ? " (видна реклама)" : ""}`);
    } else {
      console.log(`  ${name} прогрев ${i + 1}: ${r.ms} мс${r.adSeen ? " (видна реклама)" : ""}`);
    }
  }
  return out;
}

let failures = 0;
let duoMedian = NaN;
let chromeMedian = NaN;
try {
  console.log("DuoPulse (блокировщик включён):");
  const duo = await measureBrowser("DuoPulse", launchDuo, 9232, () => waitWebViewDown(duoProfile));
  console.log("Chrome (чистый, без расширений):");
  const chrome = await measureBrowser("Chrome", launchChrome, 9233, null);
  duoMedian = median(duo.map((r) => r.ms));
  chromeMedian = median(chrome.map((r) => r.ms));
  const ok = duoMedian <= chromeMedian;
  console.log(
    `\nP-08: DuoPulse медиана ${duoMedian} мс vs Chrome ${chromeMedian} мс — ${ok ? "НЕ ХУЖЕ" : "хуже"} (цель: не хуже Chrome+uBO)`,
  );
  console.log(`      прогоны: DuoPulse=${JSON.stringify(duo.map((r) => r.ms))} Chrome=${JSON.stringify(chrome.map((r) => r.ms))}`);
  console.log(`      реклама: DuoPulse=${JSON.stringify(duo.map((r) => r.adSeen))} Chrome=${JSON.stringify(chrome.map((r) => r.adSeen))}`);
  if (!ok) failures++;
} catch (e) {
  failures++;
  console.error("E2E ERROR:", e.message);
} finally {
  try {
    fs.rmSync(duoProfile, { recursive: true, force: true });
  } catch {}
  try {
    fs.rmSync(chromeProfile, { recursive: true, force: true });
  } catch {}
  await sleep(1000);
}

console.log(`\n${failures === 0 ? "ALL PASS" : "FAILURES: " + failures}`);
process.exit(failures === 0 ? 0 : 1);
