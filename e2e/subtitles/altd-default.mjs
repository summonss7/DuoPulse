// Живой стенд карточки duopulse-066: Alt+D на «свежем профиле» (первое видео,
// пустой набор) должен с ПЕРВОГО нажатия собрать дуо-дефолт «оригинал + ru»
// (docs/03 §8 п.2, сценарий docs/01 §5.1), а не снимать флаг показа.
// До фикса: видео детектируется с enabled=true и пустым набором («вкл — 0
// дорожек via video»), первый Alt+D выключал показ («выкл via alt-d»).
// После фикса: пустой набор нового видео честно «выкл», Alt+D собирает
// дефолт через tracks_ready-список адаптера, повторный Alt+D гасит показ,
// набор помнится (последний набор), третий — восстанавливает.
//
// Проверки (критерии готовности карточки):
//   A) свежее видео: enabled=false (честно), набор движка 0;
//   B) Alt+D №1: включён дуо-набор (en-оригинал + ru-перевод), оверлей
//      рисуется после seek на реплику, событие set_applied via=alt-d;
//   C) чип «Дуо en+ru» в панели подсвечен сразу (data-on=true);
//   D) Alt+D №2: показ выключен, состав помнится обеими сторонами;
//   E) Alt+D №3: восстановление того же набора без перезагрузки.
//
// Запуск:  node e2e/subtitles/altd-default.mjs [путь-к-duopulse.exe] [videoId]
// Требует собранный debug-exe (cargo build); vite dev поднимает сам (вместе
// с ним пересобирается content-бандл с фиксами). Видео по умолчанию —
// Counting Stars (hT_nvWreIhg): единственная ручная en-дорожка + ru среди
// переводов → дефолт Alt+D = «Дуо en+ru» (docs/01 §5.1). Блокировщик —
// штатный (списки по умолчанию): преролл SSAI блокируется, loadBaseTrack
// не ждёт окончания рекламы (waitForContent до 45 с).
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const VIDEO = process.argv[3] || "hT_nvWreIhg";
const CDP_PORT = 9241;
const OUT_LOG = path.join(ROOT, "e2e", "subtitles", "altd-timeline.log");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))),
  );

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    } else if (m.method) {
      for (const l of listeners) l(m);
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
  return { send, on: (l) => listeners.push(l), close: () => ws.close() };
}

const evalIn = (ws, expr, timeoutMs = 30000) =>
  Promise.race([
    ws
      .send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })
      .then((r) => r?.result?.value),
    sleep(timeoutMs).then(() => {
      throw new Error("eval-таймаут: " + expr.slice(0, 80));
    }),
  ]);

  const reconnect = async () => {
    for (let i = 0; i < 10; i++) {
      try {
        const targets = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
        const t = targets.find((x) => x.type === "page" && x.url.includes("youtube.com"));
        if (!t) throw new Error("нет цели youtube");
        const ws = connect(t.webSocketDebuggerUrl);
        await evalIn(ws, `1 + 1`, 10000);
        tab = ws;
        return;
      } catch {
        await sleep(3000);
      }
    }
    throw new Error("CDP: переподключение не удалось");
  };

  const waitForPage = async (ws, expr, timeoutMs, what) => {
    const isMain = ws === tab; // главная цель — может быть подменена reconnect'ом
    const t0 = Date.now();
    for (;;) {
      try {
        const v = await evalIn(isMain ? tab : ws, expr);
        if (v) return v;
      } catch {
        if (isMain) {
          try {
            await reconnect();
          } catch {
            /* ещё раз на следующей итерации */
          }
        }
        if (Date.now() - t0 > timeoutMs) throw new Error(`не дождались: ${what}`);
      }
      if (Date.now() - t0 > timeoutMs) throw new Error(`не дождались: ${what}`);
      await sleep(200);
    }
  };

