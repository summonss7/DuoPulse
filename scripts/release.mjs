// Сборка NSIS-установщика DuoPulse (задача 5.2, правило проекта: сборки —
// всегда в builds/duopulse_<версия>_<тип>) и публикация релиза в оба канала
// обновлений одной командой (duopulse-049): GitHub Pages (репозиторий
// duopulse-updates, локальный клон) + зеркало Aila (updates/duopulse/ —
// манифест v2 и tauri-фиды кладёт сервер Aila через общий издатель
// D:\Scheduler\tools\publish-update.cjs, aila-163). Подпись обновлений —
// TAURI_SIGNING_PRIVATE_KEY (приватный ключ minisign; локально —
// %USERPROFILE%\.tauri\duopulse-updater.key, пустой пароль). Результат:
//
//   builds/duopulse_<верс>_<тип>/
//     DuoPulse_<верс>_x64-setup.exe      — установщик (NSIS, currentUser)
//     DuoPulse_<верс>_x64-setup.exe.sig  — подпись пакета (для фида обновлений)
//     latest.json                        — фид stable (tauri-формат, адрес пакета в канале Aila)
//     latest-canary.json                 — фид canary (адрес пакета в канале Aila)
//
//   канал Aila:  https://aila.skillcoin.pp.ua/updates/duopulse/
//     manifest.json v2 + latest.json + latest-canary.json + пакет + .sig
//   канал GitHub: https://summonss7.github.io/duopulse-updates/
//     <канал>/DuoPulse_…exe + .sig, фид — <канал>/windows/x86_64/<верс>
//
// Запуск: node scripts/release.mjs [--debug] [--notes "что нового"]
//         [--publish-only] [--no-aila] [--deploy-local]
//   --debug         тип сборки debug (публикуется только канал canary)
//   --notes         «что нового» в манифесты каналов (по умолчанию пусто)
//   --publish-only  не собирать: опубликовать готовые артефакты из builds/
//   --no-aila       пропустить публикацию на Aila (GitHub — как обычно)
//   --deploy-local  не собирать/публиковать: только обновить локальную
//                   копию C:\DuoPulse свежим exe из target/<тип>/ (карточка
//                   duopulse-062 — повтор после «файл занят»)
//
// После публикации каналов релиз всегда обновляет и локальную портативную
// копию C:\DuoPulse\duopulse.exe (правило карточки duopulse-062: каждый
// выход новой версии обязан обновлять эту копию; папки нет — шаг пропущен),
// и корневую копию установщика для хаба «Скачать» Aila (правило карточки
// duopulse-063: хаб сканирует только корень builds/, и устаревший там
// установщик — единственный канал для чужих машин — навсегда отрезает их
// от обновлений).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const conf = JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
const VERSION = conf.version;
const TYPE = process.argv.includes("--debug") ? "debug" : "release";
const PUBLISH_ONLY = process.argv.includes("--publish-only");
const NO_AILA = process.argv.includes("--no-aila");
const DEPLOY_LOCAL = process.argv.includes("--deploy-local");
// Локальная портативная копия (карточка duopulse-062) — обновляется каждым
// релизом; детали — в deployLocal() ниже.
const LOCAL_DEPLOY_DIR = "C:\\DuoPulse";
const NOTES = (() => {
  const i = process.argv.indexOf("--notes");
  return i >= 0 ? (process.argv[i + 1] ?? "") : "";
})();

// --deploy-local: только локальная копия (повтор после «файл занят») — ключ
// подписи и каналы не нужны, выходим до проверок релиза.
if (DEPLOY_LOCAL) {
  deployLocal();
  process.exit(0);
}

// Каналы обновлений: релиз уходит в stable и canary, debug — только в canary.
const CHANNELS = TYPE === "release" ? ["stable", "canary"] : ["canary"];

// Канал Aila (duopulse-049): статика /updates/duopulse/, tauri-фиды лежат
// рядом с manifest.json v2; url пакета внутри фида — абсолютный (плагин
// обновлений не разрешает относительные адреса).
const AILA_FEED_BASE = "https://aila.skillcoin.pp.ua/updates/duopulse";
// Канал GitHub Pages: репозиторий duopulse-updates, файл фида — на версию
// клиента (<канал>/windows/x86_64/<верс>: {{target}} плагина — только ОС,
// {{arch}} — архитектра; пример в доках плагина — darwin/aarch64/1.0.0).
const GH_FEED_BASE = "https://summonss7.github.io/duopulse-updates";
// Локальный клон репозитория duopulse-updates для публикации GitHub-канала.
const GH_FEED_DIR = process.env.DUOPULSE_GH_FEED_DIR || "D:\\duopulse-updates";
// Общий издатель Aila (aila-163): копирует файлы, считает sha256, пишет
// manifest.json v2 + history.jsonl и объявляет релиз в «Хабе ИИ».
const AILA_CLI = "D:\\Scheduler\\tools\\publish-update.cjs";

