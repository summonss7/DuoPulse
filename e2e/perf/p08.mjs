// Замер метрики P-08 (задача 2.5/gate M2, docs/04 §2): «Время до первого
// кадра видео (повторный просмотр) ≤ контрольного браузера (не хуже)».
// Повторный просмотр = тёплый кэш профиля (2 прогрев-просмотра), затем
// 3 замеренных запуска на прогон, медиана; отсчёт — запуск процесса →
// первый кадр КОНТЕНТА (currentTime > 0.5, не пауза, не реклама; реклама
// детектируется и репортится: в DuoPulse её нет — скриптлеты, в контроле
// без блокировщика преролл ждём честно, он входит в число контроля).
//
// Контроль (решение автора 21.10.2026 03:48, duopulse_047_control_20261021):
// DuoPulse с ВЫКЛЮЧЕННЫМ блокировщиком — тот же движок WebView2 и та же
// машина, разница только в блокировщике; независимость движка теряется
// (зафиксировано в docs/04 §2). Исходный контроль «Chrome+uBO» и консервативная
// замена «чистый Chrome» отпали: с 21.10.2026 YouTube-сервер не attachит поток
// свежим Chrome/Edge-профилям (playerState 3, readyState 0 при playability OK —
// расследование CARDS/047). Смысл сравнения: блокировщик не должен ухудшать
// старт видео относительно «как без нас» (убранный преролл — часть выигрыша).
// Блокировщик выключается settings.json {"adblock":{"enabled":false}} в профиле
// контроля ДО первого запуска (ключ читается на старте, adblock/mod.rs).
// Устойчивость (duopulse-052, 24.10.2026): транзитный сетевой сбой на пути
// через SOCKS5-роутер (резолв 11001 и пр.) роняет перезагрузку страницы
// (themeRefresh/пассивный логин Google) → приложение показывает свою страницу
// ошибки (карточка 048) → youtube-цели в CDP нет, кадра не будет никогда.
// Это инфра-сбой запуска, а не «медленное видео»: прогон перезапускается
// (до INVALID_RETRIES на прогон, каждый повтор логируется). Проверка перед
// стартом: exe в dev-режиме (cargo build --release без tauri-CLI грузит UI с
// vite — ловушка e2e/perf/run.mjs) — стенд отказывается работать: внутренние
// страницы (newtab/страница ошибки) мертвы, числа не сравнимы с релизом.
// Запуск:  node e2e/perf/p08.mjs [url-видео]
// Требует release-сборку DuoPulse (npx tauri build).
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const DUO_EXE = path.join(ROOT, "src-tauri", "target", "release", "duopulse.exe");
const VIDEO = process.argv[2] || "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const RUNS = 3;
const WARMUPS = 2;
// Перезапусков «неправильного» прогона (сетевой сбой — страница не загрузилась)
const INVALID_RETRIES = 3;
const DUO_CDP = 9232;
const CTL_CDP = 9233;

if (!fs.existsSync(DUO_EXE)) {
  console.error(`FAIL  не найден exe: ${DUO_EXE} (нужна release-сборка)`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))),
  );
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

