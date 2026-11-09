// E2E-приёмка задач 1.3 «Omnibox» + 1.4 «История и закладки» (карточки
// duopulse-013/014). DoD «ручной чек» автоматизирован через CDP в UI-webview:
//   1) nav.resolve_omnibox — URL и поисковый запрос различаются (домен/IP —
//      адрес с догадкой схемы, пробелы/фразы — поиск YouTube) сквозь живое
//      приложение (юнит-уровень покрыт cargo-тестами omnibox.rs);
//   2) history.search — FTS5-подсказки: префикс по URL и заголовку, пересечение
//      токенов, пустой запрос — закладки;
//   3) UI-дропдаун: ввод «rust» → строка-действие «Поиск в YouTube» + совпадения
//      истории/закладок; пустой ввод — только закладки;
//   4) стрелки ↑↓ двигают выделение, Enter без выделения — разбор ввода
//      (тип «127.0.0.1:PORT/typed» → переход на локальный стенд), Enter с
//      выделением и клик по подсказке — переход по её адресу (URL вкладки
//      актуализируется на старте навигации — сети не ждём);
//   5) Esc — дропдаун закрыт, фокус ушёл со строки (nav.focus_page отвечает ok);
//   6) задача 1.4 — реальное хранилище SQLite в профиле: сид данных командами
//      контракта, живая запись визитов (стартовая страница в history.list),
//      удаление записей (delete_urls) и диапазонов (delete_range), закладки
//      (bookmark_add/update/remove + FTS), страница управления
//      duopulse://history (рендер, поиск, ★/✕/правка — скриншот manager.png).
// Изоляция: APPDATA и WEBVIEW2_USER_DATA_FOLDER — во временном каталоге.
// Скриншот открытого дропдауна — e2e/omnibox/suggest.png (сверка стиля с гайдом 06).
//
// Запуск:  node e2e/omnibox/run.mjs [путь-к-duopulse.exe]
// Требует собранный debug-exe (cargo build) и запускает vite dev сам.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const CDP_PORT = 9226;
// env-переопределение: 8899 на машине автора занят сервисом Aila (как E2E_PROXY_A_PORT)
const HTTP_PORT = Number(process.env.E2E_OMNIBOX_PORT || 8899);

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

// --- 1. локальный http-стенд (стартовая страница + цель перехода по Enter) ----
// <title> обязателен: заголовок вкладки/визита истории приходит из document.title
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<html><head><title>Стенд ${req.url}</title></head><body><h1>${req.url}</h1></body></html>`);
});
await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));

// --- 2. изолированный профиль (без прокси) -----------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-omnibox-e2e-"));

// --- 3. vite dev + приложение -------------------------------------------------
const vite = spawn("npm", ["run", "dev"], { cwd: ROOT, shell: true, stdio: "ignore" });
for (let i = 0; i < 60; i++) {
  try {
    await fetch("http://localhost:5173/");
    break;
  } catch {
    await sleep(500);
  }
}

const appEnv = {
  ...process.env,
  APPDATA: tmp,
  DUOPULSE_START_URL: `http://127.0.0.1:${HTTP_PORT}/start`,
  DUOPULSE_ADBLOCK_LISTS: "", // без списков: стенду не нужна сеть (задача 2.1)
  WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
};
const app = spawn(EXE, [], { stdio: "ignore", env: appEnv });

// --- 4. ждём CDP: UI (vite) и content (стенд) ---------------------------------
let targets = [];
for (let i = 0; i < 60; i++) {
  try {
    targets = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
    const hasUi = targets.some((t) => t.type === "page" && /localhost:5173/.test(t.url));
    const hasContent = targets.some((t) => t.type === "page" && t.url.includes(":" + HTTP_PORT));
    if (hasUi && hasContent) break;
  } catch {
    /* поднимается */
  }
  await sleep(1000);
}

