// DuoPulse — модель перестановки вкладок drag&drop'ом (карточка
// duopulse-205: «зажал левую кнопку мыши и перетащил окно»). Чистая
// функция — для тестов без DOM; события таб-бара (dragstart/dragover/drop)
// и команда tabs.move — в tabbar.ts, как у строки закладок (bmbar.ts).
import type { TabInfo } from "../bridge";

/** Новый порядок вкладок после drag&drop (чистая, тестится): dragged
 *  вынимается и вставляется перед beforeId (null — в конец). Перед самим
 *  собой или соседом справа — порядок не меняется (Core такой ход
 *  пропускает, UI команду не шлёт). */
export function tabReorder(
  tabs: Pick<TabInfo, "id">[],
  dragged: string,
  beforeId: string | null,
): string[] {
  const ids = tabs.map((t) => t.id);
  if (!ids.includes(dragged)) return ids; // вкладка исчезла (закрылась) — нет хода
  if (beforeId === dragged) return ids;
  const rest = ids.filter((u) => u !== dragged);
  const at = beforeId === null ? rest.length : rest.indexOf(beforeId);
  rest.splice(at < 0 ? rest.length : at, 0, dragged);
  return rest;
}

/** Сосед, перед которым встанет вкладка (чистая, тестится): первая вкладка
 *  справа от курсора, чей центр правее x (кроме тянущейся), null — в конец.
 *  dragover помечает цель маркером, drop шлёт её id командой tabs.move. */
export function dropBeforeId(
  tabs: { id: string; left: number; width: number }[],
  x: number,
  dragged: string,
): string | null {
  const next = tabs.find(
    (t) => t.id !== dragged && t.left + t.width / 2 > x,
  );
  return next?.id ?? null;
}
