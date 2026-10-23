// E2E-стенд задачи 5.2 «Установщик и автообновление» (карточка duopulse-034).
// DoD 5.2 — «установка на чистой Windows проходит» + «обновление канарейки
// на тестовой машине проходит». Машина — этот Windows; «чистая» = нет
// установленного DuoPulse (деинсталляция до старта) + изолированный APPDATA
// (свежий профиль с нуля).
//
//   фаза A «чистая установка» (релизный пакет 0.1.0 из builds/duopulse_0.1.0_release):
//     1) деинсталляция прежнего DuoPulse (если был) — чистая машина;
//     2) тихая установка setup.exe /S (PowerShell Start-Process: в Git Bash
//        «/S» превращается в путь);
//     3) каталог установки + запись Uninstall в реестре HKCU + ярлыки
//        (рабочий стол и «Пуск») на месте;
//     4) запуск установленного приложения: UI отвечает, контракт v11,
//        updater.status — версия 0.1.0, канал stable, источник github,
//        автопроверка вкл.
//
//   фаза B «обновление канарейки» (пакет 0.1.1 — синтетический, та же подпись):
//     5) сборка 0.1.1 (tauri build --config с override версии) — подписанный;
//     6) локальный фид: /canary/... → latest.json (0.1.1, подпись) + пакет;
//     7) профиль машины: канал canary, автопроверка выкл (триггер — руками);
//     8) установленное 0.1.0 (DUOPULSE_UPDATE_BASE → локальный фид):
//        updater.check нашёл 0.1.1 → updater.install → приложение завершено,
//        установщик перезапустил приложение;
//     9) новое приложение: версия 0.1.1, профиль выжил (канал canary на месте),
//        реестр показывает 0.1.1.
//
//   фаза B+ «источник Aila» (duopulse-049): локальный фид в форме зеркала
//   (latest-canary.json), профиль source=aila → updater.check обращается по
//   адресу зеркала и отвечает «у вас последняя версия» (0.1.1 = 0.1.1,
//   source=aila в результате — «кто ответил» видно).
//
//   фаза C «деинсталляция»: uninstall /S сносит каталог и запись реестра.
//
// Запуск: node e2e/update/run.mjs [--skip-build]  (по умолчанию собирает 0.1.1)
import { execFile, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SKIP_BUILD = process.argv.includes("--skip-build");
const CDP_PORT = 9242;
const FEED_PORT = 8898;
const OLD_VER = "0.1.0";
const NEW_VER = "0.1.1";
const OLD_DIR = path.join(ROOT, "builds", `duopulse_${OLD_VER}_release`);
const NEW_TMP = path.join(os.tmpdir(), `duopulse-update-${NEW_VER}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, opts, (err, stdout, stderr) =>
      err ? reject(new Error(`${cmd}: ${stderr || stdout || err.message}`)) : resolve(String(stdout)),
    ),
  );
const ps = (script) => run("powershell", ["-NoProfile", "-Command", script]);
const rmRetry = async (target, tries = 6) => {
  for (let i = 0; i < 6; i++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch {
      await sleep(800);
    }
  }
  fs.rmSync(target, { recursive: true, force: true });
};

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

// --- установленный DuoPulse: реестр HKCU Uninstall ---------------------------

/** Запись Uninstall установленного DuoPulse (CurrentUser-инсталляция). */
const uninstallEntry = async () => {
  const raw = await ps(
    `Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' ` +
      `| Where-Object { $_.DisplayName -eq 'DuoPulse' } ` +
      `| Select-Object DisplayName, DisplayVersion, InstallLocation, UninstallString ` +
      `| ConvertTo-Json -Compress`,
  );
  const out = raw.trim();
  return out ? JSON.parse(out) : null;
};
const installedExe = async () => {
  const entry = await uninstallEntry();
  // InstallLocation NSIS пишет в кавычках — снимаем
  const dir = entry?.InstallLocation?.replace(/"/g, "");
  return dir ? path.join(dir, "duopulse.exe") : null;
};
/** Тихий запуск установщика/деинсталлятора: прямой spawn без шелла —
 *  execFile не мутирует «/S» (это делает только Git Bash), а ожидание идёт
 *  по хэндлу процесса. Start-Process -Wait -PassThru гоняется с быстрым
 *  стартом NSIS («Process must exit before…» на ExitCode). */
const runInstaller = (exe, args) =>
  new Promise((resolve) => {
    const child = execFile(exe, [args]);
    child.on("error", () => resolve("spawn-error"));
    child.on("close", (code) => resolve(String(code)));
  });

// --- CDP ----------------------------------------------------------------------

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
  const outcome = r.result ?? r;
  if (outcome.exceptionDetails) {
    throw new Error(JSON.stringify(outcome.exceptionDetails.exception ?? outcome.exceptionDetails));
  }
  return outcome.result?.value;
};
/** UI-цель CDP приложения (бандл: tauri:// или http://tauri.localhost). */
const uiTarget = async (port) => {
  for (let i = 0; i < 90; i++) {
    try {
      const targets = await (await fetch(`http://localhost:${port}/json`)).json();
      const ui = targets.find(
        (t) => t.type === "page" && /tauri\.localhost|duopulse|index\.html/.test(t.url) && !t.url.startsWith("http://127.0.0.1"),
      );
      if (ui) return ui;
    } catch {
      /* поднимается */
    }
    await sleep(500);
  }
  throw new Error("UI-цель CDP не найдена");
};
const waitForCdpDown = async (port) => {
  for (let i = 0; i < 90; i++) {
    try {
      await fetch(`http://localhost:${port}/json`);
      await sleep(500);
    } catch {
      return true;
    }
  }
  return false;
};
/** Ждать, пока условие не станет истинным (деинсталлятор NSIS завершается
 *  асинхронно — копия себя в %TEMP% дочищает файлы после выхода процесса). */
