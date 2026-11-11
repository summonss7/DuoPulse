// DuoPulse — тесты модели страницы ошибки (карточка duopulse-048): хост
// правила и решение кнопки «этот сайт — через туннель».
import { describe, expect, it } from "vitest";
import {
  directAction,
  directActionAvailable,
  errorHost,
  routeContextNote,
  tunnelAction,
} from "./error-view";

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

describe("directAction — кнопка «напрямую» при поднятом туннеле (duopulse-075)", () => {
  it("глобальный режим сменился на split — автоповтор с пояснением", () => {
    const a = directAction({ mode: "wg", routing: "global" });
    expect(a.retry).toBe(true);
    expect(a.note).toContain("split");
    expect(a.note).toContain("напрямую");
  });
  it("split — правило добавлено, автоповтор", () => {
    const a = directAction({ mode: "wg", routing: "split" });
    expect(a.retry).toBe(true);
    expect(a.note).toContain("напрямую");
  });
  it("статуса нет — честная подсказка без автоповтора", () => {
    expect(directAction(null).retry).toBe(false);
  });
});

describe("directActionAvailable — когда показывать кнопку «напрямую»", () => {
  it("туннель поднят — кнопка нужна (сайт уже пытались через туннель)", () => {
    expect(directActionAvailable({ mode: "wg", routing: "global" })).toBe(true);
    expect(directActionAvailable({ mode: "wg", routing: "split" })).toBe(true);
  });
  it("туннель выключен/прокси/статуса нет — сайт и так напрямую, кнопка не нужна", () => {
    expect(directActionAvailable({ mode: "off", routing: "off" })).toBe(false);
    expect(directActionAvailable({ mode: "proxy", routing: "global" })).toBe(false);
    expect(directActionAvailable(null)).toBe(false);
  });
});

describe("routeContextNote — подсказка маршрута упавшей загрузки (duopulse-114)", () => {
  it("глобальный туннель — поясняет маршрут и ведёт к кнопке «напрямую»", () => {
    const note = routeContextNote({
      mode: "wg",
      routing: "global",
      wg: { profileName: "MyTunel-полный" },
    });
    expect(note).toContain("туннель");
    expect(note).toContain("MyTunel-полный");
    expect(note).toContain("напрямую");
  });
  it("туннель без имени профиля — текст без «undefined»", () => {
    const note = routeContextNote({ mode: "wg", routing: "global" });
    expect(note).toContain("туннель");
    expect(note).not.toContain("undefined");
  });
  it("split — сайт шёл напрямую, подсказка не нужна", () => {
    expect(routeContextNote({ mode: "wg", routing: "split" })).toBeNull();
  });
  it("внешний прокси — поясняет маршрут", () => {
    expect(routeContextNote({ mode: "proxy", routing: "off" })).toContain("прокси");
  });
  it("прямой маршрут и нет статуса — пояснять нечего", () => {
    expect(routeContextNote({ mode: "off", routing: "off" })).toBeNull();
    expect(routeContextNote(null)).toBeNull();
  });
});
