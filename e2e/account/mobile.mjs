// E2E-приёмка этапа 6 карточки duopulse-112 (цепочка duopulse-106): аккаунт
// Aila и синк на мобильной ветке — живой круг «десктоп → телефон → десктоп»
// через изолированный сервер Aila:
//   0) изолированный сервер Aila (AILA_DATA во временный каталог) + первый
//      юзер по API (auth_hash = PBKDF2-SHA256 600k, как клиент);
//   1) машина A (десктоп, чистый профиль): пароль + закладка/группа
//      сохраняются локально до входа → вход через UI настроек → авто-синк
//      уносит блобы passwords/bookmarks в облако;
//   2) телефон (эмулятор, debug-APK): override сервера файлом
//      files/profile/aila-server.txt (http://10.0.2.2:порт — loopback хоста),
//      вход через реальный UI (меню «⋮» → «Войти в Aila»), авто-синк
//      подтягивает пароль (list/reveal через invoke) и закладки; до входа
//      ветка работает как прежде (aila_status logged-in=false);
//   3) телефон добавляет закладку (history.bookmark_add будит воркер) →
//      машина B (десктоп, чистый профиль) входит тем же аккаунтом и видит
//      закладку телефона — круг замкнулся;
//   4) clipboard-команда отвечает ok (текст не читается dumpsys — приватность).
// Приложение и adb-форвард поднимает сам стенд (эмулятор должен работать):
//   adb forward tcp:9223 localabstract:webview_devtools_remote_<pid>
// Запуск:  node e2e/account/mobile.mjs [путь-к-duopulse.exe]
// Требует собранный debug-APK (android-build.sh debug, x86_64) и D:\Aila.
import { execFile, execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const AILA_ROOT = process.env.E2E_AILA_ROOT || "D:\\Aila\\server";
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const CDP_PORT = Number(process.env.CDP_PORT || 9226); // десктоп-машины
const MOB_PORT = Number(process.env.MOB_CDP_PORT || 9223); // конвенция мобильных смоуков
const AILA_PORT = Number(process.env.E2E_AILA_PORT || 8890);
const PKG = "dev.duopulse.mobile";
const USER = "duoe2e";
const PASS = "duo-e2e-pass-7";
const PHONE_BM = "https://yt.example/from-phone";

const killPortOwner = async (port) => {
  try {
    await run("powershell", [
      "-NoProfile", "-Command",
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue` +
        ` | Select-Object -ExpandProperty OwningProcess -Unique` +
        ` | ForEach-Object { taskkill /PID $_ /T /F }`,
    ]);
  } catch {}
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, opts, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))));

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

// сторож: полумёртвое окружение не держит стенд бесконечно
setTimeout(() => {
  console.error("СТЕНД: глобальный таймаут 15 мин — принудительное завершение");
  process.exit(2);
}, 15 * 60_000).unref?.();

// ---------------- CDP (общий для десктопа и телефона) ----------------
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
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
  const open = new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  open.catch(() => {});
  const send = (method, params = {}) =>
    open.then(
      () =>
        new Promise((res, rej) => {
          const i = ++id;
          // таймаут на каждый вызов: мёртвая цель висит вечно (память e2e)
          const killer = setTimeout(() => {
            pending.delete(i);
            rej(new Error(`CDP ${method}: таймаут 30 с`));
          }, 30_000);
          pending.set(i, {
            res: (v) => { clearTimeout(killer); res(v); },
            rej: (e) => { clearTimeout(killer); rej(e); },
          });
          ws.send(JSON.stringify({ id: i, method, params }));
        }),
    );
  return { send, close: () => ws.close(), closed: open };
}

const evalIn = async (ws, expression) => {
  const r = await ws.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error(JSON.stringify(r.exceptionDetails.exception ?? r.exceptionDetails).slice(0, 500));
  }
  return r.result?.value;
};

const cdpTargets = async (port) => {
  try {
    return await (await fetch(`http://localhost:${port}/json`)).json();
  } catch {
    return [];
  }
};

/** Ждать CDP-цель страницы настроек десктопа (vite 5173 — ищем по DOM). */
async function waitForSettings(timeoutMs = 60000) {
  const t0 = Date.now();
  for (;;) {
    for (const t of await cdpTargets(CDP_PORT)) {
      if (t.type !== "page") continue;
      const ws = connect(t.webSocketDebuggerUrl);
      try {
        await ws.closed;
        const verdict = await evalIn(ws, `!!window.__duopulse && !!document.querySelector('[data-aila=status]')`);
        if (verdict) return ws;
      } catch { /* цель ещё не готова */ }
      ws.close();
    }
    if (Date.now() - t0 > timeoutMs) throw new Error("страница настроек не нашлась за 60 с");
    await sleep(400);
  }
}

/** Ждать CDP-цель мобильного UI (tauri.localhost, метка мобильного бандла). */
async function waitForMobile(timeoutMs = 60000) {
  const t0 = Date.now();
  for (;;) {
    for (const t of await cdpTargets(MOB_PORT)) {
      if (t.type !== "page" || !/^https?:\/\/(tauri\.)?localhost/.test(t.url)) continue;
      const ws = connect(t.webSocketDebuggerUrl);
      try {
        await ws.closed;
        const verdict = await evalIn(ws, `!!document.getElementById('mAila')`);
        if (verdict) return ws;
      } catch { /* цель ещё не готова */ }
      ws.close();
    }
    if (Date.now() - t0 > timeoutMs) throw new Error("мобильный UI не нашёлся за 60 с (adb forward?)");
    await sleep(400);
  }
}

const viaSettings = (ws, expr) =>
  evalIn(ws, `(async()=>{ try { return await (${expr}); } catch(e){ return 'ERR:' + e; } })()`);
const noErr = (v) => !(typeof v === "string" && v.startsWith("ERR:"));

/** invoke мобильной обёртки (withGlobalTauri есть только на телефоне). */
const mobInvoke = (ws, cmd, args = {}) =>
  evalIn(ws, `(async()=>{ try {
    return { ok: await window.__TAURI__.core.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)}) };
  } catch(e){ return { err: String(e) }; } })()`);

// ---------------- машины (десктоп) ----------------
function launchMachine(profile) {
  const errFd = fs.openSync(`${profile}-stderr.log`, "a");
  return spawn(EXE, [], {
    stdio: ["ignore", "ignore", errFd],
    env: {
      ...process.env,
      APPDATA: profile,
      WEBVIEW2_USER_DATA_FOLDER: path.join(profile, "webview2-data"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
      DUOPULSE_ADBLOCK_LISTS: "",
      DUOPULSE_AILA_SERVER: `http://127.0.0.1:${AILA_PORT}`,
      DUOPULSE_START_URL: "duopulse://settings",
    },
  });
}

async function gracefulClose(app) {
  if (!app || app.exitCode !== null) return;
  const pid = app.pid;
  try { await run("taskkill", ["/PID", String(pid)]); } catch {}
  for (let i = 0; i < 40; i++) {
    if (app.exitCode !== null) break;
    await sleep(250);
  }
  if (app.exitCode === null) {
    try { await run("taskkill", ["/PID", String(pid), "/T", "/F"]); } catch {}
    await sleep(500);
  }
}

async function drainCdp(timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if ((await cdpTargets(CDP_PORT)).length === 0) return true;
    await sleep(300);
  }
  return (await cdpTargets(CDP_PORT)).length === 0;
}

const killOurExes = async () => {
  try {
    await run("powershell", [
      "-NoProfile", "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='duopulse.exe'" | Where-Object { $_.ExecutablePath -eq '${EXE}' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }`,
    ]);
  } catch {}
};

/** Вход через UI настроек (как sync.mjs этапа 4). */
async function loginViaUi(ws) {
  await evalIn(
    ws,
    `(function(){
      const btn = document.querySelector('[data-aila=login]');
      const row = btn && btn.parentElement;
      const u = row && row.querySelector('input[type=text]');
      const p = row && row.querySelector('input[type=password]');
      if (!btn || !u || !p) return 'no-fields';
      u.value = ${JSON.stringify(USER)};
      p.value = ${JSON.stringify(PASS)};
      u.dispatchEvent(new Event('input', {bubbles:true}));
      p.dispatchEvent(new Event('input', {bubbles:true}));
      btn.click();
      return 'clicked';
    })()`,
  ).then((r) => {
    if (r !== "clicked") throw new Error(`поля входа не нашлись: ${r}`);
  });
  for (let i = 0; i < 150; i++) {
    const text = await evalIn(ws, `document.querySelector('[data-aila=status]').textContent`);
    if (/Вошли/.test(text || "")) return text;
    if (/неверное имя|пароль не заполнены|недоступен|отвечал|не выдал/.test(text || "")) {
      throw new Error(`вход не удался: ${text}`);
    }
    await sleep(500);
  }
  throw new Error("вход не увиден в статусе за 75 с");
}

// ---------------- телефон ----------------
const adb = (args, opts = {}) => execFileSync("adb", args, { encoding: "utf8", ...opts }).trim();

async function phoneSetup() {
  // чистый профиль приложения: снос + свежая установка + запуск.
  // APK — свежайший debug из builds/ (android-build.sh debug, universal:
  // x86_64 под эмулятор; env E2E_APK перекрывает).
  const apk =
    process.env.E2E_APK ||
    fs
      .readdirSync(path.join(ROOT, "builds"), { withFileTypes: true })
      .filter((d) => d.isDirectory() && /_android_debug$/.test(d.name))
      // версия ЧИСЛАМИ: строковая сортировка считает 0.1.9 новее 0.1.20
      .sort((a, b) => {
        const v = (s) => s.name.split("_")[1].split(".").map(Number);
        const [va, vb] = [v(a), v(b)];
        return (va[0] - vb[0]) || (va[1] - vb[1]) || (va[2] - vb[2] || 0);
      })
      .map((d) => path.join(ROOT, "builds", d.name))
      .flatMap((dir) => fs.readdirSync(dir).map((f) => path.join(dir, f)))
      .filter((f) => f.endsWith("-android-debug.apk"))
      .pop();
  if (!apk) throw new Error("debug-APK не найден в builds/ (android-build.sh debug)");
  try { adb(["uninstall", PKG]); } catch { /* не стоял */ }
  adb(["install", "-r", apk]);
  adb(["shell", "am", "start", "-n", `${PKG}/.MainActivity`]);
  // дождаться процесса и webview-сокета devtools (debug-сборка)
  let pid = "";
  for (let i = 0; i < 60 && !pid; i++) {
    try { pid = adb(["shell", "pidof", PKG]); } catch { /* стартует */ }
    if (!pid) await sleep(500);
  }
  if (!pid) throw new Error("процесс приложения не поднялся за 30 с");
  for (let i = 0; i < 60; i++) {
    try {
      adb(["forward", `tcp:${MOB_PORT}`, `localabstract:webview_devtools_remote_${pid}`]);
      if ((await cdpTargets(MOB_PORT)).length > 0) return pid;
    } catch { /* сокета ещё нет */ }
    await sleep(500);
  }
  throw new Error("webview_devtools_remote не поднялся за 30 с");
}

/** Файл-override сервера Aila для телефона (профиль filesDir/profile). */
function phoneSetServer(url) {
  const tmp = path.join(os.tmpdir(), `aila-server-${Date.now()}.txt`);
  fs.writeFileSync(tmp, url, "utf8");
  adb(["push", tmp, "/data/local/tmp/aila-server.txt"]);
  adb(["shell", `run-as ${PKG} mkdir -p files/profile`]);
  adb(["shell", `run-as ${PKG} cp /data/local/tmp/aila-server.txt files/profile/aila-server.txt`]);
  fs.rmSync(tmp, { force: true });
}

const phoneRestart = async () => {
  adb(["shell", "am", "force-stop", PKG]);
  await sleep(800);
  // запуск сразу после force-stop бывает проглатывается системой — до трёх
  // попыток, пока pidof не увидит живой процесс (мягкий ретрай, не флейк)
  let pid = "";
  for (let attempt = 0; attempt < 3 && !pid; attempt++) {
    // am start, не monkey: инъекция события сразу после force-stopped
    // состояния на загруженном эмуляторе бывает молча проглатывается
    adb(["shell", "am", "start", "-n", `${PKG}/.MainActivity`]);
    for (let i = 0; i < 24 && !pid; i++) {
      try { pid = adb(["shell", "pidof", PKG]); } catch { /* стартует */ }
      if (!pid) await sleep(500);
    }
  }
  if (!pid) throw new Error("приложение не поднялось после force-stop (3 попытки)");
  adb(["forward", `tcp:${MOB_PORT}`, `localabstract:webview_devtools_remote_${pid}`]);
};

// ---------------- прогон ----------------
let exitCode = 0;
let ailaSrv = null;
let vite = null;
let appA = null;
let appB = null;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-acc-mob-"));
try {
  await killOurExes();
  await killPortOwner(AILA_PORT);
  await killPortOwner(MOB_PORT);
  await killPortOwner(5173); // vite прошлого прогона (память: стенды вешаются)

  // --- 0. vite (UI машин) + изолированный сервер Aila + юзер -------------
  vite = spawn("npm", ["run", "dev"], { cwd: ROOT, shell: true, stdio: "ignore" });
  let viteUp = false;
  for (let i = 0; i < 60 && !viteUp; i++) {
    try {
      const r = await fetch("http://localhost:5173/");
      if (r.ok) viteUp = true;
    } catch { /* поднимается */ }
    if (!viteUp) await sleep(500);
  }
  if (!viteUp) throw new Error("vite dev-сервер не поднялся за 30 с");

  const ailaData = path.join(tmpRoot, "aila-data");
  const ailaLog = fs.openSync(path.join(tmpRoot, "aila-server.log"), "a");
  ailaSrv = spawn("node", ["src/index.js"], {
    cwd: AILA_ROOT,
    stdio: ["ignore", ailaLog, ailaLog],
    env: { ...process.env, AILA_DATA: ailaData, PORT: String(AILA_PORT), HOST: "127.0.0.1" },
  });
  let health = null;
  for (let i = 0; i < 60 && !health; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${AILA_PORT}/api/health`);
      if (r.ok) health = await r.json();
    } catch { /* поднимается */ }
    if (!health) await sleep(500);
  }
  check("изолированный сервер Aila поднялся", !!health, health ? health.name : "нет health");

  const AUTH_SALT = "a1b2c3d4e5f60718";
  const WRAP_SALT = "1122334455667788";
  const pbkdf2 = (salt) =>
    crypto.pbkdf2Sync(PASS, Buffer.from(salt, "hex"), 600_000, 32, "sha256").toString("hex");
  const reg = await fetch(`http://127.0.0.1:${AILA_PORT}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: USER,
      display_name: "Дуо Тест",
      auth_hash: pbkdf2(AUTH_SALT),
      auth_salt: AUTH_SALT,
      wrap_salt: WRAP_SALT,
      pubkey: "",
      vault_iv: "",
      enc_vault: "",
    }),
  });
  check("пользователь Aila зарегистрирован", reg.status === 200, `статус ${reg.status}`);
  const appdataGet = async (key = "passwords") => {
    const setCookie = (reg.headers.get("set-cookie") || "");
    const token = (setCookie.match(/aila_sess=([^;]+)/) || [])[1];
    const r = await fetch(`http://127.0.0.1:${AILA_PORT}/api/appdata?app=duopulse&key=${key}`, {
      headers: { Cookie: `aila_sess=${token}` },
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  // --- 1. машина A: локальные данные → вход → блобы в облаке --------------
  const profileA = path.join(tmpRoot, "machineA");
  appA = launchMachine(profileA);
  let ws = await waitForSettings();
  await viaSettings(ws, `window.__duopulse.passwords.add({url:'https://example.com/login', title:'Example — вход', username:'artem', password:'s3cret-machineA'})`);
  const grp = await viaSettings(ws, `window.__duopulse.history.groupAdd({name:'Музыка e2e'})`);
  await viaSettings(ws, `window.__duopulse.history.bookmarkAdd({url:'https://m.example/track', title:'Трек', groupId:${grp?.id}})`);
  check("машина A: пароль + группа + закладка сохранены локально", !!grp?.id, `группа id ${grp?.id}`);
  const statusA = await loginViaUi(ws);
  check("машина A: вход через UI настроек", /Вошли/.test(statusA), statusA);

  let cloud = null;
  for (let i = 0; i < 40 && !cloud; i++) {
    const r = await appdataGet("passwords");
    if (r.status === 200 && r.body?.blob?.ct) cloud = r.body;
    else await sleep(500);
  }
  let cloudBm = null;
  for (let i = 0; i < 40 && !cloudBm; i++) {
    const r = await appdataGet("bookmarks");
    if (r.status === 200 && r.body?.blob?.ct) cloudBm = r.body;
    else await sleep(500);
  }
  check("машина A: блобы passwords/bookmarks в облаке", !!cloud && !!cloudBm,
    `rev ${cloud?.revision ?? "—"}/${cloudBm?.revision ?? "—"}`);
  await gracefulClose(appA);
  appA = null;
  await drainCdp();

  // --- 2. телефон: override сервера, до входа — локальный режим ----------
  await phoneSetup();
  phoneSetServer(`http://10.0.2.2:${AILA_PORT}`);
  await phoneRestart();
  let mws = await waitForMobile();

  const st0 = await mobInvoke(mws, "aila_status");
  check("телефон: до входа logged_in=false, сервер из override-файла",
    st0?.ok?.loggedIn === false && st0?.ok?.server === `http://10.0.2.2:${AILA_PORT}`,
    JSON.stringify(st0?.ok ?? st0?.err));

  // вход через реальный UI: меню «⋮» → блок аккаунта → «Войти в Aila»
  // (блок рисуется после aila_status — ждём кнопку)
  await evalIn(mws, `document.getElementById('mMenu').click()`);
  let btnSeen = false;
  for (let i = 0; i < 40 && !btnSeen; i++) {
    btnSeen = await evalIn(mws, `!!document.querySelector('[data-acc=login]')`);
    if (!btnSeen) await sleep(500);
  }
  if (!btnSeen) throw new Error("кнопка «Войти в Aila» не появилась за 20 с");
  await evalIn(mws, `document.querySelector('[data-acc=login]').click()`);
  await sleep(400);
  await evalIn(mws, `(function(){
    const sheet = document.querySelector('.m-acc-sheet');
    const inputs = sheet && sheet.querySelectorAll('.m-acc-input');
    if (!inputs || inputs.length < 2) return 'no-fields';
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(inputs[0], ${JSON.stringify(USER)});
    setter.call(inputs[1], ${JSON.stringify(PASS)});
    inputs[0].dispatchEvent(new Event('input', {bubbles:true}));
    inputs[1].dispatchEvent(new Event('input', {bubbles:true}));
    sheet.querySelector('.m-acc-go').click();
    return 'submitted';
  })()`).then((r) => {
    if (r !== "submitted") throw new Error(`лист входа не заполнился: ${r}`);
  });
  // PBKDF2 600k на телефоне небыстрый; ждём статус блока меню
  let mobStatus = null;
  for (let i = 0; i < 120; i++) {
    const dbg = await evalIn(mws, `window.__accDebug && window.__accDebug()`);
    if (dbg?.status?.loggedIn) { mobStatus = dbg.status; break; }
    await sleep(500);
  }
  check("телефон: вход через UI-лист выполнен", !!mobStatus,
    mobStatus ? `${mobStatus.username}@${mobStatus.server}` : "статус не пришёл");

  // авто-синк (дебаунс 3 с): пароли и закладки машины A приехали
  let mobPw = null;
  for (let i = 0; i < 60 && !mobPw; i++) {
    const r = await mobInvoke(mws, "mobile_passwords_list", { params: { query: "artem", limit: 10 } });
    if (r?.ok?.total >= 1) mobPw = r.ok;
    else await sleep(500);
  }
  check("телефон: пароль машины A приехал синком",
    mobPw?.items?.[0]?.username === "artem" && mobPw?.items?.[0]?.origin === "https://example.com",
    JSON.stringify(mobPw?.items?.[0]?.username ?? mobPw));
  if (mobPw) {
    const rev = await mobInvoke(mws, "mobile_passwords_reveal", { id: mobPw.items[0].id });
    check("телефон: пароль совпадает байт-в-байт", rev?.ok === "s3cret-machineA",
      rev?.ok === "s3cret-machineA" ? "ok" : JSON.stringify(rev?.err));
  }
  let mobBm = null;
  for (let i = 0; i < 60 && !mobBm; i++) {
    const r = await mobInvoke(mws, "history_bookmark_list", { params: { query: "track", groupId: null, offset: 0, limit: 10 } });
    if (r?.ok?.total >= 1) mobBm = r.ok;
    else await sleep(500);
  }
  check("телефон: закладка машины A приехала синком",
    mobBm?.bookmarks?.[0]?.url === "https://m.example/track",
    JSON.stringify(mobBm?.bookmarks?.[0]?.url ?? mobBm));

  // clipboard-команда отвечает ok (4): unit → null (не undefined — грабля
  // первой версии проверки); успех = ветки err нет вообще
  const clip = await mobInvoke(mws, "mobile_clipboard_copy", { text: "probe" });
  check("телефон: буфер обмена отвечает ok", clip?.err === undefined, JSON.stringify(clip?.err ?? "ok"));

  // --- 3. телефон кладёт закладку → машина B видит её --------------------
  const addBm = await mobInvoke(mws, "history_bookmark_add",
    { params: { url: PHONE_BM, title: "С телефона", groupId: null } });
  check("телефон: закладка добавлена (воркер разбужен)", addBm?.ok !== undefined && !addBm?.err,
    JSON.stringify(addBm?.err ?? "ok"));

  const profileB = path.join(tmpRoot, "machineB");
  appB = launchMachine(profileB);
  ws = await waitForSettings();
  const statusB = await loginViaUi(ws);
  check("машина B: вход тем же аккаунтом", /Вошли/.test(statusB), statusB);
  let fromPhone = null;
  for (let i = 0; i < 60 && !fromPhone; i++) {
    const list = await viaSettings(ws, `window.__duopulse.history.bookmarkList({query:'from-phone', limit:10})`);
    if (list?.total >= 1) fromPhone = list;
    else await sleep(500);
  }
  check("машина B: закладка ТЕЛЕФОНА приехала — круг десктоп↔телефон замкнут",
    fromPhone?.bookmarks?.[0]?.url === PHONE_BM,
    JSON.stringify(fromPhone?.bookmarks?.[0]?.url ?? fromPhone));

  // пароль телефона тоже доехал до B (телефон пуллил и пушыл один документ)
  const pwB = await viaSettings(ws, `window.__duopulse.passwords.list({query:'artem', limit:10})`);
  check("машина B: пароль живёт во всех трёх копиях", pwB?.total >= 1, JSON.stringify(pwB?.total));
} catch (e) {
  console.error("СТЕНД: падение:", e.message);
  exitCode = 1;
} finally {
  if (appB) await gracefulClose(appB);
  if (appA) await gracefulClose(appA);
  for (const p of [appA, appB]) if (p && p.exitCode === null) p.kill("SIGKILL");
  try { adb(["shell", "am", "force-stop", PKG]); } catch { /* эмулятор мог уйти */ }
  try { adb(["forward", "--remove", `tcp:${MOB_PORT}`]); } catch {}
  if (vite) vite.kill();
  if (ailaSrv) ailaSrv.kill();
  await drainCdp(10000);
  const failed = results.filter((r) => !r.ok);
  console.log(`\nИТОГ: ${results.length - failed.length}/${results.length}` + (failed.length ? ` (падения: ${failed.map((f) => f.name).join("; ")})` : ""));
  if (failed.length) exitCode = 1;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.exit(exitCode);
}
