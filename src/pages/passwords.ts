// DuoPulse — внутренняя страница «Пароли» (этап 1 карточки duopulse-106):
// локальный менеджер паролей без аккаунта, как chrome://passwords. Открывается
// вкладкой duopulse://passwords (webview page-passwords-N, роутер src/main.ts).
// Данные — команды контракта passwords.* (SQLite passwords.db в профиле,
// секреты — AES-256-GCM; src-tauri/src/passwords/). Список пароль не получает
// (нет поля), показ конкретного пароля — ленивый passwords.reveal по id.
//
// Секции: поиск (сайт/логин/название), список (сайт, логин, пароль-точки),
// показать/скопировать пароль, скопировать логин, добавить/править/удалить.
// Сохранение из форм и автозаполнение — этап 2 (duopulse-108); синхронизация
// через аккаунт Aila — этап 4 (duopulse-110).
import { bridge } from "../bridge";
import type { PasswordEntry } from "../bridge";

const ICONS = {
  key: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="5.5" cy="10.5" r="3"/><path d="M7.8 8.2L13 3M11 5l1.5 1.5M9.2 6.8l1.5 1.5"/></svg>',
  eye: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>',
  eyeOff: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 2.5l11 11M5.3 5.4C3.4 6.5 1.5 8 1.5 8s2.5 4.5 6.5 4.5c1.3 0 2.5-.4 3.5-1M9.6 4.3A6.7 6.7 0 008 4.1"/></svg>',
  copy: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1.5 1.5 0 00-1.5-1.5H4A1.5 1.5 0 002.5 3.5V9A1.5 1.5 0 004 10.5h1.5"/></svg>',
  edit:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M11.3 2.2l2.5 2.5L6 12.5l-3.4.9.9-3.4z"/></svg>',
  cross:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>',
  plus:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 3v10M3 8h10"/></svg>',
} as const;

/** Форма добавления/правки (null — закрыта). */
type FormState = {
  /** null — добавление, число — правка записи. */
  id: number | null;
  url: string;
  title: string;
  username: string;
};

let query = "";
let items: PasswordEntry[] = [];
let total = 0;
let seq = 0;
/** Показанные пароли (id → расшифрованное значение) — только по требованию. */
const revealed = new Map<number, string>();
let form: FormState | null = null;

const err = (e: unknown): void => console.error("passwords-page:", e);

let root: HTMLElement;
let searchEl: HTMLInputElement;
let listEl: HTMLElement;
let errEl: HTMLElement;
let totalEl: HTMLElement;
let formWrap: HTMLElement;
let formUrl: HTMLInputElement;
let formTitle: HTMLInputElement;
let formUser: HTMLInputElement;
let formPass: HTMLInputElement;
let formPassShow: HTMLButtonElement;
let formSave: HTMLButtonElement;

function fail(e: unknown): void {
  errEl.textContent = String(e instanceof Error ? e.message : e);
  errEl.hidden = false;
  err(e);
}

function actBtn(cls: string, icon: keyof typeof ICONS, title: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `act ${cls}`;
  b.title = title;
  b.innerHTML = ICONS[icon];
  return b;
}

/** Копирование в буфер: clipboard-API, фолбэк — execCommand (duopulse:// —
 *  не secure context для navigator.clipboard). */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // фолбэк ниже
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.append(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } finally {
    ta.remove();
  }
}

async function reload(): Promise<void> {
  const my = ++seq;
  try {
    const res = await bridge.passwords.list({ query, limit: 500 });
    if (my !== seq) return;
    items = res.items;
    total = res.total;
    errEl.hidden = true;
  } catch (e) {
    fail(e);
    return;
  }
  render();
}

