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
// TED iG9CE55wbtY: ручная en-дорожка (оригинал, translatable) + ru среди
// 156 переводов → дефолт Alt+D = «Дуо en+ru» (docs/01 §5.1); прежнее видео
// hT_nvWreIhg YouTube более не отдаёт translatable (duopulse-092). Списки блокировщика
// ОТКЛЮЧЕНЫ (DUOPULSE_ADBLOCK_LISTS="", изоляция добычи player-api — карточка
// duopulse-087): SSAI-преролл реально играет — гейт перед Alt+D ждёт конца
// рекламы (скип кнопки) и стабильного контента.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
// Видео по умолчанию — TED iG9CE55wbtY (duopulse-092): ручная en-дорожка в
// player-api-ответе original+translatable (дуо en+ru собирается), плотные
// субтитры для оверлея. Прежний hT_nvWreIhg (Counting Stars) более не годен:
// YouTube стал отдавать его en-дорожку isTranslatable=false в ответе плеера
// → дефолт честно один оригинал, «Дуо en+ru» платформой не собирается.
const VIDEO = process.argv[3] || "iG9CE55wbtY";
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

  // Восстановление вкладки (duopulse-092): неуспешная навигация (сеть/VPN
  // флейк, стабильно в окне themeRefresh-перезагрузки анонимной сессии P-08)
  // заменяет webview вкладки СТРАНИЦЕЙ ОШИБКИ (tabs::show_error_page — новый
  // webview с UI-бандлом на localhost:5173): цель youtube исчезает из /json,
  // старый ws висит зомби и не отвечает. Страница ошибки умеет «Повторить»
  // (bridge.nav.navigate на упавший адрес) — находим её по .err-url и жмём.
  const recoverTab = async () => {
    try {
      const targets = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
      for (const t of targets.filter((x) => x.type === "page" && /localhost:5173/.test(x.url))) {
        const c = connect(t.webSocketDebuggerUrl);
        try {
          const isErr = await evalIn(c, `!!document.querySelector(".err-url")`, 5000);
          if (isErr) {
            await evalIn(c, `document.querySelector(".err-actions button.primary")?.click() ?? false`, 5000);
            console.log("восстановление: «Повторить» нажат на странице ошибки загрузки");
            c.close();
            return true;
          }
        } catch {
          /* не страница ошибки или цель недоступна */
        }
        c.close();
      }
    } catch {
      /* /json недоступен — попробуем позже */
    }
    return false;
  };

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
        await sleep(1500);
        if (i > 0 && i % 3 === 0) await recoverTab(); // цель могла стать страницей ошибки
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
  // duopulse-092: в первые секунды анонимная сессия YouTube перезагружает
  // страницу (themeRefresh, P-08), и неуспешная навигация в этом окне
  // (сеть/VPN-флейк) ЗАМЕНЯЕТ вкладку страницей ошибки (webview закрыт,
  // новый грузит UI-бандл на localhost:5173) — цель youtube пропадает из
  // /json, зомби-ws не отвечает. Ранняя сессия минимальна (cookies +
  // навигация, без enable-доменов и опросов) и закрывается сразу; стабилиза-
  // ция и восстановление (кнопка «Повторить») идут опросом /json, полная
  // сессия подключается после стабилизации.
  const earlyLog = [];
  let early;
  for (let attempt = 0; attempt < 5 && !early; attempt++) {
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
      await evalIn(t, `1 + 1`, 10000); // цель жива и отвечает (без enable-доменов)
      early = t;
    } catch {
      t.close();
      await sleep(3000);
    }
  }
  if (!early) throw new Error("CDP: цель YouTube не подсоединилась");
  for (const [n, v] of [
    ["CONSENT", "YES+cb.20210328-17-p0.en+FX+888"],
    ["SOCS", "CAI"],
  ]) {
    await early.send("Network.setCookie", { name: n, value: v, domain: ".youtube.com", path: "/" }).catch(() => {});
  }
  await early.send("Page.navigate", { url: `https://www.youtube.com/watch?v=${VIDEO}` });
  early.close(); // отладчик отключен до первого кадра — перезагрузка P-08 пройдёт без него

  // Стабилизация БЕЗ отладчика: цель youtube с НЕИЗМЕННЫМ URL 5 опросов
  // подряд (перезагрузки themeRefresh меняют URL: ...watch?v=… → …&themeRefresh=1)
  // и не меньше 30 с — ретраи анонимной сессии отгремели, куки раскатаны.
  // Цель пропала (вкладка стала страницей ошибки) — жмём «Повторить».
  {
    const t0 = Date.now();
    let stableUrl = null;
    let hits = 0;
    let missing = 0;
    for (;;) {
      let url = null;
      try {
        const targets = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
        url = targets.find((t) => t.type === "page" && t.url.includes("youtube.com"))?.url ?? null;
      } catch {
        /* браузер поднимается */
      }
      if (url && url === stableUrl) hits++;
      else {
        if (url) earlyLog.push(`${Math.round(performance.now())}ms url: ${url.slice(0, 90)}`);
        stableUrl = url;
        hits = 0;
      }
      if (!url) {
        if (++missing >= 3) {
          if (await recoverTab()) earlyLog.push(`${Math.round(performance.now())}ms восстановление: «Повторить»`);
          missing = 0;
          stableUrl = null; // URL сменится — ждём стабильности заново
        }
      } else missing = 0;
      if (url && hits >= 5 && Date.now() - t0 >= 30000) break;
      if (Date.now() - t0 > 240000) throw new Error(`вкладка YouTube не стабилизировалась за 240 с (url=${stableUrl})`);
      await sleep(2000);
    }
  }

  // Поздняя полная сессия: ошибки/исключения страницы (Runtime-события) —
  // падения бандла видны в дамп.
  for (let attempt = 0; attempt < 5 && !tab; attempt++) {
    try {
      const targets = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
      const target = targets.find((t) => t.type === "page" && t.url.includes("youtube.com"));
      if (!target) throw new Error("нет цели youtube");
      const t = connect(target.webSocketDebuggerUrl);
      await evalIn(t, `1 + 1`, 10000);
      tab = t;
    } catch {
      await sleep(3000);
    }
  }
  if (!tab) throw new Error("CDP: цель YouTube не подсоединилась (поздняя сессия)");
  await tab.send("Runtime.enable");
  tab.on((m) => {
    if (m.method === "Runtime.exceptionThrown")
      pageErrs.push("exception: " + (m.params.exceptionDetails?.text ?? "") + " " + (m.params.exceptionDetails?.exception?.description ?? "").split("\n")[0]);
    else if (m.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(m.params.type))
      pageErrs.push(m.params.type + ": " + m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200));
  });

  // хронология (диагностика гонок детектора): опрос состояния страницы —
  // с позднего подключения (ранняя фаза — в earlyLog/appLog)
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
      fs.writeFileSync(path.join(OUT_LOG), ["--- ранняя фаза (без отладчика) ---", ...earlyLog, "--- хронология ---", ...timeline].join("\n") + "\n");
      fs.appendFileSync(path.join(OUT_LOG), "--- полный [subtitles] журнал ---\n" + appLog.join("").split("\n").filter((l) => l.includes("[subtitles]")).join("\n"));
    } catch {}
    console.error("хронология: " + timeline.length + " строк → " + OUT_LOG);
  };
  dumpTimeline = dump;

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

  // Сценарий продукта (docs/01 §5.1): пользователь СМОТРИТ видео и жмёт
  // Alt+D. Нажатие имеет смысл только в стабильном контент-состоянии
  // (stableContent): видео + список дорожек + играет + без рекламы 3 опроса
  // подряд; на паузе YouTube-плеер не отдаёт timedtext по setOption
  // (loadBaseTrack ждёт state=1) — запускаем воспроизведение; SSAI-преролл
  // (списки блокировщика отключены — изолируем добычу player-api) скипаем
  // кнопкой; перезагрузка themeRefresh (P-08) и замена вкладки страницей
  // ошибки сбрасывают счётчик — ждём заново, при пропаже цели жмём
  // «Повторить» (recoverTab, duopulse-092).
  const stableContent = async (timeoutMs, what = "стабильное контент-состояние") => {
    const gateT0 = Date.now();
    let gateHits = 0;
    let errStreak = 0;
    for (;;) {
      const s = await evalIn(
        tab,
        `(function () {
           const st = window.__duopulseContent?.state();
           const p = document.getElementById("movie_player");
           return st && { k: st.videoKey, can: st.canTracks,
             ad: !!p?.classList?.contains("ad-showing"), ps: p?.getPlayerState?.() ?? null };
         })()`,
      ).catch(() => null);
      if (s?.k?.startsWith("yt:") && s.can && !s.ad && s.ps === 1) {
        errStreak = 0;
        if (++gateHits >= 3) return;
      } else {
        gateHits = 0;
        if (!s) {
          // цель умерла/вкладка подменена — переподключение с восстановлением
          if (++errStreak >= 3) {
            try {
              await reconnect();
            } catch {
              /* ещё раз на следующей итерации */
            }
            errStreak = 0;
          }
        } else if (s.ps !== 1) {
          await evalIn(
            tab,
            `(async () => { const v = document.querySelector("video"); if (v && v.paused) { try { await v.play(); } catch (e) {} } return true; })()`,
          ).catch(() => null);
        } else if (s.ad) {
          await evalIn(tab, `document.querySelector(".ytp-ad-skip-button, .ytp-skip-ad-button")?.click() ?? null`).catch(() => null);
        }
      }
      if (Date.now() - gateT0 > timeoutMs)
        throw new Error(`${what} не достигнуто за ${Math.round(timeoutMs / 1000)} с (последнее: ${JSON.stringify(s)})`);
      await sleep(1000);
    }
  };

  // (B) Alt+D №1: дуо-дефолт «оригинал + предпочитаемый перевод» с первого
  // нажатия (загрузка дорожек — timedtext-запросы с ретраями — ждём щедро).
  // Нажатие обязано поднять флаг СИНХРОННО (enableSubs) — иначе оно потеряно
  // (гонка с перезагрузкой P-08/пере-детектом) и жмём повторно, как человек.
  // Вкладка может подмениться страницей ошибки и ПОСЛЕ нажатия — цикл
  // проходит гейт и нажимает заново, пока набор не соберётся (duopulse-092).
  const pressT0 = Date.now();
  let pressNo = 0;
  let onState = null;
  for (;;) {
    // Частичный набор (перевод ждёт ретрая при 429) НЕ перепосылаем: каждое
    // переключение плодит timedtext-запросы и усугубляет рейт-лимит — ждём
    // бэкофф-ретраи enableSubs; жмём заново только после сброса состояния
    // (вкладка подменена страницей ошибки, пере-детект) или потери флага.
    const pre = await stateOf(tab).catch(() => null);
    const partial = pre?.enabled === true && pre?.canTracks === true && (pre?.engine?.trackCount ?? 0) > 0;
    if (!partial) {
      await stableContent(Math.max(60000, 240000 - (Date.now() - pressT0)));
      pressNo++;
      let press1 = await altD(tab);
      console.log(`Alt+D №1 (нажатие ${pressNo}): dispatched=${press1?.dispatched} (false = поглощено нашим обработчиком), enabled=${press1?.enabled}, tr=${press1?.tr}`);
      for (let retry = 0; press1?.enabled !== true && retry < 2; retry++) {
        await sleep(2000);
        press1 = await altD(tab);
        console.log(`Alt+D №1 (перепосылка): enabled=${press1?.enabled}, tr=${press1?.tr}`);
      }
      if (press1?.enabled !== true)
        throw new Error(`Alt+D не поднял enabled за 3 нажатия — нажатие теряется (${JSON.stringify(press1)})`);
    } else {
      console.log(`Alt+D №1: включение живо, набор частичен (${pre.engine.trackCount}/2) — ждём ретраи загрузки`);
    }
    if (pageErrs.length) console.log("ошибки страницы: " + JSON.stringify(pageErrs.slice(-5), null, 0));
    onState = await waitForPage(
      tab,
      `window.__duopulseContent?.state().enabled === true && window.__duopulseContent?.state().engine.trackCount === 2`,
      60000,
      "Alt+D №1: дуо-набор из 2 дорожек",
    ).catch((e) => e);
    if (onState === true) break;
    if (Date.now() - pressT0 > 240000) {
      dumpTimeline();
      const s = await stateOf(tab).catch(() => null);
      const ti = await evalIn(tab, `window.__duopulseContent?.tracksInfo()`, 10000).catch(() => null);
      const log = appLog.join("").split("\n").filter((l) => /\[subtitles\]|timedtext/i.test(l)).slice(-15);
      let targetsNow = [];
      try {
        targetsNow = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
      } catch {}
      console.error("таргеты: " + targetsNow.filter((t) => t.type === "page").map((t) => t.url).join(" | "));
      console.error("ДИАГНОСТИКА B: state=" + JSON.stringify(s && { ...s, engine: s?.engine?.trackCount }));
      console.error("tracksInfo: " + JSON.stringify(ti && { path: ti.path, base: ti.base.map((b) => b.id + (b.original ? "*" : "")), translations: ti.translationsCount }));
      for (const l of log) console.error("  log: " + l.trimEnd());
      throw onState instanceof Error ? onState : new Error("Alt+D №1: дуо-набор не собран за 240 с");
    }
    console.log(`дуо-набор не собрался (${onState instanceof Error ? onState.message : "состояние сброшено"}) — гейт и нажатие заново`);
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

  // UI-хром (vite dev): сервис состояния + события + чип пресета. После
  // duopulse-092 на localhost:5173 может жить и страница ошибки замещённой
  // вкладки — берём цель БЕЗ .err-url.
  let uiTarget;
  for (let i = 0; i < 30 && !uiTarget; i++) {
    try {
      const targets = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
      for (const t of targets.filter((x) => x.type === "page" && /localhost:5173/.test(x.url))) {
        const c = connect(t.webSocketDebuggerUrl);
        const ok = await evalIn(c, `!document.querySelector(".err-url")`, 5000).catch(() => false);
        c.close();
        if (ok) {
          uiTarget = t;
          break;
        }
      }
    } catch {
      /* пробуем ещё раз */
    }
    if (!uiTarget) await sleep(500);
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
  // больше не открывает); duopulse-090: панель duo — child-webview
  // index.html?panel=duo, DOM чипов — в отдельной CDP-цели (паттерн e2e/asr).
  await evalIn(ui, `window.dispatchEvent(new CustomEvent("duo:open-panel"))`);
  let duoTarget;
  for (let i = 0; i < 30 && !duoTarget; i++) {
    const list = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
    duoTarget = list.find((x) => x.type === "page" && x.url.includes("?panel=duo")) ?? null;
    if (!duoTarget) await sleep(400);
  }
  if (!duoTarget) throw new Error("панель duo не открыта (цель ?panel=duo)");
  const duo = connect(duoTarget.webSocketDebuggerUrl);
  // готовность модуля панели: #duoPanel не скрыт и чипы отрисованы
  // (ранний статический HTML терял клики — duopulse-091)
  await waitForPage(
    duo,
    `(() => {
       const p = document.getElementById("duoPanel");
       return p && !p.hidden && p.querySelector(".duo-chip") ? 1 : 0;
     })()`,
    30000,
    "панель duo готова (модуль + чипы)",
  );
  const chip = await evalIn(
    duo,
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
  // закрыть панель (Escape в цель панели; не критично)
  await evalIn(duo, `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`).catch(() => null);

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
  dumpTimeline(); // зелёный прогон тоже оставляет хронологию (артефакт рантайма)
} catch (e) {
  dumpTimeline();
  // атрибуция падения на любой фазе: состояние бандла, список дорожек,
  // ошибки страницы, последние [subtitles]-строки Core
  if (tab) {
    try {
      const s = await stateOf(tab);
      const ti = await evalIn(tab, `window.__duopulseContent?.tracksInfo()`, 10000).catch(() => null);
      console.error("ДИАГНОСТИКА (падение): state=" + JSON.stringify({ k: s?.videoKey, en: s?.enabled, can: s?.canTracks, tr: s?.engine?.trackCount }));
      if (ti) console.error("tracksInfo: " + JSON.stringify({ path: ti.path, base: ti.base.map((b) => b.id), translationsCount: ti.translationsCount, warnings: ti.warnings }));
      if (pageErrs.length) console.error("ошибки страницы: " + JSON.stringify(pageErrs.slice(-8)));
      const log = appLog.join("").split("\n").filter((l) => l.includes("[subtitles]")).slice(-10);
      for (const l of log) console.error("  log: " + l.trimEnd());
    } catch {
      /* вкладка уже недоступна */
    }
  }
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
