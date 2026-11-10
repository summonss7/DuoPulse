// E2E-приёмка мобильной части карточки duopulse-104 «Закладки на мобильной
// ветке» на эмуляторе Android через CDP (webview_devtools_remote, прецеденты
// duopulse-081/083/102; паттерн eval-шагов — e2e/bookmarks/run.mjs).
//   1) хранилище: команды history.* в тонкой мобильной либе — profile
//      filesDir/profile/duopulse.db, миграция «Избранное», group_add/
//      rename/remove, bookmark_add/list/update/remove, toggle, move;
//   2) UI: кнопка «Закладки» на стартовом экране → экран с чипами, «+»
//      с инлайн-вводом, строка закладки (✎/✕), звёздочка в шапке открытого
//      видео — шит выбора группы + «Новая группа…»;
//   3) сенсорное перекладывание: long-press (350 мс) по строке → pointermove
//      на чип группы → pointerup — синтетические PointerEvent (слушатели
//      DOM-уровня, как DragEvent в 099): из вида группы — перенос, из «Все» —
//      добавление (много-членство сохраняется).
// Приложение и adb-форвард должны быть уже подняты (стенд их не запускает —
// эмулятор/устройство выбирает запускающий):
//   adb forward tcp:9223 localabstract:webview_devtools_remote_<pid>
//   node e2e/bookmarks/mobile.mjs
// Порт — CDP_PORT (по умолчанию 9223, конвенция мобильных смоуков).
const PORT = process.env.CDP_PORT || 9223;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

async function connect() {
  const targets = await (await fetch(`http://localhost:${PORT}/json`)).json();
  // мобильная обёртка Tauri на Android раздаёт бандл с tauri.localhost
  const t = targets.find((x) => x.type === "page" && /^https?:\/\/(tauri\.)?localhost/.test(x.url));
  if (!t) throw new Error("нет CDP-цели мобильного UI: " + targets.map((x) => x.url).join(", "));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
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
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      // таймаут на каждый вызов: мёртвая CDP-цель иначе висит вечно
      // (грабля e2e/VPN-CI, память duopulse-e2e-vpn-ci-gotchas)
      const t = setTimeout(() => {
        pending.delete(i);
        rej(new Error(`CDP ${method}: таймаут 15 с`));
      }, 15000);
      pending.set(i, {
        res: (v) => { clearTimeout(t); res(v); },
        rej: (e) => { clearTimeout(t); rej(e); },
      });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send("Runtime.enable");
  await send("Page.enable");
  return {
    eval: async (expr) => {
      const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception ?? r.exceptionDetails).slice(0, 600));
      return r.result?.value;
    },
    shot: async (file) => {
      // скриншоты — системным screencap, не CDP captureScreenshot: на
      // Android WebView тот намертво клинит devtools-сервер (сокет уходит в
      // CONNECTING, отваливаются и последующие eval — грабля duopulse-104)
      const { execFileSync } = await import("node:child_process");
      const png = execFileSync("adb", ["exec-out", "screencap", "-p"]);
      (await import("node:fs")).writeFileSync(file, png);
      console.log("saved:", file);
    },
  };
}

/** invoke через глобальный API мобильной обёртки (withGlobalTauri). */
const INVOKE = `window.__TAURI__.core.invoke`;