const stateOf = (ws) => evalIn(ws, `window.__duopulseContent?.state() ?? null`);
// Диспатч Alt+D с диагностикой доставки: наш keydown-обработчик зовёт
// preventDefault → dispatchEvent вернёт false (событие «поглощено») —
// true значит, обработчика на странице не было. Плюс состояние сразу
// после синхронного toggleSubs и накопленные ошибки страницы.
const altD = (ws) =>
  evalIn(
    ws,
    `(function () {
       const dispatched = document.dispatchEvent(
         new KeyboardEvent("keydown", { altKey: true, code: "KeyD", cancelable: true }));
       const s = window.__duopulseContent?.state();
       return { dispatched, enabled: s?.enabled, tr: s?.engine.trackCount,
         errs: (window.__duoErrs ?? []).slice(-3) };
     })()`,
  );

// Главная CDP-цель (вкладка YouTube): модульный let — waitForPage умеет
// подменять её при переподключении (страница перегружается/цель умирает).
let tab = null;

// ошибки/консоль контентной страницы (подписка после подключения CDP-цели)
const pageErrs = [];

let vite;
let app;
const appLog = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-altd-e2e-"));
let dumpTimeline = () => {};

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

try {
  await killOurExes();
  vite = spawn("npm", ["run", "dev"], { cwd: ROOT, shell: true, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try {
      await fetch("http://localhost:5173/");
      break;
    } catch {
      await sleep(500);
    }
  }
  app = spawn(EXE, [], {
    stdio: ["ignore", "ignore", "pipe"], // stderr — метки [subtitles] Core
    env: {
      ...process.env,
      APPDATA: tmp,
      DUOPULSE_START_URL: `https://www.youtube.com/watch?v=${VIDEO}`,
      DUOPULSE_ADBLOCK_LISTS: "", // изолируем от списков: без прероллов SSAI
      DUOPULSE_SLEEP_AFTER_SECS: "0",
      WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT} --autoplay-policy=no-user-gesture-required`,
    },
  });
  app.stderr?.on("data", (d) => appLog.push(String(d)));

  // --- CDP: контентная вкладка YouTube + UI-хром ---------------------------
  // Ранние цели бывают недолговечны (навигация/редирект при старте) — ws
  // может не открыться; переподключаемся к свежей цели.
  for (let attempt = 0; attempt < 5 && !tab; attempt++) {
    let target;
    for (let i = 0; i < 90; i++) {
      try {
        const targets = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
        target = targets.find((t) => t.type === "page" && t.url.includes("youtube.com"));
        if (target) break;
      } catch {
        /* поднимается */
      }
      await sleep(1000);
    }
    if (!target) throw new Error("CDP-цель вкладки YouTube не найдена");
    const t = connect(target.webSocketDebuggerUrl);
    try {
      await t.send("Page.enable").catch(() => {});
      await evalIn(t, `1 + 1`, 10000);
      tab = t;
    } catch {
      t.close();
      await sleep(3000);
    }
  }
  if (!tab) throw new Error("CDP: цель YouTube не подсоединилась");
  await tab.send("Network.enable");
  // ошибки/исключения страницы (Runtime-события): падения бандла видны в дамп
  await tab.send("Runtime.enable");
  tab.on((m) => {
    if (m.method === "Runtime.exceptionThrown")
      pageErrs.push("exception: " + (m.params.exceptionDetails?.text ?? "") + " " + (m.params.exceptionDetails?.exception?.description ?? "").split("\n")[0]);
    else if (m.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(m.params.type))
      pageErrs.push(m.params.type + ": " + m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200));
  });
  for (const [n, v] of [
    ["CONSENT", "YES+cb.20210328-17-p0.en+FX+888"],
    ["SOCS", "CAI"],
  ]) {
    await tab.send("Network.setCookie", { name: n, value: v, domain: ".youtube.com", path: "/" });
  }
  await tab.send("Page.navigate", { url: `https://www.youtube.com/watch?v=${VIDEO}` });

  await waitForPage(tab, `!!window.__duopulseContent?.state()?.videoKey`, 90000, "детект видео");
  await waitForPage(tab, `window.__duopulseContent?.state().canTracks === true`, 60000, "tracks_ready (список адаптера)");

  // (A) свежий профиль: показ честно выключен, набор пуст. Атомарно с проверкой
  // готовности: анонимная сессия YouTube перезагружает страницу (~4 с,
  // themeRefresh — карточка 056) — новый бандл до первого детекта держит
  // enabled=true; читаем состояние одним eval, чтобы не склеить два бандла.
  // До фикса здесь было enabled=true («вкл — 0 дорожек via video»).
  const fresh = await waitForPage(
    tab,
    `(function () {
       const s = window.__duopulseContent?.state();
       return s && s.canTracks && s.videoKey && s.videoKey.startsWith("yt:")
         ? { en: s.enabled, tr: s.engine.trackCount } : null;
     })()`,
    30000,
    "свежее видео с готовым списком дорожек",
  );
  check(
    "(A) свежее видео: enabled=false (флаг не поднимается на пустом наборе), движок 0",
    fresh.en === false && fresh.tr === 0,
    `enabled=${fresh.en}, tracks=${fresh.tr}`,
  );

  // хронология (диагностика гонок детектора): опрос состояния страницы
  const timeline = [];
  const timelineTimer = setInterval(() => {
    evalIn(
      tab,
      `(function () {
         const s = window.__duopulseContent?.state();
         const p = document.getElementById("movie_player");
         const v = document.querySelector("video");
         return s && { k: s.videoKey, en: s.enabled, can: s.canTracks, tr: s.engine.trackCount,
           ad: !!p?.classList?.contains("ad-showing"), st: p?.getPlayerState?.() ?? null,
           paused: !!v?.paused, t: v ? Math.round(v.currentTime) : null };
       })()`,
      10000,
    )
      .then((s) =>
        timeline.push(
          `${Math.round(performance.now())}ms key=${s?.k} en=${s?.en} can=${s?.can} tr=${s?.tr} ad=${s?.ad} st=${s?.st} paused=${s?.paused} t=${s?.t}`,
        ),
      )
      .catch((e) => timeline.push(`опрос не удался: ${e.message}`));
  }, 300);
  const dump = () => {
    clearInterval(timelineTimer);
    try {
      fs.writeFileSync(path.join(OUT_LOG), timeline.join("\n") + "\n");
      fs.appendFileSync(path.join(OUT_LOG), "--- полный [subtitles] журнал ---\n" + appLog.join("").split("\n").filter((l) => l.includes("[subtitles]")).join("\n"));
    } catch {}
    console.error("хронология: " + timeline.length + " строк → " + OUT_LOG);
  };
  dumpTimeline = dump;
  // стабилизация: детектор переэмитит видео с уточнённым ключом (длительность
  // по loadedmetadata) — тот переход сбрасывает trackList до свежего; ждём,
  // пока список дорожек снова готов и стабилен, и только тогда жмём Alt+D
  for (let i = 0; i < 30; i++) {
    const s = await stateOf(tab);
    if (s?.canTracks && s.videoKey?.startsWith("yt:")) {
      await sleep(700);
      const s2 = await stateOf(tab);
      if (s2?.canTracks && s2.videoKey === s.videoKey) break;
    }
    await sleep(500);
  }

  // сценарий продукта (docs/01 §5.1): пользователь СМОТРИТ видео и жмёт
  // Alt+D. На паузе YouTube-плеер не отдаёт timedtext по setOption — грузить
  // дорожки можно только при играющем плеере (loadBaseTrack ждёт state=1),
  // поэтому запускаем воспроизведение перед нажатием.
  await evalIn(
    tab,
    `(async () => {
       const v = document.querySelector("video");
       if (v && v.paused) { try { await v.play(); } catch (e) {} }
       return !!(v && !v.paused);
     })()`,
  );
  await waitForPage(tab, `(document.querySelector("video")?.paused ?? true) === false`, 20000, "видео играет");
  // преролл: списки блокировщика отключены (изолируем добычу player-api),
  // поэтому SSAI-преролл приходит и может идти цепочкой 1-2 мин. Дорожки
  // грузятся только на контенте (timedtext недоступен в рекламе), так что
  // ДО Alt+D дожидаемся окончания рекламы: скип при появлении кнопки, до
  // 240 с (по опыту duopulse-066: 30 с мало, преролл длиннее загрузки).
  const adT0 = Date.now();
  for (;;) {
    const ad = await evalIn(tab, `document.getElementById("movie_player")?.classList?.contains("ad-showing") === true`);
    if (!ad) break;
    if (Date.now() - adT0 > 240000) throw new Error("преролл не закончился за 240 с — Alt+D жать бессмысленно");
    await evalIn(tab, `document.querySelector(".ytp-ad-skip-button, .ytp-skip-ad-button")?.click() ?? null`);
    await sleep(3000);
  }

  // (B) Alt+D №1: дуо-дефолт «оригинал + предпочитаемый перевод» с первого
  // нажатия (загрузка дорожек — timedtext-запросы с ретраями — ждём щедро).
  const press1 = await altD(tab);
  console.log(`Alt+D №1: dispatched=${press1?.dispatched} (false = поглощено нашим обработчиком), enabled=${press1?.enabled}, tr=${press1?.tr}`);
  if (pageErrs.length) console.log("ошибки страницы: " + JSON.stringify(pageErrs.slice(-5), null, 0));
  let onState;
  try {
    onState = await waitForPage(
      tab,
      `window.__duopulseContent?.state().enabled === true && window.__duopulseContent?.state().engine.trackCount === 2`,
      150000,
      "Alt+D №1: дуо-набор из 2 дорожек",
    );
  } catch (e) {
    dumpTimeline();
    const s = await stateOf(tab);
    const ti = await evalIn(tab, `window.__duopulseContent?.tracksInfo()`);
    const log = appLog.join("").split("\n").filter((l) => /\[subtitles\]|timedtext/i.test(l)).slice(-15);
    const targetsNow = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
    console.error("таргеты: " + targetsNow.filter((t) => t.type === "page").map((t) => t.url).join(" | "));
    console.error("ДИАГНОСТИКА B: state=" + JSON.stringify({ ...s, engine: s?.engine?.trackCount }));
    console.error("tracksInfo: " + JSON.stringify(ti && { path: ti.path, base: ti.base.map((b) => b.id + (b.original ? "*" : "")), translations: ti.translationsCount }));
    for (const l of log) console.error("  log: " + l.trimEnd());
    throw e;
  }
  check(
    "(B1) Alt+D №1 включил дуо-набор (2 дорожки) с первого нажатия",
    onState === true,
    `engine=${(await stateOf(tab)).engine.trackCount}`,
  );
  clearInterval(timelineTimer);

  // оверлей рисуется: seek на реплику (TED — плотные en-субтитры), плашка видна
  let overlayOk = false;
  for (const t of [30, 90, 150]) {
    await evalIn(tab, `(async () => { const v = document.querySelector("video"); v.currentTime = ${t}; await new Promise(r => setTimeout(r, 1200)); return true; })()`);
    if ((await stateOf(tab)).overlayVisible) {
      overlayOk = true;
      break;
    }
  }
  check("(B2) оверлей рисуется после seek на реплику (без ручного выбора в панели)", overlayOk);

  // UI-хром (vite dev): сервис состояния + события + чип пресета
  let uiTarget;
  for (let i = 0; i < 30; i++) {
    const targets = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
    uiTarget = targets.find((t) => t.type === "page" && /localhost:5173/.test(t.url));
    if (uiTarget) break;
    await sleep(500);
  }
  if (!uiTarget) throw new Error("UI-цель CDP не найдена (нужен vite dev)");
  const ui = connect(uiTarget.webSocketDebuggerUrl);
  await waitForPage(ui, `typeof window.__duopulse === "object"`, 10000, "bridge-хук window.__duopulse");

  const snap1 = await evalIn(ui, `window.__duopulse.subtitles.listTracks()`);
  const ev1 = await evalIn(
    ui,
    `(function () {
       const evs = (window.__duopulseSubtitlesEvents ?? []).filter((e) => e.kind === "set_applied");
       const last = evs[evs.length - 1];
       return last ? { via: last.payload.via, enabled: last.payload.enabled, tracks: last.payload.tracks.map((t) => t.id) } : null;
     })()`,
  );
  const langs = (snap1?.tracks ?? []).map((t) => `${t.id}(${t.lang})`);
  check(
    "(B3) состав дефолта: en-оригинал + ru-перевод, событие via=alt-d, enabled=true",
    ev1?.via === "alt-d" && ev1?.enabled === true && (snap1?.tracks ?? []).length === 2 &&
      snap1.tracks.some((t) => t.lang === "en") && snap1.tracks.some((t) => t.lang === "ru"),
    `набор: ${langs.join(" + ")}, via=${ev1?.via}`,
  );

  // (C) чип «Дуо en+ru» подсвечен сразу после включения. Панель открывается
  // тест-событием (карточка 087: клик кнопки — нативное меню, Alt+D панель
  // больше не открывает).
  await evalIn(ui, `window.dispatchEvent(new CustomEvent("duo:open-panel"))`);
  await waitForPage(ui, `document.getElementById("duoPanel").hidden === false`, 5000, "панель открыта");
  const chip = await evalIn(
    ui,
    `(function () {
       const on = document.querySelector('.duo-chip[data-ids][data-on="true"]');
       return on ? { label: on.textContent, ids: on.dataset.ids } : null;
     })()`,
  );
  check(
    "(C) чип дуо-пресета подсвечен в панели сразу (data-on=true, ids содержат ru)",
    !!chip && /Дуо/.test(chip.label) && chip.ids.includes("ru"),
    chip ? `${chip.label} [${chip.ids.split("￿").join(" + ")}]` : "чип не найден",
  );
  await evalIn(ui, `document.getElementById("duoPanel").hidden || document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);

  // (D) Alt+D №2: показ выключен, состав помнится обеими сторонами
  await altD(tab);
  await waitForPage(tab, `window.__duopulseContent?.state().enabled === false && window.__duopulseContent?.state().engine.trackCount === 0`, 10000, "Alt+D №2: выкл");
  const snap2 = await evalIn(ui, `window.__duopulse.subtitles.listTracks()`);
  check(
    "(D) Alt+D №2 выключил показ; последний набор помнится (снапшот несёт 2 дорожки)",
    (await stateOf(tab)).enabled === false && snap2?.enabled === false && (snap2?.tracks ?? []).length === 2,
    `enabled=${snap2?.enabled}, tracks=${(snap2?.tracks ?? []).length}`,
  );

  // (E) Alt+D №3: восстановление того же набора без перезагрузки
  await altD(tab);
  const restored = await waitForPage(
    tab,
    `window.__duopulseContent?.state().enabled === true && window.__duopulseContent?.state().engine.trackCount === 2`,
    15000,
    "Alt+D №3: восстановление",
  );
  check("(E) Alt+D №3 восстановил тот же набор (без ручного выбора)", restored === true);

  const evidence = appLog.join("").split("\n").filter((l) => l.includes("[subtitles]")).slice(-8);
  console.log("\n--- [subtitles] из журнала приложения (последние) ---");
  for (const l of evidence) console.log(l.trimEnd());
} catch (e) {
  dumpTimeline();
  throw e;
} finally {
  try {
    app?.kill();
  } catch {}
  try {
    vite?.kill();
  } catch {}
  await killOurExes();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES: " + failed}/${results.length}`);
process.exit(failed === 0 ? 0 : 1);
