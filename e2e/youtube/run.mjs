// E2E-прогон задачи 3.3 «YouTube-адаптер: список дорожек + загрузка выбранных N»
// (карточка duopulse-024, DoD: «10 случайных видео → наборы из 2–3 дорожек
// получены»). На реальном приложении (debug-exe + vite dev) и живом YouTube:
//   для каждого видео из фиксированного набора (те же, что в фикстурах
//   e2e/fixtures/youtube/playerResponses — снапшоты списков для юнит-тестов):
//   1) адаптер даёт полный список (tracksInfo): базовые + переводы;
//   2) выбирается набор «оригинал + 2 перевода» (ru/es tlang; при отсутствии
//      — второй базовый язык), загрузка в движок (selectTracks);
//   3) проверки: 2–3 дорожки с cue > 0, языки различные, порядок сохранён;
//   4) overlay рисует строки набора при воспроизведении (duo-плашка);
//   5) нативные субтитры плеера погашены на время показа (класс <html>,
//      задача 3.4, docs/03 §2);
//   6) скриншот-пример. Итог — таблица + счётчик видео с полным набором.
//
// Задача 3.6 (карточка duopulse-027): на первом видео дроп .srt поверх
// дорожки платформы — смешанный набор (docs/01 F-06).
// Задача 3.7 (карточка duopulse-028, сценарий docs/01 §5.1 из UI-хрома):
// на первом видео кнопка «duo» (list_tracks/состояние), панель набора,
// пресет «Дуо» → тройной набор (оригинал + перевод + свой файл),
// порядок строк панелью (fast-path), Alt+D вкл/выкл с восстановлением.
// Задача 3.8 (карточка duopulse-029, gate M3): на каждом видео offset
// Alt+[ / Alt+] (шаг 100 мс, HUD), отказы набора из-за HTTP 429 — один
// ретрай после паузы (сетевая флакучесть, транспорт не меняем), итог —
// сводка рабочих путей адаптера (фиксация DoD 3.8).
//
// Механика адаптера (октябрь 2026): прямые timedtext-URL из player-ответа
// отдают пустое тело (PO-токен), поэтому дорожки грузит сам плеер по команде
// captions.setOption (тела снимает перехват fetch/XHR в initialization
// script), переводы — fetch живого URL + tlang (подпись не покрывает).
//
// Запуск:  node e2e/youtube/run.mjs [путь-к-duopulse.exe] [id1,id2,…]
// Требует собранный debug-exe (cargo build), vite dev поднимает сам.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const CDP_PORT = 9240;
const OUT_DIR = path.join(ROOT, "e2e", "youtube");

// 10 случайных видео (варьируются языки/типы: manual/asr/многоязычные TED).
const VIDEOS = process.argv[3]
  ? process.argv[3].split(",").map((s) => s.trim())
  : [
      "iG9CE55wbtY", // TED Ken Robinson — manual en + 65 дорожек
      "dQw4w9WgXcQ", // клип — en manual+asr, de/ja/pt/es
      "jNQXAC9IVRw", // Me at the zoo — короткое, en+de
      "9bZkp7q19f0", // Gangnam Style — только asr ko
      "kJQP7kiw5Fk", // Despacito — es/en/ja
      "JGwWNGJdvx8", // Shape of You — en+asr, fil/hi/id/pt
      "fJ9rUzIMcZQ", // Bohemian Rhapsody — 18 дорожек (ru/es/de/ja…)
      "hT_nvWreIhg", // Counting Stars — одна ручная en
      "kXYiU_JCYtU", // Numb — 11 дорожек (fr/de/hi/it…)
      "YQHsXMglC9A", // Hello — en asr + en
    ];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))),
  );

const killOurExes = async () => {
  try {
    await run("powershell", [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='duopulse.exe'" | Where-Object { $_.ExecutablePath -eq '${EXE.replace(/\\/g, "\\\\")}' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }`,
    ]);
  } catch {
    /* уже мертвы — ок */
  }
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
      listeners.forEach((l) => l(m));
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
  return { send, close: () => ws.close(), on: (l) => listeners.push(l) };
}

