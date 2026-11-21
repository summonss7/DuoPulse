// Живой стенд duopulse-195: DuoPulse не запускает видео сам.
// Жалоба: «сворачиваю/разворачиваю/перехожу по вкладкам — некоторые видео сами
// включаются потом». Корни (закрыты карточкой):
//   1) PlayerApiTransport.begin делал muted-старт паузы ради ленивой загрузки
//      дорожек — теперь транспорт не трогает стоящее на паузе видео вообще
//      (даже loadModule: YouTube играет паузу от программирования плеера);
//   2) ad-skip handoff-nudge (089) подталкивал playVideo «unstarted»-контенту
//      после рекламы — стоящее на паузе видео выглядело как unstarted;
//   3) повторная попытка дуо — по факту play (duoWanted в документе).
// Проверки:
//   A) устоявшееся видео (15с просмотра) на паузе + включение duo (toggle) —
//      видео НЕ играется (тот же элемент, 18с лестницы ретраев);
//   B) инструментированный call-log: video.play/player.playVideo не звались
//      из наших скриптов до явного play стенда;
//   C) play поднимает дефолт-набор заново (re-arm): дорожки в движке,
//      плашка показана (перевод может 429-квотиться — достаточно 1 дорожки);
//   D) duopulse-196: дуо включён ПО УМОЛЧАНИЮ — свежий профиль, никто не жал
//      кнопку, video-auto сам поднял дефолт-набор (en-видео → перевод ru).
// Запуск: node e2e/subtitles/pause-no-autoplay.mjs [duopulse.exe] [videoId]
// Требует собранный debug-exe; профиль свежий на прогон; тег <video>
// (dataset.p Stand195) отличает наш элемент от пересозданного YouTube.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const VIDEO = process.argv[3] || "hT_nvWreIhg"; // Counting Stars: en-ручная + переводы
const CDP_PORT = 9244;
const LAST_RUN = path.join(ROOT, "e2e", "subtitles", "pause-no-autoplay-last-run.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok, extra });
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
  const open = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  return { open, send, close: () => ws.close() };
}

