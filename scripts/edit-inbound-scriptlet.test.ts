// @vitest-environment happy-dom
// Юнит-тесты порта trusted-edit-inbound-object (карточка duopulse-072,
// критерий «исполняется в doc-start-канале: редактирование входящего объекта
// по jsonPath, +=/=/repl, фильтры свойств»). Исполняем ДОБАВЛЕННЫЙ в набор
// ресурс (scripts/edit-inbound-scriptlet.js — тот же код, что конвертер
// кладёт в scriptlets-resources.json) прямым eval в глобальном контексте —
// как content/cosmetic.js (runScriptletsDirect, doc-start eval до
// инлайн-скриптов страницы). jsonq — БУКВАЛЬНЫЕ живые правила uBO quick-fixes
// (аттестация player-запросов, снапшот 04.11.2026; запятые уже расэкраниро-
// ваны — в фильтр-листе они несут `\,`, движок снимает его при парсинге).
//
// Семантика v1-JSONPath (сверено с оригиналом uBO 1.75.4 в Node): фильтр
// [?.path] проверяет свойство НА ТЕКУЩЕМ узле; [?.a.b*=x] — вложенное
// свойство текущего узла; `+=` после фильтров без навигации мержится в
// КОРЕНЬ. Тело player-запроса: {context, playbackContext, attestationRequest}
// — сиблинги, не вложенность.
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const src = readFileSync(path.resolve(process.cwd(), "scripts", "edit-inbound-scriptlet.js"), "utf8");
const code = src.slice(Math.max(0, src.indexOf("function trustedEditInboundObject(")));
// косвенный eval — определения попадают в глобальный контекст документа
(0, eval)(code);
const g = globalThis as unknown as {
  trustedEditInboundObject: (...args: string[]) => void;
};
const eio = g.trustedEditInboundObject;

/** Тело player-запроса YouTube (живая форма: context/playbackContext/
 *  attestationRequest — сиблинги верхнего уровня). */
