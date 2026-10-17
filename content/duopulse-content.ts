// DuoPulse content-бандл — вход (задача 3.2, docs/05 §1: content/duopulse-content.ts).
// Собирается в один IIFE без зависимостей (scripts/build-content.mjs → esbuild →
// content/gen/duopulse-content.js) и инжектируется initialization_script'ом в
// каждый документ контентной вкладки (до скриптов страницы, docs/02 §4).
//
// M3: детектор <video> → событие page:video_detected в Core (WebMessage →
// bridge, docs/05 §2) → движок cue-таймлайна (часы video.currentTime) → оверлей.
// Задача 3.3: YouTube-адаптер — полный список дорожек из player-ответа (пути
// player-api → initial → texttrack, docs/03 §9) + загрузка выбранного набора
// 2–3 дорожек (оригинал + переводы tlang) в движок. На YouTube-страницах до
// скриптов страницы ставится перехват fetch/XHR: тела timedtext-ответов плеера
// (с PO-токеном) — источник данных адаптера; разбор тел — канонический в Core
// (WebMessage parse-subtitles, парсеры задачи 3.1).
//
// Выбор дорожек (до панели настроек 3.7): custom-событие
// duopulse-select-tracks {detail:{ids:[…]}} или окно
// __duopulseContent.selectTracks(ids) — id из tracksInfo() («yt:en»,
// «yt:en+ru», голый код перевода — база по умолчанию). Тест-хуки 3.2
// (duopulse-test-track/-offset) остаются для e2e-стенда не-YouTube страниц;
// оверлей 3.4 добавляет duopulse-test-style {detail:{position|fontScalePct|
// marginPct|plateOpacity}} и Shift+колесо (сдвиг).
//
// Синхронизация (задача 3.5, docs/03 §4 п.3, §8): сдвиг ±10 с шагом 100 мс —
// Shift+колесо по плашке, горячие клавиши Alt+[ (раньше) / Alt+] (позже),
// команда Core subtitles.set_offset (eval активной вкладки диспатчит
// duopulse-set-offset {detail:{offsetMs}}); каждое изменение применяет
// движок без перезагрузки дорожек и показывает HUD со слайдером. Набор
// дорожек привязан к videoKey: пересоздание <video> с тем же ключом (смена
// качества у ряда плееров) набор не теряет — реплика не пропадает.
//
// Ручные файлы (задача 3.6, docs/03 §3.2): drag&drop 1–3 файлов .srt/.vtt на
// страницу с <video> (content/adapters/file.ts; разбор — канонический в Core)
// и панельный путь subtitles.load_file (Core читает файл с диска и доставляет
// cue событием duopulse-file-track). Файловые дорожки — в общем наборе с
// дорожками платформы (docs/01 F-06): платформенные + файловые, до 3 строк.

import { VideoDetector, type DetectedVideo } from "./detector";
import { SubtitlesEngine, type ActiveRow } from "./engine/subtitles-engine";
import { SubtitlesOverlay } from "./overlay/overlay";
import type { SubtitleStyle } from "./overlay/style";
import { OffsetHud, stepOffset } from "./overlay/hud";
import { NativeCaptionsBlanker } from "./native-captions";
import { postToCore } from "./messaging";
import { createCoreParser } from "./messaging/parse";
import {
  YouTubeAdapter,
  installTimedtextCapture,
  isYouTubeHref,
  type PageWindow,
} from "./adapters/youtube";
import type { AdapterTrackList } from "./adapters/types";
import {
  FileDropZone,
  buildFileTracks,
  combinedTracks,
  fileTrackFrom,
  langOfFileName,
  type FileLoadResult,
} from "./adapters/file";
import type { Cue, Track } from "./types";

