// E2E-стенд маршрутизации трафика приложения через тоннель (карточка
// duopulse-170, паритет-мобайл 7/8): debug-APK на эмуляторе против живого
// WG-сервера e2e/wg-stand на хосте (10.0.2.2). Продолжение vpn-core-smoke
// (169 — ядро тоннеля): здесь проверяется ПЕРЕНАПРАВЛЕНИЕ трафика —
// androidx.webkit ProxyController ставит WebView приложения на
// http://127.0.0.1:<http_port> Rust-роутера (новый HTTP-листенер
// CONNECT/absolute-form), фетчи Core ходят через его SOCKS5-порт.
//
// Сценарии (критерии карточки):
//   1. тумблер VPN (use_profile) переключает маршрутизацию БЕЗ перезапуска
//      приложения: роутер → Wg/Direct, прокси WebView применяется/снимается
//      (logcat DuoPulseProxy), UI-фронт при включённом прокси жив (bypass
//      *.localhost: invoke/лист диагностики работают);
//   2. web-оверлей: страница http://blocked.tun/vpn-route.html открывается
//      ЧЕРЕЗ тоннель — wg-stand логирует dns+http (absolute-form путь), в
//      overlay-webview виден маркер страницы; https-запрос (CONNECT) доходит
//      до стенда tcp-событием;
//   3. core-фетч: duo_yt_player при включённом тоннеле уходит в роутер —
//      wg-stand видит DNS-запрос www.youtube.com, запрос не проходит
//      напрямую (в туннеле нет интернета) — путь фетча = тоннель;
//   4. kill-switch fail-closed: профиль-«чёрная дыра» — страницы оверлея не
//      грузятся, новых событий стенда нет, напрямую мимо тоннеля ничего;
//   5. выключение возвращает Direct без перезапуска: blocked.tun больше не
//      резолвится системным DNS (ERR_NAME_NOT_RESOLVED в оверлее), новых
//      событий стенда нет, UI жив, повторное включение снова пускает трафик.
//
// Запуск: node e2e/mobile/vpn-route-smoke.mjs [путь-к-debug-APK]
// (умолчание — свежий builds/duopulse_*_android_debug/*.apk). Эмулятор уже
// должен работать (ANDROID_SERIAL). wg-stand.exe строится сам при нужде.
// Результат — e2e/mobile/vpn-route-smoke-last-run.json (gitignore).

import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = "dev.duopulse.mobile";
const CDP_PORT = Number(process.env.CDP_PORT || 9223);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT = join(HERE, "vpn-route-smoke-last-run.json");
const WG_STAND =
  process.env.E2E_WG_STAND || join(ROOT, "e2e", "wg-stand", "target", "debug", "wg-stand.exe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout)),
    ),
  );

const SERIAL = process.env.ANDROID_SERIAL ||
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
  const p = join(tmpdir(), `duopulse-170-${name}.png`);
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

// --- страница для оверлея (маркер тела проверяем в webview) --------------------
const PAGE_MARKER = "dp170-tunnel-page-ok";
const pagePath = join(tmpdir(), `duopulse-170-page-${process.pid}.html`);
writeFileSync(pagePath, `<!doctype html><title>dp170</title><body><h1>${PAGE_MARKER}</h1></body>`);

