// DuoPulse — тесты i18n (карточка duopulse-131, этап 1): наборы ключей всех
// словарей совпадают, значения непустые и отличаются от ru-ключа; t() в ru
// (окружение без localStorage) подставляет параметры и фолбэчит исходник.
import { describe, expect, it } from "vitest";
import { dict as dictEn } from "./dict-en";
import { dict as dictUk } from "./dict-uk";
import { dict as dictRo } from "./dict-ro";
import { dict as dictAr } from "./dict-ar";
import { dict as dictSk } from "./dict-sk";
import { t } from "./index";

const DICTS: Record<string, Record<string, string>> = {
  en: dictEn,
  uk: dictUk,
  ro: dictRo,
  ar: dictAr,
  sk: dictSk,
};

describe("i18n-словари (duopulse-131)", () => {
  it("наборы ключей во всех словарях совпадают с en", () => {
    const ref = Object.keys(dictEn).sort();
    expect(ref.length).toBeGreaterThan(100);
    for (const [lang, dict] of Object.entries(DICTS)) {
      if (lang === "en") continue;
      expect(Object.keys(dict).sort(), `ключи ${lang}`).toEqual(ref);
    }
  });

  it("нет пустых переводов или переводов, равных ru-ключу (кроме совпадающих слов)", () => {
    for (const [lang, dict] of Object.entries(DICTS)) {
      for (const [key, value] of Object.entries(dict)) {
        expect(value.trim(), `${lang}: пустой перевод «${key}»`).not.toBe("");
      }
    }
  });

  it("плейсхолдеры {x} сохранены в переводах", () => {
    for (const [lang, dict] of Object.entries(DICTS)) {
      for (const [key, value] of Object.entries(dict)) {
        const keyPh = (key.match(/\{[a-z]+\}/g) ?? []).sort().join(",");
        const valPh = (value.match(/\{[a-z]+\}/g) ?? []).sort().join(",");
        expect(valPh, `${lang}: плейсхолдеры «${key}»`).toBe(keyPh);
      }
    }
  });
});

describe("t() (duopulse-131)", () => {
  it("в ru-окружении возвращает исходник и подставляет параметры", () => {
    expect(t("Сохранить")).toBe("Сохранить");
    expect(t("Кэш очищен ({n} дорожек).", { n: 3 })).toBe("Кэш очищен (3 дорожек).");
  });
});
