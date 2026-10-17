// Ручные файлы субтитров (задача 3.6, docs/03 §3.2, docs/05 §1:
// content/adapters/file.ts — «ручные .srt/.vtt через Core»). Drag&drop
// 1–3 файлов .srt/.vtt на страницу с <video> любого сайта: чтение — в
// content-слое (File API страницы, UTF-8 — v1; Windows-1251 — v1.1), разбор —
// канонический в Core (парсеры задачи 3.1 через WebMessage parse-subtitles).
// Файловые дорожки — полноценные участники набора (docs/01 F-06): смешиваются
// с дорожками платформы, порядок строк на плашке = порядок набора (файлы —
// в конец, docs/03 §1 «оригинал + перевод платформы + свой файл»).
//
// Панельный путь (кнопка «Свои субтитры», панель 3.7): Core читает файл с
// диска (subtitles.load_file) и доставляет cue в активную вкладку
// document-событием duopulse-file-track — дорожка строится тем же
// fileTrackFrom, что и после drop.
//
// Drag&drop не мешает сайту (docs/02 §1 — не ломаем страницу): дроп поглощается
// ТОЛЬКО если среди файлов есть .srt/.vtt и на странице есть детектированное
// видео; прочие дропы (загрузка файлов на сайт) проходят странице как без нас.

import type { SubtitlesParser } from "./types";
import type { Cue, Track } from "../types";

/** Расширения ручных файлов субтитров (docs/03 §3.2). */
export const SUBTITLE_FILE_EXTENSIONS = [".srt", ".vtt"] as const;
/** Файлов за один дроп: docs/03 §3.2 — «2–3 файла разных языков» (верхний
 * предел — общий набор, MAX_SET_TRACKS). */
export const MAX_FILE_TRACKS = 3;
/** Дорожек в наборе v1 (docs/03 §1): платформенные + файловые вместе. */
export const MAX_SET_TRACKS = 3;
/** Лимит размера файла — тот же, что у разбора в Core (main.rs, 4 МБ). */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** Файл дропа: имя + текст (реальный File удовлетворяет интерфейсу). */
export interface SubtitleFileLike {
  readonly name: string;
  text(): Promise<string>;
}

/** Язык из имени файла: «movie.ru.srt» → «ru», «subs.en-US.vtt» → «en-US»;
 * сегмент — 2–3 буквы (+ подпишусы BCP-47); прочее («2024», «рус») — не язык. */
export function langOfFileName(name: string): string {
  const base = name.replace(/\.(srt|vtt)$/i, "");
  const last = base.slice(base.lastIndexOf(".") + 1);
  return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(last) && base.includes(".")
    ? last
    : "";
}

/** Язык из заголовка WebVTT (LANGUAGE: ru) — файлы без языка в имени. */
export function langOfVttHeader(text: string): string {
  const head = text.slice(0, 2048).split(/\r?\n\r?\n/)[0] ?? "";
  const m = /^Language:[ \t]*(\S+)/im.exec(head);
  return m ? m[1] : "";
}

/** Из дропа — только файлы субтитров (по расширению), не больше
 * MAX_FILE_TRACKS, в порядке дропа. Пусто — дроп не наш, странице не мешаем. */
export function pickSubtitleFiles(files: readonly SubtitleFileLike[]): SubtitleFileLike[] {
  return files
    .filter((f) => SUBTITLE_FILE_EXTENSIONS.some((ext) => f.name.toLowerCase().endsWith(ext)))
    .slice(0, MAX_FILE_TRACKS);
}

/** Итоговый набор: платформенные дорожки + файловые, не больше MAX_SET_TRACKS
 * (docs/03 §1); файлы сверх лимита отбрасываются (счёт — в droppedFiles). */
export function combinedTracks(
  platform: readonly Track[],
  files: readonly Track[],
): { tracks: Track[]; droppedFiles: number } {
  const all = [...platform, ...files];
  return {
    tracks: all.slice(0, MAX_SET_TRACKS),
    droppedFiles: Math.max(0, all.length - MAX_SET_TRACKS),
  };
}

