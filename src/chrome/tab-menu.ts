// DuoPulse — модель контекстного меню вкладки (карточка duopulse-086):
// какие пункты недоступны в данном состоянии списка. Разметка меню — в
// оверлей-окне (src/menu-overlay.ts), эта логика — в UI (tabbar.ts) и
// уходит в оверлей payload'ом; чистая функция — для тестов без DOM.
import type { TabInfo } from "../bridge";

/** Недоступные пункты меню вкладки: без вкладки (пустое место бара) — все
 *  вкладочные, единственная вкладка — «Закрыть другие», активная/спящая —
 *  «Усыпить» (доступна фоновой неспящей). */
export function tabMenuDisabled(list: TabInfo[], id: string | null): string[] {
  const tab = id ? list.find((t) => t.id === id) : null;
  if (!tab) return ["duplicate", "sleep", "close", "closeOthers"];
  const disabled: string[] = [];
  if (list.length <= 1) disabled.push("closeOthers");
  if (tab.active || tab.sleeping) disabled.push("sleep");
  return disabled;
}
