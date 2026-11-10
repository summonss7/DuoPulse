// E2E-прогон этапа 4 менеджера паролей (карточка duopulse-110, цепочка
// duopulse-106): живой синк хранилища паролей через аккаунт Aila.
//   1) поднимается ИЗОЛИРОВАННЫЙ сервер Aila (node src/index.js из D:\Aila,
//      AILA_DATA во временный каталог, порт случайный) — первый юзер
//      регистрируется по API (auth_hash = PBKDF2-SHA256 600k, как клиент);
//   2) DuoPulse (профиль A, чистый): пароль сохраняется ЛОКАЛЬНО до входа,
//      затем вход в аккаунт через UI настроек (раздел «Аккаунт Aila») —
//      авто-синк уносит локальные пароли в облако (appdata, ревизия ≥ 1);
//      блоб на сервере проверяется: только hex-iv/ct, открытого пароля нет;
//   3) DuoPulse (профиль B, чистый, «другой компьютер»): вход тем же
//      аккаунтом → авто-синк подтягивает запись → passwords.list/reveal
//      показывают пароль машины A.
// Без vite: window.__duopulse доступен на внутренних страницах
// (duopulse://settings — она же проверяет UI раздела).
//
// Запуск:  node e2e/passwords/sync.mjs [путь-к-duopulse.exe]
// Требует собранный debug-exe и D:\Aila (этап 3 aila-386 на сервере).
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const AILA_ROOT = process.env.E2E_AILA_ROOT || "D:\\Aila\\server";
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const CDP_PORT = Number(process.env.CDP_PORT || 9226);
const AILA_PORT = Number(process.env.E2E_AILA_PORT || 8878);
const USER = "duoe2e";
const PASS = "duo-e2e-pass-7";

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

// сторож: полумёртвое окружение не должно держать стенд бесконечно
setTimeout(() => {
  console.error("СТЕНД: глобальный таймаут 12 мин — принудительное завершение");
  process.exit(2);
}, 12 * 60_000).unref?.();

async function gracefulClose(app) {
  if (!app || app.exitCode !== null) return;
  const pid = app.pid;
  try {
    await run("taskkill", ["/PID", String(pid)]);
  } catch {}
  for (let i = 0; i < 40; i++) {
    if (app.exitCode !== null) break;
    await sleep(250);
  }
  if (app.exitCode === null) {
    try {
      await run("taskkill", ["/PID", String(pid), "/T", "/F"]);
    } catch {}
    await sleep(500);
  }
}

async function killWebViewOf(profile) {
  const marker = path.join(profile, "webview2-data");
  const ps =
    `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe' ` +
    `| Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }`;
  try {
    await run("powershell", ["-NoProfile", "-Command", ps]);
  } catch {}
}

