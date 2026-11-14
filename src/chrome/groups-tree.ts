// DuoPulse — чистая работа с деревом групп закладок (карточка duopulse-151):
// группы вкладываются друг в друга (parentId, до MAX_GROUP_DEPTH уровней).
// Здесь — порядок для списков (корни по position, подгруппы следом за
// родителем), метки с путём («Родитель › Ребёнок») и проверки переноса
// (циклы, глубина). Без DOM: используется страницей управления, строкой
// закладок, звёздочкой и мобильной веткой; тестируется vitest напрямую.
import type { BookmarkGroupInfo } from "../bridge";

/** Максимум уровней дерева групп — как в Core (history/mod.rs). */
export const MAX_GROUP_DEPTH = 3;

/** Сортировка сестёрских групп: по позиции, при равенстве — по имени. */
const byPos = (a: BookmarkGroupInfo, b: BookmarkGroupInfo): number =>
  a.position - b.position || a.name.localeCompare(b.name);

/** Группы в порядке дерева: корни по position, подгруппы — сразу за
 *  родителем (рекурсивно). Группы с битым parentId (родителя нет в списке)
 *  показываются в конце как корни — дерево не теряет строк. */
export function groupTreeOrder(groups: BookmarkGroupInfo[]): BookmarkGroupInfo[] {
  const byParent = new Map<number, BookmarkGroupInfo[]>();
  const roots: BookmarkGroupInfo[] = [];
  const seen = new Set<number>();
  for (const g of groups) {
    if (g.parentId != null && groups.some((o) => o.id === g.parentId)) {
      const list = byParent.get(g.parentId) ?? [];
      list.push(g);
      byParent.set(g.parentId, list);
    } else {
      roots.push(g);
    }
  }
  const out: BookmarkGroupInfo[] = [];
  const walk = (parent: BookmarkGroupInfo): void => {
    out.push(parent);
    seen.add(parent.id);
    for (const kid of (byParent.get(parent.id) ?? []).slice().sort(byPos)) walk(kid);
  };
  for (const root of roots.slice().sort(byPos)) walk(root);
  return out;
}

/** Карта id → группа. */
const byId = (groups: BookmarkGroupInfo[]): Map<number, BookmarkGroupInfo> =>
  new Map(groups.map((g) => [g.id, g]));

/** Путь имени группы от корня: «Родитель › Ребёнок» (меню звёздочки,
 *  подсказки). Битая цепочка обрывается — цикл невозможен. */
export function groupPath(groups: BookmarkGroupInfo[], id: number): string {
  const map = byId(groups);
  const parts: string[] = [];
  const guard = new Set<number>();
  let cur: BookmarkGroupInfo | undefined = map.get(id);
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    parts.unshift(cur.name);
    cur = cur.parentId != null ? map.get(cur.parentId) : undefined;
  }
  return parts.join(" › ");
}

/** node — потомок ancestor (или сам ancestor) в дереве групп. */
export function isGroupDescendant(
  groups: BookmarkGroupInfo[],
  ancestorId: number,
  nodeId: number,
): boolean {
  const map = byId(groups);
  const guard = new Set<number>();
  let cur: BookmarkGroupInfo | undefined = map.get(nodeId);
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    if (cur.id === ancestorId) return true;
    cur = cur.parentId != null ? map.get(cur.parentId) : undefined;
  }
  return false;
}

/** Высота поддерева группы, считая её саму (лист — 1). */
export function groupSubtreeHeight(groups: BookmarkGroupInfo[], id: number): number {
  const kidsOf = new Map<number, BookmarkGroupInfo[]>();
  for (const g of groups) {
    if (g.parentId == null) continue;
    const list = kidsOf.get(g.parentId) ?? [];
    list.push(g);
    kidsOf.set(g.parentId, list);
  }
  const height = (gid: number, guard: Set<number>): number => {
    if (guard.has(gid)) return 1; // битый цикл — обрыв
    guard.add(gid);
    const kids = kidsOf.get(gid) ?? [];
    return 1 + Math.max(0, ...kids.map((k) => height(k.id, guard)));
  };
  return height(id, new Set());
}

/** Можно ли переложить группу под родителя (drag чипа группы, duopulse-151):
 *  null — в корень; нельзя — в себя/своего потомка (цикл), группу по
 *  умолчанию (всегда корень) и за пределы 3 уровней. */
export function canGroupMoveTo(
  groups: BookmarkGroupInfo[],
  id: number,
  parent: number | null,
): boolean {
  const map = byId(groups);
  const g = map.get(id);
  if (!g || g.isDefault) return false;
  if (parent == null) return true;
  const p = map.get(parent);
  if (!p || parent === id || isGroupDescendant(groups, id, parent)) return false;
  return p.depth + groupSubtreeHeight(groups, id) <= MAX_GROUP_DEPTH;
}
