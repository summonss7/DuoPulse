// Источник иконок мобильной обёртки (duopulse-081, образец novagrid-058 —
// там favicon.svg рендерился playwright'ом; у DuoPulse единственный знак —
// 256-пкс PNG-кадр внутри src-tauri/icons/icon.ico). Скрипт извлекает кадр
// ffmpeg'ом и масштабирует до 1024 — вход `tauri icon`, который раскладывает
// знак по mipmap-папкам gen/android (ic_launcher*) и заодно обновляет набор
// icons/ десктопа. 1024 нужен только как вход генератора: на устройстве
// launcher рендерит ≤192 пкс, так что апскейл с 256 качества не роняет.
// Запуск: npm run android:icons (скрипт + tauri icon одним вызовом).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const ico = resolve(root, "src-tauri/icons/icon.ico");
const out = resolve(root, "src-tauri/icons/source-1024.png");

if (!existsSync(ico)) throw new Error(`нет ${ico} — источник знака приложения`);
// ffmpeg читает .ico напрямую (выбирает самый крупный кадр), lanczos — для
// чётких контуров знака; фон остаётся прозрачным (RGBA → png rgba).
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", ico, "-vf", "scale=1024:1024:flags=lanczos", out], {
  stdio: "inherit",
});
console.log("ok", out);
