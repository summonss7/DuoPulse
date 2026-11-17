// E2E-смоук паролей web-оверлея: захват из форм (карточка duopulse-165,
// паритет 2/8) и автозаполнение (duopulse-166, паритет 3/8): debug-сборка
// на эмуляторе (у релиза нет CDP-сокета webview_devtools_remote, конвенция
// смоука duopulse-144 — порт 9223). Сценарий (страница dp165-login.html на
// 10.0.2.2:8901 из эмулятора):
//   1) оверлей открываем invoke'ом mobile_web_open из UI-webview (без тапов),
//     CDP-цель страницы оверлея ищем по URL (мёртвые цели висят в /json);
//   2) сабмит формы в оверлее → мобильный лист «Сохранить пароль?»
//     (хук __duopulseMobilePassSave) → «Сохранить» → запись в списке паролей
//     (mobile_passwords_list) и пароль по reveal;
//   3) смена пароля → бар «Обновить» → сохранить → reveal видит новый;
//   3b) автозаполнение (166): перезагрузка страницы → иконка-ключ у поля
//     пароля → тап → один аккаунт — заполнение сразу (логин+пароль в полях);
//     второй аккаунт → тап → нативный нижний лист имён (uiautomator dump,
//     тап в физических пикселях) → выбор → поля заполнены вторым; logcat
//     весь прогон не содержит паролей;
//   4) «Никогда для этого сайта» → повторный сабмит бара НЕ даёт;
//   5) инкогнито (кнопка mPrivate: Core-флаг + оверлей закрыт) → повторное
//     открытие: иконки-ключа НЕТ (автозаполнение выключено), сабмит — бара
//     нет, кандидат Core пуст.
// Запуск (APK установлен, эмулятор поднят): node e2e/mobile/pass-capture-smoke.mjs
// Результат — e2e/mobile/pass-capture-smoke-last-run.json (gitignore,
// рантайм-артефакт). Скриншоты — %TEMP%/duopulse-165-*.png.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PKG = "dev.duopulse.mobile";
const PORT = Number(process.env.CDP_PORT || 9223);
// 8899 на этой машине в Windows excluded-диапазоне (Hyper-V): 8901 (см. 144/146)
// порт = origin: прогон с «Никогда» держит denylist в сторе эмулятора,
// уникальный порт на прогон даёт чистый origin (8901+как в 144/146, диапазон
// свободен от Windows excluded-диапазонов)
const HTTP_PORT = Number(process.env.DP165_HTTP_PORT || 8901 + (Date.now() % 80));
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "pass-capture-smoke-last-run.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SERIAL = process.env.ANDROID_SERIAL ||
  execFileSync("adb", ["devices"], { encoding: "utf8" })
    .split(/\r?\n/).slice(1).find((l) => l.trim().endsWith("device"))?.split("\t")[0].trim() || "";
