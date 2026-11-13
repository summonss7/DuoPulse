// DuoPulse — адресная строка omnibox (задача 1.3, docs/05 §1 src/chrome/Omnibox).
// Разбор ввода «URL (догадка схемы) или поиск» делает Core (nav.resolve_omnibox,
// src-tauri/src/omnibox.rs) — UI показывает подсказки и зовет nav.navigate.
//
// Дропдаун подсказок: строка-действие (что сделает Enter: поиск в YouTube или
// переход по разобранному адресу) + совпадения истории/закладок из
// history.search (FTS5, Core). Навигация стрелками ↑↓, Enter — переход по
// выделенной строке (без выделения — разбор ввода), Esc — закрыть дропдаун и
// вернуть фокус странице (nav.focus_page). Пустой ввод — закладки (подсказки
// на фокус адресной строки). Данные — SQLite-хранилище Core (задача 1.4:
// визиты из on_page_load вкладок; SPA-переходы — карточка duopulse-057 —
// тоже пишут визиты; закладки).
//
// Карточка duopulse-090: дропдаун живёт в popup-ОКНЕ над webview
// («chrome-panel», панельный режим ?panel=suggest — без фокуса, набор
// остаётся в omnibox): хром-страница перекрывала HTML-дропдаун (спайк 086).
// Данные идут событием «suggest-data» (строки + выделение), клик по строке
// возвращается «suggest-pick» до потери фокуса (mousedown, не click).
import { emit, listen } from "@tauri-apps/api/event";
import { bridge } from "../bridge";
import type { HistoryHit, NavResolveOmniboxResult } from "../bridge";
import { t } from "../i18n";
import { anchorPanel, closePanel, openPanel } from "./panel-window";

const input = document.getElementById("omnibox") as HTMLInputElement;
const panel = document.getElementById("suggest") as HTMLDivElement;
const goBtn = document.getElementById("go") as HTMLButtonElement;

/** Заголовок поисковика строки-действия («Поиск в …») — из настроек «Поиск»
 *  (settings.json): по умолчанию Google, выбирается на странице настроек.
 *  Раньше был хардкод «YouTube» и врал при смене движка (duopulse-085). */
let searchEngineTitle = "Google";

/** Обновить заголовок движка из Core (снапшот настроек). Неудача — тихо:
 *  остаётся прежнее значение (настройки не критичны для подсказок). */
async function refreshEngineTitle(): Promise<void> {
  try {
    const all = await bridge.settings.getAll();
    searchEngineTitle =
      all.engines.find((e) => e.id === all.search.engine)?.title ?? searchEngineTitle;
  } catch {
    // настройки недоступны — не трогаем
  }
}

const ICONS = {
  search:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/></svg>',
  arrow:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 8h9M9 4.5 12.5 8 9 11.5"/></svg>',
  history:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/></svg>',
  bookmark:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M8 1.5l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.3l-3.8 2 .7-4.3-3.1-3 4.3-.6z"/></svg>',
} as const;

/** Строка подсказки: действие (что сделает Enter) или найденная страница. */
type Row = {
  kind: "action-search" | "action-url" | HistoryHit["source"];
  /** Главный текст: запрос / адрес / заголовок страницы. */
  main: string;
  /** Пояснение справа: поисковик / адрес страницы. */
  sub: string;
  /** Куда идти; null — строка-действие поиска (ввод разбирается на Enter). */
  url: string | null;
  icon: keyof typeof ICONS;
};

let rows: Row[] = [];
let sel = -1;
/** Активная вкладка — инкогнито (карточка duopulse-096): подсказки истории
 *  и закладок скрыты (как в браузерах — приватный ввод не подсвечивает
 *  историю профиля), остаётся строка-действие разбора ввода. */
let incognitoMode = false;
export function setIncognito(on: boolean): void {
  if (incognitoMode === on) return;
  incognitoMode = on;
}
/** Счётчик запросов: применяем только ответ последнего (ввод опережает ответы). */
let seq = 0;
let timer: number | undefined;
/** Открыто ли окно подсказок (повторные списки шлём данными, не пересоздавая). */
let suggestWin = false;
/** Момент последнего открытия окна подсказок: фокус, вернувшийся сразу после
 *  (Core отбирает его у созданной панели обратно, duopulse-097), — не
 *  пользовательский; без guard'а select() затирал карсет и update() звал
 *  открытие заново — создание webview снова крало фокус, замкнутый цикл. */
let openedAt = 0;
/** Отложенное закрытие по blur: мгновенный blur случается в момент создания
 *  окна подсказок (панель на миг перехватывает фокус, Core возвращает,
 *  duopulse-097) — закрываем, только если omnibox фокус так и не вернул. */
let blurTimer: number | undefined;

const err = (e: unknown): void => console.error("omnibox:", e);

