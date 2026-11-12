// DuoPulse dl-fetcher (duopulse-122) — document-start скрипт youtube-фрейма.
//
// Зачем: googlevideo отдаёт медиа только браузерному окружению с youtube-
// origin (CORS: Access-Control-Allow-Origin https://www.youtube.com; со
// страницы приложения fetch не читается, нативные клиенты — 403). Пробы
// 12.11.2026 (duopulse-122): URL клиента ANDROID отдают лишь первый ~1 МиБ,
// WEB требуют PO-токен, а VISIONOS (его запрашивает Rust для листа загрузок)
// даёт прямые url без n-параметра, обслуживающиеся закрытыми диапазонами
// («bytes=N-M»; открытый «bytes=N-» и GET без Range — 403). Поэтому байты
// качает fetch ЗДЕСЬ — внутри youtube-документа (embed-iframe плеера), тем
// же движком/куками/TLS, что и воспроизведение, и пересылает их postMessage'ом
// родителю (странице мобильного UI), который собирает файл кусками через
// invoke в Rust. Родитель задаёт диапазоны сам (cmd "range"), скрипт —
// «глухой» исполнитель одного запроса за раз.
//
// Регистрирует скрипт MainActivity.onWebViewCreate → MobileDownloadHelper.
// registerFetcher (WebViewCompat.addDocumentStartJavaScript, только youtube
// origin). Протокол (tag "duopulse-dl", родитель проверяет event.source):
//   → {cmd:"ping"}                              ← {type:"pong"} — рукопожатие
//   → {cmd:"range", id, url, offset, length}    ← {type:"data", id, buf}
//                                                ← {type:"error", id, message} (HTTP-код в сообщении)
//   → {cmd:"cancel", id}                        прервать текущий запрос (AbortController)
//   → {cmd:"diag"}                              ← {type:"diag", diag:{…}} — e2e-диагностика
// data.buf может быть КОРОЧЕ запрошенного — конец файла; buf переносится
// transfer'ом. Скрипт глубоко инертен: слушает сообщения только от
// window.parent и только googlevideo-адреса.
(function () {
  "use strict";
  if (window.__duopulseDlFetcher) return;
  window.__duopulseDlFetcher = true;
  var TAG = "duopulse-dl";
  var active = {}; // id -> AbortController

  // Диагностика e2e-стендов: доступность playerResponse плеера страницы
  // (внутри embed-страницы movie_player появляется после старта воспроизведения).
  function diag() {
    var out = { playerApi: false, prStatus: "", formats: 0, withUrl: 0 };
    try {
      var el = document.getElementById("movie_player");
      var pr = el && el.getPlayerResponse && el.getPlayerResponse();
      if (pr) {
        out.playerApi = true;
        out.prStatus = (pr.playabilityStatus || {}).status || "";
        var sd = pr.streamingData || {};
        var fmts = (sd.adaptiveFormats || []).concat(sd.formats || []);
        out.formats = fmts.length;
        out.withUrl = fmts.filter(function (f) { return !!f.url; }).length;
      }
    } catch (e) { out.prStatus = "err:" + e; }
    send({ type: "diag", diag: out });
  }

  function send(msg) {
    msg.tag = TAG;
    // origin родителя нам неизвестен (страница приложения) — '*', данные
    // публичные (медиа-байты), родитель сам проверяет event.source
    window.parent.postMessage(msg, "*");
  }

  function isGooglevideo(url) {
    return /^https:\/\/[a-z0-9.-]+\.googlevideo\.com\//i.test(url);
  }

  function fail(id, message) {
    send({ id: id, type: "error", message: message });
  }

  function fetchRange(m) {
    var id = m.id;
    var prev = active[id];
    if (prev) prev.abort();
    if (!isGooglevideo(m.url || "")) {
      fail(id, "не googlevideo-адрес");
      return;
    }
    var offset = m.offset | 0;
    var length = m.length | 0;
    if (!(length > 0)) {
      fail(id, "пустой диапазон");
      return;
    }
    var controller = new AbortController();
    active[id] = controller;
    // закрытый диапазон обязателен: открытый «bytes=N-» и GET без Range
    // googlevideo отбивает 403 (пробы 12.11.2026, карточка 122)
    fetch(m.url, {
      headers: { Range: "bytes=" + offset + "-" + (offset + length - 1) },
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
    })
      .then(function (resp) {
        if (active[id] !== controller) return;
        delete active[id];
        if (resp.status !== 206) {
          // тело ошибки короткое и читается (ACAO googlevideo разрешает
          // youtube-origin) — код/причина видны в сообщении
          return resp
            .text()
            .then(function (t) {
              fail(id, "HTTP " + resp.status + (t ? " · " + String(t).replace(/\s+/g, " ").slice(0, 140) : ""));
            })
            .catch(function () {
              fail(id, "HTTP " + resp.status);
            });
        }
        return resp.arrayBuffer().then(function (buf) {
          var msg = { tag: TAG, id: id, type: "data", buf: buf };
          // буфер переносится без копии (detach на отправителе)
          window.parent.postMessage(msg, "*", [buf]);
        });
      })
      .catch(function (err) {
        if (active[id] !== controller) return;
        delete active[id];
        fail(id, String((err && err.message) || err));
      });
  }

  window.addEventListener("message", function (e) {
    if (e.source !== window.parent) return;
    var m = e.data;
    if (!m || typeof m !== "object" || m.tag !== TAG) return;
    if (m.cmd === "ping") {
      send({ type: "pong", proto: 2 });
      return;
    }
    if (m.cmd === "diag") {
      diag();
      return;
    }
    if (m.cmd === "cancel") {
      var c = active[m.id];
      if (c) {
        c.abort();
        delete active[m.id];
      }
      return;
    }
    if (m.cmd === "range") fetchRange(m);
  });
})();
