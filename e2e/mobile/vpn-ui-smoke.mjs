// E2E-стенд листа «VPN» мобильной ветки (карточка duopulse-171, паритет 8/8):
// полный пользовательский цикл БЕЗ dev-кнопок — только UI (кнопка «VPN: тест»
// этапа 6/8 из листа диагностики убрана этим же этапом). Продолжение
// vpn-core-smoke (169 — ядро) и vpn-route-smoke (170 — маршрутизация): здесь
// проверяется именно ПАНЕЛЬ — меню «⋮» → «VPN»:
//   1. импорт .conf системным файл-пикером SAF (adb push в Download → клик
//      «Импортировать .conf…» → тап по файлу в DocumentsUI, uiautomator);
//   2. тумблер: включение → connected (handshake ≤30 с), живые rx/tx/ping
//      (события vpn:stats в листе), индикатор-щит в шапке (data-vpn);
//   3. режим split через селектор листа + правило «blocked.tun → туннель»
//      инпутом листа: страница открывается тоннелем (wg-stand логирует
//      dns+http), посторонний домен напрямую (стенд его DNS не видит);
//   4. kill-switch: профиль-«чёрная дыра» → после REJECT_AFTER_TIME статус
//      листа внятно показывает «kill-switch: туннель мёртв…», щит error;
//   5. персист: рестарт приложения (force-stop + am start) — режим split и
//      правило на месте, тоннель поднят сам (mobile_vpn_restore на старте UI);
//   6. выключение тумблером → Direct (страница тоннеля больше не грузится),
//      удаление профиля ✕ листа — профили и Keystore-блобы вычищены.
//
// Запуск: node e2e/mobile/vpn-ui-smoke.mjs [путь-к-debug-APK]
// (умолчание — свежий builds/duopulse_*_android_debug/*.apk). Эмулятор уже
// должен работать (ANDROID_SERIAL). wg-stand.exe строится сам при нужде.
// Результат — e2e/mobile/vpn-ui-smoke-last-run.json (gitignore).

import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = "dev.duopulse.mobile";
const CDP_PORT = Number(process.env.CDP_PORT || 9223);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT = join(HERE, "vpn-ui-smoke-last-run.json");
const WG_STAND =
  process.env.E2E_WG_STAND || join(ROOT, "e2e", "wg-stand", "target", "debug", "wg-stand.exe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout)),
    ),
  );

const SERIAL =
  process.env.ANDROID_SERIAL ||
  String(execFileSync("adb", ["devices"]).toString())
    .split("\n")
    .slice(1)
    .find((l) => /\bdevice\b/.test(l))
    ?.split("\t")
    .shift()
    ?.trim();
if (!SERIAL) throw new Error("эмулятор не найден (adb devices)");
const adb = (cmd, ...args) =>
  execFileSync("adb", ["-s", SERIAL, cmd, ...args], { maxBuffer: 16 * 1024 * 1024 }).toString();
const shot = (name) => {
  const p = join(tmpdir(), `duopulse-171-${name}.png`);
  writeFileSync(p, execFileSync("adb", ["-s", SERIAL, "exec-out", "screencap", "-p"], { maxBuffer: 16 * 1024 * 1024 }));
  console.log(`скриншот: ${p}`);
};

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

// --- APK: свежий debug из builds/ ---------------------------------------------
const apkDefault = () => {
  const dirs = readdirSync(join(ROOT, "builds"))
    .filter((d) => /_android_debug$/.test(d))
    .sort();
  for (const d of dirs.reverse()) {
    const apk = readdirSync(join(ROOT, "builds", d)).find((f) => f.endsWith("-debug.apk"));
    if (apk) return join(ROOT, "builds", d, apk);
  }
  throw new Error("debug-APK не найден в builds/ (scripts/android-build.sh debug)");
};
const APK = process.argv[2] || process.env.DUOPULSE_APK || apkDefault();
if (!existsSync(APK)) throw new Error(`APK нет: ${APK}`);
console.log(`APK: ${APK}`);

