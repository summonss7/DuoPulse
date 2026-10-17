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
    const row = { videoId, baseLang: "-", set: "-", cues: [], overlay: false, notes: [] };
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

      const sel = await evalRetry(
        tab,
        `window.__duopulseContent.selectTracks(${JSON.stringify(ids)})`,
      );
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
    // Пауза между видео: серийные timedtext-запросы рейт-лимитятся (429)
    if (vi < VIDEOS.length - 1) await sleep(4000);
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
console.log(`\nвидео с полным набором 2–3 дорожек: ${withFullSet} из ${VIDEOS.length}`);
console.log(`${failures === 0 ? "ALL PASS" : "FAILURES: " + failures} (${results.length} проверок)`);
fs.writeFileSync(
  path.join(OUT_DIR, "run-last.json"),
  JSON.stringify({ at: new Date().toISOString(), videos: rows }, null, 1),
);
process.exit(failures === 0 ? 0 : 1);