setTimeout(() => {
  console.error("СТЕНД: глобальный таймаут 15 мин — принудительное завершение");
  process.exit(2);
}, 15 * 60_000).unref?.();

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
  // Таймаут на каждый вызов (как e2e/vpn, карточка 048): у цели, умершей
  // вместе со страницей (SSAI-навигации/капча YouTube), WebSocket.send молча
  // виснет — без таймаута стенд стоит до глобальных 15 мин вместо внятного
  // отказа прогона (наблюдалось 24.10.2026 на контрольной стороне, duopulse-052).
  const CDP_CALL_TIMEOUT_MS = 20000;
  const send = (method, params = {}) =>
    open.then(
      () =>
        new Promise((res, rej) => {
          const i = ++id;
          const timer = setTimeout(() => {
            pending.delete(i);
            rej(new Error(`CDP ${method}: нет ответа ${CDP_CALL_TIMEOUT_MS} мс`));
          }, CDP_CALL_TIMEOUT_MS);
          pending.set(i, {
            res: (v) => { clearTimeout(timer); res(v); },
            rej: (e) => { clearTimeout(timer); rej(e); },
          });
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

/** Первый кадр контента в youtube-цели браузера на порту cdpPort.
 *  Возвращает { ms, adSeen } от t0 или null, пока не дождались. */
async function waitFirstFrame(cdpPort, t0, timeoutMs) {
  const deadline = t0 + timeoutMs;
  let ws = null;
  let adSeen = false;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://localhost:${cdpPort}/json`)).json();
      const yt = targets.find((x) => x.type === "page" && /youtube\.com\/watch/.test(x.url));
      if (yt && !ws) ws = connect(yt.webSocketDebuggerUrl);
      if (ws) {
        const st = await evalIn(
          ws,
          `(function () {
            const ad = !!document.querySelector('.ad-showing, .ytp-ad-player-overlay, .ytp-ad-image-overlay');
            if (ad) window.__p08ad = true;
            const v = document.querySelector('video');
            if (!v) return { novideo: true };
            if (v.paused) { v.muted = true; v.play().catch(() => {}); }
            return { ad: window.__p08ad === true, frame: v.currentTime > 0.5 && !v.paused };
          })()`,
        ).catch(() => {
          // цель умерла (страница пересоздана) — переподключимся на следующем витке,
          // иначе мёртвый ws держит опрос до конца дедлайна прогона
          ws?.close();
          ws = null;
          return null;
        });
        if (st && !st.novideo) {
          if (st.ad) adSeen = true;
          if (st.frame) {
            ws.close();
            return { ms: Date.now() - t0, adSeen };
          }
        }
      }
    } catch {
      /* браузер ещё поднимается */
    }
    await sleep(120);
  }
  ws?.close();
  return null;
}

async function killTree(pid) {
  try {
    await run("taskkill", ["/PID", String(pid), "/T", "/F"]);
  } catch {}
}

/** Жива ли youtube-цель: вкладка не ушла со страницы видео (сетевой сбой
 *  уводит её на страницу ошибки 048 — цель с watch-URL исчезает из /json). */
async function youtubeTargetAlive(cdpPort) {
  try {
    const targets = await (await fetch(`http://localhost:${cdpPort}/json`)).json();
    return targets.some((x) => x.type === "page" && /youtube\.com\/watch/.test(x.url));
  } catch {
    return false;
  }
}

/** Префлайт: exe в dev-режиме (cargo build --release без tauri-CLI) грузит UI
 *  и внутренние страницы с vite localhost:5173 — без сервера они мертвы,
 *  числа прогона не сравнимы с релизом (ловушка e2e/perf/run.mjs). Отказ
 *  до старта замеров, пока не потрачены загрузки YouTube. */
async function ensureReleaseBuild() {
  const PREFLIGHT_PORT = 9234;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-p08-pre-"));
  const app = spawn(DUO_EXE, [], {
    stdio: "ignore",
    env: {
      ...process.env,
      APPDATA: profile,
      DUOPULSE_START_URL: "about:blank",
      DUOPULSE_CDP_PORT: String(PREFLIGHT_PORT),
      WEBVIEW2_USER_DATA_FOLDER: path.join(profile, "webview2-data"),
    },
  });
  try {
    const deadline = Date.now() + 30_000;
    for (;;) {
      let targets = null;
      try {
        targets = await (await fetch(`http://localhost:${PREFLIGHT_PORT}/json`)).json();
      } catch {}
      const pages = (targets ?? []).filter(
        (t) => t.type === "page" && t.url && t.url !== "about:blank",
      );
      if (pages.length > 0) {
        if (pages.some((t) => /^http:\/\/(localhost|127\.0\.0\.1):5173\//.test(t.url))) {
          console.error("FAIL  exe в dev-режиме (UI грузится с localhost:5173 — cargo build --release без tauri-CLI):");
          console.error("      соберите npx tauri build — ловушка описана в e2e/perf/run.mjs");
          process.exit(1);
        }
        return;
      }
      if (Date.now() > deadline) {
        console.error("FAIL  префлайт: CDP не поднялся за 30 с");
        process.exit(1);
      }
      await sleep(300);
    }
  } finally {
    await killTree(app.pid);
    await sleep(500);
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {}
  }
}

// --- DuoPulse (релизная сборка, тёплый профиль) ------------------------------
const duoProfile = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-p08-duo-"));
// --- контроль: DuoPulse с выключенным блокировщиком (тёплый профиль) ---------
const ctlProfile = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-p08-ctl-"));
// settings.json контроля: ключ читается на старте Core, до подъёма движка
fs.mkdirSync(path.join(ctlProfile, "DuoPulse", "profile"), { recursive: true });
fs.writeFileSync(
  path.join(ctlProfile, "DuoPulse", "profile", "settings.json"),
  JSON.stringify({ adblock: { enabled: false } }),
);
const launchAt = (profile, port) => () =>
  spawn(DUO_EXE, [], {
    stdio: "ignore",
    env: {
      ...process.env,
      APPDATA: profile,
      DUOPULSE_START_URL: VIDEO,
      WEBVIEW2_USER_DATA_FOLDER: path.join(profile, "webview2-data"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
  });
const launchDuo = launchAt(duoProfile, DUO_CDP);
const launchCtl = launchAt(ctlProfile, CTL_CDP);

/** Дождаться смерти процессов WebView2 профиля DuoPulse: осиротевший браузер
 *  держит user-data-folder и порт CDP — следующий прогон получит зомби-цели
 *  (как e2e/perf/run.mjs waitWebViewDown). */
async function waitWebViewDown(prof) {
  const marker = path.join(prof, "webview2-data");
  const psCount =
    `(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" ` +
    `| Where-Object { $_.CommandLine -like '*${marker}*' }).Count`;
  const psKill =
    `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" ` +
    `| Where-Object { $_.CommandLine -like '*${marker}*' } ` +
    `| ForEach-Object { taskkill /PID $_.ProcessId /T /F }`;
  const t0 = Date.now();
  for (;;) {
    let count = -1;
    try {
      count = Number((await run("powershell", ["-NoProfile", "-Command", psCount])).trim());
    } catch {
      count = 0;
    }
    if (count <= 0) return;
    if (Date.now() - t0 > 5000) {
      try {
        await run("powershell", ["-NoProfile", "-Command", psKill]);
      } catch {}
      await sleep(1000);
      return;
    }
    await sleep(400);
  }
}

/** Прогрев+замеры одного прогона: launch → ждём кадр → kill; возвращает
 *  массив { ms, adSeen } замеренных прогонов. settle — ждать полной смерти
 *  процессов профиля (DuoPulse/WebView2), чтобы порт и папка освободились.
 *  Прогон без кадра, где страница потеряна (сетевой сбой → страница ошибки
 *  048 — youtube-цели нет), — инфра-сбой: перезапуск до INVALID_RETRIES.
 *  Цель на месте, а кадра нет — честный провал метрики, не маскируем. */
async function measureBrowser(name, launch, cdpPort, settle) {
  const out = [];
  const total = WARMUPS + RUNS;
  for (let i = 0; i < total; i++) {
    const label = i < WARMUPS ? `прогрев ${i + 1}` : `прогон ${i - WARMUPS + 1}`;
    for (let attempt = 1; ; attempt++) {
      const app = launch();
      const t0 = Date.now();
      const r = await waitFirstFrame(cdpPort, t0, 120_000);
      // до killTree — CDP-порт ещё жив, можно спросить про цель
      const pageAlive = r ? true : await youtubeTargetAlive(cdpPort);
      await sleep(i < WARMUPS ? 8000 : 2500); // прогрев досматривает ролик (кэш/кап рекламы)
      await killTree(app.pid);
      if (settle) await settle();
      await sleep(1200);
      if (r) {
        if (i >= WARMUPS) out.push(r);
        console.log(`  ${name} ${label}: ${r.ms} мс${r.adSeen ? " (видна реклама)" : ""}`);
        break;
      }
      if (pageAlive || attempt > INVALID_RETRIES) {
        throw new Error(`${name}: первый кадр не дождан в ${label}`);
      }
      console.log(`  ${name} ${label}: инфра-сбой (страница не загрузилась) — перезапуск ${attempt}`);
    }
  }
  return out;
}

let failures = 0;
let duoMedian = NaN;
let ctlMedian = NaN;
try {
  await ensureReleaseBuild();
  console.log("DuoPulse (блокировщик включён):");
  const duo = await measureBrowser("DuoPulse", launchDuo, DUO_CDP, () => waitWebViewDown(duoProfile));
  console.log("Контроль — DuoPulse (блокировщик выключен, решение 21.10.2026 duopulse_047_control):");
  const ctl = await measureBrowser("контроль", launchCtl, CTL_CDP, () => waitWebViewDown(ctlProfile));
  duoMedian = median(duo.map((r) => r.ms));
  ctlMedian = median(ctl.map((r) => r.ms));
  const ok = duoMedian <= ctlMedian;
  console.log(
    `\nP-08: DuoPulse медиана ${duoMedian} мс vs контроль без блокировщика ${ctlMedian} мс — ${ok ? "НЕ ХУЖЕ" : "хуже"} (docs/04 §2: контроль с 21.10.2026 — DuoPulse без блокировщика)`,
  );
  console.log(`      прогоны: DuoPulse=${JSON.stringify(duo.map((r) => r.ms))} контроль=${JSON.stringify(ctl.map((r) => r.ms))}`);
  console.log(`      реклама: DuoPulse=${JSON.stringify(duo.map((r) => r.adSeen))} контроль=${JSON.stringify(ctl.map((r) => r.adSeen))}`);
  if (!ok) failures++;
} catch (e) {
  failures++;
  console.error("E2E ERROR:", e.message);
} finally {
  // контроль шёл с выключенным блокировщиком по settings.json — убедимся,
  // что приложение не перезаписало ключ (санити подложенного конфига)
  try {
    const s = JSON.parse(fs.readFileSync(path.join(ctlProfile, "DuoPulse", "profile", "settings.json"), "utf8"));
    if (s?.adblock?.enabled !== false) {
      failures++;
      console.error(`FAIL  контроль: settings.json не держит adblock.enabled=false (${JSON.stringify(s?.adblock)})`);
    }
  } catch {}
  try {
    fs.rmSync(duoProfile, { recursive: true, force: true });
  } catch {}
  try {
    fs.rmSync(ctlProfile, { recursive: true, force: true });
  } catch {}
  await sleep(1000);
}

console.log(`\n${failures === 0 ? "ALL PASS" : "FAILURES: " + failures}`);
process.exit(failures === 0 ? 0 : 1);