// MinGW нужен сборочному скрипту tauri (dlltool/windres) — добавляем в PATH.
const mingw = "D:\\tools\\mingw64\\bin";
const env = {
  ...process.env,
  PATH: fs.existsSync(mingw) ? `${mingw};${process.env.PATH}` : process.env.PATH,
};

// Приватный ключ подписи: TAURI_SIGNING_PRIVATE_KEY (путь или ключ) либо
// стандартный файл ключа проекта; без ключа bundler не подпишет артефакты.
const defaultKey = path.join(process.env.USERPROFILE ?? "", ".tauri", "duopulse-updater.key");
if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !fs.existsSync(defaultKey)) {
  console.error(
    `нет приватного ключа подписи: задайте TAURI_SIGNING_PRIVATE_KEY или положите ${defaultKey}\n` +
      "(генерация: npx tauri signer generate -w <файл>; публичный ключ — tauri.conf.json plugins.updater.pubkey)",
  );
  process.exit(1);
}
if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
  env.TAURI_SIGNING_PRIVATE_KEY = defaultKey;
}
env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= "";

const outDir = path.join(ROOT, "builds", `duopulse_${VERSION}_${TYPE}`);
const setupName = `DuoPulse_${VERSION}_x64-setup.exe`;

// ---------------------------------------------------------------------------
// Локальная копия C:\DuoPulse (карточка duopulse-062): папа пользуется
// портативной копией C:\DuoPulse\duopulse.exe, поэтому каждый релиз обязан
// обновлять и её — свежий exe (+ WebView2Loader.dll) из target/<тип>/.
// Папки нет (чужая машина/CI) — шаг пропускается. Файл занят (DuoPulse
// открыт) — ошибка: закрыть DuoPulse и повторить `npm run release --
// --deploy-local` (только докопирование, без сборки и публикации).
// ---------------------------------------------------------------------------

