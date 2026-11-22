// E2E-стенд duopulse-217 «поворот телефона разворачивает видео, кнопка
// «на весь экран» разворачивает и сворачивает»: debug-APK + CDP webview_devtools_remote
// (порт 9223, конвенция мобильных смоуков). Контролы YouTube-плеера показываются
// только по РЕАЛЬНОМУ тачу — тапы/повороты через adb (в ФИЗИЧЕСКИХ пикселях:
// CSS-координаты × devicePixelRatio). Кнопка fullscreen меряется ИЗНУТРИ
// embed-контекста (executionContextCreated: кросс-доменный фрейм не виден из
// родительского документа, но живёт в том же рендерере). Поворот — ручной
// (accelerometer_rotation 0 + user_rotation 0/1), предсказуемо для проверок.
// Результат — e2e/mobile/rotate-fullscreen-smoke-last-run.json (gitignore).
// Прогон: эмулятор с debug-сборкой запущен, затем
//   node e2e/mobile/rotate-fullscreen-smoke.mjs
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const PORT = process.env.CDP_PORT || 9223;
const ADB = process.env.ANDROID_HOME
  ? `${process.env.ANDROID_HOME}\\platform-tools\\adb.exe`
  : "adb";
const SERIAL =
  process.env.ANDROID_SERIAL ||
  execFileSync(ADB, ["devices"], { encoding: "utf8" })
    .split("\n")
    .slice(1)
    .find((l) => l.endsWith("device"))
    ?.split("\t")[0] ||
  "";
const adb = (...args) =>
  execFileSync(ADB, SERIAL ? ["-s", SERIAL, ...args] : args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 16 * 1024 * 1024,
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Смена системной настройки с ретраем: на поворотах adb иногда отклоняет
 *  команду (переход экрана) — повтор через секунду спасает прогон. */
async function putSetting(...args) {
  for (let i = 0; i < 3; i++) {
    try {
      adb("shell", "settings", "put", ...args);
      return;
    } catch {
      if (i === 2) throw new Error("settings put не прошёл: " + args.join(" "));
      await sleep(1000);
    }
  }
}

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

async function pageTargets() {
  return (await (await fetch(`http://localhost:${PORT}/json`)).json()).filter(
    (x) => x.type === "page",
  );
}

/** Свежий CDP-коннект к UI-webview Tauri (цель tauri.localhost). */
async function connectUi() {
  const t = (await pageTargets()).find((x) => /tauri\.localhost/.test(x.url));
  if (!t) throw new Error("нет CDP-цели UI-webview (tauri.localhost)");
  return connect(t);
}

/** CDP-коннект с перечислением контекстов исполнения (embed — отдельный
 *  контекст того же рендерера). */
async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
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
          ).slice(0, 400),
      );
    return r.result.value;
  };
  return { url: target.url, evalJs, contexts, close: () => ws.close() };
}

async function waitFor(fn, ms, label, every = 500) {
  for (let gone = ms; gone > 0; gone -= every) {
    const v = await fn().catch(() => false);
    if (v) return v;
    await sleep(every);
  }
  throw new Error(`не дождались: ${label}`);
}

/** Контекст АКТИВНОГО embed: контекстов youtube может быть много (вкладки
 *  прошлых сессий живы в /json), выбираем по href === src видимого iframe. */
async function embedCtxId(ui) {
  if (ui.__embedCtx !== undefined) return ui.__embedCtx;
  const src = await ui.evalJs(
    `document.querySelector('iframe.m-tab:not([hidden])')?.src || ''`,
  );
  for (const c of ui.contexts) {
    if (c.origin !== "https://www.youtube.com") continue;
    const href = await ui.evalJs("location.href", c.id).catch(() => "");
    if (href && href === src) {
      ui.__embedCtx = c.id;
      return c.id;
    }
  }
  throw new Error("нет контекста активного youtube-embed");
}

/** Оценка в контексте активного youtube-embed. */
async function evalEmbed(ui, expression) {
  return ui.evalJs(expression, await embedCtxId(ui));
}

/** Реальный тач по CSS-прямоугольнику страницы (ФИЗИЧЕСКИЕ пиксели = CSS × dpr). */
async function tapRect(ui, cssRect) {
  const k = await ui.evalJs("window.devicePixelRatio || 1");
  const x = Math.round((cssRect.x + cssRect.width / 2) * k);
  const y = Math.round((cssRect.y + cssRect.height / 2) * k);
  adb("shell", "input", "tap", String(x), String(y));
}

