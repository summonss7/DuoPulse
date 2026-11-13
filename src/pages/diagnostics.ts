// DuoPulse — внутренняя страница «Диагностика» (задача 2.5, docs/04 §2,
// docs/05 §1 src/pages/Diagnostics). Открывается вкладкой
// duopulse://diagnostics (webview page-diagnostics-N, роутер — src/main.ts).
//
// Секции: живой срез сеанса (perf.snapshot: старт и фазы, переключения
// вкладок, RAM оболочки, счётчики блокировщика) и история прогонов метрик
// P-01..P-08 (SQLite в профиле, последние 10 — docs/04 §3): график-спарклайн
// по каждой метике + бюджеты docs/04 §2. «Снять срез» сохраняет доступные
// живые значения как прогон (P-01/P-02 по холодному/тёплому старту + P-03);
// полные прогоны пишет эталонный стенд (e2e/perf/save-run.mjs).
// Стиль — гайд 06: сине-чёрные поверхности, неон — только акценты.
import { listen } from "@tauri-apps/api/event";
import { bridge } from "../bridge";
import type { PerfSnapshotResult } from "../bridge/gen/types";
import { t, uiLocale } from "../i18n";

const err = (e: unknown): void => console.error("diagnostics-page:", e);

/** Словарь метрик docs/04 §2: идентификатор прогона → имя, бюджет, единица.
 *  budgetMax — числовой порог «в бюджете» для подсветки (null — сравнительная
 *  метрика, порога нет). Идентификаторы понимаются и Core (perf.save_run
 *  хранит их как есть). */
interface MetricDef {
  id: string;
  name: string;
  budget: string;
  budgetMax: number | null;
  unit: string;
  short: string;
}

const METRICS: MetricDef[] = [
  { id: "p01_ms", name: "P-01 Холодный старт", budget: "≤ 1500 мс", budgetMax: 1500, unit: "мс", short: "P-01" },
  { id: "p02_ms", name: "P-02 Тёплый старт", budget: "≤ 500 мс", budgetMax: 500, unit: "мс", short: "P-02" },
  { id: "p03_mb", name: "P-03 RAM оболочки", budget: "≤ 250 МБ", budgetMax: 250, unit: "МБ", short: "P-03" },
  { id: "p04_cpu_pct", name: "P-04 CPU фоновой вкладки", budget: "≈ 0 %", budgetMax: 1, unit: "%", short: "P-04" },
  { id: "p05_drops_per_min", name: "P-05 Дропы кадров 1080p60", budget: "не хуже контроля (без блокировщика)", budgetMax: null, unit: "дропов/мин", short: "P-05" },
  { id: "p06_max_block_ms", name: "P-06 Отклик UI (макс. блокировка)", budget: "нет задач > 16 мс", budgetMax: 16, unit: "мс", short: "P-06" },
  { id: "p07_ratio_pct", name: "P-07 Запросы YouTube до видео", budget: "≤ 60 %", budgetMax: 60, unit: "%", short: "P-07" },
  { id: "p08_ms", name: "P-08 Первый кадр (повторный просмотр)", budget: "≤ контроля (без блокировщика)", budgetMax: null, unit: "мс", short: "P-08" },
];

/** Карточка живого среза. */
function stat(label: string, value: string, sub?: string): HTMLElement {
  const card = document.createElement("div");
  card.className = "diag-stat";
  const l = document.createElement("div");
  l.className = "diag-stat-label";
  l.textContent = label;
  const v = document.createElement("div");
  v.className = "diag-stat-value";
  v.textContent = value;
  card.append(l, v);
  if (sub) {
    const s = document.createElement("div");
    s.className = "diag-stat-sub";
    s.textContent = sub;
    card.append(s);
  }
  return card;
}

const ms = (v: number | null | undefined): string => (v == null ? "—" : t("{v} мс", { v }));

/** Живой срез → карточки секции «Сеанс». */
function renderLive(root: HTMLElement, snap: PerfSnapshotResult): void {
  const grid = root.querySelector<HTMLElement>(".diag-live");
  if (!grid) return;
  const kids: HTMLElement[] = [];
  const st = snap.startup;
  kids.push(
    stat(
      t("Старт этого запуска"),
      st ? ms(st.ms) : "—",
      st
        ? t("{k} · фазы: {p}", {
            k: st.cold ? t("холодный (P-01)") : t("тёплый (P-02)"),
            p: st.phases
              .map((p) => `${p.stage} ${p.ms}`)
              .join(" → "),
          })
        : t("готовится…"),
    ),
  );
  const sw = snap.tabSwitch;
  kids.push(
    stat(
      t("Переключение вкладок"),
      ms(sw.lastMs),
      t("среднее {a} · максимум {m} · ×{n}", { a: ms(sw.avgMs), m: ms(sw.maxMs), n: sw.count }),
    ),
  );
  kids.push(
    stat(t("RAM оболочки (duopulse.exe)"), t("{n} МБ", { n: snap.ramSelfMb }), t("приватная память, P-03")),
  );
  const ad = snap.adblock;
  kids.push(
    stat(
      t("Блокировщик (сеанс)"),
      t("{n} бл.", { n: ad.blockedTotal }),
      t("из {n} запросов · {s}{off}", {
        n: ad.seenTotal,
        s: ad.ready ? t("списки готовы") : t("списки грузятся"),
        off: ad.enabled ? "" : t(" · выключен"),
      }),
    ),
  );
  kids.push(
    stat(
      t("Вкладки"),
      String(snap.tabs.total),
      snap.tabs.sleeping ? t("спящих: {n}", { n: snap.tabs.sleeping }) : t("все активны"),
    ),
  );
  grid.replaceChildren(...kids);
}

