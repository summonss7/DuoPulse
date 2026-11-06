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
   4) движок ещё строится (ready=false) — запрос повторяется (до 20 раз/500 мс);
   5) скриптлеты (`##+js(...)`, карточка duopulse-043): приоритет — РАННИЙ
      синхронный канал (карточка 044): до инлайн-скриптов страницы блокирующий
      XHR к loopback-эндпоинту Core (adblock::start_early_endpoint) отдаёт
      код/скрытия для этого url (window.__duopulseSyncScriptlets — тогда
      повторная инъекция в асинхронном ответе пропускается); фолбэк — код из
      WebMessage-ответа исполняется <script>-элементом в мире страницы (тот
      же тумблер/white-list). Асинхронная доставка опаздывает на ~150–600 мс
      (uBO колет синхронно в document_start) — на YouTube это ловит SABR-stall
      (карточка 044). Trusted Types (require-trusted-types-for 'script',
      youtube) обходится своей политикой duopulse-scriptlets; strict
      script-src + strict-dynamic может не пустить элемент — тогда вставка
      тихая, scriptletsRan = 0.

   Ограничения: top-level документ (ответ PostWebMessage доставляется только
   ему — во фреймах скрипт завершается сразу); выключенный блокировщик или
   сайт-исключение → active=false, скрытий и инъекций нет; страницы со
   строгим style-src/script-src CSP могут не применить <style>/<script> —
   фильтрация там молча не работает, вёрстку это не ломает.

   Без зависимостей, один IIFE — как требует docs/02 §4. */
