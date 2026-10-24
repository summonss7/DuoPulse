// Трассировка старта YouTube до первого кадра (карточка duopulse-055):
// объяснить асимметрию стоимости преролла — на стороне блокировщика SSAI-
// преролл стоит +~1,5 с к первому кадру, у контроля +~0,4 с (24.10.2026,
// сеанс duopulse-052). Гипотеза (а): у блокировщика клиентская реклама
// срезана (json-prune playerAds/adPlacements, compat.txt) → остаётся
// серверный SSAI: SABR-манифест сшивает ad-сегменты ДО контента, первый кадр
// ждёт нового рекламного CDN-хоста (DNS+TLS через SOCKS5-роутер); у контроля
// чаще клиентская реклама (playerAds/IMA) — стартует по уже тёплым соединениям
// страницы. Альтернатива (б): просто другой тип/длина преролла.
//
// На каждый запуск пишутся два потока данных:
//  - CDP Network-события цели /watch: каждый запрос (хост, тип, момент),
//    из ResourceTiming ответа — DNS/proxy/connect/TLS (мс); трассировка
//    начинается с ПОЯВЛЕНИЯ watch-цели в /json — первые ~0,3–1 с навигации
//    (документ и стартовые подресурсы) не видны, но эти хосты одинаковы
//    у обеих сторон и на асимметрию не влияют;
//  - DOM-таймлайн (каждые ~120 мс): .ad-showing, currentTime, paused —
//    даёт «первый кадр воспроизведения» (у преролла — кадр рекламы),
//    «первый кадр контента», длину преролла и разделение SSAI/клиентской
//    рекламы: сшитый SSAI-поток НЕ сбрасывает currentTime на стыке
//    реклама→контент, клиентская реклама сбрасывает в ~0.
// Сводка печатается и падает в e2e/perf/p08-trace-last.json.
//
// Запуск:  node e2e/perf/p08-trace.mjs [url-видео]
// Требует release-сборку DuoPulse (npx tauri build, как p08.mjs).
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const DUO_EXE = path.join(ROOT, "src-tauri", "target", "release", "duopulse.exe");
const VIDEO = process.argv[2] || "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const WARMUPS = 2;
const TRACED_RUNS = 2;
const DUO_CDP = 9236;
const CTL_CDP = 9237;
const DUMP = path.join(ROOT, "e2e", "perf", "p08-trace-last.json");

if (!fs.existsSync(DUO_EXE)) {
  console.error(`FAIL  не найден exe: ${DUO_EXE} (нужна release-сборка)`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))),
  );
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);

setTimeout(() => {
  console.error("СТЕНД: глобальный таймаут 15 мин — принудительное завершение");
  process.exit(2);
}, 15 * 60_000).unref?.();

