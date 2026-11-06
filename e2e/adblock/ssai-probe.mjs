// Диагностический стенд SSAI-преролла YouTube (карточка duopulse-080).
// Отвечает на вопрос «почему реклама всё ещё играет в начале видео» по фактам:
//   1) инъекция скриптлетов: ранний sync-путь (__duopulseSyncScriptlets),
//      размер инъецированного кода, момент исполнения (мс от navigationStart);
//   2) исход: показана ли реклама (.ad-showing / оверлеи), SSAP-маркер SSAI
//      в stats for nerds (debug_info «SSAP, AD»), стартовал ли контент;
//   3) состояние движка: adblock.status — списки/правила/готовность.
// Протокол как в p07.mjs: свежий профиль на прогон (frequency cap рекламы по
// кукам), списки — seed из прогретого профиля, stdio — в файл рядом.
//
// Запуск:  node e2e/adblock/ssai-probe.mjs [--deep] [url-видео …]
//   без аргументов — 3 видео итоговым зондом; --deep — один видео, плотный
//   дамп состояния во время рекламы (карточка duopulse-080: SSAI или
//   клиентская, что в playerResp, какие нативы запатчены).
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const CDP_PORT = 9228;
const DEEP = process.argv.includes("--deep");
const VIDEOS = process.argv.slice(2).filter((a) => !a.startsWith("--")).length
  ? process.argv.slice(2).filter((a) => !a.startsWith("--"))
  : DEEP
    ? ["https://www.youtube.com/watch?v=dQw4w9WgXcQ"]
    : [
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "https://www.youtube.com/watch?v=9bZkp7q19f0",
        "https://www.youtube.com/watch?v=kJQP7kiw5Fk",
      ];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, opts, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))),
  );

// ── инфраструктура p07 (kill/CDP/цели) ──────────────────────────────────────
const killOurExes = async () => {
  const listOur = () =>
    run("powershell", ["-NoProfile", "-Command",
      `@(Get-CimInstance Win32_Process -Filter "Name='duopulse.exe'" | Where-Object { $_.ExecutablePath -eq '${EXE}' }).Count`,
    ], { timeout: 20000 }).then((s) => Number(String(s).trim()) || 0);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await run("powershell", ["-NoProfile", "-Command",
        `Get-CimInstance Win32_Process -Filter "Name='duopulse.exe'" | Where-Object { $_.ExecutablePath -eq '${EXE}' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }`,
      ], { timeout: 30000 });
    } catch { /* уже мертвы — проверим фактом */ }
    let alive;
    try { alive = await listOur(); } catch { return; }
    if (alive === 0) return;
    await sleep(1500);
  }
  throw new Error("killOurExes: процессы не умерли за 3 попытки");
};

