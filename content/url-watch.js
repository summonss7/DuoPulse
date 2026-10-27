/* DuoPulse — отслеживание SPA-навигации документа (карточка duopulse-057).
   Инжектируется initialization_script в каждый документ контентной вкладки
   (после chrome-hotkeys.js), срабатывает до скриптов страницы.

   YouTube и прочие SPA ходят между видео через history.pushState/replaceState —
   новой загрузки документа нет, on_page_load молчит, и адрес вкладки в
   omnibox/сессии остаётся адресом прошлого полного перехода (виден просто
   «youtube.com» вместо /watch?v=…). Хук History API + popstate/hashchange
   сообщают Core фактический URL (WebMessage → main.rs →
   TabManager::on_spa_url): omnibox, история и сессия видят каждый переход.
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
})();
