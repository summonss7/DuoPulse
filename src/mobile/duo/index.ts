// Контроллер duo мобильной ветки (этап 2, duopulse-082): связывает сессию
// YouTube (список дорожек/загрузка cue/перевод gtx), часы YtClock, движок
// показа SubtitlesEngine (общий с десктопом) и плашку DuoOverlay. Живёт от
// открытия embed-видео до ухода с него; смена настроек пересобирает набор
// (поколение seq — Races между загрузками не смешивают результаты).

import { invoke } from "@tauri-apps/api/core";
import type { Track } from "../../../content/types";
import { SubtitlesEngine } from "../../../content/engine/subtitles-engine";
import { DuoOverlay } from "./overlay";
import { YtClock } from "./clock";
import {
  defaultOriginal,
  loadCuesByUrl,
  parsePlayerResponse,
  translateCueTable,
  type DuoInvoke,
  type MobileTrackList,
} from "./session";
import { loadDuoSettings, saveDuoSettings, type DuoMobileSettings } from "./state";
import { parseTranslationChoice } from "./state";

export interface DuoStatus {
  /** Сообщение для строки статуса панели (null — убрать). */
  text: string | null;
  /** Идёт загрузка (прогресс/спиннер панели). */
  busy: boolean;
}

export class MobileDuo {
  private settings: DuoMobileSettings = loadDuoSettings();
  private list: MobileTrackList | null = null;
  private videoId: string | null = null;
  private clock: YtClock | null = null;
  private seq = 0;
  private readonly engine = new SubtitlesEngine({ onRowsChange: (rows) => this.overlay.setRows(rows) });
  private readonly overlay: DuoOverlay;

  constructor(
    private readonly contentEl: HTMLElement,
    private readonly iframe: HTMLIFrameElement,
    private readonly onStatus: (s: DuoStatus) => void,
    private readonly doInvoke: DuoInvoke = invoke,
  ) {
    this.overlay = new DuoOverlay(contentEl);
    this.overlay.applySettings(this.settings);
    // Тест-хук смоука (как окно page e2e-стенда десктопа): состояние движка/часов.
    (window as unknown as { __duoDebug?: () => unknown }).__duoDebug = () => ({
      videoId: this.videoId,
      clockTime: this.clock?.currentTime ?? null,
      engine: this.engine.state(),
      settings: this.settings,
      baseCount: this.list?.base.length ?? 0,
    });
  }

  get currentSettings(): DuoMobileSettings {
    return this.settings;
  }

  get trackList(): MobileTrackList | null {
    return this.list;
  }

  /** Открылось YouTube-видео (embed). Загружает список дорожек и набор. */
  async open(videoId: string): Promise<void> {
    this.close(false);
    this.videoId = videoId;
    const seq = ++this.seq;
    this.onStatus({ text: "duo: читаю дорожки…", busy: true });
    try {
      const response = await this.doInvoke("duo_yt_player", { videoId });
      if (seq !== this.seq) return;
      const list = parsePlayerResponse(videoId, response);
      if (!list) {
        this.list = null;
        this.onStatus({ text: "duo: у видео нет субтитров", busy: false });
        return;
      }
      this.list = list;
      // Дефолты: оригинал — как у панели десктопа; сохранённый id жив, только
      // если это дорожка этого видео.
      if (!this.settings.originalId || !list.base.some((t) => t.id === this.settings.originalId)) {
        this.settings.originalId = defaultOriginal(list)?.id ?? null;
      }
      this.wireClock();
      await this.applySet(seq);
    } catch (e) {
      if (seq !== this.seq) return;
      this.onStatus({ text: `duo: ${messageOf(e)}`, busy: false });
    }
  }

  /** Видео закрыто/сменилось (full — выгрузить и панель). */
  close(full = true): void {
    this.seq++;
    this.engine.detach();
    this.engine.setTracks([]);
    this.clock?.detach();
    this.clock = null;
    this.videoId = null;
    this.list = null;
    this.onStatus({ text: null, busy: false });
    if (full) void 0;
  }

  /** Новые часы под текущий iframe (подписка плеера + детектор замерзания). */
  private wireClock(): void {
    this.clock = new YtClock(this.iframe, window, { onFrozen: () => this.heal() });
    this.engine.attach(this.clock);
    void this.clock.attach().catch(() => this.onStatus({ text: "duo: плеер недоступен для синхронизации", busy: false }));
  }

