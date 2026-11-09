// DuoPulse — панельный режим UI-бандла (карточка duopulse-090).
// Панели хрома — child-webview «chrome-panel» в окне main (Core —
// src-tauri/src/chrome_panel.rs), грузит index.html?panel=<kind>: хром скрыт
// (html[data-panel]), показана только запрошенная панель, логика — теми же
// модулями, что в хроме (экспорт openXxxPanel()). Окно создаётся точного
// размера и НЕ ресайзится (ловушка спайка 086, подтверждена 090: ресайз гасит
// презентацию child-webview); изменчивый контент скроллится внутри панели.
//
// Закрытие: Escape (здесь), клик по хрому вне якоря (chrome.ts), клик по
// контенту страницы (content/panel-close.js → Core), выбор пункта (модули).
import { closePanel, panelKind, PANEL_HOST, type PanelKind } from "./chrome/panel-window";

/** Загрузка модуля панели с самоспасением. Vite-dev изредка теряет ответ на
 *  один из параллельных запросов модулей свежесозданного webview НАВСЕГДА
 *  (без ошибки — import висит вечность; поймано style-стендом 090: слушатели
 *  меню не вешались, клики молча пропадали). Гонка с таймаутом + повтор
 *  кэш-бастером = НОВЫЙ запрос/запись модуля — единственный эмпирически
 *  рабочий выход. Прод-бандл грузится с локальных ассетов — там довольно
 *  первой попытки (повторы не выполняются). */
const importPanel = async <T>(
  what: string,
  load: () => Promise<T>,
  retryUrl: string,
): Promise<T | null> => {
  for (let i = 0; i < 3; i++) {
    const url = i === 0 || !import.meta.env.DEV ? null : `${retryUrl}?dp-retry=${Date.now()}`;
    try {
      return await Promise.race([
        url === null ? load() : import(/* @vite-ignore */ url),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 15_000)),
      ]);
    } catch (e) {
      console.error(`panel-boot: «${what}» не загрузился (попытка ${i + 1})`, e);
    }
  }
  return null;
};

/** Загрузка панельного режима (вызов из main.ts; kind — ?panel=). */
export function bootPanel(kind: PanelKind): void {
  document.documentElement.dataset.panel = kind;
  const el = document.getElementById(PANEL_HOST[kind]);
  if (el) el.hidden = false;

  // Escape — системная дверь панели (модули могли закрыться и сами)
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape") closePanel();
    },
    true,
  );

  // Логика панели — модулями хрома: их экспорт «открыть» refreshing данные.
  // Первая попытка — обычный импорт, повторы — кэш-бастер (см. importPanel).
  if (kind === "main")
    void importPanel("главное меню", () => import("./chrome/mainmenu"), "/src/chrome/mainmenu.ts").then(
      (m) => m?.openMainMenuPanel(),
    );
  if (kind === "proxy")
    void importPanel("прокси", () => import("./proxy-menu"), "/src/proxy-menu.ts").then((m) =>
      m?.openProxyPanel(),
    );
  if (kind === "vpn")
    void importPanel("VPN", () => import("./vpn-panel/vpn-panel"), "/src/vpn-panel/vpn-panel.ts").then(
      (m) => m?.openVpnPanel(),
    );
  if (kind === "duo") {
    // initDuo вешает живые обработчики контролов (слайдеры/селекты/чипы),
    // openDuoPanelContent — показывает панель и освежает снапшот
    void importPanel("duo", () => import("./subtitles-panel/duo"), "/src/subtitles-panel/duo.ts").then(
      (m) => {
        if (!m) return;
        m.initDuo();
        m.openDuoPanelContent();
      },
    );
    // Секция «Перевод» duo-панели (провайдеры, ключ DPAPI) — как в хроме
    void importPanel(
      "перевод duo",
      () => import("./subtitles-panel/translate-settings"),
      "/src/subtitles-panel/translate-settings.ts",
    ).then((m) => m?.initTranslateSettings());
  }
  if (kind === "suggest")
    void importPanel("подсказки", () => import("./chrome/omnibox"), "/src/chrome/omnibox.ts").then((m) =>
      m?.bootSuggestPanel(),
    );
}
