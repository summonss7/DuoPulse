// DuoPulse google-video (duopulse-236) — document-start скрипт страниц поиска
// Google в web-оверлее.
//
// Зачем (жалоба Артёма: «ищу видео, открываю из списка — блокировка рекламы не
// срабатывает, открывается прямо на сайте Google в поиске»): в мобильной
// выдаче Google у ролика YouTube миниатюра с ▶ («Відтворити в Google») — не
// ссылка на YouTube, а кнопка плеера Google: видео играет ПРЯМО В ДОКУМЕНТЕ
// выдачи (адрес остаётся google.com/search…#sv=…, iframe youtube.com/embed).
// Навигации нет — ни shouldOverrideUrlLoading, ни onPageStarted, ни
// консоль-хук DPURL не срабатывают, реклама не блокируется. Id ролика лежит
// в самой разметке результата: контейнер [data-vid] с data-surl/data-curl
// (прямая ссылка) и data-pubr (издатель).
//
// Что делает: на страницах поиска Google (только главный фрейм) слушает click
// в capture-фазе на window — раньше обработчиков Google. Клик по «▶»-миниатюре
// или по ссылке ролика YouTube гасит (preventDefault + stopPropagation: плеер
// Google не открывается, переход /url?q= не стартует) и репортит
// console.log("DPYT:<videoId>") — ловит onConsole MobileWebHelper →
// встроенный плеер DuoPulse. Делегирование по [data-vid] — подгруженные
// результаты и SPA-поиск покрыты без MutationObserver.
//
// Не наши: «Про цей результат» и прочие кнопки в обёртке с собственным
// jsaction; ссылки не на ролик (сайт издателя, «о результате»); результаты
// других издателей (TikTok, Facebook — их играет плеер Google, как прежде),
// плейлисты и каналы.
//
// Регистрирует MobileWebHelper.installGoogleVideo
// (WebViewCompat.addDocumentStartJavaScript, «*» — хост проверяет сам скрипт;
// рантайм без DOCUMENT_START_SCRIPT — тот же пейлоад в onPageFinished).
// Юнит-тесты — src/mobile/google-video.test.ts.
(function () {
  "use strict";
  if (window.__dpGoogleVideo) return;
  window.__dpGoogleVideo = true;
  if (window.top !== window) return;
  var host = (location.hostname || "").toLowerCase();
  if (!/(^|\.)google\.[a-z.]+$/.test(host)) return;
  if (!/^\/(?:search|url)$/.test(location.pathname)) return;

  var ID = /^[\w-]{6,20}$/;

  /** videoId из ссылки YouTube (watch?v=, /shorts/, /live/, /embed/, youtu.be)
   *  — тот же разбор, что youTubeVideoId в MobileWebHelper; иначе "". */
  function videoId(u) {
    var p;
    try { p = new URL(u); } catch (e) { return ""; }
    var h = p.hostname.toLowerCase().replace(/^www\./, "");
    var path = p.pathname;
    var id = "";
    if (h === "youtu.be") {
      id = path.replace(/^\/+/, "").split("/")[0];
    } else if (h === "youtube.com" || h.slice(-12) === ".youtube.com") {
      if (path === "/watch") {
        id = p.searchParams.get("v") || "";
      } else {
        var m = /^\/(?:embed|shorts|live)\/([^/]+)$/.exec(path);
        id = m ? m[1] : "";
      }
    }
    return ID.test(id) ? id : "";
  }

  /** Контейнер видео-результата с id ролика YouTube — иначе null. Прямая
   *  ссылка результата — истина: не ролик YouTube (плейлист без ролика, канал,
   *  видео другого издателя) — не трогаем. */
  function result(el) {
    var c = el && el.closest ? el.closest("[data-vid]") : null;
    if (!c) return null;
    var id = videoId(c.getAttribute("data-surl") || "") ||
      videoId(c.getAttribute("data-curl") || "");
    var vid = c.getAttribute("data-vid") || "";
    if (!id && (c.getAttribute("data-pubr") || "").toLowerCase() === "youtube" && ID.test(vid)) {
      id = vid;
    }
    return id ? { el: c, id: id } : null;
  }

  /** Контрол результата, по которому кликнули: «▶»-миниатюра (role=button без
   *  чужого обработчика — «Про цей результат» сидит в обёртке с собственным
   *  jsaction) либо ссылка результата через редиректор Google
   *  (/url?q=<ролик> | /goto?url=<токен>). Иначе null. */
  function hit(target) {
    var ctl = target && target.closest ? target.closest('a[href],[role="button"]') : null;
    if (!ctl) return null;
    var r = result(ctl);
    if (!r || r.el !== target.closest("[data-vid]")) return null;
    if (ctl.tagName === "A") {
      var h = ctl.getAttribute("href") || "";
      var m = /^\/(url|goto)\?/i.exec(h);
      if (!m) return null;
      if (m[1].toLowerCase() === "url") {
        var q = "";
        try { q = new URL(h, location.href).searchParams.get("q") || ""; } catch (e) { q = ""; }
        if (videoId(q) !== r.id) return null;
      }
    } else if (!ctl.hasAttribute("data-vll") && ctl.closest("[jsaction]") !== r.el) {
      return null;
    }
    return r;
  }

  function intercept(e) {
    var r = hit(e.target);
    if (!r) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    console.log("DPYT:" + r.id);
  }
  window.addEventListener("click", intercept, true);
  // Enter/пробел по сфокусированной «▶»-миниатюре (div role=button клика сам
  // не порождает) — тот же перехват. Ссылку не трогаем: Enter по ней и так
  // даёт click (гасит intercept — один репорт), пробел — прокрутка, не активация
  window.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    var ctl = e.target && e.target.closest ? e.target.closest('a[href],[role="button"]') : null;
    if (!ctl || ctl.tagName === "A") return;
    intercept(e);
  }, true);
})();
