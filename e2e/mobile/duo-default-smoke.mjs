// E2E-смоук ДЕФОЛТА дуо-набора мобильной ветки (карточка duopulse-186,
// мобильные п.4/п.5 дуопульса-184): на видео без сигналов оригинала (все
// дорожки ручные, без asr/audioTrackId — VEVO-клипы вроде Sam Smith
// vk_xq1P7vIU, первой в списке может идти zh-Hans) дефолт обязан брать
// en-ручную, а не первую дорожку. Регрессия: видео только с asr (Gangnam)
// — оригинал остаётся asr-дорожкой, п.4 (hl-сравнение) её не вытесняет.
//
// duopulse-201: дефолт перевода — «auto» по правилу дуо duopulse-196
// (русский оригинал → gtx:en, прочие → gtx:ru) — пункт 3.
//
// Debug-сборка на эмуляторе (у релиза нет CDP-сокета webview_devtools_remote,
// конвенция смоуков duopulse-144+ — порт 9223). Сценарий:
//   1) vk_xq1P7vIU: duo-сессия стартует сама (enabled: true, перевод — авто);
//     дефолт originalId = yt:en (не yt:zh-Hans) — п.4 (defaultCaptionTrackIndex
//     hl-ответа ≠ язык UI → контентный фолбэк) и/или п.5 (en-ручная прежде
//     первой); селект панели согласован; движок грузит yt:en с репликами;
//     перевод — авто → gtx:ru, soft (внешний gtx на эмуляторе бот-блокится,
//     дуопульс-133);
//   2) 9bZkp7q19f0 (Gangnam, только asr ko): originalId = yt:ko:asr.
//   3) _wnQ3Ow02yQ (Круг «Владимирский централ», ru:asr): перевод — авто,
//     правило дуо 196 → цель gtx:en (статус «ru → en» / дорожка +gtx:en).
// Запуск (debug-APK установлен, эмулятор поднят):
//   node e2e/mobile/duo-default-smoke.mjs
// Переопределения: DUO_VIDEO_VEVO, DUO_VIDEO_ASR, DUO_VIDEO_RU, CDP_PORT.
// Результат — e2e/mobile/duo-default-smoke-last-run.json (gitignore,
// рантайм-артефакт). Скриншоты — %TEMP%/duopulse-186-*.png.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = "dev.duopulse.mobile";
const CDP_PORT = Number(process.env.CDP_PORT || 9223);
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "duo-default-smoke-last-run.json");
const VIDEO_VEVO = process.env.DUO_VIDEO_VEVO || "vk_xq1P7vIU"; // Sam Smith — ручные дорожки, без asr/audioTrackId
const VIDEO_ASR = process.env.DUO_VIDEO_ASR || "9bZkp7q19f0"; // Gangnam Style — только asr ko
const VIDEO_RU = process.env.DUO_VIDEO_RU || "_wnQ3Ow02yQ"; // Круг «Владимирский централ» — ru:asr (duopulse-201)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SERIAL = process.env.ANDROID_SERIAL ||
  execFileSync("adb", ["devices"], { encoding: "utf8" })
    .split(/\r?\n/).slice(1).find((l) => l.trim().endsWith("device"))?.split("\t")[0].trim() || "";
