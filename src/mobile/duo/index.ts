// Контроллер duo мобильной ветки (этап 2, duopulse-082): связывает сессию
// YouTube (список дорожек/загрузка cue/перевод gtx), часы YtClock, движок
// показа SubtitlesEngine (общий с десктопом) и плашку DuoOverlay. Живёт от
// открытия embed-видео до ухода с него; смена настроек пересобирает набор
// (поколение seq — Races между загрузками не смешивают результаты).

import { invoke } from "@tauri-apps/api/core";
import { t } from "../../i18n";
import type { Cue, Track } from "../../../content/types";
import { SubtitlesEngine } from "../../../content/engine/subtitles-engine";
import { DuoOverlay } from "./overlay";
import { YtClock } from "./clock";
import {
  defaultOriginal,
  loadCuesByUrl,
  parsePlayerResponse,
  titleOfPlayerResponse,
  translateCueTable,
  type DuoInvoke,
  type MobileTrackList,
} from "./session";
import { loadDuoSettings, saveDuoSettings, type DuoMobileSettings } from "./state";
import { parseTranslationChoice } from "./state";
import {
  asrProgressText,
  createMobileAsr,
  type AsrProgressEvent,
  type AsrRunResult,
  type LocalModelSizeId,
  type MobileAsr,
  type MobileAsrSettings,
} from "./asr";

export interface DuoStatus {
  /** Сообщение для строки статуса панели (null — убрать). */
  text: string | null;
  /** Идёт загрузка (прогресс/спиннер панели). */
  busy: boolean;
  /** Ошибка, а не прогресс (панель красит строку; до duopulse-138 ловили
   *  префикс «duo: перев» — переведённый текст префиксом не опишешь). */
  error?: boolean;
}

export class MobileDuo {
  private settings: DuoMobileSettings = loadDuoSettings();
  private list: MobileTrackList | null = null;
  private videoId: string | null = null;
  /** Заголовок видео (videoDetails player-ответа) — живёт и без дорожек
   * (закладки duopulse-104 берут имя отсюда). */
  private title = "";
  private clock: YtClock | null = null;
  private seq = 0;
  private readonly engine = new SubtitlesEngine({ onRowsChange: (rows) => this.overlay.setRows(rows) });
  private readonly overlay: DuoOverlay;
  /** ASR-контроллер (duopulse-167) и его дорожки: asr:<lang> → cues. */
  private readonly asr: MobileAsr;
  private readonly asrCues = new Map<string, Cue[]>();
  private asrBusy = false;
  /** Поколение прогона ASR (duopulse-182): «Отмена»/новый тап инвалидирует
   *  старый — его finally/статусы не трогают флаг и строку нового прогона. */
  private asrRun = 0;
  /** Последний статус (duopulse-182): повторная эмуляция в finally
   *  recognizeSpeech возвращает кнопку детерминированно — событие done Core
   *  может прийти раньше конца цепочки applySet, и панель не узнаёт, что
   *  конвейер освободился. */
  private lastStatus: DuoStatus | null = null;
  /** Последний снимок настроек ASR (панель спрашивает при открытии). */
  private asrSettingsSnap: MobileAsrSettings | null = null;

  constructor(
    private readonly contentEl: HTMLElement,
    /** Плеер какой вкладки сейчас активен (вкладок много — duopulse-123). */
    private readonly getFrame: () => HTMLIFrameElement | null,
    private readonly onStatus: (s: DuoStatus) => void,
    private readonly doInvoke: DuoInvoke = invoke,
  ) {
    this.overlay = new DuoOverlay(contentEl);
    this.overlay.applySettings(this.settings);
    // ASR (duopulse-167): контроллер конвейера — тот же транспорт фетчера
    // iframe, что у загрузок музыки; порты подменяются в тестах.
    this.asr = createMobileAsr({ getFrame, doInvoke });
    // Тест-хук смоука (как окно page e2e-стенда десктопа): состояние движка/часов.
    (window as unknown as { __duoDebug?: () => unknown }).__duoDebug = () => ({
      videoId: this.videoId,
      clockTime: this.clock?.currentTime ?? null,
      engine: this.engine.state(),
      settings: this.settings,
      baseCount: this.list?.base.length ?? 0,
      asr: this.asr.stateSnapshot(),
      asrTracks: [...this.asrCues.keys()],
    });
  }