function connect(wsUrl, onEvent) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    } else if (m.method && onEvent) {
      onEvent(m);
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
          const timer = setTimeout(() => {
            pending.delete(i);
            rej(new Error(`CDP ${method}: нет ответа 15 с`));
          }, 15_000);
          pending.set(i, {
            res: (v) => { clearTimeout(timer); res(v); },
            rej: (e) => { clearTimeout(timer); rej(e); },
          });
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

async function killTree(pid) {
  try {
    await run("taskkill", ["/PID", String(pid), "/T", "/F"]);
  } catch {}
}

/** Дождаться смерти процессов WebView2 профиля (как p08.mjs). */
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

// --- профили сторон (как p08.mjs: контроль — блокировщик выключен settings) ---
const duoProfile = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-p08tr-duo-"));
const ctlProfile = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-p08tr-ctl-"));
fs.mkdirSync(path.join(ctlProfile, "DuoPulse", "profile"), { recursive: true });
fs.writeFileSync(
  path.join(ctlProfile, "DuoPulse", "profile", "settings.json"),
  JSON.stringify({ adblock: { enabled: false } }),
);
const launchAt = (profile, port) => () =>
  spawn(DUO_EXE, [], {
    stdio: "ignore",
    env: {
      ...process.env,
      APPDATA: profile,
      DUOPULSE_START_URL: VIDEO,
      WEBVIEW2_USER_DATA_FOLDER: path.join(profile, "webview2-data"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
  });

// --- версия фильтр-листов (карточка duopulse-056, хуки как в p08.mjs) ---------
// DUOPULSE_P08_SEED_FILTERS=<dir> — заморозка версий списков (сесть из донора,
// не качать); DUOPULSE_P08_KEEP_FILTERS=<dir> — копия txt+meta до удаления
// профилей. Версия (digest+rules из meta.json) падает в дамп прогона: гипотеза
// 056 — «версия совпала при разной скорости → списки исключаются».
// DUOPULSE_P08_TRACE_STAMP_DIR=<dir> — копия дампа с меткой времени туда
// (последовательные прогоны не затирают друг друга; p08-trace-last.json
// пишется как и раньше).
function seedFilters(profile) {
  const seed = process.env.DUOPULSE_P08_SEED_FILTERS;
  if (!seed) return;
  const dst = path.join(profile, "DuoPulse", "profile", "filters");
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(seed, dst, { recursive: true });
}
function keepFilters(profile, tag) {
  const keep = process.env.DUOPULSE_P08_KEEP_FILTERS;
  if (!keep) return;
  try {
    const src = path.join(profile, "DuoPulse", "profile", "filters");
    const dst = path.join(keep, `${tag}-${new Date().toISOString().replace(/[:.]/g, "")}`);
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src))
      if (f.endsWith(".txt") || f === "meta.json") fs.copyFileSync(path.join(src, f), path.join(dst, f));
  } catch {}
}
function listVersionsOf(profile) {
  try {
    const meta = JSON.parse(
      fs.readFileSync(path.join(profile, "DuoPulse", "profile", "filters", "meta.json"), "utf8"),
    );
    return Object.entries(meta.lists ?? {}).map(([name, m]) => ({
      name,
      digest: m.digest,
      rules: m.rules,
      updatedAt: m.updated_at,
    }));
  } catch {
    return null;
  }
}
seedFilters(duoProfile);
seedFilters(ctlProfile);

/** Простой запуск без трассировки (прогрев профиля, как p08.mjs). */
async function warmupOnce(name, launch, cdpPort, settle) {
  const app = launch();
  const t0 = Date.now();
  const deadline = t0 + 120_000;
  let done = false;
  while (Date.now() < deadline && !done) {
    try {
      const targets = await (await fetch(`http://localhost:${cdpPort}/json`)).json();
      const yt = targets.find((x) => x.type === "page" && /youtube\.com\/watch/.test(x.url));
      if (yt) {
        const ws = connect(yt.webSocketDebuggerUrl);
        const st = await evalIn(
          ws,
          `(function () {
            const v = document.querySelector('video');
            if (!v) return { novideo: true };
            if (v.paused) { v.muted = true; v.play().catch(() => {}); }
            return { frame: v.currentTime > 0.5 && !v.paused };
          })()`,
        ).catch(() => null);
        ws.close();
        if (st && st.frame) done = true;
      }
    } catch {}
    await sleep(150);
  }
  await sleep(8000); // прогрев досматривает ролик (кэш/кап рекламы)
  await killTree(app.pid);
  await settle();
  await sleep(1200);
  console.log(`  ${name} прогрев: ${done ? "кадр дождан" : "КАДРА НЕТ"}`);
}

/** Трассируемый запуск: Network-события + DOM-таймлайн до кадра контента
 *  (после кадра рекламы ждём ещё до 60 с — длина преролла и стык рекламы). */
async function traceLaunch(name, launch, cdpPort, settle, label) {
  const app = launch();
  const t0 = Date.now();
  const wall0 = t0 / 1000;
  const requests = new Map();
  const timeline = [];
  let ws = null;
  let frameAt = null; // первый кадр воспроизведения (при преролле — рекламы)
  let contentAt = null; // первый кадр контента
  let adStartAt = null;
  let adEndAt = null;
  let curMaxAd = 0;
  let curAtContent = null;
  const onEvent = (m) => {
    try {
      collectEvent(m);
    } catch {
      /* нестандартный URL (data:/blob:) — пропускаем событие */
    }
  };
  const collectEvent = (m) => {
    const p = m.params;
    if (m.method === "Network.requestWillBeSent") {
      requests.set(p.requestId, {
        host: new URL(p.request.url).host,
        url: p.request.url.slice(0, 160),
        type: p.type ?? "?",
        sent: Math.round((p.wallTime - wall0) * 1000),
        status: null,
        cache: null,
        ip: null,
        proto: null,
        dns: null,
        proxy: null,
        connect: null,
        ssl: null,
        ttfb: null,
      });
    } else if (m.method === "Network.responseReceived") {
      const r = requests.get(p.requestId);
      if (!r) return;
      const resp = p.response ?? {};
      r.status = resp.status ?? null;
      r.cache = resp.fromDiskCache ? "disk" : null;
      r.ip = resp.remoteIPAddress ?? null;
      r.proto = resp.protocol ?? null;
      const t = resp.timing;
      if (t) {
        // ResourceTiming: requestTime — база в секундах, остальные поля —
        // дельты в мс от неё; -1 = фазы не было (кэш/DNS на стороне прокси)
        r.dns = t.dnsStart >= 0 ? Math.max(0, Math.round(t.dnsEnd - t.dnsStart)) : 0;
        r.proxy = t.proxyStart >= 0 ? Math.max(0, Math.round(t.proxyEnd - t.proxyStart)) : 0;
        r.connect = t.connectStart >= 0 ? Math.max(0, Math.round(t.connectEnd - t.connectStart)) : 0;
        r.ssl = t.sslStart >= 0 ? Math.max(0, Math.round(t.sslEnd - t.sslStart)) : 0;
        r.ttfb = t.receiveHeadersEnd >= 0 ? Math.round(t.receiveHeadersEnd) : null;
      }
    } else if (m.method === "Network.loadingFailed") {
      const r = requests.get(p.requestId);
      if (r && !r.status) r.status = `FAIL:${p.errorText}`;
    }
  };
  const deadline = t0 + 120_000;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://localhost:${cdpPort}/json`)).json();
      const yt = targets.find((x) => x.type === "page" && /youtube\.com\/watch/.test(x.url));
      if (yt && !ws) {
        ws = connect(yt.webSocketDebuggerUrl, onEvent);
        await ws.send("Network.enable").catch(() => {});
      }
      if (ws) {
        const st = await evalIn(
          ws,
          `(function () {
            const ad = !!document.querySelector('.ad-showing, .ytp-ad-player-overlay, .ytp-ad-image-overlay');
            if (ad && !window.__trAd) window.__trAd = Date.now();
            if (!ad && window.__trAd && !window.__trAdEnd) window.__trAdEnd = Date.now();
            const v = document.querySelector('video');
            if (!v) return { novideo: true };
            if (v.paused) { v.muted = true; v.play().catch(() => {}); }
            return { t: Date.now(), ad,
              adStart: window.__trAd || 0, adEnd: window.__trAdEnd || 0,
              cur: v.currentTime, paused: v.paused };
          })()`,
        ).catch(() => {
          // цель умерла (SSAI-навигации) — переподключимся следующим витком
          ws?.close();
          ws = null;
          return null;
        });
        if (st && !st.novideo) {
          timeline.push({ t: st.t - t0, ad: st.ad, cur: st.cur, paused: st.paused });
          if (st.adStart && adStartAt === null) adStartAt = st.adStart - t0;
          if (st.adEnd && adEndAt === null) adEndAt = st.adEnd - t0;
          if (st.ad && st.cur > curMaxAd) curMaxAd = st.cur;
          const playing = !st.paused && st.cur > 0.5;
          if (playing && frameAt === null) frameAt = st.t - t0;
          if (playing && !st.ad) {
            contentAt = st.t - t0;
            curAtContent = st.cur;
            break; // контент пошёл — трассировка завершена
          }
        }
      }
    } catch {
      /* браузер поднимается */
    }
    await sleep(120);
  }
  await sleep(1500); // хвостовые события Network
  ws?.close();
  await killTree(app.pid);
  await settle();
  await sleep(1200);
  return {
    side: name,
    label,
    frameAt,
    contentAt,
    adStartAt,
    adEndAt,
    prerollMs: adStartAt !== null && adEndAt !== null ? adEndAt - adStartAt : null,
    curMaxAd,
    curAtContent,
    // сброс currentTime на стыке реклама→контент: есть → клиентская реклама,
    // нет (счётчик продолжается) → сшитый SSAI-поток
    curReset: curMaxAd > 1.5 && curAtContent !== null && curAtContent < 1,
    requests: [...requests.values()],
    timeline,
  };
}

