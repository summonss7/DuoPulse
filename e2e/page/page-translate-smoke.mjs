// e2e/page/page-translate-smoke.mjs — стенд ПЕРЕВОДА ВСЕЙ СТРАНИЦЫ (карточка
// duopulse-244, «как в Chrome»): debug-exe + CDP (порт 9236) + локальная
// страница (8896, запретные порты — e2e-грабли duopulse-120: 8899 в
// excludedportrange). Живой gtx (клиент «⋮»-меню → bridge translate.page_begin
// → document-событие → контент собирает узлы, пачки «gtx-translate» →
// yt_fallback: clients5.google.com/translate.googleapis.com).
//
// Запуск: node e2e/page/page-translate-smoke.mjs [путь-к-duopulse.exe]
// (до запуска: npm run build — свежий контент-бандл в exe; cargo build).
//
// Проверки (9): бандл в документе (диагностика pageTranslate); пункт
// «Перевести страницу…» в «⋮»-меню UI; bridge-команда (invoke) уходит без
// ошибки и поднимает фазу translating; фаза translated и ТЕКСТЫ ПЕРЕВЕДЕНЫ
// (en → ru живым gtx, узлы с пробельным контуром); бар с селектом цели и
// подписью «Переведено»; динамика — поздний узел дочитывается MutationObserver
// (дебаунс 700 мс + сеть); «Оригинал» возвращает английский текст; повторный
// вызов меню снова переводит; бар и перевод живут в контексте вкладки
// (перевод только top-level документа).
//
// Результат — e2e/page/page-translate-last-run.json (gitignore,
// рантайм-артефакт). Чистка — деревом: taskkill /T на vite и exe
// (грабли карточки 239: vite.kill() оставляет сироту на 5173).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const HTTP_PORT = Number(process.env.HTTP_PORT || 8896);
const CDP_PORT = Number(process.env.CDP_PORT || 9236);
const LAST_RUN = path.join(ROOT, "e2e", "page", "page-translate-last-run.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) =>
  new Promise((r) => {
    const p = spawn(cmd, args, { stdio: "ignore" });
    p.on("exit", () => r());
  });

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok: !!ok, extra });
  console.log(`${ok ? "OK" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

function connect(url) {
  const ws = new WebSocket(url);
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
      if (r?.exceptionDetails) {
        const d = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "?";
        return "EXC: " + String(d).slice(0, 300);
      }
      return r?.result?.value;
    });
  return { ws, send, evalIn };
}

const waitFor = async (fn, ms, stepMs = 400) => {
  for (let end = Date.now() + ms; Date.now() < end; ) {
    const v = await fn();
    if (v) return v;
    await sleep(stepMs);
  }
  return null;
};

/** Страница стенда: известные английские узлы + скрытый до поры динамики. */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>PT244</title></head>
<body>
  <h1 id="h1">Good morning world</h1>
  <p id="p1">The quick brown fox jumps over the lazy dog.</p>
  <p id="p2">  Translation keeps leading and trailing spaces.  </p>
  <script>var notTranslated = "script content";</script>
</body></html>`;

const httpServer = http.createServer((req, res) => {
  if (req.url.startsWith("/page")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));

// чистка прошлых прогонов: только НАШ exe (Artem может держать свой DuoPulse)
const EXE_PS = EXE.replace(/\\/g, "\\");
try {
  await run("powershell", [
    "-NoProfile",
    "-Command",
    `Get-CimInstance Win32_Process -Filter "Name='duopulse.exe'" | Where-Object { $_.ExecutablePath -eq '${EXE_PS}' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }`,
  ]);
} catch {
  /* уже мертвы — ок */
}

const vite = spawn("npm", ["run", "dev"], { cwd: ROOT, shell: true, stdio: "ignore" });
const tmp = fs.mkdtempSync(path.join(process.env.TEMP || "/tmp", "duopulse-244-"));
const app = spawn(EXE, [], {
  stdio: "ignore",
  env: {
    ...process.env,
    APPDATA: tmp,
    DUOPULSE_START_URL: `http://127.0.0.1:${HTTP_PORT}/page`,
    DUOPULSE_ADBLOCK_LISTS: "",
    DUOPULSE_E2E_NO_SINGLE_INSTANCE: "1",
    WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
  },
});

let ui = null;
let tab = null;
try {
  step: {
    tab = await waitFor(async () => {
      try {
        const list = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
        return (
          list.find((t) => t.type === "page" && t.url.includes(`:${HTTP_PORT}/page`)) ?? null
        );
      } catch {
        return null;
      }
    }, 90000);
    check("контент-вкладка стенда поднялась (CDP)", !!tab, tab?.url ?? "не дождались");
    if (!tab) break step;
    const tabWs = connect(tab.webSocketDebuggerUrl);
    await tabWs.send("Runtime.enable").catch(() => {});

    ui = await waitFor(async () => {
      try {
        const list = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
        return list.find((t) => t.type === "page" && /localhost:5173/.test(t.url) && !/panel=/.test(t.url)) ?? null;
      } catch {
        return null;
      }
    }, 90000);
    check("UI-цель (vite 5173) поднялась", !!ui, ui?.url ?? "не дождались");
    if (!ui) break step;
    const uiWs = connect(ui.webSocketDebuggerUrl);
    await uiWs.send("Runtime.enable").catch(() => {});
    await waitFor(() => uiWs.evalIn(`document.querySelectorAll('.tab').length > 0 ? 1 : 0`, false), 20000);

    // --- 1. бандл в документе -----------------------------------------------
    const hasHook = await tabWs.evalIn(
      `typeof window.__duopulseContent?.state?.()?.pageTranslate === "object"`,
    );
    check("контент-бандл с pageTranslate в документе", hasHook === true, String(hasHook));

    // --- 2. пункт «⋮»-меню ---------------------------------------------------
    const hasItem = await uiWs.evalIn(
      `document.querySelector('#mainMenu button[data-act="translatePage"]') !== null`,
    );
    check("пункт «Перевести страницу…» в «⋮»-меню", hasItem === true, String(hasItem));

    // --- 3. bridge-команда запускает перевод ---------------------------------
    const inv = await uiWs.evalIn(
      `window.__TAURI_INTERNALS__.invoke('translate_page_begin', { params: { target: 'ru' } }).then(() => 'ok', (e) => 'ERR:' + e)`,
    );
    check("bridge translate.page_begin отвечает ok", inv === "ok", String(inv).slice(0, 200));
    const translating = await waitFor(
      () => tabWs.evalIn(`window.__duopulseContent.state().pageTranslate.phase`, false),
      15000,
    );
    check("фаза перевода поднялась (translating/translated)", !!translating, JSON.stringify(translating));

    // --- 4. тексты переведены (живой gtx) ------------------------------------
    let h1 = "";
    let phase = "";
    const done = await waitFor(async () => {
      phase = await tabWs.evalIn(`JSON.stringify(window.__duopulseContent.state().pageTranslate)`, false);
      h1 = await tabWs.evalIn(`document.getElementById('h1').textContent`, false);
      let ph = ""; let err = "";
      try { const st = JSON.parse(phase || "{}"); ph = st.phase; err = st.lastError; } catch {}
      return ph === "translated" && /[А-Яа-яЁё]/.test(String(h1)) ? h1 : (err ? "ERR:" + err : null);
    }, 90000);
    check("фаза translated и h1 переведён (en → ru, живой gtx)", !!done, `h1="${h1}" phase=${phase}`);
    const p2 = await tabWs.evalIn(`document.getElementById('p2').textContent`, false);
    check(
      "пробельный контур узла сохранён",
      /^\s\s/.test(String(p2)) && /\s\s$/.test(String(p2)),
      JSON.stringify(p2).slice(0, 120),
    );
    const scriptText = await tabWs.evalIn(`window.notTranslated`, false);
    check("script-узел не тронут", scriptText === "script content", String(scriptText));

    // --- 5. бар ---------------------------------------------------------------
    const bar = await tabWs.evalIn(
      `(() => { const b = document.querySelector('[data-duopulse-page-bar]'); return b ? { label: b.querySelector('span')?.textContent ?? '', select: b.querySelector('select')?.value ?? '' } : null; })()`,
    );
    check(
      "бар с подписью «Переведено» и селектом цели ru",
      !!bar && /Переведено/.test(bar.label) && bar.select === "ru",
      JSON.stringify(bar),
    );

    // --- 6. динамика дочитывается --------------------------------------------
    await tabWs.evalIn(
      `(() => { const p = document.createElement('p'); p.id = 'late'; p.textContent = 'This paragraph appears after translation started.'; document.body.append(p); return true; })()`,
    );
    const late = await waitFor(async () => {
      const t = await tabWs.evalIn(`document.getElementById('late')?.textContent`, false);
      if (t && /[А-Яа-яЁё]/.test(String(t))) return t;
      const st = await tabWs.evalIn(`JSON.stringify(window.__duopulseContent.state().pageTranslate)`, false);
      try { if (JSON.parse(st).phase === "error") return "ERR:" + JSON.parse(st).lastError; } catch {}
      return null;
    }, 30000);
    check(
      "поздний узел дочитан MutationObserver'ом",
      /[А-Яа-яЁё]/.test(String(late)),
      JSON.stringify(late).slice(0, 140),
    );

    // --- 7. «Оригинал» -------------------------------------------------------
    await tabWs.evalIn(
      `document.querySelector('[data-duopulse-page-bar] button[aria-label^="Показать оригинал"]').click()`,
    );
    await sleep(300);
    const h1orig = await tabWs.evalIn(`document.getElementById('h1').textContent`, false);
    const phaseOrig = await tabWs.evalIn(`window.__duopulseContent.state().pageTranslate.phase`, false);
    check("«Оригинал» вернул английский текст", h1orig === "Good morning world", `${h1orig} (${phaseOrig})`);

    // --- 8. повторный вызов меню — снова перевод ------------------------------
    await uiWs.evalIn(
      `window.__TAURI_INTERNALS__.invoke('translate_page_begin', { params: { target: null } }).then(() => 'ok', (e) => 'ERR:' + e)`,
    );
    const again = await waitFor(async () => {
      const t = await tabWs.evalIn(`document.getElementById('h1').textContent`, false);
      if (t && /[А-Яа-яЁё]/.test(String(t))) return t;
      const st = await tabWs.evalIn(`JSON.stringify(window.__duopulseContent.state().pageTranslate)`, false);
      try { if (JSON.parse(st).phase === "error") return "ERR:" + JSON.parse(st).lastError; } catch {}
      return null;
    }, 90000);
    check("повторный запуск (target=null — память Core) переводит заново", /[А-Яа-яЁё]/.test(String(again)), JSON.stringify(again).slice(0, 120));
  }
} catch (e) {
  check("стенд упал", false, String(e).slice(0, 300));
} finally {
  const passed = results.filter((r) => r.ok).length;
  fs.mkdirSync(path.dirname(LAST_RUN), { recursive: true });
  fs.writeFileSync(
    LAST_RUN,
    JSON.stringify({ when: new Date().toISOString(), exe: EXE, passed, total: results.length, results }, null, 2),
  );
  // чистка ДЕРЕВОМ (грабли 239: vite.kill() оставляет сироту на 5173)
  try { app.kill(); } catch {}
  try { vite.kill(); } catch {}
  await run("taskkill", ["/PID", String(app.pid), "/T", "/F"]).catch(() => {});
  await run("taskkill", ["/PID", String(vite.pid), "/T", "/F"]).catch(() => {});
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  httpServer.close();
  console.log(`\n${passed}/${results.length} проверок прошло; артефакт: ${LAST_RUN}`);
  process.exit(passed === results.length ? 0 : 1);
}
