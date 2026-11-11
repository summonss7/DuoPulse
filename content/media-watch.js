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
   предзагрузка следующего ролика). Без зависимостей, IIFE — как docs/02 §4.

   Фон-пауза беззвучного видео (карточка duopulse-117, выбор Артёма): скрытая
   вкладка (Core прячет webview → WebView2 даёт document.hidden), в которой
   играет только видео БЕЗ звука, ставится на паузу, как Chrome, — молчаливое
   фоновое видео больше не держит вкладку в исключении спящего режима, и она
   засыпает по обычному таймауту простоя (duopulse-115: 12 таких вкладок —
   это ~5.5 ГБ живых рендер-процессов). Слышимое медиа (не muted и volume>0)
   не трогаем: вкладка со звуком играет и не усыпляется. Слышимость —
   эвристика по флагам элемента: видео без аудиодорожки, но не заглушённое,
   считается слышимым (надёжного способа узнать дорожку нет — лучше не
   трогать лишнего). Остановить паузу сайт не может: слушаем на захвате
   документа, событие pause дойдёт до пересчёта раньше обработчиков страницы. */
(function () {
  "use strict";
  if (window.__DUOPULSE_MEDIA_WATCH__) return;
  window.__DUOPULSE_MEDIA_WATCH__ = true;

  /* Внутренние страницы (app-origin) медиа не играют — монитор не нужен
     (карточка duopulse-076); внешний документ в этом же webview — как раньше. */
  if (
    location.hostname === "tauri.localhost" ||
    location.protocol === "duopulse:" ||
    (location.hostname === "localhost" && location.port === "5173")
  )
    return;

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

  var isPlaying = function (el) {
    return !el.paused && !el.ended;
  };

  /* Слышит ли элемент звук: не заглушён и не на нулевой громкости. */
  var isAudible = function (el) {
    return !el.muted && el.volume > 0;
  };

  var scan = function () {
    var els = document.querySelectorAll("video, audio");
    var anyPlaying = false;
    var anyAudible = false;
    for (var i = 0; i < els.length; i++) {
      if (!isPlaying(els[i])) continue;
      anyPlaying = true;
      if (isAudible(els[i])) anyAudible = true;
    }
    /* Фон-пауза (duopulse-117): скрытая вкладка, всё играющее — без звука →
       на паузу; событие pause вызовет пересчёт → playing=false → Core пустит
       вкладку в обычный сон. Паузу бросили ошибкой (сайт перекрыл pause) —
       состояние уходит как есть: вкладка останется в исключении сна. */
    if (anyPlaying && !anyAudible && document.hidden) {
      var pausedAny = false;
      for (var j = 0; j < els.length; j++) {
        if (!isPlaying(els[j])) continue;
        try {
          els[j].pause();
          pausedAny = true;
        } catch (e) {
          /* защищённый pause — не мешаем пересчёту ниже */
        }
      }
      if (pausedAny) return; // пересчёт придёт событием pause
    }
    post(anyPlaying);
  };

  ["play", "playing", "pause", "ended", "emptied"].forEach(function (type) {
    document.addEventListener(type, scan, true);
  });
  /* Скрытие вкладки (Core прячет webview): проверка немедленно — фоновое
     беззвучное видео встаёт на паузу в момент переключения вкладок, не
     дожидаясь ближайшего опроса (2 с). Возврат видимости — просто пересчёт. */
  document.addEventListener("visibilitychange", scan);

  scan();
  setInterval(scan, 2000);
})();