// --- анализ одного запуска ----------------------------------------------------
const bucketOf = (r) => {
  const u = r.url;
  if (/\/videoplayback/.test(u)) return "media";
  if (/youtubei\/v1\/(player|sabr|next|browse|att\/)|\/api\/(timedtext|manifest|stats|player)/.test(u)) return "api";
  if (/doubleclick\.net|googlesyndication\.com|gvt1\.com|\/pagead\/|\/ptracking/.test(u)) return "ads";
  if (r.type === "Document") return "document";
  return "other";
};

function analyze(l) {
  const frame = l.frameAt ?? 1e9;
  const before = l.requests.filter((r) => r.sent !== undefined && r.sent <= frame);
  const firstByHost = new Map();
  for (const r of before) if (!firstByHost.has(r.host)) firstByHost.set(r.host, r);
  const newHosts = [...firstByHost.values()].filter((r) => !r.cache);
  // стоимость НОВОГО соединения: DNS+прокси+connect (TLS внутри connect,
  // ssl показан отдельно); кэшированные ответы фаз не имеют
  const newCost = newHosts.reduce((s, r) => s + (r.dns || 0) + (r.proxy || 0) + (r.connect || 0), 0);
  const media = before.filter((r) => bucketOf(r) === "media");
  const mediaAfter = l.requests.filter((r) => bucketOf(r) === "media" && r.sent > frame);
  const mediaHostsBefore = [...new Set(media.map((r) => r.host))];
  const mediaHostsAfter = [...new Set(mediaAfter.map((r) => r.host))];
  const buckets = {};
  for (const r of before) buckets[bucketOf(r)] = (buckets[bucketOf(r)] ?? 0) + 1;
  return { before: before.length, buckets, newHosts, newCost, media, mediaHostsBefore, mediaHostsAfter };
}