// --- график истории ----------------------------------------------------------

/** Спарклайн метрики: значения прогонов (хронология), бюджет — пунктиром,
 *  выход за бюджет — красные точки. SVG собирается вручную (без библиотек —
 *  бюджет бандла, docs/04 §3). */
function sparkline(values: number[], budgetMax: number | null): SVGSVGElement {
  const W = 240;
  const H = 40;
  const PAD = 4;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.classList.add("diag-spark");
  const dataMax = Math.max(...values);
  const yMax = Math.max(dataMax * 1.15, 1e-9);
  const x = (i: number): number =>
    values.length === 1 ? W / 2 : PAD + (i * (W - 2 * PAD)) / (values.length - 1);
  const y = (v: number): number => H - PAD - (v / yMax) * (H - 2 * PAD);
  if (budgetMax != null && budgetMax <= yMax && budgetMax > 0) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", "0");
    line.setAttribute("x2", String(W));
    line.setAttribute("y1", String(y(budgetMax)));
    line.setAttribute("y2", String(y(budgetMax)));
    line.classList.add("diag-spark-budget");
    svg.append(line);
  }
  if (values.length > 1) {
    const poly = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    poly.setAttribute("points", values.map((v, i) => `${x(i)},${y(v)}`).join(" "));
    poly.classList.add("diag-spark-line");
    svg.append(poly);
  }
  values.forEach((v, i) => {
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", String(x(i)));
    dot.setAttribute("cy", String(y(v)));
    dot.setAttribute("r", i === values.length - 1 ? "3" : "2");
    dot.classList.add("diag-spark-dot");
    if (budgetMax != null && v > budgetMax) dot.classList.add("over");
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = `${v}`;
    dot.append(title);
    svg.append(dot);
  });
  return svg;
}

/** Секция истории: строка на метрику (спарклайн по прогонам, где она есть). */
function renderHistory(root: HTMLElement, runs: { id: number; createdAt: number; label: string; metrics: Record<string, number> }[]): void {
  const rows = root.querySelector<HTMLElement>(".diag-rows");
  const empty = root.querySelector<HTMLElement>(".diag-empty");
  const list = root.querySelector<HTMLElement>(".diag-runs");
  if (!rows || !empty || !list) return;
  // list_runs: новые → старые; график читает хронологию слева направо
  const chrono = [...runs].reverse();
  const kids: HTMLElement[] = [];
  for (const m of METRICS) {
    const values = chrono.map((r) => r.metrics[m.id]).filter((v): v is number => typeof v === "number");
    if (!values.length) continue;
    const row = document.createElement("div");
    row.className = "diag-row";
    row.dataset.metric = m.id;
    const name = document.createElement("div");
    name.className = "diag-row-name";
    name.textContent = t(m.name);
    const budget = document.createElement("div");
    budget.className = "diag-row-budget";
    budget.textContent = t(m.budget);
    const last = values[values.length - 1];
    const lastEl = document.createElement("div");
    lastEl.className = "diag-row-last";
    lastEl.dataset.metric = m.id;
    lastEl.textContent = `${last} ${t(m.unit)}`;
    if (m.budgetMax != null && last > m.budgetMax) lastEl.classList.add("over");
    else if (m.budgetMax != null) lastEl.classList.add("ok");
    row.append(name, sparkline(values, m.budgetMax), lastEl, budget);
    kids.push(row);
  }
  rows.replaceChildren(...kids);
  empty.hidden = kids.length > 0;
  const runEls = runs.map((r) => {
    const el = document.createElement("div");
    el.className = "diag-run";
    const head = document.createElement("span");
    head.className = "diag-run-head";
    head.textContent = t("{d} · {label}", {
      d: new Date(r.createdAt).toLocaleString(uiLocale, {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }),
      label: r.label || t("без метки"),
    });
    const vals = document.createElement("span");
    vals.className = "diag-run-vals";
    vals.textContent = METRICS.filter((m) => typeof r.metrics[m.id] === "number")
      .map((m) => `${m.short} ${r.metrics[m.id]}`)
      .join(", ");
    el.append(head, vals);
    return el;
  });
  list.replaceChildren(...runEls);
}