/** Имя сайта для заголовка строки: хост из origin (без схемы/порта). */
function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function passwordRow(p: PasswordEntry): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "mgr-entry";
  row.dataset.id = String(p.id);
  const ico = document.createElement("span");
  ico.className = "ico";
  ico.innerHTML = ICONS.key;
  const main = document.createElement("div");
  main.className = "entry-main";
  const title = document.createElement("div");
  title.className = "entry-title";
  title.textContent = p.title.trim() || hostOf(p.origin);
  const url = document.createElement("div");
  url.className = "entry-url";
  url.textContent = p.url || p.origin;
  main.append(title, url);
  const user = document.createElement("span");
  user.className = "pw-user";
  user.title = "Логин";
  user.textContent = p.username;
  const pass = document.createElement("span");
  pass.className = "pw-pass";
  if (revealed.has(p.id)) {
    // показанный пароль — полноценный контент: яркий текст, не muted-точки
    pass.classList.add("on");
    pass.textContent = revealed.get(p.id) as string;
  } else {
    pass.textContent = "••••••••";
  }

  const eye = actBtn("act-eye", "eye", "Показать пароль");
  eye.addEventListener("click", () => void toggleReveal(p.id, eye));
  const copyUser = actBtn("act-copyuser", "copy", "Скопировать логин");
  copyUser.addEventListener("click", () => void copyText(p.username));
  const copyPass = actBtn("act-copypass", "copy", "Скопировать пароль");
  copyPass.addEventListener("click", async () => {
    // пароль в списке не живёт — берём reveal (или уже показанный)
    const known = revealed.get(p.id);
    const value =
      known ??
      (await bridge.passwords.reveal({ id: p.id }).then((r) => r.password).catch(fail));
    if (value !== undefined) await copyText(value);
  });
  const edit = actBtn("act-edit", "edit", "Изменить");
  edit.addEventListener("click", () => {
    openForm({ id: p.id, url: p.url || p.origin, title: p.title, username: p.username });
  });
  const del = actBtn("act-del", "cross", "Удалить пароль");
  del.addEventListener("click", () => void remove(p.id));
  row.append(ico, main, user, pass, eye, copyUser, copyPass, edit, del);
  return row;
}

async function toggleReveal(id: number, btn: HTMLButtonElement): Promise<void> {
  if (revealed.has(id)) {
    revealed.delete(id);
    btn.innerHTML = ICONS.eye;
    btn.title = "Показать пароль";
  } else {
    try {
      revealed.set(id, (await bridge.passwords.reveal({ id })).password);
      btn.innerHTML = ICONS.eyeOff;
      btn.title = "Скрыть пароль";
    } catch (e) {
      fail(e);
      return;
    }
  }
  render();
}

async function remove(id: number): Promise<void> {
  try {
    await bridge.passwords.remove({ id });
    revealed.delete(id);
    errEl.hidden = true;
  } catch (e) {
    fail(e);
    return;
  }
  await reload();
}

function openForm(state: FormState): void {
  form = state;
  formWrap.hidden = false;
  formUrl.value = state.url;
  formTitle.value = state.title;
  formUser.value = state.username;
  formPass.value = "";
  formPassShow.innerHTML = ICONS.eye;
  formSave.textContent = state.id === null ? "Сохранить" : "Обновить";
  formUrl.focus();
  formUrl.setSelectionRange(0, 0); // длинные адреса видны с начала, а не с конца
}

function closeForm(): void {
  form = null;
  formWrap.hidden = true;
}

async function submitForm(): Promise<void> {
  if (!form) return;
  const url = formUrl.value.trim();
  const username = formUser.value.trim();
  const password = formPass.value;
  const title = formTitle.value.trim();
  if (!url || !username || !password) {
    fail("Заполните адрес сайта, логин и пароль");
    return;
  }
  try {
    if (form.id === null) {
      await bridge.passwords.add({ url, title: title || null, username, password });
    } else {
      await bridge.passwords.update({
        id: form.id,
        url,
        title: title || null,
        username,
        password,
      });
    }
    errEl.hidden = true;
    // кэш показанных паролей устарел (значение могло измениться) — сбросить
    if (form.id !== null) revealed.delete(form.id);
    closeForm();
  } catch (e) {
    fail(e);
    return;
  }
  await reload();
}

function render(): void {
  const kids: HTMLElement[] = [];
  for (const p of items) kids.push(passwordRow(p));
  if (!kids.length) {
    const empty = document.createElement("div");
    empty.className = "mgr-empty";
    empty.textContent = query
      ? "По запросу ничего не найдено"
      : "Сохранённых паролей нет — добавьте первый кнопкой «Добавить пароль»";
    kids.push(empty);
  }
  listEl.replaceChildren(...kids);
  totalEl.textContent = total > 0 ? `${items.length} из ${total}` : "";
}

