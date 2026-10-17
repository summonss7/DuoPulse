// Интерфейсы платформенных адаптеров дорожек (задача 3.3, docs/05 §1:
// content/adapters/types.ts — «интерфейс Adapter { listTracks(), version,
// paths[] }»). Адаптер инкапсулирует ВСЕ знания о платформе (docs/03 §9):
// остальной content-слой работает только с абстракциями ниже и Track.
//
// Живучесть (docs/03 §9): версия адаптера + цепочка путей добычи
// primary → fallback; в результате фиксируется сработавший путь.

import type { Cue, Track } from "../types";

/** Выбираемая дорожка: идентификатор из списка адаптера + параметры добычи. */
export interface TrackRef {
  /** id из AdapterTrackList.base / сборный для перевода ("yt:en", "yt:en+ru"). */
  id: string;
  lang: string;
  role: "original" | "translation";
  source: "youtube";
  /** Дорожка-источник перевода (id базовой) — только для role=translation. */
  baseId?: string;
  /** Код языка для программирования плеера — только для role=original. */
  languageCode?: string;
}

/** Базовая дорожка из player-ответа (оригинал/ручная/asr). */
export interface BaseTrackInfo {
  id: string;
  lang: string;
  /** Отображаемое имя (локализовано платформой). */
  name: string;
  kind: "manual" | "asr";
  /** vssId дорожки (".en" ручная / "a.en" asr) — для диагностики. */
  vssId: string;
  translatable: boolean;
  /** Дорожка языка оригинала (audioTracks.original player-ответа). */
  original: boolean;
}

/** Язык машинного перевода (tlang): применяется к базовой дорожке. */
export interface TranslationLangInfo {
  lang: string;
  name: string;
}

/** Полный список дорожек видео (docs/03 §3.1: включая переводы и asr). */
export interface AdapterTrackList {
  adapter: "youtube";
  version: string;
  /** Сработавший путь добычи (docs/03 §9: player-api | initial | texttrack). */
  usedPath: string;
  base: BaseTrackInfo[];
  translations: TranslationLangInfo[];
  warnings: string[];
}

/** Результат загрузки выбранных дорожек: успешные в порядке выбора +
 * пофактовые отказы (дорожки не «умирают» целиком — docs/03 §9). */
export interface LoadedTracks {
  tracks: Track[];
  failures: { ref: TrackRef; reason: string }[];
  /** Путь добычи, сработавший последним (диагностика). */
  usedPath: string;
}

/** Порт разбора payload → cues. Канонические парсеры — в Core (задача 3.1);
 * транспорт — WebMessage; тесты подменяют реализацией на фикстурах. */
export interface SubtitlesParser {
  parse(payload: string): Promise<{ cues: Cue[]; warnings: string[] }>;
}

/** Порты загрузки (все знания о странице/DOM — в реализации по умолчанию;
 * тесты подменяют). */
export interface LoadPorts {
  fetchImpl?: typeof fetch;
  parser: SubtitlesParser;
}

/** Адаптер платформы (docs/05 §1). */
export interface Adapter {
  readonly id: "youtube";
  readonly version: string;
  /** Цепочка путей добычи по приоритету (docs/03 §9). */
  readonly paths: readonly string[];
  matches(href: string): boolean;
  listTracks(): Promise<AdapterTrackList | null>;
  /** Загрузить выбранные 2–3 дорожки (docs/03 §1) как cue-таблицы. */
  loadTracks(refs: TrackRef[], ports: LoadPorts): Promise<LoadedTracks>;
}