function actionRow(q: string, res: NavResolveOmniboxResult): Row {
  return res.isSearch
    ? { kind: "action-search", main: q, sub: t("Поиск в {engine}", { engine: searchEngineTitle }), url: null, icon: "search" }
    : { kind: "action-url", main: res.url, sub: t("Перейти по адресу"), url: res.url, icon: "arrow" };
}

function hitRow(h: HistoryHit): Row {
  // у закладки подсказка справа дополнена именами групп (карточка 058)
  const sub =
    h.source === "bookmark" && h.group ? `${h.group} · ${h.url}` : h.url;
  return {
    kind: h.source,
    main: h.title || h.url,
    sub,
    url: h.url,
    icon: h.source === "bookmark" ? "bookmark" : "history",
  };
}

/** Загрузить подсказки по текущему вводу (пустой — закладки, без строки-действия). */
async function update(): Promise<void> {
  const q = input.value.trim();
  const my = ++seq;
  try {
    let next: Row[];
    if (incognitoMode) {
      // инкогнито (карточка 096): никаких совпадений из профиля — только
      // строка-действие; пустой ввод — нечего показать вовсе
      if (!q) {
        rows = [];
        close();
        render();
        return;
      }
      const res = await bridge.nav.resolveOmnibox({ input: q });
      if (my !== seq) return;
      next = [actionRow(q, res)];
    } else if (!q) {
      const { hits } = await bridge.history.search({ query: "", limit: 8 });
      if (my !== seq) return;
      next = hits.map(hitRow);
    } else {
      // параллельно: что сделает Enter (разбор) + FTS-совпадения подсказок
      const [res, { hits }] = await Promise.all([
        bridge.nav.resolveOmnibox({ input: q }),
        bridge.history.search({ query: q, limit: 8 }),
      ]);
      if (my !== seq) return;
      next = [actionRow(q, res), ...hits.map(hitRow)];
    }
    rows = next;
    sel = -1;
    if (rows.length) {
      // окно уже открыто — только данные: пересоздание webview на каждый ввод
      // перехватывало фокус у адресной строки и убивало набор (duopulse-097)
      if (suggestWin) sendSuggestData();
      else open();
    } else close();
    render();
  } catch (e) {
    err(e);
  }
}

function rowEl(row: Row, i: number): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "suggest-item";
  el.dataset.kind = row.kind;
  // action-search без своего URL (разбор ввода) — пустой data-url не кладём
  if (row.url !== null) el.dataset.url = row.url;
  el.dataset.sel = String(i === sel);
  el.setAttribute("role", "option");
  el.setAttribute("aria-selected", String(i === sel));
  const ico = document.createElement("span");
  ico.className = "ico";
  ico.innerHTML = ICONS[row.icon];
  const main = document.createElement("span");
  main.className = "main";
  main.textContent = row.main;
  const sub = document.createElement("span");
  sub.className = "sub";
  sub.textContent = row.sub;
  el.title = row.url ?? `${row.main} — ${row.sub}`;
  el.append(ico, main, sub);
  return el;
}

/** Полный перерисов дропдауна (строк ≤9, слушателей нет — клики делегированы). */
function render(): void {
  panel.replaceChildren(...rows.map(rowEl));
}

/** Открыть дропдаун: popup-ОКНО под адресной строкой (duopulse-090), без
 *  фокуса — набор остаётся в omnibox; DOM-дропдаун в хроме не показывается
 *  (перекрыт страницей). Дальнейшие списки — данными (sendSuggestData). */
function open(): void {
  // высота под текущий список (окно не ресайзится — ловушка child-webview,
  // duopulse-090); смена списка при том же вводе скроллится внутри
  const h = Math.min(rows.length, 9) * 36 + 14;
  const g = anchorPanel("suggest", input, "left", h);
  openPanel("suggest", g.x, g.y, g.w, g.h, false);
  suggestWin = true;
  openedAt = Date.now();
  // первый список панель запросит сама по «suggest-ready» (её boot ещё идёт —
  // событие, отправленное сейчас, потерялось бы без слушателя)
  input.setAttribute("aria-expanded", "true");
}

/** Список строк + выделение → окну подсказок (панельный режим omnibox). */
function sendSuggestData(): void {
  void emit("suggest-data", { rows, sel }).catch(err);
}

function close(): void {
  panel.hidden = true;
  sel = -1;
  if (suggestWin) {
    suggestWin = false;
    closePanel();
  }
  input.setAttribute("aria-expanded", "false");
}

/** Подсветить строку: локальный DOM мёртв (дропдаун — отдельное окно,
 *  duopulse-090) — выделение уходит данными в панельный режим. */
