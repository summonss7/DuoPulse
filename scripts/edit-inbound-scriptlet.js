// DuoPulse — собственный порт uBO trusted-edit-inbound-object, карточка
// duopulse-072 (шаг 2 ансамбля quick-fixes против SSAI-преролла YouTube).
// Скриптлета нет ни в adblock-rs, ни в ресурсном наборе @adguard/scriptlets
// 2.5.1 (только trusted-prune-inbound-object) — этот исходник подключается
// конвертером scripts/build-adblock-resources.mjs как ДОПОЛНИТЕЛЬНЫЙ ресурс
// (не замена пакетного).
//
// Канон — релиз uBO 1.75.4 (текущий стабильный, 03.11.2026):
//   src/js/resources/json-edit.js (editInboundObjectFn + сигнатура)
//   src/js/jsonpath.js            (класс JSONPath — uBO-flavored, v2)
//   src/js/resources/proxy-apply.js (proxyApplyFn)
// Сигнатура: (propChain, argPos, jsonq) — ровно форма живых правил uBO
// quick-fixes (аттестация player-запросов при патченном UA):
//   ##+js(trusted-edit-inbound-object, JSON.stringify, 0,
//         [?.attestationRequest][?.context.client.userAgent*="channel"]
//           .context.client[?.clientName=="WEB"]+={"clientScreen":"CHANNEL"})
// jsonq — uBO-flavored JSONPath: фильтры [?.path op value] (==,!=,<,<=,>,>=,
// ^=,$=,*=,=/re/), [?!.path] — негативный, потомки .., [*]; редактор в хвосте:
// =JSON (присвоение), +=JSON (слияние объектов/добавление в массив),
// =repl({"regex":…,"replacement":…}), "${now}" — подстановка Date.now().
// Порт кода uBO — дословный (кроме safe-Self: логгер uBO нам не нужен,
// заглушка); дословность проверяется тестом против живых правил.
//
// Исполняется в раннем doc-start-канале cosmetic.js — до инлайн-скриптов
// страницы, поэтому прокси JSON.stringify стоит до первого вызова плеером.
function trustedEditInboundObject() {
  return trustedEditInboundObject$dp(
    { name: "trusted-edit-inbound-object", engine: "duopulse", verbose: false },
    [].slice.call(arguments),
  );
}
function trustedEditInboundObject$dp(source, args) {
  // --- safe-Self (минимум, что трогает editInboundObjectFn uBO): логгер
  // выключен (logLevel 0), uboLog — no-op; клоны — JSON-раундтрип, как в uBO.
  const safe = {
    JSON_parse: JSON.parse,
    JSON_stringify: JSON.stringify,
    logLevel: 0,
    makeLogPrefix: function () {
      return "";
    },
    uboLog: function () {},
  };

  // --- uBO 1.75.4 src/js/jsonpath.js (класс JSONPath) — дословный порт ---
  class JSONPath {
    static create(query) {
      const jsonp = new JSONPath();
      jsonp.compile(query);
      return jsonp;
    }
    static toJSON(obj, stringifier, ...args) {
      return (stringifier || JSON.stringify)(obj, ...args).replace(/\//g, "\\/");
    }
    static keys = Object.keys;
    static entries = Object.entries;
    static hasOwn = Object.hasOwn;
    static Regex = RegExp;
    get value() {
      return this.#compiled && this.#compiled.rval;
    }
    set value(v) {
      if (this.#compiled === undefined) {
        return;
      }
      this.#compiled.rval = v;
    }
    get valid() {
      return this.#compiled !== undefined;
    }
    compile(query) {
      this.#compiled = undefined;
      this.v2 = query.startsWith("v2:");
      if (this.v2) {
        query = query.slice(3);
      }
      const r = this.#compile(query, 0);
      if (r === undefined) {
        return;
      }
      if (r.i !== query.length) {
        let val;
        if (query.startsWith("=", r.i)) {
          const match = this.#reRval.exec(query.slice(r.i));
          if (match) {
            r.modify = match[1];
            val = match[2];
          } else {
            val = query.slice(r.i + 1);
          }
        } else if (query.startsWith("+=", r.i)) {
          r.modify = "+";
          val = query.slice(r.i + 2);
        }
        try {
          r.rval = JSON.parse(val);
        } catch {
          return;
        }
      }
      r.v2 = this.v2;
      this.#compiled = r;
    }
    evaluate(root) {
      if (this.valid === false) {
        return [];
      }
      this.#root = { $: root };
      const paths = this.#evaluate(this.#compiled.steps, []);
      this.#root = null;
      return paths;
    }
    apply(root) {
      if (this.valid === false) {
        return;
      }
      const { rval } = this.#compiled;
      this.#root = { $: root };
      const paths = this.#evaluate(this.#compiled.steps, []);
      let i = paths.length;
      if (i === 0) {
        this.#root = null;
        return;
      }
      while (i--) {
        const { obj, key } = this.#resolvePath(paths[i]);
        if (obj === undefined) {
          continue;
        }
        if (rval !== undefined) {
          this.#modifyVal(obj, key);
        } else if (Array.isArray(obj) && typeof key === "number") {
          obj.splice(key, 1);
        } else {
          delete obj[key];
        }
      }
      const result = this.#root["$"] ?? null;
      this.#root = null;
      return result;
    }
    dump() {
      return JSON.stringify(this.#compiled);
    }
    toJSON(obj, ...args) {
      return JSONPath.toJSON(obj, null, ...args);
    }
    get [Symbol.toStringTag]() {
      return "JSONPath";
    }
    #UNDEFINED = 0;
    #ROOT = 1;
    #CURRENT = 2;
    #CHILDREN = 3;
    #DESCENDANTS = 4;
    #QUANTIFIER = 5;
    #reUnquotedIdentifier = /^[A-Za-z_][\w]*|^\*/;
    #reExpr = /^\s*([!=^$*]=|[<>]=?)\s*(.+?)\]/;
    #reIndice = /^-?\d+/;
    #reRval = /^=([a-z]+)\((.+)\)$/;
    #reQuantifier = /^\{(\d+|\d+,\d+|\d+,|,\d+)\};\$/;
    #root;
    #compiled;
    #compile(query, i) {
      if (query.length === 0) {
        return;
      }
      const steps = [];
      let c = query.charCodeAt(i);
      if (c === 0x24 /* $ */) {
        steps.push({ mv: this.#ROOT });
        i += 1;
      } else if (c === 0x40 /* @ */) {
        steps.push({ mv: this.#CURRENT });
        i += 1;
      } else {
        steps.push({ mv: i === 0 ? this.#ROOT : this.#CURRENT });
      }
      let mv = this.#UNDEFINED;
      for (;;) {
        if (i === query.length) {
          break;
        }
        c = query.charCodeAt(i);
        if (c === 0x20 /* whitespace */) {
          i += 1;
          continue;
        }
        // Dot accessor syntax
        if (c === 0x2e /* . */) {
          if (mv !== this.#UNDEFINED) {
            return;
          }
          if (query.startsWith("..", i)) {
            mv = this.#DESCENDANTS;
            i += 2;
          } else {
            mv = this.#CHILDREN;
            i += 1;
          }
          continue;
        }
        if (c === 0x3b /* ; */) {
          if (query.startsWith(";$", i) === false) {
            return;
          }
          steps.push({ mv: this.#QUANTIFIER, min: 1, max: 1e6 }, { mv: this.#ROOT });
          i += 2;
          mv = this.#UNDEFINED;
          continue;
        }
        if (c === 0x7b /* { */) {
          const match = this.#reQuantifier.exec(query.slice(i));
          if (match === null) {
            return;
          }
          const comma = match[1].indexOf(",");
          let min, max;
          if (comma === -1) {
            min = max = parseInt(match[1]);
          } else {
            min = parseInt(match[1].slice(0, comma)) || 0;
            max = parseInt(match[1].slice(comma + 1)) || 1e6;
          }
          steps.push({ mv: this.#QUANTIFIER, min, max }, { mv: this.#ROOT });
          i += match[0].length;
          mv = this.#UNDEFINED;
          continue;
        }
        if (c !== 0x5b /* [ */) {
          if (mv === this.#UNDEFINED) {
            const step = steps.at(-1);
            if (step === undefined) {
              return;
            }
            const j = this.#compileExpr(query, step, i);
            if (j) {
              i = j;
            }
            break;
          }
          const r = this.#consumeUnquotedIdentifier(query, i);
          if (r === undefined) {
            return;
          }
          steps.push({ mv, k: r.s });
          i = r.i;
          mv = this.#UNDEFINED;
          continue;
        }
        // Bracket accessor syntax
        if (mv === this.#CHILDREN) {
          return;
        }
        if (query.startsWith("[?", i)) {
          const not = query.charCodeAt(i + 2) === 0x21 /* ! */ ? 1 : 0;
          const j = i + 2 + not;
          const r = this.#compile(query, j);
          if (r === undefined) {
            return;
          }
          if (query.startsWith("]", r.i) === false) {
            return;
          }
          if (not) {
            r.steps.at(-1).not = true;
          }
          steps.push({ mv: mv || this.#CHILDREN, steps: r.steps });
          i = r.i + 1;
          mv = this.#UNDEFINED;
          continue;
        }
        if (query.startsWith("[*]", i)) {
          mv ||= this.#CHILDREN;
          steps.push({ mv, k: "*" });
          i += 3;
          mv = this.#UNDEFINED;
          continue;
        }
        const r = this.#consumeIdentifier(query, i + 1);
        if (r === undefined) {
          return;
        }
        mv ||= this.#CHILDREN;
        steps.push({ mv, k: r.s });
        i = r.i + 1;
        mv = this.#UNDEFINED;
      }
      if (steps.length === 0) {
        return;
      }
      if (mv !== this.#UNDEFINED) {
        return;
      }
      return { steps, i };
    }
    #evaluate(steps, pathin) {
      let resultset = [];
      if (Array.isArray(steps) === false) {
        return resultset;
      }
      for (const step of steps) {
        switch (step.mv) {
          case this.#ROOT:
            resultset = [["$"]];
            break;
          case this.#CURRENT:
            if (step.op) {
              const { obj, key } = this.#resolvePath(pathin);
              if (obj === undefined) {
                return [];
              }
              const outcome = this.#evaluateExpr(step, obj, key);
              if (outcome !== true) {
                break;
              }
            }
            resultset = [pathin];
            break;
          case this.#CHILDREN:
          case this.#DESCENDANTS: {
            if (resultset.length === 0) {
              break;
            }
            resultset = this.#getMatches(resultset, step);
            break;
          }
          case this.#QUANTIFIER: {
            const { length } = resultset;
            if (length < step.min || length > step.max) {
              return [];
            }
            resultset = [];
            break;
          }
          default:
            break;
        }
      }
      return resultset;
    }
    #getMatches(listin, step) {
      const listout = [];
      for (const pathin of listin) {
        const { value: owner } = this.#resolvePath(pathin);
        if (owner === undefined) {
          continue;
        }
        if (step.steps) {
          this.#getMatchesFromExpr(pathin, step, owner, listout);
          continue;
        }
        const iter = this.#expandKey(owner, step.k);
        if (iter) {
          for (const k of iter) {
            const outcome = this.#evaluateExpr(step, owner, k);
            if (outcome !== true) {
              continue;
            }
            listout.push([...pathin, k]);
          }
        }
        if (step.mv !== this.#DESCENDANTS) {
          continue;
        }
        for (const { obj, key, path } of this.#getDescendants(owner, true)) {
          const iter = this.#expandKey(obj[key], step.k);
          if (iter === undefined) {
            continue;
          }
          for (const k of iter) {
            const outcome = this.#evaluateExpr(step, obj[key], k);
            if (outcome !== true) {
              continue;
            }
            listout.push([...pathin, ...path, k]);
          }
        }
      }
      return listout;
    }
    #expandKey(owner, k) {
      if (typeof owner !== "object" || owner === null) {
        return;
      }
      if (Array.isArray(k)) {
        const out = [];
        for (const a of k) {
          const iter = this.#expandKey(owner, a);
          if (iter === undefined) {
            continue;
          }
          out.push(...iter);
        }
        return out;
      }
      if (typeof k === "number") {
        if (Array.isArray(owner) === false) {
          return;
        }
        return [k >= 0 ? k : owner.length + k];
      }
      if (k === "*") {
        if (Array.isArray(owner)) {
          return owner.keys();
        }
        return JSONPath.keys(owner);
      }
      if (k instanceof JSONPath.Regex) {
        const out = [];
        for (const key of JSONPath.keys(owner)) {
          if (k.test(key) === false) {
            continue;
          }
          out.push(key);
        }
        return out;
      }
      return [k];
    }
    #getMatchesFromExpr(pathin, step, owner, out) {
      const recursive = step.mv === this.#DESCENDANTS;
      const v2 = this.#compiled.v2 || recursive || Array.isArray(owner);
      for (const { path } of this.#getDescendants(owner, recursive)) {
        const q = v2 ? [...pathin, ...path] : pathin;
        const r = this.#evaluate(step.steps, q);
        if (Boolean(r?.length) === false) {
          continue;
        }
        out.push(q);
        if (v2 === false) {
          break;
        }
      }
    }
    #getDescendants(v, recursive) {
      const iterator = {
        next() {
          const n = this.stack.length;
          if (n === 0) {
            this.value = undefined;
            this.done = true;
            return this;
          }
          const details = this.stack[n - 1];
          const entry = details.keys.next();
          if (entry.done) {
            this.stack.pop();
            this.path.pop();
            return this.next();
          }
          this.path[n - 1] = entry.value;
          this.value = {
            obj: details.obj,
            key: entry.value,
            path: this.path.slice(),
          };
          const v = this.value.obj[this.value.key];
          if (recursive) {
            if (Array.isArray(v)) {
              this.stack.push({ obj: v, keys: v.keys() });
            } else if (typeof v === "object" && v !== null) {
              this.stack.push({ obj: v, keys: JSONPath.keys(v).values() });
            }
          }
          return this;
        },
        path: [],
        value: undefined,
        done: false,
        stack: [],
        [Symbol.iterator]() {
          return this;
        },
      };
      if (Array.isArray(v)) {
        iterator.stack.push({ obj: v, keys: v.keys() });
      } else if (typeof v === "object" && v !== null) {
        iterator.stack.push({ obj: v, keys: JSONPath.keys(v).values() });
      }
      return iterator;
    }
    #consumeIdentifier(query, i) {
      const keys = [];
      let needIdentifier = true;
      while (i < query.length) {
        const c0 = query.charCodeAt(i);
        if (c0 === 0x5d /* ] */) {
          break;
        }
        if (c0 === 0x20 /* SPACE */) {
          i += 1;
          continue;
        }
        if (c0 === 0x2c /* , */) {
          if (needIdentifier) {
            return;
          }
          i += 1;
          needIdentifier = true;
          continue;
        }
        if (c0 === 0x22 /* " */ || c0 === 0x27 /* ' */) {
          const r = this.#untilChar(query, c0, i + 1);
          if (r === undefined) {
            return;
          }
          keys.push(r.s);
          i = r.i;
          needIdentifier = false;
          continue;
        }
        if (c0 === 0x2d /* - */ || (c0 >= 0x30 && c0 <= 0x39)) {
          const match = this.#reIndice.exec(query.slice(i));
          if (match === null) {
            return;
          }
          const indice = parseInt(query.slice(i), 10);
          keys.push(indice);
          i += match[0].length;
          needIdentifier = false;
          continue;
        }
        if (this.v2) {
          return;
        }
        const r = this.#consumeUnquotedIdentifier(query, i);
        if (r === undefined) {
          return;
        }
        keys.push(r.s);
        i = r.i;
      }
      if (needIdentifier) {
        return;
      }
      return { s: keys.length === 1 ? keys[0] : keys, i };
    }
    #consumeUnquotedIdentifier(query, i) {
      if (query.charCodeAt(i) === 0x2f /* / */) {
        const r = this.#untilChar(query, 0x2f, i + 1);
        if (r === undefined) {
          return;
        }
        let re;
        try {
          re = new JSONPath.Regex(r.s);
        } catch {
          return;
        }
        return { s: re, i: r.i };
      }
      const match = this.#reUnquotedIdentifier.exec(query.slice(i));
      if (match === null) {
        return;
      }
      return { s: match[0], i: i + match[0].length };
    }
    #untilChar(query, targetCharCode, i) {
      const len = query.length;
      const parts = [];
      let beg = i,
        end = i;
      for (;;) {
        if (end === len) {
          return;
        }
        const c = query.charCodeAt(end);
        if (c === targetCharCode) {
          parts.push(query.slice(beg, end));
          end += 1;
          break;
        }
        if (c === 0x5c /* \ */ && end + 1 < len) {
          const d = query.charCodeAt(end + 1);
          if (d === targetCharCode) {
            parts.push(query.slice(beg, end));
            end += 1;
            beg = end;
          }
        }
        end += 1;
      }
      return { s: parts.join(""), i: end };
    }
    #compileExpr(query, step, i) {
      if (query.startsWith("=/", i)) {
        const r = this.#untilChar(query, 0x2f /* / */, i + 2);
        if (r === undefined) {
          return i;
        }
        const match = /^[i]/.exec(query.slice(r.i));
        try {
          step.rval = new JSONPath.Regex(r.s, (match && match[0]) || undefined);
        } catch {
          return;
        }
        step.op = "re";
        if (match) {
          r.i += match[0].length;
        }
        return r.i;
      }
      const match = this.#reExpr.exec(query.slice(i));
      if (match === null) {
        return;
      }
      const op = match[1],
        rval = match[2];
      if (rval.charCodeAt(0) === 0x27 /* ' */) {
        const r = this.#untilChar(rval, 0x27, 1);
        if (r === undefined) {
          return;
        }
        step.rval = r.s;
        step.op = op;
      } else {
        try {
          step.rval = JSON.parse(rval);
          step.op = op;
        } catch {
          return;
        }
      }
      return i + match[0].length - 1;
    }
    #resolvePath(path) {
      if (path.length === 0) {
        return { value: this.#root };
      }
      const key = path.at(-1);
      let obj = this.#root;
      for (let i = 0, n = path.length - 1; i < n; i++) {
        obj = obj[path[i]];
        if (obj instanceof Object === false) {
          return {};
        }
      }
      return { obj, key, value: obj[key] };
    }
    #evaluateExpr(step, owner, k) {
      if (owner === undefined || owner === null) {
        return;
      }
      const hasOwn = owner[k] !== undefined || JSONPath.hasOwn(owner, k);
      if (step.op !== undefined && hasOwn === false) {
        return;
      }
      const target = step.not !== true;
      const v = owner[k];
      switch (step.op) {
        case "==":
          return (v === step.rval) === target;
        case "!=":
          return (v !== step.rval) === target;
        case "<":
          return (v < step.rval) === target;
        case "<=":
          return (v <= step.rval) === target;
        case ">":
          return (v > step.rval) === target;
        case ">=":
          return (v >= step.rval) === target;
        case "^=":
          return `${v}`.startsWith(step.rval) === target;
        case "$=":
          return `${v}`.endsWith(step.rval) === target;
        case "*=":
          return `${v}`.includes(step.rval) === target;
        case "re":
          return step.rval.test(`${v}`);
        default:
          break;
      }
      return hasOwn === target;
    }
    #modifyVal(obj, key) {
      let { modify, rval } = this.#compiled;
      if (typeof rval === "string") {
        rval = rval.replace("${now}", `${Date.now()}`);
      }
      switch (modify) {
        case undefined:
          obj[key] = rval;
          break;
        case "+": {
          if (rval instanceof Object === false) {
            return;
          }
          const lval = obj[key];
          if (lval instanceof Object === false) {
            return;
          }
          if (Array.isArray(lval)) {
            return;
          }
          for (const [k, v] of JSONPath.entries(rval)) {
            lval[k] = v;
          }
          break;
        }
        case "call": {
          const entries = rval.slice();
          if (entries.length < 2) {
            break;
          }
          entries.forEach((a, i, aa) => {
            if (a === "${obj}") {
              aa[i] = obj;
            } else if (a === "${key}") {
              aa[i] = key;
            } else if (a === "${val}") {
              aa[i] = obj[key];
            }
          });
          const instance = entries[0] ?? self;
          instance[entries[1]](...entries.slice(2));
          break;
        }
        case "repl": {
          const lval = obj[key];
          if (typeof lval !== "string") {
            return;
          }
          if (this.#compiled.re === undefined) {
            this.#compiled.re = null;
            try {
              this.#compiled.re =
                rval.regex !== undefined
                  ? new JSONPath.Regex(rval.regex, rval.flags)
                  : new JSONPath.Regex(rval.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
            } catch {}
          }
          if (this.#compiled.re === null) {
            return;
          }
          obj[key] = lval.replace(this.#compiled.re, rval.replacement);
          break;
        }
        default:
          break;
      }
    }
  }

  // --- uBO 1.75.4 src/js/resources/proxy-apply.js — дословный порт ---
  function proxyApplyFn(target = "", handler = "", options = {}) {
    let context = globalThis;
    let prop = target;
    for (;;) {
      const pos = prop.indexOf(".");
      if (pos === -1) {
        break;
      }
      context = context[prop.slice(0, pos)];
      if (context instanceof Object === false) {
        return;
      }
      prop = prop.slice(pos + 1);
    }
    const fn = context[prop];
    if (typeof fn !== "function") {
      return;
    }
    if (proxyApplyFn.CtorContext === undefined) {
      proxyApplyFn.ctorContexts = [];
      proxyApplyFn.CtorContext = class {
        constructor(...args) {
          this.init(...args);
        }
        init(callFn, callArgs) {
          this.callFn = callFn;
          this.callArgs = callArgs;
          return this;
        }
        reflect() {
          const r = Reflect.construct(this.callFn, this.callArgs);
          this.callFn = this.callArgs = this.private = undefined;
          proxyApplyFn.ctorContexts.push(this);
          return r;
        }
        static factory(...args) {
          return proxyApplyFn.ctorContexts.length !== 0
            ? proxyApplyFn.ctorContexts.pop().init(...args)
            : new proxyApplyFn.CtorContext(...args);
        }
      };
      proxyApplyFn.applyContexts = [];
      proxyApplyFn.ApplyContext = class {
        constructor(...args) {
          this.init(...args);
        }
        init(callFn, thisArg, callArgs) {
          this.callFn = callFn;
          this.thisArg = thisArg;
          this.callArgs = callArgs;
          return this;
        }
        reflect() {
          const r = Reflect.apply(this.callFn, this.thisArg, this.callArgs);
          this.callFn = this.thisArg = this.callArgs = this.private = undefined;
          proxyApplyFn.applyContexts.push(this);
          return r;
        }
        static factory(...args) {
          return proxyApplyFn.applyContexts.length !== 0
            ? proxyApplyFn.applyContexts.pop().init(...args)
            : new proxyApplyFn.ApplyContext(...args);
        }
      };
      proxyApplyFn.isCtor = new Map();
      proxyApplyFn.proxies = new WeakMap();
      if ((options.skipToString || proxyApplyFn.skipToString) !== true) {
        proxyApplyFn.nativeToString = Function.prototype.toString;
        const proxiedToString = new Proxy(Function.prototype.toString, {
          apply(target, thisArg) {
            let proxied = thisArg;
            for (;;) {
              const fn = proxyApplyFn.proxies.get(proxied);
              if (fn === undefined) {
                break;
              }
              proxied = fn;
            }
            return proxyApplyFn.nativeToString.call(proxied);
          },
        });
        proxyApplyFn.proxies.set(proxiedToString, proxyApplyFn.nativeToString);
        Function.prototype.toString = proxiedToString;
      }
    }
    if (proxyApplyFn.isCtor.has(target) === false) {
      proxyApplyFn.isCtor.set(target, fn.prototype?.constructor === fn);
    }
    const proxyDetails = {
      apply(target, thisArg, args) {
        return handler(proxyApplyFn.ApplyContext.factory(target, thisArg, args));
      },
    };
    if (proxyApplyFn.isCtor.get(target)) {
      proxyDetails.construct = function (target, args) {
        return handler(proxyApplyFn.CtorContext.factory(target, args));
      };
    }
    const proxiedTarget = new Proxy(fn, proxyDetails);
    proxyApplyFn.proxies.set(proxiedTarget, fn);
    context[prop] = proxiedTarget;
  }

  // --- uBO 1.75.4 json-edit.js editInboundObjectFn(trusted=true) — дословно
  const propChain = String(args[0] == null ? "" : args[0]);
  const argPosRaw = String(args[1] == null ? "" : args[1]);
  const jsonq = String(args[2] == null ? "" : args[2]);
  if (propChain === "") {
    return;
  }
  const logPrefix = safe.makeLogPrefix("trusted-edit-inbound-object", propChain, jsonq);
  const jsonp = JSONPath.create(jsonq);
  // uBO: jsonp.value !== undefined && trusted !== true → отказ; мы всегда
  // trusted (permission:1 в ресурсном наборе — из недоверенных списков
  // скриптлет не инъецируется движком), остаются только ошибки разбора.
  if (jsonp.valid === false) {
    return safe.uboLog(logPrefix, "Bad JSONPath query");
  }
  const argPos = parseInt(argPosRaw, 10);
  if (isNaN(argPos)) {
    return;
  }
  const getArgPos = (args) => {
    if (Array.isArray(args) === false) {
      return;
    }
    if (argPos >= 0) {
      if (args.length <= argPos) {
        return;
      }
      return argPos;
    }
    if (args.length < -argPos) {
      return;
    }
    return args.length + argPos;
  };
  const editObj = (obj) => {
    let clone;
    try {
      clone = safe.JSON_parse(safe.JSON_stringify(obj));
    } catch {}
    if (typeof clone !== "object" || clone === null) {
      return;
    }
    const objAfter = jsonp.apply(clone);
    if (objAfter === undefined) {
      return;
    }
    safe.uboLog(logPrefix, "Edited");
    if (safe.logLevel > 1) {
      safe.uboLog(logPrefix, `After edit:\n${safe.JSON_stringify(objAfter, null, 2)}`);
    }
    return objAfter;
  };
  proxyApplyFn(propChain, function (context) {
    const i = getArgPos(context.callArgs);
    if (i !== undefined) {
      const obj = editObj(context.callArgs[i]);
      if (obj) {
        context.callArgs[i] = obj;
      }
    }
    return context.reflect();
  });
}
