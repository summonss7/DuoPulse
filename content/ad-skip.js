/* DuoPulse — кнопка «Пропустить рекламу» (карточка duopulse-076).
   Initialization_script контентной вкладки (как m0-spike/cosmetic, docs/02 §4),
   активен только на watch-страницах YouTube.

   Почему кнопка: SSAI-реклама YouTube вшивается сервером в сам медиапоток —
   сетевые фильтры её не видят, ансамбль quick-fixes (072/074) снижает частоту,
   но преролл иногда проигрывается полностью. Ручная эскалация (карточка 072:
   seek не срабатывает, помогает перезагрузка — «лотерея SSAI»):
   1-й клик — seekTo(конец текущей рекламной секции): снимает клиентские
   (не SSAI) рекламы и часть mid-roll;
   если реклама через ~800 мс всё ещё идёт — кнопка становится
   «Перезагрузить без рекламы»: перезагрузка страницы сохраняет позицию
   (&t=) — свежий player-запрос часто приходит уже без преролла (1/3 по
   матрице 072; повторный клик — ещё один бросок).

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
        render();
      }
    });
    bodyMo.observe(document.body, { childList: true, subtree: true });
  };
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", watch);
  else watch();
})();
