// DuoPulse — конвертер ресурсного набора скриптлетов uBO (карточка duopulse-043).
//
// Источник — npm-пакет @adguard/scriptlets (живая uBO-совместимая библиотека;
// родной uBO resources.txt апстрим удалил в 2020-м, у Brave — только
// браузерные ресурсы — см. журнал карточки). Читается dist/scriptlets.corelibs.json:
// для каждой записи — names (все имена/алиасы) и scriptlet (исходник функции
// `function Name(source, args)`, аргументы — массивом).
//
// На выходе — src-tauri/src/adblock/scriptlets-resources.json: массив в формате
// adblock-rs Vec<Resource> (serde): name/aliases/kind/content(base64)[/permission].
// Формат вызова движка — function-style: adblock-rs генерирует `Name("arg1","arg2")`,
// поэтому перед функцией добавляется шим, собирающий source-объект и массив
// аргументов (движок не передаёт source — конвенция AdGuard требует его первым).
//
// uBO trusted-* скриптлеты помечаются permission:1 — списки разбираются с
// ParseOptions::default() (untrusted), движок их не инъекцирует (PermissionMask).
//
// Запуск:  npm i && node scripts/build-adblock-resources.mjs
// Обновление набора: поднять версию @adguard/scriptlets в package.json и
// перегенерировать — digest ресурсов входит в метки engine.json, движок
// пересоберётся сам.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, "..");
// exports-карта пакета отдаёт только ESM-вход (CJS main нет), а corelibs.json
// не экспортирован вовсе — резолвим пакет и присоединяем путь в dist.
const SRC = path.join(
  path.dirname(fileURLToPath(import.meta.resolve("@adguard/scriptlets"))),
  "scriptlets.corelibs.json",
);
const OUT = path.join(ROOT, "src-tauri", "src", "adblock", "scriptlets-resources.json");

// uBO-короткие алиасы, которых нет в names пакета (проверено по живому
// uBlock filters.txt 15.10.2026: без них непокрыты nobab:15, raf, nee, nofetchif,
// prune; replace-node-text в пакете только trusted — остаётся непокрытым).
const UBO_SHORT_ALIASES = {
  nobab: "prevent-bab",
  raf: "prevent-requestAnimationFrame",
  nee: "prevent-eval-if",
  nofetchif: "prevent-fetch",
  prune: "json-prune",
};

const data = JSON.parse(fs.readFileSync(SRC, "utf8"));
if (!data?.scriptlets?.length) throw new Error("пустой scriptlets.corelibs.json");

const resources = [];
const jsNames = new Map(); // имя JS-функции → каноническое имя (контроль коллизий)
const aliasOwner = new Map(); // алиас → ресурс (контроль дублей между записями)

for (const entry of data.scriptlets) {
  const canonical = entry.names[0];
  const decl = entry.scriptlet.match(/^function\s+([A-Za-z_$][\w$]*)\s*\(/);
  if (!decl) throw new Error(`${canonical}: исходник не начинается с function NAME(`);
  const fn = decl[1];

  // Шим: движок вызывает `fn("a1","a2")` — собираем (source, args[]) конвенции AdGuard.
  const impl = entry.scriptlet.replace(
    new RegExp(`^function\\s+${fn}\\s*\\(`),
    `function ${fn}$dp(`,
  );
  const content = [
    `function ${fn}(){`,
    `return ${fn}$dp({name:${JSON.stringify(canonical)},engine:"duopulse",verbose:false},[].slice.call(arguments));`,
    `}`,
    impl,
    "",
  ].join("\n");

  if (jsNames.has(fn)) throw new Error(`коллизия JS-имён: ${fn} (${jsNames.get(fn)} и ${canonical})`);
  jsNames.set(fn, canonical);

  const aliases = new Set();
  const addAlias = (a, owner) => {
    for (const form of new Set([a, a.endsWith(".js") ? a.slice(0, -3) : a + ".js"])) {
      const prev = aliasOwner.get(form);
      if (prev && prev !== owner) throw new Error(`алиас ${form} у ${prev} и ${owner}`);
      aliasOwner.set(form, owner);
      if (form !== canonical && form !== canonical + ".js") aliases.add(form);
    }
  };
  for (const n of entry.names.slice(1)) addAlias(n, canonical);
  for (const [short, target] of Object.entries(UBO_SHORT_ALIASES)) {
    if (target === canonical || entry.names.includes(target)) addAlias(short, canonical);
  }

  const resource = {
    name: canonical + ".js",
    aliases: [...aliases].sort(),
    kind: { mime: "application/javascript" },
    content: Buffer.from(content, "utf8").toString("base64"),
  };
  // trusted-* требуют доверия — без него движок их не инъенцирует (PermissionMask)
  if (canonical.startsWith("trusted-") || entry.names.some((n) => n.startsWith("trusted-"))) {
    resource.permission = 1;
  }
  resources.push(resource);
}

// Самопроверка: содержимое начинается с `function NAME(` — так adblock-rs
// распознаёт function-style и генерирует вызов NAME(...).
for (const r of resources) {
  const code = Buffer.from(r.content, "base64").toString("utf8");
  if (!new RegExp(`^function\\s+[\\w$]+\\s*\\(`).test(code)) {
    throw new Error(`${r.name}: контент не function-style`);
  }
}

resources.sort((a, b) => a.name.localeCompare(b.name));
fs.writeFileSync(OUT, JSON.stringify(resources));
const trusted = resources.filter((r) => r.permission === 1).length;
console.log(
  `OK: ${resources.length} ресурсов (${trusted} trusted, без инъекции), ` +
    `${resources.reduce((s, r) => s + r.aliases.length, 0)} алиасов → ${OUT}`,
);
