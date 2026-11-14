// E2E-мини-стенд cleartext web-оверлея в РЕЛИЗНОЙ сборке Android (карточка
// duopulse-146): http-сайты (без TLS) обязаны открываться — как в Chrome.
// Полный смоук e2e/adblock/mobile-adblock-smoke.mjs (duopulse-144) гоняется
// debug-сборкой, потому что у релиза нет CDP-сокета webview_devtools_remote
// (R8) — тот путь не годится для проверки релиза. Здесь управление чистым
// adb: тап по omnibox мобильной ветки → input text → ENTER, верификация —
// факт прихода GET на локальный http-сервер стенда (10.0.2.2 из эмулятора)
// + строки DuoPulseWeb в logcat (overlay-loaded/onReceivedError добавлены
// duopulse-146 как раз для диагностики релиза без CDP).
// Проверки:
//   1) http-страница стенда открылась в релизном оверлее: сервер видел GET,
//      в logcat overlay-loaded, нет ERR_CLEARTEXT_NOT_PERMITTED;
//   2) https-адрес по-прежнему открывается (overlay-loaded, без ошибок).
// Запуск (APK уже установлен запускающим, эмулятор поднят — как смоук 144):
//   node e2e/mobile/http-release-smoke.mjs
// Координаты omnibox: дефолт — центр экрана, 11,5% высоты (шапка: ряд кнопок
// + адресная строка); переопределяются DP146_OMNI_X / DP146_OMNI_Y (плотность
// эмуляторов разная, тапы adb — в физических пикселях).
// Результат — e2e/mobile/http-release-smoke-last-run.json (gitignore,
// рантайм-артефакт). Скриншоты — %TEMP%/duopulse-146-*.png.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PKG = "dev.duopulse.mobile";
// 8899 (порт старых стендов) на этой машине попадает в Windows excluded-
// range (Hyper-V): слушаем 8901, эмулятор ходит через 10.0.2.2:8901
// (конвенция смоука duopulse-144)
const HTTP_PORT = Number(process.env.DP146_HTTP_PORT || 8901);
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "http-release-smoke-last-run.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SERIAL = process.env.ANDROID_SERIAL ||
  execFileSync("adb", ["devices"], { encoding: "utf8" })
    .split("\n").slice(1).find((l) => l.endsWith("device"))?.split("\t")[0] || "";
const adb = (...args) =>
  execFileSync("adb", SERIAL ? ["-s", SERIAL, ...args] : args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
const shot = (name) => {
  const p = join(tmpdir(), `duopulse-146-${name}.png`);
  const buf = execFileSync("adb",
    SERIAL ? ["-s", SERIAL, "exec-out", "screencap", "-p"] : ["exec-out", "screencap", "-p"],
    { maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(p, buf);
  console.log(`скриншот: ${p}`);
};

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

// --- локальный http-сервер (dp146.html) --------------------------------------
const hits = [];
const server = createServer((req, res) => {
  hits.push({ url: req.url, at: Date.now() });
  try {
    const body = readFileSync(join(HERE, "dp146.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
  } catch {
    res.writeHead(404).end("nope");
  }
});
await new Promise((r) => server.listen(HTTP_PORT, "127.0.0.1", r));

const logcat = () => {
  try { return adb("logcat", "-d", "-s", "DuoPulseWeb"); } catch { return ""; }
};

// --- запуск приложения и ввод адреса через omnibox ----------------------------
const wm = adb("shell", "wm", "size"); // «Physical size: 1080x2400»
const m = wm.match(/(\d+)x(\d+)/);
const W = Number(process.env.DP146_OMNI_X || (m ? m[1] : 1080) / 2);
const H = Number(process.env.DP146_OMNI_Y || Math.round((m ? Number(m[2]) : 2400) * 0.115));

async function openUrl(url) {
  adb("shell", "am", "force-stop", PKG);
  await sleep(1200);
  adb("logcat", "-c");
  adb("shell", "am", "start", "-n", `${PKG}/.MainActivity`);
  await sleep(6000);
  adb("shell", "input", "tap", String(W), String(H)); // omnibox мобильной ветки
  await sleep(700);
  adb("shell", "input", "text", url);
  await sleep(500);
  adb("shell", "input", "keyevent", "66"); // ENTER (enterkeyhint=go)
}

try {
  // 1) http-страница стенда в релизном оверлее
  const httpUrl = `http://10.0.2.2:${HTTP_PORT}/dp146.html?r=${Date.now()}`;
  await openUrl(httpUrl);
  let sawHit = false;
  for (let i = 0; i < 15 && !sawHit; i++) {
    sawHit = hits.some((h) => h.url.startsWith(`/dp146.html`));
    if (!sawHit) await sleep(1000);
  }
  check("http: сервер стенда видел GET страницы", sawHit,
    `hits=${hits.length}${sawHit ? "" : " (страница не загрузилась)"}`);
  let log = logcat();
  check("http: overlay-loaded в logcat",
    log.includes(`overlay-loaded: http://10.0.2.2:${HTTP_PORT}/dp146.html`));
  check("http: ERR_CLEARTEXT_NOT_PERMITTED нет",
    !log.includes("ERR_CLEARTEXT_NOT_PERMITTED"));
  shot("http-page");

  // 2) https по-прежнему открывается (поведение не изменилось)
  await openUrl("https://example.com/");
  log = "";
  for (let i = 0; i < 15 && !log.includes("overlay-loaded: https://example.com/"); i++) {
    await sleep(1000);
    log = logcat();
  }
  check("https: overlay-loaded в logcat",
    log.includes("overlay-loaded: https://example.com/"));
  check("https: сетевых ошибок главного фрейма нет",
    !log.split("\n").some((l) => l.includes("overlay-error:")));
  shot("https-page");
} catch (e) {
  check("стенд дошёл до конца", false, String(e).slice(0, 200));
} finally {
  server.close();
  const ok = results.every((r) => r.ok);
  writeFileSync(OUT, JSON.stringify({
    when: new Date().toISOString(), ok, omnibox: { x: W, y: H }, results,
  }, null, 2));
  console.log(`\n${ok ? "OK" : "FAIL"}: ${results.filter((r) => r.ok).length}/${results.length}`);
  console.log(`отчёт: ${OUT}`);
  process.exit(ok ? 0 : 1);
}
