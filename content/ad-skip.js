/* DuoPulse — авто-пропуск + кнопка «Пропустить рекламу» (карточки 076, 080, 089).
   Initialization_script контентной вкладки (как m0-spike/cosmetic, docs/02 §4),
   активен только на watch-страницах YouTube.

   Почему так: SSAI/USDAI-реклама YouTube вшивается сервером в сам медиапоток —
   сетевые фильтры её не видят, ансамбль quick-fixes (072/074/080) снижает
   частоту, но преролл всё ещё приходит. Эскейп самого uBO (serverContract-
   пейлоад quick-fixes) — seekTo(конец рекламной секции) при маркере «SSAP, AD»
   в stats for nerds; YouTube уже шлёт маркер «USDAI, SABR» — пейлоад молчит.
   Потому карточка 080 повторяет эскейп у себя, без зависимости от маркера.

   089 («чтобы реклама не играла даже 2 секунды — как будто её нет»): убрать
   сам SSAI-преролл клиентски нельзя (решение принимает сервер на каждый
   запуск playback), но можно сделать его НЕВОСПРИНИМАЕМЫМ, пока под ним
   работает пропуск:
   - АВТО-SEEK (080, ускорен): ad-showing → seekTo(конец секции) сразу и
     повторно (0/150/400/700 мс от начала рекламы), не один раз через 400 мс;
   - ЗАТЕМНЕНИЕ+ТИШИНА (089): на время ad-showing все <video> в плеере
     скрываются (фон плеера чёрный) и мутируются — ни кадра, ни звука рекламы;
   - РАЗГОН (089): playbackRate=16 на время рекламы — USDAI-секция (seekTo
     её не берёт, диагностика 089) прожигается в ~16 раз быстрее: 60-сек
     ролик гаснет за ~4 с под чёрным экраном;
   - РОДНОЙ СКИП (089): автоклик кнопок YouTube «Пропустить»/закрыть оверлей;
   - ЛОТЕРЕЯ (080, по-умному): перезагрузка с &t= — ТОЛЬКО если старт
     застрял (ad-showing есть, таймлайн не двигается 2,2 с, прожига нет или
     сервер клампит rate) и не более 2 на видео (sessionStorage; дальше —
     кнопка); идущий прожиг прерывать нельзя — после пода сервер сам
     отдаёт контент через несколько секунд;
   - СТРАХОВКА: нет прогресса 8 с (нескипабельно и не прожигается) —
     картинка/звук возвращаются, кнопка остаётся;
   - ХЕНДОФФ (089): после прожигого пода контент может встать «unstarted»
     с пустым буфером (сервер отдаёт стрим с задержкой) — мягкий nudge
     playVideo() (до 3 раз за 15 с) подталкивает старт.
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

  // ── авто-эскалация (080 → 089) ─────────────────────────────────────────────
  var SEEK_TICKS = [0, 150, 400, 700]; // мс от старта рекламы: seekTo(конец секции)
  var AD_RATE = 16; // playbackRate на время рекламы (прожиг SSAI-секции)
  var AUTO_RELOAD_MAX = 2; // на видео (защита от цикла, дальше — кнопка)
  var BLACKOUT_MAX_MS = 8000; // застоя нет прогресса — затемнение снимается
  var TICK_MS = 100; // период авто-фаз во время рекламы
  var autoTimers = [];
  var autoInterval = null;
  var reloadsKey = null;
  var reloadsVideo = "";

  var videoId = function () {
    try {
      return new URLSearchParams(location.search).get("v") || "";
    } catch (e) {
      return "";
    }
  };
  var reloadsDone = function () {
    // SPA-переходы меняют видео в том же документе — ключ пересчитываем
    var vid = videoId();
    if (!reloadsKey || reloadsVideo !== vid) {
      reloadsVideo = vid;
      reloadsKey = "duopulse-ad-reloads:" + vid;
    }
    try {
      return Number(sessionStorage.getItem(reloadsKey)) || 0;
    } catch (e) {
      return AUTO_RELOAD_MAX; // sessionStorage нет — авто-перезагрузки выключены
    }
  };
  var reloadsInc = function () {
    try {
      reloadsDone(); // инициализирует ключ текущим videoId
      sessionStorage.setItem(reloadsKey, String(reloadsDone() + 1));
    } catch (e) {}
  };
  var stopTimers = function () {
    for (var i = 0; i < autoTimers.length; i++) clearTimeout(autoTimers[i]);
    autoTimers = [];
    if (autoInterval) {
      clearInterval(autoInterval);
      autoInterval = null;
    }
  };
  // реклама кончилась (снята/прошла/плеер сменился) — фазы и затемнение долой
  var clearAuto = function () {
    stopTimers();
    blackoutOff();
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

  // ── затемнение+тишина (089): реклама скрыта и без звука, пока её пропускают ──
  var avSaved = null; // [{el, muted, rate}] до затемнения
  var avGiveUp = false; // страховка сработала — больше не затемняем
  var blackoutAssert = function () {
    if (!player || avGiveUp) return;
    var vids = player.querySelectorAll("video");
    if (!vids.length) return;
    if (!avSaved) {
      avSaved = [];
      for (var i = 0; i < vids.length; i++) {
        var v = vids[i];
        avSaved.push({ el: v, muted: v.muted, rate: v.playbackRate });
        v.style.visibility = "hidden"; // фон плеера чёрный — «рекламы нет»
        v.muted = true;
        try {
          v.playbackRate = AD_RATE;
        } catch (e) {}
      }
      return;
    }
    // поддерживать: YouTube подменяет <video> и возвращает muted/rate
    for (var j = 0; j < vids.length; j++) {
      var vv = vids[j];
      if (vv.style.visibility !== "hidden") {
        // новый <video> посреди рекламы: исходное состояние — дефолт элемента
        avSaved.push({ el: vv, muted: false, rate: 1 });
        vv.style.visibility = "hidden";
        vv.muted = true;
      }
      if (!vv.muted) vv.muted = true;
      if (vv.playbackRate < AD_RATE) {
        try {
          vv.playbackRate = AD_RATE;
        } catch (e) {}
      }
    }
  };
  // сервер честно держит наш разгон? (SABR-режим может клампить rate к 1x)
  var avRateOk = function () {
    if (!player) return false;
    try {
      var vs = player.querySelectorAll("video");
      for (var i = 0; i < vs.length; i++) if (vs[i].playbackRate >= 8) return true;
    } catch (e) {}
    return false;
  };
  var blackoutOff = function () {
    if (!avSaved) return;
    for (var i = 0; i < avSaved.length; i++) {
      var s = avSaved[i];
      try {
        s.el.style.visibility = "";
        s.el.muted = s.muted;
        s.el.playbackRate = s.rate;
      } catch (e) {}
    }
    avSaved = null;
  };

  // ── родной скип YouTube (089): кнопка «Пропустить» / закрыть оверлей ────────
  var NATIVE_SKIP = [
    ".ytp-ad-skip-button-modern",
    ".ytp-ad-skip-button",
    ".ytp-ad-overlay-close-button",
  ];
  var clickNativeSkip = function () {
    if (!player) return;
    for (var i = 0; i < NATIVE_SKIP.length; i++) {
      var b = player.querySelector(NATIVE_SKIP[i]);
      if (b) b.click(); // до разрешения скипа кнопка disabled — клик пуст
    }
  };

  // запуск при появлении ad-showing; снятие рекламы чистит таймеры (render).
  // Диагностика 089 на живом USDAI: seekTo секцию сервер игнорирует, зато
  // playbackRate=16 прожигает её — потому лотерея-перезагрузка нужна ТОЛЬКО
  // при застрявшем старте (ad-showing есть, таймлайн не идёт), а не по таймеру:
  // прерывать идущий прожиг (20-сек секция гасится за ~1,3 с) себе дороже.
  var startAuto = function () {
    stopTimers(); // фазы прошлого запуска — без снятия затемнения (089)
    stopHandoffWatch(); // новая реклама — хендофф-фаза не актуальна
    avGiveUp = false;
    var born = Date.now();
    var seekIdx = 0;
    var lastPos = -1; // позиция таймлайна (прожиг: только вперёд)
    var lastProgressAt = born; // когда таймлайн двигался в последний раз
    var burnTotal = 0; // сколько рекламного таймлайна прожжено (секции суммируются)
    autoInterval = setInterval(function () {
      if (!adShowing()) {
        // класс ушёл (seek/прожиг сработал), а MutationObserver ещё не отработал
        startHandoffWatch(); // контент после пода может встать «unstarted»
        clearAuto();
        return;
      }
      var now = Date.now();
      // seek по плану: конец секции каждый раз пересчитываем (SABR-секции)
      if (seekIdx < SEEK_TICKS.length && now - born >= SEEK_TICKS[seekIdx]) {
        seekIdx++;
        var end = adSectionEnd();
        if (end != null && player.seekTo) {
          try {
            player.seekTo(end);
          } catch (e) {}
        }
      }
      blackoutAssert();
      clickNativeSkip();
      // прогресс: позиция живого <video> (getProgressState при d=0 в переходах врёт)
      var pos = -1;
      try {
        var vs = player.querySelectorAll("video");
        for (var i = 0; i < vs.length; i++)
          if (vs[i].currentTime > pos) pos = vs[i].currentTime;
      } catch (e) {}
      if (pos >= lastPos + 0.05) {
        burnTotal += pos - Math.max(lastPos, 0);
        lastPos = pos;
        lastProgressAt = now;
      } else if (pos >= 0 && pos < lastPos - 1) {
        // новая секция пода: таймлайн прыгнул назад — это тоже прогресс
        lastPos = pos;
        lastProgressAt = now;
        burnTotal += 1;
      }
      var stuckMs = now - lastProgressAt;
      // стартовый буфер ≈1 с: порог 2,2 с отличает буферизацию от застоя
      var stuck = stuckMs > 2200;
      // сервер клампит rate (SABR-режим без пережига) — прожига не будет
      if (!avRateOk() && now - born > 2600) stuck = true;
      if (stuck) {
        // ещё не прожгли ничего — SSAI-старт застрял, бросок лотереи уместен
        if (burnTotal < 5 && reloadsDone() < AUTO_RELOAD_MAX) {
          reloadsInc();
          reloadWithT();
          return;
        }
        // лотерея исчерпана/прожиг был: ждём хендофф сервера; вскрытие затемнения
        if (stuckMs > BLACKOUT_MAX_MS) {
          avGiveUp = true;
          blackoutOff();
        }
      }
    }, TICK_MS);
  };

  // ── хендофф после пода (089): контент «unstarted» с пустым буфером ──────────
  // После прожига пода сервер отдаёт контент не сразу: плеер стоит st=-1,
  // rs=0 (диагностика 089: 7–15 с). Мягкий nudge playVideo() подталкивает
  // стрим; не чаще 3 раз, только пока действительно «unstarted/cued» и буфер
  // пуст, только 15 с после рекламы.
  var handoffTimer = null;
  var stopHandoffWatch = function () {
    if (handoffTimer) {
      clearInterval(handoffTimer);
      handoffTimer = null;
    }
  };
  var startHandoffWatch = function () {
    if (handoffTimer) return;
    var started = Date.now();
    var nudges = 0;
    var lastNudge = 0;
    handoffTimer = setInterval(function () {
      if (!player || adShowing()) return stopHandoffWatch();
      if (Date.now() - started > 15000) return stopHandoffWatch();
      var vs = [];
      try {
        vs = player.querySelectorAll("video");
      } catch (e) {}
      if (!vs.length) return stopHandoffWatch();
      for (var i = 0; i < vs.length; i++)
        if (vs[i].readyState > 0) return stopHandoffWatch(); // буфер пошёл
      var st = null;
      try {
        st = player.getPlayerState && player.getPlayerState();
      } catch (e) {}
      if ((st === -1 || st === 5) && nudges < 3 && Date.now() - lastNudge > 1200) {
        nudges++;
        lastNudge = Date.now();
        try {
          player.playVideo && player.playVideo();
        } catch (e) {}
      }
    }, 400);
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
      var hadAd = !!btn;
      if (btn) btn.remove();
      btn = null;
      stage = 0;
      clearAuto(); // реклама кончилась (снята/прошла) — авто-фазы не нужны
      if (hadAd) startHandoffWatch(); // 089: подтолкнуть контент после пода
      return;
    }
    if (btn) {
      // реклама продолжается — держим затемнение и скип (наблюдатель классов
      // дергает render на каждый чих плеера, тик startAuto — точнее)
      return;
    }
    player = document.getElementById("movie_player");
    if (!player) return;
    // позиция контента: до рекламы — прогресс плеера и есть контент
    try {
      var p = player.getProgressState && player.getProgressState();
      if (p && p.duration > 1) contentSec = Math.floor(p.current);
    } catch (e) {
      /* API может не быть — &t= не критичен */
    }
    blackoutAssert(); // 089: скрыть/заглушить немедленно, до всех фаз
    startAuto(); // карточка 080+089: seek-цикл → (если не помогло) перезагрузка
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

  // ── наблюдатели: плеер + его классы (ad-showing приходит и уходит) ──────────
  var mo = null; // классы текущего плеера
  var attachPlayer = function (cur) {
    clearAuto(); // фазы старого плеера (в т.ч. его затемнение) не нужны
    stopHandoffWatch();
    player = cur;
    if (mo) mo.disconnect();
    mo = new MutationObserver(render);
    mo.observe(player, { attributes: true, attributeFilter: ["class"] });
    // кнопка жила в старом плеере (узел уничтожен со страницей плеера):
    // сброс, иначе render выйдет по «уже показана» и не создаст её (и
    // авто-фазы 080/089) на новом плеере
    if (btn) btn.remove();
    btn = null;
    stage = 0;
    render();
  };
  var watch = function () {
    var cur = document.getElementById("movie_player");
    if (cur) attachPlayer(cur); // плеер уже есть — без опроса, сразу наблюдаем
    // плеер появляется/пересоздаётся (смена видео в radio/playlist) — следим
    // за body: опрос каждые 500 мс пропускал первый класс ad-showing (089)
    var bodyMo = new MutationObserver(function () {
      var cur = document.getElementById("movie_player");
      if (cur && cur !== player) attachPlayer(cur);
    });
    bodyMo.observe(document.body, { childList: true, subtree: true });
  };
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", watch);
  else watch();
})();
