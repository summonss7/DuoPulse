// DuoPulse — «Открыть видео…» (карточка duopulse-176): локальный ролик
// играет сам WebView2 во вкладке с file://-адресом (проверено стендом
// duopulse-172: mp4/m4v/mkv (H.264/HEVC)/webm; AVI и AC-3/DTS-звук — нет).
// Диалог — нативный (plugin:dialog|open, как выбор каталога загрузок в
// настройках): <input type=file> не годится — fakepath не даёт путь.
import { invoke } from "@tauri-apps/api/core";

/** Расширения видео, которое играет WebView2; тот же список — в Core
 * (SHELL_OPEN_EXTENSIONS, main.rs: ассоциации проводника и argv). */
export const VIDEO_FILE_EXTENSIONS = ["mp4", "m4v", "mkv", "webm"] as const;

/** Путь Windows → file://-URL вкладки: обратные слэши — в прямые, ведущий
 * «/» у диска («D:/x.mkv» → «file:///D:/x.mkv»), не-ASCII и спецсимволы —
 * процент-кодирование (encodeURI не трогает # и ? — кодируем вручную). */
export function videoFileUrl(path: string): string {
  const rooted = path.replace(/\\/g, "/");
  const slashed = rooted.startsWith("/") ? rooted : `/${rooted}`;
  return `file://${encodeURI(slashed).replace(
    /[?#]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )}`;
}

/** Диалог выбора видео → file://-URL или null (отмена/закрыт). */
export async function pickVideoUrl(title: string, filterName: string): Promise<string | null> {
  const path = await invoke<string | null>("plugin:dialog|open", {
    options: {
      title,
      directory: false,
      multiple: false,
      filters: [{ name: filterName, extensions: [...VIDEO_FILE_EXTENSIONS] }],
    },
  });
  return path ? videoFileUrl(path) : null;
}
