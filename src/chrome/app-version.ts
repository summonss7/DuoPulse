// DuoPulse — бейдж версии в шапке (карточка duopulse-074): «vX.Y.Z · дата»
// рядом с логотипом, чтобы видно было, какого числа собран бинарник.
// app.build_info отдаёт версию и unix-момент компиляции (build.rs); дату
// форматируем локально. Без Core (чистый vite-dev) бейдж остаётся скрытым.
import { bridge } from "../bridge";

/** «05.11.2026» из unix-секунд; пустая строка — момент неизвестен. */
export function buildDateRu(unix: number): string {
  if (!unix) return "";
  return new Date(unix * 1000).toLocaleDateString("ru-RU");
}

/** Текст бейджа: «v0.1.3 · 05.11.2026»; без даты — только версия. */
export function versionBadgeText(version: string, buildUnix: number): string {
  const date = buildDateRu(buildUnix);
  return `v${version}${date ? ` · ${date}` : ""}`;
}

export function initAppVersion(): void {
  const el = document.getElementById("appVer");
  if (!el) return;
  bridge.app
    .buildInfo()
    .then((info) => {
      el.textContent = versionBadgeText(info.version, info.buildUnix);
      const date = buildDateRu(info.buildUnix);
      el.title = `DuoPulse v${info.version}${date ? `, сборка ${date}` : ""}`;
      el.hidden = false;
    })
    .catch(() => {
      /* нет Core — бейджа нет; не ошибка */
    });
}
