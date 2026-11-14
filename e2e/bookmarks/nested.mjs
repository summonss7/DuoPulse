// E2E-приёмка вложенных групп закладок (карточка duopulse-151) через CDP в
// живом приложении (паттерн e2e/bookmarks/run.mjs; изоляция — временный
// APPDATA, vite dev поднимает сам, требует собранный debug-exe).
//   1) ядро: group_add с parentId (глубина 1/2/3), 4-й уровень и циклы
//      (group_move в потомка/в себя) — ошибки; group_move в корень — ок;
//   2) страница управления duopulse://history: чипы деревом («· Документы»,
//      «· · 2026»), «+ подгруппа» в панели группы создаёт подгруппу;
//      drag строки закладки на чип подгруппы перекладывает членство;
//      drag чипа группы на другую группу — вкладывает, на «Все» — в корень;
//   3) строка закладок: папка корневой группы на баре, подгруппа — нет
//      (в меню папки); drag чипа на папку уносит закладку из «Избранного»
//      в группу папки (синтетические DragEvent — new DataTransfer()).
// Скриншоты: %TEMP%/duopulse-151-*.png.
//
// Запуск:  node e2e/bookmarks/nested.mjs [путь-к-duopulse.exe]
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const step = (s) => console.log(`-- шаг: ${s}`);
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const EXE_PS = EXE.replaceAll("/", "\\");
const CDP_PORT = Number(process.env.CDP_PORT || 9231);
const HTTP_PORT = Number(process.env.E2E_151_PORT || 8897);
const SHOT_DIR = process.env.E2E_151_SHOTS || os.tmpdir();
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
  res.end(`<html><head><title>Стенд 151 ${req.url}</title></head><body><h1>${req.url}</h1></body></html>`);
});
await new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-151-e2e-"));
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

  // --- 1. ядро: вложенность, лимиты, переносы -----------------------------
  step("ядро: сид и дерево групп");
  for (const [url, title] of [
    ["https://w.example/", "Википедия"],
    ["https://g.example/", "GitHub"],
  ]) {
    await uiWs.evalIn(`${H}.bookmarkAdd(${JSON.stringify({ url, title, groupId: null })})`);
  }
  const work = await uiWs.evalIn(`${H}.groupAdd(${JSON.stringify({ name: "Работа" })})`);
  const docs = await uiWs.evalIn(
    `${H}.groupAdd(${JSON.stringify({ name: "Документы", parentId: work.id })})`,
  );
  const year = await uiWs.evalIn(
    `${H}.groupAdd(${JSON.stringify({ name: "2026", parentId: docs.id })})`,
  );
  check("group_add с parentId: глубины 1/2/3", work.depth === 1 && docs.depth === 2 && year.depth === 3,
    JSON.stringify({ work: work.depth, docs: docs.depth, year: year.depth }));
  const over = await uiWs.evalIn(
    `${H}.groupAdd(${JSON.stringify({ name: "Слишком", parentId: year.id })}).then(v => "ok").catch(e => "err:" + e)`,
  );
  check("4-й уровень — ошибка", String(over).includes("err:") && String(over).includes("уровней"), String(over).slice(0, 120));
  const cycle = await uiWs.evalIn(
    `${H}.groupMove(${JSON.stringify({ id: work.id, parentId: year.id })}).then(v => "ok").catch(e => "err:" + e)`,
  );
  check("group_move в собственного потомка — ошибка (цикл)", String(cycle).includes("err:") && (String(cycle).includes("подгруппу") || String(cycle).includes("уровней")), String(cycle).slice(0, 120));

  // --- 2. страница управления ----------------------------------------------
  step("страница управления: дерево чипов, + подгруппа, drag");
  await uiWs.evalIn(`window.__duopulse.tabs.open({ url: "duopulse://history" })`);
  const mgrTarget = await waitFor(async () => {
    const list = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
    const pages = list.filter((t) => t.type === "page" && /localhost:5173/.test(t.url));
    return pages.length >= 2 ? pages.find((p) => p.webSocketDebuggerUrl !== ui.webSocketDebuggerUrl) : null;
  }, 20000);
  check("duopulse://history открыт", !!mgrTarget, mgrTarget?.url ?? "не дождались");
  if (mgrTarget) {
    const mgr = connect(mgrTarget.webSocketDebuggerUrl);
    await mgr.send("Runtime.enable").catch(() => {});
    await waitFor(() => mgr.evalIn(`(() => document.querySelectorAll('.mgr-tab').length >= 2 ? 1 : null)()`, false), 10000);
    await mgr.evalIn(`[...document.querySelectorAll('.mgr-tab')].find(b => b.textContent === 'Закладки')?.click()`);
    const chips = await waitFor(
      () => mgr.evalIn(`(() => { const a = [...document.querySelectorAll('.mgr-chip')].map(b => b.textContent); return a.length > 4 ? a : null; })()`, false).then((v) => v ?? null),
      10000,
    );
    check(
      "чипы деревом: «· Документы», «· · 2026» следом за «Работа»",
      !!chips && chips.indexOf("Работа") >= 0 &&
        chips.indexOf("· Документы") === chips.indexOf("Работа") + 1 &&
        chips[chips.indexOf("· Документы") + 1] === "· · 2026",
      JSON.stringify(chips),
    );

    // панель группы: «+ подгруппа» создаёт «Отчёты» внутри «Документы»
    await mgr.evalIn(`[...document.querySelectorAll('.mgr-chip')].find(b => b.textContent === '· Документы')?.click()`);
    await waitFor(
      () => mgr.evalIn(`(() => { const b = [...document.querySelectorAll('.mgr-groupbar .act-sub')][0]; return b && !b.disabled ? 1 : null; })()`, false).then((v) => v ?? null),
      8000,
    );
    await mgr.evalIn(`document.querySelector('.mgr-groupbar .act-sub')?.click()`);
    await mgr.evalIn(
      `(() => { const i = document.querySelector('.mgr-chip-input'); i.value = 'Отчёты'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 'ok'; })()`,
    );
    const reports = await waitFor(
      () => mgr.evalIn(`(() => [...document.querySelectorAll('.mgr-chip')].some(b => b.textContent === '· · Отчёты') ? 1 : null)()`, false).then((v) => v ?? null),
      10000,
    );
    const reportsRow = await uiWs.evalIn(`${H}.groupList()`);
    const rep = reportsRow.groups.find((g) => g.name === "Отчёты");
    check(
      "«+ подгруппа» создала «Отчёты» внутри «Документы» (глубина 3)",
      reports === 1 && rep?.depth === 3 && rep?.parentId === docs.id,
      JSON.stringify({ ui: reports, core: rep?.depth, parent: rep?.parentId }),
    );

    // drag строки закладки на чип подгруппы: из «Избранное» в «Документы»
    await mgr.evalIn(`[...document.querySelectorAll('.mgr-chip')].find(b => b.textContent === 'Избранное')?.click()`);
    await waitFor(
      () => mgr.evalIn(`(() => document.querySelectorAll('.mgr-entry[data-url]').length ? 1 : null)()`, false).then((v) => v ?? null),
      8000,
    );
    const dragRowToChip = await mgr.evalIn(`(() => {
      const row = document.querySelector('.mgr-entry[data-url="https://g.example/"]');
      const chip = [...document.querySelectorAll('.mgr-chip')].find(b => b.textContent === '· Документы');
      if (!row || !chip) return 'no-targets';
      const r = chip.getBoundingClientRect();
      const dt = new DataTransfer();
      row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      chip.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 4, clientY: r.top + 4 }));
      chip.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 4, clientY: r.top + 4 }));
      row.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      return 'ok';
    })()`);
    await sleep(700);
    const gGroups = await uiWs.evalIn(
      `${H}.bookmarkList(${JSON.stringify({ query: null, offset: 0, limit: 50 })})`,
    );
    const gRow = gGroups.bookmarks.find((b) => b.url === "https://g.example/");
    check(
      "drag строки на чип подгруппы переложил закладку (Избранное→Документы)",
      dragRowToChip === "ok" &&
        gRow?.groups?.some((x) => x.name === "Документы") &&
        !gRow?.groups?.some((x) => x.name === "Избранное"),
      JSON.stringify({ drag: dragRowToChip, groups: gRow?.groups?.map((x) => x.name) }),
    );

    // drag чипа группы: «Работа» → внутрь «Прочее»; и обратно на «Все»
    await uiWs.evalIn(`${H}.groupAdd(${JSON.stringify({ name: "Прочее" })})`);
    await mgr.evalIn(`window.location.reload()`);
    await waitFor(() => mgr.evalIn(`(() => document.querySelectorAll('.mgr-tab').length >= 2 ? 1 : null)()`, false), 10000);
    await mgr.evalIn(`[...document.querySelectorAll('.mgr-tab')].find(b => b.textContent === 'Закладки')?.click()`);
    await waitFor(
      () => mgr.evalIn(`(() => [...document.querySelectorAll('.mgr-chip')].some(b => b.textContent === 'Прочее') ? 1 : null)()`, false).then((v) => v ?? null),
      10000,
    );
    const dragChip = await mgr.evalIn(`(() => {
      const other = [...document.querySelectorAll('.mgr-chip')].find(b => b.textContent === 'Прочее');
      const workC = [...document.querySelectorAll('.mgr-chip')].find(b => b.textContent === 'Работа');
      if (!other || !workC) return 'no-targets';
      const r = workC.getBoundingClientRect();
      const dt = new DataTransfer();
      other.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      workC.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 4, clientY: r.top + 4 }));
      workC.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 4, clientY: r.top + 4 }));
      other.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      return 'ok';
    })()`);
    await sleep(700);
    let gl = await uiWs.evalIn(`${H}.groupList()`);
    let otherG = gl.groups.find((g) => g.name === "Прочее");
    const nested = otherG?.parentId === work.id && otherG?.depth === 2;
    check("drag чипа «Прочее» на «Работа» — вкладывание", dragChip === "ok" && nested,
      JSON.stringify({ drag: dragChip, parent: otherG?.parentId, depth: otherG?.depth }));
    const dragRoot = await mgr.evalIn(`(() => {
      // после вложения чип подписан «· Прочее»; если вложение не удалось — корень «Прочее»
      const other = [...document.querySelectorAll('.mgr-chip')].find(b => b.textContent.endsWith('Прочее'));
      const all = [...document.querySelectorAll('.mgr-chip')].find(b => b.textContent === 'Все');
      if (!other || !all) return 'no-targets';
      const r = all.getBoundingClientRect();
      const dt = new DataTransfer();
      other.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      all.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 4, clientY: r.top + 4 }));
      all.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 4, clientY: r.top + 4 }));
      other.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      return 'ok';
    })()`);
    await sleep(700);
    gl = await uiWs.evalIn(`${H}.groupList()`);
    otherG = gl.groups.find((g) => g.name === "Прочее");
    check("drag чипа на «Все» — снова корень", dragRoot === "ok" && otherG?.parentId == null && otherG?.depth === 1,
      JSON.stringify({ drag: dragRoot, parent: otherG?.parentId, depth: otherG?.depth }));

    const shot = await mgr.send("Page.captureScreenshot", { format: "png" }).catch(() => null);
    if (shot) {
      fs.writeFileSync(path.join(SHOT_DIR, "duopulse-151-manager.png"), Buffer.from(shot.data, "base64"));
      console.log("скриншот:", path.join(SHOT_DIR, "duopulse-151-manager.png"));
    }
  }

  // --- 3. строка закладок ----------------------------------------------------
  step("строка закладок: папки и drag чипа в папку");
  const barInfo = await waitFor(
    () =>
      uiWs.evalIn(`(() => {
        const folders = [...document.querySelectorAll('#bmbar .bm-folder .bm-label')].map(x => x.textContent);
        const chips = [...document.querySelectorAll('#bmbar .bm-item:not(.bm-folder) .bm-label')].map(x => x.textContent);
        return (folders.length || chips.length) ? { folders, chips } : null;
      })()`, false).then((v) => v ?? null),
    10000,
  );
  check(
    "бар: папка «Работа» есть, подгруппы «Документы» на баре нет",
    !!barInfo && barInfo.folders.includes("Работа") && !barInfo.folders.includes("Документы"),
    JSON.stringify(barInfo),
  );
  const barDrag = await uiWs.evalIn(`(() => {
    const bar = document.getElementById('bmbar');
    const chip = [...bar.querySelectorAll('.bm-item:not(.bm-folder)')].find(x => x.dataset.url === "https://w.example/");
    const folder = [...bar.querySelectorAll('.bm-folder')].find(x => x.dataset.folder === String(${work.id}));
    if (!chip || !folder) return 'no-targets';
    const r = folder.getBoundingClientRect();
    const dt = new DataTransfer();
    chip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    folder.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 4, clientY: r.top + 4 }));
    folder.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 4, clientY: r.top + 4 }));
    chip.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return 'ok';
  })()`);
  await sleep(900);
  const wGroups = await uiWs.evalIn(`${H}.bookmarkList(${JSON.stringify({ query: null, offset: 0, limit: 50 })})`);
  const wRow = wGroups.bookmarks.find((b) => b.url === "https://w.example/");
  check(
    "drag чипа на папку бара: закладка ушла из «Избранное» в «Работа»",
    barDrag === "ok" &&
      wRow?.groups?.some((x) => x.name === "Работа") &&
      !wRow?.groups?.some((x) => x.name === "Избранное"),
    JSON.stringify({ drag: barDrag, groups: wRow?.groups?.map((x) => x.name) }),
  );
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
  console.log("Провалены:\n" + failed.map((r) => `  ${r.name} — ${r.extra}`).join("\n"));
  process.exitCode = 1;
}
