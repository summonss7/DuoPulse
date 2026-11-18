// ASR-контроллер мобильного duo (карточка duopulse-167, паритет 4/8):
// «Распознать речь» для видео без дорожек субтитров — облачный
// OpenAI-совместимый провайдер. Конвейер распределён так же, как загрузки
// музыки (duopulse-122): Core (Rust mobile_asr.rs) держит настройки
// (ключ — Android Keystore), кэш asr_tracks и транскрипцию; медиа-байты
// googlevideo качает фетчер ВНУТРИ embed-iframe (dl-fetcher.js —
// закрытые Range-диапазоны, движок/куки/TLS WebView: нативному ureq с
// устройства googlevideo отдаёт 403) и приносит их чанками командой
// subtitles_asr_audio_append. Прогресс конвейера — событием
// subtitles:asr_progress (tabId несёт videoId), подписка — subscribeAsrProgress.

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t } from "../../i18n";
import type { DlTransport } from "../download";
import { fetchViaTransport, iframeTransport, pingFetcher, toB64, type DlGuard } from "../download";

/** Транспорт invoke (в тестах — фейк). */
export type AsrInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Cue конвейера (camelCase, как DuoCue Rust). */
export interface AsrCueRow {
  startMs: number;
  endMs: number;
  text: string;
}

/** Итог конвейера: дорожка asr:<lang>. */
export interface AsrRunResult {
  cues: AsrCueRow[];
  lang: string;
  fromCache: boolean;
  /** Идентификатор движка («openai:whisper-1»). */
  engine: string;
}

/** Ответ subtitles_asr_start: кэш-хит (готовые cues, сети не было) или
 * задание на скачивание аудио (URL/размер — Core их добыл из player-ответа). */
export type AsrStartResult =
  | ({ status: "done" } & AsrRunResult)
  | { status: "needAudio"; url: string; size: number };

/** Настройки ASR мобильной ветки (asr_get_settings; локальный движок —
 * duopulse-168: whisper.cpp в APK, модель ggml в профиле устройства). */
export interface MobileAsrSettings {
  enabled: boolean;
  /** "cloud" | "local". */
  provider: string;
  openaiBaseUrl: string;
  openaiModel: string;
  hasApiKey: boolean;
  /** Выбранная модель локального движка: "tiny" | "base". */
  localModel: string;
  /** ggml-tiny скачана (размер сверен). */
  modelTinyDownloaded: boolean;
  /** ggml-base скачана. */
  modelBaseDownloaded: boolean;
  /** Локальный провайдер готов: выбранная модель скачана. */
  localReady: boolean;
}

/** Аргументы asr_set_settings: ключ — None не менять, "" удалить;
 * provider/localModel — опции локального движка (duopulse-168). */
export interface MobileAsrSettingsPatch {
  enabled: boolean;
  openaiBaseUrl: string;
  openaiModel: string;
  apiKey?: string;
  provider?: string;
  localModel?: string;
}

/** Размер модели локального движка. */
export type LocalModelSizeId = "tiny" | "base";

/** Модели локального движка для UI (порядок — как в настройках). */
export const LOCAL_MODELS: { id: LocalModelSizeId; label: string }[] = [
  { id: "tiny", label: "tiny · 78 МБ" },
  { id: "base", label: "base · 148 МБ" },
];

/** Payload события subtitles:asr_model_progress (менеджер моделей). */
export interface AsrModelProgressEvent {
  size: LocalModelSizeId;
  /** download | done | error. */
  phase: string;
  done: number;
  total: number;
  error?: string;
}

/** Текст статуса менеджера моделей (строка настроек ASR). */
export function asrModelProgressText(p: AsrModelProgressEvent): string {
  const mbv = (bytes: number): string =>
    (bytes / 1_048_576).toFixed(bytes < 10 * 1_048_576 ? 1 : 0);
  switch (p.phase) {
    case "download":
      return p.total > 0
        ? t("Скачивание модели… {done} / {total} МБ", { done: mbv(p.done), total: mbv(p.total) })
        : t("Скачивание модели…");
    case "done":
      return t("Модель скачана и проверена");
    case "error":
      return p.error ? t("Модель: {e}", { e: p.error }) : t("ASR: ошибка");
    default:
      return "";
  }
}

