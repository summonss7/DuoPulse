// Настройки duo мобильной ветки (этап 2, duopulse-082): состав набора
// (оригинал + перевод), вид плашки и сдвиг — персистентны в localStorage
// (переживают перезапуск/ротацию; SQLite-история — вне этапа, см. README
// «Платформы»). Значения стиля — та же модель, что у десктопа
// (content/overlay/style.ts): клампы там, здесь — только переносимый набор.

import { DEFAULT_SUBTITLE_STYLE, type SubtitleStyle } from "../../../content/overlay/style";
import { OFFSET_LIMIT_MS } from "../../../content/engine/subtitles-engine";
import { defaultTranslationTarget } from "../../../content/set-defaults";

/** Ключ localStorage (единый объект настроек мобильного duo). */
const STORAGE_KEY = "duopulse.duo.mobile.v1";

/** Языки перевода Google (gtx) в панели: языки семьи + ходовые. */
export const GTX_TARGET_LANGS: ReadonlyArray<{ code: string; name: string }> = [
  { code: "ru", name: "Русский" },
  { code: "uk", name: "Українська" },
  { code: "en", name: "English" },
  { code: "ar", name: "العربية" },
  { code: "he", name: "עברית" },
  { code: "de", name: "Deutsch" },
  { code: "pl", name: "Polski" },
  { code: "es", name: "Español" },
];

/** Выбор перевода: null — нет; "auto" — цель по правилу дуо (см.
 * AUTO_TRANSLATION); "gtx:<lang>" — Google; "track:<baseId>" — готовая
 * дорожка перевода видео (TED-подобные несут десятки языков). */
export type TranslationChoice = string | null;

/** Перевод «Авто» — дефолт и значение по правилу дуо duopulse-196
 * (мобильный паритет — duopulse-201): цель выбирает
 * defaultTranslationTarget(content/set-defaults) — русский/украинский
 * оригинал → gtx:en, прочие → gtx:ru (duopulse-216). Явный выбор
 * языка/дорожки в панели главнее: правило не перетирает. */
export const AUTO_TRANSLATION = "auto";

export interface DuoMobileSettings {
  /** Показ субтитров включён (как enabled десктопа, docs/03 §8). */
  enabled: boolean;
  /** id базовой дорожки оригинала (схема yt:<lang>[:asr][:N]). */
  originalId: string | null;
  /** Выбор перевода (см. TranslationChoice). */
  translation: TranslationChoice;
  /** Масштаб кегля плашки, % (75–300, шаг 10 — как десктоп). */
  fontScalePct: number;
  /** Позиция плашки. */
  position: "bottom" | "top";
  /** Сдвиг показа, мс (±10 с). */
  offsetMs: number;
}

export function defaultDuoSettings(): DuoMobileSettings {
  return {
    enabled: true,
    originalId: null,
    translation: AUTO_TRANSLATION,
    fontScalePct: DEFAULT_SUBTITLE_STYLE.fontScalePct,
    position: DEFAULT_SUBTITLE_STYLE.position,
    offsetMs: 0,
  };
}

/** Канонизация выбора перевода: «auto»/gtx:/track: — валидны; легаси-дефолт
 * «gtx:ru» (персистнут до duopulse-201, мог быть не явным выбором, а
 * сохранённым дефолтом duopulse-082) → «auto»: правило дуо главнее — у
 * русского оригинала старая цель равнялась языку источника и перевод молча
 * не поднимался (соло-оригинал); явный выбор другого языка (gtx:uk) и
 * готовой дорожки — как есть; мусор → null («нет»). */
function canonTranslation(raw: unknown): TranslationChoice {
  if (raw === AUTO_TRANSLATION) return AUTO_TRANSLATION;
  if (typeof raw !== "string") return null;
  if (raw === "gtx:ru") return AUTO_TRANSLATION; // легаси-дефолт дуо-082
  return raw.startsWith("gtx:") || raw.startsWith("track:") ? raw : null;
}

/** Канонизация значения из хранилища/патча: клампы и типы как у стиля
 * десктопа (style.ts mergeStyle), лишние ключи игнорируются. */
export function normalizeSettings(raw: unknown): DuoMobileSettings {
  const d = defaultDuoSettings();
  if (!raw || typeof raw !== "object") return d;
  const v = raw as Partial<DuoMobileSettings> & Record<string, unknown>;
  const num = (x: unknown, fb: number): number => (typeof x === "number" && Number.isFinite(x) ? x : fb);
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : d.enabled,
    originalId: typeof v.originalId === "string" && v.originalId ? v.originalId : null,
    translation: canonTranslation(v.translation),
    fontScalePct: Math.min(300, Math.max(75, Math.round(num(v.fontScalePct, d.fontScalePct)))),
    position: v.position === "top" ? "top" : "bottom",
    offsetMs: Math.min(OFFSET_LIMIT_MS, Math.max(-OFFSET_LIMIT_MS, Math.round(num(v.offsetMs, 0)))),
  };
}

/** Загрузка из localStorage (битое/отсутствующее — дефолты). */
export function loadDuoSettings(storage: Pick<Storage, "getItem"> = localStorage): DuoMobileSettings {
  try {
    return normalizeSettings(JSON.parse(storage.getItem(STORAGE_KEY) ?? "null"));
  } catch {
    return defaultDuoSettings();
  }
}

/** Сохранение (best-effort: переполнение/приватный режим — молча). */
export function saveDuoSettings(s: DuoMobileSettings, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* настройка переживёт только сеанс — не критично */
  }
}

/** Стиль плашки мобильной ветки: фиксированные фирменные цвета гайда 06 §6,
 * управляемые панелью — кегль и позиция (цвета/гарнитура — вне этапа 2). */
export function mobilePlateStyle(s: DuoMobileSettings): SubtitleStyle {
  return { ...DEFAULT_SUBTITLE_STYLE, fontScalePct: s.fontScalePct, position: s.position };
}

/** Разбор выбора перевода. */
export function parseTranslationChoice(choice: TranslationChoice): { kind: "none" } | { kind: "gtx"; lang: string } | { kind: "track"; baseId: string } {
  if (!choice) return { kind: "none" };
  if (choice.startsWith("gtx:")) return { kind: "gtx", lang: choice.slice(4) };
  const baseId = choice.slice("track:".length);
  return { kind: "track", baseId };
}

/** Разбор выбора перевода ДЛЯ ПОКАЗА (duopulse-201): «auto» резолвится
 * правилом дуо duopulse-196 — defaultTranslationTarget: русский/украинский
 * оригинал → gtx:en, прочие → gtx:ru (подтег не мешает: «ru-RU»/«uk-UA» —
 * те же языки; украинский — duopulse-216); явный gtx:<lang>/track:<id>/null
 * — как выбрал пользователь, правило не перетирает. */
export function resolveTranslationChoice(
  choice: TranslationChoice,
  originalLang: string,
): ReturnType<typeof parseTranslationChoice> {
  if (choice === AUTO_TRANSLATION) return { kind: "gtx", lang: defaultTranslationTarget(originalLang) };
  return parseTranslationChoice(choice);
}