  /** Плеер YouTube замерз после сворачивания (см. шапку clock.ts): лечим
   * перезагрузкой iframe с autoplay=1&start=<позиция> — жест-политика в
   * RustWebView.kt отключена, плеер сам возобновляет воспроизведение с
   * прежней секунды со звуком; API-команд на разгоне не даём (пауза/игнор,
   * живой смоук 08.11). Часы подключаем СРАЗУ после присвоения src: плеер
   * iframe вещает своё «listening» один раз на загрузке — опоздавшая
   * подписка мертва (как в open/navigate). Автостарт срабатывает не сразу
   * после возврата из фона (WebView оживает асинхронно ~минуту, смоук) —
   * не заиграло за 8 с, повторяем перезагрузку с растущими паузами. Дорожки
   * движка и настройки не трогаем — duo-сессия продолжается. */
  private healing = false;
  private heal(round = 0): void {
    if (this.healing || !this.videoId || round >= HEAL_SETTLE_MS.length) return;
    this.healing = true;
    const seq = this.seq;
    const at = Math.max(0, Math.floor(this.clock?.currentTime ?? 0));
    setTimeout(() => {
      this.healing = false;
      if (seq !== this.seq || !this.videoId) return; // видео уже закрылось
      this.clock?.detach();
      this.clock = null;
      try {
        const u = new URL(this.iframe.src);
        u.searchParams.set("autoplay", "1");
        u.searchParams.set("start", String(at));
        this.iframe.src = u.toString(); // присвоение src = перезагрузка iframe
      } catch {
        this.iframe.src = this.iframe.src; // fallback: то же значение тоже перезагружает
      }
      this.wireClock();
      // проверка автостарта: играет ли/идёт ли время (мёртвый канал = 0)
      setTimeout(() => {
        if (seq !== this.seq || !this.videoId) return;
        const clock = this.clock;
        if (clock && !clock.playerPlaying && (Math.abs(clock.currentTime - at) < 1 || clock.currentTime < 1)) {
          this.heal(round + 1);
        }
      }, 8000);
    }, round === 0 ? HEAL_SETTLE_MS[0] : HEAL_SETTLE_MS[round]);
  }

  /** Патч настроек (панель): персист + пересборка набора/стиля. */
  update(patch: Partial<DuoMobileSettings>): void {
    this.settings = { ...this.settings, ...patch };
    saveDuoSettings(this.settings);
    this.overlay.applySettings(this.settings);
    this.engine.setOffset(this.settings.offsetMs);
    if (!this.settings.enabled) {
      this.engine.setTracks([]);
      return;
    }
    void this.applySet(++this.seq);
  }

  private async applySet(seq: number): Promise<void> {
    const list = this.list;
    if (!list || !this.settings.enabled || !this.settings.originalId) {
      this.engine.setTracks([]);
      if (list && this.settings.enabled && !this.settings.originalId) {
        this.onStatus({ text: "duo: нет дорожки оригинала", busy: false });
      }
      return;
    }
    const original = list.base.find((t) => t.id === this.settings.originalId);
    const baseUrl = original ? list.urls.get(original.id) : undefined;
    if (!original || !baseUrl) {
      this.onStatus({ text: "duo: дорожка оригинала недоступна", busy: false });
      return;
    }
    const duo = this;
    const signal = {
      get aborted(): boolean {
        return seq !== duo.seq;
      },
    };
    this.onStatus({ text: "duo: грузю субтитры…", busy: true });
    try {
      const cues = await loadCuesByUrl(this.doInvoke, baseUrl, signal);
      if (signal.aborted) return;
      // Оригинал — сразу: перевод добирается в фоне, сбой перевода не роняет
      // показ (честная деградация сообщением, критерий этапа 2).
      const tracks: Track[] = [
        { id: original.id, source: "youtube", lang: original.lang, role: "original", cues },
      ];
      this.engine.setTracks(tracks);
      const choice = parseTranslationChoice(this.settings.translation);
      if (choice.kind === "gtx" && choice.lang !== original.lang) {
        this.onStatus({ text: `duo: перевожу (${original.lang} → ${choice.lang})…`, busy: true });
        try {
          const translated = await translateCueTable(
            this.doInvoke,
            cues,
            original.lang,
            choice.lang,
            (done, total) => this.onStatus({ text: `duo: перевод ${Math.round((done / total) * 100)}%`, busy: true }),
            signal,
          );
          if (signal.aborted) return;
          tracks.push({
            id: `${original.id}+gtx:${choice.lang}`,
            source: "translate",
            lang: choice.lang,
            role: "translation",
            cues: translated,
            name: `Google → ${choice.lang}`,
          });
          this.engine.setTracks(tracks);
          this.onStatus({ text: null, busy: false });
        } catch (e) {
          if (signal.aborted) return;
          this.onStatus({ text: `duo: перевод недоступен (${messageOf(e)}) — показываю оригинал`, busy: false });
        }
      } else if (choice.kind === "track") {
        const trackInfo = list.base.find((t) => t.id === choice.baseId && t.id !== original.id);
        const trackUrl = trackInfo ? list.urls.get(trackInfo.id) : undefined;
        if (trackInfo && trackUrl) {
          const transCues = await loadCuesByUrl(this.doInvoke, trackUrl, signal);
          if (signal.aborted) return;
          tracks.push({
            id: trackInfo.id,
            source: "youtube",
            lang: trackInfo.lang,
            role: "translation",
            cues: transCues,
          });
          this.engine.setTracks(tracks);
          this.onStatus({ text: null, busy: false });
        } else {
          this.onStatus({ text: null, busy: false });
        }
      } else {
        this.onStatus({ text: null, busy: false });
      }
    } catch (e) {
      if (signal.aborted) return;
      this.engine.setTracks([]);
      this.onStatus({ text: `duo: ${messageOf(e)}`, busy: false });
    }
  }

  remove(): void {
    this.close();
    this.overlay.remove();
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Паузы перед перезагрузками плеера в heal (растущие: WebView после фона
 * оживает асинхронно — ранний автостарт не срабатывает, смоук 08.11). */
const HEAL_SETTLE_MS = [6000, 15000, 30000, 60000];