(function () {
  "use strict";
  if (window.__DUOPULSE_COSMETIC__) return;
  window.__DUOPULSE_COSMETIC__ = true;

  /* Внутренние страницы (app-origin) — селекторов скрытия для них нет,
  запросы/ответы только шумят (карточка duopulse-076); внешний документ
  в этом же webview получит всё как раньше. */
  if (
    location.hostname === "tauri.localhost" ||
    location.protocol === "duopulse:" ||
    (location.hostname === "localhost" && location.port === "5173")
  )
    return;

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
    scriptlets: 0, // длина исполненного кода скриптлетов (##+js)
    scriptletsAt: 0, // performance.now() в момент вставки (диагностика тайминга)
    scriptletsRan: 0, // performance.now() из самого кода — исполнение состоялось
    syncScriptlets: false, // скриптлеты уже исполнены ранним скриптом (карточка 044)
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
  var styleFlushScheduled = false;

  function ensureStyle() {
    var mount = document.head || document.documentElement;
    if (!mount) {
      // document-start: <html> ещё не создан парсером — буфер чанков живёт в
      // cssChunks, ставим <style> при появлении DOM (карточка 044: асинхронный
      // ответ теперь может прийти раньше первого токена страницы)
      if (!styleFlushScheduled) {
        styleFlushScheduled = true;
        var kick = function () {
          if (document.head || document.documentElement) {
            styleFlushScheduled = false;
            var el = ensureStyle();
            if (el) el.textContent = cssChunks.join("\n");
          } else {
            setTimeout(kick, 10);
          }
        };
        setTimeout(kick, 10);
      }
      return null;
    }
    if (!styleEl || !styleEl.isConnected) {
      styleEl = document.createElement("style");
      styleEl.id = "duopulse-cosmetic";
      mount.appendChild(styleEl);
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
    if (el) {
      el.textContent = cssChunks.join("\n");
      // CSP style-src без unsafe-inline выкидывает <style>: sheet останется null
      if (el.sheet === null && el.textContent) state.styleBlocked = true;
    }
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

  /* --- скриптлеты (##+js, карточка duopulse-043) --------------------------- */

  /* Политика Trusted Types для страниц с require-trusted-types-for 'script'
     (youtube и др.): присваивание строки в script.textContent без обёртки
     бросает TypeError. Имя страницы не резервируют директивой trusted-types —
     свою политику создать можно; если всё же запрещена — остаёмся на строке
     (строгая страница бросит, попадёт в catch ниже). */
  var ttPolicy = null;

  function trustedScript(code) {
    try {
      if (typeof trustedTypes === "undefined" || !trustedTypes.createPolicy) {
        return code;
      }
      if (!ttPolicy) {
        ttPolicy = trustedTypes.createPolicy("duopulse-scriptlets", {
          createScript: function (s) {
            return s;
          },
        });
      }
      return ttPolicy.createScript(code);
    } catch (e) {
      log("scriptlets", "tt-policy: " + e);
      return code;
    }
  }

  /* Код приходит из движка (function-style: определения + вызовы в try/catch).
     РАННИЙ путь (карточка 044) — runScriptletsDirect: на document-start DOM ещё
     пуст (documentElement появляется позже парсером, а Trusted Types-страницы
     и вовсе режут textContent) — код исполняется прямым eval в глобальном
     контексте; Trusted Types (youtube) обходится политикой duopulse-scriptlets
     (eval(TrustedScript)). Поздний путь — <script>-элемент в мире страницы
     (инъекция до скрытий: пока CSS собирается в живой <style>, скриптлеты
     влияют на ранние проверки страницы). Маркер scriptletsRan отличает
     «элемент вставлен» от «код исполнился» (strict script-src CSP с
     strict-dynamic может не пустить элемент — тогда вставка тихая, а
     scriptletsRan остаётся 0). */
  function runScriptletsDirect(code) {
    if (!code) return false;
    try {
      (0, eval)(trustedScript(code));
    } catch (e) {
      log("scriptlets", "direct eval не прошёл: " + e);
      return false;
    }
    window.__duopulseSyncScriptlets = true;
    try {
      window.__duopulseSyncAt = Math.round(performance.now());
    } catch (e) {}
    state.syncScriptlets = true;
    state.scriptlets = code.length;
    try {
      state.scriptletsRan = Math.round(performance.now());
    } catch (e) {}
    log("scriptlets", code.length + " chars (doc-start eval, карточка 044)");
    return true;
  }

  function runScriptlets(code) {
    if (!code) return;
    try {
      var el = document.createElement("script");
      var payload =
        code +
        "\n;try{window.__duopulseCosmetic&&(window.__duopulseCosmetic.scriptletsRan=Math.round(performance.now()))}catch(e){}";
      el.textContent = trustedScript(payload);
      var mount = document.head || document.documentElement;
      if (!mount) {
        log("scriptlets", "DOM пуст — вставка отложена/пропущена (поздний путь)");
        return;
      }
      mount.appendChild(el);
      el.remove();
      state.scriptlets = code.length;
      try {
        state.scriptletsAt = Math.round(performance.now());
      } catch (e) {
        /* диагностика — не критично */
      }
      log("scriptlets", code.length + " chars");
    } catch (e) {
      log("scriptlets", "error: " + e);
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
      // Карточка 044: ранний скрипт (NavigationStarting →
      // AddScriptToExecuteOnDocumentCreated, main.rs install_early_cosmetic)
      // уже исполнил скриптлеты ДО инлайн-скриптов страницы — повторная
      // инъекция через <script> не нужна (двойной вызов set/json-prune
      // бессмысленен). Фолбэк: флаг не стоит — ранний путь не сработал
      // (первая навигация вкладки, движок строился) — колем как раньше.
      if (window.__duopulseSyncScriptlets === true) {
        state.syncScriptlets = true;
        log("scriptlets", "уже исполнены ранним скриптом (карточка 044)");
      } else {
        runScriptlets(msg.injectedScript || "");
      }
      state.hiddenSelectors += hide(msg.hide || []);
      state.ready = true;
      log(
        "resources",
        "hide=" + (msg.hide || []).length + " generichide=" + msg.generichide + " js=" + (msg.injectedScript || "").length,
      );
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

  /* --- ранний синхронный канал (карточка 044) -------------------------------
     До инлайн-скриптов страницы (этот скрипт — AddScriptToExecuteOnDocumentCreated):
     блокирующий XHR к loopback-эндпоинту Core (~единицы мс) отдаёт скриптлеты
     и скрытия для ЭТОГО url. Синхронность — суть: YouTube читает встроенный
     ytInitialPlayerResponse первыми же инлайн-скриптами, асинхронная доставка
     ниже опаздывает на ~150–600 мс — SABR-stall метрики P-08. Состояние
     (тумблер/сайт-исключение) решается на момент запроса. Фолбэк —
     асинхронный путь: эндпоинт не отвечает/выключен (порт 0), движок строится
     (ready=false), не-http(s) документ. */
  if (__DUOPULSE_COSMETIC_PORT__ > 0) {
    try {
      var top = false;
      try {
        top = window.top === window.self;
      } catch (e) {}
      var httpish = location.protocol === "http:" || location.protocol === "https:";
      if (top && httpish) {
        var xhr = new XMLHttpRequest();
        xhr.open(
          "GET",
          "http://127.0.0.1:" + __DUOPULSE_COSMETIC_PORT__ + "/duopulse-cosmetic?url=" + encodeURIComponent(location.href),
          false,
        );
        xhr.send(null);
        if (xhr.status === 200) {
          var sync = JSON.parse(xhr.responseText);
          if (sync && sync.active && sync.ready) {
            // Скриптлеты — сразу прямым eval (DOM пуст, инлайн-скрипты страницы
            // ещё не выполнялись). Селекторы скрытия — асинхронному пути ниже:
            // <style> не к чему прикрепить, а CSS-тайминг не критичен.
            if (runScriptletsDirect(sync.script || "")) {
              log("early", "sync: js=" + (sync.script || "").length);
            }
          } else if (sync && sync.active && !sync.ready) {
            log("early", "движок строится — асинхронный путь");
          } else {
            log("early", "фильтрация неактивна");
          }
        }
      }
    } catch (e) {
      log("early", "sync-канал недоступен: " + e);
    }
  }

  requestResources();
})();