const playerBody = (uaSuffix: string, attestation = true) => ({
  context: {
    client: {
      clientName: "WEB",
      clientVersion: "2.20261101.00.00",
      userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64)${uaSuffix}`,
    },
  },
  playbackContext: {
    contentPlaybackContext: { referer: "https://www.youtube.com/watch?v=x" },
  },
  ...(attestation ? { attestationRequest: { token: "abc" } } : {}),
});

beforeAll(() => {
  // doc-start-канал: прокси на JSON.stringify ставится до инлайн-скриптов
  // страницы; 6 правил — как в живом ансамбле quick-fixes (вложенные прокси).
  eio(
    "JSON.stringify",
    "0",
    '[?.attestationRequest][?.context.client.userAgent*="channel"].context.client[?.clientName=="WEB"]+={"clientScreen":"CHANNEL"}',
  );
  eio(
    "JSON.stringify",
    "0",
    '[?.attestationRequest][?.context.client.userAgent*="lactmilli"]+={"params":"8AUB"}',
  );
  eio(
    "JSON.stringify",
    "0",
    '[?.attestationRequest][?.context.client.userAgent*="yahi"]+={"params":"YAHI"}',
  );
  eio(
    "JSON.stringify",
    "0",
    '[?.attestationRequest][?.context.client.userAgent=/channel|lactmilli|inline/].playbackContext.contentPlaybackContext.lactMilliseconds="${now}"',
  );
  eio(
    "JSON.stringify",
    "0",
    '[?.attestationRequest][?.context.client.userAgent=/adunit|channel|lactmilli|inline|yahi|eafg|yaf4/].playbackContext.contentPlaybackContext.referer=repl({"regex":"(?:#reloadxhr)?$","replacement":"#reloadxhr"})',
  );
  eio(
    "JSON.stringify",
    "0",
    '[?.createCommentParams].context.client.userAgent=repl({"regex":"/; (adunit|channel|lactmilli|inline|yahi|eafg|yaf4)\\b/","replacement":""})',
  );
});

describe("trusted-edit-inbound-object (duopulse-072)", () => {
  it("+= по jsonPath с навигацией: clientScreen CHANNEL в context.client (живое правило)", () => {
    const out = JSON.parse(JSON.stringify(playerBody("; channel")));
    expect(out.context.client.clientScreen).toBe("CHANNEL");
    // остальное не тронуто
    expect(out.context.client.clientName).toBe("WEB");
    expect(out.attestationRequest).toEqual({ token: "abc" });
  });

  it("фильтр свойств [?.x / ?.a.b*=… / ==]: несовпавший объект проходит без правок", () => {
    // нет "channel" в UA → ни clientScreen, ни ${now}, ни referer-правка
    const out = JSON.parse(JSON.stringify(playerBody("")));
    expect(out.context.client.clientScreen).toBeUndefined();
    expect(out.playbackContext.contentPlaybackContext.lactMilliseconds).toBeUndefined();
    expect(out.playbackContext.contentPlaybackContext.referer).toBe(
      "https://www.youtube.com/watch?v=x",
    );
    // нет attestationRequest → фильтр отсекает и при совпадении UA
    const noAttest = JSON.parse(JSON.stringify(playerBody("; channel", false)));
    expect(noAttest.context.client.clientScreen).toBeUndefined();
    // clientName не WEB → последнее правило не применяется
    const notWeb = playerBody("; channel");
    notWeb.context.client.clientName = "ANDROID";
    expect(JSON.parse(JSON.stringify(notWeb)).context.client.clientScreen).toBeUndefined();
  });

  it("+= в корень (после фильтров без навигации): params 8AUB/YAHI по токену UA", () => {
    const lm = JSON.parse(JSON.stringify(playerBody("; lactmilli")));
    expect(lm.params).toBe("8AUB");
    const yahi = JSON.parse(JSON.stringify(playerBody("; yahi")));
    expect(yahi.params).toBe("YAHI");
    expect(yahi.context.client.clientScreen).toBeUndefined();
  });

  it("= присвоение с ${now}: lactMilliseconds ← строка цифр Date.now()", () => {
    // `=` не создаёт ключ (v1-семантика: путь обязан резолвиться) — в теле
    // lactMilliseconds уже есть (YT шлёт его в contentPlaybackContext)
    const body = playerBody("; inline");
    body.playbackContext.contentPlaybackContext.lactMilliseconds = 0;
    const before = Date.now();
    const out = JSON.parse(JSON.stringify(body));
    const after = Date.now();
    const got = out.playbackContext.contentPlaybackContext.lactMilliseconds;
    expect(typeof got).toBe("string"); // uBO: "${now}" — подстановка в строку
    expect(got).toMatch(/^\d+$/);
    expect(Number(got)).toBeGreaterThanOrEqual(before);
    expect(Number(got)).toBeLessThanOrEqual(after);
  });

  it("=repl: referer без #reloadxhr получает суффикс, с ним — не трогается", () => {
    const plain = JSON.parse(JSON.stringify(playerBody("; adunit")));
    expect(plain.playbackContext.contentPlaybackContext.referer).toBe(
      "https://www.youtube.com/watch?v=x#reloadxhr",
    );
    const tagged = playerBody("; adunit");
    tagged.playbackContext.contentPlaybackContext.referer = "https://www.youtube.com/watch?v=y#reloadxhr";
    expect(
      JSON.parse(JSON.stringify(tagged)).playbackContext.contentPlaybackContext.referer,
    ).toBe("https://www.youtube.com/watch?v=y#reloadxhr");
  });

  it("=repl по regex-значению: вырезает патченные токены из UA (createCommentParams)", () => {
    // механика repl на той же форме пути, что живое правило 32, но с regex
    // без \b (см. следующий кейс — живая \b-форма у апстрима инертна)
    eio(
      "JSON.stringify",
      "0",
      '[?.createCommentParams].context.client.userAgent=repl({"regex":"/; (adunit|channel)/","replacement":""})',
    );
    const obj = {
      createCommentParams: { commentText: "hi" },
      context: { client: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)/; channel/" } },
    };
    const out = JSON.parse(JSON.stringify(obj));
    expect(out.context.client.userAgent).toBe("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
  });

  it("живое правило 32 дословно: \\b в JSON-regex → backspace, UA не тронут (как в uBO)", () => {
    // uBO ArglistParser снимает только экранирование разделителя: \b доезжает
    // до JSON.parse и становится backspace-символом — такой regex не матчит
    // реальный UA. Дословный порт воспроизводит и это (инертность правила).
    const obj = {
      createCommentParams: { commentText: "hi" },
      // токен вне regex рабочего repl-правила из прошлого кейса — его не
      // вырежет, а \b-форма живого правила 32 (backspace) не матчит и его
      context: { client: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)/; yaf4/" } },
    };
    const out = JSON.parse(JSON.stringify(obj));
    expect(out.context.client.userAgent).toBe(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64)/; yaf4/",
    );
  });

  it("посторонний объект проходит насквозь, stringify не ломается", () => {
    const obj = { videoDetails: { videoId: "dQw4w9WgXcQ", title: "yt" } };
    expect(JSON.parse(JSON.stringify(obj))).toEqual(obj);
    expect(JSON.stringify([1, "a", null])).toBe('[1,"a",null]');
    expect(JSON.stringify("plain")).toBe('"plain"');
  });

  it("argPos: -1 — последний аргумент (отрицательная позиция uBO)", () => {
    (globalThis as { dpSend?: unknown }).dpSend = function (a: unknown, b: unknown) {
      return b;
    };
    // фильтр [?.x] держит ТЕКУЩИЙ узел (v1) — мержим навигацией .ctx
    eio("dpSend", "-1", '.ctx+={"mark":"ok"}');
    const res = (g as unknown as { dpSend: (a: unknown, b: unknown) => unknown }).dpSend(7, {
      ctx: { keep: 1 },
    });
    expect(res).toEqual({ ctx: { keep: 1, mark: "ok" } });
    // аргумент вне диапазона (argPos >= args.length) — вызов не тронут
    const res2 = (g as unknown as { dpSend: (a: unknown) => unknown }).dpSend(7);
    expect(res2).toBeUndefined();
  });

  it("битый jsonq не ломает цель (валидация до установки прокси)", () => {
    eio("JSON.stringify", "0", ".a.b += {broken"); // незакрытый JSON → invalid
    expect(JSON.stringify({ a: 1 })).toBe('{"a":1}');
    // пустой propChain / нечисловой argPos — тихий отказ
    eio("", "0", ".a=1");
    eio("JSON.stringify", "x", ".a=1");
    expect(JSON.stringify({ a: 1 })).toBe('{"a":1}');
  });
});
