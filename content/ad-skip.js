/* DuoPulse — авто-пропуск + кнопка «Пропустить рекламу» (карточки 076, 080).
   Initialization_script контентной вкладки (как m0-spike/cosmetic, docs/02 §4),
   активен только на watch-страницах YouTube.

   Почему так: SSAI/USDAI-реклама YouTube вшивается сервером в сам медиапоток —
   сетевые фильтры её не видят, ансамбль quick-fixes (072/074/080) снижает
   частоту, но преролл всё ещё приходит. Эскейп самого uBO (serverContract-
   пейлоад quick-fixes) — seekTo(конец рекламной секции) при маркере «SSAP, AD»
   в stats for nerds; YouTube уже шлёт маркер «USDAI, SABR» — пейлоад молчит.
   Потому карточка 080 повторяет эскейп у себя, без зависимости от маркера:

   АВТО (080): ad-showing → через 400 мс seekTo(duration секции); реклама
   через ~1.6 с всё ещё идёт → перезагрузка с &t= (новой бросок SSAI-лотереи),
   не более 2 авто-перезагрузок на видео (sessionStorage; дальше — кнопка).
   КНОПКА (076, без изменений): 1-й клик — seek, затем «Перезагрузить без
   рекламы» — ещё броски лотереи вручную.

   Без зависимостей, один IIFE. */