  get currentSettings(): DuoMobileSettings {
    return this.settings;
  }

  get trackList(): MobileTrackList | null {
    return this.list;
  }

  /** Заголовок открытого видео (пусто — ещё не прочитан/видео закрыто). */
  get currentTitle(): string {
    return this.title;
  }

  /** id открытого видео (null — видео закрыто); закладки (duopulse-104)
   *  собирают из него watch-url. */
  get currentVideoId(): string | null {
    return this.videoId;
  }

  /** ASR-конвейер занят (кнопка ↔ отмена в панели). */
  get isAsrBusy(): boolean {
    return this.asrBusy;
  }

  /** Настройки ASR для панели (снимок обновляет loadAsrSettings). */
  get asrSettingsView(): MobileAsrSettings | null {
    return this.asrSettingsSnap;
  }

  /** Подтянуть настройки ASR из Core (панель зовёт при открытии). */
  async loadAsrSettings(): Promise<MobileAsrSettings | null> {
    try {
      this.asrSettingsSnap = await this.asr.loadSettings();
    } catch {
      this.asrSettingsSnap = null; // Core недоступен — панель покажет дефолты
    }
    return this.asrSettingsSnap;
  }

  /** Сохранить настройки (панель) + обновить снимок. */
  async saveAsrSettings(patch: Parameters<MobileAsr["saveSettings"]>[0]): Promise<MobileAsrSettings> {
    const s = await this.asr.saveSettings(patch);
    this.asrSettingsSnap = s;
    return s;
  }

  /** Скачать модель локального движка (duopulse-168; прогресс — событием). */
  async downloadModel(size: LocalModelSizeId): Promise<void> {
    await this.asr.downloadModel(size);
  }

  /** Удалить модель локального движка + обновить снимок настроек. */
  async deleteModel(size: LocalModelSizeId): Promise<MobileAsrSettings> {
    const s = await this.asr.deleteModel(size);
    this.asrSettingsSnap = s;
    return s;
  }

  /** Событие прогресса конвейера (subtitles:asr_progress; tabId = videoId):
   * статус панели — той же строкой, что на десктопе. Поздний done (событие
   * Core доставляется после того, как applySet уже показал ошибку перевода —
   * офлайн-отказ быстрее доставки) не затирает ошибку: «Субтитры из кэша»
   * поверх «перевод недоступен» прячет причину (duopulse-182). */
  onAsrProgress(p: AsrProgressEvent): void {
    if (!this.videoId || (p.tabId && p.tabId !== this.videoId)) return;
    const text = asrProgressText(p);
    if (!text) return;
    if (p.phase === "done" && this.lastStatus?.error && !this.lastStatus.busy) return;
    this.emit({
      text,
      busy: p.phase !== "done" && p.phase !== "error",
      error: p.phase === "error",
    });
  }

  /** Единственная точка исхода статусов: запоминаем последний — повторная
   * эмуляция в finally recognizeSpeech возвращает кнопку конвейера. */
  private emit(s: DuoStatus): void {
    this.lastStatus = s;
    this.onStatus(s);
  }

