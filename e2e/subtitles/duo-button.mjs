// Живой стенд карточки duopulse-079: клик по кнопке «duo» должен ВКЛЮЧАТЬ
// субтитры (как Alt+D — дефолт «оригинал + предпочитаемый перевод»), а не
// только открывать панель; в панели — строка «Языки: с какого → на какой»
// (селекты оригинала и перевода) со ссылкой на настройки субтитров.
//
// Проверки (критерии карточки):
//   A) свежее видео (enabled=false): клик duoBtn → панель открыта И показ
//      включён дуо-дефолтом (en-оригинал + ru-перевод, via=panel);
//   B) строка «Языки»: селект «Язык видео» = en-оригинал, «Перевод» = ru;
//   C) смена перевода в селекте → дуо-набор en+<новый> без перезагрузки;
//   D) «Нет (только оригинал)» → набор из 1 дорожки;
//   E) повторный клик по duoBtn при включённом показе — только панель
//      (панель закрылась, показ остался);
//   F) «настройки субтитров» открывает вкладку duopulse://settings.
//
// Запуск:  node e2e/subtitles/duo-button.mjs [путь-к-duopulse.exe] [videoId]
// Требует собранный debug-exe (cargo build); vite dev поднимает сам. Видео
// по умолчанию — Counting Stars (hT_nvWreIhg): en-ручная + ru/es-переводы.
// Блокировщик отключён (DUOPULSE_ADBLOCK_LISTS="") — преролл скипаем кнопкой.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const VIDEO = process.argv[3] || "hT_nvWreIhg";
const CDP_PORT = 9243;

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

const evalIn = (ws, expr, timeoutMs = 30000) =>
  Promise.race([
    ws
      .send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })
      .then((r) => r?.result?.value),
    sleep(timeoutMs).then(() => {
      throw new Error("eval-таймаут: " + expr.slice(0, 80));
    }),
  ]);

const waitFor = async (ws, expr, timeoutMs, what) => {
  const isTab = ws === tab; // цель вкладки может умереть (навигация) — переподключаемся
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try {
      v = await evalIn(isTab ? tab : ws, expr);
    } catch {
      if (isTab) await reconnect().catch(() => {});
    }
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`не дождались: ${what}`);
    await sleep(300);
  }
};

// Переподключение к живой CDP-цели YouTube (навигация убивает ws-цель).
const reconnect = async () => {
  for (let i = 0; i < 10; i++) {
    try {
      const target = await findTarget((u) => u.includes("youtube.com"));
      if (!target) throw new Error("нет цели youtube");
      const ws = connect(target.webSocketDebuggerUrl);
      await evalIn(ws, `1 + 1`, 10000);
      tab = ws;
      return;
    } catch {
      await sleep(3000);
    }
  }
  throw new Error("CDP: переподключение не удалось");
};

let tab = null;
let ui = null;
let vite;
let app;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-079-e2e-"));

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

