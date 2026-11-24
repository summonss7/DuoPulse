// E2E-стенд duopulse-218 «ФОНОВАЯ МУЗЫКА»: музыка браузера играет, когда
// пользователь ушёл в другое приложение (жалоба «перехожу в другое окно —
// сразу выключается»). Debug-APK + CDP webview_devtools_remote (порт 9223,
// конвенция мобильных смоуков). Механика: MobileMediaHelper держит webview'ы
// активными при onPause активности (WryActivity гасит UI-webview), поднимает
// foreground-сервис mediaPlayback; зонд — каждые 2 с (<video> UI-webview /
// __duopulseMobileDuo().clock / медиа web-оверлея).
//
// Живой YouTube на эмуляторе периодически бот-блокируется (память проекта
// duopulse-youtube-e2e-rate-limit / googlevideo-emulator-403) — стенд
// ДЕТЕРМИНИРОВАН офлайн-путями, YouTube — мягкая фаза (SKIP при блоке,
// DP218_YT=hard делает жёсткой):
//   1) файловый плеер из «Открыть с помощью» (VIEW-intent mp4 c звуком,
//      MediaStore-грант): <video> UI-webview играет, звук течёт (dumpsys
//      audio uid state:started), foreground-сервис поднят;
//   2) уход в Настройки: 5 с — время видео идёт, звук течёт, сервис жив;
//   3) ещё 15 с в фоне — рендерер не замёрз, процесс не убит;
//   4) HOME — музыка продолжает играть;
//   5) пауза кнопкой уведомления (am startservice ACTION_PAUSE — тот же
//      путь, что «⏸»): видео встало, сервис погас ≤8 с;
//   6) web-оверлей с локальной музыкой (server 10.0.2.2:8898, тап play —
//      в оверлее нужен жест): играет, HOME — играет, сервис жив;
//   7) закрытие оверлея останавливает музыку → сервис гаснет;
//   8) возврат в приложение — UI жив;
//   9) YouTube-embed (soft): вкладка-видео играет → HOME → играет.
// Вкладки duopulse-237 (жалоба «в фоне играют все вкладки — нужна только
// активная»; прежде Kotlin слал playVideo во все iframe разом) — тоже без
// сети: iframe вкладок — ЗАГЛУШКИ с источником youtube (CDP Fetch подменяет
// документ вкладки до сети; локальная страница не годится — targetOrigin
// youtube не совпал бы), часы duo — фейк FAKE_JS UI-страницы (идут, пока
// «вкладка играет», встают на hidden — как медиа под WebView.onPause, — и
// снова идут по playVideo, дошедшему до активной вкладки):
//   10) активная играет → HOME → playVideo дошёл ТОЛЬКО ей, в фоне часы
//       идут, сервис жив; источник — файл / web-оверлей → вкладкам ничего;
//   11) переключился на вкладку на паузе и сразу ушёл → тишина, сервис гаснет;
//   12) «переключился, включил и сразу ушёл» (быстрее тика зонда) → играет
//       включённая, прежняя молчит — и путь «снимок до onPause» подтверждён;
//   13) скачок часов на непроигрываемой вкладке (30→900) — не «играет»;
//   14) файловое видео поверх активной вкладки → в фоне только файл.
// Запуск (debug-APK установлен, приложение запущено, эмулятор поднят):
//   node e2e/mobile/background-audio-smoke.mjs
// Результат — e2e/mobile/background-audio-smoke-last-run.json (gitignore).
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = "dev.duopulse.mobile";
const PORT = Number(process.env.CDP_PORT || 9223);
// 8898 — вне Windows excluded-диапазонов (память duopulse-e2e-windows-excluded-ports)
const HTTP_PORT = Number(process.env.DP218_HTTP_PORT || 8898);
const YT_HARD = process.env.DP218_YT === "hard";
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT = join(HERE, "background-audio-smoke-last-run.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SERIAL =
  process.env.ANDROID_SERIAL ||
  execFileSync("adb", ["devices"], { encoding: "utf8" })
    .split("\n")
    .slice(1)
    .find((l) => l.endsWith("device"))
    ?.split("\t")[0] ||
  "";
const adb = (args, opts = {}) =>
  execFileSync("adb", SERIAL ? ["-s", SERIAL, ...args] : args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 32 * 1024 * 1024,
    ...opts,
  });
const shell = (cmd) => adb(["shell", cmd]);

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};
const soft = (name, ok, extra = "") => {
  results.push({ name, ok: true, soft: true, skipped: !ok });
  console.log(`${ok ? "PASS" : "SKIP"}  ${name} (soft)${extra ? ` — ${extra}` : ""}`);
};

/** Все page-цели CDP приложения (UI-webview + web-оверлей). */
async function pageTargets() {
  return (await (await fetch(`http://localhost:${PORT}/json`)).json()).filter(
    (x) => x.type === "page",
  );
}