// --- страница тоннеля + wg-stand ------------------------------------------------
const PAGE_MARKER = "dp171-tunnel-page-ok";
const pagePath = join(tmpdir(), `duopulse-171-page-${process.pid}.html`);
writeFileSync(pagePath, `<!doctype html><title>dp171</title><body><h1>${PAGE_MARKER}</h1></body>`);
if (!existsSync(WG_STAND)) {
  console.log("wg-stand.exe нет — собираю (e2e/wg-stand)…");
  await run("cargo", ["build", "--manifest-path", join(ROOT, "e2e", "wg-stand", "Cargo.toml")]);
}
const confLive = join(tmpdir(), `duopulse-171-live-${process.pid}.conf`);
const stand = spawn(WG_STAND, ["--conf", confLive, `--serve`, `/vpn-ui.html=${pagePath}:text/html`], {
  stdio: ["ignore", "pipe", "inherit"],
});
const standEvents = [];
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
      standEvents.push(ev);
      if (ev.ev === "ready") standReady(ev);
    } catch { /* не-JSON строка стенда — мимо */ }
  }
});
const ready = await standReadyP;
console.log(`wg-stand: udp ${ready.udp_port}, conf ${confLive}`);
const confLiveText = readFileSync(confLive, "utf8").replace("Endpoint = 127.0.0.1:", "Endpoint = 10.0.2.2:");
if (!confLiveText.includes("10.0.2.2:")) throw new Error("endpoint не подменён — конфиг стенда другой");
const standCount = (fn) => standEvents.filter(fn).length;
const standHttp = () => standCount((e) => e.ev === "http");
const standDns = (name) => standCount((e) => e.ev === "dns" && e.name === name);

// .conf для SAF: кладём в Download эмулятора ПОДМЕНЁННЫЙ текст (endpoint
// 10.0.2.2 — хост глазами эмулятора; сам файл confLive — 127.0.0.1, для хоста)
const confPatched = join(tmpdir(), `duopulse-171-patched-${process.pid}.conf`);
writeFileSync(confPatched, confLiveText);
// имя уникально на прогон: ЗАМЕНА существующего файла не переиндексируется
// MediaProvider — Recent пикера оставался пустым/протухшим (поймано прогоном 5)
const confName = `wg-stand-171-${process.pid}.conf`;
const confOnDevice = `/sdcard/Download/${confName}`;
adb("push", confPatched, confOnDevice);

