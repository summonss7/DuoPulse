// DuoPulse e2e-стенд: субтитры в ПОЛНОЭКРАННОМ режиме + дуо из дорожек плеера
// (карточка duopulse-232: «на uakinogo субтитры есть на свёрнутом окне,
// разворачиваю на весь экран — исчезают; и не могу включить русский и
// английский двумя строками, как на Ютубе»).
//
// Полностью офлайн (без живого сайта — детерминированный): локальный сервер
// 10.0.2.2-стиля localhost:8897 + кросс-доменный OOPIF sub1.localhost с тем же
// инлайн-конфигом makePlayer, что у эмбеда кино-сайтов (duopulse-199), и
// <video> внутри фрейма (агент → анонс → виртуальное видео в топе).
//
// Механика бага: Fullscreen API поднимает элемент плеера в top layer, плашка
// position:fixed остаётся ПОД ним (::backdrop) — и для контейнера в своём
// документе, и для IFRAME, изнутри которого фулскрин просит плеер кино-сайта
// (в топ-документе fullscreenElement = сам IFRAME, DOM внутрь не добавить).
// Фикс duopulse-232 — Popover API: popover="manual" + showPopover() поднимает
// плашку в top layer СВЕРХУ фулскрин-элемента; проверяем по :popover-open
// (DOM-истина слоёв) + геометрии + тексту строк.
//
// Вторая половина карточки: дуо из дорожек САМОГО плеера (Eng. full + Рус.) —
// translations больше не пусты (embedTranslationsOf), дефолт video-auto
// собирает ДВЕ строки без облака (голый код «ru» резолвится resolveEmbedIds).
//
// Проверки:
//  1. окно: плашка над видео (текст в DOM, opacity 1);
//  2. фулскрин контейнера в топ-документе (как плеер YouTube): плашка
//     :popover-open, геометрия = вьюпорт, текст жив;
//  3. выход: popover снят, плашка вернулась к прямоугольнику видео;
//  4. embed-поток: агент фрейма анонсировал дорожки (>=2), дефолт включил
//     ДВЕ строки (en + ru) — реплики обеих в плашке одновременно;
//  5. фулскрин ИЗ фрейма (как плеер uakinogo): fullscreenElement топа =
//     IFRAME, плашка :popover-open, геометрия = вьюпорт (iframe растянут
//     UA-стилями фулскрина), текст жив;
//  6. выход из фулскрина фрейма: popover снят, плашка вернулась к окну iframe.
//
// Запуск:  node e2e/subs/fullscreen-subtitles.mjs
// Результат — e2e/subs/fullscreen-subtitles-last-run.json (gitignore);
// скриншоты — %TEMP%/duopulse-232-*.png.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const PORT = 8897;
const CDP_PORT = 9241;
const OUT = path.join(ROOT, "e2e", "subs", "fullscreen-subtitles-last-run.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 30000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))));
const EXE_WIN = EXE.split(String.fromCharCode(92)).join(String.fromCharCode(92, 92));
async function killOurExes() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await run("powershell", ["-NoProfile", "-Command",
        `Get-CimInstance Win32_Process -Filter "Name='duopulse.exe'" | Where-Object { $_.ExecutablePath -eq '${EXE_WIN}' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F`,
      ]);
    } catch { /* уже мертвы — проверим фактом */ }
    let alive;
    try {
      alive = Number(String(await run("powershell", ["-NoProfile", "-Command",
        `@(Get-CimInstance Win32_Process -Filter "Name='duopulse.exe'" | Where-Object { $_.ExecutablePath -eq '${EXE_WIN}' }).Count`,
      ])).trim()) || 0;
    } catch { return; }
    if (alive === 0) return;
    await sleep(1500);
  }
  throw new Error("killOurExes: процессы не умерли за 3 попытки");
}

// --- локальные страницы -------------------------------------------------------

