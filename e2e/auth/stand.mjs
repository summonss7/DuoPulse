// Живой прогон диалога HTTP-авторизации (карточка duopulse-148).
// Сценарий: адресная строка → http://127.0.0.1:8899 (стенд-«роутер», 401) →
// в DuoPulse открывается панель auth (логин/пароль) вместо страницы ошибки
// «сервер требует авторизацию, код 17»; неверный пароль — диалог вернулся с
// «Неверный логин или пароль» и прежним логином; верный — страница роутера
// загрузилась (ROUTER-OK). Скриншоты — %TEMP%/duopulse-148-*.png.
//
// Запуск: node e2e/auth/stand.mjs [путь-duopulse.exe]
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const CDP_PORT = 9222;
// 8899 на этой машине занят живым сервисом — стенд-роутер на 8907 (AUTH_PORT)
const AUTH_PORT = process.env.AUTH_PORT || 8907;
const AUTH_URL = `http://127.0.0.1:${AUTH_PORT}/`;
const TMP = (name) => path.join(os.tmpdir(), name);

// --- очистка прошлого прогона (ловушка висячих процессов, см. память) ------
await new Promise((res) =>
  execFile(
    "powershell",
    ["-NoProfile", "-Command",
      `Get-Process duopulse -ErrorAction SilentlyContinue | Stop-Process -Force; ` +
      `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'basic-auth-server|vite' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }`],
    { shell: false },
    () => res(),
  ),
);

// --- стенд-роутер ------------------------------------------------------------
const serverProc = spawn("node", [path.join(ROOT, "e2e", "auth", "basic-auth-server.mjs")], {
  stdio: "inherit",
  env: { ...process.env, AUTH_PORT: String(AUTH_PORT) },
});
// второй «роутер» для сценария отмены (креды Chromium кэширует по origin —
// отмена на том же порту не спросит пароль снова)
const ALT_PORT = AUTH_PORT + 1;
const serverProc2 = spawn("node", [path.join(ROOT, "e2e", "auth", "basic-auth-server.mjs")], {
  stdio: "ignore",
  env: { ...process.env, AUTH_PORT: String(ALT_PORT) },
});
// --- vite-dev (UI бинаря в debug грузится с 5173) ----------------------------
const vite = spawn("npm", ["run", "dev"], { cwd: ROOT, shell: true, stdio: "ignore" });

// свежий профиль прогона: без него сессия прошлого запуска рестартит вкладку
// с челленджем до готовности UI (тот сценарий проверялся руками — здесь он
// мешает шагу 1)
const PROFILE = path.join(os.tmpdir(), "duopulse-148-profile");
fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(PROFILE, { recursive: true });

const appLog = fs.openSync(TMP("duopulse-148-app.log"), "w");
const app = spawn(EXE, [], {
  stdio: ["ignore", appLog, appLog],
  env: {
    ...process.env,
    APPDATA: PROFILE,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      return await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
    } catch {
      await sleep(500);
    }
  }
  throw new Error("CDP не поднялся");
};

/** CDP-сессия с целью по предикату (каждый вызов — свежая: цели живут недолго).
 *  untilTruthy —retry пока выражение ложно (цель нашлась, но DOM ещё не готов). */
async function withTarget(pred, fn, waitMs = 20000, untilTruthy = false) {
  const deadline = Date.now() + waitMs;
  let lastErr = "цель не найдена";
  let lastUrls = "";
  while (Date.now() < deadline) {
    let list;
    try {
      list = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
    } catch (e) {
      lastErr = String(e);
      await sleep(400);
      continue;
    }
    lastUrls = list.filter((x) => x.type === "page").map((x) => `${x.title} ${x.url}`).join(" | ");
    // целей с одним URL бывает несколько (UI-хром и внутренние страницы в
    // dev грузятся с 5173) — пока не найдём истинную, пробуем КАЖДУЮ
    for (const t of list.filter((x) => x.type === "page" && pred(x))) {
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      try {
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        const v = await fn(ws);
        if (!untilTruthy || v) return v;
        lastErr = `значение ложно (цель ${t.url})`;
      } catch (e) {
        lastErr = String(e);
      } finally {
        ws.close();
      }
      if (!untilTruthy) break; // без ожидания — достаточно первой цели
    }
    await sleep(400);
  }
  throw new Error(`${lastErr}; цели: ${lastUrls}`);
}

// Единый помощник: выполнить JS в первой цели по предикату.
async function evalIn(pred, expression, waitMs, untilTruthy = false) {
  return withTarget(pred, async (ws) => {
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
        pending.set(i, { res, rej });
        ws.send(JSON.stringify({ id: i, method, params }));
      });
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception ?? r.exceptionDetails));
    return r.result?.value;
  }, waitMs, untilTruthy);
}

async function shot(pred, file, waitMs = 15000) {
  return withTarget(pred, async (ws) => {
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
        pending.set(i, { res, rej });
        ws.send(JSON.stringify({ id: i, method, params }));
      });
    await send("Page.enable");
    const r = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(file, Buffer.from(r.data, "base64"));
    return file;
  }, waitMs);
}

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "OK" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
};

