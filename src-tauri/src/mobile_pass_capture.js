// DuoPulse — пейлоад захвата паролей web-оверлея (карточка duopulse-165,
// паритет 2/8 аудита duopulse-156): мобильный перенос детекта формы логина
// из content/passwords-fill.ts (этап 2 duopulse-108). Контент-бандл в
// нативный WebView Android не инжектируется (канал WebMessage — только
// WebView2), поэтому пейлоад подаётся evaluateJavascript'ом из
// MobileWebHelper (источник — include_str! этого файла в mobile_pass.rs),
// а уходит кандидат JS-интерфейсом DuopulsePass — пароль не проходит через
// консоль/logcat и не попадает в UI-webview до решения Core.
//
// Логика — только захват кандидата по сабмиту (submit / Enter в поле пары /
// клик по сабмит-кнопке SPA-формы; дедуп по логин|пароль); автозаполнение —
// этап 3 (duopulse-166). Решение «заслужен ли бар» и судьба кандидата —
// Core (mobile_pass.rs → PasswordPrompts): URL страницы и origin считает
// Kotlin по webView.url, этому пейлоаду не верим. Повторная инжекция в тот
// же документ — тишина (маркер __dpPassWatch). В отличие от десктопа,
// клик/тап по САМОМУ полю кандидатом не считается: на тач-экране тап по
// полю — правка ввода, а не отправка формы.
(function () {
  if (window.__dpPassWatch) return;
  window.__dpPassWatch = 1;

  // Поле, которое может быть логином (не пароль и не служебные типы).
  function isUser(el) {
    if (!el || el.tagName !== "INPUT") return false;
    var t = (el.getAttribute("type") || "").toLowerCase();
    return t === "text" || t === "email" || t === "tel" || t === "url" || t === "";
  }

  // Поле логина для поля пароля: последнее текстовое ДО него — в общей
  // форме (порядок элементов) или в документе (SPA-логины без <form>).
  // Регистрация с confirm-полем не мешает: логин живёт до ПЕРВОГО пароля.
  function userFor(pass) {
    var scope = pass.form || document;
    var inputs = Array.prototype.slice.call(scope.querySelectorAll("input"));
    var ix = inputs.indexOf(pass);
    var best = null;
    for (var i = 0; i < ix; i++) if (isUser(inputs[i])) best = inputs[i];
    return best;
  }

  // Пары «логин + пароль» документа (лениво на каждом событии — SPA рисуют
  // формы когда вздумает, отдельный MutationObserver не нужен).
  function pairs() {
    var out = [];
    var all = document.querySelectorAll("input[type=password]");
    for (var i = 0; i < all.length; i++) {
      var p = all[i];
      if (!p.disabled) out.push({ pass: p, user: userFor(p) });
    }
    return out;
  }

  // Пара для цели события: сами поля пары либо сабмит-контрол (кнопка)
  // её формы/контейнера. Клик по прочей странице — мимо.
  function pairOf(target) {
    if (!target) return null;
    var tag = target.tagName;
    if (tag !== "INPUT" && tag !== "BUTTON") return null;
    var ps = pairs();
    for (var i = 0; i < ps.length; i++)
      if (ps[i].pass === target || ps[i].user === target) return ps[i];
    var t = (target.getAttribute("type") || "").toLowerCase();
    if (tag !== "BUTTON" && t !== "submit" && t !== "button") return null;
    for (var j = 0; j < ps.length; j++)
      if (ps[j].pass.form && target.form === ps[j].pass.form) return ps[j];
    // без <form>: кнопка в общем контейнере с паролем (SPA-логины)
    for (var k = 0; k < ps.length; k++) {
      var box = ps[k].pass.closest("div,section,fieldset");
      if (box && box.contains(target)) return ps[k];
    }
    return null;
  }

  // Последний отправленный кандидат (дедуп: повторные клики/Enter той же
  // формы не спамят; смена пароля проходит как update).
  var lastSig = "";
  function collect(pair) {
    var u = ((pair.user && pair.user.value) || "").trim();
    var p = pair.pass.value || "";
    if (!u || !p) return; // пустое хранилище не примет — бара не будет
    var sig = u + "|" + p;
    if (sig === lastSig) return;
    lastSig = sig;
    try {
      if (window.DuopulsePass && window.DuopulsePass.report)
        window.DuopulsePass.report(JSON.stringify({ username: u, password: p }));
    } catch (e) {
      /* мост недоступен — странице не мешаем */
    }
  }

  document.addEventListener(
    "submit",
    function (e) {
      var t = e.target;
      var ps = pairs();
      for (var i = 0; i < ps.length; i++)
        if (t && t.contains && t.contains(ps[i].pass)) {
          collect(ps[i]);
          break;
        }
    },
    true,
  );
  document.addEventListener(
    "keydown",
    function (e) {
      if (e.key !== "Enter") return;
      var pr = pairOf(e.target);
      if (pr) collect(pr);
    },
    true,
  );
  document.addEventListener(
    "click",
    function (e) {
      var el = e.target;
      if (!el) return;
      var tag = el.tagName;
      if (tag === "INPUT") {
        var t = (el.getAttribute("type") || "").toLowerCase();
        if (t !== "submit" && t !== "button") return;
      } else if (tag !== "BUTTON") return;
      var pr = pairOf(el);
      if (pr) collect(pr);
    },
    true,
  );
})();
