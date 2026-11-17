// E2E-смоук облачных ASR-субтитров мобильной ветки (карточка duopulse-167,
// паритет 4/8): «Распознать речь» для видео без дорожек — OpenAI-совместимый
// провайдер. Debug-сборка на эмуляторе (у релиза нет CDP-сокета
// webview_devtools_remote, конвенция смоука duopulse-144 — порт 9223).
//
// Облако-двойник поднимает сам стенд: whisper-server (e2e/asr/.cache —
// готовит prepare.mjs по требованию) + OpenAI-совместимый прокси
// (этот билд whisper.cpp не имеет /v1/audio/transcriptions): прокси слушает
// на 127.0.0.1, из эмулятора виден как 10.0.2.2. Кнопка «hang» (задержка
// ответа) делает детерминированной проверку отмены на фазе transcribe.
//
// Сценарий (видео по умолчанию — без captionTracks, проверяется в (1)):
//   1) видео без субтитров: __duopulseOpenVideo → duo-сессия без дорожек;
//   2) настройки: ⚙ → адрес 10.0.2.2:PORT/v1 + модель + ключ → сохранены;
//   3) «Распознать речь»: статусы фаз (аудио/декод/распознавание) → «Готово:
//     распознано N реплик», дорожка asr:<lang> в селекте и движке, реплики
//     в оверлее (тап по плееру — автоплей/embed);
//   4) ключ только в Keystore: run-as grep по файлам приложения — ключа нет,
//     asr_get_settings().hasApiKey true;
//   5) отмена: второе видео, прокси «висит» 12 с → «Отмена» → статус
//     «duo: распознавание отменено» (после ответа Core видит поколение);
//   6) airplane mode → повтор первого видео: «Субтитры из кэша ASR», кэш
//     отвечает без сети (прокси-хитов 0), дорожка работает.
// Запуск (APK установлен, эмулятор поднят):
//   node e2e/mobile/asr-cloud-smoke.mjs
// Переопределения: ASR_VIDEO1/ASR_VIDEO2 (без субтитров), CDP_PORT,
// ASR_PROXY_PORT (из эмулятора — 10.0.2.2:этот_порт).
// Результат — e2e/mobile/asr-cloud-smoke-last-run.json (gitignore,
// рантайм-артефакт). Скриншоты — %TEMP%/duopulse-167-*.png.
import { execFile, execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = "dev.duopulse.mobile";
const CDP_PORT = Number(process.env.CDP_PORT || 9223);
const HERE = dirname(fileURLToPath(import.meta.url));
const ASR = join(HERE, "..", "asr");
const ENGINE = join(ASR, ".cache", "bin", "whisper-server.exe");
const MODEL = join(ASR, ".cache", "models", "ggml-base.bin");
const OUT = join(HERE, "asr-cloud-smoke-last-run.json");
const VIDEO1 = process.env.ASR_VIDEO1 || "IY7WMldMdjo"; // груз. видео 2:29, без captionTracks, itag 140 (m4a) — url фетчится
const VIDEO2 = process.env.ASR_VIDEO2 || "6m_vsxvPTiE"; // груз. short ~70 с, без captionTracks (тапов нет)
const API_KEY = "sk-167smoke-secret";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SERIAL = process.env.ANDROID_SERIAL ||
  execFileSync("adb", ["devices"], { encoding: "utf8" })
    .split(/\r?\n/).slice(1).find((l) => l.trim().endsWith("device"))?.split("\t")[0].trim() || "";
if (!SERIAL) throw new Error("эмулятор не найден (adb devices)");
const adb = (...args) =>
  execFileSync("adb", ["-s", SERIAL, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const shot = (name) => {
  const p = join(tmpdir(), `duopulse-167-${name}.png`);
  // Buffer без encoding: utf8-строка портила бинарные байты PNG (duopulse-166);
  // screencap PNG ~1 МБ — больше дефолтного maxBuffer execFileSync
  writeFileSync(p, execFileSync("adb", ["-s", SERIAL, "exec-out", "screencap", "-p"], { maxBuffer: 16 * 1024 * 1024 }));
  console.log(`скриншот: ${p}`);
};

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
};

// --- движок: whisper-server + OpenAI-совместимый прокси ------------------------
if (!existsSync(ENGINE) || !existsSync(MODEL)) {
  console.log("whisper-server/модель не найдены — готовит prepare.mjs …");
  execFileSync(process.execPath, [join(ASR, "prepare.mjs")], { stdio: "inherit" });
}
const state = { hangMs: 0, hits: 0 };
const WS_PORT = 8897;
const whisper = spawn(ENGINE, ["-m", MODEL, "--port", String(WS_PORT), "--host", "127.0.0.1"], { stdio: "ignore" });
const PROXY_PORT = Number(process.env.ASR_PROXY_PORT || 8910 + (Date.now() % 40));
const CLOUD = `http://10.0.2.2:${PROXY_PORT}/v1`;

function parseMultipart(body, boundary) {
  const fields = new Map();
  let file = null;
  const delim = Buffer.from(`--${boundary}`);
  let i = body.indexOf(delim);
  while (i !== -1) {
    const start = i + delim.length;
    const next = body.indexOf(delim, start);
    if (next === -1) break;
    let part = body.subarray(start, next);
    if (part.subarray(0, 2).toString() === "\r\n") part = part.subarray(2);
    if (part.subarray(part.length - 2).toString() === "\r\n") part = part.subarray(0, part.length - 2);
    const split = part.indexOf("\r\n\r\n");
    if (split !== -1) {
      const headers = part.subarray(0, split).toString();
      const content = part.subarray(split + 4);
      const name = /name="([^"]*)"/.exec(headers)?.[1];
      if (name === "file") file = content;
      else fields.set(name, content.toString());
    }
    i = next;
  }
  return { fields, file };
}

