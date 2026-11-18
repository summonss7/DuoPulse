// Тесты листа «Диагностика» мобильной ветки (duopulse-164): секции и
// форматирование отчёта — чистые функции (DOM листа, копирование в буфер и
// diag_snapshot Core — живой прогон на эмуляторе, хук
// __duopulseMobileDiagnostics). Язык тестов — русский (дефолт t()).

import { describe, expect, it } from "vitest";
import {
  diagSections,
  formatDiagReport,
  sessionDur,
  vpnStatusLine,
  type DiagSnapshot,
} from "./diagnostics";

const snap = (over: Partial<DiagSnapshot> = {}): DiagSnapshot => ({
  appVersion: "0.1.64",
  channel: "aila.skillcoin.pp.ua",
  sessionSecs: 400,
  rssKb: 241152,
  tabs: 3,
  historyEntries: 12,
  bookmarks: 4,
  passwords: 2,
  passAutofill: true,
  adblock: { enabled: true, ready: true, blockedTotal: 50, seenTotal: 200 },
  vpn: { mode: "off", state: "", profile: "", endpoint: "", rxBytes: 0, txBytes: 0 },
  lastUpdateCheckMs: null,
  nowMs: new Date(2026, 10, 17, 13, 45).getTime(),
  ...over,
});

describe("sessionDur", () => {
  it("минуты под часом", () => {
    expect(sessionDur(420)).toBe("7 мин");
  });
  it("часы + минуты от часа", () => {
    expect(sessionDur(3660)).toBe("1 ч 1 мин");
  });
  it("меньше минуты — 0 мин", () => {
    expect(sessionDur(30)).toBe("0 мин");
  });
});

describe("diagSections", () => {
  it("пять групп: приложение, данные, блокировщик, VPN, обновления", () => {
    const s = diagSections(snap(), { lastCheckMs: null, availableVersion: null });
    expect(s.map((x) => x.title)).toEqual([
      "Приложение",
      "Данные",
      "Блокировщик рекламы",
      "VPN",
      "Обновления",
    ]);
  });
  it("версия/канал/сеанс/память и счётчики с числами", () => {
    const s = diagSections(snap(), { lastCheckMs: null, availableVersion: null });
    expect(s[0].rows).toContain("Версия: 0.1.64");
    expect(s[0].rows).toContain("Канал обновлений: aila.skillcoin.pp.ua");
    expect(s[0].rows).toContain("Сеанс: 6 мин");
    expect(s[0].rows).toContain("Память процесса: 236 МБ"); // 241152 кБ ≈ 235,5 → 236
    expect(s[1].rows).toEqual([
      "Открыто вкладок: 3",
      "История: 12",
      "Закладки: 4",
      "Пароли: 2",
      "Автозаполнение паролей: включено",
    ]);
    expect(s[2].rows).toContain("Адблок: заблокировано 50 из 200 запросов");
    expect(s[2].rows).toContain("списки готовы");
  });
  it("память недоступна — прочерк", () => {
    const s = diagSections(snap({ rssKb: null }), { lastCheckMs: null, availableVersion: null });
    expect(s[0].rows).toContain("Память процесса: —");
  });
  it("инкогнито — автозаполнение паролей выключено (duopulse-166)", () => {
    const s = diagSections(snap({ passAutofill: false }), { lastCheckMs: null, availableVersion: null });
    expect(s[1].rows).toContain("Автозаполнение паролей: выключено (инкогнито)");
  });
  it("адблок выключен — одна строка без счётчиков; недоступен — честная строка", () => {
    const off = diagSections(
      snap({ adblock: { enabled: false, ready: false, blockedTotal: 0, seenTotal: 0 } }),
      { lastCheckMs: null, availableVersion: null },
    );
    expect(off[2].rows).toEqual(["Адблок: выключен"]);
    const none = diagSections(snap({ adblock: null }), { lastCheckMs: null, availableVersion: null });
    expect(none[2].rows).toEqual(["Адблок: недоступен"]);
  });
  it("обновления: доступная версия важнее метки, метка важнее «не проверялись»", () => {
    const none = diagSections(snap(), { lastCheckMs: null, availableVersion: null });
    expect(none[4].rows).toEqual(["Обновления: ещё не проверялись"]);
    const checked = diagSections(snap({ lastUpdateCheckMs: 1_700_000_000_000 }), {
      lastCheckMs: 1_700_000_000_000,
      availableVersion: null,
    });
    expect(checked[4].rows[0]).toMatch(/^Обновления: проверялись /);
    const avail = diagSections(snap(), { lastCheckMs: 1_700_000_000_000, availableVersion: "0.1.65" });
    expect(avail[4].rows).toEqual(["Обновления: доступна версия 0.1.65"]);
  });
  it("VPN-секция (duopulse-170): выключен — одна строка", () => {
    const s = diagSections(snap(), { lastCheckMs: null, availableVersion: null });
    expect(s[3].rows).toEqual(["VPN: выключен"]);
  });
  it("VPN-секция: тоннель — режим/endpoint, профиль, трафик КБ", () => {
    const s = diagSections(
      snap({
        vpn: {
          mode: "wg",
          state: "connected",
          profile: "wg-stand.conf",
          endpoint: "10.0.2.2:51820",
          rxBytes: 2057 * 1024,
          txBytes: 1029 * 1024,
        },
      }),
      { lastCheckMs: null, availableVersion: null },
    );
    expect(s[3].rows).toEqual([
      "VPN: connected · 10.0.2.2:51820",
      "Профиль: wg-stand.conf",
      "Трафик тоннеля: rx 2057 КБ / tx 1029 КБ",
    ]);
  });
});

