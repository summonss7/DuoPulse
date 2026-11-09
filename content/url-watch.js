/* DuoPulse — отслеживание SPA-навигации документа (карточка duopulse-057).
   Инжектируется initialization_script в каждый документ контентной вкладки
   (после chrome-hotkeys.js), срабатывает до скриптов страницы.

   YouTube и прочие SPA ходят между страницами без загрузки нового документа,
   on_page_load молчит, и адрес вкладки в omnibox/сессии остаётся адресом
   прошлого полного перехода (виден просто «youtube.com» вместо /watch?v=…
   или /@канал). Сигналы Core (WebMessage → main.rs → TabManager::on_spa_url):
   - хук History API (pushState/replaceState) + popstate/hashchange —
     классический путь (карточка duopulse-057);
   - Navigation API 'navigate' (карточка duopulse-100): современный YouTube
     ходит по каналам через navigation.navigate() — history.pushState не
     вызывается, popstate не приходит; событие navigate — единственный
     сигнал. Отчитываем только same-document переходы (destination.
     sameDocument): полные переходы видит on_page_load. URL читаем через
     setTimeout ПОСЛЕ commit — в момент события location.href ещё старый,
     а отменённые (preventDefault) навигации вообще не коммитятся.
   Без зависимостей, IIFE — как docs/02 §4. */
(function () {
  "use strict";
  if (window.__DUOPULSE_URL_WATCH__) return;
  window.__DUOPULSE_URL_WATCH__ = true;

  // только top-level документ: адрес вкладки — адрес главного фрейма,
  // SPA-переход ифрейма её не меняет (скрипт исполняется во всех фреймах)
  if (window.top !== window) return;

  var last = location.href;
  var post = function () {
    var url = location.href;
    if (url === last) return;
    last = url;
    try {
      window.chrome.webview.postMessage(JSON.stringify({
        duopulse: "spa-url",
        url: url
      }));
    } catch (e) {
      /* chrome.webview нет (не WebView2) — молча, это не страница виновата */
    }
  };

  var wrap = function (name) {
    var orig = history[name];
    if (typeof orig !== "function") return;
    history[name] = function () {
      var r = orig.apply(this, arguments);
      post();
      return r;
    };
  };
  wrap("pushState");
  wrap("replaceState");
  window.addEventListener("popstate", post);
  window.addEventListener("hashchange", post);

  // Navigation API (Chromium 102+): same-document навигации любым способом
  // (navigation.navigate/goTo/back, intercept) порождают событие 'navigate'
  // и НЕ зовут наши хуки history/popstate — YouTube-переходы в канал
  // терялись (карточка duopulse-100: omnibox оставался на youtube.com,
  // закладки каналов перетирали друг друга).
  if (typeof window.navigation === "object" && window.navigation !== null &&
      typeof window.navigation.addEventListener === "function") {
    window.navigation.addEventListener("navigate", function (e) {
      var dest = e && e.destination;
      if (!dest || !dest.sameDocument) return; // полный переход — on_page_load
      setTimeout(post, 0); // после commit навигации
    });
  }
})();