// --- wg-stand: сервер WG на хосте, раздаёт страницу в туннеле ------------------
if (!existsSync(WG_STAND)) {
  console.log("wg-stand.exe нет — собираю (e2e/wg-stand)…");
  await run("cargo", ["build", "--manifest-path", join(ROOT, "e2e", "wg-stand", "Cargo.toml")]);
}
const confLive = join(tmpdir(), `duopulse-170-live-${process.pid}.conf`);
const stand = spawn(WG_STAND, ["--conf", confLive, `--serve`, `/vpn-route.html=${pagePath}:text/html`], {
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
// «Чёрная дыра» для kill-switch: чужой ключ пира + закрытый UDP-порт хоста.
const confDeadText = confLiveText
  .replace(/PublicKey = (.)/, (m, c) => `PublicKey = ${c === "B" ? "C" : "B"}`)
  .replace(/Endpoint = 10\.0\.2\.2:\d+/, "Endpoint = 10.0.2.2:1");
const standCount = (fn) => standEvents.filter(fn).length;
const standHttp = () => standCount((e) => e.ev === "http");
const standTcp = () => standCount((e) => e.ev === "tcp");
const standDns = (name) => standCount((e) => e.ev === "dns" && e.name === name);

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
// UI-webview — по хуку __duopulseOpenVideo (как 169); overlay-webview — позже
// по URL-предикату (страница из туннеля).
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
const tunnelUp = async (ms) => {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await status();
    if (last.wg && last.wg.state !== "connecting") return last;
    await sleep(1000);
  }
  return last;
};
/** Ждать overlay-webview с URL-предикатом (новая цель появляется в /json). */
async function overlayPage(pred, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    for (const t of await targets()) {
      if (!pred(t.url)) continue;
      const c = await connect(t).catch(() => null);
      if (c) return c;
    }
    await sleep(500);
  }
  return null;
}
const openOverlay = (url) => ui.invoke("mobile_web_open", { url });
const closeOverlay = () => ui.invoke("mobile_web_close", undefined).catch(() => {});

// --- 0. до VPN: оверлей открывает страницу стенда НАПРЯМУЮ (не должен) ----------
// blocked.tun резолвится только туннельным DNS стенда: прямой путь это
// ERR_NAME_NOT_RESOLVED — факел «страница живёт в туннеле», не в кэше WebView.
await openOverlay("http://blocked.tun/vpn-route.html");
await sleep(2500);
let overlay = await overlayPage((u) => u.includes("blocked.tun"), 3000);
const preBody = overlay ? await overlay.evalJs("document.body?.innerText || ''").catch(() => "") : "";
check("до VPN: blocked.tun напрямую не резолвится (маркер не виден)", !preBody.includes(PAGE_MARKER),
  overlay ? `body=${preBody.slice(0, 40)}` : "цель не поднялась/не нашлась");
await closeOverlay();
await sleep(800);

// --- 1. включение VPN: роутер + прокси WebView, UI жив (bypass) -----------------
const imported = await ui.invoke("mobile_vpn_import_profile", { params: { text: confLiveText, name: "wg-stand.conf" } });
check("импорт профиля стенда", !!imported.id, imported.endpoint);
const useRes = await ui.invoke("mobile_vpn_use_profile", { params: { id: imported.id } });
check("use_profile: режим wg", useRes.mode === "wg" && !!useRes.wg, useRes.wg?.state || "");
const up = await tunnelUp(30000);
check("handshake тоннеля: connected", up.wg?.state === "connected", `handshake ${up.wg?.lastHandshakeMs} мс назад`);
shot("vpn-on");
// Прокси WebView применился — строка logcat DuoPulseProxy (перезагрузка страниц).
const logProxy = adb("shell", "logcat", "-d", "-s", "DuoPulseProxy").toString();
check("прокси WebView применён (logcat DuoPulseProxy, перезагрузка страниц)",
  /прокси WebView применён/.test(logProxy) && /перезагружаю/.test(logProxy),
  (logProxy.match(/прокси WebView применён.*|перезагружаю.*/g) || ["нет строк"]).join(" | ").slice(0, 120));
// UI-фронт жив при включённом прокси: invoke ходит, лист диагностики открывается
// (asset.localhost/ipc — bypass; секция VPN показывает режим wg).
const diagOpen = await ui.evalJs(`(async () => {
  document.getElementById("mMenu").click();
  await new Promise((r) => setTimeout(r, 400));
  document.getElementById("mDiag").click();
  await new Promise((r) => setTimeout(r, 700));
  return window.__duopulseMobileDiagnostics?.() ?? null;
})()`);
check("UI-фронт жив при прокси: лист диагностики открыт (bypass)", diagOpen?.open === true,
  JSON.stringify(diagOpen).slice(0, 80));