/** Payload события subtitles:asr_progress (мобильная ветка: tabId = videoId). */
export interface AsrProgressEvent {
  tabId: string;
  videoKey: string;
  engine: string;
  /** audio | decode | transcribe | done | error (model — десктоп). */
  phase: string;
  done: number;
  total: number;
  fromCache: boolean;
  error?: string;
}

/** Текст статуса конвейера для строки duo-панели (порт десктопного
 * asr-status.ts; фаза model локальному провайдеру не встречается, но
 * обрабатывается — форма события общая). Пустая строка — фаза без текста. */
export function asrProgressText(p: AsrProgressEvent): string {
  const mbv = (bytes: number): string =>
    (bytes / 1_048_576).toFixed(bytes < 10 * 1_048_576 ? 1 : 0);
  switch (p.phase) {
    case "model":
      return p.total > 0
        ? t("Скачивание модели ASR… {done} / {total} МБ", { done: mbv(p.done), total: mbv(p.total) })
        : t("Скачивание модели ASR…");
    case "audio":
      return p.total > 0
        ? t("Скачивание аудио… {done} / {total} МБ", { done: mbv(p.done), total: mbv(p.total) })
        : t("Скачивание аудио…");
    case "decode":
      return t("Декодирование аудио…");
    case "transcribe":
      return p.total > 1
        ? t("Распознавание… {done} / {total}", { done: String(p.done), total: String(p.total) })
        : t("Распознавание речи…");
    case "done":
      return p.fromCache
        ? t("Субтитры из кэша ASR ({n} реплик)", { n: String(p.done) })
        : t("Готово: распознано {n} реплик", { n: String(p.done) });
    case "error":
      return p.error ? t("ASR: {e}", { e: p.error }) : t("ASR: ошибка");
    default:
      return "";
  }
}

export interface MobileAsrPorts {
  /** Embed-плеер (iframe youtube) — транспорт скачивания аудио. */
  getFrame: () => HTMLIFrameElement | null;
  /** Транспорт invoke (фейк в тестах). */
  doInvoke?: AsrInvoke;
  /** Транспорт к фетчеру iframe (в тестах — фейк). */
  transport?: DlTransport;
  /** Таймаут рукопожатия с фетчером, мс. */
  pingTimeoutMs?: number;
}

export interface MobileAsr {
  /** Полный прогон: start → (кэш | скачивание аудио фетчером + append) →
   * finish. Отмена — cancel() (отражается на await-ящихся recognize). */
  recognize(videoId: string, lang: string): Promise<AsrRunResult>;
  /** Отменить активный прогон (поколение в Core + флаг транспорта). */
  cancel(videoId: string): void;
  loadSettings(): Promise<MobileAsrSettings>;
  saveSettings(patch: MobileAsrSettingsPatch): Promise<MobileAsrSettings>;
  /** Скачать модель локального движка (прогресс — событием asr_model). */
  downloadModel(size: LocalModelSizeId): Promise<void>;
  /** Удалить модель локального движка (движок выгружается в Core). */
  deleteModel(size: LocalModelSizeId): Promise<MobileAsrSettings>;
  /** Снимок для e2e/диагностики. */
  stateSnapshot(): { busy: boolean; videoId: string | null; lastError: string | null };
}