if (!SERIAL) throw new Error("эмулятор не найден (adb devices)");
const adb = (...args) =>
  execFileSync("adb", ["-s", SERIAL, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
const shot = (name) => {
  const p = join(tmpdir(), `duopulse-165-${name}.png`);
  // Buffer без encoding: utf8-строка портила бинарные байты PNG (0x89→0xFD).
  // exec-out (не shell) переводы строк не конвертит — байты пишем как есть.
  writeFileSync(p, execFileSync("adb", ["-s", SERIAL, "exec-out", "screencap", "-p"]));
  console.log(`скриншот: ${p}`);
};

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

// --- локальный http-сервер стенда --------------------------------------------
const server = createServer((req, res) => {
  try {
    const body = readFileSync(join(HERE, "dp165-login.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
  } catch {
    res.writeHead(404).end("nope");
  }
});
await new Promise((r) => server.listen(HTTP_PORT, "127.0.0.1", r));

// --- CDP ----------------------------------------------------------------------
const forwardCdp = () => {
  const p = adb("shell", "pidof", PKG).trim();
  adb("forward", `tcp:${PORT}`, `localabstract:webview_devtools_remote_${p}`);
};
const targets = async () =>
  (await (await fetch(`http://localhost:${PORT}/json`)).json())
    .filter((t) => t.type === "page");

async function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let i = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const evalJs = (expr) => new Promise((res, rej) => {
    const id = ++i;
    pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result.result.value)));
    ws.send(JSON.stringify({
      id, method: "Runtime.evaluate",
      params: { expression: expr, returnByValue: true, awaitPromise: true },
    }));
  });
  const invoke = (cmd, args) =>
    evalJs(`window.__TAURI__.core.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
  return { url: t.url, evalJs, invoke, close: () => ws.close() };
}

/** UI-webview DuoPulse (DOM-предикат: хук смоука есть только в мобильной ветке). */
async function uiPage() {
  for (let a = 0; a < 30; a++) {
    for (const t of await targets()) {
      const c = await connect(t).catch(() => null);
      if (!c) continue;
      const ok = await c.evalJs("typeof window.__duopulseMobilePassSave").catch(() => "");
      if (ok === "function") return c;
      c.close();
    }
    await sleep(500);
  }
  throw new Error("UI-webview мобильной ветки не найден");
}

/** Страница стенда в web-оверлее (цель по живому URL; мёртвые висят в /json). */
async function overlayPage(ui, url) {
  await ui.invoke("mobile_web_open", { url });
  for (let a = 0; a < 40; a++) {
    for (const t of await targets()) {
      if (t.url.startsWith(url)) {
        const c = await connect(t).catch(() => null);
        if (c) {
          const ready = await c.evalJs("typeof window.__dpPassWatch").catch(() => "");
          if (ready === "number") return c;
          c.close();
        }
      }
    }
    await sleep(500);
  }
  throw new Error("страница стенда в оверлее не найдена");
}

/** Заполнить и сабмитить форму в оверлее. */
const submit = (ov, user, pass) =>
  ov.evalJs(`(function(){
    document.getElementById("u").value = ${JSON.stringify(user)};
    document.getElementById("p").value = ${JSON.stringify(pass)};
    document.getElementById("f").dispatchEvent(new Event("submit", {bubbles: true}));
    return window.__dp165Submits || 0;
  })()`);

/** Состояние бара UI (хук смоука). */
const bar = (ui) => ui.evalJs("JSON.stringify(window.__duopulseMobilePassSave())")
  .then((s) => JSON.parse(s));

/** Ждать истинности выражения в оверлее (навигация роняет контекст —
 *  ловим и продолжаем опрос); null — не дождались. */
async function waitFor(ov, expr, ms = 15000) {
  for (let i = 0; i < ms / 250; i++) {
    try {
      if (await ov.evalJs(expr)) return true;
    } catch { /* контекст меняется навигацией — опрос продолжается */ }
    await sleep(250);
  }
  return false;
}

/** Перезагрузить страницу стенда и дождаться пейлоадов (новый документ —
 *  свежие маркеры __dpPassWatch/__dpPassFillWatch). */
async function reloadStand(ov) {
  try { await ov.evalJs("location.reload()"); } catch { /* контекст умер — норм */ }
  const ok = await waitFor(ov, "window.__dpPassFillWatch === 1", 15000);
  if (!ok) throw new Error("пейлоад автозаполнения не поднялся после reload");
  await sleep(500); // ready() → Core → __dpPassAccounts → иконки
}

/** Тап по иконке-ключу у поля пароля (duopulse-166); false — иконки нет. */
const tapKey = (ov) =>
  ov.evalJs(`(function(){
    var ic = document.querySelector("[data-duopulse-passkey]");
    if (!ic) return false;
    ic.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true}));
    return true;
  })()`);

/** Значения полей формы [логин, пароль]. */
const fieldValues = (ov) =>
  ov.evalJs(`JSON.stringify([document.getElementById("u").value,
    document.getElementById("p").value])`).then((s) => JSON.parse(s));

/** Иконка-ключ в DOM оверлея (null — нет). */
const hasKey = (ov) => ov.evalJs(`!!document.querySelector("[data-duopulse-passkey]")`)
  .catch(() => false);

/** Нативный нижний лист выбора аккаунта: uiautomator dump → узлы с текстом.
 *  Возвращает Map текст → центр (физические пиксели для input tap). */
function sheetRows() {
  for (let a = 0; a < 6; a++) {
    try {
      adb("shell", "uiautomator", "dump", "/sdcard/uidump.xml");
      const xml = adb("shell", "cat", "/sdcard/uidump.xml").replace(/\r/g, "");
      const rows = new Map();
      for (const m of xml.matchAll(/<node[^>]*text="([^"]+)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)) {
        const [, text, x1, y1, x2, y2] = m;
        if (text && !rows.has(text))
          rows.set(text, [Math.round((+x1 + +x2) / 2), Math.round((+y1 + +y2) / 2)]);
      }
      if (rows.size) return rows;
    } catch { /* dump гонится за анимацией — повтор */ }
    sleep(400);
  }
  return new Map();
}

try {
  adb("shell", "am", "force-stop", PKG);
  adb("shell", "logcat", "-c"); // чистый буфер: проверка «паролей в logcat нет»
  await sleep(800);
  adb("shell", "am", "start", "-n", `${PKG}/dev.duopulse.mobile.MainActivity`);
  await sleep(2500); // окно и webview поднимаются не мгновенно
  forwardCdp();
  const ui = await uiPage();
  console.log("UI-webview:", ui.url);
  // логин уникален на прогон: стор эмулятора переживает перезапуски, запись
  // прошлого прогона дала бы честный «Обновить» вместо «Сохранить»
  const USER = `artem${(Date.now() % 1e7).toString(36)}`;

  // чистый стенд: зависших кандидатов нет
  check("старт: кандидата в Core нет",
    (await ui.invoke("mobile_password_candidate", {})) === null);

  // 1) сабмит → бар → «Сохранить» → запись в списке паролей
  const ov = await overlayPage(ui, `http://10.0.2.2:${HTTP_PORT}/`);
  const n1 = await submit(ov, USER, "pass-one");
  check("сабмит дошёл до страницы", n1 === 1);
  await sleep(1200);
  let b = await bar(ui);
  check("бар «Сохранить пароль?» показан", b.open === true,
    JSON.stringify(b.view || {}));
  check("кандидат: логин/origin", b.view?.username === USER &&
    b.view?.origin === `http://10.0.2.2:${HTTP_PORT}` && b.view?.updated === false);
  shot("bar-save");
  await ui.evalJs(`document.querySelector(".m-pass-save").click()`);
  await sleep(900);
  const list1 = await ui.invoke("mobile_passwords_list", { params: { query: "", limit: 50 } });
  const rec1 = ((list1.items) || []).find((e) => e.username === USER);
  check("запись появилась в списке паролей", !!rec1, rec1 ? `id=${rec1.id}` : "нет");
  if (rec1) {
    const rev1 = await ui.invoke("mobile_passwords_reveal", { id: rec1.id });
    check("пароль записи — первый сабмит", rev1 === "pass-one");
  }
  check("после «Сохранить» бар закрыт", (await bar(ui)).open === false);

  // 2) смена пароля → бар «Обновить» → сохранить → reveal видит новый
  await submit(ov, USER, "pass-two");
  await sleep(1200);
  b = await bar(ui);
  check("смена пароля: бар «Обновить»", b.open === true && b.view?.updated === true);
  shot("bar-update");
  await ui.evalJs(`document.querySelector(".m-pass-save").click()`);
  await sleep(900);
  const rec2 = (await ui.invoke("mobile_passwords_list", { params: { query: "", limit: 50 } }))
    .items?.find((e) => e.username === USER);
  check("смена пароля: запись одна (upsert по логину)", !!rec2 && rec2.id === rec1?.id);
  if (rec2) {
    const rev2 = await ui.invoke("mobile_passwords_reveal", { id: rec2.id });
    check("пароль записи обновился", rev2 === "pass-two");
  }

  // 3b) автозаполнение (duopulse-166): перезагрузка → иконка-ключ → тап →
  //     один аккаунт заполняет форму сразу (логин+пароль в полях)
  await reloadStand(ov);
  const keyed = await waitFor(ov,
    `!!document.querySelector("[data-duopulse-passkey]")`, 8000);
  check("автозаполнение: иконка-ключ у поля пароля", keyed === true);
  shot("fill-key");
  check("автозаполнение: тап по иконке (один аккаунт)", (await tapKey(ov)) === true);
  await sleep(1200); // pick() → Core credential → __dpPassFill
  let vals = await fieldValues(ov);
  check("автозаполнение: один аккаунт заполнил логин+пароль",
    vals[0] === USER && vals[1] === "pass-two", JSON.stringify(vals));

  //     второй аккаунт сайта → тап по иконке → нативный лист имён (БЕЗ
  //     паролей) → выбор → поля заполнены вторым
  const USER2 = `alya${(Date.now() % 1e7).toString(36)}`;
  await submit(ov, USER2, "pass-b");
  await sleep(1200);
  b = await bar(ui);
  check("второй аккаунт: бар «Сохранить» показан",
    b.open === true && b.view?.updated === false, b.view?.username || "");
  await ui.evalJs(`document.querySelector(".m-pass-save").click()`);
  await sleep(900);
  await reloadStand(ov);
  await waitFor(ov, `!!document.querySelector("[data-duopulse-passkey]")`, 8000);
  check("второй аккаунт: тап по иконке (лист выбора)", (await tapKey(ov)) === true);
  await sleep(900); // нативный лист поднимается
  shot("fill-sheet");
  const rows = sheetRows();
  const pt = rows.get(USER2);
  check("лист выбора: имена обоих аккаунтов (паролей в листе нет)",
    rows.has(USER) && !!pt, [...rows.keys()].filter((k) => k.length < 30).join(", "));
  if (pt) {
    adb("shell", "input", "tap", String(pt[0]), String(pt[1]));
    await sleep(1200);
    vals = await fieldValues(ov);
    check("лист выбора: выбранный аккаунт заполнил форму",
      vals[0] === USER2 && vals[1] === "pass-b", JSON.stringify(vals));
  }

  //     пароли не светятся в logcat (захвата, автозаполнения и листа)
  const log = adb("logcat", "-d").replace(/\r/g, "");
  check("logcat прогона не содержит паролей",
    !["pass-one", "pass-two", "pass-b"].some((p) => log.includes(p)));

  // 3) «Никогда для этого сайта» → повторный сабмит бара НЕ даёт
  await submit(ov, USER, "pass-three");
  await sleep(1200);
  b = await bar(ui);
  check("третий сабмит: бар показан (deny ещё нет)", b.open === true);
  await ui.evalJs(`document.querySelector(".m-pass-never").click()`);
  await sleep(900);
  await submit(ov, USER, "pass-four");
  await sleep(1200);
  b = await bar(ui);
  check("«Никогда»: повторный сабмит бара НЕ даёт",
    b.open === false && (await ui.invoke("mobile_password_candidate", {})) === null);

  // 4) инкогнито: Core-флаг ставит mPrivate (оверлей закрывается сам),
  //    повторное открытие и сабмит — бара нет
  await ui.evalJs(`document.getElementById("mPrivate").click()`);
  await sleep(1200);
  const ov2 = await overlayPage(ui, `http://10.0.2.2:${HTTP_PORT}/`);
  // автозаполнение в инкогнито выключено (duopulse-166): пейлоад поднялся,
  // но Core ответил пустым списком — иконки-ключа нет; тап-«фантом» нечем
  await waitFor(ov2, "window.__dpPassFillWatch === 1", 10000);
  await sleep(1500);
  check("инкогнито: иконки-ключа нет (автозаполнение выключено)",
    (await hasKey(ov2)) === false);
  await submit(ov2, USER, "pass-incognito");
  await sleep(1500);
  b = await bar(ui);
  check("инкогнито: бара нет, кандидат не запомнен",
    b.open === false && (await ui.invoke("mobile_password_candidate", {})) === null);
  shot("incognito-no-bar");
  // выход из инкогнито (чистит куки/хранилища — возвращаем стенд в норму)
  await ui.evalJs(`document.getElementById("mPrivate").click()`);
  await sleep(900);

  ov.close?.();
  ov2.close?.();
  ui.close();
} catch (e) {
  results.push({ name: "стенд упал", ok: false });
  console.error("FAIL стенд:", e);
  try { shot("crash"); } catch { /* уже упали */ }
} finally {
  await server.close();
  writeFileSync(OUT, JSON.stringify({
    at: new Date().toISOString(), serial: SERIAL, results,
    passed: results.filter((r) => r.ok).length, total: results.length,
  }, null, 2));
  console.log(`итог: ${results.filter((r) => r.ok).length}/${results.length} — ${OUT}`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
