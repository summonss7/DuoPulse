// Замер метрики P-07 (задача 2.1, docs/04 §2): «YouTube: запросы до старта
// видео — ≤ 60% от того же видео без блокировщика». Медиана 3 прогонов
// на режим, режимы чередуются (off,on,off,…).
//
// Протокол «свежий профиль на прогон» — выводы из пробных прогонов:
//  - тёплый HTTP-кэш повторного просмотра даёт ~25 запросов вместо ~130:
//    повторные навигации по одному профилю меряют кэш, а не блокировщик;
//  - YouTube ограничивает частоту рекламы (frequency cap по кукам): реклама
//    крутится в первом прогоне, дальше off-прогоны идут БЕЗ рекламы — и
//    медиана off сравнивает «нет рекламы» с «нет рекламы» (~100% при любом
//    качестве блокировщика). Свежие куки каждого прогона это снимает:
//    реклама есть в каждом off-прогоне и режется в каждом on-прогоне.
// Поэтому: каждый прогон — отдельные APPDATA и WEBVIEW2_USER_DATA_FOLDER,
// списки предсеяны из прогретого профиля (компилированный engine.bin —
// движок готов за сотни мс, сеть на списки в прогоне не тратится),
// off-режим — settings.json с adblock.enabled=false, записанный ДО старта
// (с самого первого запроса навигации блокировка честно выключена).
// Счёт — session-итоги adblock.status: seenTotal/blockedTotal; в сеансе
// ровно одна навигация (DUOPULSE_START_URL=видео), UI-webview перехватчиком
// не считается (COM-фильтр стоит только на content-вкладках).
//
// «Первый кадр» = первый кадр КОНТЕНТА: во время рекламной паузы ролик
// крутится в том же <video> (плеер помечен .ad-showing) — без проверки
// прогон заканчивается на первом кадре рекламы.
//
// Две трактовки «счётчика сетевых вызовов»: seen — все перехваченные
// http(s) (включая заблокированные); loaded — реально ушедшие в сеть
// (заблокированные до сети не доходят, docs/04 §1.2).
//
// Запуск:  node e2e/adblock/p07.mjs [url-видео]
// Требует собранный debug-exe (cargo build); видео по умолчанию — типичное
// монетизированное (на архивных роликах без рекламы блокировать нечего).
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const CDP_PORT = 9228;
const VIDEO = process.argv[2] || "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const RUNS_PER_MODE = 3;
const MEDIAN = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, opts, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))));

/** Убить только экземпляры НАШЕГО exe (путь — как в run.mjs: в одиночных
 * кавычках PowerShell бэкслэш не экранируется, удваивать его НЕЛЬЗЯ —
 * фильтр перестаёт совпадать и kill молча ничего не убивает).
 * Карточка 061 (29.10): kill PowerShell-вызовом иногда тихо не срабатывал
 * (зомби-браузер держал порт CDP и подменял цель) — теперь верификация
 * «процессов нет» с ретраями и таймаутами на каждом вызове (раньше
 * зависший PowerShell вешал прогон навсегда). */