function highlight(): void {
  for (const [i, el] of [...panel.children].entries()) {
    const on = i === sel;
    (el as HTMLElement).dataset.sel = String(on);
    el.setAttribute("aria-selected", String(on));
  }
  (panel.children[sel] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
  sendSuggestData();
}

/** ↑/↓: выделение соседней строки по кольцу (из «нет выделения» ↓ — первая, ↑ — последняя). */
function moveSel(step: number): void {
  if (!rows.length) return;
  if (!suggestWin) open();
  if (sel === -1) sel = step > 0 ? 0 : rows.length - 1;
  else sel = (sel + step + rows.length) % rows.length;
  highlight();
}

/** Переход по строке подсказки (клик или Enter с выделением). */
async function goRow(row: Row): Promise<void> {
  close();
  try {
    const url = row.url ?? (await bridge.nav.resolveOmnibox({ input: input.value })).url;
    await bridge.nav.navigate({ url });
  } catch (e) {
    err(e);
  }
}

/** Enter без выделения: разобрать ввод (URL/поиск) и перейти. */
async function goInput(): Promise<void> {
  const q = input.value.trim();
  if (!q) return;
  close();
  try {
    const { url } = await bridge.nav.resolveOmnibox({ input: q });
    await bridge.nav.navigate({ url });
  } catch (e) {
    err(e);
  }
}

/** URL активной вкладки — в адресную строку (когда пользователь не вводит). */
export function setActiveUrl(url: string): void {
  if (document.activeElement !== input) input.value = url;
}

/** Инициализация omnibox: слушатели ввода/клавиатуры/кликов и кнопки «Перейти». */
export function initOmnibox(): void {
  // подсказки с дебаунсом: FTS-поиск быстрый, но не чаще раза на ввод
  input.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void update(), 150);
  });
  input.addEventListener("focus", () => {
    // рефокус сразу после открытия подсказок — фокус вернуло Core после
    // перехвата его панелью, не пользователь (duopulse-097): не трогаем
    // каретку и не переоткрываем окно
    if (Date.now() - openedAt < 350) return;
    input.select();
    // движок могли сменить в настройках — заголовок строки-действия свежий
    void refreshEngineTitle();
    void update();
  });
  input.addEventListener("blur", () => {
    // мгновенный blur от создания панели подсказок — фокус вернётся (Core);
    // закрываем только если omnibox его не получил (duopulse-097)
    window.clearTimeout(blurTimer);
    blurTimer = window.setTimeout(() => {
      if (document.activeElement !== input) close();
    }, 150);
  });
  input.addEventListener("keydown", (e) => {
    switch (e.key) {
      case "ArrowDown":
        moveSel(1);
        e.preventDefault();
        break;
      case "ArrowUp":
        moveSel(-1);
        e.preventDefault();
        break;
      case "Enter":
        void (sel >= 0 && rows[sel] ? goRow(rows[sel]) : goInput());
        break;
      case "Escape":
        // Esc из omnibox: закрыть подсказки и вернуть фокус странице
        close();
        input.blur();
        void bridge.nav.focusPage().catch(err);
        break;
    }
  });

  // mousedown-предотвращение: клик по подсказке не уводит фокус с omnibox
  panel.addEventListener("mousedown", (e) => e.preventDefault());
  panel.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".suggest-item");
    const row = el && rows[[...panel.children].indexOf(el)];
    if (row) void goRow(row);
  });

  // Выбор из ОКНА подсказок (duopulse-090): панельный режим шлёт индекс на
  // mousedown (фокус уходит нашему окну — omnibox теряет его в тот же миг);
  // применяем той же goRow, что и Enter с выделением.
  void listen<{ index: number }>("suggest-pick", (ev) => {
    const row = rows[ev.payload.index];
    if (row) void goRow(row);
  });

  // Окно подсказок загрузилось и подписалось — отдать текущий список (без
  // этого первый список терялся бы в гонке boot панели против update())
  void listen("suggest-ready", () => {
    if (suggestWin && rows.length) sendSuggestData();
  });

  // Панель закрыта Core извне (новая вкладка/внутренняя страница, ресайз окна,
  // клик по контенту — duopulse-090): следующему вводу разрешаем открыть
  // окно заново, а не слать данные в закрытое
  void listen("chrome-panel-closed", () => {
    suggestWin = false;
  });

  goBtn.addEventListener("click", () => void goInput());
}

/** Панельный режим ?panel=suggest (duopulse-090): окно дропдауна — только
 *  рендер строк («suggest-data», выделение приходит тем же событием) и
 *  возврат выбора («suggest-pick», mousedown — до потери фокуса omnibox). */
export function bootSuggestPanel(): void {
  panel.hidden = false;
  panel.style.left = "0px";
  panel.style.width = "100%";
  void listen<{ rows: Row[]; sel: number }>("suggest-data", (ev) => {
    rows = ev.payload.rows;
    sel = ev.payload.sel;
    render();
  });
  panel.addEventListener("mousedown", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".suggest-item");
    const i = el ? [...panel.children].indexOf(el) : -1;
    if (i >= 0 && rows[i]) {
      e.preventDefault();
      void emit("suggest-pick", { index: i }).catch(err);
      closePanel();
    }
  });
  // слушатели на месте — хром шлёт первый список (гонка boot против update)
  void emit("suggest-ready", {}).catch(err);
}
