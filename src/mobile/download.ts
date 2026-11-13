// Загрузки с YouTube мобильной веткой (duopulse-121 → 122): кнопка «⬇» на
// экране видео открывает лист выбора — аудио (m4a/opus), видео (360p…1080p,
// MP4) и субтитры (дорожки видео, .srt). Список форматов — Rust
// duo_mobile_formats (innertube-кэш субтитров), медиа-байты качает fetch
// ВНУТРИ youtube-iframe (document-start скрипт dl-fetcher.js: googlevideo
// отдаёт CORS только youtube-origin и 403 нативным клиентам — там детали),
// чанки base64 приходят сюда postMessage'ом и уходят invoke'ами в Rust
// (duo_download_begin/append/finish), видео+звук склеивает Kotlin
// MediaMuxer. Субтитры качает Rust (duo_download_subtitle, vtt→srt).
// Контроллер — как updater.ts: состояние + колбэк рендера, транспорт
// (invoke/postMessage) подменяется в тестах.

import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";

/** Формат дорожки (ответ duo_mobile_formats). */
export interface MediaFormatRow {
  itag: number;
  mime: string;
  ext: string;
  url: string;
  bitrate: number;
  size: number;
  quality: string;
  fps: number;
  muxed: boolean;
}

/** Дорожка субтитров (ответ duo_mobile_formats). */
export interface SubTrackRow {
  name: string;
  lang: string;
  asr: boolean;
  url: string;
}

/** Список загрузок по видео. */
export interface DuoFormats {
  title: string;
  audio: MediaFormatRow[];
  video: MediaFormatRow[];
  subs: SubTrackRow[];
}

/** Состояние листа загрузки. */
export interface MusicUiState {
  kind: "idle" | "loading" | "ready" | "downloading" | "done" | "error";
  /** ready: заголовок видео; done: имя файла · место. */
  message: string;
  /** downloading: что и сколько скачано. */
  downloading: { label: string; downloaded: number; total: number } | null;
}

export function idleMusicState(): MusicUiState {
  return { kind: "idle", message: "", downloading: null };
}

/** МБ с одним знаком: 4 083 640 → «4.0 МБ». */
export function mb(bytes: number): string {
  const v = bytes / (1024 * 1024);
  return t("{v} МБ", { v: v >= 10 || bytes === 0 ? String(Math.round(v)) : v.toFixed(1) });
}

/** Бит/с → «129 kbps» (0 → «—»). */
export function kbps(bitrate: number): string {
  return bitrate > 0 ? `${Math.max(1, Math.round(bitrate / 1000))} kbps` : "—";
}

/** Строка пункта «аудио»: «M4A · 129 kbps · 4.4 МБ». */
export function audioLabel(f: MediaFormatRow): string {
  const kind = f.ext === "webm" ? "OPUS" : "M4A";
  return `${kind} · ${kbps(f.bitrate)}${f.size ? ` · ${mb(f.size)}` : ""}`;
}

/** Строка пункта «видео»: «720p · 59 МБ · +звук» (muxed — «готовый»). */
export function videoLabel(f: MediaFormatRow): string {
  const quality = f.quality || t("видео");
  const note = f.muxed ? t("готовый") : t("+звук");
  const fps = f.fps > 30 ? ` ${f.fps}fps` : "";
  return `${quality}${fps}${f.size ? ` · ${mb(f.size)}` : ""} · ${note}`;
}

/** Строка пункта «субтитры»: имя дорожки, авто-распознавание помечаем. */
export function subLabel(s: SubTrackRow): string {
  const name = s.name || s.lang || t("дорожка");
  return s.asr ? t("{name} (авто)", { name }) : name;
}

/** Строка статуса по состоянию (строка внизу листа + note() экрана). */
export function musicStatusText(s: MusicUiState): string {
  if (s.kind === "loading") return t("⬇ Запрашиваю форматы…");
  if (s.kind === "downloading" && s.downloading) {
    const d = s.downloading;
    const pct = d.total ? Math.min(100, Math.round((d.downloaded / d.total) * 100)) : 0;
    const size = d.total ? t(" ({a} из {b})", { a: mb(d.downloaded), b: mb(d.total) }) : "";
    return t("⬇ {label}: качаю {pct}%{size}", { label: d.label, pct: String(pct), size });
  }
  if (s.kind === "done") return t("⬇ Сохранено: {message}", { message: s.message });
  if (s.kind === "error") return t("⬇ {message}", { message: s.message });
  return "";
}

