// Замер метрики P-05 (задача 2.5/gate M2, docs/04 §2): «Дропы кадров 1080p60 —
// не хуже контрольного браузера на той же машине». Трактовка установлена
// автором 20.10.2026 (приёмка 5.3, вопрос duopulse_035_p05_20261019):
// YouTube перевёл выдачу 1080p60 на AV1 (itag 399), на машинах без аппаратного
// AV1-декода софт-декод дропает кадры одинаково у DuoPulse и контроля — прежний
// абсолютный бюджет «0 дропов/мин» недостижим платформенно и остаётся целью
// только при аппаратном декодировании играющего кодека (замер приёмки 19–20.10:
// DuoPulse 16,5% против Chrome 16,7%).
//
// Контроль (решение автора 21.10.2026 03:48, duopulse_047_control_20261021):
// DuoPulse с ВЫКЛЮЧЕННЫМ блокировщиком — тот же движок WebView2 и та же машина,
// разница только в блокировщике; независимость движка теряется (зафиксировано
// в docs/04 §2). Причина замены: с 21.10.2026 YouTube-сервер не attachит поток
// свежим Chrome/Edge-профилям (playerState 3, readyState 0 при playability OK —
// расследование CARDS/047), внешний Chrome-контроль невозможен. Блокировщик
// выключается settings.json {"adblock":{"enabled":false}} в профиле контроля
// ДО первого запуска (ключ читается на старте, adblock/mod.rs load_persisted).
// Отказ контроля = провал прогона: движок тот же, «пропустить контроль»
// (DUOPULSE_P05_REQUIRE_CONTROL эпохи Chrome-гейта) больше не предусмотрен.
//
// Методика — как M0 (e2e/m0-results/PROTOCOL.md): getVideoPlaybackQuality,
// дельта droppedVideoFrames за 60 с; качество форсируем hd1080 через player API,
// ждём первый кадр контента (в DuoPulse преролл убирают скриптлеты, в контроле —
// дожидаемся конца рекламы), 5 с на разгон декодера. Оба прогона — тёплый
// профиль (прогрев-просмотр качает списки блокировщика/кэш видео), затем
// по одному замерному прогону.
//
// Запуск:  node e2e/perf/p05.mjs [url-видео]
// Требует release-сборку (npx tauri build).
// Сеть: YouTube + списки блокировщика (первый запуск профиля качает EasyList/uBO).
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = path.join(ROOT, "src-tauri", "target", "release", "duopulse.exe");
const VIDEO = process.argv[2] || "https://www.youtube.com/watch?v=aqz-KE-bpKQ"; // Big Buck Bunny 60fps — как M0
const MEASURE_MS = 60_000; // окно замера: дропы за минуту
const DUO_CDP = 9229;
const CTL_CDP = 9231;

if (!fs.existsSync(EXE)) {
  console.error(`FAIL  не найден exe: ${EXE} (нужна release-сборка)`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))),
  );

setTimeout(() => {
  console.error("СТЕНД: глобальный таймаут 15 мин — принудительное завершение");
  process.exit(2);
}, 15 * 60_000).unref?.();

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
const cdpTargets = async (port) => {
  try {
    return await (await fetch(`http://localhost:${port}/json`)).json();
  } catch {
    return [];
  }
};

async function killTree(pid) {
  try {
    await run("taskkill", ["/PID", String(pid), "/T", "/F"]);
  } catch {}
}

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

/** Ждать YouTube-цель на порту и подключиться. */
async function waitYt(port) {
  for (let i = 0; i < 90; i++) {
    const t = (await cdpTargets(port)).find((x) => x.type === "page" && /youtube\.com\/watch/.test(x.url));
    if (t) return connect(t.webSocketDebuggerUrl);
    await sleep(1000);
  }
  return null;
}

/** Форсировать hd1080 и дождаться играющего 1080p-контента (без рекламы):
 *  на тёплом профиле адаптив стартует с 480p и ползёт вверх медленно;
 *  setPlaybackQualityRange, применившийся до готовности плеера — тихий no-op,
 *  поэтому повторяем, пока видео не станет 1080. */
async function waitHd1080(ws) {
  for (let i = 0; i < 90; i++) {
    await evalIn(ws, `(function () {
      const p = document.getElementById('movie_player');
      if (p && p.setPlaybackQualityRange) p.setPlaybackQualityRange('hd1080', 'hd1080');
      const v = document.querySelector('video');
      if (v) { v.muted = true; v.play().catch(() => {}); }
      return true;
    })()`).catch(() => {});
    await sleep(2000);
    const st = await stateOf(ws);
    if (st && !st.novideo && st.playing && !st.ad && st.height >= 1080) return st;
  }
  return null;
}

