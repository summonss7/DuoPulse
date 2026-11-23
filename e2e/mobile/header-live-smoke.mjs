#!/usr/bin/env node
// DuoPulse — стенд ЖИВОГО ОБНОВЛЕНИЯ ШАПКИ web-оверлея (карточка 212):
// состав ряда 1 (бейдж вкладок, «⬇», щит VPN) синхронизировался хуком
// __duopulseHeaderState только на смене URL/открытии/показе оверлея — пока
// оверлей открыт, старт менялся, зеркало расходилось с оригиналом. Фикс —
// событийный пинг mobile_web_header_ping: фронт следит за фактическим
// состоянием (src/mobile/header-ping.ts), Kotlin переопросивает хук у
// ВИДИМОГО оверлея. debug-APK + CDP 9223 (конвенция смоуков 144/165/211).
//
// Сценарий (8 проверок): видео-вкладка + открытый оверлей (бейдж «1», есть
// «⬇», нет щита) → закрытие вкладки из листа ПРЯМЫМ DOM-кликом (лист под
// оверлеем невидим пользователю, но DOM жив — единственный путь закрыть
// вкладку при ВИДИМОМ оверлее, как требует карточка) → бейдж исчез, «⬇»
// исчез, АДРЕС оверлея не менялся, в logcat свежий header-state с новым
// составом; тоннель wg-stand вкл/выкл invoke'ами → щит появляется/исчезает
// без смены адреса; спрятанный оверлей (тап «Вкладки» шапки — hide()) при
// изменении счёта → «header-ping: … спрятан», БЕЗ нового header-state
// (пустых переопросов нет — батарея). Нативная шапка оверлея — НЕ DOM:
// состав читается uiautomator-дампом (бейдж TextView, «⬇»/щит по
// content-desc). Результат — e2e/mobile/header-live-smoke-last-run.json
// (gitignore, рантайм-артефакт).
import { execFile, execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ADB = process.env.ANDROID_HOME
  ? join(process.env.ANDROID_HOME, "platform-tools", "adb.exe")
  : "adb";
const CDP_PORT = Number(process.env.CDP_PORT || 9223);
const HTTP_PORT = Number(process.env.DP212_HTTP_PORT || 8898); // 8899 — excluded-диапазон Windows
const PKG = "dev.duopulse.mobile";
const APK = process.env.DP212_APK ||
  join(ROOT, "builds", `duopulse_${process.env.DP212_VER || "0.1.99"}_android_debug`,
    `DuoPulse-${process.env.DP212_VER || "0.1.99"}-android-debug.apk`);
const WG_STAND = process.env.E2E_WG_STAND ||
  join(ROOT, "e2e", "wg-stand", "target", "debug", "wg-stand.exe");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) => new Promise((res, rej) =>
  execFile(cmd, args, { cwd: ROOT }, (e, so, se) => (e ? rej(new Error(`${cmd}: ${se || so}`)) : res(so))));
const adb = (...a) => execFileSync(ADB, ["-s", process.env.ANDROID_SERIAL || "emulator-5554", ...a],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const checks = [];
const check = (name, ok, extra = "") => {
  checks.push({ name, ok: !!ok, extra });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) process.exitCode = 1;
};

// --- локальная страница стенда (уникальный ?r=: мёртвые CDP-цели висят) ------
const R = `${Date.now()}${process.pid}`;
const PAGE = "<!doctype html><meta charset=utf-8><title>dp212</title><h1>header-live</h1>";
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
});
await new Promise((r) => server.listen(HTTP_PORT, "127.0.0.1", r));
const STAND = `http://10.0.2.2:${HTTP_PORT}/header212.html`;

