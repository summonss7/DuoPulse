// E2E-смоук ИНКОГНИТО web-оверлея (карточка duopulse-211, жалоба «в режиме
// инкогнито все запросы перенаправляет в хром и открывает в нем»): debug-APK
// на эмуляторе (у релиза нет CDP-сокета webview_devtools_remote, конвенция
// смоуков duopulse-144/165 — порт 9223). Фикс: openInApp больше не выкидывает
// адреса в системный браузер — оверлей открывается на ИЗОЛИРОВАННОМ профиле
// WebView (MULTI_PROFILE, androidx ProfileStore), профиль сносится при
// закрытии оверлея. Локальная cookie-страница (порт 8898: 8899 в Windows
// excluded-диапазоне, см. память проекта) + уникальный ?r= на каждое
// открытие (мёртвые CDP-цели прошлых WebView висят в /json вечно).
// Проверки:
//   0) (duopulse-247) до инкогнито кука common=1 общего профиля записана;
//      после полного инкогнито-цикла она уцелела — removeAllCookies общего
//      профиля при входе/выходе из режима сносил и нормальные логины;
//   1) инкогнито из UI (очки старта, __duopulseTogglePrivate) включён;
//   2) запрос из omnibox в инкогнито открыт В ПРИЛОЖЕНИИ: CDP-цель
//      страницы жива, topResumedActivity — DuoPulse, Chrome не поднимался;
//   3) изолированный профиль назначен (logcat DuoPulseWeb private-profile);
//   4) изоляция: кука приватного профиля НЕ видна обычному оверлею
//      (прямой invoke mobile_web_open incognito:false — уровень Core);
//   5) следов не остаётся: повторный инкогнито-оверлей куки не видит
//      (профиль снесён teardown'ом);
//   6) после выхода из инкогнито обычный оверлей жив, профиль чист
//      (регресс обычного пути), куки общего профиля целы (duopulse-247).
// Запуск (APK установлен, эмулятор поднят): node e2e/mobile/incognito-overlay-smoke.mjs
// Результат — e2e/mobile/incognito-overlay-smoke-last-run.json (gitignore,
// рантайм-артефакт). Скриншоты — %TEMP%/duopulse-211-*.png.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PKG = "dev.duopulse.mobile";
const PORT = Number(process.env.CDP_PORT || 9223);
// 8898 — вне Windows excluded-диапазонов (память duopulse-e2e-windows-excluded-ports)
const HTTP_PORT = Number(process.env.DP211_HTTP_PORT || 8898);
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "incognito-overlay-smoke-last-run.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SERIAL = process.env.ANDROID_SERIAL ||
  execFileSync("adb", ["devices"], { encoding: "utf8" })
    .split(/\r?\n/).slice(1).find((l) => l.trim().endsWith("device"))?.split("\t")[0].trim() || "";
if (!SERIAL) throw new Error("эмулятор не найден (adb devices)");
const adb = (...args) =>
  execFileSync("adb", ["-s", SERIAL, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
const shot = (name) => {
  const p = join(tmpdir(), `duopulse-211-${name}.png`);
  // Buffer без encoding: utf8-строка портила бинарные байты PNG (память
  // duopulse-mobile-smoke-emulator-traps); exec-out не конвертит переводы строк
  writeFileSync(p, execFileSync("adb", ["-s", SERIAL, "exec-out", "screencap", "-p"]));
  console.log(`скриншот: ${p}`);
};

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

// --- локальный http-стенд: cookie-страница ------------------------------------
// ?set=NAME ставит куку NAME=1 (path=/, общий на origin), document.cookie —
// чтение. Прочие GET — та же страница (уникальность цели — ?r= в URL).
const PAGE = `<!doctype html><meta charset="utf-8"><body>dp211
<script>
var s = new URLSearchParams(location.search).get("set");
if (s) document.cookie = s + "=1; path=/; max-age=3600";
document.title = "dp211";
</script>`;
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
});
await new Promise((r) => server.listen(HTTP_PORT, "127.0.0.1", r));
const STAND = `http://10.0.2.2:${HTTP_PORT}/`;
const uniq = () => Math.random().toString(36).slice(2, 8);

// --- CDP ----------------------------------------------------------------------
const forwardCdp = () => {
  const p = adb("shell", "pidof", PKG).trim();
  adb("forward", `tcp:${PORT}`, `localabstract:webview_devtools_remote_${p}`);
};
const targets = async () =>
  (await (await fetch(`http://localhost:${PORT}/json`)).json())
    .filter((t) => t.type === "page");