// --- установка и запуск ---------------------------------------------------------
try { adb("uninstall", PKG); } catch { /* не была установлена */ }
adb("install", "-r", APK);
adb("shell", "pm", "clear", PKG);
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
    return (await (await fetch(`http://localhost:${CDP_PORT}/json`)).json()).filter((t) => t.type === "page");
  } catch { return []; }
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
  const evalJs = (expr) =>
    new Promise((res, rej) => {
      const id = ++i;
      pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result.result.value)));
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true } }));
    });
  const invoke = (cmd, args) =>
    evalJs(`window.__TAURI__.core.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
  return { evalJs, invoke, url: t.url, close: () => ws.close() };
}
let ui = null;
for (let a = 0; a < 40 && !ui; a++) {
  for (const t of await targets()) {
    const c = await connect(t).catch(() => null);
    if (!c) continue;
    if ((await c.evalJs("typeof window.__duopulseOpenVideo").catch(() => "")) === "function") { ui = c; break; }
    c.close();
  }
  if (!ui) await sleep(500);
}
if (!ui) throw new Error("UI-webview мобильной ветки не найден");

const status = () => ui.invoke("mobile_vpn_status", undefined);
/** Открыть лист «VPN» из меню «⋮» и снять снапшот __duopulseMobileVpn. */
const openVpnSheet = async () => {
  await ui.evalJs(`(async () => {
    document.getElementById("mMenu").click();
    await new Promise((r) => setTimeout(r, 350));
    document.getElementById("mVpn").click();
    await new Promise((r) => setTimeout(r, 450));
    return "ok";
  })()`);
  return sheetSnap();
};
const sheetSnap = () =>
  ui.evalJs("JSON.stringify(window.__duopulseMobileVpn?.() ?? null)").then((s) => JSON.parse(s));
const closeSheet = () => ui.evalJs(`document.querySelector(".m-sheet-wrap:not([hidden]) .m-sheet-backdrop")?.click(); "ok"`);
/** Ждать состояние тоннеля в снапшоте листа (poll __duopulseMobileVpn). */
async function waitSheet(pred, ms, label) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await sheetSnap();
    if (pred(last)) return last;
    await sleep(1000);
  }
  return last;
}

// --- 1. лист до профилей: «нет сервера», тумблер не включается -------------------
await openVpnSheet();
let snap = await sheetSnap();
check("лист «VPN» из меню ⋮: открыт, профилей нет, режим off",
  snap?.open === true && snap.profiles === 0 && snap.routing === "off" && snap.tunnelOn === false,
  JSON.stringify(snap).slice(0, 100));
const noProfile = await ui.evalJs(`(async () => {
  document.querySelector(".m-vpn-switch").click();
  await new Promise((r) => setTimeout(r, 500));
  return JSON.stringify({
    checked: document.querySelector(".m-vpn-switch").checked,
    detail: document.querySelector(".m-vpn-detail").textContent,
  });
})()`);
check("тумблер без профиля не включается, причина — импортировать .conf",
  JSON.parse(noProfile).checked === false && /импортируйте/i.test(JSON.parse(noProfile).detail),
  JSON.parse(noProfile).detail.slice(0, 60));
shot("sheet-empty");

// --- 2. импорт через системный SAF-пикер ----------------------------------------
await ui.evalJs(`document.querySelector(".m-vpn-import").click(); "ok"`);
await sleep(1800); // DocumentsUI поднялся
/** uiautomator-тап по узлу (физические пиксели из bounds). pred выбирает узел;
 *  при нескольких совпаданиях предпочитаем clickable (пункты списков/кнопки —
 *  кликабельны, заголовки с тем же текстом — нет). */
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
let safOk = false;
// Recent-вид пикера уже показывает свежезапушенный файл (MediaProvider
// индексирует adb push) — тапаем его сразу; тап по координатам текста
// срабатывает и в некликабельном узле (touch уходит кликабельному предку).
// Фолбэк — навигация drawer'ом: Show roots → Downloads → файл (в drawer
// узлы кликабельны, точные совпадения — заголовки с тем же текстом
// некликабельны, тап по ним молчит; поймано прогонами 2–3).
safOk = await uiTapText((n) => n.text.includes(confName), "${confName} (Recent)", 4);
if (!safOk) {
  if (await uiTapText((n) => /^Show roots$|^Показать корни$/.test(n.desc), "Show roots")) {
    await sleep(1000);
    // тап по координатам текста: клик уходит кликабельному предку —
    // сами строки drawer'а в dump бывают некликабельны (прогон 5)
    if (await uiTapText((n) => n.text === "Downloads" || n.text === "Загрузки" || n.desc === "Downloads", "Downloads (roots)")) {
      await sleep(1000);
      safOk = await uiTapText((n) => n.text.includes(confName), "wg-stand-171.conf");
    }
  }
}
if (!safOk) shot("saf-stuck");
check("SAF-пикер: .conf выбран в DocumentsUI (тап по файлу)", safOk, safOk ? "" : "см. скриншот saf-stuck");
// итог глобала __duopulseVpnConfPicked → импорт в Core → строка списка
snap = await waitSheet((s) => s?.profiles === 1, 8000, "импорт");
check("импорт SAF: профиль в списке листа, причина «нет сервера» ушла",
  snap?.profiles === 1 && !/импортируйте/i.test(String(await ui.evalJs(`document.querySelector(".m-vpn-detail").textContent`))),
  `profiles=${snap?.profiles}`);
shot("sheet-imported");

// --- 3. тумблер: включение → connected, щит, живые rx/tx ------------------------
await ui.evalJs(`document.querySelector(".m-vpn-switch").click(); "ok"`);
snap = await waitSheet((s) => s?.tunnelOn === true && s?.wgState === "connected", 30000, "handshake");
check("тумблер листа: тоннель connected (handshake ≤30 с)",
  snap?.tunnelOn === true && snap?.wgState === "connected",
  `state=${snap?.wgState} routing=${snap?.routing}`);
check("индикатор-щит в шапке: показан, connected",
  snap?.shield === "connected" &&
  await ui.evalJs(`(() => { const b = document.querySelector(".m-vpn-shield"); return getComputedStyle(b).display !== "none" && b.offsetParent !== null; })()`),
  `shield=${snap?.shield}`);
const rx0 = snap?.rx ?? 0;
await ui.invoke("mobile_vpn_test_connection", { params: { probe: "blocked.tun:80" } }).catch(() => {});
snap = await waitSheet((s) => (s?.rx ?? 0) > rx0, 15000, "rx растёт");
check("живая статистика в листе: rx/tx/ping обновляются (vpn:stats)",
  (snap?.rx ?? 0) > rx0 && typeof snap?.ping === "number",
  `rx ${rx0} → ${snap?.rx}, ping=${snap?.ping}`);
shot("sheet-on");

// --- 4. split через лист: правило «blocked.tun → туннель» ----------------------
await ui.evalJs(`(async () => {
  document.querySelector('.m-vpn-modes button[data-mode="split"]').click();
  await new Promise((r) => setTimeout(r, 600));
  return "ok";
})()`);
const ruleAdd = await ui.evalJs(`(async () => {
  const i = document.querySelector(".m-vpn-rule-domain");
  i.value = "blocked.tun";
  document.querySelector('.m-vpn-rule-btn[data-route="tunnel"]').click();
  await new Promise((r) => setTimeout(r, 700));
  return JSON.stringify({ rules: window.__duopulseMobileVpn().rules, mode: window.__duopulseMobileVpn().routing,
    flash: document.querySelector(".m-vpn-detail").textContent });
})()`);
const rule = JSON.parse(ruleAdd);
check("режим split выбран селектором листа, правило добавлено инпутом",
  rule.mode === "split" && rule.rules === 1 && /через туннель/.test(rule.flash),
  `mode=${rule.mode} rules=${rule.rules} flash=${rule.flash.slice(0, 40)}`);
// оверлей: страница тоннеля грузится (правило), посторонний домен — напрямую
const http0 = standHttp();
await ui.invoke("mobile_web_open", { url: "http://blocked.tun/vpn-ui.html" });
await sleep(2500);
let overlay = null;
for (let i = 0; i < 20 && !overlay; i++) {
  for (const t of await targets()) {
    if (!t.url.includes("blocked.tun")) continue;
    overlay = await connect(t).catch(() => null);
  }
  if (!overlay) await sleep(500);
}
let marker = "";
for (let i = 0; i < 20 && !marker.includes(PAGE_MARKER); i++) {
  marker = overlay ? await overlay.evalJs("document.body?.innerText || ''").catch(() => "") : "";
  if (!marker.includes(PAGE_MARKER)) { await sleep(500); }
}
check("split-правило: blocked.tun открыт ЧЕРЕЗ тоннель (маркер в оверлее)",
  marker.includes(PAGE_MARKER) && standDns("blocked.tun") >= 1 && standHttp() > http0,
  `dns=${standDns("blocked.tun")} http+${standHttp() - http0}`);
await ui.invoke("mobile_web_close", undefined).catch(() => {});
await sleep(800);
// посторонний домен — напрямую: стенд его DNS не видит (тоннельный DNS только
// у правил «туннель»; youtube.com резолвит системный DNS эмулятора)
const dnsYt0 = standDns("www.youtube.com");
await ui.invoke("mobile_web_open", { url: "http://www.youtube.com/" }).catch(() => {});
await sleep(4000);
check("split: домен без правила идёт напрямую (DNS стенда нет)",
  standDns("www.youtube.com") === dnsYt0, `dns youtube=${standDns("www.youtube.com")}`);
await ui.invoke("mobile_web_close", undefined).catch(() => {});
await sleep(800);
shot("sheet-split");

// --- 4b. kill-switch: профиль-«чёрная дыра» — статус листа внятно о мёртвом ----
// (чужой ключ пира + закрытый UDP-порт: handshake не случится, после
// REJECT_AFTER_TIME (180 с от старта сессии) тоннель мёртв — fail-closed)
const confDeadText = confLiveText
  .replace(/PublicKey = (.)/, (m, c) => `PublicKey = ${c === "B" ? "C" : "B"}`)
  .replace(/Endpoint = 10\.0\.2\.2:\d+/, "Endpoint = 10.0.2.2:1");
const deadImport = await ui.invoke("mobile_vpn_import_profile", { params: { text: confDeadText, name: "dead.conf" } });
check("kill-switch: профиль-дыра импортирован (другой id)", !!deadImport.id && deadImport.id !== undefined, deadImport.id);
// лист перерисовать: импорт шёл мимо UI (invoke) — переоткрываем список
await closeSheet();
await openVpnSheet();
// переключение профиля — тап по строке списка (тоннель поднят → смена сразу)
await ui.evalJs(`(async () => {
  const row = [...document.querySelectorAll(".m-vpn-profile")].find((b) => b.textContent.includes("dead"));
  row?.click();
  await new Promise((r) => setTimeout(r, 600));
  return "ok";
})()`);
console.log("kill-switch: жду REJECT_AFTER_TIME (180 с)…");
snap = await waitSheet((s) => s?.wgState === "error", 200_000, "kill-switch");
const killDetail = String(await ui.evalJs(`document.querySelector(".m-vpn-detail").textContent`));
check("kill-switch: статус листа внятно о мёртвом тоннеле (fail-closed)",
  snap?.wgState === "error" && /kill-switch/.test(killDetail) && snap?.shield === "error",
  `state=${snap?.wgState} shield=${snap?.shield} detail=${killDetail.slice(0, 60)}`);
shot("sheet-killswitch");
// возврат к живому профилю — тап по строке (для рестарта ниже)
await ui.evalJs(`(async () => {
  const row = [...document.querySelectorAll(".m-vpn-profile")].find((b) => b.textContent.includes("wg-stand"));
  row?.click();
  await new Promise((r) => setTimeout(r, 600));
  return "ok";
})()`);
snap = await waitSheet((s) => s?.wgState === "connected", 30000, "возврат к живому");
check("возврат к живому профилю тапом списка: тоннель снова connected",
  snap?.wgState === "connected" && snap?.shield === "connected", `state=${snap?.wgState}`);

// --- 5. персист: рестарт приложения — режим/правило/тоннель возвращаются -------
adb("shell", "am", "force-stop", PKG);
await sleep(1200);
adb("shell", "am", "start", "-n", `${PKG}/.MainActivity`);
pid = "";
for (let i = 0; i < 30 && !pid; i++) {
  try { pid = adb("shell", "pidof", PKG).trim(); } catch { /* стартует */ }
  if (!pid) await sleep(500);
}
if (!pid) throw new Error("процесс приложения не поднялся после рестарта");
adb("forward", `tcp:${CDP_PORT}`, `localabstract:webview_devtools_remote_${pid}`);
ui.close();
ui = null;
for (let a = 0; a < 40 && !ui; a++) {
  for (const t of await targets()) {
    const c = await connect(t).catch(() => null);
    if (!c) continue;
    if ((await c.evalJs("typeof window.__duopulseOpenVideo").catch(() => "")) === "function") { ui = c; break; }
    c.close();
  }
  if (!ui) await sleep(500);
}
if (!ui) throw new Error("UI-webview после рестарта не найден");
// restore на старте поднимает тоннель в сохранённом split — щит в шапке
let shieldAfter = null;
for (let i = 0; i < 30 && !shieldAfter; i++) {
  shieldAfter = await ui.evalJs(`(() => {
    const b = document.querySelector(".m-vpn-shield");
    return b && getComputedStyle(b).display !== "none" ? b.dataset.vpn : null;
  })()`);
  if (!shieldAfter) await sleep(1000);
}
check("рестарт: тоннель поднят сам (restore), щит в шапке connected",
  shieldAfter === "connected", `shield=${shieldAfter}`);
await openVpnSheet();
snap = await sheetSnap();
check("рестарт: режим split и правило пережили перезапуск (split-rules.json)",
  snap?.routing === "split" && snap?.rules === 1 && snap?.tunnelOn === true,
  `routing=${snap?.routing} rules=${snap?.rules}`);
// страница тоннеля снова открывается (правило живое)
const http1 = standHttp();
await ui.invoke("mobile_web_open", { url: "http://blocked.tun/vpn-ui.html?restart=1" });
await sleep(3000);
check("рестарт: правило действует — страница тоннеля снова через тоннель",
  standHttp() > http1, `http+${standHttp() - http1}`);
await ui.invoke("mobile_web_close", undefined).catch(() => {});
await sleep(600);

// --- 6. выключение тумблером → Direct; удаление профиля ✕ ----------------------
await ui.evalJs(`document.querySelector(".m-vpn-switch").click(); "ok"`);
snap = await waitSheet((s) => s?.tunnelOn === false, 10000, "выключение");
check("тумблер выкл: Direct без перезапуска, щит скрыт",
  snap?.tunnelOn === false && snap?.routing === "off" &&
  await ui.evalJs(`(() => { const b = document.querySelector(".m-vpn-shield"); return b.hidden && getComputedStyle(b).display === "none"; })()`) === true,
  `routing=${snap?.routing}`);
const http2 = standHttp();
await ui.invoke("mobile_web_open", { url: "http://blocked.tun/vpn-ui.html?off=1" }).catch(() => {});
await sleep(4000);
check("Direct: страница тоннеля не грузится, стенд молчит",
  standHttp() === http2, `http+${standHttp() - http2}`);
await ui.invoke("mobile_web_close", undefined).catch(() => {});
await sleep(600);
// удаление профилей кнопкой ✕ листа (все — и живой, и дыра)
await openVpnSheet();
const delRes = await ui.evalJs(`(async () => {
  for (let i = 0; i < 4 && document.querySelectorAll(".m-vpn-profile-del").length; i++) {
    document.querySelector(".m-vpn-profile-del").click();
    await new Promise((r) => setTimeout(r, 900));
  }
  return JSON.stringify(window.__duopulseMobileVpn());
})()`);
const del = JSON.parse(delRes);
let blobsLeft = "";
try { blobsLeft = adb("shell", "run-as", PKG, "ls", "files/profile/vpn/wg").trim(); } catch { /* каталог убран — пусто */ }
check("удаление профиля ✕: список пуст, Keystore-блоб выгружен",
  del.profiles === 0 && (blobsLeft === "" || /No such file/.test(blobsLeft)),
  `profiles=${del.profiles} blobs=${JSON.stringify(blobsLeft)}`);
shot("sheet-cleanup");

ui.close();
stand.kill();
writeFileSync(OUT, JSON.stringify({ apk: APK, serial: SERIAL, at: new Date().toISOString(), results, standEvents }, null, 2));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${results.length - failed}/${results.length}`);
process.exit(failed === 0 ? 0 : 1);
