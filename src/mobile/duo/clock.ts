// Часы duo мобильной ветки (этап 2, duopulse-082): время видео из плеера
// embed-iframe через IFrame Player API (postMessage, кросс-доменно) в форме
// VideoLike движка показа (content/engine/subtitles-engine.ts — как
// video.currentTime на десктопе, только опросом): «timeupdate» ~6,7 Гц,
// «seeked» эмитим на смене состояния плеера (перематывание/пауза-возврат),
// скачки движок детектит и сам (SEEK_JUMP_MS).
//
// Ротация: WebView не перезагружается (активити переживает configChanges),
// опрос продолжается, дрейфа нет (единственный источник правды, docs/03 §4).
// Сворачивание: живой смоук 08.11 показал — после ухода в фон WebView-плеер
// YouTube ЗАМИРАЕТ (кадр статичен, тапы по контролам не доходят, время стоит,
// повторяемо даже после 3 с фона; страница-родитель при этом жива). Лечение —
// перезагрузка iframe с autoplay=1&start=<позиция> (MediaPlaybackRequires
// UserGesture отключён в RustWebView.kt, плеер сам стартует с нужной секунды
// со звуком; ЛЮБАЯ API-команда на разгоне — seek/unMute/playVideo — встреча-
// ется паузой/игнором, поэтому после лечения плеер не трогаем вовсе).
// Запускает лечение детектор замерзания здесь: onFrozen → MobileDuo.heal
// (дорожки движка и настройки duo-сессии не пересобираются).

import type { VideoLike } from "../../../content/engine/subtitles-engine";
import { t } from "../../i18n";

/** Минимальный плеер IFrame API (типы @types/youtube не тянем). */
interface YtPlayer {
  getCurrentTime(): number;
  getPlayerState(): number;
  destroy(): void;
}
interface YtNamespace {
  Player: new (el: HTMLElement, opts: Record<string, unknown>) => YtPlayer;
}
type YtWindow = Window & { YT?: YtNamespace; onYouTubeIframeAPIReady?: () => void };

/** Порог детектора замерзания: «плеер играет, а время не идёт» дольше — лечим.
 * 5 с — выше типичного буферизационного затыка (state=buffering детектор
 * игнорирует), ниже терпимого для пользователя зависания. */
export const FREEZE_MS = 5000;

/** Чистое ядро детектора: новый момент последнего прогресса (мс стены).
 * Прогресс времени / пауза (state≠1) / скрытая страница — «свежий» (детектор
 * разряжен); «играет, но время стоит» на видимой странице — прежний (копится
 * к порогу). Логика живого смоука: замерзший плеер отдаёт кэш state=playing. */
export function freezeStep(lastAdvanceAt: number, now: number, timeDelta: number, playerState: number, visible: boolean): number {
  if (!visible || playerState !== 1 || timeDelta > 0.01) return now;
  return lastAdvanceAt;
}

const API_SRC = "https://www.youtube.com/iframe_api";
const POLL_MS = 150;

/** Однократная загрузка скрипта API (общий промис на страницу). */
function loadYtApi(win: YtWindow): Promise<YtNamespace> {
  if (win.YT?.Player) return Promise.resolve(win.YT);
  const w = win as { __duoYtApiPromise?: Promise<YtNamespace> };
  if (w.__duoYtApiPromise) return w.__duoYtApiPromise;
  w.__duoYtApiPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(t("IFrame API не загрузился"))), 15_000);
    const prev = win.onYouTubeIframeAPIReady;
    win.onYouTubeIframeAPIReady = () => {
      prev?.();
      clearTimeout(timer);
      if (win.YT?.Player) resolve(win.YT);
      else reject(new Error(t("YT.Player не появился")));
    };
    const s = win.document.createElement("script");
    s.src = API_SRC;
    s.async = true;
    s.onerror = () => {
      clearTimeout(timer);
      reject(new Error(t("скрипт IFrame API недоступен (сеть?)")));
    };
    win.document.head.appendChild(s);
  });
  return w.__duoYtApiPromise;
}

type Listener = () => void;

/** Опции часов: onFrozen — плеер замерз после фона (см. шапку), лечит владелец. */
export interface YtClockOptions {
  onFrozen?: () => void;
}

/** Часы видео из embed-плеера. */
export class YtClock implements VideoLike {
  currentTime = 0;
  private readonly listeners: Record<"timeupdate" | "seeked", Set<Listener>> = { timeupdate: new Set(), seeked: new Set() };
  private player: YtPlayer | null = null;
  private timer: number | null = null;
  private attachSeq = 0;
  private frozen = false;
  private lastState = -1;
  private lastTime = -1;
  private lastAdvanceAt = 0;
  private hideWasActive = false;
  private readonly onFrozen?: () => void;

