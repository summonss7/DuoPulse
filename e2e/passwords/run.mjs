// E2E-прогон этапа 2 менеджера паролей (карточка duopulse-108, цепочка
// duopulse-106): живой цикл в браузере на локальном http-стенде.
//   1) сабмит формы логина → бар «Сохранить пароль?» (панель pwsave)
//      появляется под полосой хрома; «Сохранить» пишет запись в хранилище
//      этапа 1 (проверка: passwords.list из хрома через window.__duopulse);
//   2) повторный заход на страницу логина → клик по полю логина → поля
//      заполнены сохранённым логином и паролем;
//   3) смена пароля в форме → сабмит → бар «Обновить…» → «Обновить» →
//      запись одна, пароль новый (passwords.reveal);
//   4) второй аккаунт того же сайта → chooser из двух пунктов у поля,
//      выбор второго заполняет его;
//   5) «Никогда для этого сайта»: сайт denylist-ится — повторный сабмит
//      с иными данными бара не даёт;
//   6) инкогнито-вкладка: сабмит — бара нет; клик по полю — не заполняет.
// Изоляция: APPDATA и WEBVIEW2_USER_DATA_FOLDER — во временных каталогах
// (свежий passwords.db/passwords.key), DUOPULSE_ADBLOCK_LISTS="" — без сети.
//
// Запуск:  node e2e/passwords/run.mjs [путь-к-duopulse.exe]
// Требует собранный debug-exe (cargo build; content-бандл вшит в exe).
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const CDP_PORT = Number(process.env.CDP_PORT || 9226);
const HTTP_PORT = Number(process.env.E2E_PASSWORDS_PORT || 8897); // origin A
const HTTP_PORT_B = HTTP_PORT + 1; // origin B (denylist-проверка на другом сайте)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, opts, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))));

/** Грациозное закрытие: WM_CLOSE, затем добивание. */
async function gracefulClose(app) {
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

/** Остатки WebView2 профиля держат user-data-folder и порт CDP — добиваем. */
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
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='duopulse.exe'" | Where-Object { $_.ExecutablePath -eq '${EXE}' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }`,
    ]);
  } catch {}
};

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

// сторож: полумёртвое окружение не должно держать стенд бесконечно
setTimeout(() => {
  console.error("СТЕНД: глобальный таймаут 8 мин — принудительное завершение");
  process.exit(2);
}, 8 * 60_000).unref?.();

// --- 1. локальные сайты: /login (форма логина) и /welcome (после входа) ----
const loginPage = (port) => `<!doctype html><html><head><title>Вход Example</title></head>
<body><h1>Страница входа</h1>
<form action="/welcome" method="get">
  <input type="text" name="login" autocomplete="username" placeholder="логин">
  <input type="password" name="pass" autocomplete="current-password" placeholder="пароль">
  <button type="submit">Войти</button>
</form></body></html>`;
const welcomePage = `<!doctype html><html><head><title>Добро пожаловать</title></head>
<body><h1>Вы вошли</h1></body></html>`;

const mkServer = (port) => {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(req.url.startsWith("/welcome") ? welcomePage : loginPage(port));
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv)));
};
const serverA = await mkServer(HTTP_PORT);
const serverB = await mkServer(HTTP_PORT_B);
const siteA = `http://127.0.0.1:${HTTP_PORT}`;
const siteB = `http://127.0.0.1:${HTTP_PORT_B}`;

// --- 2. vite dev (debug-exe грузит UI с localhost:5173) ---------------------
await killOurExes(); // остатки прошлых прогонов держали бы порт CDP
const vite = spawn("npm", ["run", "dev"], { cwd: ROOT, shell: true, stdio: "ignore" });
let viteUp = false;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch("http://localhost:5173/");
    if (r.ok) {
      viteUp = true;
      break;
    }
  } catch {
    /* поднимается */
  }
  await sleep(500);
}
if (!viteUp) {
  console.error("FAIL  vite dev-сервер не поднялся за 30 с (порт 5173 занят?)");
  try {
    await run("taskkill", ["/PID", String(vite.pid), "/T", "/F"]);
  } catch {}
  process.exit(1);
}

