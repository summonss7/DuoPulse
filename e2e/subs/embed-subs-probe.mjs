// DuoPulse e2e-стенд: дорожки субтитров плеер-фрейма кино-сайта (duopulse-199).
//
// Сценарий против живой страницы фильма uakinogo.io (та же, что в пожелании
// 198): таб «Плеер 1» (data-provider="1") включает кросс-доменный OOPIF
// api.embf.net/embed/movie/…, в инлайн-конфиге makePlayer которого лежат
// подписанные .vtt (Eng. full / Укр. / Рус.). Агент content-бандла во фрейме
// (init-script исполняется во всех фреймах, WebMessage-канал туда не достаёт)
// пересылает дорожки/часы/файлы top-документу через window.postMessage;
// топ-бандл заводит виртуальное видео (iframe = геометрия плашки, прокси =
// часы движка) и грузит .vtt агентом фрейма (CDN подписан под origin
// плеера, топу CORS запрещён).
//
// Проверки:
//  1. таб плеера №2 переключает iframe на embf.net (OOPIF-таргет появился);
//  2. агент во фрейме жив (__duopulseFrameAgent);
//  3. топ-бандл видит дорожки: >=3, есть английская (оригинал);
//  4. выбор англ. дорожки: cues разобраны (полный фильм > 100 реплик),
//     enabled=true, путь эмбеда попал в Core (панель получает tracks);
//  5. видео играет и реплики идут: плашка поверх iframe, текст меняется
//     (часы фрейма → прокси → движок);
//  6. [soft] облачный перевод дорожки (gtx с хоста; 429 — мягкий фейл).
//
// Запуск:  node e2e/subs/embed-subs-probe.mjs [url]
//   DUOPULSE_E2E_PROVIDER — номер таба плеера (data-provider; «1» = embf по
//   умолчанию, «0» = дефолтный таб uakinogo — cinemar.cc, duopulse-225:
//   дорожки приходят ответом POST /api/playlist/load, перехват — агент фрейма);
//   DUOPULSE_E2E_LANG — ожидаемый язык дорожки (по умолчанию en).
// Результат — e2e/subs/embed-subs-last-run.json (gitignore, рантайм);
// скриншоты — %TEMP%/duopulse-199-*.png.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const CDP_PORT = 9233;
const URL_ = process.argv[2] || "https://uakinogo.io/novinki/116356-chelovek-pauk-novyy-den.html";
const PROVIDER = process.env.DUOPULSE_E2E_PROVIDER || "1";
const FRAME_HOST = (process.env.DUOPULSE_E2E_FRAME_HOST || (PROVIDER === "0" ? "cinemar.cc" : "embf.net")).replace(/\./g, "\\.");
const WANT_LANG = process.env.DUOPULSE_E2E_LANG || "en";
const SECS = Number(process.env.DUOPULSE_E2E_SECS) || 150;

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