const diagReport = await ui.evalJs("JSON.stringify(window.__duopulseMobileDiagnostics?.() ?? {}).replace(/\\\\\"/g, '\"')");
// секция VPN в отчёте снимка: режим wg + endpoint стенда (duopulse-170)
const snapVpn = await ui.evalJs(`(async () => {
  const r = window.__duopulseMobileDiagnostics?.().report || "";
  return JSON.stringify({ wg: /VPN: connected/.test(r) || /VPN: connecting/.test(r), ep: r.includes("10.0.2.2:${ready.udp_port}") });
})()`);
check("лист диагностики: секция VPN (режим wg, endpoint стенда)", !!snapVpn && JSON.parse(snapVpn).wg && JSON.parse(snapVpn).ep, snapVpn || "");
await ui.evalJs(`document.querySelector(".m-sheet-backdrop")?.click(); "ok"`);

// --- 2. оверлей через тоннель: страница стенда (absolute-form) + CONNECT --------
const http0 = standHttp();
const tcp0 = standTcp();
await openOverlay("http://blocked.tun/vpn-route.html");
overlay = await overlayPage((u) => u.includes("blocked.tun"), 20000);
let marker = "";
if (overlay) {
  for (let i = 0; i < 20 && !marker; i++) {
    marker = await overlay.evalJs("document.body?.innerText || ''").catch(() => "");
    if (!marker.includes(PAGE_MARKER)) { await sleep(500); marker = ""; }
  }
}
check("оверлей: страница открылась ЧЕРЕЗ тоннель (маркер в webview)", marker.includes(PAGE_MARKER),
  `body=${marker.slice(0, 40)}`);
await sleep(500);
check("wg-stand: DNS blocked.tun + HTTP-хит absolute-form из тоннеля",
  standDns("blocked.tun") >= 1 && standHttp() > http0,
  `dns=${standDns("blocked.tun")} http=${standHttp() - http0}`);
shot("overlay-tunnel");
// CONNECT-путь (https): до стенда доходит tcp-соединение, TLS-рукопожатие
// честно падает — страница не грузится, но путь виден событием tcp.
await overlay?.evalJs(`fetch("https://blocked.tun:80/", { mode: "no-cors" }).catch(() => "err")`).catch(() => {});
for (let i = 0; i < 20 && standTcp() === tcp0; i++) await sleep(500);
check("CONNECT (https-цель): соединение дошло до стенда тоннелем", standTcp() > tcp0, `tcp=${standTcp() - tcp0}`);
await closeOverlay();
await sleep(800);

// --- 3. core-фетч через роутер: duo_yt_player уходит в тоннель ------------------
// В туннеле нет интернета: прямой фетч бы прошёл (интернет эмулятора жив),
// тоннельный — падает, и wg-stand видит DNS www.youtube.com.
// Итог invoke пакуем в JSON-строку: отказ команды прилетает
// exceptionDetails'ом CDP, обычный evalJs-хелпк его теряет (поймано
// прогоном: ошибка выглядела «прошедшим напрямую ответом»).
const dnsYt0 = standDns("www.youtube.com");
const coreRaw = await ui.evalJs(
  `window.__TAURI__.core.invoke("duo_yt_player", ${JSON.stringify({ videoId: "iG9CE55wbtY" })})` +
    `.then(() => JSON.stringify({ ok: true }))` +
    `.catch((e) => JSON.stringify({ ok: false, e: String(e) }))`,
);
const core = JSON.parse(coreRaw || "{}");
for (let i = 0; i < 20 && standDns("www.youtube.com") === dnsYt0; i++) await sleep(500);
check("core-фетч (duo_yt_player): DNS ушёл тоннелем на стенд",
  standDns("www.youtube.com") > dnsYt0, `dns=${standDns("www.youtube.com") - dnsYt0}`);
check("core-фетч: напрямую мимо тоннеля не прошёл (в туннеле нет YouTube)",
  core.ok === false && /сеть|SOCKS|innertube|Connection|таймаут/i.test(core.e || ""),
  core.ok ? "ответ прошёл напрямую?!" : String(core.e).slice(0, 90));