const findTarget = async (pred) => {
  const targets = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
  return targets.find((t) => t.type === "page" && pred(t.url));
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
    stdio: "ignore",
    env: {
      ...process.env,
      APPDATA: tmp,
      DUOPULSE_START_URL: `https://www.youtube.com/watch?v=${VIDEO}`,
      DUOPULSE_ADBLOCK_LISTS: "",
      DUOPULSE_SLEEP_AFTER_SECS: "0",
      WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT} --autoplay-policy=no-user-gesture-required`,
    },
  });

  // контентная вкладка YouTube (ранние цели недолговечны — переподключаемся)
  for (let attempt = 0; attempt < 5 && !tab; attempt++) {
    let target;
    for (let i = 0; i < 90; i++) {
      try {
        target = await findTarget((u) => u.includes("youtube.com"));
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
  for (const [n, v] of [
    ["CONSENT", "YES+cb.20210328-17-p0.en+FX+888"],
    ["SOCS", "CAI"],
  ]) {
    await tab.send("Network.setCookie", { name: n, value: v, domain: ".youtube.com", path: "/" });
  }
  await tab.send("Page.navigate", { url: `https://www.youtube.com/watch?v=${VIDEO}` });

  await waitFor(tab, `!!window.__duopulseContent?.state()?.videoKey`, 90000, "детект видео");
  await waitFor(tab, `window.__duopulseContent?.state().canTracks === true`, 60000, "tracks_ready");

  // стабилизация списка дорожек (детектор переэмитит ключ по loadedmetadata;
  // анонимная сессия порой перезагружает страницу — опрос через waitFor с
  // переподключением, eval-таймаут не роняет прогон)
  for (let i = 0; i < 30; i++) {
    const s = await waitFor(tab, `window.__duopulseContent?.state()?.videoKey?.startsWith("yt:") ? window.__duopulseContent.state() : null`, 15000, "состояние yt-видео").catch(() => null);
    if (s?.canTracks) {
      await sleep(700);
      const s2 = await waitFor(tab, `window.__duopulseContent?.state()`, 15000, "состояние (повтор)").catch(() => null);
      if (s2?.canTracks && s2.videoKey === s.videoKey) break;
    }
    await sleep(500);
  }
  // играющий плеер (timedtext недоступен на паузе) и без рекламы
  await evalIn(
    tab,
    `(async () => { const v = document.querySelector("video"); if (v && v.paused) { try { await v.play(); } catch (e) {} } return true; })()`,
  );
  const adT0 = Date.now();
  for (;;) {
    const ad = await evalIn(tab, `document.getElementById("movie_player")?.classList?.contains("ad-showing") === true`).catch(() => null);
    if (!ad) break;
    if (Date.now() - adT0 > 240000) throw new Error("преролл не закончился за 240 с");
    await evalIn(tab, `document.querySelector(".ytp-ad-skip-button, .ytp-skip-ad-button")?.click() ?? null`).catch(() => null);
    await sleep(3000);
  }

  // UI-хром (vite dev) + bridge-хук
  let uiTarget;
  for (let i = 0; i < 30; i++) {
    uiTarget = await findTarget((u) => /localhost:5173/.test(u)).catch(() => null);
    if (uiTarget) break;
    await sleep(500);
  }
  if (!uiTarget) throw new Error("UI-цель CDP не найдена (нужен vite dev)");
  ui = connect(uiTarget.webSocketDebuggerUrl);
  await waitFor(ui, `typeof window.__duopulse === "object"`, 10000, "bridge-хук window.__duopulse");
  await waitFor(ui, `document.getElementById("duoBtn").hidden === false`, 30000, "кнопка duo видна");

  const before = await evalIn(ui, `window.__duopulse.subtitles.listTracks()`);
  if (before?.enabled !== false || (before?.tracks ?? []).length !== 0)
    console.log(`внимание: стартовое состояние не «свежее» (enabled=${before?.enabled}, tracks=${(before?.tracks ?? []).length}) — проверка A по-прежнему про клик`);

  // (A) клик по кнопке «duo» на выключенном показе: панель + дуо-дефолт.
  // en-оригинал непереводим (isTranslatable=false) — tlang платформы нельзя
  // и по специции дефолт = один оригинал; иначе ждём дуо en+ru.
  const preClick = await evalIn(
    tab,
    `window.__duopulseContent?.tracksInfo()`,
  ).catch(() => null);
  const enBase = preClick?.base?.find((b) => /en/.test(b.id));
  const enTranslatable = enBase?.translatable === true;
  console.log(
    "ПЕРЕД КЛИКОМ: " +
      JSON.stringify(preClick && { path: preClick.path, base: preClick.base.map((b) => b.id + (b.translatable === false ? " !tr" : "")), translationsCount: preClick.translationsCount, warnings: preClick.warnings }),
  );
  await evalIn(ui, `document.getElementById("duoBtn").click()`);
  const panelOpen = await waitFor(ui, `document.getElementById("duoPanel").hidden === false`, 5000, "панель открыта");
  let applied;
  try {
    applied = await waitFor(
      tab,
      `window.__duopulseContent?.state().enabled === true && window.__duopulseContent?.state().engine.trackCount >= 1`,
      150000,
      "клик duoBtn: показ включён (дефолт-набор загрузился)",
    );
  } catch (e) {
    const s = await evalIn(tab, `window.__duopulseContent?.state()`).catch(() => null);
    const ti = await evalIn(tab, `window.__duopulseContent?.tracksInfo()`).catch(() => null);
    const snapNow = await evalIn(ui, `window.__duopulse.subtitles.listTracks()`).catch(() => null);
    console.error("ДИАГНОСТИКА applied: content=" + JSON.stringify({ en: s?.enabled, tr: s?.engine?.trackCount, key: s?.videoKey, canTracks: s?.canTracks }));
    console.error("tracksInfo: " + JSON.stringify(ti && { path: ti.path, base: ti.base.map((b) => b.id + (b.original ? "*" : "")), translationsCount: ti.translationsCount, warnings: ti.warnings }));
    console.error("UI snapshot: " + JSON.stringify({ enabled: snapNow?.enabled, tracks: (snapNow?.tracks ?? []).map((t) => t.id) }));
    throw e;
  }
  const snapCond = enTranslatable
    ? `ids.includes("en") && ids.includes("ru")`
    : `ids.includes("en") && (s.tracks ?? []).length === 1`;
  let snap;
  try {
    snap = await waitFor(
      ui,
      `(async () => { const s = await window.__duopulse.subtitles.listTracks(); const ids = (s.tracks ?? []).map((t) => t.id).join("|"); return s.enabled === true && ${snapCond} ? s : null; })()`,
      150000,
      "дуо-набор в снапшоте UI",
    );
  } catch (e) {
    const s = await evalIn(tab, `window.__duopulseContent?.state()`);
    const ti = await evalIn(tab, `window.__duopulseContent?.tracksInfo()`);
    const snapNow = await evalIn(ui, `window.__duopulse.subtitles.listTracks()`);
    console.error("ДИАГНОСТИКА A: content=" + JSON.stringify({ en: s?.enabled, tr: s?.engine?.trackCount, key: s?.videoKey }));
    console.error("tracksInfo: " + JSON.stringify(ti && { path: ti.path, base: ti.base.map((b) => b.id + (b.original ? "*" : "")), translationsCount: ti.translationsCount, warnings: ti.warnings }));
    console.error("UI snapshot: " + JSON.stringify({ enabled: snapNow?.enabled, tracks: (snapNow?.tracks ?? []).map((t) => t.id), translations: (snapNow?.translations ?? []).map((t) => t.lang).slice(0, 10) }));
    // прямой проб: грузится ли ru через selectTracks (отделить отказ timedtext
    // от дефолт-набора/флага translatable)
    await evalIn(tab, `window.__duopulseContent?.selectTracks(["yt:en", "ru"])`);
    try {
      const probe = await waitFor(tab, `window.__duopulseContent?.state().engine.trackCount === 2`, 60000, "проб selectTracks en+ru");
      console.error("ПРОБ: selectTracks(en,ru) → 2 дорожки — загрузка ru работает");
    } catch {
      const s2 = await evalIn(tab, `window.__duopulseContent?.state()`);
      console.error("ПРОБ: selectTracks(en,ru) → " + JSON.stringify({ en: s2?.enabled, tr: s2?.engine?.trackCount }) + " — ru не грузится (timedtext/флаг)");
    }
    throw e;
  }
  check(
    `(A) клик duoBtn включил показ с дефолт-набором (${enTranslatable ? "en-оригинал + ru" : "en-оригинал, tlang недоступен"}), панель открыта`,
    panelOpen === true && applied === true && !!snap,
    `набор: ${(snap.tracks ?? []).map((t) => t.id).join(" + ")}`,
  );

  // (B) строка «Языки»: селекты оригинала/перевода отражают набор
  const langs = await evalIn(
    ui,
    `(function () {
       const from = document.getElementById("duoLangFrom");
       const to = document.getElementById("duoLangTo");
       return {
         fromValue: from.value, fromText: from.selectedOptions[0]?.textContent ?? "",
         toValue: to.value, toText: to.selectedOptions[0]?.textContent ?? "",
         fromCount: from.options.length, toPlatform: [...to.options].some((o) => o.parentElement?.label === "Перевод платформы"),
         toCloud: [...to.options].some((o) => o.parentElement?.label === "Облачный перевод"),
       };
     })()`,
  );
  check(
    `(B) «Языки»: оригинал = en-дорожка, перевод = ${enTranslatable ? "ru из группы платформы" : "«нет», tlang недоступен — группа облака"}`,
    // «· оригинал» в подписи не проверяем: метка зависит от того, отдал ли
    // YouTube originalLanguage (анонимная сессия порой нет), имя дорожки —
    // на языке интерфейса сессии («engleză»). Группа облака при полном
    // списке tlang (156 языков) пуста по дизайну (cloudLangOptions исключает
    // языки платформы) — обязательна только без tlang.
    /en/.test(langs.fromValue) &&
      langs.toValue === (enTranslatable ? "ru" : "") &&
      (enTranslatable ? langs.toPlatform : !langs.toPlatform && langs.toCloud),
    `from=${langs.fromValue} («${langs.fromText}»), to=${langs.toValue} («${langs.toText}»), platform=${langs.toPlatform}, cloud=${langs.toCloud}`,
  );

  // (C) смена перевода селектом: дуо en+<другой язык платформы>
  const other = await evalIn(
    ui,
    `(function () {
       const to = document.getElementById("duoLangTo");
       const opt = [...to.options].find((o) => o.value && o.value !== "ru" && !o.value.startsWith("cloud:"));
       return opt ? opt.value : null;
     })()`,
  );
  if (other) {
    await evalIn(
      ui,
      `(function () { const to = document.getElementById("duoLangTo"); to.value = ${JSON.stringify(other)}; to.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`,
    );
    const snapC = await waitFor(
      ui,
      `(async () => { const s = await window.__duopulse.subtitles.listTracks(); const ids = (s.tracks ?? []).map((t) => t.id).join("|"); return ids.includes(${JSON.stringify(other)}) && ids.includes("en") ? ids : null; })()`,
      150000,
      `смена перевода на ${other}`,
    );
    check(`(C) «Перевод» → ${other}: набор en+${other} без перезагрузки страницы`, !!snapC, `набор: ${snapC}`);
  } else {
    console.log("SKIP  (C) у видео нет второго перевода платформы");
  }

  // (D) «Нет (только оригинал)»: одна дорожка
  await evalIn(
    ui,
    `(function () { const to = document.getElementById("duoLangTo"); to.value = ""; to.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`,
  );
  const snapD = await waitFor(
    ui,
    `(async () => { const s = await window.__duopulse.subtitles.listTracks(); return s.enabled === true && (s.tracks ?? []).length === 1 && s.tracks[0].lang === "en" ? s.tracks[0].id : null; })()`,
    30000,
    "перевод снят — только оригинал",
  );
  check("(D) «Нет» — набор из одного оригинала", !!snapD, `набор: ${snapD}`);

  // (E) повторный клик при включённом показе: только панель, показ живёт
  await evalIn(ui, `document.getElementById("duoBtn").click()`); // панель открыта → закроется
  await waitFor(ui, `document.getElementById("duoPanel").hidden === true`, 5000, "панель закрылась");
  const snapE = await evalIn(ui, `window.__duopulse.subtitles.listTracks()`);
  check(
    "(E) второй клик duoBtn закрыл панель, показ остался включён",
    snapE.enabled === true && (snapE.tracks ?? []).length === 1,
    `enabled=${snapE.enabled}, tracks=${(snapE.tracks ?? []).length}`,
  );

  // (F) «настройки субтитров»: вкладка duopulse://settings
  await evalIn(ui, `document.getElementById("duoBtn").click()`); // снова открыть панель
  await waitFor(ui, `document.getElementById("duoPanel").hidden === false`, 5000, "панель открыта");
  await evalIn(ui, `document.getElementById("duoLangSettings").click()`);
  const settingsUrl = await waitFor(
    ui,
    `(async () => { const t = await window.__duopulse.tabs.list(); const active = t.tabs.find((x) => x.active); return active && active.url.includes("settings") ? active.url : null; })()`,
    15000,
    "активная вкладка — настройки",
  );
  check("(F) «настройки субтитров» открыли duopulse://settings", !!settingsUrl, `url=${settingsUrl}`);
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
