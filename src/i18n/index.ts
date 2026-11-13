// DuoPulse — i18n интерфейса (карточка duopulse-131, этап 1: настройки).
// Ключ словаря — русская строка-исходник: t("Сохранить") ищет перевод в
// словаре текущего языка, перевода нет — возвращает исходник (ru — язык по
// умолчанию, словаря не требует). Параметры — плейсхолдеры {name}:
// t("Кэш очищен ({n} дорожек).", { n: res.cleared }).
// Хранение языка — localStorage ("duopulse.uiLang") в origin внутренних
// страниц duopulse://; перенос в настройки Core (общие для всех webview)
// — следующий этап (карточка-продолжение в CARDS/).
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

const readStored = (): UiLang => {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v && UI_LANGS.some((l) => l.id === v)) return v as UiLang;
  } catch {
    /* localStorage недоступен — молча ru */
  }
  return "ru";
};

/** Текущий язык UI (вычисляется один раз при загрузке модуля). */
export const uiLang: UiLang = readStored();

if (typeof document !== "undefined") {
  document.documentElement.lang = uiLang;
  // Арабский — RTL: страница настроек на флексах/гридах зеркалится сама.
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

/** Смена языка: сохранить и перезагрузить страницу (простейший рефреш UI). */
export function setUiLang(lang: UiLang): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* без localStorage язык проживёт только текущую страницу */
  }
  location.reload();
}
