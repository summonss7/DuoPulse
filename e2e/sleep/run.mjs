// E2E-прогон задачи 2.3 «Спящие вкладки + исключения (звук/видео)» (карточка
// duopulse-019). На реальном приложении с коротким таймаутом усыпления
// (DUOPULSE_SLEEP_AFTER_SECS=6, скан — раз в секунду):
//   1) фоновая «шумовая» вкладка (Web Worker с вычислительной петлёй +
//      интервал-счётчик) засыпает по таймауту простоя: tabs.list.sleeping=true,
//      активная вкладка не спит;
//   2) счётчики страницы (воркер/интервал) замерзают во сне —TrySuspend
//      останавливает JS/таймеры/воркеры; после пробуждения растут снова;
//   3) пробуждение (активацией и tabs.wake) без потери состояния страницы:
//      маркер/поле ввода/счётчики не сбрасываются — вкладка не перезагружалась;
//   4) исключение «играет звук/видео»: вкладка с <audio autoplay loop>
//      НЕ усыпляется, аудио продолжает играть;
//   5) tabs.sleep вручную: активную — ошибка, играющую — ошибка, фоновую — сон;
//   6) контекстное меню «Усыпить вкладку» — UI-путь;
//   7) скриншот таб-бара со спящей вкладкой (луна + приглушение, гайд 06).
//
// Состояние страниц читается через document.title → tabs.list (заголовок —
// часть контракта): CDP-сессия подключается ТОЛЬКО к UI-webview. Подключённый
// отладчик не даёт Chromium замораживать страницу — CDP к контентной вкладке
// отменил бы TrySuspend (проверено: воркер продолжал считать при открытом
// DevTools-соединении).
// Автоплей звука без жеста — флагом --autoplay-policy=no-user-gesture-required.
//
// Запуск:  node e2e/sleep/run.mjs [путь-к-duopulse.exe]
// Требует собранный debug-exe (cargo build) и запускает vite dev сам.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const CDP_PORT = 9232;
const HTTP_PORT = 8896;
const OUT_DIR = path.join(ROOT, "e2e", "sleep");
const SLEEP_AFTER_S = 6; // DUOPULSE_SLEEP_AFTER_SECS

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
  } catch {
    /* уже мертвы — ок */
  }
};

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

// --- 1. локальный http-стенд ---------------------------------------------------
// Тихий тон 440 Гц (8 кГц, 8-бит моно, ~25% амплитуды): реальный играющий
// звук — чтобы исключение спящего режима было честным, а не формальным.
const toneWav = (() => {
  const rate = 8000;
  const n = rate; // 1 c, loop
  const data = Buffer.alloc(44 + n);
  data.write("RIFF", 0);
  data.writeUInt32LE(36 + n, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); // PCM
  data.writeUInt16LE(1, 22); // моно
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate, 28);
  data.writeUInt16LE(1, 32);
  data.writeUInt16LE(8, 34);
  data.write("data", 36);
  data.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) {
    data[44 + i] = Math.round(128 + 32 * Math.sin((2 * Math.PI * 440 * i) / rate));
  }
  return data;
})();

// «Шумовая» страница: воркер с вычислительной петлёй (таймеры скрытых страниц
// Chromium троттлит, воркер — нет: честная нагрузка фона) + интервал-счётчик.
// Состояние (счётчики, маркер, целостность поля ввода) публикуется в
// document.title — e2e читает его из tabs.list, не трогая страницу отладчиком.
const busyPage = `<html><head><title>busy</title></head><body>
<h1>busy</h1><input id="keep" value="">
<script>
  (function () {
    var marker = "keep-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    var keep = document.getElementById("keep");
    keep.value = marker;
    var dp = { interval: 0, worker: 0 };
    setInterval(function () { dp.interval++; }, 100);
    var w = new Worker("/worker.js");
    w.onmessage = function (e) { dp.worker = e.data; };
    setInterval(function () {
      document.title = "busy " + JSON.stringify({
        w: dp.worker, i: dp.interval,
        id: marker, m: keep.value === marker ? 1 : 0
      });
    }, 250);
  })();
</script></body></html>`;
const workerJs = `var n = 0;
(function loop() {
  var t = performance.now();
  while (performance.now() - t < 10) n++;
  n++;
  postMessage(n);
  setTimeout(loop, 2);
})();`;
const musicPage = `<html><head><title>music</title></head><body>
<h1>music</h1>
<audio id="a" src="/tone.wav" autoplay loop></audio>
<script>
  (function () {
    var a = document.getElementById("a");
    var pub = function () {
      document.title = "music " + JSON.stringify({ p: a.paused ? 0 : 1 });
    };
    a.addEventListener("play", pub); a.addEventListener("pause", pub);
    setInterval(pub, 250);
  })();
</script></body></html>`;
const plainPage = (n) => `<html><head><title>Страница ${n}</title></head><body><h1>/p${n}</h1></body></html>`;

