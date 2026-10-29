// Тексты статуса ASR-конвейера для duo-панели (карточка duopulse-060):
// субтитры события subtitles:asr_progress → человекочитаемая строка
// «Распознавание…», итог (готово/из кэша) и ошибки. Пустая строка — фаза
// без текста (decode неинформативен на полсекунды).

import type { SubtitlesAsrProgress } from "../bridge/gen/types";

/** МБ из байт (прогресс скачивания модели/аудио). */
function mb(bytes: number): string {
  return (bytes / 1_048_576).toFixed(bytes < 10 * 1_048_576 ? 1 : 0);
}

export function asrProgressText(p: SubtitlesAsrProgress): string {
  switch (p.phase) {
    case "model":
      return p.total > 0
        ? `Скачивание модели ASR… ${mb(p.done)} / ${mb(p.total)} МБ`
        : "Скачивание модели ASR…";
    case "audio":
      return p.total > 0
        ? `Скачивание аудио… ${mb(p.done)} / ${mb(p.total)} МБ`
        : "Скачивание аудио…";
    case "decode":
      return "Декодирование аудио…";
    case "transcribe":
      return p.total > 1
        ? `Распознавание… ${p.done} / ${p.total}`
        : "Распознавание речи…";
    case "done":
      return p.fromCache
        ? `Субтитры из кэша ASR (${p.done} реплик)`
        : `Готово: распознано ${p.done} реплик`;
    case "error":
      return p.error ? `ASR: ${p.error}` : "ASR: ошибка";
    default:
      return "";
  }
}
