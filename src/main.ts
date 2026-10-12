// DuoPulse — UI-хром: таб-бар (задача 1.2) + адресная строка (M0-спайк).
// Ввод URL/запроса → команда nav.navigate контракта bridge → Core → активная
// вкладка (webview "tab-N"). Список вкладок и их URL приходят событием
// tabs.updated — omnibox показывает URL активной вкладки (когда не в фокусе).
import { bridge } from "./bridge";
import "./bridge/dev-probe";
import { initTabBar, onTabsChanged } from "./chrome/tabbar";
import "./proxy-menu";
import "./style.css";

const omnibox = document.getElementById("omnibox") as HTMLInputElement;

// Заглушка omnibox: URL как есть, «похоже на домен» — https://,
// прочее — поисковый запрос YouTube (спайк про YouTube).
function normalize(input: string): string {
  const t = input.trim();
  if (!t) return "";
  if (/^(https?:\/\/|file:\/\/|about:)/i.test(t)) return t;
  if (/^[\w-]+(\.[\w-]+)+([\/?#].*)?$/.test(t)) return "https://" + t;
  return "https://www.youtube.com/results?search_query=" + encodeURIComponent(t);
}

async function nav(): Promise<void> {
  const url = normalize(omnibox.value);
  if (!url) return;
  try {
    await bridge.nav.navigate({ url });
  } catch (e) {
    console.error("nav.navigate failed:", e);
  }
}

omnibox.addEventListener("keydown", (e) => {
  if (e.key === "Enter") void nav();
});
document.getElementById("go")?.addEventListener("click", () => void nav());
document.getElementById("back")?.addEventListener("click", () => void bridge.nav.goBack().catch(console.error));
document.getElementById("fwd")?.addEventListener("click", () => void bridge.nav.goForward().catch(console.error));
document.getElementById("reload")?.addEventListener("click", () => void bridge.nav.reload().catch(console.error));

// Таб-бар (задача 1.2): рендер вкладок, хоткеи, контекст-меню.
initTabBar();
// URL активной вкладки — в omnibox (кроме моментов ввода).
onTabsChanged((tabs) => {
  const active = tabs.find((t) => t.active);
  if (document.activeElement !== omnibox) {
    omnibox.value = active?.url ?? "";
  }
});
