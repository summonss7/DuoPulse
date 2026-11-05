// DuoPulse — собственный порт uBO trusted-prevent-dom-bypass, карточка
// duopulse-075 (шаг 3 ансамбля quick-fixes против SSAI-преролла YouTube).
// Скриптлета нет ни в adblock-rs, ни в ресурсном наборе @adguard/scriptlets
// 2.5.1 — этот исходник подключается конвертером
// scripts/build-adblock-resources.mjs как ДОПОЛНИТЕЛЬНЫЙ ресурс.
//
// Назначение (uBO ≥1.60.1b4): страница уходит от патчей скриптлетов,
// создавая анонимный встроенный контекст (about:blank iframe) — его
// fetch/Request/… нативны, и перехват ответов на YouTube обходится мимо
// наших прокси. Скриптлет перехватывает DOM-метод (аргументы — HTMLElement)
// и встроенному контексту делегируется родительский (пропатченный) метод
// либо контекст целиком.
//
// Канон — uBO master 05.11.2026 (релиз 1.75.4):
//   src/js/resources/scriptlets.js  (trustedPreventDomBypass)
//   src/js/resources/proxy-apply.js (proxyApplyFn)
// Порт кода uBO — дословный (safe-Self: логгер uBO не нужен, заглушка;
// context.reflect/пул контекстов — как в uBO). Исполняется в раннем
// doc-start-канале cosmetic.js — до инлайн-скриптов страницы.
function trustedPreventDOMBypass() {
  return trustedPreventDOMBypass$dp(
    { name: "trusted-prevent-dom-bypass", engine: "duopulse", verbose: false },
    [].slice.call(arguments),
  );
}
function trustedPreventDOMBypass$dp(source, args) {
  var methodPath = args.length > 0 ? String(args[0]) : "";
  var targetProp = args.length > 1 ? String(args[1]) : "";
  if (methodPath === "") return;

  // --- safe-Self (минимум, что трогает trustedPreventDOMBypass uBO): uboLog —
  // no-op, логгер выключен
  var uboLog = function () {};

  // --- uBO src/js/resources/proxy-apply.js (proxyApplyFn) — дословный порт
  // (контекст-пул и proxy-tostring включены)
  function proxyApplyFn(target, handler) {
    var context = globalThis;
    var prop = target;
    for (;;) {
      var pos = prop.indexOf(".");
      if (pos === -1) break;
      context = context[prop.slice(0, pos)];
      if (context instanceof Object === false) return;
      prop = prop.slice(pos + 1);
    }
    var fn = context[prop];
    if (typeof fn !== "function") return;
    if (proxyApplyFn.CtorContext === undefined) {
      proxyApplyFn.ctorContexts = [];
      // eslint-disable-next-line no-inner-declarations
      proxyApplyFn.CtorContext = class {
        constructor(...args2) {
          this.init(...args2);
        }
        init(callFn, callArgs) {
          this.callFn = callFn;
          this.callArgs = callArgs;
          return this;
        }
        reflect() {
          var r = Reflect.construct(this.callFn, this.callArgs);
          this.callFn = this.callArgs = this.private = undefined;
          proxyApplyFn.ctorContexts.push(this);
          return r;
        }
        static factory(...args2) {
          return proxyApplyFn.ctorContexts.length !== 0
            ? proxyApplyFn.ctorContexts.pop().init(...args2)
            : new proxyApplyFn.CtorContext(...args2);
        }
      };
      proxyApplyFn.applyContexts = [];
      proxyApplyFn.ApplyContext = class {
        constructor(...args2) {
          this.init(...args2);
        }
        init(callFn, thisArg, callArgs) {
          this.callFn = callFn;
          this.thisArg = thisArg;
          this.callArgs = callArgs;
          return this;
        }
        reflect() {
          var r = Reflect.apply(this.callFn, this.thisArg, this.callArgs);
          this.callFn = this.thisArg = this.callArgs = this.private = undefined;
          proxyApplyFn.applyContexts.push(this);
          return r;
        }
        static factory(...args2) {
          return proxyApplyFn.applyContexts.length !== 0
            ? proxyApplyFn.applyContexts.pop().init(...args2)
            : new proxyApplyFn.ApplyContext(...args2);
        }
      };
      proxyApplyFn.isCtor = new Map();
      proxyApplyFn.proxies = new WeakMap();
      proxyApplyFn.nativeToString = Function.prototype.toString;
      var proxiedToString = new Proxy(Function.prototype.toString, {
        apply(_target, thisArg) {
          var proxied = thisArg;
          for (;;) {
            var fn2 = proxyApplyFn.proxies.get(proxied);
            if (fn2 === undefined) break;
            proxied = fn2;
          }
          return proxyApplyFn.nativeToString.call(proxied);
        },
      });
      proxyApplyFn.proxies.set(proxiedToString, proxyApplyFn.nativeToString);
      Function.prototype.toString = proxiedToString;
    }
    if (proxyApplyFn.isCtor.has(target) === false) {
      proxyApplyFn.isCtor.set(target, fn.prototype && fn.prototype.constructor === fn);
    }
    var proxyDetails = {
      apply(target2, thisArg, args2) {
        return handler(proxyApplyFn.ApplyContext.factory(target2, thisArg, args2));
      },
    };
    if (proxyApplyFn.isCtor.get(target)) {
      proxyDetails.construct = function (target2, args2) {
        return handler(proxyApplyFn.CtorContext.factory(target2, args2));
      };
    }
    var proxiedTarget = new Proxy(fn, proxyDetails);
    proxyApplyFn.proxies.set(proxiedTarget, fn);
    context[prop] = proxiedTarget;
  }

  // --- uBO trustedPreventDOMBypass — дословный порт ---
  proxyApplyFn(methodPath, function (context) {
    var elems = new Set(context.callArgs.filter(function (e) { return e instanceof HTMLElement; }));
    var r = context.reflect();
    if (elems.length === 0) return r;
    for (var elem of elems) {
      try {
        if (String(elem.contentWindow) !== "[object Window]") continue;
        if (elem.contentWindow.location.href !== "about:blank") {
          if (elem.contentWindow.location.href !== self.location.href) {
            continue;
          }
        }
        if (targetProp !== "") {
          var chains = targetProp.split(/\s+/);
          var me = self;
          var it = elem.contentWindow;
          for (var chain of chains) {
            for (;;) {
              var pos = chain.indexOf(".");
              if (pos === -1) break;
              var prop2 = chain.slice(0, pos);
              me = me[prop2];
              it = it[prop2];
              chain = chain.slice(pos + 1);
            }
            it[chain] = me[chain];
          }
        } else {
          Object.defineProperty(elem, "contentWindow", { value: self });
        }
        uboLog("trusted-prevent-dom-bypass: bypass prevented");
      } catch (e) {
        /* не наш элемент — пропускаем, как в uBO */
      }
    }
    return r;
  });
}