const evalIn = async (ws, expression, timeoutMs) => {
  const r = await ws.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
  if (r.exceptionDetails) return null;
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
// Центр iframe плеера в координатах вкладки (клик play — реальный жест;
// синтетические клики плеер игнорирует).
const PLAYER_RECT = `(() => {
  const f = document.querySelector('.player-container iframe, iframe[src*="embf"], iframe[data-src*="embf"], iframe[src*="cinemar"]');
  if (!f) return null;
  const r = f.getBoundingClientRect();
  if (r.width < 50) return null;
  return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
})()`;

// Состояние субтитров топ-бандла (диагностика __duopulseContent).
const SUBS_STATE = `(() => {
  const c = window.__duopulseContent;
  if (!c) return null;
  const s = c.state();
  return JSON.stringify({
    embed: s.embed, enabled: s.enabled, engine: s.engine,
    overlayVisible: s.overlayVisible, videoKey: s.videoKey,
    overlayText: (document.querySelector('[data-duopulse-subtitles]')?.textContent || '').trim().slice(0, 120),
  });
})()`;
const SUBS_STATE_DEEP = `(() => {
  const c = window.__duopulseContent;
  if (!c) return null;
  const s = c.state();
  return JSON.stringify({
    embed: s.embed, engine: s.engine, enabled: s.enabled, videoKey: s.videoKey,
    overlayVisible: s.overlayVisible,
    overlayText: (document.querySelector('[data-duopulse-subtitles]')?.textContent || '').trim().slice(0, 120),
  });
})()`;

// ── прогон ──────────────────────────────────────────────────────────────────
async function probeRun() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-199-"));
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
  let page, browser, ui;
  const checks = [];
  const check = (name, ok, extra = "") => {
    checks.push({ name, ok, extra });
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  };
  try {
    const host = new URL(URL_).hostname;
    let siteT = null, uiT = null;
    for (let i = 0; i < 90 && !(siteT && uiT); i++) {
      const t = await getJson();
      siteT = siteT || t.find((x) => x.type === "page" && x.url.includes(host));
      if (!uiT) {
        const cand = t.find((x) => x.type === "page" && /localhost:5173/.test(x.url));
        if (cand) {
          const probe = connect(cand.webSocketDebuggerUrl);
          const ty = await evalIn(probe, `typeof window.__duopulse`).catch(() => null);
          probe.close();
          if (ty === "object") uiT = cand;
        }
      }
      if (!(siteT && uiT)) await sleep(1000);
    }
    if (!siteT) throw new Error("вкладка сайта не поднялась");
    page = connect(siteT.webSocketDebuggerUrl);
    await page.send("Runtime.enable").catch(() => {});
    await page.send("Page.enable").catch(() => {});
    if (uiT) ui = connect(uiT.webSocketDebuggerUrl);
    try {
      const v = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json();
      browser = connect(v.webSocketDebuggerUrl);
      await browser.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});
    } catch (e) { console.log(`  (браузерный CDP недоступен: ${e.message})`); }

    // Плеер-контейнер в вьюпорт (lazy-iframe грузится при скролле) → таб
    // «Плеер 1» (data-provider=1, embf) кликом — сайт сам меняет src iframe;
    // PROVIDER=0 — дефолтный таб (cinemar.cc, duopulse-225), клик идемпотентен.
    await sleep(9000); // страница + rocket-loader
    await evalIn(page, `document.querySelector('.player-container')?.scrollIntoView({ block: 'center' })`);
    await sleep(2500);
    const switched = await evalIn(page, `(() => {
      const li = document.querySelector('.js-player-tabs li[data-provider="${PROVIDER}"]');
      if (!li) return "нет таба";
      li.click();
      return "клик";
    })()`);
    console.log(`  таб плеера data-provider=${PROVIDER}: ${switched}`);

    // OOPIF-таргет плеера: появляется после клика (до 30 с).
    const browserTargets = [];
    let playerSid = null;
    const syncTargets = async () => {
      if (!browser) return;
      try {
        const cur = await browser.send("Target.getTargets");
        for (const ti of cur.targetInfos) {
          const ex = browserTargets.find((x) => x.targetId === ti.targetId);
          if (ex) ex.url = ti.url;
          else browserTargets.push(ti);
        }
      } catch { /* браузерный CDP недоступен */ }
    };
    for (let i = 0; i < 30 && !playerSid; i++) {
      await syncTargets();
      const tid = browserTargets.find((x) => x.type === "iframe" && new RegExp(FRAME_HOST).test(x.url))?.targetId;
      if (tid) {
        try {
          const r = await browser.send("Target.attachToTarget", { targetId: tid, flatten: true });
          playerSid = r.sessionId;
          await browser.send("Runtime.enable", {}, undefined, playerSid).catch(() => {});
        } catch { /* фрейм перегрузился — повторим */ }
      }
      if (!playerSid) await sleep(1000);
    }
    const playerEval = async (expr) => {
      if (!playerSid) return null;
      try {
        const r = await browser.send("Runtime.evaluate", { expression: expr, returnByValue: true }, 20000, playerSid);
        if (r?.exceptionDetails) return null;
        return r?.result?.value ?? null;
      } catch { playerSid = null; return null; }
    };
    check(`плеер data-provider=${PROVIDER}: OOPIF-таргет ${FRAME_HOST.replace(/\\/g, "")} поднялся`, !!playerSid,
      playerSid ? browserTargets.find((x) => new RegExp(FRAME_HOST).test(x.url))?.url?.slice(0, 60) : "не найден за 30 с");

    // (2) агент во фрейме: init-скрипт бандла исполняется во всех фреймах.
    await sleep(3000); // видео создаётся плеером не сразу
    const agent = await playerEval(`typeof window.__duopulseFrameAgent`);
    check("агент DuoPulse во фрейме плеера (__duopulseFrameAgent)", agent === "object", String(agent));

    // duopulse-225 (cinemar): субтитры принадлежат ДУБЛЯЖУ — дефолтный
    // может идти без них (duopulse-230: у «Сердца зверя» дефолтный HDrezka
    // идёт БЕЗ субтитров, прежний дефолт стенда «Дубляж (TVShows)» сайт
    // убрал из списка вовсе). DUOPULSE_E2E_DUB — точное имя; без переменной
    // стенд сам перебирает дубляжи, пока топ-бандл не увидит дорожки
    // (предпочтение — дорожка ожидаемого языка), и возвращается к лучшему.
    if (PROVIDER === "0") {
      const DUB = process.env.DUOPULSE_E2E_DUB || "";
      await sleep(4000); // playlist UI плеера построен
      const opened = await playerEval(`(() => {
        const t = document.querySelector('.playlist-title');
        if (!t) return "нет кнопки списка";
        t.click();
        return "открыт";
      })()`);
      console.log(`  список дубляжей: ${opened}`);
      await sleep(1200);
      const embedTracksNow = async () => {
        const st = JSON.parse((await evalIn(page, SUBS_STATE)) || "null");
        return st?.embed?.tracks ?? [];
      };
      const clickDub = async (name) => playerEval(`(() => {
        const btn = [...document.querySelectorAll('.playlist button')].find(
          (b) => (b.textContent || '').trim() === ${JSON.stringify(name)});
        if (!btn) return "нет дубляжа";
        btn.click();
        return "клик";
      })()`);
      if (DUB) {
        console.log(`  дубляж «${DUB}»: ${await clickDub(DUB)}`);
        await sleep(4000); // playlist/load → перехват агента → пере-анонс
      } else {
        const names = JSON.parse((await playerEval(
          `JSON.stringify([...document.querySelectorAll('.playlist button')].map(b => (b.textContent||'').trim()))`,
        )) || "[]");
        let best = null; // {name, hasLang}
        for (const name of names.slice(0, 8)) {
          await clickDub(name);
          for (let i = 0; i < 8; i++) {
            await sleep(1000);
            const tr = await embedTracksNow();
            if (tr.length) {
              const hasLang = tr.some((t) => t.lang === WANT_LANG);
              console.log(`  дубляж «${name}»: дорожек ${tr.length}${hasLang ? ` (есть ${WANT_LANG})` : ""}`);
              if (hasLang) { best = { name, hasLang: true }; break; }
              if (!best) best = { name, hasLang: false };
              break;
            }
          }
          if (best?.hasLang) break;
        }
        if (best && !best.hasLang) {
          console.log(`  вернулись к «${best.name}» (дорожек без ${WANT_LANG})`);
          await clickDub(best.name);
          await sleep(4000);
        }
        if (!best) console.log("  ни один дубляж (первые 8) не дал дорожек");
      }
    }

    // (3) топ-бандл: дорожки эмбеда пришли relay'ем (до 30 с — плеер строится;
    // cinemar — после ответа playlist/load, перехваченного агентом).
    let embed = null;
    for (let i = 0; i < 30 && !embed; i++) {
      const st = JSON.parse((await evalIn(page, SUBS_STATE)) || "null");
      if (st?.embed?.tracks?.length) embed = st.embed;
      else await sleep(1000);
    }
    const embedTracks = embed?.tracks ?? [];
    const enTrack = embedTracks.find((t) => t.lang === WANT_LANG);
    check(
      `топ-бандл видит дорожки плеера (>=1, есть ${WANT_LANG})`,
      embedTracks.length >= 1 && !!enTrack,
      embedTracks.map((t) => `${t.id}(${t.name})`).join(", ") || "пусто",
    );

    // (3b) duopulse-232: авто-дуо из дорожек САМОГО плеера — video-auto на
    // списке с несколькими языками включает ДВЕ строки (en + цель правила
    // ru/uk) без облака; проверяем ДО явного выбора стенда (перезапишет его).
    {
      let auto = null;
      for (let i = 0; i < 15 && !auto; i++) {
        const st = JSON.parse((await evalIn(page, SUBS_STATE)) || "null");
        if (st?.engine?.tracks?.some((t) => (t.cues ?? 0) > 0)) auto = st;
        else await sleep(1000);
      }
      const tracks = auto?.engine?.tracks ?? [];
      check(
        "авто-дуо из дорожек плеера (duopulse-232: две строки без облака)",
        tracks.length === 2 && tracks.some((t) => t.lang === WANT_LANG) && tracks.some((t) => t.lang !== WANT_LANG && t.lang !== "und"),
        tracks.map((t) => `${t.id}:${t.lang}(${t.cues})`).join(", ") || "набор пуст",
      );
    }

    // (4) выбор дорожки: загрузка агентом фрейма + разбор Core-парсером.
    const enId = enTrack?.id ?? `embed:${WANT_LANG}:0`;
    await evalIn(page, `window.__duopulseContent.selectTracks([${JSON.stringify(enId)}])`);
    let applied = null;
    for (let i = 0; i < 30 && !applied; i++) {
      const st = JSON.parse((await evalIn(page, SUBS_STATE)) || "null");
      const t = st?.engine?.tracks?.find((x) => x.id === enId);
      if (t && t.cues > 0 && st.enabled) applied = st;
      else await sleep(1000);
    }
    check(
      "дорожка загружена через фрейм и применена (cues>100, enabled)",
      !!applied && applied.engine.tracks.find((x) => x.id === enId).cues > 100,
      applied ? `cues=${applied.engine.tracks.find((x) => x.id === enId).cues}, videoKey=${String(applied.videoKey).slice(0, 40)}` : "не дождались",
    );

    // (5) видео играет: клики в центр iframe (преролл плеера честно кликаем
    // тоже), ждём реплику на плашке и её смену — часы фрейма идут.
    let playClicked = 0;
    const overlayTexts = [];
    const t0 = Date.now();
    while (Date.now() - t0 < SECS * 1000) {
      const vid = JSON.parse((await playerEval(`(() => {
        const v = document.querySelector('video');
        return v ? JSON.stringify({ t: Math.round(v.currentTime), paused: v.paused }) : null;
      })()`)) || "null");
      const st = JSON.parse((await evalIn(page, (Date.now() - t0) % 9000 < 3000 ? SUBS_STATE_DEEP : SUBS_STATE)) || "null");
      const text = st?.overlayText || "";
      if (text) overlayTexts.push({ at: Math.round((Date.now() - t0) / 1000), text });
      const eng = st?.engine;
      console.log(`    t+${Math.round((Date.now() - t0) / 1000)}s vid=${vid ? `t=${vid.t},paused=${vid.paused}` : "—"} плашка="${text.slice(0, 40)}"${eng ? ` eng(att=${eng.attached},cb=${eng.frameCallback},rows=${eng.activeRows.length},t=${eng.tracks.map((x) => x.cues).join("/")})` : ""}${st?.embed ? ` host=${String(st.embed.videoKey).slice(-14)}trk=${st.embed.tracks.length}` : ""}`);
      if (overlayTexts.length >= 3 && new Set(overlayTexts.map((x) => x.text)).size >= 2) break;
      if ((!vid || vid.paused) && playClicked < 8) {
        const rect = JSON.parse((await evalIn(page, PLAYER_RECT)) || "null");
        if (rect) {
          await page.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: rect.x, y: rect.y });
          await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: rect.x, y: rect.y });
          playClicked++;
        }
      }
      await sleep(3000);
    }
    const distinctTexts = [...new Set(overlayTexts.map((x) => x.text))];
    check(
      "реплики идут по плашке поверх фрейма (часы фрейма → движок)",
      distinctTexts.length >= 2,
      distinctTexts.length ? `реплик: ${distinctTexts.length}, первая: «${distinctTexts[0].slice(0, 50)}»` : "плашка пуста",
    );

    // (6) [soft] облачный перевод дорожки: gtx с хоста работает, квота 429 —
    // мягкий фейл (не валит прогон).
    let translate = { tried: false, tracks: -1 };
    try {
      await evalIn(page, `document.dispatchEvent(new CustomEvent('duopulse-translate-request', { detail: { trackId: ${JSON.stringify(enId)}, targetLang: 'ru' } }))`);
      for (let i = 0; i < 45; i++) {
        const st = JSON.parse((await evalIn(page, SUBS_STATE)) || "null");
        if ((st?.engine?.tracks ?? []).some((x) => x.id.startsWith("cloud:ru"))) { translate.tracks = st.engine.tracks.filter((x) => x.id.startsWith("cloud:")).length; break; }
        await sleep(2000);
      }
      translate.tried = true;
    } catch (e) { translate.tried = true; translate.error = e.message; }
    console.log(`  [soft] перевод дорожки: ${translate.tracks > 0 ? `cloud-строк ${translate.tracks}` : translate.error ?? "не дождались (квота?)"}`);

    // скриншот для записи
    let shot = null;
    try {
      const s = await page.send("Page.captureScreenshot", { format: "png" });
      shot = path.join(os.tmpdir(), `duopulse-199-${Date.now()}.png`);
      fs.writeFileSync(shot, Buffer.from(s.data, "base64"));
    } catch {}

    return { checks, embedTracks, overlayTexts: overlayTexts.slice(0, 10), distinctTexts, translate, shot };
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
  console.log(`стенд duopulse-199 (субтитры плеер-фрейма): ${URL_}`);
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
    path.join(ROOT, "e2e", "subs", "embed-subs-last-run.json"),
    JSON.stringify({ date: new Date().toISOString(), url: URL_, ...result }, null, 2),
  );
  console.log(`\nитог: ${result.checks.length - failed.length}/${result.checks.length} проверок; скриншот: ${result.shot || "нет"}`);
  console.log("результат — e2e/subs/embed-subs-last-run.json");
  if (failed.length) { console.log(`FAIL: ${failed.map((f) => f.name).join("; ")}`); process.exitCode = 1; }
} catch (e) {
  console.error("EMBED-SUBS-PROBE ERROR:", e.message);
  process.exitCode = 1;
} finally {
  try { await run("taskkill", ["/PID", String(vite.pid), "/T", "/F"]); } catch {}
}
