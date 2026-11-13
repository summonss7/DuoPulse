// E2E-приёмка мобильной части карточки duopulse-134 «кнопка «на весь
// экран» YouTube не работает»: HTML-fullscreen (onShowCustomView) в web-оверлее
// поиска MobileWebHelper, выход системным «назад», повороты эмулятора.
// Прецеденты — e2e/selection/mobile.mjs (конвенция порта 9223).
// Контролы плеера m.youtube показываются только по РЕАЛЬНОМУ тачу (синтетический
// pointerdown их не будит), поэтому тапы/клавиши/повороты — adb shell input
// (скрипт сам зовёт adb; эмулятор должен быть один — берём ANDROID_SERIAL или
// первый из `adb devices`). Приложение и adb-форвард подняты запускающим:
//   adb forward tcp:9223 localabstract:webview_devtools_remote_<pid>
//   node e2e/youtube/mobile-fullscreen.mjs
// Скриншоты кладутся в %TEMP%/duopulse-134-*.png (рантайм-артефакты, не в репо).
// Бюджет YouTube мал (rate-limit ~25 автозагрузок/час): 1 поиск + 1 watch.
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

const PORT = process.env.CDP_PORT || 9223;
const SERIAL = process.env.ANDROID_SERIAL ||
  execFileSync("adb", ["devices"], { encoding: "utf8" })
    .split("\n").slice(1).find((l) => l.endsWith("device"))?.split("\t")[0] || "";
