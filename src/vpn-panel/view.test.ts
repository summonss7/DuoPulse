// Юнит-тесты модели панели VPN (задача 6.5): состояние индикатора-щита из
// снапшотов/событий Core, формат чисел статистики (rx/tx/ping/handshake),
// хост активной вкладки для «этот сайт — через туннель» и каталог маршрутных
// решений сеанса (vpn:route_changed) — без DOM, чистые функции view.ts.
import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatHandshake,
  formatPing,
  hostOf,
  noteRoute,
  routeLabel,
  routeRows,
  routingLabel,
  shieldLabel,
  shieldState,
} from "./view";

describe("shieldState (индикатор-щит, гайд 06 §2)", () => {
  it("туннель не поднят — off (внешний прокси щит не зажигает)", () => {
    expect(shieldState({ mode: "off" })).toBe("off");
    expect(shieldState({ mode: "off", wg: { state: "connected" } })).toBe("off");
    expect(shieldState({ mode: "proxy" })).toBe("off");
    expect(shieldState({ mode: "wg", wg: null })).toBe("off");
    expect(shieldState({ mode: "wg", wg: undefined })).toBe("off");
  });

  it("фазы туннеля: connecting → connecting, connected → connected, error → error", () => {
    expect(shieldState({ mode: "wg", wg: { state: "connecting" } })).toBe("connecting");
    expect(shieldState({ mode: "wg", wg: { state: "connected" } })).toBe("connected");
    expect(shieldState({ mode: "wg", wg: { state: "error" } })).toBe("error");
  });

  it("слово статуса панели по состоянию щита", () => {
    expect(shieldLabel("off")).toBe("Выключен");
    expect(shieldLabel("connecting")).toBe("Подключается");
    expect(shieldLabel("connected")).toBe("Подключён");
    expect(shieldLabel("error")).toBe("Ошибка");
  });
});

describe("formatBytes / formatPing / formatHandshake (статистика vpn:stats)", () => {
  it("байты: единицы с шагом 1024, одна десятичная запятой, без хвостовых нулей", () => {
    expect(formatBytes(0)).toBe("0 Б");
    expect(formatBytes(864)).toBe("864 Б");
    expect(formatBytes(1024)).toBe("1 КиБ");
    expect(formatBytes(1300)).toBe("1,3 КиБ");
    expect(formatBytes(1024 * 1024)).toBe("1 МиБ");
    expect(formatBytes(3.4 * 1024 * 1024)).toBe("3,4 МиБ");
    expect(formatBytes(1.1 * 1024 * 1024 * 1024)).toBe("1,1 ГиБ");
  });

  it("ping: null — «—» (сервер может не отвечать на ICMP), число — мс", () => {
    expect(formatPing(null)).toBe("—");
    expect(formatPing(undefined)).toBe("—");
    expect(formatPing(23)).toBe("23 мс");
  });

  it("handshake: без него «—», свежий «только что», дальше с/мин/ч", () => {
    expect(formatHandshake(null)).toBe("—");
    expect(formatHandshake(2000)).toBe("только что");
    expect(formatHandshake(45_000)).toBe("45 с");
    expect(formatHandshake(3 * 60_000)).toBe("3 мин");
    expect(formatHandshake(72 * 60_000)).toBe("1 ч 12 мин");
    expect(formatHandshake(2 * 3_600_000)).toBe("2 ч");
  });
});

describe("hostOf («этот сайт — через туннель»)", () => {
  it("хост активной вкладки, www снимается, регистр нормализуется", () => {
    expect(hostOf("https://www.Example.com/page?q=1")).toBe("example.com");
    expect(hostOf("http://sub.example.com/")).toBe("sub.example.com");
  });

  it("внутренние страницы и мусор не дают хоста", () => {
    expect(hostOf("duopulse://settings")).toBeNull();
    expect(hostOf("about:blank")).toBeNull();
    expect(hostOf("")).toBeNull();
    expect(hostOf(null)).toBeNull();
    expect(hostOf("не url")).toBeNull();
  });
});

describe("noteRoute / routeRows / routeLabel (маршруты сеанса)", () => {
  it("первое решение — в каталог, повтор домена всплывает наверх", () => {
    let routes = new Map<string, string>();
    routes = noteRoute(routes, "a.example", "tunnel");
    routes = noteRoute(routes, "b.example", "direct");
    routes = noteRoute(routes, "a.example", "direct"); // сменили маршрут
    expect([...routes.entries()]).toEqual([
      ["b.example", "direct"],
      ["a.example", "direct"],
    ]);
    // свежие сверху: сменившийся домен — первый в списке
    expect(routeRows(routes)[0]).toEqual({ domain: "a.example", route: "direct" });
  });

  it("список ограничен cap (панель не растягивается), старые отрезаются", () => {
    let routes = new Map<string, string>();
    for (let i = 0; i < 12; i++) routes = noteRoute(routes, `d${i}.example`, "tunnel");
    const rows = routeRows(routes, 8);
    expect(rows).toHaveLength(8);
    expect(rows[0]).toEqual({ domain: "d11.example", route: "tunnel" }); // свежайший сверху
    expect(rows[7]).toEqual({ domain: "d4.example", route: "tunnel" }); // старее d4 — отрезаны
  });

  it("подписи маршрутов и режимов", () => {
    expect(routeLabel("tunnel")).toBe("туннель");
    expect(routeLabel("direct")).toBe("напрямую");
    expect(routeLabel("proxy")).toBe("прокси");
    expect(routingLabel("off")).toBe("выключен");
    expect(routingLabel("global")).toBe("глобальный");
    expect(routingLabel("split")).toBe("split");
  });
});
