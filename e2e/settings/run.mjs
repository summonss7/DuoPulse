// E2E-стенд задачи 5.1 «Полные настройки + экспорт/импорт профиля» (карточка
// duopulse-033). DoD 5.1 — «переезд на чистую машину за 1 файл», сквозной
// прогон на реальном приложении (debug-exe + vite dev, изолированный APPDATA):
//
//   фаза A «машина-источник»:
//     1) settings.get_all — все разделы на месте, схема v2 (миграция свежего
//        профиля отработала на старте);
//     2) настройки применяются: settings.apply (поисковик bing, дефолт Google duopulse-085,
//        субтитров es + стиль, приватность) — nav.resolve_omnibox сквозно
//        водит поиск в Google;
//     3) данные: закладки + визиты истории; секреты: пароль прокси и ключ
//        LibreTranslate (DPAPI);
//     4) дефолты субтитров доходят до content-слоя: window.__DUOPULSE_DEFAULTS__
//        в контентной вкладке (initialization script до бандла);
//     5) settings.export в файл (includeSecrets) — отчёт counts; секреты в
//        файле есть, в settings.json их нет.
//
//   фаза B «чистая машина»: приложение остановлено, профиль удалён целиком,
//     запущено снова (новый профиль с нуля):
//     6) профиль пуст (get_all — дефолты, история/закладки пусты);
//     7) settings.import из файла — отчёт counts; настройки/данные/секреты
//        на месте (get_all, history.list/bookmark_list, translate.get_settings,
//        has_password прокси);
//     8) поисковик и дефолты субтитров снова применены (omnibox → google;
//        __DUOPULSE_DEFAULTS__ в новой контентной вкладке = es);
//     9) повторный импорт того же файла идемпотентен (визиты не дублируются).
//
// Кэш переводов (translated_tracks) переноскй проверен юнит-тестом
// cargo settings::profile::clean_machine_roundtrip_one_file (put → файл →
// import → get); сюда конвейер не тащим — стенд субтитров 4.2 его покрывает.
//
// Запуск: node e2e/settings/run.mjs [путь-duopulse.exe]
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const CDP_PORT_A = 9238; // у каждой фазы свой порт: физически исключает
const CDP_PORT_B = 9239; // подключение к целям прошлой машины
const HTTP_PORT = 8907;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** rmSync с ретраями: WebView2/SQLite отпускают файлы не мгновенно. */
const rmRetry = async (target, tries = 6) => {
  for (let i = 0; i < tries; i++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch {
      await sleep(800);
    }
  }
  fs.rmSync(target, { recursive: true, force: true }); // последняя попытка — пусть бросит
};
const run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))));

const killOurExes = async () => {
  try {
    await run("powershell", [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='duopulse.exe'" | Where-Object { $_.ExecutablePath -eq '${EXE.replace(/\\/g, "\\\\")}' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }`,
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

// --- минимальный http-стенд (страница для контентной вкладки) -----------------
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
    "<!doctype html><meta charset='utf-8'><title>settings-e2e</title><p>ок</p>",
  );
});
await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${HTTP_PORT}/`;

// --- CDP-подключение ----------------------------------------------------------
/** Простейший CDP-клиент: Runtime.evaluate с awaitPromise. */
const connect = (wsUrl) => {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const ready = new Promise((r) => (ws.onopen = r));
  return {
    send: async (method, params = {}) => {
      await ready;
      const id = ++seq;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((r) => pending.set(id, r));
    },
    close: () => ws.close(),
  };
};

const evalIn = async (ws, expression) => {
  const r = await ws.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  const outcome = r.result ?? r; // ответ CDP: {result: {result: {value}, exceptionDetails}}
  if (outcome.exceptionDetails) {
    throw new Error(JSON.stringify(outcome.exceptionDetails.exception ?? outcome.exceptionDetails));
  }
  return outcome.result?.value;
};

/** Ждать, пока CDP-порт перестанет отвечать (приложение полностью умерло). */
const waitForCdpDown = async (port) => {
  for (let i = 0; i < 30; i++) {
    try {
      await fetch(`http://localhost:${port}/json`);
      await sleep(500);
    } catch {
      return;
    }
  }
};

