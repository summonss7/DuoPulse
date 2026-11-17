// Юнит-тесты пейлоада захвата паролей web-оверлея (карточка duopulse-165):
// источник — src-tauri/src/mobile_pass_capture.js (тот же текст, что Core
// отдаёт Kotlin'у include_str!'ом), исполняем честно в happy-dom и дерём
// события формы. Канал — стаб window.DuopulsePass (в WebView его кладёт
// addJavascriptInterface); фиксируем мобильные отличия от десктопного
// content/passwords-fill.ts: тап по самому полю кандидатом НЕ считается.
// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Пейлоад один на тест-ран: маркер __dpPassWatch снимаем перед каждым.
 *  Путь от корня проекта (cwd vitest): import.meta.url в тест-раннере не
 *  file-схемы, URL для readFileSync не годится. */
const payload = readFileSync(
  resolve(process.cwd(), "src-tauri/src/mobile_pass_capture.js"),
  "utf8",
);

interface Report {
  username: string;
  password: string;
}

let reports: Report[] = [];

beforeEach(() => {
  reports = [];
  // свежий документ на каждый тест: пейлоад вешает слушатели на document,
  // в общем документе они копились бы между прогонами (в WebView каждая
  // навигация даёт новый документ — там накопления нет)
  vi.stubGlobal("document", document.implementation.createHTMLDocument("t"));
  delete (window as unknown as { __dpPassWatch?: number }).__dpPassWatch;
  (window as unknown as { DuopulsePass?: unknown }).DuopulsePass = {
    report: (json: string): void => {
      reports.push(JSON.parse(json) as Report);
    },
  };
  new Function(payload)();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Форма логина: логин + пароль + сабмит-кнопка (по умолчанию в форме). */
function loginForm(withForm = true): { user: HTMLInputElement; pass: HTMLInputElement; btn: HTMLElement } {
  const frag = document.createElement(withForm ? "form" : "div");
  const user = document.createElement("input");
  user.type = "text";
  const pass = document.createElement("input");
  pass.type = "password";
  const btn = document.createElement("button");
  btn.textContent = "Войти";
  frag.append(user, pass, btn);
  document.body.append(frag);
  return { user, pass, btn };
}

describe("пейлоад захвата паролей оверлея", () => {
  it("маркер установлен — повторная инжекция на том же документе тихая", () => {
    new Function(payload)(); // второй прогон по тому же документу
    expect((window as unknown as { __dpPassWatch?: number }).__dpPassWatch).toBe(1);
    const { user, pass, btn } = loginForm();
    user.value = "artem";
    pass.value = "p1";
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(reports.length).toBe(1);
  });

  it("сабмит формы: пара логин+пароль уходит в DuopulsePass", () => {
    const { user, pass, btn } = loginForm();
    user.value = "artem";
    pass.value = "secret";
    btn.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true }));
    expect(reports).toEqual([{ username: "artem", password: "secret" }]);
  });

  it("Enter в поле пароля — кандидат (сабмит без кнопки)", () => {
    const { user, pass } = loginForm();
    user.value = "artem";
    pass.value = "p1";
    pass.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(reports).toEqual([{ username: "artem", password: "p1" }]);
  });

  it("SPA-форма без <form>: клик по кнопке в общем контейнере", () => {
    const { user, pass, btn } = loginForm(false);
    user.value = "a@b.c";
    pass.value = "p2";
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(reports).toEqual([{ username: "a@b.c", password: "p2" }]);
  });

  it("клик по сабмит-кнопке с type=submit у input", () => {
    const { user, pass } = loginForm(false);
    const btn = document.createElement("input");
    btn.type = "submit";
    (pass.closest("div") as HTMLElement).append(btn);
    user.value = "u";
    pass.value = "p";
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(reports).toEqual([{ username: "u", password: "p" }]);
  });

  it("тап по самому полю — кандидат НЕ собирается (мобильное отличие)", () => {
    const { user, pass } = loginForm();
    user.value = "artem";
    pass.value = "typed";
    pass.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    user.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(reports).toEqual([]);
  });

  it("пустой логин или пароль — репорта нет (Core отверг бы)", () => {
    const { user, pass, btn } = loginForm(false);
    pass.value = "p";
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); // логин пуст
    user.value = "artem";
    pass.value = "";
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); // пароль пуст
    expect(reports).toEqual([]);
  });

  it("дедуп пары; смена пароля проходит повторно", () => {
    const { user, pass, btn } = loginForm(false);
    user.value = "artem";
    pass.value = "p1";
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(reports.length).toBe(1);
    pass.value = "p2";
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(reports.map((r) => r.password)).toEqual(["p1", "p2"]);
  });

  it("логин ищется до первого поля пароля (регистрация с confirm)", () => {
    const form = document.createElement("form");
    const user = document.createElement("input");
    user.type = "email";
    const pass = document.createElement("input");
    pass.type = "password";
    const confirm = document.createElement("input");
    confirm.type = "password";
    const btn = document.createElement("button");
    form.append(user, pass, confirm, btn);
    document.body.append(form);
    user.value = "a@b.c";
    pass.value = "p1";
    confirm.value = "p1";
    form.dispatchEvent(new Event("submit", { bubbles: true }));
    expect(reports).toEqual([{ username: "a@b.c", password: "p1" }]);
  });

  it("клик мимо формы логина — тишина", () => {
    loginForm();
    const other = document.createElement("button");
    document.body.append(other);
    other.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    other.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(reports).toEqual([]);
  });

  it("пароль не идёт через консоль: пейлоад без console-вызовов", () => {
    expect(payload).not.toContain("console.");
    // канал один — JS-интерфейс DuopulsePass (прямое JNI-сообщение в Kotlin)
    expect(payload).toContain("DuopulsePass");
  });
});
