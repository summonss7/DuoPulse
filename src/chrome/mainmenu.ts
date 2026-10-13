// DuoPulse — главное меню браузера (задача 1.5; docs/05 §1 src/chrome/MainMenu).
// Кнопка «⋮» в навбаре; пункты — быстрые действия поверх контракта bridge:
// новая вкладка, переоткрытие закрытой, внутренняя страница истории, прокси.
// Стиль — единый с контекст-меню вкладки (панель 12px, elevated, гайд 06 §5);
// открытие закрывает прочие панели хрома (меню вкладки/прокси).
import { bridge } from "../bridge";

const err = (e: unknown): void => console.error("mainmenu:", e);
const btn = document.getElementById("mainBtn") as HTMLButtonElement;
const menu = document.getElementById("mainMenu") as HTMLDivElement;

/** Прочие всплывающие панели хрома (открытие одного закрывает остальные). */
function closeOtherPanels(): void {
  (document.getElementById("tabMenu") as HTMLElement).hidden = true;
  (document.getElementById("proxyMenu") as HTMLElement).hidden = true;
}

btn.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = menu.hidden;
  if (open) closeOtherPanels();
  menu.hidden = !open;
});

// закрытие кликом мимо / Escape — как у меню вкладки (tabbar.ts)
window.addEventListener(
  "mousedown",
  (e) => {
    if (!menu.hidden && !(e.target as HTMLElement).closest("#mainMenu, #mainBtn")) menu.hidden = true;
  },
  true
);
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !menu.hidden) menu.hidden = true;
});

menu.addEventListener("click", (e) => {
  const item = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
  if (!item) return;
  menu.hidden = true;
  switch (item.dataset.act) {
    case "newtab":
      void bridge.tabs.open({}).catch(err);
      break;
    case "reopen":
      void bridge.tabs.reopen().catch(err);
      break;
    case "history":
      void bridge.tabs.open({ url: "duopulse://history" }).catch(err);
      break;
    case "proxy":
      // переиспользуем обработчик кнопки навбара: тумблер/статус обновятся сами
      document.getElementById("proxyBtn")?.click();
      break;
  }
});