function buildForm(): HTMLElement {
  formWrap = document.createElement("form");
  formWrap.className = "pw-form";
  formWrap.hidden = true;
  const field = (label: string, input: HTMLInputElement, placeholder: string): HTMLElement => {
    const wrap = document.createElement("label");
    wrap.className = "pw-field";
    const cap = document.createElement("span");
    cap.textContent = label;
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.autocomplete = "off";
    wrap.append(cap, input);
    return wrap;
  };
  formUrl = document.createElement("input");
  formUrl.type = "text";
  formTitle = document.createElement("input");
  formTitle.type = "text";
  formUser = document.createElement("input");
  formUser.type = "text";
  formPass = document.createElement("input");
  formPass.type = "password";
  formPassShow = document.createElement("button");
  formPassShow.type = "button";
  formPassShow.className = "pw-show";
  formPassShow.title = "Показать пароль";
  formPassShow.innerHTML = ICONS.eye;
  formPassShow.addEventListener("click", () => {
    const show = formPass.type === "password";
    formPass.type = show ? "text" : "password";
    formPassShow.innerHTML = show ? ICONS.eyeOff : ICONS.eye;
    formPassShow.title = show ? "Скрыть пароль" : "Показать пароль";
  });
  const passField = document.createElement("div");
  passField.className = "pw-field pw-field-pass";
  const passCap = document.createElement("span");
  passCap.textContent = "Пароль";
  passField.append(passCap, formPass, formPassShow);

  formSave = document.createElement("button");
  formSave.type = "submit";
  formSave.className = "pw-save";
  formSave.textContent = "Сохранить";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "pw-cancel";
  cancel.textContent = "Отмена";
  cancel.addEventListener("click", closeForm);

  formWrap.append(
    field("Адрес сайта", formUrl, "example.com или https://example.com/login"),
    field("Название", formTitle, "Пример — вход (необязательно)"),
    field("Логин", formUser, "почта или имя"),
    passField,
    formSave,
    cancel,
  );
  formWrap.addEventListener("submit", (e) => {
    e.preventDefault();
    void submitForm();
  });
  return formWrap;
}

export function initPasswordsPage(): void {
  document.title = "Пароли — DuoPulse";
  document.body.classList.add("internal-page");
  document.getElementById("app")?.remove();

  root = document.createElement("div");
  root.className = "mgr pw";

  const head = document.createElement("header");
  head.className = "mgr-head";
  const logo = document.createElement("div");
  logo.className = "mgr-logo";
  logo.textContent = "Duo";
  const pulse = document.createElement("span");
  pulse.textContent = "Pulse";
  logo.append(pulse);
  const title = document.createElement("h1");
  title.className = "mgr-title";
  title.textContent = "Пароли";
  searchEl = document.createElement("input");
  searchEl.type = "text";
  searchEl.className = "mgr-search";
  searchEl.placeholder = "Поиск по сайту, логину, названию";
  searchEl.spellcheck = false;
  searchEl.autocomplete = "off";
  let timer: number | undefined;
  searchEl.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      query = searchEl.value.trim();
      void reload();
    }, 200);
  });
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "mgr-clear pw-add";
  addBtn.innerHTML = `${ICONS.plus}<span>Добавить пароль</span>`;
  addBtn.addEventListener("click", () =>
    openForm({ id: null, url: "", title: "", username: "" }),
  );
  head.append(logo, title, addBtn, searchEl);

  errEl = document.createElement("div");
  errEl.className = "mgr-error";
  errEl.hidden = true;

  listEl = document.createElement("main");
  listEl.className = "mgr-list";

  const foot = document.createElement("footer");
  foot.className = "mgr-more";
  totalEl = document.createElement("span");
  totalEl.className = "mgr-total";
  foot.append(totalEl);

  root.append(head, errEl, buildForm(), listEl, foot);
  document.body.append(root);

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && form) closeForm();
  });

  void reload();
}

// модуль импортируется роутером src/main.ts — стартуем сразу
initPasswordsPage();
