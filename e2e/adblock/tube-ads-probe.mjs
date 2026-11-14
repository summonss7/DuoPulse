// Диагностический стенд рекламы туб-сайтов (карточка duopulse-140): что
// реально показывается в начале видео на pornhub/xhamster в DuoPulse и что
// режет текущий ансамбль списков. Факты по прогону:
//   1) сеть: все запросы таргета (Network.*): прошедшие (status) и
//      заблокированные движком (loadingFailed net::ERR_BLOCKED_BY_CLIENT) —
//      срез «что утечка» против «что уже режется»;
//   2) DOM: видео-элементы (src-хост, играет ли), видимые ad-подобные узлы
//      (id/class по маске ad/adv/banner/promo), попапы (обёртка window.open
//      с document-start + новые CDP-таргеты браузера);
//   3) движок: adblock.status — списки/правила/blocked_total до-после.
// Свежий профиль на прогон (частота рекламы зависит от кук), списки — seed из
// прогретого профиля (как ssai-probe.mjs).
//
// Запуск:  node e2e/adblock/tube-ads-probe.mjs [--lists env-спека] [--secs N] [site|url …]
//   site: pornhub | xhamster; иначе полный URL (видео-страница — зонд сам
//   возьмёт первую ссылку с домашней). --lists — прогон с переопределением
//   DUOPULSE_ADBLOCK_LISTS (итерация правил без пересборки).
// Результат — e2e/adblock/tube-ads-last-run.json (gitignore, рантайм).
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const CDP_PORT = 9229;
const argv = process.argv.slice(2);
const LISTS = argv.includes("--lists") ? argv[argv.indexOf("--lists") + 1] : null;
const SECS = argv.includes("--secs") ? Number(argv[argv.indexOf("--secs") + 1]) || 75 : 75;
const args = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--lists" && argv[i - 1] !== "--secs");
const SITES = args.length
  ? args.map((a) => (a.includes("://") ? a : a === "pornhub" ? "https://www.pornhub.com/" : a === "xhamster" ? "https://xhamster.com/" : null)).filter(Boolean)
  : ["https://www.pornhub.com/", "https://xhamster.com/"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, opts, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))),
  );

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
  const events = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    } else if (m.method) {
      events.push(m);
      conn.handlers.forEach((h) => h(m));
    }
  };
  const open = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  open.catch(() => {});
  const send = (method, params = {}, timeoutMs = 25000) =>
    open.then(() =>
      new Promise((res, rej) => {
        const i = ++id;
        const t = setTimeout(() => { pending.delete(i); rej(new Error(`CDP ${method}: таймаут ${timeoutMs} мс`)); }, timeoutMs);
        pending.set(i, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
        ws.send(JSON.stringify({ id: i, method, params }));
      }),
    );
  const conn = { send, events, handlers: new Set(), close: () => ws.close() };
  return conn;
}

const evalIn = async (ws, expression) => {
  const r = await ws.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception ?? r.exceptionDetails));
  return r.result?.value;
};

async function findTarget(pattern) {
  let lastJson = null;
  for (let i = 0; i < 90; i++) {
    try {
      const t = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
      lastJson = t;
      const ui = t.find((x) => x.type === "page" && /localhost:5173/.test(x.url));
      const site = t.find((x) => x.type === "page" && pattern.test(x.url));
      if (ui && site) return { ui, site };
    } catch {}
    await sleep(1000);
  }
  throw new Error(`CDP-цели не поднялись (${JSON.stringify(lastJson)?.slice(0, 600)})`);
}

