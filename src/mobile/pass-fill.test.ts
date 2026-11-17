// Юнит-тесты пейлоада автозаполнения паролей web-оверлея (карточка
// duopulse-166): источник — src-tauri/src/mobile_pass_fill.js (тот же текст,
// что Core отдаёт Kotlin'у include_str!'ом), исполняем честно в happy-dom.
// Канал — стаб window.DuopulseFill (в WebView его кладёт
// addJavascriptInterface), ответы Core — вызовы window.__dpPassAccounts /
// __dpPassFill (их в WebView делает Kotlin). Фиксируем мобильные отличия от
// десктопного content/passwords-fill.ts: старт — тап по иконке-ключу, а не
// клик по полю; пароль — аргумент __dpPassFill, после заполнения в JS
// не остаётся. happy-dom не считает layout: getBoundingClientRect даёт
// нули — иконка в DOM, дисплей может быть погашен (позиции — живой смоук).
// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const payload = readFileSync(
  resolve(process.cwd(), "src-tauri/src/mobile_pass_fill.js"),
  "utf8",
);

let readyCalls: number;
let picks: number;

beforeEach(() => {
  readyCalls = 0;
  picks = 0;
  // свежий документ на каждый тест: слушатели/иконки в общем документе
  // копились бы между прогонами (в WebView каждая навигация — новый документ)
  vi.stubGlobal("document", document.implementation.createHTMLDocument("t"));
  delete (window as unknown as { __dpPassFillWatch?: number }).__dpPassFillWatch;
  (window as unknown as { DuopulseFill?: unknown }).DuopulseFill = {
    ready: (): void => {
      readyCalls += 1;
    },
    pick: (): void => {
      picks += 1;
    },
  };
  new Function(payload)();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Форма логина: логин + пароль (+ submit-кнопка) в <form> или в div (SPA). */
function loginForm(withForm = true): { user: HTMLInputElement; pass: HTMLInputElement } {
  const frag = document.createElement(withForm ? "form" : "div");
  const user = document.createElement("input");
  user.type = "text";
  const pass = document.createElement("input");
  pass.type = "password";
  frag.append(user, pass);
  document.body.append(frag);
  return { user, pass };
}

/** Все иконки-ключи текущего документа. */
const icons = (): Element[] =>
  Array.from(document.querySelectorAll("[data-duopulse-passkey]"));

/** Прибытие логинов сайта (так их кладёт Kotlin после Core accounts_for). */
const accounts = (...names: string[]): void => {
  (window as unknown as { __dpPassAccounts: (l: string[]) => void }).__dpPassAccounts(names);
};

/** Заполнение выбранным логином (так Kotlin приносит пару после выбора). */
const fill = (user: string, pass: string): void => {
  (window as unknown as { __dpPassFill: (u: string, p: string) => void }).__dpPassFill(user, pass);
};

describe("пейлоад автозаполнения оверлея", () => {
  it("маркер установлен — повторная инжекция на том же документе тихая", () => {
    new Function(payload)(); // второй прогон по тому же документу
    expect((window as unknown as { __dpPassFillWatch?: number }).__dpPassFillWatch).toBe(1);
    loginForm();
    // форму находит скан первого прогона (MutationObserver, уступка 300 мс)
    return vi
      .waitFor(() => expect(readyCalls).toBe(1))
      .then(() => undefined);
  });

  it("форма логина найдена → DuopulseFill.ready() один раз; без формы — тишина", async () => {
    expect(readyCalls).toBe(0);
    loginForm();
    await vi.waitFor(() => expect(readyCalls).toBe(1));
    // дорисованная SPA-форма ready повторно не зовёт (accounts в Core не меняются)
    loginForm(false);
    await new Promise((r) => setTimeout(r, 450)); // уступка сканера прошла
    expect(readyCalls).toBe(1);
  });

  it("до ответа Core (инкогнито-модель) иконок нет; после __dpPassAccounts — появились", () => {
    loginForm();
    expect(icons()).toHaveLength(0); // Kotlin в инкогнито не отвечает — иконок нет
    accounts("artem");
    expect(icons()).toHaveLength(1);
    // второй password-поля — своя иконка
    const p2 = document.createElement("input");
    p2.type = "password";
    document.body.append(p2);
    return vi
      .waitFor(() => expect(icons()).toHaveLength(2)) // MutationObserver ~300 мс
      .then(() => undefined);
  });

  it("пустой список (нет сохранённых/инкогнито) снимает иконки", () => {
    loginForm();
    accounts("artem");
    expect(icons()).toHaveLength(1);
    accounts();
    expect(icons()).toHaveLength(0);
  });

  it("мусорный payload аккаунтов не ломает пейлоад (строки/не-массив)", () => {
    loginForm();
    (window as unknown as { __dpPassAccounts?: (l: unknown) => void }).__dpPassAccounts?.("junk");
    expect(icons()).toHaveLength(0);
    (window as unknown as { __dpPassAccounts?: (l: unknown) => void }).__dpPassAccounts?.([
      "artem",
      42,
      null,
    ]);
    expect(icons()).toHaveLength(1); // валидные строки дошли, мусор отсеян
  });

  it("тап по иконке → DuopulseFill.pick (один аккаунт заполнит Kotlin без листа)", () => {
    loginForm();
    accounts("artem", "alya");
    const ic = icons()[0] as HTMLElement;
    ic.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(picks).toBe(1);
  });

  it("__dpPassFill заполняет пару тапнутой иконки: значения + input/change", () => {
    const { user, pass } = loginForm();
    accounts("artem");
    const seen: string[] = [];
    for (const el of [user, pass]) {
      el.addEventListener("input", () => seen.push(`input:${el.value}`));
      el.addEventListener("change", () => seen.push(`change:${el.value}`));
    }
    icons()[0].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    fill("artem", "s3cret!");
    expect(user.value).toBe("artem");
    expect(pass.value).toBe("s3cret!");
    expect(seen).toEqual([
      "input:artem",
      "change:artem",
      "input:s3cret!",
      "change:s3cret!",
    ]);
  });

  it("без тапа по иконке заполняется первая найденная пара (SPA без <form>)", () => {
    const { user, pass } = loginForm(false);
    accounts("artem");
    fill("artem", "p1");
    expect(user.value).toBe("artem");
    expect(pass.value).toBe("p1");
  });

  it("исчезнувшее поле пароля теряет иконку (SPA перерисовал форму)", () => {
    const { pass } = loginForm();
    accounts("artem");
    expect(icons()).toHaveLength(1);
    pass.remove();
    return vi
      .waitFor(() => expect(icons()).toHaveLength(0))
      .then(() => undefined);
  });

  it("пароль не остаётся в JS: пейлоад без консоли/хранилищ, пары не текут", () => {
    expect(payload).not.toContain("console.");
    expect(payload).not.toContain("localStorage");
    expect(payload).not.toContain("sessionStorage");
    // канал один — JS-интерфейс DuopulseFill (пароль приходит только
    // аргументом __dpPassFill от Kotlin)
    expect(payload).toContain("DuopulseFill");
    const { pass } = loginForm();
    accounts("artem");
    icons()[0].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    fill("artem", "topsecret");
    expect(pass.value).toBe("topsecret");
    // окно не накопило секретов: __dpPassFill-аргументы нигде не сохранены
    expect(JSON.stringify(Object.keys(window))).not.toContain("topsecret");
  });

  it("битые аргументы __dpPassFill — тишина, значения не трогаем", () => {
    const { user, pass } = loginForm();
    accounts("artem");
    icons()[0].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    fill("", "p");
    fill("u", "");
    (window as unknown as { __dpPassFill?: (u: unknown, p: unknown) => void }).__dpPassFill?.(
      42,
      {},
    );
    expect(user.value + pass.value).toBe("");
  });
});
