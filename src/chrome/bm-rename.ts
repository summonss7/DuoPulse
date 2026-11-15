// DuoPulse — инлайн-переименование закладки/папки (карточка duopulse-149):
// правый клик по чипу строки → нативное меню «Переименовать…», по строке
// панели папки — сразу поле; вместо подписа появляется input (иконка
// остаётся), Enter — сохранить, Escape/blur — отмена. Пустое имя разрешено
// только закладке (allowEmpty): чип без названия — только значок, как в
// Chrome (больше закладок влезает в строку); папка без имени не ищется.
// Модуль чистый от транспорта — используется строкой (bmbar.ts) и панелью
// папки (bm-folder-panel.ts).
export interface InlineRenameOpts {
  /** Контейнер: кнопка-чип/папка на строке или строка панели папки. */
  host: HTMLElement;
  /** Текущее имя (может быть пустым — редактируем и пустое). */
  initial: string;
  /** Пустое имя разрешено (закладка); папка — нет. */
  allowEmpty: boolean;
  /** aria-label поля (локализует вызывающий). */
  ariaLabel: string;
  /** Сохранение нового имени (вызывается только при изменении). */
  save: (title: string) => void;
}

/** Начать правку: input вместо подписи (после иконки), фокус + выделение.
 * Повторный вызов на том же контейнере — просто фокус на живое поле. */
export function beginInlineRename(o: InlineRenameOpts): void {
  const live = o.host.querySelector<HTMLInputElement>("input.bm-rename");
  if (live) {
    live.focus();
    live.select();
    return;
  }
  const label = o.host.querySelector<HTMLElement>(":scope > .bm-label");
  const input = document.createElement("input");
  input.className = "bm-rename";
  input.type = "text";
  input.value = o.initial;
  input.spellcheck = false;
  input.maxLength = 200;
  input.setAttribute("aria-label", o.ariaLabel);
  // input внутри draggable-кнопки мешает выделению текста — на время правки
  // перетаскивание чипа/строки выключаем
  const wasDraggable = o.host.draggable;
  o.host.draggable = false;
  label?.setAttribute("hidden", "");
  const anchor = o.host.querySelector(":scope > .bm-ico, :scope > svg");
  if (anchor) anchor.after(input);
  else o.host.prepend(input);
  input.focus();
  input.select();
  /** Убрать поле, вернуть подпись и перетаскивание. */
  const finish = (): void => {
    input.remove();
    label?.removeAttribute("hidden");
    o.host.draggable = wasDraggable;
  };
  let done = false;
  input.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Escape") {
      done = true;
      finish();
    }
    if (ev.key === "Enter") {
      done = true;
      const title = input.value.trim();
      finish();
      if ((title || o.allowEmpty) && title !== o.initial.trim()) o.save(title);
    }
  });
  input.addEventListener("blur", () => {
    if (!done) finish();
  });
}