const httpServer = http.createServer((req, res) => {
  if (req.url === "/worker.js") {
    res.writeHead(200, { "Content-Type": "application/javascript" });
    res.end(workerJs);
    return;
  }
  if (req.url === "/tone.wav") {
    res.writeHead(200, { "Content-Type": "audio/wav" });
    res.end(toneWav);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  if (req.url === "/busy") res.end(busyPage);
  else if (req.url === "/music") res.end(musicPage);
  else res.end(plainPage(req.url.match(/^\/p(\d+)/)?.[1] ?? 0));
});
await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));
const url = (p) => `http://127.0.0.1:${HTTP_PORT}/${p}`;

// --- 2. изолированный профиль + приложение ------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-sleep-e2e-"));
const vite = spawn("npm", ["run", "dev"], { cwd: ROOT, shell: true, stdio: "ignore" });
for (let i = 0; i < 60; i++) {
  try {
    await fetch("http://localhost:5173/");
    break;
  } catch {
    await sleep(500);
  }
}
const app = spawn(EXE, [], {
  stdio: ["ignore", "ignore", "pipe"], // stderr — диагностика TrySuspend в лог
  env: {
    ...process.env,
    APPDATA: tmp,
    DUOPULSE_START_URL: url("p0"),
    DUOPULSE_ADBLOCK_LISTS: "", // без списков: стенду не нужна сеть
    DUOPULSE_SLEEP_AFTER_SECS: String(SLEEP_AFTER_S),
    WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT} --autoplay-policy=no-user-gesture-required`,
  },
});
const appLog = [];
app.stderr?.on("data", (d) => appLog.push(String(d)));

// --- 3. ждём CDP (только UI-webview: отладчик на контенте отменяет сон) -------
let targets = [];
for (let i = 0; i < 60; i++) {
  try {
    targets = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
    if (targets.some((t) => t.type === "page" && /localhost:5173/.test(t.url))) break;
  } catch {
    /* поднимается */
  }
  await sleep(1000);
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
  const send = (method, params = {}) =>
    open.then(
      () =>
        new Promise((res, rej) => {
          const i = ++id;
          pending.set(i, { res, rej });
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

const tabsList = (uiWs) => evalIn(uiWs, `window.__duopulse.tabs.list()`);
const tabBy = async (uiWs, pred) => (await tabsList(uiWs)).tabs.find(pred);
/** Полюс терпения: ждём условие по tabs.list (опрос 500 мс). */
const waitFor = async (uiWs, pred, timeoutMs, what) => {
  const t0 = Date.now();
  for (;;) {
    const tab = await tabBy(uiWs, pred);
    if (tab) return tab;
    if (Date.now() - t0 > timeoutMs) throw new Error(`не дождались: ${what}`);
    await sleep(500);
  }
};
/** invoke с разворотом отказа в {ok:false,error} — для проверок ошибок. */
const tryInvoke = (uiWs, js) =>
  evalIn(uiWs, `(async () => { try { return { ok: true, v: await ${js} }; } catch (e) { return { ok: false, error: String(e) }; } })()`);

/** Состояние «шумовой»/музыкальной страницы из document.title (без CDP). */
const stateOf = (tab) => {
  const m = /\{.*\}/.exec(tab?.title ?? "");
  return m ? JSON.parse(m[0]) : null;
};

let failures = 0;
try {
  const ui = targets.find((t) => t.type === "page" && /localhost:5173/.test(t.url));
  if (!ui) throw new Error("UI-цель CDP не найдена: " + targets.map((t) => t.url).join(", "));
  const uiWs = connect(ui.webSocketDebuggerUrl);

  for (let i = 0; i < 20; i++) {
    if ((await evalIn(uiWs, `typeof window.__duopulse`)) === "object") break;
    await sleep(500);
  }
  check("dev-хук window.__duopulse доступен в UI", (await evalIn(uiWs, `typeof window.__duopulse`)) === "object");

  const p0Id = (await waitFor(uiWs, (t) => t.url.endsWith("/p0"), 15000, "стартовая вкладка")).id;

  // (1) шумовая вкладка: открыть, дождаться публикации состояния, сделать фоновой
  await evalIn(uiWs, `window.__duopulse.tabs.open({ url: "${url("busy")}" })`);
  let busy;
  for (let i = 0; i < 30 && !busy; i++) {
    busy = await tabBy(uiWs, (t) => t.url.endsWith("/busy") && stateOf(t));
    if (!busy) await sleep(500);
  }
  if (!busy) throw new Error("состояние busy не публикуется в title");
  const busyId = busy.id;
  await evalIn(uiWs, `window.__duopulse.tabs.activate({ id: "${p0Id}" })`);

  // (2) бодрая фоновая вкладка работает: темп воркера на окне 3 с
  const w1 = stateOf(await tabBy(uiWs, (t) => t.id === busyId)).w;
  await sleep(3000);
  const w2 = stateOf(await tabBy(uiWs, (t) => t.id === busyId)).w;
  const awakeRate = (w2 - w1) / 3;
  check("бодрая фоновая вкладка работает (воркер считает)", awakeRate > 1000, `${(awakeRate / 1e6).toFixed(2)} млн итераций/с`);

  // (3) засыпание по таймауту простоя: sleeping=true, активная не спит
  const slept = await waitFor(uiWs, (t) => t.id === busyId && t.sleeping, 20000, "sleeping=true у busy");
  check("фоновая вкладка уснула по таймауту простоя (tabs.list.sleeping)", slept.sleeping === true);
  check("активная вкладка не спит", (await tabBy(uiWs, (t) => t.active)).sleeping === false);

  // (4) во сне счётчики замерзают: снимок → 3 с → снимок совпадает
  const settle = async () => {
    let a = stateOf(await tabBy(uiWs, (t) => t.id === busyId));
    for (let i = 0; i < 10; i++) {
      await sleep(700);
      const b = stateOf(await tabBy(uiWs, (t) => t.id === busyId));
      if (b.w === a.w && b.i === a.i) return b; // заголовок стабилен — замёрз
      a = b;
    }
    return a;
  };
  const frozen1 = await settle();
  const markerBefore = frozen1.id;
  await sleep(3000);
  const frozen2 = stateOf(await tabBy(uiWs, (t) => t.id === busyId));
  check(
    "во сне JS/таймеры/воркер заморожены (счётчики не растут 3 с)",
    frozen2.w === frozen1.w && frozen2.i === frozen1.i,
    `worker ${frozen1.w}→${frozen2.w}, interval ${frozen1.i}→${frozen2.i}`,
  );

  // (5) пробуждение tabs.wake: счётчики растут снова
  await evalIn(uiWs, `window.__duopulse.tabs.wake({ id: "${busyId}" })`);
  await waitFor(uiWs, (t) => t.id === busyId && !t.sleeping, 10000, "пробуждение tabs.wake");
  let woken;
  for (let i = 0; i < 20; i++) {
    woken = stateOf(await tabBy(uiWs, (t) => t.id === busyId));
    if (woken && woken.w > frozen2.w) break;
    await sleep(500);
  }
  check("после tabs.wake работа возобновляется (воркер растёт)", woken.w > frozen2.w, `worker ${frozen2.w}→${woken.w}`);

  // (6) состояние страницы пережило сон: маркер/поле ввода не сброшены
  check(
    "состояние страницы пережило сон (маркер и поле ввода целы — без перезагрузки)",
    woken.id === markerBefore && woken.m === 1,
    `id совпал=${woken.id === markerBefore}, поле цело=${woken.m === 1}`,
  );

  // (7) исключение «играет звук/видео»: вкладка с <audio> не усыпляется
  await evalIn(uiWs, `window.__duopulse.tabs.open({ url: "${url("music")}" })`);
  const music = await waitFor(uiWs, (t) => t.url.endsWith("/music"), 15000, "вкладка music в списке");
  const musicId = music.id;
  let musicState;
  // ждём именно ИГРАЮЩЕЕ аудио: первая публикация title может выйти до старта
  // автоплея (p:0 — буферизация tone.wav идёт через SOCKS5-роутер), проверка
  // (7) ниже подтверждает, что звук реально играет и вкладка не спит
  for (let i = 0; i < 30 && musicState?.p !== 1; i++) {
    musicState = stateOf(await tabBy(uiWs, (t) => t.id === musicId));
    if (musicState?.p !== 1) await sleep(500);
  }
  await evalIn(uiWs, `window.__duopulse.tabs.activate({ id: "${p0Id}" })`); // music → фон
  check("аудио во вкладке играет (autoplay, публикация в title)", musicState?.p === 1);
  await sleep(SLEEP_AFTER_S * 2 * 1000 + 4000); // вдвое дольше таймаута + запас на скан
  const musicNow = await tabBy(uiWs, (t) => t.id === musicId);
  const musicState2 = stateOf(musicNow);
  check(
    "вкладка с играющим звуком НЕ уснула (исключение), звук продолжает играть",
    musicNow.sleeping === false && musicState2?.p === 1,
    `sleeping=${musicNow.sleeping}, audio playing=${musicState2?.p}`,
  );

  // (8) tabs.sleep вручную: активную нельзя, играющую нельзя, фоновую можно
  const activeId = (await tabBy(uiWs, (t) => t.active)).id;
  const rActive = await tryInvoke(uiWs, `window.__duopulse.tabs.sleep({ id: "${activeId}" })`);
  check("tabs.sleep активной — отказ", rActive.ok === false, rActive.error);
  const rMusic = await tryInvoke(uiWs, `window.__duopulse.tabs.sleep({ id: "${musicId}" })`);
  check(
    "tabs.sleep играющей звук — отказ (исключение)",
    rMusic.ok === false && /звук|видео/.test(rMusic.error),
    rMusic.error,
  );
  const rBusy = await tryInvoke(uiWs, `window.__duopulse.tabs.sleep({ id: "${busyId}" })`);
  const busySlept = await waitFor(uiWs, (t) => t.id === busyId && t.sleeping, 10000, "ручной сон busy");
  const busyFrozen = await (async () => {
    await sleep(1500);
    const a = stateOf(await tabBy(uiWs, (t) => t.id === busyId));
    await sleep(1500);
    const b = stateOf(await tabBy(uiWs, (t) => t.id === busyId));
    return a.i === b.i;
  })();
  check(
    "tabs.sleep фоновой неиграющей — сон и фактическая заморозка",
    rBusy.ok === true && busySlept.sleeping === true && busyFrozen,
    `sleeping=${busySlept.sleeping}, заморожено=${busyFrozen}`,
  );
  await evalIn(uiWs, `window.__duopulse.tabs.wake({ id: "${busyId}" })`);
  await waitFor(uiWs, (t) => t.id === busyId && !t.sleeping, 10000, "второе пробуждение busy");

  // (9) пробуждение активацией (клик-эквивалент)
  await evalIn(uiWs, `window.__duopulse.tabs.sleep({ id: "${busyId}" })`);
  await waitFor(uiWs, (t) => t.id === busyId && t.sleeping, 10000, "сон busy для активации");
  await evalIn(uiWs, `window.__duopulse.tabs.activate({ id: "${busyId}" })`);
  const activated = await waitFor(uiWs, (t) => t.id === busyId && !t.sleeping, 10000, "пробуждение активацией");
  check("активация спящей вкладки пробуждает её", activated.active === true && activated.sleeping === false);

  // (10) контекстное меню «Усыпить вкладку» — UI-путь (p0 сейчас фоновая).
  // Карточка duopulse-086: меню нативное (popup muda), из CDP не кликается —
  // проверяем проводку действием «menu-action» (как шлёт Core из on_menu_event);
  // блокировку «Усыпить» для активной/спящей покрывает vitest (tab-menu.test.ts).
  await evalIn(
    uiWs,
    `window.__TAURI_INTERNALS__.invoke('plugin:event|emit', ${JSON.stringify({
      event: "menu-action",
      payload: { menu: "tab", act: "sleep", id: p0Id },
    })})`,
  );
  const p0Slept = await waitFor(uiWs, (t) => t.id === p0Id && t.sleeping, 10000, "сон p0 из меню");
  check(
    "контекстное меню: «Усыпить вкладку» усыпляет фоновую (menu-action)",
    p0Slept.sleeping === true,
  );

  // (11) скриншот таб-бара со спящей вкладкой (луна + приглушение, гайд 06)
  await sleep(300);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const shot = await uiWs.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT_DIR, "tabbar-sleeping.png"), Buffer.from(shot.data, "base64"));
  check("скриншот таб-бара со спящей вкладкой сохранён (e2e/sleep/tabbar-sleeping.png)", fs.existsSync(path.join(OUT_DIR, "tabbar-sleeping.png")));

  uiWs.close();
} catch (e) {
  failures++;
  console.error("E2E ERROR:", e.message);
} finally {
  app.kill("SIGKILL");
  await killOurExes();
  const tabsLog = appLog.join("").split("\n").filter((l) => /tabs:|suspend|Suspend|session:/.test(l));
  if (tabsLog.length) console.log("\n--- журнал приложения (tabs/sleep) ---\n" + tabsLog.slice(-15).join("\n"));
  // vite.kill() на Windows убивает только npm-оболочку — дерево npm→node
  // переживает скрипт и держит порт 5173 (strictPort) для следующих прогонов
  try {
    await run("taskkill", ["/PID", String(vite.pid), "/T", "/F"]);
  } catch {
    /* дерево уже мертво — ок */
  }
  httpServer.close();
  await sleep(1000);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

const failed = results.filter((r) => !r.ok).length + failures;
console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES: " + failed} (${results.length} проверок)`);
process.exit(failed === 0 ? 0 : 1);