/** Собрать ASR-контроллер duo (порты подменяются в тестах). */
export function createMobileAsr(opts: MobileAsrPorts): MobileAsr {
  const doInvoke = opts.doInvoke ?? tauriInvoke;
  const transport = opts.transport ?? iframeTransport(opts.getFrame);
  const pingTimeoutMs = opts.pingTimeoutMs ?? 2500;
  let guard: DlGuard | null = null;
  let busyVideoId: string | null = null;
  let lastError: string | null = null;

  return {
    async recognize(videoId: string, lang: string): Promise<AsrRunResult> {
      // guard назначается ДО первого await: cancel сразу после старта тоже
      // должен гасить прогон (иначе синхронная отмена — no-op до needAudio)
      const g: DlGuard = { cancelled: false };
      guard = g;
      try {
        const start = (await doInvoke("subtitles_asr_start", { videoId, lang })) as AsrStartResult;
        if (!start || typeof start !== "object") throw new Error(t("ASR: ошибка"));
        if (start.status === "done") return start;
        // needAudio: байты качает фетчер iframe теми же закрытыми диапазонами,
        // что и загрузки музыки (duopulse-122), чанки уходят в Core
        busyVideoId = videoId;
        if (g.cancelled) throw new Error(t("распознавание отменено"));
        await pingFetcher(transport, pingTimeoutMs);
        try {
          await fetchViaTransport(
            transport,
            start.url,
            async (chunk) => {
              await doInvoke("subtitles_asr_audio_append", { videoId, b64: toB64(chunk) });
            },
            g,
            start.size,
          );
        } catch (e) {
          // фетчер говорит «загрузка отменена» — для ASR это отмена распознавания
          if (g.cancelled) throw new Error(t("распознавание отменено"));
          throw e;
        }
        if (g.cancelled) throw new Error(t("распознавание отменено"));
        const done = (await doInvoke("subtitles_asr_audio_finish", { videoId, lang })) as AsrRunResult;
        if (!done || !Array.isArray(done.cues)) throw new Error(t("ASR: ошибка"));
        lastError = null;
        return done;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        if (guard === g) guard = null;
        if (busyVideoId === videoId) busyVideoId = null;
      }
    },

    cancel(videoId: string): void {
      if (guard) guard.cancelled = true;
      busyVideoId = null;
      void doInvoke("subtitles_asr_cancel", { videoId }).catch(() => {});
    },

    async loadSettings(): Promise<MobileAsrSettings> {
      return (await doInvoke("asr_get_settings", {})) as MobileAsrSettings;
    },

    async saveSettings(patch: MobileAsrSettingsPatch): Promise<MobileAsrSettings> {
      return (await doInvoke("asr_set_settings", {
        args: {
          enabled: patch.enabled,
          openaiBaseUrl: patch.openaiBaseUrl,
          openaiModel: patch.openaiModel,
          apiKey: patch.apiKey ?? null,
          provider: patch.provider ?? "cloud",
          localModel: patch.localModel ?? "tiny",
        },
      })) as MobileAsrSettings;
    },

    async downloadModel(size: LocalModelSizeId): Promise<void> {
      await doInvoke("asr_model_download", { size });
    },

    async deleteModel(size: LocalModelSizeId): Promise<MobileAsrSettings> {
      return (await doInvoke("asr_model_delete", { size })) as MobileAsrSettings;
    },

    stateSnapshot() {
      return { busy: busyVideoId !== null, videoId: busyVideoId, lastError };
    },
  };
}

/** Подписка на прогресс конвейера (событие Core; отписка — возврат). */
export function subscribeAsrProgress(
  onEvent: (p: AsrProgressEvent) => void,
): () => void {
  return subscribePayload("subtitles:asr_progress", onEvent);
}

/** Подписка на прогресс менеджера моделей локального движка (duopulse-168). */
export function subscribeAsrModelProgress(
  onEvent: (p: AsrModelProgressEvent) => void,
): () => void {
  return subscribePayload("subtitles:asr_model_progress", onEvent);
}

function subscribePayload<T>(event: string, onEvent: (p: T) => void): () => void {
  let unlisten: (() => void) | null = null;
  let alive = true;
  void listen<T>(event, (e) => onEvent(e.payload))
    .then((u) => {
      if (!alive) u();
      else unlisten = u;
    })
    .catch(() => {});
  return () => {
    alive = false;
    unlisten?.();
  };
}
