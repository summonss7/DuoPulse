// E2E-приёмка строки закладок (карточка duopulse-143) через CDP в живом
// приложении (паттерн e2e/bookmarks/run.mjs; изоляция — временный APPDATA).
//   1) пустой профиль: #bmbar скрыт, высота #app 84 (динамику высоты задаёт
//      строка — tabs.set_chrome_height);
//   2) сид: закладки в «Избранное» (null-группа), безгрупповая, группа
//      «Работа» с двумя членами → бар: чипы (3+1) и папка, #app 112,
//      --chrome-h 112px;
//   3) правка через мост (bookmarkRemove) + переключение вкладки —
//      tabs.updated с дебаунсом обновляет строку (чип исчез);
//   4) наведение на папку (pointerover, dwell 250 мс) открывает нативное
//      меню: выбор пункта клавиатурой (SendKeys DOWN+ENTER — окно поднято
//      на передний план ALT-трюком, меню фонового окна клавиатуру не
//      получает) навигирует активную вкладку на закладку папки;
//   5) клик по чипу — навигация активной вкладки; CDP-сервер стенда клик
//      переживает плохо (соединение рвётся — WS 1006), поэтому клик —
//      последний CDP-шаг, а результат сверяем скриншотом окна (адресная
//      строка + заголовок страницы = адрес закладки).
// Скриншоты: %TEMP%/duopulse-143-bar.png и duopulse-143-click.png (снимок
// окна: DPI-aware + ALT-трюк foreground — иначе огрызок/перекрытие).
//
// Запуск:  node e2e/bookmarks/bmbar.mjs [путь-к-duopulse.exe]
// Требует собранный debug-exe (cargo build); vite dev поднимает сам.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

process.on("exit", (c) => console.log("NODE-EXIT-EVENT:", c));
process.on("beforeExit", () => console.log("NODE-BEFORE-EXIT"));
process.on("unhandledRejection", (e) => {
  console.log("UNHANDLED:", String(e).slice(0, 400));
});
const step = (s) => console.log(`-- шаг: ${s}`);

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
// WMI/Win32 отдают пути с обратными слэшами — для PS-сравнений ExecutablePath
const EXE_PS = EXE.replaceAll("/", "\\");
const CDP_PORT = Number(process.env.CDP_PORT || 9226);
// 8899 занят сервисом Aila (см. e2e/omnibox/run.mjs)
const HTTP_PORT = Number(process.env.E2E_BMBAR_PORT || 8896);
const SHOT_DIR = process.env.E2E_BMBAR_SHOTS || os.tmpdir();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))),
  );

/** Убить только экземпляры НАШЕГО exe. */
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
const consoleLog = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
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
    } else if (!m.id) {
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
        consoleLog.push("[ui] " + m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
      }
      if (m.method === "Runtime.exceptionThrown") {
        consoleLog.push("[ui] EXC: " + JSON.stringify(m.params.exceptionDetails.exception ?? {}).slice(0, 300));
      }
    }
  };
  const open = new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  open.catch(() => {});
  ws.onclose = async (e) => {
    console.log("WS-CLOSED:", e.code, e.reason);
    try {
      const l = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
      console.log("TARGETS:", l.map((t) => t.type + " " + t.url.slice(0, 60)).join(" || "));
    } catch (e2) {
      console.log("TARGETS: сервер недоступен", String(e2).slice(0, 100));
    }
  };
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
    send("Runtime.evaluate", { expression: expr, awaitPromise, returnByValue: true }).then(
      (r) => r?.result?.value,
    );
  return { ws, send, evalIn };
}

const waitFor = async (fn, ms, step = 400) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
};

/** PS-скрипт снимка окна приложения (нативные слои — меню — видны, в отличие
 *  от CDP-кадра одного webview). DPI-aware: без этого GetWindowRect отдаёт
 *  логические координаты, а CopyFromScreen берёт физические — снимок
 *  съезжал в крошечный огрызок (грабля DPI-виртуализации PowerShell). */
const shotScript = (file, foreground = true) => `
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  public struct R { public int L, T, Rt, B; }
}
"@
[Win32]::SetProcessDPIAware() | Out-Null
$proc = Get-CimInstance Win32_Process -Filter "Name='duopulse.exe'" |
  Where-Object { $_.ExecutablePath -eq '${EXE_PS}' } | Select-Object -First 1
$p = Get-Process -Id $proc.ProcessId -ErrorAction Stop
$r = New-Object Win32+R
$fg = "${foreground ? 1 : 0}"
# окно на передний план: SetForegroundWindow из фонового процесса Windows
# блокирует защита фокуса — классический ALT-трюк (keybd_event снимает
# ограничение); активация ещё и будит приостановленный композитор webview.
# fg=0 — снимок с открытым модальным меню: ALT/активация меню закрывают
# (меню и так держит окно активным) — снимаем как есть.
if ($fg -eq "1") {
  [Win32]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [Win32]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
  [Win32]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 500
}
[Win32]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
$w = $r.Rt - $r.L; $h = $r.B - $r.T
if ($w -le 0 -or $h -le 0) { throw "пустой прямоугольник окна" }
$b = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($b)
$g.CopyFromScreen($r.L, $r.T, 0, 0, $b.Size)
$b.Save("${file.replaceAll("\\", "/")}", [System.Drawing.Imaging.ImageFormat]::Png)
`;

