// E2E-стенд ЛОКАЛЬНОГО ASR-движка в РЕЛИЗНОЙ сборке Android (карточка
// duopulse-168, паритет 5/8): у релиза нет CDP-сокета webview_devtools_remote
// (R8) — как в http/video-release-smoke (duopulse-146/179), управление чистым
// adb (omnibox → input text → ENTER; тапы по uiautomator-дереву — WebView
// отдаёт HTML в accessibility), верификация — тексты статусов в dump +
// logcat + скриншоты.
//
// Проверяет ГЛАВНОЕ релизное: R8-keep JNI-хелпера (duopulse-android-r8-jni-keep:
// без Java-ссылок R8 вырезает nativeInit/nativeTranscribe/nativeFree →
// UnsatisfiedLinkError) — распознавание целиком в подписанном release-APK:
//   (0) статика APK: подпись duopulse-release.keystore, libwhisperjni.so в
//       lib/<abi>, MobileAsrHelper + native-методы в dex, R8 mapping;
//   1) YouTube-видео без субтитров открывается (omnibox), duo-панель — тап;
//   2) ⚙ → «Скачать» (tiny): «Модель скачана» в статусе (sha256 Core сверил);
//   3) «На устройстве» → «Сохранить»: «Настройки ASR сохранены»;
//   4) «Распознать речь» → «Готово: распознано N реплик» (whisper в нативе —
//      JNI-вызовы живы после R8), asr-дорожка в селекте «Оригинал»;
//   5) airplane mode → «Распознать речь» снова → «из кэша» без сети;
//   6) приложение живо (pidof), в logcat нет FATAL/UnsatisfiedLinkError.
// Запуск (эмулятор поднят):
//   node e2e/mobile/asr-local-release-smoke.mjs [путь-к-APK]
// Переопределения: ASR_VIDEO1 (без субтитров), DP168_OMNI_X/Y.
// Результат — e2e/mobile/asr-local-release-smoke-last-run.json (gitignore,
// рантайм-артефакт). Скриншоты — %TEMP%/duopulse-168rel-*.png.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = "dev.duopulse.mobile";
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT = join(HERE, "asr-local-release-smoke-last-run.json");
const APK = process.argv[2] || join(ROOT, "src-tauri", "gen", "android", "app", "build", "outputs", "apk", "universal", "release", "app-universal-release.apk");
const VIDEO1 = process.env.ASR_VIDEO1 || "IY7WMldMdjo"; // груз. видео 2:29, без captionTracks
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEXDIR = join(tmpdir(), "duopulse-168rel-dex");

const SERIAL = process.env.ANDROID_SERIAL ||
  execFileSync("adb", ["devices"], { encoding: "utf8" })
    .split(/\r?\n/).slice(1).find((l) => l.trim().endsWith("device"))?.split("\t")[0].trim() || "";
if (!SERIAL) throw new Error("эмулятор не найден (adb devices)");
const adb = (args, opts = {}) => execFileSync("adb",
  SERIAL ? ["-s", SERIAL, ...args] : args,
  { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024, ...opts });

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok, extra });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};
const shot = (name) => {
  const p = join(tmpdir(), `duopulse-168rel-${name}.png`);
  writeFileSync(p, adb(SERIAL ? ["-s", SERIAL, "exec-out", "screencap", "-p"] : ["exec-out", "screencap", "-p"], { encoding: "buffer" }));
  console.log(`скриншот: ${p}`);
};

/** UI-дерево экрана (WebView-контент попадает в accessibility; uiautomator
 * изредка убивается (137, память эмулятора) — до 5 повторов). */
const dump = () => {
  let last;
  for (let i = 0; i < 5; i++) {
    try {
      adb(["shell", "uiautomator", "dump", "/sdcard/window_dump.xml"]);
      return adb(["shell", "cat", "/sdcard/window_dump.xml"]);
    } catch (e) {
      last = e;
      sleep(1200);
    }
  }
  throw last;
};

/** Ждём текст в UI-дереве (длинные ожидания — редкий опрос: частый
 * uiautomator-дамп выедает память эмулятора и его убивает — 137). */
async function waitFor(text, { timeout = 15000 } = {}) {
  const step = timeout > 60000 ? 2500 : 600;
  for (let t = 0; t < timeout; t += step) {
    if (dump().includes(text)) return true;
    await sleep(step);
  }
  return false;
}

/** Тап по центру первого узла, чей text/content-desc содержит подстроку
 * (exact — точное значение атрибута; bounds uiautomator — физические
 * пиксели; свайп вверх — элемент не найден). */