async function connect(match) {
  // мёртвые CDP-цели прошлых WebView висят в /json вечно (память проекта):
  // перебираем кандидатов адреса, живой — тот, кто отвечает на пинг
  const cands = (await pageTargets()).filter((x) => match.test(x.url));
  if (!cands.length) throw new Error("нет CDP-цели: " + match);
  let lastErr = null;
  for (const t of cands) {
    try {
      return await connectTarget(t);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("все цели мертвы: " + match);
}

async function connectTarget(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
    setTimeout(() => rej(new Error("ws open таймаут")), 8000);
  });
  let id = 0;
  const pending = new Map();
  const contexts = [];
  const listeners = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      return;
    }
    if (m.method === "Runtime.executionContextCreated")
      contexts.push(m.params.context);
    for (const h of listeners.get(m.method) ?? []) {
      // слушатель стенда не должен рвать соединение
      try { h(m.params); } catch { /* диагностика — в консоли */ }
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      const to = setTimeout(() => {
        pending.delete(i);
        rej(new Error(`CDP ${method}: таймаут 20 с`));
      }, 20000);
      pending.set(i, {
        res: (v) => {
          clearTimeout(to);
          res(v);
        },
        rej: (e) => {
          clearTimeout(to);
          rej(e);
        },
      });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send("Runtime.enable");
  const evalJs = async (expression, contextId) => {
    const r = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      ...(contextId ? { contextId } : {}),
    });
    if (r.exceptionDetails)
      throw new Error(
        "eval: " +
          JSON.stringify(
            r.exceptionDetails.exception?.description ?? r.exceptionDetails.text,
          ).slice(0, 300),
      );
    return r.result.value;
  };
  const invoke = (cmd, args) =>
    evalJs(`window.__TAURI__.core.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
  // живость: мёртвая цель открывает ws, но eval молчит (ловушка duopulse-218)
  const ping = await Promise.race([
    evalJs("1"),
    new Promise((_, rej) => setTimeout(() => rej(new Error("цель не отвечает")), 6000)),
  ]);
  if (ping !== 1) throw new Error("цень не отвечает (пинг)");
  /** Подписка на события CDP-цели (Fetch.requestPaused — вкладки-заглушки). */
  const on = (method, handler) => {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(handler);
  };
  return { url: t.url, evalJs, invoke, contexts, send, on, close: () => ws.close() };
}

async function connectUi() {
  return connect(/tauri\.localhost/);
}

async function waitFor(fn, ms, label, every = 700) {
  for (let gone = ms; gone > 0; gone -= every) {
    const v = await Promise.resolve(fn()).catch(() => false);
    if (v) return v;
    await sleep(every);
  }
  throw new Error(`не дождались: ${label}`);
}

/** Тап в ФИЗИЧЕСКИХ пикселях (CSS × dpr). */
function tap(cssX, cssY, dpr) {
  shell(
    `input tap ${Math.round(cssX * dpr)} ${Math.round(cssY * dpr)}`,
  );
}

// ── системные сигналы ────────────────────────────────────────────────────

/** Живой pid приложения (для проверки своей записи сервиса). */
let APP_PID = "";

/** uid приложения: плеер аудио живёт в рендерере (другой pid, тот же uid). */
const APP_UID = (() => {
  const dump = adb(["shell", "dumpsys", "package", PKG], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const ids = [...dump.matchAll(/(?:userId|uid)=(\d+)/g)].map((m) => m[1]);
  const uid = ids.find((v) => Number(v) >= 10000);
  if (!uid) throw new Error("uid приложения не найден");
  return uid;
})();

/** Звук приложения реально течёт: активный плеер (AudioPlaybackConfiguration)
 *  нашего uid в state:started (строка «u/pid:<uid>/<pid>» — двоеточия только
 *  перед uid, ловушка парсинга duopulse-218). */
function audioFlowing() {
  try {
    const dump = adb(["shell", "dumpsys", "audio"], { maxBuffer: 16 * 1024 * 1024 });
    return dump
      .split(/piid:/)
      .some((b) => b.includes(`u/pid:${APP_UID}/`) && /state:started/.test(b));
  } catch {
    return false;
  }
}

/** Foreground-сервис фоновой музыки жив. Записи сервисов убитых процессов
 *  живут в дампсе какое-то время (ловушка duopulse-218: проверка «сервис
 *  поднят» ложно проходила по мёртвой записи, фон включался раньше зонда) —
 *  блок записи ServiceRecord обязан содержать pid ЖИВОГО процесса. */
function mediaServiceOn() {
  try {
    const dump = adb(["shell", "dumpsys", "activity", "services", PKG], {
      maxBuffer: 16 * 1024 * 1024,
    });
    if (!APP_PID) return false;
    return dump
      .split("ServiceRecord")
      .some(
        (b) =>
          b.includes("MediaPlaybackService") &&
          b.includes("isForeground=true") &&
          b.includes(` ${APP_PID}:`),
      );
  } catch {
    return false;
  }
}

/** logcat-журнал хелпера (в результат — диагностика). */
function mediaLog() {
  try {
    return adb(["logcat", "-d", "-s", "DuoPulseMedia"], { maxBuffer: 8 * 1024 * 1024 })
      .split("\n")
      .filter((l) => l.includes("D"))
      .slice(-30);
  } catch {
    return [];
  }
}

// ── фикстуры ─────────────────────────────────────────────────────────────

/** mp4 с ЗВУКОМ (синус) для файлового плеера и wav для оверлея — ffmpeg
 *  хоста (как video-release-smoke duopulse-179); %TEMP%, не в репо. */
function makeFixtures() {
  const dir = join(tmpdir(), "duopulse-218");
  mkdirSync(dir, { recursive: true });
  const mp4 = join(dir, "duopulse-218-tone.mp4");
  const wav = join(dir, "duopulse-218-tone.wav");
  const ffmpeg = process.env.DP218_FFMPEG || "ffmpeg";
  if (!existsSync(mp4))
    execFileSync(
      ffmpeg,
      ["-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10",
        "-f", "lavfi", "-i", "sine=frequency=440", "-t", "300",
        "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", mp4],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
  if (!existsSync(wav))
    execFileSync(
      ffmpeg,
      ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=480",
        "-ar", "22050", "-ac", "1", "-c:a", "pcm_s16le", wav],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
  return { mp4, wav };
}

/** content-URI MediaStore на файл в /sdcard/Download — как реальный
 *  «Открыть с помощью» (паттерн video-release-smoke duopulse-179: shell не
 *  грантит documents-URI, MediaStore грантит). */
async function mediaUri(name) {
  for (let t = 0; t < 10; t++) {
    let out = "";
    try {
      out = shell(
        `content query --uri content://media/external/video/media ` +
          `--projection _id --where "_display_name='${name}'"`,
      );
    } catch {
      out = "";
    }
    const m = out.match(/_id=(\d+)/);
    if (m) return `content://media/external/video/media/${m[1]}`;
    shell(
      `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE ` +
        `-d file:///sdcard/Download/${encodeURIComponent(name)}`,
    );
    await sleep(1000);
  }
  throw new Error(`MediaStore не увидел ${name}`);
}

