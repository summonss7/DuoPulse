// Юнит-тесты языков облачного перевода панели (задача 4.2, docs/03 §7–8):
// селект «+ перевод в…» исключает переводы платформы (tlang бесплатный и
// приоритетнее) и языки, уже стоящие в наборе; статус прогресса и бейдж
// «перевод недоступен» (4.3) — строки для duoTranslateMeta.
import { describe, expect, it } from "vitest";
import {
  CLOUD_LANGS,
  PRIORITY_LANG_ORDER,
  baseLang,
  cloudLangOptions,
  langPriority,
  translateProgressText,
  translateUnavailableText,
  withPriorityLangsFirst,
} from "./cloud-langs";

describe("порядок языков (карточка duopulse-094)", () => {
  it("CLOUD_LANGS: en→ro→ru→ar первыми, ro в списке", () => {
    expect(CLOUD_LANGS.slice(0, 4).map((l) => l.code)).toEqual(["en", "ro", "ru", "ar"]);
    expect(CLOUD_LANGS.some((l) => l.code === "ro")).toBe(true);
    const codes = CLOUD_LANGS.map((l) => l.code);
    expect(codes).toEqual([...new Set(codes)]); // без дублей
  });

  it("langPriority: приоритетные по порядку, подтеги и регистр не мешают", () => {
    expect(langPriority("en")).toBe(0);
    expect(langPriority("RO")).toBe(1);
    expect(langPriority("pt-BR")).toBe(PRIORITY_LANG_ORDER.length); // прочий
  });

  it("withPriorityLangsFirst: стабильная сортировка — приоритетные первыми", () => {
    const items = ["es", "ru", "ja", "en", "ro"];
    expect(withPriorityLangsFirst(items, (l) => l)).toEqual(["en", "ro", "ru", "es", "ja"]);
  });
});

describe("cloudLangOptions (селект «+ перевод в…»)", () => {
  it("без источника в наборе переводить нечего — пусто", () => {
    expect(cloudLangOptions([{ lang: "ru" }], [], false)).toEqual([]);
  });

  it("исключает переводы платформы и языки набора (с подтегами)", () => {
    const options = cloudLangOptions(
      [{ lang: "ru" }, { lang: "es" }],
      ["en", "PT-BR"],
      true,
    ).map((o) => o.code);
    expect(options).not.toContain("ru"); // есть у платформы
    expect(options).not.toContain("es"); // есть у платформы
    expect(options).not.toContain("en"); // уже в наборе
    expect(options).not.toContain("pt"); // «PT-BR» в наборе → базовый «pt»
    expect(options).toContain("uk");
    expect(options).toContain("de");
  });

  it("полный список при пустых исключениях — все коды уникальны", () => {
    const codes = cloudLangOptions([], [], true).map((o) => o.code);
    expect(codes).toEqual([...new Set(codes)]);
    expect(codes.length).toBe(CLOUD_LANGS.length);
  });

  it("baseLang: нижний регистр и без подтега", () => {
    expect(baseLang("PT-BR")).toBe("pt");
    expect(baseLang(" ru ")).toBe("ru");
    expect(baseLang("")).toBe("");
  });
});

describe("translateProgressText (статус панели)", () => {
  const base = { done: 12, total: 40, fromCache: false, provider: "deepl" };

  it("ход: «Перевод… 12/40» с провайдером", () => {
    expect(translateProgressText({ ...base, phase: "translating" })).toBe("Перевод (deepl)… 12/40");
  });

  it("итог: из кэша и с сетью; ошибка — текст", () => {
    expect(translateProgressText({ ...base, phase: "done", fromCache: true })).toBe(
      "Перевод готов (из кэша)",
    );
    expect(translateProgressText({ ...base, phase: "done", fromCache: false })).toBe(
      "Перевод готов",
    );
    expect(
      translateProgressText({ ...base, phase: "error", error: "облачный перевод выключен" }),
    ).toBe("Перевод не удался: облачный перевод выключен");
    expect(translateProgressText({ ...base, phase: "error", error: null })).toBe(
      "Перевод не удался: ошибка",
    );
    expect(translateProgressText({ ...base, phase: "?" })).toBe("");
  });
});

describe("translateUnavailableText (бейдж «перевод недоступен», 4.3)", () => {
  it("офлайн — с обещанием автоповтора (бейдж держится)", () => {
    expect(
      translateUnavailableText({ reason: "offline", detail: "сеть недоступна", willRetry: true }),
    ).toBe("Перевод недоступен (нет сети) — повторим, когда сеть появится");
  });

  it("willRetry=true всегда читается как ожидание сети, даже с чужим reason", () => {
    expect(translateUnavailableText({ reason: "x", detail: "", willRetry: true })).toBe(
      "Перевод недоступен (нет сети) — повторим, когда сеть появится",
    );
  });

  it("нет провайдера (выключен/нет ключа) — подсказка без автоповтора", () => {
    expect(
      translateUnavailableText({
        reason: "no_provider",
        detail: "нет ключа DeepL — сохраните в панели «Перевод»",
        willRetry: false,
      }),
    ).toBe("Перевод недоступен: нет ключа DeepL — сохраните в панели «Перевод»");
    expect(translateUnavailableText({ reason: "no_provider", detail: "", willRetry: false })).toBe(
      "Перевод недоступен: нет провайдера",
    );
  });
});