  constructor(
    private readonly iframe: HTMLIFrameElement,
    private readonly win: YtWindow = window as YtWindow,
    options: YtClockOptions = {},
  ) {
    this.onFrozen = options.onFrozen;
    // Вторая половина детектора (первая — в тике опроса): YouTube при уходе
    // в фон сам ставит паузу (state=2), тик-детектор по state=1 её не видит.
    // Здесь: играло при уходе (время недавно шло) → вернулись и за порог
    // не ожило → замерзание.
    this.win.document.addEventListener("visibilitychange", this.onVisibility);
  }

  private onVisibility = (): void => {
    if (this.win.document.visibilityState === "hidden") {
      this.hideWasActive = Date.now() - this.lastAdvanceAt < 2000;
      return;
    }
    if (!this.hideWasActive) return;
    // Кэш API замерзшего плеера врёт и по state («играет»/«пауза»), поэтому
    // решаем по медиа-времени: играло при уходе, а после возврата за порог
    // не сдвинулось (замерз или YouTube-пауза фона) — лечим (heal заодно
    // возобновляет показ autoplay-перезагрузкой).
    const timeAtVisible = this.currentTime;
    this.win.setTimeout(() => {
      if (
        !this.frozen &&
        this.win.document.visibilityState === "visible" &&
        Math.abs(this.currentTime - timeAtVisible) < 0.01
      ) {
        this.frozen = true;
        this.onFrozen?.();
      }
    }, FREEZE_MS + 1000);
  };

  /** Плеер в состоянии «играет» (проверка лечения; кэш API — сам источник
   * детектора, поэтому без try нет смысла). */
  get playerPlaying(): boolean {
    try {
      return this.player?.getPlayerState() === 1;
    } catch {
      return false;
    }
  }

  addEventListener(type: string, listener: Listener): void {
    if (type === "timeupdate" || type === "seeked") this.listeners[type].add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    if (type === "timeupdate" || type === "seeked") this.listeners[type].delete(listener);
  }

  /** Подписаться на плеер iframe (enablejsapi=1 в src — platform.ts). */
  async attach(): Promise<void> {
    const seq = ++this.attachSeq;
    const YT = await loadYtApi(this.win);
    if (seq !== this.attachSeq) return; // успели отсоединиться/переподключиться
    this.player = new YT.Player(this.iframe, {
      events: {
        onReady: () => this.startPolling(),
        onStateChange: () => this.emit("seeked"), // перемотка/пауза — пересчёт сразу
      },
    });
    this.startPolling(); // onReady мог прийти раньше подписки — тикаем и так
  }

  private startPolling(): void {
    if (this.timer !== null) return;
    this.lastAdvanceAt = Date.now();
    this.timer = this.win.setInterval(() => {
      if (!this.player) return;
      const now = Date.now();
      let time = Number.NaN;
      try {
        time = this.player.getCurrentTime();
        this.lastState = this.player.getPlayerState();
      } catch {
        /* плеер недоступен (замерз/видео сменилось): время оставляем кэш,
           а детектор ниже ловит это по отсутствию прогресса */
      }
      const visible = this.win.document.visibilityState === "visible";
      if (!Number.isNaN(time)) {
        this.currentTime = time;
        this.lastAdvanceAt = freezeStep(this.lastAdvanceAt, now, time - this.lastTime, this.lastState, visible);
        this.lastTime = time;
      }
      // NaN-ветка тоже под детектором: getCurrentTime мёртвого канала кидает,
      // кэш state при этом может врать «играет» — решает только время.
      if (
        !this.frozen &&
        visible &&
        this.lastState === 1 &&
        now - this.lastAdvanceAt > FREEZE_MS
      ) {
        this.frozen = true;
        this.onFrozen?.();
      }
      this.emit("timeupdate");
    }, POLL_MS);
  }

  private emit(type: "timeupdate" | "seeked"): void {
    for (const l of this.listeners[type]) l();
  }

  /** Отсоединиться (плеер НЕ destroy: он живёт в iframe со страницей). */
  detach(): void {
    this.attachSeq++;
    if (this.timer !== null) {
      this.win.clearInterval(this.timer);
      this.timer = null;
    }
    this.win.document.removeEventListener("visibilitychange", this.onVisibility);
    this.player = null;
  }
}