/** Окно приложения на передний план (ALT-трюк против защиты фокуса) —
 *  нужно ДО открытия нативного меню: меню фонового окна не получает
 *  клавиатуру, SendKeys уходит в чужое окно. */
const foregroundApp = async () => {
  await run("powershell", [
    "-NoProfile",
    "-Command",
    `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W2 {
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@
$proc = Get-CimInstance Win32_Process -Filter "Name='duopulse.exe'" |
  Where-Object { $_.ExecutablePath -eq '${EXE_PS}' } | Select-Object -First 1
$p = Get-Process -Id $proc.ProcessId -ErrorAction Stop
[W2]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[W2]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
[W2]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 400
`,
  ]).catch((e) => console.log("fg:", String(e).slice(0, 120)));
};

/** Скриншот с одним повтором: первый PS-запрос изредка падает (прогрев
 *  Add-Type), второй тем же скриптом проходит. */
const shotWindow = async (file, foreground = true) => {
  for (let i = 0; i < 2; i++) {
    try {
      await run("powershell", ["-NoProfile", "-Command", shotScript(file, foreground)]);
      return;
    } catch (e) {
      console.log(`shot: попытка ${i + 1} не вышла —`, String(e).slice(0, 120));
      await sleep(700);
    }
  }
};

// --- 1. локальный http-стенд (внешняя страница для навигации чипом) -----------
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(
    `<html><head><title>Стенд 143 ${req.url}</title></head><body><h1>${req.url}</h1></body></html>`,
  );
});
await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-143-e2e-"));

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
const appEnv = {
  ...process.env,
  APPDATA: tmp,
  DUOPULSE_START_URL: `http://127.0.0.1:${HTTP_PORT}/start`,
  DUOPULSE_ADBLOCK_LISTS: "",
  WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
};
const app = spawn(EXE, [], { stdio: "ignore", env: appEnv });