// ── вкладки-заглушки (duopulse-237) ───────────────────────────────────────

/** videoId двух вкладок стенда. */
const TAB_A = "dp237aaaa11";
const TAB_B = "dp237bbbb22";

/** Причина реплея в logcat для гонки «включил и сразу ушёл» (см. phase 12). */
const RACE = "шли в момент ухода";

/** «Плеер» вкладки-заглушки: пишет команды IFrame API (func@Date.now()) и
 *  докладывает о них родителю строкой — не JSON, чужие слушатели UI-страницы
 *  её игнорируют. */
const STUB_JS =
  "window.__dpCmds=[];window.__dpId=location.pathname.split('/').pop();" +
  "addEventListener('message',function(e){var d=e.data;" +
  "if(typeof d==='string'){try{d=JSON.parse(d)}catch(x){}}" +
  "if(!d||d.event!=='command')return;" +
  "window.__dpCmds.push(d.func+'@'+Date.now());" +
  "parent.postMessage('__dp:cmd:'+d.func+':'+window.__dpId,'*')});";

/** Документ вкладки-заглушки. */
const TAB_STUB =
  "<!doctype html><meta charset=utf-8>" +
  "<meta name=viewport content=\"width=device-width,initial-scale=1\">" +
  "<body style=\"margin:0;background:#101418;color:#BDFE4F;font:16px system-ui\">" +
  "<div style=\"display:flex;height:100vh;align-items:center;justify-content:center\">" +
  "e2e duopulse-237</div><script>" + STUB_JS + "</scr" + "ipt>";

/** Фейк часов duo UI-страницы (подменяет __duopulseMobileDuo — его читает
 *  зонд Kotlin): часы идут, пока «вкладка играет» (set — рука стенда), встают
 *  на hidden и снова идут по playVideo, дошедшему до активной вкладки. */
const FAKE_JS =
  "(function(){window.__dpRealDuo=window.__dpRealDuo||window.__duopulseMobileDuo;" +
  "var f=window.__dpFake={id:'',playing:false,base:0,at:Date.now()};" +
  "f.now=function(){return f.playing?f.base+(Date.now()-f.at)/1000:f.base};" +
  "f.set=function(id,playing,base){f.id=id;f.base=base==null?f.now():base;" +
  "f.at=Date.now();f.playing=!!playing;return f.now()};" +
  "window.__dpVis=[];" +
  "addEventListener('message',function(e){var s=e.data;" +
  "if(typeof s!=='string'||s.indexOf('__dp:cmd:')!==0)return;" +
  "var p=s.split(':'),func=p[2],id=p[3];if(id!==f.id)return;" +
  "f.base=f.now();f.at=Date.now();f.playing=func==='playVideo';" +
  "window.__dpVis.push(func+'@'+id)});" +
  "addEventListener('visibilitychange',function(){" +
  "window.__dpVis.push((document.hidden?'hidden':'visible')+'@'+Date.now());" +
  "if(document.hidden&&f.playing){f.base=f.now();f.at=Date.now();f.playing=false}});" +
  "window.__duopulseMobileDuo=function(){return{videoId:f.id,clock:f.now()}};return 1})()";

