// Пресеты внешнего вида плашки (карточка duopulse-059): быстрые наборы
// цветов строк/подложки + обводка, переключаются чипами в duo-панели и
// заполняют форму дефолтов на странице настроек. Применяются обычным патчем
// subtitles.set_style — content-оверлей знает только значения (модель в
// content/overlay/style.ts), сами пресеты живут в chrome-слое.
//
// Пресеты обязаны читаться на светлом видео (задача): у всех включена
// обводка и заметная непрозрачность подложки; «фирменный» — вид по гайду
// 06 §6 (дефолт DEFAULT_SUBTITLE_STYLE).

/** Поля стиля, задаваемые пресетом вида (геометрию — размер/позицию/отступ —
 *  пресет не трогает: это отдельные настройки). */
export interface LookPatch {
  originalColor: string;
  translationColor: string;
  mutedColor: string;
  plateColor: string;
  textStroke: boolean;
  plateOpacity: number;
}

export interface LookPreset {
  id: string;
  label: string;
  patch: LookPatch;
}

export const LOOK_PRESETS: readonly LookPreset[] = [
  {
    id: "brand",
    label: "Фирменный",
    patch: {
      originalColor: "#ffffff",
      translationColor: "#bdfe4f",
      mutedColor: "#ffffff",
      plateColor: "#0a0e17",
      textStroke: true,
      plateOpacity: 0.78,
    },
  },
  {
    id: "mono",
    label: "Ч/б контраст",
    patch: {
      originalColor: "#ffffff",
      translationColor: "#e6e6e6",
      mutedColor: "#b3b3b3",
      plateColor: "#000000",
      textStroke: true,
      plateOpacity: 0.9,
    },
  },
  {
    id: "tv",
    label: "Жёлтый TV",
    patch: {
      originalColor: "#ffdd33",
      translationColor: "#ffffff",
      mutedColor: "#ffdd33",
      plateColor: "#000000",
      textStroke: true,
      plateOpacity: 0.85,
    },
  },
];

/** Стиль панели (SubtitlesStyleInfo контракта): поля вида для сравнения. */
export interface LookSource {
  originalColor: string;
  translationColor: string;
  mutedColor: string;
  plateColor: string;
  textStroke: boolean;
  plateOpacity: number;
}

/** Пресет, чьи значения вид совпадает со стилем (все 6 полей патча); null —
 *  пользовательские цвета («Свои»). Прозрачность входит в сравнение: крутили
 *  её отдельно — пресет честно слетает. */
export function matchLookPreset(style: LookSource): LookPreset | null {
  for (const p of LOOK_PRESETS) {
    const q = p.patch;
    if (
      style.originalColor === q.originalColor &&
      style.translationColor === q.translationColor &&
      style.mutedColor === q.mutedColor &&
      style.plateColor === q.plateColor &&
      style.textStroke === q.textStroke &&
      Math.abs(style.plateOpacity - q.plateOpacity) < 0.001
    ) {
      return p;
    }
  }
  return null;
}