async function evalIn(ws, expr, awaitPromise = false) {
  const r = await ws.send("Runtime.evaluate", { expression: expr, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result?.value;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-195-"));
let app;
try {
  app = spawn(EXE, [], {
    stdio: "ignore",
    env: {
      ...process.env,
      APPDATA: tmp,
      DUOPULSE_START_URL: `https://www.youtube.com/watch?v=${VIDEO}`,
      DUOPULSE_SLEEP_AFTER_SECS: "0",
      WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT} --autoplay-policy=no-user-gesture-required`,
    },
  });

  let tab = null;
  for (let attempt = 0; attempt < 5 && !tab; attempt++) {
    let target;
    for (let i = 0; i < 90; i++) {
      try {
        const list = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
        target = list.find((x) => x.type === "page" && x.url.includes("youtube.com"));
        if (target) break;
      } catch { /* поднимается */ }
      await sleep(1000);
    }
    if (!target) throw new Error("CDP-цель YouTube не найдена");
    const t = connect(target.webSocketDebuggerUrl);
    try {
      await t.open;
      await t.send("Page.enable").catch(() => {});
      await evalIn(t, `1 + 1`);
      tab = t;
    } catch {
      t.close();
      await sleep(3000);
    }
  }
  if (!tab) throw new Error("CDP: цель не подсоединилась");

  for (let i = 0; i < 60; i++) {
    const ready = await evalIn(tab, `!!document.querySelector("video") && !!window.__duopulseContent`);
    if (ready) break;
    await sleep(1000);
  }
  // Устоявшийся просмотр: реклама кончилась, список дорожек готов, 15с игры —
  // пауза AFTER старта не гоняется с bootstrap-инициализацией YouTube
  // (maybeAdoptBootstrapPlayer_ сам играет «паузу» в первые секунды).
  for (let i = 0; i < 90; i++) {
    const ok = await evalIn(
      tab,
      `(function(){
        const ad = !!(document.getElementById("movie_player")?.classList?.contains("ad-showing"));
        const v = document.querySelector("video");
        const content = !!(v && Number.isFinite(v.duration) && v.duration > 120);
        return !ad && content && !!window.__duopulseContent?.state().canTracks && (v?.currentTime ?? 0) > 15;
      })()`,
    );
    if (ok === true) break;
    await sleep(1000);
  }

  // D: дуо по умолчанию (duopulse-196) — свежий профиль (lastEnabled нет),
  // видео играет само; video-auto обязан поднять набор без всяких кнопок
  let auto = null;
  for (let i = 0; i < 40; i++) {
    auto = await evalIn(tab, `__duopulseContent.state()`);
    if (auto && auto.enabled && auto.engine.trackCount >= 1) break;
    await sleep(1000);
  }
  check(
    "D. дуо включён сам (video-auto, duopulse-196): набор в движке",
    !!(auto && auto.enabled && auto.engine.trackCount >= 1),
    auto ? JSON.stringify({ enabled: auto.enabled, tracks: auto.engine.trackCount }) : "нет состояния",
  );

  // Инструментация (duopulse-195): кто зовёт video.play / player API
  await evalIn(tab, `(function(){
    window.__callLog = [];
    const log = (what) => { try { window.__callLog.push(what + " :: " + String(new Error().stack).split("\\n").slice(2,7).join(" <= ")); } catch(e){} };
    const op = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function(){ log("video.play"); return op.apply(this, arguments); };
    const mp = document.getElementById("movie_player");
    if (mp) for (const m of ["loadModule","unloadModule","setOption","seekTo","playVideo","pauseVideo"]) {
      const o = mp[m];
      if (typeof o === "function") try { mp[m] = function(){ log("player."+m); return o.apply(this, arguments); }; } catch(e){}
    }
    return true;
  })()`);

  // Пауза до устойчивого состояния; тег элемента отличит пересоздание YouTube
  let pausedBefore = undefined;
  for (let i = 0; i < 10; i++) {
    await evalIn(tab, `(function(){const v=document.querySelector("video"); if(v){ if(!v.paused) v.pause(); v.dataset.pStand195="1";} return true;})()`);
    await sleep(800);
    pausedBefore = await evalIn(tab, `(function(){const v=document.querySelector("video"); return v ? (v.paused && v.dataset.pStand195==="1") : undefined;})()`);
    if (pausedBefore === true) break;
    await sleep(700);
  }
  check("0. видео поставлено на паузу (устоявшийся просмотр)", pausedBefore === true, `paused=${pausedBefore}`);

  // A: включение duo на паузе — видео никто не играет
  await evalIn(tab, `document.dispatchEvent(new CustomEvent("duopulse-toggle", {detail:{enabled:true, via:"stand-195"}})); true`);
  const videoState = () => evalIn(tab, `(function(){const v=document.querySelector("video"); return v ? {paused: v.paused, tagged: v.dataset.pStand195==="1", t: Math.round(v.currentTime*10)/10} : null;})()`);
  await sleep(6000);
  const vs6 = await videoState();
  check("A1. пауза + включение duo: видео НЕ запустилось (6с)", vs6 && vs6.paused === true && vs6.tagged === true, JSON.stringify(vs6));
  await sleep(12000);
  const vs18 = await videoState();
  check("A2. спустя 18с (лестница ретраев) видео всё ещё на паузе", vs18 && vs18.paused === true && vs18.tagged === true, JSON.stringify(vs18));

  // B: до явного play стенда — только DuoPulse-независимые вызовы (стенд play
  // помечен <anonymous>:1 — ниже фильтруется по нашему eval-маркеру)
  await evalIn(tab, `(function(){const v=document.querySelector("video"); if(v) return v.play();})()`, true);

  // C: play поднял набор (re-arm) — перевод может 429 (квота tlang), достаточно оригинала
  let st = null;
  for (let i = 0; i < 40; i++) {
    st = await evalIn(tab, `__duopulseContent.state()`);
    if (st.engine.trackCount > 0) break;
    await sleep(1000);
  }
  check("C1. play поднял дефолт-набор (re-arm): дорожки в движке", st.engine.trackCount >= 1, `tracks=${st.engine.trackCount}`);
  check("C2. показ включён (плашка видна)", st.enabled === true || st.overlayVisible === true, JSON.stringify({ enabled: st.enabled, overlay: st.overlayVisible }));

  const calls = (await evalIn(tab, `window.__callLog ?? []`)).filter((c) => !c.includes("<anonymous>:1:"));
  const foreign = calls.filter((c) => c.includes("player.playVideo") || c.includes("video.play"));
  check("B. video.play/player.playVideo не звались до явного play", foreign.length === 0, foreign.length ? foreign[0].slice(0, 160) : `${calls.length} легальных вызовов плеера`);
} catch (e) {
  results.push({ name: "стенд упал", ok: false, extra: String(e.message ?? e).slice(0, 300) });
  console.error("СТЕНД УПАЛ:", e);
} finally {
  try { app?.kill(); } catch { /* уже вышел */ }
  await sleep(800);
  try { await execFile("taskkill", ["/IM", "duopulse.exe", "/F"], () => {}); } catch { /* нет — ок */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
}

fs.writeFileSync(LAST_RUN, JSON.stringify({ at: new Date().toISOString(), video: VIDEO, results }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? "ИТОГ: все проверки прошли" : `ИТОГ: провалено ${failed.length}`);
process.exit(failed.length === 0 ? 0 : 1);
