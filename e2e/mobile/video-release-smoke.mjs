// E2E-стенд видео из «Открыть с помощью» в РЕЛИЗНОЙ сборке Android (карточка
// duopulse-179): у релиза нет CDP-сокета webview_devtools_remote (R8), как в
// http-release-smoke.mjs (duopulse-146) — управление чистым adb, верификация —
// uiautomator dump (WebView отдаёт свою страницу в accessibility-дерево: видны
// имя файла и подсказки DuoPulse), logcat (DuoPulseVideo хелпера, stderr
// mobilevideo-протокола) и скриншоты.
// Проверки:
//   1) DuoPulse — обработчик VIEW video/* (pm query-activities: mp4/mkv/webm);
//   2) VIEW-интент content:// (externalstorage.documents, c грантом как
//      реальный менеджер) → экран-проигрыватель: имя файла в dump, видео
//      играет (кадры меняются между скриншотами), logcat mobilevideo 206;
//      файлы: mp4 (кириллица в имени), mkv, webm;
//   3) тот же URI без гранта → подсказка «нет доступа», без краха;
//   4) PDF не сломан: VIEW application/pdf → просмотрщик (страница в dump);
//   5) bmgr-смоук (duopulse-153): backup → uninstall → install → живой старт.
// Фикстуры: mp4 — e2e/subtitles/assets/testsrc.mp4; mkv/webm — ремуксы
// ffmpeg (в PATH стенда); pdf — минимальный валидный однострачник, собранный
// здесь же. Лежат в %TEMP%\duopulse-179 (одноразовые, в репо не идут).
// Запуск (APK уже установлен запускающим, эмулятор поднят):
//   node e2e/mobile/video-release-smoke.mjs [путь-к-APK]
// Результат — e2e/mobile/video-release-smoke-last-run.json (gitignore,
// рантайм-артефакт). Скриншоты — %TEMP%/duopulse-179-*.png.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = "dev.duopulse.mobile";
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT = join(HERE, "video-release-smoke-last-run.json");
const FIX = join(tmpdir(), "duopulse-179");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SERIAL = process.env.ANDROID_SERIAL ||
  execFileSync("adb", ["devices"], { encoding: "utf8" })
    .split("\n").slice(1).find((l) => l.endsWith("device"))?.split("\t")[0] || "";
const adb = (args, opts = {}) => execFileSync("adb",
  SERIAL ? ["-s", SERIAL, ...args] : args,
  { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024, ...opts });

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok, extra });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};
const shot = (name) => {
  const p = join(tmpdir(), `duopulse-179-${name}.png`);
  writeFileSync(p, adb(SERIAL ? ["-s", SERIAL, "exec-out", "screencap", "-p"] : ["exec-out", "screencap", "-p"], { encoding: "buffer" }));
  console.log(`скриншот: ${p}`);
  return readFileSync(p);
};

/** UI-дерево экрана (WebView-контент попадает в accessibility). */
const dump = () => {
  adb(["shell", "uiautomator", "dump", "/sdcard/window_dump.xml"]);
  return adb(["shell", "cat", "/sdcard/window_dump.xml"]);
};

/** Ждём, пока в UI-дереве появится текст (проигрыватель/подсказка). */
async function waitFor(text, { timeout = 15000, not = false } = {}) {
  for (let t = 0; t < timeout; t += 500) {
    const xml = dump();
    const hit = xml.includes(text);
    if (not ? !hit : hit) return true;
    await sleep(500);
  }
  return false;
}

/** Приложение живо (не схлопнулось)? */
const alive = () => {
  try {
    return adb(["shell", "pidof", PKG]).trim() !== "";
  } catch {
    return false;
  }
};

