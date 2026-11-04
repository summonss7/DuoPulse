// Запись фикстур player-ответов YouTube (задача 3.3, карточка duopulse-024;
// docs/03 §9 — тесты адаптера на записанных снапшотах, без сети).
//
// Поднимает приложение (debug-exe + vite dev), для каждого видео-кандидата:
//   1) открывает watch-страницу, ждёт player-ответ;
//   2) снимает captions.playerCaptionsTracklistRenderer (captionTracks +
//      translationLanguages + audioTracks) и videoDetails — путь «player-api»
//      (movie_player.getPlayerResponse), попутно проверяет путь
//      «initial» (window.ytInitialPlayerResponse);
//   3) пробует in-page fetch дорожки (базовая + tlang-перевод, fmt=json3) —
//      знание о том, работает ли сетевой путь 3.3 в текущем YouTube;
//   4) пишет e2e/fixtures/youtube/playerResponses/<videoId>.json.
//
// Запуск:  node e2e/youtube/record.mjs [duopulse.exe] [id1,id2,…]
// Требует собранный debug-exe (cargo build) и сеть до youtube.com.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const CDP_PORT = 9235;
const OUT_DIR = path.join(ROOT, "e2e", "fixtures", "youtube", "playerResponses");

// Кандидаты: разнообразие языков/видов дорожек (manual/asr/переводы tlang).
// Часть может оказаться без субтитров — рекордер отчитает и пропустит.
const CANDIDATES = process.argv[3]
  ? process.argv[3].split(",").map((id) => id.trim())
  : [
      "iG9CE55wbtY", // TED Ken Robinson — manual en + переводы
      "dQw4w9WgXcQ", // клип, asr en
      "jNQXAC9IVRw", // Me at the zoo — короткое, asr en
      "9bZkp7q19f0", // Gangnam Style — ko
      "kJQP7kiw5Fk", // Despacito — es
      "JGwWNGJdvx8", // Shape of You — en
      "fJ9rUzIMcZQ", // Bohemian Rhapsody — en
      "60ItHLz5WEA", // Faded — en
      "hT_nvWreIhg", // Counting Stars — en
      "2Vv-BfVoq4g", // Perfect — en
      "kXYiU_JCYtU", // Numb — en
      "YQHsXMglC9A", // Hello — en
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

/** Снять данные видео в контексте страницы (пути адаптера — docs/03 §9). */
const SNIPPET = `(async () => {
  const el = document.getElementById("movie_player");
  const api = typeof el?.getPlayerResponse === "function" ? el.getPlayerResponse() : null;
  const initial = window.ytInitialPlayerResponse ?? null;
  const response = api ?? initial;
  const details = response?.videoDetails ?? null;
  const list = response?.captions?.playerCaptionsTracklistRenderer ?? null;
  return {
    usedPath: api ? "player-api" : initial ? "initial" : null,
    hasBothPaths: !!api && !!initial,
    videoId: details?.videoId ?? null,
    title: details?.title ?? null,
    durationSec: Number(details?.lengthSeconds ?? 0) || null,
    captionTracks: list?.captionTracks ?? null,
    translationLanguages: list?.translationLanguages ?? null,
    audioTracks: list?.audioTracks ?? null,
    defaultCaptionTrackIndex: list?.defaultCaptionTrackIndex ?? null,
    defaultAudioTrackIndex: list?.defaultAudioTrackIndex ?? null,
  };
})()`;

/** In-page fetch дорожки: baseUrl + fmt=json3 (+tlang). Статус/длина/начало тела. */
const FETCH_SNIPPET = (url) => `(async () => {
  try {
    const res = await fetch(${JSON.stringify(url)}, { credentials: "include" });
    const body = await res.text();
    return { status: res.status, ok: res.ok, length: body.length, head: body.slice(0, 160) };
  } catch (e) {
    return { status: 0, ok: false, length: 0, head: String(e) };
  }
})()`;

const appendTlang = (baseUrl, tlang) =>
  baseUrl + (baseUrl.includes("?") ? "&" : "?") + "fmt=json3" + (tlang ? `&tlang=${encodeURIComponent(tlang)}` : "");

const results = [];
let vite, app, appLog = [], tmp;
try {
  await killOurExes();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-yt-record-"));
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
      DUOPULSE_START_URL: `https://www.youtube.com/watch?v=${CANDIDATES[0]}`,
      DUOPULSE_ADBLOCK_LISTS: "",
      DUOPULSE_SLEEP_AFTER_SECS: "0",
      WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT} --autoplay-policy=no-user-gesture-required`,
    },
  });
  app.stderr?.on("data", (d) => appLog.push(String(d)));

  // Ждём CDP-цель контентной вкладки на youtube.com
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
  // EEA-consent страховка (вне EEA безвредны)
  for (const [name, value] of [
    ["CONSENT", "YES+cb.20210328-17-p0.en+FX+888"],
    ["SOCS", "CAI"],
  ]) {
    await tab.send("Network.setCookie", { name, value, domain: ".youtube.com", path: "/" });
  }

  for (const id of CANDIDATES) {
    const url = `https://www.youtube.com/watch?v=${id}`;
    await tab.send("Page.navigate", { url });
    // player-ответ появляется после отрисовки плеера
    let data = null;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      try {
        data = await evalIn(tab, SNIPPET);
      } catch {
        continue; // навигация сбрасывает контекст
      }
      if (data?.captionTracks || data?.usedPath === null) break;
      if (data?.usedPath && !data.captionTracks && i > 16) break; // ответ есть, дорожек нет
    }
    if (!data?.captionTracks?.length) {
      results.push({ id, ok: false, reason: data ? "captionTracks пуст/нет" : "player-ответ не дождались" });
      console.log(`SKIP  ${id} — дорожек нет`);
      continue;
    }
    // Проба сетевого пути: дорожка по умолчанию/первая + её tlang-перевод (ru, если есть)
    const base = data.captionTracks.find((t) => t.vssId?.startsWith("a.")) ?? data.captionTracks[0];
    const canRu = (data.translationLanguages ?? []).some((l) => l.languageCode === "ru");
    const probeBase = await evalIn(tab, FETCH_SNIPPET(appendTlang(base.baseUrl)));
    const probeRu = canRu
      ? await evalIn(tab, FETCH_SNIPPET(appendTlang(base.baseUrl, "ru")))
      : { skipped: true };
    const fixture = {
      videoId: data.videoId ?? id,
      url,
      recordedAt: new Date().toISOString(),
      title: data.title,
      durationSec: data.durationSec,
      paths: { playerApi: data.usedPath === "player-api", initialResponse: data.hasBothPaths || data.usedPath === "initial" },
      captionTracks: data.captionTracks,
      translationLanguages: data.translationLanguages ?? [],
      // duopulse-070: audioTracks рендерера пишем в фикстуру (web-клиент:
      // captionTrackIndices/defaultCaptionTrackIndex; defaultCaptionTrackIndex
      // зависит от языка интерфейса записывавшей сессии — не язык оригинала).
      ...(data.audioTracks ? { audioTracks: data.audioTracks } : {}),
      ...(data.defaultCaptionTrackIndex != null ? { defaultCaptionTrackIndex: data.defaultCaptionTrackIndex } : {}),
      ...(data.defaultAudioTrackIndex != null ? { defaultAudioTrackIndex: data.defaultAudioTrackIndex } : {}),
      netProbe: { base: probeBase, tlangRu: probeRu },
    };
    fs.writeFileSync(path.join(OUT_DIR, `${fixture.videoId}.json`), JSON.stringify(fixture));
    results.push({
      id: fixture.videoId,
      ok: true,
      title: data.title?.slice(0, 48),
      tracks: data.captionTracks.length,
      langs: data.captionTracks.map((t) => t.languageCode + (t.kind === "asr" ? "(asr)" : "")).join(" "),
      trans: (data.translationLanguages ?? []).length,
      fetchBase: probeBase.ok ? `ok ${probeBase.length}Б` : `fail ${probeBase.status}`,
      fetchRu: probeRu.skipped ? "нет ru" : probeRu.ok ? `ok ${probeRu.length}Б` : `fail ${probeRu.status}`,
    });
    console.log(`OK    ${fixture.videoId} — дорожек ${data.captionTracks.length}, переводов ${fixture.translationLanguages?.length ?? 0}`);
  }
  tab.close();
} catch (e) {
  console.error("RECORD ERROR:", e.message);
  process.exitCode = 1;
} finally {
  app?.kill("SIGKILL");
  await killOurExes();
  try {
    await run("taskkill", ["/PID", String(vite?.pid), "/T", "/F"]);
  } catch {}
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

console.log("\n--- сводка ---");
for (const r of results) {
  console.log(
    r.ok
      ? `${r.id} | ${String(r.tracks).padStart(2)} дор. | перев ${String(r.trans).padStart(3)} | fetch ${r.fetchBase} / ru ${r.fetchRu} | ${r.langs} | ${r.title}`
      : `${r.id} | SKIP: ${r.reason}`,
  );
}
