// Тексты статуса ASR-конвейера для duo-панели (карточка duopulse-060):
// субтитры события subtitles:asr_progress → человекочитаемая строка
// «Распознавание…», итог (готово/из кэша) и ошибки. Пустая строка — фаза
// без текста (decode неинформативен на полсекунды).

import type { SubtitlesAsrProgress } from "../bridge/gen/types";
import { t } from "../i18n";

/** МБ из байт (прогресс скачивания модели/аудио). */
function mb(bytes: number): string {
  return (bytes / 1_048_576).toFixed(bytes < 10 * 1_048_576 ? 1 : 0);
}

export function asrProgressText(p: SubtitlesAsrProgress): string {
  switch (p.phase) {
    case "model":
      return p.total > 0
        ? t("Скачивание модели ASR… {done} / {total} МБ", { done: mb(p.done), total: mb(p.total) })
        : t("Скачивание модели ASR…");
    case "audio":
      return p.total > 0
        ? t("Скачивание аудио… {done} / {total} МБ", { done: mb(p.done), total: mb(p.total) })
        : t("Скачивание аудио…");
    case "decode":
      return t("Декодирование аудио…");
    case "transcribe":
      return p.total > 1
        ? t("Распознавание… {done} / {total}", { done: p.done, total: p.total })
        : t("Распознавание речи…");
    case "done":
      return p.fromCache
        ? t("Субтитры из кэша ASR ({n} реплик)", { n: p.done })
        : t("Готово: распознано {n} реплик", { n: p.done });
    case "error":
      return p.error ? t("ASR: {e}", { e: p.error }) : t("ASR: ошибка");
    default:
      return "";
  }
}
