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
  return { url: t.url, evalJs, invoke, contexts, close: () => ws.close() };
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
  const ui = await connectUi();
  await ui.invoke("mobile_web_close", {}).catch(() => {});
  await ui.evalJs(`window.__duopulseGoHome && window.__duopulseGoHome()`);
  await sleep(1200);

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
    JSON.stringify({ ok, results, log: mediaLog(), at: new Date().toISOString() }, null, 2),
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
