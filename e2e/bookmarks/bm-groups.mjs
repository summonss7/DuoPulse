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
//   5) панель папки «Медиа»: правый клик по строке — HTML мини-меню
//      .bm-ctx («Переименовать…»/«Удалить закладку»), скриншот, клик
//      «Удалить закладку» — закладка удалена;
//   6) внешний drop в ОТКРЫТУЮ панель (тело, не подгруппа): E из
//      «Избранного» переложена в «Медиа».
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
  await foregroundApp();
  await uiWs.evalT(
    `(() => {
      const b = [...document.querySelectorAll('#bmbar .bm-item:not(.bm-folder)')].find(x => x.dataset.url === "https://b.example/");
      if (!b) return 'no-chip';
      const r = b.getBoundingClientRect();
      b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 4, clientY: r.top + 4 }));
      return 'ok';
    })()`,
    4000,
  );
  await sleep(900); // нативный popup открылся (модален — UI-webview может молчать)
  await sendKeys("{DOWN}{DOWN}{ENTER}");
  await sleep(700);
  const bGone = await waitFor(
    () =>
      uiWs.evalT(`window.__duopulse.history.bookmarkList(${JSON.stringify({ query: "b.example", groupId: -1, offset: 0, limit: 10 })})`, 4000).then(
        (r) => (r && r !== "EVAL-TIMEOUT" && r.bookmarks?.length === 0 ? r : null),
      ),
    8000,
  );
  const bChipGone = await uiWs.evalT(
    `!document.querySelector('#bmbar .bm-item[data-url="https://b.example/"]')`,
    4000,
  );
  check(
    "«Удалить» из нативного меню: закладка B удалена, чип исчез",
    !!bGone && bChipGone === true,
    JSON.stringify({ gone: !!bGone, chip: bChipGone }),
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

  // --- 5. панель папки: мини-меню «Удалить закладку» -------------------------
  step("панель «Медиа»: правый клик — мини-меню, удаление закладки");
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
    const rowOk = await waitFor(
      () => panelWs.evalIn(`document.querySelectorAll('.bm-row[data-url]').length`, false).then((n) => (n === 1 ? n : null)),
      10000,
    );
    check("панель: строка «Кино»", rowOk === 1, String(rowOk));
    await panelWs.evalIn(
      `(() => {
        const row = document.querySelector('.bm-row[data-url="https://m1.example/"]');
        const r = row.getBoundingClientRect();
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 30, clientY: r.top + r.height / 2 }));
        return 'ok';
      })()`,
    );
    const ctx = await waitFor(
      () =>
        panelWs.evalIn(`(() => {
          const m = document.querySelector('.bm-ctx');
          if (!m) return null;
          return { items: [...m.querySelectorAll('button')].map((b) => b.textContent) };
        })()`, false).then((v) => v ?? null),
      6000,
    );
    check(
      "мини-меню: «Переименовать…» + «Удалить закладку»",
      !!ctx && ctx.items.length === 2 && ctx.items[0] === "Переименовать…" && ctx.items[1] === "Удалить закладку",
      JSON.stringify(ctx),
    );
    const shot = await panelWs.send("Page.captureScreenshot", { format: "png" }).catch(() => null);
    if (shot) {
      fs.writeFileSync(path.join(SHOT_DIR, "duopulse-160-ctx.png"), Buffer.from(shot.data, "base64"));
      console.log("скриншот:", path.join(SHOT_DIR, "duopulse-160-ctx.png"));
    }
    await panelWs.evalIn(`document.querySelector('.bm-ctx .bm-ctx-danger')?.click()`);
    await sleep(900);
    const m1Gone = await uiWs.evalIn(
      `${H}.bookmarkList(${JSON.stringify({ query: "m1.example", groupId: -1, offset: 0, limit: 10 })})`,
    );
    check(
      "«Удалить закладку» панели: M1 удалена",
      m1Gone.bookmarks?.length === 0,
      JSON.stringify(m1Gone.bookmarks?.map((b) => b.url)),
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
  try { app.kill(); } catch {}
  try { vite.kill(); } catch {}
  try { httpServer.close(); } catch {}
  await killOurExes();
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (consoleLog.length) {
  console.log("\nКонсоль приложения (ошибки):");
  for (const line of consoleLog) console.log("  " + line);
}
const failed = results.filter((r) => !r.ok);
console.log(`\nИтог: ${results.length - failed.length}/${results.length} проверок прошло`);
if (failed.length) {
  console.log("Провалены:\n" + failed.map((r) => `  ${r.name}`).join("\n"));
  process.exitCode = 1;
}
