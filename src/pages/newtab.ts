// DuoPulse — страница «Новая вкладка» (задача 1.5, гайд 06 §7, docs/05 §1
// src/pages/NewTab). Открывается вкладкой duopulse://newtab — как стартовая
// страница и новые вкладки (кнопка «+», tabs.open без url — Core).
//
// Статическая, без фоновых сетевых запросов: шрифты локальные (src/theme/),
// «топ-сайты» — агрегат локальной истории (history.list, SQLite в профиле),
// при нехватке — локальный список по умолчанию. Переходы — только по действию
// пользователя: omnibox-подсказка (Enter — nav.resolve_omnibox + nav.navigate,
// разбор ввода делает Core, src-tauri/src/omnibox.rs) и плитки (клик — в этой
// вкладке, Ctrl/средняя кнопка — новая, как на странице истории).
import { bridge } from "../bridge";
import type { HistoryEntry } from "../bridge";
import { t } from "../i18n";

const err = (e: unknown): void => console.error("newtab-page:", e);

/** Локальные плитки по умолчанию: добирают сетку до 8 при пустой истории. */
const DEFAULT_SITES: [url: string, host: string][] = [
  ["https://www.youtube.com/", "youtube.com"],
  ["https://ru.wikipedia.org/", "ru.wikipedia.org"],
  ["https://github.com/", "github.com"],
  ["https://habr.com/ru/all/", "habr.com"],
  ["https://stackoverflow.com/", "stackoverflow.com"],
  ["https://news.ycombinator.com/", "news.ycombinator.com"],
  ["https://mail.google.com/", "mail.google.com"],
  ["https://web.telegram.org/", "web.telegram.org"],
];

const SEARCH_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/></svg>';

/** Топ-8 сайтов: записи истории группируются по хосту, вес = сумма визитов,
 *  представитель — самая посещаемая страница хоста. */
function topSites(entries: HistoryEntry[]): { url: string; host: string }[] {
  const weight = new Map<string, { url: string; urlVisits: number; count: number }>();
  for (const e of entries) {
    let parsed: URL;
    try {
      parsed = new URL(e.url);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    const host = parsed.hostname.replace(/^www\./, "");
    if (!host) continue;
    const prev = weight.get(host);
    if (prev) {
      prev.count += e.visitCount;
      if (e.visitCount > prev.urlVisits) {
        prev.url = e.url;
        prev.urlVisits = e.visitCount;
      }
    } else {
      weight.set(host, { url: e.url, urlVisits: e.visitCount, count: e.visitCount });
    }
  }
  const byHistory = [...weight.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([host, { url }]) => ({ url, host }));
  const defaults = DEFAULT_SITES.filter((d) => !weight.has(d[1]));
  return [...byHistory, ...defaults.map(([url, host]) => ({ url, host }))].slice(0, 8);
}

function tileEl(site: { url: string; host: string }): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "ntp-tile";
  el.dataset.url = site.url;
  el.title = site.url;
  const letter = document.createElement("span");
  letter.className = "ntp-letter";
  letter.textContent = site.host.charAt(0);
  const host = document.createElement("span");
  host.className = "ntp-host";
  host.textContent = site.host;
  el.append(letter, host);
  return el;
}

function openUrl(url: string, newTab: boolean): void {
  if (newTab) {
    void bridge.tabs.open({ url }).catch(err);
  } else {
    // страница заменяется сайтом (Core: webview уходит с app-origin — tabs/)
    void bridge.nav.navigate({ url }).catch(err);
  }
}

/** Omnibox-подсказка: Enter разбирает ввод как адресную строку (Core) и идёт. */
async function goSearch(input: HTMLInputElement): Promise<void> {
  const q = input.value.trim();
  if (!q) return;
  try {
    const { url } = await bridge.nav.resolveOmnibox({ input: q });
    await bridge.nav.navigate({ url });
  } catch (e) {
    err(e);
  }
}

// --- сборка страницы ---------------------------------------------------------

document.title = t("Новая вкладка");
document.body.classList.add("internal-page");
document.getElementById("app")?.remove(); // разметка хрома странице не нужна

const root = document.createElement("div");
root.className = "ntp";

const logo = document.createElement("div");
logo.className = "ntp-logo";
logo.textContent = "Duo";
const pulse = document.createElement("span");
pulse.textContent = "Pulse";
logo.append(pulse);

const search = document.createElement("div");
search.className = "ntp-search";
const searchIco = document.createElement("span");
searchIco.className = "ico";
searchIco.innerHTML = SEARCH_ICON;
const input = document.createElement("input");
input.type = "text";
input.placeholder = t("Введите адрес или поисковый запрос");
input.spellcheck = false;
input.autocomplete = "off";
input.setAttribute("aria-label", t("Адресная строка"));
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") void goSearch(input);
});
search.append(searchIco, input);

const grid = document.createElement("div");
grid.className = "ntp-grid";

// Подсказка первых запусков (карточка duopulse-057): входы в субтитры и
// избранное неочевидны с первого взгляда — одна приглушённая строка.
const hint = document.createElement("div");
hint.className = "ntp-hint";
hint.textContent = t(
  "На видео появится кнопка «duo» — субтитры до 3 строк, выбор языков и вид плашки (Alt+D — вкл/выкл). " +
    "Звёздочка рядом с адресом добавляет страницу в избранное (Ctrl+D).",
);

root.append(logo, search, hint, grid);
document.body.append(root);

grid.addEventListener("click", (e) => {
  const tile = (e.target as HTMLElement).closest<HTMLElement>(".ntp-tile");
  if (tile?.dataset.url) openUrl(tile.dataset.url, e.ctrlKey || e.metaKey);
});
grid.addEventListener("auxclick", (e) => {
  if (e.button !== 1) return; // средняя кнопка — новая вкладка
  const tile = (e.target as HTMLElement).closest<HTMLElement>(".ntp-tile");
  if (tile?.dataset.url) openUrl(tile.dataset.url, true);
});

// топ-сайты из локальной истории; ошибка чтения — плитки по умолчанию
bridge.history
  .list({ limit: 500, offset: 0 })
  .then(({ entries }) => {
    grid.replaceChildren(...topSites(entries).map(tileEl));
  })
  .catch((e) => {
    err(e);
    grid.replaceChildren(...DEFAULT_SITES.map(([url, host]) => tileEl({ url, host })));
  });