/** Прямоугольник из embed-контекста → координаты страницы: у кросс-доменного
 *  фрейма своя система координат от его левого верхнего угла, тап считает
 *  adb по странице целиком — добавляем смещение iframe на странице. */
async function embedRectToPage(ui, inner) {
  const off = JSON.parse(
    await ui.evalJs(
      `JSON.stringify((r => ({x:r.x,y:r.y}))(document.querySelector('iframe.m-tab:not([hidden])').getBoundingClientRect()))`,
    ),
  );
  return { x: inner.x + off.x, y: inner.y + off.y, width: inner.w, height: inner.h };
}

/** Снимок геометрии плеера/хрома для проверок и отладки. */
const snap = (ui) =>
  ui.evalJs(`(() => {
    const f = document.querySelector('iframe.m-tab:not([hidden])');
    const bar = document.querySelector('.m-bar');
    const r = f && f.getBoundingClientRect();
    return JSON.stringify({
      rotateFull: document.querySelector('#mobile').classList.contains('m-rotate-full'),
      fs: document.fullscreenElement ? String(document.fullscreenElement.tagName) : null,
      frame: r && { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      barShown: bar ? getComputedStyle(bar).display !== 'none' : null,
      iw: innerWidth, ih: innerHeight,
      landscape: matchMedia('(orientation: landscape)').matches,
      startHidden: document.querySelector('#mStart').hidden,
    }) })()`);

/** Статус-бар системы: видим ли — InsetsSource type=statusBars из dumpsys
 *  window; null, если парсинг не удался (проверка мягкая, решают CSS/геометрия). */
function statusBarVisible() {
  try {
    const dump = adb("shell", "dumpsys", "window");
    const line = String(dump)
      .split("\n")
      .find((l) => l.includes("type=statusBars") && l.includes("visible="));
    if (!line) return null;
    return /visible=true/.test(line);
  } catch {
    return null;
  }
}

