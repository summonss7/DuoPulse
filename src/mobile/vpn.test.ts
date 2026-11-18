// DuoPulse — тесты чистых моделей листа «VPN» мобильной ветки (duopulse-171):
// статистика из события/снапшота, тосты режимов/импорта, итог SAF-пикера.
// Класс листа (DOM + IPC) проверяется e2e-стендом e2e/mobile/vpn-ui-smoke.mjs.
import { describe, expect, it } from "vitest";
import { importFlash, modeFlash, pickErrorText, statsView, type VpnStatusDto } from "./vpn";

const off: VpnStatusDto = { mode: "off", routing: "off", state: "off", detail: "", wg: null };

describe("statsView (duopulse-171)", () => {
  it("событие vpn:stats свежее снапшота — числа из него", () => {
    const v = statsView(
      {
        profileId: "p",
        profileName: "n",
        state: "connected",
        endpoint: "10.0.2.2:1",
        lastHandshakeMs: 1000,
        rxBytes: 1,
        txBytes: 2,
        pingMs: 10,
        sinceMs: 0,
      },
      { state: "connected", rxBytes: 2048, txBytes: 4096, pingMs: 42, lastHandshakeMs: 30_000 },
    );
    expect(v.rx).toContain("2 КиБ");
    expect(v.tx).toContain("4 КиБ");
    expect(v.ping).toContain("42 мс");
    expect(v.hs).toContain("30 с");
  });
  it("события не было — снапшот тоннеля; ничего нет — прочерки", () => {
    const v = statsView(null, null);
    expect(v.rx).toBe("↓ —");
    expect(v.tx).toBe("↑ —");
    expect(v.ping).toContain("—");
    expect(v.hs).toContain("—");
  });
});

describe("modeFlash (duopulse-171)", () => {
  it("туннель поднят — короткая форма", () => {
    expect(modeFlash({ ...off, mode: "wg", routing: "global" }, "global")).toBe("Режим: глобальный.");
  });
  it("off — короткая форма (туннель не нужен)", () => {
    expect(modeFlash(off, "off")).toBe("Режим: выключен.");
  });
  it("туннель не поднят — честная подсказка включить тумблер", () => {
    expect(modeFlash(off, "split")).toBe(
      "Режим сохранён (split), но туннель не поднят — включите тумблер.",
    );
  });
});

describe("importFlash (duopulse-171)", () => {
  it("тоннель поднялся сам — короткая форма", () => {
    expect(importFlash({ ...off, mode: "wg" }, "стенд")).toBe("Профиль «стенд» импортирован.");
  });
  it("туннель не поднят — подсказка включить тумблер", () => {
    expect(importFlash(off, "стенд")).toBe("Профиль «стенд» импортирован — включите тумблер.");
  });
});

describe("pickErrorText (duopulse-171)", () => {
  it("отмена пикера — внятная строка, не сырой код", () => {
    expect(pickErrorText({ error: "cancelled" })).toBe("Импорт отменён");
  });
  it("отказ чтения — причина как пришла; пустой итог — общий отказ", () => {
    expect(pickErrorText({ error: "файл пуст" })).toBe("файл пуст");
    expect(pickErrorText({})).toBe("Не удалось прочитать файл");
  });
});
