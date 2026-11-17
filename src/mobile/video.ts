// Мобильный проигрыватель видео из системы (карточка duopulse-179):
// DuoPulse — кандидат «Открыть с помощью» для video/* (intent-filter из
// fileAssociations tauri.android.conf.json), Kotlin-хелпер копирует
// контентный URI в cache/video, команда mobile_video_take (lib.rs) отдаёт
// его сюда. Играет сам <video>: WebView Android умеет mp4/webm (и mkv с
// поддержанными кодеками — контейнер разбирает Chromium-демуксер, как
// WebView2 десктопа в duopulse-172), файл подаётся протоколом mobilevideo
// с Range/206 — работает перемотка. Просмотр — экран поверх вкладок, как
// просмотрщик PDF (duopulse-119): мобильные вкладки (duopulse-123) — модель
// YouTube-iframe, файловая вкладка потребовала бы переделку модели вкладок.
//
// Чистые функции (URL протокола, ошибки take) — тесты video.test.ts;
// DOM/команды — createMobileVideo (контроллер для mobile.ts: poll на
// старте/фокусе, close из «домой»), маркеры busy/noperm — общие с PDF.
import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";
import { BUSY_RETRIES, BUSY_RETRY_MS, isBusyError, isNoPermError } from "./pdf";

/** Путь cache/video → URL протокола mobilevideo: на Android wry мапит
 *  кастомные протоколы на http://<scheme>.localhost (приложение живёт на
 *  http://tauri.localhost — оба http, без mixed content). Путь кодируем
 *  целиком (encodeURIComponent): слэши и кириллица — один сегмент. */
export function mobileVideoUrl(path: string): string {
  return `http://mobilevideo.localhost/v/${encodeURIComponent(path)}`;
}

/** Параметры контроллера от мобильного UI (mobile.ts). */
export interface MobileVideoDeps {
  /** строка статуса внизу экрана (note в mobile.ts) */
  note: (text: string) => void;
  /** контейнер .m-content — сюда монтируется проигрыватель */
  host: HTMLElement;
  /** закрыть прочие полноэкранные просмотрщики (PDF) перед показом */
  closeOthers: () => void;
  /** спрятать контент под проигрывателем: стартовый экран и вкладки-плееры */
  hideContent: () => void;
  /** вернуть контент после закрытия: активная вкладка или стартовый экран */
  restoreContent: () => void;
  /** имя открытого файла — в omnibox (как watch-URL видео, duopulse-105) */
  showInOmnibox: (text: string) => void;
  /** кнопки «duo»/«⬇» — только у YouTube-видео */
  setVideoButtons: (visible: boolean) => void;
}

interface VideoPendingFile {
  path: string;
  name: string;
}

/** Состояние для e2e-стендов (window.__duopulseMobileVideo). */
export interface VideoSnapshot {
  open: boolean;
  name: string | null;
  playing: boolean;
  error: string | null;
}

/**
 * Контроллер проигрывателя: poll() зовётся мобильным UI на старте и по
 * возврату фокуса (onNewIntent при живом приложении); файл — командой
 * mobile_video_take (однократно), играет <video> через протокол mobilevideo.
 */
export function createMobileVideo(deps: MobileVideoDeps) {
  let open = false;
  let name: string | null = null;
  let error: string | null = null;
  let overlay: HTMLElement | null = null;
  let video: HTMLVideoElement | null = null;

  const snapshot = (): VideoSnapshot => ({
    open,
    name,
    playing: video ? !video.paused && !video.ended : false,
    error,
  });

  /** Притянуть pending-файл из системы («Открыть с помощью»): busy — копия
   *  ещё готовится фоновым потоком хелпера, ждём и повторяем (duopulse-124);
   *  noperm — контентный URI без grant (duopulse-141) — подсказка, не стена
   *  исключения. Маркеры — общие с PDF (pdf.ts). */
  async function poll(): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      let pending: VideoPendingFile | null = null;
      try {
        pending = await invoke<VideoPendingFile | null>("mobile_video_take");
      } catch (e) {
        if (isBusyError(e) && attempt < BUSY_RETRIES) {
          await new Promise((r) => setTimeout(r, BUSY_RETRY_MS));
          continue;
        }
        if (isNoPermError(e)) {
          deps.note(
            t("Видео не открыто: нет доступа к файлу. Откройте файл ещё раз из проводника."),
          );
          return;
        }
        deps.note(`Видео: ${e}`);
        return;
      }
      if (pending) await openFile(pending);
      return;
    }
  }

  /** Закрыть проигрыватель и вернуть прежний экран (✕/«домой»/видео YouTube). */
  function close(): void {
    if (video) {
      try {
        video.pause();
      } catch {
        /* пауза снятого элемента не критична */
      }
    }
    overlay?.remove();
    overlay = null;
    video = null;
    if (open) {
      open = false;
      deps.restoreContent();
      deps.setVideoButtons(false);
      deps.showInOmnibox("");
    }
  }

  async function openFile(file: VideoPendingFile): Promise<void> {
    close();
    deps.closeOthers();
    open = true;
    name = file.name;
    error = null;
    deps.hideContent();
    deps.setVideoButtons(false);
    deps.showInOmnibox(name);
    overlay = document.createElement("div");
    overlay.className = "m-video";
    overlay.innerHTML = `
      <div class="m-video-bar">
        <button class="m-video-close" title="${t("Закрыть")}" aria-label="${t("Закрыть")}">✕</button>
        <span class="m-video-name"></span>
      </div>
      <video class="m-video-el" controls playsinline autoplay></video>
    `;
    deps.host.appendChild(overlay);
    overlay.querySelector<HTMLElement>(".m-video-name")!.textContent = name;
    overlay.querySelector<HTMLElement>(".m-video-close")!.addEventListener("click", close);
    video = overlay.querySelector("video");
    video!.addEventListener("error", () => {
      // типично code 4 (SRC_NOT_SUPPORTED): avi/AC-3 и прочее, что Chromium
      // не декодирует — файл скопирован и открыт честно, это предел WebView
      const code = video?.error?.code ?? 0;
      error = t("Видео не открылось: {error}", {
        error: code
          ? t("формат не поддержан плеером WebView (код {code})", { code: String(code) })
          : "?",
      });
      deps.note(error);
    });
    video!.src = mobileVideoUrl(file.path);
    deps.note(t("Видео «{name}» открыто.", { name }));
  }

  return { poll, close, snapshot };
}
