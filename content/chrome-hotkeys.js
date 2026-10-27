/* DuoPulse — горячие клавиши таб-бара в content-webview (задача 1.2).
   Инжектируется в каждый документ вкладки вторым initialization_script
   (после content/m0-spike.js), срабатывает до скриптов страницы.

   Фокус обычно в контентной части, а не в UI-полосе — поэтому переключения
   вкладок (Ctrl+Tab / Ctrl+Shift+Tab) и восстановление закрытой (Ctrl+Shift+T)
   ловятся здесь и уходят в Core сообщением WebView2
   (window.chrome.webview.postMessage → WebMessageReceived в main.rs →
   tabs::handle_hotkey). Ctrl+D — закладка текущей страницы (карточка 057):
   ту же команду дублирует звёздочка в навбаре (фокус в UI). Команды
   навигации самого таб-бара сюда не входят — это уровень браузерного хрома,
   страница их не видит (preventDefault + stopPropagation на захвате).
   Без зависимостей, IIFE — как docs/02 §4. */
(function () {
  "use strict";
  if (window.__DUOPULSE_HOTKEYS__) return;
  window.__DUOPULSE_HOTKEYS__ = true;

  var post = function (key) {
    try {
      window.chrome.webview.postMessage(JSON.stringify({
        duopulse: "hotkey",
        key: key
      }));
    } catch (e) {
      /* chrome.webview нет (не WebView2) — молча, это не страница виновата */
    }
  };

  window.addEventListener(
    "keydown",
    function (e) {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === "Tab") {
        post(e.shiftKey ? "ctrl+shift+tab" : "ctrl+tab");
      } else if (e.shiftKey && !e.repeat && (e.key === "t" || e.key === "T")) {
        post("ctrl+shift+t");
      } else if (!e.shiftKey && !e.repeat && (e.key === "d" || e.key === "D")) {
        post("ctrl+d");
      } else {
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true
  );
})();
