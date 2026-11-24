// E2E-приёмка duopulse-242 «перетаскивание папок: поставить рядом, вынести
// из вложенности» через CDP в живом приложении (паттерн
// e2e/bookmarks/bm-drag.mjs; изоляция — временный APPDATA, vite dev поднимает
// сам, требует собранного debug-exe). Жалоба Артёма: «хотел перетянуть папку
// левее — зашла внутрь другой, назад не достать». Синтетические dragover/drop
// шлём НА ЦЕЛЕВОЙ ЭЛЕМЕНТ (папка/строка/крошка) — closest() в делегированных
// обработчиках видит цель; дроп «в пустоту» — на сам бар.
//   1) сид: чипы в «Избранном», корневые папки «Работа»/«Медиа», внутри
//      «Работы» подпапки «Документы»/«Заметки», внутри «Документов» —
//      «Отчёты» (глубина 3);
//   2) строка: drag «Медиа» на ЛЕВУЮ ТРЕТЬ «Работы» — маркер drop-before и
//      group_reorder: «Медиа» встала ПЕРЕД «Работой» (регресс жалобы: раньше
//      весь диапазон папки значил «внутрь» — group_move);
//   3) строка: drag «Медиа» на ЦЕНТР «Работы» — подсветка drop-target и
//      group_move: «Медиа» вложена в «Работу»;
//   4) панель «Работы»: подпапки перетаскиваемы — drag «Заметки» на верхнюю
//      треть «Документов» — group_reorder среди подпапок;
//   5) кросс-webview: drag подпапки «Медиа» ИЗ панели на ФОН строки (payload
//      BM_FOLDER_MIME) — group_move в корень: «забрать из вложенности»;
//      панель перерисовалась (dragend), «Медиа» на строке;
//   6) панель «Документов»: drag «Отчёты» на крошку «‹ Работа» — вынос на
//      уровень выше (group_move под «Работу»);
//   7) меню bmsub: правый клик по «Документам» открывает НАСТОЯЩЕЕ нативное
//      меню (перехват invoke невозможен — __TAURI_INTERNALS__.invoke не
//      перезаписываем), пункты читаем через UI Automation и закрываем ESC;
//      выбор «Переместить на уровень выше» эмулируется событием menu-action —
//      «Документы» в корне;
//   8) строка: drag своей папки ПРАВЕЕ последнего пункта — group_reorder
//      в конец ряда (раньше дроп «в пустоту» молча ничего не делал).
// Скриншоты: %TEMP%/duopulse-242-*.png.
// Результат: e2e/bookmarks/bm-drag242-last-run.json (gitignore, рантайм).
//
// Запуск:  node e2e/bookmarks/bm-drag242.mjs [путь-к-duopulse.exe]
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const step = (s) => console.log(`-- шаг: ${s}`);
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const EXE_PS = EXE.replaceAll("/", "\\");
const CDP_PORT = Number(process.env.CDP_PORT || 9235);
const HTTP_PORT = Number(process.env.E2E_242_PORT || 8934);
const SHOT_DIR = process.env.E2E_242_SHOTS || os.tmpdir();
const LAST_RUN = path.join(ROOT, "e2e", "bookmarks", "bm-drag242-last-run.json");
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
  results.push({ name, ok: !!ok, extra });
  console.log(`${ok ? "OK" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

const consoleLog = [];
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

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<html><head><title>Стенд 242 ${req.url}</title></head><body><h1>${req.url}</h1></body></html>`);
});
await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-242-e2e-"));
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
    DUOPULSE_E2E_NO_SINGLE_INSTANCE: "1",
    WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
  },
});

