// E2E-стенд тоннель-ядра WireGuard мобильной ветки (карточка duopulse-169,
// паритет-мобайл 6/8): boringtun+smoltcp из десктопного vpn/wg.rs работает
// на Android без TUN-драйвера — проверяется debug-APK на эмуляторе против
// живого WG-сервера e2e/wg-stand на машине разработчика (эмулятор видит хост
// как 10.0.2.2 — alias на loopback-интерфейс хоста, UDP входит).
//
// Сценарии (критерии карточки):
//   1. импорт ТЕКСТА .conf (mobile_vpn_import_profile): профиль в списке,
//      endpoint/address/dns на месте; активным становится по use_profile;
//   2. подъём тоннеля (use_profile): status mode=wg, состояние
//      connecting→connected, handshake возраст, endpoint, rx/tx растут;
//      события vpn:state_changed/vpn:stats приходят формами десктопного
//      контракта vpn.* (camelCase: profileId/rxBytes/lastHandshakeMs…);
//   3. проба test_connection ЦЕЛЬЮ ИЗ ТОННЕЛЯ (blocked.tun:80): DNS-запрос и
//      HTTP-хит видит wg-stand (трафик идёт через тоннель, не напрямую);
//   4. приватный ключ — под Android Keystore: блоб files/profile/vpn/wg/
//      <id>.bin начинается «v1:» и НЕ содержит ключа из .conf; в
//      wg-profiles.json ключа тоже нет (run-as, debug-APK);
//   5. кнопка «VPN: тест» листа «Диагностика» (этап 6, временная): открываем
//      меню «⋮» → Диагностика → кнопка; итог в window.__duopulseVpnTest
//      (проба переопределяется localStorage __duopulseVpnProbe);
//   6. kill-switch fail-closed: профиль с чёрной дырой (чужой ключ пира,
//      закрытый порт) — тоннель не поднимается; проба ДО порога мёртвости
//      отваливается по таймауту туннельного DNS (напрямую не ходим), после
//      REJECT_AFTER_TIME (180 с) status «мёртв» (error/kill-switch), новые
//      соединения отказывают мгновенно с причиной kill-switch;
//   7. гигиена: выключение (use_profile null → off, событие «выключен»),
//      удаление профилей вычищает и Keystore-блобы.
//
// Запуск: node e2e/mobile/vpn-core-smoke.mjs [путь-к-debug-APK]
// (умолчание — свежий builds/duopulse_*_android_debug/*.apk). Эмулятор уже
// должен работать (ANDROID_SERIAL). wg-stand.exe строится сам при нужде.
// Результат — e2e/mobile/vpn-core-smoke-last-run.json (gitignore).

import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = "dev.duopulse.mobile";
const CDP_PORT = Number(process.env.CDP_PORT || 9223);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT = join(HERE, "vpn-core-smoke-last-run.json");
const WG_STAND =
  process.env.E2E_WG_STAND || join(ROOT, "e2e", "wg-stand", "target", "debug", "wg-stand.exe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout)),
    ));

const SERIAL = process.env.ANDROID_SERIAL ||
  String(execFileSync("adb", ["devices"]).toString())
    .split("\n")
    .slice(1)
    .find((l) => /\bdevice\b/.test(l))
    ?.split("\t")
    .shift()
    ?.trim();
