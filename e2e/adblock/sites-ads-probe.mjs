// Стенд рекламы кинотеатров uakinogo/kinogo (карточка duopulse-188): живая
// страница фильма + плеер hdvb (iframe cinemar.cc), встроенный список
// duopulse-sites (попандер deltarockme.com + VAST-прероллы aglNNN/adstag)
// поверх живых EasyList/uBO. Проверки (PASS/FAIL, ретраи как у tube-ads):
//   1) duopulse-sites в adblock.status: правила разобраны, без ошибок;
//   2) все запросы к рекламным хостам (deltarockme/agl*/adstag*/aj2517/
//      srv224) режутся движком (ERR_BLOCKED_BY_CLIENT/403), ни один не
//      проходит 2xx; среди них есть реально попытанные (проверка не пустая);
//   3) фильм играет: video в плеере — длительность фильма (>10 мин, не
//      15–60-с преролл), время идёт (t>3), не на паузе; клик play —
//      реальный Input-жест по центру iframe в родительской вкладке
//      (плеер-iframe не OOPIF: своего CDP-таргета нет, video-элемент читаем
//      через execution-context iframe в таргете вкладки);
//   4) попандеров нет: window.open-обёртки (document-start, все фреймы) +
//      новые CDP-таргеты после честного клика по странице;
//   5) «Скачать» в плеере (soft): панель открывается, новые вкладки после
//      клика — не рекламные хосты.
// Свежий профиль на прогон; списки — живые (EasyList/uBO качает движок,
// duopulse-sites — из бинарника: стенд проверяет и проводку списка).
//
// Запуск:  node e2e/adblock/sites-ads-probe.mjs [url]
//   (по умолчанию — страница «Человек-паук: Новый день» с пожелания 188).
// Результат — e2e/adblock/sites-ads-last-run.json (gitignore, рантайм);
// скриншоты — %TEMP%/duopulse-188-*.png.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const CDP_PORT = 9231;
const URL_ = process.argv[2] || "https://uakinogo.io/novinki/116356-chelovek-pauk-novyy-den.html";
// Рекламные хосты: наши (deltarockme/agl/adstag) + уже закрытые EasyList
// (aj2517/srv224 — в ансамбле они тоже обязаны быть порезаны) + цепочка
// VAST из живого прогона (kinoroll — редиректор тегов, kingads — VAST/dsp,
// mygaru — ident-пиксель).
const AD_HOST_RE = /(^|\.)(deltarockme\.com|agl\d+\.(site|shop)|adstag\d+\.xyz|aj2517\.bid|srv224\.com|kinoroll\.com|kingads\.digital|mygaru\.com)$/i;
const SECS = Number(process.env.DUOPULSE_E2E_SECS) || 75;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, opts, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))));

const EXE_WIN = EXE.replace(/\\/g, "\\\\");
/** Убить только экземпляры НАШЕГО exe (Артёмов DuoPulse не трогаем). */
const killOurExes = async () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await run("powershell", ["-NoProfile", "-Command",
        `Get-CimInstance Win32_Process -Filter "Name='duopulse.exe'" | Where-Object { $_.ExecutablePath -eq '${EXE_WIN}' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F`,
      ], { timeout: 30000 });
    } catch { /* уже мертвы — проверим фактом */ }
    let alive;
    try {
      alive = Number(String(await run("powershell", ["-NoProfile", "-Command",
        `@(Get-CimInstance Win32_Process -Filter "Name='duopulse.exe'" | Where-Object { $_.ExecutablePath -eq '${EXE_WIN}' }).Count`,
      ], { timeout: 20000 })).trim()) || 0;
    } catch { return; }
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
  const handlers = new Set();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    } else if (m.method) {
      handlers.forEach((h) => h(m));
    }
  };
  const open = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  open.catch(() => {});
  const send = (method, params = {}, timeoutMs = 25000, sessionId) =>
    open.then(() =>
      new Promise((res, rej) => {
        const i = ++id;
        const t = setTimeout(() => { pending.delete(i); rej(new Error(`CDP ${method}: таймаут ${timeoutMs} мс`)); }, timeoutMs);
        pending.set(i, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
        ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
      }),
    );
  return { send, handlers, close: () => ws.close() };
}