/** id файловой дорожки: file:<lang>, без языка — file:<имя-файла>; дубликаты
 * получают :2, :3 (несколько дорожек одного языка бывают у разных файлов). */
export function fileTrackFrom(
  name: string,
  lang: string,
  cues: Cue[],
  usedIds?: Set<string>,
): Track {
  const base =
    lang && lang !== "und"
      ? `file:${lang}`
      : `file:${name.replace(/\.(srt|vtt)$/i, "").replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 24) || "file"}`;
  let id = base;
  for (let n = 2; usedIds?.has(id); n++) id = `${base}:${n}`;
  usedIds?.add(id);
  return { id, source: "file", lang: lang || "und", role: "original", cues };
}

/** Итог загрузки файлов: дорожки (по порядку файлов) + пофактовые отказы. */
export interface FileLoadResult {
  tracks: Track[];
  failures: { name: string; reason: string }[];
  warnings: string[];
}

/** Прочитать и разобрать файлы дропа: чтение — здесь (UTF-8), разбор — в Core
 * (SubtitlesParser, WebMessage parse-subtitles); пустой файл/отказ канала —
 * отказ дорожки, остальные файлы грузятся дальше (docs/03 §9 — не «умирает»
 * целиком). */
export async function buildFileTracks(
  files: readonly SubtitleFileLike[],
  ports: { parser: SubtitlesParser },
): Promise<FileLoadResult> {
  const out: FileLoadResult = { tracks: [], failures: [], warnings: [] };
  const usedIds = new Set<string>();
  for (const f of files) {
    let text: string;
    try {
      text = await f.text();
    } catch {
      out.failures.push({ name: f.name, reason: "файл не читается" });
      continue;
    }
    if (text.length > MAX_FILE_BYTES) {
      out.failures.push({ name: f.name, reason: "файл больше 4 МБ" });
      continue;
    }
    let parsed: { cues: Cue[]; warnings: string[] };
    try {
      parsed = await ports.parser.parse(text);
    } catch (e) {
      out.failures.push({ name: f.name, reason: e instanceof Error ? e.message : "Core не разобрал файл" });
      continue;
    }
    for (const w of parsed.warnings) out.warnings.push(`${f.name}: ${w}`);
    if (parsed.cues.length === 0) {
      // Предупреждения уже собраны — панель покажет, почему cue нет.
      out.failures.push({ name: f.name, reason: "в файле нет ни одного cue" });
      continue;
    }
    const lang = langOfFileName(f.name) || langOfVttHeader(text) || "und";
    out.tracks.push(fileTrackFrom(f.name, lang, parsed.cues, usedIds));
  }
  return out;
}

// --- drag&drop -----------------------------------------------------------------

/** DOM-событие дропа (DragEvent без типа — jsdom-тесты шлют Event с полем). */
export interface DragEventLike {
  readonly type: string;
  readonly dataTransfer: { readonly types: readonly string[]; readonly files: File[]; dropEffect: string } | null;
  preventDefault(): void;
  stopPropagation(): void;
}

/** Минимальный window для слушателей дропа (событие приходит как unknown и
 * кастится внутри — совместимость со структурой Window при strictFunctionTypes). */
export interface DropWindow {
  addEventListener(type: string, listener: (e: unknown) => void, capture?: boolean): void;
}

/** Минимальный document для плашки-подсказки. */
export interface DropDocument {
  createElement(tag: "div"): HTMLDivElement;
  documentElement: { appendChild(el: HTMLDivElement): unknown };
}