/** Снапшот групп Core: id → {parentId, position}. */
const groupSnap = async (ui, H) => {
  const gl = await ui.evalIn(`${H}.groupList()`);
  const map = new Map();
  for (const g of gl.groups) map.set(g.id, { name: g.name, parentId: g.parentId, position: g.position, isDefault: g.isDefault });
  return map;
};

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
  await waitFor(() => uiWs.evalIn(`document.querySelectorAll('.tab').length > 0 ? 1 : 0`, false), 15000);
  const H = `window.__duopulse.history`;

  // --- 1. сид -----------------------------------------------------------------
  step("сид: чипы, корневые папки, подпапки 2-3 уровней");
  for (const [url, title] of [
    ["https://a.example/", "Альфа"],
    ["https://b.example/", "Бета"],
    ["https://c.example/", "Гамма"],
    ["https://w1.example/", "Задача 1"],
    ["https://w2.example/", "Задача 2"],
  ]) {
    await uiWs.evalIn(`${H}.bookmarkAdd(${JSON.stringify({ url, title, groupId: null })})`);
  }
  const gl0 = await uiWs.evalIn(`${H}.groupList()`);
  const def = gl0.groups.find((g) => g.isDefault);
  const work = await uiWs.evalIn(`${H}.groupAdd(${JSON.stringify({ name: "Работа" })})`);
  const media = await uiWs.evalIn(`${H}.groupAdd(${JSON.stringify({ name: "Медиа" })})`);
  const docs = await uiWs.evalIn(`${H}.groupAdd(${JSON.stringify({ name: "Документы", parentId: work.id })})`);
  const notes = await uiWs.evalIn(`${H}.groupAdd(${JSON.stringify({ name: "Заметки", parentId: work.id })})`);
  const reports = await uiWs.evalIn(`${H}.groupAdd(${JSON.stringify({ name: "Отчёты", parentId: docs.id })})`);
  for (const url of ["https://w1.example/", "https://w2.example/"]) {
    await uiWs.evalIn(`${H}.groupToggleBookmark(${JSON.stringify({ url, groupId: work.id, on: true })})`);
    await uiWs.evalIn(`${H}.groupToggleBookmark(${JSON.stringify({ url, groupId: def.id, on: false })})`);
  }
  await uiWs.evalIn(`window.__duopulse.tabs.open({ url: "duopulse://history" }).then(() => window.__duopulse.tabs.list())`);
  await sleep(1200);
  const barInfo = await waitFor(
    () =>
      uiWs.evalIn(`(() => {
        const folders = [...document.querySelectorAll('#bmbar .bm-folder .bm-label')].map(x => x.textContent);
        return folders.includes('Работа') && folders.includes('Медиа') ? folders : null;
      })()`, false).then((v) => v ?? null),
    10000,
  );
  check("бар: папки «Работа» и «Медиа» на строке", !!barInfo, JSON.stringify(barInfo));

  /** Синтетический drag ПАПКИ строки: события НА цель (closest видит папку). */
  const dragFolder = (folderId, targetId, x, y) =>
    uiWs.evalIn(`(() => {
      const bar = document.getElementById('bmbar');
      const m = [...bar.querySelectorAll('.bm-folder')].find(x => x.dataset.folder === String(${folderId}));
      const t = [...bar.querySelectorAll('.bm-folder')].find(x => x.dataset.folder === String(${targetId}));
      if (!m || !t) return 'no-targets';
      const dt = new DataTransfer();
      m.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      t.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: ${x}, clientY: ${y} }));
      const afford = t.classList.contains('drop-before') ? 'before' : t.classList.contains('drop-after') ? 'after' : t.classList.contains('drop-target') ? 'into' : 'none';
      t.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: ${x}, clientY: ${y} }));
      m.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      return afford;
    })()`, false);
  const folderRect = (folderId) =>
    uiWs.evalIn(`(() => {
      const t = [...document.querySelectorAll('#bmbar .bm-folder')].find(x => x.dataset.folder === String(${folderId}));
      if (!t) return null;
      const r = t.getBoundingClientRect();
      return { left: r.left, width: r.width, top: r.top + r.height / 2 };
    })()`, false);

  // --- 2. строка: левая треть = «рядом слева» (регресс жалобы) ----------------
  step("строка: drag «Медиа» на левую треть «Работы» — рядом, НЕ внутрь");
  const wr = await folderRect(work.id);
  const afford2 = await dragFolder(media.id, work.id, Math.round(wr.left + wr.width * 0.1), wr.top);
  await sleep(1200);
  const snap2 = await groupSnap(uiWs, H);
  check(
    "левая треть: маркер drop-before, group_reorder — «Медиа» ПЕРЕД «Работой», не вложена",
    afford2 === "before" &&
      snap2.get(media.id).parentId === null &&
      snap2.get(media.id).position < snap2.get(work.id).position,
    JSON.stringify({ afford: afford2, media: snap2.get(media.id), work: snap2.get(work.id) }),
  );

  // --- 3. строка: центр = «внутрь» ----------------------------------------------
  step("строка: drag «Медиа» на центр «Работы» — вложение");
  const wr3 = await folderRect(work.id); // ре-рендер после шага 2 сдвинул папку
  const afford3 = await dragFolder(media.id, work.id, Math.round(wr3.left + wr3.width / 2), wr3.top);
  await sleep(1200);
  const snap3 = await groupSnap(uiWs, H);
  check(
    "центр: подсветка drop-target, group_move — «Медиа» внутри «Работы»",
    afford3 === "into" && snap3.get(media.id).parentId === work.id,
    JSON.stringify({ afford: afford3, media: snap3.get(media.id) }),
  );

  // --- 4. панель «Работы»: перестановка подпапок краевой зоной ------------------
  step("панель «Работы»: drag «Заметки» на верхнюю треть «Документов»");
  await uiWs.evalIn(`(() => {
    const w = [...document.querySelectorAll('#bmbar .bm-folder')].find(x => x.dataset.folder === String(${work.id}));
    w?.click();
    return 'ok';
  })()`, false);
  const panelT = await waitFor(async () => {
    try {
      const list = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
      return list.find((t) => t.type === "page" && /panel=bmfolder/.test(t.url)) ?? null;
    } catch {
      return null;
    }
  }, 15000);
  check("панель-webview bmfolder открылась", !!panelT, panelT?.url ?? "не дождались");
  let panelWs = panelT ? connect(panelT.webSocketDebuggerUrl) : null;
  if (panelWs) await panelWs.send("Runtime.enable").catch(() => {});
  if (panelWs) {
    await waitFor(
      () =>
        panelWs.evalIn(`(() => {
          const subs = [...document.querySelectorAll('.bm-row.bm-sub .bm-label')].map(x => x.textContent);
          return subs.includes('Документы') && subs.includes('Заметки') && subs.includes('Медиа') ? subs : null;
        })()`, false).then((v) => v ?? null),
      12000,
    );
    const subOrder = await panelWs.evalIn(`(() => {
      const host = document.getElementById('bmFolder');
      const notes = [...host.querySelectorAll('.bm-sub')].find(x => x.dataset.sub === String(${notes.id}));
      const docs = [...host.querySelectorAll('.bm-sub')].find(x => x.dataset.sub === String(${docs.id}));
      if (!notes || !docs) return 'no-targets';
      const r = docs.getBoundingClientRect();
      const dt = new DataTransfer();
      notes.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      docs.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 4, clientY: Math.round(r.top + r.height * 0.1) }));
      const afford = docs.classList.contains('drop-before') ? 'before' : docs.classList.contains('drop-target') ? 'into' : 'none';
      docs.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 4, clientY: Math.round(r.top + r.height * 0.1) }));
      notes.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      return afford;
    })()`, false);
    await sleep(1200);
    const snap4 = await groupSnap(uiWs, H);
    check(
      "верхняя треть подпапки: маркер drop-before, group_reorder — «Заметки» перед «Документами»",
      subOrder === "before" && snap4.get(notes.id).position < snap4.get(docs.id).position,
      JSON.stringify({ afford: subOrder, notes: snap4.get(notes.id), docs: snap4.get(docs.id) }),
    );

    // --- 5. кросс-webview: подпапка из панели на ФОН строки = вынос -----------
    step("кросс-webview: drag «Медиа» из панели на фон строки — вынос в корень");
    const lastBar = await uiWs.evalIn(`(() => {
      const items = [...document.querySelectorAll('#bmbar .bm-item')];
      const r = items[items.length - 1].getBoundingClientRect();
      return { x: Math.round(r.right + 30), y: Math.round(r.top + r.height / 2) };
    })()`, false);
    // dragstart — в панели (источник), dragover/drop — в строке со своим
    // DataTransfer, несущим payload BM_FOLDER_MIME (эмуляция OLE-drag)
    await panelWs.evalIn(`(() => {
      const host = document.getElementById('bmFolder');
      const sub = [...host.querySelectorAll('.bm-sub')].find(x => x.dataset.sub === String(${media.id}));
      if (!sub) return 'no-sub';
      const dt = new DataTransfer();
      sub.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      return 'ok';
    })()`, false);
    const cross = await uiWs.evalIn(`(() => {
      const bar = document.getElementById('bmbar');
      const dt = new DataTransfer();
      dt.setData('application/x-duopulse-bm-folder', ${JSON.stringify(JSON.stringify({ folder: media.id }))});
      bar.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: ${lastBar.x}, clientY: ${lastBar.y} }));
      bar.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: ${lastBar.x}, clientY: ${lastBar.y} }));
      return 'ok';
    })()`, false);
    await panelWs.evalIn(`(() => {
      document.getElementById('bmFolder').dispatchEvent(new DragEvent('dragend', { bubbles: true }));
      return 'ok';
    })()`, false);
    await sleep(1500);
    const snap5 = await groupSnap(uiWs, H);
    const panelNoMedia = await panelWs.evalIn(
      `(() => [...document.querySelectorAll('.bm-row.bm-sub')].some(x => x.dataset.sub === String(${media.id})) ? 1 : 0)()`,
      false,
    );
    check(
      "дроп на фон строки: group_move в корень; панель перерисовалась (dragend)",
      cross === "ok" && snap5.get(media.id).parentId === null && panelNoMedia === 0,
      JSON.stringify({ cross, media: snap5.get(media.id), panelStillHasMedia: panelNoMedia }),
    );

    // --- 6. панель «Документов»: крошка «‹ Работа» — вынос на уровень выше ----
    step("панель «Документов»: drag «Отчёты» на крошку — на уровень выше");
    await panelWs.evalIn(`(() => {
      const host = document.getElementById('bmFolder');
      const docs = [...host.querySelectorAll('.bm-sub')].find(x => x.dataset.sub === String(${docs.id}));
      docs?.click();
      return 'ok';
    })()`, false);
    await waitFor(
      () =>
        panelWs.evalIn(`(() => [...document.querySelectorAll('.bm-row.bm-sub')].some(x => x.dataset.sub === String(${reports.id})) ? 1 : null)()`, false).then((v) => v ?? null),
      12000,
    );
    const crumb = await panelWs.evalIn(`(() => {
      const host = document.getElementById('bmFolder');
      const back = host.querySelector('.bm-row.bm-back');
      const rep = [...host.querySelectorAll('.bm-sub')].find(x => x.dataset.sub === String(${reports.id}));
      if (!back || !rep) return 'no-targets';
      const dt = new DataTransfer();
      rep.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      back.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 10, clientY: 10 }));
      const afford = back.classList.contains('drop-target') ? 'into' : 'none';
      back.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 10, clientY: 10 }));
      rep.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      return afford;
    })()`, false);
    await sleep(1200);
    const snap6 = await groupSnap(uiWs, H);
    check(
      "крошка «‹ Работа»: подсветка, group_move — «Отчёты» под «Работой» (уровень выше)",
      crumb === "into" && snap6.get(reports.id).parentId === work.id,
      JSON.stringify({ afford: crumb, reports: snap6.get(reports.id) }),
    );

    // --- 7. меню bmsub: правый клик + «Переместить на уровень выше» -----------
    step("меню bmsub: правый клик по «Документам», выбор «на уровень выше»");
    // вернулись в панель «Работы» (крошка «‹ Работа»)
    await panelWs.evalIn(`(() => {
      const host = document.getElementById('bmFolder');
      const back = host.querySelector('.bm-row.bm-back');
      back?.click();
      return 'ok';
    })()`, false);
    await waitFor(
      () =>
        panelWs.evalIn(`(() => [...document.querySelectorAll('.bm-row.bm-sub')].some(x => x.dataset.sub === String(${docs.id})) ? 1 : null)()`, false).then((v) => v ?? null),
      12000,
    );
    // Нативное меню открываем по-настоящему: пункт ui_menu_open не перехватить
    // (window.__TAURI_INTERNALS__.invoke НЕперезаписываем, проверено пробником),
    // сам факт меню ловим окном #32768 у нашего pid (e2e/bookmarks/dp242-menu.ps1,
    // EnumWindows; битый kind Core бы отклонил — меню бы не открылось), закрываем
    // PostMessage-ESC (SendKeys не долетает — окно может быть не на переднем плане)
    const menuOpened = await panelWs.evalIn(`(() => {
      const host = document.getElementById('bmFolder');
      const docs = [...host.querySelectorAll('.bm-sub')].find(x => x.dataset.sub === String(${docs.id}));
      if (!docs) return 'no-targets';
      const r = docs.getBoundingClientRect();
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + 4), clientY: Math.round(r.top + 4) });
      docs.dispatchEvent(ev);
      return ev.defaultPrevented ? 'ok' : 'not-prevented';
    })()`, false);
    await sleep(1200); // popup материализуется в отдельном потоке
    const MENU_PS = path.join(ROOT, "e2e", "bookmarks", "dp242-menu.ps1");
    const menuWin = await run("powershell", [
      "-NoProfile",
      "-File",
      MENU_PS,
      "-ProcId",
      String(app.pid),
      "-Mode",
      "items",
    ]).catch(() => "");
    await run("powershell", ["-NoProfile", "-File", MENU_PS, "-ProcId", String(app.pid), "-Mode", "close"]).catch(() => {});
    await sleep(600);
    const menuGone = await run("powershell", [
      "-NoProfile",
      "-File",
      MENU_PS,
      "-ProcId",
      String(app.pid),
      "-Mode",
      "items",
    ]).catch(() => "");
    check(
      "нативное меню bmsub открылось (#32768) и закрылось по ESC",
      menuOpened === "ok" && String(menuWin).includes("MENU hwnd") && String(menuGone).includes("NO-MENU-WINDOW"),
      JSON.stringify({ menuOpened, menuWin: String(menuWin).trim(), menuGone: String(menuGone).trim() }),
    );
    // выбор «Переместить на уровень выше» — событием menu-action (как Core)
    await panelWs.evalIn(
      `window.__TAURI_INTERNALS__.invoke('plugin:event|emit', ${JSON.stringify({
        event: "menu-action",
        payload: { menu: "bmsub", act: "up", groupId: docs.id },
      })})`,
    );
    await sleep(1200);
    const snap7 = await groupSnap(uiWs, H);
    const panelNoDocs = await panelWs.evalIn(
      `(() => [...document.querySelectorAll('.bm-row.bm-sub')].some(x => x.dataset.sub === String(${docs.id})) ? 1 : 0)()`,
      false,
    );
    check(
      "«Переместить на уровень выше»: group_move в корень, строка ушла из панели",
      snap7.get(docs.id).parentId === null && panelNoDocs === 0,
      JSON.stringify({ docs: snap7.get(docs.id), panelStillHasDocs: panelNoDocs }),
    );

    // скриншот панели (красота строк подпапок)
    const shot = await panelWs.send("Page.captureScreenshot", { format: "png" }).catch(() => null);
    if (shot) {
      fs.writeFileSync(path.join(SHOT_DIR, "duopulse-242-panel.png"), Buffer.from(shot.data, "base64"));
      console.log("скриншот:", path.join(SHOT_DIR, "duopulse-242-panel.png"));
    }
  }

  // --- 8. строка: дроп ПРАВЕЕ последнего пункта — в конец ряда ------------------
  step("строка: drag «Медиа» на левую треть «Работы», затем правее последнего — в конец");
  const wr8 = await folderRect(work.id);
  await dragFolder(media.id, work.id, Math.round(wr8.left + wr8.width * 0.1), wr8.top);
  await sleep(1200);
  const snap8a = await groupSnap(uiWs, H);
  const lastBar8 = await uiWs.evalIn(`(() => {
    const items = [...document.querySelectorAll('#bmbar .bm-item')];
    const r = items[items.length - 1].getBoundingClientRect();
    return { x: Math.round(r.right + 30), y: Math.round(r.top + r.height / 2) };
  })()`, false);
  const drop8 = await uiWs.evalIn(`(() => {
    const bar = document.getElementById('bmbar');
    const m = [...bar.querySelectorAll('.bm-folder')].find(x => x.dataset.folder === String(${media.id}));
    if (!m) return 'no-targets';
    const dt = new DataTransfer();
    m.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    bar.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: ${lastBar8.x}, clientY: ${lastBar8.y} }));
    bar.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: ${lastBar8.x}, clientY: ${lastBar8.y} }));
    m.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return 'ok';
  })()`, false);
  await sleep(1200);
  const snap8 = await groupSnap(uiWs, H);
  const roots = [...snap8.values()].filter((g) => !g.isDefault && g.parentId === null);
  const mediaLast = snap8.get(media.id).position >= Math.max(...roots.filter((g) => g.name !== "Медиа").map((g) => g.position));
  check(
    "дроп правее последнего: group_reorder в конец (Медиа — последняя из корневых)",
    drop8 === "ok" &&
      snap8a.get(media.id).position < snap8a.get(work.id).position &&
      mediaLast,
    JSON.stringify({ drop: drop8, media: snap8.get(media.id) }),
  );

  // --- скриншот бара ------------------------------------------------------------
  const barShot = await uiWs
    .send("Page.captureScreenshot", {
      format: "png",
      clip: await uiWs
        .evalIn(`(() => { const r = document.getElementById('bmbar').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 }; })()`, false)
        .then((c) => c ?? undefined),
    })
    .catch(() => null);
  if (barShot) {
    fs.writeFileSync(path.join(SHOT_DIR, "duopulse-242-bar.png"), Buffer.from(barShot.data, "base64"));
    console.log("скриншот:", path.join(SHOT_DIR, "duopulse-242-bar.png"));
  }
} catch (e) {
  check("стенд завершился без падения", false, String(e));
} finally {
  // чистим ДЕРЕВО: vite.kill() (npm-shell) оставляет сиротой node/vite на
  // 5173 (грабли duopulse-239), app.kill() — webview2-процессы, держащие
  // файлы профиля (EPERM на rmSync); паузы/ретраи на отпускание файлов
  try { app.kill(); } catch {}
  try { vite.kill(); } catch {}
  try { httpServer.close(); } catch {}
  await killOurExes();
  await run("taskkill", ["/PID", String(vite.pid), "/T", "/F"]).catch(() => {});
  await run("taskkill", ["/PID", String(app.pid), "/T", "/F"]).catch(() => {});
  await sleep(800);
  for (let i = 0; i < 3; i++) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
      break;
    } catch {
      await sleep(700);
    }
  }
}

if (consoleLog.length) {
  console.log("\nКонсоль приложения (ошибки):");
  for (const line of consoleLog) console.log("  " + line);
}
const failed = results.filter((r) => !r.ok);
console.log(`\nИтог: ${results.length - failed.length}/${results.length} проверок прошло`);
fs.writeFileSync(
  LAST_RUN,
  JSON.stringify({ when: new Date().toISOString(), results, consoleErrors: consoleLog }, null, 2),
);
if (failed.length) {
  console.log("Провалены:\n" + failed.map((r) => `  ${r.name} — ${r.extra}`).join("\n"));
  process.exitCode = 1;
}