if (!SERIAL) throw new Error("эмулятор не найден (adb devices)");
const adb = (...args) =>
  execFileSync("adb", ["-s", SERIAL, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const shot = (name) => {
  const p = join(tmpdir(), `duopulse-186-${name}.png`);
  // Buffer без encoding: utf8-строка портила бинарные байты PNG (duopulse-166)
  writeFileSync(p, execFileSync("adb", ["-s", SERIAL, "exec-out", "screencap", "-p"], { maxBuffer: 16 * 1024 * 1024 }));
  console.log(`скриншот: ${p}`);
};

const results = [];
const check = (name, ok, extra = "", soft = false) => {
  results.push({ name, ok, soft: soft || undefined, extra: extra || undefined });
  console.log(`${ok ? "✓" : soft ? "⚠" : "✗"} ${name}${extra ? ` — ${extra}` : ""}${!ok && soft ? " (soft: не валит смоук)" : ""}`);
};

// --- CDP ------------------------------------------------------------------------
// чистый прогон: настройки duo в localStorage данных приложения — pm clear
// даёт детерминизм (enabled/translation из дефолтов)
adb("shell", "pm", "clear", PKG);
adb("shell", "am", "start", "-n", `${PKG}/.MainActivity`);
const forwardCdp = async () => {
  // после запуска приложения процесс появляется не мгновенно — ждём pid
  let p = "";
  for (let i = 0; i < 30 && !p; i++) {
    try { p = adb("shell", "pidof", PKG).trim(); } catch { /* pidof без процесса — код 1 */ }
    if (!p) await sleep(500);
  }
  if (!p) throw new Error("процесс приложения не поднялся после запуска");
  adb("forward", `tcp:${CDP_PORT}`, `localabstract:webview_devtools_remote_${p}`);
};
const targets = async () => {
  // сокет поднимается вместе с UI-webview: сразу после старта соединение
  // может отказывать — это «ещё нет»
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
  return { evalJs, close: () => ws.close() };
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

const debug = () => ui.evalJs("JSON.stringify(window.__duoDebug?.() ?? null)").then((s) => JSON.parse(s));
const openVideo = (id) => ui.evalJs(`window.__duopulseOpenVideo(${JSON.stringify(id)}); 'ok'`);
const statusText = () => ui.evalJs(`document.querySelector('.m-duo-status')?.textContent ?? ""`);

/** Дождаться duo-сессии видео и применённого дефолта: originalId присвоен
 * И стабилен (видео-вход обновляет videoId раньше, чем parsePlayerResponse
 * сменит дефолт, — ранний сэмпл ловит originalId предыдущего видео). */
async function waitDefaults(id, ms = 30000) {
  let d = null;
  for (let i = 0; i < ms / 500; i++) {
    d = await debug().catch(() => null);
    if (d && d.videoId === id && d.settings?.originalId) break;
    await sleep(500);
  }
  if (!d || d.videoId !== id) throw new Error(`видео ${id} не открылось`);
  if (!d.settings?.originalId) throw new Error(`дефолт дуо для ${id} не применился`);
  for (let i = 0; i < ms / 1500; i++) {
    await sleep(1500);
    const d2 = await debug().catch(() => null);
    if (d2?.videoId !== id) throw new Error(`видео ${id} сменилось в ожидании`);
    if (d2?.settings?.originalId === d.settings.originalId) return d2; // стабилен
    d = d2;
  }
  return d; // так и не стабилизировался — отдаём последний сэмпл
}

/** Открыть duo-панель (кнопка #mDuo, панель лениво импортируется). */
async function openPanel() {
  if (await ui.evalJs(`!!document.querySelector('.m-duo-panel')`)) return;
  await ui.evalJs(`document.querySelector('#mDuo')?.click(); 'ok'`);
  for (let i = 0; i < 20 && !(await ui.evalJs(`!!document.querySelector('.m-duo-panel')`)); i++) await sleep(300);
}

await forwardCdp();
const ui = await uiPage();

try {
  // (1) VEVO-кейс: дефолт en, не первая zh-Hans
  await openVideo(VIDEO_VEVO);
  const d1 = await waitDefaults(VIDEO_VEVO);
  await openPanel();
  await sleep(500);
  const options = await ui.evalJs(`[...document.querySelectorAll('.m-duo-original option')].map(o=>o.value).join(',')`);
  check("(1) дорожки ручные (нет asr/audio-сигналов в id)", !options.includes(":asr"), options);
  const premise = options.split(",").filter(Boolean);
  check(`(1) предпосылка: zh-Hans в списке (порядок нестабилен)`, premise.includes("yt:zh-Hans"), premise.join(" "), true);
  check("(1) дефолт оригинала — yt:en, НЕ yt:zh-Hans (п.4/п.5)", d1.settings.originalId === "yt:en", `originalId=${d1.settings.originalId}`);
  const sel = await ui.evalJs(`document.querySelector('.m-duo-original')?.value ?? ""`);
  check("(1) селект панели согласован (yt:en)", sel === "yt:en", sel);
  check("(1) перевод по дефолту — авто (правило дуо: en → gtx:ru)", d1.settings.translation === "auto", d1.settings.translation);
  // движок грузит оригинал с репликами; перевод gtx — soft (бот-блок gtx на
  // эмуляторе — внешний фактор, дуопульс-133)
  let d1e = null;
  for (let i = 0; i < 60; i++) {
    d1e = await debug().catch(() => null);
    const t0 = d1e?.engine?.tracks?.[0];
    if (t0?.id === "yt:en" && (t0?.cues ?? 0) > 0) break;
    await sleep(1000);
  }
  const t1 = d1e?.engine?.tracks ?? [];
  check("(1) движок: оригинал yt:en с репликами", t1[0]?.id === "yt:en" && (t1[0]?.cues ?? 0) > 0,
    `tracks=${t1.map((t) => `${t.id}:${t.cues}`).join(",")}`);
  shot("vevo-default");
  let translated = null;
  for (let i = 0; i < 240 && !translated; i++) {
    const d = await debug().catch(() => null);
    translated = (d?.engine?.tracks ?? []).find((t) => t.id === "yt:en+gtx:ru" && (t.cues ?? 0) > 0) ?? null;
    if (!translated) await sleep(1000);
  }
  check("(1) перевод yt:en+gtx:ru в движке (soft: gtx)", !!translated,
    translated ? `${translated.cues} реплик` : await statusText(), true);

  // (2) регрессия: asr-фолбэк жив (п.4 не вытесняет asr-оригинал)
  await openVideo(VIDEO_ASR);
  const d2 = await waitDefaults(VIDEO_ASR);
  check("(2) Gangnam: оригинал yt:ko:asr (asr-фолбэк жив)", d2.settings.originalId === "yt:ko:asr",
    `originalId=${d2.settings.originalId}`);
  shot("asr-default");

  // (3) duopulse-201: русский оригинал — цель gtx:en (правило дуо 196):
  // раньше дефолт gtx:ru равнялся языку источника и перевод молча не
  // поднимался (соло-оригинал); теперь «auto» → ru → en.
  await openVideo(VIDEO_RU);
  const d3 = await waitDefaults(VIDEO_RU);
  check("(3) перевод — авто (правило дуо не выключалось)", d3.settings.translation === "auto",
    d3.settings.translation);
  const ruOrig = d3.settings.originalId ?? "";
  check(`(3) оригинал — ru-дорожка`, /^yt:ru/.test(ruOrig), ruOrig);
  shot("ru-default");
  // правило выбрало en: статус «перевожу (ru → en)» в кольцевом логе
  // __duoDebug.statusLog (панель может открыться позже короткого статуса —
  // 429 мгновенный, строка панели его не увидит; лог от панели не зависит)
  // ИЛИ готовая дорожка +gtx:en в движке (gtx бот-блокится — дуопульс-133)
  let sawRuleEn = false;
  let ruTrans = null;
  for (let i = 0; i < 120 && !(sawRuleEn && ruTrans); i++) {
    const d = await debug().catch(() => null);
    if ((d?.statusLog ?? []).some((s) => /ru → en/.test(String(s)))) sawRuleEn = true;
    ruTrans = (d?.engine?.tracks ?? []).find((t) => /gtx:en$/.test(t.id) && (t.cues ?? 0) > 0) ?? null;
    if (!(sawRuleEn && ruTrans)) await sleep(500);
  }
  check("(3) правило 196: цель ru → en (статус конвейера или дорожка)",
    sawRuleEn || !!ruTrans, sawRuleEn ? "статус «ru → en» в логе конвейера" : "статус не пойман");
  check("(3) вторая строка gtx:en в движке (soft: gtx)", !!ruTrans,
    ruTrans ? `${ruTrans.cues} реплик` : await statusText().catch(() => ""), true);
} catch (e) {
  results.push({ name: "сценарий упал", ok: false, error: String(e) });
  console.error("ОШИБКА:", e);
} finally {
  ui?.close();
  writeFileSync(OUT, JSON.stringify({ started: new Date().toISOString(), videoVevo: VIDEO_VEVO, videoAsr: VIDEO_ASR, videoRu: VIDEO_RU, results, ok: results.every((r) => r.ok || r.soft) }, null, 2));
  const ok = results.length > 0 && results.every((r) => r.ok || r.soft);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} проверок — ${ok ? "OK" : "ЕСТЬ ПРОВАЛЫ"}`);
  console.log(`результат: ${OUT}`);
  process.exit(ok ? 0 : 1);
}