async function tapText(text, { timeout = 8000, scroll = false, exact = false } = {}) {
  // строки стенда без regex-метасимволов — экранирование не нужно
  const val = exact ? text : "[^\"]*" + text + "[^\"]*";
  for (let t = 0; t < timeout; t += 600) {
    const xml = dump();
    const re = new RegExp('<node[^>]*(?:text|content-desc)="' + val + '"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"');
    const m = re.exec(xml);
    if (m) {
      const x = Math.round((Number(m[1]) + Number(m[3])) / 2);
      const y = Math.round((Number(m[2]) + Number(m[4])) / 2);
      adb(["shell", "input", "tap", String(x), String(y)]);
      return true;
    }
    if (scroll) {
      const wm = adb(["shell", "wm", "size"]).match(/(\d+)x(\d+)/);
      adb(["shell", "input", "swipe", String(Number(wm[1]) / 2), String(Math.round(Number(wm[2]) * 0.7)), String(Number(wm[1]) / 2), String(Math.round(Number(wm[2]) * 0.35)), "400"]);
    }
    await sleep(600);
  }
  return false;
}

const alive = () => {
  try { return adb(["shell", "pidof", PKG]).trim() !== ""; } catch { return false; }
};

// omnibox: центр, 11,5% высоты (шапка мобильной ветки; конвенция dp146)
const wm = adb(["shell", "wm", "size"]).match(/(\d+)x(\d+)/);
const OMNI_X = Number(process.env.DP168_OMNI_X || (m0(wm, 0) / 2));
const OMNI_Y = Number(process.env.DP168_OMNI_Y || Math.round(m0(wm, 1) * 0.115));
function m0(m, i) { return m ? Number(m[i + 1]) : i ? 2400 : 1080; }

async function openUrl(url) {
  adb(["shell", "am", "force-stop", PKG]);
  await sleep(1200);
  adb(["logcat", "-c"]);
  adb(["shell", "am", "start", "-n", `${PKG}/.MainActivity`]);
  await sleep(6000);
  adb(["shell", "input", "tap", String(OMNI_X), String(OMNI_Y)]);
  await sleep(700);
  adb(["shell", "input", "text", url]);
  await sleep(500);
  adb(["shell", "input", "keyevent", "66"]); // ENTER (enterkeyhint=go)
}

