// Сравнение двух дампов трассировки P-08 (карточка duopulse-056): быстрый
// прогон против медленного — что именно отличается на стороне блокировщика
// до первого кадра. Читает дампы p08-trace.mjs (p08-trace-last.json или
// копии из DUOPULSE_P08_TRACE_STAMP_DIR) и печатает по каждому запуску:
//  - момент первого кадра/контента, преролл (SSAI/клиентский);
//  - запросы до кадра: число, бакеты (media/api/ads/…), порядок хостов;
//  - медиа-пробы: сколько запросов/хостов ДО кадра (фолбэк-путь = несколько
//    googlevideo-хостов до первого кадра), момент первого media-запроса;
//  - срезанные запросы: статусы FAIL:*/403/4xx с моментом и URL;
//  - стоимость новых соединений (DNS+proxy+connect по первым запросам хостов);
//  - версия фильтр-листов прогона (digest+rules, если дамп её содержит).
// Затем — построчная диффа медленного и быстрого запусков одной стороны:
// расхождение последовательности хостов, разница срезанных запросов.
//
// Запуск:  node e2e/perf/p08-trace-cmp.mjs <дамп-медленный.json> <дамп-быстрый.json>
import fs from "node:fs";

const [slowPath, fastPath] = process.argv.slice(2);
if (!slowPath || !fastPath) {
  console.error("Запуск: node e2e/perf/p08-trace-cmp.mjs <медленный.json> <быстрый.json>");
  process.exit(1);
}

const bucketOf = (r) => {
  const u = r.url;
  if (/\/videoplayback/.test(u)) return "media";
  if (/youtubei\/v1\/(player|sabr|next|browse|att\/)|\/api\/(timedtext|manifest|stats|player)/.test(u)) return "api";
  if (/doubleclick\.net|googlesyndication\.com|gvt1\.com|\/pagead\/|\/ptracking/.test(u)) return "ads";
  if (r.type === "Document") return "document";
  return "other";
};
const isFailed = (r) =>
  typeof r.status === "string" || (typeof r.status === "number" && r.status >= 400);

function describe(l) {
  const frame = l.frameAt ?? 1e9;
  const before = l.requests.filter((r) => r.sent !== undefined && r.sent <= frame).sort((a, b) => a.sent - b.sent);
  const buckets = {};
  for (const r of before) buckets[bucketOf(r)] = (buckets[bucketOf(r)] ?? 0) + 1;
  const media = before.filter((r) => bucketOf(r) === "media");
  const mediaHosts = [...new Set(media.map((r) => r.host))];
  const failed = before.filter(isFailed);
  const firstByHost = new Map();
  for (const r of before) if (!firstByHost.has(r.host)) firstByHost.set(r.host, r);
  const newHosts = [...firstByHost.values()].filter((r) => !r.cache);
  const newCost = newHosts.reduce((s, r) => s + (r.dns || 0) + (r.proxy || 0) + (r.connect || 0), 0);
  return {
    frame,
    before,
    buckets,
    media,
    mediaHosts,
    failed,
    newHosts,
    newCost,
    hostSeq: before.map((r) => `${r.host}${isFailed(r) ? "!" : ""}`),
  };
}

