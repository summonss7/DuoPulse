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
// (duopulse-test-track/-offset) остаются для e2e-стенда не-YouTube страниц.

import { VideoDetector, type DetectedVideo } from "./detector";
import { SubtitlesEngine, type ActiveRow } from "./engine/subtitles-engine";
import { SubtitlesOverlay } from "./overlay/overlay";
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

  const overlay = new SubtitlesOverlay();

  const engine = new SubtitlesEngine({
    onRowsChange(rows: ActiveRow[]): void {
      if (rows.length > 0 && currentVideo) overlay.show(rows, currentVideo.el);
      else overlay.hide();
    },
  });

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
    engine.setTracks(loaded.tracks);
    for (const f of loaded.failures) failures.push({ id: f.ref.id, reason: f.reason });
    return { loaded: loaded.tracks.length, failures, unknown: resolved.unknown };
  };

  const detector = new VideoDetector({
    onVideo(video: DetectedVideo): void {
      const changed = currentVideo?.el !== video.el || currentVideo?.videoKey !== video.videoKey;
      currentVideo = video;
      if (changed) {
        engine.setTracks([]); // набор дорожек привязан к видео (docs/03 §6)
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
    },
  });

  // Тест-хуки e2e-стенда (задача 3.2): тест-страница/CDP задаёт дорожку и сдвиг
  // напрямую — сервис-обвязка Core subtitles.* появится в задачах 3.5–3.7.
  document.addEventListener("duopulse-test-track", () => {
    const track = (window as unknown as Record<string, unknown>).__DUOPULSE_TEST_TRACK__ as Track | undefined;
    if (track && Array.isArray(track.cues)) engine.setTracks([track]);
  });
  document.addEventListener("duopulse-test-offset", (e) => {
    const detail = (e as CustomEvent<{ offsetMs?: number }>).detail;
    if (detail && typeof detail.offsetMs === "number") engine.setOffset(detail.offsetMs);
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
    } {
      return {
        videoKey: currentVideo?.videoKey ?? null,
        canTracks: (trackList?.base.length ?? 0) > 0,
        engine: engine.state(),
        overlayVisible: overlay.visible,
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
