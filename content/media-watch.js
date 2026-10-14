/* DuoPulse — монитор играющего медиа в content-webview (задача 2.3).
   Инжектируется в каждый документ вкладки initialization_script'ом (после
   content/chrome-hotkeys.js), срабатывает до скриптов страницы.

   Исключение спящего режима (docs/04 §1.3): вкладка с играющим звуком/видео
   не усыпляется. Состояние медиа страницы Core сам не видит — этот скрипт
   сообщает его сообщением WebView2 (window.chrome.webview.postMessage →
   WebMessageReceived в main.rs → tabs::TabManager::on_media): есть хоть один
   незапаузенный <video>/<audio> → playing=true. Обновления по событиям
   медиа-элементов (play/pause/… не всплывают — слушаем на захвате документа)
   и дешёвым опросом раз в 2 с (SPA добавляют элементы без событий, напр.
   предзагрузка следующего ролика). Без зависимостей, IIFE — как docs/02 §4. */
(function () {
  "use strict";
  if (window.__DUOPULSE_MEDIA_WATCH__) return;
  window.__DUOPULSE_MEDIA_WATCH__ = true;

  var last = null;

  var post = function (playing) {
    if (playing === last) return;
    last = playing;
    try {
      window.chrome.webview.postMessage(JSON.stringify({
        duopulse: "media",
        playing: playing
      }));
    } catch (e) {
      /* chrome.webview нет (не WebView2) — молча, это не страница виновата */
    }
  };

  var scan = function () {
    var els = document.querySelectorAll("video, audio");
    for (var i = 0; i < els.length; i++) {
      if (!els[i].paused && !els[i].ended) {
        post(true);
        return;
      }
    }
    post(false);
  };

  ["play", "playing", "pause", "ended", "emptied"].forEach(function (type) {
    document.addEventListener(type, scan, true);
  });

  scan();
  setInterval(scan, 2000);
})();
