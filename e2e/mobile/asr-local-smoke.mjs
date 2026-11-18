// E2E-смоук ЛОКАЛЬНЫХ ASR-субтитров мобильной ветки (карточка duopulse-168,
// паритет 5/8): whisper.cpp нативной libwhisperjni в APK — распознавание на
// устройстве, без сети на фазе транскрипции. Debug-сборка на эмуляторе
// (у релиза нет CDP-сокета webview_devtools_remote — конвенция duopulse-144;
// релизный R8-прогон — отдельный стенд asr-local-release-smoke.mjs).
//
// Сценарий (видео без captionTracks, то же что у облачного смоука 167):
//   1) видео без субтитров: __duopulseOpenVideo → duo-сессия без дорожек;
//   2) менеджер моделей: ⚙ → локальный блок: «На устройстве» выключена без
//     модели → «Скачать» (tiny, 78 МБ, настоящий HuggingFace) → события
//     download (байты растут, total сверен) → done (фаза приходит ТОЛЬКО
//     после sha256-проверки); файл в files/profile/asr/models — точный размер;
//   3) провайдер local + «Сохранить»: asr_get_settings provider=local,
//     localReady=true; ключа облака не касаемся;
//   4) «Распознать речь»: фазы audio→decode→transcribe→done, движок
//     local:whisper, дорожка asr:<lang> — оригинал, реплики в оверлее;
//   5) airplane mode → повтор видео: done fromCache, кэш без сети;
//   6) удаление модели: asr_model_delete → файла нет, модель не скачана,
//     «На устройстве» в панели снова выключена.
// Запуск (APK установлен, эмулятор поднят):
//   node e2e/mobile/asr-local-smoke.mjs
// Переопределения: ASR_VIDEO1 (без субтитров), CDP_PORT, ASR_MODEL_SIZE
// (tiny | base). Результат — e2e/mobile/asr-local-smoke-last-run.json
// (gitignore, рантайм-артефакт). Скриншоты — %TEMP%/duopulse-168-*.png.
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = "dev.duopulse.mobile";
const CDP_PORT = Number(process.env.CDP_PORT || 9223);
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "asr-local-smoke-last-run.json");
const VIDEO1 = process.env.ASR_VIDEO1 || "IY7WMldMdjo"; // груз. видео 2:29, без captionTracks, itag 140 (m4a) — url фетчится
// размер tiny по реестру models.rs (base — 147951465); total событий сверен
const MODEL_SIZE = process.env.ASR_MODEL_SIZE || "tiny";
const MODEL_BYTES = MODEL_SIZE === "base" ? 147951465 : 77691713;
const MODEL_FILE = MODEL_SIZE === "base" ? "ggml-base.bin" : "ggml-tiny.bin";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SERIAL = process.env.ANDROID_SERIAL ||
  execFileSync("adb", ["devices"], { encoding: "utf8" })
    .split(/\r?\n/).slice(1).find((l) => l.trim().endsWith("device"))?.split("\t")[0].trim() || "";
