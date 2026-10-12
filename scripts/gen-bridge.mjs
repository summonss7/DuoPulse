// Генерация TS-типов IPC-контракта bridge (задача 1.1, docs/05 §2).
// Конвейер: Rust-типы (src-tauri/src/bridge.rs, schemars) → bridge/contract.json
// (JSON Schema draft-07, единый источник для TS) → src/bridge/gen/types.ts.
//
// Запуск: npm run gen:bridge. Генерённые файлы не правим руками — правки
// только в Rust-типах, затем перегенерация (соответствие проверяют тесты:
// cargo bridge::contract_file_is_up_to_date, vitest src/bridge/client.test.ts).
import { execFileSync } from "node:child_process";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "json-schema-to-typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT = path.join(ROOT, "bridge", "contract.json");
const OUT = path.join(ROOT, "src", "bridge", "gen", "types.ts");

// 1. Обновляем bridge/contract.json из Rust-типов (ignored-тест — генератор).
// MinGW нужен сборочному скрипту tauri (windres); добавляем в PATH, если стоит.
const mingw = "D:\\tools\\mingw64\\bin";
const env = { ...process.env, PATH: fs.existsSync(mingw) ? `${mingw};${process.env.PATH}` : process.env.PATH };
spawnSync("cargo", ["test", "update_contract_file", "--", "--ignored"], {
  cwd: path.join(ROOT, "src-tauri"),
  env,
  stdio: "inherit",
});

const contract = JSON.parse(fs.readFileSync(CONTRACT, "utf8"));

// 2. Собираем единую draft-07 схему: каждая подсхема с title становится
// определением; вложенные definitions (например, TabInfo у TabsListResult)
// поднимаем на верхний уровень.
const defs = {};
const addSchema = (schema) => {
  if (!schema || typeof schema !== "object" || !schema.title) return;
  const { $schema, definitions, ...rest } = schema;
  defs[schema.title] = rest;
  for (const [name, def] of Object.entries(definitions ?? {})) {
    defs[name] = def;
  }
};
for (const cmd of Object.values(contract.commands ?? {})) {
  addSchema(cmd.params);
  addSchema(cmd.result);
}
for (const ev of Object.values(contract.events ?? {})) {
  addSchema(ev.payload);
}

// 3. Компилируем в TS. Корень — «оглавление» со ссылкой на каждое определение:
// экспортируются все типы контракта (иначе json-schema-to-typescript выбрасывает
// определения, на которые нет ссылок из корня).
const root = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "DuoPulseBridgeContract",
  description: "Реестр типов IPC-контракта bridge (все поля — ссылки на типы).",
  type: "object",
  properties: Object.fromEntries(
    Object.keys(defs).map((name) => [name, { $ref: `#/definitions/${name}` }]),
  ),
  required: Object.keys(defs),
  additionalProperties: false,
  definitions: defs,
};
const banner = [
  "// GENERATED FILE — НЕ ПРАВИТЬ РУКАМИ.",
  "// Источник: src-tauri/src/bridge.rs → bridge/contract.json (версия контракта "
    + `${contract.version}); регенерация: npm run gen:bridge.`,
  "",
].join("\n");
const ts = await compile(root, "DuoPulseBridgeContract", {
  bannerComment: banner,
  additionalProperties: false,
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, ts);
console.log(`ок: src/bridge/gen/types.ts (${Object.keys(defs).length} типов, контракт v${contract.version})`);
