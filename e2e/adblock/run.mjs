// E2E-прогон задачи 2.1 «adblock-rs: сетевая фильтрация» (карточка
// duopulse-017, DoD: списки обновляются; исключение для сайта работает).
// Реальное приложение + локальный тест-лист (DUOPULSE_ADBLOCK_LISTS →
// файл, сеть не нужна). Через CDP в UI-webview (dev-хук __duopulse):
//   1) adblock.status: включён из коробки, движок готов, правила тест-листа;
//   2) страница стенда: /blocked-path/* режется ДО сети (403 +
//      X-DuoPulse-Block: adblock, сервер хита не видел), /ok-path — мимо;
//      <script src> в blocked-path не грузится (ResourceContext → тип);
//   3) счётчик: status.blockedTotal растёт, событие adblock:blocked_count
//      доходит (журнал __duopulseAdblockEvents);
//   4) исключение сайта: adblock.set_enabled site=127.0.0.1 on=false →
//      после reload ничего не блокируется; on=true — снова блокируется;
//   5) глобальный тумблер: set_enabled site=null on=false → нет блокировок,
//      ключ "adblock" в settings.json; рестарт приложения — настройка живёт;
//   6) обновление списков: правило дописывается в файл, adblock.update_lists
//      force → движок перестроен (rules вырос), новое правило действует.
// Изоляция: APPDATA и WEBVIEW2_USER_DATA_FOLDER — во временном каталоге.
//
// Запуск:  node e2e/adblock/run.mjs [путь-к-duopulse.exe]
// Требует собранный debug-exe (cargo build) и запускает vite dev сам.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const CDP_PORT = 9228;
const HTTP_PORT = 8896;
const FIXTURE = path.join(ROOT, "e2e", "adblock", "filters-test.txt");
const FIXTURE_RULES = 2; // /blocked-path/* и /late-rule/* (комментарии не в счёт)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))));

/** Убить только экземпляры НАШЕГО exe. */
const killOurExes = async () => {
  try {
    await run("powershell", [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='duopulse.exe'" | Where-Object { $_.ExecutablePath -eq '${EXE}' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }`,
    ]);
  } catch {
    /* уже мертвы — ок */
  }
};

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

// --- 1. локальный http-стенд: страница с блокируемыми/чистыми запросами ------
const hits = { blocked: 0, ok: 0, late: 0 };
const page = `<!doctype html><html><head><title>adblock-stand</title></head><body>
<script>
window.__results = null;
async function probe() {
  const r = {};
  try {
    const resp = await fetch("/blocked-path/ad.js", { cache: "no-store" });
    r.blockedStatus = resp.status;
    r.blockedHeader = resp.headers.get("x-duopulse-block");
  } catch (e) { r.blockedError = String(e); }
  try {
    const resp = await fetch("/ok-path/lib.js", { cache: "no-store" });
    r.okStatus = resp.status;
  } catch (e) { r.okError = String(e); }
  r.script = await new Promise((res) => {
    const s = document.createElement("script");
    s.src = "/blocked-path/s.js?" + Math.random();
    s.onload = () => res("loaded");
    s.onerror = () => res("blocked");
    document.head.appendChild(s);
    setTimeout(() => res("timeout"), 8000);
  });
  window.__results = r;
  document.title = "probed";
}
probe();
</script></body></html>`;
const httpServer = http.createServer((req, res) => {
  const noCache = { "Content-Type": "application/javascript", "Cache-Control": "no-store" };
  if (req.url.startsWith("/blocked-path")) hits.blocked++;
  else if (req.url.startsWith("/late-rule")) hits.late++;
  else if (req.url.startsWith("/ok-path")) hits.ok++;
  if (req.url === "/" || req.url.startsWith("/start")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(page);
  } else {
    res.writeHead(200, noCache);
    res.end("// stub");
  }
});
await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));

// --- 2. изолированный профиль + тест-лист (копия: прогон допишет правило) ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-adblock-e2e-"));
const fixtureCopy = path.join(tmp, "filters-test.txt");
fs.copyFileSync(FIXTURE, fixtureCopy);

const appEnv = () => ({
  ...process.env,
  APPDATA: tmp,
  DUOPULSE_START_URL: `http://127.0.0.1:${HTTP_PORT}/start`,
  DUOPULSE_ADBLOCK_LISTS: `test=${fixtureCopy}`,
  WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
});

// --- 3. vite dev --------------------------------------------------------------
const vite = spawn("npm", ["run", "dev"], { cwd: ROOT, shell: true, stdio: "ignore" });
for (let i = 0; i < 60; i++) {
  try {
    await fetch("http://localhost:5173/");
    break;
  } catch {
    await sleep(500);
  }
}