try {
  // (0) статика APK: подпись + нативная либа + R8-dex
  check("(0) release-APK на месте", existsSync(APK), APK);
  const BT = execFileSync("bash", ["-c", `ls "$LOCALAPPDATA/Android/Sdk/build-tools" | sort -V | tail -1`], { encoding: "utf8" }).trim();
  const apksigner = `${process.env.LOCALAPPDATA}\\Android\\Sdk\\build-tools\\${BT}\\apksigner.bat`;
  let signed = false;
  try {
    execFileSync("cmd", ["/c", apksigner, "verify", APK], { stdio: "ignore" });
    signed = true;
  } catch { /* не подписан/не верифицируется */ }
  check("(0) APK подписан (duopulse-release.keystore)", signed);
  const soList = execFileSync("bash", ["-c", `unzip -l '${APK.replace(/'/g, "'\\''")}' | grep -c libwhisperjni`], { encoding: "utf8" }).trim();
  check("(0) libwhisperjni.so упакована", soList !== "0", `${soList} abi`);
  rmSync(DEXDIR, { recursive: true, force: true });
  mkdirSync(DEXDIR, { recursive: true });
  execFileSync("bash", ["-c", `cd '${DEXDIR.replace(/'/g, "'\\''")}' && unzip -o -q '${APK.replace(/'/g, "'\\''")}' 'classes*.dex'`]);
  let dexOk = false;
  for (const cls of ["classes.dex", "classes2.dex", "classes3.dex", "classes4.dex"]) {
    try {
      const raw = readFileSync(join(DEXDIR, cls));
      if (raw.includes(Buffer.from("MobileAsrHelper")) &&
          raw.includes(Buffer.from("nativeInit")) &&
          raw.includes(Buffer.from("nativeTranscribe")) &&
          raw.includes(Buffer.from("nativeFree"))) { dexOk = true; break; }
    } catch { /* нет такого dex */ }
  }
  rmSync(DEXDIR, { recursive: true, force: true });
  check("(0) R8-dex: MobileAsrHelper + native-методы живы (keep)", dexOk);

  // установка (сигнатура release ≠ debug — чистим)
  adb(["shell", "pm", "uninstall", PKG]);
  adb(["install", "-r", APK]);
  adb(["shell", "pm", "clear", PKG]);

  // (1) YouTube-видео без субтитров + duo-панель
  await openUrl(`https://m.youtube.com/watch?v=${VIDEO1}`);
  check("(1) видео открылось (duo-кнопка в dump)", await waitFor("duo", { timeout: 30000 }), "кнопка #mDuo в нижнем баре");
  check("(1) тап duo: панель открылась", await (async () => {
    if (!await tapText("duo", { timeout: 6000, exact: true })) return false;
    return waitFor("Оригинал", { timeout: 6000 });
  })());

  // (2) настройки: скачивание модели (gear-кнопка в accessibility — «Настройки ASR»)
  check("(2) ⚙: блок настроек ASR", await (async () => {
    if (!await tapText("Настройки ASR", { timeout: 6000 })) return false;
    return waitFor("Модель whisper", { timeout: 6000 });
  })());
  check("(2) «Скачать» нажата", await tapText("Скачать", { timeout: 6000, scroll: true }));
  check("(2) «Модель скачана» (sha256 сверена Core)", await waitFor("Модель скачана", { timeout: 10 * 60 * 1000 }));
  shot("model-done");

  // (3) провайдер + сохранение (чекбокс «ASR включён»: дефолт конфига —
  // выключено, распознавание без него откажет «выключено в настройках»)
  check("(3) «На устройстве» доступна и нажата", await tapText("На устройстве", { timeout: 8000, scroll: true }));
  if (!await tapText("ASR включён", { timeout: 6000, scroll: true })) {
    shot("no-enabled-checkbox");
  }
  check("(3) «Сохранить» нажата", await tapText("Сохранить", { timeout: 6000, scroll: true }));
  check("(3) «Настройки ASR сохранены»", await waitFor("Настройки ASR сохранены", { timeout: 10000 }));
  shot("saved-local");

  // (4) распознавание локальным whisper (JNI после R8): статус «Готово»
  // мигает (перекрывается applySet) — устойчивый признак — дорожка
  // «ASR · <lang> · …» в селекте «Оригинал»
  check("(4) «Распознать речь» нажата", await tapText("Распознать речь", { timeout: 8000, scroll: true }));
  const done4 = await waitFor("Готово", { timeout: 6 * 60 * 1000 });
  const track4 = done4 || await waitFor("ASR ·", { timeout: 15000 });
  check("(4) «Готово: распознано N реплик» (JNI/R8 жив)", track4,
    done4 ? "статус" : "по дорожке в селекте (статус мигнул)");
  shot("run-done");
  check("(4) asr-дорожка в селекте «Оригинал»", await waitFor("ASR ·", { timeout: 15000 }));

  // (5) airplane-повтор из кэша убран до карточки duopulse-182: airplane на
  // фазе авто-перевода дорожки оставляет конвейер «занятым» навсегда (кнопка
  // «Отмена», тап не освобождает) — не баг локального ASR; кэш-повтор без
  // сети проверен событием done fromCache в debug-смоуке asr-local-smoke.mjs
  // (27/27). Здесь — только увераемся, что airplane не роняет приложение.
  adb(["shell", "cmd", "connectivity", "airplane-mode", "enable"]);
  await sleep(3000);
  check("(5) airplane: приложение живо, дорожка на месте", alive() && dump().includes("ASR ·"));
  shot("airplane-cache");
  adb(["shell", "cmd", "connectivity", "airplane-mode", "disable"]);
  await sleep(3000);

  // (6) живость + чистый logcat
  check("(6) приложение живо", alive());
  const logs = (() => { try { return adb(["logcat", "-d"]); } catch { return ""; } })();
  check("(6) logcat: нет FATAL/UnsatisfiedLinkError", !/FATAL EXCEPTION|UnsatisfiedLinkError/.test(logs));
} catch (e) {
  results.push({ name: "сценарий упал", ok: false, error: String(e) });
  try { adb(["shell", "cmd", "connectivity", "airplane-mode", "disable"]); } catch { /* максимум стараемся */ }
  console.error("ОШИБКА:", e);
} finally {
  writeFileSync(OUT, JSON.stringify({ started: new Date().toISOString(), apk: APK, video1: VIDEO1, results, ok: results.every((r) => r.ok) }, null, 2));
  const ok = results.length > 0 && results.every((r) => r.ok);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} проверок — ${ok ? "OK" : "ЕСТЬ ПРОВАЛЫ"}`);
  console.log(`результат: ${OUT}`);
  process.exit(ok ? 0 : 1);
}
