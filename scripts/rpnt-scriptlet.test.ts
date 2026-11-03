// @vitest-environment happy-dom
// Юнит-тест инжекции rpnt (карточка duopulse-069, критерий «rpnt исполняется
// в раннем doc-start-канале: текст узла перезаписан до скриптов страницы»).
// Исполняем ДОБАВЛЕННЫЙ в набор ресурс (scripts/rpnt-scriptlet.js — тот же
// код, что конвертер кладёт в scriptlets-resources.json) прямым eval в
// глобальном контексте — как это делает content/cosmetic.js
// (runScriptletsDirect, doc-start eval до инлайн-скриптов страницы) — и
// проверяем перезапись текстовых узлов, появляющихся ПОЗЖЕ вызова (парсер
// страницы доходит до них уже с установленным observer'ом).
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const src = readFileSync(path.resolve(process.cwd(), "scripts", "rpnt-scriptlet.js"), "utf8");
const code = src.slice(Math.max(0, src.indexOf("function trustedReplaceNodeText(")));
// косвенный eval — определения попадают в глобальный контекст документа
(0, eval)(code);
const rpnt = (globalThis as unknown as {
  trustedReplaceNodeText: (...args: string[]) => void;
}).trustedReplaceNodeText;

/** Мутации happy-dom доезжают асинхронно — ждём observer-тик. */
const settle = () => new Promise<void>((r) => setTimeout(r, 30));

beforeAll(() => {
  // ранний doc-start-канал исполняет скриптлеты при readyState='loading'
  // (до DOMContentLoaded, до инлайн-скриптов страницы); happy-dom стартует
  // с 'complete' — по uBO-семантике rpnt тогда завершается сразу
  Object.defineProperty(document, "readyState", { get: () => "loading", configurable: true });
});

/** Паттерн живого правила serverContract из uBO quick-fixes (мини-замена). */
const LIVE_PATTERN = "/(\\(function serverContract\\(\\)|^if \\(window\\.ytcsi)/";

describe("rpnt (trusted-replace-node-text, duopulse-069)", () => {
  it("перезаписывает script-узел, появившийся ПОСЛЕ вызова (doc-start), с $1 и sedCount", async () => {
    // doc-start: целевых узлов ещё нет — вызов до «инлайн-скриптов страницы»
    rpnt(
      "script",
      LIVE_PATTERN,
      "PRELUDE;$1",
      "sedCount",
      "1",
      "excludes",
      "MutationObserver",
      "condition",
      "/serverContract|js_ld/",
    );

    const el = document.createElement("script");
    el.textContent = "(function serverContract(){var a=1;})();";
    document.head.appendChild(el);

    const untouched = document.createElement("script");
    untouched.textContent = "yt.setConfig({});";
    document.head.appendChild(untouched);

    await settle();
    // замена: $1 вернул найденный кусок, остальной текст не тронут
    expect(el.textContent).toBe("PRELUDE;(function serverContract(){var a=1;})();");
    expect(untouched.textContent).toBe("yt.setConfig({});");

    // sedCount=1: второе вхождение (новый узел с тем же текстом) не заменяется
    const second = document.createElement("script");
    second.textContent = "(function serverContract(){var b=2;})();";
    document.head.appendChild(second);
    await settle();
    expect(second.textContent).toBe("(function serverContract(){var b=2;})();");
  });

  it("excludes пропускает узлы с подстрокой-исключением (literal-паттерн)", async () => {
    rpnt("script", "window.foo()", "window.foo = function(){};", "excludes", "MutationObserver");
    const el = document.createElement("script");
    el.textContent = "window.foo(); new MutationObserver(function(){});";
    document.head.appendChild(el);
    const clean = document.createElement("script");
    clean.textContent = "window.foo();";
    document.head.appendChild(clean);
    await settle();
    expect(el.textContent).toBe("window.foo(); new MutationObserver(function(){});");
    expect(clean.textContent).toBe("window.foo = function(){};;");
  });

  it("#text: перезапись текстовых узлов (selector-режим uBO)", async () => {
    rpnt("#text", "/^Реклама$/", "—");
    const div = document.createElement("div");
    div.textContent = "Реклама";
    document.body.appendChild(div);
    await settle();
    expect(div.textContent).toBe("—");
  });

  it("script-замена идёт через Trusted Types-политику (youtube-случай)", async () => {
    const wrapped: string[] = [];
    (globalThis as { trustedTypes?: unknown }).trustedTypes = {
      createPolicy: (_name: string, rules: { createScript: (s: string) => string }) => ({
        createScript: (s: string) => {
          wrapped.push(s);
          return rules.createScript(s);
        },
      }),
    };
    try {
      rpnt("script", "aa", "bb");
      const el = document.createElement("script");
      el.textContent = "xxaazz";
      document.head.appendChild(el);
      await settle();
      expect(wrapped.length).toBe(1);
      expect(wrapped[0]).toBe("xxbbzz");
      expect(el.textContent).toBe("xxbbzz");
    } finally {
      delete (globalThis as { trustedTypes?: unknown }).trustedTypes;
    }
  });
});
