// DuoPulse — пейлоад автозаполнения паролей web-оверлея (карточка
// duopulse-166, паритет 3/8 аудита duopulse-156): мобильный перенос
// content/passwords-fill.ts в нативный WebView Android (контент-бандл
// туда не инжектируется — канал WebMessage есть только у WebView2).
// Инжекция — evaluateJavascript из MobileWebHelper (источник include_str!
// в mobile_pass.rs), подаётся после пейлоада захвата (mobile_pass_capture.js).
//
// Цепочка: форма логина найдена → DuopulseFill.ready() (JS-интерфейс,
// Kotlin) → Core accounts_for (логины сайта, БЕЗ паролей; инкогнито —
// пусто, иконки не показываются) → __dpPassAccounts([...]) сюда →
// иконка-ключ 🔑 у поля пароля → тап → DuopulseFill.pick() → один аккаунт:
// заполнение сразу; несколько: нативный нижний лист (имена без паролей) →
// выбор → Core credential (reveal по факту выбора) → __dpPassFill(логин,
// пароль) — заполняет поля нативными сеттерами (input/change видит сайт-JS
// React/Vue), значение пароля живёт в памяти мгновение и НИКУДА не
// сохраняется (ни JS-переменные после заполнения, ни веб-хранилища, ни
// консоль). URL и origin считает Kotlin (webView.url) — этому пейлоаду
// не верим. Повторная инжекция в тот же документ — тишина (маркер
// __dpPassFillWatch). В отличие от десктопа, автозаполнение стартует не
// кликом по полю (тап на тач-экране — правка ввода), а тапом по иконке.
(function () {
  if (window.__dpPassFillWatch) return;
  window.__dpPassFillWatch = 1;

  // Поле, которое может быть логином (не пароль и не служебные типы).
  function isUser(el) {
    if (!el || el.tagName !== "INPUT") return false;
    var t = (el.getAttribute("type") || "").toLowerCase();
    return t === "text" || t === "email" || t === "tel" || t === "url" || t === "";
  }

  // Поле логина для поля пароля: последнее текстовое ДО него — в общей
  // форме (порядок элементов) или в документе (SPA-логины без <form>).
  function userFor(pass) {
    var scope = pass.form || document;
    var inputs = Array.prototype.slice.call(scope.querySelectorAll("input"));
    var ix = inputs.indexOf(pass);
    var best = null;
    for (var i = 0; i < ix; i++) if (isUser(inputs[i])) best = inputs[i];
    return best;
  }

  // Пары «логин + пароль» (лениво на каждом скане — SPA рисуют формы
  // когда вздумает, ловит MutationObserver ниже).
  function pairs() {
    var out = [];
    var all = document.querySelectorAll("input[type=password]");
    for (var i = 0; i < all.length; i++) {
      var p = all[i];
      if (!p.disabled) out.push({ pass: p, user: userFor(p) });
    }
    return out;
  }

  // Установить значение input «по-настоящему» (сеттер прототипа +
  // input/change): React/Vue-страницы не глотают присвоение value.
  function setVal(el, v) {
    var d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
    if (d && d.set) d.set.call(el, v);
    else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  var accounts = []; // логины сайта от Kotlin (паролей здесь не бывает)
  var icons = []; // {pass, el} — иконка у конкретного поля пароля
  var pending = null; // пара полей, по чьей иконке тапнули (куда заполнять)
  var readySent = false; // ready() один раз на документ (accounts не меняются)
  var scanT = 0;
  var raf = 0;

  // Иконка в правом краю поля пароля: fixed (не скроллится вместе со
  // страницей — переезжает onMove), z-index максимален, стиль — токены
  // DuoPulse (как chooser десктопа: тёмная плашка, акцентная рамка).
  function makeIcon(pair) {
    var el = document.createElement("div");
    el.setAttribute("data-duopulse-passkey", "1");
    var s = el.style;
    s.position = "fixed";
    s.zIndex = "2147483647";
    s.width = "28px";
    s.height = "28px";
    s.lineHeight = "28px";
    s.textAlign = "center";
    s.fontSize = "15px";
    s.borderRadius = "8px";
    s.border = "1px solid rgba(189,254,79,0.35)";
    s.background = "rgba(10,14,23,0.9)";
    s.boxShadow = "0 2px 8px rgba(0,0,0,0.35)";
    s.cursor = "pointer";
    el.textContent = "🔑";
    el.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      pending = pair;
      try {
        if (window.DuopulseFill && window.DuopulseFill.pick) window.DuopulseFill.pick();
      } catch (err) {
        /* мост недоступен — странице не мешаем */
      }
    });
    return el;
  }

  function place(ic) {
    var r = ic.pass.getBoundingClientRect();
    // поле скрылось (display:none у формы, SPA перерисовал) — иконку гасим
    if (r.width <= 0 || r.height <= 0) {
      ic.el.style.display = "none";
      return;
    }
    ic.el.style.display = "block";
    ic.el.style.left = Math.round(Math.max(r.left + 2, r.right - 34)) + "px";
    ic.el.style.top = Math.round(r.top + (r.height - 28) / 2) + "px";
  }

  // Пересобрать иконки под текущие поля пароля (поля без иконки получают,
  // исчезнувшие теряют) и расставить по местам.
  function sync() {
    var alive = [];
    for (var a = 0; a < icons.length; a++) {
      if (document.contains(icons[a].pass)) alive.push(icons[a]);
      else icons[a].el.remove();
    }
    icons = alive;
    if (accounts.length > 0) {
      var ps = pairs();
      for (var k = 0; k < ps.length; k++) {
        (function (pair) {
          for (var j = 0; j < icons.length; j++) if (icons[j].pass === pair.pass) return;
          var el = makeIcon(pair);
          document.documentElement.append(el);
          icons.push({ pass: pair.pass, el: el });
        })(ps[k]);
      }
    }
    for (var b = 0; b < icons.length; b++) place(icons[b]);
  }

  function schedule() {
    if (scanT) return;
    scanT = setTimeout(function () {
      scanT = 0;
      scan();
    }, 300);
  }

  // Скан: сообщить Kotlin про форму логина (один раз — accounts в Core
  // меняются только сохранением), пересобрать иконки.
  function scan() {
    if (pairs().length > 0 && !readySent) {
      readySent = true;
      try {
        if (window.DuopulseFill && window.DuopulseFill.ready) window.DuopulseFill.ready();
      } catch (e) {
        /* мост недоступен — странице не мешаем */
      }
    }
    sync();
  }

  // Логины сайта от Kotlin (JSON-массив строк; пусто/мусор — снять иконки:
  // нет сохранённых или инкогнито — автозаполнения нет).
  window.__dpPassAccounts = function (list) {
    accounts = [];
    if (Object.prototype.toString.call(list) === "[object Array]") {
      for (var i = 0; i < list.length; i++)
        if (typeof list[i] === "string" && list[i]) accounts.push(list[i]);
    }
    if (accounts.length === 0) {
      for (var d = 0; d < icons.length; d++) icons[d].el.remove();
      icons = [];
      return;
    }
    sync();
  };

  // Заполнить форму выбранным логином (Kotlin → Core credential): пару берём
  // по тапнутой иконке (если поле ещё живо), иначе первую найденную. Пароль —
  // аргумент вызова, после заполнения в JS не остаётся нигде.
  window.__dpPassFill = function (username, password) {
    if (typeof username !== "string" || typeof password !== "string") return;
    if (!username || !password) return;
    var pair = null;
    if (pending && document.contains(pending.pass)) pair = pending;
    else {
      var ps = pairs();
      if (ps.length > 0) pair = ps[0];
    }
    if (!pair) return;
    if (pair.user) setVal(pair.user, username);
    setVal(pair.pass, password);
    pending = null;
  };

  // Скролл/ресайз — иконки fixed: переезжают за полями (rAF-уступка).
  function onMove() {
    if (raf) return;
    raf = window.requestAnimationFrame(function () {
      raf = 0;
      for (var i = 0; i < icons.length; i++) place(icons[i]);
    });
  }
  window.addEventListener("scroll", onMove, true);
  window.addEventListener("resize", onMove, true);

  // SPA дорисовывают формы когда вздумает — пересканируем (уступка 300 мс).
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  scan();
})();