/** Прогоны из Core + перерисовка истории. */
async function reloadRuns(): Promise<void> {
  const root = document.querySelector<HTMLElement>(".diag");
  if (!root) return;
  try {
    const res = await bridge.perf.listRuns();
    renderHistory(root, res.runs);
  } catch (e) {
    err(e);
  }
}

/** Снять срез живого сеанса: старт (P-01/P-02 по холодному/тёплому) + RAM
 *  (P-03) — что доступно в perf.snapshot сейчас. */
async function saveSnapshot(label: string): Promise<void> {
  const snap = await bridge.perf.snapshot();
  const metrics: Record<string, number> = {};
  if (snap.startup) metrics[snap.startup.cold ? "p01_ms" : "p02_ms"] = snap.startup.ms;
  if (snap.ramSelfMb > 0) metrics.p03_mb = snap.ramSelfMb;
  if (!Object.keys(metrics).length) {
    throw new Error(t("в срезе не оказалось значений (старт ещё не зафиксирован)"));
  }
  await bridge.perf.saveRun({ label, metrics });
  await reloadRuns();
}

// --- сборка страницы ---------------------------------------------------------

/** Точка входа webview внутренней страницы (вызывается из src/main.ts —
 *  модуль импортируется ради побочного эффекта). */
export function initDiagnosticsPage(): void {
  document.title = t("Диагностика — DuoPulse");
  document.body.classList.add("internal-page");
  document.getElementById("app")?.remove();

  const root = document.createElement("div");
  root.className = "diag";
  root.dataset.page = "diagnostics";

  const head = document.createElement("header");
  head.className = "diag-head";
  const logo = document.createElement("div");
  logo.className = "mgr-logo";
  logo.textContent = "Duo";
  const pulse = document.createElement("span");
  pulse.textContent = "Pulse";
  logo.append(pulse);
  const title = document.createElement("h1");
  title.className = "mgr-title";
  title.textContent = t("Диагностика производительности");
  head.append(logo, title);

  // секция «Сеанс сейчас» + срез
  const liveTitle = document.createElement("h2");
  liveTitle.textContent = t("Сеанс сейчас");
  const live = document.createElement("div");
  live.className = "diag-live";

  const saveRow = document.createElement("div");
  saveRow.className = "diag-save";
  const label = document.createElement("input");
  label.id = "diagLabel";
  label.type = "text";
  label.placeholder = t("Метка среза (необязательно)");
  label.spellcheck = false;
  const saveBtn = document.createElement("button");
  saveBtn.id = "diagSave";
  saveBtn.type = "button";
  saveBtn.textContent = t("Снять срез");
  const saveErr = document.createElement("span");
  saveErr.className = "diag-save-err";
  saveBtn.addEventListener("click", () => {
    const auto = t("Срез {d}", {
      d: new Date().toLocaleString(uiLocale, {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }),
    });
    saveBtn.disabled = true;
    saveErr.textContent = "";
    saveSnapshot(label.value.trim() || auto)
      .catch((e) => {
        saveErr.textContent = String(e);
        err(e);
      })
      .finally(() => {
        saveBtn.disabled = false;
      });
  });
  saveRow.append(label, saveBtn, saveErr);

  // секция истории
  const histTitle = document.createElement("h2");
  histTitle.textContent = t("Метрики P-01..P-08 — история прогонов");
  const histNote = document.createElement("div");
  histNote.className = "diag-note";
  histNote.textContent = t(
    "Хранятся последние 10 прогонов (docs/04 §3). Живой срез сохраняет P-01/P-02/P-03; " +
      "полный прогон (все метрики) пишет эталонный стенд e2e/perf.",
  );
  const rows = document.createElement("div");
  rows.className = "diag-rows";
  const empty = document.createElement("div");
  empty.className = "diag-empty";
  empty.hidden = true;
  empty.textContent = t("Прогонов пока нет — снимите срез или прогоните эталонный стенд e2e/perf.");
  const runsList = document.createElement("div");
  runsList.className = "diag-runs";

  root.append(head, liveTitle, live, saveRow, histTitle, histNote, rows, empty, runsList);
  document.body.append(root);

  // живой срез: первичный + по событиям perf + лёгкий поллинг (RAM/счётчики
  // дрейфуют со временем)
  const refresh = (): void => {
    bridge
      .perf
      .snapshot()
      .then((snap) => renderLive(root, snap))
      .catch(err);
  };
  refresh();
  void listen(bridge.events.perfStartupMs, refresh);
  void listen(bridge.events.perfTabSwitchMs, refresh);
  window.setInterval(refresh, 3000);

  void reloadRuns();
}

// модуль импортируется роутером src/main.ts — стартуем сразу
initDiagnosticsPage();