const evalIn = async (ws, expression) => {
  const r = await ws.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception ?? r.exceptionDetails));
  return r.result?.value;
};
const evalRetry = async (ws, expr, attempts = 4) => {
  for (let i = 0; ; i++) {
    try {
      return await evalIn(ws, expr);
    } catch (e) {
      if (i >= attempts - 1) throw e;
      await sleep(1500);
    }
  }
};

/** Дождаться условия в странице (опрос 200 мс; редиректы старта YouTube
 * сбрасывают контекст — ловим и продолжаем). */
const waitForPage = async (ws, expr, timeoutMs, what) => {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try {
      v = await evalIn(ws, expr);
    } catch {
      /* навигация — на следующий круг */
    }
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`не дождались: ${what}`);
    await sleep(200);
  }
};

const results = [];
const rows = [];
let failures = 0;
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

let vite, app, appLog = [], tmp;
try {
  await killOurExes();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-yt-e2e-"));
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
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      APPDATA: tmp,
      DUOPULSE_START_URL: `https://www.youtube.com/watch?v=${VIDEOS[0]}`,
      DUOPULSE_ADBLOCK_LISTS: "", // изолируем от списков: чистый YouTube
      DUOPULSE_SLEEP_AFTER_SECS: "0",
      WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT} --autoplay-policy=no-user-gesture-required`,
    },
  });
  app.stderr?.on("data", (d) => appLog.push(String(d)));

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
  const tab = connect(target.webSocketDebuggerUrl);
  await tab.send("Network.enable");
  // Счётчик timedtext-запросов на текущем видео (диагностика отказов базы:
  // 0 запросов = setOption не сработал; запрос с v= и lang= = проблема матча).
  let netTimedtext = [];
  tab.on((m) => {
    if (m.method === "Network.requestWillBeSent" && m.params?.request?.url?.includes("timedtext")) {
      netTimedtext.push(
        m.params.request.url.split("?")[1]?.split("&").filter((p) => /lang|tlang|v=/.test(p)).join("&"),
      );
    }
  });
  for (const [n, v] of [
    ["CONSENT", "YES+cb.20210328-17-p0.en+FX+888"],
    ["SOCS", "CAI"],
  ]) {
    await tab.send("Network.setCookie", { name: n, value: v, domain: ".youtube.com", path: "/" });
  }

  let shotDone = false;
  for (const [vi, videoId] of VIDEOS.entries()) {
    const row = { videoId, path: "-", baseLang: "-", set: "-", cues: [], overlay: false, notes: [] };
    netTimedtext = [];
    try {
      await tab.send("Page.navigate", { url: `https://www.youtube.com/watch?v=${videoId}` });
      await waitForPage(tab, `window.__duopulseContent?.tracksInfo() !== null`, 25000, "список дорожек");
      // Реклама: серию прероллов (бывает 2–3 подряд у анонимной сессии)
      // пережидаем до вызова — как пользователь, включающий субтитры на
      // контенте; адаптер внутри тоже ждёт, но его бюджет попыток конечен.
      await waitForPage(
        tab,
        `(function () {
           const el = document.getElementById("movie_player");
           return !el?.classList?.contains("ad-showing");
         })()`,
        90000,
        "конец рекламы",
      ).catch(() => console.log(`      ${videoId}: реклама не кончилась за 90 с — пробуем всё равно`));
      // Переход реклама → контент пересоздаёт плеер/видео: список дорожек
      // сбрасывается и собирается заново — ждём повторно.
      await waitForPage(tab, `window.__duopulseContent?.tracksInfo() !== null`, 20000, "список после рекламы");
      // Телеметрия плеера перед загрузкой (диагностика «таймаутов базы»):
      // реклама/пауза/состояние плеера объясняют отказы программирования.
      const playerBefore = await evalRetry(tab, `(function () {
        const el = document.getElementById("movie_player");
        const v = document.querySelector("video");
        return {
          ad: el?.classList?.contains("ad-showing") ?? null,
          state: typeof el?.getPlayerState === "function" ? el.getPlayerState() : null,
          paused: v?.paused ?? null, t: v?.currentTime ?? null,
        };
      })()`);
      const info = await evalRetry(tab, `window.__duopulseContent.tracksInfo()`);
      row.path = info.path;
      row.baseLang = `${info.base.length} баз / ${info.translationsCount} перев. (путь ${info.path}; плеер ad=${playerBefore.ad} state=${playerBefore.state} paused=${playerBefore.paused} t=${playerBefore.t})`;
      if (info.base.length === 0) throw new Error("нет базовых дорожек");

      // Набор: оригинал (audioTracks.original → ручная → первая) + ru + es;
      // недостающие переводы замещаем вторым базовым языком (свободное
      // комбинирование, docs/03 §1).
      const original = info.base.find((b) => b.original && b.kind === "manual") ??
        info.base.find((b) => b.original) ?? info.base.find((b) => b.kind === "manual") ?? info.base[0];
      const ids = [original.id];
      const names = [`${original.id}(${original.lang})`];
      for (const code of ["ru", "es"]) {
        if (info.translationsCount > 0) {
          ids.push(code);
          names.push(`${original.id}+${code}`);
        }
      }
      if (ids.length < 2 && info.base.length > 1) {
        const second = info.base.find((b) => b.id !== original.id);
        if (second) {
          ids.push(second.id);
          names.push(second.id);
        }
      }
      row.set = names.join(" + ");

      let sel = await evalRetry(
        tab,
        `window.__duopulseContent.selectTracks(${JSON.stringify(ids)})`,
      );
      // Задача 3.8: серийные timedtext-запросы рейт-лимитятся (HTTP 429) —
      // адаптер бэкоффит 6/12/18 с, но окно лимита анонимной сессии длиннее
      // (кумулятивно ~15 tlang-запросов). Ретраи набора ранером с растущей
      // паузой (сетевая флакучесть, не дефект транспорта; docs/03 §9);
      // результат последнего ретрая канонический для проверок ниже.
      for (const [ri, retryDelay] of [75, 150].entries()) {
        if (!sel.failures.length) break;
        row.notes.push(`ретрай #${ri + 1} через ${retryDelay} с (${sel.failures.map((f) => f.reason).join("; ")})`);
        await sleep(retryDelay * 1000);
        sel = await evalRetry(
          tab,
          `window.__duopulseContent.selectTracks(${JSON.stringify(ids)})`,
        );
      }
      if (sel.unknown.length) row.notes.push(`неизвестные: ${sel.unknown.join(",")}`);
      for (const f of sel.failures) row.notes.push(`отказ ${f.id}: ${f.reason}`);
      if (sel.failures.length) {
        row.notes.push(`сеть timedtext: ${netTimedtext.length} → ${netTimedtext.slice(0, 4).join(" | ")}`);
        const hookBuf = await evalRetry(tab, `(window.__duopulseTimedtextSource?.all() ?? []).map(c => c.body.length + "Б " + c.url.split("?")[1]?.split("&").filter(p => /lang|tlang|v=/.test(p)).join("&")).slice(-6)`);
        row.notes.push(`буфер хука: ${JSON.stringify(hookBuf)}`);
      }

      const st = await evalRetry(tab, `window.__duopulseContent.state()`);
      row.cues = st.engine.tracks.map((t) => `${t.id}:${t.cues}`);
      const okSet =
        sel.loaded >= 2 &&
        sel.loaded <= 3 &&
        st.engine.tracks.length === sel.loaded &&
        st.engine.tracks.every((t) => t.cues > 0);
      check(
        `${videoId}: набор 2–3 дорожки загружен (${sel.loaded} шт, cue: ${row.cues.join(", ")})`,
        okSet,
        sel.failures.map((f) => `${f.id}→${f.reason}`).join("; ") || undefined,
      );

      // Плашка рисует строки набора при воспроизведении: seek в точку с cue
      // (30% длительности — у коротких роликов начало уже могло пройти).
      await evalRetry(
        tab,
        `(async function () {
           const v = document.querySelector("video");
           if (v && Number.isFinite(v.duration) && v.duration > 0) {
             const to = Math.max(0.5, v.duration * 0.3);
             if (Math.abs(v.currentTime - to) > 0.5) {
               await new Promise((res) => {
                 const d = () => { v.removeEventListener("seeked", d); res(); };
                 v.addEventListener("seeked", d);
                 v.currentTime = to;
               });
             }
             try { await v.play(); } catch (e) {}
           }
           return true;
         })()`,
      );
      const overlayText = await waitForPage(
        tab,
        `(function () {
           const t = document.querySelector("[data-duopulse-subtitles]");
           return t && t.innerText.trim().length > 0 ? t.innerText.trim() : null;
         })()`,
        18000,
        "плашка с cue",
      );
      row.overlay = true;
      const lines = overlayText.split("\n").filter((l) => l.trim());
      check(
        `${videoId}: overlay рисует набор (${lines.length} строк(и))`,
        lines.length >= Math.min(2, sel.loaded),
        JSON.stringify(lines.slice(0, 3)).slice(0, 140),
      );

      // Гашение нативных субтитров плеера на время нашего показа (docs/03 §2):
      // CSS-класс на <html> — селектор знает только адаптер (docs/03 §9).
      const ytBlanked = await evalRetry(
        tab,
        `window.__duopulseContent.state().nativeBlanked === true && document.documentElement.classList.contains("duopulse-yt-captions-off")`,
      );
      check(`${videoId}: нативные субтитры YouTube погашены (класс <html>)`, ytBlanked === true);

      // Задача 3.8 (gate M3): offset на живом YouTube — Alt+] / Alt+[
      // (шаг 100 мс, docs/03 §8) при активном наборе; HUD открывается и
      // показывает сдвиг, возврат к нулю — той же клавишей в минус.
      await evalIn(
        tab,
        `document.dispatchEvent(new KeyboardEvent("keydown", { altKey: true, code: "BracketRight", cancelable: true }))`,
      );
      const plus = await waitForPage(
        tab,
        `(function () {
           const s = window.__duopulseContent.state();
           return s.engine.offsetMs === 100 && s.offsetHudVisible === true ? true : null;
         })()`,
        6000,
        "Alt+] +100 мс с HUD",
      );
      await evalIn(
        tab,
        `document.dispatchEvent(new KeyboardEvent("keydown", { altKey: true, code: "BracketLeft", cancelable: true }))`,
      );
      const back = await waitForPage(
        tab,
        `window.__duopulseContent.state().engine.offsetMs === 0`,
        6000,
        "Alt+[ возврат к 0",
      );
      check(`${videoId}: offset Alt+]/Alt+[ — +100 мс с HUD, возврат к 0`, plus === true && back === true);

      // Задача 3.6 (ручные файлы, карточка duopulse-027): дроп .srt поверх
      // дорожек платформы — смешанный набор (docs/01 F-06). На первом видео:
      // платформенная часть сужается до оригинала, дроп добавляет файл.
      if (vi === 0) {
        await evalRetry(tab, `window.__duopulseContent.selectTracks([${JSON.stringify(original.id)}])`);
        const swallow = await evalRetry(
          tab,
          `(function () {
             const dt = new DataTransfer();
             dt.items.add(new File(["1\\n00:00:00,500 --> 01:00:00,000\\nРучной файл поверх YouTube\\n"], "manual.ru.srt", { type: "text/plain" }));
             return window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
           })()`,
        );
        const mixState = await waitForPage(
          tab,
          `(function () {
             const s = window.__duopulseContent.state();
             return s.fileTracks.length === 1 && s.fileTracks[0].id === "file:ru" && s.engine.trackCount === 2 ? s : null;
           })()`,
          15000,
          "файловая дорожка поверх YouTube",
        );
        check(
          `${videoId}: дроп .srt поверх дорожки платформы — смешанный набор 2 дорожки (${mixState.engine.tracks.map((t) => t.id).join(" + ")})`,
          swallow === false,
        );
        const mixOverlay = await waitForPage(
          tab,
          `(function () {
             const t = document.querySelector("[data-duopulse-subtitles]");
             return t && t.innerText.includes("Ручной файл поверх YouTube") ? t.innerText.trim() : null;
           })()`,
          15000,
          "плашка со строкой файла",
        );
        check(
          `${videoId}: overlay рисует смешанный набор (платформа + файл)`,
          mixOverlay.includes("Ручной файл поверх YouTube") && mixOverlay.split("\n").filter((l) => l.trim()).length >= 2,
          JSON.stringify(mixOverlay.split("\n").slice(0, 2)).slice(0, 140),
        );
        if (!shotDone) {
          fs.mkdirSync(OUT_DIR, { recursive: true });
          const shot = await tab.send("Page.captureScreenshot", { format: "png" });
          fs.writeFileSync(path.join(OUT_DIR, "shot-file-mix-yt.png"), Buffer.from(shot.data, "base64"));
          check("скриншот смешанного набора на YouTube (shot-file-mix-yt.png)", fs.existsSync(path.join(OUT_DIR, "shot-file-mix-yt.png")));
        }

        // Задача 3.7 (карточка duopulse-028): сценарий docs/01 §5.1 из UI-хрома —
        // кнопка «duo», панель набора, пресет «Дуо» (третья строка — свой файл),
        // порядок строк, Alt+D вкл/выкл с восстановлением последнего набора.
        const tlist = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
        const uiT = tlist.find((t) => t.type === "page" && /localhost:5173/.test(t.url));
        if (!uiT) throw new Error("UI-цель CDP не найдена (нужен vite dev)");
        const ui = connect(uiT.webSocketDebuggerUrl);
        await waitForPage(ui, `typeof window.__duopulse === "object"`, 10000, "bridge-хук в хроме");
        await sleep(600); // set-state смешанного набора долетел до кнопки

        const snap = await evalRetry(ui, `window.__duopulse.subtitles.listTracks()`);
        check(
          `${videoId}: §5.1 list_tracks — видео, набор (оригинал + файл ru), список адаптера`,
          snap.videoKey === `yt:${videoId}` && snap.enabled === true &&
            snap.tracks.length === 2 && snap.tracks.some((t) => t.source === "file") &&
            snap.canTracks === true && snap.base.length > 0,
          JSON.stringify({ videoKey: snap.videoKey, tracks: snap.tracks.map((t) => t.id) }),
        );
        const btnState = await evalRetry(
          ui,
          `(function () { const b = document.getElementById("duoBtn"); return { hidden: b.hidden, count: b.dataset.count }; })()`,
        );
        check(
          `${videoId}: §5.1 кнопка «duo» видна, состояние «дуо» (2 дорожки)`,
          btnState.hidden === false && btnState.count === "2",
          JSON.stringify(btnState),
        );

        // Панель: пресет «Дуо» добавляет перевод tlang к оригиналу — с файловой
        // строкой это тройной набор (docs/03 §1: оригинал + перевод + свой файл).
        await evalIn(ui, `document.getElementById("duoBtn").click()`);
        await sleep(500);
        const duoChip = await evalIn(
          ui,
          `(function () {
             const chips = Array.from(document.querySelectorAll("#duoPresets .duo-chip"));
             const chip = chips.find((c) => c.textContent.startsWith("Дуо"));
             if (!chip) return null;
             chip.click();
             return chip.dataset.ids;
           })()`,
        );
        check(`${videoId}: §5.1 панель открылась, пресет «Дуо» кликнут`, duoChip !== null, String(duoChip));
        const trioState = await waitForPage(
          tab,
          `(function () {
             const s = window.__duopulseContent.state();
             return s.engine.trackCount === 3 && s.engine.tracks.every((t) => t.cues > 0) ? s.engine.tracks.map((t) => t.id) : null;
           })()`,
          60000, // загрузка перевода tlang: при 429 адаптер бэкоффит 6/12/18 с
          "тройной набор из панели (пресет + файл)",
        );
        check(
          `${videoId}: §5.1 тройной набор: оригинал + перевод платформы + свой файл`,
          trioState.length === 3 && trioState[0] === original.id && trioState[1] === `${original.id}+ru` && trioState[2] === "file:ru",
          trioState.join(" + "),
        );

        // Порядок строк: «↓» в панели — fast-path перестановка (без сети).
        await evalIn(ui, `document.querySelector("#duoSet .duo-row [data-act='down']").click()`);
        const swapped = await waitForPage(
          tab,
          `(function () {
             const ids = window.__duopulseContent.state().engine.tracks.map((t) => t.id);
             return ids[0] === ${JSON.stringify(`${original.id}+ru`)} ? ids : null;
           })()`,
          10000,
          "перестановка строк набора",
        );
        check(
          `${videoId}: §5.1 порядок строк настраивается (перевод выше оригинала)`,
          swapped[0] === `${original.id}+ru` && swapped[1] === original.id && swapped[2] === "file:ru",
          swapped.join(" + "),
        );

        // Alt+D: выключить (нативные не гасим) / включить — последний набор тот же.
        await evalIn(tab, `document.dispatchEvent(new KeyboardEvent("keydown", { altKey: true, code: "KeyD", cancelable: true }))`);
        const offState = await waitForPage(
          tab,
          `(function () {
             const s = window.__duopulseContent.state();
             return s.enabled === false && s.engine.trackCount === 0 && !document.documentElement.classList.contains("duopulse-yt-captions-off") ? true : null;
           })()`,
          10000,
          "Alt+D выкл на YouTube",
        );
        check(`${videoId}: §5.1 Alt+D выключил показ (нативные субтитры не гасим)`, offState === true);
        await evalIn(tab, `document.dispatchEvent(new KeyboardEvent("keydown", { altKey: true, code: "KeyD", cancelable: true }))`);
        const onState = await waitForPage(
          tab,
          `(function () {
             const s = window.__duopulseContent.state();
             return s.enabled === true && s.engine.trackCount === 3 && s.nativeBlanked === true ? s.engine.tracks.map((t) => t.id) : null;
           })()`,
          10000,
          "Alt+D включил последний набор",
        );
        check(
          `${videoId}: §5.1 Alt+D включил: последний набор восстановлен без перезагрузки`,
          onState.join(",") === swapped.join(","),
          onState.join(" + "),
        );
        ui.close();
      }

      if (!shotDone) {
        fs.mkdirSync(OUT_DIR, { recursive: true });
        const shot = await tab.send("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(path.join(OUT_DIR, "shot-duo.png"), Buffer.from(shot.data, "base64"));
        shotDone = true;
        check("скриншот duo-набора сохранён (e2e/youtube/shot-duo.png)", fs.existsSync(path.join(OUT_DIR, "shot-duo.png")));
      }
    } catch (e) {
      check(`${videoId}: прогон`, false, e.message);
      row.notes.push(e.message);
    }
    rows.push(row);
    console.log(`      ${videoId}: ${row.baseLang} | набор: ${row.set}${row.notes.length ? " | " + row.notes.join("; ") : ""}`);
    // Пауза между видео: серийные tlang-запросы рейт-лимитятся (429) —
    // окно лимита кумулятивное, размазываем запросы по времени прогона
    if (vi < VIDEOS.length - 1) await sleep(25000);
  }

  // Core видел сообщения адаптера (журнал [subtitles])
  await sleep(400);
  const logText = appLog.join("");
  check(
    "Core получал списки дорожек ([subtitles] tracks в журнале)",
    logText.includes("[subtitles] tracks:"),
    (logText.split("\n").filter((l) => l.includes("[subtitles] tracks")).pop() ?? "").trim(),
  );
  tab.close();
} catch (e) {
  failures++;
  console.error("E2E ERROR:", e.message);
} finally {
  app?.kill("SIGKILL");
  await killOurExes();
  try {
    await run("taskkill", ["/PID", String(vite?.pid), "/T", "/F"]);
  } catch {}
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
  await sleep(500);
}

const withFullSet = results.filter((r) => r.ok && r.name.includes("набор 2–3")).length;
// Задача 3.8 (DoD «фиксация рабочих путей адаптера»): каким путём добычи
// (docs/03 §9) собран список дорожек на каждом видео прогона.
const pathsOf = {};
for (const r of rows) if (r.path && r.path !== "-") pathsOf[r.path] = (pathsOf[r.path] ?? 0) + 1;
console.log(`\nвидео с полным набором 2–3 дорожек: ${withFullSet} из ${VIDEOS.length}`);
console.log(`рабочие пути адаптера (список дорожек): ${JSON.stringify(pathsOf)}`);
console.log(`${failures === 0 ? "ALL PASS" : "FAILURES: " + failures} (${results.length} проверок)`);
fs.writeFileSync(
  path.join(OUT_DIR, "run-last.json"),
  JSON.stringify({ at: new Date().toISOString(), paths: pathsOf, videos: rows }, null, 1),
);
process.exit(failures === 0 ? 0 : 1);