async function waitCdpFree() {
  for (let i = 0; i < 30; i++) {
    try {
      await fetch(`http://localhost:${CDP_PORT}/json`, { signal: AbortSignal.timeout(1000) });
      await sleep(1000);
    } catch (e) {
      if (e?.name === "TimeoutError") { await sleep(1000); continue; }
      return;
    }
  }
  throw new Error(`порт CDP ${CDP_PORT} не освободился`);
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
  const open = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  open.catch(() => {});
  const send = (method, params = {}, timeoutMs = 20000) =>
    open.then(() =>
      new Promise((res, rej) => {
        const i = ++id;
        const t = setTimeout(() => { pending.delete(i); rej(new Error(`CDP ${method}: таймаут ${timeoutMs} мс`)); }, timeoutMs);
        pending.set(i, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
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

async function targets() {
  let lastJson = null;
  for (let i = 0; i < 90; i++) {
    try {
      const t = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
      lastJson = t;
      const ui = t.find((x) => x.type === "page" && /localhost:5173/.test(x.url));
      const yt = t.find((x) => x.type === "page" && /youtube\.com/.test(x.url));
      if (ui && yt) return { ui, yt };
    } catch {}
    await sleep(1000);
  }
  throw new Error(`CDP-цели не поднялись (${JSON.stringify(lastJson)?.slice(0, 800)})`);
}

// ── зонд страницы: состояние косметики + реклама + SSAP ────────────────────
const PROBE = `(() => {
  const c = window.__duopulseCosmetic || null;
  const player = document.getElementById('movie_player');
  let stats = null;
  try { stats = player && player.getStatsForNerds ? player.getStatsForNerds() : null; } catch (e) {}
  const v = document.querySelector('video');
  // маркеры 080: применился ли rpnt-replacement (пейлоад в тексте DOM-скрипта),
  // отработал ли UA-токен-механизм serverContract (channel/lactmilli/yahi/inline
  // в INNERTUBE_CONTEXT.client.userAgent)
  let rpnt = null, ua = null;
  try { rpnt = document.documentElement.textContent.includes('YOUTUBE_PREMIUM_LOGO'); } catch (e) {}
  try { ua = (window.ytcfg && window.ytcfg.data_ && window.ytcfg.data_.INNERTUBE_CONTEXT.client.userAgent || '').match(/channel|lactmilli|yahi|inline/g); } catch (e) {}
  return JSON.stringify({
    sync: window.__duopulseSyncScriptlets === true,
    syncAt: window.__duopulseSyncAt ?? null,
    cos: c ? { js: c.scriptlets ?? 0, ran: c.scriptletsRan ?? null, active: !!c.active } : null,
    ad: !!document.querySelector('.ad-showing, .ytp-ad-player-overlay, .ytp-ad-image-overlay'),
    ssap: stats && stats.debug_info ? String(stats.debug_info).slice(0, 24) : null,
    playing: !!(v && v.currentTime > 0.5 && !v.paused && !v.ended),
    t: v ? Math.round(v.currentTime) : null,
    rpnt,
    uaTokens: ua,
  });
})()`;

// Глубокий зонд (duopulse-080): во время рекламы — тип рекламы (SSAP/оверлеи),
// содержимое playerResponse/ytInitialPlayerResponse, патчи нативов (какие
// скриптлеты реально исполнились в мире страницы).
const DEEP_PROBE = `(() => {
  const player = document.getElementById('movie_player');
  let stats = null, pr = null, ps = null;
  try { stats = player && player.getStatsForNerds && player.getStatsForNerds(); } catch (e) {}
  try { pr = player && player.getPlayerResponse && player.getPlayerResponse(); } catch (e) {}
  try { ps = player && player.getProgressState && player.getProgressState(); } catch (e) {}
  const ipr = window.ytInitialPlayerResponse || null;
  const v = document.querySelector('video');
  const fn = (f) => { try { return String(f).slice(0, 60); } catch (e) { return '?'; } };
  return JSON.stringify({
    adClass: player ? player.className.includes('ad-showing') : null,
    ov: [document.querySelector('.ytp-ad-player-overlay') && 'video', document.querySelector('.ytp-ad-image-overlay') && 'image', document.querySelector('.ytp-ad-skip-button, .ytp-ad-skip-button-modern') && 'skip', document.querySelector('.ytp-ad-badge') && 'badge', document.querySelector('.duopulse-ad-skip') && 'duo'].filter(Boolean).join('|') || null,
    debug: stats ? String(stats.debug_info || '').slice(0, 48) : null,
    adUri: v && v.currentSrc ? decodeURIComponent(v.currentSrc).replace(/https:\\/\\//, '').slice(0, 140) : null,
    prog: ps ? Math.round(ps.duration) + 's/' + Math.round(ps.current) + 's' : null,
    pr: pr ? { ads: !!pr.playerAds, place: !!pr.adPlacements, slots: !!pr.adSlots } : null,
    ipr: ipr ? { ads: !!ipr.playerAds, place: !!ipr.adPlacements, slots: !!ipr.adSlots } : 'none',
    patched: ['stringify:' + (fn(JSON.stringify).includes('native code') ? 'n' : 'P'), 'fetch:' + (fn(window.fetch).includes('native code') ? 'n' : 'P'), 'mapHas:' + (fn(Map.prototype.has).includes('native code') ? 'n' : 'P'), 'arrPush:' + (fn(Array.prototype.push).includes('native code') ? 'n' : 'P'), 'pThen:' + (fn(Promise.prototype.then).includes('native code') ? 'n' : 'P')].join(' '),
    t: v ? Math.round(v.currentTime) : null,
  });
})()`;

function launchApp(tmp, video) {
  const stdioLog = path.join(tmp, "app-stdio.log");
  const out = fs.openSync(stdioLog, "a");
  const app = spawn(EXE, [], {
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      APPDATA: tmp,
      DUOPULSE_START_URL: video,
      WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
  });
  app.on("exit", (code) => { fs.closeSync(out); console.log(`    [app pid ${app.pid}] вышел, код ${code} (stdio: ${stdioLog})`); });
  return app;
}

async function probeRun(video, seedFilters) {
  await sleep(4000); // приладка после kill (вывод p07)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-ssai-"));
  const profile = path.join(tmp, "DuoPulse", "profile");
  fs.mkdirSync(profile, { recursive: true });
  if (seedFilters) fs.cpSync(seedFilters, path.join(profile, "filters"), { recursive: true });
  const app = launchApp(tmp, video);
  let ui, yt;
  try {
    const t = await targets();
    ui = connect(t.ui.webSocketDebuggerUrl);
    yt = connect(t.yt.webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) {
      if ((await evalIn(ui, `typeof window.__duopulse`)) === "object") break;
      await sleep(500);
    }
    let engine = null;
    for (let i = 0; i < 30; i++) {
      const st = await evalIn(ui, `window.__duopulse.adblock.status()`);
      if (st?.ready === true) { engine = st; break; }
      await sleep(500);
    }
    if (!engine) throw new Error("движок не построился из seed-кэша");
    console.log(
      `  движок: ${engine.lists.map((l) => `${l.name}=${l.rules}`).join(", ")} (enabled=${engine.enabled})`,
    );
    // таймлайн 75 с: раз в 1.5 с зонд; фиксируем ПЕРВЫЕ появления фактов
    // (--deep: 45 с раз в 2 с, полный дамп каждой пробы)
    const deepSamples = [];
    const first = {};
    const WINDOW_MS = DEEP ? 45000 : 75000;
    const PERIOD_MS = DEEP ? 2000 : 1500;
    const probe = DEEP ? DEEP_PROBE : PROBE;
    const deadline = Date.now() + WINDOW_MS;
    while (Date.now() < deadline) {
      let p;
      try {
        p = JSON.parse(await evalIn(yt, probe));
      } catch {
        const tt = await targets();
        yt.close();
        yt = connect(tt.yt.webSocketDebuggerUrl);
        continue;
      }
      if (DEEP) {
        deepSamples.push({ at: Math.round((Date.now() - (deadline - WINDOW_MS)) / 1000), ...p });
        console.log(
          `    t+${deepSamples.at(-1).at}s ad=${p.adClass} ov=${p.ov} debug=${JSON.stringify(p.debug)} prog=${p.prog}` +
            `\n      pr=${JSON.stringify(p.pr)} ipr=${JSON.stringify(p.ipr)} patched=${p.patched} uri=${p.adUri ? p.adUri.slice(0, 60) : null}`,
        );
        if (p.adClass === false && p.t > 1) break; // контент пошёл
      } else {
        for (const k of ["sync", "ad", "ssap", "playing"]) {
          const val = k === "ssap" ? (p.ssap && p.ssap.includes("SSAP") ? p.ssap : null) : p[k];
          if (val && !first[k]) first[k] = { at: Math.round((Date.now() - (deadline - WINDOW_MS)) / 1000), val: k === "ssap" ? p.ssap : true };
        }
        // контент стартовал и (не в рекламе) — достаточно
        if (first.playing && !p.ad) break;
      }
      await sleep(PERIOD_MS);
    }
    const final = JSON.parse(await evalIn(yt, probe));
    return { first, final, deepSamples };
  } finally {
    ui?.close();
    yt?.close();
    try { await run("taskkill", ["/PID", String(app.pid), "/T", "/F"]); } catch {}
    app.kill("SIGKILL");
    await killOurExes();
    await waitCdpFree();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── прогрев списков (живые EasyList/uBO/quick-fixes + engine.bin) ──────────
async function warmSeed() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-ssai-seed-"));
  const app = launchApp(tmp, VIDEOS[0]);
  let ui, yt;
  try {
    const t = await targets();
    ui = connect(t.ui.webSocketDebuggerUrl);
    yt = connect(t.yt.webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) {
      if ((await evalIn(ui, `typeof window.__duopulse`)) === "object") break;
      await sleep(500);
    }
    for (let i = 0; i < 120; i++) {
      const st = await evalIn(ui, `window.__duopulse.adblock.status()`);
      if (st?.ready === true) {
        console.log(`  прогрев: ${st.lists.map((l) => `${l.name}=${l.rules}`).join(", ")}`);
        break;
      }
      await sleep(1000);
    }
    return { seedDir: path.join(tmp, "DuoPulse", "profile", "filters"), tmp, ui, yt, app };
  } catch (e) {
    ui?.close(); yt?.close(); app.kill("SIGKILL");
    await killOurExes();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    throw e;
  }
}

const vite = spawn("npm", ["run", "dev"], { cwd: ROOT, shell: true, stdio: "ignore" });
let seedTmp = null;
try {
  for (let i = 0; i < 60; i++) {
    try { await fetch("http://localhost:5173/"); break; } catch { await sleep(500); }
  }
  await killOurExes();
  await waitCdpFree();
  console.log("прогрев: скачиваем живые списки и собираем движок…");
  const warm = await warmSeed();
  seedTmp = warm.tmp;
  warm.ui.close(); warm.yt.close();
  await killOurExes();
  await waitCdpFree();

  const results = [];
  for (const video of VIDEOS) {
    console.log(`\nвидео ${video}`);
    let r = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { r = await probeRun(video, warm.seedDir); break; }
      catch (e) { console.log(`  попытка ${attempt} не удалась — ${e.message}`); }
    }
    if (!r) { results.push({ video, error: "прогон не удался" }); continue; }
    if (DEEP) { results.push({ video, deep: r.deepSamples }); continue; }
    const js = r.final.cos?.js ?? 0;
    console.log(
      `  инъекция: sync=${r.final.sync}${r.final.cos?.ran != null ? ` (ранний, +${r.final.cos.ran} мс)` : ""}, js=${js} симв.` +
        `\n  реклама: ${r.first.ad ? `ДА (t+${r.first.ad.at}s)${r.first.ssap ? `, SSAI: ${JSON.stringify(r.first.ssap.val)}` : ""}` : "нет"}` +
        `\n  контент: ${r.first.playing ? `стартовал t+${r.first.playing.at}s` : "не стартовал за 75 с"} (финально playing=${r.final.playing}, ad=${r.final.ad}, t=${r.final.t}s)` +
        `\n  080: rpnt-пейлоад в DOM=${r.final.rpnt}, UA-токены=${JSON.stringify(r.final.uaTokens)}`,
    );
    results.push({ video, ...r });
  }

  fs.writeFileSync(
    path.join(ROOT, "e2e", "adblock", "ssai-last-run.json"),
    JSON.stringify({ date: new Date().toISOString(), results }, null, 2),
  );
  console.log("\nитоги записаны в e2e/adblock/ssai-last-run.json");
} catch (e) {
  console.error("SSAI-PROBE ERROR:", e.message);
  process.exitCode = 1;
} finally {
  if (seedTmp) { try { fs.rmSync(seedTmp, { recursive: true, force: true }); } catch {} }
  try { await run("taskkill", ["/PID", String(vite.pid), "/T", "/F"]); } catch {}
  await killOurExes().catch(() => {});
}
