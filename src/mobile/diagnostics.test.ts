// Тесты листа «Диагностика» мобильной ветки (duopulse-164): секции и
// форматирование отчёта — чистые функции (DOM листа, копирование в буфер и
// diag_snapshot Core — живой прогон на эмуляторе, хук
// __duopulseMobileDiagnostics). Язык тестов — русский (дефолт t()).

import { describe, expect, it } from "vitest";
import { diagSections, formatDiagReport, sessionDur, type DiagSnapshot } from "./diagnostics";

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
  it("четыре группы: приложение, данные, блокировщик, обновления", () => {
    const s = diagSections(snap(), { lastCheckMs: null, availableVersion: null });
    expect(s.map((x) => x.title)).toEqual(["Приложение", "Данные", "Блокировщик рекламы", "Обновления"]);
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
    expect(none[3].rows).toEqual(["Обновления: ещё не проверялись"]);
    const checked = diagSections(snap({ lastUpdateCheckMs: 1_700_000_000_000 }), {
      lastCheckMs: 1_700_000_000_000,
      availableVersion: null,
    });
    expect(checked[3].rows[0]).toMatch(/^Обновления: проверялись /);
    const avail = diagSections(snap(), { lastCheckMs: 1_700_000_000_000, availableVersion: "0.1.65" });
    expect(avail[3].rows).toEqual(["Обновления: доступна версия 0.1.65"]);
  });
});

describe("formatDiagReport", () => {
  it("заголовок с версией, все секции, перевод строки в конце", () => {
    const r = formatDiagReport(snap(), { lastCheckMs: null, availableVersion: null });
    expect(r.startsWith("DuoPulse 0.1.64 — ")).toBe(true);
    for (const line of ["Приложение", "Данные", "Блокировщик рекламы", "Обновления", "Открыто вкладок: 3"]) {
      expect(r).toContain(line);
    }
    expect(r.endsWith("\n")).toBe(true);
  });
});
