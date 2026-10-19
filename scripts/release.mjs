// Сборка NSIS-установщика DuoPulse (задача 5.2, правило проекта: сборки —
// всегда в builds/duopulse_<версия>_<тип>). Подпись обновлений — TAURI_SIGNING_
// PRIVATE_KEY (приватный ключ minisign; локально — %USERPROFILE%\.tauri\
// duopulse-updater.key, пустой пароль). Результат:
//
//   builds/duopulse_<верс>_release/
//     DuoPulse_<верс>_x64-setup.exe     — установщик (NSIS, currentUser)
//     DuoPulse_<верс>_x64-setup.exe.sig — подпись пакета (для фида обновлений)
//     latest.json                        — манифест фида (url поправить хостингом)
//
// Запуск: node scripts/release.mjs [--debug]   (тип release по умолчанию)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const conf = JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
const VERSION = conf.version;
const TYPE = process.argv.includes("--debug") ? "debug" : "release";

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

console.log(`сборка DuoPulse v${VERSION} (${TYPE})…`);
const tauriArgs = TYPE === "debug" ? ["tauri", "build", "--debug"] : ["tauri", "build"];
const build = spawnSync("npx", tauriArgs, { cwd: ROOT, env, stdio: "inherit", shell: true });
if (build.status !== 0) {
  console.error(`сборка упала (код ${build.status})`);
  process.exit(build.status ?? 1);
}

// Артефакты bundler'а → постоянная папка builds/
const bundleDir = path.join(ROOT, "src-tauri", "target", TYPE, "bundle", "nsis");
const outDir = path.join(ROOT, "builds", `duopulse_${VERSION}_${TYPE}`);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const copied = [];
// в bundle/nsis могут лежать артефакты прошлых сборок с другим --config
// (стенд e2e/update гонит там синтетические версии) — берём только свою
const wanted = new Set([
  `DuoPulse_${VERSION}_x64-setup.exe`,
  `DuoPulse_${VERSION}_x64-setup.exe.sig`,
]);
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
// Манифест фида bundler не порождает (его делает релизный конвейер 5.3) —
// собираем сами из фактической подписи; url — имя пакета, хостинг подставит
// свой базовый адрес.
const setupName = copied.find((n) => n.endsWith("-setup.exe"));
const signature = fs.readFileSync(path.join(outDir, `${setupName}.sig`), "utf8").trim();
fs.writeFileSync(
  path.join(outDir, "latest.json"),
  JSON.stringify(
    {
      version: VERSION,
      notes: "",
      pub_date: new Date().toISOString(),
      platforms: { "windows-x86_64": { signature, url: setupName } },
    },
    null,
    2,
  ) + "\n",
);
copied.push("latest.json");
const kb = (f) => `${(fs.statSync(path.join(outDir, f)).size / 1024).toFixed(0)} КБ`;
console.log(`\nготово: ${path.relative(ROOT, outDir)}`);
for (const name of copied.sort()) console.log(`  ${name} — ${kb(name)}`);
console.log("\nфид обновлений: latest.json + .sig выкладываются на сервер фида (5.3);");
console.log("url внутри latest.json указывает на имя пакета — хостинг подставит свой базовый адрес.");
