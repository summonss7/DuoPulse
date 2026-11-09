// DuoPulse — страница «Режим инкогнито» (карточка duopulse-096). Стартовая
// страница инкогнито-вкладок (duopulse://incognito): статичная, без обращений
// к истории/настройкам — приватная вкладка не должна тянуть данные профиля на
// экран. Уход по адресу (omnibox, ссылка) превращает вкладку в обычную
// контентную — среда WebView2 остаётся изолированной (она назначена webview
// при создании, см. tabs/mod.rs).
document.title = "Режим инкогнито";
document.body.classList.add("internal-page");
document.getElementById("app")?.remove(); // разметка хрома странице не нужна

const root = document.createElement("div");
root.className = "incg";

const badge = document.createElement("div");
badge.className = "incg-badge";
badge.innerHTML =
  '<svg viewBox="0 0 48 32" width="72" height="48" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M8 22c0-7 6-12 10-12s4 4 6 4 2-4 6-4 10 5 10 12"/>' +
  '<path d="M12 22l-3 7h30l-3-7"/>' +
  '<path d="M43 12l4-2M5 12L1 10"/></svg>';

const title = document.createElement("h1");
title.textContent = "Вы перешли в режим инкогнито";

const lead = document.createElement("p");
lead.className = "incg-lead";
lead.textContent =
  "Инкогнито-вкладки живут в изолированном хранилище: DuoPulse не сохраняет " +
  "историю посещений этих страниц и не восстанавливает их при следующем запуске, " +
  "а куки и данные сайтов удаляются при закрытии последней инкогнито-вкладки.";

const list = document.createElement("ul");
list.className = "incg-list";
for (const item of [
  "не сохраняется история посещений и заголовки страниц",
  "вкладки не попадают в сохраняемую сессию — после перезапуска их нет",
  "куки, кэш и хранилища сайтов — в отдельном временном хранилище, вне профиля",
  "ссылки, открытые из этой вкладки, тоже открываются в инкогнито",
]) {
  const li = document.createElement("li");
  li.textContent = item;
  list.append(li);
}

const note = document.createElement("p");
note.className = "incg-note";
note.textContent =
  "Осторожно: инкогнито скрывает следы в браузере, но не в интернете — сайты, " +
  "провайдер и админ сети по-прежнему видят ваши запросы. Закладки и загрузки " +
  "сохраняются как обычно.";

root.append(badge, title, lead, list, note);
document.body.append(root);

export {}; // динамический импорт роутера (src/main.ts) — файл-модуль
