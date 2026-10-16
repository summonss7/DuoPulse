// Сохранение прогона метрик в историю страницы «Диагностика» (задача 2.5):
// пишет строку в perf_runs того же duopulse.db, что и Core (приложение
// закрыто; WAL + busy_timeout допускают и соседство, но пишем без него).
// Используется gate-прогоном M2: итог P-01..P-08 попадает на график
// duopulse://diagnostics хозяина.
//
// Запуск:
//   node e2e/perf/save-run.mjs --label "gate M2" --metrics '{"p01_ms":402,...}'
// Профиль по умолчанию — настоящий (%APPDATA%\DuoPulse\profile), переопределение:
//   --profile <каталог профиля>
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const label = arg("label") ?? "прогон";
const metricsRaw = arg("metrics");
const profile = arg("profile") ?? path.join(process.env.APPDATA, "DuoPulse", "profile");
if (!metricsRaw) {
  console.error("укажи --metrics '{\"p01_ms\":402,...}'");
  process.exit(1);
}
const metrics = JSON.parse(metricsRaw);
if (typeof metrics !== "object" || metrics === null || Array.isArray(metrics)) {
  console.error("--metrics должен быть JSON-объектом {id: число}");
  process.exit(1);
}

fs.mkdirSync(profile, { recursive: true });
const db = new DatabaseSync(path.join(profile, "duopulse.db"));
db.exec(
  "CREATE TABLE IF NOT EXISTS perf_runs(" +
    "id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, " +
    "label TEXT NOT NULL DEFAULT '', metrics TEXT NOT NULL)",
);
const insert = db.prepare(
  "INSERT INTO perf_runs(created_at, label, metrics) VALUES (?1, ?2, ?3)",
);
insert.run(Date.now(), label, JSON.stringify(metrics));
db.exec("DELETE FROM perf_runs WHERE id NOT IN (SELECT id FROM perf_runs ORDER BY id DESC LIMIT 10)");
const rows = db.prepare("SELECT id, created_at, label, metrics FROM perf_runs ORDER BY id DESC").all();
db.close();
console.log(`OK: прогон «${label}» сохранён (${Object.keys(metrics).length} метрик), история: ${rows.length} прогонов`);
for (const r of rows) {
  console.log(`  #${r.id} ${new Date(r.created_at).toLocaleString("ru-RU")} ${r.label} ${r.metrics}`);
}
