// DuoPulse — выгрузка дорожки субтитров в файл (карточка duopulse-118).
// Панель загрузки (download.begin subs) → Core эвалит в активную вкладку
// document-событие duopulse-download-subs {detail:{reqId,trackId}} — здесь
// дорожка выбранного языка загружается ТЕМ ЖЕ путём, что и для показа плашки
// (адаптер YouTube: PO-токен плеера + перехват timedtext; набор показа
// НЕ трогается — loadTracks без applySet), cues уходят WebMessage'ом
// «download-subs» обратно в Core, который соберёт .srt.
// Формы trackId — как у выбора набора: «yt:en» (база), «yt:en+ru» (перевод
// базы), «ru» (перевод базы по умолчанию), «yt:en:asr» (конкретная asr).
import type { YouTubeAdapter } from "./adapters/youtube";
import type { AdapterTrackList, SubtitlesParser, TrackRef } from "./adapters/types";
import type { Track } from "./types";

/** Минимальный транспорт WebMessage (content/messaging). */
export interface SubsDownloadPorts {
  /** Отправить сообщение в Core (main.rs install_content_messaging). */
  post(message: Record<string, unknown>): void;
}

export interface SubsDownloadDeps {
  adapter: Pick<YouTubeAdapter, "resolveIds" | "loadTracks">;
  /** Свежий список дорожек (null — ещё не получен/не YouTube). */
  getTrackList(): AdapterTrackList | null;
  /** Разбор тел дорожек — тот же Core-парсер, что у показа. */
  parser: SubtitlesParser;
  /** Заголовок документа для имени файла. */
  title(): string;
}

/** Ответ в Core (duopulse:download-subs). */
export interface SubsDownloadReply {
  duopulse: "download-subs";
  reqId: number;
  ok: boolean;
  error?: string;
  lang?: string;
  name?: string;
  title?: string;
  cues?: { startMs: number; endMs: number; text: string }[];
}

const FAILURE_TEXT = "язык недоступен (список сменился?)";

/** Загрузить дорожку по trackId и вернуть ответ для Core (без отправки). */
export async function subsDownloadReply(
  deps: SubsDownloadDeps,
  reqId: number,
  trackId: string,
): Promise<SubsDownloadReply> {
  const base = {
    duopulse: "download-subs" as const,
    reqId,
  };
  if (!trackId) {
    return { ...base, ok: false, error: "язык не выбран" };
  }
  const list = deps.getTrackList();
  if (!list) {
    return { ...base, ok: false, error: "список дорожек ещё не получен (видео сменилось?)" };
  }
  const resolved = deps.adapter.resolveIds([trackId]);
  if (resolved.refs.length === 0) {
    return { ...base, ok: false, error: FAILURE_TEXT };
  }
  let loaded: { tracks: Track[]; failures: { ref: TrackRef; reason: string }[] };
  try {
    loaded = await deps.adapter.loadTracks(resolved.refs, { parser: deps.parser });
  } catch (e) {
    return { ...base, ok: false, error: `загрузка дорожки: ${e instanceof Error ? e.message : String(e)}` };
  }
  const track = loaded.tracks[0];
  if (!track) {
    return {
      ...base,
      ok: false,
      error: loaded.failures[0]?.reason ?? "дорожка не загрузилась",
    };
  }
  return {
    ...base,
    ok: true,
    lang: track.lang,
    title: deps.title().replace(/\s*-\s*YouTube\s*$/i, ""),
    cues: track.cues.map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text })),
  };
}

/** Установить слушатель duopulse-download-subs (идемпотентен). */
export function installSubsDownload(
  doc: Document,
  ports: SubsDownloadPorts,
  deps: SubsDownloadDeps,
): void {
  doc.addEventListener("duopulse-download-subs", (e) => {
    const detail = (e as CustomEvent<{ reqId?: unknown; trackId?: unknown }>).detail;
    const reqId = typeof detail?.reqId === "number" ? detail.reqId : 0;
    const trackId = typeof detail?.trackId === "string" ? detail.trackId : "";
    if (!reqId) return;
    void subsDownloadReply(deps, reqId, trackId).then((reply) => ports.post(reply as unknown as Record<string, unknown>));
  });
}
