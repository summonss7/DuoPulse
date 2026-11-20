// Модель данных content-слоя субтитров (docs/03 §6, content-зеркало Cue из
// src-tauri/src/subtitles). Поле videoKey живёт на стороне Core (кэш/события),
// движку показа оно не нужно — здесь дорожка это только идентичность + cue.

/** Единица субтитра: полуинтервал [startMs, endMs) + текст (строки через \n). */
export interface Cue {
  startMs: number;
  endMs: number;
  text: string;
}

/** Источник дорожки (docs/03 §3): платформенные адаптеры (YouTube; «embed» —
 * плеер-фреймы кино-сайтов, duopulse-199), ручной файл, перевод (M4),
 * распознавание речи (карточка duopulse-060); «test» — тест-хук e2e-стенда
 * (задача 3.2). */
export type TrackSource = "youtube" | "embed" | "file" | "translate" | "asr" | "test";

export interface Track {
  id: string; // "yt:en:orig", "file:ru", …
  source: TrackSource;
  lang: string; // BCP-47
  role: "original" | "translation";
  cues: Cue[]; // могут перекрываться — смёржит таймлайн движка (docs/03 §4)
  /** Отображаемое имя, если источник его знает (облачный перевод —
   * «DeepL → ru», задача 4.2); отсутствие — панель выведет из id/языка. */
  name?: string;
  /** Реплики верхнего расположения (карточка duopulse-178: .ass \an7/8/9 —
   * знаки/заголовки поверх кадра): их startMs; парсер Core отдаёт списком,
   * движок матчит по start активного cue, оверлей рисует в плашке-верху. */
  topStarts?: number[];
}
