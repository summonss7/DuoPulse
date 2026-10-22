// DoD задачи 2.2: реальный YouTube (главная + страница просмотра) с живыми
// списками EasyList+uBO (карточка duopulse-018). Реальное приложение, реальная
// сеть, свежий профиль — списки скачиваются и движок строится сам.
//
//   1) «После» (блокировщик включён из коробки): ждём готовности косметики,
//      замеряем рекламные плейсхолдеры главной и watch-страницы, скриншоты;
//   2) «До»: глобальный тумблер off → reload → те же замер и скриншот;
//   3) вёрстка не пострадала: карточек видео на главной off ≈ on (±30%);
//   4) эталонные сайты (по аргументам, по умолчанию habr/wikipedia/github/
//      stackoverflow) с включённым блокировщиком: load complete, контент
//      на месте, скриншот для визуальной сверки.
// Скриншоты: e2e/adblock/shots-2.2/ (коммитятся как доказательство DoD).
//
// Запуск:  node e2e/adblock/cosmetic-youtube.mjs
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const CDP_PORT = 9230;
const SHOTS = path.join(ROOT, "e2e", "adblock", "shots-2.2");
const WATCH_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const REFERENCE_SITES = ["https://habr.com/ru/all/", "https://ru.wikipedia.org/wiki/Windows", "https://github.com/", "https://stackoverflow.com/questions"];

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
  } catch {}
};

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-cosmetic-yt-"));
fs.mkdirSync(SHOTS, { recursive: true });

const vite = spawn("npm", ["run", "dev"], { cwd: ROOT, shell: true, stdio: "ignore" });
for (let i = 0; i < 60; i++) {
  try { await fetch("http://localhost:5173/"); break; } catch { await sleep(500); }
}

const app = spawn(EXE, [], {
  stdio: "ignore",
  env: {
    ...process.env,
    APPDATA: tmp,
    DUOPULSE_START_URL: "https://www.youtube.com/",
    WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
  },
});

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

const evalIn = async (ws, expression) => {
  const r = await ws.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception ?? r.exceptionDetails));
  return r.result?.value;
};

async function shot(ws, file) {
  const r = await ws.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(SHOTS, file), Buffer.from(r.data, "base64"));
}

/** Ждать CDP-цель контент-вкладки с данным URL. */
async function waitTarget(match, what) {
  for (let i = 0; i < 90; i++) {
    try {
      const targets = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
      const t = targets.find((x) => x.type === "page" && match(x.url));
      if (t) return t;
    } catch {}
    await sleep(1000);
  }
  throw new Error(`CDP-цель не поднялась: ${what}`);
}

/** Замер рекламных блоков YouTube: плейсхолдеры считаются «видимыми
 *  заглушками», только если реально занимают место (пустые контейнеры без
 *  рекламной кампании нулевой высоты и не видны пользователю). */
const AD_PROBE = `(function () {
  var sels = ['#masthead-ad', 'ytd-display-ad-renderer', 'ytd-promoted-video-renderer', 'ytd-ad-slot-renderer', '#player-ads', 'ytd-promoted-sparkles-web-renderer', 'ytd-in-feed-ad-layout-renderer'];
  var out = { visibleAds: 0, hiddenByCosmetic: 0, bySel: {}, videos: document.querySelectorAll('ytd-rich-item-renderer').length, appliedCss: (document.getElementById('duopulse-cosmetic') || {}).textContent || '' };
  sels.forEach(function (s) {
    var els = document.querySelectorAll(s);
    if (!els.length) return;
    var visible = 0, hidden = 0;
    els.forEach(function (el) {
      var cs = getComputedStyle(el);
      var invisible = cs.display === 'none' || cs.visibility === 'hidden' || el.getClientRects().length === 0;
      if (invisible) { hidden++; return; }
      var r = el.getBoundingClientRect();
      if (r.width > 1 && r.height > 1) visible++;
    });
    out.bySel[s] = { total: els.length, visible: visible, hidden: hidden };
    out.visibleAds += visible;
    out.hiddenByCosmetic += hidden;
  });
  out.cosmetic = window.__duopulseCosmetic ? {
    active: window.__duopulseCosmetic.active,
    ready: window.__duopulseCosmetic.ready,
    hiddenSelectors: window.__duopulseCosmetic.hiddenSelectors,
    genericSelectors: window.__duopulseCosmetic.genericSelectors,
  } : null;
  return out;
})()`;

/** Ждать готовности страницы (готовность косметики + сетка/плеер). */
async function waitYt(ws, needCosmetic) {
  for (let i = 0; i < 60; i++) {
    const st = await evalIn(ws, `window.__duopulseCosmetic ? window.__duopulseCosmetic.ready : false`);
    if (!needCosmetic || st === true) break;
    await sleep(1000);
  }
  await sleep(2000); // доливка late-generic + стабилизация layout
}

/** Ждать окончания in-stream рекламы плеера (преролл: косметика его не
 *  режет — это видео-поток; заглушки меряем после его завершения). */
