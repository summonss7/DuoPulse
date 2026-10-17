// Чистые функции формы «Перевод» (задача 4.1) — зеркалят валидацию Core
// (src-tauri/src/translate/config.rs), чтобы неверная форма не уходила в IPC.

import { describe, expect, it } from "vitest";
import {
  formToConfig,
  formValues,
  keyPlaceholder,
  secretOf,
  validateForm,
  type TranslateFormValues,
} from "./translate-form";
import type { TranslateSettings } from "../bridge/gen/types";

const form: TranslateFormValues = {
  enabled: true,
  provider: "deepl",
  deeplPlan: "pro",
  libreUrl: "  http://lt.local:5055/  ",
};

const settings: TranslateSettings = {
  enabled: false,
  provider: "libretranslate",
  deeplPlan: "free",
  libretranslateUrl: "http://localhost:5000",
  hasApiKeys: ["deepl"],
};

describe("форма «Перевод» ↔ конфиг", () => {
  it("formToConfig тримит адрес LibreTranslate", () => {
    expect(formToConfig(form)).toEqual({
      enabled: true,
      provider: "deepl",
      deeplPlan: "pro",
      libretranslateUrl: "http://lt.local:5055/",
    });
  });

  it("formValues читает снапшот настроек", () => {
    expect(formValues(settings)).toEqual({
      enabled: false,
      provider: "libretranslate",
      deeplPlan: "free",
      libreUrl: "http://localhost:5000",
    });
  });

  it("ключ: placeholder и семантика секрета", () => {
    expect(keyPlaceholder(true)).toContain("сохранён");
    expect(keyPlaceholder(false)).toBe("ключ");
    expect(secretOf("")).toBeNull();
    expect(secretOf("   ")).toBeNull();
    expect(secretOf(" sk-1 ")).toBe("sk-1");
  });

  it("валидация включённого LibreTranslate требует http(s)-адрес", () => {
    expect(validateForm({ ...form, provider: "libretranslate", libreUrl: "  " })).toContain("не задан");
    expect(
      validateForm({ ...form, provider: "libretranslate", libreUrl: "ftp://x" }),
    ).toContain("http://");
    expect(
      validateForm({ ...form, provider: "libretranslate", libreUrl: "http://lt.local" }),
    ).toBeNull();
    // Deepl/Google адреса не требуют; выключенному — всё можно
    expect(validateForm({ ...form, provider: "deepl", libreUrl: "" })).toBeNull();
    expect(
      validateForm({ ...form, enabled: false, provider: "libretranslate", libreUrl: "" }),
    ).toBeNull();
  });
});
