// Мобильный просмотрщик PDF (карточка duopulse-119): WebView Android PDF
// не рендерит, DuoPulse назначается просмотрщиком системы (intent-filter
// ACTION_VIEW application/pdf) — Kotlin-хелпер копирует файл в cache/pdf,
// команды mobile_pdf_take/mobile_pdf_chunk (lib.rs) отдают его фронтенду,
// здесь документ собирается из base64-кусков и рисуется pdf.js на canvas.
// Десктопу просмотрщик не нужен: WebView2 показывает PDF нативно (проба
// duopulse-119 — edge_pdf с тулбаром).
//
// Чистые функции (сборка байтов, листание, зум) вынесены и покрыты тестами
// (pdf.test.ts); DOM/команды — createMobilePdf (контроллер для mobile.ts:
// poll на старте/фокусе, close из «домой»).
import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";

/** Границы и шаг зума просмотрщика (доли от вписывания в ширину). */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 4;
export const ZOOM_STEP = 0.25;

/** Ожидание «busy» от mobile_pdf_take (копирование в фоне): пауза/повторы,
 *  суммарно до ~10 с — с запасом на большие файлы и медленное хранилище. */
export const BUSY_RETRY_MS = 250;
export const BUSY_RETRIES = 40;

/** Зум в границах [ZOOM_MIN, ZOOM_MAX]. */
export function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/** Листание: page+delta в границах [1, count] (за край — без движения). */
export function turnPage(page: number, count: number, delta: number): number {
  return Math.min(count, Math.max(1, page + delta));
}

