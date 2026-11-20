// Вычисление стабильного ключа видео (docs/03 §6: «YouTube id / URL+duration»).
// Чистая функция — тестируется без DOM. YouTube распознаётся по хосту:
// watch?v=, shorts/<id>, youtu.be/<id>; прочие сайты — URL (+ длительность
// целыми секундами, когда известна: отличает разные видео на одном плеер-URL).

export function videoKeyFor(href: string, durationSec?: number): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return `url:${href}`;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const v = url.searchParams.get("v");
    if (v) return `yt:${v}`;
    const shorts = /^\/shorts\/([\w-]+)/.exec(url.pathname);
    if (shorts) return `yt:${shorts[1]}`;
  } else if (host === "youtu.be") {
    const id = url.pathname.replace(/^\//, "");
    if (id) return `yt:${id}`;
  }
  const duration =
    durationSec !== undefined && Number.isFinite(durationSec) && durationSec > 0
      ? `:${Math.round(durationSec)}`
      : "";
  return `url:${url.origin}${url.pathname}${url.search}${duration}`;
}

/** Уточнение длительности меняет ключ того же видео (короткий → «:сек»):
 * детект до loadedmetadata приходит без длительности, уточнённый — следом
 * (duopulse-180; у плеер-фреймов duopulse-199 это окно всегда открыто —
 * дорожки выбирают сразу). Такая пара — то же видео, набор не терять. */
export function isRefinedVideoKey(prev: string, next: string): boolean {
  if (prev === next || !next.startsWith(`${prev}:`)) return false;
  return /^\d+$/.test(next.slice(prev.length + 1));
}