// --- wg-stand: живой WG-сервер на хосте ---------------------------------------
try { readFileSync(WG_STAND); } catch {
  console.log("wg-stand.exe нет — собираю (e2e/wg-stand)…");
  await run("cargo", ["build", "--manifest-path", join(ROOT, "e2e", "wg-stand", "Cargo.toml")]);
}
const confLive = join(tmpdir(), `duopulse-212-live-${process.pid}.conf`);
const stand = spawn(WG_STAND, ["--conf", confLive], { stdio: ["ignore", "pipe", "inherit"] });
let standReady;
const standReadyP = new Promise((res, rej) => {
  standReady = res;
  setTimeout(() => rej(new Error("wg-stand не поднялся за 15 с")), 15000);
});
stand.stdout.setEncoding("utf8");
stand.stdout.on("data", (chunk) => {
  for (const line of chunk.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.ev === "ready") standReady(ev);
    } catch { /* не-JSON строка стенда — мимо */ }
  }
});
const ready = await standReadyP;
console.log(`wg-stand: udp ${ready.udp_port}`);
// эмулятор видит хост как 10.0.2.2 — подменяем endpoint loopback
const confText = readFileSync(confLive, "utf8").replace("Endpoint = 127.0.0.1:", "Endpoint = 10.0.2.2:");
if (!confText.includes("10.0.2.2:")) throw new Error("endpoint не подменён — конфиг стенда другой");

// --- установка и запуск --------------------------------------------------------
console.log(`APK: ${APK}`);
adb("install", "-r", APK);
adb("shell", "pm", "clear", PKG);
adb("logcat", "-c");
adb("shell", "am", "start", "-n", `${PKG}/.MainActivity`);
let pid = "";
for (let i = 0; i < 30 && !pid; i++) {
  try { pid = adb("shell", "pidof", PKG).trim(); } catch { /* pidof без процесса — код 1 */ }
  if (!pid) await sleep(500);
}
if (!pid) throw new Error("процесс приложения не поднялся");
adb("forward", `tcp:${CDP_PORT}`, `localabstract:webview_devtools_remote_${pid}`);

const targets = async () => {
  try {
    return (await (await fetch(`http://localhost:${CDP_PORT}/json`)).json())
      .filter((t) => t.type === "page");
  } catch { return []; } // сокет webview_devtools_remote появляется не сразу
};
async function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let i = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
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

/** UI-webview DuoPulse (DOM-предикат: хук шапки есть только в мобильной ветке). */
async function uiPage() {
  for (let a = 0; a < 30; a++) {
    for (const t of await targets()) {
      const c = await connect(t).catch(() => null);
      if (!c) continue;
      const ok = await c.evalJs("typeof window.__duopulseHeaderState").catch(() => "");
      if (ok === "function") return c;
      c.close();
    }
    await sleep(500);
  }
  throw new Error("UI-webview мобильной ветки не найден");
}

/** Живая CDP-цель страницы стенда с данным ?r= (мёртвые цели висят в /json —
 *  опрос коннектом). */
async function overlayPage(ms = 20000) {
  for (let a = 0; a < ms / 500; a++) {
    for (const t of await targets()) {
      if (!t.url.includes(`r=${R}`)) continue;
      const c = await connect(t).catch(() => null);
      if (!c) continue;
      const title = await c.evalJs("document.title").catch(() => "");
      if (title === "dp212") return c;
      c.close();
    }
    await sleep(500);
  }
  throw new Error("страница стенда в оверлее не найдена");
}

/** uiautomator-дамп экрана: состав НАТИВНОЙ шапки оверлея (бейдж/«⬇»/щит —
 *  Kotlin-вьюхи, из CDP недостижимы; GONE-вьюхи в dump не попадают).
 *  Бейдж — числовой TextView шапки; «⬇» — content-desc «Скачать…»; щит —
 *  «VPN». Ретрай: dump падает «could not get idle state» на анимациях. */
