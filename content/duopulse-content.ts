// DuoPulse content-бандл — вход (задача 3.2, docs/05 §1: content/duopulse-content.ts).
// Собирается в один IIFE без зависимостей (scripts/build-content.mjs → esbuild →
// content/gen/duopulse-content.js) и инжектируется initialization_script'ом в
// каждый документ контентной вкладки (до скриптов страницы, docs/02 §4).
//
// Каркас M3: детектор <video> → событие page:video_detected в Core (WebMessage →
// bridge, docs/05 §2) → движок cue-таймлайна (часы video.currentTime) → оверлей.
// Дорожки реальных платформ даст YouTube-адаптер (задача 3.3) и Core subtitles.*
// (3.3–3.6); до них движок питается тест-хуком e2e-стенда (custom-события
// duopulse-test-track / duopulse-test-offset — чтение window-глобальных
// устанавливает сама тест-страница или CDP).

import { VideoDetector, type DetectedVideo } from "./detector";
import { SubtitlesEngine, type ActiveRow } from "./engine/subtitles-engine";
import { SubtitlesOverlay } from "./overlay/overlay";
import { postToCore } from "./messaging";
import type { Track } from "./types";

(function (): void {
  "use strict";
  const w = window as unknown as { __DUOPULSE_SUBTITLES__?: boolean };
  if (w.__DUOPULSE_SUBTITLES__) return; // бандл исполняется один раз на документ
  w.__DUOPULSE_SUBTITLES__ = true;

  const overlay = new SubtitlesOverlay();
  let currentVideo: DetectedVideo | null = null;

  const engine = new SubtitlesEngine({
    onRowsChange(rows: ActiveRow[]): void {
      if (rows.length > 0 && currentVideo) overlay.show(rows, currentVideo.el);
      else overlay.hide();
    },
  });

  const reportDetected = (video: DetectedVideo): void => {
    // Событие контракта page:video_detected (docs/05 §2): Core эмитит его в UI
    // (main.rs → bridge::emit). canTracks=false — адаптеров дорожек ещё нет,
    // появится с YouTube-адаптером (задача 3.3).
    postToCore({ duopulse: "video", videoKey: video.videoKey, canTracks: false });
  };

  const detector = new VideoDetector({
    onVideo(video: DetectedVideo): void {
      const changed = currentVideo?.el !== video.el || currentVideo?.videoKey !== video.videoKey;
      currentVideo = video;
      if (changed) engine.attach(video.el);
      reportDetected(video);
    },
    onVideoLost(): void {
      currentVideo = null;
      engine.detach(); // плашка гасится (rows = [])
    },
  });

  // Тест-хуки e2e-стенда (задача 3.2): тест-страница/CDP задаёт дорожку и сдвиг
  // напрямую — сервис-обвязка Core subtitles.* появится в задачах 3.3–3.6.
  document.addEventListener("duopulse-test-track", () => {
    const track = (window as unknown as Record<string, unknown>).__DUOPULSE_TEST_TRACK__ as
      | Track
      | undefined;
    if (track && Array.isArray(track.cues)) engine.setTracks([track]);
  });
  document.addEventListener("duopulse-test-offset", (e) => {
    const detail = (e as CustomEvent<{ offsetMs?: number }>).detail;
    if (detail && typeof detail.offsetMs === "number") engine.setOffset(detail.offsetMs);
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
        canTracks: false,
        engine: engine.state(),
        overlayVisible: overlay.visible,
      };
    },
  };
})();