const fmtLaunch = (l) => {
  const d = describe(l);
  const ad = l.frameAt !== null && (l.adStartAt !== null || l.curMaxAd > 0);
  const kind = ad
    ? l.curReset
      ? `преролл КЛИЕНТСКИЙ (сброс ${l.curMaxAd.toFixed(1)}→${(l.curAtContent ?? 0).toFixed(1)})`
      : `преролл SSAI (${l.prerollMs ?? "?"} мс, ${l.curMaxAd.toFixed(1)}→${(l.curAtContent ?? 0).toFixed(1)} без сброса)`
    : "без рекламы";
  const lines = [
    `[${l.label}] кадр ${l.frameAt} мс${l.contentAt !== null ? `, контент ${l.contentAt} мс` : ""} — ${kind}`,
    `  до кадра: ${d.before.length} запросов (${Object.entries(d.buckets).map(([k, v]) => `${k}=${v}`).join(", ") || "пусто"}); новых хостов ${d.newHosts.length}, их DNS+proxy+connect ${d.newCost} мс`,
  ];
  if (d.media.length)
    lines.push(
      `  медиа до кадра: ${d.media.length} шт., хосты ${d.mediaHosts.join(", ")}; первый media-запрос @${d.media[0].sent} мс`,
    );
  else lines.push(`  медиа до кадра: НЕТ (первый media-запрос после кадра)`);
  if (d.failed.length)
    for (const r of d.failed)
      lines.push(`  СРЕЗАН/ОШИБКА @${r.sent} мс ${r.status} ${r.url.slice(0, 120)}`);
  else lines.push(`  срезанных/ошибок до кадра: нет`);
  return { lines, d };
};

function diffSeq(a, b) {
  // первая позиция расхождения последовательностей хостов
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

const load = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const slow = load(slowPath);
const fast = load(fastPath);

for (const [tag, dump] of [["МЕДЛЕННЫЙ", slow], ["БЫСТРЫЙ", fast]]) {
  console.log(`\n========== ${tag}: ${dump.video} (${dump.generated}) ==========`);
  if (dump.lists) {
    for (const [side, v] of Object.entries(dump.lists))
      console.log(
        `списки ${side}: ${(v ?? []).map((l) => `${l.name}#${l.digest.toString(16)}(${l.rules})`).join(" ") || "нет"}`,
      );
  } else console.log(`списки: дамп без версии (старый формат)`);
  for (const [side, launches] of Object.entries(dump.raw)) {
    console.log(`--- ${side} ---`);
    for (const l of launches) for (const line of fmtLaunch(l).lines) console.log(line);
  }
}

// диффа первых трассируемых прогонов стороны DuoPulse (медленный vs быстрый)
const duoSlow = slow.raw.DuoPulse?.[0];
const duoFast = fast.raw.DuoPulse?.[0];
if (duoSlow && duoFast) {
  const ds = describe(duoSlow);
  const df = describe(duoFast);
  console.log(`\n========== ДИФФА DuoPulse (${duoSlow.label} медленного vs ${duoFast.label} быстрого) ==========`);
  const at = diffSeq(ds.hostSeq, df.hostSeq);
  console.log(`последовательность хостов совпадает до позиции ${at} (медленный ${ds.hostSeq.length}, быстрый ${df.hostSeq.length})`);
  if (at < Math.max(ds.hostSeq.length, df.hostSeq.length)) {
    console.log(`  медленный [${at}…]: ${ds.hostSeq.slice(Math.max(0, at - 3), at + 8).join(" → ")}`);
    console.log(`  быстрый   [${at}…]: ${df.hostSeq.slice(Math.max(0, at - 3), at + 8).join(" → ")}`);
  }
  const failSlow = new Set(ds.failed.map((r) => r.url.slice(0, 120)));
  const failFast = new Set(df.failed.map((r) => r.url.slice(0, 120)));
  const onlySlow = [...failSlow].filter((u) => !failFast.has(u));
  const onlyFast = [...failFast].filter((u) => !failSlow.has(u));
  console.log(`срезанные только у медленного: ${onlySlow.length ? "" : "—"}`);
  onlySlow.forEach((u) => console.log(`  + ${u}`));
  console.log(`срезанные только у быстрого: ${onlyFast.length ? "" : "—"}`);
  onlyFast.forEach((u) => console.log(`  + ${u}`));
  console.log(
    `первый media-запрос: медленный ${ds.media[0]?.sent ?? "—"} мс, быстрый ${df.media[0]?.sent ?? "—"} мс;` +
      ` медиа-хостов до кадра: ${ds.mediaHosts.length} vs ${df.mediaHosts.length}`,
  );
}
