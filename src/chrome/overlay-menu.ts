// DuoPulse — транспорт нативных popup-меню хрома (карточка duopulse-086).
// Контентные webview рисуются поверх HTML UI, поэтому контекстное меню
// вкладки и меню звёздочки показывает Core нативным popup'ом muda
// (src-tauri/src/chrome_menu.rs): системный рендер поверх всех webview,
// модальность и Escape из коробки. UI открывает меню командой ui_menu_open
// (kind + точка в клиентских логических координатах + payload), выбор
// пункта возвращается событием «menu-action».
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Действие из меню: menu — вид меню, остальные поля — по виду. */
export interface MenuAction {
  menu: "tab" | "star" | "duo" | "bmfolder";
  [k: string]: unknown;
}

/** Открыть нативное меню у точки (x/y — координаты UI-webview). */
export function openOverlayMenu(kind: "tab" | "star" | "duo" | "bmfolder", x: number, y: number, payload: unknown): void {
  void invoke("ui_menu_open", { kind, x, y, payload }).catch((e) =>
    console.error("overlay-menu:", e)
  );
}

/** Подписка на выбор пункта (один обработчик на вид — tabbar/star/duo). */
export function onOverlayMenuAction(cb: (action: MenuAction) => void): void {
  void listen<MenuAction>("menu-action", (ev) => cb(ev.payload));
}