// --- браузеры ----------------------------------------------------------------
// Оба прогона — DuoPulse (release): основной с блокировщиком (по умолчанию),
// контроль — отдельный профиль с заранее выключенным блокировщиком.
const duoProfile = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-p05-duo-"));
const ctlProfile = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-p05-ctl-"));
// settings.json контроля: ключ читается на старте Core, до подъёма движка
fs.mkdirSync(path.join(ctlProfile, "DuoPulse", "profile"), { recursive: true });
fs.writeFileSync(
  path.join(ctlProfile, "DuoPulse", "profile", "settings.json"),
  JSON.stringify({ adblock: { enabled: false } }),
);
const launchAt = (profile, port) => () =>
  spawn(EXE, [], {
    stdio: "ignore",
    env: {
      ...process.env,
      APPDATA: profile,
      DUOPULSE_START_URL: VIDEO,
      WEBVIEW2_USER_DATA_FOLDER: path.join(profile, "webview2-data"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
  });
const launchDuo = launchAt(duoProfile, DUO_CDP);
const launchCtl = launchAt(ctlProfile, CTL_CDP);

/** Один прогон браузера: запуск → режим → kill. mode=warmup — дождаться
 *  играющего контента (без рекламы) и закрыть (кэш/списки); mode=measure —
 *  форсировать 1080p, 5 с разгон, дельта дропов за MEASURE_MS. settle —
 *  ждать полной смерти процессов профиля (DuoPulse/WebView2). */
async function runOnce(name, mode, launch, port, settle) {
  const app = launch();
  let ws = null;
  try {
    ws = await waitYt(port);
    if (!ws) throw new Error(`${name}: YouTube-цель не поднялась (${mode})`);
    if (mode === "warmup") {
      let warmed = false;
      let adSeen = false;
      for (let i = 0; i < 150 && !warmed; i++) {
        // muted-play — иначе свежий профиль не стартует автоплей и прогрев
        // не дождётся кадра
        await evalIn(ws, `(function () {
          const v = document.querySelector('video');
          if (v && v.paused) { v.muted = true; v.play().catch(() => {}); }
          return true;
        })()`).catch(() => {});
        const st = await stateOf(ws);
        if (st && !st.novideo) {
          if (st.ad) adSeen = true;
          if (st.playing) warmed = true;
        }
        if (!warmed) await sleep(1000);
      }
      if (!warmed) throw new Error(`${name}: прогрев не дошёл до контента`);
      console.log(`  ${name} прогрев: видео играет${adSeen ? " (видна реклама — ждём кэш)" : ""}`);
      await sleep(8000); // досматриваем ролик — кэш видео тёплый
      return null;
    }
    const ready = await waitHd1080(ws);
    if (!ready) throw new Error(`${name}: 1080p-контент не играет (проверь, что видео имеет формат 1080p60)`);
    await sleep(5000); // разгон декодера
    const q1 = await stateOf(ws);
    await sleep(MEASURE_MS);
    const q2 = await stateOf(ws);
    const drops = q2.dropped - q1.dropped;
    const frames = q2.total - q1.total;
    console.log(
      `  ${name} замер: ${drops} дропов / ${frames} кадров за минуту (${(frames / (MEASURE_MS / 1000)).toFixed(1)} fps, ${ready.width}×${ready.height}); дельта битых: ${(drops / Math.max(frames, 1) * 100).toFixed(2)}%`,
    );
    return { drops, frames, width: ready.width, height: ready.height };
  } finally {
    ws?.close();
    await killTree(app.pid);
    if (settle) await settle();
    await sleep(1200);
  }
}

let failures = 0;
let duo = null;
let ctl = null;
try {
  console.log("DuoPulse (блокировщик включён):");
  await runOnce("DuoPulse", "warmup", launchDuo, DUO_CDP, () => waitWebViewDown(duoProfile));
  duo = await runOnce("DuoPulse", "measure", launchDuo, DUO_CDP, () => waitWebViewDown(duoProfile));
  check("P-05 сценарий: DuoPulse играет 1080p контент", duo.height >= 1080, `${duo.width}×${duo.height}`);

  console.log("Контроль — DuoPulse (блокировщик выключен, решение 21.10.2026 duopulse_047_control):");
  await runOnce("контроль", "warmup", launchCtl, CTL_CDP, () => waitWebViewDown(ctlProfile));
  ctl = await runOnce("контроль", "measure", launchCtl, CTL_CDP, () => waitWebViewDown(ctlProfile));
  check("P-05 сценарий: контроль (без блокировщика) играет 1080p контент", ctl.height >= 1080, `${ctl.width}×${ctl.height}`);

  const ok = duo.drops <= ctl.drops;
  check(
    `P-05 дропы DuoPulse ≤ контроль без блокировщика (${duo.drops} vs ${ctl.drops} за минуту)`,
    ok,
    `цель — не хуже контроля (docs/04 §2: трактовка 20.10.2026, контроль с 21.10.2026 — DuoPulse без блокировщика); абсолют «0/мин» — только при аппаратном декоде кодека`,
  );
  if (!ok) failures++;
} catch (e) {
  failures++;
  console.error("E2E ERROR:", e.message);
} finally {
  // контроль шёл с выключенным блокировщиком по settings.json — убедимся,
  // что приложение не перезаписало ключ (санити подложенного конфига)
  try {
    const s = JSON.parse(fs.readFileSync(path.join(ctlProfile, "DuoPulse", "profile", "settings.json"), "utf8"));
    if (s?.adblock?.enabled !== false) {
      failures++;
      console.error(`FAIL  контроль: settings.json не держит adblock.enabled=false (${JSON.stringify(s?.adblock)})`);
    }
  } catch {}
  try {
    fs.rmSync(duoProfile, { recursive: true, force: true });
  } catch {}
  try {
    fs.rmSync(ctlProfile, { recursive: true, force: true });
  } catch {}
  await sleep(1000);
}

const failed = results.filter((r) => !r.ok).length + failures;
console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES: " + failed} (${results.length} проверок)`);
process.exit(failed === 0 ? 0 : 1);