describe("formatDiagReport", () => {
  it("заголовок с версией, все секции, перевод строки в конце", () => {
    const r = formatDiagReport(snap(), { lastCheckMs: null, availableVersion: null });
    expect(r.startsWith("DuoPulse 0.1.64 — ")).toBe(true);
    for (const line of ["Приложение", "Данные", "Блокировщик рекламы", "VPN", "Обновления", "Открыто вкладок: 3"]) {
      expect(r).toContain(line);
    }
    expect(r.endsWith("\n")).toBe(true);
  });
});

describe("vpnStatusLine (duopulse-169)", () => {
  it("выключенный VPN — короткая строка", () => {
    expect(vpnStatusLine({ mode: "off", routing: "off", state: "off", detail: "", wg: null })).toBe(
      "VPN: выключен",
    );
  });
  it("живой тоннель: состояние, endpoint, handshake, rx/tx КБ, пинг", () => {
    const line = vpnStatusLine({
      mode: "wg",
      routing: "global",
      state: "on",
      detail: "туннель жив",
      wg: {
        profileId: "abc123",
        profileName: "стенд",
        state: "connected",
        endpoint: "10.0.2.2:51820",
        lastHandshakeMs: 1200,
        rxBytes: 2057 * 1024,
        txBytes: 1029 * 1024,
        pingMs: 35,
        sinceMs: 1,
      },
    });
    expect(line).toContain("connected");
    expect(line).toContain("10.0.2.2:51820");
    expect(line).toContain("handshake 1200 мс назад");
    expect(line).toContain("rx 2057 КБ");
    expect(line).toContain("tx 1029 КБ");
    expect(line).toContain("пинг 35 мс");
  });
  it("без handshake и без пинга — честные прочерки в строке", () => {
    const line = vpnStatusLine({
      mode: "wg",
      routing: "global",
      state: "on",
      detail: "handshake…",
      wg: {
        profileId: "x",
        profileName: "n",
        state: "connecting",
        endpoint: "10.0.2.2:1",
        lastHandshakeMs: null,
        rxBytes: 0,
        txBytes: 0,
        pingMs: null,
        sinceMs: 1,
      },
    });
    expect(line).toContain("handshake не завершён");
    expect(line).not.toContain("пинг");
  });
});
