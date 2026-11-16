// E2E-смоук duopulse-161 «фавиконы сайтов в строке закладок» через CDP в
// живом приложении (паттерн e2e/bookmarks/bm-groups.mjs: изоляция —
// временный APPDATA, vite dev поднимает сам, требует собранный debug-exe).
//   1) сид: закладки на живые хосты трёх сортов — корневой /favicon.ico
//      (youtube), иконка только по <link rel=icon> из HTML (github, habr,
//      wikipedia) и сайт без иконки вовсе (локальный стенд);
//   2) у каждого «иконочного» чипа — img.bm-fav с data:image/* (иконку
//      fetched Core, не <img src=/favicon.ico>);
//   3) без-иконочный чип — бейдж-буква, img нет (негатив-кэш не врёт);
//   4) повторный рендер строки не плодит вторые img (кэш сеанса/профиля);
//   5) скриншот строки — %TEMP%/duopulse-161-bar.png.
// Живые хосты гоняются сетью (как favicon_live в cargo): за бот-блоком
// стенда иконка может не прийти — это soft-fail с пометкой, не падение.
//
// Запуск:  node e2e/bookmarks/bm-favicon.mjs [путь-к-duopulse.exe]
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const step = (s) => console.log(`-- шаг: ${s}`);
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const EXE_PS = EXE.replaceAll("/", "\\");
const CDP_PORT = Number(process.env.CDP_PORT || 9234);
const HTTP_PORT = Number(process.env.E2E_161_PORT || 8909);
const SHOT = path.join(os.tmpdir(), "duopulse-161-bar.png");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))),
  );
const killOurExes = async () => {
  try {
    await run("powershell", [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='duopulse.exe'" | Where-Object { $_.ExecutablePath -eq '${EXE_PS}' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }`,
    ]);
  } catch {
    /* уже мертвы — ок */
  }
};

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

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
  const evalIn = (expr, awaitPromise = true) =>
    send("Runtime.evaluate", { expression: expr, awaitPromise, returnByValue: true }).then((r) => {
      if (r?.exceptionDetails) return "EXC: " + String(r.exceptionDetails.text).slice(0, 200);
      return r?.result?.value;
    });
  const evalT = (expr, ms = 6000) =>
    Promise.race([evalIn(expr), sleep(ms).then(() => "EVAL-TIMEOUT")]);
  return { ws, send, evalIn, evalT };
}

const waitFor = async (fn, ms, stepMs = 400) => {
  for (let end = Date.now() + ms; Date.now() < end; ) {
    const v = await fn();
    if (v) return v;
    await sleep(stepMs);
  }
  return null;
};

// локальный «сайт без иконки»: ни /favicon.ico, ни <link rel=icon>
const httpServer = http.createServer((req, res) => {
  if (req.url.startsWith("/favicon")) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<html><head><title>Без иконки</title></head><body>стенд 161</body></html>`);
});
await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));

// несвежий vite на 5173 подсунул бы СТАРЫЙ бандл — чистим (паттерн bm-groups)
try {
  await run("powershell", [
    "-NoProfile",
    "-Command",
    `$c = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue;
     if ($c) { $c | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }`,
  ]);
} catch {
  /* порт свободен — ок */
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-161-e2e-"));
const vite = spawn("npm", ["run", "dev"], { cwd: ROOT, shell: true, stdio: "ignore" });
for (let i = 0; i < 60; i++) {
  try {
    await fetch("http://localhost:5173/");
    break;
  } catch {
    await sleep(500);
  }
}

await killOurExes();
const app = spawn(EXE, [], {
  stdio: "ignore",
  env: {
    ...process.env,
    APPDATA: tmp,
    DUOPULSE_START_URL: `http://127.0.0.1:${HTTP_PORT}/start`,
    DUOPULSE_ADBLOCK_LISTS: "",
    WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
  },
});

// Живые хосты: у youtube есть корневой .ico (работало и раньше); github,
// habr, wikipedia — иконка добывается разбором HTML/фолбэками (в чём суть
// duopulse-161). Локальный стенд — негатив (буква, без img).
const SITES = [
  ["https://www.youtube.com/", "YouTube"],
  ["https://github.com/", "GitHub"],
  ["https://habr.com/", "Хабр"],
  ["https://ru.wikipedia.org/", "Википедия"],
];
const NO_ICON = `http://127.0.0.1:${HTTP_PORT}/plain`;

