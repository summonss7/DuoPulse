// Сборка content-бандла DuoPulse (задача 3.2, docs/05 §1): content/*.ts → один
// IIFE без зависимостей → content/gen/duopulse-content.js. Файл подключается в
// бинарник include_str! (src-tauri/src/main.rs), поэтому cargo требует его до
// сборки — как dist/ для UI. Рантайм-артефакт: в .gitignore, руками не править.
//
// Минификация выключена сознательно: бандл мал (бюджет ≤ 80 КБ gzip — docs/05 §1),
// а читаемость в DevTools дороже; размер печатается для контроля бюджета.
import { build } from "esbuild";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = fileURLToPath(new URL("..", import.meta.url));
const outfile = `${root}content/gen/duopulse-content.js`;

await build({
  entryPoints: [`${root}content/duopulse-content.ts`],
  bundle: true,
  format: "iife",
  target: "chrome105", // как UI-бандл (vite.config.ts)
  platform: "browser",
  outfile,
  minify: false,
  sourcemap: false,
  legalComments: "none",
  banner: {
    js: "/* DuoPulse content-bundle — генерат scripts/build-content.mjs из content/*.ts; не править руками */",
  },
  logLevel: "info",
});

const size = statSync(outfile).size;
const gzip = gzipSync(new Uint8Array(await (await import("node:fs/promises")).readFile(outfile))).length;
console.log(`content-бандл: ${(size / 1024).toFixed(1)} КБ (${(gzip / 1024).toFixed(1)} КБ gzip, бюджет 80 КБ gzip)`);