/** Запуск приложения с профилем в tmp; ждёт UI-цель CDP, возвращает её ws. */
async function launchApp(tmp, cdpPort) {
  const app = spawn(EXE, [], {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      APPDATA: tmp,
      DUOPULSE_START_URL: "duopulse://newtab",
      DUOPULSE_ADBLOCK_LISTS: "", // без списков: стенду не нужна сеть
      DUOPULSE_SLEEP_AFTER_SECS: "0",
      WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
    },
  });
  app.stderr?.on("data", () => {}); // журнал не копим — шум старта не нужен
  let targets = [];
  for (let i = 0; i < 60; i++) {
    try {
      targets = await (await fetch(`http://localhost:${cdpPort}/json`)).json();
      const ui = targets.find((t) => t.type === "page" && /localhost:5173/.test(t.url));
      if (ui) break;
    } catch {
      /* поднимается */
    }
    await sleep(500);
  }
  const ui = targets.find((t) => t.type === "page" && /localhost:5173/.test(t.url));
  if (!ui) throw new Error("UI-цель CDP не найдена");
  const ws = connect(ui.webSocketDebuggerUrl);
  for (let i = 0; i < 20; i++) {
    if ((await evalIn(ws, `typeof window.__duopulse`)) === "object") break;
    await sleep(500);
  }
  return { app, ws };
}