// ── транспорт: fetch внутри youtube-iframe (dl-fetcher.js) ────────────────

/** Сообщения от dl-fetcher (postMessage; buf — ArrayBuffer в data). */
export interface DlMessage {
  id?: string;
  type?: "pong" | "data" | "error";
  buf?: ArrayBuffer;
  message?: string;
}

/** Узкий канал к скрипту в iframe (реальный — postMessage, в тестах — фейк). */
export interface DlTransport {
  post(msg: unknown): void;
  subscribe(handler: (m: DlMessage) => void): () => void;
}

/** Транспорт к embed-плееру: postMessage с targetOrigin youtube. */
export function iframeTransport(getFrame: () => HTMLIFrameElement | null): DlTransport {
  const listeners: ((m: DlMessage) => void)[] = [];
  window.addEventListener("message", (e: MessageEvent) => {
    const frame = getFrame();
    if (!frame || e.source !== frame.contentWindow) return;
    const data = e.data as DlMessage | null;
    if (!data || typeof data !== "object" || (data as { tag?: string }).tag !== "duopulse-dl") return;
    for (const l of listeners.slice()) l(data);
  });
  return {
    post(msg) {
      const frame = getFrame();
      if (!frame?.contentWindow) throw new Error(t("плеер YouTube не открыт"));
      frame.contentWindow.postMessage(msg, "https://www.youtube.com");
    },
    subscribe(handler) {
      listeners.push(handler);
      return () => {
        const i = listeners.indexOf(handler);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
  };
}

/** base64 без переполнения стека (кусками по 32 КиБ). */
export function toB64(buf: Uint8Array): string {
  let out = "";
  for (let i = 0; i < buf.length; i += 0x8000) {
    out += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  }
  return btoa(out);
}

let dlSeq = 0;

/** Проверить, что dl-fetcher в iframe жив (рукопожатие ping→pong). */
async function pingFetcher(transport: DlTransport, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      unsubscribe();
      reject(new Error(t("YouTube не отвечает — обновите страницу видео и попробуйте снова")));
    }, timeoutMs);
    const unsubscribe = transport.subscribe((m) => {
      if (m.type !== "pong") return;
      window.clearTimeout(timer);
      unsubscribe();
      resolve();
    });
    try {
      transport.post({ tag: "duopulse-dl", cmd: "ping", id: "ping" });
    } catch (e) {
      window.clearTimeout(timer);
      unsubscribe();
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/** Флаг отмены активной загрузки (закрытие листа прерывает докачку). */
export interface DlGuard {
  cancelled: boolean;
}

/** Размер одного диапазона: закрытые «bytes=N-M» — googlevideo открытые
 * диапазоны и GET без Range отбивает 403 (пробы 12.11.2026, duopulse-122). */
export const DL_CHUNK = 4 * 1024 * 1024;

/**
 * Скачать url через fetcher в iframe: запрашиваем закрытые диапазоны по
 * DL_CHUNK, батчи уходят в onChunk по мере поступления. Известный total
 * экономит последний запрос; короткий ответ (< запрошенного) — конец файла.
 * Сбой куска — до 3 повторов того же диапазона; 4xx и отмена не ретраятся.
 */
export async function fetchViaTransport(
  transport: DlTransport,
  url: string,
  onChunk: (chunk: Uint8Array, offset: number) => Promise<void>,
  guard?: DlGuard,
  total = 0,
): Promise<void> {
  const id = `web${Date.now()}-${dlSeq++}`;
  let offset = 0;
  let retries = 0;
  let lastError = "";
  // исход одного диапазона: next — просим следующий, done — конец файла,
  // fail — ошибка (ретрай/выход по правилам ниже)
  while (guard ? !guard.cancelled : true) {
    if (total > 0 && offset >= total) return;
    const want = total > 0 ? Math.min(DL_CHUNK, total - offset) : DL_CHUNK;
    const outcome = await new Promise<"next" | "done" | "fail">((resolve) => {
      const unsubscribe = transport.subscribe((m) => {
        if (m.id !== id) return;
        if (m.type === "data" && m.buf instanceof ArrayBuffer) {
          const chunk = new Uint8Array(m.buf);
          cleanup();
          if (chunk.length === 0) {
            resolve("done"); // пустой ответ — приравниваем к концу файла
            return;
          }
          void onChunk(chunk, offset)
            .then(() => {
              offset += chunk.length;
              resolve(chunk.length < want ? "done" : "next"); // короткий — EOF
            })
            .catch((e) => {
              lastError = e instanceof Error ? e.message : String(e);
              resolve("fail");
            });
          return;
        }
        if (m.type === "error") {
          lastError = m.message ?? t("ошибка сети");
          cleanup();
          resolve("fail");
          return;
        }
        if (m.type === "pong") return; // ответы чужих рукопожатий не трогаем
      });
      const cleanup = () => unsubscribe();
      try {
        transport.post({ tag: "duopulse-dl", cmd: "range", id, url, offset, length: want });
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        cleanup();
        resolve("fail");
      }
    });
    if (outcome === "next") {
      retries = 0;
      continue;
    }
    if (outcome === "done") return;
    // fail: отмена/отказ сервера — не ретраим, иначе до 3 попыток диапазона
    if (guard?.cancelled) break;
    if (/HTTP 4\d\d/.test(lastError)) break; // сервер отказал — докачка не поможет
    if (++retries > 3) break;
  }
  if (total > 0 && offset >= total) return;
  throw new Error(lastError || (guard?.cancelled ? t("загрузка отменена") : t("загрузка не удалась")));
}

// ── контроллер листа ──────────────────────────────────────────────────────

export interface MusicDownloader {
  /** Тап «⬇»: лист открыт — закрыть; видео нет — подсказка; иначе открыть. */
  start(): void;
  /** Снимок состояния (e2e-стенды). */
  stateSnapshot(): MusicUiState;
}

export interface MusicPorts {
  getVideoId: () => string | null;
  /** Контейнер для листа (m-content, поверх плеера). */
  host: HTMLElement;
  /** Embed-плеер (iframe youtube) — транспорт загрузки. */
  getFrame: () => HTMLIFrameElement | null;
  /** Строка статуса экрана (note() в mobile.ts). */
  render: (text: string) => void;
  /** Транспорт invoke (фейк в тестах). */
  doInvoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  /** Транспорт к fetcher'у (в тестах — фейк). */
  transport?: DlTransport;
  /** Таймаут рукопожатия с fetcher'ом, мс (в тестах меньше). */
  pingTimeoutMs?: number;
}

/** Собрать контроллер загрузок с листом выбора. */
export function createMusicDownloader(opts: MusicPorts): MusicDownloader {
  const doInvoke = opts.doInvoke ?? invoke;
  const transport = opts.transport ?? iframeTransport(opts.getFrame);
  const pingTimeoutMs = opts.pingTimeoutMs ?? 2500;
  let state = idleMusicState();
  let list: DuoFormats | null = null;
  let wrap: HTMLElement | null = null;
  let activeId: string | null = null; // id активной загрузки (cancel при закрытии)
  let activeGuard: DlGuard | null = null;

  const apply = (s: MusicUiState): void => {
    state = s;
    opts.render(musicStatusText(s));
    if (wrap) renderSheet(s);
  };

  // ── DOM листа ───────────────────────────────────────────────────────────
  function buildSheet(): void {
    if (wrap) return;
    const el = document.createElement("div");
    el.className = "m-sheet-wrap m-dl-wrap";
    el.hidden = true;
    el.innerHTML = `
      <div class="m-sheet-backdrop"></div>
      <div class="m-sheet m-dl" role="dialog" aria-label="${t("Скачать")}">
        <div class="m-dl-head">
          <b>${t("Скачать")}</b>
          <span class="m-dl-title"></span>
          <button class="m-dl-close" title="${t("Закрыть")}" aria-label="${t("Закрыть")}">✕</button>
        </div>
        <div class="m-dl-body"></div>
      </div>`;
    el.querySelector(".m-sheet-backdrop")!.addEventListener("click", closeSheet);
    el.querySelector(".m-dl-close")!.addEventListener("click", closeSheet);
    opts.host.appendChild(el);
    wrap = el;
  }

  function closeSheet(): void {
    if (!wrap) return;
    if (activeId) {
      if (activeGuard) activeGuard.cancelled = true;
      try {
        transport.post({ tag: "duopulse-dl", cmd: "cancel", id: activeId });
      } catch {
        /* плеер уже закрыт — tmp почистит abort ниже */
      }
      void doInvoke("duo_download_abort", { id: activeId }).catch(() => {});
      activeId = null;
      apply({ ...idleMusicState(), kind: "error", message: t("загрузка отменена") });
    }
    wrap.hidden = true;
  }

  function row(label: string, handler: () => void, disabled = false): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "m-sheet-item m-dl-row";
    b.textContent = label;
    b.disabled = disabled;
    b.addEventListener("click", () => handler());
    return b;
  }

  function renderSheet(s: MusicUiState): void {
    if (!wrap) return;
    wrap.querySelector<HTMLElement>(".m-dl-title")!.textContent = list?.title ?? "";
    const body = wrap.querySelector<HTMLElement>(".m-dl-body")!;
    body.innerHTML = "";
    const busy = s.kind === "downloading" || s.kind === "loading";
    if (s.kind === "loading") {
      const p = document.createElement("p");
      p.className = "m-dl-note";
      p.textContent = t("Запрашиваю форматы…");
      body.appendChild(p);
      return;
    }
    if (s.kind === "downloading" && s.downloading) {
      const p = document.createElement("p");
      p.className = "m-dl-note";
      p.textContent = musicStatusText(s);
      body.appendChild(p);
      return;
    }
    if (s.kind === "done" || s.kind === "error") {
      const p = document.createElement("p");
      p.className = `m-dl-note ${s.kind === "error" ? "m-dl-err" : ""}`;
      p.textContent = s.kind === "done" ? t("Сохранено: {message}", { message: s.message }) : s.message;
      body.appendChild(p);
    }
    if (!list) return;
    const section = (title: string, rows: HTMLElement[]): void => {
      if (!rows.length) return;
      const h = document.createElement("h4");
      h.textContent = title;
      body.appendChild(h);
      for (const r of rows) body.appendChild(r);
    };
    section(
      t("♪ Аудио"),
      list.audio.map((f) => row(audioLabel(f), () => void downloadAudio(f), busy)),
    );
    section(
      t("▶ Видео"),
      list.video.map((f) => row(videoLabel(f), () => void downloadVideo(f), busy)),
    );
    section(
      t("Субтитры (srt)"),
      list.subs.map((tr) => row(subLabel(tr), () => void downloadSub(tr), busy)),
    );
  }

  // ── загрузки ────────────────────────────────────────────────────────────
  async function downloadByUrl(url: string, label: string, total: number, base = 0): Promise<string> {
    const id = (await doInvoke("duo_download_begin", {})) as string;
    const guard: DlGuard = { cancelled: false };
    activeId = id;
    activeGuard = guard;
    try {
      await pingFetcher(transport, pingTimeoutMs);
      await fetchViaTransport(
        transport,
        url,
        async (chunk, offset) => {
          apply({
            kind: "downloading",
            message: "",
            downloading: { label, downloaded: base + offset + chunk.length, total },
          });
          await doInvoke("duo_download_append", { id, b64: toB64(chunk) });
        },
        guard,
        total,
      );
    } catch (e) {
      void doInvoke("duo_download_abort", { id }).catch(() => {});
      if (activeGuard === guard) activeGuard = null;
      if (activeId === id) activeId = null;
      throw e;
    }
    return id;
  }

  async function downloadAudio(f: MediaFormatRow): Promise<void> {
    if (!list) return;
    const label = audioLabel(f);
    try {
      apply({ kind: "downloading", message: "", downloading: { label, downloaded: 0, total: f.size } });
      const id = await downloadByUrl(f.url, label, f.size);
      const r = await doInvoke<string>("duo_download_finish", {
        args: { id, videoId: opts.getVideoId(), ext: f.ext, mime: f.mime, collection: "audio" },
      });
      activeId = null;
      activeGuard = null;
      apply({ kind: "done", message: String(r ?? ""), downloading: null });
    } catch (e) {
      if (!wasCancelled()) apply({ kind: "error", message: errText(e), downloading: null });
    }
  }

  async function downloadVideo(f: MediaFormatRow): Promise<void> {
    if (!list) return;
    const label = videoLabel(f);
    const videoId = opts.getVideoId();
    const parts: string[] = [];
    try {
      apply({ kind: "downloading", message: "", downloading: { label, downloaded: 0, total: f.size } });
      if (f.muxed) {
        const id = await downloadByUrl(f.url, label, f.size);
        const r = await doInvoke<string>("duo_download_finish", {
          args: { id, videoId, ext: "mp4", mime: f.mime, collection: "video" },
        });
        activeId = null;
        activeGuard = null;
        apply({ kind: "done", message: String(r ?? ""), downloading: null });
        return;
      }
      // раздельные дорожки: видео, затем лучший m4a-звук, склейка в Rust/Kotlin
      const videoPart = await downloadByUrl(f.url, label, f.size);
      parts.push(videoPart);
      const sound = list.audio.find((a) => a.ext === "m4a") ?? list.audio[0];
      const total2 = f.size + (sound?.size ?? 0);
      if (sound) {
        const audioPart = await downloadByUrl(sound.url, label, total2, f.size);
        parts.push(audioPart);
      }
      const r = await doInvoke<string>("duo_download_finish_mux", {
        videoId,
        videoPart,
        audioPart: parts[parts.length - 1] ?? "",
      });
      activeId = null;
      activeGuard = null;
      apply({ kind: "done", message: String(r ?? ""), downloading: null });
    } catch (e) {
      for (const p of parts) void doInvoke("duo_download_abort", { id: p }).catch(() => {});
      if (!wasCancelled()) apply({ kind: "error", message: errText(e), downloading: null });
    }
  }

  async function downloadSub(t: SubTrackRow): Promise<void> {
    const label = subLabel(t);
    try {
      apply({ kind: "downloading", message: "", downloading: { label, downloaded: 0, total: 0 } });
      const r = await doInvoke<string>("duo_download_subtitle", {
        videoId: opts.getVideoId(),
        url: t.url,
        lang: t.lang,
      });
      apply({ kind: "done", message: String(r ?? ""), downloading: null });
    } catch (e) {
      apply({ kind: "error", message: errText(e), downloading: null });
    }
  }

  function errText(e: unknown): string {
    const raw = e instanceof Error ? e.message : String(e);
    if (/HTTP 403/.test(raw)) return t("YouTube не отдал файл (HTTP 403) — попробуйте ещё раз");
    return raw;
  }

  /** Отмена пользователем уже показала свою строку — статус не перетираем. */
  function wasCancelled(): boolean {
    return state.message === t("загрузка отменена") && state.kind === "error";
  }

  async function openSheet(): Promise<void> {
    const videoId = opts.getVideoId();
    if (!videoId) {
      apply({ kind: "error", message: t("откройте видео YouTube"), downloading: null });
      return;
    }
    buildSheet();
    wrap!.hidden = false;
    list = null;
    apply({ kind: "loading", message: "", downloading: null });
    try {
      list = (await doInvoke("duo_mobile_formats", { videoId })) as DuoFormats;
      apply({ kind: "ready", message: list.title, downloading: null });
    } catch (e) {
      apply({ kind: "error", message: errText(e), downloading: null });
    }
  }

  return {
    start() {
      if (state.kind === "loading" || state.kind === "downloading") {
        // идёт работа — просто показать текущее состояние листа
        if (wrap) wrap.hidden = false;
        return;
      }
      if (wrap && !wrap.hidden) {
        closeSheet();
        return;
      }
      void openSheet();
    },
    stateSnapshot: () => state,
  };
}
