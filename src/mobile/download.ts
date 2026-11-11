// Загрузка музыки с YouTube мобильной веткой (duopulse-121): кнопка «⬇» на
// экране видео зовёт Rust duo_download_music (тот же innertube-запрос, что у
// субтитров → лучшая аудиодорожка m4a → MediaStore «Music/DuoPulse»);
// прогресс приходит событием «duopulse:mobile-music-progress» и рисуется в
// строку статуса. Контроллер — как updater.ts: состояние + колбэк рендера,
// транспорт (invoke/listen) подменяется в тестах.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Состояние загрузки музыки (idle — кнопка просто не активна/нет видео). */
export interface MusicUiState {
  kind: "idle" | "downloading" | "done" | "error";
  /** downloading: скачано/всего байт (0 — размер неизвестен). */
  downloaded: number;
  total: number;
  /** done: имя файла · место; error: причина. */
  message: string;
}

export function idleMusicState(): MusicUiState {
  return { kind: "idle", downloaded: 0, total: 0, message: "" };
}

/** МБ с одним знаком: 4 083 640 → «4.0 МБ». */
export function mb(bytes: number): string {
  const v = bytes / (1024 * 1024);
  return `${v >= 10 || bytes === 0 ? Math.round(v) : v.toFixed(1)} МБ`;
}

/** Строка статуса по состоянию (тест): прогресс/итог/ошибка. */
export function musicStatusText(s: MusicUiState): string {
  if (s.kind === "downloading") {
    const pct = s.total ? Math.min(100, Math.round((s.downloaded / s.total) * 100)) : 0;
    const size = s.total ? ` (${mb(s.downloaded)} из ${mb(s.total)})` : "";
    return `♪ Музыка: качаю ${pct}%${size}`;
  }
  if (s.kind === "done") return `♪ Музыка сохранена: ${s.message}`;
  if (s.kind === "error") return `♪ Музыка: ${s.message}`;
  return "";
}

export interface MusicDownloader {
  /** Тап «⬇»: видео нет/загрузка идёт — короткая подсказка, иначе старт. */
  start(): void;
  /** Снимок состояния (e2e-стенды). */
  stateSnapshot(): MusicUiState;
}

/** Событие прогресса (payload события «duopulse:mobile-music-progress»). */
export interface MusicProgressEvent {
  payload: { videoId: string; downloaded: number; total: number };
}

/** Узкая сигнатура listen (фейк в тестах совпадает с реальным транспортом). */
export type MusicListenFn = (
  name: string,
  handler: (e: MusicProgressEvent) => void,
) => Promise<UnlistenFn>;

export interface MusicPorts {
  getVideoId: () => string | null;
  render: (s: MusicUiState) => void;
  /** Транспорт invoke (фейк в тестах; сигнатура — как у invoke из core). */
  doInvoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  doListen?: MusicListenFn;
}

/** Собрать контроллер загрузки музыки (подписка на прогресс — один раз). */
export function createMusicDownloader(opts: MusicPorts): MusicDownloader {
  const doInvoke = opts.doInvoke ?? invoke;
  const doListen: MusicListenFn = opts.doListen ?? listen;
  let state = idleMusicState();
  const render = (s: MusicUiState): void => {
    state = s;
    opts.render(s);
  };
  void doListen("duopulse:mobile-music-progress", (e) => {
    if (state.kind !== "downloading") return;
    render({
      kind: "downloading",
      downloaded: e.payload.downloaded ?? 0,
      total: e.payload.total ?? 0,
      message: "",
    });
  }).then((un: UnlistenFn) => {
    if (typeof window === "undefined") return;
    // контроллер живёт всю сессию приложения — отписка не нужна, ссылку держим
    // для сборщика мусора честности ради (стенды проверяют снапшот, не слушателя)
    (window as unknown as { __duopulseMusicUnlisten?: UnlistenFn }).__duopulseMusicUnlisten = un;
  });
  return {
    start() {
      const videoId = opts.getVideoId();
      if (state.kind === "downloading") {
        opts.render(state); // повторный тап — просто показать текущий прогресс
        return;
      }
      if (!videoId) {
        render({ kind: "error", downloaded: 0, total: 0, message: "откройте видео YouTube" });
        return;
      }
      render({ kind: "downloading", downloaded: 0, total: 0, message: "" });
      void doInvoke<string>("duo_download_music", { videoId })
        .then((r) =>
          render({ kind: "done", downloaded: 0, total: 0, message: typeof r === "string" ? r : "" }),
        )
        .catch((e) =>
          render({
            kind: "error",
            downloaded: 0,
            total: 0,
            message: e instanceof Error ? e.message : String(e),
          }),
        );
    },
    stateSnapshot: () => state,
  };
}