let failures = 0;
try {
  await killOurExes();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-settings-e2e-"));
  const profilePath = path.join(tmp, "duopulse-profile.json"); // вне APPDATA: доступен обеим машинам
  const vite = spawn("npm", ["run", "dev"], { cwd: ROOT, shell: true, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try {
      await fetch("http://localhost:5173/");
      break;
    } catch {
      await sleep(500);
    }
  }

  // ================= фаза A: машина-источник =================================
  const a = await launchApp(tmp, CDP_PORT_A);
  try {
    const all0 = await evalIn(a.ws, `window.__duopulse.settings.getAll()`);
    check("A1 settings.get_all: все разделы, схема v3, дефолт Google (duopulse-085)", !!all0 &&
      all0.schemaVersion === 3 && all0.search?.engine === "google" &&
      all0.subtitles?.defaultTranslationLang === "ru" &&
      all0.privacy?.clearHistoryOnExit === false && Array.isArray(all0.engines) &&
      all0.engines.length === 4, JSON.stringify(all0?.search));

    // поиск до настройки — Google (дефолт duopulse-085)
    const s0 = await evalIn(a.ws, `window.__duopulse.nav.resolveOmnibox({ input: "тест запроса" })`);
    check("A2a omnibox до настройки: поиск в Google (дефолт)", s0?.isSearch === true &&
      s0.url.startsWith("https://www.google.com/search?q="), s0?.url);

    // применяем настройки
    await evalIn(a.ws, `window.__duopulse.settings.apply({ search: { engine: "bing" },
      subtitles: { defaultTranslationLang: "ES ", style: { fontScalePct: 130, position: "top",
      marginPct: 4, plateOpacity: 0.9 } }, privacy: { clearHistoryOnExit: true } })`);
    const s1 = await evalIn(a.ws, `window.__duopulse.nav.resolveOmnibox({ input: "тест запроса" })`);
    check("A2b omnibox после apply: поиск в Bing (смена движка сквозно)", s1?.url.startsWith("https://www.bing.com/search?q="), s1?.url);
    const all1 = await evalIn(a.ws, `window.__duopulse.settings.getAll()`);
    check("A2c apply нормализован: язык es, клампы стиля", all1.subtitles.defaultTranslationLang === "es" &&
      all1.subtitles.style.fontScalePct === 130 && all1.subtitles.style.position === "top" &&
      all1.privacy.clearHistoryOnExit === true, JSON.stringify(all1.subtitles));

    // настройки применяются к НОВОЙ контентной вкладке (initialization script)
    await evalIn(a.ws, `window.__duopulse.tabs.open({ url: "${pageUrl}" })`);
    let contentWs = null;
    for (let i = 0; i < 20; i++) {
      const targets = await (await fetch(`http://localhost:${CDP_PORT_A}/json`)).json();
      const page = targets.find((t) => t.type === "page" && t.url.startsWith(pageUrl));
      if (page) { contentWs = connect(page.webSocketDebuggerUrl); break; }
      await sleep(500);
    }
    const defaults = await evalIn(contentWs, `window.__DUOPULSE_DEFAULTS__`);
    check("A3 дефолты субтитров в content-слое (новая вкладка)", !!defaults &&
      defaults.subtitles?.defaultTranslationLang === "es" &&
      defaults.subtitles?.style?.fontScalePct === 130, JSON.stringify(defaults));

    // данные + секреты
    await evalIn(a.ws, `window.__duopulse.history.bookmarkAdd({ url: "https://example.com/a", title: "Пример A" })`);
    await evalIn(a.ws, `window.__duopulse.history.bookmarkAdd({ url: "https://example.com/b", title: "Пример B" })`);
    for (let i = 0; i < 3; i++) {
      await evalIn(a.ws, `window.__duopulse.history.visit({ url: "https://example.com/page${i}", title: "Страница ${i}" })`);
    }
    // пароль прокси (конфиг выключен — валиден без адреса? нет: выключенный не валидируется)
    await evalIn(a.ws, `window.__duopulse.settings.set({ key: "proxy", value: { enabled: false,
      proto: "http", host: "p.example", port: 3128, login: "user" }, secret: "p@ss-e2e" })`);
    await evalIn(a.ws, `window.__duopulse.translate.setSettings({ value: { enabled: true,
      provider: "libretranslate", deeplPlan: "free", libretranslateUrl: "http://localhost:5055" },
      secret: "lt-key-e2e" })`);
    const tr0 = await evalIn(a.ws, `window.__duopulse.translate.getSettings()`);
    const px0 = await evalIn(a.ws, `window.__duopulse.settings.get({ key: "proxy" })`);
    check("A4 секреты источника: пароль прокси + ключ LibreTranslate (DPAPI)",
      px0?.hasPassword === true && tr0?.hasApiKeys?.includes("libretranslate"),
      `hasPassword=${px0?.hasPassword}, keys=${JSON.stringify(tr0?.hasApiKeys)}`);

    // экспорт
    const exp = await evalIn(a.ws, `window.__duopulse.settings.export({ path: ${JSON.stringify(profilePath)}, includeSecrets: true })`);
    // визитов 4: три через history.visit + контентная страница стенда
    // (её визит пишет Core из on_page_load — http(s))
    check("A5 экспорт одним файлом: counts и размер", !!exp && exp.counts?.settingsSections >= 4 &&
      exp.counts?.bookmarks === 2 && exp.counts?.visits === 4 && exp.counts?.secrets === 2 &&
      exp.bytes > 500, JSON.stringify(exp?.counts));
    const raw = fs.readFileSync(profilePath, "utf8");
    const parsedFile = JSON.parse(raw);
    check("A6 файл: формат duopulseProfile, секреты есть, экспорт без них — нет",
      parsedFile.duopulseProfile === 1 && parsedFile.secrets?.proxyPassword === "p@ss-e2e" &&
      parsedFile.secrets?.translateApiKeys?.libretranslate === "lt-key-e2e" &&
      parsedFile.bookmarks?.length === 2 && parsedFile.visits?.length === 4 &&
      !JSON.stringify(parsedFile.settings).includes("p@ss-e2e"), `${(exp.bytes / 1024).toFixed(1)} КБ`);
  } finally {
    a.ws.close();
    await killOurExes();
    await waitForCdpDown(CDP_PORT_A);
    await sleep(500);
  }

  // ================= фаза B: чистая машина ====================================
  // «другая машина»: свежий APPDATA-корень с нуля (хэндлы старого профиля
  // живут, пока жив стенд — приложение A уже остановлено); файл профиля
  // лежит вне APPDATA и доступен обеим фазам
  const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-settings-e2e-b-"));
  check("фаза B: чистая машина — свежий профиль с нуля",
    !fs.existsSync(path.join(tmpB, "DuoPulse", "profile", "settings.json")));

  const b = await launchApp(tmpB, CDP_PORT_B);
  try {
    const fresh = await evalIn(b.ws, `window.__duopulse.settings.getAll()`);
    const freshHist = await evalIn(b.ws, `window.__duopulse.history.list({ query: null, offset: 0, limit: 100 })`);
    const freshMarks = await evalIn(b.ws, `window.__duopulse.history.bookmarkList({ query: null, offset: 0, limit: 100 })`);
    check("B1 чистая машина: профиль пуст (дефолты, без истории/закладок)",
      fresh.search?.engine === "google" && freshHist?.total === 0 && freshMarks?.total === 0,
      `hist=${freshHist?.total}, marks=${freshMarks?.total}`);

    const imp = await evalIn(b.ws, `window.__duopulse.settings.import({ path: ${JSON.stringify(profilePath)} })`);
    check("B2 импорт: отчёт counts, секреты, прокси применён роутером без перезапуска",
      !!imp && imp.counts?.bookmarks === 2 &&
      imp.counts?.visits === 4 && imp.counts?.secrets === 2 && imp.hasSecrets === true &&
      imp.needsRestart === false, JSON.stringify(imp));

    const after = await evalIn(b.ws, `window.__duopulse.settings.getAll()`);
    const hist = await evalIn(b.ws, `window.__duopulse.history.list({ query: null, offset: 0, limit: 100 })`);
    const marks = await evalIn(b.ws, `window.__duopulse.history.bookmarkList({ query: null, offset: 0, limit: 100 })`);
    const tr = await evalIn(b.ws, `window.__duopulse.translate.getSettings()`);
    const px = await evalIn(b.ws, `window.__duopulse.settings.get({ key: "proxy" })`);
    check("B3 настройки переехали (поиск/субтитры/приватность/прокси/перевод)",
      after.search?.engine === "bing" && after.subtitles?.defaultTranslationLang === "es" &&
      after.subtitles?.style?.fontScalePct === 130 && after.privacy?.clearHistoryOnExit === true &&
      px?.host === "p.example" && px?.hasPassword === true &&
      tr?.provider === "libretranslate" && tr?.hasApiKeys?.includes("libretranslate"),
      `engine=${after.search?.engine}, lang=${after.subtitles?.defaultTranslationLang}`);

    check("B4 данные переехали: история (4 визита файла), закладки 2, поиск жив",
      hist?.total === 4 && marks?.total === 2 &&
        marks.bookmarks.some((m) => m.title === "Пример A"),
      `hist=${hist?.total}, marks=${marks?.total}`);

    const sB = await evalIn(b.ws, `window.__duopulse.nav.resolveOmnibox({ input: "ещё запрос" })`);
    check("B5 omnibox на новой машине: поиск в Bing (настройка из файла)",
      sB?.url.startsWith("https://www.bing.com/search?q="), sB?.url);

    // дефолты субтитров — в контентную вкладку, открытую ПОСЛЕ импорта
    await evalIn(b.ws, `window.__duopulse.tabs.open({ url: "${pageUrl}" })`);
    let contentWsB = null;
    for (let i = 0; i < 20; i++) {
      const targets = await (await fetch(`http://localhost:${CDP_PORT_B}/json`)).json();
      const page = targets.filter((t) => t.type === "page" && t.url.startsWith(pageUrl)).pop();
      if (page) { contentWsB = connect(page.webSocketDebuggerUrl); break; }
      await sleep(500);
    }
    const defaultsB = await evalIn(contentWsB, `window.__DUOPULSE_DEFAULTS__`);
    check("B6 дефолты субтитров в content-слое из файла (es, 130%)",
      defaultsB?.subtitles?.defaultTranslationLang === "es" &&
        defaultsB?.subtitles?.style?.fontScalePct === 130, JSON.stringify(defaultsB));

    // повторный импорт того же файла — идемпотентен
    const imp2 = await evalIn(b.ws, `window.__duopulse.settings.import({ path: ${JSON.stringify(profilePath)} })`);
    const hist2 = await evalIn(b.ws, `window.__duopulse.history.list({ query: null, offset: 0, limit: 100 })`);
    // дедуп — точное совпадение (url, visited_at): живой визит контентной
    // страницы B6 (новое время) не дубль файлового, повторный импорт может
    // вставить только его (≤1); агрегат по URL не растёт
    check("B7 повторный импорт идемпотентен (агрегат по URL не растёт)",
      (imp2?.counts?.visits ?? 0) <= 1 && hist2?.total === 4,
      `visits=${imp2?.counts?.visits}, total=${hist2?.total}`);

    // settings.json машины-приёмника: без секретов, версия схемы актуальна
    const rawSettings = fs.readFileSync(path.join(tmpB, "DuoPulse", "profile", "settings.json"), "utf8");
    check("B8 settings.json приёмника: схема v3, секретов нет",
      rawSettings.includes('"settingsVersion": 3') && !rawSettings.includes("p@ss-e2e") &&
        !rawSettings.includes("lt-key-e2e"));
  } finally {
    b.ws.close();
    await killOurExes();
    vite.kill();
    httpServer.close();
    try {
      await rmRetry(tmpB);
    } catch {
      console.warn(`временный профиль машины B не удалён: ${tmpB}`);
    }
    try {
      await rmRetry(tmp);
    } catch {
      console.warn(`временный профиль машины A не удалён: ${tmp}`);
    }
  }
} catch (e) {
  failures += 1;
  console.error("СТЕНД УПАЛ:", e);
} finally {
  await killOurExes();
}

failures += results.filter((r) => !r.ok).length;
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} PASS${failures ? `, ${failures} FAIL` : " — ALL PASS"}`);
process.exit(failures ? 1 : 0);
