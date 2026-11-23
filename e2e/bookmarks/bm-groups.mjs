// E2E-приёмка duopulse-160 «строка закладок: удалить, перенос между
// группами, новая группа» через CDP в живом приложении (паттерн
// e2e/bookmarks/bm-drag.mjs; изоляция — временный APPDATA, vite dev
// поднимает сам, требует собранный debug-exe).
//   1) сид: A,B,C,E в «Избранном», D безгрупповая, «Работа» — ПУСТАЯ
//      корневая группа, «Медиа» с одним членом;
//      пустая папка «Работа» видна на строке (duopulse-160);
//   2) внешний drop на папку строки (синтетический DragEvent, без
//      dragstart в этом webview — имитация переноса из панели папки):
//      свой MIME с группой-источником → перенос A; чистый text/plain
//      (фолбэк, источник-«Избранное» угадывается) → перенос C;
//   3) правый клик по чипу B — нативное меню «Переименовать…/Удалить»,
//      выбор «Удалить» клавиатурой (DOWN DOWN ENTER, окно на переднем
//      плане ALT-трюком) — закладка удалена, чип исчез;
//   4) правый клик по пустому месту строки — «Новая группа…» (ENTER),
//      папка появилась + инлайн-правка; печать «Тест»+ENTER — группа
//      переименована;
//   5) панель папки «Медиа»: правый клик по строке — нативное меню
//      (duopulse-189: системный popup вместо HTML .bm-ctx), состав из CDP
//      не читается — проверяем поведением: Escape закрывает без
//      последствий, 1-й пункт «Создать раздел…» (duopulse-173) создаёт
//      подгруппу в «Медиа», 3-й «Удалить закладку» удаляет закладку
//      (поиск закладки — groupId:null, все группы: -1 — фильтр «без
//      группы», сгруппированная закладка им не находится);
//   6) внешний drop в ОТКРЫТУЮ панель (тело, не подгруппа): E из
//      «Избранного» переложена в «Медиа»;
//   7) (duopulse-163) правый клик по папке «Тест» — нативное меню
//      «Переименовать…/Удалить группа»: позиция попапа у курсора
//      (GetWindowRect #32768 против клиентской точки → экран), выбор
//      «Удалить группу» клавиатурой — группа и папка исчезли.
// Реальный OLE-drag между webview синтетическими событиями не
// воспроизводится (это транспорт Chromium, проверен живым перетаскиванием);
// стенд проверяет приёмную логику обеих сторон.
// Скриншоты: %TEMP%/duopulse-160-*.png.
//
// Запуск:  node e2e/bookmarks/bm-groups.mjs [путь-к-duopulse.exe]
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const step = (s) => console.log(`-- шаг: ${s}`);
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const EXE_PS = EXE.replaceAll("/", "\\");
const CDP_PORT = Number(process.env.CDP_PORT || 9233);
const HTTP_PORT = Number(process.env.E2E_160_PORT || 8908);
const SHOT_DIR = process.env.E2E_160_SHOTS || os.tmpdir();
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
const consoleLog = [];
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
        return "EXC: " + String(d).slice(0, 200);
      }
      return r?.result?.value;
    });
  // eval с таймаутом: во время модального нативного меню UI-webview может
  // не отвечать — waitFor не должен висеть вечно
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

/** Окно приложения на передний план (ALT-трюк против защиты фокуса) —
 *  нативное меню фонового окна не получает клавиатуру (паттерн bmbar.mjs). */
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

const sendKeys = (keys) =>
  run("powershell", [
    "-NoProfile",
    "-Command",
    `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keys}')`,
  ]).catch((e) => console.log("keys:", String(e).slice(0, 120)));

/** Сколько попапов-меню (#32768) открыто у процесса НАШЕГО exe — нативное
 *  меню из CDP не видно (класс окон ищем EnumWindows по pid; FindWindow
 *  глобален и на живой машине ловит чужие меню, например Aila). */
const ourPopups = () =>
  run("powershell", [
    "-NoProfile",
    "-Command",
    `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class PM {
  public static int Count = 0;
  static uint Target;
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  static bool Cb(IntPtr h, IntPtr l) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    if (pid == Target) {
      var sb = new StringBuilder(64);
      GetClassName(h, sb, 64);
      if (sb.ToString() == "#32768") Count++;
    }
    return true;
  }
  public static int Find(uint pid) { Target = pid; Count = 0; EnumWindows(Cb, IntPtr.Zero); return Count; }
}
"@
$proc = Get-CimInstance Win32_Process -Filter "Name='duopulse.exe'" |
  Where-Object { $_.ExecutablePath -eq '${EXE_PS}' } | Select-Object -First 1
$p = Get-Process -Id $proc.ProcessId -ErrorAction Stop
[PM]::Find($p.Id)
`,
  ])
    .then((out) => Number(String(out).trim()))
    .catch(() => 0);