/** Минимальный валидный PDF (1 страница «DuoPulse 179»): pdf.js его ест. */
function minimalPdf() {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null, // stream, длина подставим
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = "BT /F1 16 Tf 20 40 Td (DuoPulse 179 PDF) Tj ET";
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let pdf = "%PDF-1.4\n";
  const offs = [];
  objs.forEach((o, i) => {
    offs.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offs) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

/** Фикстуры: mp4 из репо + ремуксы ffmpeg + pdf. Возвращает имена в Download. */
function makeFixtures() {
  mkdirSync(FIX, { recursive: true });
  const src = join(ROOT, "e2e", "subtitles", "assets", "testsrc.mp4");
  if (!existsSync(src)) throw new Error(`нет исходника ${src}`);
  const ffmpeg = process.env.DP179_FFMPEG || "ffmpeg";
  const run = (args) => execFileSync(ffmpeg, args, { stdio: ["ignore", "pipe", "ignore"] });
  // mp4 — с кириллицей и пробелом в имени (грабля имён из duopulse-141)
  const mp4 = join(FIX, "фильм 179.mp4");
  run(["-y", "-stream_loop", "4", "-i", src, "-c", "copy", "-movflags", "+faststart", mp4]);
  const mkv = join(FIX, "ролик-179.mkv");
  run(["-y", "-i", src, "-c", "copy", mkv]);
  const webm = join(FIX, "clip-179.webm");
  run(["-y", "-i", src, "-c:v", "libvpx", "-b:v", "300k", "-c:a", "libopus", "-b:a", "96k", webm]);
  const pdf = join(FIX, "doc-179.pdf");
  writeFileSync(pdf, minimalPdf());
  return { mp4, mkv, webm, pdf };
}

/** content-URI MediaStore на файл в /sdcard/Download — так «Открыть с
 *  помощью» выглядит у реальных менеджеров (content://media/…). Ищем id
 *  по имени в коллекции (video/media для видео, file для pdf). Грантить
 *  documents-URI из shell нельзя (SecurityException у shell-отправителя,
 *  грабля стенда), MediaStore грантит. */
async function mediaUri(name, isVideo) {
  const coll = isVideo ? "video/media" : "file";
  for (let t = 0; t < 10; t++) {
    let out = "";
    try {
      // вся команда одной строкой: adb shell склеивает отдельные аргументы
      // без кавычек, и where со значением с пробелами разваливается
      // («Invalid token mp4»); проекция только _id — шелловой content
      // печатает одну колонку на строку
      out = adb(["shell",
        `content query --uri content://media/external/${coll} ` +
        `--projection _id ` +
        `--where "_display_name='${name.replace(/'/g, "''")}'"`]);
    } catch {
      out = "";
    }
    const m = out.match(/_id=(\d+)/);
    if (m) return `content://media/external/${coll}/${m[1]}`;
    // сканер мог ещё не увидеть файл — пинаем и ждём
    adb(["shell", "am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE",
      "-d", `file:///sdcard/Download/${encodeURIComponent(name)}`]);
    await sleep(1000);
  }
  throw new Error(`MediaStore не увидел ${name}`);
}

/** VIEW-интент: grant как реальный менеджер (или без — noperm-ветка). */
function viewIntent(uri, mime, { grant = true } = {}) {
  adb([
    "shell", "am", "start",
    "-a", "android.intent.action.VIEW",
    "-d", uri, "-t", mime,
    ...(grant ? ["--grant-read-uri-permission"] : []),
    "-n", `${PKG}/.MainActivity`,
  ]);
}

async function main() {
  mkdirSync(FIX, { recursive: true });
  const fx = makeFixtures();
  for (const [local, name] of [
    [fx.mp4, "фильм 179.mp4"], [fx.mkv, "ролик-179.mkv"],
    [fx.webm, "clip-179.webm"], [fx.pdf, "doc-179.pdf"],
  ]) {
    adb(["push", local, `/sdcard/Download/${name}`]);
  }
  console.log("фикстуры в /sdcard/Download: 4 шт");
  const uriMp4 = await mediaUri("фильм 179.mp4", true);
  const uriMkv = await mediaUri("ролик-179.mkv", true);
  const uriWebm = await mediaUri("clip-179.webm", true);
  const uriPdf = await mediaUri("doc-179.pdf", false);
  console.log(`MediaStore: ${uriMp4} ${uriMkv} ${uriWebm} ${uriPdf}`);

  // 1) DuoPulse — кандидат «Открыть с помощью» для video/*
  for (const mime of ["video/mp4", "video/x-matroska", "video/webm", "application/pdf"]) {
    let out = "";
    try {
      out = adb(["shell", "pm", "query-activities", "-a", "android.intent.action.VIEW", "-t", mime]);
    } catch (e) {
      out = String(e.stdout || e.message);
    }
    check(`pm query-activities ${mime}: DuoPulse в обработчиках`, out.includes(PKG));
  }

  // логи: свежий срез (хелпер/протокол пишут по ходу)
  adb(["logcat", "-c"]);

  // 2) mp4 с грантом → проигрыватель играет
  viewIntent(uriMp4, "video/mp4");
  let ok = await waitFor("фильм 179.mp4");
  check("mp4 (кириллица): экран-проигрыватель с именем файла", ok);
  const f1 = shot("mp4-a");
  await sleep(2500);
  const f2 = shot("mp4-b");
  check("mp4: кадры меняются (видео играет)", !f1.equals(f2));
  const logVideo = adb(["shell", "logcat", "-d", "-s", "DuoPulseVideo"]);
  check("хелпер: копия в cache/video (logcat)", /copied/.test(logVideo));
  const logProto = adb(["shell", "logcat", "-d"]);
  check("протокол mobilevideo: отдал куски (206 в logcat)", /mobilevideo: 206/.test(logProto));
  check("mp4: приложение живо", alive());

  // 3) mkv и webm — тот же путь (контейнеры Chromium-демуксера)
  adb(["shell", "am", "force-stop", PKG]);
  await sleep(800);
  viewIntent(uriMkv, "video/x-matroska");
  check("mkv: проигрыватель с именем файла", await waitFor("ролик-179.mkv"));
  shot("mkv");
  check("mkv: приложение живо", alive());

  adb(["shell", "am", "force-stop", PKG]);
  await sleep(800);
  viewIntent(uriWebm, "video/webm");
  check("webm: проигрыватель с именем файла", await waitFor("clip-179.webm"));
  shot("webm");
  check("webm: приложение живо", alive());

  // 4) без гранта → подсказка «нет доступа», без краха (duopulse-141)
  adb(["shell", "am", "force-stop", PKG]);
  await sleep(800);
  adb(["logcat", "-c"]);
  viewIntent(uriWebm, "video/webm", { grant: false });
  ok = await waitFor("нет доступа");
  check("без гранта: подсказка «нет доступа к файлу»", ok);
  shot("noperm");
  check("без гранта: приложение живо (без краха)", alive());

  // 5) PDF не сломан (duopulse-119 регресс)
  adb(["shell", "am", "force-stop", PKG]);
  await sleep(800);
  viewIntent(uriPdf, "application/pdf");
  ok = await waitFor("страниц 1.");
  check("PDF: просмотрщик открыл документ (страница 1 в статусе)", ok);
  shot("pdf");
  check("PDF: приложение живо", alive());

  // 6) bmgr-смоук (duopulse-153): backup → uninstall → install → старт
  adb(["shell", "bmgr", "enable", "true"]);
  adb(["shell", "bmgr", "transport", "com.android.localtransport/.LocalTransport"]);
  adb(["shell", "input", "keyevent", "KEYCODE_HOME"]); // фон: force-stop даёт «Backup is not allowed» (duopulse-153)
  await sleep(1500);
  const bk = adb(["shell", "bmgr", "backupnow", PKG]);
  const backupOk = /Backup finished with result: (Success|0)/.test(bk) && !/not allowed/i.test(bk);
  check("bmgr: backup прошёл", backupOk, bk.split("\n").find((l) => l.includes(PKG)) || "");
  // APK для переустановки: аргумент или свежий release в builds/ (числовую
  // версию передаёт запускающий: DP179_VER)
  const apkPath = process.argv[2] ||
    join(ROOT, "builds", `DuoPulse-${process.env.DP179_VER || "0.1.64"}-android-release.apk`);
  if (!existsSync(apkPath)) {
    check("bmgr: reinstall", false, `APK не найден: ${apkPath}`);
  } else {
    adb(["shell", "pm", "uninstall", PKG]);
    adb(["install", "-r", apkPath]);
    adb(["shell", "am", "start", "-n", `${PKG}/.MainActivity`]);
    await sleep(4000);
    check("bmgr: uninstall→install(restore)→живой старт", alive());
    shot("bmgr-restore");
  }

  const passed = results.filter((r) => r.ok).length;
  writeFileSync(OUT, JSON.stringify({ when: new Date().toISOString(), results, passed, total: results.length }, null, 2));
  console.log(`\n${passed}/${results.length} проверок прошло — ${OUT}`);
  process.exitCode = passed === results.length ? 0 : 1;
}

main().catch((e) => {
  results.push({ name: "стенд упал", ok: false, extra: String(e) });
  writeFileSync(OUT, JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
  console.error(e);
  process.exitCode = 1;
});