function connect(wsUrl, onEvent) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    } else if (!m.id && onEvent) {
      onEvent(m);
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

// --- помощники поверх DOM UI ---------------------------------------------------
/** Состояние omnibox-дропдауна (открыт, строки, выделение). */
const suggestState = (ws) =>
  evalIn(ws, `(() => {
    const panel = document.getElementById('suggest');
    return {
      open: !panel.hidden,
      rows: [...panel.children].map(el => ({
        kind: el.dataset.kind,
        url: el.dataset.url ?? null,
        sel: el.dataset.sel === 'true',
        main: el.querySelector('.main')?.textContent ?? '',
        sub: el.querySelector('.sub')?.textContent ?? '',
      })),
    };
  })()`);
/** Ввести текст в omnibox (эмулирует печать: value + событие input). */
const setInput = (ws, v) =>
  evalIn(ws, `(() => {
    const i = document.getElementById('omnibox');
    i.focus();
    i.value = ${JSON.stringify(v)};
    i.dispatchEvent(new Event('input'));
    return i.value;
  })()`);
const pressKey = (ws, key) =>
  evalIn(ws, `document.getElementById('omnibox')
    .dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, cancelable: true }))`);
const tabUrl = async (ws) =>
  (await evalIn(ws, `window.__duopulse.tabs.list()`))?.tabs?.find((t) => t.active)?.url ?? "";
/** Ждать, пока URL активной вкладки не станет равен ожидаемому. */
const waitTabUrl = async (ws, expected, timeout = 8000) =>
  waitFor(async () => {
    const u = await tabUrl(ws);
    return u === expected ? u : null;
  }, timeout);
/** Ждать попадания на сайт подсказки: внешний адрес может редиректить
 *  (wikipedia / → /wiki/Заглавная_страница), поэтому сравниваем origin. */
const waitTabSite = async (ws, expected, timeout = 15000) => {
  const origin = new URL(expected).origin;
  return waitFor(async () => {
    const u = await tabUrl(ws);
    try {
      return new URL(u).origin === origin ? u : null;
    } catch {
      return null;
    }
  }, timeout);
};
/** Поллить условие до истинного (по умолчанию 8 с). */
const waitFor = async (fn, timeout = 8000) => {
  for (const deadline = Date.now() + timeout; ; ) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(250);
  }
};