const TOP_HTML = `<!doctype html><meta charset="utf-8"><title>fs-top</title>
<style>body{background:#202030;margin:0;padding:8px;font:14px sans-serif;color:#fff}
#stage{width:640px;height:360px;background:#000}
#stage video{width:100%;height:100%;background:#123}
button{font-size:16px;padding:6px 10px;margin:6px 2px}
iframe{display:block;border:0}</style>
<div id="stage"><video id="v"></video></div>
<button id="btnStage">fs stage</button>
<script>
window.__t = 5;
const v = document.getElementById('v');
Object.defineProperty(v, 'currentTime', { get(){ return window.__t; } });
window.tick = (dt) => { window.__t += dt; v.dispatchEvent(new Event('timeupdate')); };
window.setTrack = () => {
  window.__DUOPULSE_TEST_TRACK__ = [{ id:'test:ru', source:'test', lang:'ru', role:'original', name:'тест',
    cues:[{startMs:0,endMs:6000000,text:'ПЛАШКА ЖИВА t='+Math.floor(window.__t)}] }];
  document.dispatchEvent(new Event('duopulse-test-track'));
  window.tick(0.5);
};
document.getElementById('btnStage').onclick = () => document.getElementById('stage').requestFullscreen().catch(e => { window.__fsErr = String(e); });
</script>`;

// Страница фазы embed: та же топ-страница + плеер-фрейм (видео и конфиг
// makePlayer внутри — топология эмбеда кино-сайта).
const EMBED_HTML = TOP_HTML.replace("<title>fs-top</title>", "<title>fs-embed</title>").replace(
  "<script>\nwindow.__t = 5;",
  `<iframe id="fr" allow="fullscreen" allowfullscreen src="http://sub1.localhost:${PORT}/frame.html" width="640" height="300"></iframe>\n<script>\nwindow.__t = 5;`,
);

const FRAME_HTML = `<!doctype html><meta charset="utf-8"><title>fs-frame</title>
<div id="inner" style="width:100%;height:100%;background:#305030">
<video id="fv" style="width:100%;height:80%;background:#204020"></video><br>
<button id="btnFs" style="font-size:18px;padding:10px">fs from frame</button></div>
<script>
window.__t = 7;
const fv = document.getElementById('fv');
Object.defineProperty(fv, 'currentTime', { get(){ return window.__t; } });
setInterval(() => { window.__t += 0.5; fv.dispatchEvent(new Event('timeupdate')); }, 500);
fv.dispatchEvent(new Event('timeupdate'));
document.getElementById('btnFs').onclick = () => document.getElementById('inner').requestFullscreen().catch(e => { window.__fsErr = String(e); });
</script>
<script>
function makePlayer(opts) { window.__p = opts; }
makePlayer({ source: { cc: [
  { url: "http://sub1.localhost:${PORT}/en.vtt", name: "Eng. full - 1" },
  { url: "http://sub1.localhost:${PORT}/ru.vtt", name: "Рус. полные - 2" },
] } });
</script>`;

const VTT_EN = "WEBVTT\n\n00:00:00.000 --> 00:99:00.000\nENG LINE windows/fullscreen t=live\n";
const VTT_RU = "WEBVTT\n\n00:00:00.000 --> 00:99:00.000\nРУС СТРОКА окна/фулскрин t=живая\n";

// --- CDP ----------------------------------------------------------------------

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
    open.then(() => new Promise((res, rej) => {
      const i = ++id;
      const t = setTimeout(() => { pending.delete(i); rej(new Error(`CDP ${method}: таймаут ${timeoutMs} мс`)); }, timeoutMs);
      pending.set(i, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      ws.send(JSON.stringify({ id: i, method, params }));
    }));
  return { send, close: () => ws.close() };
}
const evalIn = async (ws, expression, timeoutMs = 20000) => {
  const r = await ws.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
  if (r.exceptionDetails) return { __ex: JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails).slice(0, 300) };
  return r.result?.value;
};
async function getJson() {
  let lastErr = null;
  for (let i = 0; i < 10; i++) {
    try { return (await fetch(`http://localhost:${CDP_PORT}/json`)).json(); } catch (e) { lastErr = e; await sleep(1000); }
  }
  throw lastErr;
}
const clickAt = async (ws, x, y) => {
  for (const type of ["mousePressed", "mouseReleased"]) await ws.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
};

// --- прогон -------------------------------------------------------------------

const plaqueInfo = `(() => {
  const c = document.querySelector('[data-duopulse-subtitles]');
  if (!c) return { plaque: false };
  const r = c.getBoundingClientRect();
  return { plaque: true, op: c.style.opacity, rect: [r.x, r.y, r.width, r.height].map(Math.round),
    popover: c.getAttribute('popover'), open: c.matches(':popover-open'),
    fsEl: document.fullscreenElement ? document.fullscreenElement.tagName : null,
    text: (c.textContent || '').trim().slice(0, 80) };
})()`;

