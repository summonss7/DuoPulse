// @vitest-environment happy-dom
// DuoPulse — инлайн-переименование на строке закладок (duopulse-149):
// поле вместо подписи, Enter — сохранить (пустое имя разрешено закладке —
// чип-значок как в Chrome), Escape/blur — отмена, повторный вызов — фокус
// на живое поле. Папка (allowEmpty: false) пустое имя не сохраняет.
import { describe, expect, it, vi } from "vitest";
import { beginInlineRename } from "./bm-rename";

/** Чип-кнопка как на строке: иконка + подпись (может отсутствовать). */
const chip = (label?: string): HTMLButtonElement => {
  const btn = document.createElement("button");
  btn.className = label === undefined ? "bm-item bm-icon-only" : "bm-item";
  btn.draggable = true;
  const ico = document.createElement("i");
  ico.className = "bm-ico";
  btn.append(ico);
  if (label !== undefined) {
    const el = document.createElement("span");
    el.className = "bm-label";
    el.textContent = label;
    btn.append(el);
  }
  document.body.append(btn);
  return btn;
};

const type = (btn: HTMLElement, value: string): void => {
  const input = btn.querySelector<HTMLInputElement>("input.bm-rename")!;
  input.value = value;
};

const press = (btn: HTMLElement, key: string): void => {
  const input = btn.querySelector<HTMLInputElement>("input.bm-rename")!;
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
};

describe("duopulse-149: beginInlineRename", () => {
  it("Enter — сохранить изменение, поле уходит, подпись возвращается", () => {
    const btn = chip("Сайт");
    const save = vi.fn();
    beginInlineRename({ host: btn, initial: "Сайт", allowEmpty: true, ariaLabel: "переименовать", save });
    type(btn, "Новый сайт");
    press(btn, "Enter");
    expect(save).toHaveBeenCalledWith("Новый сайт");
    expect(btn.querySelector("input")).toBeNull();
    expect((btn.querySelector(".bm-label") as HTMLElement).hidden).toBe(false);
    expect(btn.draggable).toBe(true);
  });

  it("пустое имя: закладке разрешено (allowEmpty), папке — нет", () => {
    const bmBtn = chip("Сайт");
    const bmSave = vi.fn();
    beginInlineRename({ host: bmBtn, initial: "Сайт", allowEmpty: true, ariaLabel: "x", save: bmSave });
    type(bmBtn, "   ");
    press(bmBtn, "Enter");
    expect(bmSave).toHaveBeenCalledWith("");

    const folderBtn = chip("Музыка");
    const folderSave = vi.fn();
    beginInlineRename({ host: folderBtn, initial: "Музыка", allowEmpty: false, ariaLabel: "x", save: folderSave });
    type(folderBtn, "");
    press(folderBtn, "Enter");
    expect(folderSave).not.toHaveBeenCalled();
  });

  it("Escape и blur — отмена без сохранения; правка чипа-значка без подписи", () => {
    const escBtn = chip("Сайт");
    const escSave = vi.fn();
    beginInlineRename({ host: escBtn, initial: "Сайт", allowEmpty: true, ariaLabel: "x", save: escSave });
    press(escBtn, "Escape");
    expect(escSave).not.toHaveBeenCalled();
    expect(escBtn.querySelector("input")).toBeNull();

    const iconBtn = chip(undefined);
    const save = vi.fn();
    beginInlineRename({ host: iconBtn, initial: "", allowEmpty: true, ariaLabel: "x", save });
    type(iconBtn, "Имя");
    iconBtn.querySelector("input")!.dispatchEvent(new FocusEvent("blur"));
    expect(save).not.toHaveBeenCalled(); // blur — отмена, не сохранение
    expect(iconBtn.querySelector("input")).toBeNull();
  });
});
