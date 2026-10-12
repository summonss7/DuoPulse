// DuoPulse — UI-хром: таб-бар (задача 1.2) + адресная строка omnibox (1.3).
// Ввод разбирает Core (nav.resolve_omnibox: URL с догадкой схемы или поиск),
// подсказки — history.search (FTS5 по истории и закладкам); Enter — nav.navigate
// активной вкладки. Список вкладок и их URL приходят событием tabs.updated —
// omnibox показывает URL активной вкладки (когда не в фокусе).
import { bridge } from "./bridge";
import "./bridge/dev-probe";
import { initTabBar, onTabsChanged } from "./chrome/tabbar";
import { initOmnibox, setActiveUrl } from "./chrome/omnibox";
import "./proxy-menu";
import "./style.css";

// Таб-бар (задача 1.2): рендер вкладок, хоткеи, контекст-меню.
initTabBar();
// Omnibox (задача 1.3): подсказки, Enter/Esc/стрелки, кнопки навигации.
initOmnibox();

// URL активной вкладки — в адресную строку (кроме моментов ввода).
onTabsChanged((tabs) => {
  const active = tabs.find((t) => t.active);
  setActiveUrl(active?.url ?? "");
});

// Кнопки навигации (nav.* контракта действуют на активную вкладку).
document.getElementById("back")?.addEventListener("click", () => void bridge.nav.goBack().catch(console.error));
document.getElementById("fwd")?.addEventListener("click", () => void bridge.nav.goForward().catch(console.error));
document.getElementById("reload")?.addEventListener("click", () => void bridge.nav.reload().catch(console.error));