const fmtHost = (r) =>
  `${r.host} (dns ${r.dns ?? "?"} / proxy ${r.proxy ?? "?"} / connect ${r.connect ?? "?"} / tls ${r.ssl ?? "?"} мс, первый запрос @${r.sent} мс${r.proto ? ", " + r.proto : ""})`;

const runs = { DuoPulse: [], контроль: [] };
try {
  console.log(`Трассировка P-08 (карточка duopulse-055): ${VIDEO}`);
  console.log("DuoPulse (блокировщик включён):");
  for (let i = 0; i < WARMUPS; i++) {
    await warmupOnce("DuoPulse", launchAt(duoProfile, DUO_CDP), DUO_CDP, () => waitWebViewDown(duoProfile));
  }
  for (let i = 0; i < TRACED_RUNS; i++) {
    runs.DuoPulse.push(
      await traceLaunch("DuoPulse", launchAt(duoProfile, DUO_CDP), DUO_CDP, () => waitWebViewDown(duoProfile), `прогон ${i + 1}`),
    );
  }
  console.log("Контроль — DuoPulse (блокировщик выключен):");
  for (let i = 0; i < WARMUPS; i++) {
    await warmupOnce("контроль", launchAt(ctlProfile, CTL_CDP), CTL_CDP, () => waitWebViewDown(ctlProfile));
  }
  for (let i = 0; i < TRACED_RUNS; i++) {
    runs.контроль.push(
      await traceLaunch("контроль", launchAt(ctlProfile, CTL_CDP), CTL_CDP, () => waitWebViewDown(ctlProfile), `прогон ${i + 1}`),
    );
  }

  const summary = {};
  for (const [side, list] of Object.entries(runs)) {
    console.log(`\n=== ${side} ===`);
    summary[side] = { launches: [] };
    for (const l of list) {
      const a = analyze(l);
      const ad = l.frameAt !== null && (l.adStartAt !== null || l.curMaxAd > 0);
      const kind = ad
        ? l.curReset
          ? `преролл ${Math.round((l.prerollMs ?? 0) / 100) / 10} с, КЛИЕНТСКАЯ реклама (currentTime сброшен ${l.curMaxAd.toFixed(1)}→${(l.curAtContent ?? 0).toFixed(1)})`
          : `преролл ${l.prerollMs !== null ? Math.round(l.prerollMs / 100) / 10 + " с" : "?"}, SSAI-сшивка (currentTime ${l.curMaxAd.toFixed(1)}→${(l.curAtContent ?? 0).toFixed(1)} без сброса)`
        : "без рекламы";
      console.log(
        `[${l.label}] первый кадр ${l.frameAt} мс${l.contentAt !== null ? `, контент ${l.contentAt} мс` : ""} — ${kind}`,
      );
      console.log(
        `  запросов до кадра: ${a.before} (${Object.entries(a.buckets).map(([k, v]) => `${k}=${v}`).join(", ") || "пусто"});` +
          ` новых хостов: ${a.newHosts.length}, их DNS+proxy+connect: ${a.newCost} мс`,
      );
      if (a.newHosts.length) {
        for (const r of a.newHosts.slice(0, 8)) console.log(`    + ${fmtHost(r)}`);
        if (a.newHosts.length > 8) console.log(`    … ещё ${a.newHosts.length - 8}`);
      }
      if (ad) {
        console.log(
          `  медиа до кадра (реклама): ${a.media.length} шт. от ${a.mediaHostsBefore.join(", ") || "—"};` +
            ` медиа контента после кадра: хосты ${a.mediaHostsAfter.join(", ") || "—"}`,
        );
      } else {
        console.log(`  медиа до кадра: ${a.media.length} шт. от ${a.mediaHostsBefore.join(", ") || "—"}`);
      }
      summary[side].launches.push({
        label: l.label,
        frameAt: l.frameAt,
        contentAt: l.contentAt,
        prerollMs: l.prerollMs,
        curMaxAd: l.curMaxAd,
        curAtContent: l.curAtContent,
        curReset: l.curReset,
        requestsBeforeFrame: a.before,
        buckets: a.buckets,
        newHostsBeforeFrame: a.newHosts.map((r) => ({ host: r.host, sent: r.sent, dns: r.dns, proxy: r.proxy, connect: r.connect, ssl: r.ssl, proto: r.proto })),
        newHostCostMs: a.newCost,
        mediaHostsBeforeFrame: a.mediaHostsBefore,
        mediaHostsAfterFrame: a.mediaHostsAfter,
      });
    }
    const frames = list.map((l) => l.frameAt).filter((x) => x !== null);
    if (frames.length) {
      summary[side].medianFrameMs = median(frames);
      console.log(`медиана первого кадра: ${summary[side].medianFrameMs} мс`);
    }
  }
  const dump = () =>
    JSON.stringify(
      {
        video: VIDEO,
        generated: new Date().toISOString(),
        // версия списков на момент прогона (карточка 056): digest+rules meta.json
        lists: { DuoPulse: listVersionsOf(duoProfile), контроль: listVersionsOf(ctlProfile) },
        summary,
        raw: runs,
      },
      null,
      1,
    );
  fs.writeFileSync(DUMP, dump());
  const stampDir = process.env.DUOPULSE_P08_TRACE_STAMP_DIR;
  if (stampDir) {
    const stamped = path.join(stampDir, `p08-trace-${new Date().toISOString().replace(/[:.]/g, "")}.json`);
    fs.mkdirSync(stampDir, { recursive: true });
    fs.writeFileSync(stamped, dump());
    console.log(`копия дампа: ${stamped}`);
  }
  console.log(`\nдамп: ${path.relative(ROOT, DUMP)}`);
  console.log(`списки DuoPulse: ${(listVersionsOf(duoProfile) ?? []).map((l) => `${l.name}#${l.digest.toString(16)}(${l.rules})`).join(" ") || "meta.json нет"}`);
} catch (e) {
  console.error("E2E ERROR:", e.message);
  process.exitCode = 1;
} finally {
  keepFilters(duoProfile, "duo");
  keepFilters(ctlProfile, "ctl");
  try {
    fs.rmSync(duoProfile, { recursive: true, force: true });
  } catch {}
  try {
    fs.rmSync(ctlProfile, { recursive: true, force: true });
  } catch {}
  await sleep(1000);
}
