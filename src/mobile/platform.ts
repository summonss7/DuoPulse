// DuoPulse — признак платформы и разбор адреса для мобильной ветки (этап 1
// карточки duopulse-081). Десктоп различает webview по меткам; мобильная
// обёртка одна (окно "main" из tauri.android.conf.json), и её признак —
// withGlobalTauri: мобильный конфиг включает глобальный API →
// window.__TAURI__ есть только на телефоне (приём novagrid-058; десктопный
// tauri.conf.json держит false). Один бандл на все платформы, ветвление —
// в main.ts.

/** Мобильная обёртка Tauri (Android)? Параметр — для юнит-тестов. */
export function isTauriMobile(w: { __TAURI__?: unknown } = window as { __TAURI__?: unknown }): boolean {
  return typeof w.__TAURI__ !== "undefined";
}

/** Куда идёт ввод omnibox: адрес (iframe/системный браузер) или поиск. */
export type MobileResolution = {
  kind: "url" | "search";
  url: string;
};

/** Поисковые системы мобильной ветки (duopulse-085) — те же движки, что в
 *  Core (SearchEngine в src-tauri/src/settings/mod.rs): по умолчанию Google,
 *  выбор — селектор стартового экрана. У мобильной обёртки нет settings.json
 *  и команд Core (см. шапку mobile.ts) — держим свой словарь и храним выбор
 *  в localStorage. Префикс — шаблон ссылки с encoded-запросом в конце. */
export const MOBILE_SEARCH_ENGINES = [
  { id: "google", title: "Google", prefix: "https://www.google.com/search?q=" },
  { id: "youtube", title: "YouTube", prefix: "https://www.youtube.com/results?search_query=" },
  { id: "bing", title: "Bing", prefix: "https://www.bing.com/search?q=" },
  { id: "duckduckgo", title: "DuckDuckGo", prefix: "https://duckduckgo.com/?q=" },
] as const;

export type MobileEngineId = (typeof MOBILE_SEARCH_ENGINES)[number]["id"];

/** Поисковик по умолчанию — Google (duopulse-085). */
export const DEFAULT_MOBILE_ENGINE: MobileEngineId = "google";

/** Префикс поисковой ссылки движка. */
export function enginePrefix(engine: MobileEngineId): string {
  return MOBILE_SEARCH_ENGINES.find((e) => e.id === engine)?.prefix
    ?? MOBILE_SEARCH_ENGINES[0].prefix;
}

/** Значение из localStorage → корректный id движка (мусор/нет — дефолт). */
export function normalizeEngine(v: string | null): MobileEngineId {
  return MOBILE_SEARCH_ENGINES.some((e) => e.id === v) ? (v as MobileEngineId) : DEFAULT_MOBILE_ENGINE;
}

/** Похоже на домен/IP (без схемы): «example.com», «example.com/path», «1.2.3.4». */
const BARE_DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+([/?#:].*)?$/i;

/** YouTube-плеер, который можно встроить в iframe: обычные /watch и youtu.be
 *  страница YouTube отдает с X-Frame-Options и в iframe не открывается,
 *  /embed/ID — можно (единственный официальный встраиваемый путь).
 *  enablejsapi=1 — IFrame Player API для duo-часов (duopulse-082: опрос
 *  getCurrentTime кросс-доменного плеера постсообщениями). */
export function youtubeEmbedUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    let id: string | null = null;
    if (host === "youtube.com" || host === "m.youtube.com") {
      const v = u.searchParams.get("v");
      if (u.pathname === "/watch" && v) id = v;
      const m = u.pathname.match(/^\/embed\/([\w-]+)/);
      if (m) id = m[1];
    }
    if (host === "youtu.be") {
      id = u.pathname.slice(1).split("/")[0] || null;
    }
    if (id) return `https://www.youtube.com/embed/${id}?enablejsapi=1`;
  } catch {
    // не URL — не плеер
  }
  return null;
}

/** videoId из URL embed-плеера (после youtubeEmbedUrl) — для duo-сессии. */
export function videoIdOfEmbed(url: string): string | null {
  const m = url.match(/\/embed\/([\w-]{6,20})/);
  return m ? m[1] : null;
}

/** Разбор ввода «URL (догадка схемы) или поиск» — мобильная пара
 *  nav.resolve_omnibox (omnibox.rs); YouTube-ссылки с видео переписываются
 *  во встраиваемый плеер (см. youtubeEmbedUrl), поисковый префикс — выбранный
 *  движок (duopulse-085, по умолчанию Google). */
export function resolveMobileInput(
  input: string,
  engine: MobileEngineId = DEFAULT_MOBILE_ENGINE,
): MobileResolution {
  const q = input.trim();
  if (!q) return { kind: "search", url: enginePrefix(engine) };

  if (/^https?:\/\//i.test(q)) {
    return { kind: "url", url: youtubeEmbedUrl(q) ?? q };
  }
  // «голый» домен/IP — https, как в omnibox.rs (localhost без точки — тоже
  // адрес: http, локальная разработка)
  if (BARE_DOMAIN.test(q) || /^localhost([/:?]|$)/i.test(q)) {
    const scheme = /^localhost(:|$)/i.test(q) ? "http" : "https";
    return { kind: "url", url: youtubeEmbedUrl(`${scheme}://${q}`) ?? `${scheme}://${q}` };
  }
  return { kind: "search", url: enginePrefix(engine) + encodeURIComponent(q) };
}