try {
  await targets();
  // 1. дождаться UI-хрома: omnibox есть И таб-бар отрисован (модули vite
  //    подключили слушателей — Enter раньше них уходил в пустоту)
  const uiUrl = (t) => (t.url.includes("5173") || t.url.includes("index.html") || t.url.includes("tauri")) && !t.url.includes("panel=");
  await evalIn(uiUrl,
    "!!document.getElementById('omnibox') && document.querySelectorAll('#tabs .tab').length > 0",
    30000, true);
  // Enter с ретри: между вводом и открытием панели — челлендж 401 (до ~6 с)
  for (let attempt = 0; attempt < 5; attempt++) {
    await evalIn(uiUrl, `
      (() => {
        const i = document.getElementById('omnibox');
        if (!i) return null;
        i.value = ${JSON.stringify(AUTH_URL)};
        i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return 'entered';
      })()`, 20000, true);
    const opened = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json()
      .then((l) => l.some((x) => x.type === "page" && (x.url.includes("panel=auth") || x.url.includes(`127.0.0.1:${AUTH_PORT}`))))
      .catch(() => false);
    if (opened) break;
    await sleep(1500);
  }
  await sleep(2500);

  // 2. панель auth открылась с формой (панельный webview грузит index.html?panel=auth)
  const panelUrl = (t) => t.url.includes("panel=auth");
  const form = await evalIn(panelUrl, `(() => ({
    title: document.getElementById('authTitle')?.textContent ?? null,
    realm: document.getElementById('authRealm')?.textContent ?? null,
    errorHidden: document.getElementById('authError')?.hidden ?? null,
    login: !!document.getElementById('authLogin'),
    password: !!document.getElementById('authPassword'),
  }))()`, 20000);
  check("панель auth открылась с формой", !!form?.login && !!form?.password, JSON.stringify(form));
  check("заголовок — хост стенда, realm из WWW-Authenticate",
    form?.title === `Вход на 127.0.0.1:${AUTH_PORT}` && form?.realm === "Router Console", JSON.stringify(form));
  await shot(panelUrl, TMP("duopulse-148-dialog.png"));

  // 3. неверный пароль → сервер повторяет 401 → диалог вернулся с ошибкой и логином
  //    (пауза: ретрай-нога + повторный челлендж + перерисовка панели ~1 c)
  await evalIn(panelUrl, `
    (() => {
      document.getElementById('authLogin').value = 'admin';
      document.getElementById('authPassword').value = 'wrong-pass';
      document.getElementById('authDialog').requestSubmit();
      return 'submitted-wrong';
    })()`);
  await sleep(2000);
  const retry = await evalIn(panelUrl, `(() => ({
    errorHidden: document.getElementById('authError')?.hidden ?? null,
    login: document.getElementById('authLogin')?.value ?? null,
    title: document.getElementById('authTitle')?.textContent ?? null,
  }))()`, 20000);
  check("неверный пароль — диалог вернулся с «Неверный логин или пароль»",
    retry?.errorHidden === false && retry?.login === "admin", JSON.stringify(retry));
  await shot(panelUrl, TMP("duopulse-148-retry.png"));

  // 4. верный пароль → страница роутера загрузилась, панели нет
  await evalIn(panelUrl, `
    (() => {
      document.getElementById('authPassword').value = 'routerpass';
      document.getElementById('authDialog').requestSubmit();
      return 'submitted-right';
    })()`);
  await sleep(2000);
  const okPage = await evalIn((t) => t.url.includes(`127.0.0.1:${AUTH_PORT}`),
    "document.body && document.body.innerText.includes('ROUTER-OK')", 20000);
  check("верный пароль — страница роутера загрузилась (ROUTER-OK)", okPage === true);
  await shot((t) => t.url.includes(`127.0.0.1:${AUTH_PORT}`), TMP("duopulse-148-router-ok.png"));
  await sleep(1200);
  const stillOpen = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json()
    .then((l) => l.some((x) => x.type === "page" && x.url.includes("panel=auth")))
    .catch(() => false);
  check("панель auth закрылась после входа", stillOpen === false);

  // 5. отмена: второй роутер (другой origin — креды первого не закэшированы)
  //    → диалог → «Отмена» → страница ошибки «сервер требует авторизацию»
  await evalIn(uiUrl, `
    (() => {
      const i = document.getElementById('omnibox');
      i.value = 'http://127.0.0.1:${ALT_PORT}/';
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return 'entered-alt';
    })()`, 20000, true);
  await evalIn(panelUrl, `
    (() => {
      document.getElementById('authCancel').click();
      return 'cancelled';
    })()`, 20000);
  const errPage = (t) => t.title.includes("Не удалось открыть сайт");
  const cancelPage = await evalIn(
    errPage,
    "document.body && document.body.innerText.includes('авторизац')", 20000, true);
  check("отмена — страница ошибки «сервер требует авторизацию»", cancelPage === true);
  await shot(errPage, TMP("duopulse-148-cancel.png"));

  console.log(`\nИтог: ${results.filter((r) => r.ok).length}/${results.length} проверок прошло`);
  console.log("Скриншоты:", TMP("duopulse-148-dialog.png"), TMP("duopulse-148-retry.png"), TMP("duopulse-148-router-ok.png"), TMP("duopulse-148-cancel.png"));
} finally {
  app.kill();
  serverProc.kill();
  serverProc2.kill();
  vite.kill();
  await new Promise((r) =>
    execFile("powershell", ["-NoProfile", "-Command",
      "Get-Process duopulse -ErrorAction SilentlyContinue | Stop-Process -Force"], {}, () => r()));
}
if (results.some((r) => !r.ok)) process.exit(1);