const evalIn = async (ws, expression, contextId, timeoutMs) => {
  const r = await ws.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, ...(contextId ? { contextId } : {}) }, timeoutMs);
  if (r.exceptionDetails) return null; // фрейм мог переехать — не роняем прогон
  return r.result?.value;
};

async function getJson() {
  let lastErr = null;
  for (let i = 0; i < 90; i++) {
    try { return await (await fetch(`http://localhost:${CDP_PORT}/json`)).json(); } catch (e) { lastErr = e; }
    await sleep(1000);
  }
  throw new Error(`CDP /json не поднялся (${lastErr?.message})`);
}

// ── зонды ───────────────────────────────────────────────────────────────────
// Состояние видео плеера (выполняется в execution-context'е iframe плеера).
const VID_PROBE = `(() => {
  const v = document.querySelector('video');
  if (!v) return null;
  return JSON.stringify({
    src: (() => { try { return decodeURIComponent(v.currentSrc || v.src || '').replace(/^https?:\\/\\//, '').slice(0, 90); } catch { return '?'; } })(),
    t: Math.round(v.currentTime * 10) / 10, dur: Math.round(v.duration || 0), paused: v.paused,
    w: v.videoWidth, h: v.videoHeight,
  });
})()`;

// Центр iframe плеера в координатах родительской вкладки (клик play — реальный
// Input-жест; синтетические клики плеер игнорирует).
const PLAYER_RECT = `(() => {
  const f = document.querySelector('.player-container iframe, iframe[src*="cinemar"], iframe[data-src*="cinemar"], iframe[src*="embf"], iframe[data-src*="embf"]');
  if (!f) return null;
  const r = f.getBoundingClientRect();
  if (r.width < 50) return null;
  return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) });
})()`;

// Кнопка «Скачать» в плеере (soft-фаза): панель и ссылки качеств.
const DL_CLICK = `(() => {
  const btns = [...document.querySelectorAll('div,span,button,a')].filter((b) => {
    const t = (b.textContent || '').trim();
    return t === 'Скачать' && b.getBoundingClientRect().width > 0;
  });
  if (!btns.length) return null;
  btns.sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height);
  btns[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return btns.length;
})()`;

const DL_PANEL = `(() => {
  const links = [...document.querySelectorAll('.download a[href], a.download[href], [class*=download] a[href]')].slice(0, 6).map((a) => a.href.slice(0, 90));
  return links.length ? JSON.stringify(links) : null;
})()`;

// Рекламные ресурсы по resource timing: WebResourceRequested-блокировка
// невидима в CDP Network (запрос режется до сетевого стека), но страница
// видит свою карту загрузок: попытка остаётся (deltarockme — <script src> в
// head), прошедшей она быть не может (transferSize>0 = утечка).
const AD_TIMING = `(() => {
  const re = /(^|\\.)((deltarockme\\.com)|(agl\\d+\\.(site|shop))|(adstag\\d+\\.xyz)|(aj2517\\.bid)|(srv224\\.com))$/i;
  const h = (u) => { try { return new URL(u).host; } catch { return null; } };
  return JSON.stringify(performance.getEntriesByType('resource')
    .filter((e) => { const x = h(e.name); return x && re.test(x); })
    .slice(0, 30)
    .map((e) => ({ host: h(e.name), transfer: e.transferSize || 0, dur: Math.round(e.duration) })));
})()`;

// Сеть таргета → коллекция прогона (как tube-ads-probe; iframe не OOPIF —
// его запросы видны в Network вкладки).
function tapNetwork(conn, net) {
  conn.handlers.add((m) => {
    if (m.method === "Network.requestWillBeSent") {
      const r = m.params.request;
      net.requests.set(m.params.requestId, { url: r.url, type: m.params.type, ts: Math.round((m.params.wallTime - net.t0) * 10) / 10 });
    } else if (m.method === "Network.responseReceived") {
      const e = net.requests.get(m.params.requestId);
      if (e) { e.status = m.params.response.status; e.mime = m.params.response.mimeType; }
    } else if (m.method === "Network.loadingFailed") {
      const e = net.requests.get(m.params.requestId);
      if (e) { e.failed = m.params.errorText; if (m.params.blockedReason) e.blocked = m.params.blockedReason; }
    }
  });
}

