// E2E-прогон этапа 4 менеджера паролей (карточка duopulse-110) и этапа 5
// синка закладок (карточка duopulse-111, цепочка duopulse-106): живой синк
// хранилищ через аккаунт Aila.
//   1) поднимается ИЗОЛИРОВАННЫЙ сервер Aila (node src/index.js из D:\Aila,
//      AILA_DATA во временный каталог, порт случайный) — первый юзер
//      регистрируется по API (auth_hash = PBKDF2-SHA256 600k, как клиент);
//   2) DuoPulse (профиль A, чистый): пароль и закладки с группой сохраняются
//      ЛОКАЛЬНО до входа, затем вход в аккаунт через UI настроек (раздел
//      «Аккаунт Aila») — авто-синк уносит пароли (appdata key=passwords) и
//      закладки (key=bookmarks, отдельный ключ HKDF) в облако (ревизия ≥ 1);
//      блобы на сервере проверяются: только hex-iv/ct, открытых данных нет;
//   3) DuoPulse (профиль B, чистый, «другой компьютер»): вход тем же
//      аккаунтом → авто-синк подтягивает пароль (list/reveal) и закладки
//      (bookmarkList/groupList, членства по именам групп);
//   4) удаление на B (закладка + группа) уезжает надгробием; перезапуск A
//      (восстановленная сессия → синк на старте) применяет удаления.
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

/** Дождаться смерти всех CDP-целей порта. Зомби-вебвью прошлого запуска
 *  держит порт 9226 — свежий exe без порта, а стенд опрашивает СТАРУЮ
 *  страницу (замороженное состояние): tombstone-проверки врут. */
async function drainCdp(timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if ((await cdpTargets()).length === 0) return true;
    await sleep(300);
  }
  return (await cdpTargets()).length === 0;
}

/** Закрыть машину наглухо: exe → вебвью профиля → ни одной CDP-цели
 *  (иначе следующий запуск машины говорит со зомби). */