// ── зонды страницы ──────────────────────────────────────────────────────────
// Состояние видео + видимые ad-подобные узлы + попап-лог обёртки window.open.
const PAGE_PROBE = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 100 && r.height > 50; };
  const vids = [...document.querySelectorAll('video')].slice(0, 4).map((v) => ({
    src: (() => { try { return decodeURIComponent(v.currentSrc || v.src || '').replace(/^https?:\\/\\//, '').slice(0, 90); } catch { return '?'; } })(),
    t: Math.round(v.currentTime * 10) / 10, dur: Math.round(v.duration || 0), paused: v.paused, muted: v.muted,
    parent: (v.closest('[id]')?.id || v.parentElement?.className || '').toString().slice(0, 60),
  }));
  const adish = [];
  for (const el of document.querySelectorAll('div,iframe,section,aside,a')) {
    const id = (el.id + ' ' + (typeof el.className === 'string' ? el.className : '')).toString();
    if (!/(^|[\\s_-])(ad|ads|adv|advert|banner|popup|popunder|promo|preroll|interstitial|spot)([\\s_-]|$)|ads?\\d|trafficjunky|exo|juicy/i.test(id)) continue;
    if (!vis(el)) continue;
    const r3 = el.getBoundingClientRect();
    adish.push({ tag: el.tagName, id: id.trim().slice(0, 80), size: (r3.width | 0) + 'x' + (r3.height | 0) });
    if (adish.length >= 12) break;
  }
  // «Пропустить рекламу»: только компактная интерактивная подпись (прошлый
  // прогон ловил ложный скип — textContent огромной обёртки с <script> внутри).
  const skipBtn = [...document.querySelectorAll('button,a,div,span')].find((el) => {
    const t = (el.textContent || '').trim();
    return t && t.length <= 40 && /skip|пропуст|reklam|реклам|advertisement|publicit|werbung/i.test(t) && vis(el);
  });
  // Анти-адблок-наг (pornhub любит): явные упоминания в видимой странице.
  let nag = null;
  try { const txt = document.body.innerText.slice(0, 20000);
    if (/ad[- ]?block|блокировщик|adblock/i.test(txt)) nag = (txt.match(/[^\\n]{0,60}ad[- ]?block[^\\n]{0,60}/i) || [])[0]?.trim().slice(0, 90) || 'найдено упоминание';
  } catch {}
  return JSON.stringify({
    url: location.href.slice(0, 90), title: document.title.slice(0, 60),
    vids, adish, skip: skipBtn ? skipBtn.textContent.trim().slice(0, 40) : null, nag,
    popups: (window.__dpPopups || []).slice(-5),
    iframes: [...document.querySelectorAll('iframe')].slice(0, 6).map((f) => (f.src || '').replace(/^https?:\\/\\//, '').slice(0, 70)),
  });
})()`;

// Клик по play: селекторы обеих платформ → прямоугольник → реальный Input-жест
// CDP (mousePressed/Released). Возвращает описание цели или null.
const PLAY_RECT = `(() => {
  const sels = ['.big.play', '.mgp_play', '.mgp-big-play', '.xplayer__play', 'button[class*=play i]', '[class*=play-button i]'];
  for (const s of sels) { const b = document.querySelector(s); if (b) { const r = b.getBoundingClientRect();
    if (r.width > 0) return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, sel: s }); } }
  const v = document.querySelector('video');
  if (v) { const r = v.getBoundingClientRect(); if (r.width > 0) return JSON.stringify({ x: r.x + Math.min(80, r.width / 2), y: r.y + r.height / 2, sel: 'video' }); }
  return null;
})()`;
async function clickPlay(page) {
  const rect = JSON.parse((await evalIn(page, PLAY_RECT)) || "null");
  if (!rect) return null;
  const opts = { type: "mousePressed", button: "left", clickCount: 1, x: Math.round(rect.x), y: Math.round(rect.y) };
  await page.send("Input.dispatchMouseEvent", opts);
  await page.send("Input.dispatchMouseEvent", { ...opts, type: "mouseReleased" });
  return rect.sel;
}

// Первая ссылка на видео-страницу с домашней/категории: pornhub —
// view_video.php?viewkey=…, xhamster — /videos/<slug>-<id>. Навигационные
// ссылки (/video?c=…, /creators/videos/…) не считаются видео-страницей.
const FIRST_VIDEO = `(() => {
  const ok = (h) => /[?&]viewkey=/.test(h) || /\\/videos\\/[a-z0-9-]+\\d{6,}/.test(h);
  const a = [...document.querySelectorAll('a[href]')].find((a) => ok(a.href));
  return a ? new URL(a.href, location.origin).href : null;
})()`;

// Кнопки «войти/18+» — возрастной шлюз xhamster и согласия.
const GATE_BUTTONS = `JSON.stringify([...document.querySelectorAll('button, a')].filter((b) => {
  const t = (b.textContent || '').trim(); if (!t || t.length > 40) return false;
  return /\\b(18|enter|согласен|войти|agree|continue|i am|je suis|sono|sunt)\\b/i.test(t) && b.getBoundingClientRect().width > 0;
}).slice(0, 8).map((b) => ({ tag: b.tagName, cls: (b.className || '').toString().slice(0, 50), t: b.textContent.trim().slice(0, 40) })))`;

function launchApp(tmp, url) {
  const stdioLog = path.join(tmp, "app-stdio.log");
  const out = fs.openSync(stdioLog, "a");
  const env = {
    ...process.env,
    APPDATA: tmp,
    DUOPULSE_START_URL: url,
    WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
  };
  if (LISTS) env.DUOPULSE_ADBLOCK_LISTS = LISTS;
  const app = spawn(EXE, [], { stdio: ["ignore", out, out], env });
  app.on("exit", (code) => { fs.closeSync(out); console.log(`    [app pid ${app.pid}] вышел, код ${code} (stdio: ${stdioLog})`); });
  return app;
}

// Сеть таргета: направляем события в коллекцию прогона. ts — секунды от
// старта прогона (wallTime): фаза до старта контента = преролл-реклама.
function tapNetwork(conn, net) {
  conn.handlers.add((m) => {
    if (m.method === "Network.requestWillBeSent") {
      const r = m.params.request;
      net.requests.set(m.params.requestId, { url: r.url, type: m.params.type, method: r.method, ts: Math.round((m.params.wallTime - net.t0) * 10) / 10 });
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

async function probeRun(site, seedFilters) {
  await sleep(4000);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-tube-"));
  const profile = path.join(tmp, "DuoPulse", "profile");
  fs.mkdirSync(profile, { recursive: true });
  if (seedFilters) fs.cpSync(seedFilters, path.join(profile, "filters"), { recursive: true });
  const app = launchApp(tmp, site);
  let ui, page, browser;
  const net = { requests: new Map(), t0: Date.now() / 1000 };
  const newTargets = [];
  try {
    // браузерный уровень: новые таргеты = попапы/попандеры
    try {
      const v = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json();
      browser = connect(v.webSocketDebuggerUrl);
      await browser.send("Target.setDiscoverTargets", { discover: true });
      browser.handlers.add((m) => { if (m.method === "Target.targetCreated" && m.params.targetInfo.type === "page") newTargets.push(m.params.targetInfo.url); });
    } catch (e) { console.log(`  (браузерный CDP недоступен: ${e.message})`); }

    const host = hostOf(site).replace(/^www\./, "");
    const t = await findTarget(new RegExp(host.replace(/\./g, "\\."), "i"));
    ui = connect(t.ui.webSocketDebuggerUrl);
    page = connect(t.site.webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) {
      if ((await evalIn(ui, `typeof window.__duopulse`)) === "object") break;
      await sleep(500);
    }
    let engine0 = null;
    for (let i = 0; i < 60; i++) {
      const st = await evalIn(ui, `window.__duopulse.adblock.status()`);
      if (st?.ready === true) { engine0 = st; break; }
      await sleep(1000);
    }
    if (!engine0) throw new Error("движок не построился из seed-кэша");
    console.log(`  движок: ${engine0.lists.map((l) => `${l.name}=${l.rules}`).join(", ")} blocked=${engine0.blockedTotal}`);

    await page.send("Network.enable");
    await page.send("Page.enable");
    tapNetwork(page, net);
    // document-start обёртка window.open (попандеры) на все последующие навигации
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source:
      `window.__dpPopups = [];
       const __ow = window.open;
       window.open = function (u, ...a) { try { window.__dpPopups.push(String(u).slice(0, 90)); } catch (e) {} return __ow.call(this, u, ...a); };`,
    });

    // шлюз 18+/согласия: жмём первую подходящую кнопку, если есть
    await sleep(4000);
    try {
      const gates = JSON.parse((await evalIn(page, GATE_BUTTONS)) || "[]");
      if (gates.length) {
        console.log(`  шлюз-кнопки: ${JSON.stringify(gates.map((g) => g.t))}`);
        await evalIn(page, `(() => { const b = [...document.querySelectorAll('button, a')].find((b) => /\\b(18|enter|согласен|войти|agree|continue)\\b/i.test((b.textContent || '').trim()) && b.getBoundingClientRect().width > 0); if (b) { b.click(); return b.textContent.trim().slice(0, 30); } return null; })()`);
        await sleep(3000);
      }
    } catch {}

    // видео-страница: первая ссылка с домашней
    let videoUrl = null;
    for (let i = 0; i < 10 && !videoUrl; i++) {
      videoUrl = await evalIn(page, FIRST_VIDEO);
      if (!videoUrl) await sleep(2000);
    }
    if (videoUrl) {
      console.log(`  видео-страница: ${videoUrl.slice(0, 90)}`);
      await page.send("Page.navigate", { url: videoUrl });
    } else {
      console.log("  видео-ссылка не найдена — остаёмся на стартовой");
    }

    // таймлайн: зонд раз в 3 с; видео на паузе — кликаем play (реальный
    // Input-жест, autoplay без него не стартует → преролл не проявляется).
    const samples = [];
    const t0 = Date.now();
    let playClicks = 0;
    while (Date.now() - t0 < SECS * 1000) {
      try {
        const p = JSON.parse(await evalIn(page, PAGE_PROBE));
        samples.push({ at: Math.round((Date.now() - t0) / 1000), ...p });
        const v = p.vids?.[0];
        console.log(`    t+${samples.at(-1).at}s ${v ? `vid(t=${v.t},dur=${v.dur},paused=${v.paused},${v.src.slice(0, 40)})` : "нет video"} skip=${JSON.stringify(p.skip)} adish=${p.adish?.length || 0}${p.iframes?.length ? " iframes=" + p.iframes.length : ""}${p.nag ? " nag=" + p.nag.slice(0, 50) : ""}`);
        if (v && v.paused && playClicks < 4 && !/ orientation/i.test(p.skip || "")) {
          const sel = await clickPlay(page);
          if (sel) { playClicks++; console.log(`    клик play #${playClicks} → ${sel}`); }
        }
      } catch {
        const tt = await findTarget(new RegExp(host.replace(/\./g, "\\."), "i"));
        page.close();
        page = connect(tt.site.webSocketDebuggerUrl);
        await page.send("Network.enable");
        tapNetwork(page, net);
      }
      const last = samples.at(-1);
      const mainVid = last?.vids?.[0];
      if (mainVid && !mainVid.paused && mainVid.t > 3 && !samples.playingLogged) { samples.playingLogged = true; console.log(`  видео играет (t=${mainVid.t}s, dur=${mainVid.dur}s, src=${mainVid.src.slice(0, 50)})`); }
      await sleep(3000);
    }
    const engine1 = (await evalIn(ui, `window.__duopulse.adblock.status()`)) || {};
    return { samples, net: [...net.requests.values()], newTargets, engine: { start: engine0.blockedTotal, end: engine1.blockedTotal ?? null, seen: engine1.seenTotal ?? null } };
  } finally {
    ui?.close(); page?.close(); browser?.close();
    try { await run("taskkill", ["/PID", String(app.pid), "/T", "/F"]); } catch {}
    app.kill("SIGKILL");
    await killOurExes();
    await waitCdpFree();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── прогрев списков (как ssai-probe) ────────────────────────────────────────
async function warmSeed() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-tube-seed-"));
  const app = launchApp(tmp, "https://example.com/");
  let ui;
  try {
    const t = await findTarget(/example\.com/);
    ui = connect(t.ui.webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) {
      if ((await evalIn(ui, `typeof window.__duopulse`)) === "object") break;
      await sleep(500);
    }
    for (let i = 0; i < 150; i++) {
      const st = await evalIn(ui, `window.__duopulse.adblock.status()`);
      if (st?.ready === true) {
        console.log(`  прогрев: ${st.lists.map((l) => `${l.name}=${l.rules}`).join(", ")}`);
        break;
      }
      await sleep(1000);
    }
    return { seedDir: path.join(tmp, "DuoPulse", "profile", "filters"), tmp, ui, app };
  } catch (e) {
    ui?.close(); app.kill("SIGKILL");
    await killOurExes();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    throw e;
  }
}