const killOurExes = async () => {
  try {
    await run("powershell", [
      "-NoProfile", "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='duopulse.exe'" | Where-Object { $_.ExecutablePath -eq '${EXE}' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }`,
    ]);
  } catch {}
};

// ---------------- CDP ----------------
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
          const killer = setTimeout(() => {
            pending.delete(i);
            rej(new Error(`CDP ${method}: таймаут 60 с`));
          }, 60_000);
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
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception ?? r.exceptionDetails));
  return r.result?.value;
};

const cdpTargets = async () => {
  try {
    return await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
  } catch {
    return [];
  }
};

/** Ждать CDP-цель страницы настроек: debug-эндпоинты внутренних страниц
 *  живут на vite (5173) и URL неразличимы с хромом — ищем по DOM-предикату
 *  (раздел «Аккаунт Aila» есть только там). */
async function waitForSettings(timeoutMs = 60000) {
  const t0 = Date.now();
  for (;;) {
    for (const t of await cdpTargets()) {
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

const viaSettings = (ws, expr) =>
  evalIn(ws, `(async()=>{ try { return await (${expr}); } catch(e){ return 'ERR:' + e; } })()`);

/** Запуск «машины»: свежий профиль, старт на duopulse://settings. */
function launchMachine(profile) {
  return spawn(EXE, [], {
    stdio: "ignore",
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

/** Вход через UI раздела «Аккаунт Aila»: поля + кнопка → статус «Вошли».
 *  Поля ищем внутри ряда кнопки — на странице настроек есть чужие
 *  password-поля (прокси/перевод) выше по DOM. */
async function loginViaUi(ws) {
  const clicked = await evalIn(
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
  );
  if (clicked !== "clicked") throw new Error(`поля входа не нашлись: ${clicked}`);
  // вывод ключей PBKDF2 600k — в debug-сборке небыстрый; ждём статус
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

let exitCode = 0;
let ailaSrv = null;
let vite = null;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-pw-sync-"));
try {
  await killOurExes();
  await killPortOwner(AILA_PORT); // stale-сервер прошлого прогона держал бы порт

  // --- 0. vite dev: debug-exe грузит UI (включая duopulse://settings) с 5173
  vite = spawn("npm", ["run", "dev"], { cwd: ROOT, shell: true, stdio: "ignore" });
  let viteUp = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch("http://localhost:5173/");
      if (r.ok) {
        viteUp = true;
        break;
      }
    } catch { /* поднимается */ }
    await sleep(500);
  }
  if (!viteUp) throw new Error("vite dev-сервер не поднялся за 30 с (порт 5173 занят?)");

  // --- 1. изолированный сервер Aila + регистрация владельца ---------------
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
    await sleep(500);
  }
  check("изолированный сервер Aila поднялся", !!health, health ? health.name : "health не дождались");

  // auth_hash как у клиента: PBKDF2-SHA256(пароль, hex-соль, 600k) → hex
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
  const setCookie = reg.headers.get("set-cookie") || "";
  const ownerToken = (setCookie.match(/aila_sess=([^;]+)/) || [])[1];
  const regBody = await reg.json().catch(() => ({}));
  check("первый пользователь Aila зарегистрирован (владелец)", reg.status === 200 && !!ownerToken, JSON.stringify(regBody));
  const appdataGet = async () => {
    const r = await fetch(`http://127.0.0.1:${AILA_PORT}/api/appdata?app=duopulse&key=passwords`, {
      headers: { Cookie: `aila_sess=${ownerToken}` },
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  // --- 2. машина A: локальный пароль ДО входа, вход через UI, синк вверх ---
  const profileA = path.join(tmpRoot, "machineA");
  let app = launchMachine(profileA);
  let ws = await waitForSettings();
  check("настройки: раздел «Аккаунт Aila» с формой входа", await evalIn(
    ws,
    `(function(){
      const login = document.querySelector('[data-aila=login]');
      return !!login && !login.hidden && !!document.querySelector('section .set-section-title, h2');
    })()`,
  ));
  const before = await viaSettings(ws, `window.__duopulse.passwords.add({url:'https://example.com/login', title:'Example — вход', username:'artem', password:'s3cret-machineA'})`);
  check("машина A: пароль сохранён локально (до входа)", before && before.id > 0, JSON.stringify(before));
  const localList = await viaSettings(ws, `window.__duopulse.passwords.list({query:'artem', limit:10})`);
  check("машина A: запись видна локально", localList?.total === 1, JSON.stringify(localList?.total));

  const statusA = await loginViaUi(ws);
  check("машина A: вход через UI — статус «Вошли»", /Вошли/.test(statusA), statusA);

  // авто-синк: дебаунс 3 с → ждём блоб на сервере
  let cloud = null;
  for (let i = 0; i < 40 && !cloud; i++) {
    const r = await appdataGet();
    if (r.status === 200 && r.body?.blob?.ct) cloud = r.body;
    else await sleep(500);
  }
  check("машина A: авто-синк отправил блоб в облако", !!cloud && cloud.revision >= 1, cloud ? `ревизия ${cloud.revision}` : "блоб не появился");
  if (cloud) {
    const raw = Buffer.from(cloud.blob.ct, "hex").toString("latin1");
    check(
      "облако: блоб шифрованный — сервер не видел пароля",
      /^[0-9a-f]+$/.test(cloud.blob.ct) && /^[0-9a-f]{24}$/.test(cloud.blob.iv) &&
        !raw.includes("s3cret-machineA") && !raw.includes("artem") && !raw.includes("example.com"),
      `ct ${cloud.blob.ct.length} hex-символов`,
    );
  }

  await gracefulClose(app);
  await killWebViewOf(profileA);
  for (let i = 0; i < 20; i++) {
    if ((await cdpTargets()).length === 0) break;
    await sleep(300);
  }

  // --- 3. машина B: чистый профиль, тот же аккаунт → пароль приехал -------
  const profileB = path.join(tmpRoot, "machineB");
  app = launchMachine(profileB);
  ws = await waitForSettings();
  const emptyList = await viaSettings(ws, `window.__duopulse.passwords.list({query:'artem', limit:10})`);
  check("машина B: до входа хранилище пустое", emptyList?.total === 0, JSON.stringify(emptyList?.total));
  const statusB = await loginViaUi(ws);
  check("машина B: вход тем же аккаунтом", /Вошли/.test(statusB), statusB);

  // первый синк: pull применяет облачные записи
  let arrived = null;
  for (let i = 0; i < 60 && !arrived; i++) {
    const list = await viaSettings(ws, `window.__duopulse.passwords.list({query:'artem', limit:10})`);
    if (list?.total >= 1) arrived = list;
    else await sleep(500);
  }
  check(
    "машина B: пароль машины A приехал синком",
    !!arrived && arrived.items[0]?.username === "artem" && arrived.items[0]?.origin === "https://example.com",
    JSON.stringify(arrived?.items?.[0] ?? arrived),
  );
  if (arrived) {
    const revealed = await viaSettings(ws, `window.__duopulse.passwords.reveal({id:${arrived.items[0].id}})`);
    check("машина B: пароль совпадает байт-в-байт", revealed?.password === "s3cret-machineA", JSON.stringify(revealed));
  }
  const statusAfter = await viaSettings(ws, `window.__duopulse.aila.status()`);
  check("машина B: aila.status — вход + сервер стенда", statusAfter?.loggedIn === true && statusAfter?.server === `http://127.0.0.1:${AILA_PORT}`, JSON.stringify(statusAfter));

  await gracefulClose(app);
  await killWebViewOf(profileB);
} catch (e) {
  console.error("СТЕНД УПАЛ:", e?.message || e);
  exitCode = 1;
} finally {
  if (ailaSrv && ailaSrv.exitCode === null) {
    try { ailaSrv.kill(); } catch {}
    await sleep(300);
  }
  await killPortOwner(AILA_PORT);
  if (vite) {
    try { await run("taskkill", ["/PID", String(vite.pid), "/T", "/F"]); } catch {}
  }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\nПРОВАЛ: ${failed}/${results.length}` : `\nOK: ${results.length}/${results.length}`);
process.exit(failed ? 1 : exitCode);
