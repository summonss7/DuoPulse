// E2E-приёмка карточки duopulse-058 «Группы избранного» через CDP в живом
// приложении (паттерн e2e/omnibox/run.mjs; изоляция — временный APPDATA).
//   1) данные: bookmark_add с группой/без, group_list (счётчики, default),
//      group_rename/group_set_sort/group_toggle_bookmark (несколько групп,
//      «без группы»), bookmark_move (позиции manual), bookmark_list с
//      groupId (null/-1/id) и search с метками групп («Имя · Имя»);
//   2) мини-меню звёздочки навбара на внешней странице: список групп,
//      «Новая группа…», добавление в выбранную группу;
//   3) omnibox: пустой фокус — подсказки-закладки с «группа · url» в подписи;
//   4) страница управления duopulse://history: чипы «Все/Избранное/Проекты/
//      Без группы/+», выбор группы, меню папки (членства ✓), drag&drop
//      порядка (синтетические DragEvent — слушатели DOM-уровня), «+» с
//      инлайн-инпутом, удаление группы.
// Скриншот секции закладок — e2e/bookmarks/manager-groups.png (гайд 06).
//
// Запуск:  node e2e/bookmarks/run.mjs [путь-к-duopulse.exe]
// Требует собранный debug-exe (cargo build); vite dev поднимает сам.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const CDP_PORT = Number(process.env.CDP_PORT || 9226);
// 8899 занят сервисом Aila (см. e2e/omnibox/run.mjs)
const HTTP_PORT = Number(process.env.E2E_BOOKMARKS_PORT || 8897);

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
        consoleLog.push(
          "[ui] EXC: " + JSON.stringify(m.params.exceptionDetails.exception ?? {}).slice(0, 300),
        );
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
    send("Runtime.evaluate", {
      expression: expr,
      awaitPromise,
      returnByValue: true,
    }).then((r) => r?.result?.value);
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

