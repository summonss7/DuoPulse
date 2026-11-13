// DuoPulse — payload нативного меню кнопки «duo» (карточка duopulse-087:
// «в кнопочки duo не могу найти, где настроить языки субтитров и формат
// плашки»). HTML-панель на контентных вкладках уходит под страницу (спайк
// duopulse-086: webview всегда поверх HTML UI), поэтому вход в настройки
// субтитров — нативное popup-меню muda (chrome_menu.rs build_duo_menu),
// видимое над любой вкладкой. Чистые функции без DOM — юнит-тесты; сборку
// payload и исполнение действий (IPC) делает duo.ts.
//
// Состав меню: показ набора; языки текущего видео (оригинал/перевод — те же
// варианты, что у селектов панели: fromOptions/toOptions langs-row);
// перевод по умолчанию для новых видео (settings.subtitles); формат плашки
// (позиция/размер/вид-пресет); сдвиг синхронизации; свои субтитры; ASR;
// «Все настройки субтитров…» — страница duopulse://settings.
import type {
  AppliedTrackInfo,
  BaseTrackInfo,
  SubtitlesStyleInfo,
  TranslationLangInfo,
} from "../bridge/gen/types";
import { t } from "../i18n";
import { fromOptions, langRowState, toOptions } from "./langs-row";
import { CLOUD_LANGS } from "./cloud-langs";
import { LOOK_PRESETS, matchLookPreset } from "./look-presets";

/** Срез состояния активной вкладки (поля DuoState из duo.ts). */
export interface DuoMenuState {
  enabled: boolean;
  videoKey: string | null;
  tracks: AppliedTrackInfo[];
  base: BaseTrackInfo[];
  translations: TranslationLangInfo[];
  style: SubtitlesStyleInfo;
}

/** Payload команды ui_menu_open kind="duo": варианты с флагом current —
 * chrome_menu.rs печатает их в muda-меню (чекбоксы/подменю/разделители). */
export interface DuoMenuPayload {
  enabled: boolean;
  hasVideo: boolean;
  /** «Язык видео»: базовые дорожки платформы. */
  from: { id: string; name: string; current: boolean }[];
  /** «Перевод»: «Нет» + платформенные tlang + облачные (после разделителя). */
  to: { value: string; name: string; group: "none" | "platform" | "cloud"; current: boolean }[];
  /** Текущий и список «Перевода по умолчанию» (CLOUD_LANGS + свой код). */
  defLang: string;
  defLangs: { code: string; name: string }[];
  /** Формат плашки: позиция/размер/совпавший пресет вида (null — «Свои»). */
  style: { position: string; fontScalePct: number; look: string | null };
  lookPresets: { id: string; label: string }[];
}

/** Сборка payload меню по снапшоту вкладки и дефолтному языку настроек. */
export function buildDuoMenuPayload(state: DuoMenuState, defaultTranslationLang: string): DuoMenuPayload {
  const row = langRowState(state.tracks);
  const fromTrack = state.base.find((b) => b.id === row.fromId) ?? null;
  const from = fromOptions(state.base).map((o) => ({ ...o, current: o.id === row.fromId }));
  const currentTo =
    row.to.kind === "none" ? "" : row.to.kind === "platform" ? row.to.lang : `cloud:${row.to.lang}`;
  const to: DuoMenuPayload["to"] = [
    {
      value: "",
      name: state.base.length ? t("Нет (только оригинал)") : "—",
      group: "none",
      current: currentTo === "",
    },
    ...toOptions(
      state.translations,
      fromTrack ? { lang: fromTrack.lang, translatable: fromTrack.translatable } : null,
    ).map((o) => ({ ...o, current: o.value === currentTo })),
  ];
  // Применённый перевод может быть вне списка вариантов (tlang с подтегом —
  // как в селекте панели): добавляем, чтобы меню показывало фактическое.
  if (currentTo && !to.some((o) => o.value === currentTo)) {
    const cloud = currentTo.startsWith("cloud:");
    to.push({
      value: currentTo,
      name: cloud
        ? t("{lang} — облако", { lang: row.to.kind === "cloud" ? row.to.lang : currentTo })
        : currentTo,
      group: cloud ? "cloud" : "platform",
      current: true,
    });
  }
  const def = defaultTranslationLang.trim().toLowerCase();
  const defLangs = CLOUD_LANGS.map((l) => ({ code: l.code, name: l.name }));
  if (def && !defLangs.some((l) => l.code === def)) defLangs.push({ code: def, name: def });
  const look = matchLookPreset(state.style);
  return {
    enabled: state.enabled,
    hasVideo: !!state.videoKey,
    from,
    to,
    defLang: def,
    defLangs,
    style: {
      position: state.style.position,
      fontScalePct: state.style.fontScalePct,
      look: look?.id ?? null,
    },
    lookPresets: LOOK_PRESETS.map((p) => ({ id: p.id, label: p.label })),
  };
}

/** id дорожки пункта «Язык видео» по индексу (null — индекс мимо списка). */
export function menuFromId(payload: DuoMenuPayload, index: number): string | null {
  return payload.from[index]?.id ?? null;
}

/** Значение пункта «Перевод» по индексу (null — индекс мимо списка). */
export function menuToValue(payload: DuoMenuPayload, index: number): string | null {
  return payload.to[index]?.value ?? null;
}
