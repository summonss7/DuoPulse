/* DuoPulse M0 — content-скрипт спайка.
   Инжектируется в каждый документ дочернего webview через
   AddScriptToExecuteOnDocumentCreatedAsync
   (в tauri — WebviewBuilder::initialization_script).

   Что делает:
   1) спрашивает у Core галочку «Диагностика» (карточка duopulse-129;
      по умолчанию выключена — запрос/ответ WebMessage, паттерн cosmetic.js);
   2) при включённой галочке: пишет метку в консоль документа, проверяет
      сетевой перехват (same-origin /duopulse_block_test_probe → 403 +
      X-DuoPulse-Block: 1) и рисует бейдж мониторинга видео в углу страницы
      (протокол M0). Выключена — документ тихо без диагностики.

   Без зависимостей, один IIFE — как требует docs/02 §4 для content-слоя. */
(function () {
  "use strict";
  if (window.__DUOPULSE_M0__) return;
  window.__DUOPULSE_M0__ = true;

  /* Внутренние страницы (app-origin: прод tauri.localhost, dev localhost:5173)
     — не контент: бейдж и проба перехвата там — шум и лишние запросы
     (карточка duopulse-076). Webview живёт со скриптом всю жизнь: после ухода
     по внешнему адресу документ создаётся заново — guard не мешает. */
  if (
    location.hostname === "tauri.localhost" ||
    location.protocol === "duopulse:" ||
    (location.hostname === "localhost" && location.port === "5173")
  )
    return;

  /* Канал с Core есть только в WebView2 (стенды вне приложения — тихо). */
  var host = null;
  try {
    host = window.chrome && window.chrome.webview ? window.chrome.webview : null;
  } catch (e) {
    host = null;
  }
  if (!host) return;

  /* Галочка «Диагностика» (карточка duopulse-129): Core отвечает
     m0-badge-enabled на каждый НОВЫЙ документ — смена настройки видна
     после перехода/перезагрузки страницы, без перезапуска вкладки. */
  var m0Started = false;
  host.addEventListener("message", function (ev) {
    var msg = null;
    try {
      msg = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
    } catch (e) {
      return;
    }
    if (!msg || msg.duopulse !== "m0-badge-enabled") return;
    if (msg.enabled && !m0Started) {
      m0Started = true;
      startM0();
    }
  });
  host.postMessage(JSON.stringify({ duopulse: "m0-badge" }));

  function startM0() {
    var TAG = "[DuoPulse M0]";
    console.log(TAG, "content script injected:", location.href);

    /* --- 1. Тест сетевого перехвата (same-origin probe) ----------------- */
    var blockState = "…";
    fetch("/duopulse_block_test_probe", { cache: "no-store" })
      .then(function (r) {
        var blocked =
          r.status === 403 && r.headers.get("x-duopulse-block") === "1";
        blockState = blocked
          ? "BLOCKED (403 · перехват работает)"
          : "NOT blocked (" + r.status + " · перехват не сработал?)";
        console.log(TAG, "block-test:", blockState);
      })
      .catch(function (e) {
        blockState = "n/a (" + (e && e.message ? e.message : "network error") + ")";
        console.warn(TAG, "block-test fetch failed:", e && e.message);
      });

    /* --- 2. Мониторинг видео -------------------------------------------- */
    var currentVideo = null;
    function pickVideo() {
      try {
        var vids = document.querySelectorAll("video");
        var best = null;
        var bestArea = 0;
        for (var i = 0; i < vids.length; i++) {
          var v = vids[i];
          var area = (v.videoWidth || 0) * (v.videoHeight || 0);
          if (area > bestArea) {
            best = v;
            bestArea = area;
          }
        }
        currentVideo = best;
      } catch (e) {
        /* ignore */
      }
    }
    function startScan() {
      try {
        var mo = new MutationObserver(function () {
          pickVideo();
        });
        mo.observe(document.documentElement, {
          childList: true,
          subtree: true,
        });
      } catch (e) {
        /* ignore */
      }
      pickVideo();
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", startScan);
    } else {
      startScan();
    }

    /* --- 3. Бейдж и периодический отчёт -------------------------------- */
    var badge = null;
    var videoLine = "video: —";
    function ensureBadge() {
      if (badge && badge.isConnected) return;
      badge = document.createElement("div");
      badge.id = "__duopulse_m0_badge__";
      var s = badge.style;
      s.position = "fixed";
      s.left = "8px";
      s.bottom = "8px";
      s.zIndex = "2147483647";
      s.background = "rgba(10,14,23,.92)";
      s.color = "#BDFE4F";
      s.border = "1px solid rgba(189,254,79,.55)";
      s.borderRadius = "8px";
      s.font = "11px/1.5 Consolas, monospace";
      s.padding = "6px 9px";
      s.pointerEvents = "none";
      s.whiteSpace = "pre";
      s.direction = "ltr";
      s.maxWidth = "48vw";
      s.overflow = "hidden";
      (document.body || document.documentElement).appendChild(badge);
    }
    function renderBadge() {
      try {
        ensureBadge();
        badge.textContent =
          "DuoPulse M0 · injected ✓\nblock-test: " +
          blockState +
          "\n" +
          videoLine;
      } catch (e) {
        /* ignore */
      }
    }

    var t0 = null;
    var baseFrames = 0;
    var lastLog = 0;
    setInterval(function () {
      if (!currentVideo || !currentVideo.isConnected) pickVideo();
      var v = currentVideo;
      if (v && v.videoWidth && v.getVideoPlaybackQuality) {
        var q = v.getVideoPlaybackQuality();
        if (q) {
          if (t0 === null) {
            t0 = performance.now();
            baseFrames = q.totalVideoFrames;
          }
          var total = q.totalVideoFrames;
          var dropped = q.droppedVideoFrames;
          var secs = Math.max(0.001, (performance.now() - t0) / 1000);
          var fps = (total - baseFrames) / secs;
          videoLine =
            "video: " +
            v.videoWidth +
            "x" +
            v.videoHeight +
            " | dropped " +
            dropped +
            "/" +
            total +
            " (" +
            (total ? ((100 * dropped) / total).toFixed(2) : "0") +
            "%)" +
            " | ~" +
            fps.toFixed(1) +
            " fps" +
            (v.paused ? " | paused" : "");
          var now = Date.now();
          if (now - lastLog > 10000) {
            lastLog = now;
            console.log(TAG, videoLine);
          }
        }
      } else {
        videoLine = "video: —";
      }
      renderBadge();
    }, 1000);
  }
})();