function deployLocal() {
  if (!fs.existsSync(path.join(LOCAL_DEPLOY_DIR, "duopulse.exe"))) {
    console.log(`\nлокальная копия ${LOCAL_DEPLOY_DIR} не найдена — обновление пропущено`);
    return;
  }
  const srcExe = path.join(ROOT, "src-tauri", "target", TYPE, "duopulse.exe");
  if (!fs.existsSync(srcExe)) {
    console.error(`нет свежей сборки ${srcExe} — сначала обычный запуск release`);
    process.exit(1);
  }
  console.log(`\nобновление локальной копии ${LOCAL_DEPLOY_DIR} (v${VERSION}, ${TYPE})…`);
  const srcDll = path.join(ROOT, "src-tauri", "target", TYPE, "WebView2Loader.dll");
  const sources = [srcExe, ...(fs.existsSync(srcDll) ? [srcDll] : [])];
  try {
    for (const from of sources) {
      fs.copyFileSync(from, path.join(LOCAL_DEPLOY_DIR, path.basename(from)));
      console.log(`  ${path.basename(from)} — обновлён`);
    }
  } catch (e) {
    console.error(
      `не удалось обновить ${LOCAL_DEPLOY_DIR}: ${e.message}\n` +
        "Закройте DuoPulse и повторите: npm run release -- --deploy-local",
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Хаб «Скачать» Aila (карточка duopulse-063): сервер сканирует только корень
// builds/ проектов (подпапки релизов duopulse_<верс>_<тип>/ он не видит),
// поэтому каждый релиз обязан класть туда свежий установщик —
// DuoPulse-<верс>-setup-release.exe (имя по конвенции хаба, карточка 045).
// Установщики/портативные zip прошлых версий из корня убираем: устаревший
// установщик с нерабочим апдейтером — ловушка (другой компьютер поставит его
// раз и никогда не узнает о новых версиях). Портативные zip в хабе больше
// не раздаём вовсе: портативная копия не умеет самообновляться (NSIS-апдейтер
// её не трогает — та же причина жалобы 063); канал дистрибуции — только
// самообновляющийся установщик. Только release: debug-сборки в хаб не идут.
// ---------------------------------------------------------------------------

function deployHub() {
  if (TYPE !== "release") return;
  const root = path.join(ROOT, "builds");
  const setupCopy = path.join(root, `DuoPulse-${VERSION}-setup-release.exe`);
  fs.copyFileSync(path.join(outDir, setupName), setupCopy);
  console.log(`хаб «Скачать» Aila: ${path.basename(setupCopy)} — обновлён (корень builds/)`);
  for (const name of fs.readdirSync(root)) {
    const stale =
      (/^DuoPulse-[\d.]+-setup-release\.exe$/i.test(name) || /^DuoPulse-[\d.]+-portable-release\.zip$/i.test(name)) &&
      name !== path.basename(setupCopy);
    if (stale) {
      fs.rmSync(path.join(root, name));
      console.log(`хаб «Скачать» Aila: ${name} — убран (устарел/не самообновляется)`);
    }
  }
}

if (PUBLISH_ONLY) {
  // повторная публикация готовых артефактов (без сборки): фиды ниже будут
  // перегенерированы из фактической подписи в builds/
  if (!fs.existsSync(path.join(outDir, setupName))) {
    console.error(`--publish-only: нет ${path.join(outDir, setupName)} — сначала обычный запуск`);
    process.exit(1);
  }
  console.log(`публикация готовых артефактов DuoPulse v${VERSION} (${TYPE})…`);
} else {
  console.log(`сборка DuoPulse v${VERSION} (${TYPE})…`);
  const tauriArgs = TYPE === "debug" ? ["tauri", "build", "--debug"] : ["tauri", "build"];
  const build = spawnSync("npx", tauriArgs, { cwd: ROOT, env, stdio: "inherit", shell: true });
  if (build.status !== 0) {
    console.error(`сборка упала (код ${build.status})`);
    process.exit(build.status ?? 1);
  }

  // Артефакты bundler'а → постоянная папка builds/
  const bundleDir = path.join(ROOT, "src-tauri", "target", TYPE, "bundle", "nsis");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const copied = [];
  // в bundle/nsis могут лежать артефакты прошлых сборок с другим --config
  // (стенд e2e/update гоняет там синтетические версии) — берём только свою
  const wanted = new Set([setupName, `${setupName}.sig`]);
  for (const name of fs.readdirSync(bundleDir)) {
    const from = path.join(bundleDir, name);
    if (!fs.statSync(from).isFile() || !wanted.has(name)) continue;
    fs.copyFileSync(from, path.join(outDir, name));
    copied.push(name);
  }
  if (!copied.some((n) => n.endsWith("-setup.exe"))) {
    console.error(`в ${bundleDir} не найден setup.exe — сборка прошла без NSIS?`);
    process.exit(1);
  }
}

// Манифесты фида (tauri-формат) собираем сами из фактической подписи: фид
// канала — один файл на канал, url пакета — абсолютный адрес в канале Aila
// (GitHub-конвейер ниже пишет свои файлы фида со своим базовым адресом).
const signature = fs.readFileSync(path.join(outDir, `${setupName}.sig`), "utf8").trim();
const feedJson = (packageUrl) =>
  JSON.stringify(
    {
      version: VERSION,
      notes: NOTES,
      pub_date: new Date().toISOString(),
      platforms: { "windows-x86_64": { signature, url: packageUrl } },
    },
    null,
    2,
  ) + "\n";
const ailaPackageUrl = `${AILA_FEED_BASE}/${setupName}`;
const feedFiles = [];
if (CHANNELS.includes("stable")) {
  fs.writeFileSync(path.join(outDir, "latest.json"), feedJson(ailaPackageUrl));
  feedFiles.push("latest.json");
}
if (CHANNELS.includes("canary")) {
  fs.writeFileSync(path.join(outDir, "latest-canary.json"), feedJson(ailaPackageUrl));
  feedFiles.push("latest-canary.json");
}

const kb = (f) => `${(fs.statSync(path.join(outDir, f)).size / 1024).toFixed(0)} КБ`;
console.log(`\nготово: ${path.relative(ROOT, outDir)}`);
for (const name of [setupName, `${setupName}.sig`, ...feedFiles].sort()) console.log(`  ${name} — ${kb(name)}`);

// ---------------------------------------------------------------------------
// Канал Aila (duopulse-049): общий издатель кладёт файлы в updates/duopulse/,
// сервер пишет manifest.json v2 (sha256, история, «📦 Обновление …» в «Хаб ИИ»).
// Неуспех — ошибка релиза (канал не должен молча пропускаться); --no-aila —
// осознанный пропуск (например, публикация только на GitHub).
// ---------------------------------------------------------------------------
if (NO_AILA) {
  console.log("\nпубликация на Aila пропущена (--no-aila)");
} else if (!fs.existsSync(AILA_CLI)) {
  console.error(`нет издателя Aila: ${AILA_CLI} (aila-163) — публикация невозможна`);
  process.exit(1);
} else {
  console.log(`\nпубликация на Aila (${CHANNELS.join("+")})…`);
  const extra = [setupName, `${setupName}.sig`, ...feedFiles].map((f) => path.join(outDir, f)).join(",");
  const cliArgs = [
    AILA_CLI,
    "duopulse",
    "--version",
    VERSION,
    "--notes",
    NOTES || `DuoPulse ${VERSION} (${TYPE})`,
    "--extra",
    extra,
  ];
  // без shell:true: cmd.exe режет аргументы по «;» и «,» — заметки релиза
  // обрезались до первой точки с запятой (0.1.2); как у git() ниже
  const pub = spawnSync("node", cliArgs, { stdio: "inherit" });
  if (pub.status !== 0) {
    console.error(`публикация на Aila не удалась (код ${pub.status}) — Aila включена?`);
    process.exit(pub.status ?? 1);
  }
}

// ---------------------------------------------------------------------------
// Канал GitHub Pages (по умолчанию в приложении): репозиторий duopulse-updates
// (решение автора 20.10.2026, вопрос duopulse_035_hosting_20261019). Публикация —
// коммит в локальный клон: пакет + подпись по каналам, файлы фида на каждую
// версию клиента (endpoint плагина — <канал>/windows-x86_64/x86_64/<верс>);
// файлы прошлых версий перезаписываем текущим фидом, чтобы клиенты на старых
// версиях узнали о релизе. Нет клона — публикация GitHub откладывается
// (артефакты и канал Aila уже готовы), подсказка ниже.
// ---------------------------------------------------------------------------
if (!fs.existsSync(path.join(GH_FEED_DIR, ".git"))) {
  console.log(
    `\nGitHub-канал не опубликован: нет клона ${GH_FEED_DIR}\n` +
      "(git clone https://github.com/summonss7/duopulse-updates.git — и повторите с --publish-only)",
  );
} else {
  console.log(`\nпубликация на GitHub Pages (${CHANNELS.join("+")})…`);
  for (const channel of CHANNELS) {
    const chDir = path.join(GH_FEED_DIR, channel);
    fs.mkdirSync(chDir, { recursive: true });
    fs.copyFileSync(path.join(outDir, setupName), path.join(chDir, setupName));
    fs.copyFileSync(path.join(outDir, `${setupName}.sig`), path.join(chDir, `${setupName}.sig`));
    const feedDir = path.join(chDir, "windows", "x86_64");
    fs.mkdirSync(feedDir, { recursive: true });
    const feed = feedJson(`${GH_FEED_BASE}/${channel}/${setupName}`);
    fs.writeFileSync(path.join(feedDir, VERSION), feed);
    for (const name of fs.readdirSync(feedDir)) {
      if (name !== VERSION) fs.writeFileSync(path.join(feedDir, name), feed);
    }
  }
  // без shell:true: cmd.exe режет аргументы со скобками («(stable+canary)»)
  const git = (args) => {
    const r = spawnSync("git", args, { cwd: GH_FEED_DIR, stdio: "inherit" });
    if (r.error) {
      console.error(`git ${args[0]} в ${GH_FEED_DIR} не запустился: ${r.error.message}`);
      process.exit(1);
    }
    if (r.status !== 0) {
      console.error(`git ${args[0]} в ${GH_FEED_DIR} не удался (код ${r.status})`);
      process.exit(r.status ?? 1);
    }
  };
  git(["add", "-A"]);
  git(["commit", "-m", `duopulse ${VERSION} (${CHANNELS.join("+")})`]);
  git(["push"]);
  console.log(`фид GitHub Pages обновлён: ${GH_FEED_BASE}`);
}

// Локальная копия C:\DuoPulse — последний шаг каждого релиза (карточка
// duopulse-062): новая версия обязана обновлять и папину портативную копию.
// Перед ней — корень builds/ для хаба «Скачать» (карточка duopulse-063).
deployHub();
deployLocal();
