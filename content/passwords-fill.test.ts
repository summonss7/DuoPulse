// Юнит-тесты жизненного цикла паролей в странице (этап 2 duopulse-108):
// детект пары логин+пароль, кандидат по сабмиту (submit/Enter/кнопка,
// дедуп), автозаполнение (один аккаунт — сразу, несколько — chooser),
// инкогнито — пассивность. DOM — happy-dom; канал Core отсутствует —
// сообщения Core доставляются напрямую (перехват onCoreMessage).
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PasswordFill, usernameFieldFor } from "./passwords-fill";

/** Перехват onCoreMessage: content/messaging в happy-dom без канала —
 *  слушатель не ставится; дергаем сами (тот же контракт, что у Core). */
let coreListeners: ((m: Record<string, unknown>) => void)[] = [];

vi.mock("./messaging", () => ({
  onCoreMessage: (h: (m: Record<string, unknown>) => void): (() => void) => {
    coreListeners.push(h);
    return () => {
      coreListeners = coreListeners.filter((x) => x !== h);
    };
  },
  postToCore: (): void => {},
}));

function postFromCore(msg: Record<string, unknown>): void {
  for (const h of [...coreListeners]) h(msg);
}

interface Harness {
  ctrl: PasswordFill;
  posted: Record<string, unknown>[];
}

function makeHarness(incognito = false): Harness {
  const posted: Record<string, unknown>[] = [];
  const ctrl = new PasswordFill(document, { post: (m) => posted.push(m) }, incognito);
  ctrl.start();
  return { ctrl, posted };
}

/** Форма логина: <form><input name=u><input type=password><button></form>. */
function loginForm(opts: { user?: string; pass?: string } = {}): {
  user: HTMLInputElement;
  pass: HTMLInputElement;
  button: HTMLButtonElement;
} {
  const form = document.createElement("form");
  const user = document.createElement("input");
  user.type = "text";
  user.name = "login";
  user.value = opts.user ?? "";
  const pass = document.createElement("input");
  pass.type = "password";
  pass.value = opts.pass ?? "";
  const button = document.createElement("button");
  button.type = "submit";
  button.textContent = "Войти";
  form.append(user, pass, button);
  document.body.append(form);
  return { user, pass, button };
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement
    .querySelectorAll("[data-duopulse-accounts]")
    .forEach((n) => n.remove());
  coreListeners = [];
  vi.useRealTimers();
});

describe("usernameFieldFor", () => {
  it("берёт последнее текстовое поле до пароля в форме", () => {
    const form = document.createElement("form");
    const search = document.createElement("input"); // до — тоже кандидат
    search.type = "text";
    const email = document.createElement("input");
    email.type = "email";
    const pass = document.createElement("input");
    pass.type = "password";
    form.append(search, email, pass);
    document.body.append(form);
    expect(usernameFieldFor(pass)).toBe(email);
  });

  it("без формы ищет по документу; чекбоксы/радио — не логин", () => {
    const chk = document.createElement("input");
    chk.type = "checkbox";
    const user = document.createElement("input"); // без type — текстовое
    const pass = document.createElement("input");
    pass.type = "password";
    document.body.append(chk, user, pass);
    expect(usernameFieldFor(pass)).toBe(user);
  });
});