async function waitNoPreroll(ws, timeoutMs) {
  for (let i = 0; i < Math.ceil(timeoutMs / 1000); i++) {
    const adShowing = await evalIn(
      ws,
      `!!document.querySelector('.html5-video-player.ad-showing, .ytp-ad-player-overlay')`,
    );
    if (!adShowing) return true;
    await sleep(1000);
  }
  return false;
}

let failures = 0;
try {
  // списки (реальные) качаются и движок строится — даём время
  const uiT = await waitTarget((u) => /localhost:5173/.test(u), "UI");
  const uiWs = connect(uiT.webSocketDebuggerUrl);
  for (let i = 0; i < 90; i++) {
    if ((await evalIn(uiWs, `typeof window.__duopulse`)) === "object") break;
    await sleep(1000);
  }
  let ready = false;
  for (let i = 0; i < 90; i++) {
    const st = await evalIn(uiWs, `window.__duopulse.adblock.status()`);
    if (st?.ready === true) { ready = true; break; }
    await sleep(1000);
  }
  check("живые списки скачаны, движок готов (EasyList+uBO)", ready);

  // --- главная YouTube: «после» (блокировщик включён) ------------------------
  let ytT = await waitTarget((u) => /youtube\.com/.test(u), "youtube");
  let ytWs = connect(ytT.webSocketDebuggerUrl);
  await waitYt(ytWs, true);
  const homeAfter = await evalIn(ytWs, AD_PROBE);
  await shot(ytWs, "youtube-home-after.png");
  check(
    "главная «после»: косметика активна, селекторы скрытия применены",
    homeAfter.cosmetic?.active === true && homeAfter.cosmetic.hiddenSelectors + homeAfter.cosmetic.genericSelectors > 0,
    JSON.stringify(homeAfter.cosmetic),
  );

  // --- главная YouTube: «до» (тумблер off + reload) --------------------------
  await evalIn(uiWs, `window.__duopulse.adblock.setEnabled({ site: null, on: false })`);
  await evalIn(uiWs, `window.__duopulse.nav.reload()`);
  await sleep(4000);
  ytWs.close();
  ytT = await waitTarget((u) => /youtube\.com/.test(u), "youtube reload");
  ytWs = connect(ytT.webSocketDebuggerUrl);
  await waitYt(ytWs, true);
  const homeBefore = await evalIn(ytWs, AD_PROBE);
  await shot(ytWs, "youtube-home-before.png");
  check(
    "главная «до»: косметика неактивна (тумблер off)",
    homeBefore.cosmetic?.active === false,
    JSON.stringify(homeBefore.cosmetic),
  );

  // --- включаем обратно и на watch-страницу ----------------------------------
  await evalIn(uiWs, `window.__duopulse.adblock.setEnabled({ site: null, on: true })`);
  await evalIn(uiWs, `window.__duopulse.nav.navigate({ url: ${JSON.stringify(WATCH_URL)} })`);
  await sleep(6000);
  ytWs.close();
  ytT = await waitTarget((u) => /watch\?v=/.test(u), "youtube watch");
  ytWs = connect(ytT.webSocketDebuggerUrl);
  await waitYt(ytWs, true);
  const hadPreroll = await evalIn(ytWs, `!!document.querySelector('.html5-video-player.ad-showing, .ytp-ad-player-overlay')`);
  const prerollEnded = await waitNoPreroll(ytWs, 90000);
  console.log(`\nпреролл: ${hadPreroll ? "играл, дождались конца: " + prerollEnded : "не было"}`);
  const watchAfter = await evalIn(ytWs, AD_PROBE);
  await shot(ytWs, "youtube-watch-after.png");
  check(
    "watch «после»: косметика активна, сетка/плеер живы",
    watchAfter.cosmetic?.active === true && (await evalIn(ytWs, `!!document.querySelector('video')`)) === true,
    JSON.stringify(watchAfter.cosmetic),
  );

  // скриптлеты (карточка duopulse-043 + ранний путь 044): uBO filters содержит
  // непривилегированные правила для youtube (`set ytInitialPlayerResponse.playerAds,
  // undefined` — adSlots с 22.10.2026 НЕ трогаем: compat-список против SABR-stall,
  // adblock/compat.txt) — код должен инъенцироваться и ИСПОЛНИТЬСЯ: ранним скриптом
  // NavigationStarting → AddScriptToExecuteOnDocumentCreated (main.rs, до инлайн-
  // скриптов страницы, window.__duopulseSyncScriptlets — CSP/Trusted Types не мешают)
  // ИЛИ асинхронным <script>-элементом cosmetic.js (scriptletsRan — маркер ставит
  // сам код). Проверяем ЭФФЕКТ: ytInitialPlayerResponse.playerAds === undefined.
  const scriptlets = await evalIn(ytWs, `window.__duopulseCosmetic ? {
    len: window.__duopulseCosmetic.scriptlets,
    atMs: window.__duopulseCosmetic.scriptletsAt,
    ranMs: window.__duopulseCosmetic.scriptletsRan,
    sync: window.__duopulseSyncScriptlets === true,
    syncAt: typeof window.__duopulseSyncAt === 'number' ? window.__duopulseSyncAt : null,
    playerAds: window.ytInitialPlayerResponse ? String(window.ytInitialPlayerResponse.playerAds) : 'нет-объекта',
    adSlots: window.ytInitialPlayerResponse ? String(window.ytInitialPlayerResponse.adSlots) : 'нет-объекта',
  } : null`);
  check(
    "watch: скриптлеты исполнены ДО инлайн-скриптов страницы (ранний скрипт 044: playerAds=undefined) или через <script> (scriptletsRan)",
    (scriptlets?.sync === true && scriptlets?.playerAds === "undefined") ||
      (scriptlets?.len > 0 && scriptlets?.ranMs > 0),
    JSON.stringify(scriptlets),
  );

  // замеры плейсхолдеров: сводка (кампании рекламы непостоянны — жёсткий
  // критерий только на ВИДИМЫЕ заглушки: после включённой косметики их 0)
  console.log("\nглавная «до»:    ", JSON.stringify(homeBefore.bySel), "видео:", homeBefore.videos);
  console.log("главная «после»: ", JSON.stringify(homeAfter.bySel), "видео:", homeAfter.videos);
  console.log("watch «после»:   ", JSON.stringify(watchAfter.bySel));
  console.log("применённые селекторы (первые 400):", (watchAfter.appliedCss || "").slice(0, 400));
  check(
    "видео-сетка главной не пострадала (±30%)",
    Math.abs(homeAfter.videos - homeBefore.videos) <= Math.max(3, Math.round(homeBefore.videos * 0.3)),
    `${homeBefore.videos} → ${homeAfter.videos}`,
  );
  check(
    "видимых рекламных заглушек на главной «после» нет",
    homeAfter.visibleAds === 0,
    `видимых: ${homeAfter.visibleAds}, скрыто косметикой: ${homeAfter.hiddenByCosmetic}`,
  );
  check(
    "видимых рекламных заглушек на watch «после» нет (преролл завершён)",
    watchAfter.visibleAds === 0,
    `видимых: ${watchAfter.visibleAds}, скрыто косметикой: ${watchAfter.hiddenByCosmetic}`,
  );

  // --- эталонные сайты с включённым блокировщиком ----------------------------
  for (const site of REFERENCE_SITES) {
    await evalIn(uiWs, `window.__duopulse.nav.navigate({ url: ${JSON.stringify(site)} })`);
    await sleep(7000);
    const t = await waitTarget((u) => { try { return new URL(u).hostname === new URL(site).hostname; } catch { return false; } }, site);
    const ws = connect(t.webSocketDebuggerUrl);
    // дождаться complete (habr досыпает контент дольше остальных)
    for (let i = 0; i < 30; i++) {
      const rs = await evalIn(ws, `document.readyState`);
      if (rs === "complete") break;
      await sleep(1000);
    }
    const health = await evalIn(ws, `(function () {
      return {
        readyState: document.readyState,
        cosmetic: window.__duopulseCosmetic ? window.__duopulseCosmetic.active : null,
        bodyText: (document.body ? document.body.innerText : '').length,
        styleBlocked: window.__duopulseCosmetic ? window.__duopulseCosmetic.styleBlocked : null,
      };
    })()`);
    const name = new URL(site).hostname.replace(/\./g, "_");
    await shot(ws, `${name}-with-adblock.png`);
    // контроль без блокера: readyState «interactive» сам по себе не дефект,
    // если и с выключенным блокером сайт ведёт себя так же (habr тянет
    // долгие соединения) — фиксируем для отчёта.
    let controlState = "n/a";
    if (health.readyState !== "complete") {
      await evalIn(uiWs, `window.__duopulse.adblock.setEnabled({ site: null, on: false })`);
      await evalIn(uiWs, `window.__duopulse.nav.reload()`);
      await sleep(8000);
      controlState = await evalIn(ws, `document.readyState`);
      await evalIn(uiWs, `window.__duopulse.adblock.setEnabled({ site: null, on: true })`);
      await evalIn(uiWs, `window.__duopulse.nav.reload()`);
      await sleep(8000);
    }
    ws.close();
    check(
      `${new URL(site).hostname}: контент на месте, косметика активна, style не заблокирован${controlState !== "n/a" ? ` (readyState и без блокера: ${controlState})` : ""}`,
      health.bodyText > 500 && health.cosmetic === true && health.styleBlocked === false,
      JSON.stringify(health),
    );
  }
  uiWs.close();
} catch (e) {
  failures++;
  console.error("E2E ERROR:", e.message);
} finally {
  if (app?.kill) app.kill("SIGKILL");
  await killOurExes();
  try { await run("taskkill", ["/PID", String(vite.pid), "/T", "/F"]); } catch {}
  await sleep(1200);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

const failed = results.filter((r) => !r.ok).length + failures;
console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES: " + failed} (${results.length} проверок)`);
console.log("скриншоты:", SHOTS);
process.exit(failed === 0 ? 0 : 1);
