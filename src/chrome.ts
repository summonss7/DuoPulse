// DuoPulse — UI-хром браузера (webview «main»): таб-бар (задача 1.2),
// адресная строка omnibox (задача 1.3), кнопки навигации, главное меню
// (задача 1.5). Внутренние страницы duopulse:// (задача 1.4) имеют свой
// вход — src/pages/ + роутер src/main.ts; сюда не импортируются.
import { bridge } from "./bridge";
import { initTabBar, onTabsChanged } from "./chrome/tabbar";
import { initOmnibox, setActiveUrl } from "./chrome/omnibox";
import "./chrome/mainmenu";
import "./proxy-menu";
import "./vpn-panel/vpn-panel";
import { initDuo } from "./subtitles-panel/duo";
import { initTranslateSettings } from "./subtitles-panel/translate-settings";

// Таб-бар (задача 1.2): рендер вкладок, хоткеи, контекст-меню.
initTabBar();
// Omnibox (задача 1.3): подсказки, Enter/Esc/стрелки, кнопки навигации.
initOmnibox();
// Кнопка «duo» + панель настроек набора субтитров (задача 3.7, docs/03 §8).
initDuo();
// Секция «Перевод» duo-панели: провайдеры DeepL/Google/LibreTranslate (4.1).
initTranslateSettings();

// URL активной вкладки — в адресную строку (кроме моментов ввода).
onTabsChanged((tabs) => {
  const active = tabs.find((t) => t.active);
  setActiveUrl(active?.url ?? "");
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