const killOurExes = async () => {
  const listOur = () =>
    run(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `@(Get-CimInstance Win32_Process -Filter "Name='duopulse.exe'" | Where-Object { $_.ExecutablePath -eq '${EXE}' }).Count`,
      ],
      { timeout: 20000 },
    ).then((s) => Number(String(s).trim()) || 0);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await run(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Get-CimInstance Win32_Process -Filter "Name='duopulse.exe'" | Where-Object { $_.ExecutablePath -eq '${EXE}' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }`,
        ],
        { timeout: 30000 },
      );
    } catch {
      /* уже мертвы или PowerShell-сбой — проверим ниже фактом */
    }
    let alive;
    try {
      alive = await listOur();
    } catch {
      return; // верификация недоступна — лучшая попытка сделана (как раньше)
    }
    if (alive === 0) return;
    await sleep(1500);
  }
  throw new Error("killOurExes: наши duopulse-процессы не умерли за 3 попытки (зомби держит порт CDP)");
};

/** Дождаться, пока порт CDP освободился: осиротевший браузер-процесс WebView2
 * держит порт и ПОДМЕНИВАЕТ цель следующего прогона (замер шёл бы по зомби
 * из прошлого прогона — счётчики чужой сессии, монотонный рост).
 * Карточка 061: AbortSignal-таймаут — это TimeoutError (порт занят, но HTTP
 * не отвечает, зомби) — ждём дальше; свободен только отказ в соединении. */
async function waitCdpFree() {
  for (let i = 0; i < 30; i++) {
    try {
      await fetch(`http://localhost:${CDP_PORT}/json`, { signal: AbortSignal.timeout(1000) });
      await sleep(1000);
    } catch (e) {
      if (e?.name === "TimeoutError") {
        await sleep(1000);
        continue;
      }
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
  const open = new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  open.catch(() => {});
  // Карточка 061: мёртвая цель не отвечает и не закрывает промис — запрос
  // висел вечно (известная ловушка e2e; vpn/proxy-a стенды чинили карточкой
  // 048, здесь того же рода таймаут на каждом send).
  const send = (method, params = {}, timeoutMs = 20000) =>
    open.then(
      () =>
        new Promise((res, rej) => {
          const i = ++id;
          const t = setTimeout(() => {
            pending.delete(i);
            rej(new Error(`CDP ${method}: таймаут ${timeoutMs} мс (цель мертва?)`));
          }, timeoutMs);
          pending.set(i, {
            res: (v) => {
              clearTimeout(t);
              res(v);
            },
            rej: (e) => {
              clearTimeout(t);
              rej(e);
            },
          });
          ws.send(JSON.stringify({ id: i, method, params }));
        }),
    );
  return { send, close: () => ws.close() };
}

const evalIn = async (ws, expression) => {
  const r = await ws.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails)
    throw new Error(JSON.stringify(r.exceptionDetails.exception ?? r.exceptionDetails));
  return r.result?.value;
};

async function targets() {
  let lastJson = null; // диагностика (карточка 061): что реально отдавал /json
  for (let i = 0; i < 90; i++) {
    try {
      const t = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
      lastJson = t;
      const ui = t.find((x) => x.type === "page" && /localhost:5173/.test(x.url));
      const yt = t.find((x) => x.type === "page" && /youtube\.com/.test(x.url));
      if (ui && yt) return { ui, yt };
      // Карточка 061: YT-навигация упала с ERR_* → вкладка стала страницей
      // ошибки (карточка 048, в dev-режиме это localhost:5173). Дальше ждать
      // бессмысленно — прогон ретраится целиком.
      if (i > 10 && t.some((x) => x.type === "page" && /Не удалось открыть сайт|ERR_/.test(x.title))) {
        throw new Error(`страница ошибки вместо видео: ${t.map((x) => `${x.title} @ ${x.url}`).join(" | ")}`);
      }
    } catch (e) {
      if (String(e.message).startsWith("страница ошибки")) throw e;
    }
    await sleep(1000);
  }
  throw new Error(
    `CDP-цели не поднялись (последний /json: ${JSON.stringify(lastJson)?.slice(0, 1500)})`,
  );
}

/** Первый кадр КОНТЕНТА (мимо рекламной паузы, см. шапку). */
const PROBE_SRC = `(() => {
  if (document.querySelector('.ad-showing, .ytp-ad-player-overlay, .ytp-ad-image-overlay')) return false;
  const v = document.querySelector('video'); if (!v) return false;
  if (v.paused) { v.muted = true; v.play().catch(() => {}); }
  return v.currentTime > 0.5;
})()`;

/** Запуск приложения с изолированным профилем (общая часть прогонов).
 * stdio — в файл-улей рядом с профилем (карточка 061: «Не удалось открыть
 * сайт» на YT-вкладке и загадочные коды выхода оставались без улик). */
function launchApp(tmp) {
  const stdioLog = path.join(tmp, "app-stdio.log");
  const out = fs.openSync(stdioLog, "a");
  const app = spawn(EXE, [], {
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      APPDATA: tmp,
      DUOPULSE_START_URL: VIDEO,
      WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
  });
  app.on("exit", (code) => {
    fs.closeSync(out);
    console.log(`    [app pid ${app.pid}] вышел, код ${code} (stdio: ${stdioLog})`);
  });
  return app;
}

/** vite жив? (карточка 061: между прогонами dev-сервер ни разу не падал, но
 * проверка дешевле разбора «Не удалось открыть сайт» на UI). */
