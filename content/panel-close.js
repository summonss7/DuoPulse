// DuoPulse — закрытие панелей хрома кликом по странице (карточка duopulse-090).
// Панели хрома — child-webview над контентом: клик по странице («мимо» панели)
// уходит в документ вкладки, хром его не видит — репортим сюда, Core закрывает
// панель (как нативный дропдаун). Сообщение — то же family, что chrome-hotkeys:
// JSON {duopulse: "close-panel"} → WebMessageReceived в main.rs.
(function () {
  if (window.__dpPanelClose) return;
  window.__dpPanelClose = true;
  document.addEventListener(
    "mousedown",
    function () {
      try {
        window.chrome.webview.postMessage(
          JSON.stringify({ duopulse: "close-panel" })
        );
      } catch (e) {
        /* API недоступен — просто клик по странице */
      }
    },
    true
  );
})();