async function waitTarget(match, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const t = await getJson();
    const hit = t.find((x) => x.type === "page" && match(x.url));
    if (hit) return hit;
    await sleep(1000);
  }
  return null;
}

async function main() {
  await killOurExes();
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    const routes = {
      "/top.html": ["text/html; charset=utf-8", TOP_HTML],
      "/embed.html": ["text/html; charset=utf-8", EMBED_HTML],
      "/frame.html": ["text/html; charset=utf-8", FRAME_HTML],
      "/en.vtt": ["text/vtt; charset=utf-8", VTT_EN],
      "/ru.vtt": ["text/vtt; charset=utf-8", VTT_RU],
    };
    const hit = routes[p];
    if (hit) { res.writeHead(200, { "content-type": hit[0] }); res.end(hit[1]); }
    else { res.writeHead(404); res.end("no"); }
  }).listen(PORT, "127.0.0.1");
  await sleep(500);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-232-"));
  const app = spawn(EXE, [], {
    stdio: ["ignore", fs.openSync(path.join(tmp, "app-stdio.log"), "a"), "ignore"],
    env: {
      ...process.env,
      APPDATA: tmp,
      DUOPULSE_START_URL: `http://localhost:${PORT}/top.html`,
      DUOPULSE_E2E_NO_SINGLE_INSTANCE: "1",
      WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
  });

  const checks = [];
  const check = (name, ok, extra = "") => {
    checks.push({ name, ok, extra });
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  };
  try {
    const top = await waitTarget((u) => u.includes("top.html"), 60);
    if (!top) throw new Error("вкладка стенда не поднялась");
    const page = connect(top.webSocketDebuggerUrl);
    await page.send("Runtime.enable").catch(() => {});
    await page.send("Page.enable").catch(() => {});
    await sleep(4000); // iframe + агент + анонс дорожек

    // 1. окно: плашка над видео
    await evalIn(page, `window.setTrack()`);
    await sleep(600);
    const win1 = await evalIn(page, plaqueInfo);
    check("окно: плашка над видео (текст жив)", win1?.plaque === true && win1.op === "1" && /ПЛАШКА/.test(win1.text || ""),
      JSON.stringify(win1));

    // 2. фулскрин контейнера в топ-документе (плеер YouTube-стиля)
    const btn = await evalIn(page, `(() => { const r = document.getElementById('btnStage').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    await clickAt(page, btn[0], btn[1]);
    await sleep(1200);
    const fsA = await evalIn(page, plaqueInfo);
    const viewportA = await evalIn(page, `[window.innerWidth, window.innerHeight]`);
    check("фулскрин контейнера: плашка в top layer (:popover-open)", fsA?.open === true, JSON.stringify(fsA));
    check("фулскрин контейнера: геометрия = вьюпорт", !!fsA && fsA.rect[0] === 0 && fsA.rect[1] === 0 && fsA.rect[2] === viewportA[0] && fsA.rect[3] === viewportA[1],
      `rect=${JSON.stringify(fsA?.rect)} vp=${JSON.stringify(viewportA)}`);
    check("фулскрин контейнера: текст жив", /ПЛАШКА/.test(fsA?.text || ""), JSON.stringify(fsA?.text));
    const shotA = await page.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(os.tmpdir(), "duopulse-232-fs-container.png"), Buffer.from(shotA.data, "base64"));

    // 3. выход: popover снят, плашка у видео
    await evalIn(page, `document.exitFullscreen().catch(() => {})`);
    await sleep(1000);
    await evalIn(page, `window.tick(0.5)`);
    const out1 = await evalIn(page, plaqueInfo);
    check("выход: popover снят, плашка у видео", out1?.popover === null && out1?.rect?.[0] === 8, JSON.stringify(out1));

    // --- фаза 2: embed-топология кино-сайта (свежий документ — свежий бандл)
    await evalIn(page, `location.assign('http://localhost:${PORT}/embed.html')`);
    const embT = await waitTarget((u) => u.includes("embed.html"), 30);
    if (!embT) throw new Error("страница фазы embed не поднялась");
    const embPage = connect(embT.webSocketDebuggerUrl);
    await embPage.send("Runtime.enable").catch(() => {});
    await embPage.send("Page.enable").catch(() => {});
    await sleep(6000); // iframe + агент + анонс дорожек + автодуо-загрузка

    // 4. embed-поток: дуо из дорожек плеера (duopulse-232, вторая половина)
    const emb = await evalIn(embPage, `(() => { const s = window.__duopulseContent.state();
      return { frames: s.embed.frames, tracks: s.embed.tracks.map(t => t.lang + ':' + t.name),
        engine: s.engine.trackCount, rows: s.engine.activeRows.map(r => r.text) }; })()`);
    check("embed: агент анонсировал дорожки плеера (en + ru)", emb?.frames === 1 && (emb.tracks || []).length >= 2, JSON.stringify(emb));
    check("embed: дефолт включил ДВЕ строки (дуо en+ru, без облака)", emb?.engine === 2 && (emb.rows || []).length === 2 &&
      emb.rows.some((t) => /ENG LINE/.test(t)) && emb.rows.some((t) => /РУС СТРОКА/.test(t)), JSON.stringify(emb?.rows));
    const embInfo = await evalIn(embPage, plaqueInfo);
    check("embed: окно — плашка над iframe плеера (две строки видны)",
      /ENG LINE/.test(embInfo?.text || "") && /РУС СТРОКА/.test(embInfo?.text || ""), JSON.stringify(embInfo?.text));
    // Правило дуо (duopulse-206): перевод сверху, оригинал снизу — первая
    // строка плашки русская, английская под ней (duopulse-232 роли embed).
    const firstRow = await evalIn(embPage, `document.querySelector('[data-duopulse-subtitles] .duopulse-subtitles-row')?.textContent ?? ''`);
    check("embed: перевод сверху (первая строка плашки — русская)", /РУС СТРОКА/.test(firstRow || ""), JSON.stringify(firstRow));

    // 5. фулскрин ИЗ фрейма (плеер uakinogo-стиля)
    let frameT = null;
    for (let i = 0; i < 20 && !frameT; i++) {
      const t = await getJson();
      frameT = t.find((x) => (x.type === "page" || x.type === "iframe") && x.url.includes("frame.html"));
      if (!frameT) await sleep(500);
    }
    if (!frameT) check("фулскрин фрейма: OOPIF-таргет", false, "нет");
    else {
      const frame = connect(frameT.webSocketDebuggerUrl);
      await frame.send("Runtime.enable").catch(() => {});
      const fb = await evalIn(frame, `(() => { const r = document.getElementById('btnFs').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
      await clickAt(frame, fb[0], fb[1]);
      await sleep(1500);
      const fsB = await evalIn(embPage, plaqueInfo);
      const viewportB = await evalIn(embPage, `[window.innerWidth, window.innerHeight]`);
      check("фулскрин фрейма: fullscreenElement топа = IFRAME", fsB?.fsEl === "IFRAME", JSON.stringify(fsB?.fsEl));
      check("фулскрин фрейма: плашка в top layer (:popover-open)", fsB?.open === true, JSON.stringify(fsB));
      check("фулскрин фрейма: геометрия = вьюпорт (якорь-iframe растянут)",
        !!fsB && fsB.rect[0] === 0 && fsB.rect[1] === 0 && fsB.rect[2] === viewportB[0] && fsB.rect[3] === viewportB[1],
        `rect=${JSON.stringify(fsB?.rect)} vp=${JSON.stringify(viewportB)}`);
      check("фулскрин фрейма: текст жив (обе строки дуо)", /ENG LINE/.test(fsB?.text || "") && /РУС СТРОКА/.test(fsB?.text || ""), JSON.stringify(fsB?.text));
      const shotB = await embPage.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(os.tmpdir(), "duopulse-232-fs-frame.png"), Buffer.from(shotB.data, "base64"));

      // 6. выход из фулскрина фрейма
      await evalIn(embPage, `document.exitFullscreen().catch(() => {})`);
      await sleep(1000);
      const out2 = await evalIn(embPage, plaqueInfo);
      check("выход из фрейма: popover снят, плашка у окна iframe", out2?.popover === null && !!out2 && out2.rect[2] === 640, JSON.stringify(out2));
      frame.close();
    }
    embPage.close();
    page.close();
  } finally {
    await killOurExes();
    server.close();
    app.kill();
  }

  const passed = checks.filter((c) => c.ok).length;
  fs.writeFileSync(OUT, JSON.stringify({ card: "duopulse-232", when: new Date().toISOString(), passed, total: checks.length, checks }, null, 2));
  console.log(`итог: ${passed}/${checks.length}`);
  process.exitCode = passed === checks.length ? 0 : 1;
}

main().catch((e) => {
  console.error("стенд упал:", e);
  process.exitCode = 1;
});