const main = async () => {
  const cdp = await connect();
  console.log("цель подключена");

  // ── чистый старт: убираем закладки/группы прошлых прогонов ────────────
  await cdp.eval(`(async () => {
    const { groups } = await ${INVOKE}("history_group_list");
    for (const g of groups) if (!g.isDefault) await ${INVOKE}("history_group_remove", { params: { id: g.id } });
    const { bookmarks } = await ${INVOKE}("history_bookmark_list", { params: { query: null, groupId: null, offset: 0, limit: 500 } });
    for (const b of bookmarks) await ${INVOKE}("history_bookmark_remove", { params: { url: b.url } });
    return "clean";
  })()`);

  // ── 1. хранилище в мобильной либе ─────────────────────────────────────
  let v = await cdp.eval(`(async () => {
    const g1 = await ${INVOKE}("history_group_add", { params: { name: "Море" } });
    const dup = await ${INVOKE}("history_group_add", { params: { name: "Избранное" } }).catch((e) => String(e));
    await ${INVOKE}("history_bookmark_add", { params: { url: "https://www.youtube.com/watch?v=aaaaaaaaaaa", title: "Волны", groupId: null } });
    await ${INVOKE}("history_bookmark_add", { params: { url: "https://www.youtube.com/watch?v=bbbbbbbbbbb", title: "Прилив", groupId: g1.id } });
    await ${INVOKE}("history_bookmark_update", { params: { url: "https://www.youtube.com/watch?v=aaaaaaaaaaa", title: "Волны у маяка" } });
    const { bookmarks } = await ${INVOKE}("history_bookmark_list", { params: { query: null, groupId: null, offset: 0, limit: 500 } });
    return { g1, dup, bookmarks };
  })()`);
  check("group_add/bookmark_add/update/list в мобильной либе", v.bookmarks.length === 2 && v.bookmarks.find((b) => b.title === "Волны у маяка") !== undefined, JSON.stringify(v.bookmarks?.map((b) => b.title)));
  check("дубликат имени группы — ошибка", typeof v.dup === "string" && v.dup.includes("уже есть"), String(v.dup).slice(0, 80));
  const SEA = v.g1.id;

  // ── 2. экран закладок ────────────────────────────────────────────────
  v = await cdp.eval(`(() => {
    document.querySelector(".m-bm-open")?.click();
    return !!document.querySelector("#mBookmarks");
  })()`);
  await sleep(400);
  v = await cdp.eval(`window.__bmDebug()`);
  check("экран «Закладки» открыт со стартового экрана", v.open === true, "");
  check("чипы: «Все», «Избранное · 1», «Море · 1»", v.groups.map((g) => `${g.name}·${g.count}`).join("|") === "Избранное·1|Море·1", JSON.stringify(v.groups));
  check("строки с заголовками и меткой хоста", v.bookmarks.length === 2, JSON.stringify(v.bookmarks.map((b) => b.title)));
  await cdp.shot("e2e/bookmarks/mobile-view.png");

  // «+» — инлайн-ввод новой группы
  v = await cdp.eval(`(() => {
    [...document.querySelectorAll(".m-bm-chip")].find((c) => c.textContent === "+").click();
    const i = document.querySelector(".m-bm-chip-input");
    if (!i) return "нет инпута";
    i.value = "Горы";
    i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return "ок";
  })()`);
  await sleep(400);
  v = await cdp.eval(`window.__bmDebug()`);
  check("«+» создаёт группу «Горы» (инлайн-ввод)", v.groups.some((g) => g.name === "Горы"), JSON.stringify(v.groups.map((g) => g.name)));
  const MOUNT = v.groups.find((g) => g.name === "Горы")?.id;

  // ✎ — переименование строки
  v = await cdp.eval(`(() => {
    const row = [...document.querySelectorAll(".m-bm-row")].find((r) => r.dataset.url.includes("bbbbbbbbbbb"));
    [...row.querySelectorAll(".m-bm-act")][0].click();
    const i = row.querySelector(".m-bm-rename");
    if (!i) return "нет инпута";
    i.value = "Прилив у скал";
    i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return "ок";
  })()`);
  await sleep(400);
  v = await cdp.eval(`window.__bmDebug()`);
  check("✎ переименовывает закладку", v.bookmarks.find((b) => b.url.includes("bbbbbbbbbbb"))?.title === "Прилив у скал", "");

  // ── 3. сенсорное перекладывание (синтетические PointerEvent) ─────────
  // тяга: long-press по строке → палец на чип группы (id) → отпускание
  const drag = async (urlSub, targetId) => cdp.eval(`(async () => {
    const row = [...document.querySelectorAll(".m-bm-row")].find((r) => r.dataset.url.includes("${urlSub}"));
    const chip = [...document.querySelectorAll(".m-bm-chip")].find((c) => c.dataset.drop === String(${targetId}));
    if (!row || !chip) return "нет строки/чипа";
    const r = row.getBoundingClientRect(), c = chip.getBoundingClientRect();
    const pe = (type, x, y, el) =>
      el.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, pointerId: 7, isPrimary: true, pointerType: "touch", button: 0 }));
    pe("pointerdown", r.x + 30, r.y + 12, row);
    await new Promise((res) => setTimeout(res, ${350 + 120}));
    const dbg = window.__bmDebug();
    if (!dbg.drag) return "тяга не активировалась";
    pe("pointermove", r.x + 32, r.y + 8, window);
    pe("pointermove", c.x + c.width / 2, c.y + c.height / 2, window);
    const marked = !!chip.classList.contains("drop-target");
    pe("pointerup", c.x + c.width / 2, c.y + c.height / 2, window);
    return { marked, sel: dbg.sel };
  })()`);

  // вид «Море» (чип по имени): сначала выберем его кликом по чипу
  v = await cdp.eval(`(async () => {
    const chips = [...document.querySelectorAll(".m-bm-chip")];
    const sea = chips.find((c) => c.textContent.startsWith("Море"));
    sea.click();
    await new Promise((r) => setTimeout(r, 350));
    return window.__bmDebug();
  })()`);
  check("вид группы «Море»: одна закладка", v.sel === SEA && v.bookmarks.length === 1, JSON.stringify({ sel: v.sel, n: v.bookmarks.length }));

  v = await drag("bbbbbbbbbbb", MOUNT);
  await sleep(450);
  check("long-press тяга активна и чип-цель подсвечен", typeof v === "object" && v.marked === true, JSON.stringify(v));
  v = await cdp.eval(`window.__bmDebug()`);
  check("перенос из «Море» в «Горы»: вид «Море» опустел", v.sel === SEA && v.bookmarks.length === 0, JSON.stringify(v.bookmarks?.length));
  v = await cdp.eval(`(async () => ${INVOKE}("history_bookmark_list", { params: { query: null, groupId: ${MOUNT}, offset: 0, limit: 50 } }))()`);
  check("в «Горах» оказалась закладка", v.bookmarks.length === 1 && v.bookmarks[0].url.includes("bbbbbbbbbbb"), "");

  // из «Все» на чип «Море» — добавление (много-членство: «Горы» остаётся)
  v = await cdp.eval(`(async () => {
    [...document.querySelectorAll(".m-bm-chip")].find((c) => c.dataset.sel === "all").click();
    await new Promise((r) => setTimeout(r, 350));
    return window.__bmDebug().sel;
  })()`);
  check("вернулись в «Все»", v === "all", String(v));
  v = await drag("bbbbbbbbbbb", SEA);
  await sleep(450);
  v = await cdp.eval(`(async () => {
    const all = await ${INVOKE}("history_bookmark_list", { params: { query: null, groupId: null, offset: 0, limit: 50 } });
    return all.bookmarks.find((b) => b.url.includes("bbbbbbbbbbb")).groups.map((g) => g.name).sort();
  })()`);
  check("из «Все» — добавление, много-членство сохранено", JSON.stringify(v) === JSON.stringify(["Горы", "Море"]), JSON.stringify(v));

  await cdp.shot("e2e/bookmarks/mobile-after-drag.png");

  // ── 4. возврат на старт ───────────────────────────────────────────────
  // звёздочка в шапке открытого видео проверяется живым прогоном с реальным
  // YouTube-видео (одна загрузка, вне этого стенда — rate-limit Google,
  // память duopulse-youtube-e2e-rate-limit); здесь — только навигация экрана.
  v = await cdp.eval(`document.querySelector(".m-bm-back").click()`);
  await sleep(150);
  v = await cdp.eval(`document.querySelector("#mBookmarks").hidden`);
  check("«←» возвращает на стартовый экран", v === true, "");

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${failed === 0 ? "ALL PASS" : "FAILED"}: ${results.length - failed}/${results.length}`);
  process.exit(failed === 0 ? 0 : 1);
};

main().catch((e) => {
  console.error("стенд упал:", e.message);
  process.exit(1);
});
