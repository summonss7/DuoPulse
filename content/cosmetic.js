/* DuoPulse — косметическая фильтрация (задача 2.2, docs/02 §3–4, docs/05 §3 M2).
   Третий initialization_script контентной вкладки: срабатывает до скриптов
   страницы на каждом новом документе (AddScriptToExecuteOnDocumentCreated).

   Механика (паттерн Brave/uBO в мире без расширений):
   1) сразу после создания документа скрипт спрашивает у Core косметические
      ресурсы для своего URL (window.chrome.webview.postMessage →
      WebMessageReceived в main.rs): host-специфичные селекторы скрытия
      (`youtube.com##…`) + misc-generic (`##div[class^="ad"]…`);
   2) ответ приходит PostWebMessageAsString → селекторы уходят в <style> как
      `display:none!important`; CSS живой — поздние и SPA-узлы скрываются сами;
   3) массовые generic class/id-правила (`##.ad`, `###banner`) движок отдаёт
      только по классам/идам, реально присутствующим в DOM: скрипт собирает их
      (первичный проход + MutationObserver с дебаунсом) и досылает дельту;
   4) движок ещё строится (ready=false) — запрос повторяется (до 20 раз/500 мс).

   Ограничения: top-level документ (ответ PostWebMessage доставляется только
   ему — во фреймах скрипт завершается сразу); выключенный блокировщик или
   сайт-исключение → active=false, скрытий нет; скриптлеты (##+js) не
   поддержаны — нужен ресурсный набор uBO (отдельная работа). Страницы со
   строгим style-src CSP (без unsafe-inline) могут не применить <style> —
   фильтрация там молча не работает, вёрстку это не ломает.

   Без зависимостей, один IIFE — как требует docs/02 §4. */