function buildMultipart(fields, file) {
  const b = "----duopulse167stand";
  const parts = [];
  for (const [k, v] of Object.entries(fields))
    parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n`));
  parts.push(file, Buffer.from(`\r\n--${b}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${b}` };
}

const proxy = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (!req.url.startsWith("/v1/audio/transcriptions")) {
      res.writeHead(404).end();
      return;
    }
    const boundary = /boundary=(.+)$/.exec(req.headers["content-type"] || "")?.[1];
    const { fields, file } = boundary ? parseMultipart(Buffer.concat(chunks), boundary) : {};
    if (!file) {
      res.writeHead(400).end("no file");
      return;
    }
    state.hits++;
    const fwd = { response_format: "verbose_json" };
    for (const k of ["language", "prompt", "temperature"]) if (fields.has(k)) fwd[k] = fields.get(k);
    const mp = buildMultipart(fwd, file);
    const go = () => {
      const up = fetch(`http://127.0.0.1:${WS_PORT}/inference`, { method: "POST", headers: { "Content-Type": mp.contentType } , body: mp.body });
      up.then((r) => r.text().then((t) => res.writeHead(r.status, { "Content-Type": "application/json" }).end(t)))
        .catch(() => res.writeHead(502).end("upstream error"));
    };
    if (state.hangMs > 0) setTimeout(go, state.hangMs);
    else go();
    console.log(`[cloud] файл ${Math.round(file.length / 1024)} КБ, lang=${fwd.language ?? "—"}`);
  });
});
await new Promise((r) => proxy.listen(PROXY_PORT, "127.0.0.1", r));
console.log(`облако-двойник: whisper-server :${WS_PORT}, OpenAI-прокси :${PROXY_PORT} (${CLOUD})`);

// --- CDP ----------------------------------------------------------------------
// чистый прогон: кэш asr_tracks и настройки живут в данных приложения —
// pm clear даёт детерминизм (повторный запуск видео снова идёт в облако)
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
  // сокет webview_devtools_remote поднимается вместе с UI-webview: сразу
  // после старта приложения соединение может отказывать — это «ещё нет»
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
// лог событий конвейера: статусы в панели мигают (перекрываются applySet),
// события subtitles:asr_progress — детерминированная хроника фаз
await ui.evalJs(`window.__asrLog = []; window.__TAURI__.event.listen('subtitles:asr_progress', e => window.__asrLog.push({...e.payload, at: Date.now()})).then(u => window.__asrUnlisten = u); 'ok'`);
const asrLog = () => ui.evalJs("JSON.stringify(window.__asrLog ?? [])").then((s) => JSON.parse(s));
const statusText = () => ui.evalJs(`document.querySelector('.m-duo-status')?.textContent ?? ""`);
const panel = () => ui.evalJs(`!!document.querySelector('.m-duo-panel')`);
const debug = () => ui.evalJs("JSON.stringify(window.__duoDebug?.() ?? null)").then((s) => JSON.parse(s));
const openVideo = (id) => ui.evalJs(`window.__duopulseOpenVideo(${JSON.stringify(id)}); 'ok'`);