const hostOf = (u) => { try { return new URL(u).host; } catch { return u.slice(0, 40); } };
const isAdHost = (u) => AD_HOST_RE.test(hostOf(u));
// Обёртка window.open на все последующие документы (вкладка + iframe'ы):
// addScriptToEvaluateOnNewDocument применяется к каждому фрейму.
const OPEN_WRAP = `window.__dpPopups = [];
 const __ow = window.open;
 window.open = function (u, ...a) { try { window.__dpPopups.push(String(u).slice(0, 120)); } catch (e) {} return __ow.call(this, u, ...a); };`;

// ── прогон ──────────────────────────────────────────────────────────────────
async function probeRun() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-188-"));
  const app = spawn(EXE, [], {
    stdio: ["ignore", fs.openSync(path.join(tmp, "app-stdio.log"), "a"), "ignore"],
    env: {
      ...process.env,
      APPDATA: tmp,
      DUOPULSE_START_URL: URL_,
      DUOPULSE_E2E_NO_SINGLE_INSTANCE: "1",
      WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
  });
  const net = { requests: new Map(), t0: Date.now() / 1000 };
  const newTargets = [];
  let ui, page, browser;
  const checks = [];
  const check = (name, ok, extra = "") => {
    checks.push({ name, ok, extra });
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  };
  try {
    const host = hostOf(URL_);
    let t = await getJson();
    // UI-цель ждём вместе с dev-хуком (vite мог ещё не отдать бандл —
    // тогда на localhost:5173 лежит error-страница без __duopulse)
    let uiT = null, siteT = null;
    for (let i = 0; i < 90 && !(uiT && siteT); i++) {
      t = await getJson();
      if (!uiT) {
        const cand = t.find((x) => x.type === "page" && /localhost:5173/.test(x.url));
        if (cand) {
          const probe = connect(cand.webSocketDebuggerUrl);
          const ty = await evalIn(probe, `typeof window.__duopulse`).catch(() => null);
          probe.close();
          if (ty === "object") uiT = cand;
        }
      }
      siteT = siteT || t.find((x) => x.type === "page" && x.url.includes(host));
      if (!(uiT && siteT)) await sleep(1000);
    }
    if (!(uiT && siteT)) throw new Error(`цели не поднялись: ui=${!!uiT} site=${!!siteT}`);
    ui = connect(uiT.webSocketDebuggerUrl);
    page = connect(siteT.webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) {
      if ((await evalIn(ui, `typeof window.__duopulse`)) === "object") break;
      await sleep(500);
    }
    // движок: живые EasyList/uBO качаются, duopulse-sites — из бинарника
    let engine = null;
    for (let i = 0; i < 150; i++) {
      const st = await evalIn(ui, `window.__duopulse?.adblock?.status?.() ?? null`);
      if (st?.ready === true) { engine = st; break; }
      await sleep(1000);
    }
    if (!engine) throw new Error("движок не построился (списки не скачались?)");
    console.log(`  движок: ${engine.lists.map((l) => `${l.name}=${l.rules}${l.error ? "!" + l.error : ""}`).join(", ")}`);

    // (1) duopulse-sites: проводка встроенного списка
    const sitesList = engine.lists.find((l) => l.name === "duopulse-sites");
    check(
      "duopulse-sites в ансамбле списков, правила разобраны (>=6), без ошибок",
      !!sitesList && sitesList.rules >= 6 && !sitesList.error,
      JSON.stringify(sitesList),
    );

    // браузерный уровень: новые таргеты = попапы/попандеры/табы скачивания
    // + карта таргетов для поиска OOPIF плеера. setDiscoverTargets присылает
    // и существующие — новые считаем только после разогрева.
    const browserTargets = [];
    try {
      const v = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json();
      browser = connect(v.webSocketDebuggerUrl);
      browser.handlers.add((m) => {
        if (m.method === "Target.targetCreated") {
          const ti = m.params.targetInfo;
          browserTargets.push(ti);
          if (ti.type === "page") newTargets.push(ti.url);
        }
      });
      await browser.send("Target.setDiscoverTargets", { discover: true });
      const existing = await browser.send("Target.getTargets");
      for (const ti of existing.targetInfos) if (!browserTargets.some((x) => x.targetId === ti.targetId)) browserTargets.push(ti);
      await sleep(2500);
      newTargets.length = 0; // существующие не считаем «новыми»
    } catch (e) { console.log(`  (браузерный CDP недоступен: ${e.message})`); }

    await page.send("Network.enable");
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    tapNetwork(page, net);
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: OPEN_WRAP });

    // Плеер — OOPIF (type "iframe", в /json его нет, контексты в родительском
    // таргете не видны — грабли первых прогонов): зондим через браузерный
    // CDP — Target.attachToTarget(flatten) и evaluate с sessionId.
    let playerSid = null;
    let playerUrl = null;
    let playerAttaches = 0;
    let playerAttachLogged = false;
    const attachPlayer = async () => {
      // события targetCreated доезжают не всегда, а таргет iframe рождается
      // с about:blank и меняет URL потом (targetInfoChanged) — сверяемся с
      // getTargets и обновляем URL существующих записей
      if (browser) {
        try {
          const cur = await browser.send("Target.getTargets");
          for (const ti of cur.targetInfos) {
            const ex = browserTargets.find((x) => x.targetId === ti.targetId);
            if (ex) ex.url = ti.url;
            else browserTargets.push(ti);
          }
        } catch { /* браузерный CDP недоступен */ }
      }
      const tid = browserTargets.find((x) => x.type === "iframe" && /cinemar\.cc|embf\.net/.test(x.url))?.targetId;
      if (!playerAttachLogged) {
        playerAttachLogged = true;
        const byType = {};
        for (const t of browserTargets) byType[t.type] = (byType[t.type] || 0) + 1;
        console.log(`  attachPlayer: targets=${JSON.stringify(byType)} tid=${tid ? "есть" : "нет"} browser=${!!browser}`);
      }
      if (!tid || !browser) return false;
      try {
        const r = await browser.send("Target.attachToTarget", { targetId: tid, flatten: true });
        playerSid = r.sessionId;
        playerUrl = browserTargets.find((x) => x.targetId === tid)?.url || null;
        playerAttaches++;
        await browser.send("Runtime.enable", {}, undefined, playerSid).catch(() => {});
        console.log(`  плеер OOPIF: ${String(playerUrl).slice(0, 70)}`);
        return true;
      } catch (e) { console.log(`  attachPlayer: attach не удался — ${e.message}`); playerSid = null; return false; }
    };
    const playerEval = async (expr) => {
      if (!playerSid) return null;
      try {
        const r = await browser.send("Runtime.evaluate", { expression: expr, returnByValue: true }, 20000, playerSid);
        if (r?.exceptionDetails) return null;
        return r?.result?.value ?? null;
      } catch { playerSid = null; return null; } // сессия умерла (навигация) — перевяжем
    };

    // попандер вешается на клик ПОСЛЕ загрузки скрипта: обёртка уже стоит —
    // честный клик в невидимой точке страницы (popunder биндит document)
    await sleep(9000); // страница + lazy-iframe + rocket-loader
    try {
      await page.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: 15, y: 15 });
      await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: 15, y: 15 });
    } catch {}
    // плеер ниже вьюпорта: lazy-iframe (class=lazy, threshold:0) грузится
    // только при скролле — поднимаем контейнер в вьюпорт
    await evalIn(page, `document.querySelector('.player-container')?.scrollIntoView({ block: 'center' })`);
    await sleep(4000);

    // таймлайн: видео-зонд каждые 3 с; play — реальный Input-жест по центру
    // iframe в родительской вкладке (жест проваливается в iframe; жмём и без
    // видео-зонда — видео может просто ещё не существовать до старта).
    // Страница время от времени подвисает на evaluate — перевязываем ws.
    let playClicked = 0;
    const timeline = [];
    const t0 = Date.now();
    const reconnectPage = async () => {
      try { page.close(); } catch {}
      const t = await getJson();
      const cand = t.find((x) => x.type === "page" && x.url.includes(hostOf(URL_)));
      if (!cand) return false;
      page = connect(cand.webSocketDebuggerUrl);
      await page.send("Network.enable").catch(() => {});
      await page.send("Runtime.enable").catch(() => {});
      tapNetwork(page, net);
      return true;
    };
    while (Date.now() - t0 < SECS * 1000) {
      const sample = { at: Math.round((Date.now() - t0) / 1000), vid: null, sid: !!playerSid };
      try {
        if (!playerSid) await attachPlayer();
        const v = JSON.parse((await playerEval(VID_PROBE)) || "null");
        sample.vid = v;
        if ((!v || v.paused) && playClicked < 4 && Date.now() - t0 > 8000) {
          const rect = JSON.parse((await evalIn(page, PLAYER_RECT, undefined, 10000)) || "null");
          if (rect) {
            await page.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: rect.x, y: rect.y });
            await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: rect.x, y: rect.y });
            playClicked++;
            console.log(`    клик play #${playClicked} → iframe@${rect.x},${rect.y}`);
          }
        }
      } catch { await reconnectPage().catch(() => {}); /* фрейм/вкладка живёт дальше */ }
      timeline.push(sample);
      const v = sample.vid;
      console.log(`    t+${sample.at}s ${v ? `vid(t=${v.t},dur=${v.dur},paused=${v.paused},${(v.src || "").slice(0, 36)})` : `плеер=${sample.sid ? "прикреплён" : "нет"}`}`);
      await sleep(3000);
    }
    const engine1 = (await evalIn(ui, `window.__duopulse?.adblock?.status?.() ?? {}`)) || {};

    // (2) рекламные хосты: блокировка WebResourceRequested невидима в CDP
    // Network (0 событий при blockedTotal>0 — грабля первого прогона), поэтому
    // правда — resource timing страницы и фреймов плеера: попытки есть
    // (deltarockme — <script src> в head), но ни одной передачи байт.
    const timings = [];
    try { timings.push(...JSON.parse((await evalIn(page, AD_TIMING)) || "[]")); } catch {}
    try { timings.push(...JSON.parse((await playerEval(AD_TIMING)) || "[]")); } catch {}
    const attempted = timings.length;
    const leakedTimings = timings.filter((x) => x.transfer > 0);
    // плюс то, что могло стать видным CDP (например, режется на другом слое)
    const all = [...net.requests.values()];
    const adReqs = all.filter((x) => isAdHost(x.url));
    const adLeaked = adReqs.filter((x) => !x.failed && x.status >= 200 && x.status < 300);
    check(
      "рекламные хосты (deltarockme/agl*/adstag*/aj2517/srv224) режутся: попытки есть, байт не передано",
      attempted > 0 && leakedTimings.length === 0 && adLeaked.length === 0,
      `попыток(rum)=${attempted}, утечек(rum)=${leakedTimings.length}, cdp-видимых=${adReqs.length}, из них прошло=${adLeaked.length}`,
    );

    // (3) фильм играет: длительность > 10 мин (не преролл 15–60 с), время идёт
    const playing = timeline.filter((s) => s.vid && !s.vid.paused && s.vid.t > 3 && s.vid.dur > 600);
    const anyVideo = timeline.find((s) => s.vid);
    check(
      "фильм играет без преролла (dur>10 мин, t>3, не пауза)",
      playing.length > 0,
      anyVideo ? `кадр: t=${anyVideo.vid.t} dur=${anyVideo.vid.dur} paused=${anyVideo.vid.paused}` : "video в контексте плеера не найден",
    );

    // (4) попандеры: window.open в вкладке/плеере + новые таргеты после клика
    const popups = [];
    try { popups.push(...((await evalIn(page, `window.__dpPopups || []`)) || [])); } catch {}
    try { popups.push(...((await playerEval(`window.__dpPopups || []`)) || [])); } catch {}
    const adTargets = newTargets.filter((u) => isAdHost(u) || /^about:blank$/.test(u));
    check(
      "попандеров нет (window.open и новые таргеты после честного клика)",
      popups.length === 0 && adTargets.length === 0,
      `open=${JSON.stringify(popups.slice(0, 3))} targets=${JSON.stringify(adTargets.slice(0, 3))}`,
    );
    check("счётчик blockedTotal растёт (движок реально резал)", engine1.blockedTotal > 0, `blockedTotal=${engine1.blockedTotal}`);

    // (5) soft: «Скачать» в плеере — панель и цели ссылок не рекламные
    let dl = { tried: false, clicked: null, panel: null, newTabs: [], adTabs: 0 };
    if (!playerSid) await attachPlayer();
    if (playerSid) {
      try {
        const before = newTargets.length;
        const clicked = await playerEval(DL_CLICK);
        await sleep(2500);
        const links = JSON.parse((await playerEval(DL_PANEL)) || "null");
        dl = { tried: true, clicked, panel: links, newTabs: newTargets.slice(before) };
        dl.adTabs = dl.newTabs.filter((u) => isAdHost(u)).length;
        console.log(`  [soft] Скачать: кнопок=${clicked}, панель=${links ? links.length + " ссылок" : "нет"}, новые вкладки=${dl.newTabs.length}, рекламных из них=${dl.adTabs}`);
      } catch (e) { console.log(`  [soft] Скачать: зонд не сработал — ${e.message}`); }
    }

    // скриншот страницы-фильма для записи
    let shot = null;
    try {
      const s = await page.send("Page.captureScreenshot", { format: "png" });
      shot = path.join(os.tmpdir(), `duopulse-188-${Date.now()}.png`);
      fs.writeFileSync(shot, Buffer.from(s.data, "base64"));
    } catch {}

    return {
      checks, timeline, playerUrl, playerAttaches,
      engine: { lists: engine.lists.map((l) => ({ name: l.name, rules: l.rules })), blockedTotal: engine1.blockedTotal },
      net: {
        adTiming: timings,
        adCdpVisible: adReqs.map((x) => ({ ts: x.ts, url: x.url.slice(0, 110), status: x.status || x.failed })),
        mediaHosts: [...new Set(all.filter((x) => !x.failed && /video|mp4|m3u8|mpegurl|octet|webm|\.ts($|\?)/i.test((x.mime || "") + " " + x.url)).map((x) => hostOf(x.url)))],
        requestsTotal: all.length,
      },
      popups, newTargets, download: dl, shot,
    };
  } finally {
    ui?.close(); page?.close(); browser?.close();
    try { await run("taskkill", ["/PID", String(app.pid), "/T", "/F"]); } catch {}
    app.kill("SIGKILL");
    await killOurExes();
    await waitCdpFree();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── main ────────────────────────────────────────────────────────────────────
let vite = spawn("npm", ["run", "dev"], { cwd: ROOT, shell: true, stdio: "ignore" });
try {
  const viteUp = async () => {
    try { await fetch("http://localhost:5173/", { signal: AbortSignal.timeout(2000) }); return true; } catch { return false; }
  };
  const viteRestart = async () => {
    try { await run("taskkill", ["/PID", String(vite.pid), "/T", "/F"]); } catch {}
    await sleep(1500);
    vite = spawn("npm", ["run", "dev"], { cwd: ROOT, shell: true, stdio: "ignore" });
    for (let i = 0; i < 40; i++) { if (await viteUp()) return true; await sleep(500); }
    return false;
  };
  for (let i = 0; i < 60; i++) { if (await viteUp()) break; await sleep(500); }
  if (!(await viteUp())) throw new Error("vite не поднялся");
  await killOurExes();
  await waitCdpFree();
  console.log(`стенд duopulse-188: ${URL_}`);
  let result = null;
  for (let attempt = 1; attempt <= 3 && !result; attempt++) {
    console.log(`попытка ${attempt}`);
    try { result = await probeRun(); }
    catch (e) { console.log(`  прогон не удался — ${e.message}`); }
    if (!result && !(await viteUp())) { console.log("  vite не отвечает — перезапускаю"); await viteRestart(); }
  }
  if (!result) throw new Error("все попытки исчерпаны");
  const failed = result.checks.filter((c) => !c.ok);
  fs.writeFileSync(
    path.join(ROOT, "e2e", "adblock", "sites-ads-last-run.json"),
    JSON.stringify({ date: new Date().toISOString(), url: URL_, ...result }, null, 2),
  );
  console.log(`\nитог: ${result.checks.length - failed.length}/${result.checks.length} проверок; скриншот: ${result.shot || "нет"}`);
  console.log("результат — e2e/adblock/sites-ads-last-run.json");
  if (failed.length) { console.log(`FAIL: ${failed.map((f) => f.name).join("; ")}`); process.exitCode = 1; }
} catch (e) {
  console.error("SITES-ADS-PROBE ERROR:", e.message);
  process.exitCode = 1;
} finally {
  try { await run("taskkill", ["/PID", String(vite.pid), "/T", "/F"]); } catch {}
}