(function () {
  "use strict";
  if (window.__DUOPULSE_AD_SKIP__) return;
  window.__DUOPULSE_AD_SKIP__ = true;

  // только top-level документ YouTube с плеером (iframe-инъекции не нужны)
  if (window.top !== window) return;
  var host = location.hostname;
  var isYt =
    host === "www.youtube.com" || host === "m.youtube.com" || host === "youtube.com";
  if (!isYt) return;
  if (!/\/watch\?/.test(location.pathname + location.search)) return;

  var player = null;
  var btn = null;
  var stage = 0; // 0 — seek, 1 — reload
  // позиция контента до рекламы (для &t= при перезагрузке): во время SSAI-преролла
  // currentTime отсчитывает рекламу — сохраняем последнее «не рекламное» значение
  var contentSec = 0;

  // ── авто-эскалация (карточка 080) ──────────────────────────────────────────
  var AUTO_SEEK_MS = 400; // после ad-showing: плеерному API дать осесть
  var AUTO_RELOAD_MS = 1600; // seek не снял рекламу — бросок лотереи
  var AUTO_RELOAD_MAX = 2; // на видео (защита от цикла, дальше — кнопка)
  var autoTimers = [];
  var reloadsKey = null;

  var videoId = function () {
    try {
      return new URLSearchParams(location.search).get("v") || "";
    } catch (e) {
      return "";
    }
  };
  var reloadsDone = function () {
    if (!reloadsKey) reloadsKey = "duopulse-ad-reloads:" + videoId();
    try {
      return Number(sessionStorage.getItem(reloadsKey)) || 0;
    } catch (e) {
      return AUTO_RELOAD_MAX; // sessionStorage нет — авто-перезагрузки выключены
    }
  };
  var reloadsInc = function () {
    try {
      if (!reloadsKey) reloadsDone(); // инициализирует ключ текущим videoId
      sessionStorage.setItem(reloadsKey, String(reloadsDone() + 1));
    } catch (e) {}
  };
  var clearAuto = function () {
    for (var i = 0; i < autoTimers.length; i++) clearTimeout(autoTimers[i]);
    autoTimers = [];
  };
  // конец ТЕКУЩЕЙ секции прогресса: во время рекламы duration = длина секции
  var adSectionEnd = function () {
    try {
      var p = player.getProgressState && player.getProgressState();
      // живые потоки (duration Infinity) и аномально длинные «секции» —
      // не реклама, авто-seek не трогаем (остаётся кнопка)
      if (p && isFinite(p.duration) && p.duration > 0 && p.duration <= 600)
        return p.duration;
    } catch (e) {}
    return null;
  };
  var reloadWithT = function () {
    var url;
    try {
      url = new URL(location.href);
      if (contentSec > 3) url.searchParams.set("t", String(contentSec));
      else url.searchParams.delete("t");
    } catch (e) {
      location.reload();
      return;
    }
    location.href = url.href;
  };
  // запуск при появлении ad-showing; снятие рекламы чистит таймеры (render)
  var startAuto = function () {
    clearAuto();
    autoTimers.push(
      setTimeout(function () {
        var end = adSectionEnd();
        if (end != null && player.seekTo) {
          try {
            player.seekTo(end);
          } catch (e) {}
        }
      }, AUTO_SEEK_MS),
    );
    autoTimers.push(
      setTimeout(function () {
        if (!adShowing()) return;
        if (reloadsDone() >= AUTO_RELOAD_MAX) return; // кап исчерпан — кнопка
        reloadsInc();
        reloadWithT();
      }, AUTO_RELOAD_MS),
    );
  };

  var adShowing = function () {
    return !!(player && player.classList && player.classList.contains("ad-showing"));
  };

  // Стили — инлайн на элементе: YouTube вычищает чужие <style> из head,
  // а атрибуты style на живом узле не трогает (проверено живой страницей).
  var applyStyle = function (el, styles) {
    for (var k in styles) el.style[k] = styles[k];
  };
  var btnStyle = {
    position: "absolute",
    top: "12px",
    right: "12px",
    zIndex: "2147483646",
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    height: "30px",
    padding: "0 12px",
    border: "1px solid rgba(189,254,79,.55)",
    borderRadius: "8px",
    background: "rgba(10,14,23,.85)",
    color: "#fff",
    font: "500 12px/1 system-ui,sans-serif",
    cursor: "pointer",
    userSelect: "none",
    whiteSpace: "nowrap",
  };
  var dotStyle = {
    width: "6px",
    height: "6px",
    borderRadius: "50%",
    background: "#bdfe4f",
    flex: "none",
  };

  var render = function () {
    var need = adShowing();
    if (!need) {
      if (btn) btn.remove();
      btn = null;
      stage = 0;
      clearAuto(); // реклама кончилась (снята/прошла) — авто-фазы не нужны
      return;
    }
    if (btn) return; // уже показана
    player = document.getElementById("movie_player");
    if (!player) return;
    // позиция контента: до рекламы — прогресс плеера и есть контент
    try {
      var p = player.getProgressState && player.getProgressState();
      if (p && p.duration > 1) contentSec = Math.floor(p.current);
    } catch (e) {
      /* API может не быть — &t= не критичен */
    }
    startAuto(); // карточка 080: seek → (если не помогло) перезагрузка
    btn = document.createElement("div");
    btn.className = "duopulse-ad-skip";
    btn.title =
      "DuoPulse: попытка пропустить рекламу. SSAI-реклама вшита в поток — " +
      "если скип не сработал, перезагрузка страницы часто возвращает видео уже без рекламы.";
    applyStyle(btn, btnStyle);
    // Trusted Types YouTube (require-trusted-types-for 'script') запрещает
    // innerHTML — только createElement/textContent (иначе TypeError на каждом render)
    var dot = document.createElement("span");
    applyStyle(dot, dotStyle);
    var label = document.createElement("span");
    label.className = "duopulse-ad-skip-label";
    label.textContent = "Пропустить рекламу";
    btn.appendChild(dot);
    btn.appendChild(label);
    btn.addEventListener("click", onClick);
    // hover-акцент без CSS-классов (style-тег YouTube вычищает)
    btn.addEventListener("mouseenter", function () {
      btn.style.borderColor = "#bdfe4f";
      btn.style.color = "#bdfe4f";
    });
    btn.addEventListener("mouseleave", function () {
      btn.style.borderColor = "rgba(189,254,79,.55)";
      btn.style.color = "#fff";
    });
    player.appendChild(btn);
  };

  var onClick = function () {
    if (!btn) return;
    if (stage === 0) {
      stage = 1;
      try {
        var p = player.getProgressState && player.getProgressState();
        // seek в конец текущей (рекламной) секции — снимает клиентские рекламы
        if (p && p.duration > 0 && player.seekTo) player.seekTo(p.duration);
      } catch (e) {
        /* нет API — сразу предлагаем перезагрузку */
      }
      btn.querySelector(".duopulse-ad-skip-label").textContent = "Перезагрузить без рекламы";
      // seek мог не помочь (SSAI): через 800 мс кнопка сама предложит reload
      return;
    }
    // перезагрузка с сохранением позиции контента — новый бросок SSAI-лотереи
    reloadsInc();
    reloadWithT();
  };

  // плеер появляется после загрузки страницы; класс ad-showing приходит и уходит
  var watch = function () {
    player = document.getElementById("movie_player");
    if (!player) {
      setTimeout(watch, 500);
      return;
    }
    render();
    var mo = new MutationObserver(render);
    mo.observe(player, { attributes: true, attributeFilter: ["class"] });
    // плеер пересоздаётся (смена видео в radio/playlist) — следим за ним
    var bodyMo = new MutationObserver(function () {
      var cur = document.getElementById("movie_player");
      if (cur && cur !== player) {
        player = cur;
        mo.disconnect();
        mo.observe(player, { attributes: true, attributeFilter: ["class"] });
        // кнопка жила в старом плеере (узел уничтожен со страницей плеера):
        // сброс, иначе render выйдет по «уже показана» и не создаст её (и
        // авто-фазы 080) на новом плеере
        if (btn) btn.remove();
        btn = null;
        stage = 0;
        render();
      }
    });
    bodyMo.observe(document.body, { childList: true, subtree: true });
  };
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", watch);
  else watch();
})();