const main = async () => {
  // 0. форвард CDP к живому UI-webview (pid приложения)
  const pid =
    adb("shell", "pidof", "dev.duopulse.mobile").trim() ||
    adb("shell", "pidof", "com.duopulse.mobile").trim();
  if (!pid) throw new Error("приложение не запущено (am start dev.duopulse.mobile)");
  adb("forward", `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`);
  // Иммерсивный режим: первичный системный «swipe down»-оверлей
  // (ImmersiveModeConfirmation) перехватывает фокус и глотает системный
  // «назад» — подтверждаем заранее (флаг живёт в secure, global — на старых
  // образах; без него окно висит над приложением и «назад» не доходит)
  adb("shell", "settings", "put", "secure", "immersive_mode_confirmations", "confirmed");
  adb("shell", "settings", "put", "global", "immersive_mode_confirmations", "confirmed");

  // 1. портрет + ручной поворот (прогнозируемо), «домой» — чистый старт
  await putSetting("system", "accelerometer_rotation", "0");
  await putSetting("system", "user_rotation", "0");
  const ui = await connectUi();
  await ui.evalJs("window.__duopulseGoHome && window.__duopulseGoHome()");
  await sleep(1500);

  // 2. открыть видео (кнопка-пример TED на старте) — встроенный плеер
  await ui.evalJs(`document.querySelector('.m-quick[data-url]').click()`);
  await waitFor(
    () => ui.evalJs(`(() => { const f = document.querySelector('iframe.m-tab:not([hidden])');
      return !!f && /embed\\//.test(f.src) && document.querySelector('#mStart').hidden })()`),
    25000,
    "вкладка-видео с embed-плеером",
  );
  await waitFor(
    () => evalEmbed(ui, `!!document.querySelector('video')`).catch(() => false),
    25000,
    "видео-элемент в embed",
  );
  // лейаут устоялся (iframe только что показан — rect успел стать 0×0)
  await waitFor(
    async () => {
      const r = await ui.evalJs(
        `(() => { const r = document.querySelector('iframe.m-tab:not([hidden])').getBoundingClientRect(); return r.width > 50 && r.height > 50 })()`,
      );
      return r === true;
    },
    15000,
    "iframe разложился",
  );
  let s = JSON.parse(await snap(ui));
  check(
    "портрет: видео открыто, полного экрана нет",
    !s.rotateFull && s.barShown && s.frame && s.frame.y > 0,
    JSON.stringify(s.frame),
  );

  // 3. запустить воспроизведение (центр плеера — большой play), кнопка
  // fullscreen до старта может молчать
  const playerRect0 = await embedRectToPage(
    ui,
    JSON.parse(
      await evalEmbed(
        ui,
        `JSON.stringify((r => ({x:r.x,y:r.y,w:r.width,h:r.height}))(document.querySelector('#movie_player, video').getBoundingClientRect()))`,
      ),
    ),
  );
  await waitFor(
    async () => {
      const playing = await evalEmbed(
        ui,
        `(() => { const v = document.querySelector('video'); return !!v && !v.paused })()`,
      ).catch(() => false);
      if (playing) return true;
      await tapRect(ui, playerRect0); // плеер мог не быть готов — тап повторится
      await sleep(1500);
      return false;
    },
    30000,
    "видео играет",
  );

  // 4. ПОВОРОТ В ЛАНДШАФТ: видео разворачивается на весь экран
  await putSetting("system", "user_rotation", "1");
  await waitFor(
    async () => JSON.parse(await snap(ui)).rotateFull,
    15000,
    "класс .m-rotate-full по повороту",
  );
  await sleep(1200); // инсеты/лейаут устоялись
  s = JSON.parse(await snap(ui));
  check(
    "ландшафт: видео на весь экран (шапки нет, iframe = вьюпорт)",
    s.rotateFull && !s.barShown && s.frame.x === 0 && s.frame.y === 0 &&
      s.frame.w === s.iw && s.frame.h === s.ih,
    JSON.stringify(s.frame),
  );
  check(
    "ландшафт: системные панели спрятаны",
    statusBarVisible() !== true,
    `statusBar=${statusBarVisible()}`,
  );

  // 5. ПОВОРОТ ОБРАТНО: прежний вид
  await putSetting("system", "user_rotation", "0");
  await waitFor(
    async () => !(JSON.parse(await snap(ui))).rotateFull,
    15000,
    "снятие .m-rotate-full в портрете",
  );
  await sleep(1200);
  s = JSON.parse(await snap(ui));
  check(
    "портрет: полный экран снят, шапка вернулась",
    !s.rotateFull && s.barShown && s.frame.y > 0,
    JSON.stringify(s.frame),
  );
  check(
    "портрет: системные панели видны",
    statusBarVisible() !== false,
    `statusBar=${statusBarVisible()}`,
  );

  // 6. КНОПКА «⛶» ШАПКИ В ПОРТРЕТЕ: полный экран + доворот в ландшафт.
  // Fullscreen API плеера запрещён (allow iframe) — современный WebView
  // обрабатывает его внутренне, мимо onShowCustomView; разворачивает только
  // наша кнопка (duopulse-217).
  const expandRect = () =>
    ui.evalJs(`(() => { const b = document.querySelector('#mExpand');
      if (!b || b.hidden) return null; const r = b.getBoundingClientRect();
      return r.width > 0 ? JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height }) : null })()`);
  const expandBtn = await waitFor(
    async () => (await expandRect().catch(() => null)) ?? false,
    10000,
    "кнопка «⛶» шапки видна",
  );
  await tapRect(ui, JSON.parse(expandBtn));
  await waitFor(
    async () => JSON.parse(await snap(ui)).rotateFull,
    15000,
    "полный экран по кнопке «⛶»",
  );
  await waitFor(
    async () => JSON.parse(await snap(ui)).landscape,
    20000,
    "доворот экрана в ландшафт (requestedOrientation)",
  );
  s = JSON.parse(await snap(ui));
  check(
    "кнопка ⛶: полный экран + экран в ландшафте",
    s.rotateFull && s.landscape && !s.barShown,
    "",
  );
  check(
    "кнопка ⛶: плавающая «⛶»-выход поверх видео видна",
    await ui.evalJs(`!document.querySelector('.m-fs-exit').hidden`),
    "",
  );

  // 7. СИСТЕМНЫЙ «НАЗАД»: выход из полного экрана, экран в портрет,
  //    приложение ЖИВО (прежде пустая история WebView финишила активность)
  adb("shell", "input", "keyevent", "4");
  await waitFor(
    async () => !(JSON.parse(await snap(ui))).rotateFull,
    20000,
    "выход из полного экрана «назад»",
  );
  await waitFor(
    async () => !(JSON.parse(await snap(ui))).landscape,
    20000,
    "возврат экрана в портрет",
  );
  await sleep(800);
  s = JSON.parse(await snap(ui));
  check(
    "«назад»: полный экран снят, портрет, шапка вернулась",
    !s.rotateFull && !s.landscape && s.barShown,
    "",
  );
  check(
    "«назад»: приложение живо",
    adb("shell", "pidof", "dev.duopulse.mobile").trim().length > 0,
    "",
  );

  // 7b. ПЛАВАЮЩАЯ «⛶»: вход кнопкой шапки — выход плавающей (без поворота)
  await tapRect(ui, JSON.parse(await expandRect()));
  await waitFor(
    async () => JSON.parse(await snap(ui)).rotateFull,
    15000,
    "повторный вход по «⛶» (7b)",
  );
  const exitRectJs = `(() => { const b = document.querySelector('.m-fs-exit');
    if (!b || b.hidden) return null; const r = b.getBoundingClientRect();
    return r.width > 0 ? JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height }) : null })()`;
  await waitFor(
    async () => (await ui.evalJs(exitRectJs).catch(() => null)) ?? false,
    10000,
    "плавающая «⛶» видна",
  );
  await sleep(1200); // доворот экрана устоялся — тап по старым координатам мимо
  await waitFor(
    async () => {
      const rect = await ui.evalJs(exitRectJs).catch(() => null);
      if (rect) await tapRect(ui, JSON.parse(rect));
      await sleep(1200);
      return !(JSON.parse(await snap(ui))).rotateFull;
    },
    20000,
    "выход плавающей «⛶»",
  );
  await waitFor(
    async () => !(JSON.parse(await snap(ui))).landscape,
    15000,
    "портрет после плавающей «⛶»",
  );
  check("плавающая ⛶: свернула полный экран, портрет", true);

  // 8. ОВЕРЛЕЙ ПОВЕРХ: ландшафт с видео → открыть поиск → полный экран снят
  await putSetting("system", "user_rotation", "1");
  await waitFor(
    async () => JSON.parse(await snap(ui)).rotateFull,
    15000,
    ".m-rotate-full в ландшафте (шаг 8)",
  );
  await ui.evalJs(`(() => { const ob = document.querySelector('#mOmnibox');
    ob.value = 'https://www.youtube.com/results?search_query=bunny';
    ob.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 0 })()`);
  await waitFor(
    async () => !(JSON.parse(await snap(ui))).rotateFull,
    20000,
    "оверлей снял полный экран поворота",
  );
  check("оверлей поверх: полный экран поворота снят", true);
  // «домой» закрывает оверлей и видео — чистый ландшафтный старт без спрятанных панелей
  await ui.evalJs("window.__duopulseGoHome && window.__duopulseGoHome()");
  await sleep(1200);
  check(
    "домой в ландшафте: панель не держится спрятанной",
    statusBarVisible() !== false,
    `statusBar=${statusBarVisible()}`,
  );

  await putSetting("system", "accelerometer_rotation", "1");
  await putSetting("system", "user_rotation", "0");
  ui.close();
  const failed = results.filter((r) => !r.ok).length;
  const out = { ts: new Date().toISOString(), checks: results, failed };
  writeFileSync(
    new URL("./rotate-fullscreen-smoke-last-run.json", import.meta.url),
    JSON.stringify(out, null, 2),
  );
  console.log(`\n${failed === 0 ? "OK" : "FAILED"}: ${results.length - failed}/${results.length}`);
  process.exit(failed === 0 ? 0 : 1);
};

main().catch((e) => {
  results.push({ name: "стенд упал", ok: false, error: e.message });
  writeFileSync(
    new URL("./rotate-fullscreen-smoke-last-run.json", import.meta.url),
    JSON.stringify({ ts: new Date().toISOString(), checks: results, failed: 1, error: e.message }, null, 2),
  );
  console.error("ОШИБКА:", e.message);
  console.log("\nFAILED");
  process.exit(1);
});
