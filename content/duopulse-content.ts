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
import type { Track } from "./types";

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

  /** Набор текущего видео (переживает пересоздание <video> с тем же ключом —
   * смена качества: таймлайн тот же, дорожки те же, docs/03 §4). Помним
   * последний применённый набор: детект нового элемента приходит до
   * loadedmetadata (ключ без длительности), уточнённый ключ — следом. */
  let tracksFor: { key: string; tracks: Track[] } | null = null;

  /** Единая точка смены набора: движок + гашение нативного показа. */
  const applyTracks = (tracks: Track[]): void => {
    engine.setTracks(tracks);
    if (tracks.length > 0) blanker.blank(currentVideo?.el ?? null);
    else blanker.restore();
  };

  /** Запомнить набор за текущим видео (пустой — забыть). */
  const storeTracks = (tracks: Track[]): void => {
    tracksFor = tracks.length > 0 && currentVideo
      ? { key: currentVideo.videoKey, tracks }
      : null;
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
   * во время загрузки — результат не применяется (дорожки прошлого видео). */
  const selectTracks = async (
    ids: string[],
  ): Promise<{ loaded: number; failures: { id: string; reason: string }[]; unknown: string[] }> => {
    const resolved = adapter.resolveIds(ids);
    const failures = resolved.unknown.map((id) => ({ id, reason: "неизвестный id дорожки" }));
    if (resolved.refs.length === 0) return { loaded: 0, failures, unknown: resolved.unknown };
    const keyAtStart = currentVideo?.videoKey ?? null;
    const loaded = await adapter.loadTracks(resolved.refs, { parser });
    if (currentVideo?.videoKey !== keyAtStart) return { loaded: 0, failures, unknown: resolved.unknown };
    applyTracks(loaded.tracks);
    storeTracks(loaded.tracks);
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
        // для возврата к тому же видео.
        if (tracksFor && tracksFor.key === video.videoKey) applyTracks(tracksFor.tracks);
        else applyTracks([]);
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
  // __DUOPULSE_TEST_TRACK__ — дорожка, массив дорожек (набор 3.4) или {clear:true}.
  document.addEventListener("duopulse-test-track", () => {
    const payload = (window as unknown as Record<string, unknown>).__DUOPULSE_TEST_TRACK__;
    if (payload === null || typeof payload !== "object") return;
    if ("clear" in payload && (payload as { clear: unknown }).clear === true) {
      applyTracks([]);
      storeTracks([]);
      return;
    }
    if (Array.isArray(payload) || Array.isArray((payload as { cues?: unknown }).cues)) {
      const tracks = (Array.isArray(payload) ? payload : [payload]) as Track[];
      if (tracks.every((t) => Array.isArray(t.cues))) {
        applyTracks(tracks);
        storeTracks(tracks);
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
    } {
      return {
        videoKey: currentVideo?.videoKey ?? null,
        canTracks: (trackList?.base.length ?? 0) > 0,
        engine: engine.state(),
        overlayVisible: overlay.visible,
        style: overlay.styleInfo(),
        nativeBlanked: blanker.blanked,
        offsetHudVisible: hud.visible,
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
  };
})();
