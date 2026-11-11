// Тесты чистых помощников панели загрузки (карточка duopulse-118).
import { describe, expect, it } from "vitest";
import {
  AUDIO_FORMAT_OPTIONS,
  QUALITY_OPTIONS,
  fmtSec,
  modeLabel,
  parseTimeInput,
  phaseLabel,
  rangeValid,
  subsLangOptions,
} from "./options";
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