function dumpHeader() {
  const dumpPath = `/sdcard/window_dump_${process.pid}.xml`;
  let xml = "";
  for (let a = 0; a < 3 && !xml.includes("<node"); a++) {
    try {
      adb("shell", "uiautomator", "dump", dumpPath);
      xml = adb("exec-out", "cat", dumpPath);
    } catch { /* ретрай */ }
    if (!xml.includes("<node")) { adb("shell", "rm", "-f", dumpPath); }
  }
  if (!xml.includes("<node")) throw new Error("uiautomator dump не удался");
  const nodes = [...xml.matchAll(/<node [^>]*\/?>(?:<\/node>)?/g)].map((m) => m[0]);
  const attr = (node, name) => (node.match(new RegExp(`${name}="([^"]*)"`)) || [])[1] || "";
  let badge = null;
  for (const n of nodes) {
    if (/^\d{1,2}$/.test(attr(n, "text"))) {
      // числовой TextView шапки — бейдж вкладок (других чисел в шапке нет)
      badge = attr(n, "text");
      break;
    }
  }
  const has = (desc) => nodes.some((n) => attr(n, "content-desc") === desc);
  return {
    badge,
    music: has("Скачать: аудио, видео или субтитры"),
    shield: has("VPN"),
    tabsBtn: has("Вкладки"),
  };
}

/** logcat DuoPulseWeb: строки паттерна (для «переопрос был/не было»). */
const logLines = (re) =>
  adb("logcat", "-d", "-s", "DuoPulseWeb").split("\n").filter((l) => re.test(l));

// ── сценарий ────────────────────────────────────────────────────────────────
const ui = await uiPage();
console.log("UI-webview найден");

// 1) видео-вкладка (хук «▶ duo»: onTabActive → videoOpen=true, бейдж 1)
await ui.evalJs(`window.__duopulseOpenVideo && window.__duopulseOpenVideo('9bZkp7q19f0')`);
await sleep(3000);
let snap = await ui.evalJs("JSON.stringify(window.__duopulseMobileTabs && window.__duopulseMobileTabs())");
check("видео-вкладка открыта (снапшот старта)", JSON.parse(snap).count >= 1);

// 2) web-оверлей с страницей стенда
await ui.invoke("mobile_web_open", { url: `${STAND}?r=${R}`, incognito: false });
const ov = await overlayPage();
const url0 = ov.url;
console.log(`оверлей открыт: ${url0}`);
await sleep(1200); // syncChrome при открытии уже отрисовал состав

let h = dumpHeader();
check("шапка оверлея при открытии: бейдж «1», есть «⬇», нет щита",
  h.badge === "1" && h.music && !h.shield,
  `badge=${h.badge} music=${h.music} shield=${h.shield}`);

// 3) закрытие видео-вкладки из листа ПРЯМЫМ DOM-кликом при ВИДИМОМ оверлее
//    (лист в UI-webview под оверлеем — DOM жив; у пользователя те же
//    кнопки после hide(), здесь меня именно «без смены адреса»)
await ui.evalJs("window.__duopulseShowTabs && window.__duopulseShowTabs()");
await sleep(300);
const closed = await ui.evalJs(
  `(function(){var d=document.querySelector('.m-tabs-del');if(!d)return false;d.click();return true})()`);
check("вкладка закрыта кликом ✕ листа", closed === true);
await sleep(1500); // debounce 200 мс + roundtrip + dump

h = dumpHeader();
check("«⬇» исчез из шапки без смены адреса оверлея",
  !h.music && ov.url === url0, `music=${h.music} url=${ov.url === url0 ? "не менялся" : "ИЗМЕНИЛСЯ"}`);
check("бейдж вкладок опустел (вкладок нет)", !h.badge, `badge=${h.badge ?? "скрыт"}`);
const hs = logLines(/header-state: tabs=\d+ video=\w+ vpn=\w+/);
check("logcat: живой переопрос с новым составом (tabs=0 video=false)",
  hs.some((l) => l.includes("tabs=0 video=false")), hs.at(-1)?.trim() || "нет строк");