let ui = null;
try {
  // --- 2. ждём CDP: UI (vite) ------------------------------------------------
  ui = await waitFor(async () => {
    try {
      const list = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
      return list.find((t) => t.type === "page" && /localhost:5173/.test(t.url)) ?? null;
    } catch {
      return null;
    }
  }, 60000);
  check("приложение поднялось (CDP-цель UI)", !!ui, ui?.url ?? "не дождались");
  if (!ui) throw new Error("нет CDP");
  const uiWs = connect(ui.webSocketDebuggerUrl);
  await uiWs.send("Runtime.enable").catch(() => {});
  await waitFor(() => uiWs.evalIn(`document.querySelectorAll('.tab').length > 0 ? 1 : 0`, false), 15000);

  const H = `window.__duopulse.history`;
  const barState = () =>
    uiWs.evalIn(
      `(() => {
        const bar = document.getElementById('bmbar');
        return {
          hidden: bar.hidden,
          chips: bar.querySelectorAll('.bm-item:not(.bm-folder)').length,
          folders: [...bar.querySelectorAll('.bm-folder')].map((f) => f.textContent.trim()),
          appH: document.getElementById('app').offsetHeight,
          chromeVar: getComputedStyle(document.documentElement).getPropertyValue('--chrome-h').trim(),
        };
      })()`,
      false,
    );

  // --- 3. пустой профиль: строки нет, высота базовая --------------------------
  await sleep(1500); // первый refreshBmBar успел отработать (пусто → скрыта)
  const empty = await barState();
  check(
    "пустой профиль: строка скрыта, #app 84",
    empty.hidden && empty.appH === 84 && empty.chromeVar === "84px",
    JSON.stringify(empty),
  );

  // --- 4. сид: «Избранное» + безгрупповая + группа «Работа» -------------------
  // адреса — локальные (стенд): клик по чипу навигирует без страницы ошибки
  // (замена webview вкладки на error-page роняла CDP-цель UI — WS 1006)
  const L = (u) => `http://127.0.0.1:${HTTP_PORT}/${u}`;
  for (const [url, title] of [
    [L("wiki"), "Википедия"],
    [L("git"), "GitHub"],
    [L("mdn"), "mdn"],
  ]) {
    await uiWs.evalIn(`${H}.bookmarkAdd(${JSON.stringify({ url, title, groupId: null })})`);
  }
  // безгрупповая: добавить и выключить членство в группе по умолчанию
  await uiWs.evalIn(
    `${H}.bookmarkAdd(${JSON.stringify({ url: L("ungrouped"), title: "Без группы", groupId: null })})`,
  );
  const groups0 = await uiWs.evalIn(`${H}.groupList()`);
  const FAV_ID = groups0.groups.find((g) => g.isDefault).id;
  await uiWs.evalIn(
    `${H}.groupToggleBookmark(${JSON.stringify({ url: L("ungrouped"), groupId: FAV_ID, on: false })})`,
  );
  const work = await uiWs.evalIn(`${H}.groupAdd({ name: "Работа" })`);
  for (const url of [L("git"), L("mdn")]) {
    await uiWs.evalIn(
      `${H}.groupToggleBookmark(${JSON.stringify({ url, groupId: work.id, on: true })})`,
    );
  }
  // строка обновляется по tabs.updated — откроем вкладку (событие уйдёт)
  await uiWs.evalIn(
    `window.__duopulse.tabs.open(${JSON.stringify({ url: `http://127.0.0.1:${HTTP_PORT}/second` })})`,
  );
  const seeded = await waitFor(async () => {
    const s = await barState();
    return s && !s.hidden && s.chips === 4 && s.folders.length === 1 ? s : null;
  }, 10000);
  check(
    "сид: 4 чипа (3 «Избранное» + безгрупповая) и папка «Работа»",
    !!seeded && seeded.folders[0] === "Работа",
    JSON.stringify(seeded),
  );
  check(
    "высота хрома выросла: #app 112, --chrome-h 112px",
    seeded?.appH === 112 && seeded?.chromeVar === "112px",
    JSON.stringify({ appH: seeded?.appH, chromeVar: seeded?.chromeVar }),
  );
  // --- 5. tabs.updated обновляет строку (bookmarkRemove + переключение) -------
  step("обновление по tabs.updated");
  await uiWs.evalIn(`${H}.bookmarkRemove(${JSON.stringify({ url: L("mdn") })})`);
  await uiWs.evalIn(
    `window.__duopulse.tabs.list().then((res) => window.__duopulse.tabs.activate({ id: res.tabs[0].id }))`,
  );
  const afterRemove = await waitFor(async () => {
    const st = await barState();
    return st && st.chips === 3 ? st : null;
  }, 8000);
  check("правка через мост + tabs.updated — чип исчез (дебаунс)", !!afterRemove, JSON.stringify(afterRemove));

  // --- 6. наведение на папку — нативное меню + выбор пункта -------------------
  // наведение открывает меню (dwell 250 мс), выбор — клавиатурой (DOWN+ENTER
  // в нативное меню): menu-action → навигация активной вкладки. Скриншотами
  // меню не сверяем: поднять окно без закрытия модального меню не вышло
  // (ALT-трюк активацией меню закрывает) — функциональная проверка надёжнее.
  step("наведение на папку");
  await foregroundApp(); // окно вперёд: меню фонового окна не получает клавиатуру
  await uiWs.evalIn(
    `document.querySelector('#bmbar .bm-folder').dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))`,
    false,
  );
  await sleep(700); // dwell 250 мс + открытие нативного меню
  await run("powershell", [
    "-NoProfile",
    "-Command",
    `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{DOWN}{ENTER}')`,
  ]).catch(() => {});
  const menuNav = await waitFor(async () => {
    const res = await uiWs.evalIn(`window.__duopulse.tabs.list()`);
    const a = (res?.tabs ?? []).find((t) => t.active);
    return a?.url === L("git") ? a : null;
  }, 8000);
  check(
    "наведение на папку открыло меню, выбор пункта навигировал вкладку",
    !!menuNav,
    menuNav ? menuNav.url : "вкладка не ушла на закладку папки",
  );
  await shotWindow(path.join(SHOT_DIR, "duopulse-143-bar.png"));

  // --- 7. клик по чипу — навигация активной вкладки ---------------------------
  // ЗАМЕРШЕЕ ПОНЯТИЕ: клик по чипу ронял CDP-сервер стенда целиком (WS 1006,
  // /json недоступен; живой прогон с логами приложения навигацию подтверждает)
  // — поэтому клик последний, а результат сверяем скриншотом окна.
  step("клик по чипу");
  // eval клика не ждать: клик роняет CDP-сервер стенда (см. комментарий
  // шага) — гонка с таймаутом, дальше только скриншот
  await Promise.race([
    uiWs.evalIn(
      `[...document.querySelectorAll('#bmbar .bm-item:not(.bm-folder)')][0].click()`,
      false,
    ).catch(() => {}),
    sleep(1500),
  ]);
  await sleep(2500);
  await shotWindow(path.join(SHOT_DIR, "duopulse-143-click.png"));

  step("готово");
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `\nFAIL: ${failed.length}` : "\nOK: все проверки прошли");
  console.log("скриншоты:", path.join(SHOT_DIR, "duopulse-143-bar.png"), path.join(SHOT_DIR, "duopulse-143-click.png"));
} finally {
  // порядок: приложение → vite → http; временный профиль не трогаем (следование
  // run.mjs), %TEMP% заберёт чистка системы
  await killOurExes();
  vite.kill();
  httpServer.close();
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
}