async function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let i = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const evalJs = (expr) => new Promise((res, rej) => {
    const id = ++i;
    pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result.result.value)));
    ws.send(JSON.stringify({
      id, method: "Runtime.evaluate",
      params: { expression: expr, returnByValue: true, awaitPromise: true },
    }));
  });
  const invoke = (cmd, args) =>
    evalJs(`window.__TAURI__.core.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
  return { url: t.url, evalJs, invoke, close: () => ws.close() };
}

/** UI-webview DuoPulse (DOM-предикат: хук инкогнито есть только в ветке). */
async function uiPage() {
  for (let a = 0; a < 30; a++) {
    for (const t of await targets()) {
      const c = await connect(t).catch(() => null);
      if (!c) continue;
      const ok = await c.evalJs("typeof window.__duopulseTogglePrivate").catch(() => "");
      if (ok === "function") return c;
      c.close();
    }
    await sleep(500);
  }
  throw new Error("UI-webview мобильной ветки не найден");
}

/** Живая CDP-цель страницы стенда с данным ?r= (мёртвые цели висят в /json —
 *  опрос коннектом: мёртвая цель eval не отвечает). */
async function overlayPage(r, ms = 20000) {
  for (let a = 0; a < ms / 500; a++) {
    for (const t of await targets()) {
      if (!t.url.includes(`r=${r}`)) continue;
      const c = await connect(t).catch(() => null);
      if (!c) continue;
      const title = await c.evalJs("document.title").catch(() => "");
      if (title === "dp211") return c;
      c.close();
    }
    await sleep(500);
  }
  throw new Error(`страница стенда r=${r} в оверлее не найдена`);
}

/** Куки страницы оверлея (строка document.cookie). */
const cookies = (ov) => ov.evalJs("document.cookie");

/** Ввод адреса в omnibox старта + Enter — полный UI-путь navigate → openInApp
 *  (передачу флага инкогнито проверяет именно он, а не прямой invoke). */
const omniboxGo = (ui, url) =>
  ui.evalJs(`(function(){
    var ob = document.getElementById("mOmnibox");
    ob.value = ${JSON.stringify(url)};
    ob.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return true;
  })()`);

/** Верхняя resumed-активность (урон Chrome был бы виден здесь). */
const topActivity = () =>
  adb("shell", "dumpsys", "activity", "activities")
    .match(/topResumedActivity=ActivityRecord\{[^}]* ([\w.]+\/[\w.]+)/)?.[1] || "";
const chromePid = () => adb("shell", "pidof", "com.android.chrome").trim();

// --- прогон -------------------------------------------------------------------
let exit = 0;
try {
  adb("shell", "am", "force-stop", PKG);
  adb("shell", "logcat", "-c"); // чистый буфер: строки private-profile — наши
  await sleep(800);
  adb("shell", "am", "start", "-n", `${PKG}/dev.duopulse.mobile.MainActivity`);
  await sleep(2500); // окно и webview поднимаются не мгновенно
  forwardCdp();
  const ui = await uiPage();
  console.log("UI-webview:", ui.url);

  const chrome0 = chromePid();

  // 0) (duopulse-247, жалоба «постоянно нужно входить в аккаунт») кука
  //    общего профиля ДО инкогнито: после полного инкогнито-цикла она
  //    обязана уцелеть — прежний mobile_private_cleanup делал
  //    removeAllCookies ВСЕГО общего профиля при каждом входе/выходе
  //    из режима, снося и нормальные логины сайтов
  const r0 = uniq();
  omniboxGo(ui, `${STAND}?set=common&r=${r0}`);
  const ov0 = await overlayPage(r0).catch(() => null);
  check("общий профиль: обычный оверлей до инкогнито открыт", !!ov0);
  if (!ov0) throw new Error("оверлей до инкогнито не открылся");
  const c0 = await cookies(ov0);
  check("общий профиль: кука common=1 записана", c0.includes("common=1"),
    `cookie=«${c0}»`);
  await ui.invoke("mobile_web_close", {});
  await sleep(1200);

  // 1) инкогнито включён из UI (очки старта — тот же переключатель)
  await ui.evalJs("window.__duopulseTogglePrivate()");
  let on = false;
  for (let a = 0; a < 20 && !on; a++) {
    on = (await ui.evalJs("window.__duopulsePrivateOn ? window.__duopulsePrivateOn() : false")) === true;
    if (!on) await sleep(300);
  }
  check("инкогнито включён (очки старта, __duopulsePrivateOn)", on);

  // 2) запрос из omnibox в инкогнито — оверлей В ПРИЛОЖЕНИИ, не Chrome
  const r1 = uniq();
  omniboxGo(ui, `${STAND}?set=priv&r=${r1}`);
  const ov1 = await overlayPage(r1).catch(() => null);
  check("инкогнито: страница открылась в web-оверлее (CDP-цель жива)", !!ov1,
    ov1 ? "" : "цель не найдена");
  if (!ov1) throw new Error("оверлей инкогнито не открылся");
  const top1 = topActivity();
  check("инкогнито: поверх — DuoPulse, не Chrome", top1.startsWith(`${PKG}/`), top1);
  const chrome1 = chromePid();
  check("инкогнито: Chrome не поднимался", chrome1 === chrome0,
    `до=«${chrome0}» после=«${chrome1}»`);
  shot("incognito-overlay");

  // 3) изолированный профиль назначен (logcat Kotlin-хелпера)
  await sleep(500);
  const log = adb("shell", "logcat", "-d", "-s", "DuoPulseWeb");
  check("logcat: изолированный профиль назначен (MULTI_PROFILE)",
    log.includes("private-profile: изолированный профиль назначен"));
  check("logcat: деграда на общий профиль не было",
    !log.includes("MULTI_PROFILE не поддержан") &&
    !log.includes("private-profile: недоступен"));

  // 4) изоляция профилей: priv=1 читается в инкогнито, но НЕ видна
  //    обычному оверлею (прямой invoke incognito:false — уровень Core)
  const c1 = await cookies(ov1);
  check("инкогнито: кука priv=1 записана в приватном профиле",
    c1.includes("priv=1"), `cookie=«${c1}»`);
  await ui.invoke("mobile_web_close", {});
  await sleep(1200); // teardown в UI-нити + чистка профиля
  const r2 = uniq();
  await ui.invoke("mobile_web_open", { url: `${STAND}?r=${r2}`, incognito: false });
  const ov2 = await overlayPage(r2).catch(() => null);
  check("обычный оверлей (incognito:false) открыт поверх режима", !!ov2);
  if (!ov2) throw new Error("обычный оверлей не открылся");
  const c2 = await cookies(ov2);
  check("изоляция: кука приватного профиля НЕ видна общему", !c2.includes("priv=1"),
    `cookie=«${c2}»`);
  await ui.invoke("mobile_web_close", {});
  await sleep(1200);

  // 5) следов не остаётся: повторный инкогнито-оверлей куки не видит
  //    (профиль снесён teardown'ом закрытия)
  const r3 = uniq();
  await ui.invoke("mobile_web_open", { url: `${STAND}?r=${r3}`, incognito: true });
  const ov3 = await overlayPage(r3).catch(() => null);
  check("повторный инкогнито-оверлей открыт", !!ov3);
  if (!ov3) throw new Error("повторный инкогнито-оверлей не открылся");
  const c3 = await cookies(ov3);
  check("следов не остаётся: priv в новом инкогнито-профиле нет", !c3.includes("priv=1"),
    `cookie=«${c3}»`);
  await ui.invoke("mobile_web_close", {});
  await sleep(1200);

  // 6) выход из инкогнито → обычный оверлей жив, профиль чист (регресс
  //    обычного пути: mobile_private_cleanup на выходе чистит общий)
  await ui.evalJs("window.__duopulseTogglePrivate()");
  for (let a = 0; a < 20; a++) {
    if ((await ui.evalJs("window.__duopulsePrivateOn ? window.__duopulsePrivateOn() : false")) === false) break;
    await sleep(300);
  }
  const r4 = uniq();
  omniboxGo(ui, `${STAND}?r=${r4}`);
  const ov4 = await overlayPage(r4).catch(() => null);
  check("после выхода: обычный запрос открыт оверлеем в приложении", !!ov4);
  if (ov4) {
    const c4 = await cookies(ov4);
    check("после выхода: общий профиль чист (приватных следов нет)", !c4.includes("priv=1"),
      `cookie=«${c4}»`);
    check("после выхода: кука общего профиля уцелела (duopulse-247 — логины сайтов переживают инкогнито)",
      c4.includes("common=1"), `cookie=«${c4}»`);
    const top4 = topActivity();
    check("после выхода: поверх — DuoPulse", top4.startsWith(`${PKG}/`), top4);
  }
} catch (e) {
  exit = 1;
  console.error("СМОУК ПАЛ:", e.message);
} finally {
  server.close();
  writeFileSync(OUT, JSON.stringify({
    started: new Date().toISOString(),
    serial: SERIAL, httpPort: HTTP_PORT,
    checks: results, allPassed: results.every((r) => r.ok),
  }, null, 2));
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - bad}/${results.length} проверок прошло; результат: ${OUT}`);
  process.exit(exit || (bad ? 1 : 0));
}