async function waitForTargets() {
  let targets = [];
  for (let i = 0; i < 60; i++) {
    try {
      targets = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
      const hasUi = targets.some((t) => t.type === "page" && /localhost:5173/.test(t.url));
      const hasContent = targets.some((t) => t.type === "page" && t.url.includes(":" + HTTP_PORT));
      if (hasUi && hasContent) return targets;
    } catch {
      /* поднимается */
    }
    await sleep(1000);
  }
  throw new Error("CDP-цели не поднялись");
}

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
          pending.set(i, { res, rej });
          ws.send(JSON.stringify({ id: i, method, params }));
        }),
    );
  return { send, close: () => ws.close() };
}

const evalIn = async (ws, expression) => {
  const r = await ws.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception ?? r.exceptionDetails));
  return r.result?.value;
};

/** Ждать результаты пробы на контент-вкладке (после load/reload). */
async function readProbe(contentWs) {
  for (let i = 0; i < 20; i++) {
    const r = await evalIn(contentWs, `window.__results`);
    if (r) return r;
    await sleep(500);
  }
  throw new Error("проба страницы не завершилась");
}

let app;
let failures = 0;
try {
  app = spawn(EXE, [], { stdio: "ignore", env: appEnv() });
  let targets = await waitForTargets();
  const uiWs = connect(targets.find((t) => t.type === "page" && /localhost:5173/.test(t.url)).webSocketDebuggerUrl);
  const contentWs = connect(targets.find((t) => t.type === "page" && t.url.includes(":" + HTTP_PORT)).webSocketDebuggerUrl);

  // dev-хук готов?
  for (let i = 0; i < 20; i++) {
    if ((await evalIn(uiWs, `typeof window.__duopulse`)) === "object") break;
    await sleep(500);
  }

  // (1) статус: включён из коробки, движок из файлового списка
  let st = await evalIn(uiWs, `window.__duopulse.adblock.status()`);
  check(
    "adblock.status: включён из коробки, движок готов, правила тест-листа",
    st?.enabled === true && st?.ready === true && st?.lists?.length === 1 &&
      st.lists[0].name === "test" && st.lists[0].rules === FIXTURE_RULES && !st.lists[0].error,
    JSON.stringify(st?.lists),
  );

  // (2) блокировка до сети: страница пробы
  let probe = await readProbe(contentWs);
  check(
    "fetch /blocked-path → 403 с X-DuoPulse-Block: adblock",
    probe.blockedStatus === 403 && probe.blockedHeader === "adblock",
    JSON.stringify(probe),
  );
  check("fetch /ok-path → 200 (чистый ресурс)", probe.okStatus === 200, JSON.stringify(probe));
  check(
    "<script src=/blocked-path> не выполнен (тип запроса из ResourceContext)",
    probe.script === "blocked",
    probe.script,
  );
  check(
    "сервер не видел blocked-запросов (запрос резался до сети), ok-видел",
    hits.blocked === 0 && hits.ok >= 1,
    JSON.stringify(hits),
  );

  // (3) счётчик (событие проверяем после reload ниже: на старте блокировки
  // могут флэшиться до регистрации слушателя в UI — вкладки грузятся параллельно)
  st = await evalIn(uiWs, `window.__duopulse.adblock.status()`);
  check("счётчик blockedTotal ≥ 2 (fetch + script)", st?.blockedTotal >= 2, `blockedTotal=${st?.blockedTotal}`);

  // (4) исключение сайта: 127.0.0.1 → white-list
  st = await evalIn(uiWs, `window.__duopulse.adblock.setEnabled({ site: "127.0.0.1", on: false })`);
  check(
    "set_enabled site=127.0.0.1 on=false: сайт в исключениях",
    st?.siteExceptions?.includes("127.0.0.1") === true,
    JSON.stringify(st?.siteExceptions),
  );
  await evalIn(uiWs, `window.__duopulse.nav.reload()`);
  probe = await readProbe(contentWs);
  check(
    "после reload сайт-исключение не блокируется (403 → 200)",
    probe.blockedStatus === 200 && probe.script === "loaded",
    JSON.stringify(probe),
  );
  const totalAfterException = (await evalIn(uiWs, `window.__duopulse.adblock.status()`)).blockedTotal;

  // вернуть блокировку сайту
  st = await evalIn(uiWs, `window.__duopulse.adblock.setEnabled({ site: "127.0.0.1", on: true })`);
  await evalIn(uiWs, `window.__duopulse.nav.reload()`);
  probe = await readProbe(contentWs);
  check(
    "set_enabled on=true: блокировка сайту возвращена",
    probe.blockedStatus === 403 && probe.script === "blocked",
    JSON.stringify(probe),
  );
  const totalAfterReEnable = (await evalIn(uiWs, `window.__duopulse.adblock.status()`)).blockedTotal;
  check("после снятия исключения блокировка возобновилась (счётчик вырос)", totalAfterReEnable >= totalAfterException + 2, `${totalAfterException} → ${totalAfterReEnable}`);
  await sleep(1200); // батчинг событий ~400 мс
  const events = await evalIn(uiWs, `window.__duopulseAdblockEvents`);
  check(
    "событие adblock:blocked_count доставлено в UI (журнал dev-probe)",
    Array.isArray(events) && events.length >= 1 && events.at(-1).total === totalAfterReEnable,
    `журнал=${JSON.stringify(events?.at(-1))}, счётчик=${totalAfterReEnable}`,
  );

  // (5) глобальный тумблер + персистентность
  await evalIn(uiWs, `window.__duopulse.adblock.setEnabled({ site: null, on: false })`);
  await evalIn(uiWs, `window.__duopulse.nav.reload()`);
  probe = await readProbe(contentWs);
  check(
    "глобальный тумблер off: ничего не блокируется",
    probe.blockedStatus === 200 && probe.script === "loaded",
    JSON.stringify(probe),
  );
  const rawSettings = fs.readFileSync(path.join(tmp, "DuoPulse", "profile", "settings.json"), "utf8");
  check("settings.json: ключ adblock с enabled:false (персистентность)", rawSettings.includes('"adblock"') && rawSettings.includes('"enabled": false'), rawSettings.slice(0, 200));
  const filtersOk = fs.readdirSync(path.join(tmp, "DuoPulse", "profile", "filters"));
  check(
    "кэш списков в профиле: текст + скомпилированный движок + мета",
    filtersOk.includes("test.txt") && filtersOk.includes("engine.bin") && filtersOk.includes("meta.json") && filtersOk.includes("engine.json"),
    filtersOk.join(","),
  );

  // рестарт: настройка живёт (сессию отключает DUOPULSE_START_URL)
  app.kill("SIGKILL");
  await killOurExes();
  await sleep(1500);
  app = spawn(EXE, [], { stdio: "ignore", env: appEnv() });
  targets = await waitForTargets();
  const uiWs2 = connect(targets.find((t) => t.type === "page" && /localhost:5173/.test(t.url)).webSocketDebuggerUrl);
  for (let i = 0; i < 20; i++) {
    if ((await evalIn(uiWs2, `typeof window.__duopulse`)) === "object") break;
    await sleep(500);
  }
  st = await evalIn(uiWs2, `window.__duopulse.adblock.status()`);
  check("рестарт: глобальный тумблер off пережил перезапуск", st?.enabled === false, `enabled=${st?.enabled}`);
  check("рестарт: движок из кэша готов", st?.ready === true, `ready=${st?.ready}`);

  // (6) обновление списков: дописываем правило в файл-источник
  await evalIn(uiWs2, `window.__duopulse.adblock.setEnabled({ site: null, on: true })`);
  fs.appendFileSync(fixtureCopy, "/late-rule/*\n");
  await evalIn(uiWs2, `window.__duopulse.adblock.updateLists({ force: true })`);
  let rules = 0;
  for (let i = 0; i < 20; i++) {
    st = await evalIn(uiWs2, `window.__duopulse.adblock.status()`);
    rules = st?.lists?.[0]?.rules ?? 0;
    if (rules === FIXTURE_RULES + 1) break;
    await sleep(500);
  }
  check("update_lists force: движок перестроен по изменённому списку", rules === FIXTURE_RULES + 1, `rules=${rules}`);

  const contentWs2 = connect(targets.find((t) => t.type === "page" && t.url.includes(":" + HTTP_PORT)).webSocketDebuggerUrl);
  const late = await evalIn(
    contentWs2,
    `fetch("/late-rule/x.js", { cache: "no-store" }).then(r => r.status + "|" + r.headers.get("x-duopulse-block")).catch(e => "err:" + e)`,
  );
  check("новое правило /late-rule/* действует", late === "403|adblock", late);

  uiWs.close();
  uiWs2.close();
  contentWs.close();
  contentWs2.close();
} catch (e) {
  failures++;
  console.error("E2E ERROR:", e.message);
} finally {
  if (app?.kill) app.kill("SIGKILL");
  await killOurExes();
  try {
    await run("taskkill", ["/PID", String(vite.pid), "/T", "/F"]);
  } catch {
    /* дерево уже мертво — ок */
  }
  httpServer.close();
  await sleep(1000);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

const failed = results.filter((r) => !r.ok).length + failures;
console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES: " + failed} (${results.length} проверок)`);
process.exit(failed === 0 ? 0 : 1);