// --- 1. локальный http-стенд (внешняя страница для звёздочки) -----------------
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(
    `<html><head><title>Стенд 058 ${req.url}</title></head><body><h1>${req.url}</h1></body></html>`,
  );
});
await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-058-e2e-"));

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
  await waitFor(
    () => uiWs.evalIn(`document.querySelectorAll('.tab').length > 0 ? 1 : 0`, false),
    15000,
  );

  const H = `window.__duopulse.history`;

  // --- 3. данные: сид и CRUD групп -------------------------------------------
  // закладки в «Избранное» (null-группа = по умолчанию) — как Ctrl+D
  for (const [url, title] of [
    ["https://w.example/", "Википедия"],
    ["https://g.example/", "GitHub"],
    ["https://m.example/", "mdn"],
  ]) {
    await uiWs.evalIn(`${H}.bookmarkAdd(${JSON.stringify({ url, title, groupId: null })})`);
  }
  const fav0 = await uiWs.evalIn(`${H}.groupList()`);
  const FAV_ID = fav0.groups[0].id;
  check(
    "группа по умолчанию «Избранное» создана миграцией (3 закладки)",
    fav0.groups.length === 1 && fav0.groups[0].isDefault && fav0.groups[0].count === 3,
    JSON.stringify(fav0.groups),
  );

  const work = await uiWs.evalIn(`${H}.groupAdd({ name: "Работа" })`);
  const WORK_ID = work.id;
  check("group_add создал «Работа»", work?.name === "Работа" && WORK_ID > 0, JSON.stringify(work));
  const dup = await uiWs.evalIn(`${H}.groupAdd({ name: "Работа" })`).catch((e) => String(e));
  check("дубликат имени — ошибка", typeof dup === "string" && dup.includes("уже есть"), String(dup));

  await uiWs.evalIn(
    `${H}.groupToggleBookmark(${JSON.stringify({ url: "https://g.example/", groupId: WORK_ID, on: true })})`,
  );
  await uiWs.evalIn(
    `${H}.groupToggleBookmark(${JSON.stringify({ url: "https://m.example/", groupId: WORK_ID, on: true })})`,
  );
  const listAll = await uiWs.evalIn(
    `${H}.bookmarkList(${JSON.stringify({ query: null, offset: 0, limit: 100 })})`,
  );
  const gRow = listAll.bookmarks.find((b) => b.url === "https://g.example/");
  const mRow = listAll.bookmarks.find((b) => b.url === "https://m.example/");
  check(
    "строки несут членства (g и m — в 2 группах)",
    gRow?.groups?.length === 2 && mRow?.groups?.length === 2,
    JSON.stringify({ g: gRow?.groups, m: mRow?.groups }),
  );

  const inWork = await uiWs.evalIn(
    `${H}.bookmarkList(${JSON.stringify({ query: null, groupId: WORK_ID, offset: 0, limit: 100 })})`,
  );
  check("фильтр groupId — члены «Работа»", inWork.total === 2, String(inWork.total));

  // manual-порядок: вставка шла g→m; перенос m наверх
  await uiWs.evalIn(
    `${H}.bookmarkMove(${JSON.stringify({ url: "https://m.example/", groupId: WORK_ID, position: 0 })})`,
  );
  const moved = await uiWs.evalIn(
    `${H}.bookmarkList(${JSON.stringify({ query: null, groupId: WORK_ID, offset: 0, limit: 100 })})`,
  );
  check(
    "bookmark_move: m наверх в manual-порядке",
    moved.bookmarks[0].url === "https://m.example/",
    JSON.stringify(moved.bookmarks.map((b) => b.url)),
  );
  await uiWs.evalIn(`${H}.groupSetSort(${JSON.stringify({ id: WORK_ID, sortBy: "title" })})`);
  const byTitle = await uiWs.evalIn(
    `${H}.bookmarkList(${JSON.stringify({ query: null, groupId: WORK_ID, offset: 0, limit: 100 })})`,
  );
  check(
    "group_set_sort=«по имени»: GitHub < mdn",
    byTitle.bookmarks.map((b) => b.url).join() === "https://g.example/,https://m.example/",
    JSON.stringify(byTitle.bookmarks.map((b) => b.url)),
  );
  // обратно в «вручную» (dnd-секция ниже) и m — «без группы»
  await uiWs.evalIn(`${H}.groupSetSort(${JSON.stringify({ id: WORK_ID, sortBy: "manual" })})`);
  await uiWs.evalIn(
    `${H}.groupToggleBookmark(${JSON.stringify({ url: "https://m.example/", groupId: FAV_ID, on: false })})`,
  );
  await uiWs.evalIn(
    `${H}.groupToggleBookmark(${JSON.stringify({ url: "https://m.example/", groupId: WORK_ID, on: false })})`,
  );
  const ungrouped = await uiWs.evalIn(
    `${H}.bookmarkList(${JSON.stringify({ query: null, groupId: -1, offset: 0, limit: 100 })})`,
  );
  check(
    "снятие всех членств → фильтр -1 «без группы»",
    ungrouped.total === 1 && ungrouped.bookmarks[0].url === "https://m.example/",
    JSON.stringify(ungrouped),
  );

  const hits = await uiWs.evalIn(`${H}.search(${JSON.stringify({ query: "", limit: 8 })})`);
  const gHit = hits.hits.find((h) => h.url === "https://g.example/");
  check(
    "omnibox-подсказка закладки несёт группы «Избранное · Работа»",
    gHit?.group === "Избранное · Работа",
    JSON.stringify(gHit),
  );

  await uiWs.evalIn(`${H}.groupRename(${JSON.stringify({ id: WORK_ID, name: "Проекты" })})`);

  // --- 4. меню звёздочки на внешней странице ---------------------------------
  // Карточка duopulse-086: меню нативное (popup muda поверх контентных
  // webview — DOM-меню под страницей не было видно), из CDP не кликается:
  // выбор группы эмулируем событием «menu-action» (тот же вид, что шлёт
  // Core из on_menu_event).
  await uiWs.evalIn(`document.getElementById('omnibox').blur()`);
  const starHidden = await uiWs.evalIn(`document.getElementById('starBtn').hidden`, false);
  check("звёздочка видна на внешней странице", starHidden === false, String(starHidden));
  // добавление текущей страницы стенд в «Проекты»
  await uiWs.evalIn(
    `window.__TAURI_INTERNALS__.invoke('plugin:event|emit', ${JSON.stringify({
      event: "menu-action",
      payload: { menu: "star", groupId: WORK_ID },
    })})`,
  );
  const starred = await waitFor(
    () =>
      uiWs.evalIn(
        `(() => { const v = document.getElementById('starBtn').dataset.on; return v === 'true' ? v : null; })()`,
        false,
      ),
    6000,
  );
  const startMark = await uiWs.evalIn(
    `${H}.bookmarkList(${JSON.stringify({ query: null, offset: 0, limit: 100 })})`,
  );
  const startRow = startMark.bookmarks.find((b) => b.url.includes(":" + HTTP_PORT + "/start"));
  check(
    "звёздочка добавила страницу в выбранную группу «Проекты»",
    starred === "true" && startRow?.groups?.some((g) => g.name === "Проекты"),
    JSON.stringify({ starred, groups: startRow?.groups }),
  );

  // omnibox: подсказки с группой в подписи (рендер) — пользователь очистил
  // ввод (пустой запрос = закладки); value+input-событие, паттерн e2e/omnibox
  const omniboxDiag = await uiWs.evalIn(`(async () => {
    const omnibox = document.getElementById('omnibox');
    omnibox.focus();
    omnibox.value = '';
    omnibox.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 900));
    return {
      active: document.activeElement?.id ?? "",
      panelHidden: document.getElementById('suggest').hidden,
      items: document.querySelectorAll('.suggest-item').length,
    };
  })()`);
  const subs = await waitFor(
    () =>
      uiWs
        .evalIn(`(() => { const a = [...document.querySelectorAll('.suggest-item .sub')].map(e => e.textContent); return a.length ? a : null; })()`, false)
        .then((v) => v ?? null),
    6000,
  );
  check(
    "дропдаун omnibox: подпись закладки с группой",
    !!subs && subs.some((s) => s.includes("Избранное · ") || s.includes("Проекты · ")),
    JSON.stringify({ diag: omniboxDiag, subs }),
  );

  // --- 5. страница управления: чипы, меню папки, dnd, «+» --------------------
  await uiWs.evalIn(`document.getElementById('omnibox').blur()`);
  await uiWs.evalIn(`window.__duopulse.tabs.open({ url: "duopulse://history" })`);
  const mgrTarget = await waitFor(async () => {
    const list = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
    const pages = list.filter((t) => t.type === "page" && /localhost:5173/.test(t.url));
    return pages.length >= 2
      ? pages.find((p) => p.webSocketDebuggerUrl !== ui.webSocketDebuggerUrl)
      : null;
  }, 20000);
  check("duopulse://history открыт", !!mgrTarget, mgrTarget?.url ?? "не дождались");
  if (mgrTarget) {
    const mgr = connect(mgrTarget.webSocketDebuggerUrl);
    await mgr.send("Runtime.enable").catch(() => {});

    // секция «Закладки» — после полной инициализации страницы (.mgr-tab есть)
    await waitFor(
      () =>
        mgr.evalIn(`(() => document.querySelectorAll('.mgr-tab').length >= 2 ? 1 : null)()`, false),
      10000,
    );
    await mgr.evalIn(`[...document.querySelectorAll('.mgr-tab')].find(b => b.textContent === 'Закладки')?.click()`);
    const chips = await waitFor(
      () =>
        mgr
          .evalIn(`(() => { const a = [...document.querySelectorAll('.mgr-chip')].map(b => b.textContent); return a.length ? a : null; })()`, false)
          .then((v) => v ?? null),
      10000,
    );
    check(
      "чипы групп: Все / Избранное / Проекты / Без группы / +",
      !!chips &&
        chips[0] === "Все" &&
        chips.includes("Избранное") &&
        chips.includes("Проекты") &&
        chips.includes("Без группы"),
      JSON.stringify(chips),
    );

    const badges = await waitFor(
      () => mgr.evalIn(`(() => { const n = document.querySelectorAll('.mgr-entry .badge').length; return n || null; })()`, false),
      10000,
    );
    check("метки групп у строк закладок (в «Все»)", !!badges && badges >= 4, String(badges));

    // «Проекты»: члены — g (GitHub) и страница стенд (manual: g, старт).
    // Ждём именно перерисовки под фильтр: до reload в DOM живут старые
    // строки «Все» (гонка первого прогона: опрос находил их мгновенно).
    await mgr.evalIn(
      `[...document.querySelectorAll('.mgr-chip')].find(b => b.textContent === 'Проекты')?.click()`,
    );
    const projRows = await waitFor(
      () =>
        mgr
          .evalIn(`(() => {
             const active = [...document.querySelectorAll('.mgr-chip.active')].map(b => b.textContent);
             const urls = [...document.querySelectorAll('.mgr-entry')].map(r => r.dataset.url);
             return active.includes('Проекты') && urls.length &&
               urls.every(u => u === 'https://g.example/' || u === ${JSON.stringify(startRow.url)})
               ? urls : null;
           })()`, false)
          .then((v) => v ?? null),
      10000,
    );
    const sortShown = await mgr.evalIn(`document.querySelector('.mgr-sort')?.value ?? ""`, false);
    check(
      "группа «Проекты»: строки по manual-порядку, сортировка «вручную»",
      JSON.stringify(projRows) === JSON.stringify(["https://g.example/", startRow.url]) &&
        sortShown === "manual",
      JSON.stringify({ projRows, sortShown }),
    );

    // меню папки строки g: ✓ у обеих групп; клик «Избранное» — снять членство
    await mgr.evalIn(`document.querySelector('.mgr-entry .act-groups')?.click()`);
    const gmenu = await waitFor(
      () =>
        mgr
          .evalIn(`(() => { const a = [...document.querySelectorAll('.mgr-groups-menu button')].map(b => b.textContent); return a.length ? a : null; })()`, false)
          .then((v) => v ?? null),
      6000,
    );
    check(
      "меню папки: группы с ✓",
      !!gmenu && gmenu.some((t) => t === "✓ Избранное") && gmenu.some((t) => t === "✓ Проекты"),
      JSON.stringify(gmenu),
    );
    await mgr.evalIn(
      `[...document.querySelectorAll('.mgr-groups-menu button')].find(b => b.textContent === '✓ Избранное')?.click()`,
    );
    await waitFor(
      () => mgr.evalIn(`(() => (!document.querySelector('.mgr-groups-menu') ? 1 : 0))()`, false),
      6000,
    );
    const afterMenu = await uiWs.evalIn(`${H}.groupList()`);
    const favAfter = afterMenu.groups.find((g) => g.id === FAV_ID);
    check(
      "меню папки сняло членство (g ушёл из «Избранное», в «Проекты» остался)",
      favAfter.count === 1,
      JSON.stringify(afterMenu.groups),
    );
    // ждём перерисовки после toggle (бейдж g — только «Проекты»): drop,
    // сделанный в полёте reload, тихо теряется (bookmarks уже очищены)
    await waitFor(
      () =>
        mgr
          .evalIn(`(() => {
             const row = [...document.querySelectorAll('.mgr-entry')]
               .find(r => r.dataset.url === 'https://g.example/');
             const badges = row ? [...row.querySelectorAll('.badge')].map(b => b.textContent) : [];
             return badges.length === 1 && badges[0] === 'Проекты' ? 1 : null;
           })()`, false)
          .then((v) => v ?? null),
      10000,
    );

    // drag&drop: старт (строка 1) НА g (строка 0, выше середины) → старт первым
    const dnd = await mgr.evalIn(`(async () => {
       const rows = [...document.querySelectorAll('.mgr-entry')];
       const dt = new DataTransfer();
       rows[1].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
       rows[0].dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: rows[0].getBoundingClientRect().top + 2 }));
       rows[0].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
       rows[1].dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
       await new Promise(r => setTimeout(r, 500));
       return [...document.querySelectorAll('.mgr-entry')].map(r => r.dataset.url);
     })()`);
    const projOrder = await uiWs.evalIn(
      `${H}.bookmarkList(${JSON.stringify({ query: null, groupId: WORK_ID, offset: 0, limit: 100 })})`,
    );
    check(
      "drag&drop переставил строку (ядро и UI согласно)",
      JSON.stringify(dnd) === JSON.stringify(projOrder.bookmarks.map((b) => b.url)) &&
        projOrder.bookmarks[0].url.includes(":" + HTTP_PORT + "/start"),
      `${JSON.stringify(dnd)} vs ${JSON.stringify(projOrder.bookmarks.map((b) => b.url))}`,
    );

    // «+» создаёт группу через инлайн-инпут
    await mgr.evalIn(`document.querySelector('.mgr-chip-add')?.click()`);
    await mgr.evalIn(
      `(() => { const i = document.querySelector('.mgr-chip-input'); i.value = 'Учёба'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 'ok'; })()`,
    );
    const chipStudy = await waitFor(
      () =>
        mgr
          .evalIn(`(() => [...document.querySelectorAll('.mgr-chip')].some(b => b.textContent === 'Учёба') ? 1 : null)()`, false)
          .then((v) => v ?? null),
      10000,
    );
    check("«+» создал группу «Учёба» (инлайн-инпут)", chipStudy === 1, "");
    const studyRemoved = await uiWs.evalIn(
      `(async () => { const gl = await ${H}.groupList(); const s = gl.groups.find(g => g.name === 'Учёба'); await ${H}.groupRemove({ id: s.id }); return 'ok'; })()`,
    );
    check("group_remove удалил «Учёба»", studyRemoved === "ok", String(studyRemoved));

    // скриншот секции закладок с непустой выбранной группой («Проекты»:
    // чипы, панель сортировки, строки с бейджами — гайд 06)
    await mgr.evalIn(
      `[...document.querySelectorAll('.mgr-chip')].find(b => b.textContent === 'Проекты')?.click()`,
    );
    await waitFor(
      () =>
        mgr
          .evalIn(`(() => {
             const active = [...document.querySelectorAll('.mgr-chip.active')].map(b => b.textContent);
             const urls = [...document.querySelectorAll('.mgr-entry')].map(r => r.dataset.url);
             return active.includes('Проекты') && urls.length &&
               urls.every(u => u === 'https://g.example/' || u === ${JSON.stringify(startRow.url)})
               ? urls : null;
           })()`, false)
          .then((v) => v ?? null),
      10000,
    );
    const shot = await mgr.send("Page.captureScreenshot", { format: "png" }).catch(() => null);
    if (shot) {
      fs.writeFileSync(
        path.join(import.meta.dirname, "manager-groups.png"),
        Buffer.from(shot.data, "base64"),
      );
      console.log("скриншот: e2e/bookmarks/manager-groups.png");
    }
  }
} catch (e) {
  check("стенд завершился без падения", false, String(e));
} finally {
  // --- 6. уборка --------------------------------------------------------------
  try {
    app.kill();
  } catch {}
  try {
    vite.kill();
  } catch {}
  try {
    httpServer.close();
  } catch {}
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
  console.log("Провалены:\n" + failed.map((r) => `  ${r.name} — ${r.extra}`).join("\n"));
  process.exitCode = 1;
}
