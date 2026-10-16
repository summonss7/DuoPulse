// Движок показа субтитров (задача 3.2, docs/03 §4). Часы — только
// video.currentTime (единственный источник правды: смена качества/скорости
// не рассинхронизируют показ, собственного таймера нет). Подписки — timeupdate
// (непрерывное воспроизведение, ~4 Гц) и seeked (скачок по таймлайну);
// покадровая точность (requestVideoFrameCallback) — задача 3.5.
//
// Скачок отличается от непрерывного показа (docs/03 §4): cue, в котором при
// скачке осталось < 150 мс, не показывается («пропущенные» реплики не мигают);
// при непрерывном показе реплика висит до конца (активный cue не срывается).
//
// offsetMs — сдвиг пользователя: положительный = субтитры позже, применяется
// одинаково ко всем дорожкам набора (±10 с, docs/03 §4; слайдер/клавиши — 3.5).

import type { Cue, Track } from "../types";
import { CueTimeline } from "./timeline";

/** Cue, в котором при скачке осталось меньше этого, не показывается. */
export const MIN_REMAINING_AFTER_SEEK_MS = 150;
/** Скачок времени: |Δt| больше этого между выборками = seek (даже если событие
 * seeked не пришло — например, страница перевела currentTime программно). */
export const SEEK_JUMP_MS = 250;
/** Предел сдвига пользователя (docs/03 §4: ±10 с). */
export const OFFSET_LIMIT_MS = 10_000;

/** Строка плашки = активный cue дорожки; порядок = порядок дорожек набора. */
export interface ActiveRow {
  trackId: string;
  text: string;
}

export interface SubtitlesEngineEvents {
  /** Активный набор строк изменился (перерисовка только по смене набора,
   * docs/03 §5 — не на каждый кадр). rows = [] — плашка скрыта. */
  onRowsChange(rows: ActiveRow[]): void;
}

interface BoundTrack {
  track: Track;
  timeline: CueTimeline;
  /** Cue, скрытый правилом 150 мс при последнем скачке: непрерывный показ не
   * «вспыхивает» его обратно на оставшиеся миллисекунды (docs/03 §4). */
  suppressed: Cue | null;
}

/** Минимальный видео-интерфейс движка (упрощает тесты без DOM). */
export interface VideoLike {
  currentTime: number;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export class SubtitlesEngine {
  private readonly events: SubtitlesEngineEvents;
  private tracks: BoundTrack[] = [];
  private video: VideoLike | null = null;
  private offsetMs = 0;
  private rows: ActiveRow[] = [];
  private lastTimeMs: number | null = null;

  constructor(events: SubtitlesEngineEvents) {
    this.events = events;
  }

  /** Набор дорожек (1–3 в v1, порядок = порядок строк на плашке). */
  setTracks(tracks: Track[]): void {
    this.tracks = tracks.map((track) => ({ track, timeline: CueTimeline.build(track.cues), suppressed: null }));
    this.tick(true);
  }

  /** Сдвиг пользователя, мс: положительный — показывать позже. */
  setOffset(offsetMs: number): void {
    this.offsetMs = Math.max(-OFFSET_LIMIT_MS, Math.min(OFFSET_LIMIT_MS, Math.round(offsetMs)));
    this.tick(true);
  }

  getOffset(): number {
    return this.offsetMs;
  }

  /** Привязать часы: подписки на timeupdate/seeked + немедленный пересчёт. */
  attach(video: VideoLike): void {
    if (this.video === video) return;
    this.detach();
    this.video = video;
    this.lastTimeMs = null;
    video.addEventListener("timeupdate", this.onTimeUpdate);
    video.addEventListener("seeked", this.onSeeked);
    this.tick(true);
  }

  detach(): void {
    if (!this.video) return;
    this.video.removeEventListener("timeupdate", this.onTimeUpdate);
    this.video.removeEventListener("seeked", this.onSeeked);
    this.video = null;
    this.lastTimeMs = null;
    this.setRows([]);
  }

  private readonly onTimeUpdate = (): void => {
    this.tick();
  };

  private readonly onSeeked = (): void => {
    this.tick(true);
  };

  /** Пересчёт активных строк; jumped — правило 150 мс для скачков. */
  private tick(jumped = false): void {
    if (!this.video || this.tracks.length === 0) {
      this.setRows([]);
      return;
    }
    const t = this.video.currentTime * 1000;
    if (!jumped && this.lastTimeMs !== null && Math.abs(t - this.lastTimeMs) > SEEK_JUMP_MS) {
      jumped = true; // программный перевод currentTime без события seeked
    }
    this.lastTimeMs = t;
    const shifted = t - this.offsetMs;
    const rows: ActiveRow[] = [];
    for (const bound of this.tracks) {
      const cue = bound.timeline.activeAt(shifted);
      if (cue && jumped) {
        // Скачок: хвост реплики короче порога не показываем и запоминаем,
        // чтобы непрерывный показ не вспыхнул его на остаток (docs/03 §4).
        bound.suppressed = cue.endMs - shifted < MIN_REMAINING_AFTER_SEEK_MS ? cue : null;
      }
      if (!cue || cue === bound.suppressed || !cue.text) continue;
      rows.push({ trackId: bound.track.id, text: cue.text });
    }
    this.setRows(rows);
  }

  private setRows(rows: ActiveRow[]): void {
    const same =
      rows.length === this.rows.length &&
      rows.every((r, i) => r.trackId === this.rows[i].trackId && r.text === this.rows[i].text);
    if (same) return;
    this.rows = rows;
    this.events.onRowsChange(rows);
  }

  /** Диагностика (e2e-стенд, окно page): состояние движка. */
  state(): {
    trackCount: number;
    offsetMs: number;
    activeRows: ActiveRow[];
    attached: boolean;
  } {
    return {
      trackCount: this.tracks.length,
      offsetMs: this.offsetMs,
      activeRows: this.rows,
      attached: this.video !== null,
    };
  }
}
