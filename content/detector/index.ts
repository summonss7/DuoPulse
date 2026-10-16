// Детектор <video> на странице (задача 3.2, docs/02 §4, docs/03 §5): первичный
// скан + MutationObserver (видео появляется/уходит динамически — YouTube-плеер
// строит DOM скриптом, SPA-переходы меняют страницу без перезагрузки) + опрос
// location.href (SPA-переход меняет URL без события — ключ видео пересчитывается).
//
// Ключевое видео одно: с наибольшей площадью прямоугольника (превью-плееры
// YouTube маленькие); при уходе ключевого видео из DOM — рескан. События
// детектора идемпотентны: повторный onVideo с тем же ключом не эмитится.

import { videoKeyFor } from "./videoKey";

export interface DetectedVideo {
  el: HTMLVideoElement;
  videoKey: string;
  url: string;
}

export interface DetectorEvents {
  onVideo(video: DetectedVideo): void;
  /** Ключевое видео ушло из DOM (удалено/заменено при SPA-переходе). */
  onVideoLost(): void;
}

/** Интервал опроса URL (SPA-переходы без перезагрузки, напр. yt-navigate). */
const URL_POLL_MS = 500;

export class VideoDetector {
  private readonly events: DetectorEvents;
  private current: DetectedVideo | null = null;
  private observer: MutationObserver | null = null;
  private urlPoll: number | null = null;
  private scanScheduled = false;
  private lastUrl = "";
  private started = false;

  constructor(events: DetectorEvents) {
    this.events = events;
  }

  start(): void {
    if (typeof document === "undefined" || this.started) return;
    this.started = true;
    this.lastUrl = location.href;
    // Initialization script исполняется до разбора документа — <html> ещё
    // может не существовать (observe(null) бросает TypeError). Корня нет —
    // ждём DOMContentLoaded; начальный скан после разбора ловит видео из
    // исходной разметки, последующие добавления — MutationObserver.
    if (document.documentElement) this.begin();
    else document.addEventListener("DOMContentLoaded", this.begin, { once: true });
  }

  private readonly begin = (): void => {
    const root = document.documentElement;
    if (!root) return;
    // Пачки мутаций разбора документа сглаживаем в один скан на кадр.
    this.observer = new MutationObserver(() => this.scheduleScan());
    this.observer.observe(root, { childList: true, subtree: true });
    this.urlPoll = window.setInterval(() => this.checkUrlChange(), URL_POLL_MS);
    this.scan();
  };

  stop(): void {
    document.removeEventListener("DOMContentLoaded", this.begin);
    this.observer?.disconnect();
    this.observer = null;
    if (this.urlPoll !== null) {
      window.clearInterval(this.urlPoll);
      this.urlPoll = null;
    }
    this.current = null;
    this.started = false;
  }

  getCurrent(): DetectedVideo | null {
    return this.current;
  }

  private scheduleScan(): void {
    if (this.scanScheduled) return;
    this.scanScheduled = true;
    const run = (): void => {
      this.scanScheduled = false;
      this.scan();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  /** Пересчёт: текущее видео ушло → onVideoLost + поиск нового; ключ текущего
   * видео мог уточниться (loadedmetadata → длительность) — обновляем на месте. */
  private scan(): void {
    if (this.current && !this.current.el.isConnected) {
      this.current = null;
      this.events.onVideoLost();
    }
    if (!this.current) {
      const el = this.pickVideo();
      if (el) {
        const key = videoKeyFor(location.href, durationOf(el));
        this.current = { el, videoKey: key, url: location.href };
        this.watchMetadata(el);
        this.events.onVideo(this.current);
      }
    }
  }

  /** Ключевое видео: наибольшая площадь прямоугольника (>0), иначе первое. */
  private pickVideo(): HTMLVideoElement | null {
    const videos = Array.from(document.querySelectorAll("video"));
    let best: HTMLVideoElement | null = null;
    let bestArea = 0;
    for (const el of videos) {
      const r = el.getBoundingClientRect();
      const area = Math.max(0, r.width) * Math.max(0, r.height);
      if (area > bestArea) {
        best = el;
        bestArea = area;
      }
    }
    if (best) return best;
    return videos[0] ?? null;
  }

  /** Длительность появляется после loadedmetadata — уточняем ключ (URL+duration,
   * docs/03 §6) и переэмитим, если изменился. */
  private watchMetadata(el: HTMLVideoElement): void {
    const refine = (): void => {
      if (this.current?.el !== el) return;
      const key = videoKeyFor(location.href, durationOf(el));
      if (key !== this.current.videoKey) {
        this.current.videoKey = key;
        this.events.onVideo(this.current);
      }
    };
    if (Number.isFinite(el.duration)) refine();
    else el.addEventListener("loadedmetadata", refine, { once: true });
  }

  /** SPA-переход: URL сменился без перезагрузки — ключ пересчитать; видео
   * YouTube при этом обычно пересоздаётся (ловит MutationObserver), но даже
   * если элемент пережил переход, его ключ уже другой. */
  private checkUrlChange(): void {
    if (location.href === this.lastUrl) return;
    this.lastUrl = location.href;
    if (!this.current) {
      this.scan();
      return;
    }
    const key = videoKeyFor(location.href, durationOf(this.current.el));
    if (key !== this.current.videoKey) {
      this.current.videoKey = key;
      this.current.url = location.href;
      this.events.onVideo(this.current);
    }
  }
}

function durationOf(el: HTMLVideoElement): number | undefined {
  const d = el.duration;
  return Number.isFinite(d) && d > 0 ? d : undefined;
}
