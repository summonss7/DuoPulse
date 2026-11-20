// Стенд duopulse-190: охват адблока по кросс-доменным (OOPIF) фреймам после
// снятия гейта хостов — сетевой уровень (перегрузка ICoreWebView2_22
// AddWebResourceRequestedFilterWithRequestSourceKinds(ALL) в main.rs —
// браузер-флаг msEdgeWebViewApplyWebResourceRequestedFilterForOOPIFs не
// нужен, замерено) и префильтр+кэш фреймовых скриптлетов
// (AdblockService::frame_script_plan).
//
// Локальная страница + N кросс-доменных iframes sub<i>.localhost (каждый —
// свой origin; WebView2 рендерит их out-of-process). Проверки:
//   1) фреймы живы: каждый отчитался postMessage'ом в top;
//   2) СЕТЕВОЙ УРОВЕНЬ OOPIF: fetch из фрейма по BLOCK_TEST_PATH
//      (/duopulse_block_test_probe — main.rs отдаёт 403 из COM-перехватчика)
//      блокируется при включённом флаге; DUOPULSE_OOPIF_FILTER=0 (A/B) —
//      тот же fetch проходит насквозь: разница доказывает, что без флага
//      WebResourceRequested запросы фреймов не видит (пробел 188/190);
//   3) UI/Core round-trip (window.__duopulse.tabs.list) жив при шторме DCL
//      N фреймов — инъекционная обвязка не вешает UI-нить;
//   4) CPU успокаивается после загрузки (шторм уникальных хостов без правил
//      не будит расчёт косметики: префильтр отсекает до url_cosmetic_resources);
//   5) YouTube-эмбед на соседней странице играет (запросы эмбеда теперь идут
//      через перехватчик — EasyList/compat не ломают плеер; CDP-таргет
//      type "iframe", видео currentTime>1).
//
// Запуск:  node e2e/adblock/frame-storm-probe.mjs [N=40]
// A/B:     DUOPULSE_OOPIF_FILTER=0 node e2e/adblock/frame-storm-probe.mjs  (проверка 2 инвертируется: OOPIF мимо — пробел как был)
// Результат — e2e/adblock/frame-storm-last-run.json (gitignore, рантайм).
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const CDP_PORT = 9233;
const HTTP_PORT = 8897;
const FRAMES = Number(process.argv[2] || process.env.DUOPULSE_E2E_FRAMES || 40);
const OOPIF_FILTER_OFF = process.env.DUOPULSE_OOPIF_FILTER === "0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, opts, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))));
const checks = [];
const check = (name, ok, extra = "") => {
  checks.push({ name, ok, extra: String(extra) });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
};