// --- 3. запуск приложения с чистым профилем ---------------------------------
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-pw-e2e-"));
const app = spawn(EXE, [], {
  stdio: "ignore",
  env: {
    ...process.env,
    APPDATA: profile,
    WEBVIEW2_USER_DATA_FOLDER: path.join(profile, "webview2-data"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    DUOPULSE_ADBLOCK_LISTS: "",
    DUOPULSE_START_URL: siteA + "/login",
  },
});

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
            rej(new Error(`CDP ${method}: таймаут 10 с`));
          }, 10_000);
          pending.set(i, {
            res: (v) => {
              clearTimeout(killer);
              res(v);
            },
            rej: (e) => {
              clearTimeout(killer);
              rej(e);
            },
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

/** Ждать CDP-цель по предикату (url-подстрока + DOM-проверка). */
async function waitForTarget(urlPart, domProbe, timeoutMs = 45000) {
  const t0 = Date.now();
  for (;;) {
    for (const t of await cdpTargets()) {
      if (!t.url.includes(urlPart)) continue;
      const ws = connect(t.webSocketDebuggerUrl);
      try {
        await ws.closed;
        const verdict = await evalIn(ws, domProbe);
        if (verdict) return ws;
      } catch {
        /* цель ещё не готова */
      }
      ws.close();
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`цель ${urlPart} не найдена за ${timeoutMs} мс`);
    await sleep(400);
  }
}

/** Сайт-вкладка: ищем по полю пароля и метке content-бандла __duopulseContent. */
const CONTENT_PROBE = `(function(){
  return window.__duopulseContent && document.querySelector('input[type=password]') ? 'ready' : '';
})()`;
const CHROME_PROBE = `(function(){
  if (document.documentElement.dataset.panel) return ''; // панель хрома
  if (document.body.classList.contains('internal-page')) return '';
  return document.querySelectorAll('#tabs .tab').length > 0 ? 'chrome' : '';
})()`;

/** Заполнить и сабмитнуть форму логина в сайт-вкладке. */
const submitLogin = (ws, user, pass) =>
  evalIn(
    ws,
    `(function(){
      const u = document.querySelector('input[type=text]');
      const p = document.querySelector('input[type=password]');
      u.value = ${JSON.stringify(user)};
      p.value = ${JSON.stringify(pass)};
      u.dispatchEvent(new Event('input', {bubbles:true}));
      p.dispatchEvent(new Event('input', {bubbles:true}));
      document.querySelector('button[type=submit]').click();
      return 'submitted';
    })()`,
  );

/** Есть ли панель бара (index.html?panel=pwsave) с живым текстом. */
async function saveBar() {
  for (const t of await cdpTargets()) {
    if (!t.url.includes("panel=pwsave")) continue;
    const ws = connect(t.webSocketDebuggerUrl);
    try {
      await ws.closed;
      const text = await evalIn(ws, `document.getElementById('pwSaveText')?.textContent || ''`);
      if (text) return { ws, text };
    } catch {}
    ws.close();
  }
  return null;
}
async function noSaveBar() {
  return (await saveBar()) === null;
}
const clickBar = (bar, id) => evalIn(bar.ws, `document.getElementById('${id}').click(); 'clicked'`);

/** bridge-вызов из хрома (window.__duopulse — src/bridge/dev-probe.ts). */
const chromeCall = (ws, expr) => evalIn(ws, `(async()=>{ try { return await (${expr}); } catch(e){ return 'ERR:' + e; } })()`);

let exitCode = 0;
try {
  // --- старт: ждём сайт-вкладку (START_URL) и хром --------------------------
  const tab = await waitForTarget(`127.0.0.1:${HTTP_PORT}`, CONTENT_PROBE);
  const chrome = await waitForTarget("localhost:5173", CHROME_PROBE).catch(() => null);
  const viaChrome = (expr) => (chrome ? chromeCall(chrome, expr) : Promise.resolve("NO-CHROME"));

  // 1. сабмит → бар → «Сохранить» → запись в хранилище
  await submitLogin(tab, "artem", "s3cret!");
  let bar = null;
  for (let i = 0; i < 40 && !bar; i++) {
    bar = await saveBar();
    if (!bar) await sleep(250);
  }
  check("сабмит формы логина показывает бар «Сохранить пароль?»", !!bar, bar?.text ?? "бар не появился");
  if (bar) {
    check("текст бара — сайт и логин", /artem/.test(bar.text) && bar.text.includes("127.0.0.1"), bar.text);
    await clickBar(bar, "pwSaveAccept");
    await sleep(600);
  }
  const saved = await viaChrome(`window.__duopulse.passwords.list({query:'artem', limit:10})`);
  check(
    "«Сохранить» пишет запись хранилища (passwords.list)",
    saved && saved.total === 1 && saved.items[0]?.username === "artem" && saved.items[0]?.origin === siteA,
    JSON.stringify(saved?.items?.[0] ?? saved),
  );
  const savedId = saved?.items?.[0]?.id;
  check("бар закрыт после решения", await noSaveBar());

  // 1b. живучесть бара (duopulse-142): клик по странице бар не убивает,
  //     переключение вкладок закрывает, возврат на вкладку — перепоказывает
  await tab.send("Page.navigate", { url: `${siteA}/login` });
  await sleep(1000);
  await submitLogin(tab, "artem", "surv1ve!");
  bar = null;
  for (let i = 0; i < 40 && !bar; i++) {
    bar = await saveBar();
    if (!bar) await sleep(250);
  }
  check("повторный сабмит (новый пароль) снова показывает бар", !!bar, bar?.text ?? "бар не появился");
  if (bar) {
    // клик по странице (mousedown — канал dp-close-panel) бар не закрывает
    await evalIn(tab, `document.body.dispatchEvent(new MouseEvent('mousedown', {bubbles:true})); 'md'`);
    await sleep(700);
    const survived = await saveBar();
    check("mousedown по странице не закрывает бар (duopulse-142)", !!survived, "бар погиб от клика по контенту");
    // уходим на другую вкладку — панель закрывается (кандидат жив в Core)
    const tabsBefore = await viaChrome(`window.__duopulse.tabs.list()`);
    const tabA = tabsBefore?.tabs?.find((t) => t.url.includes(`127.0.0.1:${HTTP_PORT}`));
    await viaChrome(`window.__duopulse.tabs.open({url:'${siteB}/login'})`);
    await sleep(1000);
    check("уход с вкладки кандидата закрывает панель", await noSaveBar());
    // возврат на вкладку кандидата — бар возвращается (сверка по tabs.updated)
    await viaChrome(`window.__duopulse.tabs.activate({id:'${tabA?.id}'})`);
    let back = null;
    for (let i = 0; i < 40 && !back; i++) {
      back = await saveBar();
      if (!back) await sleep(250);
    }
    check("возврат на вкладку перепоказывает бар (duopulse-142)", !!back, "бар не вернулся");
    if (back) {
      await clickBar(back, "pwSaveClose");
      await sleep(600);
    }
    check("закрывающий крестик бара гасит кандидата (dismiss)", await noSaveBar());
    // подчистить вкладку B — проверка 5 ниже ждёт СВОЮ свежую вкладку B активной
    const tabsCleanup = await viaChrome(`window.__duopulse.tabs.list()`);
    for (const t of tabsCleanup?.tabs ?? []) {
      if (t.url.includes(`127.0.0.1:${HTTP_PORT_B}`)) {
        await viaChrome(`window.__duopulse.tabs.close({id:'${t.id}'})`);
        await sleep(400);
      }
    }
  }

  // 2. повторный заход → клик по полю логина → автозаполнение
  await tab.send("Page.navigate", { url: `${siteA}/login` });
  await sleep(1200);
  await evalIn(tab, `document.querySelector('input[type=text]').click(); 'clicked'`);
  await sleep(700);
  const filled = await evalIn(
    tab,
    `(function(){ const u=document.querySelector('input[type=text]'); const p=document.querySelector('input[type=password]');
       return JSON.stringify({u:u.value, p:p.value}); })()`,
  );
  const fv = JSON.parse(filled);
  check("клик по полю заполняет логин и пароль", fv.u === "artem" && fv.p === "s3cret!", filled);

  // 3. смена пароля → бар «Обновить…» → запись одна, пароль новый
  await submitLogin(tab, "artem", "n3wpass!");
  bar = null;
  for (let i = 0; i < 40 && !bar; i++) {
    bar = await saveBar();
    if (!bar) await sleep(250);
  }
  check("смена пароля показывает бар обновления", !!bar && /Обновить/.test(bar.text), bar?.text ?? "бар не появился");
  if (bar) {
    const acceptLabel = await evalIn(bar.ws, `document.getElementById('pwSaveAccept').textContent`);
    check("кнопка бара — «Обновить»", acceptLabel.trim() === "Обновить", String(acceptLabel));
    await clickBar(bar, "pwSaveAccept");
    await sleep(600);
  }
  const after = await viaChrome(`window.__duopulse.passwords.list({query:'artem', limit:10})`);
  check("обновление — запись по-прежнему одна", after?.total === 1, `total=${after?.total}`);
  const revealed = await viaChrome(`window.__duopulse.passwords.reveal({id:${savedId}})`);
  check("пароль обновлён в хранилище", revealed?.password === "n3wpass!", JSON.stringify(revealed));

  // 4. второй аккаунт → chooser из двух → выбор второго заполняет
  await viaChrome(`window.__duopulse.passwords.add({url:'${siteA}/login', title:'Вход Example', username:'alya', password:'alya-pass'})`);
  await tab.send("Page.navigate", { url: `${siteA}/login` });
  await sleep(1200);
  await evalIn(tab, `document.querySelector('input[type=password]').click(); 'clicked'`);
  await sleep(500);
  const chooserItems = await evalIn(
    tab,
    `(function(){ const n=document.querySelector('[data-duopulse-accounts]');
       return n ? JSON.stringify([...n.children].map(x=>x.textContent)) : ''; })()`,
  );
  check(
    "несколько аккаунтов — chooser с логинами сайта",
    chooserItems === JSON.stringify(["artem", "alya"]),
    chooserItems || "chooser не открылся",
  );
  await evalIn(
    tab,
    `(function(){ const n=document.querySelector('[data-duopulse-accounts]');
       n.children[1].click(); return 'picked'; })()`,
  );
  await sleep(600);
  const filled2 = JSON.parse(
    await evalIn(
      tab,
      `(function(){ const u=document.querySelector('input[type=text]'); const p=document.querySelector('input[type=password]');
         return JSON.stringify({u:u.value, p:p.value}); })()`,
    ),
  );
  check("выбор второго аккаунта заполняет его", filled2.u === "alya" && filled2.p === "alya-pass", JSON.stringify(filled2));

  // 5. «Никогда для этого сайта» — сайт B больше не предлагает
  await viaChrome(`window.__duopulse.tabs.open({url:'${siteB}/login'})`);
  const tabB = await waitForTarget(`127.0.0.1:${HTTP_PORT_B}`, CONTENT_PROBE);
  await sleep(600);
  await submitLogin(tabB, "bob", "bob-pass");
  bar = null;
  for (let i = 0; i < 30 && !bar; i++) {
    bar = await saveBar();
    if (!bar) await sleep(250);
  }
  check("незнакомый сайт B тоже предлагает бар", !!bar, bar?.text ?? "бар не появился");
  if (bar) {
    await clickBar(bar, "pwSaveNever");
    await sleep(600);
  }
  // повторный сабмит на B — бара нет (denylist)
  await tabB.send("Page.navigate", { url: `${siteB}/login` });
  await sleep(1200);
  await submitLogin(tabB, "carol", "carol-pass");
  await sleep(2000);
  check("«Никогда для этого сайта» — сайт B больше не предлагает", await noSaveBar());

  // 6. инкогнито: не предлагает и не заполняет
  const targetsBefore = new Set((await cdpTargets()).map((t) => t.id));
  await viaChrome(`window.__duopulse.tabs.open({url:'${siteA}/login', incognito:true})`);
  // инкогнито-вкладка — НОВАЯ CDP-цель с тем же адресом; ищем диффом
  let incog = null;
  const t0 = Date.now();
  while (!incog && Date.now() - t0 < 30000) {
    for (const t of await cdpTargets()) {
      if (targetsBefore.has(t.id) || !t.url.includes(`127.0.0.1:${HTTP_PORT}`)) continue;
      const ws = connect(t.webSocketDebuggerUrl);
      try {
        await ws.closed;
        if ((await evalIn(ws, CONTENT_PROBE)) === "ready") {
          incog = ws;
          break;
        }
      } catch {}
      ws.close();
    }
    if (!incog) await sleep(400);
  }
  if (incog) {
    const state = await evalIn(
      incog,
      `JSON.stringify(window.__duopulseContent.state().passwords)`,
    );
    await submitLogin(incog, "eve", "eve-pass").catch(() => "навигация");
    await sleep(2000);
    const noBar = await noSaveBar();
    // автозаполнение: возврат на страницу логина siteA (логины есть) — поле пусто
    await incog.send("Page.navigate", { url: `${siteA}/login` });
    await sleep(1200);
    await evalIn(incog, `document.querySelector('input[type=text]').click(); 'clicked'`).catch(() => {});
    await sleep(700);
    const v = await evalIn(incog, `document.querySelector('input[type=text]').value`);
    check(
      "инкогнито: не предлагает сохранить и не заполняет",
      /"incognito":true/.test(String(state)) && noBar && v === "",
      `state=${String(state).slice(0, 60)}… bar=${!noBar} fill="${v}"`,
    );
    incog.close();
  } else {
    check("инкогнито: не предлагает сохранить и не заполняет", false, "инкогнито-цель не найдена");
  }

  tab.close();
  chrome?.close();
  tabB.close();
} catch (e) {
  console.error("СТЕНД: ошибка", e);
  exitCode = 1;
} finally {
  await gracefulClose(app);
  try {
    await run("taskkill", ["/PID", String(vite.pid), "/T", "/F"]);
  } catch {}
  serverA.close();
  serverB.close();
  await killWebViewOf(profile);
  await killOurExes();
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {}
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nИтог: ${results.length - failed}/${results.length} проверок прошли`);
  process.exit(failed > 0 || exitCode ? 1 : 0);
}