/** Вкладки стенда (duopulse-237): две вкладки, их iframe — заглушки с
 *  источником youtube. Возвращает ручки: set — часы активной вкладки ('' —
 *  вкладки нет), switchTo — строка листа вкладок, cmds — команды вкладки,
 *  playCount — playVideo в обе с последнего reset. Читает вкладки только
 *  через waitFor: «не дождались» не должно выглядеть как «команд не было». */
async function tabStand(ui) {
  await ui.send("Fetch.enable", {
    patterns: [{ urlPattern: "https://www.youtube.com/embed/*", requestStage: "Request" }],
  });
  ui.on("Fetch.requestPaused", (p) => {
    ui.send("Fetch.fulfillRequest", {
      requestId: p.requestId,
      responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
      body: Buffer.from(TAB_STUB).toString("base64"),
    }).catch(() => {});
  });
  await ui.evalJs(FAKE_JS);
  // прошлый прогон мог оборваться во фазе вкладок, а сессия вкладок переживает
  // перезапуск (localStorage) — начинаем без чужих вкладок
  await ui.evalJs(
    `(() => { const s = window.__duopulseMobileTabs(); if (!s.count) return 0;` +
      `window.__duopulseShowTabs(); document.querySelector('.m-tabs-close-all').click();` +
      `return s.count })()`,
  );
  for (const id of [TAB_A, TAB_B])
    await ui.evalJs(`window.__duopulseOpenVideo(${JSON.stringify(id)})`);

  /** Контекст вкладки — iframe в процессе UI-webview (та же CDP-цель). */
  const ctx = async (videoId) => {
    for (const c of ui.contexts) {
      if (c.origin !== "https://www.youtube.com" || !c.auxData?.isDefault) continue;
      const href = await ui.evalJs("location.href", c.id).catch(() => "");
      if (!href.includes(`/embed/${videoId}`)) continue;
      return c.id;
    }
    return null;
  };
  const read = async (videoId) => {
    const c = await waitFor(() => ctx(videoId), 15000, `вкладка ${videoId}`);
    return JSON.parse(await ui.evalJs("JSON.stringify(window.__dpCmds)", c));
  };
  return {
    set: (id, playing, base) =>
      ui.evalJs(`window.__dpFake.set(${JSON.stringify(id)},${!!playing},${base ?? "null"})`),
    /** Строка листа вкладок — DOM-клик (тот же обработчик, что у тапа). */
    switchTo: async (videoId) => {
      const ok = await ui.evalJs(
        `(() => { window.__duopulseShowTabs();` +
          `const i = window.__duopulseMobileTabs().tabs.findIndex((t) => t.videoId === ${JSON.stringify(videoId)});` +
          `const row = document.querySelectorAll('.m-tabs-sheet .m-tabs-main')[i];` +
          `if (!row) return false; row.click(); return true })()`,
      );
      if (!ok) throw new Error("строка вкладки не найдена: " + videoId);
    },
    cmds: read,
    reset: async () => {
      for (const id of [TAB_A, TAB_B]) {
        const c = await ctx(id);
        if (c) await ui.evalJs("window.__dpCmds.length=0", c);
      }
    },
    playCount: async () => {
      let n = 0;
      for (const id of [TAB_A, TAB_B])
        n += (await read(id)).filter((x) => x.startsWith("playVideo@")).length;
      return n;
    },
    /** Часы активной вкладки идут (два замера). */
    advancing: async () => {
      const a = await ui.evalJs("window.__dpFake.now()");
      await sleep(2500);
      return (await ui.evalJs("window.__dpFake.now()")) > a + 0.5;
    },
    vis: () => ui.evalJs("JSON.stringify(window.__dpVis.slice(-24))"),
  };
}

// ── сценарий ─────────────────────────────────────────────────────────────