// --- 4. kill-switch: чёрная дыра — оверлей не грузится, стенд молчит ------------
const deadImport = await ui.invoke("mobile_vpn_import_profile", { params: { text: confDeadText, name: "dead.conf" } });
await ui.invoke("mobile_vpn_use_profile", { params: { id: deadImport.id } });
const http1 = standHttp();
const dns1 = standEvents.filter((e) => e.ev === "dns").length;
await sleep(1500); // прокси переприменился (другой порт не нужен — роутер уже Wg-дыра)
await openOverlay("http://blocked.tun/vpn-route.html");
await sleep(6000);
let deadOverlay = await overlayPage((u) => u.includes("blocked.tun"), 3000);
const deadBody = deadOverlay ? await deadOverlay.evalJs("document.body?.innerText || ''").catch(() => "") : "";
check("kill-switch: страница тоннеля НЕ открылась (мимо тоннеля ничего)",
  !deadBody.includes(PAGE_MARKER), `body=${deadBody.slice(0, 50)}`);
check("kill-switch: новых хитов стенда нет (прямых ходов роутер не делает)",
  standHttp() === http1 && standEvents.filter((e) => e.ev === "dns").length === dns1,
  `http+${standHttp() - http1} dns+${standEvents.filter((e) => e.ev === "dns").length - dns1}`);
await closeOverlay();
await sleep(800);

// --- 5. выключение: Direct без перезапуска + повторное включение ----------------
const offRes = await ui.invoke("mobile_vpn_use_profile", { params: { id: null } });
check("выключение: режим off", offRes.mode === "off" && !offRes.wg, offRes.detail);
const logClear = adb("shell", "logcat", "-d", "-s", "DuoPulseProxy").toString();
check("прокси WebView снят (logcat)", /прокси WebView снят/.test(logClear), "");
const http2 = standHttp();
// query-суффикс — другой ключ HTTP-кэша WebView: доказываем именно СЕТЬ,
// а не выдачу страницы из кэша успешной загрузки тоннеля
await openOverlay("http://blocked.tun/vpn-route.html?direct=1");
await sleep(5000);
let offOverlay = await overlayPage((u) => u.includes("blocked.tun"), 3000);
const offBody = offOverlay ? await offOverlay.evalJs("document.body?.innerText || ''").catch(() => "") : "";
check("Direct: blocked.tun системным DNS не резолвится (страницы нет, стенд молчит)",
  !offBody.includes(PAGE_MARKER) && standHttp() === http2, `http+${standHttp() - http2}`);
await closeOverlay();
await sleep(800);
// UI жив после выключения — тот же процесс, invoke ходит
const stAfter = await status();
check("после выключения: тот же процесс, UI жив (status off)", stAfter.mode === "off", stAfter.detail);
// повторное включение тем же приложением — трафик снова в тоннеле
await ui.invoke("mobile_vpn_use_profile", { params: { id: imported.id } });
const reUp = await tunnelUp(30000);
const http3 = standHttp();
await openOverlay("http://blocked.tun/vpn-route.html?again=1");
overlay = await overlayPage((u) => u.includes("blocked.tun"), 20000);
let reMarker = "";
if (overlay) {
  for (let i = 0; i < 20 && !reMarker; i++) {
    reMarker = await overlay.evalJs("document.body?.innerText || ''").catch(() => "");
    if (!reMarker.includes(PAGE_MARKER)) { await sleep(500); reMarker = ""; }
  }
}
check("повторное включение: страница снова через тоннель (без перезапуска)",
  reUp.wg?.state === "connected" && reMarker.includes(PAGE_MARKER) && standHttp() > http3,
  `state=${reUp.wg?.state} http+${standHttp() - http3}`);
await closeOverlay();

// --- гигиена --------------------------------------------------------------------
for (const id of [imported.id, deadImport.id]) await ui.invoke("mobile_vpn_remove_profile", { params: { id } });
const list2 = await ui.invoke("mobile_vpn_list_profiles", undefined);
check("гигиена: профили вычищены, режим off", list2.length === 0, `profiles=${list2.length}`);

ui.close();
stand.kill();
writeFileSync(OUT, JSON.stringify({ apk: APK, serial: SERIAL, at: new Date().toISOString(), results, standEvents }, null, 2));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${results.length - failed}/${results.length}`);
process.exit(failed === 0 ? 0 : 1);