async function ensureVite() {
  try {
    await fetch("http://localhost:5173/");
    return null;
  } catch {}
  console.log("  vite не отвечает — перезапуск dev-сервера");
  const v = spawn("npm", ["run", "dev"], { cwd: ROOT, shell: true, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try {
      await fetch("http://localhost:5173/");
      return v;
    } catch {
      await sleep(500);
    }
  }
  throw new Error("vite не поднялся за 30 с");
}


/**
 * Один прогон: свежий профиль (фильтры — из seed, при off — settings с
 * выключенным блокировщиком), DUOPULSE_START_URL=видео, ждать первый кадр
 * контента, вернуть session-итоги {seen, blocked}, закрыть приложение,
 * удалить временный профиль.
 */
async function measureRun(mode, seedFilters) {
  // приладка после kill предыдущего приложения (карточка 061):YT-вкладка
  // следующего приложения иногда ловила ERR_* на первой навигации, если
  // предыдущий WebView2Tree убит за 1–2 с до этого (только тяжёлый тёплый
  // прогон с видео; лёгкий — не воспроизводится)
  await sleep(4000);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `duopulse-p07-${mode}-`));
  const profile = path.join(tmp, "DuoPulse", "profile");
  fs.mkdirSync(profile, { recursive: true });
  if (seedFilters) fs.cpSync(seedFilters, path.join(profile, "filters"), { recursive: true });
  if (mode === "off") {
    fs.writeFileSync(
      path.join(profile, "settings.json"),
      JSON.stringify({ adblock: { enabled: false, siteExceptions: [] } }, null, 2),
    );
  }
  const app = launchApp(tmp);
  let ui, yt;
  try {
    const t = await targets();
    ui = connect(t.ui.webSocketDebuggerUrl);
    yt = connect(t.yt.webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) {
      if ((await evalIn(ui, `typeof window.__duopulse`)) === "object") break;
      await sleep(500);
    }
    if (mode === "on") {
      // движок должен быть готов до основного потока запросов (compiled-кэш
      // deserialize — сотни мс); ждём готовности, иначе прогон не валиден
      let ready = false;
      for (let i = 0; i < 30; i++) {
        if ((await evalIn(ui, `window.__duopulse.adblock.status()`))?.ready === true) {
          ready = true;
          break;
        }
        await sleep(500);
      }
      if (!ready) throw new Error("[on] движок блокировщика не построился из seed-кэша");
    }
    let started = false;
    let adSeen = false;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      try {
        const r = await evalIn(
          yt,
          `(() => { const ad = !!document.querySelector('.ad-showing, .ytp-ad-player-overlay, .ytp-ad-image-overlay');
            if (ad) window.__p07ad = true;
            return JSON.stringify({ ad: window.__p07ad === true, frame: ${PROBE_SRC} }); })()`,
        ).then((s) => JSON.parse(s));
        if (r.ad) adSeen = true;
        if (r.frame) {
          started = true;
          break;
        }
      } catch {
        const tt = await targets();
        yt.close();
        yt = connect(tt.yt.webSocketDebuggerUrl);
      }
      await sleep(400);
    }
    if (!started) throw new Error(`[${mode}] видео не стартовало за 180 с`);
    const st = await evalIn(ui, `window.__duopulse.adblock.status()`);
    return { seen: st.seenTotal ?? 0, blocked: st.blockedTotal ?? 0, adSeen };
  } finally {
    ui?.close();
    yt?.close();
    try {
      await run("taskkill", ["/PID", String(app.pid), "/T", "/F"]);
    } catch {}
    app.kill("SIGKILL");
    await killOurExes();
    await waitCdpFree();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }
}

// --- запуск приложения (UI-webview в dev-сборке грузится с vite) -------------
const vite = spawn("npm", ["run", "dev"], { cwd: ROOT, shell: true, stdio: "ignore" });
for (let i = 0; i < 60; i++) {
  try {
    await fetch("http://localhost:5173/");
    break;
  } catch {
    await sleep(500);
  }
}

/** Прогрев: скачать настоящие списки, собрать движок; профиль НЕ удаляем —
 * его filters/ станет seed-кэшем для прогонов. */
async function warmSeed() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-p07-seed-"));
  const app = launchApp(tmp);
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
        console.log(`  списки готовы: ${st.lists.map((l) => `${l.name}=${l.rules}`).join(", ")}`);
        break;
      }
      await sleep(1000);
    }
    // дождаться записи engine.bin (после ready он уже скомпилирован)
    return { seedDir: path.join(tmp, "DuoPulse", "profile", "filters"), tmp, ui, yt };
  } catch (e) {
    ui?.close();
    yt?.close();
    app.kill("SIGKILL");
    await killOurExes();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
    throw e;
  }
}

