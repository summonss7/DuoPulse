// Панель «Перевод» (задача 4.1, docs/03 §7–8): чистые функции формы без DOM —
// юнит-тесты; DOM-обвязка — translate-settings.ts. Форма ↔ конфиг перевода
// (translate.{get,set}_settings): несекретные параметры в settings.json,
// ключ API — только DPAPI (как пароль прокси, duopulse-009).

import type {
  DeeplPlan,
  ProviderId,
  TranslateConfig,
  TranslateSettings,
} from "../bridge/gen/types";
import { t } from "../i18n";

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  deepl: "DeepL",
  google: "Google Translate",
  libretranslate: "LibreTranslate",
};

/** Значения полей формы «Перевод» (id DOM-элементов — translate-settings.ts). */
export interface TranslateFormValues {
  enabled: boolean;
  provider: ProviderId;
  deeplPlan: DeeplPlan;
  libreUrl: string;
}

/** Конфиг из значений формы (Trim адреса — как валидация Core). */
export function formToConfig(v: TranslateFormValues): TranslateConfig {
  return {
    enabled: v.enabled,
    provider: v.provider,
    deeplPlan: v.deeplPlan,
    libretranslateUrl: v.libreUrl.trim(),
  };
}

/** Значения формы из снапшота настроек Core. */
export function formValues(s: TranslateSettings): TranslateFormValues {
  return {
    enabled: s.enabled,
    provider: s.provider,
    deeplPlan: s.deeplPlan,
    libreUrl: s.libretranslateUrl,
  };
}

/** Placeholder поля ключа: сохранён — пусто = не менять (паттерн прокси). */
export function keyPlaceholder(hasKey: boolean): string {
  return hasKey ? t("сохранён — пусто = не менять") : t("ключ");
}

/** Секрет для set_settings: пустое поле — не менять (null), иначе строка. */
export function secretOf(keyInput: string): string | null {
  const key = keyInput.trim();
  return key === "" ? null : key;
}

/** Клиентская валидация перед сохранением включённого режима (зеркало Core):
 * адрес LibreTranslate обязателен и http(s); выключенному — всё можно. */
export function validateForm(v: TranslateFormValues): string | null {
  if (!v.enabled) return null;
  if (v.provider !== "libretranslate") return null;
  const url = v.libreUrl.trim();
  if (!url) return t("Адрес LibreTranslate не задан");
  if (!/^https?:\/\//.test(url)) return t("Адрес LibreTranslate должен начинаться с http:// или https://");
  return null;
}