/** Сборка байтов документа из base64-кусков mobile_pdf_chunk. */
export function assembleBytes(chunks: readonly string[]): Uint8Array {
  const raw = atob(chunks.join(""));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Ошибка mobile_pdf_take «копирование ещё идёт» (duopulse-124): копия
 *  готовится фоновым потоком хелпера, а take фронтенд зовёт сразу —
 *  такой ответ надо повторить, а не съесть как неудачу. */
export function isBusyError(e: unknown): boolean {
  // invoke бракует строкой ошибки, но возможна и обёртка Error — ищем маркер
  return String(e).includes("busy:");
}

/** Параметры контроллера от мобильного UI (mobile.ts). */
export interface MobilePdfDeps {
  /** строка статуса внизу экрана (note в mobile.ts) */
  note: (text: string) => void;
  /** контейнер .m-content — сюда монтируется просмотрщик */
  host: HTMLElement;
  /** спрятать контент под просмотрщиком: стартовый экран и вкладки-плееры */
  hideContent: () => void;
  /** вернуть контент после закрытия: активная вкладка или стартовый экран */
  restoreContent: () => void;
  /** адрес открытого файла — в omnibox (как watch-URL видео, duopulse-105) */
  showInOmnibox: (text: string) => void;
  /** кнопки «duo»/«⬇» — только у YouTube-видео */
  setVideoButtons: (visible: boolean) => void;
}

interface PdfChunkResult {
  data: string;
  next: number;
  total: number;
}

interface PdfPendingFile {
  path: string;
  name: string;
}

/** Состояние для e2e-стендов (window.__duopulseMobilePdf). */
export interface PdfSnapshot {
  open: boolean;
  name: string | null;
  pages: number;
  page: number;
  zoom: number;
  error: string | null;
}

/**
 * Контроллер просмотрщика: poll() зовётся мобильным UI на старте и по
 * возврату фокуса (onNewIntent при живом приложении); файл — командой
 * mobile_pdf_take (однократно), байты — последовательными mobile_pdf_chunk.
 */
export function createMobilePdf(deps: MobilePdfDeps) {
  let open = false;
  let name: string | null = null;
  let error: string | null = null;
  let page = 1;
  let pages = 0;
  let zoom = 1;
  // pdf.js подгружается динамически: рабочий чанк не грузится, пока PDF
  // ни разу не открыт (бандл общий с десктопом, которому просмотрщик не нужен)
  let pdfjs: typeof import("pdfjs-dist") | null = null;
  let doc: import("pdfjs-dist").PDFDocumentProxy | null = null;
  let overlay: HTMLElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let pageLabel: HTMLElement | null = null;
  let zoomLabel: HTMLElement | null = null;
  let renderSeq = 0;

  const snapshot = (): PdfSnapshot => ({ open, name, pages, page, zoom, error });

  /** Притянуть pending-файл из системы («Открыть с помощью»). Пока хелпер
   *  копирует файл в фоне, take отвечает «busy» (duopulse-124) — ждём и
   *  повторяем, иначе файл терялся («открылось, но пусто»). */
  async function poll(): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      let pending: PdfPendingFile | null = null;
      try {
        pending = await invoke<PdfPendingFile | null>("mobile_pdf_take");
      } catch (e) {
        if (isBusyError(e) && attempt < BUSY_RETRIES) {
          await new Promise((r) => setTimeout(r, BUSY_RETRY_MS));
          continue;
        }
        // ошибка копирования хелпером — показать, не открывать
        deps.note(`PDF: ${e}`);
        return;
      }
      if (pending) await openFile(pending);
      return;
    }
  }

  /** Выгрузить документ и показать прежний экран (кнопка «домой»/закрыть). */
  function close(): void {
    renderSeq++;
    overlay?.remove();
    overlay = null;
    canvas = null;
    pageLabel = null;
    zoomLabel = null;
    doc?.destroy().catch(() => {});
    doc = null;
    if (open) {
      open = false;
      deps.restoreContent();
      deps.setVideoButtons(false);
      deps.showInOmnibox("");
    }
  }

  async function openFile(file: PdfPendingFile): Promise<void> {
    close();
    open = true;
    name = file.name;
    error = null;
    page = 1;
    pages = 0;
    zoom = 1;
    deps.hideContent();
    deps.setVideoButtons(false);
    deps.showInOmnibox(name);
    try {
      const bytes = await readChunks(file.path);
      if (!pdfjs) {
        pdfjs = await import("pdfjs-dist");
        // воркер — тем же бандлом (?url → ассет Vite), origin приложения
        const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      }
      doc = await pdfjs.getDocument({ data: bytes }).promise;
      pages = doc.numPages;
      buildOverlay();
      await renderPage();
      deps.note(t("PDF «{name}»: страниц {pages}.", { name, pages }));
    } catch (e) {
      error = String(e);
      deps.note(t("PDF не открылся: {error}", { error: String(e) }));
      close();
    }
  }

  /** Байты документа последовательными кусками (base64) до next == total. */
  async function readChunks(path: string): Promise<Uint8Array> {
    const chunks: string[] = [];
    let offset = 0;
    for (;;) {
      const c = await invoke<PdfChunkResult>("mobile_pdf_chunk", { path, offset });
      chunks.push(c.data);
      if (c.next >= c.total) break;
      offset = c.next;
    }
    return assembleBytes(chunks);
  }

  function buildOverlay(): void {
    overlay = document.createElement("div");
    overlay.className = "m-pdf";
    overlay.innerHTML = `
      <div class="m-pdf-bar">
        <button class="m-pdf-close" title="${t("Закрыть")}" aria-label="${t("Закрыть")}">✕</button>
        <span class="m-pdf-name"></span>
        <span class="m-pdf-page"></span>
        <button class="m-pdf-prev" title="${t("Предыдущая страница")}" aria-label="${t("Предыдущая страница")}">‹</button>
        <button class="m-pdf-next" title="${t("Следующая страница")}" aria-label="${t("Следующая страница")}">›</button>
        <button class="m-pdf-zoom-out" title="${t("Мельче")}" aria-label="${t("Мельче")}">−</button>
        <button class="m-pdf-zoom-in" title="${t("Крупнее")}" aria-label="${t("Крупнее")}">+</button>
        <span class="m-pdf-zoom"></span>
      </div>
      <div class="m-pdf-scroll"><canvas class="m-pdf-canvas"></canvas></div>
    `;
    deps.host.appendChild(overlay);
    canvas = overlay.querySelector("canvas");
    pageLabel = overlay.querySelector(".m-pdf-page");
    zoomLabel = overlay.querySelector(".m-pdf-zoom");
    overlay.querySelector<HTMLElement>(".m-pdf-name")!.textContent = name;
    overlay.querySelector(".m-pdf-close")!.addEventListener("click", close);
    overlay.querySelector(".m-pdf-prev")!.addEventListener("click", () => {
      page = turnPage(page, pages, -1);
      void renderPage();
    });
    overlay.querySelector(".m-pdf-next")!.addEventListener("click", () => {
      page = turnPage(page, pages, +1);
      void renderPage();
    });
    overlay.querySelector(".m-pdf-zoom-out")!.addEventListener("click", () => {
      zoom = clampZoom(zoom - ZOOM_STEP);
      void renderPage();
    });
    overlay.querySelector(".m-pdf-zoom-in")!.addEventListener("click", () => {
      zoom = clampZoom(zoom + ZOOM_STEP);
      void renderPage();
    });
  }

  /** Текущая страница на canvas: базовый масштаб — вписать в ширину, zoom —
   *  множитель; DPR учтён (чёткий текст на плотных экранах). */
  async function renderPage(): Promise<void> {
    if (!doc || !canvas || !overlay) return;
    const seq = ++renderSeq;
    const pdfPage = await doc.getPage(page);
    if (seq !== renderSeq) return; // уже перерисовали новой страницей/зумом
    const cssWidth = overlay.clientWidth;
    const base = pdfPage.getViewport({ scale: 1 }).width;
    const fit = cssWidth > 0 ? cssWidth / base : 1;
    const scale = fit * zoom;
    const viewport = pdfPage.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(viewport.width * dpr);
    canvas.height = Math.round(viewport.height * dpr);
    canvas.style.width = `${Math.round(viewport.width)}px`;
    canvas.style.height = `${Math.round(viewport.height)}px`;
    await pdfPage.render({
      canvasContext: canvas.getContext("2d")!,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    }).promise;
    overlay.querySelector(".m-pdf-scroll")!.scrollTop = 0;
    if (pageLabel) pageLabel.textContent = `${page}/${pages}`;
    if (zoomLabel) zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  }

  return { poll, close, snapshot };
}