export interface FileDropZoneOptions {
  win: DropWindow;
  doc: DropDocument;
  parser: SubtitlesParser;
  /** Детектор нашёл <video> — дроп применим (docs/03 §3.2 «на любой <video>
   * найденного детектора»). */
  hasVideo(): boolean;
  /** Файловые дорожки построены (замещают прежние файловые — дроп задаёт
   * файловую часть набора целиком); пусто — все файлы не разобрались. */
  onApply(result: FileLoadResult): void;
}

/**
 * Зона приёма файлов на window (capture): подсказка при драге файлов над
 * страницей с видео, поглощение дропа только своих файлов. Подсказка — по
 * гайду 06 §6 (тёмная плашка, скругление 6, blur 2, лайм-акцент), не ловит
 * указатель (pointer-events:none).
 */
export class FileDropZone {
  private readonly opts: FileDropZoneOptions;
  private hint: HTMLDivElement | null = null;
  private dragDepth = 0;

  constructor(opts: FileDropZoneOptions) {
    this.opts = opts;
  }

  start(): void {
    const w = this.opts.win;
    const on = (h: (e: DragEventLike) => void) => (e: unknown) => h(e as DragEventLike);
    w.addEventListener("dragenter", on((e) => this.onDragEnter(e)), true);
    w.addEventListener("dragover", on((e) => this.onDragOver(e)), true);
    w.addEventListener("dragleave", on(() => this.onDragLeave()), true);
    w.addEventListener("drop", on((e) => this.onDrop(e)), true);
  }

  /** Подсказка видна (диагностика e2e). */
  hintVisible(): boolean {
    return this.hint !== null && this.hint.style.opacity === "1";
  }

  private draggedFiles(e: DragEventLike): File[] | null {
    const dt = e.dataTransfer;
    if (!dt || !dt.types.includes("Files")) return null;
    if (!this.opts.hasVideo()) return null;
    return Array.from(dt.files ?? []);
  }

  private onDragEnter(e: DragEventLike): void {
    if (!this.draggedFiles(e)) return;
    this.dragDepth++;
    this.showHint();
  }

  private onDragOver(e: DragEventLike): void {
    if (!this.draggedFiles(e)) return;
    // Разрешаем дроп (без preventDefault браузер открыл бы файл вкладкой);
    // состав файлов до drop скрыт (protected mode) — решает drop.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }

  private onDragLeave(): void {
    if (this.dragDepth > 0 && --this.dragDepth === 0) this.hideHint();
  }

  private onDrop(e: DragEventLike): void {
    const dragged = this.draggedFiles(e);
    this.dragDepth = 0;
    this.hideHint();
    const files = pickSubtitleFiles(dragged ?? []);
    if (dragged === null || files.length === 0) return; // не наш дроп — сайту
    e.preventDefault();
    e.stopPropagation();
    void buildFileTracks(files, { parser: this.opts.parser }).then((result) => this.opts.onApply(result));
  }

  private showHint(): void {
    if (!this.hint?.isConnected) {
      const el = this.opts.doc.createElement("div");
      el.setAttribute("data-duopulse-dropzone", "1");
      const s = el.style;
      s.position = "fixed";
      s.top = "18px";
      s.left = "50%";
      s.transform = "translateX(-50%)";
      s.zIndex = "2147483647";
      s.padding = "10px 18px";
      s.borderRadius = "6px"; // гайд 06 §6
      s.background = "rgba(10,14,23,0.92)";
      s.backdropFilter = "blur(2px)"; // гайд 06 §6
      s.color = "#E8EDF2";
      s.fontFamily = "Inter, 'Segoe UI', system-ui, sans-serif";
      s.fontSize = "13px";
      s.pointerEvents = "none";
      s.opacity = "0";
      s.transition = "opacity 120ms";
      s.userSelect = "none";
      el.textContent = "Отпустите — наложим субтитры (.srt / .vtt)";
      this.opts.doc.documentElement.appendChild(el);
      this.hint = el;
    }
    if (this.hint) this.hint.style.opacity = "1";
  }

  private hideHint(): void {
    if (this.hint) this.hint.style.opacity = "0";
  }
}