/** Открыть нативное меню (dispatch — CDP-выражение contextmenu в webview ws)
 *  и отправить ему клавиши. Клавиши — только по живому попапу (гейт): на
 *  живой машине Aila перетягивает foreground, а попап не-foreground окна
 *  Windows закрывает мгновенно — клавиши уходят мимо меню; PS-запуск гейта
 *  (~1,5 с) заодно доказывает, что окно держит foreground. Попап не пойман —
 *  ретрай (до 4). true — клавиши ушли в открытое меню. */
const menuKeys = async (ws, dispatch, keys) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    await foregroundApp();
    await ws.evalT(dispatch, 2500).catch(() => {});
    await sleep(800);
    if ((await ourPopups()) > 0) {
      await sendKeys(keys);
      return true;
    }
    await sendKeys("{ESC}");
    await sleep(500);
  }
  return false;
};

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<html><head><title>Стенд 160 ${req.url}</title></head><body><h1>${req.url}</h1></body></html>`);
});
await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));

// несвежий vite на 5173 подсунул бы СТАРЫЙ бандл (vite-autoпорт) — чистим
try {
  const out = await run("powershell", [
    "-NoProfile",
    "-Command",
    `$c = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue;
     if ($c) { $c | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }`,
  ]);
} catch { /* порт свободен — ок */ }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-160-e2e-"));
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
// stderr приложения — в лог tmp-профиля: [startup]/[menu163] и паники видны
// при разборе провалов (приложение пишет человекочитаемые метки)
const appLog = fs.openSync(path.join(tmp, "app.log"), "a");
const app = spawn(EXE, [], {
  stdio: ["ignore", appLog, appLog],
  env: {
    ...process.env,
    APPDATA: tmp,
    DUOPULSE_START_URL: `http://127.0.0.1:${HTTP_PORT}/start`,
    DUOPULSE_ADBLOCK_LISTS: "",
    // single-instance держит установленный DuoPulse пользователя — без
    // рубильника debug-exe стенда молча гаснет по мьютексу идентификатора
    DUOPULSE_E2E_NO_SINGLE_INSTANCE: "1",
    WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
  },
});