async function closeMachine(app, profile, title) {
  await gracefulClose(app);
  await killWebViewOf(profile);
  if (!(await drainCdp())) {
    // добить всё наше: exe по пути, вебвью по маркеру временного каталога
    try {
      await run("powershell", ["-NoProfile", "-Command",
        `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'"` +
        ` | Where-Object { $_.CommandLine -like '*${path.basename(profile)}*' }` +
        ` | ForEach-Object { taskkill /PID $_.ProcessId /T /F }`]);
    } catch {}
    await killOurExes();
    if (!(await drainCdp(15000))) {
      throw new Error(`CDP-цели ${title} не умерли — зомби держит порт ${CDP_PORT}`);
    }
  }
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

/** void-ответ команды дошёл без ошибки ('ERR:…' — нет). */
const noErr = (v) => !(typeof v === "string" && v.startsWith("ERR:"));

/** Запуск «машины»: свежий профиль, старт на duopulse://settings.
 *  stderrexe — в файл рядом с профилем (диагностика воркера синка). */
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

  // auth_hash как у клиента: PBKDF2-SHA256(пароль, hex-соль, 600k) → hex;
  // заодно выводим ключи синка (wrap → passwords → bookmarks цепочкой HKDF,
  // как aila.rs) — стенду нужно ЗАГЛЯНУТЬ в блоб закладок: ждать «ревизия
  // выросла» нельзя, входной круг машины B сам толкает ревизию (created_at
  // «Избранное» на разных машинах различается), а круг удалений выходит
  // только после дебаунса 3 с
  const AUTH_SALT = "a1b2c3d4e5f60718";
  const WRAP_SALT = "1122334455667788";
  const pbkdf2 = (salt) =>
    crypto.pbkdf2Sync(PASS, Buffer.from(salt, "hex"), 600_000, 32, "sha256").toString("hex");
  const WRAP_KEY = crypto.pbkdf2Sync(PASS, Buffer.from(WRAP_SALT, "hex"), 600_000, 32, "sha256");
  const hkdf = (ikm, info) =>
    Buffer.from(crypto.hkdfSync("sha256", ikm, Buffer.from("duopulse"), Buffer.from(info), 32));
  const BM_KEY = hkdf(hkdf(WRAP_KEY, "duopulse-passwords-v1"), "duopulse-bookmarks-v1");
  const openBmBlob = (blob) => {
    const iv = Buffer.from(blob.iv, "hex");
    const ct = Buffer.from(blob.ct, "hex");
    const d = crypto.createDecipheriv("aes-256-gcm", BM_KEY, iv);
    d.setAuthTag(ct.subarray(ct.length - 16));
    return JSON.parse(
      Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString("utf8"),
    );
  };
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
  const appdataGet = async (key = "passwords") => {
    const r = await fetch(`http://127.0.0.1:${AILA_PORT}/api/appdata?app=duopulse&key=${key}`, {
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

  // закладки и группа — тоже локально до входа (этап 5 duopulse-111):
  // без аккаунта поведение прежнее, правки копятся локально
  const bmWild = await viaSettings(ws, `window.__duopulse.history.bookmarkAdd({url:'https://yt.example/wild', title:'Дикое видео'})`);
  check("машина A: закладка сохранена локально (до входа)", noErr(bmWild), JSON.stringify(bmWild));
  const grp = await viaSettings(ws, `window.__duopulse.history.groupAdd({name:'Музыка e2e'})`);
  check("машина A: группа создана локально", grp && grp.id > 0, JSON.stringify(grp));
  const bmTrack = await viaSettings(ws, `window.__duopulse.history.bookmarkAdd({url:'https://m.example/track', title:'Трек', groupId:${grp?.id}})`);
  check("машина A: закладка в группе сохранена локально", noErr(bmTrack), JSON.stringify(bmTrack));
  const localMarks = await viaSettings(ws, `window.__duopulse.history.bookmarkList({query:'', limit:10})`);
  check("машина A: закладки видны локально", localMarks?.total === 2, JSON.stringify(localMarks?.total));

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

  // закладки уехали отдельным ключом appdata (этап 5): key=bookmarks
  let cloudBm = null;
  for (let i = 0; i < 40 && !cloudBm; i++) {
    const r = await appdataGet("bookmarks");
    if (r.status === 200 && r.body?.blob?.ct) cloudBm = r.body;
    else await sleep(500);
  }
  check("машина A: авто-синк отправил блоб закладок (key=bookmarks)", !!cloudBm && cloudBm.revision >= 1, cloudBm ? `ревизия ${cloudBm.revision}` : "блоб не появился");
  if (cloudBm) {
    const raw = Buffer.from(cloudBm.blob.ct, "hex").toString("latin1");
    check(
      "облако: блоб закладок шифрованный — сервер не видел url/групп",
      /^[0-9a-f]+$/.test(cloudBm.blob.ct) && /^[0-9a-f]{24}$/.test(cloudBm.blob.iv) &&
        !raw.includes("yt.example") && !raw.includes("m.example"),
      `ct ${cloudBm.blob.ct.length} hex-символов`,
    );
  }

  await closeMachine(app, profileA, "машины A (первый запуск)");

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

  // закладки машины A приехали (этап 5): закладка, группа, членство по имени
  let bmArrived = null;
  for (let i = 0; i < 60 && !bmArrived; i++) {
    const list = await viaSettings(ws, `window.__duopulse.history.bookmarkList({query:'wild', limit:10})`);
    if (list?.total >= 1) bmArrived = list;
    else await sleep(500);
  }
  check(
    "машина B: закладка машины A приехала синком",
    !!bmArrived && bmArrived.bookmarks[0]?.title === "Дикое видео" && bmArrived.bookmarks[0]?.url === "https://yt.example/wild",
    JSON.stringify(bmArrived?.bookmarks?.[0] ?? bmArrived),
  );
  const groupsB = await viaSettings(ws, `window.__duopulse.history.groupList()`);
  const musicB = (groupsB?.groups || []).find?.((g) => g.name === "Музыка e2e");
  check("машина B: группа «Музыка e2e» приехала", !!musicB, JSON.stringify(groupsB?.groups ?? groupsB));
  const trackB = await viaSettings(ws, `window.__duopulse.history.bookmarkList({query:'track', limit:10})`);
  check(
    "машина B: членство закладки в группе приехало (по имени)",
    trackB?.bookmarks?.[0]?.groups?.some?.((g) => g.name === "Музыка e2e") === true,
    JSON.stringify(trackB?.bookmarks?.[0]?.groups),
  );

  // удаление на B → надгробия уезжают в облако; ждём их ВНУТРИ блоба
  // (расшифрованном ключом синка): wild исчез из bookmarks, tombstones несёт
  // оба ключа. Круг удалений выходит после дебаунса 3 с — ждём до 40 с
  const rm1 = await viaSettings(ws, `window.__duopulse.history.bookmarkRemove({url:'https://yt.example/wild'})`);
  const rm2 = musicB
    ? await viaSettings(ws, `window.__duopulse.history.groupRemove({id:${musicB.id}})`)
    : "нет группы";
  check("машина B: закладка и группа удалены локально", noErr(rm1) && noErr(rm2), `${JSON.stringify(rm1)} / ${JSON.stringify(rm2)}`);
  let tombstoned = false;
  let tombDetail = "";
  for (let i = 0; i < 80 && !tombstoned; i++) {
    const r = await appdataGet("bookmarks");
    if (r.status === 200 && r.body?.blob?.ct) {
      try {
        const doc = openBmBlob(r.body.blob);
        const wildGoneCloud = !(doc.bookmarks || []).some((b) => b.url === "https://yt.example/wild");
        const tombs = doc.tombstones || [];
        const hasWild = tombs.some((t) => t.kind === "bookmark" && t.key === "https://yt.example/wild");
        const hasMusic = tombs.some((t) => t.kind === "group" && t.key === "Музыка e2e");
        if (wildGoneCloud && hasWild && hasMusic) tombstoned = true;
        else tombDetail = `wildGone=${wildGoneCloud} t=${JSON.stringify(tombs)}`;
      } catch (e) {
        tombDetail = `блоб не расшифровался: ${e?.message || e}`;
      }
    }
    if (!tombstoned) await sleep(500);
  }
  check("машина B: надгробия уехали в облако (в блобе)", tombstoned, tombDetail);

  await closeMachine(app, profileB, "машины B");

  // --- 4. перезапуск машины A: восстановленная сессия → синк на старте -----
  // применяет удаления машины B (надгробия), данные не портятся
  app = launchMachine(profileA);
  ws = await waitForSettings();
  let wildGone = false;
  let musicGone = false;
  for (let i = 0; i < 90 && !(wildGone && musicGone); i++) {
    if (!wildGone) {
      const list = await viaSettings(ws, `window.__duopulse.history.bookmarkList({query:'wild', limit:10})`);
      if (list?.total === 0) wildGone = true;
    }
    if (!musicGone) {
      const groups = await viaSettings(ws, `window.__duopulse.history.groupList()`);
      if (Array.isArray(groups?.groups) && !groups.groups.some((g) => g.name === "Музыка e2e")) musicGone = true;
    }
    if (!(wildGone && musicGone)) await sleep(500);
  }
  check("машина A (перезапуск): удаление закладки доехало надгробием", wildGone, wildGone ? "" : "закладка всё ещё на месте");
  check("машина A (перезапуск): удаление группы доехало надгробием", musicGone, musicGone ? "" : "группа всё ещё на месте");
  if (!(wildGone && musicGone)) {
    const st = await viaSettings(ws, `window.__duopulse.aila.status()`);
    console.log(`--- aila.status машины A (перезапуск): ${JSON.stringify(st)}`);
  }
  const survivor = await viaSettings(ws, `window.__duopulse.history.bookmarkList({query:'track', limit:10})`);
  check(
    "машина A (перезапуск): соседняя закладка не пострадала (группа удалена — закладка жива)",
    survivor?.total === 1 && survivor.bookmarks[0]?.url === "https://m.example/track",
    JSON.stringify(survivor?.bookmarks?.[0] ?? survivor),
  );
  const pwStill = await viaSettings(ws, `window.__duopulse.passwords.list({query:'artem', limit:10})`);
  check("машина A (перезапуск): пароли не пострадали", pwStill?.total === 1, JSON.stringify(pwStill?.total));
  // диагностика воркера: если круг синка падал — stderr машины знает почему
  for (const p of [profileA, profileB]) {
    try {
      const text = fs.readFileSync(`${p}-stderr.log`, "utf8");
      const lines = text.split("\n").filter((l) => l.includes("[aila]"));
      if (lines.length) console.log(`--- [aila]-лог ${path.basename(p)}:\n${lines.slice(0, 8).join("\n")}`);
      if (!wildGone || !musicGone) {
        console.log(`--- полный хвост stderr ${path.basename(p)}:\n${text.split("\n").slice(-40).join("\n")}`);
      }
    } catch {}
  }

  await gracefulClose(app);
  await killWebViewOf(profileA);
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