(function () {
  "use strict";
  if (window.__DUOPULSE_COSMETIC__) return;
  window.__DUOPULSE_COSMETIC__ = true;

  var host = null;
  try {
    host = window.chrome && window.chrome.webview ? window.chrome.webview : null;
  } catch (e) {
    host = null;
  }
  if (!host) return; // не WebView2 (стенды вне приложения) — нечего скрывать
  try {
    if (window.top !== window.self) return; // ответ приходит только top-level
  } catch (e) {
    return;
  }

  /* Состояние для e2e/диагностики через CDP. */
  var state = (window.__duopulseCosmetic = {
    ready: false, // получили применяемые ресурсы (или фильтрация не действует)
    active: false, // фильтрация для этого URL действует
    hiddenSelectors: 0,
    genericSelectors: 0,
    genericScans: 0,
    styleBlocked: false, // CSP не пустил <style> (косметика молча не работает)
    log: [], // последние события обмена с Core (диагностика)
  });

  function log(kind, detail) {
    state.log.push(kind + ": " + detail);
    if (state.log.length > 40) state.log.shift();
  }

  function post(msg) {
    try {
      host.postMessage(JSON.stringify(msg));
    } catch (e) {
      /* страница ушла навигацией — не критично */
    }
  }

  var styleEl = null;
  var cssChunks = [];

  function ensureStyle() {
    if (!styleEl || !styleEl.isConnected) {
      styleEl = document.createElement("style");
      styleEl.id = "duopulse-cosmetic";
      (document.head || document.documentElement).appendChild(styleEl);
    }
    return styleEl;
  }

  /* Селекторы приходят из списков фильтров движком adblock-rs; от инъекций
     CSS страхуемся отказом от селекторов с фигурными скобками (комбинаторы
     «>», «+», «~» — легитимная часть селекторов). */
  function safe(s) {
    return typeof s === "string" && s.length > 0 && !/[{}]/.test(s) ? s : null;
  }

  function hide(selectors) {
    var ok = [];
    for (var i = 0; i < selectors.length; i++) {
      var s = safe(selectors[i]);
      if (s) ok.push(s);
    }
    if (!ok.length) return 0;
    cssChunks.push(ok.join(",") + "{display:none!important}");
    var el = ensureStyle();
    el.textContent = cssChunks.join("\n");
    // CSP style-src без unsafe-inline выкидывает <style>: sheet останется null
    if (el.sheet === null && el.textContent) state.styleBlocked = true;
    return ok.length;
  }

  /* --- generic class/id: сбор классов/идов страницы и дельта-досылка ------ */

  var TOKEN_CAP = 3000; // потолок отслеживаемых токенов (память/размер сообщений)
  var seen = Object.create(null);
  var seenCount = 0;
  var pendingClasses = [];
  var pendingIds = [];
  var genericTimer = 0;
  var FLUSH_MS = 120;

  function harvestEl(el, classes, ids) {
    if (seenCount >= TOKEN_CAP) return;
    if (el.id && !seen["#" + el.id]) {
      seen["#" + el.id] = 1;
      seenCount++;
      ids.push(el.id);
    }
    var cl = el.classList; // у SVG-элементов classList есть не всегда
    if (cl) {
      for (var i = 0; i < cl.length; i++) {
        if (seenCount >= TOKEN_CAP) return;
        var c = cl[i];
        if (!seen["." + c]) {
          seen["." + c] = 1;
          seenCount++;
          classes.push(c);
        }
      }
    }
  }

  function harvestRoot(root, classes, ids) {
    try {
      harvestEl(root, classes, ids);
      var els = root.querySelectorAll("[class],[id]");
      for (var i = 0; i < els.length; i++) harvestEl(els[i], classes, ids);
    } catch (e) {
      /* чужой/мёртвый узел — пропускаем */
    }
  }

  function fullScan() {
    var classes = [];
    var ids = [];
    harvestRoot(document.documentElement, classes, ids);
    queueGeneric(classes, ids);
  }

  function queueGeneric(classes, ids) {
    if (classes.length) pendingClasses = pendingClasses.concat(classes);
    if (ids.length) pendingIds = pendingIds.concat(ids);
    if (genericTimer) return;
    genericTimer = setTimeout(flushGeneric, FLUSH_MS);
  }

  function flushGeneric() {
    genericTimer = 0;
    if (!pendingClasses.length && !pendingIds.length) return;
    var classes = pendingClasses.splice(0, pendingClasses.length);
    var ids = pendingIds.splice(0, pendingIds.length);
    state.genericScans++;
    log("generic-req", "classes=[" + classes.join(",") + "] ids=[" + ids.join(",") + "]");
    post({ duopulse: "cosmetic-generic", url: location.href, classes: classes, ids: ids });
  }

  /* Поздние узлы: CSS-скрытие для уже выданных селекторов происходит само,
     observer нужен только чтобы заметить НОВЫЕ классы/иды для generic-правил. */
  function startObserver() {
    try {
      var mo = new MutationObserver(function (muts) {
        var classes = [];
        var ids = [];
        for (var i = 0; i < muts.length; i++) {
          var m = muts[i];
          if (m.type === "attributes") harvestEl(m.target, classes, ids);
          for (var j = 0; j < m.addedNodes.length; j++) {
            var n = m.addedNodes[j];
            if (n.nodeType === 1) harvestRoot(n, classes, ids);
          }
        }
        if (classes.length || ids.length) queueGeneric(classes, ids);
      });
      mo.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "id"],
        childList: true,
        subtree: true,
      });
    } catch (e) {
      /* без observer поздние generic не покроются — уже выданные живут в CSS */
    }
  }

  /* --- цикл запроса ресурсов ---------------------------------------------- */

  var retries = 0;
  var RETRY_MAX = 20;

  function requestResources() {
    post({ duopulse: "cosmetic", url: location.href });
  }

  function onMessage(ev) {
    var msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    if (!msg || msg.url !== location.href) return; // чужой документ/фрейм
    if (msg.duopulse === "cosmetic-resources") {
      if (!msg.ready) {
        log("resources", "not ready, retry " + retries);
        if (++retries < RETRY_MAX) setTimeout(requestResources, 500);
        return;
      }
      retries = RETRY_MAX; // дальше не повторяем
      if (!msg.active) {
        log("resources", "inactive");
        state.ready = true;
        return;
      }
      state.active = true;
      state.hiddenSelectors += hide(msg.hide || []);
      state.ready = true;
      log("resources", "hide=" + (msg.hide || []).length + " generichide=" + msg.generichide);
      if (!msg.generichide) {
        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", function () {
            fullScan();
            startObserver();
          });
        } else {
          fullScan();
          startObserver();
        }
      }
    } else if (msg.duopulse === "cosmetic-generic-selectors") {
      if (!state.active) return;
      log("generic-res", (msg.selectors || []).join(","));
      state.genericSelectors += hide(msg.selectors || []);
    }
  }

  host.addEventListener("message", onMessage);
  requestResources();
})();