const waitFor = async (fn, tries = 20) => {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true;
    await sleep(500);
  }
  return false;
};

/** Запуск установленного приложения с изолированным профилем и фидом стенда. */
async function launchInstalled(exe, tmp, withFeed) {
  const app = spawn(exe, [], {
    stdio: ["ignore", "ignore", "ignore"],
    env: {
      ...process.env,
      APPDATA: tmp,
      DUOPULSE_START_URL: "duopulse://newtab",
      DUOPULSE_ADBLOCK_LISTS: "",
      DUOPULSE_SLEEP_AFTER_SECS: "0",
      WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
      ...(withFeed ? { DUOPULSE_UPDATE_BASE: `http://127.0.0.1:${FEED_PORT}` } : {}),
    },
  });
  const target = await uiTarget(CDP_PORT);
  const ws = connect(target.webSocketDebuggerUrl);
  for (let i = 0; i < 30; i++) {
    if ((await evalIn(ws, `typeof window.__duopulse`)) === "object") break;
    await sleep(500);
  }
  return { app, ws };
}

const killInstalled = async (exe) => {
  // в single-quoted PS-строке бэкслеш — обычный символ: удваивать нельзя,
  // иначе путь не совпадёт и taskkill никого не найдёт (B-фаза коннектилась
  // к живому A-приложению без env фида). Экранируем только кавычку.
  const safe = exe.replace(/'/g, "''");
  try {
    await ps(
      `Get-CimInstance Win32_Process -Filter "Name='duopulse.exe'" | Where-Object { $_.ExecutablePath -eq '${safe}' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }`,
    );
  } catch {
    /* уже мертвы */
  }
};

// --- локальный фид канарейки ---------------------------------------------------

const feed = { latestJson: "", package: Buffer.alloc(0) };
const feedServer = http.createServer((req, res) => {
  if (req.url.startsWith("/canary/") || req.url.startsWith("/latest-canary.json")) {
    // github-форма фида (<канал>/…) и aila-форма (latest-<канал>.json,
    // duopulse-049) отдают один манифест стенда
    res.writeHead(200, { "Content-Type": "application/json" }).end(feed.latestJson);
  } else if (req.url.includes(`_${NEW_VER}_x64-setup.exe`)) {
    res.writeHead(200, { "Content-Type": "application/octet-stream" }).end(feed.package);
  } else {
    res.writeHead(404).end("no such feed entry");
  }
});

let failures = 0;
try {
  // ===== подготовка: чистая машина + подписанный пакет 0.1.1 ==================
  const oldSetup = path.join(OLD_DIR, `DuoPulse_${OLD_VER}_x64-setup.exe`);
  if (!fs.existsSync(oldSetup)) {
    throw new Error(`нет релизного пакета ${oldSetup} — сначала npm run release (задача 5.2)`);
  }
  const oldSig = fs.readFileSync(path.join(OLD_DIR, `DuoPulse_${OLD_VER}_x64-setup.exe.sig`), "utf8");
  // bundler пишет .sig чистым base64-блобом (без текстовой шапки minisign) —
  // проверяем, что блоб декодируется в minisign-подпись
  const sigOk = Buffer.from(oldSig.trim(), "base64").toString("utf8").startsWith("untrusted comment:");
  check("препарат: релизный пакет 0.1.0 подписан (.sig присутствует)", sigOk, `${(fs.statSync(oldSetup).size / 1024 / 1024).toFixed(1)} МБ`);

  let oldExe = await installedExe();
  if (oldExe) {
    console.log("найдена прежняя установка — деинсталляция (чистая машина)");
    await killInstalled(oldExe);
    const entry = await uninstallEntry();
    if (entry?.UninstallString) await runInstaller(entry.UninstallString.replace(/"/g, ""), "/S");
    await sleep(1500);
  }
  check("A0 чистая машина: установленного DuoPulse нет", (await uninstallEntry()) === null);

  if (!SKIP_BUILD && !fs.existsSync(path.join(NEW_TMP, "setup.exe"))) {
    console.log(`сборка синтетического пакета ${NEW_VER} (подпись та же)…`);
    fs.mkdirSync(NEW_TMP, { recursive: true });
    const override = path.join(NEW_TMP, "version-override.json");
    fs.writeFileSync(override, JSON.stringify({ version: NEW_VER }));
    const mingw = "D:\\tools\\mingw64\\bin";
    const env = {
      ...process.env,
      PATH: fs.existsSync(mingw) ? `${mingw};${process.env.PATH}` : process.env.PATH,
      TAURI_SIGNING_PRIVATE_KEY: path.join(process.env.USERPROFILE ?? "", ".tauri", "duopulse-updater.key"),
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "",
    };
    const build = spawnSync("npx", ["tauri", "build", "--config", override], {
      cwd: ROOT,
      env,
      stdio: "inherit",
      shell: true,
    });
    if (build.status !== 0) throw new Error(`сборка ${NEW_VER} упала (код ${build.status})`);
    const bundle = path.join(ROOT, "src-tauri", "target", "release", "bundle", "nsis");
    fs.copyFileSync(path.join(bundle, `DuoPulse_${NEW_VER}_x64-setup.exe`), path.join(NEW_TMP, "setup.exe"));
    fs.copyFileSync(path.join(bundle, `DuoPulse_${NEW_VER}_x64-setup.exe.sig`), path.join(NEW_TMP, "setup.exe.sig"));
  }
  const newSig = fs.readFileSync(path.join(NEW_TMP, "setup.exe.sig"), "utf8");
  feed.package = fs.readFileSync(path.join(NEW_TMP, "setup.exe"));
  feed.latestJson = JSON.stringify({
    version: NEW_VER,
    notes: "стенд канарейки e2e",
    pub_date: new Date().toISOString(),
    platforms: {
      "windows-x86_64": {
        signature: newSig.trim(),
        url: `http://127.0.0.1:${FEED_PORT}/DuoPulse_${NEW_VER}_x64-setup.exe`,
      },
    },
  });
  await new Promise((r) => feedServer.listen(FEED_PORT, "127.0.0.1", r));

  // ===== фаза A: установка на чистой машине ===================================
  const exitA = await runInstaller(oldSetup, "/S");
  check("A1 тихая установка setup.exe /S завершена", exitA === "0", `exit=${exitA}`);
  let entryA = await uninstallEntry();
  check(
    "A2 реестр: запись Uninstall (DuoPulse, версия, каталог)",
    !!entryA && entryA.DisplayVersion === OLD_VER && !!entryA.InstallLocation,
    JSON.stringify(entryA && { v: entryA.DisplayVersion, dir: entryA.InstallLocation }),
  );
  const exeA = await installedExe();
  check("A3 каталог: duopulse.exe + деинсталлятор установлены", !!exeA && fs.existsSync(exeA) && fs.existsSync(path.join(path.dirname(exeA), "uninstall.exe")), exeA);
  const desktop = path.join(process.env.USERPROFILE, "Desktop", "DuoPulse.lnk");
  // tauri NSIS кладёт ярлык «Пуска» прямо в Programs (без подпапки)
  const startMenu = path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "DuoPulse.lnk");
  check(
    "A4 ярлыки: рабочий стол и «Пуск»",
    fs.existsSync(desktop) && fs.existsSync(startMenu),
    `desktop=${fs.existsSync(desktop)}, startMenu=${fs.existsSync(startMenu)}`,
  );

  const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-update-e2e-"));
  const a = await launchInstalled(exeA, tmpA, false);
  try {
    const version = await evalIn(a.ws, `window.__duopulse.bridge.version()`);
    check("A5 установленное приложение: контракт v11", version?.version === 11, JSON.stringify(version));
    const st = await evalIn(a.ws, `window.__duopulse.updater.status()`);
    check(
      "A6 updater.status: версия 0.1.0, канал stable, источник github, автопроверка вкл",
      st?.currentVersion === OLD_VER && st?.channel === "stable" && st?.source === "github" && st?.autoCheck === true,
      JSON.stringify(st && { v: st.currentVersion, ch: st.channel, src: st.source, auto: st.autoCheck }),
    );
  } finally {
    a.ws.close();
    await killInstalled(exeA);
    await waitForCdpDown(CDP_PORT);
    await sleep(700);
  }

  // ===== фаза B: обновление канарейки =========================================
  // профиль машины: канал canary (как у тестовой машины канарейки)
  const profileDir = path.join(tmpA, "DuoPulse", "profile");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, "settings.json"),
    JSON.stringify({ settingsVersion: 2, updater: { channel: "canary", autoCheck: false } }, null, 2),
  );

  const b = await launchInstalled(exeA, tmpA, true);
  try {
    const st0 = await evalIn(b.ws, `window.__duopulse.updater.status()`);
    check("B1 канал canary из профиля", st0?.channel === "canary" && st0?.autoCheck === false, JSON.stringify(st0 && { ch: st0.channel, auto: st0.autoCheck }));

    const res = await evalIn(b.ws, `window.__duopulse.updater.check()`);
    check(
      "B2 updater.check: найден пакет 0.1.1 (подпись фида проверена, ответил github)",
      res?.available === true && res?.version === NEW_VER && !res?.error && res?.source === "github",
      JSON.stringify(res && { v: res.version, src: res.source, err: res.error }),
    );
    const st1 = await evalIn(b.ws, `window.__duopulse.updater.status()`);
    check("B3 статус: обновление ожидает решения (pending)", st1?.pending?.version === NEW_VER, JSON.stringify(st1?.pending));

    // установка: приложение завершит процесс сразу после запуска пакета —
    // ответ команды не ждём (fire-and-forget eval без awaitPromise)
    await b.ws.send("Runtime.evaluate", {
      expression: `window.__duopulse.updater.install().catch(() => {})`,
      awaitPromise: false,
      returnByValue: true,
    });
    await sleep(1500);
    b.ws.close();
    const died = await waitForCdpDown(CDP_PORT);
    check("B4 приложение завершено установщиком", died);
  } catch (e) {
    b.ws.close();
    throw e;
  }

  // установщик работает и перезапускает приложение — ждём цель CDP снова
  let wsC = null;
  for (let i = 0; i < 120 && !wsC; i++) {
    await sleep(1000);
    try {
      const target = await uiTarget(CDP_PORT);
      wsC = connect(target.webSocketDebuggerUrl);
      if ((await evalIn(wsC, `typeof window.__duopulse`)) !== "object") {
        wsC.close();
        wsC = null;
      }
    } catch {
      /* ещё ставится */
    }
  }
  check("B5 приложение перезапущено установщиком (авто-рестарт)", !!wsC);
  try {
    if (wsC) {
      const st2 = await evalIn(wsC, `window.__duopulse.updater.status()`);
      check(
        "B6 обновлённое приложение: версия 0.1.1, профиль выжил (канал canary)",
        st2?.currentVersion === NEW_VER && st2?.channel === "canary",
        JSON.stringify(st2 && { v: st2.currentVersion, ch: st2.channel }),
      );
    }
    const entryB = await uninstallEntry();
    check("B7 реестр после обновления: DisplayVersion 0.1.1", entryB?.DisplayVersion === NEW_VER, entryB?.DisplayVersion);
  } finally {
    wsC?.close();
    const exeNow = await installedExe();
    if (exeNow) await killInstalled(exeNow);
    await waitForCdpDown(CDP_PORT);
  }

  // ===== фаза B+: источник Aila (duopulse-049) =================================
  // адресация зеркала: <база>/latest-<канал>.json вместо github-формы
  // <канал>/{{target}}/{{arch}}/{{current_version}}; фид стенда показывает
  // ту же версию → проверка отвечает «у вас последняя версия», и видно,
  // кто ответил (source=aila).
  const exeB = await installedExe();
  const profileDirB = path.join(tmpA, "DuoPulse", "profile");
  fs.writeFileSync(
    path.join(profileDirB, "settings.json"),
    JSON.stringify(
      { settingsVersion: 2, updater: { channel: "canary", source: "aila", autoCheck: false } },
      null,
      2,
    ),
  );
  const bp = await launchInstalled(exeB, tmpA, true);
  try {
    const st0 = await evalIn(bp.ws, `window.__duopulse.updater.status()`);
    check(
      "B+1 источник aila из профиля",
      st0?.channel === "canary" && st0?.source === "aila",
      JSON.stringify(st0 && { ch: st0.channel, src: st0.source }),
    );
    const res = await evalIn(bp.ws, `window.__duopulse.updater.check()`);
    check(
      "B+2 зеркало aila: проверка прошла, «у вас последняя версия» (ответил aila)",
      res?.available === false && !res?.error && res?.source === "aila",
      JSON.stringify(res && { v: res.version, src: res.source, err: res.error }),
    );
    const st1 = await evalIn(bp.ws, `window.__duopulse.updater.status()`);
    check(
      "B+3 статус: последняя проверка без ошибки, pending пуст",
      st1?.lastCheck && !st1.lastCheck.error && st1.lastCheck.source === "aila" && !st1?.pending,
      JSON.stringify(st1?.lastCheck),
    );
  } finally {
    bp.ws.close();
    await killInstalled(exeB);
    await waitForCdpDown(CDP_PORT);
  }

  // ===== фаза C: деинсталляция ================================================
  const entryC = await uninstallEntry();
  const exeC = await installedExe();
  if (entryC?.UninstallString && exeC) {
    const exitC = await runInstaller(entryC.UninstallString.replace(/"/g, ""), "/S");
    check("C1 деинсталляция /S завершена", exitC === "0", `exit=${exitC}`);
  } else {
    check("C1 деинсталляция /S завершена", false, "запись Uninstall не найдена");
  }
  const dirC = exeC ? path.dirname(exeC) : null;
  const gone = await waitFor(
    async () => (await uninstallEntry()) === null && (!dirC || !fs.existsSync(dirC)),
  );
  check("C2 после деинсталляции: записи реестра нет, каталог снесён", gone, gone ? "чисто" : "остались следы");

  // временные профили — подчистить (пакет 0.1.1 в %TEMP% оставляем до
  // следующего прогона: SKIP_BUILD переиспользует его)
  try {
    await rmRetry(tmpA);
  } catch {
    console.warn(`временный профиль не удалён: ${tmpA}`);
  }
} catch (e) {
  failures += 1;
  console.error("СТЕНД УПАЛ:", e);
} finally {
  feedServer.close();
  const exe = await installedExe().catch(() => null);
  if (exe) await killInstalled(exe).catch(() => {});
}

failures += results.filter((r) => !r.ok).length;
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} PASS${failures ? `, ${failures} FAIL` : " — ALL PASS"}`);
process.exit(failures ? 1 : 0);

