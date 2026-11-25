// E2E-смоук ПЕРЕВОДА ВСЕЙ СТРАНИЦЫ web-оверлея мобильной ветки (карточка
// duopulse-245, паритет десктопа 244): debug-APK на эмуляторе + CDP 9223
// (конвенция смоуков duopulse-144/165). Фича: пейлоад assets/duopulse/
// page-translate.js (инжекция onPageFinished, маркер __dpPageTranslate),
// вход — пункт «🌐 Перевести страницу…» нативного «⋮»-меню шапки оверлея,
// транспорт — веб-фетч gtx из самой страницы (duopulse-208: браузерный
// TLS-профиль System WebView обходит бот-блок эмулятора).
//
// Локальная страница стенда (порт 8896 — вне Windows excluded-диапазонов,
// память duopulse-e2e-windows-excluded-ports) + уникальный ?r= на открытие
// (мёртвые CDP-цели прошлых WebView висят в /json вечно). ДВЕ фазы:
//   A) детерминированная: транспорт подменён window.__dpPtFetch ДО входа
//      (Response-подобная заглушка, тот же контракт, что читает пейлоад) —
//      меню жмём НАСТОЯЩИМ тапом (uiautomator: «⋮» по content-desc «Меню»,
//      пункт по тексту), проверяем перевод/контур пробелов/служебные
//      пропуски/бар (15 языков, «Оригинал», ×)/смену цели/память localStorage/
//      дочитку динамики/×;
//   B) живой gtx: __dpPtFetch снят, begin('ru') идёт настоящим фетчем —
//      бот-блок эмулятора обязан быть обойдён (duopulse-208); всплеск 429 —
//      честный lastError в артефакт + один ретрай после паузы.
// Запуск (APK установлен или задан DP245_APK, эмулятор поднят):
//   node e2e/mobile/page-translate-smoke.mjs
// Результат — e2e/mobile/page-translate-smoke-last-run.json (gitignore,
// рантайм-артефакт). Скриншоты — %TEMP%/duopulse-245-*.png.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const PKG = "dev.duopulse.mobile";
const PORT = Number(process.env.CDP_PORT || 9223);
// 8896 — вне Windows excluded-диапазонов (память duopulse-e2e-windows-excluded-ports)
const HTTP_PORT = Number(process.env.DP245_HTTP_PORT || 8896);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT = join(HERE, "page-translate-smoke-last-run.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// свежий debug-APK из builds/ (умолчание паттерна vpn-ui-smoke: каталог
// версии → .apk внутри)
const APK = process.env.DP245_APK ||
  readdirSync(join(ROOT, "builds"))
    .filter((d) => /^duopulse_.+_android_debug$/.test(d))
    .flatMap((d) => readdirSync(join(ROOT, "builds", d))
      .filter((f) => f.endsWith(".apk"))
      .map((f) => join(ROOT, "builds", d, f)))
    .filter((f) => existsSync(f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
if (!APK || !existsSync(APK)) throw new Error("debug-APK не найден (builds/duopulse_*_android_debug)");
console.log("APK:", APK);

const SERIAL = process.env.ANDROID_SERIAL ||
  execFileSync("adb", ["devices"], { encoding: "utf8" })
    .split(/\r?\n/).slice(1).find((l) => l.trim().endsWith("device"))?.split("\t")[0].trim() || "";
if (!SERIAL) throw new Error("эмулятор не найден (adb devices)");
const adb = (...args) =>
  execFileSync("adb", ["-s", SERIAL, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
const shot = (name) => {
  const p = join(tmpdir(), `duopulse-245-${name}.png`);
  // Buffer без encoding: utf8-строка портила бинарные байты PNG (память
  // duopulse-mobile-smoke-emulator-traps); exec-out не конвертит переводы строк
  writeFileSync(p, execFileSync("adb", ["-s", SERIAL, "exec-out", "screencap", "-p"]));
  console.log(`скриншот: ${p}`);
};

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok, extra });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

// --- локальный http-стенд: английская страница с контуром пробелов ---------
// script/цифры — непереводимые узлы (пейлоад их пропускает); late-узлов нет —
// динамику добавляем CDP-эвалом (детерминированнее таймера страницы).
const PAGE = `<!doctype html><meta charset="utf-8"><title>dp245</title>
<body>
<h1 id="h">DuoPulse page translate smoke</h1>
<p id="a">  The quick brown fox jumps  </p>
<p id="b">Second paragraph of the stand</p>
<script>var standVar = "not translated";</script>
<p id="digits">12345 67890</p>
</body>`;
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

/** /json опрос, не роняющий прогон: сокет webview_devtools_remote
 *  поднимается позже старта приложения (гонка первого fetch). */
const safeTargets = async () => {
  try {
    return await targets();
  } catch {
    return [];
  }
};

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
    for (const t of await safeTargets()) {
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
    for (const t of await safeTargets()) {
      if (!t.url.includes(`r=${r}`)) continue;
      const c = await connect(t).catch(() => null);
      if (!c) continue;
      const title = await c.evalJs("document.title").catch(() => "");
      if (title === "dp245") return c;
      c.close();
    }
    await sleep(500);
  }
  throw new Error(`страница стенда r=${r} в оверлее не найдена`);
}

/** uiautomator-тап по узлу (физические пиксели из bounds; vpn-ui-паттерн):
 *  pred выбирает узел, при нескольких совпадениях предпочитаем clickable. */
async function uiTapText(pred, label, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const dumpPath = `/sdcard/window_dump_${process.pid}.xml`;
    adb("shell", "uiautomator", "dump", dumpPath);
    const xml = adb("exec-out", "cat", dumpPath);
    const nodes = [...xml.matchAll(/<node[^>]*?text="([^"]*)"[^>]*?content-desc="([^"]*)"[^>]*?clickable="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)]
      .map((m) => ({ text: m[1], desc: m[2], clickable: m[3] === "true", x1: +m[4], y1: +m[5], x2: +m[6], y2: +m[7] }));
    const hits = nodes.filter((n) => pred(n));
    const hit = hits.find((n) => n.clickable) ?? hits[0];
    if (hit) {
      const x = Math.round((hit.x1 + hit.x2) / 2);
      const y = Math.round((hit.y1 + hit.y2) / 2);
      adb("shell", "input", "tap", String(x), String(y));
      console.log(`  тап «${label}» @${x},${y}`);
      return true;
    }
    await sleep(700);
  }
  console.log(`  узел «${label}» не найден в dump`);
  return false;
}

/** Заглушка транспорта (Response-подобный, как читает пейлоад): перевод
 *  «[tl]«строка»» построчно — детерминированная фаза A. */
const MOCK_FETCH = `(function(){
  window.__dpPtFetch = function (url) {
    var u = new URL(url);
    var q = u.searchParams.get("q") || "";
    var tl = u.searchParams.get("tl") || "ru";
    var trans = q.split("\\n").map(function (l) { return "[" + tl + "]\\u00ab" + l + "\\u00bb"; }).join("\\n");
    return Promise.resolve({ status: 200, text: function () {
      return Promise.resolve(JSON.stringify({ sentences: [{ trans: trans }] }));
    } });
  };
  return typeof window.__duopulsePageTranslate;
})()`;

/** Снапшот состояния пейлоада (или null — пейлоада нет). */
const state = (ov) =>
  ov.evalJs("window.__duopulsePageTranslate ? JSON.stringify(window.__duopulsePageTranslate.state()) : 'null'")
    .then((s) => JSON.parse(s));

/** Ждать состояние с предикатом. */
async function waitState(ov, pred, ms, label) {
  for (let a = 0; a < ms / 300; a++) {
    const s = await state(ov).catch(() => null);
    if (s && pred(s)) return s;
    await sleep(300);
  }
  throw new Error(`состояние не дождано: ${label}`);
}

// --- прогон -------------------------------------------------------------------
let exit = 0;
let ui = null;
let ov = null;
try {
  try { adb("shell", "pm", "uninstall", PKG); } catch { /* не была установлена */ }
  adb("install", "-r", APK);
  adb("shell", "am", "force-stop", PKG);
  await sleep(800);
  adb("shell", "am", "start", "-n", `${PKG}/dev.duopulse.mobile.MainActivity`);
  await sleep(2500); // окно и webview поднимаются не мгновенно
  forwardCdp();
  ui = await uiPage();
  console.log("UI-webview:", ui.url);

  // 1) оверлей со страницей стенда (прямой invoke — уровень Core)
  const r1 = uniq();
  await ui.invoke("mobile_web_open", { url: `${STAND}?r=${r1}`, incognito: false });
  ov = await overlayPage(r1).catch(() => null);
  check("оверлей: страница стенда открыта (CDP-цель жива)", !!ov);
  if (!ov) throw new Error("оверлей не открылся");

  // 2) пейлоад в документе (инжекция onPageFinished)
  const apiType = await ov.evalJs("typeof window.__duopulsePageTranslate");
  check("пейлоад page-translate в документе (window.__duopulsePageTranslate)", apiType === "object", apiType);
  if (apiType !== "object") throw new Error("пейлоад не инжектирован");

  // 3) детерминированный транспорт ДО входа (фаза A)
  const mockSet = await ov.evalJs(MOCK_FETCH);
  check("заглушка транспорта установлена до входа (__dpPtFetch)", mockSet === "object");

  // 4) вход НАСТОЯЩИМ меню: «⋮» шапки оверлея → «🌐 Перевести страницу…»
  const menuOk = await uiTapText((n) => n.desc === "Меню" && n.clickable, "⋮ (Меню)");
  check("нативное «⋮»-меню открыто (content-desc «Меню»)", menuOk);
  let itemSeen = false;
  if (menuOk) {
    const dumpPath = `/sdcard/window_dump_${process.pid}.xml`;
    adb("shell", "uiautomator", "dump", dumpPath);
    const xml = adb("exec-out", "cat", dumpPath);
    itemSeen = xml.includes("Перевести страницу");
  }
  check("⋮-меню содержит пункт «Перевести страницу…»", itemSeen);
  const tapped = await uiTapText((n) => n.text.includes("Перевести страницу"), "🌐 Перевести страницу…");
  check("тап пункта «Перевести страницу…» (uiautomator)", tapped);
  if (!tapped) throw new Error("пункт меню не нажат");

  // 5) перевод пошёл и завершён
  const s1 = await waitState(ov, (s) => s.phase === "translated", 15000, "translated")
    .catch(() => null);
  check("перевод завершён (state.phase=translated)", !!s1, s1 ? "" : "таймаут");
  if (!s1) throw new Error("перевод не завершён");

  // 6) тексты: перевод с контуром пробелов, служебные/цифры не тронуты
  const aTxt = await ov.evalJs("document.getElementById('a').textContent");
  const bTxt = await ov.evalJs("document.getElementById('b').textContent");
  const hTxt = await ov.evalJs("document.getElementById('h').textContent");
  check("перевод узла с сохранением пробельного контура",
    aTxt === "  [ru]\u00abThe quick brown fox jumps\u00bb  ", JSON.stringify(aTxt));
  check("перевод второго абзаца",
    bTxt === "[ru]\u00abSecond paragraph of the stand\u00bb", JSON.stringify(bTxt));
  check("заголовок переведён", hTxt === "[ru]\u00abDuoPulse page translate smoke\u00bb", JSON.stringify(hTxt));
  const digits = await ov.evalJs("document.getElementById('digits').textContent");
  check("только цифры не переведены", digits === "12345 67890", JSON.stringify(digits));
  const scriptOk = await ov.evalJs("String(window.standVar)");
  check("script-узел не тронут", scriptOk === "not translated");

  // 7) бар: статус, 15 языков, «Оригинал», «×»
  const bar = await ov.evalJs(`(function(){
    var b = document.querySelector("[data-duopulse-page-bar]");
    if (!b) return JSON.stringify(null);
    var sel = b.querySelector("select");
    return JSON.stringify({
      status: b.querySelector("span").textContent,
      langs: sel ? sel.options.length : 0,
      value: sel ? sel.value : "",
      toggle: b.querySelectorAll("button")[0].textContent,
      close: !!b.querySelector('button[aria-label="Спрятать панель перевода"]')
    });
  })()`).then((s) => JSON.parse(s));
  check("бар: статус «Переведено на Русский»", bar && bar.status === "Переведено на Русский", bar ? bar.status : "бара нет");
  check("бар: селект цели — 15 языков десктопа (ru выбран)", bar && bar.langs === 15 && bar.value === "ru", `langs=${bar?.langs}`);
  check("бар: кнопка «Оригинал» и «×»", bar && bar.toggle === "Оригинал" && bar.close === true);
  shot("translated");

  // 8) «Оригинал» → английский назад; «Показать перевод» → перевод снова
  await ov.evalJs(`document.querySelector("[data-duopulse-page-bar]").querySelectorAll("button")[0].click(); "ok"`);
  const origTxt = await ov.evalJs("document.getElementById('a').textContent");
  const sOrig = await waitState(ov, (s) => s.phase === "original", 5000, "original").catch(() => null);
  check("«Оригинал»: тексты восстановлены, phase=original",
    origTxt === "  The quick brown fox jumps  " && !!sOrig, JSON.stringify(origTxt));
  await ov.evalJs(`document.querySelector("[data-duopulse-page-bar]").querySelectorAll("button")[0].click(); "ok"`);
  await waitState(ov, (s) => s.phase === "translated", 15000, "translated-again");
  const backTxt = await ov.evalJs("document.getElementById('a').textContent");
  check("«Показать перевод»: перевод возвращён (полный прогон заново)",
    backTxt === "  [ru]\u00abThe quick brown fox jumps\u00bb  ", JSON.stringify(backTxt));

  // 9) смена цели в баре → uk; память цели (localStorage того же origin)
  await ov.evalJs(`(function(){
    var sel = document.querySelector("[data-duopulse-page-bar] select");
    sel.value = "uk"; sel.dispatchEvent(new Event("change")); return "ok";
  })()`);
  await waitState(ov, (s) => s.phase === "translated" && s.target === "uk", 15000, "uk");
  const ukTxt = await ov.evalJs("document.getElementById('b').textContent");
  const stored = await ov.evalJs("localStorage.getItem('duopulse.pageTranslateTarget')");
  check("смена цели в баре: перевод на uk (заново)", ukTxt === "[uk]\u00abSecond paragraph of the stand\u00bb", JSON.stringify(ukTxt));
  check("память цели: localStorage duopulse.pageTranslateTarget=uk", stored === "uk", String(stored));

  // 10) дочитка динамики: поздний узел переводится (MutationObserver)
  await ov.evalJs(`(function(){
    var p = document.createElement("p");
    p.id = "late"; p.textContent = "Late dynamic node";
    document.body.appendChild(p); return "ok";
  })()`);
  let lateTxt = "";
  for (let a = 0; a < 30; a++) {
    lateTxt = await ov.evalJs("document.getElementById('late') ? document.getElementById('late').textContent : ''");
    if (lateTxt === "[uk]\u00abLate dynamic node\u00bb") break;
    await sleep(300);
  }
  check("динамика: поздний узел дочитан переводом (debounce)", lateTxt === "[uk]\u00abLate dynamic node\u00bb", JSON.stringify(lateTxt));

  // 11) «×» прячет бар, перевод жив
  await ov.evalJs(`document.querySelector("[data-duopulse-page-bar]").querySelectorAll("button")[1].click(); "ok"`);
  const barGone = await ov.evalJs("!document.querySelector('[data-duopulse-page-bar]')");
  const stillUk = await ov.evalJs("document.getElementById('b').textContent");
  check("«×» прячет бар, перевод остаётся", barGone === true && stillUk === "[uk]\u00abSecond paragraph of the stand\u00bb");
  shot("banner-hidden");

  // 12) фаза B — живой gtx без заглушки (бот-блок эмулятора обходит
  //     браузерный TLS-профиль System WebView, duopulse-208)
  await ov.evalJs("delete window.__dpPtFetch; 'ok'");
  await ov.evalJs("window.__duopulsePageTranslate.begin('ru'); 'ok'");
  let live = await waitState(ov, (s) => s.phase === "translated" || s.phase === "error", 30000, "live-gtx")
    .catch(() => null);
  if (live && live.phase === "error" && /429|HTTP 5\d\d/.test(live.lastError)) {
    console.log("  живой gtx всплеск, ретрай через 8 с:", live.lastError);
    await sleep(8000);
    await ov.evalJs("window.__duopulsePageTranslate.begin('ru'); 'ok'");
    live = await waitState(ov, (s) => s.phase === "translated" || s.phase === "error", 30000, "live-gtx-retry")
      .catch(() => null);
  }
  const liveTxt = await ov.evalJs("document.getElementById('b').textContent");
  const liveChanged = liveTxt !== "Second paragraph of the stand" && /\p{L}/u.test(liveTxt.replace(/\[|\]|«|»/g, ""));
  check("живой gtx: страница переведена настоящим фетчем (бот-блок обойдён)",
    !!live && live.phase === "translated" && liveChanged,
    live ? `phase=${live.phase} err=${live.lastError} b=${JSON.stringify(liveTxt.slice(0, 40))}` : "таймаут");
  shot("live-gtx");

  // 13) закрытие оверлея — чистый финал (мобильный web-оверлей)
  await ui.invoke("mobile_web_close", {});
  check("оверлей закрыт (mobile_web_close)", true);
} catch (e) {
  exit = 1;
  console.error("СМОУК ПАЛ:", e.message);
} finally {
  try { ui?.invoke("mobile_web_close", {}).catch(() => {}); } catch { /* уже закрыт */ }
  server.close();
  writeFileSync(OUT, JSON.stringify({
    started: new Date().toISOString(),
    serial: SERIAL, httpPort: HTTP_PORT, apk: APK,
    checks: results, allPassed: results.every((r) => r.ok),
  }, null, 2));
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - bad}/${results.length} проверок прошло; результат: ${OUT}`);
  process.exit(exit || (bad ? 1 : 0));
}