const adb = (...args) =>
  execFileSync("adb", SERIAL ? ["-s", SERIAL, ...args] : args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const shot = (name) => {
  const p = join(tmpdir(), `duopulse-134-${name}.png`);
  const buf = execFileSync("adb", SERIAL ? ["-s", SERIAL, "exec-out", "screencap", "-p"] : ["exec-out", "screencap", "-p"], { maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(p, buf);
  console.log(`скриншот: ${p}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

async function pageTargets() {
  return (await (await fetch(`http://localhost:${PORT}/json`)).json())
    .filter((x) => x.type === "page");
}

async function connect(targetOrRe) {
  // цель можно передать объектом (защита от мёртвых целей прошлых оверлеев —
  // они висят в /json вечно, а eval по ним молча таймаутит)
  const t = targetOrRe instanceof RegExp
    ? (await pageTargets()).find((x) => targetOrRe.test(x.url))
    : targetOrRe;
  if (!t) throw new Error(`нет CDP-цели ${urlRe}: ` + targets.map((x) => x.url).join(", "));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
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
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      const to = setTimeout(() => { pending.delete(i); rej(new Error(`CDP ${method}: таймаут 15 с`)); }, 15000);
      pending.set(i, {
        res: (v) => { clearTimeout(to); res(v); },
        rej: (e) => { clearTimeout(to); rej(e); },
      });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evalJs = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return r.result.value;
  };
  return { url: t.url, evalJs, close: () => ws.close() };
}

async function waitFor(fn, ms, label, every = 500) {
  for (let gone = ms; gone > 0; gone -= every) {
    if (await fn().catch(() => false)) return true;
    await sleep(every);
  }
  throw new Error(`не дождались: ${label}`);
}

/** Реальный тач по центру плеера — показывает контролы m.youtube. */
async function tapPlayer(page) {
  // adb tap принимает ФИЗИЧЕСКИЕ пиксели: CSS-координаты × devicePixelRatio
  const c = await page.evalJs(`(() => { const r = document.querySelector('#movie_player')?.getBoundingClientRect();
    const k = window.devicePixelRatio || 1;
    return r ? JSON.stringify({ x: (r.x + r.width / 2) * k, y: (r.y + r.height / 2) * k }) : null })()`);
  if (!c) return false;
  const { x, y } = JSON.parse(c);
  adb("shell", "input", "tap", String(Math.round(x)), String(Math.round(y)));
  return true;
}

const BTN = 'button.fullscreen-icon, .fullscreen-button, button[aria-label*="full screen" i]';

const main = async () => {
  // портрет + ручной поворот (прогнозируемо для теста)
  adb("shell", "settings", "put", "system", "accelerometer_rotation", "0");
  adb("shell", "settings", "put", "system", "user_rotation", "0");

  // 0. сброс состояния прошлых прогонов: «домой» закрывает web-оверлей
  const ui = await connect(/^https?:\/\/(tauri\.)?localhost/);
  console.log("UI:", ui.url);
  await ui.evalJs(`(() => { document.querySelector('#mHome')?.click(); return 0; })()`);
  await sleep(1500);

  // 1. UI Tauri: поиск через omnibox — как делал Артём
  await ui.evalJs(`(() => {
    const ob = document.querySelector('#mOmnibox');
    if (!ob) return 'нет omnibox';
    ob.value = 'https://m.youtube.com/results?search_query=big+buck+bunny';
    ob.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 'ok';
  })()`).then((r) => check("omnibox: поиск запущен", r === "ok", String(r)));

  // 2. web-оверлей: CDP-цель страницы YouTube появилась
  let yt = null;
  await waitFor(async () => {
    const ts = await pageTargets();
    yt = ts.find((x) => /youtube\.com\/results/.test(x.url));
    return !!yt;
  }, 20000, "web-оверлей с выдачей YouTube");
  check("web-оверлей: поиск YouTube открыт", !!yt, yt?.url ?? "");
  const page = await connect(yt); // именно живая цель оверлея, не мёртвая прошлая

  // 3. клик по первому результату выдачи (виртуальный список: ретрай)
  await waitFor(async () => {
    const href = await page.evalJs(`(() => {
      const a = document.querySelector('a#video-title-link, ytm-video-with-context-renderer a, a#thumbnail');
      if (!a) return null;
      a.click(); return a.href || location.href;
    })()`).catch(() => null);
    if (href) console.log("клик по результату:", href);
    return !!href;
  }, 15000, "клик по результату выдачи");
  await waitFor(() => page.evalJs(`!!document.querySelector('video') && /watch|shorts/.test(location.href)`), 25000, "страница watch");

  // 4. воспроизведение (muted — автоплей-политика эмулятора); YT может
  // сбрасывать muted и вставать на паузу — дожимаем в цикле
  await waitFor(async () => {
    await page.evalJs(`(() => { const v = document.querySelector('video'); if (!v) return 0;
      if (v.paused) { v.muted = true; v.play().catch(() => {}); } return 0; })()`).catch(() => {});
    return page.evalJs(`(() => { const v = document.querySelector('video'); return !!v && !v.paused && v.currentTime > 0.5; })()`);
  }, 25000, "видео играет");

  // 5. кнопка «на весь экран» (портрет): показать контролы реальным тачем
  await waitFor(async () => {
    await tapPlayer(page);
    await sleep(600);
    return await page.evalJs(`!!document.querySelector('${BTN}')`);
  }, 15000, "кнопка fullscreen (контролы по тачу)");
  await page.evalJs(`(() => { const v = document.querySelector('video'); if (v && v.paused) v.play().catch(() => {}); return 0; })()`);
  // кнопка могла спрятаться — снова тач и сразу клик
  await tapPlayer(page);
  await sleep(400);
  await page.evalJs(`(() => { const b = document.querySelector('${BTN}'); if (!b) throw new Error('кнопка спряталась'); b.click(); return 'clicked'; })()`);
  await waitFor(() => page.evalJs(`document.fullscreenElement != null`), 10000, "document.fullscreenElement (портрет)");
  check("портрет: кнопка «на весь экран» включила fullscreen (JS)", true);
  shot("fs-portrait");
  await sleep(3000);

  // 6. выход системным «назад»
  adb("shell", "input", "keyevent", "4");
  await waitFor(() => page.evalJs(`document.fullscreenElement == null`), 20000, "выход из fullscreen «назад»");
  check("портрет: системный «назад» вышел из fullscreen", true);
  shot("back-portrait");
  await sleep(1000);

  // 7. поворот в ландшафт: страница watch сама разворачивает плеер,
  // иначе — кнопкой; затем скриншот
  adb("shell", "settings", "put", "system", "user_rotation", "1");
  await waitFor(() => page.evalJs(`matchMedia('(orientation: landscape)').matches`), 15000, "orientation landscape");
  check("ландшафт: orientation сменился", true);
  await page.evalJs(`(() => { const v = document.querySelector('video'); if (v) { v.muted = true; v.play().catch(() => {}); } return 0; })()`);
  await sleep(2500);
  let okFs = await page.evalJs(`document.fullscreenElement != null`);
  if (!okFs) {
    await waitFor(async () => {
      await tapPlayer(page);
      await sleep(600);
      return await page.evalJs(`!!document.querySelector('${BTN}')`);
    }, 15000, "кнопка fullscreen в ландшафте");
    await tapPlayer(page);
    await sleep(400);
    await page.evalJs(`(() => { const b = document.querySelector('${BTN}'); if (b) b.click(); return !!b; })()`);
    okFs = await waitFor(() => page.evalJs(`document.fullscreenElement != null`), 10000, "fullscreen в ландшафте").catch(() => false);
  }
  check("ландшафт: fullscreen (авто плеера или кнопкой)", okFs === true);
  shot("fs-landscape");
  await sleep(3000);

  // 8. «назад» из ландшафт-fullscreen и возврат портрета
  adb("shell", "input", "keyevent", "4");
  await waitFor(() => page.evalJs(`document.fullscreenElement == null`), 20000, "выход из ландшафт-fullscreen");
  check("ландшафт: «назад» вышел из fullscreen", true);
  adb("shell", "settings", "put", "system", "user_rotation", "0");

  ui.close(); page.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${failed === 0 ? "OK" : "FAILED"}: ${results.length - failed}/${results.length}`);
  process.exit(failed === 0 ? 0 : 1);
};

main().catch((e) => {
  console.error("ОШИБКА:", e.message);
  console.log(`\nFAILED`);
  process.exit(1);
});