const measures = { off: [], on: [] };
const blocks = { off: [], on: [] };
let seedTmp = null;
const extraVites = []; // перезапущенные ensureVite (уборка в finally)
try {
  // зачистка перед стартом: зомби-браузер с прошлых прогонов подменит цель
  await killOurExes();
  await waitCdpFree();
  console.log("прогрев: скачиваем списки EasyList/uBO и собираем движок…");
  const warm = await warmSeed();
  seedTmp = warm.tmp;
  warm.ui.close();
  warm.yt.close();
  await killOurExes();
  await waitCdpFree();
  const engine = fs.readdirSync(warm.seedDir).join(",");
  console.log(`  seed-кэш фильтров: ${engine}`);

  const order = [];
  const ads = { off: [], on: [] };
  for (let i = 0; i < RUNS_PER_MODE; i++) order.push("off", "on");
  for (const mode of order) {
    // Карточка 061: навигация YT-вкладки свежего приложения изредка падает
    // ERR_* (после kill предыдущего дерева WebView2; замеру не подлежит) —
    // прогон целиком ретраится на новом профиле, до 3 попыток.
    let r = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const v = await ensureVite();
        if (v) extraVites.push(v);
        r = await measureRun(mode, warm.seedDir);
        break;
      } catch (e) {
        console.log(`  режим ${mode}: попытка ${attempt} не удалась — ${e.message}`);
        if (attempt === 3) throw e;
      }
    }
    measures[mode].push(r.seen);
    blocks[mode].push(r.blocked);
    ads[mode].push(r.adSeen ? 1 : 0);
    console.log(
      `  режим ${mode.padEnd(3)}: запросов до первого кадра контента = ${r.seen}` +
        ` (заблокировано ${r.blocked}, в сеть ушло ${r.seen - r.blocked},` +
        ` реклама${r.adSeen ? "" : " не"} показана)`,
    );
  }

  const offSeen = MEDIAN(measures.off);
  const onSeen = MEDIAN(measures.on);
  const offLoaded = offSeen - MEDIAN(blocks.off);
  const onLoaded = onSeen - MEDIAN(blocks.on);
  const ratioSeen = offSeen > 0 ? Math.round((onSeen / offSeen) * 100) : NaN;
  const ratioLoaded = offLoaded > 0 ? Math.round((onLoaded / offLoaded) * 100) : NaN;
  console.log(`\nP-07: без блокировщика (медиана ${RUNS_PER_MODE} прогонов) = ${offSeen}`);
  console.log(`P-07: с блокировщиком  (медиана ${RUNS_PER_MODE} прогонов) = ${onSeen}`);
  console.log(`P-07: отношение всех перехваченных = ${ratioSeen}%`);
  console.log(
    `P-07: в сеть (заблокированные не грузились): ${offLoaded} → ${onLoaded}, отношение = ${ratioLoaded}% (цель ≤ 60%)`,
  );
  console.log(
    `прогоны: off=${JSON.stringify(measures.off)} on=${JSON.stringify(measures.on)} ` +
      `заблокировано off=${JSON.stringify(blocks.off)} on=${JSON.stringify(blocks.on)} реклама off=${JSON.stringify(ads.off)} on=${JSON.stringify(ads.on)}`,
  );
  const notes =
    `video=${VIDEO}\n` +
    `off=${measures.off.join("/")} on=${measures.on.join("/")} ` +
    `blocked(off)=${blocks.off.join("/")} blocked(on)=${blocks.on.join("/")} ` +
    `ratioSeen=${ratioSeen}% ratioLoaded=${ratioLoaded}%`;
  fs.writeFileSync(
    path.join(ROOT, "e2e", "adblock", "p07-last-run.txt"),
    `${new Date().toISOString()}\n${notes}\n`,
  );
} catch (e) {
  console.error("P07 ERROR:", e.message);
  } finally {
    if (seedTmp) {
      try {
        fs.rmSync(seedTmp, { recursive: true, force: true });
      } catch {}
    }
    for (const v of extraVites) {
      try {
        await run("taskkill", ["/PID", String(v.pid), "/T", "/F"]);
      } catch {}
    }
    try {
      await run("taskkill", ["/PID", String(vite.pid), "/T", "/F"]);
    } catch {}
    await sleep(1000);
  }