let vite = spawn("npm", ["run", "dev"], { cwd: ROOT, shell: true, stdio: "ignore" });
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
let seedTmp = null;
try {
  for (let i = 0; i < 60; i++) {
    try { await fetch("http://localhost:5173/"); break; } catch { await sleep(500); }
  }
  await killOurExes();
  await waitCdpFree();
  console.log(LISTS ? `прогрев + итерация списков: ${LISTS.slice(0, 120)}` : "прогрев: скачиваем живые списки и собираем движок…");
  const warm = await warmSeed();
  seedTmp = warm.tmp;
  warm.ui.close();
  await killOurExes();
  await waitCdpFree();

  const results = [];
  for (const site of SITES) {
    console.log(`\nсайт ${site}`);
    let r = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      // vite мог умереть (прошлый сеанс/краш) — UI без него не поднимется
      if (!(await viteUp())) { console.log("  vite не отвечает — перезапускаю"); await viteRestart(); }
      try { r = await probeRun(site, warm.seedDir); break; }
      catch (e) { console.log(`  попытка ${attempt} не удалась — ${e.message}`); }
    }
    if (!r) { results.push({ site, error: "прогон не удался" }); continue; }
    const blocked = r.net.filter((x) => x.failed === "net::ERR_BLOCKED_BY_CLIENT");
    const leaked = r.net.filter((x) => !x.failed && !/^data:|^blob:/.test(x.url));
    const popups = [...new Set([...r.newTargets, ...r.samples.flatMap((s) => s.popups || [])])];
    const adsSeen = r.samples.filter((s) => s.skip || (s.adish && s.adish.length));
    const nags = [...new Set(r.samples.map((s) => s.nag).filter(Boolean))];
    console.log(`  движок: blocked ${r.engine.start} → ${r.engine.end} (видел ${r.engine.seen})`);
    console.log(`  сеть: ${r.net.length} запросов, движок резал ${blocked.length}, прошло ${leaked.length}`);
    console.log(`  попапы/попандеры: ${popups.length ? JSON.stringify(popups.slice(0, 5)) : "нет"}`);
    console.log(`  реклама в DOM: ${adsSeen.length ? `${adsSeen.length}/${r.samples.length} проб (skip=${JSON.stringify(adsSeen.map((s) => s.skip).filter(Boolean).slice(0, 3))}, adish=${JSON.stringify((adsSeen[0]?.adish || []).slice(0, 4))})` : "не замечено"}`);
    if (nags.length) console.log(`  анти-адблок-наг: ${JSON.stringify(nags.slice(0, 2))}`);
    const v0 = r.samples.find((s) => s.vids?.[0])?.vids[0];
    console.log(`  видео: ${v0 ? `t=${v0.t}s paused=${v0.paused} src=${v0.src.slice(0, 60)}` : "не найдено"}`);
    results.push({ site, engine: r.engine, popups, adsSeen: adsSeen.length, nags, samples: r.samples.length,
      blockedSample: blocked.slice(0, 60).map((x) => ({ ts: x.ts, url: x.url.slice(0, 110) })),
      leaked: leaked.map((x) => ({ ts: x.ts, host: hostOf(x.url), path: new URL(x.url).pathname.slice(0, 60), type: x.type, status: x.status })).slice(0, 400),
      timeline: r.samples.map((s) => ({ at: s.at, title: s.title, vids: s.vids, skip: s.skip, adish: s.adish, iframes: s.iframes, nag: s.nag })) });
  }

  fs.writeFileSync(path.join(ROOT, "e2e", "adblock", "tube-ads-last-run.json"), JSON.stringify({ date: new Date().toISOString(), lists: LISTS, results }, null, 2));
  console.log("\nитоги записаны в e2e/adblock/tube-ads-last-run.json");
} catch (e) {
  console.error("TUBE-PROBE ERROR:", e.message);
  process.exitCode = 1;
} finally {
  if (seedTmp) { try { fs.rmSync(seedTmp, { recursive: true, force: true }); } catch {} }
  try { await run("taskkill", ["/PID", String(vite.pid), "/T", "/F"]); } catch {}
  await killOurExes().catch(() => {});
}
