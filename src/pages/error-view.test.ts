// DuoPulse — тесты модели страницы ошибки (карточка duopulse-048): хост
// правила и решение кнопки «этот сайт — через туннель».
import { describe, expect, it } from "vitest";
import { errorHost, tunnelAction } from "./error-view";

describe("errorHost — хост для split-правила", () => {
  it("внешний адрес даёт домен без www", () => {
    expect(errorHost("https://www.youtube.com/watch?v=x")).toBe("youtube.com");
    expect(errorHost("http://blocked.tun/path?q=1")).toBe("blocked.tun");
  });
  it("IP-адреса правила не получают (правило доменное)", () => {
    expect(errorHost("http://127.0.0.1:8897/a")).toBeNull();
    expect(errorHost("http://8.8.8.8/")).toBeNull();
  });
  it("внутренние схемы и мусор — null", () => {
    expect(errorHost("duopulse://error?url=https://x")).toBeNull();
    expect(errorHost("file:///C:/x.htm")).toBeNull();
    expect(errorHost("не адрес")).toBeNull();
    expect(errorHost(undefined)).toBeNull();
  });
});

describe("tunnelAction — решение после vpn.add_rule", () => {
  it("туннель поднят в split/global — автоповтор по правилу", () => {
    expect(tunnelAction({ mode: "wg", routing: "split" }).retry).toBe(true);
    expect(tunnelAction({ mode: "wg", routing: "global" }).retry).toBe(true);
  });
  it("туннель выключен — подсказка включить и повторить руками", () => {
    const a = tunnelAction({ mode: "off", routing: "split" });
    expect(a.retry).toBe(false);
    expect(a.note).toContain("Включите туннель");
  });
  it("режим выключен при живом туннеле — подсказка включить split", () => {
    const a = tunnelAction({ mode: "wg", routing: "off" });
    expect(a.retry).toBe(false);
    expect(a.note).toContain("split");
  });
  it("статуса нет — честная подсказка без автоповтора", () => {
    expect(tunnelAction(null).retry).toBe(false);
  });
});