describe("кандидат по сабмиту", () => {
  it("submit отправляет логин+пароль и шлёт lookup при первом поле", () => {
    const { user, pass } = loginForm({ user: "artem", pass: "s3cret" });
    const { posted } = makeHarness();
    // первый скан уже отправил passwords-lookup
    expect(posted).toEqual([{ duopulse: "passwords-lookup" }]);
    user.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true }));
    const candidate = posted.find((m) => m["duopulse"] === "password-candidate");
    expect(candidate).toMatchObject({ username: "artem", password: "s3cret" });
    expect(candidate).toHaveProperty("url");
    expect(candidate).toHaveProperty("title");
  });

  it("Enter в пароле и клик по кнопке — тоже кандидат, дедуп один", () => {
    loginForm({ user: "artem", pass: "p1" });
    const { posted } = makeHarness();
    const pass = document.querySelector("input[type=password]") as HTMLInputElement;
    pass.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const button = document.querySelector("button") as HTMLButtonElement;
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const candidates = posted.filter((m) => m["duopulse"] === "password-candidate");
    expect(candidates).toHaveLength(1);
    // смена пароля проходит (сценарий «обновить»)
    pass.value = "p2";
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(posted.filter((m) => m["duopulse"] === "password-candidate")).toHaveLength(2);
  });

  it("пустой пароль — кандидата нет; пустой логин (роутер) — законный кандидат", () => {
    const { pass, button } = loginForm({ user: "", pass: "" });
    const { posted } = makeHarness();
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    pass.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(posted.filter((m) => m["duopulse"] === "password-candidate")).toHaveLength(0);

    // duopulse-194: роутер просит только пароль — кандидат с пустым логином
    pass.value = "router-pass";
    pass.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(posted.find((m) => m["duopulse"] === "password-candidate")).toMatchObject({
      username: "",
      password: "router-pass",
    });
  });

  it("форма «только пароль» без <form>: Enter в пароле — кандидат (роутер)", () => {
    const pass = document.createElement("input");
    pass.type = "password";
    pass.value = "admin";
    document.body.append(pass);
    const { posted } = makeHarness();
    pass.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(posted.find((m) => m["duopulse"] === "password-candidate")).toMatchObject({
      username: "",
      password: "admin",
    });
  });

  it("инкогнито: модуль пассивен — ни lookup, ни кандидата", () => {
    loginForm({ user: "artem", pass: "p" });
    const { posted } = makeHarness(true);
    const button = document.querySelector("button") as HTMLButtonElement;
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(posted).toHaveLength(0);
    expect(makeHarness(true).ctrl.state()).toMatchObject({ incognito: true });
  });
});