const main = async () => {
  const { mp4, wav } = makeFixtures();
  // локальная музыка для web-оверлея (эмулятор видит хост как 10.0.2.2)
  const wavBytes = readFileSync(wav);
  const server = createServer((req, res) => {
    if (req.url === "/tone.wav") {
      res.writeHead(200, {
        "Content-Type": "audio/wav",
        "Content-Length": wavBytes.length,
        "Accept-Ranges": "bytes",
      });
      res.end(wavBytes);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">` +
        `<audio id=a src=/tone.wav loop></audio>` +
        `<button id=p style="position:fixed;inset:0;font-size:40px;background:#111;color:#BDFE4F">▶ играть</button>` +
        `<script>p.onclick=()=>{a.play();p.textContent="…играет"}</script>`,
    );
  });
  await new Promise((r) => server.listen(HTTP_PORT, "0.0.0.0", r));

  const pid = shell(`pidof ${PKG}`).trim();
  if (!pid) throw new Error("приложение не запущено (am start " + PKG + ")");
  APP_PID = pid;
  adb(["forward", `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`]);

  // чистый старт: закрыть оверлей/плеер, домой, приложение на передний план
  shell(`am start -n ${PKG}/.MainActivity`);
  await sleep(1500);
  // цель UI-webview появляется не сразу после холодного старта (переустановка
  // APK + force-stop): ждём её, а не первый же /json
  const ui = await waitFor(() => connectUi(), 20000, "CDP-цель UI-webview", 1000);
  await ui.invoke("mobile_web_close", {}).catch(() => {});
  await ui.evalJs(`window.__duopulseGoHome && window.__duopulseGoHome()`);
  await sleep(1200);

  // вкладки-заглушки duopulse-237 весь смоук лежат в фоне без активной —
  // фазы 218 идут на чистом старте, как прежде; проверки «вкладкам ничего»
  // внутри фаз 4 и 6 (источник — файл / web-оверлей)
  const tab = await tabStand(ui);
  await ui.evalJs(`window.__duopulseGoHome && window.__duopulseGoHome()`);
  await sleep(800);
  /** playVideo среди команд вкладки. */
  const plays = (list) => list.filter((x) => x.startsWith("playVideo@")).length;
  /** Метка времени устройства; logcat хелпера С метки — по времени, а не по
   *  номеру строки: кольцо буфера чужими логами фазу не рвёт. */
  const mark = () => shell("date '+%m-%d %H:%M:%S.000'").trim();
  const since = (m) =>
    shell(`logcat -d -s DuoPulseMedia -T '${m}'`)
      .split("\n")
      .filter((l) => / D DuoPulseMedia\b/.test(l));
  /** Причина реплея из строки «вкладка перезапущена (…; причина)». */
  const reasonOf = (lines) => {
    const l = lines.find((x) => x.includes("вкладка перезапущена"));
    const m = l && l.match(/;\s*([^)]*)\)\s*$/);
    return m ? m[1] : "";
  };

  // ── Фаза 1: файловый плеер из «Открыть с помощью» ──────────────────────
  adb(["push", mp4, "/sdcard/Download/duopulse-218-tone.mp4"]);
  const uri = await mediaUri("duopulse-218-tone.mp4");
  adb(["shell", "am", "start", "-a", "android.intent.action.VIEW",
    "-d", uri, "-t", "video/mp4", "--grant-read-uri-permission",
    "-n", `${PKG}/.MainActivity`]);
  const playerPlays = () =>
    ui.evalJs(
      `(() => { const v = document.querySelector('.m-video-el'); return !!v && !v.paused && v.currentTime > 0 })()`,
    ).catch(() => false);
  await waitFor(playerPlays, 30000, "файловый плеер открылся и играет (autoplay)");
  check("1. файловый плеер играет (autoplay из VIEW-intent)", true);

  await waitFor(mediaServiceOn, 12000, "foreground-сервис фоновой музыки");
  check("2. сервис фоновой музыки поднят (isForeground)", true);

  // стабилизация: видео обязано устойчиво идти перед уходом в фон (уход
  // через полсекунды после старта — гонка с 2-секундным тиком зонда, так
  // реальные пользователи не переключаются; зонд должен успеть увидеть игру)
  await waitFor(async () => {
    const a = await ui.evalJs(`document.querySelector('.m-video-el')?.currentTime ?? -1`);
    await sleep(2500);
    const b = await ui.evalJs(`document.querySelector('.m-video-el')?.currentTime ?? -1`);
    return b > a + 1;
  }, 20000, "видео устойчиво играет (стабилизация)");

  // ── Фаза 2: уход в Настройки ───────────────────────────────────────────
  shell("am start -a android.settings.SETTINGS");
  await sleep(4500);
  const t1 = await ui.evalJs(`document.querySelector('.m-video-el')?.currentTime ?? -1`);
  await sleep(3000);
  const t2 = await ui.evalJs(`document.querySelector('.m-video-el')?.currentTime ?? -1`);
  check(
    "3. в другом приложении видео идёт (время растёт)",
    t2 > t1 + 1,
    `t ${t1?.toFixed?.(1)}→${t2?.toFixed?.(1)}`,
  );
  check("3. в другом приложении звук течёт (dumpsys audio uid started)", audioFlowing());

  // ── Фаза 3: долгий фон ─────────────────────────────────────────────────
  await sleep(15000);
  const t3 = await ui.evalJs(`document.querySelector('.m-video-el')?.currentTime ?? -1`);
  check("4. фон 15+ секунд: видео всё ещё идёт", t3 > t2 + 10, `t≈${t3?.toFixed?.(1)}`);
  check("4. фон 15+ секунд: сервис жив", mediaServiceOn());

  // ── Фаза 4: HOME ───────────────────────────────────────────────────────
  shell("input keyevent 3");
  await sleep(5000);
  const t4 = await ui.evalJs(`document.querySelector('.m-video-el')?.currentTime ?? -1`);
  check("5. HOME: музыка продолжает играть", t4 > t3 + 3, `t≈${t4?.toFixed?.(1)}`);
  check("5. HOME: звук течёт", audioFlowing());
  // duopulse-237: источник — файл, вкладки не заводятся (прежде playVideo
  // после паузы уходил во все iframe разом)
  check(
    "5. HOME: вкладки не заводятся (источник — файловое видео)",
    (await tab.playCount()) === 0,
  );

  // ── Фаза 5: пауза кнопкой «⏸» уведомления (ACTION_PAUSE сервиса — тот же
  // путь, что PendingIntent уведомления; shell-uid чужой сервис не пускает,
  // run-as приложения + --user 0 проходит)
  shell(
    `run-as ${PKG} am startservice --user 0 -n ${PKG}/.MediaPlaybackService -a dev.duopulse.media.PAUSE`,
  );
  await sleep(1500);
  const p1 = await ui.evalJs(`document.querySelector('.m-video-el')?.currentTime ?? -1`);
  await sleep(3000);
  const p2 = await ui.evalJs(`document.querySelector('.m-video-el')?.currentTime ?? -1`);
  check(
    "6. «⏸» остановила плеер",
    Math.abs(p2 - p1) < 0.2,
    `t ${p1?.toFixed?.(1)}→${p2?.toFixed?.(1)}`,
  );
  await waitFor(() => !mediaServiceOn(), 12000, "сервис погас после паузы");
  check("6. сервис фоновой музыки погашен", true);

  // ── Фаза 6: музыка в web-оверлее (локальная страница) ──────────────────
  shell(`am start -n ${PKG}/.MainActivity`);
  await sleep(2000);
  // уникальный ?r= на открытие: мёртвые CDP-цели прошлых WebView висят в
  // /json вечно и совпадают адресом (ловушка duopulse-211/218)
  const ovR = Date.now();
  await ui.invoke("mobile_web_open", {
    url: `http://10.0.2.2:${HTTP_PORT}/music.html?r=${ovR}`,
    incognito: false,
  });
  await sleep(2500);
  const ov = await connect(new RegExp(`music\\.html\\?r=${ovR}`));
  const dpr = await ov.evalJs("window.devicePixelRatio || 1");
  // тап «▶» (в оверлее медиа требует жеста) — кнопка на весь экран
  await waitFor(async () => {
    const r = JSON.parse(
      await ov.evalJs(`JSON.stringify(document.getElementById('p').getBoundingClientRect())`),
    );
    tap(r.x + r.width / 2, r.y + r.height / 2, dpr);
    return ov.evalJs(`(() => { const a = document.getElementById('a'); return !!a && !a.paused })()`);
  }, 20000, "тап play в оверлее");
  check("7. музыка в web-оверлее играет (тап play)", true);

  await waitFor(mediaServiceOn, 12000, "сервис по музыке оверлея");
  check("7. сервис фоновой музыки поднят (источник — оверлей)", true);

  shell("input keyevent 3"); // HOME
  await sleep(5000);
  check(
    "8. HOME: музыка оверлея продолжает играть",
    (await ov
      .evalJs(`(() => { const a = document.getElementById('a'); return !!a && !a.paused })()`)
      .catch(() => false)) === true,
  );
  check("8. HOME: звук течёт", audioFlowing());
  check("8. HOME: сервис жив", mediaServiceOn());
  check("8. HOME: вкладки не заводятся (источник — web-оверлей)", (await tab.playCount()) === 0);

  // закрытие оверлея останавливает музыку → сервис гаснет (invoke может
  // отклониться промисом при повторном закрытии — не роняет стенд)
  await ui.invoke("mobile_web_close", {}).catch(() => {});
  await waitFor(() => !mediaServiceOn(), 12000, "сервис погас после закрытия оверлея");
  check("9. закрытие оверлея остановило музыку (сервис погас)", true);

  // ── Фаза 7: возврат в приложение ───────────────────────────────────────
  shell(`am start -n ${PKG}/.MainActivity`);
  await sleep(2000);
  const st = await ui.evalJs(
    `window.__duopulseHeaderState ? window.__duopulseHeaderState().tabs >= 0 : false`,
  );
  check("10. возврат: UI жив (headerState отвечает)", st === true);
  ov.close();

  // ── Фаза 7b (duopulse-237): в фоне играет ТОЛЬКО активная вкладка ───────
  // Жалоба: «играют все вкладки, а нужно чтобы играла только активная» —
  // прежде Kotlin после onPause-паузы слал playVideo во все iframe разом.
  const home = () => shell("input keyevent 3");
  const back = async () => {
    shell(`am start -n ${PKG}/.MainActivity`);
    await sleep(2000);
  };

  // A. активная играет → HOME → перезапущена только она, в фоне идёт
  await ui.evalJs(`window.__duopulseGoHome && window.__duopulseGoHome()`); // файловый плеер прочь
  await tab.set("", false, 0);
  await waitFor(() => !mediaServiceOn(), 30000, "сервис погашен перед фазой вкладок");
  await tab.switchTo(TAB_B);
  await tab.set(TAB_B, true, 100);
  await waitFor(mediaServiceOn, 12000, "сервис по часам duo активной вкладки");
  check("14. сервис фоновой музыки поднят по часам duo активной вкладки", true);
  await sleep(1500); // ещё тик зонда: кэш «играет» — о вкладке B
  await tab.reset();
  let m = mark();
  await home();
  await sleep(3000);
  const [a1, b1] = [await tab.cmds(TAB_A), await tab.cmds(TAB_B)];
  check(
    "15. HOME: активная вкладка перезапущена (playVideo дошёл ей)",
    plays(b1) === 1,
    `команды B: ${b1.join(",") || "—"}`,
  );
  check(
    "16. HOME: фоновая вкладка НЕ запущена (playVideo не было)",
    plays(a1) === 0,
    `команды A: ${a1.join(",") || "—"}`,
  );
  const logA = since(m);
  check(
    "17. logcat: «вкладка перезапущена (только активная: 1; …)»",
    logA.some((l) => l.includes("только активная: 1")),
    reasonOf(logA),
  );
  await sleep(5000); // суммарно ≥8 с в фоне
  check("18. в фоне часы активной вкладки идут, сервис жив", (await tab.advancing()) && mediaServiceOn());
  await back();

  // B. играла B → переключился на стоящую на паузе A и сразу ушёл: в фоне тишина
  await tab.reset();
  await tab.switchTo(TAB_A);
  await tab.set(TAB_A, false, 30);
  await home();
  await sleep(3000);
  const [a2, b2] = [await tab.cmds(TAB_A), await tab.cmds(TAB_B)];
  check("19. переключился на вкладку на паузе и сразу ушёл: она НЕ заведена", plays(a2) === 0);
  check("20. … прежняя (играла до переключения) тоже молчит", plays(b2) === 0);
  await waitFor(() => !mediaServiceOn(), 30000, "сервис погашен (в фоне никто не играет)");
  check("21. в фоне никто не играет — сервис погашен", true);
  await back();

  // C. играла B → переключился на A, включил и сразу ушёл — быстрее тика
  // зонда: играет A, B молчит. До 4 раундов: в окно «переключение → HOME»
  // (~0,4 с) тик попадает не каждый раз, а путь «снимок до onPause» (RACE)
  // подтверждается только чистым раундом
  const reasons = [];
  for (let round = 1; round <= 4; round++) {
    await tab.switchTo(TAB_B);
    await tab.set(TAB_B, true, 200);
    await waitFor(mediaServiceOn, 12000, "сервис (вкладка B играет)");
    await sleep(1500);
    await tab.reset();
    m = mark();
    await tab.switchTo(TAB_A);
    await tab.set(TAB_A, true, 30);
    await home();
    await sleep(3000);
    const [a3, b3] = [await tab.cmds(TAB_A), await tab.cmds(TAB_B)];
    const reason = reasonOf(since(m));
    reasons.push(reason || "(реплея не было)");
    check(
      `22. «переключился, включил и сразу ушёл» (раунд ${round}): играет включённая, прежняя молчит`,
      plays(a3) === 1 && plays(b3) === 0,
      reason || "реплея не было",
    );
    await back();
    if (reason === RACE) break;
  }
  check(
    "23. путь «шли в момент ухода» подтверждён: снимок до onPause раньше паузы",
    reasons.includes(RACE),
    reasons.join(" / "),
  );

  // D. обе на паузе; переключение на «давно смотренную» — часы прыгнули
  // (30→900): игрой не считается, сервис не поднимается
  await tab.set(TAB_A, false);
  await waitFor(() => !mediaServiceOn(), 30000, "сервис погашен (обе вкладки на паузе)");
  m = mark();
  await tab.switchTo(TAB_B);
  await tab.set(TAB_B, false, 900);
  await sleep(5500); // ≥2 тиков зонда о новой вкладке
  check(
    "24. скачок часов на непроигрываемой вкладке не поднимает сервис (ложного «играет» нет)",
    !since(m).some((l) => l.includes("playback-on")) && !mediaServiceOn(),
  );
  await tab.reset();
  await home();
  await sleep(5000);
  const [a4, b4] = [await tab.cmds(TAB_A), await tab.cmds(TAB_B)];
  check("25. HOME на паузе: ни одна вкладка не заведена", plays(a4) === 0 && plays(b4) === 0);
  await waitFor(() => !mediaServiceOn(), 30000, "сервис погашен (фон, обе на паузе)");
  check("26. в фоне тишина — сервис погашен", true);
  await back();

  // E. файловое видео поверх активной вкладки («Открыть с помощью» не снимает
  // вкладку с активной): в фоне перезапускается файл, вкладка молчит
  await tab.switchTo(TAB_B);
  adb(["shell", "am", "start", "-a", "android.intent.action.VIEW",
    "-d", uri, "-t", "video/mp4", "--grant-read-uri-permission",
    "-n", `${PKG}/.MainActivity`]);
  await waitFor(playerPlays, 30000, "файловый плеер поверх вкладки");
  await waitFor(mediaServiceOn, 12000, "сервис по файловому видео");
  await sleep(2500);
  const e0 = await ui.evalJs(`document.querySelector('.m-video-el')?.currentTime ?? -1`);
  await tab.reset();
  await home();
  await sleep(5000);
  const e1 = await ui.evalJs(`document.querySelector('.m-video-el')?.currentTime ?? -1`);
  check("27. файловое видео поверх активной вкладки: в фоне идёт файл", e1 > e0 + 3, `t ${e0?.toFixed?.(1)}→${e1?.toFixed?.(1)}`);
  check("28. … вкладка под плеером НЕ заведена", (await tab.playCount()) === 0);
  await back();
  // плеер заглушить тем же путём, что «⏸» уведомления
  shell(
    `run-as ${PKG} am startservice --user 0 -n ${PKG}/.MediaPlaybackService -a dev.duopulse.media.PAUSE`,
  );
  await sleep(1500);

  const tabDiag = { reasons, vis: JSON.parse(await tab.vis().catch(() => "[]")) };

  // вкладки-заглушки прочь (мягкая фаза YouTube ниже открывает настоящую),
  // часы duo — настоящие, перехват Fetch снят
  const left = await ui.evalJs(
    `(() => { window.__duopulseGoHome(); window.__duopulseShowTabs();` +
      `document.querySelector('.m-tabs-close-all').click();` +
      `window.__duopulseMobileDuo = window.__dpRealDuo;` +
      `return window.__duopulseMobileTabs().count })()`,
  );
  await ui.send("Fetch.disable");
  check("29. вкладки-заглушки закрыты, сессия вкладок чиста (не мешает другим стендам)", left === 0);

  // ── Фаза 8 (soft): YouTube-embed ───────────────────────────────────────
  await ui.evalJs(`window.__duopulseGoHome && window.__duopulseGoHome()`);
  await sleep(1200);
  await ui.evalJs(`document.querySelector('.m-quick[data-url]').click()`);
  await waitFor(
    () =>
      ui.evalJs(
        `!!document.querySelector('iframe.m-tab:not([hidden])') && document.querySelector('#mStart').hidden`,
      ),
    25000,
    "вкладка-видео с embed-плеером",
  );
  const ytCtx = async () => {
    const src = await ui.evalJs(
      `document.querySelector('iframe.m-tab:not([hidden])')?.src || ''`,
    );
    for (const c of ui.contexts) {
      if (c.origin !== "https://www.youtube.com") continue;
      const href = await ui.evalJs("location.href", c.id).catch(() => "");
      if (href && href === src) return c.id;
    }
    return null;
  };
  // грузится ли вообще (rate-limit окружения даёт readyState 0 навсегда)
  const ytLoaded = await waitFor(async () => {
    const c = await ytCtx();
    return c && (await ui.evalJs(
      `(v => v ? v.readyState > 0 : false)(document.querySelector('video'))`, c,
    ).catch(() => false));
  }, 90000, "YouTube-embed загрузился (readyState>0)").catch(() => false);

  if (!ytLoaded) {
    soft("11-13. YouTube-embed в фоне", false, "бит-блок окружения (readyState 0)");
  } else {
    const dprUi = await ui.evalJs("window.devicePixelRatio || 1");
    const ytPlays = async () => {
      const c = await ytCtx();
      return c && (await ui.evalJs(
        `(v => v ? !v.paused : false)(document.querySelector('video'))`, c,
      ).catch(() => false));
    };
    await waitFor(async () => {
      if (await ytPlays()) return true;
      const c = await ytCtx();
      if (!c) return false;
      const v = JSON.parse(await ui.evalJs(
        `(v => v ? JSON.stringify(v.getBoundingClientRect()) : null)(document.querySelector('video'))`, c,
      ).catch(() => null));
      const off = JSON.parse(await ui.evalJs(
        `JSON.stringify((r => ({x:r.x,y:r.y}))(document.querySelector('iframe.m-tab:not([hidden])').getBoundingClientRect()))`,
      ));
      if (v) tap(off.x + v.x + v.width / 2, off.y + v.y + v.height / 2, dprUi);
      return false;
    }, 60000, "play тапом (видео-элемент embed играет)");
    soft("11. YouTube-видео играет (тап play)", true);

    const c1 = await ytPlays();
    shell("input keyevent 3");
    await sleep(5000);
    const c2 = await ytPlays();
    soft("12. HOME: YouTube-музыка играет в фоне", c2 === true, c2 ? "" : "плеер встал");
    soft("13. HOME: сервис жив (YouTube)", mediaServiceOn());
    if (YT_HARD && (!c1 || !c2 || !mediaServiceOn()))
      throw new Error("DP218_YT=hard: YouTube-фаза обязана проходить");
  }
  ui.close();

  const ok = results.every((r) => r.ok);
  writeFileSync(
    OUT,
    JSON.stringify(
      { ok, results, log: mediaLog(), tabs: tabDiag, at: new Date().toISOString() },
      null,
      2,
    ),
  );
  console.log(
    ok
      ? `\nВСЕ ${results.filter((r) => !r.skipped).length} ЖЁСТКИХ ПРОВЕРОК ПРОШЛИ (soft: ${results.filter((r) => r.skipped).length})`
      : `\nЕСТЬ ПРОВАЛЫ: ${results.filter((r) => !r.ok).length}/${results.length}`,
  );
  server.close();
  process.exit(ok ? 0 : 1);
};

main().catch((e) => {
  results.push({ name: "стенд упал", ok: false, error: String(e.message || e) });
  writeFileSync(OUT, JSON.stringify({ ok: false, results, log: mediaLog() }, null, 2));
  console.error("FAIL: " + (e.stack || e));
  process.exit(1);
});
