// DuoPulse — индикатор загрузок в навбаре (карточка duopulse-158): кнопка
// «↓» с пульсирующей точкой видна, пока что-то качается — файлы страниц
// (клики по ссылкам, filedl:*) и медиа/субтитры панели «Скачать»
// (download:*); клик открывает панель «Скачать» (сверху секция «Файлы»).
// После завершения кнопка остаётся до конца сеанса (список свежих загрузок
// в Core), без пульса. Логика показа чистая и не знает DOM — модель в
// dl-indicator-model.ts, юнит-тесты dl-indicator-model.test.ts.
import { listen } from "@tauri-apps/api/event";
import { bridge } from "../bridge";
import { t } from "../i18n";
import type {
  DownloadFinished,
  DownloadProgress,
  FileDlFinished,
  FileDlStarted,
} from "../bridge/gen/types";
import { anchorPanel, closePanel as closePanelWindow, currentPanel, openPanel } from "./panel-window";
import { emptyDlIndicatorState, indicatorTitle, indicatorVisible } from "./dl-indicator-model";

/** Кнопка «↓» индикатора загрузок (режим хрома). Идемпотентна. */
export function initDlIndicator(): void {
  const btn = document.getElementById("dlIndBtn") as HTMLButtonElement | null;
  if (!btn || btn.dataset.dlIndInit === "1") return;
  btn.dataset.dlIndInit = "1";
  const state = emptyDlIndicatorState();

  const apply = (): void => {
    btn.hidden = !indicatorVisible(state);
    const active = state.activeFiles + state.activeMedia;
    btn.dataset.active = active > 0 ? "1" : "0";
    btn.dataset.media = state.activeMedia > 0 ? "1" : "0";
    btn.title = indicatorTitle(state);
  };

  // стартовое состояние: живые файловые загрузки (перезагрузка UI-webview при
  // смене языка) и активные медиа-задания ядра
  void (async () => {
    try {
      const [files, status] = await Promise.all([bridge.filedl.status(), bridge.download.status()]);
      const ACTIVE = new Set(["prepare", "tools", "download", "convert", "subs"]);
      state.recentFiles = files.files.length;
      state.activeFiles = files.files.filter((f) => f.state === "active").length;
      state.activeMedia = status.jobs.filter((j) => ACTIVE.has(j.phase)).length;
      apply();
    } catch (e) {
      console.error("dl-indicator:", e);
    }
  })();

  // файловые загрузки: старт/итог двигают счётчики, прогресс — нет
  void listen<FileDlStarted>(bridge.events.filedlStarted, () => {
    state.activeFiles += 1;
    state.recentFiles += 1;
    apply();
  });
  void listen<FileDlFinished>(bridge.events.filedlFinished, () => {
    state.activeFiles = Math.max(0, state.activeFiles - 1);
    apply();
  });
  // медиа-задания: прогресс держит id в множестве активных, итог снимает
  const mediaActive = new Set<number>();
  void listen<DownloadProgress>(bridge.events.downloadProgress, (ev) => {
    mediaActive.add(ev.payload.jobId);
    state.activeMedia = mediaActive.size;
    apply();
  });
  void listen<DownloadFinished>(bridge.events.downloadFinished, (ev) => {
    mediaActive.delete(ev.payload.jobId);
    state.activeMedia = mediaActive.size;
    apply();
  });

  btn.addEventListener("click", () => {
    if (currentPanel() === "download") {
      closePanelWindow();
      return;
    }
    const { x, y, w, h } = anchorPanel("download", btn, "right");
    openPanel("download", x, y, w, h);
  });
  apply();
}