if (!SERIAL) throw new Error("эмулятор не найден (adb devices)");
const adb = (...args) => execFileSync("adb", ["-s", SERIAL, ...args], { maxBuffer: 16 * 1024 * 1024 }).toString();
const shot = (name) => {
  // Buffer без encoding: utf8-строка портила бинарные байты PNG (duopulse-166)
  const p = join(tmpdir(), `duopulse-169-${name}.png`);
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

// --- wg-stand: сервер WG на хосте ----------------------------------------------
if (!existsSync(WG_STAND)) {
  console.log("wg-stand.exe нет — собираю (e2e/wg-stand)…");
  await run("cargo", ["build", "--manifest-path", join(ROOT, "e2e", "wg-stand", "Cargo.toml")]);
}
const confLive = join(tmpdir(), `duopulse-169-live-${process.pid}.conf`);
const stand = spawn(WG_STAND, ["--conf", confLive], { stdio: ["ignore", "pipe", "inherit"] });
const standEvents = [];
stand.stdout.setEncoding("utf8");
let standReady;
const standReadyP = new Promise((res, rej) => {
  standReady = res;
  setTimeout(() => rej(new Error("wg-stand не поднялся за 15 с")), 15000);
});
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
// Конфиг стенда пишет Endpoint = 127.0.0.1:<port> — из эмулятора хост виден
// как 10.0.2.2 (alias loopback-интерфейса хоста). Подменяем хост endpoint.
const confLiveText = readFileSync(confLive, "utf8").replace("Endpoint = 127.0.0.1:", "Endpoint = 10.0.2.2:");
if (!confLiveText.includes("10.0.2.2:")) throw new Error("endpoint не подменён — конфиг стенда другой");
// «Чёрная дыра» для kill-switch: чужой ключ пира (новый id профиля, handshake
// не сложится) + закрытый UDP-порт хоста.
const confDeadText = confLiveText
  .replace(/PublicKey = (.)/, (m, c) => `PublicKey = ${c === "B" ? "C" : "B"}`)
  .replace(/Endpoint = 10\.0\.2\.2:\d+/, "Endpoint = 10.0.2.2:1");

// --- установка и запуск ---------------------------------------------------------
// прежде — снос прошлой сборки: релиз подписан другим ключом, install -r
// падает с INSTALL_FAILED_UPDATE_INCOMPATIBLE (данные стенда это не трогает —
// ниже pm clear)
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
  const evalJs = (expr) => new Promise((res, rej) => {
    const id = ++i;
    pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result.result.value)));
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
  const invoke = (cmd, args) =>
    evalJs(`window.__TAURI__.core.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
  return { evalJs, invoke, close: () => ws.close() };
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

// Хроника событий контракта vpn.* (формы — camelCase, как у десктопа).
await ui.evalJs(`(async () => {
  window.__vpnEv = { states: [], stats: [] };
  const E = window.__TAURI__.event;
  await E.listen("vpn:state_changed", (e) => window.__vpnEv.states.push(e.payload));
  await E.listen("vpn:stats", (e) => window.__vpnEv.stats.push(e.payload));
  return "ok";
})()`);
const vpnEv = () => ui.evalJs("JSON.stringify(window.__vpnEv)").then((s) => JSON.parse(s));
const status = () => ui.invoke("mobile_vpn_status", undefined);
const tunnelUp = async (ms, label) => {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await status();
    if (last.wg && last.wg.state !== "connecting") return last;
    await sleep(1000);
  }
  return last;
};

// --- 1. импорт текста .conf ------------------------------------------------------
const imported = await ui.invoke("mobile_vpn_import_profile", { params: { text: confLiveText, name: "wg-stand.conf" } });
check("импорт .conf: профиль создан", !!imported.id && imported.endpoint === `10.0.2.2:${ready.udp_port}`,
  JSON.stringify(imported).slice(0, 120));
check("импорт .conf: секретов в DTO нет", !/private/i.test(JSON.stringify(imported)));
const list1 = await ui.invoke("mobile_vpn_list_profiles", undefined);
check("список профилей: один, не активен", list1.length === 1 && list1[0].id === imported.id && !list1[0].active);

// --- 4 (ранний заход). Keystore: блоб ключа --------------------------------------
const blobRaw = adb("exec-out", "run-as", PKG, "cat", `files/profile/vpn/wg/${imported.id}.bin`);
const privB64 = /PrivateKey = (\S+)/.exec(confLiveText)[1];
check("Keystore: блоб секретов существует и запечатан (v1:)", blobRaw.startsWith("v1:") && blobRaw.length > 32,
  `${blobRaw.slice(0, 16)}… (${blobRaw.length} байт)`);
check("Keystore: приватного ключа нет ни в блобе, ни в wg-profiles.json",
  !blobRaw.includes(privB64) &&
  !adb("shell", "run-as", PKG, "cat", "files/profile/wg-profiles.json").includes(privB64));

// --- 2. подъём тоннеля ------------------------------------------------------------
const useRes = await ui.invoke("mobile_vpn_use_profile", { params: { id: imported.id } });
check("use_profile: режим wg сразу", useRes.mode === "wg" && !!useRes.wg, useRes.wg?.state || "");
const up = await tunnelUp(30000, "handshake");
check("handshake состоялся: connected, endpoint/rx/tx на месте",
  up.wg?.state === "connected" && up.wg.endpoint === `10.0.2.2:${ready.udp_port}` &&
  typeof up.wg.rxBytes === "number" && typeof up.wg.txBytes === "number" &&
  up.wg.lastHandshakeMs != null,
  `handshake ${up.wg?.lastHandshakeMs} мс назад`);
shot("tunnel-up");

// --- 3. проба целью из тоннеля -----------------------------------------------------
const t0 = await ui.invoke("mobile_vpn_test_connection", { params: { probe: "blocked.tun:80" } });
check("test_connection: проба через тоннель прошла (DNS+HTTP видит стенд)",
  t0.state === "on" && /ответ/.test(t0.detail), t0.detail);
const standHttp = standEvents.filter((e) => e.ev === "http").length;
const standDns = standEvents.filter((e) => e.ev === "dns" && e.name === "blocked.tun").length;
check("wg-stand: DNS blocked.tun и HTTP-хит пришли тоннелем", standDns >= 1 && standHttp >= 1,
  `dns=${standDns} http=${standHttp}`);
const st1 = await status();
check("rx/tx растут после пробы", st1.wg.rxBytes > (up.wg?.rxBytes ?? 0), `${up.wg?.rxBytes} → ${st1.wg.rxBytes}`);

// События контракта: формы camelCase десктопного vpn.*.
const ev1 = await vpnEv();
const connEv = ev1.states.find((s) => s.wg?.state === "connected");
check("событие vpn:state_changed (connected): camelCase-форма контракта",
  !!connEv && connEv.mode === "wg" && "profileId" in connEv.wg && "lastHandshakeMs" in connEv.wg,
  JSON.stringify(connEv ?? null).slice(0, 140));
check("событие vpn:stats: rxBytes/txBytes/pingMs", ev1.stats.length >= 1 &&
  "rxBytes" in ev1.stats.at(-1) && "txBytes" in ev1.stats.at(-1), JSON.stringify(ev1.stats.at(-1) ?? null).slice(0, 120));

// --- 5. лист «VPN» из меню «⋮» (duopulse-171 заменил кнопку «VPN: тест») ---------
const sheetRun = await ui.evalJs(`(async () => {
  document.getElementById("mMenu").click();
  await new Promise((r) => setTimeout(r, 400));
  document.getElementById("mVpn").click();
  await new Promise((r) => setTimeout(r, 800));
  return window.__duopulseMobileVpn?.() ?? null;
})()`);
check("лист «VPN» открыт из меню ⋮: тоннель жив, статус/щит connected",
  sheetRun?.open === true && sheetRun.tunnelOn === true &&
  sheetRun.wgState === "connected" && sheetRun.shield === "connected",
  JSON.stringify(sheetRun).slice(0, 140));
check("лист «VPN»: живые rx/tx/ping из событий vpn:stats",
  typeof sheetRun?.rx === "number" && typeof sheetRun?.tx === "number" && sheetRun.rx >= 0,
  `rx=${sheetRun?.rx} tx=${sheetRun?.tx} ping=${sheetRun?.ping}`);
shot("vpn-sheet");
await ui.evalJs(`document.querySelector(".m-sheet-backdrop")?.click(); "ok"`);
const diagSnap = await ui.evalJs(`(async () => {
  document.getElementById("mMenu").click();
  await new Promise((r) => setTimeout(r, 400));
  document.getElementById("mDiag").click();
  await new Promise((r) => setTimeout(r, 700));
  return JSON.stringify(window.__duopulseMobileDiagnostics?.() ?? null);
})()`).then((s2) => JSON.parse(s2));
check("лист диагностики без dev-кнопки «VPN: тест» открывается", diagSnap?.open === true,
  JSON.stringify(diagSnap).slice(0, 80));
await ui.evalJs(`document.querySelector(".m-sheet-backdrop")?.click(); "ok"`);

// --- 6. kill-switch: чёрная дыра, fail-closed -------------------------------------
const deadImport = await ui.invoke("mobile_vpn_import_profile", { params: { text: confDeadText, name: "dead.conf" } });
check("kill-switch: профиль-дыра импортирован (другой id)", deadImport.id !== imported.id, deadImport.id);
const useDead = await ui.invoke("mobile_vpn_use_profile", { params: { id: deadImport.id } });
check("kill-switch: тоннель переключён на дыру (connecting)", useDead.wg?.state === "connecting", useDead.wg?.state ?? "");
// До порога мёртвости: проба обязана провалиться (туннельный DNS не отвечает)
// — напрямую, мимо тоннеля, ничего не уходит (fail-closed).
const tDead = await ui.invoke("mobile_vpn_test_connection", { params: { probe: "blocked.tun:80" } });
check("kill-switch (до порога): проба падает по таймауту тоннеля, не напрямую",
  tDead.state === "error" && /(таймаут|DNS)/.test(tDead.detail), tDead.detail);
// REJECT_AFTER_TIME: на Android env не задать — ждём протокольные 180 с
// (порог от старта сессии: handshake не было → тоннель мёртв).
console.log("kill-switch: жду REJECT_AFTER_TIME (180 с)…");
const deadUp = await (async () => {
  const deadline = Date.now() + 200_000;
  let last;
  while (Date.now() < deadline) {
    last = await status();
    if (last.wg?.state === "error" && /kill-switch/.test(last.wg ? last.detail : "")) return last;
    await sleep(5000);
  }
  return last;
})();
check("kill-switch (после порога): status «мёртв» с причиной",
  deadUp.wg?.state === "error" && /kill-switch/.test(deadUp.detail), deadUp.detail);
const tRefuse = await ui.invoke("mobile_vpn_test_connection", { params: { probe: "blocked.tun:80" } });
check("kill-switch: новые соединения отказывают сразу (fail-fast)",
  tRefuse.state === "error" && /kill-switch/.test(tRefuse.detail), tRefuse.detail);
const evDead = await vpnEv();
const killEv = evDead.states.find((s) => s.state === "error" && /kill-switch/.test(s.detail ?? ""));
check("kill-switch: событие vpn:state_changed с причиной ушло", !!killEv, JSON.stringify(killEv ?? null).slice(0, 120));

// --- 7. гигиена --------------------------------------------------------------------
const offRes = await ui.invoke("mobile_vpn_use_profile", { params: { id: null } });
check("выключение: режим off", offRes.mode === "off" && !offRes.wg, offRes.detail);
const evOff = await vpnEv();
check("событие «выключен» ушло", evOff.states.some((s) => s.mode === "off"));
for (const id of [imported.id, deadImport.id]) await ui.invoke("mobile_vpn_remove_profile", { params: { id } });
const list2 = await ui.invoke("mobile_vpn_list_profiles", undefined);
let blobsLeft = "";
try { blobsLeft = adb("shell", "run-as", PKG, "ls", "files/profile/vpn/wg").trim(); } catch { /* каталог убран — пусто */ }
check("удаление: профили и Keystore-блобы вычищены", list2.length === 0 && (blobsLeft === "" || /No such file/.test(blobsLeft)),
  `profiles=${list2.length} blobs=${JSON.stringify(blobsLeft)}`);

ui.close();
stand.kill();
writeFileSync(OUT, JSON.stringify({ apk: APK, serial: SERIAL, at: new Date().toISOString(), results, standEvents: standEvents.length }, null, 2));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${results.length - failed}/${results.length}`);
process.exit(failed === 0 ? 0 : 1);
