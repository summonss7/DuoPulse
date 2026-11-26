// E2E-приёмка duopulse-147 «меню закладок: красота + drag&drop» через CDP в
// живом приложении (паттерн e2e/bookmarks/nested.mjs; изоляция — временный
// APPDATA, vite dev поднимает сам, требует собранный debug-exe).
//   1) сид: A,B,C в «Избранное» (null-группа), D безгрупповая, папки
//      «Работа»/«Медиа» (корневые, с членами), «Документы» внутри «Работа»;
//   2) drag чипа B перед A на строке (синтетические DragEvent + DataTransfer)
//      — history.bmbar_reorder: порядок «Избранного» B,A,C,D, безгрупповый D
//      усыновлён (Ungrouped пуст);
//   3) drag папки «Медиа» перед «Работа» — history.group_reorder: корневые
//      папки на баре меняются местами (groupList);
//   4) клик по папке «Работа» — панель-webview bmfolder (CDP-цель
//      ?panel=bmfolder): строки-закладки с бейджами, подгруппа с шевроном,
//      крошка «‹» не мешает; скриншот панели;
//   5) drag строки закладки внутри панели (вторая перед первой) —
//      history.bookmark_move: порядок группы «Работа» сменился;
//   6) drag строки на подгруппу «Документы» — закладка переложена;
//      клик по закладке панели навигирует активную вкладку (URL).
// Скриншоты: %TEMP%/duopulse-147-*.png.
//
// Запуск:  node e2e/bookmarks/bm-drag.mjs [путь-к-duopulse.exe]
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const step = (s) => console.log(`-- шаг: ${s}`);
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const EXE_PS = EXE.replaceAll("/", "\\");
const CDP_PORT = Number(process.env.CDP_PORT || 9232);
const HTTP_PORT = Number(process.env.E2E_147_PORT || 8907);
const SHOT_DIR = process.env.E2E_147_SHOTS || os.tmpdir();
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
  results.push({ name, ok: !!ok });
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
  res.end(`<html><head><title>Стенд 147 ${req.url}</title></head><body><h1>${req.url}</h1></body></html>`);
});
await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-147-e2e-"));
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
  await waitFor(() => uiWs.evalIn(`document.querySelectorAll('.tab').length > 0 ? 1 : 0`, false), 15000);
  const H = `window.__duopulse.history`;

  // --- 1. сид ---------------------------------------------------------------
  step("сид: закладки, безгрупповая, папки и подгруппа");
  for (const [url, title] of [
    ["https://a.example/", "Альфа"],
    ["https://b.example/", "Бета"],
    ["https://c.example/", "Гамма"],
    ["https://d.example/", "Дельта"],
    ["https://w1.example/", "Задача 1"],
    ["https://w2.example/", "Задача 2"],
    ["https://m1.example/", "Кино"],
  ]) {
    await uiWs.evalIn(`${H}.bookmarkAdd(${JSON.stringify({ url, title, groupId: null })})`);
  }
  // Дельта — безгрупповая: выходим из «Избранного»
  const gl0 = await uiWs.evalIn(`${H}.groupList()`);
  const def = gl0.groups.find((g) => g.isDefault);
  await uiWs.evalIn(`${H}.groupToggleBookmark(${JSON.stringify({ url: "https://d.example/", groupId: def.id, on: false })})`);
  const work = await uiWs.evalIn(`${H}.groupAdd(${JSON.stringify({ name: "Работа" })})`);
  const media = await uiWs.evalIn(`${H}.groupAdd(${JSON.stringify({ name: "Медиа" })})`);
  const docs = await uiWs.evalIn(`${H}.groupAdd(${JSON.stringify({ name: "Документы", parentId: work.id })})`);
  for (const url of ["https://w1.example/", "https://w2.example/"]) {
    await uiWs.evalIn(`${H}.groupToggleBookmark(${JSON.stringify({ url, groupId: work.id, on: true })})`);
    await uiWs.evalIn(`${H}.groupToggleBookmark(${JSON.stringify({ url, groupId: def.id, on: false })})`);
  }
  await uiWs.evalIn(`${H}.groupToggleBookmark(${JSON.stringify({ url: "https://m1.example/", groupId: media.id, on: true })})`);
  await uiWs.evalIn(`${H}.groupToggleBookmark(${JSON.stringify({ url: "https://m1.example/", groupId: def.id, on: false })})`);
  // свежий бар: переклюаем вкладку (tabs.updated → refreshBmBar)
  await uiWs.evalIn(`window.__duopulse.tabs.open({ url: "duopulse://history" }).then(() => window.__duopulse.tabs.list())`);
  await sleep(1200);
  const barInfo = await waitFor(
    () =>
      uiWs.evalIn(`(() => {
        const chips = [...document.querySelectorAll('#bmbar .bm-item:not(.bm-folder)')].map(x => x.dataset.url);
        const folders = [...document.querySelectorAll('#bmbar .bm-folder .bm-label')].map(x => x.textContent);
        return chips.length >= 4 ? { chips, folders } : null;
      })()`, false).then((v) => v ?? null),
    10000,
  );
  check(
    "бар: чипы A,B,C,D и папки «Работа», «Медиа»",
    !!barInfo && barInfo.chips[0] === "https://a.example/" && barInfo.chips[3] === "https://d.example/" &&
      barInfo.folders.includes("Работа") && barInfo.folders.includes("Медиа"),
    JSON.stringify(barInfo),
  );

  // --- 2. drag чипа B перед A ------------------------------------------------
  step("строка: drag чипа B перед A");
  const chipDrag = await uiWs.evalIn(`(() => {
    const bar = document.getElementById('bmbar');
    const b = [...bar.querySelectorAll('.bm-item:not(.bm-folder)')].find(x => x.dataset.url === "https://b.example/");
    const a = [...bar.querySelectorAll('.bm-item:not(.bm-folder)')].find(x => x.dataset.url === "https://a.example/");
    if (!b || !a) return 'no-targets';
    const r = a.getBoundingClientRect();
    const dt = new DataTransfer();
    b.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    bar.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 2, clientY: r.top + 4 }));
    bar.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 2, clientY: r.top + 4 }));
    b.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return 'ok';
  })()`);
  await sleep(1200);
  const afterChip = await waitFor(
    () =>
      uiWs.evalIn(`(() => {
        const chips = [...document.querySelectorAll('#bmbar .bm-item:not(.bm-folder)')].map(x => x.dataset.url);
        return chips[0] === "https://b.example/" ? chips : null;
      })()`, false).then((v) => v ?? null),
    10000,
  );
  const ung = await uiWs.evalIn(`${H}.bookmarkList(${JSON.stringify({ query: null, groupId: -1, offset: 0, limit: 50 })})`);
  check(
    "bmbar_reorder: порядок B,A,C,D; безгрупповая D усыновлена «Избранным»",
    chipDrag === "ok" && !!afterChip && afterChip[0] === "https://b.example/" && afterChip[3] === "https://d.example/" && ung.bookmarks.length === 0,
    JSON.stringify({ drag: chipDrag, bar: afterChip, ungrouped: ung.bookmarks?.length }),
  );

  // --- 3. drag папки «Медиа» перед «Работа» ----------------------------------
  step("строка: drag папки «Медиа» перед «Работа»");
  const folderDrag = await uiWs.evalIn(`(() => {
    const bar = document.getElementById('bmbar');
    const m = [...bar.querySelectorAll('.bm-folder')].find(x => x.dataset.folder === String(${media.id}));
    const w = [...bar.querySelectorAll('.bm-folder')].find(x => x.dataset.folder === String(${work.id}));
    if (!m || !w) return 'no-targets';
    const r = w.getBoundingClientRect();
    const dt = new DataTransfer();
    m.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    bar.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 2, clientY: r.top + 4 }));
    bar.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 2, clientY: r.top + 4 }));
    m.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return 'ok';
  })()`);
  await sleep(1200);
  const gl1 = await uiWs.evalIn(`${H}.groupList()`);
  const roots = gl1.groups.filter((g) => !g.isDefault && g.parentId == null).map((g) => g.name);
  check(
    "group_reorder: «Медиа» встала перед «Работа»",
    folderDrag === "ok" && roots.indexOf("Медиа") !== -1 && roots.indexOf("Медиа") < roots.indexOf("Работа"),
    JSON.stringify({ drag: folderDrag, roots }),
  );

  // --- 4. панель папки --------------------------------------------------------
  step("панель bmfolder: клик по папке «Работа»");
  await uiWs.evalIn(`(() => {
    const w = [...document.querySelectorAll('#bmbar .bm-folder')].find(x => x.dataset.folder === String(${work.id}));
    w?.click();
    return 'ok';
  })()`);
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
    const rows = await waitFor(
      () =>
        panelWs.evalIn(`(() => {
          const subs = [...document.querySelectorAll('.bm-row.bm-sub .bm-label')].map(x => x.textContent);
          const marks = [...document.querySelectorAll('.bm-row[data-url] .bm-label')].map(x => x.textContent);
          return marks.length >= 2 && subs.includes('Документы') ? { subs, marks } : null;
        })()`, false).then((v) => v ?? null),
      12000,
    );
    check(
      "панель: закладки «Задача 1/2» с бейджами + подгруппа «Документы»",
      !!rows && rows.marks[0] === "Задача 1" && rows.marks[1] === "Задача 2",
      JSON.stringify(rows),
    );
    const badges = await panelWs.evalIn(`(() => {
      const ico = document.querySelector('.bm-row[data-url] .bm-ico');
      const host = document.querySelector('.bm-row[data-url] .bm-host');
      return ico && host ? { bg: ico.style.background.slice(0, 30), letter: ico.textContent, host: host.textContent } : null;
    })()`, false);
    check(
      "панель: бейдж-буква с градиентом и домен рядом",
      !!badges && String(badges.bg).includes("linear-gradient") && badges.letter === "З" && badges.host === "w1.example",
      JSON.stringify(badges),
    );
    const shot = await panelWs.send("Page.captureScreenshot", { format: "png" }).catch(() => null);
    if (shot) {
      fs.writeFileSync(path.join(SHOT_DIR, "duopulse-147-panel.png"), Buffer.from(shot.data, "base64"));
      console.log("скриншот:", path.join(SHOT_DIR, "duopulse-147-panel.png"));
    }

    // --- 5. drag строки внутри панели: «Задача 2» перед «Задача 1» -----------
    step("панель: drag «Задача 2» перед «Задача 1»");
    const pDrag = await panelWs.evalIn(`(() => {
      const host = document.getElementById('bmFolder');
      const rows = [...host.querySelectorAll('.bm-row[data-url]')];
      const r2 = rows.find(x => x.dataset.url === "https://w2.example/");
      const r1 = rows.find(x => x.dataset.url === "https://w1.example/");
      if (!r1 || !r2) return 'no-targets';
      const r = r1.getBoundingClientRect();
      const dt = new DataTransfer();
      r2.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      host.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 4, clientY: r.top + 3 }));
      host.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 4, clientY: r.top + 3 }));
      r2.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      return 'ok';
    })()`);
    await sleep(1200);
    const wOrder = await uiWs.evalIn(
      `${H}.bookmarkList(${JSON.stringify({ query: null, groupId: work.id, offset: 0, limit: 50 })})`,
    );
    const wUrls = wOrder.bookmarks.map((b) => b.url);
    check(
      "панель: bookmark_move — «Задача 2» встала первой",
      pDrag === "ok" && wUrls[0] === "https://w2.example/" && wUrls[1] === "https://w1.example/",
      JSON.stringify({ drag: pDrag, order: wUrls }),
    );

    // --- 6. drag строки на подгруппу + клик-навигация ------------------------
    step("панель: drag «Задача 1» на подгруппу «Документы»");
    const pMove = await panelWs.evalIn(`(() => {
      const host = document.getElementById('bmFolder');
      const row = [...host.querySelectorAll('.bm-row[data-url]')].find(x => x.dataset.url === "https://w1.example/");
      const sub = [...host.querySelectorAll('.bm-row.bm-sub')].find(x => x.dataset.sub === String(${docs.id}));
      if (!row || !sub) return 'no-targets';
      const r = sub.getBoundingClientRect();
      const dt = new DataTransfer();
      row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      sub.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 4, clientY: r.top + 4 }));
      sub.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 4, clientY: r.top + 4 }));
      row.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      return 'ok';
    })()`);
    await sleep(1200);
    const docsList = await uiWs.evalIn(
      `${H}.bookmarkList(${JSON.stringify({ query: null, groupId: docs.id, offset: 0, limit: 50 })})`,
    );
    check(
      "панель: закладка переложена в подгруппу «Документы»",
      pMove === "ok" && docsList.bookmarks.some((b) => b.url === "https://w1.example/"),
      JSON.stringify({ drag: pMove, docs: docsList.bookmarks.map((b) => b.url) }),
    );
    step("панель: клик по закладке навигирует активную вкладку");
    await panelWs.evalIn(`(() => {
      const row = [...document.querySelectorAll('.bm-row[data-url]')].find(x => x.dataset.url === "https://w2.example/");
      row?.click();
      return 'ok';
    })()`);
    const nav = await waitFor(
      () =>
        uiWs.evalIn(`window.__duopulse.tabs.list()`, true).then((tabs) => {
          const active = tabs.tabs.find((t) => t.active);
          return active?.url?.startsWith("https://w2.example/") ? active.url : null;
        }),
      10000,
    );
    check("клик по строке панели — переход активной вкладки", !!nav, String(nav));
  }

  // --- скриншот бара (красота чипов) -----------------------------------------
  const barShot = await uiWs
    .send("Page.captureScreenshot", {
      format: "png",
      clip: await uiWs
        .evalIn(`(() => { const r = document.getElementById('bmbar').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 }; })()`, false)
        .then((c) => c ?? undefined),
    })
    .catch(() => null);
  if (barShot) {
    fs.writeFileSync(path.join(SHOT_DIR, "duopulse-147-bar.png"), Buffer.from(barShot.data, "base64"));
    console.log("скриншот:", path.join(SHOT_DIR, "duopulse-147-bar.png"));
  }
} catch (e) {
  check("стенд завершился без падения", false, String(e));
} finally {
  try { app.kill(); } catch {}
  // vite.kill() на Windows убивает только npm-оболочку — дерево npm→node
  // переживает скрипт и держит порт 5173 (strictPort) для следующих прогонов
  try {
    await run("taskkill", ["/PID", String(vite.pid), "/T", "/F"]);
  } catch {
    /* дерево уже мертво — ок */
  }
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
  console.log("Провалены:\n" + failed.map((r) => `  ${r.name} — ${r.extra}`).join("\n"));
  process.exitCode = 1;
}