// PS-строки не экранируют бэкслеш (экран — backtick): путь из path.join
// подставляем как есть (двойные слэши ломали -eq — метрика CPU была 0)
const EXE_WIN = EXE;
const ourPids = async () => {
  const out = await run("powershell", ["-NoProfile", "-Command",
    `Get-CimInstance Win32_Process -Filter "Name='duopulse.exe'" | Where-Object { $_.ExecutablePath -eq '${EXE_WIN}' } | Select-Object -ExpandProperty ProcessId`]);
  return out.split(/\s+/).filter(Boolean);
};
const killOurExes = async () => {
  for (let i = 0; i < 3; i++) {
    const pids = await ourPids().catch(() => []);
    if (!pids.length) return;
    await run("powershell", ["-NoProfile", "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='duopulse.exe'" | Where-Object { $_.ExecutablePath -eq '${EXE_WIN}' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }`]).catch(() => {});
    await sleep(1500);
  }
  throw new Error("killOurExes: процессы не умерли");
};
/** CPU-секунды дерева duopulse.exe + msedgewebview2 (BFS по родителям).
 * Win32_Process не имеет поля CPU — сумма Kernel+UserModeTime (100-нс);
 * выводим ЦЕЛЫЕ сотые доли секунды: десятичный разделитель локали
 * («2,53» ру-локали) ломал Number() — метрика молча превращалась в 0. */
const treeCpu = async () => {
  const out = await run("powershell", ["-NoProfile", "-Command",
    "$all = Get-CimInstance Win32_Process; $ids = @($all | Where-Object { $_.Name -eq 'duopulse.exe' -and $_.ExecutablePath -eq '" + EXE_WIN + "' } | ForEach-Object { $_.ProcessId }); for ($i=0; $i -lt 4; $i++) { $kids = @($all | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids } | ForEach-Object { $_.ProcessId }); if (-not $kids.Count) { break }; $ids = @($ids + $kids) }; [math]::Round(($all | Where-Object { $_.ProcessId -in $ids } | ForEach-Object { [double]$_.KernelModeTime + [double]$_.UserModeTime } | Measure-Object -Sum).Sum/1e5)"]);
  return (Number(String(out).trim()) || 0) / 100;
};

// ── локальные страницы ───────────────────────────────────────────────────────
// Сервер один (слушает 127.0.0.1): фреймы ходят по http://sub<i>.localhost
// (Chromium резолвит *.localhost в loopback; proxy-bypass «localhost»
// покрывает поддомена — трафик не уходит в роутер).
const STORM_HTML = `<!doctype html><meta charset="utf-8"><body>
<script>
  window.__storm = { reported: 0, blocked: 0, passed: 0, byHost: {} };
  addEventListener('message', (e) => {
    const d = e.data || {};
    if (!d.stormFrame) return;
    __storm.reported++;
    if (d.blocked) __storm.blocked++; else __storm.passed++;
    __storm.byHost[d.host] = d.status;
  });
  const mk = (src) => { const f = document.createElement('iframe'); f.src = src; f.width = 100; f.height = 60; document.body.appendChild(f); };
  for (let i = 0; i < ${FRAMES}; i++) mk('http://sub' + i + '.localhost:${HTTP_PORT}/frame');
  // контрольные: same-origin (127.0.0.1 — перехват виден всегда) и
  // реальный кросс-домен (localhost vs IP — OOPIF)
  mk('http://127.0.0.1:${HTTP_PORT}/frame');
  mk('http://localhost:${HTTP_PORT}/frame');
</script>`;
const FRAME_HTML = `<!doctype html><meta charset="utf-8"><body><script>
  // fetch BLOCK_TEST_PATH: main.rs отдаёт 403 из COM-перехватчика ДО сети
  // (сетевой уровень для OOPIF-фреймов — суть проверки 2)
  fetch('/duopulse_block_test_probe?frame=' + location.hostname)
    .then((r) => parent.postMessage({ stormFrame: 1, host: location.hostname, blocked: !r.ok, status: r.status }, '*'))
    .catch((e) => parent.postMessage({ stormFrame: 1, host: location.hostname, blocked: true, status: 'err:' + (e && e.message || e) }, '*'));
</script>`;
const EMBED_HTML = `<!doctype html><meta charset="utf-8"><body>
<iframe id="yt" width="640" height="360" src="https://www.youtube.com/embed/jNQXAC9IVRw?autoplay=1&mute=1" allow="autoplay"></iframe>
</body>`;

const server = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("access-control-allow-origin", "*");
  res.end(req.url.startsWith("/frame") ? FRAME_HTML : req.url.startsWith("/embed") ? EMBED_HTML : STORM_HTML);
});

// ── CDP ─────────────────────────────────────────────────────────────────────
const getJson = async () => (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error("ws: " + wsUrl)); });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    } else listeners.forEach((l) => l(m));
  };
  return {
    ws,
    on: (l) => listeners.push(l),
    send: async (method, params = {}, timeoutMs = 20000) => {
      await opened;
      return new Promise((res, rej) => {
        const i = ++id;
        const t = setTimeout(() => { pending.delete(i); rej(new Error("CDP timeout: " + method)); }, timeoutMs);
        pending.set(i, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
        ws.send(JSON.stringify({ id: i, method, params }));
      });
    },
    close: () => ws.close(),
  };
}
const evalIn = async (conn, expression, timeoutMs = 20000, contextId) => {
  const r = await conn.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, ...(contextId ? { contextId } : {}) }, timeoutMs);
  if (r.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.exceptionDetails.exception ?? r.exceptionDetails).slice(0, 300));
  return r.result?.value;
};

// ── прогон ──────────────────────────────────────────────────────────────────
const t0 = Date.now();
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
let exit = 1;
let child = null;
let ui = null;
let vite = null;
try {
  await killOurExes();
  await new Promise((r) => server.listen(HTTP_PORT, "127.0.0.1", r));
  for (let i = 0; i < 30; i++) { try { await fetch(`http://localhost:${CDP_PORT}/json`, { signal: AbortSignal.timeout(800) }); await sleep(1000); } catch (e) { if (e?.name === "TimeoutError") continue; break; } }

  // vite (UI-webview debug-бандла) — как у sites-ads-probe
  vite = spawn("npm", ["run", "dev"], { cwd: ROOT, shell: true, stdio: "ignore" });
  const viteUp = async () => { try { return (await (await fetch("http://localhost:5173/", { signal: AbortSignal.timeout(1200) })).text()).length > 0; } catch { return false; } };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dp190-storm-"));
  child = spawn(EXE, [], {
    env: {
      ...process.env,
      APPDATA: tmp,
      DUOPULSE_START_URL: `http://127.0.0.1:${HTTP_PORT}/storm`,
      DUOPULSE_E2E_NO_SINGLE_INSTANCE: "1",
      WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
      ...(OOPIF_FILTER_OFF ? { DUOPULSE_OOPIF_FILTER: "0" } : {}),
    },
    stdio: "ignore",
  });

  // ждём вкладку со штормом
  let tab = null;
  for (let i = 0; i < 40 && !tab; i++) {
    await sleep(1000);
    const ts = await getJson().catch(() => []);
    tab = ts.find((x) => x.type === "page" && x.url.includes(":8897/storm"));
  }
  if (!tab) throw new Error("вкладка шторма не поднялась");
  let page = connect(tab.webSocketDebuggerUrl);
  await page.send("Runtime.enable");

  // (1)+(2): фреймы отчитались; fetch BLOCK_TEST_PATH из OOPIF
  let stormStr = null;
  for (let i = 0; i < 30 && !stormStr; i++) {
    await sleep(1000);
    stormStr = await evalIn(page, `window.__storm && __storm.reported >= ${Math.ceil(FRAMES * 0.9)} ? JSON.stringify(__storm) : null`, 8000).catch(() => null);
  }
  const storm = stormStr ? JSON.parse(stormStr) : null;
  if (storm) {
    check(`фреймы живы (>=90% отчитались из ${FRAMES}+3 origins)`, storm.reported >= Math.ceil(FRAMES * 0.9),
      `reported=${storm.reported}`);
    // Диагностика по типам origin: sub*.localhost против 127.0.0.1/[::1]/
    // localhost — если реальным кросс-доменным блок доходит, а поддомена
    // нет, семейство localhost не изолируется (не OOPIF)
    const real = ["127.0.0.1", "localhost"].map((h) => `${h}=${storm.byHost[h]}`).join(" ");
    const wantBlocked = !OOPIF_FILTER_OFF;
    check(
      `сетевой уровень OOPIF: fetch BLOCK_TEST_PATH из фрейма ${wantBlocked ? "блокируется перехватчиком (флаг ON)" : "проходит насквозь (флаг OFF — A/B-доказательство пробела)"}`,
      storm.reported > 0 && (wantBlocked ? storm.passed === 0 : storm.blocked === 0),
      `blocked=${storm.blocked} passed=${storm.passed}; контольные: ${real}${!wantBlocked && storm.blocked > 0 ? " (OOPIF мимо перехватчика — это и есть пробел 188/190; выключитель не сработал?)" : ""}`);
  } else {
    check(`фреймы живы (>=90% отчитались из ${FRAMES}+3 origins)`, false, "postMessage не доехали");
  }

  // (3): UI/Core round-trip при живом шторме (dev-хук ждём, как mem-hang)
  for (let i = 0; i < 60; i++) {
    const ts = await getJson().catch(() => []);
    const u = ts.find((x) => x.type === "page" && /localhost:5173/.test(x.url));
    if (u) {
      ui = connect(u.webSocketDebuggerUrl);
      if ((await evalIn(ui, `typeof window.__duopulse`, 8000).catch(() => "")) === "object") break;
      ui.close(); ui = null;
    }
    await sleep(1000);
  }
  if (ui) {
    const rt = await evalIn(ui, `(async () => { if (!window.__duopulse) return null; const t0 = Date.now(); await window.__duopulse.tabs.list(); return Date.now() - t0; })()`, 15000).catch((e) => "ERR:" + e.message);
    check("UI/Core round-trip жив (tabs.list при шторме DCL-фреймов)", typeof rt === "number", `rt=${rt}ms`);
  } else {
    check("UI/Core round-trip жив (tabs.list при шторме DCL-фреймов)", false, "UI-цель не найдена (vite?)");
  }

  // (4): CPU успокаивается (шторм хостов без правил не будит косметику)
  const cpu1 = await treeCpu();
  await sleep(10000);
  const cpu2 = await treeCpu();
  const cpuDelta = cpu2 - cpu1;
  check(`CPU после шторма успокаивается (префильтр гасит шторм без правил)`, cpuDelta < 3.0, `дерево CPU ${cpu1.toFixed(1)}→${cpu2.toFixed(1)} (+${cpuDelta.toFixed(1)}с за 10с; N=${FRAMES} уникальных хостов)`);

  // (5): YouTube-эмбед (OOPIF youtube.com в локальной странице) играет
  await evalIn(page, `location.href = 'http://127.0.0.1:${HTTP_PORT}/embed'`).catch(() => {});
  let yt = null;
  let ytLast = null;
  for (let i = 0; i < 25 && !yt; i++) {
    await sleep(1000);
    const ts = await getJson().catch(() => []);
    const f = ts.find((x) => x.type === "iframe" && /youtube\.com\/embed/.test(x.url));
    if (!f) continue;
    const fw = connect(f.webSocketDebuggerUrl);
    await fw.send("Runtime.enable");
    const v = await evalIn(fw, `(() => { const v = document.querySelector('video'); const err = document.querySelector('.ytp-error-content-wrap-reason'); return { v: v ? { t: v.currentTime, paused: v.paused, rs: v.readyState } : null, err: err ? err.textContent.trim().slice(0, 60) : null }; })()`, 8000).catch(() => null);
    const flat = v ? { ...(v.v || { t: -1, paused: true, rs: -1 }), err: v.err } : null;
    fw.close();
    if (flat) { ytLast = flat; if (flat.t > 1 && !flat.paused) yt = flat; }
  }
  const ytOk = !!(yt && yt.t > 1 && !yt.paused);
  const ytView = yt || ytLast;
  check("YouTube-эмбед играет (запросы эмбеда через перехватчик не ломаются)", ytOk,
    ytView ? `t=${ytView.t.toFixed(1)} paused=${ytView.paused} readyState=${ytView.rs}${ytView.err ? ' err=' + ytView.err : ''}` : "iframe-таргет/видео не найден");
  if (!ytOk) {
    const shot = path.join(os.tmpdir(), `duopulse-190-embed-${Date.now()}.png`);
    try {
      await page.send("Page.enable");
      const r = await page.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(shot, Buffer.from(r.data, "base64"));
      console.log(`    скриншот эмбеда: ${shot}`);
    } catch { /* вкладка могла уйти */ }
  }

  exit = checks.every((c) => c.ok) ? 0 : 1;
} catch (e) {
  console.error("FRAME-STORM-PROBE ERROR:", e.message);
} finally {
  try { child?.kill(); } catch {}
  try { ui?.close(); } catch {}
  await killOurExes().catch(() => {});
  try { server.close(); } catch {}
  try { if (vite?.pid) await run("taskkill", ["/PID", String(vite.pid), "/T", "/F"]); } catch {}
  const out = {
    date: new Date().toISOString(), frames: FRAMES, oopifFilterOff: OOPIF_FILTER_OFF,
    secs: Math.round((Date.now() - t0) / 1000), checks,
  };
  fs.writeFileSync(path.join(ROOT, "e2e", "adblock", "frame-storm-last-run.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`итог: ${checks.filter((c) => c.ok).length}/${checks.length} проверок (${stamp()}); результат — e2e/adblock/frame-storm-last-run.json`);
}
process.exit(exit);