  /** «Распознать речь» (duopulse-167): конвейер Core (кэш → аудио фетчером
   * iframe → облако) → дорожка asr:<lang> в списке и показе. Повторный тап
   * при занятом конвейере игнорируется (отмена — отдельной кнопкой).
   * asrBusy держится до конца применения набора (перевод включительно) —
   * но перевод имеет таймаут/отмену (duopulse-182), «занят вечно» невозможен. */
  async recognizeSpeech(): Promise<void> {
    const videoId = this.videoId;
    if (!videoId || this.asrBusy) return;
    const run = ++this.asrRun;
    this.asrBusy = true;
    this.emit({ text: t("Распознавание запущено…"), busy: true });
    try {
      const r: AsrRunResult = await this.asr.recognize(videoId, "");
      const lang = r.lang || "auto";
      const trackId = `asr:${lang}`;
      this.asrCues.set(trackId, r.cues);
      if (!this.list) {
        this.list = {
          videoId,
          title: this.title,
          base: [],
          translations: [],
          urls: new Map(),
          originalLangs: new Set(),
        };
      }
      this.list.base = [
        ...this.list.base.filter((x) => x.id !== trackId),
        {
          id: trackId,
          lang,
          name: lang === "auto" ? "ASR" : `ASR · ${lang}`,
          kind: "asr",
          vssId: "",
          translatable: false,
          original: true,
        },
      ];
      this.settings.originalId = trackId;
      this.settings.enabled = true;
      saveDuoSettings(this.settings);
      // Видео без дорожек не подключало часы (open выходит до wireClock —
      // «нет субтитров»): дорожка ASR появилась, а реплики не рисуются.
      // YT.Player поверх живого iframe работает и поздним подключением.
      if (!this.clock) this.wireClock();
      await this.applySet(++this.seq);
    } catch (e) {
      if (run !== this.asrRun) return; // прогон уже отменён — статусы отдаёт cancelAsr
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === t("распознавание отменено")) {
        this.emit({ text: t("duo: распознавание отменено"), busy: false });
      } else {
        this.emit({ text: t("duo: {message}", { message: msg }), busy: false, error: true });
      }
    } finally {
      if (run === this.asrRun) {
        this.asrBusy = false;
        // Кнопка возвращается здесь, а не «когда событие done Core обгонит
        // цепочку»: повторяем последний статус — панель перечитает занятость.
        this.emit(this.lastStatus ?? { text: null, busy: false });
      }
    }
  }

  /** «Отмена» панели: поколение в Core + флаг транспорта фетчера; фаза
   * применения (перевод в applySet) гасится поколением seq — конвейер
   * освобождается в ЛЮБОЙ фазе, а не только пока качается аудио (duopulse-182:
   * раньше тап в фазе перевода ничего не делал — кнопка висела «Отмена»). */
  cancelAsr(): void {
    if (!this.videoId) return;
    this.asr.cancel(this.videoId);
    if (!this.asrBusy) return;
    this.asrRun++; // старому прогону запрет трогать флаг/статусы
    this.seq++; // сигнал applySet: перевод бросит «перевод отменён» на границе пачки/в гонке вызова
    this.asrBusy = false;
    this.emit({ text: t("duo: распознавание отменено"), busy: false });
  }

  /** Открылось YouTube-видео (embed). Загружает список дорожек и набор. */
  async open(videoId: string): Promise<void> {
    this.close(false);
    this.videoId = videoId;
    const seq = ++this.seq;
    this.emit({ text: t("duo: читаю дорожки…"), busy: true });
    try {
      const response = await this.doInvoke("duo_yt_player", { videoId });
      if (seq !== this.seq) return;
      this.title = titleOfPlayerResponse(response);
      const list = parsePlayerResponse(videoId, response);
      if (!list) {
        this.list = null;
        this.emit({ text: t("duo: у видео нет субтитров"), busy: false, error: true });
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
      this.emit({ text: t("duo: {message}", { message: messageOf(e) }), busy: false, error: true });
    }
  }

  /** Видео закрыто/сменилось (full — выгрузить и панель). */
  close(full = true): void {
    this.cancelAsr(); // конвейер ASR этого видео больше не актуален
    this.seq++;
    this.engine.detach();
    this.engine.setTracks([]);
    this.clock?.detach();
    this.clock = null;
    this.videoId = null;
    this.list = null;
    this.title = "";
    this.asrCues.clear();
    this.asrBusy = false;
    this.emit({ text: null, busy: false });
    if (full) void 0;
  }

  /** Новые часы под активный iframe (подписка плеера + детектор замерзания). */
  private wireClock(): void {
    const frame = this.getFrame();
    if (!frame) return;
    this.clock = new YtClock(frame, window, { onFrozen: () => this.heal() });
    this.engine.attach(this.clock);
    void this.clock.attach().catch(() => this.emit({ text: t("duo: плеер недоступен для синхронизации"), busy: false, error: true }));
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
        const frame = this.getFrame();
        if (!frame) return;
        const u = new URL(frame.src);
        u.searchParams.set("autoplay", "1");
        u.searchParams.set("start", String(at));
        frame.src = u.toString(); // присвоение src = перезагрузка iframe
      } catch {
        const frame = this.getFrame();
        if (frame) frame.src = frame.src; // fallback: то же значение тоже перезагружает
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
        this.emit({ text: t("duo: нет дорожки оригинала"), busy: false, error: true });
      }
      return;
    }
    const original = list.base.find((tr) => tr.id === this.settings.originalId);
    const baseUrl = original ? list.urls.get(original.id) : undefined;
    // Дорожка ASR (duopulse-167): cues уже в памяти (кэш Core/конвейер), URL
    // у неё нет — скачивать нечего.
    const asrCues = original ? this.asrCues.get(original.id) : undefined;
    if (!original || (!baseUrl && !asrCues)) {
      this.emit({ text: t("duo: дорожка оригинала недоступна"), busy: false, error: true });
      return;
    }
    const duo = this;
    const signal = {
      get aborted(): boolean {
        return seq !== duo.seq;
      },
    };
    this.emit({ text: t("duo: грузю субтитры…"), busy: true });
    try {
      const cues = asrCues ?? (await loadCuesByUrl(this.doInvoke, baseUrl!, signal));
      if (signal.aborted) return;
      // Оригинал — сразу: перевод добирается в фоне, сбой перевода не роняет
      // показ (честная деградация сообщением, критерий этапа 2).
      const tracks: Track[] = [
        {
          id: original.id,
          // Дорожка ASR — свой источник (кэш/конвейер, не платформа)
          source: original.id.startsWith("asr:") ? "asr" : "youtube",
          lang: original.lang,
          role: "original",
          cues,
        },
      ];
      this.engine.setTracks(tracks);
      const choice = parseTranslationChoice(this.settings.translation);
      if (choice.kind === "gtx" && choice.lang !== original.lang) {
        this.emit({
          text: t("duo: перевожу ({from} → {to})…", { from: original.lang, to: choice.lang }),
          busy: true,
        });
        try {
          const translated = await translateCueTable(
            this.doInvoke,
            cues,
            original.lang,
            choice.lang,
            (done, total) =>
              this.emit({
                text: t("duo: перевод {pct}%", { pct: String(Math.round((done / total) * 100)) }),
                busy: true,
              }),
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
          this.emit({ text: null, busy: false });
        } catch (e) {
          if (signal.aborted) return;
          this.emit({
            text: t("duo: перевод недоступен ({reason}) — показываю оригинал", { reason: messageOf(e) }),
            busy: false,
            // duopulse-182: честная ошибка строки статуса (панель красит),
            // а не молчаливое «занято» без конца конвейера
            error: true,
          });
        }
      } else if (choice.kind === "track") {
        const trackInfo = list.base.find((tr) => tr.id === choice.baseId && tr.id !== original.id);
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
          this.emit({ text: null, busy: false });
        } else {
          this.emit({ text: null, busy: false });
        }
      } else {
        this.emit({ text: null, busy: false });
      }
    } catch (e) {
      if (signal.aborted) return;
      this.engine.setTracks([]);
      this.emit({ text: t("duo: {message}", { message: messageOf(e) }), busy: false, error: true });
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