if (!SERIAL) throw new Error("эмулятор не найден (adb devices)");
const adb = (...args) =>
  execFileSync("adb", ["-s", SERIAL, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const shot = (name) => {
  const p = join(tmpdir(), `duopulse-168-${name}.png`);
  // Buffer без encoding: utf8-строка портила бинарные байты PNG (duopulse-166)
  writeFileSync(p, execFileSync("adb", ["-s", SERIAL, "exec-out", "screencap", "-p"], { maxBuffer: 16 * 1024 * 1024 }));
  console.log(`скриншот: ${p}`);
};

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
};

// --- CDP ----------------------------------------------------------------------
// чистый прогон: кэш asr_tracks, настройки и модели живут в данных приложения
adb("shell", "pm", "clear", PKG);
adb("shell", "am", "start", "-n", `${PKG}/.MainActivity`);
const forwardCdp = async () => {
  let p = "";
  for (let i = 0; i < 30 && !p; i++) {
    try { p = adb("shell", "pidof", PKG).trim(); } catch { /* pidof без процесса — код 1 */ }
    if (!p) await sleep(500);
  }
  if (!p) throw new Error("процесс приложения не поднялся после запуска");
  adb("forward", `tcp:${CDP_PORT}`, `localabstract:webview_devtools_remote_${p}`);
};
const targets = async () => {
  try {
    return (await (await fetch(`http://localhost:${CDP_PORT}/json`)).json()).filter((t) => t.type === "page");
  } catch {
    return [];
  }
};

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
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
  const invoke = (cmd, args) =>
    evalJs(`window.__TAURI__.core.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
  return { evalJs, invoke, close: () => ws.close() };
}

/** UI-webview DuoPulse (DOM-предикат: глобал видеовхода мобильной ветки). */
async function uiPage() {
  for (let a = 0; a < 40; a++) {
    for (const t of await targets()) {
      const c = await connect(t).catch(() => null);
      if (!c) continue;
      const ok = await c.evalJs("typeof window.__duopulseOpenVideo").catch(() => "");
      if (ok === "function") return c;
      c.close();
    }
    await sleep(500);
  }
  throw new Error("UI-webview мобильной ветки не найден");
}

// --- сценарий ------------------------------------------------------------------
await forwardCdp();
const ui = await uiPage();
// хроника событий: статусы панели мигают (перекрываются applySet), события
// subtitles:asr_progress / asr_model_progress — детерминированный лог фаз
await ui.evalJs(`window.__asrLog = []; window.__TAURI__.event.listen('subtitles:asr_progress', e => window.__asrLog.push({...e.payload, at: Date.now()})).then(u => window.__asrUnlisten = u); 'ok'`);
await ui.evalJs(`window.__asrModelLog = []; window.__TAURI__.event.listen('subtitles:asr_model_progress', e => window.__asrModelLog.push({...e.payload, at: Date.now()})).then(u => window.__asrModelUnlisten = u); 'ok'`);
const asrLog = () => ui.evalJs("JSON.stringify(window.__asrLog ?? [])").then((s) => JSON.parse(s));
const modelLog = () => ui.evalJs("JSON.stringify(window.__asrModelLog ?? [])").then((s) => JSON.parse(s));
const statusText = () => ui.evalJs(`document.querySelector('.m-duo-status')?.textContent ?? ""`);
const panel = () => ui.evalJs(`!!document.querySelector('.m-duo-panel')`);
const debug = () => ui.evalJs("JSON.stringify(window.__duoDebug?.() ?? null)").then((s) => JSON.parse(s));
const openVideo = (id) => ui.evalJs(`window.__duopulseOpenVideo(${JSON.stringify(id)}); 'ok'`);

async function waitVideo(id, ms = 30000) {
  for (let i = 0; i < ms / 500; i++) {
    const d = await debug().catch(() => null);
    if (d && d.videoId === id) return d;
    await sleep(500);
  }
  throw new Error(`видео ${id} не открылось`);
}

async function openPanel() {
  if (await panel()) return;
  await ui.evalJs(`document.querySelector('#mDuo')?.click(); 'ok'`);
  for (let i = 0; i < 20 && !(await panel()); i++) await sleep(300);
  if (!(await panel())) throw new Error("duo-панель не открылась");
}

try {
  // (1) видео без субтитров
  await openVideo(VIDEO1);
  await waitVideo(VIDEO1);
  await openPanel();
  await sleep(1500); // duo-сессия: дорожки читаются после видео-входа
  const d1b = await debug();
  check("(1) видео без дорожек: baseCount=0", d1b.baseCount === 0, `baseCount=${d1b.baseCount}`);
  check("(1) строка ASR в панели", await ui.evalJs(`!!document.querySelector('.m-duo-asr-run')`));

  // (2) менеджер моделей: настройки → локальный блок
  await ui.evalJs(`document.querySelector('.m-duo-asr-gear').click(); 'ok'`);
  await sleep(400);
  check("(2) блок локального движка в настройках", await ui.evalJs(`!!document.querySelector('.m-duo-asr-local')`));
  check("(2) «На устройстве» без модели выключена", await ui.evalJs(`document.querySelector('.m-duo-asr-prov-local')?.disabled === true`));
  check("(2) «Скачать» видна, «Удалить» скрыта", await ui.evalJs(
    `!document.querySelector('.m-duo-asr-dl')?.hidden && document.querySelector('.m-duo-asr-del')?.hidden === true`));
  // выбор размера (по умолчанию tiny; base — через ASR_MODEL_SIZE)
  await ui.evalJs(`document.querySelector('.m-duo-asr-lmodel').value = ${JSON.stringify(MODEL_SIZE)}; 'ok'`);
  await ui.evalJs(`document.querySelector('.m-duo-asr-dl').click(); 'ok'`);
  // скачивание: настоящий HuggingFace, ${Math.round(MODEL_BYTES / 1048576)} МБ — ждём до 10 минут
  let done2 = false;
  for (let i = 0; i < 600 && !done2; i++) {
    await sleep(1000);
    done2 = (await modelLog()).some((e) => e.phase === "done" || e.phase === "error");
  }
  shot("model-done");
  const log2 = await modelLog();
  const dl2 = log2.filter((e) => e.phase === "download");
  const err2 = log2.find((e) => e.phase === "error");
  check("(2) модель скачана (done после sha256-проверки)", !err2 && log2.some((e) => e.phase === "done"), err2?.error ?? "ok");
  check("(2) прогресс с байтами (download-события)", dl2.length >= 3, `${dl2.length} событий`);
  check("(2) total = размер реестра", dl2.some((e) => e.total === MODEL_BYTES), `total=${dl2.at(-1)?.total ?? "—"}, ожидалось ${MODEL_BYTES}`);
  const grow = dl2.every((e, i) => i === 0 || e.done >= dl2[i - 1].done);
  check("(2) байты растут", grow && dl2.at(-1).done === MODEL_BYTES, `последний done=${dl2.at(-1)?.done ?? "—"}`);
  // файл на месте, размер точный (хэш Core уже сверил — фаза done)
  const stat = (() => {
    try {
      return adb("shell", "run-as", PKG, "stat", "-c", "%s", `files/profile/asr/models/${MODEL_FILE}`).trim();
    } catch {
      return "";
    }
  })();
  check(`(2) файл модели ${MODEL_BYTES} байт`, stat === String(MODEL_BYTES), stat || "не найден");
  const settings2 = await ui.invoke("asr_get_settings", {});
  check(`(2) asr_get_settings: ${MODEL_SIZE} скачана`, settings2?.[MODEL_SIZE === "tiny" ? "modelTinyDownloaded" : "modelBaseDownloaded"] === true);
  // done → Core-событие → loadAsrSettings → refreshAsr — асинхронная цепочка,
  // кнопка оживает не в момент события: ждём до 5 с
  let localEnabled = false;
  for (let i = 0; i < 25 && !localEnabled; i++) {
    localEnabled = await ui.evalJs(`document.querySelector('.m-duo-asr-prov-local')?.disabled === false`);
    if (!localEnabled) await sleep(200);
  }
  check("(2) «На устройстве» стала доступной", localEnabled);

  // (3) провайдер local + сохранение
  await ui.evalJs(`document.querySelector('.m-duo-asr-prov-local').click(); 'ok'`);
  await ui.evalJs(`document.querySelector('.m-duo-asr-enabled').checked = true; 'ok'`);
  await ui.evalJs(`document.querySelector('.m-duo-asr-save').click(); 'ok'`);
  let saved = "";
  for (let i = 0; i < 20 && !/сохранены/i.test(saved); i++) {
    await sleep(400);
    saved = await statusText();
  }
  check("(3) настройки сохранены", /сохранены/i.test(saved), saved);
  const settings3 = await ui.invoke("asr_get_settings", {});
  check("(3) провайдер local, модель готова", settings3?.provider === "local" && settings3?.localReady === true,
    `provider=${settings3?.provider} localReady=${settings3?.localReady}`);

  // (3b) duopulse-182: «Отмена» в фазе СКАЧИВАНИЯ АУДИО (первый прогон,
  // кэш пуст — фаза гарантированно длится секунды). Отмена перевода на
  // живой сети недетерминирована (единственный батч летает быстрее поллинга;
  // холодный старт греет кэш gtx) — фаза перевода покрыта юнит-тестом
  // index.test.ts (зависший invoke: кнопка возвращается немедленно).
  {
    await ui.evalJs(`document.querySelector('.m-duo-asr-run').click(); 'ok'`);
    let downloading = false;
    for (let i = 0; i < 60 && !downloading; i++) {
      downloading = /Скачивание аудио|Распознавание запущено/.test(await statusText());
      if (!downloading) await sleep(120);
    }
    if (downloading) {
      await ui.evalJs(`document.querySelector('.m-duo-asr-cancel').click(); 'ok'`);
      let back = false;
      for (let i = 0; i < 25 && !back; i++) {
        back = (await ui.evalJs(`document.querySelector('.m-duo-asr-cancel')?.hidden === true`)) === true;
        if (!back) await sleep(120);
      }
      check("(3b) «Отмена» на скачивании аудио: кнопка вернулась сразу", back === true);
      await sleep(600);
      const stCancel = await statusText();
      check("(3b) статус «распознавание отменено»", /отменено/.test(stCancel), stCancel);
      await sleep(1000); // хвосты отменённого конвейера не роняют приложение
    } else {
      check("(3b) «Отмена» на скачивании аудио: кнопка вернулась сразу", false, "фаза аудио не поймана");
      check("(3b) статус «распознавание отменено»", false, "—");
    }
    shot("run0-cancel-audio");
  }

  // (4) полный прогон локальным движком: фазы → готово → дорожка → реплики
  await ui.evalJs(`document.querySelector('.m-duo-asr-run').click(); 'ok'`);
  const phases = [];
  let final = "";
  // транскрипция whisper на CPU эмулятора — до 5 минут
  for (let i = 0; i < 600 && !/^Готово/.test(final); i++) {
    const s = await statusText();
    if (s && s !== phases[phases.length - 1]) phases.push(s);
    final = s;
    await sleep(500);
  }
  shot("run1-done");
  check("(4) прогресс виден (фазы до «Готово»)", phases.length >= 2, phases.slice(0, 4).join(" | "));
  const log4 = await asrLog();
  const done4 = log4.find((e) => e.phase === "done" && !e.fromCache);
  check("(4) «распознано N реплик» (событие done)", (done4?.done ?? 0) >= 1, `done=${done4?.done ?? 0}`);
  check("(4) движок local:whisper", log4.some((e) => e.engine === "local:whisper"), log4[0]?.engine ?? "—");
  const ph4 = log4.map((e) => e.phase);
  check("(4) события: audio→decode→transcribe→done", ["audio", "decode", "transcribe", "done"].every((p) => ph4.includes(p)), ph4.join("→"));
  const d4 = await debug();
  check("(4) дорожка asr:<lang> в duo", d4.asrTracks.length === 1 && d4.asrTracks[0].startsWith("asr:"), String(d4.asrTracks));
  const sel = await ui.evalJs(`[...document.querySelectorAll('.m-duo-original option')].map(o=>o.value).join(',')`);
  check("(4) asr-дорожка выбрана оригиналом", sel === d4.asrTracks[0], sel);
  // реплики в оверлее: тап в центр ВИДИМОГО iframe-плеера (физические пиксели)
  const tapVideo = async () => {
    const r = await ui.evalJs(`(() => {
      const f = [...document.querySelectorAll('iframe.m-tab')].find((x) => x.offsetParent !== null);
      if (!f) return null;
      const b = f.getBoundingClientRect();
      return JSON.stringify({ x: (b.left + b.width / 2) * devicePixelRatio, y: (b.top + b.height / 2) * devicePixelRatio });
    })()`).catch(() => null);
    if (r) adb("shell", "input", "tap", String(Math.round(r.x)), String(Math.round(r.y)));
    return !!r;
  };
  let rowsSeen = false;
  for (let i = 0; i < 60 && !rowsSeen; i++) {
    if (i % 8 === 0) await tapVideo();
    const d = await debug().catch(() => null);
    rowsSeen = (d?.engine?.activeRows?.length ?? 0) > 0;
    await sleep(500);
  }
  shot("run1-rows");
  const d4b = (await debug().catch(() => null)) ?? {};
  check("(4) дорожка работает (cues в движке)", (d4b.engine?.tracks?.[0]?.cues ?? 0) > 0, `cues=${d4b.engine?.tracks?.[0]?.cues}`);

  // язык ASR-дорожки (asr:<lang>) — для холодных пар перевода фазы 5
  const asrLang = ((d4.asrTracks ?? [])[0] ?? "as:").slice(4) || "en";

  // (5) airplane mode → повтор видео из кэша (сеть не нужна вовсе) +
  // duopulse-182: офлайн-перевод — честная статус-ошибка и возврат кнопки,
  // а не вечное «Отмена» (нашли релизным смоуком 168). Пара <asr-lang>→uk
  // холодная — кэш gtx прогона 4 не маскирует отсутствие сети.
  adb("shell", "cmd", "connectivity", "airplane-mode", "enable");
  await sleep(3000);
  await openVideo(VIDEO1);
  await waitVideo(VIDEO1);
  await openPanel();
  // пару для перевода переключаем ДО прогона: applySet повтора пойдёт в
  // холодный кэш → честная сеть → офлайн-отказ (быстрый fast-fail Rust)
  const asrLang5 = asrLang; // язык ASR-дорожки не менялся между фазами
  const colds5 = ["en", "uk", "de"].filter((l) => l !== asrLang5);
  await ui.evalJs(`(() => { const s = document.querySelector('.m-duo-trans'); s.value = 'gtx:${colds5[1] ?? colds5[0]}'; s.dispatchEvent(new Event('change')); })(); 'ok'`);
  const log5Before = (await asrLog()).length;
  await ui.evalJs(`document.querySelector('.m-duo-asr-run').click(); 'ok'`);
  let d5 = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    d5 = await debug().catch(() => null);
    if (d5?.asrTracks?.length > 0 && (d5.engine?.tracks?.length ?? 0) > 0) break;
  }
  shot("run2-cache-airplane");
  const log5 = (await asrLog()).slice(log5Before);
  check("(5) airplane: событие done fromCache", log5.some((e) => e.phase === "done" && e.fromCache === true), log5.map((e) => `${e.phase}${e.fromCache ? "*" : ""}`).join(","));
  check("(5) дорожка из кэша работает", (d5?.engine?.tracks?.[0]?.cues ?? 0) > 0, `cues=${d5?.engine?.tracks?.[0]?.cues}`);
  let fail2 = "";
  for (let i = 0; i < 100 && !/перевод недоступен/.test(fail2); i++) {
    fail2 = await statusText();
    if (!/перевод недоступен/.test(fail2)) await sleep(300);
  }
  check("(5) airplane: статус-ошибка «перевод недоступен» (не «занято»)", /перевод недоступен/.test(fail2), fail2);
  check("(5) строка статуса крашится ошибкой (m-err)",
    (await ui.evalJs(`document.querySelector('.m-duo-status')?.classList.contains('m-err') ?? false`)) === true);
  let btnBack = false;
  for (let i = 0; i < 20 && !btnBack; i++) {
    btnBack = (await ui.evalJs(`document.querySelector('.m-duo-asr-run')?.hidden === false`)) === true;
    if (!btnBack) await sleep(250);
  }
  check("(5) кнопка «Распознать речь» вернулась (нет вечного «Отмена»)", btnBack === true);
  adb("shell", "cmd", "connectivity", "airplane-mode", "disable");
  adb("shell", "svc", "wifi", "enable"); // эмулятор не всегда поднимает сеть сам
  await sleep(3000);

  // (6) удаление модели: файла нет, провайдер больше не предлагается.
  // Идём через кнопку панели (asr_model_delete не эмитит событий — панель
  // обновляет снимок ответом команды; прямой invoke панель бы не обновил)
  await ui.evalJs(`document.querySelector('.m-duo-asr-gear').click(); 'ok'`);
  await sleep(400);
  const delVisible = await ui.evalJs(`!document.querySelector('.m-duo-asr-del')?.hidden`);
  check("(6) «Удалить» видна (модель скачана)", delVisible === true);
  await ui.evalJs(`document.querySelector('.m-duo-asr-del').click(); 'ok'`);
  await sleep(800);
  const settings6 = await ui.invoke("asr_get_settings", {});
  check(`(6) модель ${MODEL_SIZE} удалена из профиля`, settings6?.[MODEL_SIZE === "tiny" ? "modelTinyDownloaded" : "modelBaseDownloaded"] === false && settings6?.localReady === false);
  let fileGone = false;
  try {
    adb("shell", "run-as", PKG, "stat", "-c", "%s", `files/profile/asr/models/${MODEL_FILE}`);
  } catch { fileGone = true; /* stat без файла — код 1 */ }
  check("(6) файла модели нет", fileGone);
  let localDisabledAgain = false;
  for (let i = 0; i < 15 && !localDisabledAgain; i++) {
    localDisabledAgain = await ui.evalJs(`document.querySelector('.m-duo-asr-prov-local')?.disabled === true`);
    if (!localDisabledAgain) await sleep(300);
  }
  check("(6) «На устройстве» снова выключена", localDisabledAgain);
  shot("model-deleted");
} catch (e) {
  results.push({ name: "сценарий упал", ok: false, error: String(e) });
  try { adb("shell", "cmd", "connectivity", "airplane-mode", "disable"); } catch { /* максимум стараемся */ }
  console.error("ОШИБКА:", e);
} finally {
  ui?.close();
  writeFileSync(OUT, JSON.stringify({ started: new Date().toISOString(), video1: VIDEO1, model: MODEL_SIZE, results, ok: results.every((r) => r.ok) }, null, 2));
  const ok = results.length > 0 && results.every((r) => r.ok);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} проверок — ${ok ? "OK" : "ЕСТЬ ПРОВАЛЫ"}`);
  console.log(`результат: ${OUT}`);
  process.exit(ok ? 0 : 1);
}