// 4) щит VPN: тоннель wg-stand вкл/выкл invoke'ами при том же адресе оверлея
//    (аргументы мобильных VPN-команд — под ключом params; use_profile сам
//    поднимает тоннель, off — use_profile null, как в vpn-core-smoke 169)
const prof = await ui.invoke("mobile_vpn_import_profile", { params: { text: confText, name: "dp212" } });
await ui.invoke("mobile_vpn_use_profile", { params: { id: prof.id } });
let vpnUp = false;
let lastSt = "";
for (let i = 0; i < 80 && !vpnUp; i++) {
  await sleep(750);
  const st = await ui.invoke("mobile_vpn_status", undefined).catch((e) => ({ err: String(e) }));
  lastSt = JSON.stringify(st).slice(0, 160);
  vpnUp = !!st && st.wg?.state === "connected";
}
check("тоннель wg-stand поднят (status connected)", vpnUp, vpnUp ? "" : lastSt);
await sleep(1500); // vpn:state_changed → щит старта → пинг → переопрос

h = dumpHeader();
check("щит VPN появился в шапке без смены адреса",
  h.shield && ov.url === url0, `shield=${h.shield}`);

await ui.invoke("mobile_vpn_use_profile", { params: { id: null } });
let vpnOff = false;
for (let i = 0; i < 20 && !vpnOff; i++) {
  await sleep(750);
  const st = await ui.invoke("mobile_vpn_status", undefined).catch(() => null);
  vpnOff = !!st && st.mode === "off" && st.state === "off";
}
await sleep(1500);
h = dumpHeader();
check("щит VPN исчез после выключения тоннеля", !h.shield && vpnOff,
  `shield=${h.shield} off=${vpnOff}`);

// 5) спрятанный оверлей: тап «Вкладки» шапки (hide + лист старта), затем
//    реальное изменение состояния (переоткрытие видео — счёт 0→1) → пинг
//    пришёл, но переопроса НЕТ («+ Новая вкладка» не годится: newTab()
//    сбрасывает к старту, счёт 0→0 — сигнатура не меняется)
const dumpPath = `/sdcard/window_dump_${process.pid}.xml`;
adb("shell", "uiautomator", "dump", dumpPath);
const xml = adb("exec-out", "cat", dumpPath);
const node = [...xml.matchAll(/<node [^>]*\/?>/g)].map((m) => m[0])
  .find((n) => /content-desc="Вкладки"/.test(n) && /bounds="\[\d+,\d+\]\[\d+,\d+\]"/.test(n));
if (!node) throw new Error("кнопка «Вкладки» шапки не найдена в dump");
const [, x1, y1, x2, y2] = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/).map(Number);
adb("shell", "input", "tap", String(Math.round((x1 + x2) / 2)), String(Math.round((y1 + y2) / 2)));
await sleep(800);
const before = logLines(/header-state:|header-ping:/).length;
await ui.evalJs(`window.__duopulseOpenVideo && window.__duopulseOpenVideo('9bZkp7q19f0')`);
await sleep(1500);
const lines = logLines(/header-state:|header-ping:/);
const added = lines.slice(before);
check("спрятанный оверлей: пинг подавлен, новых переопросов нет",
  added.some((l) => l.includes("header-ping:")) && !added.some((l) => l.includes("header-state:")),
  added.map((l) => l.trim().slice(-60)).join(" | ") || "строк нет");

// ── итог ----------------------------------------------------------------------
const report = {
  card: "duopulse-212",
  when: new Date().toISOString(),
  apk: APK.split("\\").pop(),
  checks,
};
try {
  writeFileSync(join(ROOT, "e2e", "mobile", "header-live-smoke-last-run.json"),
    JSON.stringify(report, null, 2));
  console.log(`итог: ${checks.filter((c) => c.ok).length}/${checks.length} проверок — e2e/mobile/header-live-smoke-last-run.json`);
} catch (e) {
  console.error(`отчёт не записан: ${e.message}`);
}
ov.close();
ui.close();
stand.kill();
server.close();
adb("shell", "am", "force-stop", PKG);
process.exit(process.exitCode || 0);
