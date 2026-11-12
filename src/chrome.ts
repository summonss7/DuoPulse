// DuoPulse — UI-хром браузера (webview «main»): таб-бар (задача 1.2),
// адресная строка omnibox (задача 1.3), кнопки навигации, главное меню
// (задача 1.5). Внутренние страницы duopulse:// (задача 1.4) имеют свой
// вход — src/pages/ + роутер src/main.ts; сюда не импортируются.
import { bridge } from "./bridge";
import { initTabBar, onTabsChanged } from "./chrome/tabbar";
import { initOmnibox, setActiveUrl, setIncognito } from "./chrome/omnibox";
import { initStar, setActivePage } from "./chrome/star";
import { closePanel, currentPanel } from "./chrome/panel-window";
import { initPwSaveBar } from "./chrome/pw-save";
import { initUpdateBar } from "./chrome/update-bar";
import "./chrome/mainmenu";
import "./proxy-menu";
import "./vpn-panel/vpn-panel";
import { initDuo } from "./subtitles-panel/duo";
import { initTranslateSettings } from "./subtitles-panel/translate-settings";
import { initDownloadButton } from "./download-panel/panel";

// Клик по хрому вне якорной кнопки закрывает панель-окно (duopulse-090):
// клики по странице ловит Core (потеря фокуса панелью), клики по хрому — тут.
// Клик по omnibox не закрывает подсказки — ввод продолжается (focus → update).
window.addEventListener(
  "mousedown",
  (e) => {
    const kind = currentPanel();
    if (!kind) return;
    const t = e.target as HTMLElement;
    if (kind === "suggest" && t.closest("#omnibox, #go, #suggest")) return;
    if (t.closest("#mainBtn, #proxyBtn, #vpnBtn, #duoBtn, #dlBtn")) return; // тумблеры
    closePanel();
  },
  true,
);

// Таб-бар (задача 1.2): рендер вкладок, хоткеи, контекст-меню.
initTabBar();
// Omnibox (задача 1.3): подсказки, Enter/Esc/стрелки, кнопки навигации.
initOmnibox();
// Звёздочка избранного (карточка duopulse-057): закладка активной страницы.
initStar();
// Бар «Сохранить пароль?» (этап 2 duopulse-108): панель pwsave по событию
// passwords:save_prompt, закрытие при переключении вкладки.
initPwSaveBar();
// Бар «Появилась новая версия» (карточка duopulse-127): строка поверх
// таб-бара, пока найденное обновление не установлено/отклонено.
initUpdateBar();
// Кнопка «duo» + панель настроек набора субтитров (задача 3.7, docs/03 §8).
initDuo();
// Секция «Перевод» duo-панели: провайдеры DeepL/Google/LibreTranslate (4.1).
initTranslateSettings();
// Кнопка «⬇» + панель «Скачать» (карточка duopulse-118).
initDownloadButton();

// URL активной вкладки — в адресную строку (кроме моментов ввода); сюда же —
// звёздочка (SPA-навигация и Ctrl+D из контента тоже приходят tabs.updated).
onTabsChanged((tabs) => {
  const active = tabs.find((t) => t.active);
  setActiveUrl(active?.url ?? "");
  setActivePage(active);
  // инкогнито-вкладка активна (карточка 096): подсказки omnibox не тянут
  // историю/закладки профиля
  setIncognito(Boolean(active?.incognito));
});

// Кнопки навигации (nav.* контракта действуют на активную вкладку).
document.getElementById("back")?.addEventListener("click", () => void bridge.nav.goBack().catch(console.error));
document.getElementById("fwd")?.addEventListener("click", () => void bridge.nav.goForward().catch(console.error));
document.getElementById("reload")?.addEventListener("click", () => void bridge.nav.reload().catch(console.error));

// Внутренняя страница «История и закладки» (задача 1.4): открывается
// вкладкой duopulse://history — как chrome://history.
document.getElementById("libBtn")?.addEventListener("click", () => {
  void bridge.tabs.open({ url: "duopulse://history" }).catch(console.error);
});