/** Дождаться duo-сессии видео (videoId в __duoDebug). */
async function waitVideo(id, ms = 30000) {
  for (let i = 0; i < ms / 500; i++) {
    const d = await debug().catch(() => null);
    if (d && d.videoId === id) return d;
    await sleep(500);
  }
  throw new Error(`видео ${id} не открылось`);
}

/** Открыть duo-панель (кнопка #mDuo, панель лениво импортируется). */
async function openPanel() {
  if (await panel()) return;
  await ui.evalJs(`document.querySelector('#mDuo')?.click(); 'ok'`);
  for (let i = 0; i < 20 && !(await panel()); i++) await sleep(300);
  if (!(await panel())) throw new Error("duo-панель не открылась");
}

try {
  // (1) видео без субтитров
  await openVideo(VIDEO1);
  const d1 = await waitVideo(VIDEO1);
  await openPanel();
  await sleep(1500); // duo-сессия: дорожки читаются после видео-входа
  const d1b = await debug();
  check("(1) видео без дорожек: baseCount=0", d1b.baseCount === 0, `baseCount=${d1b.baseCount}`);
  check("(1) строка ASR в панели", await ui.evalJs(`!!document.querySelector('.m-duo-asr-run')`));

  // (2) настройки облака: ключ уходит в Keystore
  await ui.evalJs(`document.querySelector('.m-duo-asr-gear').click(); 'ok'`);
  await ui.evalJs(`document.querySelector('.m-duo-asr-url').value = ${JSON.stringify(CLOUD)}; 'ok'`);
  await ui.evalJs(`document.querySelector('.m-duo-asr-model').value = 'whisper-1'; 'ok'`);
  await ui.evalJs(`document.querySelector('.m-duo-asr-key').value = ${JSON.stringify(API_KEY)}; 'ok'`);
  await ui.evalJs(`document.querySelector('.m-duo-asr-enabled').checked = true; 'ok'`);
  await ui.evalJs(`document.querySelector('.m-duo-asr-save').click(); 'ok'`);
  let saved = "";
  for (let i = 0; i < 20 && !/сохранены/i.test(saved); i++) {
    await sleep(400);
    saved = await statusText();
  }
  check("(2) настройки сохранены", /сохранены/i.test(saved), saved);

  // (3) полный прогон: прогресс → готово → дорожка → реплики
  const hitsBefore = state.hits;
  await ui.evalJs(`document.querySelector('.m-duo-asr-run').click(); 'ok'`);
  const phases = [];
  let final = "";
  for (let i = 0; i < 1000 && !/^Готово/.test(final); i++) {
    const s = await statusText();
    if (s && s !== phases[phases.length - 1]) phases.push(s);
    final = s;
    await sleep(300);
  }
  shot("run1-done");
  check("(3) прогресс виден (фазы до «Готово»)", phases.length >= 2, phases.slice(0, 4).join(" | "));
  const log3 = await asrLog();
  const done3 = log3.find((e) => e.phase === "done" && !e.fromCache);
  check("(3) «распознано N реплик» (событие done)", (done3?.done ?? 0) >= 1, `done=${done3?.done ?? 0} (статус мигнул: «${final.slice(0, 40)}» — applySet перекрывает)`);
  check("(3) облако получило аудио (прокси-хиты)", state.hits > hitsBefore, `+${state.hits - hitsBefore}`);
  const ph3 = log3.map((e) => e.phase);
  check("(3) события: audio→decode→transcribe→done", ["audio", "decode", "transcribe", "done"].every((p) => ph3.includes(p)), ph3.join("→"));
  const d3 = await debug();
  check("(3) дорожка asr:<lang> в duo", d3.asrTracks.length === 1 && d3.asrTracks[0].startsWith("asr:"), String(d3.asrTracks));
  const sel = await ui.evalJs(`[...document.querySelectorAll('.m-duo-original option')].map(o=>o.value).join(',')`);
  check("(3) asr-дорожка выбрана оригиналом", sel === d3.asrTracks[0], sel);
  // реплики в оверлее: тап в центр ВИДИМОГО iframe-плеера (координаты из
  // DOM × dpr — физические пиксели; shorts-плееры тапом уводят в оверлей,
  // для обычных видео тап по центру = play)
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
    if (i % 8 === 0) await tapVideo(); // повторный тач: пауза/продолжить не ловим
    const d = await debug().catch(() => null);
    rowsSeen = (d?.engine?.activeRows?.length ?? 0) > 0;
    await sleep(500);
  }
  shot("run1-rows");
  const d3b = (await debug().catch(() => null)) ?? {};
  check("(3) дорожка работает (кues в движке)", (d3b.engine?.tracks?.[0]?.cues ?? 0) > 0, `cues=${d3b.engine?.tracks?.[0]?.cues}`);
  check("(3) реплики в оверлее", rowsSeen, `activeRows=${d3b.engine?.activeRows?.length ?? 0}`);

  // (4) ключ только в Android Keystore: в файлах приложения ключа нет
  let keyOnDisk = "";
  try {
    keyOnDisk = execFileSync("adb", ["-s", SERIAL, "exec-out", "run-as", PKG, "sh", "-c",
      `grep -rl ${API_KEY} files/ 2>/dev/null | head -1`], { encoding: "utf8" }).trim();
  } catch { /* grep без совпадений — выход 1 */ }
  check("(4) ключа НЕТ в файлах приложения", !keyOnDisk, keyOnDisk || "чисто");
  const settings = await ui.invoke("asr_get_settings", {});
  check("(4) asr_get_settings: hasApiKey true", settings?.hasApiKey === true);

  // (5) отмена: прокси висит 12 с → «Отмена» на фазе распознавания
  await openVideo(VIDEO2);
  await waitVideo(VIDEO2);
  await openPanel();
  state.hangMs = 12000;
  await ui.evalJs(`document.querySelector('.m-duo-asr-run').click(); 'ok'`);
  let cancelShown = false;
  for (let i = 0; i < 60 && !cancelShown; i++) {
    await sleep(300);
    cancelShown = await ui.evalJs(`!document.querySelector('.m-duo-asr-cancel')?.hidden`);
  }
  check("(5) «Отмена» видна, пока конвейер занят", cancelShown);
  await ui.evalJs(`document.querySelector('.m-duo-asr-cancel').click(); 'ok'`);
  let cancelled = "";
  for (let i = 0; i < 80 && !/отменено/.test(cancelled); i++) {
    await sleep(500); // прокси отпустит ответ через 12 с — Core увидит поколение
    cancelled = await statusText();
  }
  state.hangMs = 0;
  shot("run2-cancel");
  check("(5) статус «распознавание отменено»", /отменено/.test(cancelled), cancelled);
  const d5 = (await debug().catch(() => null)) ?? { asr: {} };
  check("(5) после отмены конвейер свободен", d5.asr?.busy === false, JSON.stringify(d5.asr));

  // (6) airplane mode → повтор первого видео из кэша
  adb("shell", "cmd", "connectivity", "airplane-mode", "enable");
  await sleep(3000);
  await openVideo(VIDEO1);
  await waitVideo(VIDEO1);
  await openPanel();
  const hits6 = state.hits;
  const log6Before = (await asrLog()).length;
  await ui.evalJs(`document.querySelector('.m-duo-asr-run').click(); 'ok'`);
  // кэш отвечает мгновенно: ждём событие done fromCache или дорожку в движке
  let d6 = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    d6 = await debug().catch(() => null);
    if (d6?.asrTracks?.length > 0 && (d6.engine?.tracks?.length ?? 0) > 0) break;
  }
  shot("run3-cache-airplane");
  const log6 = (await asrLog()).slice(log6Before);
  check("(6) airplane: событие done fromCache (из кэша)", log6.some((e) => e.phase === "done" && e.fromCache === true), log6.map((e) => `${e.phase}${e.fromCache ? "*" : ""}`).join(","));
  check("(6) сети не было (прокси-хитов 0)", state.hits === hits6, `+${state.hits - hits6}`);
  check("(6) дорожка из кэша работает", (d6?.engine?.tracks?.[0]?.cues ?? 0) > 0, `cues=${d6?.engine?.tracks?.[0]?.cues}`);
  adb("shell", "cmd", "connectivity", "airplane-mode", "disable");
  await sleep(3000);
} catch (e) {
  results.push({ name: "сценарий упал", ok: false, error: String(e) });
  try { adb("shell", "cmd", "connectivity", "airplane-mode", "disable"); } catch { /* максимум стараемся */ }
  console.error("ОШИБКА:", e);
} finally {
  ui?.close();
  writeFileSync(OUT, JSON.stringify({ started: new Date().toISOString(), video1: VIDEO1, video2: VIDEO2, cloud: CLOUD, results, ok: results.every((r) => r.ok) }, null, 2));
  proxy.close();
  whisper.kill();
  const ok = results.length > 0 && results.every((r) => r.ok);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} проверок — ${ok ? "OK" : "ЕСТЬ ПРОВАЛЫ"}`);
  console.log(`результат: ${OUT}`);
  process.exit(ok ? 0 : 1);
}