let ui = null;
let exitCode = 1;
try {
  step("ждём CDP-цель UI");
  ui = await waitFor(async () => {
    try {
      const list = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
      return (
        list.find((t) => t.type === "page" && /localhost:5173/.test(t.url) && !/panel=/.test(t.url)) ??
        null
      );
    } catch {
      return null;
    }
  }, 60000);
  check("приложение поднялось (CDP-цель UI)", !!ui, ui?.url ?? "не дождались");
  if (!ui) throw new Error("нет CDP");
  const uiWs = connect(ui.webSocketDebuggerUrl);
  await uiWs.send("Runtime.enable").catch(() => {});
  await waitFor(() => uiWs.evalT(`document.querySelectorAll('.tab').length > 0 ? 1 : 0`, 4000), 15000);
  const H = `window.__duopulse.history`;

  step(`сид: ${SITES.length} сайта с иконкой + локальный без иконки`);
  for (const [url, title] of SITES) {
    await uiWs.evalIn(`${H}.bookmarkAdd(${JSON.stringify({ url, title, groupId: null })})`);
  }
  await uiWs.evalIn(`${H}.bookmarkAdd(${JSON.stringify({ url: NO_ICON, title: "Без иконки", groupId: null })})`);
  await waitFor(
    () => uiWs.evalT(`document.querySelectorAll('#bmbar .bm-item[data-url]').length >= ${SITES.length + 1} ? 1 : 0`, 4000),
    15000,
  );
  check("чипы строки закладок отрисованы", true);

  step("ждём фавиконы чипов (Core фетчит живые сайты)");
  const chipDump = `(() => {
      const chips = [...document.querySelectorAll('#bmbar .bm-item[data-url]')];
      const out = [];
      for (const ch of chips) {
        const img = ch.querySelector('img.bm-fav');
        out.push({ url: ch.dataset.url, hasImg: !!img, src: img ? img.src.slice(0, 24) : '', nImg: ch.querySelectorAll('img.bm-fav').length });
      }
      return JSON.stringify(out);
    })()`;
  // ждём, пока у каждого живого сайта появится img (Core фетчит по Host'у);
  // таймаут — мягкий: ниже каждый чип проверяется по факту
  const chipsArr = await waitFor(async () => {
    const s = await uiWs.evalT(chipDump, 4000);
    if (typeof s !== "string" || s.startsWith("EXC")) return null;
    const arr = JSON.parse(s);
    return SITES.every(([u]) => arr.find((c) => c.url === u)?.hasImg) ? arr : null;
  }, 90000, 1000);
  const favInfo = await uiWs.evalT(chipDump, 4000);

  const chips = JSON.parse(typeof favInfo === "string" ? favInfo : "[]");
  const byUrl = Object.fromEntries(chips.map((c) => [c.url, c]));
  for (const [url] of SITES) {
    const c = byUrl[url];
    const ok = !!c?.hasImg && c.src.startsWith("data:image/") && c.nImg === 1;
    check(`фавикон ${new URL(url).host}: img data:image/*`, ok, c ? `src=${c.src}` : "чип не найден");
  }
  const neg = byUrl[NO_ICON];
  check(
    "сайт без иконки — бейдж-буква, img нет",
    !!neg && !neg.hasImg,
    neg ? (neg.hasImg ? `внезапный img ${neg.src}` : "ок") : "чип не найден",
  );

  step("повторный рендер: кэш не плодит вторые img");
  await uiWs.evalIn(`${H}.bookmarkAdd(${JSON.stringify({ url: SITES[0][0], title: SITES[0][1], groupId: null })})`);
  await sleep(1500);
  const dup = await uiWs.evalT(
    `[...document.querySelectorAll('#bmbar .bm-item[data-url]')].every(ch => ch.querySelectorAll('img.bm-fav').length <= 1) ? 1 : 0`,
    4000,
  );
  check("после ре-рендера у чипа не больше одного img", dup === 1);

  step("скриншот строки");
  await uiWs.send("Page.enable").catch(() => {});
  const shot = await uiWs.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(SHOT, Buffer.from(shot.data, "base64"));
  console.log(`скриншот: ${SHOT}`);

  exitCode = results.every((r) => r.ok) ? 0 : 1;
} catch (e) {
  console.log("ошибка стенда:", String(e).slice(0, 400));
  exitCode = 1;
} finally {
  step("уборка");
  await killOurExes();
  vite.kill();
  httpServer.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* файлы вебвью ещё держатся — оставим %TEMP%-хвост, чистка подберёт */
  }
}
console.log(results.every((r) => r.ok) ? `ИТОГ: ${results.filter((r) => r.ok).length}/${results.length} PASS` : `ИТОГ: FAIL (${results.filter((r) => !r.ok).length} из ${results.length})`);
process.exit(exitCode);
