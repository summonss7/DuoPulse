// Плашка/HUD поверх ПОЛНОЭКРАННОГО плеера (duopulse-232: «субтитры на
// свёрнутом окне есть, разворачиваю на весь экран — исчезают»). Fullscreen
// API поднимает элемент плеера в top layer; обычный position:fixed остаётся
// ПОД ним (::backdrop фулскрин-элемента закрывает весь документ) — пере-позиция
// геометрии этого не чинит. Перенос плашки ВНУТРЬ фулскрин-элемента тоже не
// универсален: у кино-сайтов фулскрин просит плеер кросс-доменного фрейма —
// в топ-документе fullscreenElement = сам IFRAME, DOM внутрь него не добавить
// (дети iframe не рендерятся), а у простых страниц фулскрин-элементом бывает
// сам <video>. Решение — Popover API (Chromium 114+): элемент с
// popover="manual" + showPopover() попадает в top layer СВЕРХУ фулскрин-
// элемента (top layer упорядочен по моменту входа — наш popover открывается
// позже) и работает для всех трёх вариантов. Выход из фулскрина — атрибут
// снимаем: элемент возвращается в обычный поток, UA-стили [popover]
// (border/padding/margin/background:Canvas и пр.) действуют только пока
// атрибут стоит; на входе их гасим явно на случай открытого состояния.

/** Синхронизировать элемент с полноэкранным состоянием документа: фулскрин
 * открыт — элемент поднимается в top layer popover'ом; закрыт — popover
 * снимается. Вызывать на fullscreenchange (и достаточно только там: рантайм
 * без Popover API молча остаётся на прежнем поведении — под фулскрином). */
export function syncTopLayerOnFullscreen(el: HTMLElement): void {
  if (document.fullscreenElement) {
    // Нейтрализовать UA-стили открытого [popover]: без этого вокруг плашки
    // рисуются рамка/отступы и белый фон подложки контейнера.
    const s = el.style;
    s.border = "none";
    s.padding = "0";
    s.margin = "0";
    s.inset = "auto";
    s.background = "transparent";
    s.color = "inherit";
    s.overflow = "visible";
    el.popover = "manual";
    try {
      el.showPopover();
    } catch {
      /* рантайм без Popover API / уже открыт — поведение без top layer */
    }
  } else if (el.popover !== null) {
    try {
      el.hidePopover();
    } catch {
      /* уже скрыт навигацией — не критично */
    }
    el.popover = null;
  }
}
