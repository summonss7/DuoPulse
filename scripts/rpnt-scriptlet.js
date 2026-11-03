// DuoPulse — собственный порт uBO trusted-replace-node-text (rpnt), карточка
// duopulse-069. AdGuard-версия из пакета @adguard/scriptlets НЕсовместима с
// uBO-порядком аргументов (у AdGuard лишний textMatch перед pattern) и не
// знает токены sedCount/excludes/condition/stay — живые правила uBO
// quick-fixes/filters.txt через неё ломаются молча. Этот исходник подключается
// конвертером scripts/build-adblock-resources.mjs вместо пакетной реализации
// (имя каноническое — правила с полным именем работают тоже).
//
// Семантика — по uBO wiki Resources-Library:
//   (nodeName|#text|CSS-селектор, pattern(строка|/regex/flags), replacement
//    [, 'condition',X, 'includes',X, 'excludes',X, 'sedCount',N,
//     'stay',1, 'quitAfter',ms])
// Замена — String.replace-семантика ($1..$9 работают); sedCount ограничивает
// число замен (0 = без лимита); по умолчанию observer живёт до DOMContentLoaded
// (stay,1 — бессрочно). Исполняется в раннем doc-start-канале cosmetic.js:
// до инлайн-скриптов страницы, поэтому documentElement может ещё не быть —
// наблюдаем document (появление <html> — childList-мутация документа).
function trustedReplaceNodeText() {
  return trustedReplaceNodeText$dp(
    { name: "trusted-replace-node-text", engine: "duopulse", verbose: false },
    [].slice.call(arguments),
  );
}
function trustedReplaceNodeText$dp(source, args) {
  var NODE_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;
  var argc = args.length;
  if (argc < 2 || String(args[0]) === "" || String(args[1]) === "") return;

  var nodeSpec = String(args[0]);
  var pattern = String(args[1]);
  var replacement = argc > 2 ? String(args[2]) : "";
  var includes = null,
    excludes = null,
    sedCount = 0,
    stay = false,
    quitAfter = 0;

  var i = 3;
  while (i < argc) {
    var k = String(args[i]);
    var v = i + 1 < argc ? args[i + 1] : null;
    if (k === "condition" || k === "includes") {
      includes = v;
      i += 2;
    } else if (k === "excludes") {
      excludes = v;
      i += 2;
    } else if (k === "sedCount") {
      sedCount = parseInt(v, 10) || 0;
      i += 2;
    } else if (k === "stay") {
      stay = String(v) === "1";
      i += 2;
    } else if (k === "quitAfter") {
      quitAfter = parseInt(v, 10) || 0;
      i += 2;
    } else {
      i += 1; // 'log' и неизвестные токены — мимо
    }
  }

  function toRe(s) {
    s = String(s == null ? "" : s);
    if (s.length > 1 && s.charAt(0) === "/") {
      var last = s.lastIndexOf("/");
      if (last > 0) {
        try {
          return new RegExp(s.slice(1, last), s.slice(last + 1).replace(/[^gimsuy]/g, ""));
        } catch (e) {
          return null;
        }
      }
    }
    return null;
  }
  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  function matcher(tok) {
    // условие-токен: /regex/ или подстрока
    var re = tok != null ? toRe(tok) : null;
    if (re) return re;
    var lit = String(tok == null ? "" : tok);
    return {
      test: function (s) {
        return lit !== "" && s.indexOf(lit) !== -1;
      },
    };
  }

  var reFind = toRe(pattern);
  var literal = !reFind;
  if (literal) reFind = new RegExp(escapeRe(pattern), "g");
  var reCond = includes != null ? matcher(includes) : null;
  var reExcl = excludes != null ? matcher(excludes) : null;
  var limit = sedCount > 0 ? sedCount : Infinity;

  var sedDone = 0;

  function sed(text) {
    if (sedDone >= limit) return text;
    if (reCond && !reCond.test(text)) return text;
    if (reExcl && reExcl.test(text)) return text;
    var flags = reFind.flags.indexOf("g") >= 0 ? reFind.flags : reFind.flags + "g";
    var reG = new RegExp(reFind.source, flags);
    var out;
    if (replacement.indexOf("$") < 0) {
      out = text.replace(reG, function (m) {
        if (sedDone >= limit) return m;
        sedDone++;
        return replacement;
      });
    } else {
      // $-подстановки ($1..): String.replace на каждом матче отдельно —
      // группы внутри матча видны, хвост матча не теряется
      var single = new RegExp(reFind.source, reFind.flags.replace("g", ""));
      var acc = "",
        pos = 0,
        m;
      reG.lastIndex = 0;
      while (sedDone < limit && (m = reG.exec(text)) !== null) {
        if (m[0] === "") {
          reG.lastIndex++;
          if (reG.lastIndex > text.length) break;
          continue;
        }
        acc += text.slice(pos, m.index) + m[0].replace(single, replacement);
        pos = m.index + m[0].length;
        sedDone++;
      }
      out = acc + text.slice(pos);
    }
    return out;
  }

  var isTextNodes = nodeSpec === "#text";
  var isTagName = !isTextNodes && NODE_NAME.test(nodeSpec);
  var selector = isTextNodes || isTagName ? nodeSpec : nodeSpec;

  // Trusted Types (youtube: require-trusted-types-for 'script'): присвоение
  // строки в textContent SCRIPT-узла бросает TypeError — замена обязана идти
  // через политику. Имя своё: duopulse-scriptlets уже занят косметикой
  // (cosmetic.js); createPolicy запрещена — остаёмся на строке (строгий
  // документ бросит — поймает catch ниже, как без порта).
  var ttPolicy = null;
  function ttWrap(node, text) {
    try {
      if (
        node.nodeName === "SCRIPT" &&
        typeof trustedTypes !== "undefined" &&
        trustedTypes.createPolicy
      ) {
        if (!ttPolicy) {
          ttPolicy = trustedTypes.createPolicy("duopulse-rpnt", {
            createScript: function (s) {
              return s;
            },
          });
        }
        return ttPolicy.createScript(text);
      }
    } catch (e) {
      return text;
    }
    return text;
  }

  function nodesIn(root) {
    var out = [];
    try {
      if (isTextNodes) {
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        var n;
        while ((n = walker.nextNode())) out.push(n);
      } else {
        var els = root.querySelectorAll(selector);
        for (var j = 0; j < els.length; j++) out.push(els[j]);
      }
    } catch (e) {
      /* битый селектор — тихо */
    }
    return out;
  }

  function handleNode(node) {
    var text = node.textContent;
    if (text === null || text === "") return;
    var updated = sed(text);
    if (updated !== text) {
      try {
        node.textContent = ttWrap(node, updated);
      } catch (e) {
        /* чужой/мёртвый узел или строгий Trusted Types */
      }
    }
  }

  function scan(root) {
    var list = nodesIn(root);
    for (var j = 0; j < list.length; j++) handleNode(list[j]);
  }

  if (document.documentElement) scan(document);

  var mo = null;
  try {
    mo = new MutationObserver(function (muts) {
      for (var j = 0; j < muts.length; j++) {
        var added = muts[j].addedNodes;
        for (var q = 0; q < added.length; q++) {
          var n = added[q];
          if (n.nodeType === 1) {
            // сам элемент и его поддерево (парсер вставляет целые куски)
            if (matchesSpec(n)) handleNode(n);
            scan(n);
          } else if (n.nodeType === 3 && isTextNodes) {
            handleNode(n);
          }
        }
      }
    });
    function matchesSpec(el) {
      if (isTextNodes) return false;
      if (isTagName) return el.nodeName === nodeSpec.toUpperCase();
      try {
        return el.matches(selector);
      } catch (e) {
        return false;
      }
    }
    mo.observe(document.documentElement || document, { childList: true, subtree: true });
  } catch (e) {
    mo = null;
  }

  function stop() {
    if (mo) {
      try {
        mo.disconnect();
      } catch (e) {}
    }
  }
  if (!stay) {
    if (document.readyState === "loading") {
      document.addEventListener(
        "DOMContentLoaded",
        function () {
          if (quitAfter > 0) setTimeout(stop, quitAfter);
          else stop();
        },
        { once: true },
      );
    } else if (quitAfter > 0) {
      setTimeout(stop, quitAfter);
    } else {
      stop();
    }
  }
}
