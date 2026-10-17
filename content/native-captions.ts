// Гашение нативных субтитров платформы, пока активен наш показ (docs/03 §2:
// рендерим сами, нативные гасим — только на время показа, состояние страницы
// возвращается при выключении). Два механизма:
// - generic: <video>.textTracks в режиме showing переводятся в hidden —
//   браузер перестаёт рендерить <track>-субтитры, cue-события для страницы
//   живы; исходные режимы восстанавливаются при возврате;
// - YouTube: CSS-класс на <html> скрывает DOM-слой субтитров плеера
//   (blankYouTubeCaptions — селектор знает только адаптер, docs/03 §9);
//   CSS переживёт перезагрузку captions-модуля плеером и не мешает добыче
//   дорожек программированием плеера.

import { blankYouTubeCaptions, isYouTubeHref, type DocumentLike } from "./adapters/youtube";

/** Минимальный список textTracks (структурная типизация — тесты без DOM). */
export interface TextTracksLike {
  length: number;
  [index: number]: { mode: string };
}

/** Видео с textTracks (реальный HTMLVideoElement подходит структурно). */
export interface VideoWithTextTracks {
  textTracks: TextTracksLike;
}

export interface NativeCaptionsOptions {
  /** Документ страницы (CSS-гашение YouTube-слоя плеера). */
  doc: DocumentLike;
  /** href страницы на момент операции: YouTube-страницы гасятся классом. */
  href(): string;
}

export class NativeCaptionsBlanker {
  private readonly opts: NativeCaptionsOptions;
  /** Скрытые нами режимы showing (восстанавливаются при возврате). */
  private hidden: { track: { mode: string }; wasMode: string }[] = [];
  private ytClassOn = false;

  constructor(opts: NativeCaptionsOptions) {
    this.opts = opts;
  }

  get blanked(): boolean {
    return this.hidden.length > 0 || this.ytClassOn;
  }

  /** Скрыть нативные субтитры (наш показ стал активен). Повторный вызов с
   * другим видео пере применяет generic-часть к нему. */
  blank(video: VideoWithTextTracks | null): void {
    this.restoreGeneric();
    if (video) {
      const tracks = video.textTracks;
      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i];
        if (track.mode === "showing") {
          this.hidden.push({ track, wasMode: track.mode });
          track.mode = "hidden";
        }
      }
    }
    if (isYouTubeHref(this.opts.href())) {
      blankYouTubeCaptions(this.opts.doc, true);
      this.ytClassOn = true;
    }
  }

  /** Вернуть нативный показ (наш показ выключен — docs/03 §2). */
  restore(): void {
    this.restoreGeneric();
    if (this.ytClassOn) {
      blankYouTubeCaptions(this.opts.doc, false);
      this.ytClassOn = false;
    }
  }

  private restoreGeneric(): void {
    for (const { track, wasMode } of this.hidden) track.mode = wasMode;
    this.hidden = [];
  }
}
