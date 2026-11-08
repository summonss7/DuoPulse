// Настройки duo мобильной ветки (этап 2, duopulse-082): состав набора
// (оригинал + перевод), вид плашки и сдвиг — персистентны в localStorage
// (переживают перезапуск/ротацию; SQLite-история — вне этапа, см. README
// «Платформы»). Значения стиля — та же модель, что у десктопа
// (content/overlay/style.ts): клампы там, здесь — только переносимый набор.

import { DEFAULT_SUBTITLE_STYLE, type SubtitleStyle } from "../../../content/overlay/style";
import { OFFSET_LIMIT_MS } from "../../../content/engine/subtitles-engine";

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

/** Выбор перевода: null — нет; "gtx:<lang>" — Google; "track:<baseId>" —
 * готовая дорожка перевода видео (TED-подобные несут десятки языков). */
export type TranslationChoice = string | null;

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
    translation: "gtx:ru",
    fontScalePct: DEFAULT_SUBTITLE_STYLE.fontScalePct,
    position: DEFAULT_SUBTITLE_STYLE.position,
    offsetMs: 0,
  };
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
    translation:
      typeof v.translation === "string" && (v.translation.startsWith("gtx:") || v.translation.startsWith("track:"))
        ? v.translation
        : null,
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
