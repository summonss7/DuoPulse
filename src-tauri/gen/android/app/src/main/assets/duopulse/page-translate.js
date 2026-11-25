// DuoPulse page-translate (duopulse-245) — перевод всей страницы web-оверлея
// Android, паритет с десктопом duopulse-244.
//
// Зачем: на десктопе «Перевести страницу…» (⋮-меню + контекстное меню)
// переводит документ целиком (content/page-translate.ts, конвейер gtx Core).
// Мобильный web-оверлей — отдельный WebView без десктопного контент-бандла и
// без Tauri-канала: у него свой слой пейлоадов (assets/duopulse/), вход —
// пункт «⋮»-меню шапки оверлея (нативный Kotlin, MobileWebHelper.showMenu →
// evaluateJavascript window.__duopulsePageTranslate.begin()).
//
// Что делает: собирает текстовые узлы документа (TreeWalker; служебные теги,
// translate=no, contenteditable и свои узлы — мимо), водит пачки (≤ 40 строк /
// ≤ 1200 символов, пауза 150 мс — всплески бесплатный gtx считает абузом)
// транспортом ВЕБ-ФЕТЧ прямо из страницы (duopulse-208: браузерный TLS-профиль
// Android System WebView Google не бот-блокирует — эмулятор включён; эндпоинт
// gtx отдаёт CORS *, два хоста — канонический и clients5). Ответы dj=1
// разбирает как parse_gtx_dj Rust (sentences[].trans, перенос строки пачки
// Google сохраняет внутри trans; несовпадение числа строк — построчный
// добор). Заменяет textContent с сохранением оригиналов (Map) и пробельного
// контура узла. Бар сверху (CSSOM, гайд 06 §6 — DOM без каналов, CSP страницы
// не нарушаем): статус, селект цели (15 языков десктопа), «Оригинал»/
// «Показать перевод», «×» (спрятать бар; перевод живёт). Смена цели —
// оригиналы на место и полный прогон заново; MutationObserver дочитывает
// динамику (debounce 700 мс), пока перевод показан. Последняя цель —
// localStorage (инкогнито-профиль изолирован и сносится сам). Жизнь — до
// навигации документа (SPA-смена URL документ не убивает — перевод остаётся).
//
// CSP страницы с connect-src без googleapis заблокирует фетч — бар честно
// покажет «Не получилось» (мобильного Core-фолбэка у оверлея нет; ureq Core
// на эмуляторе бот-блочится — duopulse-208, потому веб-фетч и основной).
//
// Транспорт для тестов/стендов подменяется ДО begin: window.__dpPtFetch(url)
// → Promise<Response-подобного {status:number, text():Promise<string>}>
// (юнит-тесты src/mobile/page-translate.test.ts — happy-dom; смоук
// e2e/mobile/page-translate-smoke.mjs — CDP, детерминированная фаза без
// живого gtx).
//
// Инжекция — MobileWebHelper в onPageFinished (идемпотентен: маркер
// __dpPageTranslate; переводу ранний старт не нужен — вход всегда от
// пользователя). Регистрирует window.__duopulsePageTranslate {begin, state,
// stop} (диагностика стендов — state() снапшот).
(function () {
  "use strict";
  if (window.__dpPageTranslate) return;
  window.__dpPageTranslate = true;
  if (window.top !== window) return; // только главный документ оверлея

  /** Языки селекта цели — зеркало SELECTION_LANGS десктопа
   *  (content/translate-select.ts, 15 языков). */
  var LANGS = [
    { code: "ru", name: "Русский" },
    { code: "en", name: "English" },
    { code: "uk", name: "Українська" },
    { code: "de", name: "Deutsch" },
    { code: "fr", name: "Français" },
    { code: "es", name: "Español" },
    { code: "it", name: "Italiano" },
    { code: "pt", name: "Português" },
    { code: "pl", name: "Polski" },
    { code: "tr", name: "Türkçe" },
    { code: "ro", name: "Română" },
    { code: "kk", name: "Қазақша" },
    { code: "ar", name: "العربية" },
    { code: "ja", name: "日本語" },
    { code: "zh", name: "中文" }
  ];

  /** Строк в одной пачке gtx (лимит Core-конвейера GTX_BATCH_MAX_LINES=60;
   *  запас — как на десктопе, на случай построчного фолбэка). */
  var MAX_LINES_PER_BATCH = 40;
  /** Символов в одной пачке (GET-query; с запасом до ~8 КБ адреса). */
  var MAX_CHARS_PER_BATCH = 1200;
  /** Пауза между пачками, мс: бесплатный gtx всплески считает абузом. */
  var BATCH_STAGGER_MS = 150;
  /** Пауза накопления новых узлов MutationObserver до запроса, мс. */
  var MUTATION_DEBOUNCE_MS = 700;
  /** Минимальная длина непробельного текста узла. */
  var MIN_TEXT_LEN = 2;
  /** Ключ памяти последней цели (try/catch — localStorage бывает закрыт). */
  var TARGET_KEY = "duopulse.pageTranslateTarget";

  /** Теги без видимого текста (или с машинным: код, разметка). */
  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, TEXTAREA: 1, TITLE: 1,
    CODE: 1, PRE: 1, KBD: 1, SAMP: 1, VAR: 1, SVG: 1, IFRAME: 1, OBJECT: 1,
    CANVAS: 1, AUDIO: 1, VIDEO: 1, MAP: 1
  };

  /** Свои узлы (бар перевода) — не собираем и не переводим. */
  var UI_SLOW = "[data-duopulse-translate]";

  /** Пробельный контур оригинала: сохранить отступы узла при замене. */
  function splitEdges(text) {
    var start = text.length - text.trimStart().length;
    var end = text.trimEnd().length;
    return {
      lead: text.slice(0, start),
      core: text.slice(start, Math.max(end, start)),
      trail: text.slice(Math.max(end, start))
    };
  }

  /** Годен ли текст к переводу: непустой, не только цифры/знаки. */
  function isTranslatableText(text) {
    var core = splitEdges(text).core;
    if (core.length < MIN_TEXT_LEN) return false;
    // только цифры и пунктуация — не переводим (цены, счётчики, артикулы)
    return /[^\p{N}\p{P}\p{Z}\s]/u.test(core);
  }

  /** Пропустить элемент целиком: служебный тег, перевод запрещён, правка. */
  function skipElement(el) {
    if (!el) return false;
    if (SKIP_TAGS[el.tagName]) return true;
    if (el.closest && el.closest(UI_SLOW)) return true; // бар — наш
    var tr = el.getAttribute && el.getAttribute("translate");
    if (tr && tr.toLowerCase() === "no") return true; // HTML translate=no
    if (el.isContentEditable) return true;
    return false;
  }

  /** Собрать переводимые текстовые узлы поддерева (порядок DOM). */
  function collectTextNodes(root) {
    var out = [];
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (skipElement(node.parentElement)) return NodeFilter.FILTER_REJECT;
        if (!isTranslatableText(node.nodeValue || "")) return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    for (var n = walker.nextNode(); n; n = walker.nextNode()) out.push(n);
    return out;
  }

  /** Нарезать узлы на пачки (порядок сохраняется). */
  function chunkNodes(nodes) {
    var chunks = [];
    var cur = [];
    var chars = 0;
    for (var i = 0; i < nodes.length; i++) {
      var len = (nodes[i].nodeValue || "").length;
      if (cur.length > 0 && (cur.length >= MAX_LINES_PER_BATCH || chars + len > MAX_CHARS_PER_BATCH)) {
        chunks.push(cur);
        cur = [];
        chars = 0;
      }
      cur.push(nodes[i]);
      chars += len;
    }
    if (cur.length > 0) chunks.push(cur);
    return chunks;
  }

  // --- транспорт: веб-фетч gtx (duopulse-208) -----------------------------------

  /** Хосты gtx: канонический сперва, clients5 — запасная рёбра (лимиты
   *  независимые; порядок — GTX_WEB_HOSTS session.ts мобильной ветки). */
  var GTX_HOSTS = ["translate.googleapis.com", "clients5.google.com"];

  /** GET: продовый fetch из страницы; тесты/стенд подменяют __dpPtFetch. */
  function httpGet(url) {
    if (typeof window.__dpPtFetch === "function") return window.__dpPtFetch(url);
    return fetch(url);
  }

  /** Разбор dj=1-ответа gtx: sentences[].trans, слепленные в одну строку —
   *  переносы строк пачки Google сохраняет внутри trans (семантика
   *  parse_gtx_dj Rust: предложение без trans рушит весь разбор). */
  function parseDj(body) {
    var v;
    try { v = JSON.parse(body); } catch (e) { return null; }
    if (!v || !Array.isArray(v.sentences)) return null;
    var out = "";
    for (var i = 0; i < v.sentences.length; i++) {
      var s = v.sentences[i];
      if (!s || typeof s.trans !== "string") return null;
      out += s.trans;
    }
    return out;
  }

  /** Один GET gtx по хостам подряд: сетевой отказ/CSP — следующий хост;
   *  все упали — {error}; не-200 — {error} честным статусом (лимит уровня
   *  адреса бьёт оба профиля, ретраи лишь продлят «занято»). */
  function gtxGet(from, to, joined) {
    var idx = 0;
    var httpErr = null;
    function next() {
      if (idx >= GTX_HOSTS.length) {
        return Promise.resolve({ error: httpErr || "сеть/CSP страницы запретили запрос" });
      }
      var host = GTX_HOSTS[idx++];
      var url = "https://" + host + "/translate_a/single?client=gtx&dj=1" +
        "&sl=" + encodeURIComponent(from) + "&tl=" + encodeURIComponent(to) +
        "&dt=t&q=" + encodeURIComponent(joined);
      return httpGet(url).then(function (resp) {
        if (resp.status !== 200) {
          httpErr = "gtx HTTP " + resp.status + " (" + host + ")";
          return next();
        }
        return resp.text().then(function (body) {
          var parsed = parseDj(body);
          if (parsed === null) return { error: "gtx ответ не разобран" };
          return { text: parsed };
        });
      }, function () {
        return next(); // сеть/прокси/CSP — следующая рёбра
      });
    }
    return next();
  }

  /** Перевести пачку строк: пакетный GET (строки через \n), при несовпадении
   *  числа строк — построчный добор (Google смёржил короткие; схема
   *  translate_batch Rust / gtxWebBatch session.ts). */
  function gtxBatch(texts, from, to) {
    return gtxGet(from, to, texts.join("\n")).then(function (r) {
      if (r.error) return r;
      var lines = r.text.split("\n");
      if (lines.length === texts.length) return { lines: lines };
      var out = [];
      var chain = Promise.resolve();
      for (var i = 0; i < texts.length; i++) {
        (function (txt) {
          chain = chain.then(function () {
            return gtxGet(from, to, txt).then(function (one) {
              if (one.error) throw one;
              out.push(one.text.trim());
            });
          });
        })(texts[i]);
      }
      return chain.then(
        function () { return { lines: out }; },
        function (e) { return e; }
      );
    });
  }

  // --- контроллер (один на документ) --------------------------------------------

  /** Оригиналы переведённых узлов (восстановление «Оригинал»). */
  var originals = new Map();
  var phase = "idle"; // idle | translating | translated | original | error
  var target = "";
  var done = 0;
  var total = 0;
  var lastError = "";
  /** Поколение запроса: отменяет ответы прошлых стартов. */
  var generation = 0;
  var banner = null;
  var statusLabel = null;
  var targetSelect = null;
  var toggleBtn = null;
  var observer = null;
  var mutationTimer = 0;
  var pendingMutationNodes = [];

  /** Код языка: trim/нижний регистр; валиден из LANGS. */
  function normalizeLang(lang) {
    var code = String(lang || "").trim().toLowerCase();
    for (var i = 0; i < LANGS.length; i++) if (LANGS[i].code === code) return code;
    return "";
  }

  function langName(code) {
    for (var i = 0; i < LANGS.length; i++) if (LANGS[i].code === code) return LANGS[i].name;
    return code;
  }

  function rememberedTarget() {
    try {
      return normalizeLang(localStorage.getItem(TARGET_KEY) || "");
    } catch (e) {
      return "";
    }
  }

  function saveTarget(code) {
    try { localStorage.setItem(TARGET_KEY, code); } catch (e) { /* без памяти */ }
  }

  var delay = function (ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  };

  /** Диагностика стендов (window.__duopulsePageTranslate.state()). */
  function state() {
    return {
      phase: phase,
      target: target,
      nodes: originals.size,
      done: done,
      total: total,
      lastError: lastError,
      bannerVisible: banner !== null
    };
  }

  /** Вход пользователя (⋮-меню): старт/продолжение перевода страницы.
   *  target не задан — последняя цель (localStorage) либо «ru». */
  function begin(lang) {
    var code = normalizeLang(lang) || rememberedTarget() || "ru";
    // повторный вход с той же целью: показать бар (перевод уже стоит)
    if (phase === "translated" && code === target) {
      showBanner();
      return Promise.resolve();
    }
    // смена цели / показ оригинала / повтор после ошибки: оригиналы на
    // место (память Map) и полный прогон заново — перевода «без сети» не храним
    stopObserver();
    restoreOriginals();
    target = code;
    saveTarget(code);
    generation++;
    var gen = generation;
    lastError = "";
    phase = "translating";
    done = 0;
    var nodes = document.body ? collectTextNodes(document.body) : [];
    total = nodes.length;
    showBanner();
    updateLabel();
    if (nodes.length === 0) {
      phase = "translated"; // пустая страница — «переведено» без запросов
      updateLabel();
      return Promise.resolve();
    }
    var chain = Promise.resolve();
    var chunks = chunkNodes(nodes);
    for (var i = 0; i < chunks.length; i++) {
      (function (chunk) {
        chain = chain.then(function () {
          if (gen !== generation) return; // сменили цель/выключили
          return translateChunk(chunk, code, gen);
        }).then(function () {
          if (gen !== generation) return;
          if (BATCH_STAGGER_MS > 0) return delay(BATCH_STAGGER_MS);
        });
      })(chunks[i]);
    }
    return chain.then(function () {
      if (gen !== generation) return;
      phase = "translated";
      updateLabel();
      startObserver();
    });
  }

  function translateChunk(chunk, code, gen) {
    var texts = [];
    for (var i = 0; i < chunk.length; i++) {
      texts.push(splitEdges(chunk[i].nodeValue || "").core);
    }
    return gtxBatch(texts, "auto", code).then(function (reply) {
      if (gen !== generation) return;
      if (!reply || !Array.isArray(reply.lines)) {
        fail(reply && typeof reply.error === "string" ? reply.error : "транспорт не ответил");
        return;
      }
      for (var j = 0; j < chunk.length; j++) {
        var node = chunk[j];
        var line = typeof reply.lines[j] === "string" ? reply.lines[j] : "";
        if (!line) continue; // пустой перевод — узел остаётся оригиналом
        if (!originals.has(node)) originals.set(node, node.nodeValue || "");
        var edges = splitEdges(originals.get(node));
        node.nodeValue = edges.lead + line + edges.trail;
        done++;
      }
      updateLabel();
    });
  }

  function fail(message) {
    // отмена идущих пачек этого прогона: кулдаун gtx гасит и следующие —
    // частичный перевод остаётся, повтор из бара/меню пойдёт с нуля
    generation++;
    phase = "error";
    lastError = message;
    updateLabel();
  }

  /** Оригиналы на место (перевод снят). */
  function restoreOriginals() {
    originals.forEach(function (original, node) {
      node.nodeValue = original;
    });
    originals.clear();
    done = 0;
  }

  /** Показать оригинал (кнопка бара): вернуть все textContent. */
  function showOriginal() {
    if (phase !== "translated" && phase !== "error") return;
    generation++; // отменяет идущие пачки
    stopObserver();
    restoreOriginals();
    phase = "original";
    updateLabel();
  }

  /** Смена цели в баре: запомнить выбор, перевести заново. */
  function retarget(lang) {
    var code = normalizeLang(lang);
    if (!code || code === target) return;
    void begin(code);
  }

  /** Спрятать бар (перевод остаётся; меню вернёт бар). */
  function hideBanner() {
    if (banner) {
      banner.remove();
      banner = null;
      statusLabel = null;
      targetSelect = null;
      toggleBtn = null;
    }
  }

  /** Остановить контроллер (юнит-тесты): наблюдатель, таймеры, бар;
   *  переведённые узлы остаются как есть. */
  function stop() {
    generation++;
    stopObserver();
    hideBanner();
    phase = "idle";
  }

  function updateLabel() {
    if (!statusLabel) return;
    if (phase === "translating") {
      var pct = total > 0 ? Math.min(99, Math.round((done / total) * 100)) : 0;
      statusLabel.textContent = "Переводим… " + pct + "%";
    } else if (phase === "translated") {
      statusLabel.textContent = "Переведено на " + langName(target);
    } else if (phase === "original") {
      statusLabel.textContent = "Оригинал (" + langName(target) + ")";
    } else if (phase === "error") {
      statusLabel.textContent = "Не получилось: " + lastError;
    }
    if (toggleBtn) {
      toggleBtn.textContent = phase === "original" ? "Показать перевод" : "Оригинал";
    }
  }

  function showBanner() {
    if (banner && banner.isConnected) {
      updateLabel();
      return;
    }
    hideBanner();
    var root = document.createElement("div");
    root.setAttribute("data-duopulse-page-bar", "1");
    root.setAttribute("data-duopulse-translate", "page");
    var s = root.style;
    s.position = "fixed";
    s.top = "8px";
    s.left = "50%";
    s.transform = "translateX(-50%)";
    s.zIndex = "2147483647";
    s.maxWidth = "min(560px, calc(100vw - 16px))";
    s.display = "flex";
    s.alignItems = "center";
    s.gap = "8px";
    s.padding = "6px 10px";
    s.borderRadius = "8px"; // гайд 06 §6
    s.border = "1px solid rgba(189,254,79,0.25)";
    s.background = "rgba(10,14,23,0.96)";
    s.color = "#E8EDF2";
    s.fontFamily = "Inter, 'Segoe UI', system-ui, sans-serif";
    s.fontSize = "13px";
    s.lineHeight = "1.4";
    s.pointerEvents = "auto";
    s.boxShadow = "0 8px 24px rgba(0,0,0,0.4)";
    // на узких экранах бар переносится, не выезжая за края
    s.flexWrap = "wrap";

    var status = document.createElement("span");
    var ss = status.style;
    ss.color = "#BDFE4F";
    ss.fontSize = "12px";
    ss.fontWeight = "600";
    ss.whiteSpace = "nowrap";
    ss.overflow = "hidden";
    ss.textOverflow = "ellipsis";
    ss.maxWidth = "220px";

    var select = document.createElement("select");
    var ts = select.style;
    ts.background = "rgba(189,254,79,0.14)";
    ts.color = "#BDFE4F";
    ts.border = "1px solid rgba(189,254,79,0.3)";
    ts.borderRadius = "4px";
    ts.padding = "2px 4px";
    ts.fontFamily = "inherit";
    ts.fontSize = "12px";
    select.setAttribute("aria-label", "Язык перевода страницы");
    for (var i = 0; i < LANGS.length; i++) {
      var opt = document.createElement("option");
      opt.value = LANGS[i].code;
      opt.textContent = LANGS[i].name;
      select.appendChild(opt);
    }
    select.value = target || "ru";
    select.addEventListener("change", function () {
      retarget(select.value);
    });

    var toggle = document.createElement("button");
    toggle.type = "button";
    toggle.textContent = "Оригинал";
    toggle.setAttribute("aria-label", "Показать оригинал страницы");
    var gs = toggle.style;
    gs.border = "1px solid rgba(255,255,255,0.2)";
    gs.background = "rgba(255,255,255,0.06)";
    gs.color = "#E8EDF2";
    gs.borderRadius = "4px";
    gs.padding = "3px 8px";
    gs.fontFamily = "inherit";
    gs.fontSize = "12px";
    gs.cursor = "pointer";
    toggle.addEventListener("click", function () {
      if (phase === "original") void begin(target);
      else showOriginal();
    });

    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "×";
    closeBtn.setAttribute("aria-label", "Спрятать панель перевода");
    var cs = closeBtn.style;
    cs.border = "none";
    cs.background = "transparent";
    cs.color = "#93A0AE";
    cs.fontSize = "16px";
    cs.lineHeight = "1";
    cs.cursor = "pointer";
    cs.padding = "0 2px";
    closeBtn.addEventListener("click", function () { hideBanner(); });

    root.appendChild(status);
    root.appendChild(select);
    root.appendChild(toggle);
    root.appendChild(closeBtn);
    document.documentElement.appendChild(root);
    banner = root;
    statusLabel = status;
    targetSelect = select;
    toggleBtn = toggle;
    updateLabel();
  }

  // --- дочитка динамики ----------------------------------------------------------

  /** Наблюдатель динамики: новые текстовые узлы переводятся, пока показан
   *  перевод (childList; свои замены узлов уже в originals — пропускаем). */
  function startObserver() {
    if (observer || !document.body) return;
    observer = new MutationObserver(function (records) {
      onMutations(records);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (mutationTimer) {
      clearTimeout(mutationTimer);
      mutationTimer = 0;
    }
    pendingMutationNodes = [];
  }

  function onMutations(records) {
    if (phase !== "translated") return;
    var fresh = false;
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (r.type === "characterData") {
        // собственная замена узла (он уже в originals) — не динамика;
        // правка стороннего текста — не трогаем (v1)
        continue;
      }
      for (var j = 0; j < r.addedNodes.length; j++) {
        var node = r.addedNodes[j];
        if (node.nodeType !== 3) {
          // элементы — спускаемся внутрь (в т.ч. целые поддеревья)
          if (node.nodeType === 1 && !skipElement(node)) {
            var inner = collectTextNodes(node);
            for (var k = 0; k < inner.length; k++) {
              if (!originals.has(inner[k])) {
                pendingMutationNodes.push(inner[k]);
                fresh = true;
              }
            }
          }
          continue;
        }
        if (originals.has(node)) continue;
        if (!isTranslatableText(node.nodeValue || "")) continue;
        if (skipElement(node.parentElement)) continue;
        pendingMutationNodes.push(node);
        fresh = true;
      }
    }
    if (!fresh) return;
    if (mutationTimer) clearTimeout(mutationTimer);
    mutationTimer = setTimeout(function () {
      mutationTimer = 0;
      translateMutations();
    }, MUTATION_DEBOUNCE_MS);
  }

  /** Перевод накопленных мутаций (дочитка динамики). */
  function translateMutations() {
    if (phase !== "translated") {
      pendingMutationNodes = [];
      return;
    }
    var nodes = [];
    for (var i = 0; i < pendingMutationNodes.length; i++) {
      if (pendingMutationNodes[i].isConnected) nodes.push(pendingMutationNodes[i]);
    }
    pendingMutationNodes = [];
    if (nodes.length === 0) return;
    var gen = generation;
    var code = target;
    total = Math.max(total, originals.size + nodes.length);
    var chunks = chunkNodes(nodes);
    var chain = Promise.resolve();
    for (var j = 0; j < chunks.length; j++) {
      (function (chunk) {
        chain = chain.then(function () {
          if (gen !== generation) return;
          return translateChunk(chunk, code, gen);
        });
      })(chunks[j]);
    }
  }

  // --- API (Kotlin-меню, стенды, тесты) ------------------------------------------

  window.__duopulsePageTranslate = {
    begin: begin,
    state: state,
    stop: stop
  };
})();