let ui = null;
try {
  step("ждём CDP-цель UI");
  ui = await waitFor(async () => {
    try {
      const list = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
      return list.find((t) => t.type === "page" && /localhost:5173/.test(t.url) && !/panel=/.test(t.url)) ?? null;
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

  // --- 1. сид ---------------------------------------------------------------
  step("сид: A,B,C,E в «Избранном», D безгрупповая, пустая «Работа», «Медиа»");
  for (const [url, title] of [
    ["https://a.example/", "Альфа"],
    ["https://b.example/", "Бета"],
    ["https://c.example/", "Гамма"],
    ["https://d.example/", "Дельта"],
    ["https://e.example/", "Эпсилон"],
    ["https://m1.example/", "Кино"],
  ]) {
    await uiWs.evalIn(`${H}.bookmarkAdd(${JSON.stringify({ url, title, groupId: null })})`);
  }
  const gl0 = await uiWs.evalIn(`${H}.groupList()`);
  const def = gl0.groups.find((g) => g.isDefault);
  // D — безгрупповая
  await uiWs.evalIn(`${H}.groupToggleBookmark(${JSON.stringify({ url: "https://d.example/", groupId: def.id, on: false })})`);
  const work = await uiWs.evalIn(`${H}.groupAdd(${JSON.stringify({ name: "Работа" })})`); // ПУСТАЯ
  const media = await uiWs.evalIn(`${H}.groupAdd(${JSON.stringify({ name: "Медиа" })})`);
  await uiWs.evalIn(`${H}.groupToggleBookmark(${JSON.stringify({ url: "https://m1.example/", groupId: media.id, on: true })})`);
  await uiWs.evalIn(`${H}.groupToggleBookmark(${JSON.stringify({ url: "https://m1.example/", groupId: def.id, on: false })})`);
  // свежий бар: tabs.updated → refreshBmBar
  await uiWs.evalIn(`window.__duopulse.tabs.open({ url: "duopulse://history" }).then(() => window.__duopulse.tabs.list())`);
  await sleep(1200);
  const barInfo = await waitFor(
    () =>
      uiWs.evalT(`(() => {
        const chips = [...document.querySelectorAll('#bmbar .bm-item:not(.bm-folder)')].map(x => x.dataset.url);
        const folders = [...document.querySelectorAll('#bmbar .bm-folder .bm-label')].map(x => x.textContent);
        return chips.length >= 5 ? { chips, folders } : null;
      })()`, 4000).then((v) => (v && v !== "EVAL-TIMEOUT" ? v : null)),
    10000,
  );
  check(
    "бар: 5 чипов; ПУСТАЯ папка «Работа» видна + «Медиа» (duopulse-160)",
    !!barInfo && barInfo.chips.length === 5 &&
      barInfo.folders.includes("Работа") && barInfo.folders.includes("Медиа"),
    JSON.stringify(barInfo),
  );

  // --- 2a. внешний drop на папку строки: свой MIME с группой-источником ------
  step("внешний drop A на папку «Работа» (свой MIME, fromGroup=Избранное)");
  const dropA = await uiWs.evalIn(`(() => {
    const bar = document.getElementById('bmbar');
    const f = [...bar.querySelectorAll('.bm-folder')].find(x => x.dataset.folder === String(${work.id}));
    if (!f) return 'no-targets';
    const r = f.getBoundingClientRect();
    const dt = new DataTransfer();
    dt.setData('application/x-duopulse-bm', ${JSON.stringify(JSON.stringify({ url: "https://a.example/", group: def.id }))});
    dt.setData('text/plain', 'https://a.example/');
    // drop на самой папке (как в живом drag&drop): обработчик ищет цель
    // closest('.bm-folder') от target — от bar она не найдётся
    f.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 6, clientY: r.top + 4 }));
    f.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 6, clientY: r.top + 4 }));
    return 'ok';
  })()`);
  await sleep(1200);
  const wl = await uiWs.evalIn(`${H}.bookmarkList(${JSON.stringify({ query: null, groupId: work.id, offset: 0, limit: 50 })})`);
  const dl = await uiWs.evalIn(`${H}.bookmarkList(${JSON.stringify({ query: null, groupId: def.id, offset: 0, limit: 50 })})`);
  check(
    "перенос A в «Работу»: член + из «Избранного» ушла, чип исчез",
    dropA === "ok" && wl.bookmarks.some((b) => b.url === "https://a.example/") && !dl.bookmarks.some((b) => b.url === "https://a.example/"),
    JSON.stringify({ drop: dropA, work: wl.bookmarks.map((b) => b.url), def: dl.bookmarks.length }),
  );

  // --- 2b. внешний drop фолбэком text/plain (источник угадан по членству) ---
  step("внешний drop C на папку «Работа» (только text/plain)");
  const dropC = await uiWs.evalIn(`(() => {
    const bar = document.getElementById('bmbar');
    const f = [...bar.querySelectorAll('.bm-folder')].find(x => x.dataset.folder === String(${work.id}));
    if (!f) return 'no-targets';
    const r = f.getBoundingClientRect();
    const dt = new DataTransfer();
    dt.setData('text/plain', 'https://c.example/');
    f.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 6, clientY: r.top + 4 }));
    f.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 6, clientY: r.top + 4 }));
    return 'ok';
  })()`);
  await sleep(1200);
  const wl2 = await uiWs.evalIn(`${H}.bookmarkList(${JSON.stringify({ query: null, groupId: work.id, offset: 0, limit: 50 })})`);
  const dl2 = await uiWs.evalIn(`${H}.bookmarkList(${JSON.stringify({ query: null, groupId: def.id, offset: 0, limit: 50 })})`);
  check(
    "перенос C в «Работу» фолбэком text/plain",
    dropC === "ok" && wl2.bookmarks.some((b) => b.url === "https://c.example/") && !dl2.bookmarks.some((b) => b.url === "https://c.example/"),
    JSON.stringify({ drop: dropC, work: wl2.bookmarks.map((b) => b.url) }),
  );

  // --- 3. правый клик по чипу: нативное меню «Удалить» ------------------------
  step("нативное меню чипа B: «Удалить» (DOWN DOWN ENTER)");
  const chipMenu = `(() => {
    const b = [...document.querySelectorAll('#bmbar .bm-item:not(.bm-folder)')].find(x => x.dataset.url === "https://b.example/");
    if (!b) return 'no-chip';
    const r = b.getBoundingClientRect();
    b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 4, clientY: r.top + 4 }));
    return 'ok';
  })()`;
  // выбор — по гейту живого попапа с ретраями (foreground на живой машине
  // крадёт Aila: без гейта клавиши уходят мимо меню — флак «чип не исчез»)
  let bGone = null;
  let bMenu = false;
  for (let attempt = 0; attempt < 3 && !bGone; attempt++) {
    bMenu = await menuKeys(uiWs, chipMenu, "{DOWN}{DOWN}{ENTER}");
    if (!bMenu) break;
    bGone = await waitFor(
      () =>
        uiWs.evalT(`window.__duopulse.history.bookmarkList(${JSON.stringify({ query: "b.example", groupId: null, offset: 0, limit: 10 })})`, 4000).then(
          (r) => (r && r !== "EVAL-TIMEOUT" && r.bookmarks?.length === 0 ? r : null),
        ),
      6000,
    );
    if (!bGone) await sendKeys("{ESC}"); // фокус ушёл между гейтом и клавишами — ретрай
  }
  const bChipGone = await uiWs.evalT(
    `!document.querySelector('#bmbar .bm-item[data-url="https://b.example/"]')`,
    4000,
  );
  check(
    "«Удалить» из нативного меню: закладка B удалена, чип исчез",
    !!bGone && bChipGone === true,
    JSON.stringify({ menu: bMenu, gone: !!bGone, chip: bChipGone }),
  );

  // --- 4. правый клик по пустому месту: «Новая группа…» -----------------------
  step("правый клик по пустому месту строки → «Новая группа…»");
  // DOWN обязателен: у Win32-попапа нет начального выделения, ENTER без
  // выделения закрывает меню без выбора (паттерн bmbar.mjs). Повторы:
  // сразу после закрытия предыдущего попапа (шаг 3) клавиатура/фокус
  // добираются не сразу — ретрай диспатча+клавиатуры надёжен
  const pollGroup = (name) => async () => {
    const r = await uiWs.evalT(`window.__duopulse.history.groupList()`, 4000);
    return r && r !== "EVAL-TIMEOUT" && Array.isArray(r.groups) && r.groups.some((g) => g.name === name)
      ? true
      : null;
  };
  let newGroup = null;
  for (let attempt = 0; attempt < 3 && !newGroup; attempt++) {
    await foregroundApp();
    await uiWs.evalT(
      `(() => {
        const bar = document.getElementById('bmbar');
        const r = bar.getBoundingClientRect();
        bar.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.right - 60, clientY: r.top + r.height / 2 }));
        return 'ok';
      })()`,
      4000,
    );
    await sleep(1100);
    await sendKeys("{DOWN}{ENTER}");
    await sleep(600);
    newGroup = await waitFor(pollGroup("Новая группа"), 4000);
  }
  check("группа «Новая группа» создана с строки", newGroup === true);
  const renameLive = await waitFor(
    () => uiWs.evalT(`!!document.querySelector('#bmbar input.bm-rename')`, 4000).then((v) => (v === true ? v : null)),
    6000,
  );
  check("инлайн-правка имени новой папки открылась", renameLive === true, String(renameLive));
  let renamed = null;
  // живая клавиатура в инлайн-input фонового webview не фокусируется
  // (SendKeys уходит мимо) — правку имени проверяем значением+Enter:
  // input существует из реального потока, save-путь (group_rename) настоящий
  for (let attempt = 0; attempt < 2 && !renamed; attempt++) {
    await uiWs.evalT(
      `(() => {
        const inp = document.querySelector('#bmbar input.bm-rename');
        if (!inp) return 'no-input';
        inp.value = 'Тест';
        inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: false }));
        return 'ok';
      })()`,
      4000,
    );
    await sleep(800);
    renamed = await waitFor(pollGroup("Тест"), 6000);
  }
  check("новая папка переименована в «Тест» (Enter)", renamed === true);
  const testOnBar = await uiWs.evalT(
    `[...document.querySelectorAll('#bmbar .bm-folder .bm-label')].some(x => x.textContent === 'Тест')`,
    4000,
  );
  check("папка «Тест» на строке", testOnBar === true);

  // --- 5. панель папки: нативное меню строки ---------------------------------
  // С duopulse-189 меню строки — системный popup (HTML .bm-ctx прятался за
  // видео у коротких папок), из CDP не читается — три пункта проверяем
  // поведением: Escape, «Создать раздел…» (duopulse-173), «Удалить закладку».
  step("панель «Медиа»: правый клик по строке — нативное меню (189/173)");
  await uiWs.evalT(`(() => {
    const f = [...document.querySelectorAll('#bmbar .bm-folder')].find(x => x.dataset.folder === String(${media.id}));
    f?.click();
    return 'ok';
  })()`, 4000);
  const panelT = await waitFor(async () => {
    try {
      const list = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
      return list.find((t) => t.type === "page" && /panel=bmfolder/.test(t.url)) ?? null;
    } catch {
      return null;
    }
  }, 15000);
  check("панель-webview bmfolder открылась", !!panelT, panelT?.url ?? "не дождались");
  let panelWs = null;
  if (panelT) {
    panelWs = connect(panelT.webSocketDebuggerUrl);
    await panelWs.send("Runtime.enable").catch(() => {});
    // строки приходят после groupList+bookmarkList по IPC и загрузки бандла из
    // холодного vite dev; на живой машине это плавает — лимит 20 с, в проверке
    // фактическое время, при провале — снимок состояния панели
    const rowsT0 = Date.now();
    const rowOk = await waitFor(
      () => panelWs.evalIn(`document.querySelectorAll('.bm-row[data-url]').length`, false).then((n) => (n === 1 ? n : null)),
      20000,
    );
    const rowsMs = Date.now() - rowsT0;
    const panelState = rowOk
      ? `${rowsMs} мс`
      : String(
          await panelWs
            .evalT(
              `JSON.stringify({ ready: document.readyState, rows: document.querySelectorAll('.bm-row').length, host: !!document.getElementById('bmFolder'), perf: Math.round(performance.now()) })`,
              4000,
            ),
        );
    check("панель: строка «Кино»", rowOk === 1, panelState);
    const rowMenu = `(() => {
      const row = document.querySelector('.bm-row[data-url="https://m1.example/"]');
      if (!row) return 'no-row';
      const r = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 30, clientY: r.top + r.height / 2 }));
      return 'ok';
    })()`;
    // адреса закладки M1 по ВСЕМ группам (groupId:null — все; -1 — фильтр
    // «без группы»: сгруппированная закладка им не находится)
    const m1Everywhere = () =>
      uiWs
        .evalT(`${H}.bookmarkList(${JSON.stringify({ query: "m1.example", groupId: null, offset: 0, limit: 10 })})`, 4000)
        .then((r) => (r && r !== "EVAL-TIMEOUT" ? r.bookmarks.map((b) => b.url) : null));
    const shot = await panelWs.send("Page.captureScreenshot", { format: "png" }).catch(() => null);
    if (shot) {
      fs.writeFileSync(path.join(SHOT_DIR, "duopulse-160-ctx.png"), Buffer.from(shot.data, "base64"));
      console.log("скриншот:", path.join(SHOT_DIR, "duopulse-160-ctx.png"));
    }
    const m1Before = await m1Everywhere();
    const escOk = await menuKeys(panelWs, rowMenu, "{ESC}");
    await sleep(500);
    const m1AfterEsc = await m1Everywhere();
    check(
      "нативное меню строки открылось (попап #32768) и закрылось Escape без последствий (duopulse-189)",
      escOk && (m1Before?.length ?? 0) > 0 && JSON.stringify(m1AfterEsc) === JSON.stringify(m1Before),
      JSON.stringify({ menu: escOk, before: m1Before, after: m1AfterEsc }),
    );

    const groupsBefore = await uiWs.evalT(`${H}.groupList()`, 4000);
    const known = new Set((Array.isArray(groupsBefore?.groups) ? groupsBefore.groups : []).map((g) => g.id));
    // 1-й пункт — «Создать раздел…» (duopulse-173): подгруппа в открытой папке
    const sectionKeys = await menuKeys(panelWs, rowMenu, "{DOWN}{ENTER}");
    let section = null;
    if (sectionKeys) {
      section = await waitFor(
        () =>
          uiWs
            .evalT(`${H}.groupList()`, 4000)
            .then((r) =>
              r && r !== "EVAL-TIMEOUT" && Array.isArray(r.groups)
                ? (r.groups.find((g) => g.parentId === media.id && !known.has(g.id)) ?? null)
                : null,
            ),
        6000,
      );
      await sleep(600); // панель перерисовалась и открыла инлайн-правку имени
    }
    await sendKeys("{ESC}"); // инлайн-правка имени раздела — остаётся «Новый раздел»
    check(
      "1-й пункт — «Создать раздел…»: подгруппа внутри «Медиа» (duopulse-173)",
      !!section,
      JSON.stringify(section ? { name: section.name, parent: section.parentId, depth: section.depth } : { menu: sectionKeys }),
    );

    // 3-й пункт — «Удалить закладку» (разделитель после «Создать раздел…»
    // клавиатура пропускает: два DOWN — «Переименовать…», три — удаление):
    // M1 уходит из всех групп, строки панели нет
    const deleteKeys = await menuKeys(panelWs, rowMenu, "{DOWN}{DOWN}{DOWN}{ENTER}");
    let m1Gone = null;
    if (deleteKeys) {
      m1Gone = await waitFor(async () => {
        const urls = await m1Everywhere();
        return urls && urls.length === 0 ? urls : null;
      }, 8000);
    }
    if (!m1Gone) await sendKeys("{ESC}"); // фокус ушёл между гейтом и клавишами
    const rowGone = m1Gone
      ? await panelWs.evalT(`!document.querySelector('.bm-row[data-url="https://m1.example/"]')`, 4000)
      : false;
    check(
      "3-й пункт — «Удалить закладку»: M1 удалена из всех групп, строки панели нет",
      !!m1Gone && rowGone === true,
      JSON.stringify({ menu: deleteKeys, urls: m1Gone, row: rowGone }),
    );

    // --- 6. внешний drop в открытую панель: E из «Избранного» → «Медиа» ------
    step("внешний drop E в тело панели «Медиа»");
    const pDrop = await panelWs.evalIn(`(() => {
      const host = document.getElementById('bmFolder');
      const r = host.getBoundingClientRect();
      const dt = new DataTransfer();
      dt.setData('application/x-duopulse-bm', ${JSON.stringify(JSON.stringify({ url: "https://e.example/", group: def.id }))});
      dt.setData('text/plain', 'https://e.example/');
      host.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 30, clientY: r.top + r.height - 8 }));
      host.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 30, clientY: r.top + r.height - 8 }));
      return 'ok';
    })()`);
    await sleep(1200);
    const ml = await uiWs.evalIn(`${H}.bookmarkList(${JSON.stringify({ query: null, groupId: media.id, offset: 0, limit: 50 })})`);
    const dl3 = await uiWs.evalIn(`${H}.bookmarkList(${JSON.stringify({ query: null, groupId: def.id, offset: 0, limit: 50 })})`);
    check(
      "E переложена в «Медиа» дропом в панель (из «Избранного» ушла)",
      pDrop === "ok" && ml.bookmarks.some((b) => b.url === "https://e.example/") && !dl3.bookmarks.some((b) => b.url === "https://e.example/"),
      JSON.stringify({ drop: pDrop, media: ml.bookmarks.map((b) => b.url), def: dl3.bookmarks.length }),
    );
  }

  // --- 7. папка «Тест»: позиция меню у курсора + «Удалить группу» (163) -------
  step("правый клик по папке «Тест»: меню у курсора, «Удалить группу»");
  // гигиена: панель папки закрываем тумблером, висящие попапы — ESC
  await uiWs
    .evalT(
      `(() => { const f = [...document.querySelectorAll('#bmbar .bm-folder')].find(x => x.querySelector('.bm-label')?.textContent === 'Медиа'); f?.click(); return 'ok'; })()`,
      4000,
    )
    .catch(() => {});
  await sendKeys("{ESC}");
  await sleep(600);
  // точка клика: физические экранные = клиентные × dpr + клиент-ноль окна
  // (ClientToScreen по hwnd; screenX/screenY вебвью врёт на смешанных DPI)
  const probe = await uiWs.evalT(`(() => {
    const f = [...document.querySelectorAll('#bmbar .bm-folder')].find(x => x.querySelector('.bm-label')?.textContent === 'Тест');
    if (!f) return null;
    const r = f.getBoundingClientRect();
    return { x: r.left + 20, y: r.top + r.height / 2, dpr: window.devicePixelRatio };
  })()`, 4000);
  check("папка «Тест» на строке (зонд точки клика)", !!probe, JSON.stringify(probe));
  const dispatchExpr = `(() => {
    const f = [...document.querySelectorAll('#bmbar .bm-folder')].find(x => x.querySelector('.bm-label')?.textContent === 'Тест');
    if (!f) return 'no-folder';
    f.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${probe ? probe.x : 0}, clientY: ${probe ? probe.y : 0} }));
    return 'ok';
  })()`;
  // замер позиции: ретраи — машина Артёма живая, Aila перетягивает
  // foreground, а попап НЕ-foreground окна Windows закрывает мгновенно
  // (no-popup при живом фиксе); замер — с короткой паузой, потом ESC
  const psRect = () =>
    run("powershell", [
      "-NoProfile",
      "-Command",
      `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public class MP {
  public static List<long> Found = new List<long>();
  public static long Main = 0;
  static uint Target;
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  public struct RECT { public int L; public int T; public int R; public int B; }
  public struct POINT { public int X; public int Y; }
  static bool Cb(IntPtr h, IntPtr l) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    if (pid == Target) {
      var sb = new StringBuilder(64);
      GetClassName(h, sb, 64);
      if (sb.ToString() == "#32768") Found.Add(h.ToInt64());
      if (sb.ToString() == "Tauri Window") Main = h.ToInt64();
    }
    return true;
  }
  public static void FindMenus(uint pid) { Target = pid; Found.Clear(); Main = 0; EnumWindows(Cb, IntPtr.Zero); }
}
"@
$proc = Get-CimInstance Win32_Process -Filter "Name='duopulse.exe'" |
  Where-Object { $_.ExecutablePath -eq '${EXE_PS}' } | Select-Object -First 1
$p = Get-Process -Id $proc.ProcessId -ErrorAction Stop
# hwnd и попап ищем EnumWindows: Get-Process MainWindowHandle у окна Tauri
# бывает IntPtr.Zero (окно не foreground) — тогда ClientToScreen даёт (0,0);
# попап #32768 — только среди окон НАШЕГО процесса (FindWindow глобален и на
# живой машине ловит чужие меню, например Aila)
[MP]::FindMenus($p.Id)
if ([MP]::Main -eq 0) { "no-hwnd" } else {
$pt = New-Object MP+POINT
[MP]::ClientToScreen([IntPtr][MP]::Main, [ref]$pt) | Out-Null
$origin = "$($pt.X),$($pt.Y)"
if ([MP]::Found.Count -eq 0) { "no-popup origin=$origin" } else {
  $r = New-Object MP+RECT
  [MP]::GetWindowRect([IntPtr][MP]::Found[0], [ref]$r) | Out-Null
  "$($r.L),$($r.T) origin=$origin"
}
}
`,
    ]).catch((e) => "ps-error " + String(e).slice(0, 80));
  let menuAtCursor = false;
  let menuInfo = "";
  if (probe) {
    for (let attempt = 0; attempt < 4 && !menuInfo; attempt++) {
      await foregroundApp();
      await uiWs.evalT(dispatchExpr, 2500).catch(() => {});
      await sleep(800);
      const r = String(await psRect()).trim();
      const om = /origin=(-?\d+),(-?\d+)/.exec(r);
      if (om && /^-?\d+,-?\d+ /.test(r)) {
        const [ml, mt] = r.split(" ")[0].split(",").map(Number);
        // ожидание — БЕЗ devicePixelRatio: muda делает to_physical по
        // hwnd_dpi процесса (DPI-контекст хоста 1.0 при webview dpr 1.25),
        // т.е. попап приходит в клиентскую точку clientX/clientY как есть
        const ex = Number(om[1]) + Math.round(probe.x);
        const ey = Number(om[2]) + Math.round(probe.y);
        menuInfo = `${r} клик=${ex},${ey}`;
        // TrackPopupMenu ставит верхний левый угол попапа в точку клика;
        // допуск 30px — тени/округления ClientToScreen
        menuAtCursor = Math.abs(ml - ex) <= 30 && Math.abs(mt - ey) <= 30;
        await sendKeys("{ESC}"); // замерили — закрываем, удаление отдельно
      } else {
        menuInfo = "";
        await sendKeys("{ESC}"); // попап не пойман (foreground украден) — ретрай
      }
      await sleep(500);
    }
    check(
      "нативное меню открылось У КУРСОРА (не «три сантиметра ниже»)",
      menuAtCursor,
      menuInfo || "попап не пойман за 4 попытки (foreground ворует Aila?)",
    );
    if (!menuAtCursor) {
      const shot = path.join(SHOT_DIR, "duopulse-163-menu-fail.png");
      await run("powershell", [
        "-NoProfile",
        "-Command",
        `Add-Type -AssemblyName System.Windows.Forms;
         Add-Type -AssemblyName System.Drawing;
         $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
         $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height);
         $g = [System.Drawing.Graphics]::FromImage($bmp);
         $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size);
         $bmp.Save('${shot.replaceAll("\\", "/")}');`,
      ]).catch(() => {});
      console.log("диагностика: скриншот", shot);
    }

    // --- 7b. «Удалить группу» (2-й пункт) — отдельное открытие меню ----------
    const testGonePoll = () =>
      uiWs.evalT(`window.__duopulse.history.groupList()`, 4000).then(
        (r) => (r && r !== "EVAL-TIMEOUT" && Array.isArray(r.groups) && !r.groups.some((g) => g.name === "Тест") ? r : null),
      );
    let testGone = null;
    for (let attempt = 0; attempt < 4 && !testGone; attempt++) {
      await foregroundApp();
      await uiWs.evalT(dispatchExpr, 2000).catch(() => {});
      await sleep(700);
      // гейт: клавиши — только по живому попапу (psRect видит его и после
      // полутора секунд PS-запуска: значит окно держит foreground и клавиши
      // попадут в меню, а не в Aila)
      const gate = String(await psRect()).trim();
      if (!/^-?\d+,-?\d+ /.test(gate)) {
        await sendKeys("{ESC}");
        await sleep(500);
        continue;
      }
      await sendKeys("{DOWN}{DOWN}{ENTER}"); // 2-й пункт — «Удалить группу»
      await sleep(800);
      testGone = await waitFor(testGonePoll, 6000);
      if (!testGone) await sendKeys("{ESC}"); // фокус ушёл между гейтом и клавишами — ретрай
    }
    const folderGone = await uiWs.evalT(
      `![...document.querySelectorAll('#bmbar .bm-folder .bm-label')].some(x => x.textContent === 'Тест')`,
      4000,
    );
    check(
      "«Удалить группу» из меню папки: группа «Тест» удалена, папка исчезла",
      !!testGone && folderGone === true,
      JSON.stringify({ gone: !!testGone, folder: folderGone }),
    );
    const others = await uiWs.evalT(
      `window.__duopulse.history.groupList().then(r => r.groups.map(g => g.name).join('|'))`,
      4000,
    );
    check("остальные группы целы (Работа/Медиа/Избранное)", String(others).includes("Работа") && String(others).includes("Медиа"), String(others));
  }

  // --- скриншот бара ----------------------------------------------------------
  const barShot = await uiWs
    .send("Page.captureScreenshot", {
      format: "png",
      clip: await uiWs
        .evalIn(`(() => { const r = document.getElementById('bmbar').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 }; })()`, false)
        .then((c) => c ?? undefined),
    })
    .catch(() => null);
  if (barShot) {
    fs.writeFileSync(path.join(SHOT_DIR, "duopulse-160-bar.png"), Buffer.from(barShot.data, "base64"));
    console.log("скриншот:", path.join(SHOT_DIR, "duopulse-160-bar.png"));
  }
} catch (e) {
  check("стенд завершился без падения", false, String(e));
} finally {
  let appLogText = "";
  try {
    appLogText = fs.readFileSync(path.join(tmp, "app.log"), "utf8").trim();
  } catch { /* лога нет — ок */ }
  try { app.kill(); } catch {}
  try { vite.kill(); } catch {}
  try { httpServer.close(); } catch {}
  await killOurExes();
  fs.rmSync(tmp, { recursive: true, force: true });
  if (appLogText) globalThis.__dp163AppLog = appLogText;
}

if (consoleLog.length) {
  console.log("\nКонсоль приложения (ошибки):");
  for (const line of consoleLog) console.log("  " + line);
}
const failedAny = results.some((r) => !r.ok);
if (failedAny && globalThis.__dp163AppLog) {
  console.log("\napp.log (хвост):\n  " + globalThis.__dp163AppLog.split("\n").slice(-25).join("\n  "));
}
const failed = results.filter((r) => !r.ok);
console.log(`\nИтог: ${results.length - failed.length}/${results.length} проверок прошло`);
if (failed.length) {
  console.log("Провалены:\n" + failed.map((r) => `  ${r.name}`).join("\n"));
  process.exitCode = 1;
}
