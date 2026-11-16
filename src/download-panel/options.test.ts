// Тесты чистых помощников панели загрузки (карточка duopulse-118;
// форматирование файловых загрузок — duopulse-158).
import { describe, expect, it } from "vitest";
import {
  AUDIO_FORMAT_OPTIONS,
  QUALITY_OPTIONS,
  fileDlStatusText,
  fmtBytes,
  fmtSec,
  fmtSpeed,
  modeLabel,
  parseTimeInput,
  phaseLabel,
  rangeValid,
  subsLangOptions,
} from "./options";
import type { FileDlInfo } from "../bridge/gen/types";
import type { BaseTrackInfo, TranslationLangInfo } from "../bridge/gen/types";

const base = (id: string, name: string, kind: "manual" | "asr", original: boolean): BaseTrackInfo => ({
  id,
  lang: id.replace(/^yt:/, "").split("+")[0],
  kind,
  name,
  original,
  translatable: true,
});

describe("parseTimeInput", () => {
  it("разбирает мм:сс, чч:мм:сс и голые секунды", () => {
    expect(parseTimeInput("1:23")).toBe(83);
    expect(parseTimeInput("1:23:45")).toBe(5025);
    expect(parseTimeInput("12")).toBe(12);
    expect(parseTimeInput(" 0:30 ")).toBe(30);
  });
  it("мусор и нули — null", () => {
    expect(parseTimeInput("")).toBeNull();
    expect(parseTimeInput("1:99")).toBeNull();
    expect(parseTimeInput("0:00")).toBeNull();
    expect(parseTimeInput("abc")).toBeNull();
    expect(parseTimeInput("1:2:3:4")).toBeNull();
    expect(parseTimeInput("-5")).toBeNull();
  });
});

describe("fmtSec", () => {
  it("минуты и часы", () => {
    expect(fmtSec(83)).toBe("1:23");
    expect(fmtSec(5025)).toBe("1:23:45");
    expect(fmtSec(5)).toBe("0:05");
  });
});

describe("rangeValid", () => {
  it("старт обязателен, конец опционален и позже старта", () => {
    expect(rangeValid("1:23", "2:00")).toBe(true);
    expect(rangeValid("1:23", "")).toBe(true);
    expect(rangeValid("", "2:00")).toBe(false);
    expect(rangeValid("2:00", "1:23")).toBe(false);
    expect(rangeValid("2:00", "2:00")).toBe(false);
    expect(rangeValid("x", "y")).toBe(false);
  });
});

describe("subsLangOptions", () => {
  it("базовые дорожки с пометками + переводы", () => {
    const b = [
      base("yt:en", "English", "manual", true),
      base("yt:en:asr", "English (auto)", "asr", false),
    ];
    const t: TranslationLangInfo[] = [{ lang: "ru", name: "Русский" }];
    const opts = subsLangOptions(b, t);
    expect(opts.map((o) => o.value)).toEqual(["yt:en", "yt:en:asr", "ru"]);
    expect(opts[0].label).toBe("English •");
    expect(opts[1].label).toBe("English (auto) (авто)");
    expect(opts[2].label).toBe("Русский (перевод)");
  });
  it("пустой список — пустые опции", () => {
    expect(subsLangOptions([], [])).toEqual([]);
  });
});

describe("подписи", () => {
  it("фазы и режимы по-русски, неизвестное — как есть", () => {
    expect(phaseLabel("download")).toBe("загрузка");
    expect(phaseLabel("tools")).toBe("докачка инструментов (один раз)");
    expect(phaseLabel("weird")).toBe("weird");
    expect(modeLabel("audio")).toBe("музыка");
    expect(modeLabel("subs")).toBe("субтитры");
    expect(modeLabel("x")).toBe("x");
  });
  it("качества и форматы не пусты", () => {
    expect(QUALITY_OPTIONS[0]).toEqual({ value: "best", label: "лучшее" });
    expect(AUDIO_FORMAT_OPTIONS.map((o) => o.value)).toEqual(["m4a", "mp3"]);
  });
});

// файловые загрузки (карточка duopulse-158)
const file = (over: Partial<FileDlInfo>): FileDlInfo => ({
  id: 1,
  url: "https://example.com/a.mp3",
  fileName: "a.mp3",
  path: "D:\\Downloads\\a.mp3",
  state: "active",
  received: 0,
  speed: 0,
  error: null,
  ...over,
});

describe("fmtBytes / fmtSpeed (duopulse-158)", () => {
  it("байты → компактные подписи", () => {
    expect(fmtBytes(0)).toBe("0 Б");
    expect(fmtBytes(843)).toBe("843 Б");
    expect(fmtBytes(1024 * 900)).toBe("900 КБ");
    expect(fmtBytes(13 * 1024 * 1024)).toBe("13.0 МБ");
    expect(fmtBytes(2.5 * 1024 * 1024 * 1024)).toContain("ГБ");
  });
  it("скорость: 0/мусор — пусто, живая — «…/с»", () => {
    expect(fmtSpeed(0)).toBe("");
    expect(fmtSpeed(-5)).toBe("");
    expect(fmtSpeed(1024 * 1024)).toContain("МБ/с");
  });
});

describe("fileDlStatusText (duopulse-158)", () => {
  it("активная — скачивается с байтами и скоростью", () => {
    const text = fileDlStatusText(file({ received: 12.4 * 1024 * 1024, speed: 1.2 * 1024 * 1024 }));
    expect(text).toContain("скачивается");
    expect(text).toContain("12.4 МБ");
    expect(text).toContain("1.2 МБ/с");
  });
  it("без скорости — только байты", () => {
    expect(fileDlStatusText(file({ received: 500 }))).toBe("скачивается · 500 Б");
  });
  it("готовая — «готово», прерванная — причина", () => {
    expect(fileDlStatusText(file({ state: "done" }))).toBe("готово");
    expect(fileDlStatusText(file({ state: "error", error: "загрузка прервана" }))).toBe(
      "загрузка прервана",
    );
  });
});
