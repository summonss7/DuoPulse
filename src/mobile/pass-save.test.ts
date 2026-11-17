// Юнит-тесты бара «Сохранить пароль?» мобильной ветки (карточка
// duopulse-165): текст под кандидата (новый/обновление), показ по событию
// Core, решение кнопками одной командой mobile_password_resolve
// (save/never/dismiss), закрытие фоном = dismiss. Слушатель события и
// invoke замоканы (паттерн тестов updater/account).
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (ev: { payload: unknown }) => void;
let listeners: Record<string, Handler[]> = {};
let invokes: [string, Record<string, unknown>?][] = [];

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, h: Handler) => {
    (listeners[name] ??= []).push(h);
    return Promise.resolve(() => {});
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    invokes.push([cmd, args]);
    return Promise.resolve(true);
  },
}));

import { MobilePassSave, passPromptText, type PassPromptView } from "./pass-save";

const view = (over: Partial<PassPromptView> = {}): PassPromptView => ({
  tabId: "web-overlay",
  origin: "https://example.com",
  username: "artem",
  updated: false,
  ...over,
});

beforeEach(() => {
  listeners = {};
  invokes = [];
  document.body.innerHTML = "";
});

function fire(payload: PassPromptView): void {
  for (const h of listeners["passwords:save_prompt"] ?? []) h({ payload });
}

describe("passPromptText", () => {
  it("новый логин — «Сохранить…», сайт без схемы", () => {
    expect(passPromptText(view())).toBe(
      "Сохранить пароль для «artem» на example.com?",
    );
  });
  it("обновление — «Обновить сохранённый…»", () => {
    expect(passPromptText(view({ updated: true }))).toBe(
      "Обновить сохранённый пароль для «artem» на example.com?",
    );
  });
});

describe("MobilePassSave", () => {
  it("событие Core открывает лист; «Сохранить» решает одной командой", async () => {
    const note = vi.fn();
    const content = document.createElement("div");
    document.body.append(content);
    new MobilePassSave({ content, note });
    fire(view());
    const wrap = content.querySelector<HTMLElement>(".m-pass-wrap")!;
    expect(wrap.hidden).toBe(false);
    expect(wrap.querySelector(".m-pass-text")!.textContent).toBe(
      "Сохранить пароль для «artem» на example.com?",
    );
    expect(wrap.querySelector<HTMLButtonElement>(".m-pass-save")!.textContent).toBe(
      "Сохранить",
    );
    wrap.querySelector<HTMLButtonElement>(".m-pass-save")!.click();
    await vi.waitFor(() => expect(wrap.hidden).toBe(true));
    expect(invokes).toEqual([["mobile_password_resolve", { action: "save" }]]);
    expect(note).toHaveBeenCalledWith("Пароль сохранён");
  });

  it("обновление — кнопка «Обновить» и тост «Пароль обновлён»", async () => {
    const note = vi.fn();
    const content = document.createElement("div");
    document.body.append(content);
    new MobilePassSave({ content, note });
    fire(view({ updated: true }));
    const wrap = content.querySelector<HTMLElement>(".m-pass-wrap")!;
    expect(wrap.querySelector(".m-pass-save")!.textContent).toBe("Обновить");
    wrap.querySelector<HTMLButtonElement>(".m-pass-save")!.click();
    await vi.waitFor(() => expect(note).toHaveBeenCalledWith("Пароль обновлён"));
  });

  it("«Никогда для этого сайта» — действие never", async () => {
    const content = document.createElement("div");
    document.body.append(content);
    new MobilePassSave({ content, note: () => {} });
    fire(view());
    const wrap = content.querySelector<HTMLElement>(".m-pass-wrap")!;
    wrap.querySelector<HTMLButtonElement>(".m-pass-never")!.click();
    await vi.waitFor(() => expect(wrap.hidden).toBe(true));
    expect(invokes).toEqual([["mobile_password_resolve", { action: "never" }]]);
  });

  it("фон и «Закрыть» — dismiss (кандидат в Core не зависает)", async () => {
    const content = document.createElement("div");
    document.body.append(content);
    new MobilePassSave({ content, note: () => {} });
    fire(view());
    const wrap = content.querySelector<HTMLElement>(".m-pass-wrap")!;
    wrap.querySelector<HTMLElement>(".m-sheet-backdrop")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await vi.waitFor(() => expect(wrap.hidden).toBe(true));
    expect(invokes).toEqual([["mobile_password_resolve", { action: "dismiss" }]]);
  });

  it("решение закрывает лист: повторное событие открывает снова", async () => {
    const content = document.createElement("div");
    document.body.append(content);
    new MobilePassSave({ content, note: () => {} });
    const wrap = content.querySelector<HTMLElement>(".m-pass-wrap")!;
    fire(view());
    wrap.querySelector<HTMLButtonElement>(".m-pass-close")!.click();
    await vi.waitFor(() => expect(wrap.hidden).toBe(true));
    fire(view({ username: "other" }));
    expect(wrap.hidden).toBe(false);
    expect(wrap.querySelector(".m-pass-text")!.textContent).toContain("other");
    // битый payload — тихо, лист не портим
    fire({ tabId: "x", origin: "", username: "", updated: false });
    expect(wrap.hidden).toBe(false);
  });

  it("снимок e2e-хука: open/view/lastAction", async () => {
    const content = document.createElement("div");
    document.body.append(content);
    new MobilePassSave({ content, note: () => {} });
    const hook = (
      window as unknown as { __duopulseMobilePassSave: () => unknown }
    ).__duopulseMobilePassSave;
    expect(hook()).toMatchObject({ open: false, view: null, lastAction: "" });
    fire(view());
    expect(hook()).toMatchObject({ open: true, view: { username: "artem" } });
    content.querySelector<HTMLButtonElement>(".m-pass-save")!.click();
    await vi.waitFor(() =>
      expect(hook()).toMatchObject({ open: false, lastAction: "save" }),
    );
  });
});