describe("автозаполнение", () => {
  it("один аккаунт: клик по полю — запрос, ответ заполняет оба поля", () => {
    const { user, pass } = loginForm({ user: "", pass: "" });
    const { ctrl, posted } = makeHarness();
    postFromCore({ duopulse: "passwords-found", origin: "https://example.com", accounts: ["artem"] });
    // duopulse-194: логины пришли — форма заполняется и без клика (как Chrome)
    expect(posted).toContainEqual({ duopulse: "passwords-fill", username: "artem" });
    user.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    postFromCore({ duopulse: "passwords-fill-data", username: "artem", password: "s3cret" });
    expect((user as HTMLInputElement).value).toBe("artem");
    expect(pass.value).toBe("s3cret");
    expect(ctrl.state().lastFilled).toBe("artem");
  });

  it("несколько аккаунтов: chooser у поля, выбор заполняет выбранный", () => {
    const { user, pass } = loginForm({ user: "", pass: "" });
    const { posted } = makeHarness();
    postFromCore({
      duopulse: "passwords-found",
      origin: "https://example.com",
      accounts: ["artem", "alya"],
    });
    // авто — первый аккаунт; переключиться — chooser по клику
    expect(posted).toContainEqual({ duopulse: "passwords-fill", username: "artem" });
    pass.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(posted).toEqual([{ duopulse: "passwords-lookup" }, { duopulse: "passwords-fill", username: "artem" }]);
    const chooser = document.querySelector("[data-duopulse-accounts]");
    expect(chooser).not.toBeNull();
    const items = [...chooser!.children].map((n) => (n as HTMLElement).textContent);
    expect(items).toEqual(["artem", "alya"]);
    (chooser!.children[1] as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(posted).toContainEqual({ duopulse: "passwords-fill", username: "alya" });
    postFromCore({ duopulse: "passwords-fill-data", username: "alya", password: "p2" });
    expect(user.value).toBe("alya");
    expect(pass.value).toBe("p2");
    // chooser закрыт выбором
    expect(document.querySelector("[data-duopulse-accounts]")).toBeNull();
  });

  it("запись «только пароль»: ответ заполняет пароль, логин не трогает", () => {
    loginForm({ user: "", pass: "" });
    const { posted } = makeHarness();
    postFromCore({ duopulse: "passwords-found", origin: "http://192.168.31.1", accounts: [""] });
    expect(posted).toContainEqual({ duopulse: "passwords-fill", username: "" });
    postFromCore({ duopulse: "passwords-fill-data", username: "", password: "router" });
    const pass = document.querySelector("input[type=password]") as HTMLInputElement;
    const user = document.querySelector("input[name=login]") as HTMLInputElement;
    expect(pass.value).toBe("router");
    expect(user.value).toBe("");
  });

  it("авто не спорит с человеком: занятый пароль/чужой логин — не заполняет", () => {
    const { user, pass } = loginForm({ user: "someone-else", pass: "" });
    const { posted } = makeHarness();
    postFromCore({ duopulse: "passwords-found", origin: "https://x", accounts: ["artem"] });
    expect(posted).not.toContainEqual({ duopulse: "passwords-fill", username: "artem" });
    pass.value = "typed";
    user.value = "";
    postFromCore({ duopulse: "passwords-found", origin: "https://x", accounts: ["artem"] });
    expect(posted).not.toContainEqual({ duopulse: "passwords-fill", username: "artem" });
    // ...а явный клик по пустому полю по-прежнему заполняет (не затирая ввод)
    pass.value = "";
    user.value = "artem";
    user.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(posted).toContainEqual({ duopulse: "passwords-fill", username: "artem" });
  });

  it("клик мимо chooser закрывает его; без аккаунтов клик — просто клик", () => {
    loginForm({ user: "", pass: "" });
    const { posted } = makeHarness();
    const pass = document.querySelector("input[type=password]") as HTMLInputElement;
    pass.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(posted).toEqual([{ duopulse: "passwords-lookup" }]); // только lookup
    postFromCore({ duopulse: "passwords-found", origin: "https://x", accounts: ["a", "b"] });
    pass.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector("[data-duopulse-accounts]")).not.toBeNull();
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector("[data-duopulse-accounts]")).toBeNull();
  });

  it("потерянный ранний lookup: активация поля переспрашивает (duopulse-194)", () => {
    vi.useFakeTimers();
    loginForm({ user: "", pass: "" });
    const { posted } = makeHarness();
    expect(posted).toEqual([{ duopulse: "passwords-lookup" }]);
    vi.advanceTimersByTime(1100); // троттлинг повтора 1 с
    const field = document.querySelector("input[name=login]") as HTMLInputElement;
    field.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(posted.filter((m) => m["duopulse"] === "passwords-lookup")).toHaveLength(2);
    // ответ (пусть пустой) останавливает повторы
    postFromCore({ duopulse: "passwords-found", origin: "https://x", accounts: [] });
    vi.advanceTimersByTime(1100);
    field.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(posted.filter((m) => m["duopulse"] === "passwords-lookup")).toHaveLength(2);
  });

  it("SPA перерисовал форму: ответ доходит в живые поля", async () => {
    vi.useFakeTimers();
    loginForm({ user: "", pass: "" });
    const { posted } = makeHarness();
    const pass1 = document.querySelector("input[type=password]") as HTMLInputElement;
    pass1.dispatchEvent(new MouseEvent("click", { bubbles: true })); // lastFocusedPair = форма 1
    postFromCore({ duopulse: "passwords-found", origin: "https://x", accounts: ["artem"] });
    expect(posted).toContainEqual({ duopulse: "passwords-fill", username: "artem" });
    // сайт заменил форму (реакт-ререндер): старая пара мертва
    document.body.innerHTML = "";
    loginForm({ user: "", pass: "" });
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(400); // пересканирование
    postFromCore({ duopulse: "passwords-fill-data", username: "artem", password: "fresh" });
    const pass2 = document.querySelector("input[type=password]") as HTMLInputElement;
    expect(pass2.value).toBe("fresh");
  });
});

describe("SPA-перерисовка форм", () => {
  it("MutationObserver подхватывает форму, появившуюся после старта", async () => {
    vi.useFakeTimers();
    const { posted } = makeHarness();
    expect(posted).toHaveLength(0); // формы ещё нет — lookup не послан
    loginForm({ user: "a", pass: "b" });
    await Promise.resolve(); // доставка mutation-записей (микротаск happy-dom)
    await Promise.resolve();
    vi.advanceTimersByTime(400);
    expect(posted).toContainEqual({ duopulse: "passwords-lookup" });
    const button = document.querySelector("button") as HTMLButtonElement;
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(posted.find((m) => m["duopulse"] === "password-candidate")).toMatchObject({
      username: "a",
      password: "b",
    });
  });
});
