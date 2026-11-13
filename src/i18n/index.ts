// DuoPulse — i18n интерфейса (карточка duopulse-131, этап 1: настройки;
// duopulse-136, этап 2: язык живёт в Core — раздел "ui" settings.json).
// Ключ словаря — русская строка-исходник: t("Сохранить") ищет перевод в
// словаре текущего языка, перевода нет — возвращает исходник (ru — язык по
// умолчанию, словаря не требует). Параметры — плейсхолдеры {name}:
// t("Кэш очищен ({n} дорожек).", { n: res.cleared }).
// Источник языка: localStorage («duopulse.uiLang», пишут setUiLang и слушатель
// события смены) → window.__DUOPULSE_UI_LANG__ (init-скрипт Core при создании
// webview; duopulse-136) → «ru». Core эмитит settings:ui_lang_changed, слушатель
// в src/main.ts перезагружает страницу — все webview синхронны.
import { dict as dictEn } from "./dict-en";
import { dict as dictUk } from "./dict-uk";
import { dict as dictRo } from "./dict-ro";
import { dict as dictAr } from "./dict-ar";
import { dict as dictSk } from "./dict-sk";

export type UiLang = "ru" | "en" | "uk" | "ro" | "ar" | "sk";

export const UI_LANGS: { id: UiLang; label: string }[] = [
  { id: "ru", label: "Русский" },
  { id: "en", label: "English" },
  { id: "uk", label: "Українська" },
  { id: "ro", label: "Română" },
  { id: "ar", label: "العربية" },
  { id: "sk", label: "Slovenčina" },
];

const DICTS: Partial<Record<UiLang, Readonly<Record<string, string>>>> = {
  en: dictEn,
  uk: dictUk,
  ro: dictRo,
  ar: dictAr,
  sk: dictSk,
};

const STORAGE_KEY = "duopulse.uiLang";

const isUiLang = (v: unknown): v is UiLang => UI_LANGS.some((l) => l.id === v);

/** Текущий язык UI: localStorage (живое значение после смены) → init-скрипт
 *  Core (window.__DUOPULSE_UI_LANG__, «испечён» при создании webview) → ru. */
const readLang = (): UiLang => {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (isUiLang(v)) return v;
  } catch {
    /* localStorage недоступен — дальше init-скрипт Core */
  }
  const injected = (globalThis as { __DUOPULSE_UI_LANG__?: string }).__DUOPULSE_UI_LANG__;
  if (isUiLang(injected)) return injected;
  return "ru";
};

/** Текущий язык UI (вычисляется один раз при загрузке модуля). */
export const uiLang: UiLang = readLang();

if (typeof document !== "undefined") {
  document.documentElement.lang = uiLang;
  // Арабский — RTL: страницы настроек/хрома на флексах/гридах зеркалятся сами.
  document.documentElement.dir = uiLang === "ar" ? "rtl" : "ltr";
}

/** Перевод строки: словарь текущего языка → иначе исходник (ru). */
export function t(src: string, params?: Record<string, string | number>): string {
  let out = DICTS[uiLang]?.[src] ?? src;
  if (params) {
    for (const [k, v] of Object.entries(params)) out = out.replaceAll(`{${k}}`, String(v));
  }
  return out;
}

/** Локаль для дат/времени текущего языка UI (подсказки, даты релизов). */
export const uiLocale: string = { ru: "ru-RU", en: "en-GB", uk: "uk-UA", ro: "ro-RO", ar: "ar-EG", sk: "sk-SK" }[uiLang];

/** Перевести статическую разметку (duopulse-136): data-i18n — текст элемента
 *  (плюс data-i18n-title / -placeholder / -aria-label — одноимённые атрибуты);
 *  исходник — текущее значение атрибута/текста. Вызывают хром (chrome.ts) и
 *  панельные webview (panel-boot.ts) до показа. */
export function applyStaticI18n(root: ParentNode = document): void {
  const nodes = root.querySelectorAll<HTMLElement>(
    "[data-i18n], [data-i18n-title], [data-i18n-placeholder], [data-i18n-aria-label]",
  );
  for (const el of nodes) {
    const text = el.dataset.i18n;
    if (text !== undefined) el.textContent = t(text);
    const title = el.dataset.i18nTitle;
    if (title !== undefined) el.title = t(title);
    const ph = el.dataset.i18nPlaceholder;
    if (ph !== undefined) el.setAttribute("placeholder", t(ph));
    const aria = el.dataset.i18nAriaLabel;
    if (aria !== undefined) el.setAttribute("aria-label", t(aria));
  }
}

/** Смена языка (duopulse-136): записать в Core (settings.apply ui.lang) и
 *  перезагрузиться; Core эмитит settings:ui_lang_changed — остальные webview
 *  перезагружает слушатель в src/main.ts. localStorage — живой кэш страницы
 *  (первыми его читают перезагруженные webview до нового init-скрипта). */
export async function setUiLang(lang: UiLang): Promise<void> {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* без localStorage язык проживёт только текущую страницу */
  }
  try {
    const { bridge } = await import("../bridge");
    await bridge.settings.apply({ ui: { lang } });
  } catch {
    /* Core недоступен (сбой invoke) — язык переживёт только эту страницу */
  }
  location.reload();
}
