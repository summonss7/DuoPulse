// DuoPulse e2e/asr: подготовка локального ASR-движка и модели (карточка duopulse-091).
// Спайк duopulse-060 держал whisper-server.exe и ggml-base.bin в
// %TEMP%\duopulse-asr-proto — чистка временных файлов снесла папку, стенд
// e2e/asr/run.mjs упал ENOENT. Здесь ассеты восстанавливаются по требованию
// в постоянный кэш e2e/asr/.cache/ (gitignored, модели >100 МБ в репо не живут):
//
//   bin/whisper-server.exe  — whisper.cpp @ 284029c (коммит спайка, тот же
//                             серверный API, с которым писал Core), сборка
//                             cmake+ninja + MinGW (D:\tools\mingw64), статическая
//                             линковка — exe без DLL-зависимостей;
//   models/ggml-base.bin    — huggingface.co/ggerganov/whisper.cpp (~148 МБ).
//
// Промежуточные файлы (клон, cmake-каталог) — %TEMP%\duopulse-asr-build,
// как у e2e/m0-audio: повторный запуск переиспользует и докачивает.
//
// Запуск: node e2e/asr/prepare.mjs   (run.mjs зовёт сам, когда не находит файлы)
// Переопределения: DUOPULSE_E2E_ASR_CACHE (каталог кэша),
// DUOPULSE_E2E_ASR_ENGINE / DUOPULSE_E2E_ASR_MODEL (готовые файлы движка/модели
// — тогда prepare пропускает сборку/скачивание), DUOPULSE_MINGW_BIN (тулчейн).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const CACHE = process.env.DUOPULSE_E2E_ASR_CACHE || path.join(ROOT, "e2e", "asr", ".cache");
const ENGINE = process.env.DUOPULSE_E2E_ASR_ENGINE || path.join(CACHE, "bin", "whisper-server.exe");
const MODEL = process.env.DUOPULSE_E2E_ASR_MODEL || path.join(CACHE, "models", "ggml-base.bin");
const WORK = path.join(os.tmpdir(), "duopulse-asr-build");
const REPO = "https://github.com/ggml-org/whisper.cpp";
// мастер спайка duopulse-060 (28.10.2026); полный SHA — короткий GitHub
// принимать в fetch отказывается («couldn't find remote ref»)
const COMMIT = "284029c07012d2000941a08d38a31ffb71f4734e";
const MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";

const run = (cmd, args, opts = {}) => {
  console.log(`[prepare] ${cmd} ${args.join(" ").slice(0, 120)}`);
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
};

// --- 1. whisper-server.exe -----------------------------------------------------
if (fs.existsSync(ENGINE)) {
  console.log(`[prepare] движок на месте: ${ENGINE}`);
} else {
  const mingw = process.env.DUOPULSE_MINGW_BIN || "D:\\tools\\mingw64\\bin";
  const env = { ...process.env, PATH: `${mingw}${path.delimiter}${process.env.PATH}` };
  const src = path.join(WORK, "whisper.cpp");
  const build = path.join(WORK, "build");
  if (!fs.existsSync(path.join(src, ".git"))) {
    fs.mkdirSync(WORK, { recursive: true });
    run("git", ["clone", "--filter=blob:none", REPO, src]);
  }
  // коммит из истории клона; если ветки ушли (ребейз) — тянем SHA с origin
  try {
    execFileSync("git", ["-C", src, "rev-parse", "--verify", "--quiet", `${COMMIT}^{commit}`]);
  } catch {
    run("git", ["-C", src, "fetch", "--depth", "1", "origin", COMMIT]);
  }
  run("git", ["-C", src, "checkout", "--quiet", COMMIT]);
  run(
    "cmake",
    [
      "-S", src, "-B", build, "-G", "Ninja",
      "-DCMAKE_BUILD_TYPE=Release",
      // examples/ на этом коммите добавляется только при WHISPER_BUILD_EXAMPLES
      // (сервер — examples/server, таргет whisper-server); SDL-примеры за WHISPER_SDL2
      "-DWHISPER_BUILD_TESTS=OFF", "-DWHISPER_BUILD_EXAMPLES=ON", "-DWHISPER_BUILD_SERVER=ON",
      // GGML_OPENMP=OFF: -static не забирает libgomp — exe падал на загрузке
      // модели с «libgomp-1.dll not found»; параллелизм whisper — свой пул нитей
      "-DGGML_OPENMP=OFF", "-DCMAKE_EXE_LINKER_FLAGS=-static",
    ],
    { env },
  );
  run("cmake", ["--build", build, "--target", "whisper-server", "--parallel", String(os.cpus().length)], { env });
  const built = path.join(build, "bin", "whisper-server.exe");
  if (!fs.existsSync(built)) throw new Error(`сборка не дала whisper-server.exe: ${built}`);
  fs.mkdirSync(path.dirname(ENGINE), { recursive: true });
  fs.copyFileSync(built, ENGINE);
  run(ENGINE, ["--help"], { env }); // дым: статический exe стартует без DLL
  console.log(`[prepare] движок собран: ${ENGINE}`);
}

// --- 2. ggml-base.bin ----------------------------------------------------------
if (fs.existsSync(MODEL)) {
  console.log(`[prepare] модель на месте: ${MODEL}`);
} else {
  fs.mkdirSync(path.dirname(MODEL), { recursive: true });
  const part = `${MODEL}.part`;
  // curl (в системе с 1809+): -L на CDN-редирект huggingface, докачка при обрыве
  run("curl", ["-L", "--fail", "--retry", "3", "-C", "-", "--silent", "--show-error", "-o", part, MODEL_URL]);
  const size = fs.statSync(part).size;
  if (size < 100 * 1024 * 1024) throw new Error(`модель подозрительно мала: ${(size / 1e6).toFixed(1)} МБ (ожидалось ~148)`);
  fs.renameSync(part, MODEL);
  console.log(`[prepare] модель скачана: ${MODEL} (${(size / 1e6).toFixed(1)} МБ)`);
}

console.log("[prepare] готово: движок и модель на месте");