let failures = 0;
// консоль UI: ошибки omnibox (console.error) видны в отчёте прогона
const uiConsole = [];
try {
  const ui = targets.find((t) => t.type === "page" && /localhost:5173/.test(t.url));
  if (!ui) throw new Error("UI-цель CDP не найдена: " + targets.map((t) => t.url).join(", "));
  const uiWs = connect(ui.webSocketDebuggerUrl, (m) => {
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      uiConsole.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    }
    if (m.method === "Runtime.exceptionThrown") {
      uiConsole.push("EXC: " + JSON.stringify(m.params.exceptionDetails.exception ?? {}).slice(0, 200));
    }
  });
  await uiWs.send("Runtime.enable").catch(() => {});

  // Дропдаун подсказок (duopulse-090) — child-webview-цель index.html?panel=
  // suggest: DOM списка живёт там; цель пересоздаётся на каждый ввод-сеанс.
  const sugPanelWs = async (timeout = 8000) => {
    const t = await waitFor(async () => {
      const list = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
      // title в /json лагает — цель ищем по URL, boot подтвердит DOM ниже
      return list.find(
        (x) => x.type === "page" && x.url.includes("?panel=suggest"),
      ) ?? null;
    }, timeout);
    if (!t) return null;
    const ws = connect(t.webSocketDebuggerUrl, (m) => {
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
        uiConsole.push("[suggest] " + m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
      }
    });
    await ws.send("Runtime.enable").catch(() => {});
    // boot панели мог ещё не оцениться (цель появляется раньше DOM-модуля)
    await waitFor(() => evalIn(ws, `document.documentElement.dataset.panel === "suggest" ? 1 : 0`), 4000).catch(() => {});
    return ws;
  };
  /** Состояние дропдауна: панель живёт своей целью (нет — закрыт). */
  const suggestOpen = async () => {
    const w = await sugPanelWs(3000);
    return w ? await suggestState(w) : { open: false, rows: [] };
  };

  // dev-хук bridge (src/bridge/dev-probe.ts) — ждём готовности
  const probe = await waitFor(
    () => evalIn(uiWs, `typeof window.__duopulse === "object" ? "ready" : ""`),
    15000,
  );
  check("dev-хук window.__duopulse доступен в UI", probe === "ready", `state=${probe}`);

  // Хром грузится динамическим импортом (роутер src/main.ts: хром и внутренние
  // страницы не живут друг в друге) — ждём первый рендер таб-бара: к нему
  // слушатели omnibox/кнопок уже стоят.
  const chromeReady = await waitFor(
    () => evalIn(uiWs, `document.querySelectorAll('.tab').length > 0 ? "ready" : ""`),
    15000,
  );
  check("хром UI инициализирован (таб-бар отрисован)", chromeReady === "ready", `state=${chromeReady}`);

  // --- (0) сид реального хранилища (задача 1.4: SQLite duopulse.db) -----------
  // В 1.3 данные сидировались внутри Core; теперь подсказки читают живую
  // БД профиля — наполняем её тем же набором командами контракта.
  const seed = [
    ["bookmark", "https://www.youtube.com/", "YouTube"],
    ["bookmark", "https://ru.wikipedia.org/", "Википедия — свободная энциклопедия"],
    ["bookmark", "https://github.com/", "GitHub: Let's build from here"],
    ["bookmark", "https://developer.mozilla.org/ru/", "MDN Web Docs"],
    ["history", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "Rick Astley — Never Gonna Give You Up"],
    ["history", "https://www.youtube.com/results?search_query=rust+lang", "rust lang — YouTube"],
    ["history", "https://music.youtube.com/", "YouTube Music"],
    ["history", "https://www.youtube.com/feed/subscriptions", "Подписки — YouTube"],
    ["history", "https://ru.wikipedia.org/wiki/Rust", "Rust — Википедия"],
    ["history", "https://ru.wikipedia.org/wiki/Субтитры", "Субтитры — Википедия"],
    ["history", "https://en.wikipedia.org/wiki/Subtitle", "Subtitle — Wikipedia"],
    ["history", "https://github.com/tauri-apps/tauri", "tauri-apps/tauri — Tauri Framework"],
    ["history", "https://github.com/rust-lang/rust", "rust-lang/rust — Empowering everyone"],
    ["history", "https://doc.rust-lang.org/book/", "The Rust Programming Language"],
    ["history", "https://developer.mozilla.org/ru/docs/Web/API/WebSocket", "WebSocket — MDN Web Docs"],
    ["history", "https://stackoverflow.com/questions", "Stack Overflow — Where Developers Learn"],
    ["history", "https://habr.com/ru/all/", "Хабр"],
    ["history", "https://www.reddit.com/r/rust/", "r/rust — Reddit"],
    ["history", "https://news.ycombinator.com/", "Hacker News"],
    ["history", "https://translate.google.com/", "Google Переводчик"],
    ["history", "https://mail.google.com/", "Gmail"],
    ["history", "https://rustyy.ru/", "Rust по-русски — сообщество разработчиков"],
    ["history", "https://www.ivi.ru/watch/subtitles", "Фильмы с субтитрами — ivi"],
  ];
  const seedOk = await evalIn(
    uiWs,
    `(async () => {
       const h = window.__duopulse.history;
       for (const [src, url, title] of ${JSON.stringify(seed)}) {
         await (src === "bookmark" ? h.bookmarkAdd({ url, title }) : h.visit({ url, title }));
       }
       return "ok";
     })()`,
  );
  check("сид истории/закладок командами контракта (SQLite в профиле)", seedOk === "ok", String(seedOk));

  // --- (1) nav.resolve_omnibox: URL и запрос различаются ----------------------
  const res1 = await evalIn(uiWs, `window.__duopulse.nav.resolveOmnibox({ input: "example.com" })`);
  check(
    "разбор «example.com» → https-адрес",
    res1?.isSearch === false && res1?.url === "https://example.com",
    JSON.stringify(res1),
  );
  const res2 = await evalIn(uiWs, `window.__duopulse.nav.resolveOmnibox({ input: "  http://a.b/c?d=e  " })`);
  check(
    "разбор полного URL — как есть (тримминг)",
    res2?.isSearch === false && res2?.url === "http://a.b/c?d=e",
    JSON.stringify(res2),
  );
  const res3 = await evalIn(uiWs, `window.__duopulse.nav.resolveOmnibox({ input: "127.0.0.1:${HTTP_PORT}/typed" })`);
  check(
    `разбор «127.0.0.1:порт» → http-адрес (IP)`,
    res3?.isSearch === false && res3?.url === `http://127.0.0.1:${HTTP_PORT}/typed`,
    JSON.stringify(res3),
  );
  const res4 = await evalIn(uiWs, `window.__duopulse.nav.resolveOmnibox({ input: "rust lang" })`);
  check(
    "разбор «rust lang» (пробел) → поиск YouTube",
    res4?.isSearch === true &&
      res4?.url === "https://www.youtube.com/results?search_query=rust%20lang",
    JSON.stringify(res4),
  );
  const res5 = await evalIn(uiWs, `window.__duopulse.nav.resolveOmnibox({ input: "кот && 100%" })`);
  check(
    "поисковый запрос кодируется (encodeURIComponent-семантика)",
    res5?.isSearch === true &&
      res5?.url === "https://www.youtube.com/results?search_query=%D0%BA%D0%BE%D1%82%20%26%26%20100%25",
    JSON.stringify(res5),
  );

  // --- (2) history.search: FTS5-подсказки --------------------------------------
  const h1 = await evalIn(uiWs, `window.__duopulse.history.search({ query: "субтит" })`);
  check(
    "FTS: префикс «субтит» находит по заголовку (кириллица)",
    h1?.hits?.some((h) => h.url.includes("Субтитры")) === true,
    JSON.stringify(h1?.hits?.map((h) => h.url)),
  );
  const h2 = await evalIn(uiWs, `window.__duopulse.history.search({ query: "википедия субтитры" })`);
  check(
    "FTS: несколько токенов пересекаются (AND)",
    h2?.hits?.length === 1 && h2.hits[0].url.includes("Субтитры"),
    JSON.stringify(h2?.hits?.map((h) => h.url)),
  );
  const h3 = await evalIn(uiWs, `window.__duopulse.history.search({ query: "" })`);
  check(
    "пустой запрос — только закладки",
    h3?.hits?.length > 0 && h3.hits.every((h) => h.source === "bookmark"),
    JSON.stringify(h3?.hits?.map((h) => h.url)),
  );

  // --- (3) UI-дропдаун: строка-действие + FTS-совпадения -----------------------
  await setInput(uiWs, "rust");
  let st = await waitFor(async () => {
    const s = await suggestOpen();
    return s?.open && s.rows.length >= 2 ? s : null;
  });
  check(
    "ввод «rust»: дропдаун открыт, строка-действие + совпадения",
    !!st && st.rows[0].kind === "action-search" && st.rows[0].sub === "Поиск в YouTube",
    st ? JSON.stringify(st.rows.slice(0, 3)) : "не дождались",
  );
  check(
    "совпадения — история/закладки с адресом для перехода",
    !!st && st.rows.slice(1).some((r) => r.kind === "history" && r.url?.includes("rust-lang")),
    st ? JSON.stringify(st.rows.slice(1, 4).map((r) => r.url)) : "",
  );

  // скриншот открытого дропдауна (сверка стиля с гайдом 06)
  const sugShotWs = await sugPanelWs();
  const shot = await sugShotWs.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(import.meta.dirname, "suggest.png"), Buffer.from(shot.data, "base64"));

  // --- (4) стрелки: выделение двигается ----------------------------------------
  await pressKey(uiWs, "ArrowDown"); // выделение на строку-действие
  await pressKey(uiWs, "ArrowDown"); // …на первую подсказку
  st = await suggestOpen();
  check(
    "↑↓ двигают выделение (2×↓ → первая подсказка)",
    st.rows.filter((r) => r.sel).length === 1 && st.rows[1].sel === true,
    JSON.stringify(st.rows.map((r) => r.sel)),
  );
  await pressKey(uiWs, "ArrowUp");
  st = await suggestOpen();
  check(
    "↑ возвращает выделение на строку-действие",
    st.rows[0].sel === true && st.rows.filter((r) => r.sel).length === 1,
    JSON.stringify(st.rows.map((r) => r.sel)),
  );

  // --- (5) Enter без выделения: тип «URL» → переход по адресу (лок. стенд) ----
  await setInput(uiWs, `127.0.0.1:${HTTP_PORT}/typed`);
  st = await waitFor(async () => {
    const s = await suggestOpen();
    return s?.open && s.rows[0]?.kind === "action-url" ? s : null;
  });
  check(
    "ввод IP:PORT — строка-действие «Перейти по адресу» с http-схемой",
    !!st && st.rows[0].url === `http://127.0.0.1:${HTTP_PORT}/typed`,
    st ? st.rows[0].url : "не дождались",
  );
  await pressKey(uiWs, "Enter");
  const urlAfterEnter = await waitTabUrl(uiWs, `http://127.0.0.1:${HTTP_PORT}/typed`);
  check(
    "Enter без выделения: перешли по разобранному адресу",
    urlAfterEnter === `http://127.0.0.1:${HTTP_PORT}/typed`,
    urlAfterEnter ?? "не дождались",
  );

  // --- (6) клик по подсказке истории → переход по её адресу --------------------
  await setInput(uiWs, "github");
  const clickRow = await waitFor(async () => {
    const s = await suggestOpen();
    return s?.open && s.rows.some((r) => r.url?.includes("github.com/rust-lang")) ? s : null;
  });
  check(
    "ввод «github»: подсказки содержат github.com/rust-lang",
    !!clickRow,
    clickRow ? JSON.stringify(clickRow.rows.map((r) => r.url)) : "не дождались",
  );
  {
    const w = await sugPanelWs();
    await evalIn(w, `document.querySelector('.suggest-item[data-url*="github.com/rust-lang"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))`);
  }
  const urlAfterClick = await waitTabSite(uiWs, "https://github.com/rust-lang/rust");
  check(
    "клик по подсказке: вкладка пошла по её адресу",
    !!urlAfterClick,
    urlAfterClick ?? "не дождались",
  );

  // --- (7) Enter с выделением на подсказке → переход по подсказке -------------
  // база — локальный стенд (после внешней загрузки github рендерер может быть
  // занят и задержать старт следующей навигации)
  await evalIn(uiWs, `window.__duopulse.nav.navigate({ url: "http://127.0.0.1:${HTTP_PORT}/enter" })`);
  await waitTabUrl(uiWs, `http://127.0.0.1:${HTTP_PORT}/enter`, 10000);
  await setInput(uiWs, "википедия");
  const selRows = await waitFor(async () => {
    const s = await suggestOpen();
    return s?.open && s.rows.length >= 2 ? s : null;
  });
  await pressKey(uiWs, "ArrowDown");
  await pressKey(uiWs, "ArrowDown"); // выделена первая FTS-подсказка
  st = await suggestOpen();
  const selected = st.rows.find((r) => r.sel);
  await pressKey(uiWs, "Enter");
  const urlAfterSel = selected ? await waitTabSite(uiWs, selected.url) : null;
  check(
    "Enter с выделением: перешли по выделенной подсказке",
    !!selected && !!urlAfterSel,
    `выделено ${selected?.url}, вкладка ${urlAfterSel ?? "не дождались"}`,
  );

  // --- (8) Esc: дропдаун закрыт, фокус возвращён странице ---------------------
  await setInput(uiWs, "rust");
  await waitFor(async () => {
    const s = await suggestOpen();
    return s?.open;
  });
  await pressKey(uiWs, "Escape");
  st = await suggestState(uiWs);
  const focusAfterEsc = await evalIn(uiWs, `document.activeElement?.id ?? document.activeElement?.tagName`);
  const focusPageOk = await evalIn(uiWs, `window.__duopulse.nav.focusPage().then(() => "ok", e => String(e))`);
  check(
    "Esc: дропдаун закрыт, фокус ушёл из строки",
    st.open === false && focusAfterEsc !== "omnibox",
    `open=${st.open}, activeElement=${focusAfterEsc}`,
  );
  check("nav.focusPage: команда отвечает ok", focusPageOk === "ok", String(focusPageOk).slice(0, 80));

  // --- (9) пустой ввод — только закладки ---------------------------------------
  await setInput(uiWs, "");
  // ждём ЦЕЛЕВОЕ состояние: панель живёт отдельным окном, и до прихода
  // свежего suggest-data в ней виден СТАРЫЙ список (с строкой-действием)
  st = await waitFor(async () => {
    const s = await suggestOpen();
    return s?.open && s.rows.length > 0 && s.rows.every((r) => r.kind === "bookmark") ? s : null;
  });
  check(
    "пустой ввод: дропдаун — закладки без строки-действия",
    !!st && st.rows.every((r) => r.kind === "bookmark"),
    st ? JSON.stringify(st.rows.map((r) => r.url)) : "не дождались",
  );

  // --- (10) задача 1.4: живая запись визитов Core -------------------------------
  // стартовая страница стенда открывалась навигацией — on_page_load(Finished)
  // обязан был записать визит в реальную БД
  const liveList = await evalIn(uiWs, `window.__duopulse.history.list({ query: null, offset: 0, limit: 100 })`);
  check(
    "живая запись: стартовая навигация попала в history.list",
    liveList?.entries?.some((e) => e.url === `http://127.0.0.1:${HTTP_PORT}/start`) === true,
    JSON.stringify(liveList?.entries?.slice(0, 3).map((e) => e.url)),
  );
  // визит с заголовком: страница /typed открывалась в (5) — заголовок <title>
  const liveTyped = await evalIn(uiWs, `window.__duopulse.history.list({ query: "typed", offset: 0, limit: 10 })`);
  check(
    "живая запись с заголовком (on_title → note_title)",
    liveTyped?.entries?.some((e) => e.url.endsWith("/typed") && e.title === "Стенд /typed") === true,
    JSON.stringify(liveTyped?.entries?.map((e) => [e.url, e.title])),
  );

  // --- (11) задача 1.4: удаление записей и диапазонов ---------------------------
  const del = await evalIn(
    uiWs,
    `(async () => {
       const h = window.__duopulse.history;
       await h.deleteUrls({ urls: ["https://www.ivi.ru/watch/subtitles"] });
       const afterDelete = (await h.search({ query: "ivi" })).hits.length;
       const before = (await h.list({ query: null, offset: 0, limit: 1 })).total;
       await h.deleteRange({ fromMs: 0, toMs: 1 }); // пустой диапазон ничего не трогает
       const afterRange = (await h.list({ query: null, offset: 0, limit: 1 })).total;
       return { afterDelete, before, afterRange };
     })()`,
  );
  check(
    "delete_urls убирает запись и из FTS",
    del?.afterDelete === 0,
    `ivi hits=${del?.afterDelete}`,
  );
  check(
    "delete_range пустым диапазоном ничего не удаляет",
    del?.before > 0 && del?.before === del?.afterRange,
    JSON.stringify(del),
  );

  // --- (12) задача 1.4: закладки add/update/remove ------------------------------
  const bm = await evalIn(
    uiWs,
    `(async () => {
       const h = window.__duopulse.history;
       await h.bookmarkAdd({ url: "https://rustyy.ru/", title: "Rust по-русски" });
       const afterAdd = (await h.bookmarkList({ query: null, offset: 0, limit: 500 }))
         .bookmarks.some((b) => b.url === "https://rustyy.ru/");
       await h.bookmarkUpdate({ url: "https://rustyy.ru/", title: "Rust по-русски — сообщество" });
       const found = (await h.search({ query: "сообщество" }))
         .hits.some((x) => x.source === "bookmark" && x.url === "https://rustyy.ru/");
       await h.bookmarkRemove({ url: "https://rustyy.ru/" });
       const afterRemove = (await h.bookmarkList({ query: null, offset: 0, limit: 500 }))
         .bookmarks.some((b) => b.url === "https://rustyy.ru/");
       return { afterAdd, found, afterRemove };
     })()`,
  );
  check(
    "закладки: bookmarkAdd/Update(FTS)/Remove",
    bm?.afterAdd === true && bm?.found === true && bm?.afterRemove === false,
    JSON.stringify(bm),
  );

  // --- (13) задача 1.4: страница управления duopulse://history ------------------
  // omnibox в фокусе после (9) — снимаем, чтобы URL активной вкладки
  // обновился в строке (пока ввод в фокусе, значение не затирается)
  await evalIn(uiWs, `document.getElementById('omnibox').blur()`);
  await evalIn(uiWs, `window.__duopulse.tabs.open({ url: "duopulse://history" })`);
  // внутренняя страница = второй webview UI-бандла: новая CDP-цель на 5173
  const mgrTarget = await waitFor(async () => {
    const list = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
    const pages = list.filter((t) => t.type === "page" && /localhost:5173/.test(t.url));
    return pages.length >= 2
      ? pages.find((p) => p.webSocketDebuggerUrl !== ui.webSocketDebuggerUrl)
      : null;
  }, 20000);
  check("duopulse://history открыт как вкладка (новая цель UI-бандла)", !!mgrTarget, mgrTarget?.url ?? "не дождались");
  if (mgrTarget) {
    const mgrWs = connect(mgrTarget.webSocketDebuggerUrl, (m) => {
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
        uiConsole.push("[page] " + m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
      }
      if (m.method === "Runtime.exceptionThrown") {
        uiConsole.push("[page] EXC: " + JSON.stringify(m.params.exceptionDetails.exception ?? {}).slice(0, 200));
      }
    });
    await mgrWs.send("Runtime.enable").catch(() => {});

    const rows = await waitFor(async () => {
      const n = await evalIn(mgrWs, `document.querySelectorAll('.mgr-entry').length`);
      return n >= 5 ? n : null;
    }, 15000);
    check("страница: история отрисована (группы по дням, ≥5 записей)", !!rows, `rows=${rows}`);

    // omnibox хрома показывает канонический адрес вкладки-страницы
    const omniboxUrl = await evalIn(uiWs, `document.getElementById('omnibox').value`);
    check("omnibox показывает duopulse://history активной вкладки", omniboxUrl.startsWith("duopulse://history"), omniboxUrl);

    // заголовок вкладки — document.title страницы (on_document_title_changed)
    const pageTitle = await waitFor(async () => {
      const res = await evalIn(uiWs, `window.__duopulse.tabs.list()`);
      return res?.tabs?.find?.((x) => x.active)?.title ?? "";
    });
    check("заголовок вкладки страницы — «История и закладки — DuoPulse»", pageTitle === "История и закладки — DuoPulse", pageTitle);

    // поиск по странице фильтрует историю (FTS через history.list)
    await evalIn(mgrWs, `(() => {
       const i = document.querySelector('.mgr-search');
       i.focus(); i.value = 'habr'; i.dispatchEvent(new Event('input'));
       return true;
     })()`);
    const filtered = await waitFor(async () => {
      const urls = await evalIn(mgrWs, `[...document.querySelectorAll('.mgr-entry')].map((e) => e.dataset.url)`);
      return urls.length >= 1 && urls.every((u) => u.includes("habr")) ? urls : null;
    }, 8000);
    check("поиск страницы фильтрует историю (FTS)", !!filtered, filtered?.join(","));
    await evalIn(mgrWs, `(() => {
       const i = document.querySelector('.mgr-search');
       i.value = ''; i.dispatchEvent(new Event('input'));
       return true;
     })()`);
    await waitFor(async () => {
      const n = await evalIn(mgrWs, `document.querySelectorAll('.mgr-entry').length`);
      return n >= 5 ? n : null;
    }, 8000);

    // ★ в истории → закладка; ✕ → запись удалена (закладка живёт)
    const starClicked = await evalIn(mgrWs, `(() => {
       const row = document.querySelector('.mgr-entry[data-url="https://habr.com/ru/all/"]');
       if (!row) return "no-row";
       row.querySelector('.act-star').click();
       return "clicked";
     })()`);
    const habrMarked = await waitFor(async () => {
      const marks = await evalIn(uiWs, `window.__duopulse.history.bookmarkList({ query: null, offset: 0, limit: 500 })`);
      return marks?.bookmarks?.some((b) => b.url === "https://habr.com/ru/all/") === true ? true : null;
    }, 8000);
    check("★ на странице добавляет закладку", starClicked === "clicked" && habrMarked === true, starClicked);

    const delClicked = await evalIn(mgrWs, `(async () => {
       const row = document.querySelector('.mgr-entry[data-url="https://habr.com/ru/all/"]');
       if (!row) return "no-row";
       row.querySelector('.act-del').click();
       return "clicked";
     })()`);
    const habrGone = await waitFor(async () => {
      const res = await evalIn(uiWs, `window.__duopulse.history.search({ query: "habr" })`);
      return res?.hits?.some((x) => x.source === "history") === false ? true : null;
    }, 8000);
    check("✕ на странице удаляет запись истории", delClicked === "clicked" && habrGone === true, delClicked);

    // секция «Закладки»: ждём именно закладочную строку habr (после удаления
    // из истории DOM мог ещё показывать старые строки истории)
    await evalIn(mgrWs, `document.querySelector('.mgr-tab[data-sec="bookmarks"]').click()`);
    const bookSection = await waitFor(async () => {
      const ok = await evalIn(
        mgrWs,
        `document.querySelector('.mgr-tab[data-sec="bookmarks"]')?.classList.contains('active')
           && document.querySelector('.mgr-entry[data-url="https://habr.com/ru/all/"] .act-edit')
         ? "ready" : ""`,
      );
      return ok === "ready" ? ok : null;
    }, 10000);
    const editDone = await evalIn(mgrWs, `(() => {
       const row = document.querySelector('.mgr-entry[data-url="https://habr.com/ru/all/"]');
       if (!row) return "no-row";
       row.querySelector('.act-edit').click();
       const input = row.querySelector('.entry-edit');
       if (!input) return "no-input";
       input.value = "Хабр — лучшее";
       input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
       return "saved";
     })()`);
    const renamed = await waitFor(async () => {
      const marks = await evalIn(uiWs, `window.__duopulse.history.bookmarkList({ query: null, offset: 0, limit: 500 })`);
      return marks?.bookmarks?.find((b) => b.url === "https://habr.com/ru/all/")?.title === "Хабр — лучшее"
        ? true
        : null;
    }, 8000);
    check("правка заголовка закладки со страницы (bookmarkUpdate)", editDone === "saved" && renamed === true, editDone);

    // скриншот страницы управления (сверка с гайдом 06)
    const mgrShot = await mgrWs.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(import.meta.dirname, "manager.png"), Buffer.from(mgrShot.data, "base64"));
    mgrWs.close();
  }

  uiWs.close();
} catch (e) {
  failures++;
  console.error("E2E ERROR:", e.message);
} finally {
  app.kill("SIGKILL");
  await killOurExes();
  // vite.kill() на Windows убивает только npm-оболочку — дерево npm→node
  // переживает скрипт и держит порт 5173 (strictPort) для следующих прогонов
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
if (uiConsole.length) console.log(`\nконсоль UI:\n  ${uiConsole.join("\n  ")}`);
console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES: " + failed} (${results.length} проверок)`);
process.exit(failed === 0 ? 0 : 1);