(function (): void {
  "use strict";
  const w = window as unknown as { __DUOPULSE_SUBTITLES__?: boolean };
  if (w.__DUOPULSE_SUBTITLES__) return; // бандл исполняется один раз на документ
  w.__DUOPULSE_SUBTITLES__ = true;

  const pageWindow = window as unknown as PageWindow;
  let currentVideo: DetectedVideo | null = null;
  // Перехват тел timedtext: только на YouTube (initialization script до
  // скриптов страницы; кросс-доменная навигация = новый документ = новый бандл).
  const capture = isYouTubeHref(location.href) ? installTimedtextCapture(pageWindow) : undefined;
  const adapter = new YouTubeAdapter({
    win: pageWindow,
    getVideo: () => currentVideo?.el ?? null,
    capture,
  });

  const engine = new SubtitlesEngine({
    onRowsChange(rows: ActiveRow[]): void {
      if (rows.length > 0 && currentVideo) overlay.show(rows, currentVideo.el);
      else overlay.hide();
    },
  });

  const overlay = new SubtitlesOverlay({
    // Shift+колесо над плашкой — шаг сдвига синхронизации (docs/03 §8, 100 мс).
    onOffsetStep: (direction) => stepOffsetBy(direction),
  });

  /** HUD синхронизации (задача 3.5): слайдер ±10 с/шаг 100 + индикация. */
  const hud = new OffsetHud({
    onSet: (offsetMs) => setOffset(offsetMs),
  });

  /** Единая точка применения сдвига (docs/03 §4: ко всему набору, без
   * перезагрузки дорожек): любой источник — клавиши, колесо, слайдер, IPC. */
  const setOffset = (offsetMs: number): void => {
    engine.setOffset(offsetMs);
    if (currentVideo) {
      // HUD — на свободном краю видео (противоположном плашке субтитров).
      const side = overlay.styleInfo().position === "top" ? "bottom" : "top";
      hud.show(engine.getOffset(), currentVideo.el, side);
    }
  };

  const stepOffsetBy = (direction: number): void => {
    if (engine.state().trackCount === 0) return;
    setOffset(stepOffset(engine.getOffset(), direction));
  };

  // Гашение нативных субтитров платформы, пока активен наш показ (docs/03 §2).
  const blanker = new NativeCaptionsBlanker({ doc: document, href: () => location.href });

  /** Набор текущего видео из двух частей (задача 3.6): платформенная
   * (адаптер/тест-хук) и файловая (drag&drop/subtitles.load_file). Итог —
   * платформенные + файловые до 3 строк (docs/03 §1); дроп замещает файловую
   * часть целиком. Переживает пересоздание <video> с тем же ключом — смена
   * качества: таймлайн тот же, дорожки те же, docs/03 §4. Память — последние
   * ключи (LRU): возврат к видео восстанавливает обе части. */
  let platformTracks: Track[] = [];
  let fileTracks: Track[] = [];
  const setMemory = new Map<string, { platform: Track[]; files: Track[] }>();
  const SET_MEMORY_LIMIT = 8;

  /** Единая точка смены набора: движок + гашение нативного показа. */
  const applyTracks = (tracks: Track[]): void => {
    engine.setTracks(tracks);
    if (tracks.length > 0) blanker.blank(currentVideo?.el ?? null);
    else blanker.restore();
  };

  /** Применить и запомнить текущее разбиение набора за текущим видео. */
  const applySet = (): void => {
    const { tracks, droppedFiles } = combinedTracks(platformTracks, fileTracks);
    if (droppedFiles > 0) {
      // Файлы сверх лимита набора отброшены — телеметрия для диагностики.
      postToCore({
        duopulse: "file-tracks",
        videoKey: currentVideo?.videoKey ?? "",
        applied: fileTracks.length,
        dropped: droppedFiles,
      });
    }
    applyTracks(tracks);
    if (currentVideo) {
      const key = currentVideo.videoKey;
      setMemory.delete(key); // LRU: освежить порядок
      setMemory.set(key, { platform: platformTracks, files: fileTracks });
      while (setMemory.size > SET_MEMORY_LIMIT) {
        setMemory.delete(setMemory.keys().next().value as string);
      }
    }
  };

  const parser = createCoreParser();
  let trackList: AdapterTrackList | null = null;
  let listSeq = 0;

  const reportDetected = (video: DetectedVideo, canTracks: boolean): void => {
    // Событие контракта page:video_detected (docs/05 §2): Core эмитит его в UI
    // (main.rs → bridge::emit). canTracks — по факту списка адаптера (3.3).
    postToCore({ duopulse: "video", videoKey: video.videoKey, canTracks });
  };

  /** Список дорожек YouTube-видео: после детекта (player-ответ может отставать
   * на SPA — listTracks ждёт); переотчёт при смене видео отбрасывается. */
  const onYouTubeVideo = (video: DetectedVideo): void => {
    const seq = ++listSeq;
    void adapter.listTracks().then((list) => {
      if (seq !== listSeq || currentVideo?.videoKey !== video.videoKey) return;
      trackList = list;
      const canTracks = (list?.base.length ?? 0) > 0;
      reportDetected(video, canTracks);
      if (list) {
        // Журнал Core до сервис-обвязки subtitles.* (задачи 3.5–3.7).
        postToCore({
          duopulse: "tracks",
          videoKey: video.videoKey,
          path: list.usedPath,
          base: list.base.length,
          translations: list.translations.length,
        });
      }
    });
  };

  /** Загрузка выбранного набора (id из tracksInfo()) в движок. Смена видео
   * во время загрузки — результат не применяется (дорожки прошлого видео);
   * файловая часть набора не трогается (смешивание, docs/01 F-06). */
  const selectTracks = async (
    ids: string[],
  ): Promise<{ loaded: number; failures: { id: string; reason: string }[]; unknown: string[] }> => {
    const resolved = adapter.resolveIds(ids);
    const failures = resolved.unknown.map((id) => ({ id, reason: "неизвестный id дорожки" }));
    if (resolved.refs.length === 0) return { loaded: 0, failures, unknown: resolved.unknown };
    const keyAtStart = currentVideo?.videoKey ?? null;
    const loaded = await adapter.loadTracks(resolved.refs, { parser });
    if (currentVideo?.videoKey !== keyAtStart) return { loaded: 0, failures, unknown: resolved.unknown };
    platformTracks = loaded.tracks;
    applySet();
    for (const f of loaded.failures) failures.push({ id: f.ref.id, reason: f.reason });
    return { loaded: loaded.tracks.length, failures, unknown: resolved.unknown };
  };

  let lastAppliedVideoKey: string | null = null;
  const detector = new VideoDetector({
    onVideo(video: DetectedVideo): void {
      // Детектор уточняет ключ того же объекта (loadedmetadata/SPA) и
      // переэмитит его — сравнение currentVideo.videoKey с video.videoKey
      // здесь всегда «равно» (одна ссылка), поэтому помним ключ последней
      // обработки сами: смена ключа = смена видео (docs/03 §6).
      const changed =
        currentVideo?.el !== video.el || lastAppliedVideoKey !== video.videoKey;
      lastAppliedVideoKey = video.videoKey;
      currentVideo = video;
      if (changed) {
        // Набор привязан к videoKey (docs/03 §6). Новый <video> с тем же
        // ключом (смена качества у плееров, пересоздающих элемент; ключ
        // уточняется по loadedmetadata) — применяем запомненный набор без
        // перезагрузки (3.5); чужой ключ — чистим показ, набор-память живёт
        // для возврата к тому же видео. Детект до loadedmetadata приходит с
        // ключом без длительности — память по уточнённому ключу не стёрта,
        // уточнённый детект следом её поднимет.
        const mem = setMemory.get(video.videoKey);
        platformTracks = mem ? mem.platform : [];
        fileTracks = mem ? mem.files : [];
        applyTracks(combinedTracks(platformTracks, fileTracks).tracks);
        engine.attach(video.el);
        if (adapter.matches(video.url)) onYouTubeVideo(video);
        else {
          trackList = null;
          reportDetected(video, false);
        }
      }
    },
    onVideoLost(): void {
      currentVideo = null;
      engine.detach(); // плашка гасится (rows = [])
      blanker.restore(); // нативный показ платформы возвращается (docs/03 §2)
      hud.hide();
    },
  });

  // Тест-хуки e2e-стенда (задача 3.2): тест-страница/CDP задаёт дорожку и сдвиг
  // напрямую — сервис-обвязка Core subtitles.* появится в задачах 3.5–3.7.
  // __DUOPULSE_TEST_TRACK__ — дорожка, массив дорожек (набор 3.4) или {clear:true};
  // до 3.6 хук задавал весь набор, теперь — платформенную часть (файловые
  // дорожки дропа живут своей частью — смешивание проверяется стендом 3.6).
  document.addEventListener("duopulse-test-track", () => {
    const payload = (window as unknown as Record<string, unknown>).__DUOPULSE_TEST_TRACK__;
    if (payload === null || typeof payload !== "object") return;
    if ("clear" in payload && (payload as { clear: unknown }).clear === true) {
      platformTracks = [];
      fileTracks = [];
      applySet();
      return;
    }
    if (Array.isArray(payload) || Array.isArray((payload as { cues?: unknown }).cues)) {
      const tracks = (Array.isArray(payload) ? payload : [payload]) as Track[];
      if (tracks.every((t) => Array.isArray(t.cues))) {
        platformTracks = tracks;
        applySet();
      }
    }
  });
  document.addEventListener("duopulse-test-offset", (e) => {
    const detail = (e as CustomEvent<{ offsetMs?: number }>).detail;
    if (detail && typeof detail.offsetMs === "number") setOffset(detail.offsetMs);
  });
  // Команда Core subtitles.set_offset (задача 3.5): bridge-хендлер исполняет
  // этот диспатч в активной вкладке (eval) — применение без перезагрузки
  // дорожек, кламп ±10 с в движке.
  document.addEventListener("duopulse-set-offset", (e) => {
    const detail = (e as CustomEvent<{ offsetMs?: number }>).detail;
    if (detail && typeof detail.offsetMs === "number") setOffset(detail.offsetMs);
  });

  // Горячие клавиши сдвига (задача 3.5, docs/03 §8): Alt+[ — раньше,
  // Alt+] — позже, шаг 100 мс (docs/03 §4). Действуют при активном наборе
  // субтитров; странице событие не отдаём. e.code — независимо от раскладки.
  document.addEventListener(
    "keydown",
    (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.code !== "BracketLeft" && e.code !== "BracketRight") return;
      if (engine.state().trackCount === 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      stepOffsetBy(e.code === "BracketRight" ? 1 : -1);
    },
    true,
  );
  // Стиль плашки (задача 3.4): позиция/отступ/кегль/подложка — до панели 3.7.
  document.addEventListener("duopulse-test-style", (e) => {
    const detail = (e as CustomEvent<Partial<SubtitleStyle>>).detail;
    if (detail && typeof detail === "object") overlay.setStyle(detail);
  });

  // Выбор дорожек YouTube-адаптера (до панели 3.7): событие или окно ниже.
  document.addEventListener("duopulse-select-tracks", (e) => {
    const detail = (e as CustomEvent<{ ids?: string[] }>).detail;
    if (Array.isArray(detail?.ids)) void selectTracks(detail.ids);
  });

  // Панельный путь задачи 3.6: Core прочитал файл с диска (subtitles.load_file)
  // и доставил cue этим событием (eval активной вкладки — паттерн
  // subtitles.set_offset). Дорожка строится тем же fileTrackFrom, что и после
  // drop; дроп/панель замещают файловую часть набора целиком.
  document.addEventListener("duopulse-file-track", (e) => {
    const detail = (e as CustomEvent<{ name?: unknown; cues?: unknown }>).detail;
    if (!detail || typeof detail !== "object" || !Array.isArray(detail.cues)) return;
    const cues: Cue[] = [];
    for (const c of detail.cues) {
      if (!c || typeof c !== "object") continue;
      const cue = c as Record<string, unknown>;
      if (typeof cue["startMs"] !== "number" || typeof cue["endMs"] !== "number") continue;
      cues.push({ startMs: cue["startMs"], endMs: cue["endMs"], text: String(cue["text"] ?? "") });
    }
    if (cues.length === 0) return;
    const name = typeof detail.name === "string" && detail.name ? detail.name : "субтитры.srt";
    fileTracks = [fileTrackFrom(name, langOfFileName(name), cues)];
    applySet();
    postToCore({
      duopulse: "file-tracks",
      videoKey: currentVideo?.videoKey ?? "",
      applied: 1,
      via: "load_file",
    });
  });

  // Drag&drop ручных файлов (задача 3.6): приём на window (capture), поглощение
  // только своих дропов; разбор тел — в Core (WebMessage parse-subtitles).
  const dropzone = new FileDropZone({
    win: window,
    doc: document,
    parser,
    hasVideo: () => currentVideo !== null,
    onApply(result: FileLoadResult): void {
      fileTracks = result.tracks;
      applySet();
      postToCore({
        duopulse: "file-tracks",
        videoKey: currentVideo?.videoKey ?? "",
        applied: result.tracks.length,
        failures: result.failures.length,
        via: "drop",
      });
    },
  });
  dropzone.start();

  detector.start();

  // Диагностика стендов: состояние content-слоя в контексте страницы.
  (window as unknown as Record<string, unknown>).__duopulseContent = {
    state(): {
      videoKey: string | null;
      canTracks: boolean;
      engine: ReturnType<typeof engine.state>;
      overlayVisible: boolean;
      style: SubtitleStyle;
      nativeBlanked: boolean;
      offsetHudVisible: boolean;
      dropHintVisible: boolean;
      fileTracks: { id: string; lang: string; cues: number }[];
    } {
      return {
        videoKey: currentVideo?.videoKey ?? null,
        canTracks: (trackList?.base.length ?? 0) > 0,
        engine: engine.state(),
        overlayVisible: overlay.visible,
        style: overlay.styleInfo(),
        nativeBlanked: blanker.blanked,
        offsetHudVisible: hud.visible,
        dropHintVisible: dropzone.hintVisible(),
        fileTracks: fileTracks.map((t) => ({ id: t.id, lang: t.lang, cues: t.cues.length })),
      };
    },
    /** Список дорожек текущего видео (null — ещё не получен/не YouTube). */
    tracksInfo(): {
      path: string;
      version: string;
      base: { id: string; lang: string; kind: string; name: string; original: boolean }[];
      translationsCount: number;
      warnings: string[];
    } | null {
      if (!trackList) return null;
      return {
        path: trackList.usedPath,
        version: trackList.version,
        base: trackList.base.map((b) => ({
          id: b.id,
          lang: b.lang,
          kind: b.kind,
          name: b.name,
          original: b.original,
        })),
        translationsCount: trackList.translations.length,
        warnings: trackList.warnings.slice(),
      };
    },
    selectTracks,
    /** Убрать файловые дорожки набора (панель/e2e): платформенные остаются. */
    clearFiles(): void {
      fileTracks = [];
      applySet();
    },
    /** Применить файловые дорожки как после дропа (диагностика стенда 3.6):
     * чтение+разбор — тем же путём, что и реальный drop. */
    async addFiles(files: readonly { name: string; text: () => Promise<string> }[]): Promise<FileLoadResult> {
      const result = await buildFileTracks(files, { parser });
      fileTracks = result.tracks;
      applySet();
      return result;
    },
  };
})();
